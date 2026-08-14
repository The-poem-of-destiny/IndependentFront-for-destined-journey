#!/usr/bin/env bash
# ===================================================
# 开发启动器（macOS / Linux）—— dev.bat 的 POSIX 孪生实现。
# 用法: npm run dev  （或 bash dev.sh）
# - 清掉 5173-5179 上的残留 Vite 监听
# - 固定端口 5173 启动 Vite
#
# 行为与 dev.bat 保持一致；两边的差异记录在 docs/reference/dev-bat-notes.md。
# 注意本文件与 .bat 不同，注释可以写中文（sh 按行读，不存在 cmd 那个
# 字节偏移错位问题）；但**行尾必须是 LF**，见根目录 .gitattributes。
# ===================================================
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "=============================="
echo "  叙事引擎 开发启动器"
echo "=============================="
echo

# ------------------------------------------------------------------
# 内容仓模式（内容-引擎分离波 4，D14）。
# 默认自动启用：兄弟目录 ../fated_poem_independent_assets/data 存在就进内容仓模式。
# --no-content 强制退回占位模式；--content 为历史兼容参数（等价默认行为）。
# 已显式设置的 POEM_CONTENT_DIR 永远优先，不覆盖。
NO_CONTENT=""
for arg in "$@"; do
  if [ "$arg" = "--no-content" ]; then NO_CONTENT=1; fi
done

if [ -z "${POEM_CONTENT_DIR:-}" ] && [ -z "$NO_CONTENT" ]; then
  CANDIDATE="$HERE/../fated_poem_independent_assets/data"
  if [ -d "$CANDIDATE" ]; then
    POEM_CONTENT_DIR="$(cd -- "$CANDIDATE" && pwd)"
  fi
fi
if [ -n "${POEM_CONTENT_DIR:-}" ]; then
  export POEM_CONTENT_DIR
  echo "[dev] content repo: $POEM_CONTENT_DIR"
fi

# ------------------------------------------------------------------
# 清掉开发端口段上的残留监听。
# lsof 的 -sTCP:LISTEN 已经把 ESTABLISHED / TIME_WAIT 排除在外，也不区分
# IPv4/IPv6 —— 所以这里不需要 dev.bat 那三个 netstat/findstr 细节的对应物。
# lsof 无匹配时退出码为 1，必须 `|| true`，否则 set -e 会当场终止。
if command -v lsof >/dev/null 2>&1; then
  for port in 5173 5174 5175 5176 5177 5178 5179; do
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    for pid in $pids; do
      echo "[clean] 杀掉端口 $port 上的进程 PID=$pid ..."
      kill -9 "$pid" 2>/dev/null || true
    done
  done
  # 给 kill 一点落地时间（对应 dev.bat 里那句 ping -n 2）。
  sleep 1
else
  echo "[clean] 未找到 lsof，跳过端口清理；若 5173 被占用，--strictPort 会直接报错退出。"
fi

echo "[dev] 启动 Vite: http://localhost:5173/"
echo
exec npx vite --port 5173 --strictPort
