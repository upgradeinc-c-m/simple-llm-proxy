#!/usr/bin/env bash
# CloudFormation でプロキシをデプロイする。
# 使い方: deploy.sh [stack-name] [cloudformation deploy への追加引数...]
#   例: deploy.sh llm-proxy --parameter-overrides AllowedBetas="context-management-2025-06-27"
# 環境変数 AWS_REGION(または AWS_DEFAULT_REGION)と AWS 認証情報が必要
set -euo pipefail
cd "$(dirname "$0")"

STACK="${1:-llm-proxy}"
shift $(( $# > 0 ? 1 : 0 ))
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:?AWS_REGION を設定してください}}"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="cfn-artifacts-${ACCOUNT}-${REGION}"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "==> アーティファクト用バケットを作成: $BUCKET"
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

echo "==> package"
aws cloudformation package --template-file template.yaml --s3-bucket "$BUCKET" \
  --s3-prefix "$STACK" --output-template-file /tmp/"$STACK"-packaged.yaml >/dev/null

echo "==> deploy: $STACK ($REGION)"
aws cloudformation deploy --template-file /tmp/"$STACK"-packaged.yaml --stack-name "$STACK" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset "$@"

aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
