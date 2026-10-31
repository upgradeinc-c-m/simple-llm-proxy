#!/usr/bin/env python3
"""CloudWatch Logs Insights からプロキシの利用状況を集計して Markdown で出力する。

使い方:
  usage-report.py [--log-group /aws/lambda/llm-proxy] [--hours 24] [--region ap-northeast-1] [--profile NAME]
                  [--haiku-in 1.1 --haiku-out 5.5]   # 概算コスト(USD / 1M tokens)に使う単価

AWS CLI の認証情報を使う(boto3 不要)。Logs Insights のスキャン課金(東京: $0.0076/GB)がかかる。
"""
import argparse, json, subprocess, sys, time

QUERIES = {
    "by_key": "filter ispresent(decision) | stats count() as requests, sum(inputTokens) as inTokens, sum(outputTokens) as outTokens by keyName, decision | sort requests desc",
    "by_model": "filter decision = 'allow' and ispresent(model) | stats count() as requests, sum(inputTokens) as inTokens, sum(outputTokens) as outTokens, avg(latencyMs) as avgLatencyMs by model | sort requests desc",
    "deny_reasons": "filter ispresent(decision) and decision != 'allow' | stats count() as count by decision, reason | sort count desc | limit 20",
    "by_team": "filter decision = 'allow' and ispresent(team) | stats count() as requests, sum(inputTokens) as inTokens, sum(outputTokens) as outTokens, sum(costUsd) as costUsd by team | sort costUsd desc",
}

def aws(args, profile=None, region=None):
    cmd = ["aws"] + args + ["--output", "json"]
    if profile: cmd += ["--profile", profile]
    if region: cmd += ["--region", region]
    return json.loads(subprocess.check_output(cmd))

def run_query(log_group, query, start, end, profile, region):
    qid = aws(["logs", "start-query", "--log-group-name", log_group, "--start-time", str(start), "--end-time", str(end), "--query-string", query], profile, region)["queryId"]
    for _ in range(60):
        res = aws(["logs", "get-query-results", "--query-id", qid], profile, region)
        if res["status"] in ("Complete", "Failed", "Cancelled", "Timeout"):
            break
        time.sleep(1)
    rows = [{f["field"]: f["value"] for f in r} for r in res.get("results", [])]
    return rows, res.get("statistics", {})

def num(v):
    try: return float(v)
    except (TypeError, ValueError): return 0.0

def table(rows, cols):
    if not rows: return "(データなし)\n"
    out = ["| " + " | ".join(cols) + " |", "| " + " | ".join("---" for _ in cols) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |")
    return "\n".join(out) + "\n"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--log-group", default="/aws/lambda/llm-proxy")
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--region"); ap.add_argument("--profile")
    ap.add_argument("--haiku-in", type=float, default=1.1); ap.add_argument("--haiku-out", type=float, default=5.5)
    a = ap.parse_args()
    end = int(time.time()); start = int(end - a.hours * 3600)
    print(f"# {a.log_group} 利用レポート(直近 {a.hours:g} 時間)\n")
    scanned = 0.0
    by_key, st = run_query(a.log_group, QUERIES["by_key"], start, end, a.profile, a.region); scanned += num(st.get("bytesScanned"))
    print("## キー別(判定ごと)\n"); print(table(by_key, ["keyName", "decision", "requests", "inTokens", "outTokens"]))
    by_model, st = run_query(a.log_group, QUERIES["by_model"], start, end, a.profile, a.region); scanned += num(st.get("bytesScanned"))
    print("## モデル別(許可のみ)\n"); print(table(by_model, ["model", "requests", "inTokens", "outTokens", "avgLatencyMs"]))
    by_team, st = run_query(a.log_group, QUERIES["by_team"], start, end, a.profile, a.region); scanned += num(st.get("bytesScanned"))
    print("## チーム別(許可のみ)\n"); print(table(by_team, ["team", "requests", "inTokens", "outTokens", "costUsd"]))
    deny, st = run_query(a.log_group, QUERIES["deny_reasons"], start, end, a.profile, a.region); scanned += num(st.get("bytesScanned"))
    print("## 拒否・エラーの理由\n"); print(table(deny, ["decision", "reason", "count"]))
    tin = sum(num(r.get("inTokens")) for r in by_model); tout = sum(num(r.get("outTokens")) for r in by_model)
    cost = tin / 1e6 * a.haiku_in + tout / 1e6 * a.haiku_out
    print("## 合計\n")
    print(f"- 許可リクエスト: {int(sum(num(r.get('requests')) for r in by_model)):,}")
    print(f"- 入力トークン: {int(tin):,} / 出力トークン: {int(tout):,}")
    print(f"- 概算 Bedrock 費用(単価 入力 ${a.haiku_in} / 出力 ${a.haiku_out} per 1M tokens として): ${cost:,.4f}")
    print(f"- Logs Insights スキャン量: {scanned/1024/1024:.1f} MB")

if __name__ == "__main__":
    main()
