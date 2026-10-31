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
  keyctl.py admin-token [--name NAME] [--role admin|viewer]   管理 UI 用トークンを発行(複数可。viewer は閲覧のみ)
  keyctl.py admin-tokens | admin-revoke <name>
  keyctl.py team create --name team-x [--budget-usd 100 --budget-period monthly] [--rpm 300] [--tpm 1000000]
  keyctl.py team list | team show <teamId> | team usage <teamId> | team update <teamId> [...] | team delete <teamId>
  keyctl.py create ... [--team <teamId>] [--guardrail <id>[:<version>]]   キーをチームに所属させる / Guardrails を付ける
  keyctl.py regenerate <keyId>      設定と keyId を保ったまま平文を作り直す(旧平文は無効)
  keyctl.py audit [--month 2026-10]  管理操作の監査ログ

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
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p) AND keyId = :k",
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "KEY#"}, ":k": {"S": key_id}})], a)
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

def apply_team_guardrail(a, m):
    if getattr(a, "team", None) is not None:
        if a.team == "": m.pop("teamId", None)
        else:
            if not find_team(a, a.team, must=False): sys.exit(f"チームが見つからない: {a.team}")
            m["teamId"] = a.team
    if getattr(a, "guardrail", None) is not None:
        if a.guardrail == "": m.pop("guardrail", None)
        else:
            gid, _, ver = a.guardrail.partition(":"); m["guardrail"] = {"id": gid, "version": ver or "DRAFT"}

def find_team(a, team_id, must=True):
    res = aws(["get-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": f"TEAM#{team_id}"}, "sk": {"S": "META"}})], a)
    if "Item" not in res:
        if must: sys.exit(f"チームが見つからない: {team_id}")
        return None
    return item_to_py(res["Item"])

def usage_rows(a, pk, period=None):
    res = aws(["query", "--table-name", a.table, "--key-condition-expression", "pk = :p AND begins_with(sk, :u)",
               "--expression-attribute-values", json.dumps({":p": {"S": pk}, ":u": {"S": "USAGE#" + (period or "")}})], a)
    rows = [item_to_py(i) for i in res.get("Items", [])]
    if not period: rows = [r for r in rows if not r["sk"].startswith("USAGE#min#")]
    print("| period | requests | inputTokens | outputTokens | costUsd |"); print("| --- | --- | --- | --- | --- |")
    for r in sorted(rows, key=lambda r: r["sk"]):
        print(f'| {r["sk"][6:]} | {r.get("requests",0)} | {r.get("inputTokens",0)} | {r.get("outputTokens",0)} | {r.get("costMicroUsd",0)/1e6:.6f} |')

def print_meta(m):
    lim = m.get("limits") or {}
    exp = time.strftime("%Y-%m-%d", time.gmtime(m["expiresAt"])) if m.get("expiresAt") else "-"
    print(f'{m["keyId"]:18} {m.get("prefix",""):14} {m.get("name",""):16} {"disabled" if m.get("disabled") else "active":8} '
          f'models={",".join((m.get("models") or {}).keys()) or "-"} tools={json.dumps(m.get("tools") or {}, ensure_ascii=False)} '
          f'team={m.get("teamId","-")} cidrs={",".join(m.get("cidrs") or []) or "-"} budget={lim.get("budgetUsd","-")}USD/{lim.get("budgetPeriod","monthly")} '
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
    apply_team_guardrail(a, meta)
    put_meta(a, meta)
    print(f"created {meta['keyId']} ({a.name})")
    print("API key (shown once, store it securely):")
    print(f"  {key}")

def cmd_list(a):
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p)",
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "KEY#"}})], a)
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
    apply_team_guardrail(a, m)
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

def cmd_admin_token(a):
    token = "llmpa_" + secrets.token_hex(24)
    item = {"pk": f"ADMIN#{hash_key(token)}", "sk": "META", "name": a.name or "admin", "role": a.role, "createdAt": int(time.time())}
    aws(["put-item", "--table-name", a.table, "--item", json.dumps({k: to_av(v) for k, v in item.items()})], a)
    print(f"admin token created: name={item['name']} role={a.role} (shown once, store it securely). 管理 UI のログイン画面に貼り付ける:")
    print(f"  {token}")

