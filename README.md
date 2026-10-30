# simple-llm-proxy

AWS Lambda の Function URL で Anthropic Messages API 互換と OpenAI 互換(Chat Completions / Responses API)のリクエストを受け、
Amazon Bedrock に転送する簡易 LLM プロキシです。Claude Code、Anthropic SDK、OpenAI SDK、Codex CLI から接続先の差し替えだけで使えます。

- コードは 2 ファイル(約 570 行)、依存パッケージなし(AWS SDK v3 は Lambda ランタイム同梱)
- インフラは Terraform(Lambda、Function URL、IAM、ログ、ダッシュボード)。固定費ゼロ
- API キーごとに、使えるモデル(エイリアス → Bedrock モデル ID)、ツール名の allow / deny、送信元 CIDR を制限
- 1 リクエスト 1 行の JSON ログを CloudWatch Logs に出力(キー名、モデル、ツール名、トークン数、判定理由)
- 利用状況の可視化: CloudWatch ダッシュボード(Terraform で作成)と、Markdown の利用レポートを出す `usage-report.py`

![構成図](docs/architecture.png)

設計と検証の経緯は Zenn の記事「Lambda+Bedrockで作る簡易LLMプロキシ(認証・制限・ログ)」にまとめています。

## 構成

| ファイル | 内容 |
| --- | --- |
| `src/index.mjs` | ルーティング・認証・制限・ログ・Bedrock 転送 |
| `src/openai.mjs` | OpenAI 形式(Chat Completions / Responses API)と Anthropic Messages 形式の相互変換。LiteLLM の変換を参考にした |
| `terraform/` | Lambda、Function URL、IAM、CloudWatch Logs、利用状況ダッシュボードの定義 |
| `usage-report.py` | Logs Insights からキー別・モデル別の利用状況と拒否理由を集計して Markdown 出力 |
| `keys.example.json` | API キー設定の例。コピーして `keys.json` にする(git 管理外) |
| `cost-estimate.py` | 月額ランニングコストの試算スクリプト(単価と前提はファイル内に記載) |
| `docs/` | 構成図・シーケンス図(PNG と Mermaid ソース) |

## エンドポイント

| ルート | 形式 | 主なクライアント |
| --- | --- | --- |
| `POST /v1/messages` | Anthropic Messages API(ボディ透過) | Claude Code、Anthropic SDK |
| `POST /v1/chat/completions` | OpenAI Chat Completions | OpenAI SDK、OpenAI 互換クライアント |
| `POST /v1/responses` | OpenAI Responses API | Codex CLI、OpenAI SDK |
| `GET /v1/models` | キーに許可されたモデル一覧 | クライアントのモデル選択 |

認証は `x-api-key` または `Authorization: Bearer <key>`。ツール制限はどの形式でも「モデルに渡すツール定義の名前」で判定します。

## デプロイ(Terraform)

API キー設定は Terraform の state に入れたくないので、SSM パラメータだけ AWS CLI で登録します。

```bash
cp keys.example.json keys.json   # キー・モデル・ツール・CIDR を編集
aws ssm put-parameter --name /llm-proxy/keys --type SecureString --value file://keys.json --overwrite --region ap-northeast-1

cd terraform
terraform init
terraform apply
# Outputs: function_url, log_group_name, dashboard_url
```

Claude Code から使う場合は、Bedrock が受け付ける beta だけを許可リストに入れます(それ以外の `anthropic-beta` は落としてログに記録)。

```bash
terraform apply -var 'allowed_betas=context-management-2025-06-27,interleaved-thinking-2025-05-14'
```

`authorization_type = "NONE"` の Function URL を Terraform で作ると、`lambda:InvokeFunctionUrl` と `lambda:InvokeFunction`(`InvokedViaFunctionUrl`)の 2 つの許可がプロバイダによって自動で付きます。

### 変数

