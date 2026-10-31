// 管理 UI(別 Lambda)。GET / で単一ファイルの HTML を返し、/api/* で DynamoDB のキー・利用量・単価を操作する。
// 認証は管理トークン(pk=CONFIG / sk=ADMIN に SHA-256 ハッシュを保存。keyctl.py admin-token で発行)。
// 任意で ADMIN_CIDRS(カンマ区切り)による送信元 IP 制限。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, QueryCommand, ScanCommand, BatchGetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { ADMIN_HTML } from "./admin-ui.mjs";

const TABLE = process.env.KEYS_TABLE;
const ADMIN_CIDRS = (process.env.ADMIN_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const ddb = new DynamoDBClient({});
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const keyIdOf = (hash) => `key_${hash.slice(0, 12)}`;
const now = () => Math.floor(Date.now() / 1000);

function ipInCidr(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  if (ip.includes(":")) return false;
  const toInt = (a) => a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const [base, bits] = cidr.split("/"); const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

// --- DynamoDB ヘルパ -----------------------------------------------------------------------
async function getItem(pk, sk) { const r = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: marshall({ pk, sk }) })); return r.Item ? unmarshall(r.Item) : null; }
async function putItem(item) { await ddb.send(new PutItemCommand({ TableName: TABLE, Item: marshall(item, { removeUndefinedValues: true }) })); }
async function listMeta() {
  const items = []; let start;
  do {
    const r = await ddb.send(new ScanCommand({ TableName: TABLE, FilterExpression: "sk = :m", ExpressionAttributeValues: marshall({ ":m": "META" }), ExclusiveStartKey: start }));
    items.push(...(r.Items ?? []).map((i) => unmarshall(i))); start = r.LastEvaluatedKey;
  } while (start);
  return items.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
async function findMeta(keyId) { return (await listMeta()).find((m) => m.keyId === keyId) ?? null; }
async function usageOf(pk, { includeMinutes = false } = {}) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :u)", ExpressionAttributeValues: marshall({ ":p": pk, ":u": "USAGE#" }) }));
  return (r.Items ?? []).map((i) => unmarshall(i)).filter((u) => includeMinutes || !u.sk.startsWith("USAGE#min#"))
    .map((u) => ({ period: u.sk.slice(6), requests: u.requests ?? 0, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, costUsd: (u.costMicroUsd ?? 0) / 1e6 }))
    .sort((a, b) => (a.period < b.period ? 1 : -1));
}
async function monthUsageFor(metas) {
  const month = `USAGE#month#${new Date().toISOString().slice(0, 7)}`;
  const out = {};
  for (let i = 0; i < metas.length; i += 100) {
    const chunk = metas.slice(i, i + 100);
    const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [TABLE]: { Keys: chunk.map((m) => marshall({ pk: m.pk, sk: month })) } } }));
    for (const it of r.Responses?.[TABLE] ?? []) { const u = unmarshall(it); out[u.pk] = { requests: u.requests ?? 0, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, costUsd: (u.costMicroUsd ?? 0) / 1e6 }; }
  }
  return out;
}
const publicMeta = (m, usage) => ({ keyId: m.keyId, prefix: m.prefix, name: m.name, models: m.models ?? {}, tools: m.tools ?? null, cidrs: m.cidrs ?? [], limits: m.limits ?? {}, expiresAt: m.expiresAt ?? null, disabled: Boolean(m.disabled), createdAt: m.createdAt ?? null, updatedAt: m.updatedAt ?? null, usage: usage ?? null });

// --- 入力の正規化 -----------------------------------------------------------------------------
class BadRequest extends Error { constructor(m) { super(m); this.status = 400; } }
function normalizeKeyInput(body, base = {}) {
  const m = { ...base };
  if (body.name !== undefined) { if (!String(body.name).trim()) throw new BadRequest("name is required"); m.name = String(body.name).trim(); }
  if (body.models !== undefined) {
    if (typeof body.models !== "object" || !Object.keys(body.models).length) throw new BadRequest("models must be a non-empty object {alias: modelId}");
    m.models = Object.fromEntries(Object.entries(body.models).map(([a, v]) => [String(a).trim(), String(v).trim()]));
  }
  if (body.tools !== undefined) {
    if (body.tools === null) delete m.tools;
    else if (Array.isArray(body.tools.allow)) m.tools = { allow: body.tools.allow.map(String) };
    else if (Array.isArray(body.tools.deny)) m.tools = { deny: body.tools.deny.map(String) };
    else throw new BadRequest("tools must be {allow: [...]}, {deny: [...]} or null");
  }
  if (body.cidrs !== undefined) { const c = (body.cidrs ?? []).map(String).filter(Boolean); if (c.length) m.cidrs = c; else delete m.cidrs; }
  if (body.limits !== undefined) {
    const l = {}; const src = body.limits ?? {};
    for (const k of ["budgetUsd", "rpm", "tpm"]) { if (src[k] !== undefined && src[k] !== null && src[k] !== "") { const n = Number(src[k]); if (!(n > 0)) throw new BadRequest(`${k} must be a positive number`); l[k] = n; } }
    if (src.budgetPeriod) { if (!["monthly", "daily"].includes(src.budgetPeriod)) throw new BadRequest("budgetPeriod must be monthly or daily"); l.budgetPeriod = src.budgetPeriod; }
    if (Object.keys(l).length) m.limits = l; else delete m.limits;
  }
  if (body.expiresInDays !== undefined) { if (body.expiresInDays === null || body.expiresInDays === "") delete m.expiresAt; else m.expiresAt = now() + Number(body.expiresInDays) * 86400; }
  if (body.expiresAt !== undefined) { if (body.expiresAt === null) delete m.expiresAt; else m.expiresAt = Number(body.expiresAt); }
  if (body.disabled !== undefined) m.disabled = Boolean(body.disabled);
  return m;
}

