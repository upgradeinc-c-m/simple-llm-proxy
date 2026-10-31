// Anthropic Messages 形式 ↔ Bedrock Converse API の変換。
// Claude 以外の Bedrock モデル(Nova、Llama、Mistral など)を同じプロキシで使うために、
// Anthropic 形式に正規化したリクエストを Converse に変換し、応答を Anthropic のイベント形式に戻す。
import { ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

const IMAGE_FORMATS = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };

function toConverseBlock(b) {
  switch (b.type) {
    case "text": return { text: b.text };
    case "image": {
      if (b.source?.type !== "base64") throw Object.assign(new Error("Converse には base64 画像のみ渡せます"), { status: 400 });
      return { image: { format: IMAGE_FORMATS[b.source.media_type] ?? "png", source: { bytes: Buffer.from(b.source.data, "base64") } } };
    }
    case "tool_use": return { toolUse: { toolUseId: b.id, name: b.name, input: b.input ?? {} } };
    case "tool_result": {
      const content = typeof b.content === "string" ? [{ text: b.content }]
        : (b.content ?? []).map((c) => (c.type === "text" ? { text: c.text } : toConverseBlock(c)));
      return { toolResult: { toolUseId: b.tool_use_id, content: content.length ? content : [{ text: "" }], status: b.is_error ? "error" : "success" } };
    }
    case "thinking": case "redacted_thinking": return null; // 思考ブロックは再送しない
    default: throw Object.assign(new Error(`Converse に変換できないブロック: ${b.type}`), { status: 400 });
  }
}

// Anthropic 形式のボディ → Converse の入力(modelId は呼び出し側で付ける)
export function anthropicToConverse(body, { guardrail } = {}) {
  const messages = (body.messages ?? []).map((m) => ({
    role: m.role,
    content: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).map(toConverseBlock).filter(Boolean),
  })).filter((m) => m.content.length);
  const input = { messages, inferenceConfig: { maxTokens: body.max_tokens ?? 4096 } };
  if (body.system) input.system = (typeof body.system === "string" ? [{ type: "text", text: body.system }] : body.system).filter((b) => b.type === "text").map((b) => ({ text: b.text }));
  if (body.temperature != null) input.inferenceConfig.temperature = body.temperature;
  if (body.top_p != null) input.inferenceConfig.topP = body.top_p;
  if (body.stop_sequences?.length) input.inferenceConfig.stopSequences = body.stop_sequences;
  if (body.tools?.length) {
    input.toolConfig = { tools: body.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || undefined, inputSchema: { json: t.input_schema ?? { type: "object", properties: {} } } } })) };
    const tc = body.tool_choice;
    if (tc?.type === "any") input.toolConfig.toolChoice = { any: {} };
    else if (tc?.type === "tool") input.toolConfig.toolChoice = { tool: { name: tc.name } };
    else if (tc?.type === "auto" || !tc) input.toolConfig.toolChoice = { auto: {} };
  }
  if (guardrail?.id) input.guardrailConfig = { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version ?? "DRAFT", trace: "disabled" };
  return input;
}

const STOP = { end_turn: "end_turn", tool_use: "tool_use", max_tokens: "max_tokens", stop_sequence: "stop_sequence", guardrail_intervened: "refusal", content_filtered: "refusal" };
const usageOf = (u) => ({
  input_tokens: u?.inputTokens ?? 0, output_tokens: u?.outputTokens ?? 0,
  cache_read_input_tokens: u?.cacheReadInputTokens ?? 0, cache_creation_input_tokens: u?.cacheWriteInputTokens ?? 0,
});

// Converse の応答 → Anthropic Messages の応答
export function converseToAnthropic(res, alias) {
  const content = (res.output?.message?.content ?? []).map((b) => {
    if (b.text != null) return { type: "text", text: b.text };
    if (b.toolUse) return { type: "tool_use", id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} };
    return null;
  }).filter(Boolean);
  return {
    id: `msg_cvs_${Date.now().toString(36)}`, type: "message", role: "assistant", model: alias, content,
    stop_reason: STOP[res.stopReason] ?? "end_turn", stop_sequence: null, usage: usageOf(res.usage),
  };
}

// ConverseStream のイベント列 → Anthropic のストリームイベント列(非同期ジェネレータ)
export async function* converseStreamToAnthropic(stream, alias) {
  const id = `msg_cvs_${Date.now().toString(36)}`;
  let stopReason = "end_turn", usage = usageOf(null), started = false;
  const openBlocks = new Set(); // content_block_start を送った index
  for await (const ev of stream) {
    if (ev.messageStart && !started) {
      started = true;
      yield { type: "message_start", message: { id, type: "message", role: "assistant", model: alias, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } };
    } else if (ev.contentBlockStart) {
      const s = ev.contentBlockStart.start;
      openBlocks.add(ev.contentBlockStart.contentBlockIndex);
      yield { type: "content_block_start", index: ev.contentBlockStart.contentBlockIndex, content_block: s?.toolUse ? { type: "tool_use", id: s.toolUse.toolUseId, name: s.toolUse.name, input: {} } : { type: "text", text: "" } };
    } else if (ev.contentBlockDelta) {
      const d = ev.contentBlockDelta.delta; const index = ev.contentBlockDelta.contentBlockIndex;
      if (d.text != null) {
        // Converse はテキストブロックの start を送らないので、初回の delta で補う
        if (!openBlocks.has(index)) { openBlocks.add(index); yield { type: "content_block_start", index, content_block: { type: "text", text: "" } }; }
        yield { type: "content_block_delta", index, delta: { type: "text_delta", text: d.text } };
      } else if (d.toolUse) {
        yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: d.toolUse.input ?? "" } };
      }
    } else if (ev.contentBlockStop) {
      yield { type: "content_block_stop", index: ev.contentBlockStop.contentBlockIndex };
    } else if (ev.messageStop) {
      stopReason = STOP[ev.messageStop.stopReason] ?? "end_turn";
    } else if (ev.metadata) {
      usage = usageOf(ev.metadata.usage);
      yield { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens } };
      yield { type: "message_stop" };
    }
  }
}

export const converseCommands = { ConverseCommand, ConverseStreamCommand };
