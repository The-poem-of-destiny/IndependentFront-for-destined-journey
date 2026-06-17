#!/bin/bash
# Phase 完成通知脚本 — 声音 + 弹窗 + 终端横幅
# 用法: bash scripts/notify.sh "Phase 4.5 完成!" "607 tests passed"

PHASE_NAME="${1:-Phase 完成}"
DETAIL="${2:-}"

echo ""
echo "════════════════════════════════════════════════════════"
echo "  🔔 ${PHASE_NAME}"
if [ -n "$DETAIL" ]; then
  echo "  📋 ${DETAIL}"
fi
echo "════════════════════════════════════════════════════════"
echo ""

# Windows Toast 通知 (PowerShell)
powershell -NoProfile -Command "
Add-Type -AssemblyName System.Windows.Forms;
\$notification = New-Object System.Windows.Forms.NotifyIcon;
\$notification.Icon = [System.Drawing.SystemIcons]::Information;
\$notification.BalloonTipTitle = '${PHASE_NAME}';
\$notification.BalloonTipText = '${DETAIL}';
\$notification.Visible = \$true;
\$notification.ShowBalloonTip(5000);
Start-Sleep -Seconds 6;
\$notification.Dispose();
" 2>/dev/null || true

# 系统声音 (响 3 下)
for i in 1 2 3; do
  powershell -NoProfile -Command "[System.Media.SystemSounds]::Asterisk.Play()" 2>/dev/null || true
  sleep 0.3
done
