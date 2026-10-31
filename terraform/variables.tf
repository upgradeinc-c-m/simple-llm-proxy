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

variable "create_admin_ui" {
  description = "管理 UI(別 Lambda + Function URL)を作るか"
  type        = bool
  default     = true
}

variable "admin_cidrs" {
  description = "管理 UI にアクセスできる送信元 CIDR(カンマ区切り。空なら制限なし。管理トークンによる認証は常に必要)"
  type        = string
  default     = ""
}

variable "create_alert_topic" {
  description = "予算の 80% / 100% 到達を通知する SNS トピックを作るか"
  type        = bool
  default     = true
}

variable "alert_email" {
  description = "アラートの送信先メールアドレス(空なら購読を作らない。購読確認メールが届く)"
  type        = string
  default     = ""
}

variable "log_bodies" {
  description = "リクエストの messages と応答テキスト(先頭 2KB)もログに出すか。監査用途向け。既定は出さない"
  type        = bool
  default     = false
}

variable "admin_auth_type" {
  description = "管理 UI の Function URL 認証。NONE(管理トークンで保護)か AWS_IAM(SigV4 必須。CloudFront + OAC などと組み合わせる)"
  type        = string
  default     = "NONE"
  validation {
    condition     = contains(["NONE", "AWS_IAM"], var.admin_auth_type)
    error_message = "admin_auth_type は NONE か AWS_IAM"
  }
}
