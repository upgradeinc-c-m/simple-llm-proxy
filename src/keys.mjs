// API キー・チーム・利用量制限・費用計上・予算アラート(DynamoDB 1 テーブル)。
//   pk=KEY#<sha256(key)>   sk=META                 キーの設定(name, teamId, models, tools, cidrs, limits, guardrail, expiresAt, disabled)
//   pk=KEY#<sha256(key)>   sk=USAGE#<period>       期間ごとの利用量(requests, reserved, inputTokens, outputTokens, costMicroUsd, alerted80/100)
//   pk=TEAM#<teamId>       sk=META                 チームの設定(name, limits)
//   pk=TEAM#<teamId>       sk=USAGE#<period>       チーム合計の利用量
//   pk=ADMIN#<sha256(tok)> sk=META                 管理トークン(name, role: admin|viewer)
//   pk=AUDIT#<yyyy-mm>     sk=<ISO ts>#<rand>      管理操作の監査ログ
//   pk=CONFIG              sk=PRICES               モデル ID → {inputPerM, outputPerM}(USD / 1M tokens)
import { createHash } from "node:crypto";
import { DynamoDBClient, GetItemCommand, BatchGetItemCommand, UpdateItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const TABLE = process.env.KEYS_TABLE;
const CACHE_TTL_MS = Number(process.env.KEYS_TTL_MS ?? 60_000);
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN ?? "";
const ALERT_THRESHOLDS = [0.8, 1.0];
const ddb = new DynamoDBClient({});
const cache = new Map(); // "pk" -> {value, loadedAt}
let sns = null;

export const hashKey = (key) => createHash("sha256").update(key).digest("hex");

export function periodKeys(date = new Date()) {
  const iso = date.toISOString();
  return { minute: `min#${iso.slice(0, 16)}`, daily: `day#${iso.slice(0, 10)}`, monthly: `month#${iso.slice(0, 7)}` };
}

// --- 読み込み(60 秒キャッシュ) ------------------------------------------------------------
async function getCached(pk, sk = "META") {
  const ck = `${pk}|${sk}`; const c = cache.get(ck);
  if (c && Date.now() - c.loadedAt < CACHE_TTL_MS) return c.value;
  const r = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: marshall({ pk, sk }) }));
  const v = r.Item ? unmarshall(r.Item) : null;
  cache.set(ck, { value: v, loadedAt: Date.now() });
  return v;
}
export async function loadKeyMeta(apiKey) {
  const keyHash = hashKey(apiKey);
  const meta = await getCached(`KEY#${keyHash}`);
  const team = meta?.teamId ? await getCached(`TEAM#${meta.teamId}`) : null;
  return { keyHash, meta, team };
}
export async function loadPrices() { return (await getCached("CONFIG", "PRICES"))?.models ?? {}; }

// --- 制限の判定 -------------------------------------------------------------------------------
// 1) 無効化・期限 → 2) キーとチームの分・期間の利用量を一括取得 → 3) RPM は条件付き書き込みで予約(同期的)→ 4) TPM・予算
export async function checkLimits(keyHash, meta, team, now = new Date()) {
  if (meta.disabled) return { status: 403, type: "permission_error", message: "api key is disabled" };
  if (meta.expiresAt && now.getTime() / 1000 > Number(meta.expiresAt)) {
    return { status: 403, type: "permission_error", message: `api key expired at ${new Date(Number(meta.expiresAt) * 1000).toISOString()}` };
  }
  const p = periodKeys(now);
  const scopes = [{ label: "key", pk: `KEY#${keyHash}`, limits: meta.limits ?? {} }];
  if (team) {
    if (team.disabled) return { status: 403, type: "permission_error", message: `team "${team.name}" is disabled` };
    scopes.push({ label: `team ${team.name}`, pk: `TEAM#${team.teamId}`, limits: team.limits ?? {} });
  }
  const wanted = [];
  for (const s of scopes) {
    s.budgetSk = `USAGE#${s.limits.budgetPeriod === "daily" ? p.daily : p.monthly}`;
    if (s.limits.tpm) wanted.push({ pk: s.pk, sk: `USAGE#${p.minute}` });
    if (s.limits.budgetUsd) wanted.push({ pk: s.pk, sk: s.budgetSk });
  }
  const items = {};
  if (wanted.length) {
    const r = await ddb.send(new BatchGetItemCommand({ RequestItems: { [TABLE]: { Keys: wanted.map((k) => marshall(k)) } } }));
    for (const it of r.Responses?.[TABLE] ?? []) { const u = unmarshall(it); items[`${u.pk}|${u.sk}`] = u; }
  }
  for (const s of scopes) {
    const minute = items[`${s.pk}|USAGE#${p.minute}`] ?? {};
    const period = items[`${s.pk}|${s.budgetSk}`] ?? {};
    if (s.limits.tpm && Number(minute.inputTokens ?? 0) + Number(minute.outputTokens ?? 0) >= s.limits.tpm) {
      return { status: 429, type: "rate_limit_error", message: `tpm limit exceeded for ${s.label} (${Number(minute.inputTokens ?? 0) + Number(minute.outputTokens ?? 0)}/${s.limits.tpm} tokens this minute)` };
    }
    if (s.limits.budgetUsd) {
      const spent = Number(period.costMicroUsd ?? 0) / 1e6;
      if (spent >= s.limits.budgetUsd) {
        return { status: 429, type: "insufficient_quota", message: `budget exceeded for ${s.label} (spent ${spent.toFixed(6)} of ${s.limits.budgetUsd} USD ${s.limits.budgetPeriod ?? "monthly"})` };
      }
    }
  }
  // RPM: 分の項目に reserved を条件付きで加算する(並列でも上限を超えない)
  for (const s of scopes) {
    if (!s.limits.rpm) continue;
    try {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE, Key: marshall({ pk: s.pk, sk: `USAGE#${p.minute}` }),
        UpdateExpression: "ADD reserved :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ConditionExpression: "attribute_not_exists(reserved) OR reserved < :rpm",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: marshall({ ":one": 1, ":rpm": s.limits.rpm, ":ttl": Math.floor(now.getTime() / 1000) + 3600 }),
      }));
    } catch (e) {
      if (e.name === "ConditionalCheckFailedException") {
        return { status: 429, type: "rate_limit_error", message: `rpm limit exceeded for ${s.label} (${s.limits.rpm} requests per minute)` };
      }
      throw e;
    }
  }
  return null;
}

