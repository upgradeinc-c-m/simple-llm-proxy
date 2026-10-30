// 簡易 LLM プロキシ: Lambda Function URL で Anthropic Messages API / OpenAI 互換 API のリクエストを受け、
// API キー認証・送信元 IP 制限・モデル/ツール制限・ログ記録を行ったうえで Amazon Bedrock に転送する。
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  BadRequest, chatToAnthropic, anthropicToChat, chatStream,
  responsesToAnthropic, anthropicToResponses, responsesStream, modelList,
} from "./openai.mjs";

const KEYS_PARAM = process.env.KEYS_PARAM ?? "/llm-proxy/keys";
const KEYS_TTL_MS = Number(process.env.KEYS_TTL_MS ?? 60_000);
const ANTHROPIC_VERSION = "bedrock-2023-05-31";
// クライアントが送る anthropic-beta のうち Bedrock に渡してよいもの。未知の値を渡すと Bedrock が 400 を返す。
const ALLOWED_BETAS = (process.env.ALLOWED_BETAS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const bedrock = new BedrockRuntimeClient({});
const ssm = new SSMClient({});
let keysCache = { value: null, loadedAt: 0 };

// --- 設定の読み込み(SSM SecureString、60 秒キャッシュ) ---------------------------
async function loadKeys() {
  if (keysCache.value && Date.now() - keysCache.loadedAt < KEYS_TTL_MS) return keysCache.value;
  const res = await ssm.send(new GetParameterCommand({ Name: KEYS_PARAM, WithDecryption: true }));
  keysCache = { value: JSON.parse(res.Parameter.Value), loadedAt: Date.now() };
  return keysCache.value;
}

// --- 送信元 IP の CIDR 判定(IPv4 のみ。IPv6 は完全一致) -------------------------
function ipToInt(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}
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
    return {
      status: 403,
      type: "permission_error",
      message: `model "${alias}" is not allowed. allowed: ${Object.keys(keyConfig.models ?? {}).join(", ")}`,
    };
  }
  const { allow, deny } = keyConfig.tools ?? {};
  const blocked = toolNames.filter((n) => (allow && !allow.includes(n)) || (deny && deny.includes(n)));
  if (blocked.length) {
    return { status: 403, type: "permission_error", message: `tools not allowed: ${blocked.join(", ")}` };
  }
  return null;
}

// --- 入口の形式ごとのアダプタ --------------------------------------------------------
// toAnthropic: リクエスト → {alias, anthropicBody, stream, ...}
// fromAnthropic: Bedrock の JSON 応答 → クライアントへ返す JSON
// stream: Bedrock のイベント → クライアントへ書く SSE 文字列(onEvent)
const ADAPTERS = {
  anthropic: {
    errorBody: (type, message) => ({ type: "error", error: { type, message } }),
    toAnthropic(body, headers) {
      const { model, stream, ...rest } = body;
      const anthropicBody = { ...rest };
      const extra = {};
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
        if (json.type === "message_start") { this.usage.input_tokens = json.message?.usage?.input_tokens; json.message.model = alias; }
        if (json.type === "message_delta") this.usage.output_tokens = json.usage?.output_tokens;
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
};

// --- レスポンス書き出しのヘルパ ----------------------------------------------------
function sendJson(responseStream, status, obj) {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: status,
    headers: { "content-type": "application/json" },
  });
  stream.write(JSON.stringify(obj));
  stream.end();
}

// --- Bedrock エラーを Anthropic 形式に寄せる ---------------------------------------
function mapBedrockError(err) {
  const status = err.$metadata?.httpStatusCode ?? 502;
  const type =
    status === 429 ? "rate_limit_error" :
    status === 400 ? "invalid_request_error" :
    status === 403 ? "permission_error" :
    "api_error";
  return { status, type, message: `${err.name}: ${err.message}` };
}

