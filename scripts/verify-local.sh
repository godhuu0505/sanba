#!/usr/bin/env bash
# SANBA ローカルスタックの疎通スモークテスト。
#
# `just up` (アプリ最小構成) または `just up-full` (補助スタック込み) で起動した後に
# 実行し、各コンポーネントが応答しているかを確認する。実 creds を伴う音声 E2E は
# 対象外 (ここは「配線が通っているか」の確認)。
#
#   ./scripts/verify-local.sh          # アプリ最小構成を確認
#   ./scripts/verify-local.sh --full   # 補助スタックも確認
set -uo pipefail

FULL=false
[[ "${1:-}" == "--full" ]] && FULL=true

pass=0
fail=0

check() {
  local name="$1" url="$2" expect="${3:-}"
  printf '  %-26s ' "$name"
  local body
  if body=$(curl -fsS --max-time 5 "$url" 2>/dev/null); then
    if [[ -z "$expect" || "$body" == *"$expect"* ]]; then
      echo "OK"
      pass=$((pass + 1))
      return
    fi
    echo "FAIL (unexpected response)"
  else
    echo "FAIL (no response)"
  fi
  fail=$((fail + 1))
}

check_container() {
  local svc="$1"
  printf '  %-26s ' "$svc (container)"
  if docker compose ps --status running --services 2>/dev/null | grep -qx "$svc"; then
    echo "running"
    pass=$((pass + 1))
  else
    echo "NOT running"
    fail=$((fail + 1))
  fi
}

check_port() {
  # TCP ポートが接続を受け付けているかだけ確認する (HTTP の成功エンドポイントを問わない)。
  local name="$1" host="$2" port="$3"
  printf '  %-26s ' "$name"
  if timeout 5 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null; then
    echo "OK"
    pass=$((pass + 1))
  else
    echo "FAIL (port closed)"
    fail=$((fail + 1))
  fi
}

echo "== アプリ最小構成 =="
check "api /healthz"            "http://localhost:8080/healthz"            '"status":"ok"'
check "web (Next.js)"          "http://localhost:3000"
check "livekit"                "http://localhost:7880"
check "elasticsearch"          "http://localhost:9200/_cluster/health"
# Firestore エミュレータのルートは HTTP 成功エンドポイントではないため、ポート疎通で確認する。
check_port "firestore emulator" localhost 8200
check_container "agent"

if $FULL; then
  echo "== 補助スタック (tools) =="
  check "prometheus"           "http://localhost:9090/-/healthy"
  check "grafana"              "http://localhost:3001/api/health"        '"database"'
  check "loki"                 "http://localhost:3100/ready"
  check "tempo"                "http://localhost:3200/ready"
  check "langfuse"             "http://localhost:3030/api/public/health"
  check "four-keys /metrics"   "http://localhost:9301/metrics"
fi

echo
echo "結果: ${pass} OK / ${fail} FAIL"
[[ $fail -eq 0 ]] || exit 1
