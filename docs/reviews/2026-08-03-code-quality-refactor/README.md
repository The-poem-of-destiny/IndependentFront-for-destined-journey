# 代码质量与重构审查报告（2026-08-03）

> 本报告拆成多个文件。本文是索引：审查信息、**[进度追踪](#进度追踪)**、结论摘要、系统性主题与优先级总表。详细发现按主题分档，路线图与健康面各自独立。

## 文档结构

| 文件                                                                                         | 内容                                           | 发现数 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| [T1 接线缺口：内核跑通了，产品没接上](findings-t1-wiring-gap.md)                             | 该主题的详细发现（证据 / 影响 / 重构建议）     | 4      |
| [T2 AI 文本与引擎状态之间没有唯一的编解码缝](findings-t2-ai-boundary.md)                     | 该主题的详细发现（证据 / 影响 / 重构建议）     | 5      |
| [T3 真源分裂：同一份事实被抄成 2–6 份，每份都是一条静默漂移线](findings-t3-single-source.md) | 该主题的详细发现（证据 / 影响 / 重构建议）     | 10     |
| [T4 僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路](findings-t4-corpses.md)                  | 该主题的详细发现（证据 / 影响 / 重构建议）     | 3      |
| [T5 分层塌陷：seam 说过要落但没落，巨石继续长](findings-t5-layering.md)                      | 该主题的详细发现（证据 / 影响 / 重构建议）     | 6      |
| [T6 质量网的缺口：类型、测试与工具链没盖住最容易出错的地方](findings-t6-safety-net.md)       | 该主题的详细发现（证据 / 影响 / 重构建议）     | 3      |
| [重构路线图](roadmap.md)                                                                     | 8 个排序步骤 + 刻意延后的 9 条及其理由         | —      |
| [健康面与覆盖缺口](health-and-gaps.md)                                                       | 做得好的地方、本轮没覆盖到的面、70→31 归并记录 | —      |

## 审查信息

| 项目     | 内容                                                                                  |
| -------- | ------------------------------------------------------------------------------------- |
| 基线     | `master` @ `1c9e743`（Improve generation and workshop regex compatibility, #24）      |
| 范围     | 全仓 868 个 tracked 文件，约 123k 行非测试 TS/Vue，207 个 `*.test.ts`                 |
| 主题     | **代码质量与可重构性**。安全、CI、打包、发布形态不在本轮范围                          |
| 方法     | 7 个切片并行审查 → 每切片一轮对抗式复核（试图证伪）→ 归并/排序/路线图                 |
| 原始产出 | 70 条经复核的 finding，归并为 31 条（合并记录见附录 B）                               |
| 基线质量 | `typecheck` / `typecheck:vue` / `format:check` / `lint` / `test:run` 五道 CI 闸门全绿 |
| 测试基线 | 207 个测试文件，5829 passed / 3 skipped，16.56s                                       |

**与既有审查的关系**：`docs/reviews/` 下已有三份报告，覆盖安全（工坊正则 XSS、EJS 沙盒逃逸、dev server 路径穿越、通配 CORS 代理、工坊供应链未签名）、CI 缺口、Windows-only 启动脚本、文档陈旧与包元数据。本轮刻意不复述这些结论，只做质量与重构面的补集。

## 进度追踪

> **状态只记在本节 + 下方优先级总表的「状态」列**——findings 各文件不重复标注，免得这份报告自己长成第 32 条真源分裂。每合入一个 PR，改这两处即可。
>
> 报告正文（结论摘要 / 各 findings 文件）描述的是**基线 `1c9e743` 时的现场**，刻意不随修复改写——那是发现当时的证据；仅在结论摘要的三条头条上加了指回本节的 ✅ 指针，免得只看摘要的人把已修的当成现状。

| 状态 | 含义                                     |
| ---- | ---------------------------------------- |
| ✅   | 已完成，有测试或可复核的证据             |
| 🔄   | 部分完成，剩余项写在备注列               |
| ⬜   | 未开始（下表备注里附本次核对的抽查结果） |

**核对基线**：`master` @ `02c8214` + 本 PR · `typecheck` / `typecheck:vue` / `typecheck:tools` / `lint` 全绿 · `vite build` 通过 · 213 个测试文件 · 5843 passed / 4 skipped

### 按路线图步骤

| 步骤                                      | 包含                   | 状态 | 备注                                                                                                                                              |
| ----------------------------------------- | ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [步骤 1](roadmap.md) 清尸体 + 补工具链网  | Q-04、Q-15             | ✅   | 四批僵尸清完 + 补网与清仓两个 PR 都落地                                                                                                           |
| [步骤 2](roadmap.md) 修静默出错的生产路径 | Q-01、Q-02             | ✅   | 两条全部兑现（`a0c3d5d`），骰子那条建议仍需真机打一场复核                                                                                         |
| [步骤 3](roadmap.md) 三处去留裁定         | Q-07、Q-03、Q-30       | ✅   | 三条裁定均已拍板并落地（Q-07 含 emit 源 + 效果回收 + 战斗内 12/18 显式化）                                                                        |
| [步骤 4](roadmap.md) AI 输出编解码收口    | Q-05、Q-13、Q-14、Q-17 | ✅   | 四条全部落地                                                                                                                                      |
| [步骤 5](roadmap.md) 数据路径去重         | Q-08、Q-16、Q-12       | ✅   | 三条全部落地（api-key 那份迁移按裁定留在外面）                                                                                                    |
| [步骤 6](roadmap.md) 品质体系与设置真源   | Q-11、Q-18、Q-06       | ✅   | 三条全部落地。Q-18 的 `UiSettings` 与 12 张 map 物理合并已于 2026-08-04 经主人拍板后完成（真机验证过老 localStorage 往返）                        |
| [步骤 7](roadmap.md) EJS 能力面 + Legacy  | Q-09、Q-10、Q-27       | 🔄   | 三条各自落地了不依赖真机的那半；剩下的都压在同一个前置上——**Legacy 退役需真机走查**（别名层共享源码要与它同批，否则失去 parity 这唯一的差分护栏） |
| [步骤 8](roadmap.md) 巨石拆分第一刀       | Q-23、Q-19             | 🔄   | Q-19 两个 PR 全落；Q-23 未动——它要先拍板域边界（`EffectIntent` 的传递闭包 ~400 行，盲搬等于替主人做决定）                                         |
| [后续批次](roadmap.md#后续批次不进前八步) | 其余 9 条              | 🔄   | Q-22 / Q-31 / Q-26 已做完；Q-25 视图层巨石本轮拆掉了 8 个分区 + StatusOverview 画像段（Agent 目录等 Q-18）；其余 5 条的延后理由仍成立，见下       |

### 已落地的提交

| 提交      | 覆盖                     | 说明                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a0c3d5d` | Q-01、Q-02               | `drawDice` 改必填依赖、删 `sysDrawSixty`；`applyTimeAdvance` 的 patches 末尾自提交                                                                                                                                                                                                     |
| `cfc9cd2` | Q-04(1-3 批)、Q-15(部分) | 三批僵尸删除 + 文档同步；新增 `tsconfig.tools.json`                                                                                                                                                                                                                                    |
| `ecd68a1` | —                        | prettier 修复（CI `format:check` 红灯）                                                                                                                                                                                                                                                |
| `9fd5a3b` | Q-30                     | 数据拆 `start-catalog-data.ts`；`Rarity` → `CatalogRarityCode`；加防分叉闸门测试                                                                                                                                                                                                       |
| `0a6e7b6` | Q-03                     | 裁定：hiddenLine 保留 + 门槛统一 100 字 + embedding 接线；MEM 编号收敛到一套发号器                                                                                                                                                                                                     |
| `eab3729` | Q-07(部分)               | 裁定：完整接线；新增 `effect-wiring.ts`，装备/卸下/存档加载三处接上注册面                                                                                                                                                                                                              |
| `ebb2cf9` | —                        | 本进度追踪面                                                                                                                                                                                                                                                                           |
| `7b4c2a7` | Q-05 🔄、Q-13 ✅         | 新增 `agent-xml.ts` + `model-json.ts` 两个共享缝（45 条测试）；修 plot_post_check 兜底分支静默空转、item_gen 三处严格 effect 正则丢字段；14 处 `as any` 全删并补出 3 处真类型缺口。Q-05 剩 marker-protocol 走表化                                                                      |
| `cbf6f82` | Q-07 ✅                  | 第二半：`commitChatState` 发事件 + `SubscriptionManager.setEffectSink` 回收效果（反应轮上限 3）；`runWindow` 消掉 8 处静默丢弃；6 个无求值器窗口以 `WINDOW_NOT_WIRED` 编译期掉落                                                                                                       |
| `316acb8` | Q-15 ✅                  | 补网（`typecheck:tools` 进 CI / lint·format 扩到 server·tests·scripts）+ 清仓；补网当场逮到三处过期，含 CharGenSystemCard 把 `string[]` 当字典渲染                                                                                                                                     |
| `c4d01c2` | Q-04 ✅                  | 第四批：删 `variableContext`/`variableInstruction` 闭包与 `buildFallbackMessages`，`DEFAULT_TEMPLATES` 补齐三个退役 Agent；顺带删净 `MatchedEntry`/`lorebookMatches`/`targetCharacterId` 与 `buildZoneSection`                                                                         |
| `a4365c5` | Q-17 ✅                  | `buildRequestBody(request, stream)` + `postCompletions(body, signal)` 收口流式/非流式两份逐字相同的装配；`stream` 是真形参（`stream_options` 只能在流式出现）；超时倍率提为具名常量                                                                                                    |
| `8135359` | Q-05 ✅                  | `marker-protocol` 走表化：8 份相同扫描骨架 → `MARKER_SPECS` + `scanByTag`；`MARKER_TAGS` 与 `scanMarkers` 的合并都由表推导，消掉「两份手抄清单」这条漏扫线；补 2 条数据驱动防分叉闸门                                                                                                  |
| `ba1dba0` | Q-14 ✅                  | 三层失败回执各自收口：编排层解析/结构/落库/时间推进四条日志分家（落库抛异常终于会上浮 `onStateCommitError`）；新建 `store-result.ts` 判别式回执，删掉 UI 反查 store 猜原因；工具层失败一律 throw + `ToolResult`                                                                        |
| `63ddb66` | Q-08 ✅                  | 六步迁移收敛成 `legacy-dexie-migration.ts` 一份（-348 行）；`preStep` 承 beautifier 的第 0 步旁路；两份 `verifyRow` 各自保留强度不降级；api-key 那份刻意留在外面。39 条现有 adapter 测试未改一行 + 15 条骨架测试                                                                       |
| `f227812` | Q-12 ✅、Q-16 ✅         | 删 `variables.ts`/`vars-merger.ts` 两个僵尸宿主，`applyVarsPatch` → `applyPathOps` + `VarPathOps` 进 types；新增 `db-write.ts`（detach 唯一实现）/ `store-utils.ts`（配额判据+notify）/ `asset-path.ts`（+13 测试），`game-store` 三个 metadata 写函数收成 `patchSaveMetadata`         |
| `43c3188` | Q-11 ✅                  | 品质 4 套类型/序号 + 5 份颜色表收敛成一套（全部由 `RARITY_LEVELS`/`TIER_CONFIGS` 派生）；修好 ScenePanel「键错整套词汇」的层级描边色；`CharGenSystemCard` 47 项裸 hex 表删除改主题令牌；`inferQuality` 下沉 `quality-inference.ts`；`ItemsPanel` `any[]` → 判别联合（18 处 cast 归零） |
| `1604575` | Q-06 ✅                  | 设置真源收敛：新增 `engine-settings.ts` 注入缝，删 `syncSnapshotSettings` 那座只搬两个字段的桥 + `settings` 表播种；FullBackup 分支注明只为老备份往返；AGENTS.md 那句「settings 同为死表」（此前是错的）改成事实                                                                       |
| `c70e2e2` | Q-18 🔄                  | 新增 `agent-settings.ts`：`AGENT_SETTINGS_DEFAULTS`（六份拷贝收成一处）+ get/patch/reset/fillMissing 四个口；13 段手抄的加载器、`saveAsDefault`、`restoreAgentDefaults` 两分支全部收口。**剩**：`UiSettings` 接口（审查要求先取得同意）与 13 张 map 的物理合并                         |
| `7f313e0` | Q-09 🔄                  | 新增 `EJS_SURFACE` 唯一真源（4 张名单全部派生）—— `engine.has('world.isDaytime')` 不再返回 false；补 `EjsWorld`/`EjsEngine` 与有签名的 `marshalWorld`；危险键集宿主侧 5 份 → 1 份。**剩**：别名层共享源码（须与 Legacy 退役同批）                                                      |
| `671d269` | Q-10 🔄                  | 两份逐行相同的编译缓存合一并接到生产路径；QuickJS 补 `guestBodyCache`（此前零记忆化，是 348-583ms/pass 的直接来源）；清空口经 `registerEjsCacheClear` 反向注册只留一个。**剩**：同步渲染路径降格（须与 Legacy 退役同批）                                                               |
| `e89cc91` | Q-27 🔄                  | 收掉 `data.sequence!` 非空断言；`measure` 的 O(全部元素) 开销与「为什么不顺手收窄」写进代码。**主体（290 行内嵌运行时切成真 .js）按审查排期约束未做** —— 那是 SEC-01 执行体，须配真机走查                                                                                              |
| `f41824f` | Q-19 🔄                  | 提交层 30 分支 switch → `PATCH_HANDLERS: Record<StatePatchOp, …>`（漏接 op 变编译错误）；资源钳制 10 处 `as any` → `satisfies` 表；13 处 `await import` 转静态                                                                                                                         |
| `ba215ae` | Q-19 ✅                  | 抽 `vars-update-translator.ts`：纯翻译脱离 560 行巨方法，orchestrator 1520 → 1100 行；现有 5808 条未改一行全绿（行为等价）+ 13 条直接喂 parsed 的新测试                                                                                                                                |
| `3368ae3` | Q-22 ✅、Q-31 ✅         | 删 combat-v3 从不被读的 `bundle` 参数（连带 `bundleOf` 与两处 `as never`）；`session.completed` 构造快照 → 活 getter 并收窄到 SettlementCommitted；location-db 邻接按对称收口 + 全表对称性闸门                                                                                         |
| `34db02e` | Q-26 ✅                  | Dexie v13+ 改 `withSchema` delta 写法（-390 行重述），v1–v12 原样冻结；逐字节验证四版键序与索引串全同；更正 v12 那句被证伪的「漏写即删表」                                                                                                                                             |

### 未做的 4 条，以及各自卡在哪

> 都不是"漏了"。每一条要么审查自己写了排期约束，要么需要主人先拍一个板 ——
> 那类决定不该由执行者顺手替主人做掉。

| ID                                                                                                                        | 卡在哪                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Q-09](findings-t3-single-source.md#q-09) 别名层                                                                          | 宿主 TS 与 guest 210 行字符串各写一遍同一套别名。抽共享源码**必须与 Legacy 退役同批**，否则会先失去 `ejs-backend-parity.test.ts` 这唯一的差分护栏                            |
| [Q-10](findings-t4-corpses.md#q-10) 同步路径降格                                                                          | 同上批。且要迁 3 个测试文件约 20 条在 Legacy 默认后端下断言同步渲染输出的基线；`agent-templates.buildAgentMessages`（文档化的公共导出）仍在同步调用它                        |
| [Q-27](findings-t5-layering.md#q-27) 主体                                                                                 | 290 行内嵌运行时是 **SEC-01 隔离契约的执行体**。审查原文：需"由熟悉 SEC-01 契约的人做，并配一次真机走查（切片顺序 / CSP 分档 / 跨帧广播三项各验一次）"                       |
| [Q-23](findings-t5-layering.md#q-23)                                                                                      | 审查要求"动手前先拍板域边界"。`EffectAutomaton` 的传递闭包（`EffectIntent` 及其下游）约 400 行，搬哪些、留哪些是设计决定                                                     |
| [Q-29](findings-t5-layering.md#q-29)                                                                                      | 审查原文："动手前需要一个 owner 定下 seam 位置"，且含一处要主人确认的行为变更 —— 端点列表一次 `run` 内算一次意味着**回合中途改设置不再立即生效**                             |
| [Q-24](findings-t5-layering.md#q-24) / [Q-20](findings-t6-safety-net.md#q-20) / [Q-21](findings-t3-single-source.md#q-21) | Q-24 与 Q-20 只是没排期（**不需要任何拍板**，Q-24 第一刀还是代码注释里预先授权过的）；Q-21 要配 audit-code 与世界书对账（涉平衡数值）—— 但见下方「Q-21 里藏着两处 live bug」 |
| _本 PR_                                                                                                                   | Q-25 🔄                                                                                                                                                                      | 视图层拆分：`SettingsPage.vue` 3821 → 1991 行（8 个分区抽成子组件 + 共用外壳 `settings-chrome.css` 单份）；`StatusOverview.vue` 1411 → 1175 行（画像段 → `usePlayerPortrait` + `portrait-messages`）。CSS 按**归属表**分配而非手感：166 条里 63 条随分区走、40 条进共用外壳、8 条 `.sampler-*` 是死规则直接删                                            |
| _本 PR_                                                                                                                   | Q-18 ✅                                                                                                                                                                      | 设置真源类型化：12 张 per-Agent map → 一张 `agents` 表（构造期同步迁移，无标志位）；新建 `settings-types.ts` 声明 `UiSettings`（**type 不是 interface**，见文件头），getDefaults 里 17 处冗余 `as` 与消费端 8 处断言自行消失。类型当场查出三个**读了但从没人写**的键：embeddingEndpointId（记忆向量化因此从未运行）、embeddingModel、combatEngineVersion |
| _本 PR_                                                                                                                   | Q-25 ✅                                                                                                                                                                      | Agent 分区拆完：SettingsPage 1995 → 约 415 行纯壳层；新增 settings/agent/ 四组件 + 四模块。动手前先出**符号→模板段**确定性映射，再由四路独立评审对着真代码挑刺 —— 它们逮到我漏了整个 CSS 归属步骤、把 resetPrompt 误标成「被取代」（实为自诞生起零调用）、以及打算把占位符做成组件会把跨组件 DOM 伸手制度化                                              |

### 主人已拍板 / 已登记的待办（2026-08-03 追记）

**Q-28 —— 已拍板：保留并深化。** 主人裁定「crimson + indigo 的深度定制就是新方向，其余主题将来跟进」。
这把审查那条先决产品决策关掉了，但**反过来抬高了契约化的优先级**：如果十个主题最终都要伸进组件，
那 319 条选择器就不是需要清理的事故，而是需要**声明**的接口 —— 第 8、9 个主题作者没有任何办法
从文档回答「我能选哪些类名」。

实测出的形状比审查原文乐观得多（原文只给了合计 319 未做分布）：

|                          | 选择器条数 | 其中限定在 `.game-page-layout` 内 | 逸出到全局 |
| ------------------------ | ---------: | --------------------------------: | ---------: |
| `crimson.css`（1702 行） |        233 |                               199 |         34 |
| `indigo.css`（555 行）   |         86 |                                80 |          6 |

逸出的 40 条里绝大多数仍是游戏面板（`.items-panel` / `.char-panel` / `.options-popup` /
`.ctx-menu` / `.buff-pop`）—— 它们经 AppModal 渲染到 `.game-page-layout` 之外，属于同一域。
**真正跨域的只有一条**：`crimson.css:497` 的裸 `.modal-content`，它命中全应用每一个弹窗
（含设置页）。这意味着契约可以按域分层写，不必一次覆盖全部 319 条。

落地顺序不变（审查 §Q-28 的三步），但第 1 步的判据要改写：不再是「它今天还匹配活 DOM 吗」，
而是「它该成为 token、还是该成为公开钩子」—— 因为两类都要留下，且都要写进 `docs/design.md` §4
给后续 8 个主题当接口。

**Q-29 —— 登记为 TODO，主人稍后处理。** 待办本身不变（seam 位置 + 那条行为变更的口径：
端点列表一次 `run` 内算一次 = 回合中途改设置不再立即生效）。

**Q-23 —— 登记为 TODO。** 待办不变（先拍板域边界，再动第一刀 `EffectAutomaton`）。

**Q-25 —— 主人索取细节，已单独出料。** 补一条实测结论：**主题层几乎不碰 SettingsPage**
（上表 40 条逸出选择器里没有一条命中设置页私有类名，唯一交集是那条全局 `.modal-content`），
所以 Q-25 与 Q-28 可以并行推进，互不阻塞。

**Q-21 里藏着两处 live bug（本次复核发现，审查原文未点出严重度）。**
审查把 Q-21 定级「中 / 重复」，但其中两刀是当下就在错的：

1. **制作检定在生产环境恒为 d20 = 10。** `agent-tools.ts:673` 与 `:742` 都以
   `d20Rolls: []` 装配请求，注释写着 `// Will be rolled inside craftResolver` —— 那句是错的：
   `resolveCheck` 把空数组原样透传（`craft-resolver.ts:172`），`craft-dc.ts:87` 落到
   `d20Rolls[0] ?? 10`。真正掷骰的 `createCraftRequest`（`:692`）没有任何工具调用。
   连带后果：**大失败不可达**（判据要 `diceValue === 1 && d20Rolls.length === 1`，而 length 是 0）、
   **优势/劣势整条规则是死的**（`determineAdvantage` 每次都算，但 `rollCraftDice` 要 `length >= 2` 才生效）。
   这与 Q-01 同形状，但 Q-01 的修复只覆盖 combat-v3 的 coordinator，制作侧这条独立存活。
2. **格挡重算路径用了另一个伤害类型。** `attack.ts:227` 传 `ability.damageType`，
   `:540` 传 `attacker.ability?.damageType ?? '物理'`。格挡一个伤害类型异于攻击者基础档的技能，
   抗性/减伤处理会变。审查的复核轮已判断这"很可能是 live bug 而非坏味"。

## 结论摘要

这是一个**架构判断力明显高于其接线纪律**的仓库。

分层是真的（工坊纯函数链零 I/O、combat-v3 有源码级确定性守卫、ADR-21 的写入纪律经反证成立、`@ts-ignore` 全仓 0 次），文档也是真的（ADR 编号、设计规范、Phase 记录都能对上代码）。问题不在于设计得不好，而在于**「新内核先跑通、测试先绿」之后，「把内核接到生产路径上」那一步被 Phase 完成通知盖了过去**。

本轮最有价值的三条发现都是这个形状，而且都不会崩溃、只会静默降级：

- **生产战斗从未拿到真骰子**——`sysDrawSixty` 恒返回 60 颗 `10`，注入缝 `registerDiceSupplier` 只存在于类型声明和三条注释里，从未被调用（[Q-01](findings-t1-wiring-gap.md#q-01)）。整个 DiceTape 通道预算、优势/劣势双骰、7 个重放 fixture 服务的随机性，在出货的游戏里一次都没被触发。〔✅ 已修 `a0c3d5d`，见[进度追踪](#进度追踪)〕
- **状态到期的连带效果全部蒸发**——`applyTimeAdvance` 仔细构造的 patches 在唯一调用点被丢弃（[Q-02](findings-t1-wiring-gap.md#q-02)）。效果条本身会消失，但它承诺的回血/掉属性不会发生。〔✅ 已修 `a0c3d5d`〕
- **两层效果系统都是空的**——战斗外整条 emitChain 事件层从未被实例化，战斗内 18 个「封闭枚举」窗口有 13 个惰性（[Q-07](findings-t1-wiring-gap.md#q-07)）。〔✅ 已修：注册面 `eab3729`，emit 源 + 效果回收 + 战斗内 12/18 显式化见[进度追踪](#进度追踪)〕

三条都被绿测掩盖，因为测试注入自己的替身、或只覆盖被替换掉的那一层。**这类缺陷的成本不是修复工作量，而是发现延迟**：读代码的人看不出问题，只有真机对着数值表比对才会发现。

第二类问题是**真源分裂**：同一份事实被抄成 2–6 份，且多处已经漂移并造成后果——`ScenePanel` 的 6 元 `TIER_COLOR` 漏掉「唯一」，T7 角色一律描成 muted 灰；`start-catalog` 的 `RARITY_TO_QUALITY` 与 `field-enums` 的别名表已分叉（前者只有 `only`、后者两个键都收），捏人页那句 `|| '普通'` 兜底使这条分叉一旦被数据触发就是静默降级；EJS 能力面已发生 8 次渲染漂移，`engine.has` 已经在说谎。第三类是**僵尸模块**：三代架构退役时都只断引用、没删文件，还留着自己的测试为其背书，让人和 AI 工具都无法从名字区分尸体与现役实现。

**建议的第一刀**：删尸体 + 补工具链网（Q-04、Q-15，工作量 S，无需裁定），紧接着修两条静默出错的生产路径（Q-01、Q-02，工作量 S）。这四条不依赖任何架构决策，且删除面已由排除测试文件的全仓 grep 逐个反证。

> 〔进度〕这一刀已全部切下：Q-04 / Q-15 / Q-01 / Q-02 四条完成，「先删尸体再拆巨石」这条硬约束的前置已清。见[进度追踪](#进度追踪)。

## 严重度定义

| severity | 含义                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 高       | 生产行为已经错误/退化，或该问题正在持续复制出新的副本，越晚处理成本越高 |
| 中       | 显著抬高维护成本或改错代码的概率，但当前行为正确                        |
| 低       | 局部噪音，值得在顺路的 PR 里收掉，不值得单独排期                        |

## 系统性主题

31 条发现归入 6 个主题。主题描述的是**成因**，不是分类标签——同一成因下的条目通常应该一起修。

### [T1 接线缺口：内核跑通了，产品没接上](findings-t1-wiring-gap.md)

每一代架构升级（战斗 v3、事件效果层、记忆子系统、状态到期结算）都按「新内核先跑通、测试先绿」的方式合入，而「把内核接到生产路径上」那一步被 Phase 完成通知盖了过去。测试只覆盖被替换掉的那一层或内核自身，于是绿测恰好掩盖了未接线的事实。后果不是崩溃，而是产品在静默地跑一条退化路径：骰子恒定、到期效果不落地、AI 写的记忆走另一套编号。

成员：[Q-01](findings-t1-wiring-gap.md#q-01)、[Q-02](findings-t1-wiring-gap.md#q-02)、[Q-03](findings-t1-wiring-gap.md#q-03)、[Q-07](findings-t1-wiring-gap.md#q-07)

### [T2 AI 文本与引擎状态之间没有唯一的编解码缝](findings-t2-ai-boundary.md)

从模型文本抢救结构（XML 标签 / marker 扫描 / JSON 围栏 / 子元素）与把结构写回状态（翻译层、落库回执）这两个方向，都没有一个被测试钉住的共享模块，每条 Agent 链各自演化出一份容忍度。真机 debug loop 每修好一处，其余五处不受惠；失败回执又有三种形态，落库失败会伪装成解析失败，把调试引向改 prompt。

成员：[Q-05](findings-t2-ai-boundary.md#q-05)、[Q-13](findings-t2-ai-boundary.md#q-13)、[Q-14](findings-t2-ai-boundary.md#q-14)、[Q-17](findings-t2-ai-boundary.md#q-17)、[Q-19](findings-t2-ai-boundary.md#q-19)

### [T3 真源分裂：同一份事实被抄成 2–6 份，每份都是一条静默漂移线](findings-t3-single-source.md)

仓库反复出现同一模式：一条规则（品质映射、能力面符号表、六步迁移、设置、邻接语义、平衡阈值、Dexie schema）没有可复用出口时，第二个调用点就整段复制。复制发生的当天两份等价，编译器对二者是否仍等价零意见，于是漂移只能靠差分测试或真机撞见。多处漂移已经发生并造成静默降级或数据丢失。

成员：[Q-06](findings-t3-single-source.md#q-06)、[Q-08](findings-t3-single-source.md#q-08)、[Q-09](findings-t3-single-source.md#q-09)、[Q-11](findings-t3-single-source.md#q-11)、[Q-12](findings-t3-single-source.md#q-12)、[Q-16](findings-t3-single-source.md#q-16)、[Q-21](findings-t3-single-source.md#q-21)、[Q-26](findings-t3-single-source.md#q-26)、[Q-30](findings-t3-single-source.md#q-30)、[Q-31](findings-t3-single-source.md#q-31)

### [T4 僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路](findings-t4-corpses.md)

三代架构（v3 世界书栈、v2 战斗、Legacy EJS 后端、旧流式解析器、失效的提示词闭包）退役时都只断了引用、没删文件，还留着自己的测试为其背书。读代码的人和 AI 工具无法从名字与文档区分尸体与现役实现，改错地方的成本是整轮 prompt 调试或整次重构白做；这些尸体还把死类型钉在 `types.ts` 上，挡住后面的拆分。

成员：[Q-04](findings-t4-corpses.md#q-04)、[Q-10](findings-t4-corpses.md#q-10)、[Q-22](findings-t4-corpses.md#q-22)

### [T5 分层塌陷：seam 说过要落但没落，巨石继续长](findings-t5-layering.md)

项目在文档里定义了清晰的分层（planner/executor、types 唯一来源、组件与主题的私有边界、GamePipeline 只做编排），但缺口出现时没有可用的出口，于是逻辑就近长在最方便的宿主里——3823 行的设置页、1600 行的管线类、Pinia 闭包里的文案与闸门、主题 CSS 直接伸进组件私有类名。结果是「两个不相干的理由改同一个文件」，且这些逻辑只能通过驱动整个宿主才能测。

成员：[Q-23](findings-t5-layering.md#q-23)、[Q-24](findings-t5-layering.md#q-24)、[Q-25](findings-t5-layering.md#q-25)、[Q-27](findings-t5-layering.md#q-27)、[Q-28](findings-t5-layering.md#q-28)、[Q-29](findings-t5-layering.md#q-29)

### [T6 质量网的缺口：类型、测试与工具链没盖住最容易出错的地方](findings-t6-safety-net.md)

约定（每模块配测试、`types.ts` 唯一来源）在最难测、最热的地方恰好破例：有状态的 composable、`Record<string, any>` 的设置面、`tests/` 与 `server/` 拿不到 tsc/eslint/prettier。缺口一旦存在就自我复制——下一个模块也可以是例外，而这些正是回归时无声、只能靠真机复现的区域。

成员：[Q-15](findings-t6-safety-net.md#q-15)、[Q-18](findings-t6-safety-net.md#q-18)、[Q-20](findings-t6-safety-net.md#q-20)

## 优先级总表

排序依据是「节省的维护成本 × 置信度 ÷ 重构风险」，不是严重度标签本身：一条需要先做架构裁定的高危项，排在一条能解锁另外三项的机械清理之后。

> 「状态」列的口径与[进度追踪](#进度追踪)一致，核对基线 `eab3729`。

| ID                                        | 严重度 | 主题 | 问题                                                                                     | 处置     | 状态 |
| ----------------------------------------- | ------ | ---- | ---------------------------------------------------------------------------------------- | -------- | ---- |
| [Q-01](findings-t1-wiring-gap.md#q-01)    | 高     | T1   | 生产战斗从未拿到真骰子，live 战斗里每个 d20 都是常量 10                                  | 步骤 2   | ✅   |
| [Q-02](findings-t1-wiring-gap.md#q-02)    | 高     | T1   | `applyTimeAdvance` 算出的 patches 在唯一调用点被丢弃，`onRemove` 脚本在生产中等于没写    | 步骤 2   | ✅   |
| [Q-03](findings-t1-wiring-gap.md#q-03)    | 高     | T1   | 记忆子系统被 UI 层重新实现一遍，`memory-summarizer.ts` 生产零调用，两套 MEM 编号不兼容   | 步骤 3   | ✅   |
| [Q-04](findings-t4-corpses.md#q-04)       | 中     | T4   | 五处僵尸模块零生产引用却仍带测试与提示词正文                                             | 步骤 1   | ✅   |
| [Q-05](findings-t2-ai-boundary.md#q-05)   | 高     | T2   | AI 输出解析没有共享缝：15+ 份拷贝，同名 `extractTag` 语义相反，effect 正则已漂出数据丢失 | 步骤 4   | ✅   |
| [Q-06](findings-t3-single-source.md#q-06) | 中     | T3   | 设置有两个真源，只有两个字段被手写桥搬运，引擎侧读到的是永远停在默认值的影子配置         | 步骤 6   | ✅   |
| [Q-07](findings-t1-wiring-gap.md#q-07)    | 高     | T1   | 两层效果系统都是空的：13 个「封闭枚举」窗口惰性，emitChain 事件层从未被实例化            | 步骤 3   | ✅   |
| [Q-08](findings-t3-single-source.md#q-08) | 中     | T3   | 「六步迁移」复制了三遍且已漂移——唯一「搞砸即用户数据不可恢复」的路径是复制粘贴           | 步骤 5   | ✅   |
| [Q-09](findings-t3-single-source.md#q-09) | 高     | T3   | EJS 能力面契约被记在 6 处，已发生 8 次静默渲染漂移，`engine.has` 已经在说谎              | 步骤 7   | 🔄   |
| [Q-10](findings-t4-corpses.md#q-10)       | 中     | T4   | Legacy EJS 后端的两处遗产：缓存只服务停用路径（生产零缓存）、同步渲染路径恒被闸门关死    | 步骤 7   | 🔄   |
| [Q-11](findings-t3-single-source.md#q-11) | 中     | T3   | 7 级品质有 4 套类型与 5 份颜色表；`ScenePanel` 漏「唯一」项，T7 角色一律描成灰色         | 步骤 6   | ✅   |
| [Q-12](findings-t3-single-source.md#q-12) | 中     | T3   | 两个同名 `applyVarsPatch` 契约互斥，其中一份的宿主已是零引用僵尸                         | 步骤 5   | ✅   |
| [Q-13](findings-t2-ai-boundary.md#q-13)   | 中     | T2   | `assembleCharacterState` 里 14 处无谓的 `as any`，同一字面量一半字段带转型               | 步骤 4   | ✅   |
| [Q-14](findings-t2-ai-boundary.md#q-14)   | 中     | T2   | 失败回执三处口径各异，落库失败会伪装成解析失败                                           | 步骤 4   | ✅   |
| [Q-15](findings-t6-safety-net.md#q-15)    | 中     | T6   | 15 个源文件在 tsc/ESLint/Prettier 三张网之外，59 个 tracked 临时脚本与 ~120MB 大文件     | 步骤 1   | ✅   |
| [Q-16](findings-t3-single-source.md#q-16) | 中     | T3   | store 层没有共享工具层：detach helper 复制 8 份，两个同名 `toRow` 语义还不同             | 步骤 5   | ✅   |
| [Q-17](findings-t2-ai-boundary.md#q-17)   | 中     | T2   | `agent-client` 的流式与非流式路径各写一份请求体装配、fetch 与错误翻译                    | 步骤 4   | ✅   |
| [Q-18](findings-t6-safety-net.md#q-18)    | 中     | T6   | 最热的状态零编译期保护：settings 是 `Record<string, any>`，per-Agent 摊成 13 张并行 map  | 步骤 6   | ✅   |
| [Q-19](findings-t2-ai-boundary.md#q-19)   | 中     | T2   | AI→状态写入链是两个无缝巨型函数：560 行私有翻译方法 + 30 分支手写 switch                 | 步骤 8   | ✅   |
| [Q-20](findings-t6-safety-net.md#q-20)    | 中     | T6   | 测试底盘三处缺口：730 行有状态 composable 零测试、7 份逐字相同的桩、两份过期源码断言     | 后续批次 | ⬜   |
| [Q-21](findings-t3-single-source.md#q-21) | 中     | T3   | 战斗/制作结算层四处复制，含 17 参数调用两份、15 字段装配两份且各自掷骰                   | 后续批次 | ⬜   |
| [Q-22](findings-t4-corpses.md#q-22)       | 中     | T4   | combat-v3 公共面两个装饰性字段：`bundle` 从不被读、`completed` 是构造时快照              | 后续批次 | ✅   |
| [Q-23](findings-t5-layering.md#q-23)      | 中     | T5   | `types.ts` 3716 行兼任常量/函数库；`combat-v3/types.ts` 把依赖方向反转                   | 步骤 8   | ⬜   |
| [Q-24](findings-t5-layering.md#q-24)      | 中     | T5   | `asset-store` 的「纯执行器」定位没守住，约 200 行文案/闸门长在 Pinia 闭包里              | 后续批次 | ⬜   |
| [Q-25](findings-t5-layering.md#q-25)      | 高     | T5   | 视图层巨石：`SettingsPage.vue` 3823 行内联 9 个分区，`StatusOverview.vue` 夹 260 行管线  | 后续批次 | ✅   |
| [Q-26](findings-t3-single-source.md#q-26) | 中     | T3   | `database.ts` 里 16 个 Dexie 版本各自全量重述 schema，约 390 行是同一张表清单的拷贝      | 后续批次 | ✅   |
| [Q-27](findings-t5-layering.md#q-27)      | 低     | T5   | beautifier iframe 的 290 行运行时内嵌在模板字面量里，四职责混在一个函数                  | 步骤 7   | 🔄   |
| [Q-28](findings-t5-layering.md#q-28)      | 高     | T5   | `crimson.css` 与 `indigo.css` 里 319 条全局选择器直接伸进组件的 scoped 私有类名          | 后续批次 | ⬜   |
| [Q-29](findings-t5-layering.md#q-29)      | 高     | T5   | Agent 装配与整条 LLM 管线没有独立层，两处各写一份且已漂移，两个宿主都涨成 L 级巨石       | 后续批次 | ⬜   |
| [Q-30](findings-t3-single-source.md#q-30) | 中     | T3   | `start-catalog.ts`：8752 行 CDN 数据硬编成 TS 模块，并第二次定义了 Rarity 与品质映射     | 步骤 3   | ✅   |
| [Q-31](findings-t3-single-source.md#q-31) | 低     | T3   | `location-db` 邻接关系两套语义：`buildAdjacency` 双向对称，`areAdjacent` 只看单向        | 后续批次 | ✅   |