| 名前 | 既定値 | 内容 |
| --- | --- | --- |
| `region` | `ap-northeast-1` | デプロイ先リージョン |
| `name` | `llm-proxy` | 関数名(ロググループ・ダッシュボード名にも使う) |
| `keys_parameter_name` | `/llm-proxy/keys` | API キー設定を置く SSM パラメータ名 |
| `allowed_betas` | 空 | クライアントの `anthropic-beta` のうち Bedrock へ渡す値(カンマ区切り) |
| `log_retention_days` | `30` | CloudWatch Logs の保持日数 |
| `memory_size` / `timeout` | `256` / `300` | Lambda のメモリ(MB)とタイムアウト(秒) |
| `create_dashboard` | `true` | 利用状況ダッシュボードを作るか |

## 可視化

### CloudWatch ダッシュボード(`<name>-usage`)

ログが 1 リクエスト 1 行の JSON なので、Logs Insights のクエリをそのままウィジェットにしています。

- キー別リクエスト数(allow / deny / error)
- キー別・モデル別トークン数(入力 / 出力)
- 拒否・エラーの理由
- リクエスト数の推移(5 分ごと、判定別)
- レイテンシ(p50 / p95 / max)
- Lambda の Invocations / Errors / Throttles
- 渡されたツール名の組み合わせ

アカウント内のカスタムダッシュボードは 3 枚まで無料、4 枚目以降は 1 枚 $3/月。ウィジェットの描画時に Logs Insights のスキャン課金がかかる(東京: $0.0076/GB)。

### 利用レポート(`usage-report.py`)

Slack や月次報告に貼る用途向けに、同じ集計を Markdown で出します。AWS CLI の認証情報を使い、boto3 は不要です。

```bash
python3 usage-report.py --hours 24 --region ap-northeast-1 [--profile NAME]
```

```markdown
## キー別(判定ごと)

| keyName | decision | requests | inTokens | outTokens |
| --- | --- | --- | --- | --- |
| team-a | allow | 5 | 62 | 31 |
| team-a | deny | 2 |  |  |
...
## 合計

- 許可リクエスト: 5
- 入力トークン: 62 / 出力トークン: 31
- 概算 Bedrock 費用(単価 入力 $1.1 / 出力 $5.5 per 1M tokens として): $0.0002
```

## キー設定(`keys.json`)

```json
{
  "proxy-key-team-a-change-me": {
    "name": "team-a",
    "models": {
      "claude-haiku-4-5": "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
      "claude-sonnet-4-5": "jp.anthropic.claude-sonnet-4-5-20250929-v1:0"
    },
    "tools": { "deny": ["bash", "computer"] },
    "cidrs": ["203.0.113.0/24"]
  }
}
```

- `models`: クライアントが送るモデル名(エイリアス)→ Bedrock モデル ID。許可リストを兼ねる
- `tools`: `allow`(列挙した名前だけ許可)か `deny`(列挙した名前を拒否)。ツール名は大文字小文字を区別する(Claude Code は `Bash`、Codex は `exec_command`)
- `cidrs`: 送信元 IP の許可リスト(IPv4。省略時は制限なし)

## クライアント設定

```bash
# Claude Code
export ANTHROPIC_BASE_URL=https://<function-url>
export ANTHROPIC_AUTH_TOKEN=<key>
export ANTHROPIC_MODEL=claude-haiku-4-5

# OpenAI SDK
new OpenAI({ baseURL: "https://<function-url>/v1", apiKey: "<key>" })
```

```toml
# Codex CLI: ~/.codex/config.toml
model_provider = "llmproxy"
model = "claude-haiku-4-5"

[model_providers.llmproxy]
name = "llm-proxy"
base_url = "https://<function-url>/v1"
env_key = "LLM_PROXY_KEY"
wire_api = "responses"
```

## 未対応・制限事項

- `previous_response_id`(ステートレスなので全履歴を送る)、`response_format` / `text.format` の `text` 以外、`n > 1`
- ホスト型ツール(`web_search` など)。落として `droppedTools` としてログに記録
- `/v1/messages/count_tokens`、埋め込みなど上記以外のエンドポイント
- レート制限・予算上限。CIDR 判定は IPv4 のみ
- Function URL は公開エンドポイント。WAF が必要なら CloudFront を手前に置き、Function URL を `AuthType: AWS_IAM` にする構成を検討する(未検証)

## 削除

```bash
cd terraform && terraform destroy
aws ssm delete-parameter --name /llm-proxy/keys --region ap-northeast-1
```

## ライセンス

MIT
