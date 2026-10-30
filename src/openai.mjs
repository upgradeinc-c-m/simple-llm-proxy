// OpenAI 互換(Chat Completions / Responses API)と Anthropic Messages 形式の相互変換。
// 対応関係は LiteLLM の anthropic/chat/transformation.py と responses/litellm_completion_transformation を参考にしている。
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_TOKENS = 4096;

export class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// ---------------------------------------------------------------- 共通ヘルパ
const now = () => Math.floor(Date.now() / 1000);
const parseArgs = (s) => { if (s == null || s === "") return {}; try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return { _raw: s }; } };
const finishReason = (stop) => ({ end_turn: "stop", stop_sequence: "stop", max_tokens: "length", tool_use: "tool_calls", refusal: "content_filter" }[stop] ?? "stop");

function imageBlock(url) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(url ?? "");
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

// OpenAI の content(文字列 or パーツ配列)→ Anthropic のブロック配列
function toBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  const out = [];
  for (const p of content) {
    if (typeof p === "string") { if (p.trim()) out.push({ type: "text", text: p }); continue; }
    switch (p.type) {
      case "text": case "input_text": case "output_text": case "refusal":
        if ((p.text ?? p.refusal ?? "").trim()) out.push({ type: "text", text: p.text ?? p.refusal }); break;
      case "image_url": out.push(imageBlock(typeof p.image_url === "string" ? p.image_url : p.image_url?.url)); break;
      case "input_image": out.push(imageBlock(p.image_url)); break;
      default: throw new BadRequest(`unsupported content part type: ${p.type}`);
    }
  }
  return out;
}
const blocksToText = (content) => typeof content === "string" ? content : (content ?? []).map((p) => (typeof p === "string" ? p : p.text ?? p.output_text ?? "")).join("");

// 同じロールの連続をまとめながら messages を組み立てる(tool_result は直前の user にまとまる)
function makeConversation() {
  const messages = [];
  return {
    messages,
    push(role, blocks) {
      if (!blocks.length) return;
      const last = messages[messages.length - 1];
      if (last && last.role === role) last.content.push(...blocks); else messages.push({ role, content: blocks });
    },
    finish() {
      if (!messages.length) throw new BadRequest("messages must contain at least one user message");
      if (messages[0].role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "." }] });
      const last = messages[messages.length - 1];
      if (last.role === "assistant") {
        const t = last.content[last.content.length - 1];
        if (t?.type === "text") t.text = t.text.trimEnd();
      }
      return messages;
    },
  };
}

function toolChoice(tc, parallel) {
  let out;
  if (tc == null || tc === "auto") out = { type: "auto" };
  else if (tc === "required" || tc === "any") out = { type: "any" };
  else if (tc === "none") out = null;
  else if (typeof tc === "object") {
    const name = tc.function?.name ?? tc.name;
    out = name ? { type: "tool", name } : toolChoice(tc.type, parallel);
    if (out === null) return null;
  }
  if (out && parallel === false) out.disable_parallel_tool_use = true;
  return out;
}

function anthropicTool(name, description, parameters) {
  return { name, description: description ?? "", input_schema: parameters ?? { type: "object", properties: {} } };
}

// ---------------------------------------------------------------- Chat Completions
export function chatToAnthropic(body) {
  if ((body.n ?? 1) > 1) throw new BadRequest("n > 1 is not supported");
  if (body.response_format && body.response_format.type !== "text") throw new BadRequest("response_format other than text is not supported");
  const system = [];
  const conv = makeConversation();
  for (const m of body.messages ?? []) {
    switch (m.role) {
      case "system": case "developer": system.push(...toBlocks(m.content)); break;
      case "user": conv.push("user", toBlocks(m.content)); break;
      case "assistant": {
        const blocks = toBlocks(m.content);
        for (const tc of m.tool_calls ?? []) {
          if (tc.type !== "function") throw new BadRequest(`unsupported tool_call type: ${tc.type}`);
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) });
        }
        conv.push("assistant", blocks); break;
      }
      case "tool": case "function":
        conv.push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id ?? m.name, content: blocksToText(m.content) }]); break;
      default: throw new BadRequest(`unsupported message role: ${m.role}`);
    }
  }
  const tools = [
    ...(body.tools ?? []).filter((t) => t.type === "function").map((t) => anthropicTool(t.function.name, t.function.description, t.function.parameters)),
    ...(body.functions ?? []).map((f) => anthropicTool(f.name, f.description, f.parameters)),
  ];
  const out = {
    messages: conv.finish(),
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (system.length) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  const choice = toolChoice(body.tool_choice ?? body.function_call, body.parallel_tool_calls);
  if (tools.length && choice !== null) { out.tools = tools; out.tool_choice = choice; }
  return { alias: body.model, anthropicBody: out, stream: Boolean(body.stream), includeUsage: Boolean(body.stream_options?.include_usage) };
}

function chatUsage(u) {
  if (!u) return undefined;
  const cached = u.cache_read_input_tokens ?? 0;
  const prompt = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: u.output_tokens ?? 0, total_tokens: prompt + (u.output_tokens ?? 0), prompt_tokens_details: { cached_tokens: cached } };
}

