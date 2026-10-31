// 簡易 LLM プロキシ: Lambda Function URL で Anthropic Messages API / OpenAI 互換 API のリクエストを受け、
// API キー認証・送信元 IP 制限・モデル/ツール制限・利用量制限・ログ記録を行ったうえで Amazon Bedrock に転送する。
import {
  BedrockRuntimeClient, InvokeModelCommand, InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { loadKeyMeta, loadPrices, checkLimits, estimateCost, recordUsage, usageHistory } from "./keys.mjs";
import {
  BadRequest, chatToAnthropic, anthropicToChat, chatStream,
  responsesToAnthropic, anthropicToResponses, responsesStream, modelList,
} from "./openai.mjs";
import { anthropicToConverse, converseToAnthropic, converseStreamToAnthropic, converseCommands } from "./converse.mjs";

const ANTHROPIC_VERSION = "bedrock-2023-05-31";
const ALLOWED_BETAS = (process.env.ALLOWED_BETAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const LOG_BODIES = process.env.LOG_BODIES === "true";
const RETRYABLE = new Set(["ThrottlingException", "ServiceUnavailableException", "ModelNotReadyException", "InternalServerException", "ModelTimeoutException"]);

const bedrock = new BedrockRuntimeClient({});

// --- 送信元 IP の CIDR 判定(IPv4 のみ。IPv6 は完全一致) -------------------------
function ipToInt(ip) { return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0; }
function ipInCidr(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  if (ip.includes(":")) return false;
  const [base, bits] = cidr.split("/");
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

// --- 利用制限の判定。許可なら null、拒否なら {status, type, message} を返す --------
function authorize(keyConfig, sourceIp, alias, toolNames) {
  if (keyConfig.cidrs?.length && !keyConfig.cidrs.some((c) => ipInCidr(sourceIp, c))) {
    return { status: 403, type: "permission_error", message: `source ip ${sourceIp} is not allowed` };
  }
  if (!keyConfig.models?.[alias]) {
    return { status: 403, type: "permission_error", message: `model "${alias}" is not allowed. allowed: ${Object.keys(keyConfig.models ?? {}).join(", ")}` };
  }
  const { allow, deny } = keyConfig.tools ?? {};
  const blocked = toolNames.filter((n) => (allow && !allow.includes(n)) || (deny && deny.includes(n)));
  if (blocked.length) return { status: 403, type: "permission_error", message: `tools not allowed: ${blocked.join(", ")}` };
  return null;
}

// --- 入口の形式ごとのアダプタ --------------------------------------------------------
const ADAPTERS = {
  anthropic: {
    errorBody: (type, message) => ({ type: "error", error: { type, message } }),
    toAnthropic(body, headers) {
      const { model, stream, ...rest } = body;
      const anthropicBody = { ...rest }; const extra = {};
      if (headers["anthropic-beta"]) {
        const requested = headers["anthropic-beta"].split(",").map((s) => s.trim()).filter(Boolean);
        const passed = requested.filter((b) => ALLOWED_BETAS.includes(b));
        const dropped = requested.filter((b) => !ALLOWED_BETAS.includes(b));
        if (passed.length) anthropicBody.anthropic_beta = passed;
        if (dropped.length) extra.droppedBetas = dropped;
      }
      return { alias: model, anthropicBody, stream: Boolean(stream), extra };
    },
    fromAnthropic: (json, alias) => ({ ...json, model: alias }),
    stream: (alias) => ({
      usage: {},
      onEvent(json) {
        if (json.type === "message_start") { Object.assign(this.usage, json.message?.usage ?? {}); json.message.model = alias; }
        if (json.type === "message_delta") Object.assign(this.usage, json.usage ?? {});
        return `event: ${json.type}\ndata: ${JSON.stringify(json)}\n\n`;
      },
    }),
  },
  chat: {
    errorBody: (type, message) => ({ error: { message, type, param: null, code: null } }),
    toAnthropic: (body) => chatToAnthropic(body),
    fromAnthropic: anthropicToChat,
    stream: (alias, req) => chatStream(alias, req.includeUsage),
  },
  responses: {
    errorBody: (type, message) => ({ error: { message, type, param: null, code: null } }),
    toAnthropic: (body) => responsesToAnthropic(body),
    fromAnthropic: (json, alias, req) => anthropicToResponses(json, alias, req.echo),
    stream: (alias, req) => responsesStream(alias, req.echo),
  },
};
const ROUTES = {
  "POST /v1/messages": "anthropic",
  "POST /v1/chat/completions": "chat",
  "POST /v1/responses": "responses",
  "POST /v1/embeddings": "embeddings",
  "POST /v1/messages/count_tokens": "count_tokens",
  "GET /v1/models": "models",
  "GET /v1/usage": "usage",
  "GET /health": "health",
};

// --- レスポンス書き出し ----------------------------------------------------------------
function sendJson(responseStream, status, obj) {
  const stream = awslambda.HttpResponseStream.from(responseStream, { statusCode: status, headers: { "content-type": "application/json" } });
  stream.write(JSON.stringify(obj)); stream.end();
}
function mapBedrockError(err) {
  const status = err.status ?? err.$metadata?.httpStatusCode ?? 502;
  const type = status === 429 ? "rate_limit_error" : status === 400 ? "invalid_request_error" : status === 403 ? "permission_error" : "api_error";
  // 403 / 5xx の詳細(IAM ロールの ARN やアカウント ID を含む)はクライアントに返さず、ログにだけ残す
  const message = status === 403 ? `${err.name}: upstream access denied (check the proxy IAM policy)`
    : status >= 500 ? `${err.name}: upstream error` : `${err.name}: ${err.message}`;
  return { status, type, message, detail: err.message };
}

// --- 上流の選択: Anthropic モデルは InvokeModel に透過、それ以外は Converse に変換 -------------------
const isAnthropicModel = (modelId) => /(^|\.)anthropic\./.test(modelId);
const modelCandidates = (value) => String(value).split("|").map((s) => s.trim()).filter(Boolean); // "id1|id2" でフォールバック

async function invokeOnce(modelId, anthropicBody, wantStream, alias, guardrail) {
  if (isAnthropicModel(modelId)) {
    const params = { modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify({ anthropic_version: ANTHROPIC_VERSION, ...anthropicBody }) };
    if (guardrail?.id) Object.assign(params, { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version ?? "DRAFT", trace: "DISABLED" });
    if (!wantStream) {
      const res = await bedrock.send(new InvokeModelCommand(params));
      return { json: JSON.parse(Buffer.from(res.body).toString()) };
    }
    const res = await bedrock.send(new InvokeModelWithResponseStreamCommand(params));
    return { events: (async function* () { for await (const ev of res.body) { if (ev.chunk?.bytes) yield JSON.parse(Buffer.from(ev.chunk.bytes).toString()); } })() };
  }
  const input = { modelId, ...anthropicToConverse(anthropicBody, { guardrail }) };
  if (!wantStream) {
    const res = await bedrock.send(new converseCommands.ConverseCommand(input));
    return { json: converseToAnthropic(res, alias) };
  }
  const res = await bedrock.send(new converseCommands.ConverseStreamCommand(input));
  return { events: converseStreamToAnthropic(res.stream, alias) };
}

// 候補モデルを順に試す(429 / 5xx 系なら次へ)。成功した modelId も返す
async function invokeWithFallback(candidates, anthropicBody, wantStream, alias, guardrail, log) {
  let lastErr;
  for (const [i, modelId] of candidates.entries()) {
    try {
      const r = await invokeOnce(modelId, anthropicBody, wantStream, alias, guardrail);
      if (i > 0) log.fallbackTo = modelId;
      return { ...r, modelId };
    } catch (e) {
      lastErr = e;
      const status = e.$metadata?.httpStatusCode;
      // スロットリング・5xx に加え、モデル ID が無効/廃止された場合も次の候補へ(モデル廃止時の切り替え用)
      const modelGone = (e.name === "ValidationException" || e.name === "ResourceNotFoundException") && /model/i.test(e.message ?? "");
      if (i < candidates.length - 1 && (RETRYABLE.has(e.name) || status === 429 || (status >= 500 && status < 600) || modelGone)) { (log.fallbackErrors ??= []).push(`${modelId}: ${e.name}`); continue; }
      throw e;
    }
  }
  throw lastErr;
}

// --- 埋め込み(OpenAI /v1/embeddings 互換 → Titan / Cohere) -------------------------------------
async function embed(modelId, inputs) {
  const vectors = []; let tokens = 0;
  if (/cohere\.embed/.test(modelId)) {
    const res = await bedrock.send(new InvokeModelCommand({ modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify({ texts: inputs, input_type: "search_document" }) }));
    const json = JSON.parse(Buffer.from(res.body).toString()); vectors.push(...json.embeddings);
  } else {
    for (const text of inputs) {
      const res = await bedrock.send(new InvokeModelCommand({ modelId, contentType: "application/json", accept: "application/json", body: JSON.stringify({ inputText: text }) }));
      const json = JSON.parse(Buffer.from(res.body).toString()); vectors.push(json.embedding); tokens += json.inputTextTokenCount ?? 0;
    }
  }
  return { vectors, tokens };
}

// --- ハンドラ本体 -------------------------------------------------------------------
export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const startedAt = Date.now();
  const http = event.requestContext?.http ?? {};
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sourceIp = http.sourceIp ?? "unknown";
  const path = (event.rawPath ?? "/").replace(/\/+/g, "/").replace(/\/+$/, "") || "/";
  const route = `${http.method} ${path}`;
  const format = ROUTES[route] ?? (path.startsWith("/v1/models/") && http.method === "GET" ? "models" : undefined);
  const adapter = ADAPTERS[format] ?? (format === "anthropic" || format === "count_tokens" || format === "usage" ? ADAPTERS.anthropic : ADAPTERS.chat);
  const log = { ts: new Date(startedAt).toISOString(), requestId: context.awsRequestId, sourceIp, method: http.method, path, format };
  const finish = (status, extra = {}) => console.log(JSON.stringify({ ...log, ...extra, status, latencyMs: Date.now() - startedAt }));
  const sendError = (status, type, message) => sendJson(responseStream, status, adapter.errorBody(type, message));

  if (format === "health") return sendJson(responseStream, 200, { ok: true, ts: log.ts });
  if (!format) {
    finish(404, { decision: "deny", reason: "not_found" });
    return sendError(404, "not_found_error", `unsupported route: ${route}. supported: ${Object.keys(ROUTES).join(", ")}`);
  }

  // 認証(x-api-key か Authorization: Bearer)。キーは SHA-256 で DynamoDB を引き、所属チームも読む
  const apiKey = headers["x-api-key"] ?? headers["authorization"]?.replace(/^Bearer\s+/i, "");
  const { keyHash, meta: keyConfig, team } = apiKey ? await loadKeyMeta(apiKey) : { keyHash: null, meta: null, team: null };
  if (!keyConfig) { finish(401, { decision: "deny", reason: "invalid_api_key" }); return sendError(401, "authentication_error", "invalid api key"); }
  log.keyName = keyConfig.name ?? "unnamed"; log.keyId = keyConfig.keyId; if (team) log.team = team.name;

  if (format === "models") { finish(200, { decision: "allow" }); return sendJson(responseStream, 200, modelList(Object.keys(keyConfig.models ?? {}))); }
  if (format === "usage") {
    finish(200, { decision: "allow" });
    return sendJson(responseStream, 200, {
      keyId: keyConfig.keyId, name: keyConfig.name, team: team?.name ?? null, limits: keyConfig.limits ?? {}, teamLimits: team?.limits ?? {},
      expiresAt: keyConfig.expiresAt ?? null, usage: await usageHistory(`KEY#${keyHash}`), teamUsage: team ? await usageHistory(`TEAM#${team.teamId}`) : null,
    });
  }

  let body, req;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
    body = JSON.parse(raw ?? "{}");
    if (format === "embeddings") req = { alias: body.model, anthropicBody: {}, stream: false, inputs: Array.isArray(body.input) ? body.input : [body.input] };
    else if (format === "count_tokens") { const { model, ...rest } = body; req = { alias: model, anthropicBody: { max_tokens: 1, ...rest }, stream: false }; } // CountTokens も max_tokens 必須
    else req = adapter.toAnthropic(body, headers);
  } catch (err) {
    const message = err instanceof BadRequest ? err.message : "request body must be JSON";
    finish(400, { decision: "deny", reason: message }); return sendError(400, "invalid_request_error", message);
  }
  const { alias, anthropicBody, stream: wantStream } = req;
  log.model = alias; log.stream = wantStream; log.tools = (anthropicBody.tools ?? []).map((t) => t.name).filter(Boolean);
  Object.assign(log, req.extra ?? {});

  const denied = authorize(keyConfig, sourceIp, alias, log.tools);
  if (denied) { finish(denied.status, { decision: "deny", reason: denied.message }); return sendError(denied.status, denied.type, denied.message); }
  const candidates = modelCandidates(keyConfig.models[alias]);
  log.modelId = candidates[0];

  const limited = await checkLimits(keyHash, keyConfig, team);
  if (limited) { finish(limited.status, { decision: "deny", reason: limited.message }); return sendError(limited.status, limited.type, limited.message); }

  const usage = {};
  const settle = async (status, modelId) => {
    const prices = await loadPrices();
    const { costUsd, unpriced } = estimateCost(prices, modelId, usage);
    log.costUsd = Number(costUsd.toFixed(6)); if (unpriced) log.unpriced = true;
    try { await recordUsage(keyHash, keyConfig, team, usage, costUsd); } catch (e) { log.usageRecordError = e.name; }
    finish(status, { decision: "allow", ...usage });
  };
  if (LOG_BODIES) console.log(JSON.stringify({ type: "body", requestId: context.awsRequestId, keyId: keyConfig.keyId, messages: JSON.stringify(anthropicBody.messages ?? req.inputs ?? []).slice(0, 2048) }));

  try {
    if (format === "count_tokens") {
      const { CountTokensCommand } = await import("@aws-sdk/client-bedrock-runtime");
      if (!CountTokensCommand) throw Object.assign(new Error("count_tokens is not supported by this runtime"), { status: 501 });
      // CountTokens は推論プロファイル ID を受け付けないので、jp./apac./global. などの接頭辞を外した基盤モデル ID で呼ぶ
      const baseModelId = candidates[0].replace(/^[a-z-]+\.(?=[a-z]+\.)/, "");
      const res = await bedrock.send(new CountTokensCommand({ modelId: baseModelId, input: { invokeModel: { body: Buffer.from(JSON.stringify({ anthropic_version: ANTHROPIC_VERSION, ...anthropicBody })) } } }));
      finish(200, { decision: "allow", inputTokens: res.inputTokens });
      return sendJson(responseStream, 200, { input_tokens: res.inputTokens });
    }
    if (format === "embeddings") {
      const { vectors, tokens } = await embed(candidates[0], req.inputs);
      Object.assign(usage, { inputTokens: tokens, outputTokens: 0 });
      sendJson(responseStream, 200, { object: "list", model: alias, data: vectors.map((v, i) => ({ object: "embedding", index: i, embedding: v })), usage: { prompt_tokens: tokens, total_tokens: tokens } });
      return settle(200, candidates[0]);
    }
    const r = await invokeWithFallback(candidates, anthropicBody, wantStream, alias, keyConfig.guardrail, log);
    if (!wantStream) {
      const json = r.json;
      Object.assign(usage, { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens, stopReason: json.stop_reason, cacheReadTokens: json.usage?.cache_read_input_tokens, cacheWriteTokens: json.usage?.cache_creation_input_tokens });
      if (LOG_BODIES) console.log(JSON.stringify({ type: "body", requestId: context.awsRequestId, keyId: keyConfig.keyId, response: JSON.stringify(json.content ?? []).slice(0, 2048) }));
      sendJson(responseStream, 200, adapter.fromAnthropic(json, alias, req));
      return settle(200, r.modelId);
    }
    const out = awslambda.HttpResponseStream.from(responseStream, { statusCode: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    const conv = adapter.stream(alias, req); let responseText = "";
    for await (const json of r.events) {
      if (json.type === "message_delta") usage.stopReason = json.delta?.stop_reason;
      if (LOG_BODIES && json.type === "content_block_delta" && json.delta?.type === "text_delta") responseText += json.delta.text;
      const text = conv.onEvent(json); if (text) out.write(text);
    }
    out.end();
    Object.assign(usage, { inputTokens: conv.usage.input_tokens, outputTokens: conv.usage.output_tokens, cacheReadTokens: conv.usage.cache_read_input_tokens, cacheWriteTokens: conv.usage.cache_creation_input_tokens });
    if (LOG_BODIES) console.log(JSON.stringify({ type: "body", requestId: context.awsRequestId, keyId: keyConfig.keyId, response: responseText.slice(0, 2048) }));
    await settle(200, r.modelId);
  } catch (err) {
    const mapped = mapBedrockError(err);
    finish(mapped.status, { decision: "error", reason: mapped.message, detail: mapped.detail?.slice(0, 300), ...usage });
    try { sendError(mapped.status, mapped.type, mapped.message); }
    catch { responseStream.write(`event: error\ndata: ${JSON.stringify(adapter.errorBody(mapped.type, mapped.message))}\n\n`); responseStream.end(); }
  }
});
