---
name: typecheck-skips-vue-sfc
description: npm run typecheck (plain tsc) does NOT typecheck .vue SFCs — use npm run typecheck:vue (vue-tsc, now a devDependency; baseline 0 errors as of 2026-07-31)
metadata:
  type: project
---

`npm run typecheck` 是裸 `tsc --noEmit`。虽然 tsconfig 的 `include` 写了 `src/**/*.vue`，
裸 tsc 根本解析不了 SFC，于是 **所有 `.vue` 里的 `<script setup>` 与模板表达式都不在
类型检查范围内** —— 前端改动跑完 typecheck 全绿，不代表那个组件类型上是对的。
`npm run build`（vite）也只 transpile，同样不查类型。

**How to apply:** 只要动了 `.vue`，除 typecheck 外**必须**再跑一次：

```
npm run typecheck:vue        # = vue-tsc --noEmit
```

`vue-tsc` 现在是仓库 devDependency（`^3.3.8`，2026-07-31 实测），不必再用
`npx -p vue-tsc@2.x -p typescript@5.8.3 …` 那套 pin 版本的绕法（那是它还没进
package.json 时的历史办法，留作 npx 拉新版会炸 `ERR_PACKAGE_PATH_NOT_EXPORTED ./lib/tsc`
的备忘）。

**基线：0 条错误**（2026-07-31 实测，全仓）。此前记录的「32 条既有错误、其中 18 条在
SettingsPage.vue」已被修掉 —— 现在**任何输出都是你弄坏的**，别当基线放过。
想确认 vue-tsc 真的在查模板（而不是静默空跑），往某个 SFC 模板里塞一句
`{{ someStore.__bogus__ }}` 跑一次，应报 TS2339，再还原。

**Why 这个洞会放过真实运行时 bug（不只是风格问题）:** 2026-07-29 在 `SettingsPage.vue`
里发现「清除所有数据」写的是 `const { deleteDatabase } = await import('@engine/database')`，
而 database.ts 只导出 `clearAllData` —— 解构出 `undefined`、点下去必抛 TypeError，
且抛在关弹窗与 toast 之前（表现成「点了没反应」）。同样的写法放 `.ts` 里裸 tsc 一眼就抓。

**额外守护:** 源码级测试用 Vite 的 `?raw` 读 SFC 文本，正则抠出所有
`await import('@engine/…')` 的解构名逐个对照模块真实导出
（见 `src/ui/components/settings/SettingsPage.engine-imports.test.ts`）。
**别在 `src/**` 下 `import 'fs'`** —— 仓库没装 `@types/node`，会让 typecheck 报 TS2307；
`?raw` 的类型由 `src/env.d.ts` 引的 `vite/client` 提供，直接就是 string。

**再补一道：`npx eslint "src/ui/**/*.{ts,vue}"`。** vue-tsc 与 vitest 都**不**报
`vue/no-dupe-keys` —— props 里有 `social`、`<script setup>` 里又 `const social = useXStore()`
时，两处都全绿，只有 eslint 报错（2026-08-01 实测于 WorkshopSocialActions.vue）。
模板里到底解析到哪一个是运行时才见分晓的事，改 SFC 后顺手跑一次 eslint 最省事。

相关：[[known-flaky-tests]]（测试侧的同类基线）。