// --- ハンドラ本体 -------------------------------------------------------------------
export const handler = awslambda.streamifyResponse(async (event, responseStream, context) => {
  const startedAt = Date.now();
  const http = event.requestContext?.http ?? {};
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const sourceIp = http.sourceIp ?? "unknown";
  const path = (event.rawPath ?? "/").replace(/\/+$/, "") || "/";
  const route = `${http.method} ${path}`;
  const format = ROUTES[route] ?? (path.startsWith("/v1/models") && http.method === "GET" ? "models" : undefined);
  const adapter = ADAPTERS[format] ?? ADAPTERS[format === "models" ? "chat" : "anthropic"];
  const log = {
    ts: new Date(startedAt).toISOString(),
    requestId: context.awsRequestId,
    sourceIp,
    method: http.method,
    path,
    format,
  };
  const finish = (status, extra = {}) => {
    console.log(JSON.stringify({ ...log, ...extra, status, latencyMs: Date.now() - startedAt }));
  };
  const sendError = (status, type, message) => sendJson(responseStream, status, adapter.errorBody(type, message));

  if (!format) {
    finish(404, { decision: "deny", reason: "not_found" });
    return sendError(404, "not_found_error", `unsupported route: ${route}. supported: ${Object.keys(ROUTES).join(", ")}, GET /v1/models`);
  }

  // 認証: x-api-key か Authorization: Bearer
  const apiKey = headers["x-api-key"] ?? headers["authorization"]?.replace(/^Bearer\s+/i, "");
  const keys = await loadKeys();
  const keyConfig = apiKey ? keys[apiKey] : undefined;
  if (!keyConfig) {
    finish(401, { decision: "deny", reason: "invalid_api_key" });
    return sendError(401, "authentication_error", "invalid api key");
  }
  log.keyName = keyConfig.name ?? "unnamed";

  if (format === "models") {
    finish(200, { decision: "allow" });
    return sendJson(responseStream, 200, modelList(Object.keys(keyConfig.models ?? {})));
  }

  let body, req;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body;
    body = JSON.parse(raw ?? "{}");
    req = adapter.toAnthropic(body, headers);
  } catch (err) {
    const message = err instanceof BadRequest ? err.message : "request body must be JSON";
    finish(400, { decision: "deny", reason: message });
    return sendError(400, "invalid_request_error", message);
  }
  const { alias, anthropicBody, stream: wantStream } = req;
  anthropicBody.anthropic_version ??= ANTHROPIC_VERSION; // Bedrock の InvokeModel で必須
  log.model = alias;
  log.stream = wantStream;
  log.tools = (anthropicBody.tools ?? []).map((t) => t.name).filter(Boolean);
  Object.assign(log, req.extra ?? {});

  const denied = authorize(keyConfig, sourceIp, alias, log.tools);
  if (denied) {
    finish(denied.status, { decision: "deny", reason: denied.message });
    return sendError(denied.status, denied.type, denied.message);
  }
  const modelId = keyConfig.models[alias];
  log.modelId = modelId;

  const usage = {};
  try {
    if (!wantStream) {
      const res = await bedrock.send(new InvokeModelCommand({
        modelId, contentType: "application/json", accept: "application/json",
        body: JSON.stringify(anthropicBody),
      }));
      const json = JSON.parse(Buffer.from(res.body).toString());
      Object.assign(usage, { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens, stopReason: json.stop_reason });
      finish(200, { decision: "allow", ...usage });
      return sendJson(responseStream, 200, adapter.fromAnthropic(json, alias, req));
    }

    // ストリーミング: Bedrock のイベントストリームを入口の形式の SSE に変換して流す
    const res = await bedrock.send(new InvokeModelWithResponseStreamCommand({
      modelId, contentType: "application/json", accept: "application/json",
      body: JSON.stringify(anthropicBody),
    }));
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
    const conv = adapter.stream(alias, req);
    for await (const ev of res.body) {
      if (!ev.chunk?.bytes) continue;
      const json = JSON.parse(Buffer.from(ev.chunk.bytes).toString());
      if (json.type === "message_delta") usage.stopReason = json.delta?.stop_reason;
      const text = conv.onEvent(json);
      if (text) out.write(text);
    }
    out.end();
    usage.inputTokens = conv.usage.input_tokens;
    usage.outputTokens = conv.usage.output_tokens;
    finish(200, { decision: "allow", ...usage });
  } catch (err) {
    const mapped = mapBedrockError(err);
    finish(mapped.status, { decision: "error", reason: mapped.message, ...usage });
    try {
      sendError(mapped.status, mapped.type, mapped.message);
    } catch {
      // ストリーミング開始後のエラーはヘッダを変えられないので、SSE の error イベントとして流す
      responseStream.write(`event: error\ndata: ${JSON.stringify(adapter.errorBody(mapped.type, mapped.message))}\n\n`);
      responseStream.end();
    }
  }
});
