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
    actions = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
    resources = [
      "arn:aws:bedrock:*::foundation-model/*",
      "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/*",
    ]
  }
  statement {
    sid       = "Keys"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.keys.arn]
  }
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
      KEYS_TABLE    = aws_dynamodb_table.keys.name
      ALLOWED_BETAS = var.allowed_betas
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
