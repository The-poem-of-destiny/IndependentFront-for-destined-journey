# 地图 v1.2 实施计划（lean-delegation 编排）

> 状态：**实施中（2026-08-18）**。设计真源：同目录 `2026-08-18-map-tile-dynamics-v1.2-design.md`
> （ADR-33，16 条裁定）。本文是波次编排与逐任务 brief 摘要；照
> `2026-08-04-image-generation-implementation-plan.md` 的先例，实施完在开头补
> 「实际执行情况」一节记录与计划的偏差。
>
> 范围：**仅公开仓**。跨仓后续（内容仓编译管线 / sample-map 编辑器 / 私有仓 uid 510）
> 见设计 §6 末节，不在本轮。

## 波次总览

```
W1a 类型+pack 容错     ─┐（并行）
W1b time-ledger        ─┘
        ↓
W2  map-dynamics 纯函数叶
        ↓
W3  state-manager 接线（op 六件套 + 结算钩子 + 首访 + 翻译层 + dispatcher 教学）
        ↓
W4  读侧（map-context / MAP_CONTEXT / $map / 供值）─┐（并行）
W5  UI 地块详情扩展                                 ─┘
        ↓
W6  验证（npm run gates 全量 + 主会话审查）
```

顺序理由：W3 与 W4 都要动 `types.ts`（op 联合 / `AgentContext.mapFacts`），
不并行以免同文件互踩；W4 与 W5 文件面完全不相交（引擎读侧 vs Vue 组件），可并行。
四类系统通知走既有 `SaveProfile.news[]` 通道（`addNews`），**无需新 UI** —— W5 只做地块详情。

## 关键锚点（scout 实测，2026-08-18）

- op 联合 `types.ts:1875`；handler 表 `state-manager.ts:2618`（`PATCH_HANDLERS`，缺 op 编译报错）；
  value 必填白名单 `state-manager.ts:602`。
- dispatcher 翻译 `vars-update-translator.ts:94`（`buildDispatcherPatches`）。
- `applyTimeAdvance` `state-manager.ts:2262`：锁内顺序 advanceTime → `syncMapWeather(:2279)` →
  `syncRandomEvents(:2285)` → **结算钩子插这里** → 尾部锁外自提交 `:2359`。
  游戏日 idiom：`gameDayOf(:1980)` = `toEpochMinutes/MINUTES_PER_GAME_DAY`。
- facts 存取先例（照抄）：`save-profile.ts:369-409` 的 randomEvents 四件套
  （KEY / get / update / setInPlace，`:390` 注释明言「事实不清空」契约）。
- 通知通道：`save-profile.ts:135` `addNews`（`NewsItem` 在 `types.ts:3019`）。
- 入账先例：`coordinator.ts:2144` `{op:'update_character', target:'characters.<名>',
value:{money:n}, metadata:{delta:true}}`（`money` 已在 UPDATE_CHAR 两张白名单）；
  玩家识别 `state-manager.ts:1990`（`type === 'player'`）。
- MAP_CONTEXT 链：resolver `placeholder-registry.ts:624`；供值 `game-pipeline.ts:872`；
  源码断言测试 `placeholder-registry.map-context.test.ts:428`（`toContain`，加行不破、需补断言）。
- `$map`：`ejs-capabilities.ts:355-390`（纯数据、ASCII 键、deep-clone）。
- UI 信息卡：`MapPoliticalTab.vue:1174-1245`（`.pol-card`）；读法先例 `:368`
  （直接 `getMapFlags(profile)`）。**该组件无组件测试**（只有 lib 级 map-political.test.ts）。
- 零中文闸门：`map-literals-gate.test.ts:47` glob `map-*.ts` —— 新建 `map-dynamics.ts` 自动纳管。

## 逐任务 brief 摘要

