---
name: ejs-corpus-fallback-baseline
description: 内置世界书 EJS 语料实测回退基线（45 条含 EJS / 8 条失败），以及 `{{roll}}` 写在 EJS 代码块里推翻设计 D1 宏剥离顺序的事实
metadata:
  type: project
---

用整片编译版 `ejs-runtime.ts` 跑全部 `data/worldbooks/*.json`（509 条目，45 条含 `<%`，空 stats/vars）实测：**8 条失败 = 17.8% 回退率**，高于设计 D10 的 5% 验收线。失败分布：

- `TavernHelper` / `getChatMessage` / `message_id` / `lastMessageId` / `YAML` 未注入 → 6 条（设计 §4 已明确接受的降级）
- `system_core.json#417` 用 `await` → 1 条（§4 已接受）
- `event.json#358` 编译失败：条目里写了 `<%_ if ({{roll 1d100}} >= 100) { _%>` —— **ST 宏嵌在 EJS 代码块内部**

**Why:** 最后这条推翻设计 D1 的顺序约定（「EJS 求值在前、`setvar/getvar/random` 宏剥离在后」）。该条目要求 `{{roll}}` **先**被替换成数字，EJS 才编译得过。而且全仓根本没有 `{{roll}}` 的解析器（`placeholder-registry.ts` 只有 `parseSetvars/resolveGetvars/resolveRandoms`），所以它注定回退。

**How to apply:** 做工坊 P2 接线（renderWorldBookEntries / 装配挂点）时，别把 D10 的「回退率 ≤5%」当硬门槛直接卡——先按上面这张单子归因。要真降回退率，得决定是否在 EJS 求值**之前**插一道宏预剥离（至少 `{{roll}}`），那是对 D1 的修订，需要主人拍板。

**闸门已落地**：这 8 条 uid（343/353/357/358/417/421/477/505）已钉进 `src/sillytavern/worldbook-ejs-corpus.test.ts` 的 `KNOWN_FALLBACK_UIDS` 白名单，断言是**集合相等**（多一条红、少一条也红）。改 EJS 运行时或语料后测试红，先来这份清单归因，别直接改断言。

相关：[[known-flaky-tests]]（既有失败基线的同类判断方法）
