#!/usr/bin/env python3
"""llm-proxy の API キー管理 CLI(DynamoDB を IAM 権限で直接操作。boto3 不要、aws cli を使う)。

  keyctl.py create --name team-a --models claude-haiku-4-5=jp.anthropic.claude-haiku-4-5-20251001-v1:0[,alias=modelId...]
                   [--deny-tools bash,computer | --allow-tools get_weather] [--cidrs 203.0.113.0/24]
                   [--budget-usd 50 --budget-period monthly|daily] [--rpm 60] [--tpm 200000] [--expires-in-days 90]
      → 平文キーをこの 1 回だけ表示する(保存されるのは SHA-256 ハッシュ)
  keyctl.py list
  keyctl.py show <keyId>
  keyctl.py update <keyId> [--budget-usd ...] [--rpm ...] [--tpm ...] [--models ...] [--deny-tools ...] [--allow-tools ...] [--cidrs ...] [--expires-in-days N]
  keyctl.py disable <keyId> | enable <keyId> | revoke <keyId>
  keyctl.py usage <keyId> [--period month#2026-10 | day#2026-10-30]
  keyctl.py set-prices  modelId=inputPerM:outputPerM[,...]     例: jp.anthropic.claude-haiku-4-5-20251001-v1:0=1.1:5.5
  keyctl.py import keys.json        旧形式(平文キー → 設定)の JSON を取り込む(同じ平文キーのまま使える)

共通オプション: --table llm-proxy-keys --region ap-northeast-1 --profile NAME
"""
import argparse, hashlib, json, secrets, subprocess, sys, time

def aws(args, a):
    cmd = ["aws", "dynamodb"] + args + ["--output", "json"]
    if a.region: cmd += ["--region", a.region]
    if a.profile: cmd += ["--profile", a.profile]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"aws error: {out.stderr.strip()}")
    return json.loads(out.stdout) if out.stdout.strip() else {}

# --- DynamoDB JSON <-> Python ------------------------------------------------------------
def to_av(v):
    if isinstance(v, bool): return {"BOOL": v}
    if isinstance(v, (int, float)): return {"N": str(v)}
    if isinstance(v, str): return {"S": v}
    if isinstance(v, list): return {"L": [to_av(x) for x in v]}
    if isinstance(v, dict): return {"M": {k: to_av(x) for k, x in v.items()}}
    if v is None: return {"NULL": True}
    raise TypeError(type(v))
def from_av(av):
    (t, v), = av.items()
    if t == "S": return v
    if t == "N": return float(v) if "." in v else int(v)
    if t == "BOOL": return v
    if t == "NULL": return None
    if t == "L": return [from_av(x) for x in v]
    if t == "M": return {k: from_av(x) for k, x in v.items()}
    return v
def item_to_py(item): return {k: from_av(v) for k, v in item.items()}

def hash_key(key): return hashlib.sha256(key.encode()).hexdigest()
def key_id_of(h): return "key_" + h[:12]

def parse_models(s):
    out = {}
    for pair in (s or "").split(","):
        if not pair.strip(): continue
        alias, _, model = pair.partition("=")
        if not model: sys.exit(f"--models は alias=modelId 形式: {pair}")
        out[alias.strip()] = model.strip()
    return out
def parse_list(s): return [x.strip() for x in (s or "").split(",") if x.strip()]

def find_meta(a, key_id):
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND keyId = :k",
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":k": {"S": key_id}})], a)
    items = res.get("Items", [])
    if not items: sys.exit(f"キーが見つからない: {key_id}")
    return item_to_py(items[0])

def put_meta(a, meta):
    aws(["put-item", "--table-name", a.table, "--item", json.dumps({k: to_av(v) for k, v in meta.items()})], a)

def build_limits(a, base=None):
    limits = dict(base or {})
    if a.budget_usd is not None: limits["budgetUsd"] = a.budget_usd
    if a.budget_period: limits["budgetPeriod"] = a.budget_period
    if a.rpm is not None: limits["rpm"] = a.rpm
    if a.tpm is not None: limits["tpm"] = a.tpm
    return {k: v for k, v in limits.items() if v not in (None, 0, "")}