export function anthropicToChat(json, alias) {
  const text = json.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const reasoning = json.content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("");
  const toolCalls = json.content.filter((b) => b.type === "tool_use").map((b, i) => ({ index: i, id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message = { role: "assistant", content: text || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: json.id, object: "chat.completion", created: now(), model: alias,
    choices: [{ index: 0, message, finish_reason: finishReason(json.stop_reason), logprobs: null }],
    usage: chatUsage(json.usage),
  };
}

// Anthropic のストリームイベントを Chat Completions のチャンク(SSE 文字列)に変換する
export function chatStream(alias, includeUsage) {
  let id = "", created = now(), toolCount = 0;
  const toolIdx = {};
  const usage = {};
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: alias, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] })}\n\n`;
  return {
    onEvent(ev) {
      switch (ev.type) {
        case "message_start":
          id = ev.message.id; Object.assign(usage, ev.message.usage ?? {});
          return chunk({ role: "assistant", content: "" });
        case "content_block_start":
          if (ev.content_block.type === "tool_use") {
            toolIdx[ev.index] = toolCount++;
            return chunk({ tool_calls: [{ index: toolIdx[ev.index], id: ev.content_block.id, type: "function", function: { name: ev.content_block.name, arguments: "" } }] });
          }
          return "";
        case "content_block_delta":
          if (ev.delta.type === "text_delta") return chunk({ content: ev.delta.text });
          if (ev.delta.type === "input_json_delta") return chunk({ tool_calls: [{ index: toolIdx[ev.index], function: { arguments: ev.delta.partial_json } }] });
          if (ev.delta.type === "thinking_delta") return chunk({ reasoning_content: ev.delta.thinking });
          return "";
        case "message_delta":
          Object.assign(usage, ev.usage ?? {});
          return chunk({}, finishReason(ev.delta?.stop_reason));
        case "message_stop": {
          let tail = "";
          if (includeUsage) tail += `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: alias, choices: [], usage: chatUsage(usage) })}\n\n`;
          return tail + "data: [DONE]\n\n";
        }
        default: return "";
      }
    },
    usage,
  };
}

// ---------------------------------------------------------------- Responses API
export function responsesToAnthropic(body) {
  if (body.previous_response_id) throw new BadRequest("previous_response_id is not supported (send the full input instead)");
  if (body.text?.format && body.text.format.type !== "text") throw new BadRequest("text.format other than text is not supported");
  const system = [];
  if (body.instructions) system.push({ type: "text", text: body.instructions });
  const conv = makeConversation();
  const items = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input ?? [];
  for (const it of items) {
    const type = it.type ?? (it.role ? "message" : undefined);
    switch (type) {
      case "message":
        if (it.role === "system" || it.role === "developer") system.push(...toBlocks(it.content));
        else if (it.role === "user") conv.push("user", toBlocks(it.content));
        else if (it.role === "assistant") conv.push("assistant", toBlocks(it.content));
        else throw new BadRequest(`unsupported message role: ${it.role}`);
        break;
      case "function_call":
        conv.push("assistant", [{ type: "tool_use", id: it.call_id, name: it.name, input: parseArgs(it.arguments) }]); break;
      case "function_call_output":
        conv.push("user", [{ type: "tool_result", tool_use_id: it.call_id, content: blocksToText(it.output) }]); break;
      case "reasoning": break; // 思考の再送はしない
      default: throw new BadRequest(`unsupported input item type: ${type}`);
    }
  }
  // function はそのまま、namespace(function のグループ)は平坦に展開、ホスト型ツール(web_search など)は提供できないので落とす
  const tools = [], dropped = [];
  for (const t of body.tools ?? []) {
    if (t.type === "function") tools.push(anthropicTool(t.name, t.description, t.parameters));
    else if (t.type === "namespace") for (const f of t.tools ?? []) { if (f.type === "function") tools.push(anthropicTool(f.name, f.description, f.parameters)); }
    else dropped.push(t.type);
  }
  const out = { messages: conv.finish(), max_tokens: body.max_output_tokens ?? DEFAULT_MAX_TOKENS };
  if (system.length) out.system = system;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  const choice = toolChoice(body.tool_choice, body.parallel_tool_calls);
  if (tools.length && choice !== null) { out.tools = tools; out.tool_choice = choice; }
  const extra = dropped.length ? { droppedTools: [...new Set(dropped)] } : {};
  return { alias: body.model, anthropicBody: out, stream: Boolean(body.stream), echo: body, extra };
}

function responsesUsage(u) {
  if (!u) return undefined;
  const cached = u.cache_read_input_tokens ?? 0;
  const input = (u.input_tokens ?? 0) + cached + (u.cache_creation_input_tokens ?? 0);
  return { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: u.output_tokens ?? 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + (u.output_tokens ?? 0) };
}

function responseEnvelope(id, alias, echo, status, output, usage, stopReason) {
  return {
    id, object: "response", created_at: now(), status, model: alias, output,
    usage, error: null,
    incomplete_details: stopReason === "max_tokens" ? { reason: "max_output_tokens" } : null,
    instructions: echo.instructions ?? null, parallel_tool_calls: echo.parallel_tool_calls ?? true,
    tool_choice: echo.tool_choice ?? "auto", tools: echo.tools ?? [],
    temperature: echo.temperature ?? null, top_p: echo.top_p ?? null, max_output_tokens: echo.max_output_tokens ?? null,
    store: false, previous_response_id: null, reasoning: { effort: null, summary: null },
    text: { format: { type: "text" } }, truncation: "disabled", metadata: echo.metadata ?? {}, user: null,
  };
}

const messageItem = (id) => ({ type: "message", id, status: "completed", role: "assistant", content: [] });
const functionItem = (b) => ({ type: "function_call", id: `fc_${b.id}`, call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}), status: "completed" });

export function anthropicToResponses(json, alias, echo) {
  const output = [];
  let msg = null;
  for (const b of json.content) {
    if (b.type === "text") {
      if (!msg) { msg = messageItem(`msg_${randomUUID().replace(/-/g, "")}`); output.push(msg); }
      msg.content.push({ type: "output_text", text: b.text, annotations: [] });
    } else if (b.type === "tool_use") { output.push(functionItem(b)); msg = null; }
  }
  const status = json.stop_reason === "max_tokens" ? "incomplete" : "completed";
  return responseEnvelope(`resp_${json.id}`, alias, echo, status, output, responsesUsage(json.usage), json.stop_reason);
}

// Anthropic のストリームイベントを Responses API のイベント(SSE 文字列)に変換する
export function responsesStream(alias, echo) {
  let seq = 0, respId = "", stopReason = null;
  const usage = {}, output = [], items = {}; // items: Anthropic の content index → {item, outputIndex, text/args}
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`;
  return {
    onEvent(e) {
      switch (e.type) {
        case "message_start": {
          respId = `resp_${e.message.id}`; Object.assign(usage, e.message.usage ?? {});
          const r = responseEnvelope(respId, alias, echo, "in_progress", [], undefined, null);
          return ev("response.created", { response: r }) + ev("response.in_progress", { response: r });
        }
        case "content_block_start": {
          const b = e.content_block;
          if (b.type === "text") {
            const item = messageItem(`msg_${randomUUID().replace(/-/g, "")}`); item.status = "in_progress";
            items[e.index] = { item, outputIndex: output.length, text: "" }; output.push(item);
            return ev("response.output_item.added", { output_index: items[e.index].outputIndex, item })
              + ev("response.content_part.added", { item_id: item.id, output_index: items[e.index].outputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          if (b.type === "tool_use") {
            const item = { ...functionItem(b), arguments: "", status: "in_progress" };
            items[e.index] = { item, outputIndex: output.length, args: "" }; output.push(item);
            return ev("response.output_item.added", { output_index: items[e.index].outputIndex, item });
          }
          return "";
        }
        case "content_block_delta": {
          const s = items[e.index]; if (!s) return "";
          if (e.delta.type === "text_delta") { s.text += e.delta.text; return ev("response.output_text.delta", { item_id: s.item.id, output_index: s.outputIndex, content_index: 0, delta: e.delta.text, logprobs: [] }); }
          if (e.delta.type === "input_json_delta") { s.args += e.delta.partial_json; return ev("response.function_call_arguments.delta", { item_id: s.item.id, output_index: s.outputIndex, delta: e.delta.partial_json }); }
          return "";
        }
        case "content_block_stop": {
          const s = items[e.index]; if (!s) return "";
          s.item.status = "completed";
          if (s.item.type === "message") {
            const part = { type: "output_text", text: s.text, annotations: [] }; s.item.content = [part];
            return ev("response.output_text.done", { item_id: s.item.id, output_index: s.outputIndex, content_index: 0, text: s.text, logprobs: [] })
              + ev("response.content_part.done", { item_id: s.item.id, output_index: s.outputIndex, content_index: 0, part })
              + ev("response.output_item.done", { output_index: s.outputIndex, item: s.item });
          }
          s.item.arguments = s.args || "{}";
          return ev("response.function_call_arguments.done", { item_id: s.item.id, output_index: s.outputIndex, arguments: s.item.arguments })
            + ev("response.output_item.done", { output_index: s.outputIndex, item: s.item });
        }
        case "message_delta":
          Object.assign(usage, e.usage ?? {}); stopReason = e.delta?.stop_reason ?? stopReason; return "";
        case "message_stop": {
          const status = stopReason === "max_tokens" ? "incomplete" : "completed";
          const r = responseEnvelope(respId, alias, echo, status, output, responsesUsage(usage), stopReason);
          return ev(status === "completed" ? "response.completed" : "response.incomplete", { response: r });
        }
        default: return "";
      }
    },
    usage,
  };
}

// ---------------------------------------------------------------- /v1/models
export function modelList(aliases) {
  return { object: "list", data: aliases.map((id) => ({ id, object: "model", created: now(), owned_by: "llm-proxy" })) };
}
