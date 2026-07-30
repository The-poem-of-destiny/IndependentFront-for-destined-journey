---
name: powershell-mangles-utf8-source
description: 用 PowerShell Get-Content/Set-Content 批量改本仓库源文件会把中文注释毁成乱码；改文件一律走 Edit/Write 工具
metadata:
  type: feedback
---

**绝不用 PowerShell 的 `Get-Content ... | Set-Content` / `-replace` 去批量改本仓库的源文件。**
批量替换要么用 Edit 工具逐处改，要么用 Write 整文件重写。

**Why:** 本仓库几乎每个 `.ts` / `.vue` 都带大段中文注释（UTF-8 无 BOM）。
环境里的 PowerShell 是 **5.1**，`Get-Content` 按系统 ANSI 代码页读取，
`Set-Content -Encoding utf8` 再按 UTF-8 写回 —— 一读一写就把每个汉字变成
`鈥斺€?` 这类乱码，而且**整文件**都毁掉，不只是被替换的那几行。
2026-07-30 诊断素材刷新 bug 时用它做了一次 `[fakeBytes(` → `[bytesPart(` 的
全局替换，一个新写的测试文件当场全成乱码，只能整份重写。
（`-Encoding utf8` 还会带 BOM，是第二个坑。）

**How to apply:** 任何"把 X 全改成 Y"的需求，先看能不能用 `Edit` 的
`replace_all: true`；跨文件的用 Grep 定位后逐文件 Edit。真要脚本化，
用 Bash 工具（Git Bash 默认 UTF-8）而不是 PowerShell。

相关: [[blob-uint8array-typecheck-trap]]（那次替换正是为了修这个 typecheck 陷阱）
