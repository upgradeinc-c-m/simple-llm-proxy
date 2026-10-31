// API キー管理と利用量制限(DynamoDB 1 テーブル)。
//   pk=KEY#<sha256(key)>  sk=META            : キーの設定(name, models, tools, cidrs, limits, expiresAt, disabled, prefix)
//   pk=KEY#<sha256(key)>  sk=USAGE#<period>   : 期間ごとの利用量(requests, inputTokens, outputTokens, costMicroUsd)。分単位の項目は TTL で消える
//   pk=CONFIG             sk=PRICES           : モデル ID → {inputPerM, outputPerM}(USD / 1M tokens)。費用計算に使う
import { createHash } from "node:crypto";
import { DynamoDBClient, GetItemCommand, BatchGetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = process.env.KEYS_TABLE;
const CACHE_TTL_MS = Number(process.env.KEYS_TTL_MS ?? 60_000);
const ddb = new DynamoDBClient({});
const metaCache = new Map(); // keyHash -> {value, loadedAt}
let pricesCache = { value: null, loadedAt: 0 };

export const hashKey = (key) => createHash("sha256").update(key).digest("hex");

// --- 期間キー --------------------------------------------------------------------------
export function periodKeys(date = new Date()) {
  const iso = date.toISOString();
  return {
    minute: `min#${iso.slice(0, 16)}`,          // 2026-10-30T14:35
    daily: `day#${iso.slice(0, 10)}`,           // 2026-10-30
    monthly: `month#${iso.slice(0, 7)}`,        // 2026-10
  };
}

// --- 読み込み ----------------------------------------------------------------------------
export async function loadKeyMeta(apiKey) {
  const keyHash = hashKey(apiKey);
  const c = metaCache.get(keyHash);
  if (c && Date.now() - c.loadedAt < CACHE_TTL_MS) return { keyHash, meta: c.value };
  const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: marshall({ pk: `KEY#${keyHash}`, sk: "META" }) }));
  const meta = res.Item ? unmarshall(res.Item) : null;
  metaCache.set(keyHash, { value: meta, loadedAt: Date.now() });
  return { keyHash, meta };
}

export async function loadPrices() {
  if (pricesCache.value && Date.now() - pricesCache.loadedAt < CACHE_TTL_MS) return pricesCache.value;
  const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: marshall({ pk: "CONFIG", sk: "PRICES" }) }));
  pricesCache = { value: res.Item ? (unmarshall(res.Item).models ?? {}) : {}, loadedAt: Date.now() };
  return pricesCache.value;
}

// --- 利用量制限の判定。超過なら {status, type, message} ------------------------------------
// limits: { rpm, tpm, budgetUsd, budgetPeriod: "monthly" | "daily" }
export async function checkLimits(keyHash, meta, now = new Date()) {
  if (meta.disabled) return { status: 403, type: "permission_error", message: "api key is disabled" };
  if (meta.expiresAt && now.getTime() / 1000 > Number(meta.expiresAt)) {
    return { status: 403, type: "permission_error", message: `api key expired at ${new Date(Number(meta.expiresAt) * 1000).toISOString()}` };
  }
  const limits = meta.limits ?? {};
  const p = periodKeys(now);
  const budgetSk = limits.budgetPeriod === "daily" ? p.daily : p.monthly;
  const wanted = [];
  if (limits.rpm || limits.tpm) wanted.push(`USAGE#${p.minute}`);
  if (limits.budgetUsd) wanted.push(`USAGE#${budgetSk}`);
  if (!wanted.length) return null;

  const res = await ddb.send(new BatchGetItemCommand({
    RequestItems: { [TABLE]: { Keys: wanted.map((sk) => marshall({ pk: `KEY#${keyHash}`, sk })) } },
  }));
  const items = Object.fromEntries((res.Responses?.[TABLE] ?? []).map((i) => { const u = unmarshall(i); return [u.sk, u]; }));
  const minute = items[`USAGE#${p.minute}`] ?? {};
  const period = items[`USAGE#${budgetSk}`] ?? {};

  if (limits.rpm && Number(minute.requests ?? 0) >= limits.rpm) {
    return { status: 429, type: "rate_limit_error", message: `rpm limit exceeded (${minute.requests}/${limits.rpm} requests this minute)` };
  }
  if (limits.tpm && Number(minute.inputTokens ?? 0) + Number(minute.outputTokens ?? 0) >= limits.tpm) {
    return { status: 429, type: "rate_limit_error", message: `tpm limit exceeded (${Number(minute.inputTokens ?? 0) + Number(minute.outputTokens ?? 0)}/${limits.tpm} tokens this minute)` };
  }
  if (limits.budgetUsd) {
    const spent = Number(period.costMicroUsd ?? 0) / 1e6;
    if (spent >= limits.budgetUsd) {
      return { status: 429, type: "insufficient_quota", message: `budget exceeded (spent ${spent.toFixed(6)} of ${limits.budgetUsd} USD ${limits.budgetPeriod ?? "monthly"})` };
    }
  }
  return null;
}

// --- 費用計算(USD)。単価が無いモデルは 0 として扱い、unpriced=true を返す ------------------
export function estimateCost(prices, modelId, usage) {
  const pr = prices[modelId];
  if (!pr) return { costUsd: 0, unpriced: true };
  const inTok = Number(usage.inputTokens ?? 0), outTok = Number(usage.outputTokens ?? 0);
  const cacheRead = Number(usage.cacheReadTokens ?? 0), cacheWrite = Number(usage.cacheWriteTokens ?? 0);
  const costUsd = (inTok * pr.inputPerM + outTok * pr.outputPerM
    + cacheRead * (pr.cacheReadPerM ?? pr.inputPerM * 0.1) + cacheWrite * (pr.cacheWritePerM ?? pr.inputPerM * 1.25)) / 1e6;
  return { costUsd, unpriced: false };
}

// --- 利用量の記録(分・日・月の 3 項目に加算) --------------------------------------------
export async function recordUsage(keyHash, usage, costUsd, now = new Date()) {
  const p = periodKeys(now);
  const costMicro = Math.round(costUsd * 1e6);
  const ttl = { minute: Math.floor(now.getTime() / 1000) + 3600, daily: Math.floor(now.getTime() / 1000) + 400 * 86400, monthly: Math.floor(now.getTime() / 1000) + 400 * 86400 };
  await Promise.all(Object.entries(p).map(([kind, sk]) => ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: marshall({ pk: `KEY#${keyHash}`, sk: `USAGE#${sk}` }),
    UpdateExpression: "ADD requests :one, inputTokens :in, outputTokens :out, costMicroUsd :cost SET #ttl = if_not_exists(#ttl, :ttl)",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: marshall({ ":one": 1, ":in": Number(usage.inputTokens ?? 0), ":out": Number(usage.outputTokens ?? 0), ":cost": costMicro, ":ttl": ttl[kind] }),
  }))));
}
