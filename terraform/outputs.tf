output "function_url" {
  value = aws_lambda_function_url.proxy.function_url
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.proxy.name
}

output "dashboard_url" {
  value = var.create_dashboard ? "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards:name=${aws_cloudwatch_dashboard.usage[0].dashboard_name}" : null
}

output "keys_table_name" {
  value = aws_dynamodb_table.keys.name
}