def cmd_admin_tokens(a):
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p)",
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "ADMIN#"}})], a)
    for it in sorted((item_to_py(i) for i in res.get("Items", [])), key=lambda x: x.get("createdAt", 0)):
        print(f'{it.get("name"):16} role={it.get("role")} created={time.strftime("%Y-%m-%d", time.gmtime(it.get("createdAt", 0)))} {"disabled" if it.get("disabled") else ""}')
    if aws(["get-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": "CONFIG"}, "sk": {"S": "ADMIN"}})], a).get("Item"):
        print("(legacy)         role=admin  旧形式の CONFIG/ADMIN トークンも有効。admin-revoke legacy で削除")

def cmd_admin_revoke(a):
    if a.name == "legacy":
        aws(["delete-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": "CONFIG"}, "sk": {"S": "ADMIN"}})], a); print("legacy admin token removed"); return
    res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p) AND #n = :name",
               "--expression-attribute-names", json.dumps({"#n": "name"}),
               "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "ADMIN#"}, ":name": {"S": a.name}})], a)
    for it in res.get("Items", []):
        aws(["delete-item", "--table-name", a.table, "--key", json.dumps({"pk": it["pk"], "sk": it["sk"]})], a); print(f"revoked admin token {a.name}")

def cmd_team(a):
    if a.sub == "create":
        if not a.name: sys.exit("--name は必須")
        team_id = "team_" + secrets.token_hex(6)
        t = {"pk": f"TEAM#{team_id}", "sk": "META", "teamId": team_id, "name": a.name, "createdAt": int(time.time())}
        lim = build_limits(a)
        if lim: t["limits"] = lim
        aws(["put-item", "--table-name", a.table, "--item", json.dumps({k: to_av(v) for k, v in t.items()})], a); print(f"created {team_id} ({a.name})")
    elif a.sub == "list":
        res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p)",
                   "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "TEAM#"}})], a)
        for t in sorted((item_to_py(i) for i in res.get("Items", [])), key=lambda x: x.get("createdAt", 0)):
            lim = t.get("limits") or {}
            print(f'{t["teamId"]:20} {t.get("name",""):16} {"disabled" if t.get("disabled") else "active":8} budget={lim.get("budgetUsd","-")}USD/{lim.get("budgetPeriod","monthly")} rpm={lim.get("rpm","-")} tpm={lim.get("tpm","-")}')
    elif a.sub == "show":
        print(json.dumps({k: v for k, v in find_team(a, a.team_id).items() if k != "pk"}, ensure_ascii=False, indent=2))
    elif a.sub == "usage":
        find_team(a, a.team_id); usage_rows(a, f"TEAM#{a.team_id}", a.period)
    elif a.sub == "update":
        t = find_team(a, a.team_id)
        if a.name: t["name"] = a.name
        lim = build_limits(a, t.get("limits"))
        if lim: t["limits"] = lim
        if a.disabled is not None: t["disabled"] = a.disabled
        t["updatedAt"] = int(time.time())
        aws(["put-item", "--table-name", a.table, "--item", json.dumps({k: to_av(v) for k, v in t.items()})], a); print("updated")
    elif a.sub == "delete":
        find_team(a, a.team_id)
        res = aws(["scan", "--table-name", a.table, "--filter-expression", "sk = :m AND begins_with(pk, :p) AND teamId = :t",
                   "--expression-attribute-values", json.dumps({":m": {"S": "META"}, ":p": {"S": "KEY#"}, ":t": {"S": a.team_id}})], a)
        if res.get("Items"): sys.exit(f"チームにキーが {len(res['Items'])} 件あります。先に外してください")
        aws(["delete-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": f"TEAM#{a.team_id}"}, "sk": {"S": "META"}})], a); print(f"deleted {a.team_id}")

