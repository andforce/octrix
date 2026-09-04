#!/usr/bin/env bash
set -euo pipefail

source_env="${IDEPLOY_ENV_FILE:-/opt/ideploy/deploy/.env}"
target_env="${OCTRIX_ENV_FILE:-/opt/octrix/deploy/.env}"

if [[ ! -r "$source_env" ]]; then
  echo "无法读取 iDeploy 环境文件：$source_env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$source_env"
set +a

existing_value() {
  local name="$1"
  [[ -r "$target_env" ]] || return 0
  sed -n "s/^${name}=//p" "$target_env" | head -1
}

existing_pepper="$(existing_value OCTRIX_TOKEN_PEPPER)"
pepper="${existing_pepper:-$(openssl rand -hex 32)}"
public_url="${OCTRIX_PUBLIC_URL:-$(existing_value OCTRIX_PUBLIC_URL)}"
sms_sign_name="${OCTRIX_SMS_SIGN_NAME:-$(existing_value OCTRIX_SMS_SIGN_NAME)}"
sms_template_code="${OCTRIX_SMS_TEMPLATE_CODE:-$(existing_value OCTRIX_SMS_TEMPLATE_CODE)}"
sms_scheme_name="${OCTRIX_SMS_SCHEME_NAME:-$(existing_value OCTRIX_SMS_SCHEME_NAME)}"
legacy_enabled="${OCTRIX_LEGACY_AUTH_ENABLED:-false}"
legacy_until="${OCTRIX_LEGACY_AUTH_UNTIL:-}"

if [[ -z "$public_url" ]]; then
  echo "必须通过 OCTRIX_PUBLIC_URL 提供对外 HTTPS 地址，例如 https://relay.example.com。" >&2
  exit 1
fi

if [[ -z "$sms_sign_name" || -z "$sms_template_code" ]]; then
  echo "必须通过 OCTRIX_SMS_SIGN_NAME 和 OCTRIX_SMS_TEMPLATE_CODE 提供已确认可用的阿里云赠送或自定义短信配置。" >&2
  exit 1
fi

if [[ "$legacy_enabled" == "true" ]]; then
  if [[ -z "$legacy_until" ]]; then
    echo "开启兼容模式时必须显式设置 OCTRIX_LEGACY_AUTH_UNTIL。" >&2
    exit 1
  fi
  until_epoch="$(date -u -d "$legacy_until" +%s 2>/dev/null || true)"
  now_epoch="$(date -u +%s)"
  if [[ -z "$until_epoch" || "$until_epoch" -le "$now_epoch" || "$until_epoch" -gt $((now_epoch + 7 * 24 * 60 * 60)) ]]; then
    echo "OCTRIX_LEGACY_AUTH_UNTIL 必须是未来 7 天内的 ISO 时间。" >&2
    exit 1
  fi
fi

install -d -m 0700 "$(dirname "$target_env")"
umask 077
temporary="$(mktemp "$(dirname "$target_env")/.octrix-env.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

{
  printf 'OCTRIX_PUBLIC_URL=%s\n' "$public_url"
  printf 'OCTRIX_TOKEN_PEPPER=%s\n' "$pepper"
  printf 'OCTRIX_GOOGLE_OAUTH_CLIENT_ID=%s\n' "${IDEPLOY_GOOGLE_OAUTH_CLIENT_ID:-}"
  printf 'OCTRIX_GOOGLE_OAUTH_CLIENT_SECRET=%s\n' "${IDEPLOY_GOOGLE_OAUTH_CLIENT_SECRET:-}"
  printf 'OCTRIX_GOOGLE_ALLOWED_EMAILS=%s\n' "${IDEPLOY_GOOGLE_ALLOWED_EMAILS:-}"
  printf 'OCTRIX_APPLE_OAUTH_CLIENT_ID=%s\n' "${IDEPLOY_APPLE_OAUTH_CLIENT_ID:-}"
  printf 'OCTRIX_APPLE_NATIVE_CLIENT_ID=%s\n' "${IDEPLOY_APPLE_NATIVE_CLIENT_ID:-com.octrix.mobile}"
  printf 'OCTRIX_APPLE_OAUTH_TEAM_ID=%s\n' "${IDEPLOY_APPLE_OAUTH_TEAM_ID:-}"
  printf 'OCTRIX_APPLE_OAUTH_KEY_ID=%s\n' "${IDEPLOY_APPLE_OAUTH_KEY_ID:-}"
  printf 'OCTRIX_APPLE_OAUTH_PRIVATE_KEY_BASE64=%s\n' "${IDEPLOY_APPLE_OAUTH_PRIVATE_KEY_BASE64:-}"
  printf 'OCTRIX_ALIYUN_ACCESS_KEY_ID=%s\n' "${IDEPLOY_ALIYUN_ACCESS_KEY_ID:-}"
  printf 'OCTRIX_ALIYUN_ACCESS_KEY_SECRET=%s\n' "${IDEPLOY_ALIYUN_ACCESS_KEY_SECRET:-}"
  printf 'OCTRIX_ALIYUN_DYPNS_ENDPOINT=%s\n' "${IDEPLOY_ALIYUN_DYPNS_ENDPOINT:-dypnsapi.aliyuncs.com}"
  printf 'OCTRIX_SMS_SIGN_NAME=%s\n' "$sms_sign_name"
  printf 'OCTRIX_SMS_TEMPLATE_CODE=%s\n' "$sms_template_code"
  printf 'OCTRIX_SMS_SCHEME_NAME=%s\n' "$sms_scheme_name"
  printf 'OCTRIX_SMS_ALLOWED_PHONES=%s\n' "${IDEPLOY_SMS_ALLOWED_PHONES:-}"
  printf 'OCTRIX_WEB_SESSION_TTL_SECONDS=%s\n' '2592000'
  printf 'OCTRIX_SMS_CODE_TTL_SECONDS=%s\n' '300'
  printf 'OCTRIX_AUTHORIZATION_TTL_SECONDS=%s\n' '600'
  printf 'OCTRIX_AUTHORIZATION_POLL_SECONDS=%s\n' '2'
  printf 'OCTRIX_LEGACY_AUTH_ENABLED=%s\n' "$legacy_enabled"
  printf 'OCTRIX_LEGACY_AUTH_UNTIL=%s\n' "$legacy_until"
} >"$temporary"

install -m 0600 "$temporary" "$target_env"
echo "Octrix 环境文件已生成；Google/短信白名单和云厂商访问配置已复制，短信签名/模板使用已确认的 Octrix 配置。"
