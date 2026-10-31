data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------- コードの zip 化(依存パッケージなし)
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/.build/lambda.zip"
}

# ---------------------------------------------------------------- ログ
resource "aws_cloudwatch_log_group" "proxy" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- API キーと利用量(DynamoDB)
# pk=KEY#<sha256> / sk=META がキー設定、sk=USAGE#<period> が利用量、pk=CONFIG / sk=PRICES がモデル単価。
# オンデマンド課金。分単位の利用量は ttl 属性で自動削除。
resource "aws_dynamodb_table" "keys" {
  name         = var.keys_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------------------------------------------------------------- IAM
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "proxy" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.proxy.arn}:*"]
  }
  statement {
    sid     = "Bedrock"
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CountTokens"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }
  statement {
    sid       = "Guardrails"
    actions   = ["bedrock:ApplyGuardrail"]
    resources = ["arn:aws:bedrock:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:guardrail/*"]
  }
  statement {
    sid       = "Keys"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.keys.arn]
  }
  dynamic "statement" {
    for_each = var.create_alert_topic ? [1] : []
    content {
      sid       = "Alerts"
      actions   = ["sns:Publish"]
      resources = [aws_sns_topic.alerts[0].arn]
    }
  }
}

# ---------------------------------------------------------------- 予算アラート(SNS)
resource "aws_sns_topic" "alerts" {
  count = var.create_alert_topic ? 1 : 0
  name  = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  count     = var.create_alert_topic && var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_iam_role" "proxy" {
  name               = "${var.name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "proxy" {
  name   = var.name
  role   = aws_iam_role.proxy.id
  policy = data.aws_iam_policy_document.proxy.json
}

# ---------------------------------------------------------------- Lambda
resource "aws_lambda_function" "proxy" {
  function_name    = var.name
  role             = aws_iam_role.proxy.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = var.memory_size
  timeout          = var.timeout

  environment {
    variables = {
      KEYS_TABLE      = aws_dynamodb_table.keys.name
      ALLOWED_BETAS   = var.allowed_betas
      ALERT_TOPIC_ARN = var.create_alert_topic ? aws_sns_topic.alerts[0].arn : ""
      LOG_BODIES      = var.log_bodies ? "true" : "false"
    }
  }

  depends_on = [aws_cloudwatch_log_group.proxy, aws_iam_role_policy.proxy]
}

# authorization_type = "NONE" の場合、プロバイダが lambda:InvokeFunctionUrl と
# lambda:InvokeFunction(InvokedViaFunctionUrl=true)の 2 つの許可を自動で付ける。
# CloudFormation ではこの 2 つ目を自分で書かないと全リクエストが 403 になる。
resource "aws_lambda_function_url" "proxy" {
  function_name      = aws_lambda_function.proxy.function_name
  authorization_type = "NONE"
  invoke_mode        = "RESPONSE_STREAM"
}
