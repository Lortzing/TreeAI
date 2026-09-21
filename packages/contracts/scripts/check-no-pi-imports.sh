#!/usr/bin/env bash
# Pi 类型隔离检查：packages/contracts 内不得引用 Pi 包或 Pi 内部路径。
# 对应任务书 §3.2（Pi 类型隔离）与 Gate 0 验收项"Pi 类型没有泄漏到 contracts"。
#
# 用法：bash scripts/check-no-pi-imports.sh
# 退出码：0 = 无 Pi 引用；1 = 发现 Pi 引用。
set -u

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if grep -rn -E "pi-coding-agent|@earendil-works" "$PKG_DIR/src" "$PKG_DIR/tests" 2>/dev/null; then
  echo "FAIL: contracts 内发现 Pi 引用（违反 Pi 类型隔离）。" >&2
  exit 1
fi

echo "ok: no Pi imports in packages/contracts (src + tests)"
exit 0
