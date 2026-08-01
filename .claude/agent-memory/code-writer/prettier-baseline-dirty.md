---
name: prettier-baseline-dirty
description: 本地 format:check 报 400+ 文件是 Windows CRLF 工作副本的假象，仓库内容其实是干净的——只校自己动过的文件，别跑 npm run format
metadata:
  type: project
---

`.github/workflows/ci.yml` 的步骤是 typecheck → typecheck:vue → **format:check** → lint → test:run。
本地 `npm run format:check` 在干净 HEAD 上就报 **400+ files**（2026-07-31 实测 452），
但这**不代表仓库内容不合格**：`.prettierrc` 有 `"endOfLine": "lf"`，而 Windows 工作副本被
git 换成了 CRLF → prettier 逐文件判失败。把 `git show HEAD:<file>` 的内容（LF）落到临时目录
连同 `.prettierrc` 一起 check，同一批文件**全部通过** —— CI 在 Linux/LF 上看到的就是这个结果。

**Why:** 两个方向都会踩坑。①看到本地 format:check 全红就跑 `npm run format`，会把 400+ 文件
的行尾/格式改动淹掉本次 diff；②反过来以为「反正基线就是红的」而不管自己新写的代码格式，
CI 会真的红——因为 CI 那边基线是绿的。

**How to apply:** 只对自己动过的文件跑 `npx prettier --write <files>`（LF 改写在 git 里不可见，
`git diff --stat` 仍是正常行数，无害）。要确认某个 warn 是不是自己引入的，就用上面
「git show HEAD → 临时目录 + .prettierrc → prettier --check」的对比法，别只看本地全量结果。
`data/**` 不在 format:check 的 glob 内（globs = `src/**/*.{ts,vue,css}` / 根 `*.json` / `docs/**/*.md`），
`data/defaults/agent-config.json` 本身就不合 prettier 风格，**别去格式化它**。
lint 是 0 errors / 165 warnings 的基线，别为清 warning 顺手改无关文件。

相关：[[known-flaky-tests]]（测试侧的同类基线）