// --- ルーティング -----------------------------------------------------------------------------
async function api(method, path, body) {
  let mt;
  if (method === "GET" && path === "/api/keys") {
    const metas = await listMeta(); const usage = await monthUsageFor(metas);
    return { status: 200, body: { keys: metas.map((m) => publicMeta(m, usage[m.pk] ?? { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })), month: new Date().toISOString().slice(0, 7) } };
  }
  if (method === "POST" && path === "/api/keys") {
    const key = `llmp_${randomBytes(24).toString("hex")}`; const hash = sha256(key);
    const meta = normalizeKeyInput(body, { pk: `KEY#${hash}`, sk: "META", keyId: keyIdOf(hash), prefix: `${key.slice(0, 12)}…`, createdAt: now(), createdBy: "admin-ui" });
    if (!meta.name || !meta.models) throw new BadRequest("name and models are required");
    await putItem(meta);
    return { status: 201, body: { key, ...publicMeta(meta) } };
  }
  if ((mt = path.match(/^\/api\/keys\/(key_[0-9a-f]{12})$/))) {
    const meta = await findMeta(mt[1]); if (!meta) return { status: 404, body: { error: "key not found" } };
    if (method === "GET") return { status: 200, body: { ...publicMeta(meta), usageHistory: await usageOf(meta.pk) } };
    if (method === "PATCH") { const updated = normalizeKeyInput(body, meta); updated.updatedAt = now(); await putItem(updated); return { status: 200, body: publicMeta(updated) }; }
    if (method === "DELETE") { await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: marshall({ pk: meta.pk, sk: "META" }) })); return { status: 200, body: { revoked: meta.keyId } }; }
  }
  if (path === "/api/prices") {
    if (method === "GET") { const p = await getItem("CONFIG", "PRICES"); return { status: 200, body: { models: p?.models ?? {}, updatedAt: p?.updatedAt ?? null } }; }
    if (method === "PUT") {
      const models = {};
      for (const [id, v] of Object.entries(body.models ?? {})) { const i = Number(v.inputPerM), o = Number(v.outputPerM); if (!(i >= 0 && o >= 0)) throw new BadRequest(`invalid price for ${id}`); models[id] = { inputPerM: i, outputPerM: o }; }
      await putItem({ pk: "CONFIG", sk: "PRICES", models, updatedAt: now() }); return { status: 200, body: { models } };
    }
  }
  return { status: 404, body: { error: `unsupported route: ${method} ${path}` } };
}

export const handler = async (event) => {
  const http = event.requestContext?.http ?? {}; const path = (event.rawPath ?? "/").replace(/\/+/g, "/").replace(/\/+$/, "") || "/"; // 連続スラッシュと末尾スラッシュを正規化
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const json = (status, body) => ({ statusCode: status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) });
  const sourceIp = http.sourceIp ?? "unknown";
  if (ADMIN_CIDRS.length && !ADMIN_CIDRS.some((c) => ipInCidr(sourceIp, c))) return json(403, { error: "source ip not allowed" });

  if (http.method === "GET" && path === "/") {
    return { statusCode: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:" }, body: ADMIN_HTML };
  }
  if (!path.startsWith("/api/")) return json(404, { error: "not found" });

  // 管理トークンの検証(定数時間比較)
  const token = headers["authorization"]?.replace(/^Bearer\s+/i, "") ?? "";
  const admin = await getItem("CONFIG", "ADMIN");
  if (!admin?.tokenHash) return json(503, { error: "admin token is not configured. run: keyctl.py admin-token" });
  const given = Buffer.from(sha256(token)), expected = Buffer.from(admin.tokenHash);
  if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) return json(401, { error: "invalid admin token" });

  let body = {};
  try { const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body; body = raw ? JSON.parse(raw) : {}; } catch { return json(400, { error: "body must be JSON" }); }
  try {
    const res = await api(http.method, path, body);
    console.log(JSON.stringify({ ts: new Date().toISOString(), sourceIp, method: http.method, path, status: res.status, keyId: body?.keyId ?? (path.match(/key_[0-9a-f]{12}/) ?? [])[0] }));
    return json(res.status, res.body);
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message });
    console.log(JSON.stringify({ ts: new Date().toISOString(), method: http.method, path, error: e.name, message: e.message }));
    return json(500, { error: `${e.name}: ${e.message}` });
  }
};