def print_meta(m):
    lim = m.get("limits") or {}
    exp = time.strftime("%Y-%m-%d", time.gmtime(m["expiresAt"])) if m.get("expiresAt") else "-"
    print(f'{m["keyId"]:18} {m.get("prefix",""):14} {m.get("name",""):16} {"disabled" if m.get("disabled") else "active":8} '
          f'models={",".join((m.get("models") or {}).keys()) or "-"} tools={json.dumps(m.get("tools") or {}, ensure_ascii=False)} '
          f'cidrs={",".join(m.get("cidrs") or []) or "-"} budget={lim.get("budgetUsd","-")}USD/{lim.get("budgetPeriod","monthly")} '
          f'rpm={lim.get("rpm","-")} tpm={lim.get("tpm","-")} expires={exp}')

# --- commands ----------------------------------------------------------------------------
def cmd_create(a):
    if not a.name or not a.models: sys.exit("--name と --models は必須")
    key = "llmp_" + secrets.token_hex(24)
    h = hash_key(key)
    meta = {"pk": f"KEY#{h}", "sk": "META", "keyId": key_id_of(h), "prefix": key[:12] + "…", "name": a.name,
            "models": parse_models(a.models), "createdAt": int(time.time())}
    if a.deny_tools: meta["tools"] = {"deny": parse_list(a.deny_tools)}
    if a.allow_tools is not None: meta["tools"] = {"allow": parse_list(a.allow_tools)}
    if a.cidrs: meta["cidrs"] = parse_list(a.cidrs)
    lim = build_limits(a)
    if lim: meta["limits"] = lim
    if a.expires_in_days is not None: meta["expiresAt"] = int(time.time()) + a.expires_in_days * 86400
    put_meta(a, meta)
    print(f"created {meta['keyId']} ({a.name})")
    print("API key (shown once, store it securely):")
    print(f"  {key}")

def cmd_list(a):
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m",
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}})], a)
    for it in sorted((item_to_py(i) for i in res.get("Items", [])), key=lambda m: m.get("createdAt", 0)):
        print_meta(it)

def cmd_show(a): print(json.dumps({k: v for k, v in find_meta(a, a.key_id).items() if k != "pk"}, ensure_ascii=False, indent=2))

def cmd_update(a):
    m = find_meta(a, a.key_id)
    if a.models: m["models"] = parse_models(a.models)
    if a.deny_tools: m["tools"] = {"deny": parse_list(a.deny_tools)}
    if a.allow_tools is not None: m["tools"] = {"allow": parse_list(a.allow_tools)}
    if a.cidrs: m["cidrs"] = parse_list(a.cidrs)
    lim = build_limits(a, m.get("limits"))
    if lim: m["limits"] = lim
    elif "limits" in m and (a.budget_usd == 0 or a.rpm == 0 or a.tpm == 0): m.pop("limits", None)
    if a.expires_in_days is not None: m["expiresAt"] = int(time.time()) + a.expires_in_days * 86400
    m["updatedAt"] = int(time.time()); put_meta(a, m); print("updated"); print_meta(m)

def set_disabled(a, flag):
    m = find_meta(a, a.key_id); m["disabled"] = flag; m["updatedAt"] = int(time.time()); put_meta(a, m)
    print(("disabled " if flag else "enabled ") + m["keyId"])

def cmd_revoke(a):
    m = find_meta(a, a.key_id)
    aws(["delete-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": m["pk"]}, "sk": {"S": "META"}})], a)
    print(f"revoked {m['keyId']}(利用量の履歴は残る。プロキシ側のキャッシュは最大 60 秒で切れる)")