| 波  | 任务         | 产出                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1a | 类型 + pack  | `types-map.ts` 加 pack v1.2.0 字段（`developmentLevels?` / `MapTile.development?` / `MapTile.buildings?`）与事实类型（`TileStatus`/`TileStatusEffect`/`BuildingRecord`/`TileHistoryEntry`/`TileFactsEntry`/`MapFactsFlags`）；`map-pack.ts` 容错扩展（旧包零影响）；`public/data/content/map-pack.json` 补中立占位字段；coercion 测试                                            |
| W1b | 时间账本     | 新 `time-ledger.ts`：`periodsDue(anchor, period, prevDay, nextDay)` / 到期判定等零簿记纯函数 + 测试（跨多期 / 锚未到 / 负跨度防御）                                                                                                                                                                                                                                              |
| W2  | 动态纯函数叶 | 新 `map-dynamics.ts`：有效视图（基线⊕事实）/ copy-on-write 播种 / 状态刷新与到期 / 进度结算与升降档（升清 0 / 降落 50 / 双端钳位）/ 严格槽位摧毁 / 最小空槽落位 / 编年史（10 条 FIFO + 首访钉扎、结构化条目零中文）/ 收益到期清单。全量测试                                                                                                                                      |
| W3  | 引擎接线     | `types.ts` op 联合 +6；`PATCH_HANDLERS` 六 handler（按名解析失败 warn 忽略）；`save-profile.ts` mapFacts 四件套；`applyTimeAdvance` 结算钩子（到期→事实更新 + 收益 patch 入玩家 `money` + `addNews` 四类通知）；`syncMapLocation` 旁观首访记档；`vars-update-translator.ts` dispatcher 输出段 → 六 op；`agent-config.json` dispatcher 教学段（**改完必跑编码三判据**）；接线测试 |
| W4  | 读侧         | `map-context.ts` 快照扩展（本块全量+编年史头条 / 邻块头条行，数据面零中文）；`AgentContext.mapFacts` + `game-pipeline.ts` 供值行 + 源码断言补条；`placeholder-registry.ts` MAP_CONTEXT 中文渲染；`ejs-capabilities.ts` `$map` 扩展；测试                                                                                                                                         |
| W5  | UI           | `MapPoliticalTab.vue` 信息卡扩展：发展条+档名徽章 / 状态列表（倒计时、永久徽章）/ 建筑槽格（玩家产业高亮）/ 编年史列表。遵循 `docs/design.md`；样式随组件既有体系                                                                                                                                                                                                                |
| W6  | 验证         | `npm run gates` 全量（八闸门）+ 主会话 diff 审查 + 修复轮                                                                                                                                                                                                                                                                                                                        |

## 纪律（每个 brief 附带）

- 子 agent 全部 **Opus / medium effort**；不许再生 subagent。
- 改中文 JSON/文档后必跑编码三判据（U+FFFD 0 / ctrl 0 / JSON 可解析）。
- 改过的文件跑 `npx prettier --write <files>`（只 write 自己改过的）。
- 引擎 `map-*.ts` 零中文字面量（闸门自动纳管）；`src/sillytavern/**` 禁 import 前端。
- 报告 ≤15 行：改动文件单行摘要 + 验证命令与结果 + 阻塞项；不贴代码。

## 实际执行情况（2026-08-18 回填）

计划 6 波，实际跑了 **7 波 8 任务 + 2 次定向返工**，全部一次或两次通过：

- **W1a/W1b 并行** 照计划。W1b 主动少交了一样：不导出无消费方的钩子类型（knip 棘轮会红），
  钩子类型归 W3 —— 正确的偏差，计划里「time-ledger.ts + 钩子类型」的分配写错了波。
- **W2 一次返工（裁定违反，brief 的锅）**：主会话 brief 里一句「multi-level cascade」诱导
  实现了进度溢出结转（+250 一口气跨两档），与裁定 §8-7（升档清 0、溢出丢弃、单次至多跨一档）
  冲突。返工同时把结算从「合并成一笔大 delta」改为**逐期顺序结算**（不结转后两者不再等价，
  长时间跳跃仍能逐档下滑，单笔 op 永远至多一档）。教训：brief 里的示例也要对着裁定表核一遍。
- **W3 照计划**，顺带把六 op 的 value 形状钉进 `VALUE_REQUIRED_OPS`。
- **W4/W5 并行** 照计划。两个 agent 各自独立收敛出同一条读侧规则（发展度只在「pack 声明过
  或已有事实」时渲染，旧包不长幻影 Lv1）—— 已回写设计 §8 的 📌 注记。W5 顺手修了
  `MapPanel.test.ts` 假 profile 无 `gameTime` 导致的 13 个既有测试炸点（防御读）。
- **W5.5（计划外整波）**：主人实施中追加「主建筑」特性（裁定 §8-17~19 补裁）——
  独立字段不占槽 / 作者名+档位通名派生 / 同套所有权语义。单 agent 全栈落地，
  新增 `renamed` 编年史事件类（改名要记档但引擎零中文，`note` 承载不了）。
- **W5.5 一次返工（自报缺口）**：`EJS_SURFACE.namespaces.$map` 漏列 v1.2 新键 ——
  W4 的遗漏被 W5.5 的 agent 发现。修复补了**双向**键集相等断言（旧测试只查表→对象单向，
  这正是缺口能活下来的原因）。
- **W6 验证**：`npm run gates` 全量 + diff 审查（分层/零中文/锁纪律/自愈边界/写路径五准则）。

测试规模：8869（W1 后）→ 9030（W5.5 返工后），新增约 160 用例。
全程 `content-store-registry.test.ts` 已知合跑 flake 未复现。
