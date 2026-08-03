# T1 接线缺口：内核跑通了，产品没接上

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

每一代架构升级（战斗 v3、事件效果层、记忆子系统、状态到期结算）都按「新内核先跑通、测试先绿」的方式合入，而「把内核接到生产路径上」那一步被 Phase 完成通知盖了过去。测试只覆盖被替换掉的那一层或内核自身，于是绿测恰好掩盖了未接线的事实。后果不是崩溃，而是产品在静默地跑一条退化路径：骰子恒定、到期效果不落地、AI 写的记忆走另一套编号。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                    |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| [Q-01](#q-01) | 高     | 生产战斗从未拿到真骰子：live 战斗里每个 d20 都是常量 10                                                 |
| [Q-02](#q-02) | 高     | applyTimeAdvance 算出的 patches 在唯一调用点被丢弃，状态到期的 onRemove 脚本在生产中等于没写            |
| [Q-03](#q-03) | 高     | 记忆子系统被 UI 层重新实现一遍：memory-summarizer.ts 生产零调用，两套 MEM 编号互不兼容且阈值已漂        |
| [Q-07](#q-07) | 高     | 两层效果系统都是空的：战斗内 18 个「封闭枚举」窗口有 13 个惰性，战斗外整条 emitChain 事件层从未被实例化 |

<a id="q-01"></a>

### Q-01 生产战斗从未拿到真骰子：live 战斗里每个 d20 都是常量 10

- **严重度**：高
- **主题**：接线缺口：内核跑通了，产品没接上
- **位置**：`src/sillytavern/combat-v3/coordinator.ts:89`、`src/sillytavern/combat-v3/coordinator.ts:125`、`src/sillytavern/combat-v3/coordinator.ts:723`、`src/ui/lib/game-pipeline.ts:1360`
- **工作量**：S　**风险**：中
- **来源**：CMBT-01

**证据**

`coordinator.ts:125` 无条件走确定性兜底：

```ts
const getDice = (): { outputId: string; dice: number[] } => sysDrawSixty(_idSeq++);
```

而 `sysDrawSixty`（:724-726）返回的是 `Array.from({ length: 60 }, () => 10)`。本该供给真实随机的注入缝在 :89 声明为 `registerDiceSupplier?: (fn: () => { outputId: string; dice: number[] }) => void;`，但 grep 全仓只在该类型声明与三处文档注释（:19、:116、:723）出现——`runCombatV3` 内部从不读它，唯一的生产调用点 `game-pipeline.ts:1360` 也从不传它。:723 的注释「无真实随机源时用确定性中位数 10；真实源自 registerDiceSupplier」说明这本是临时兜底，如今是唯一路径。

后果：`performAttackCheck` 恒见 10，`rollIntention` 恒见 10，先攻是常量，暴击/大失败/优劣势分支在运行时不可达。测试全绿是因为测试自带骰源（`coordinator.test.ts:214` 传 `() => ({ outputId: 'x', dice: [10] })`），所以这个状态可以无限期存活。

同类缺陷在制作侧同样存在：两个 craft 工具都写死 `d20Rolls: []`，`craft-dc.ts` 的 `rollCraftDice` 兜底成 `d20Rolls[0] ?? 10`，于是每一次制作检定也是 10，大失败/精益求精同样不可达（详见 Q-21）。

**影响**

整个 v3 内核——DiceTape 通道预算、优劣势双骰、epoch 续带、7 个 replay fixture——存在的理由就是让随机可审计，而产品里一次都没被驱动。战斗结果完全由属性面板预先决定，玩家永远看不到暴击与失手。只修战斗不修制作，产品仍有一半是确定性的。

**重构建议**

把骰源从可选回调改成必填依赖：

1. `RunCombatV3Opts.deps` 增加 `drawDice: () => { outputId: string; dice: number[] }`（必填），删掉没人用的 `registerDiceSupplier` 回调注册形态；`runCombatV3` 内用 `deps.drawDice` 取代局部 `getDice`；从 coordinator.ts 删除 `sysDrawSixty`。注意 `drawDice` 必须可反复调用——BeginOutput 战中续杯要再取。
2. 在 `src/ui/lib/game-pipeline.ts:1360` 的 `await import('@engine/combat-v3')` 旁实现唯一一份真实 supplier，委托给 `src/sillytavern/dice.ts` 的 `rollDice`/`d20`（既有唯一随机源，符合 combat-v3 铁律 1「内核内禁 Math.random」）。
3. 补一条 coordinator 测试：supplier 返回一个已知的非均匀 60 向量，断言它确实抵达 `performAttackCheck`（对 `AttackDeclared` 事件的 `dice` 字段断言）。
4. 同一 PR 或紧随其后处理制作侧：让 `craft_check` 返回它用过的骰带、`craft_settle` 复用同一条带（见 Q-21）。该改动会变更 AI 可见的工具返回 schema，按 AGENTS.md 必须同步 `agent-config.json` 与 `reference/agent流程测试/agent预期分析.md`。

落地前建议先真机打一场确认手感变化可接受——这是本条唯一的中等风险来源。

<a id="q-02"></a>

### Q-02 applyTimeAdvance 算出的 patches 在唯一调用点被丢弃，状态到期的 onRemove 脚本在生产中等于没写

- **严重度**：高
- **主题**：接线缺口：内核跑通了，产品没接上
- **位置**：`src/sillytavern/state-manager.ts:1464`、`src/sillytavern/state-manager.ts:1513`、`src/sillytavern/state-manager.ts:1524`、`src/sillytavern/state-manager.ts:1537`、`src/sillytavern/agent-orchestrator.ts:854`
- **工作量**：M　**风险**：中
- **来源**：CORE-02

**证据**

`async applyTimeAdvance(minutes: number): Promise<StatePatch[]>`（state-manager.ts:1464）在函数体里逐条构造 patch：到期效果的 `patches.push(...convertScriptEffects(result))`（:1513）与 `patches.push({ op: 'remove_status_effect', ... })`（:1518）。而它在全仓的唯一调用点是 agent-orchestrator.ts:854：

```ts
await sm.applyTimeAdvance(parsed.delta_time);
```

返回值直接丢弃，从不喂给 `commitChatState`。

同一函数里另有两处 `this.createEvent(...)`（:1524、:1537）同样丢返回值——`createEvent` 只 `return { ... }`，不 push 进 `this.events`，所以 :1537 注释写的「3. emit time_advanced」实际什么都没 emit。

更深一层：即便有人把返回值接上也仍不正确。`convertScriptEffects`（:1571）产出的 `{ op: 'delta_variable', target: \`characters.${h.charId}.hp\` }`会落到`applyDeltaVariable`（:489），那个 handler 只剥 `variables.`前缀，然后把值`setVar`进`SaveProfile.variables`这棵树——不是角色的 hp；并且用的是`charId`，与 `resolveCharacter`（:448）「只按 name 解析」的铁律相反。

需要说明失效范围是精确的部分失效：statusEffects 的时长扣减确实落库（:1532 `saveCharacter`），gameTime 也落库（:1475 `updateProfile`），所以「时长在走、效果会消失」，但 remove/hp/stat 这些由脚本产生的连带结果全部蒸发。

**影响**

装备与状态的 `onRemove` 脚本在生产中等于没写。症状是「效果到期了，但它承诺的回血/掉属性没发生」，而代码读起来一切正常——patches 明明构造得很仔细。这类缺陷不会被任何单测抓到（返回值本身是对的），只会以真机现象报上来，排查成本极高。

**重构建议**

按下列顺序改，改动局限在 `applyTimeAdvance` 一个出口：

1. 收尾改成自提交：在 `applyTimeAdvance` 末尾 `if (patches.length) await this.commitChatState(patches)`。不要改成让 agent-orchestrator.ts:854 在外面提交——ADR-21 指定 `commitChatState` 为唯一写入口，自提交变体更贴合该约定，且 orchestrator 在 :849 已经把其它 patch 汇进同一条路。
2. 顺手把 :1532 处的裸 `saveCharacter` 也折进同一次 commit——它本身就是一处 ADR-21 绕过，不要在直写之上再叠一层 commit。
3. :1524 / :1537 两处改成 `this.events.push(this.createEvent(...))`；若确实不需要事件，就把这两行连注释一起删掉，别留假 emit。
4. 修 `convertScriptEffects` 的 op 映射：`hpChanges` → `op: 'delta_hp'`，`statChanges` → `update_character` + `metadata.delta`；`charId` 先经一个新增的 `resolveNameById(saveId, charId)` 换成名字，与「AI 永不产 id、名字解析唯一入口」对齐。
5. 补一条回归测试：一个带 `onRemove` 的效果到期后，owner 的 hp 真的变了。

<a id="q-03"></a>

### Q-03 记忆子系统被 UI 层重新实现一遍：memory-summarizer.ts 生产零调用，两套 MEM 编号互不兼容且阈值已漂

- **严重度**：高
- **主题**：接线缺口：内核跑通了，产品没接上
- **位置**：`src/ui/lib/game-pipeline.ts:1270`、`src/ui/lib/game-pipeline.ts:1278`、`src/ui/lib/game-pipeline.ts:1288`、`src/ui/lib/game-pipeline.ts:1250`、`src/ui/lib/game-pipeline.ts:1177`、`src/sillytavern/memory-store.ts:114`、`src/sillytavern/memory-store.ts:128`
- **工作量**：M　**风险**：中
- **来源**：CORE-01

**证据**

引擎侧 `memory-summarizer.summarizeAndSave()` 的编排是「解析 → 校验 ≥200 字 → 生成 MEM 编号 → 算 embedding → 落库」：`generateMemoryId` 用 6 位流水号 `MEM${String(nextNum).padStart(6, '0')}`，识别正则是 `/^MEM(\d{6})$/`；`validateMemoryContent` 默认 `minChars: number = 200`；`parseMemorySummaryOutput` 要求 `content` / `hiddenLine` / `keywords` 三项齐全，缺一返回 `null`。

生产链完全不走它。`game-pipeline.ts:1270` 的 private `persistMemorySummary` 自己又写了一遍同一套规则，且每一条都不一样：

```ts
const id = `MEM${now.toString(36).toUpperCase()}`; // base36 时间戳，永远匹配不上 /^MEM(\d{6})$/
if (!parsed.content || parsed.content.length < 50) return; // 50，不是 200
hiddenLine: parsed.hiddenLine || ''; // 缺失照样落库，引擎侧会直接判 null
```

它还多了一条引擎侧没有的 `<json>...</json>` 剥壳——而同一个类在 `game-pipeline.ts:1177` 已经有 `extractJsonBlock` 干同样的事。第三种 id 形状来自 `game-pipeline.ts:1250` 的 `eventToMemory` 落库路径。

全仓 grep（排除 `*.test.ts`）：`summarizeAndSave` / `createCompressionSummaryMemory` / `saveMemoryWithEmbedding` / `getRoundCount` / `checkCompressionNeeded` / `applyCompression` 的生产调用点均为 0，只有 `memory-store.test.ts` 在调。

> 复核修正：原始发现称 `computeEmbedding` 也是生产死代码，这一条不成立——`memory-store.ts:114` 在 `recallMemories` 内部调用它，而 `recallMemories` 是活的生产路径（`agent-orchestrator.ts:619`）。成立的是更窄的一条：生产中没有任何写入口会给 `MemoryRecord.embedding` 赋值（只有已死的 `summarizeAndSave` 与 `saveMemoryWithEmbedding` 会），所以 `memory-store.ts:128` 的余弦分支恒不命中，召回永远退化成 importance 排序——orchestrator 自己都标了「无向量，按重要度排序」。

**影响**

同一份「记忆落库」规则有两份实现且已经漂移：200 字 vs 50 字、hiddenLine 必填 vs 可空、两套互不兼容的 id 编码。改记忆格式的人会照 AGENTS.md 去改 `memory-summarizer.ts`，跑完 229 行绿测以为改完了，实际生产行为一字未变——文档与测试在联合误导。反过来，哪天真把引擎侧接回来，`generateMemoryId` 会从 `MEM000001` 重新发号，与已有的 base36 时间戳记忆混在同一张表里且互相看不见（正则筛不到对方，编号会撞）。设置页的 `embeddingEndpointId`/`embeddingModel`/`embeddingDimension` 三项虽然驱动了真实的 query embedding 请求，但因为库里没有向量，对召回结果毫无影响。

**重构建议**

把 `persistMemorySummary` 的方言收回引擎，顺序如下：

1. `memory-summarizer.ts` 增补 `stripJsonEnvelope(raw)`（把 UI 独有的 `<json>` 剥壳搬进来），`parseMemorySummaryOutput` 先过它；UI 侧删掉自带剥壳，`extractJsonBlock` 保留给别处用。
2. 把 200/50 的分歧裁定成一个导出常量 `MEMORY_MIN_CHARS`，UI 不再自带阈值。
3. `game-pipeline.persistMemorySummary` 改成薄壳：`await summarizeAndSave({ saveId, agentRawOutput: raw, gameTimeRange, embeddingEndpoint })`，再把返回的 `MemoryRecord` push 进 `this.game.recentMemories`；id 生成与校验全部下沉。
4. `eventToMemory` 那条落库（`game-pipeline.ts:1250`）改走同一个 id 发号器，两条写入口共用一套编号。**这一步必须与 3 同批**，否则表里仍有两种编码。
5. embedding 与压缩两条链二选一：要么在 `GamePipeline` 里接线（接了 `recallMemories` 的余弦分支才有意义），要么连同 `getRoundCount`/`checkCompressionNeeded`/`applyCompression`/`saveMemoryWithEmbedding` 与对应测试一起删掉。不要留「有测试的死路」。

注：记忆不受 ADR-21 / M5 约束（那两条管的是 chat state 与 profile 变量），把 id 发号搬进引擎不触碰任何既有不变式。

<a id="q-07"></a>

### Q-07 两层效果系统都是空的：战斗内 18 个「封闭枚举」窗口有 13 个惰性，战斗外整条 emitChain 事件层从未被实例化

- **严重度**：高
- **主题**：接线缺口：内核跑通了，产品没接上
- **位置**：`src/sillytavern/game-event.ts:444`、`src/sillytavern/script-registry.ts:80`、`src/sillytavern/script-executor.ts:468`、`src/sillytavern/subscription-manager.ts:42`、`src/sillytavern/effect-runtime.ts:40`、`src/sillytavern/modifier-collector.ts:93`、`src/sillytavern/state-manager.ts:1508`、`src/sillytavern/combat-item-validator.ts:370`、`src/sillytavern/combat-v3/windows.ts:212`、`src/sillytavern/combat-v3/phases/attack.ts:92`、`src/sillytavern/combat-v3/phases/attack.ts:126`、`src/sillytavern/combat-v3/phases/attack.ts:138`、`src/sillytavern/combat-v3/phases/attack.ts:188`、`src/sillytavern/combat-v3/phases/attack.ts:200`、`src/sillytavern/combat-v3/phases/round.ts:63`、`src/sillytavern/combat-v3/phases/round.ts:91`
- **工作量**：L　**风险**：中
- **来源**：CMBT-03, CMBT-02

**证据**

两层是同一个病灶的两个断面。

**战斗外（emitChain 事件层，完全没有入口）。** AGENTS.md:261 写着「基础设施全部齐全，唯一缺口是『装备/卸下/存档加载时调 executeInit → ScriptRegistry.registerAll』接线」（P1-11）。实际比「缺一个调用」严重：`grep -rn 'new EventBus|getEventBus' src/ --include=*.ts --include=*.vue | grep -v test` 只有一个命中，就是 `game-event.ts:444-446` 的定义本身。生产中从来没有 EventBus 被创建，于是它的每一个下游消费方都不可达：

- `ScriptRegistry.registerAll`（`script-registry.ts:80`）非测试调用方 0
- `executeInit`（`script-executor.ts:468`）与 `executeCleanup`（:499）非测试调用方 0
- `class SubscriptionManager`（`subscription-manager.ts:42`）除自身测试外无人 import
- `class EffectRuntime` / `createEffectRuntime`（`effect-runtime.ts:40`, :366）importer 0
- `collectAttackerMods` / `collectDefenderMods`（`modifier-collector.ts:93`, :118）调用方 0

唯一一条活线是 `state-manager.ts:1508` 为 `onRemove` 钩子动态 import 的单个函数 `executeScript`。守着这堆死代码的测试重量：`game-event.test.ts` 1150 行、`effect-runtime.test.ts` 909、`script-executor.test.ts` 777、`modifier-collector.test.ts` 429、`script-registry.test.ts` 230、`subscription-manager.test.ts` 196，合计 3691 行。

**战斗内（v3 的 18 窗口，13 个惰性）。** `V3_WINDOW_KEYS`（`combat-item-validator.ts:370-389`）是编译期白名单，`compile.ts` 拒绝任何 `subscribe` 不在其中的 automaton。但把每个 key 在 `combat-v3/phases/` + `reducer.ts` 里 grep：`initiative.before`、`initiative.after`、`turn.close`、`morale.before`、`morale.after`、`settlement.before` 出现次数为 0——没有任何求值器会跑它们。有调用点的 12 个里又有 7 个把结果丢弃：

```ts
evaluateWindow(state.activeEffects, 'check.intent', makeWindowRuntimeCtx(...)); // 无赋值
// ④ collect_defender_mods 窗口（M1 空转）
// round.open 窗口（M3 接索引，M1 空转）
```

`evaluateWindow` 返回 `{ intents, rejections }`（`windows.ts:100-152`），这 7 处把 effect intents **和** `EffectRejected` 诊断一起静默丢掉。真正端到端接通的只有 5 个：`action.declared`、`turn.open`、`damage.preview`、`damage.after`、`unit.beforeDown`。另外 `makeWindowRuntimeCtx`（`windows.ts:212-213`）把 `depth: 0` 与 `charges: { remaining: 0 }` 写死，任何读 `ctx.charges.remaining` / `ctx.depth` 的触发表达式恒见 0。

> 复核修正：战斗内这 13 个惰性窗口在源码注释里被明确标为「M1 空转 / M3 接索引」，属于声明过的分阶段工作，不是静默回归，故该子项独立评级为「中」。真正的缺陷更窄：编译白名单接受没有求值器的 window key，而 `char-gen-agent.ts:802-842` 允许 AI 从 18 个里任选。

**影响**

ADR-29 在 AGENTS.md 里明文告诉每一个后来者，emitChain 是「制作系统与战斗外的效果基座」，加效果就是注册 handler——照做写出的代码永远不会跑。同时 3700 行测试在 CI 里持续烧时间，断言一个没有入口的子系统的内部自洽性，无论上层怎么坏它们都会一直绿，让「效果系统有覆盖」这个印象变成主动误导。

战斗内同理：一个订阅 `morale.before` 或 `collect_attacker_mods` 的物品/技能能过全部 9 项编译校验、进 `ActiveEffectIndex`、在 `describe-automaton.ts` 的 tooltip 里显示出来，然后什么都不做——没有日志、没有 `EffectRejected`、没有测试。排查「我的反伤为什么不触发」一次要烧掉维护者一天，而 DSL 的核心卖点（作者对着一张有文档的窗口清单写效果）有 13/18 是虚的。

**重构建议**

先拍板再动手，两个断面分别处理。

**战斗外——必须由 owner 做一次架构裁定，二选一并写进 AGENTS.md：**

- 方案 A（接线）：在 `state-manager.ts` 现有 `executeScript` import 旁加 `wireScripts(saveId, characters)`，每存档调一次 `getEventBus(saveId)`，对每件已装备物品/技能调 `executeInit`，再 `ScriptRegistry.registerAll(decls, ownerKey)`；从装备/卸下路径与存档加载路径调用它；补一条集成测试，证明已装备物品的 `$event.on` handler 能观察到真实 emit。注意 ADR-21 指定 `state-manager` 为唯一状态写入口，在这里挂 EventBus 生命周期位置正确，但**不得开出第二条写路径**。
- 方案 B（删除）：注意范围比原始发现说的窄——`script-executor.ts` 不可删（`state-manager` 依赖 `executeScript`，`executeInit`/`executeCleanup` 与它同文件，所谓「rehome」实际只是删掉两个导出）。`game-event.ts` 还导出 ADR-29 点名要给制作系统当基座的 DomainEvent 周边管线，删它等于否掉已文档化的制作效果计划——这本身是 ADR 级决定，不是清理。

无论选哪个，AGENTS.md:253-261 的「齐全」说法今天就是事实错误，必须先改掉。

**战斗内——两步，不依赖上面的裁定：**

1. 把缺口显式化：`V3_WINDOW_KEYS` 拆成 `V3_WINDOW_KEYS_LIVE`（5 个）与 `V3_WINDOW_KEYS_RESERVED`，`compile.ts` 对 reserved key 抛新错误码 `WINDOW_NOT_WIRED`，让 automaton 大声掉落而不是静默入索引，`describe-automaton.ts` 渲染该状态。**这会改变已存档 automaton 的加载行为（老存档里的会开始被丢弃），必须配迁移说明**；同时 `docs/reference/combat-system-architecture-v3.md` §五 5.1 的「18 窗口封闭枚举」表述要一并改，否则两处打架。
2. 消掉 7 处丢弃：在 `windows.ts` 引入 `runWindow(out: PhaseOutcome, index, key, rt): readonly RawIntent[]`，它总是把 `evaluation.rejections` 追加进 `out.events` 再返回 intents，然后把全部 12 个调用点换成它。暂时消费不了 intents 的窗口就退化成一行 `runWindow(...)`，忽略返回值是**可见的** TODO 而非隐藏的。顺带把 `makeWindowRuntimeCtx` 的 `depth` 与 per-automaton `charges` 改成入参，不再写死 0。