def cmd_usage(a):
    m = find_meta(a, a.key_id)
    res = aws(["query", "--table-name", a.table, "--key-condition-expression", "pk = :p AND begins_with(sk, :u)",
               "--expression-attribute-values", json.dumps({":p": {"S": m["pk"]}, ":u": {"S": "USAGE#" + (a.period or "")}})], a)
    rows = [item_to_py(i) for i in res.get("Items", [])]
    rows = [r for r in rows if not r["sk"].startswith("USAGE#min#")] if not a.period else rows
    print(f"| period | requests | inputTokens | outputTokens | costUsd |"); print("| --- | --- | --- | --- | --- |")
    for r in sorted(rows, key=lambda r: r["sk"]):
        print(f'| {r["sk"][6:]} | {r.get("requests",0)} | {r.get("inputTokens",0)} | {r.get("outputTokens",0)} | {r.get("costMicroUsd",0)/1e6:.6f} |')
    lim = m.get("limits") or {}
    if lim.get("budgetUsd"): print(f'\nbudget: {lim["budgetUsd"]:.6f} USD / {lim.get("budgetPeriod","monthly")}')

def cmd_set_prices(a):
    models = {}
    for pair in a.prices.split(","):
        model, _, pr = pair.partition("="); i, _, o = pr.partition(":")
        models[model.strip()] = {"inputPerM": float(i), "outputPerM": float(o)}
    aws(["put-item", "--table-name", a.table, "--item", json.dumps({"pk": {"S": "CONFIG"}, "sk": {"S": "PRICES"}, "models": to_av(models), "updatedAt": {"N": str(int(time.time()))}})], a)
    print("prices set:", json.dumps(models))

def cmd_import(a):
    data = json.load(open(a.file))
    for key, cfg in data.items():
        h = hash_key(key)
        meta = {"pk": f"KEY#{h}", "sk": "META", "keyId": key_id_of(h), "prefix": key[:12] + "…", "name": cfg.get("name", "imported"),
                "models": cfg.get("models", {}), "createdAt": int(time.time()), "importedFrom": a.file}
        if cfg.get("tools"): meta["tools"] = cfg["tools"]
        if cfg.get("cidrs"): meta["cidrs"] = cfg["cidrs"]
        put_meta(a, meta); print(f"imported {meta['keyId']} ({meta['name']})")

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--table", default="llm-proxy-keys"); ap.add_argument("--region"); ap.add_argument("--profile")
    sub = ap.add_subparsers(dest="cmd", required=True)
    def limits(p):
        p.add_argument("--models"); p.add_argument("--deny-tools"); p.add_argument("--allow-tools"); p.add_argument("--cidrs")
        p.add_argument("--budget-usd", type=float); p.add_argument("--budget-period", choices=["monthly", "daily"])
        p.add_argument("--rpm", type=int); p.add_argument("--tpm", type=int); p.add_argument("--expires-in-days", type=int)
    p = sub.add_parser("create"); p.add_argument("--name"); limits(p); p.set_defaults(fn=cmd_create)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    p = sub.add_parser("show"); p.add_argument("key_id"); p.set_defaults(fn=cmd_show)
    p = sub.add_parser("update"); p.add_argument("key_id"); limits(p); p.set_defaults(fn=cmd_update)
    p = sub.add_parser("disable"); p.add_argument("key_id"); p.set_defaults(fn=lambda a: set_disabled(a, True))
    p = sub.add_parser("enable"); p.add_argument("key_id"); p.set_defaults(fn=lambda a: set_disabled(a, False))
    p = sub.add_parser("revoke"); p.add_argument("key_id"); p.set_defaults(fn=cmd_revoke)
    p = sub.add_parser("usage"); p.add_argument("key_id"); p.add_argument("--period"); p.set_defaults(fn=cmd_usage)
    p = sub.add_parser("set-prices"); p.add_argument("prices"); p.set_defaults(fn=cmd_set_prices)
    p = sub.add_parser("import"); p.add_argument("file"); p.set_defaults(fn=cmd_import)
    a = ap.parse_args(); a.fn(a)

if __name__ == "__main__":
    main()
