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
| 🔄   | 部分完成，剩余项见下方明细               |
| ⬜   | 未开始（下表备注里附本次核对的抽查结果） |

**核对基线**：`master` @ `eab3729`（2026-08-03 核对）· `typecheck` 0 错误 · 203 个测试文件 · 5678 passed / 3 skipped

### 按路线图步骤

| 步骤                                      | 包含                   | 状态 | 备注                                                                                  |
| ----------------------------------------- | ---------------------- | ---- | ------------------------------------------------------------------------------------- |
| [步骤 1](roadmap.md) 清尸体 + 补工具链网  | Q-04、Q-15             | 🔄   | 僵尸删了三批；工具链只落了 `tsconfig.tools.json`，清仓（PR 2）零进度                  |
| [步骤 2](roadmap.md) 修静默出错的生产路径 | Q-01、Q-02             | ✅   | 两条全部兑现（`a0c3d5d`），骰子那条建议仍需真机打一场复核                             |
| [步骤 3](roadmap.md) 三处去留裁定         | Q-07、Q-03、Q-30       | 🔄   | 三条裁定均已拍板；Q-03 / Q-30 已落地，Q-07 只落了注册面                               |
| [步骤 4](roadmap.md) AI 输出编解码收口    | Q-05、Q-13、Q-14、Q-17 | ⬜   | —                                                                                     |
| [步骤 5](roadmap.md) 数据路径去重         | Q-08、Q-16、Q-12       | ⬜   | 抽查：三份 `*-migration.ts` 与 `variables.ts` / `vars-merger.ts` 两个僵尸宿主原样在库 |
| [步骤 6](roadmap.md) 品质体系与设置真源   | Q-11、Q-18、Q-06       | ⬜   | 抽查：`ScenePanel.vue:134` 的 `TIER_COLOR` 仍是 6 元、仍漏「唯一」，T7 仍描成灰       |
| [步骤 7](roadmap.md) EJS 能力面 + Legacy  | Q-09、Q-10、Q-27       | ⬜   | 抽查：`ejs-backend.ts` 仍在；退役仍卡在真机走查这一前置                               |
| [步骤 8](roadmap.md) 巨石拆分第一刀       | Q-23、Q-19             | ⬜   | 硬前置未清：步骤 1 的删尸体与步骤 3 的效果层都还没收尾                                |
| [后续批次](roadmap.md#后续批次不进前八步) | 其余 9 条              | ⬜   | —                                                                                     |

### 🔄 三条的剩余明细

**Q-04（僵尸）** — 已删：`editor-utils` / `combat-morale-pipeline` / `death-system` / `fp-system` / `combat-panel` / `cluster-system` / `lorebook-engine` / `prompt-assembler` / `importer` / `stream-parser` 及各自测试。剩余两项：

- `agent-templates.ts` 里 13 个 Agent 的 `variableContext` / `variableInstruction` 闭包仍在（`:442-648`），且仍是 `buildAgentPrompt`（`:944-950`）在 `ctx.zones` 缺失时的回退分支——删之前要先确认这条回退在生产里是否还会被走到。
- `MatchedEntry` / `lorebookMatches` 死类型仍钉在 `types.ts`（20 处引用横跨 16 文件），提交时标注为「留待 owner 决策批次」。

**Q-15（质量网）** — 已做：新增 `tsconfig.tools.json`（`extends` 主配置，纳入 `server/` `tests/` `*.config.ts`）。剩余按原建议的两个 PR 拆：

- PR 1 未完：`package.json` 里没有 `typecheck:tools` 脚本，`ci.yml` 仍是原来五步；`lint` / `format` / `format:check` 的 glob 仍只盖 `src/**`。已知阻塞：`tests/agent-framework` 两个 CLI 脚本引用了已删的引擎 API（`calcHP` / `equipment`），要先修才能让 `typecheck:tools` 全绿。
- PR 2 未开始：`tmp/` 59 个 tracked 文件、`_msg_story.json`、`bash.exe.stackdump`、`data/defaults/agent-config.json.bak`、`src/components/SillyTavern/index.html` 全部原样在库；`reference/` 两份 jsonl 合计约 100 MB 也还在。AGENTS.md 架构图里那行 `src/vanilla/sillytavern-store.ts`（目录已不存在）尚未删。

**Q-07（效果层）** — 裁定为「完整接线」。已做：新增 `effect-wiring.ts`，按存档实例化 EventBus，装备 / 卸下 / 存档加载三处接上 `executeInit` 与 `$event.on` 订阅注册，3 条回归测试。剩余两项：

- 只建了**注册面**，战斗外的业务事件 `emit` 源尚未接（提交自述「留待后续」）——即订阅能挂上，但目前没有生产事件去触发它们。
- 战斗内 13 个惰性窗口未处理：`initiative.before` / `initiative.after` / `turn.close` / `morale.before` / `morale.after` / `settlement.before` 在 `combat-v3/phases/` 里仍只出现在注释中，无求值器；编译白名单与 `char-gen-agent` 仍允许 AI 从 18 个里任选。

### 已落地的提交

| 提交      | 覆盖                   | 说明                                                                               |
| --------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `a0c3d5d` | Q-01、Q-02             | `drawDice` 改必填依赖、删 `sysDrawSixty`；`applyTimeAdvance` 的 patches 末尾自提交 |
| `cfc9cd2` | Q-04(部分)、Q-15(部分) | 三批僵尸删除 + 文档同步；新增 `tsconfig.tools.json`                                |
| `ecd68a1` | —                      | prettier 修复（CI `format:check` 红灯）                                            |
| `9fd5a3b` | Q-30                   | 数据拆 `start-catalog-data.ts`；`Rarity` → `CatalogRarityCode`；加防分叉闸门测试   |
| `0a6e7b6` | Q-03                   | 裁定：hiddenLine 保留 + 门槛统一 100 字 + embedding 接线；MEM 编号收敛到一套发号器 |
| `eab3729` | Q-07(部分)             | 裁定：完整接线；新增 `effect-wiring.ts`，装备/卸下/存档加载三处接上注册面          |

## 结论摘要

这是一个**架构判断力明显高于其接线纪律**的仓库。

分层是真的（工坊纯函数链零 I/O、combat-v3 有源码级确定性守卫、ADR-21 的写入纪律经反证成立、`@ts-ignore` 全仓 0 次），文档也是真的（ADR 编号、设计规范、Phase 记录都能对上代码）。问题不在于设计得不好，而在于**「新内核先跑通、测试先绿」之后，「把内核接到生产路径上」那一步被 Phase 完成通知盖了过去**。

本轮最有价值的三条发现都是这个形状，而且都不会崩溃、只会静默降级：

- **生产战斗从未拿到真骰子**——`sysDrawSixty` 恒返回 60 颗 `10`，注入缝 `registerDiceSupplier` 只存在于类型声明和三条注释里，从未被调用（[Q-01](findings-t1-wiring-gap.md#q-01)）。整个 DiceTape 通道预算、优势/劣势双骰、7 个重放 fixture 服务的随机性，在出货的游戏里一次都没被触发。〔✅ 已修 `a0c3d5d`，见[进度追踪](#进度追踪)〕
- **状态到期的连带效果全部蒸发**——`applyTimeAdvance` 仔细构造的 patches 在唯一调用点被丢弃（[Q-02](findings-t1-wiring-gap.md#q-02)）。效果条本身会消失，但它承诺的回血/掉属性不会发生。〔✅ 已修 `a0c3d5d`〕
- **两层效果系统都是空的**——战斗外整条 emitChain 事件层从未被实例化，战斗内 18 个「封闭枚举」窗口有 13 个惰性（[Q-07](findings-t1-wiring-gap.md#q-07)）。〔🔄 战斗外注册面已接（`eab3729`），业务事件源与战斗内 13 窗口仍在〕

三条都被绿测掩盖，因为测试注入自己的替身、或只覆盖被替换掉的那一层。**这类缺陷的成本不是修复工作量，而是发现延迟**：读代码的人看不出问题，只有真机对着数值表比对才会发现。

第二类问题是**真源分裂**：同一份事实被抄成 2–6 份，且多处已经漂移并造成后果——`ScenePanel` 的 6 元 `TIER_COLOR` 漏掉「唯一」，T7 角色一律描成 muted 灰；`start-catalog` 的 `RARITY_TO_QUALITY` 与 `field-enums` 的别名表已分叉（前者只有 `only`、后者两个键都收），捏人页那句 `|| '普通'` 兜底使这条分叉一旦被数据触发就是静默降级；EJS 能力面已发生 8 次渲染漂移，`engine.has` 已经在说谎。第三类是**僵尸模块**：三代架构退役时都只断引用、没删文件，还留着自己的测试为其背书，让人和 AI 工具都无法从名字区分尸体与现役实现。

**建议的第一刀**：删尸体 + 补工具链网（Q-04、Q-15，工作量 S，无需裁定），紧接着修两条静默出错的生产路径（Q-01、Q-02，工作量 S）。这四条不依赖任何架构决策，且删除面已由排除测试文件的全仓 grep 逐个反证。

> 〔进度〕这一刀已切下一半：Q-01 / Q-02 全部兑现，Q-04 删了三批，Q-15 只落了 `tsconfig.tools.json`——**清仓那半（PR 2）尚未开始，而它正是「先删尸体再拆巨石」这条硬约束的实际卡点**。明细见[进度追踪](#进度追踪)。

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
| [Q-04](findings-t4-corpses.md#q-04)       | 中     | T4   | 五处僵尸模块零生产引用却仍带测试与提示词正文                                             | 步骤 1   | 🔄   |
| [Q-05](findings-t2-ai-boundary.md#q-05)   | 高     | T2   | AI 输出解析没有共享缝：15+ 份拷贝，同名 `extractTag` 语义相反，effect 正则已漂出数据丢失 | 步骤 4   | ⬜   |
| [Q-06](findings-t3-single-source.md#q-06) | 中     | T3   | 设置有两个真源，只有两个字段被手写桥搬运，引擎侧读到的是永远停在默认值的影子配置         | 步骤 6   | ⬜   |
| [Q-07](findings-t1-wiring-gap.md#q-07)    | 高     | T1   | 两层效果系统都是空的：13 个「封闭枚举」窗口惰性，emitChain 事件层从未被实例化            | 步骤 3   | 🔄   |
| [Q-08](findings-t3-single-source.md#q-08) | 中     | T3   | 「六步迁移」复制了三遍且已漂移——唯一「搞砸即用户数据不可恢复」的路径是复制粘贴           | 步骤 5   | ⬜   |
| [Q-09](findings-t3-single-source.md#q-09) | 高     | T3   | EJS 能力面契约被记在 6 处，已发生 8 次静默渲染漂移，`engine.has` 已经在说谎              | 步骤 7   | ⬜   |
| [Q-10](findings-t4-corpses.md#q-10)       | 中     | T4   | Legacy EJS 后端的两处遗产：缓存只服务停用路径（生产零缓存）、同步渲染路径恒被闸门关死    | 步骤 7   | ⬜   |
| [Q-11](findings-t3-single-source.md#q-11) | 中     | T3   | 7 级品质有 4 套类型与 5 份颜色表；`ScenePanel` 漏「唯一」项，T7 角色一律描成灰色         | 步骤 6   | ⬜   |
| [Q-12](findings-t3-single-source.md#q-12) | 中     | T3   | 两个同名 `applyVarsPatch` 契约互斥，其中一份的宿主已是零引用僵尸                         | 步骤 5   | ⬜   |
| [Q-13](findings-t2-ai-boundary.md#q-13)   | 中     | T2   | `assembleCharacterState` 里 14 处无谓的 `as any`，同一字面量一半字段带转型               | 步骤 4   | ⬜   |
| [Q-14](findings-t2-ai-boundary.md#q-14)   | 中     | T2   | 失败回执三处口径各异，落库失败会伪装成解析失败                                           | 步骤 4   | ⬜   |
| [Q-15](findings-t6-safety-net.md#q-15)    | 中     | T6   | 15 个源文件在 tsc/ESLint/Prettier 三张网之外，59 个 tracked 临时脚本与 ~120MB 大文件     | 步骤 1   | 🔄   |
| [Q-16](findings-t3-single-source.md#q-16) | 中     | T3   | store 层没有共享工具层：detach helper 复制 8 份，两个同名 `toRow` 语义还不同             | 步骤 5   | ⬜   |
| [Q-17](findings-t2-ai-boundary.md#q-17)   | 中     | T2   | `agent-client` 的流式与非流式路径各写一份请求体装配、fetch 与错误翻译                    | 步骤 4   | ⬜   |
| [Q-18](findings-t6-safety-net.md#q-18)    | 中     | T6   | 最热的状态零编译期保护：settings 是 `Record<string, any>`，per-Agent 摊成 13 张并行 map  | 步骤 6   | ⬜   |
| [Q-19](findings-t2-ai-boundary.md#q-19)   | 中     | T2   | AI→状态写入链是两个无缝巨型函数：560 行私有翻译方法 + 30 分支手写 switch                 | 步骤 8   | ⬜   |
| [Q-20](findings-t6-safety-net.md#q-20)    | 中     | T6   | 测试底盘三处缺口：730 行有状态 composable 零测试、7 份逐字相同的桩、两份过期源码断言     | 后续批次 | ⬜   |
| [Q-21](findings-t3-single-source.md#q-21) | 中     | T3   | 战斗/制作结算层四处复制，含 17 参数调用两份、15 字段装配两份且各自掷骰                   | 后续批次 | ⬜   |
| [Q-22](findings-t4-corpses.md#q-22)       | 中     | T4   | combat-v3 公共面两个装饰性字段：`bundle` 从不被读、`completed` 是构造时快照              | 后续批次 | ⬜   |
| [Q-23](findings-t5-layering.md#q-23)      | 中     | T5   | `types.ts` 3716 行兼任常量/函数库；`combat-v3/types.ts` 把依赖方向反转                   | 步骤 8   | ⬜   |
| [Q-24](findings-t5-layering.md#q-24)      | 中     | T5   | `asset-store` 的「纯执行器」定位没守住，约 200 行文案/闸门长在 Pinia 闭包里              | 后续批次 | ⬜   |
| [Q-25](findings-t5-layering.md#q-25)      | 高     | T5   | 视图层巨石：`SettingsPage.vue` 3823 行内联 9 个分区，`StatusOverview.vue` 夹 260 行管线  | 后续批次 | ⬜   |
| [Q-26](findings-t3-single-source.md#q-26) | 中     | T3   | `database.ts` 里 16 个 Dexie 版本各自全量重述 schema，约 390 行是同一张表清单的拷贝      | 后续批次 | ⬜   |
| [Q-27](findings-t5-layering.md#q-27)      | 低     | T5   | beautifier iframe 的 290 行运行时内嵌在模板字面量里，四职责混在一个函数                  | 步骤 7   | ⬜   |
| [Q-28](findings-t5-layering.md#q-28)      | 高     | T5   | `crimson.css` 与 `indigo.css` 里 319 条全局选择器直接伸进组件的 scoped 私有类名          | 后续批次 | ⬜   |
| [Q-29](findings-t5-layering.md#q-29)      | 高     | T5   | Agent 装配与整条 LLM 管线没有独立层，两处各写一份且已漂移，两个宿主都涨成 L 级巨石       | 后续批次 | ⬜   |
| [Q-30](findings-t3-single-source.md#q-30) | 中     | T3   | `start-catalog.ts`：8752 行 CDN 数据硬编成 TS 模块，并第二次定义了 Rarity 与品质映射     | 步骤 3   | ✅   |
| [Q-31](findings-t3-single-source.md#q-31) | 低     | T3   | `location-db` 邻接关系两套语义：`buildAdjacency` 双向对称，`areAdjacent` 只看单向        | 后续批次 | ⬜   |
