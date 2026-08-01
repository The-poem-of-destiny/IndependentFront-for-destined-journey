---
name: prettier-baseline-dirty
description: CI 跑 format:check，但仓库基线本身有 423 个文件不合格——只格式化自己动过的文件，别跑 npm run format
metadata:
  type: project
---

`.github/workflows/ci.yml` 的步骤是 typecheck → typecheck:vue → **format:check** → lint → test:run，
但 `npm run format:check` 在干净的 HEAD 上就报 **423 files**（2026-07-31 实测，大头是 `docs/**/*.md`，
`src/` 里也有，例如 `workshop-manifest.ts` / `types.ts` / `workshop-store.ts` / 若干 `*.test.ts`）。

**Why:** 看到 format:check 红会误以为是自己弄坏的，然后跑 `npm run format` —— 那会一次改 423 个文件，
把本次改动淹进一场全仓格式化 diff 里，review 直接作废。

**How to apply:** 只校自己动过的文件，逐个 `npx prettier --check <file>`；要判断某个 warn 是不是自己引入的，
拿 `git show HEAD:<file>` 落到临时文件再 check 一次对比。新建的文件必须一次写成 prettier 风格
（常见触发点：函数签名超 100 列要拆行、`expect(...)` 长链的换行位置）。
lint 是 0 errors / 165 warnings 的基线，别为清 warning 顺手改无关文件。

相关：[[known-flaky-tests]]（测试侧的同类基线）
