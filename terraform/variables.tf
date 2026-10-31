variable "region" {
  description = "デプロイ先リージョン"
  type        = string
  default     = "ap-northeast-1"
}

variable "name" {
  description = "Lambda 関数名(ロググループ名・ダッシュボード名にも使う)"
  type        = string
  default     = "llm-proxy"
}

variable "keys_table_name" {
  description = "API キーと利用量を保存する DynamoDB テーブル名(Terraform が作成。キーの発行は keyctl.py)"
  type        = string
  default     = "llm-proxy-keys"
}

variable "allowed_betas" {
  description = "クライアントの anthropic-beta のうち Bedrock へ渡す値(カンマ区切り)。それ以外は落としてログに記録"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "memory_size" {
  type    = number
  default = 256
}

variable "timeout" {
  description = "秒。ストリーミング中は応答が終わるまで待つので長めに"
  type        = number
  default     = 300
}

variable "create_dashboard" {
  description = "利用状況の CloudWatch ダッシュボードを作るか(アカウントで 4 枚目以降は月額課金)"
  type        = bool
  default     = true
}