def cmd_regenerate(a):
    m = find_meta(a, a.key_id)
    key = "llmp_" + secrets.token_hex(24); h = hash_key(key)
    nxt = dict(m); nxt["pk"] = f"KEY#{h}"; nxt["prefix"] = key[:12] + "…"; nxt["updatedAt"] = int(time.time()); nxt["regeneratedFrom"] = m["pk"]
    put_meta(a, nxt)
    res = aws(["query", "--table-name", a.table, "--key-condition-expression", "pk = :p AND begins_with(sk, :u)",
               "--expression-attribute-values", json.dumps({":p": {"S": m["pk"]}, ":u": {"S": "USAGE#"}})], a)
    for it in res.get("Items", []):
        if it["sk"]["S"].startswith("USAGE#min#"): continue
        it = dict(it); it["pk"] = {"S": nxt["pk"]}
        aws(["put-item", "--table-name", a.table, "--item", json.dumps(it)], a)
    aws(["delete-item", "--table-name", a.table, "--key", json.dumps({"pk": {"S": m["pk"]}, "sk": {"S": "META"}})], a)
    print(f"regenerated {m['keyId']}(旧平文は無効。利用量は引き継ぎ)"); print("API key (shown once):"); print(f"  {key}")

def cmd_audit(a):
    month = a.month or time.strftime("%Y-%m", time.gmtime())
    res = aws(["query", "--table-name", a.table, "--key-condition-expression", "pk = :p", "--no-scan-index-forward",
               "--expression-attribute-values", json.dumps({":p": {"S": f"AUDIT#{month}"}})], a)
    for it in (item_to_py(i) for i in res.get("Items", [])):
        print(f'{it["sk"].split("#")[0]} {it.get("actor"):12} {it.get("action"):40} {it.get("target") or "-":22} {str(it.get("detail",""))[:80]}')

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--table", default="llm-proxy-keys"); ap.add_argument("--region"); ap.add_argument("--profile")
    sub = ap.add_subparsers(dest="cmd", required=True)
    def limits(p):
        p.add_argument("--models"); p.add_argument("--deny-tools"); p.add_argument("--allow-tools"); p.add_argument("--cidrs")
        p.add_argument("--budget-usd", type=float); p.add_argument("--budget-period", choices=["monthly", "daily"])
        p.add_argument("--rpm", type=int); p.add_argument("--tpm", type=int); p.add_argument("--expires-in-days", type=int)
        p.add_argument("--team", help="所属チームの teamId(空文字で外す)"); p.add_argument("--guardrail", help="Bedrock Guardrails の id[:version](空文字で外す)")
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
    p = sub.add_parser("admin-token"); p.add_argument("--name"); p.add_argument("--role", choices=["admin", "viewer"], default="admin"); p.set_defaults(fn=cmd_admin_token)
    sub.add_parser("admin-tokens").set_defaults(fn=cmd_admin_tokens)
    p = sub.add_parser("admin-revoke"); p.add_argument("name"); p.set_defaults(fn=cmd_admin_revoke)
    p = sub.add_parser("regenerate"); p.add_argument("key_id"); p.set_defaults(fn=cmd_regenerate)
    p = sub.add_parser("audit"); p.add_argument("--month"); p.set_defaults(fn=cmd_audit)
    p = sub.add_parser("team"); p.add_argument("sub", choices=["create", "list", "show", "usage", "update", "delete"]); p.add_argument("team_id", nargs="?")
    p.add_argument("--name"); p.add_argument("--budget-usd", type=float); p.add_argument("--budget-period", choices=["monthly", "daily"]); p.add_argument("--rpm", type=int); p.add_argument("--tpm", type=int)
    p.add_argument("--period"); p.add_argument("--disabled", type=lambda v: v.lower() == "true"); p.set_defaults(fn=cmd_team)
    a = ap.parse_args(); a.fn(a)

if __name__ == "__main__":
    main()
