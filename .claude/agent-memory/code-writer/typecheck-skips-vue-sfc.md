---
name: typecheck-skips-vue-sfc
description: npm run typecheck (plain tsc) does NOT typecheck .vue SFC scripts/templates — green typecheck is no proof a Vue component compiles type-safely
metadata:
  type: project
---

`npm run typecheck` 是裸 `tsc --noEmit`，仓库里**没有装 vue-tsc**。虽然 tsconfig 的
`include` 写了 `src/**/*.vue`，裸 tsc 根本解析不了 SFC，于是 **所有 `.vue` 里的
`<script setup>` 与模板表达式都不在类型检查范围内** —— 前端改动跑完 typecheck 全绿，
不代表那个组件类型上是对的。`npm run build`（vite）也只 transpile，同样不查类型。

**Why:** 2026-07-29 写素材设置分区（`settings/AssetSection.vue` + `settings/assets/*`）时
发现的：typecheck 与 build 双绿，但两个 SFC 里各有一处重复 `import { inject }`、一处
CSS 少写冒号，全靠人眼与 vue-tsc 才抓到。

这个洞会放过**真实的运行时 bug**，不只是风格问题: 2026-07-29 在 `SettingsPage.vue` 里
发现「清除所有数据」写的是 `const { deleteDatabase } = await import('@engine/database')`,
而 database.ts 只导出 `clearAllData` —— 解构出 `undefined`、点下去必抛 TypeError，
且抛在关弹窗与 toast 之前（表现成"点了没反应"），大概从上线起就没成功过。
`await import()` 的解构名如果放在 `.ts` 里，裸 tsc 一眼就能抓，放进 `.vue` 就彻底失明。

**守护办法（不改 tsconfig / 不加依赖）:** 写源码级测试，用 Vite 的 `?raw` 读 SFC 文本，
正则抠出所有 `await import('@engine/…')` 的解构名，逐个对照模块真实导出
（见 `src/ui/components/settings/SettingsPage.engine-imports.test.ts`）。
**别在 `src/**` 下 `import 'fs'`** —— 仓库没装 `@types/node`，会让 typecheck 报 TS2307；
`?raw` 的类型由 `src/env.d.ts` 引的 `vite/client` 提供，直接就是 string。

**How to apply:** 只要动了 `.vue`，除了 typecheck/build，再补一次 SFC 检查：

```
npx -y -p vue-tsc@2.2.10 -p typescript@5.8.3 vue-tsc --noEmit
```

两个坑：①光 `npx vue-tsc` 会拉到新版 TypeScript 并炸在
`ERR_PACKAGE_PATH_NOT_EXPORTED ./lib/tsc`，必须像上面那样把 TS 一起 pin 住
（`-p typescript@5.6.3 -p vue-tsc@2.1.10` 这一对也验证可用）。
②输出里有既有错误基线，2026-07-29 实测**恰好 32 条**，其中 **18 条集中在
`SettingsPage.vue`**（`PresetItem.settings` / `.template` 类型上不存在 —— 真类型漂移，
已作为已知缺陷记进素材设计文档 §12，刻意未修），其余散在
CreateStepPlot(5)/CombatMessageFlow(2)/CharacterListPanel(2)/WorldBookEditor/MapPanel/
ChatFlow/CustomItemForm/CreateStepBackground 各 1。这是基线不是你弄坏的 ——
数总数 + 按路径分组比对最快：

```
… vue-tsc --noEmit -p tsconfig.json 2>&1 | grep -oE "^[^(]+\.vue" | sort | uniq -c | sort -rn
```

相关：[[known-flaky-tests]]（测试侧的同类基线）。
