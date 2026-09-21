#!/usr/bin/env bash
# 反例类型测试：tests/negatives/*/ 下每个用例都必须编译失败。
#
# 用法：
#   TSC=<tsc 可执行文件路径> bash scripts/run-negative-type-tests.sh
# 未设置 TSC 时回退到 PATH 中的 tsc（需 workspace 依赖安装后可用，
# 见 coordination/d2/CONTRACT-FREEZE-1.md 的验证命令占位）。
#
# 退出码：0 = 全部反例如预期被拒绝；1 = 有反例意外通过（契约失效）
#         或环境错误（tsc 不可用）。
set -u

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSC="${TSC:-tsc}"

if ! command -v "$TSC" >/dev/null 2>&1; then
  echo "ERROR: tsc 不可用（TSC=${TSC}）。请设置 TSC=<tsc 路径> 或安装 workspace 依赖。" >&2
  exit 1
fi

fail=0
count=0
for cfg in "$PKG_DIR"/tests/negatives/*/tsconfig.json; do
  [ -e "$cfg" ] || continue
  case_dir="$(dirname "$cfg")"
  count=$((count + 1))
  if "$TSC" -p "$case_dir" >/dev/null 2>&1; then
    echo "NEGATIVE-TEST UNEXPECTED PASS（契约失效，应编译失败）: $case_dir" >&2
    fail=1
  else
    echo "negative ok（已按预期拒绝）: $case_dir"
  fi
done

if [ "$count" -eq 0 ]; then
  echo "ERROR: 未发现任何反例用例。" >&2
  exit 1
fi

if [ "$fail" -eq 0 ]; then
  echo "negative type tests: ${count}/${count} rejected as expected"
fi
exit "$fail"
