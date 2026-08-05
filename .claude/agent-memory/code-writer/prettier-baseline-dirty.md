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
⚠️ 对比法有个必踩的坑：prettier **按文件路径**向上找配置，临时目录在仓库外 → 它用默认配置
（printWidth 80 等）把**所有**文件都判红，看起来跟没做一样。必须显式 `--config .prettierrc`。
加了之后 2026-08-01 实测：10 个 LF 副本里只有 4 个真红，正好是本次实际写了内容的那 4 个。

**更省事的同一件事**（2026-08-04 实测，不用临时目录也就不会踩配置坑）：
`npx prettier <file> > /tmp/p.ts; tr -d '\r' < <file> > /tmp/o.ts; diff /tmp/p.ts /tmp/o.ts`
—— 无差异就是「内容合格、只是工作副本 CRLF」，CI 那边（Linux/LF 检出）必绿。
`core.autocrlf=true` 且 `.gitattributes` 只声明了 `*.bat`，所以仓库里存的一直是 LF。
判断依据还有一条：`git diff --numstat` 只报你真正改的那几行 = 整份文件没被行尾污染。

format:check 的 glob 是 `{src,server,tests,scripts}/**/*.{ts,vue,css,mjs,cjs}` + 根 `*.{json,js,ts}`
+ 根 `*.md` + `docs/**/*.md` —— **`server/` `tests/` `vite.config.ts` 都在管辖内**（早先这条记成
只有 `src/**`，是错的）。`data/**` 确实不在，`data/defaults/agent-config.json` 本身就不合
prettier 风格，**别去格式化它**。
lint 是 0 errors / 165 warnings 的基线，别为清 warning 顺手改无关文件。

相关：[[known-flaky-tests]]（测试侧的同类基线）