// --- 費用(USD)。単価が無いモデルは 0 で unpriced=true ------------------------------------------
export function estimateCost(prices, modelId, usage) {
  const pr = prices[modelId];
  if (!pr) return { costUsd: 0, unpriced: true };
  const n = (v) => Number(v ?? 0);
  const costUsd = (n(usage.inputTokens) * pr.inputPerM + n(usage.outputTokens) * pr.outputPerM
    + n(usage.cacheReadTokens) * (pr.cacheReadPerM ?? pr.inputPerM * 0.1) + n(usage.cacheWriteTokens) * (pr.cacheWritePerM ?? pr.inputPerM * 1.25)) / 1e6;
  return { costUsd, unpriced: false };
}

// --- 利用量の記録(キーとチーム、分・日・月)と予算アラート ------------------------------------
export async function recordUsage(keyHash, meta, team, usage, costUsd, now = new Date()) {
  const p = periodKeys(now); const nowSec = Math.floor(now.getTime() / 1000);
  const ttl = { minute: nowSec + 3600, daily: nowSec + 400 * 86400, monthly: nowSec + 400 * 86400 };
  const scopes = [{ pk: `KEY#${keyHash}`, limits: meta.limits ?? {}, name: meta.name, kind: "key" }];
  if (team) scopes.push({ pk: `TEAM#${team.teamId}`, limits: team.limits ?? {}, name: team.name, kind: "team" });
  const updates = [];
  const results = {};
  for (const s of scopes) for (const [kind, sk] of Object.entries(p)) {
    updates.push(ddb.send(new UpdateItemCommand({
      TableName: TABLE, Key: marshall({ pk: s.pk, sk: `USAGE#${sk}` }),
      UpdateExpression: "ADD requests :one, inputTokens :in, outputTokens :out, costMicroUsd :cost SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: marshall({ ":one": 1, ":in": Number(usage.inputTokens ?? 0), ":out": Number(usage.outputTokens ?? 0), ":cost": Math.round(costUsd * 1e6), ":ttl": ttl[kind] }),
      ReturnValues: "ALL_NEW",
    })).then((r) => { results[`${s.pk}|${sk}`] = unmarshall(r.Attributes); }));
  }
  await Promise.all(updates);
  // 予算の閾値を越えたら 1 回だけ通知(alerted80 / alerted100 フラグを条件付きで立てる)
  if (!ALERT_TOPIC_ARN) return;
  for (const s of scopes) {
    if (!s.limits.budgetUsd) continue;
    const sk = s.limits.budgetPeriod === "daily" ? p.daily : p.monthly;
    const item = results[`${s.pk}|${sk}`]; if (!item) continue;
    const spent = Number(item.costMicroUsd ?? 0) / 1e6; const ratio = spent / s.limits.budgetUsd;
    for (const th of ALERT_THRESHOLDS) {
      if (ratio < th) continue;
      const flag = `alerted${Math.round(th * 100)}`;
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE, Key: marshall({ pk: s.pk, sk: `USAGE#${sk}` }),
          UpdateExpression: "SET #f = :t", ConditionExpression: "attribute_not_exists(#f)",
          ExpressionAttributeNames: { "#f": flag }, ExpressionAttributeValues: marshall({ ":t": true }),
        }));
        await publishAlert({ kind: s.kind, name: s.name, threshold: th, spent, budgetUsd: s.limits.budgetUsd, period: sk });
      } catch (e) { if (e.name !== "ConditionalCheckFailedException") console.log(JSON.stringify({ alertError: e.name, message: e.message })); }
    }
  }
}

async function publishAlert(a) {
  if (!sns) { const { SNSClient } = await import("@aws-sdk/client-sns"); sns = new SNSClient({}); }
  const { PublishCommand } = await import("@aws-sdk/client-sns");
  const pct = Math.round(a.threshold * 100);
  const subject = `[llm-proxy] ${a.kind} "${a.name}" reached ${pct}% of budget`;
  const message = `${a.kind} "${a.name}" spent ${a.spent.toFixed(4)} USD of ${a.budgetUsd} USD (${a.period}). ${pct >= 100 ? "Requests are now rejected with 429." : "Approaching the limit."}`;
  await sns.send(new PublishCommand({ TopicArn: ALERT_TOPIC_ARN, Subject: subject.slice(0, 100), Message: message }));
  console.log(JSON.stringify({ alert: subject }));
}

// --- 利用者自身の利用量(GET /v1/usage) --------------------------------------------------------
export async function usageHistory(pk) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "pk = :p AND begins_with(sk, :u)", ExpressionAttributeValues: marshall({ ":p": pk, ":u": "USAGE#" }) }));
  return (r.Items ?? []).map((i) => unmarshall(i)).filter((u) => !u.sk.startsWith("USAGE#min#"))
    .map((u) => ({ period: u.sk.slice(6), requests: u.requests ?? 0, inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, costUsd: (u.costMicroUsd ?? 0) / 1e6 }))
    .sort((a, b) => (a.period < b.period ? 1 : -1));
}
