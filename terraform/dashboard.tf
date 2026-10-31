# 利用状況の可視化。ログは 1 リクエスト 1 行の JSON なので、Logs Insights のクエリをそのままウィジェットにする。
locals {
  lg = aws_cloudwatch_log_group.proxy.name

  q_base = "fields @timestamp, keyName, keyId, decision, model, stream, inputTokens, outputTokens, costUsd, latencyMs, reason | filter ispresent(decision)"

  widgets = [
    {
      type       = "text", x = 0, y = 0, width = 24, height = 2,
      properties = { markdown = "## ${var.name} 利用状況\nAPI キー(keyName)ごとのリクエスト数・トークン数・拒否理由。ログは CloudWatch Logs `${local.lg}`。" }
    },
    {
      type = "log", x = 0, y = 2, width = 12, height = 8,
      properties = {
        title = "キー別リクエスト数(allow / deny / error)", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | ${local.q_base} | stats count() as requests by keyName, decision | sort requests desc"
      }
    },
    {
      type = "log", x = 12, y = 2, width = 12, height = 8,
      properties = {
        title = "キー別トークン数(入力 / 出力)", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | ${local.q_base} | filter decision = 'allow' and ispresent(model) | stats sum(inputTokens) as inTokens, sum(outputTokens) as outTokens, count() as requests by keyName, model | sort inTokens desc"
      }
    },
    {
      type = "log", x = 0, y = 10, width = 12, height = 8,
      properties = {
        title = "拒否・エラーの理由", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | ${local.q_base} | filter decision != 'allow' | stats count() as count by decision, reason | sort count desc | limit 20"
      }
    },
    {
      type = "log", x = 12, y = 10, width = 12, height = 8,
      properties = {
        title = "リクエスト数の推移(5 分ごと、判定別)", region = var.region, view = "bar",
        query = "SOURCE '${local.lg}' | ${local.q_base} | stats count() as requests by bin(5m), decision"
      }
    },
    {
      type = "log", x = 0, y = 18, width = 12, height = 8,
      properties = {
        title = "レイテンシ(ms、allow のみ。平均 / p95 / 最大)", region = var.region, view = "bar",
        query = "SOURCE '${local.lg}' | ${local.q_base} | filter decision = 'allow' | stats avg(latencyMs) as avgMs, pct(latencyMs, 95) as p95Ms, max(latencyMs) as maxMs by bin(5m)"
      }
    },
    {
      type = "metric", x = 12, y = 18, width = 12, height = 8,
      properties = {
        title = "Lambda(Invocations / Errors / Throttles)", region = var.region, view = "timeSeries", stat = "Sum", period = 300,
        metrics = [
          ["AWS/Lambda", "Invocations", "FunctionName", var.name],
          [".", "Errors", ".", "."],
          [".", "Throttles", ".", "."],
        ]
      }
    },
    {
      type = "log", x = 0, y = 26, width = 12, height = 8,
      properties = {
        title = "キー別の費用(USD、単価テーブルから算出)", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | ${local.q_base} | filter decision = 'allow' | stats sum(costUsd) as costUsd, sum(inputTokens) as inTokens, sum(outputTokens) as outTokens, count() as requests by keyName, keyId | sort costUsd desc"
      }
    },
    {
      type = "log", x = 12, y = 26, width = 12, height = 8,
      properties = {
        title = "利用量制限による拒否(rpm / tpm / budget / expired / disabled)", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | ${local.q_base} | filter decision = 'deny' and (reason like /limit exceeded|budget exceeded|expired|disabled/) | stats count() as count by keyName, reason | sort count desc"
      }
    },
    {
      type = "log", x = 0, y = 34, width = 24, height = 8,
      properties = {
        title = "渡されたツール名(先頭 5 個の組み合わせ)", region = var.region, view = "table",
        query = "SOURCE '${local.lg}' | fields @timestamp, keyName, tools.0, tools.1, tools.2, tools.3, tools.4 | filter ispresent(decision) and ispresent(tools.0) | stats count() as requests by keyName, tools.0, tools.1, tools.2, tools.3, tools.4 | sort requests desc | limit 20"
      }
    },
  ]
}

resource "aws_cloudwatch_dashboard" "usage" {
  count          = var.create_dashboard ? 1 : 0
  dashboard_name = "${var.name}-usage"
  dashboard_body = jsonencode({ widgets = local.widgets })
}
