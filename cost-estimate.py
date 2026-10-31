# 簡易 LLM プロキシの月額ランニングコスト見積もり(ap-northeast-1、2026-10-30 時点の公開単価)
# 単価の出典: AWS Price List API(Lambda、CloudWatch Logs、データ転送)、Bedrock 料金ページ(Claude)
P = {
    "lambda_req": 0.0000002,          # USD / request (APN1-Request)
    "lambda_gbs": 0.0000166667,       # USD / GB-second (APN1-Lambda-GB-Second, 最初の 6B GB-s)
    "lambda_free_req": 1_000_000,     # 無料枠 (常時)
    "lambda_free_gbs": 400_000,
    "logs_ingest": 0.76,              # USD / GB (APN1-DataProcessing-Bytes)
    "logs_store": 0.033,              # USD / GB-月 (APN1-TimedStorage-ByteHrs)
    "dto": 0.114,                     # USD / GB (東京 -> インターネット 最初の 10TB)
    "dto_free_gb": 100,               # AWS 全体で月 100GB 無料
    "ddb_rru": 0.0000001425,          # USD / 読み込み要求単位(APN1-ReadRequestUnits、オンデマンド)
    "ddb_wru": 0.000000715,           # USD / 書き込み要求単位(APN1-WriteRequestUnits、オンデマンド)
    "haiku_in": 1.1, "haiku_out": 5.5,        # Claude Haiku 4.5 (jp. geo CRIS) USD / 1M tokens。global CRIS は 1.0 / 5.0
    "sonnet_in": 3.3, "sonnet_out": 16.5,     # Claude Sonnet 4.5 (jp. geo CRIS) USD / 1M tokens
}
A = {  # 1 リクエストあたりの前提(検証で観測した値をもとに置いた仮定)
    "duration_s": 3.0,      # ストリーミング中は Lambda が待つ。短い応答で 0.7〜1.8 秒を観測、エージェント用途を見込んで 3 秒
    "memory_gb": 0.25,      # 256 MB
    "log_bytes": 700,       # JSON 1 行(ツール名が多いと増える)
    "resp_kb": 8,           # クライアントへ返すバイト数(SSE 含む)
    "in_tokens": 9_400,     # Claude Code の 1 ターン(観測値)
    "out_tokens": 300,
    "ddb_reads": 1,         # 利用量チェック(BatchGetItem 2 項目、結果整合)≒ 1 RRU。キー設定は 60 秒キャッシュ
    "ddb_writes": 3,        # 利用量の加算(分・日・月の 3 項目に UpdateItem)
}
GB = 1024**3
def est(req):
    gbs = req * A["duration_s"] * A["memory_gb"]
    lam = max(0, req - P["lambda_free_req"]) * P["lambda_req"] + max(0, gbs - P["lambda_free_gbs"]) * P["lambda_gbs"]
    log_gb = req * A["log_bytes"] / GB
    logs = log_gb * P["logs_ingest"] + log_gb * P["logs_store"]   # 保持 30 日 ≒ 1 か月分の保存
    dto_gb = req * A["resp_kb"] * 1024 / GB
    dto = max(0, dto_gb - P["dto_free_gb"]) * P["dto"]
    ddb = req * A["ddb_reads"] * P["ddb_rru"] + req * A["ddb_writes"] * P["ddb_wru"]
    proxy = lam + logs + dto + ddb
    tin = req * A["in_tokens"] / 1e6; tout = req * A["out_tokens"] / 1e6
    haiku = tin * P["haiku_in"] + tout * P["haiku_out"]
    sonnet = tin * P["sonnet_in"] + tout * P["sonnet_out"]
    return dict(req=req, gbs=gbs, lam=lam, log_gb=log_gb, logs=logs, dto_gb=dto_gb, dto=dto, ddb=ddb, proxy=proxy, haiku=haiku, sonnet=sonnet)
rows = [est(r) for r in (10_000, 100_000, 1_000_000)]
print("| 月間リクエスト | Lambda | CloudWatch Logs | DynamoDB | データ転送 | プロキシ小計 | Bedrock(Haiku 4.5) | Bedrock(Sonnet 4.5 jp) |")
print("| --- | --- | --- | --- | --- | --- | --- | --- |")
for r in rows:
    print(f"| {r['req']:,} | ${r['lam']:.2f} | ${r['logs']:.2f} | ${r['ddb']:.2f} | ${r['dto']:.2f} | ${r['proxy']:.2f} | ${r['haiku']:,.0f} | ${r['sonnet']:,.0f} |")
print()
for r in rows:
    print(f"req={r['req']:,}: GB-s={r['gbs']:,.0f} log={r['log_gb']*1024:.1f}MB dto={r['dto_gb']*1024:.0f}MB proxy_share_haiku={r['proxy']/(r['proxy']+r['haiku'])*100:.2f}%")
