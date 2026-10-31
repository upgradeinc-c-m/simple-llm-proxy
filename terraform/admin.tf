# 管理 UI(別 Lambda + Function URL)。HTML と JSON API を同じ関数が返す。
# プロキシ本体とは IAM を分け、キーの作成・削除(PutItem / DeleteItem)はこちらだけに許可する。
resource "aws_cloudwatch_log_group" "admin" {
  count             = var.create_admin_ui ? 1 : 0
  name              = "/aws/lambda/${var.name}-admin"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "admin" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.name}-admin:*"]
  }
  statement {
    sid       = "Keys"
    actions   = ["dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.keys.arn]
  }
}

resource "aws_iam_role" "admin" {
  count              = var.create_admin_ui ? 1 : 0
  name               = "${var.name}-admin-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy" "admin" {
  count  = var.create_admin_ui ? 1 : 0
  name   = "${var.name}-admin"
  role   = aws_iam_role.admin[0].id
  policy = data.aws_iam_policy_document.admin.json
}

resource "aws_lambda_function" "admin" {
  count            = var.create_admin_ui ? 1 : 0
  function_name    = "${var.name}-admin"
  role             = aws_iam_role.admin[0].arn
  runtime          = "nodejs22.x"
  handler          = "admin.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      KEYS_TABLE  = aws_dynamodb_table.keys.name
      ADMIN_CIDRS = var.admin_cidrs
    }
  }

  depends_on = [aws_cloudwatch_log_group.admin, aws_iam_role_policy.admin]
}

resource "aws_lambda_function_url" "admin" {
  count              = var.create_admin_ui ? 1 : 0
  function_name      = aws_lambda_function.admin[0].function_name
  authorization_type = "NONE"
  invoke_mode        = "BUFFERED"
}
