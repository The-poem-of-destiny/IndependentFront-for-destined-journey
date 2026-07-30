---
name: bat-stderr-harness-dependent
description: 验证 .bat「无 stderr 噪音」时，测量姿势会改变结论 —— PowerShell Start-Process 恒报 0，只有 Git Bash 的 cmd.exe /c 能复现
metadata:
  type: feedback
---

在 Windows 上验证一个 `.bat`「跑起来干不干净」时，**不能只用一种调用姿势测**。同一个文件、同一台机器：

- `Start-Process -RedirectStandardOutput/-RedirectStandardError`（PowerShell）→ stderr **恒为 0**
- 先 `chcp 936` 再 `call` 的包装 bat → stderr **恒为 0**
- `MSYS_NO_PATHCONV=1 cmd.exe /c "C:\full\path.bat" > o.txt 2> e.txt < /dev/null`（Git Bash）→ **940 B**，问题现形

**Why:** 2026-07-30 修 `dev.bat` 的 `chcp 65001` 解析器错位时实测到的。前两种姿势会让人得出「这 bug 不存在」的结论并直接收工；只有第三种复现出了报告里说的字节数。差异来自控制台代码页与句柄形态（本机 OEMCP=936，但 Claude Code 的 shell 已把控制台设成 65001）。

**How to apply:** 任何「让 stderr 变干净」「脚本有噪音输出」类任务，先用 Git Bash + `cmd.exe /c` + 完整路径 + 分离重定向复现出报告中的字节数，**再**动手改；改完用同一个 harness 复测。测不出来 ≠ 没问题。

配套：测 `dev.bat` 这类会 `taskkill` 的脚本，必须先把端口号改成等长的安全值（`5173,...,5179` → `5973,...,5979`，等长保证字节偏移不变、不影响解析器错位的复现），并把 `npx vite` 换成 echo stub —— 主人的 dev server 就跑在 5173 上，曾有 agent 把它杀了。

相关：[[powershell-mangles-utf8-source]]（同一台机器上 PowerShell 处理中文/编码的另一个坑）
