---
name: prettier-baseline-dirty
description: format:check 的 Windows CRLF 假红已于 2026-08-17 修好（endOfLine 改 auto），本地现在直接可信；glob 覆盖面与「别碰哪些文件」仍需记住
metadata:
  type: project
---

## 已修（2026-08-17）：本地 format:check 现在是可信闸门

`.prettierrc` 的 `"endOfLine"` 由 `"lf"` 改成 `"auto"`（infra-1）。
`core.autocrlf=true` 保证入库仍是 LF，Linux CI 的 LF 检出照常通过；
Windows 工作副本的 CRLF 不再被逐文件判红。改前 `npm run format:check` 报 **776 files**，
改后同一条命令 → `All matched files use Prettier code style!`，且**零文件被重写**。

**Why:** 此前那 776 条全是行尾噪声，逼出一整套「只 --write 自己动过的文件 / CR-剥离 diff 对比 /
git diff --numstat 分辨真假改动」的手工流程。那套流程现在**不再需要**——直接跑
`npm run format:check`，红就是真红。

**How to apply:** 改完文件直接跑 `npm run format:check`；要修就 `npx prettier --write <你改过的文件>`。
仍然**不要**跑仓库级 `npm run format`（没必要，且会把无关文件卷进 diff）。
如果哪天又看到大批假红，先确认 `.prettierrc` 里的 `endOfLine` 没被改回 `lf`。

## 仍然有效的事实

format:check 的 glob 是 `{src,server,tests,scripts}/**/*.{ts,vue,css,mjs,cjs}` + 根 `*.{json,js,ts}`
+ 根 `*.md` + `docs/**/*.md` + `public/data/**/*.json`
—— **`server/` `tests/` `vite.config.ts` `package.json` 都在管辖内**。
`data/**` 不在：`data/defaults/agent-config.json` 本身就不合 prettier 风格，**别去格式化它**。
`.mts` / `.d.mts` 两边都不在 glob 里（见 infra-4）。

🔴 **`.html` 不在 glob 里**：`src/ui/components/home/*.standalone.html` 那批研究页
`npx prettier --check` 全报红，但 CI 根本不看它们。给 standalone html 跑 `--write` 是**纯添乱**
（会把 veil SPECS 那种一行一条的数组表拆成几百行，破坏作者刻意的可读排版）。
新增 standalone html 只需保持 LF 行尾，格式不用管。

## 一键跑全部闸门

`npm run gates`（2026-08-17 新增，infra-2）= CI 九道闸门的本地等价，按 CI 顺序串联：
typecheck → typecheck:vue → typecheck:tools → build → format:check → lint → knip:ratchet → test:run。
**`typecheck:tools` 是 `tests/` `server/` `*.config.ts` 的唯一类型网**（主 tsconfig 只 include `src/**`），
历史上两次 CI 挂红都是漏跑它（PR #109 之后的 6b9e474、更早的 37d0544）。

相关：[[known-flaky-tests]]（测试侧的基线）、[[crlf-breaks-mutation-scripts]]（同一个 CRLF 事实的另一处咬人，脚本侧仍然咬）
