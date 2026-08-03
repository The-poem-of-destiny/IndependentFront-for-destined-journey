# T4 僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

三代架构（v3 世界书栈、v2 战斗、Legacy EJS 后端、旧流式解析器、失效的提示词闭包）退役时都只断了引用、没删文件，还留着自己的测试为其背书。读代码的人和 AI 工具无法从名字与文档区分尸体与现役实现，改错地方的成本是整轮 prompt 调试或整次重构白做；这些尸体还把死类型钉在 `types.ts` 上，挡住后面的拆分。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                               |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------ |
| [Q-04](#q-04) | 中     | 五处僵尸模块（v3 世界书栈 / v2 战斗遗留 / stream-parser / variableContext 提示词）零生产引用却仍带测试与提示词正文 |
| [Q-10](#q-10) | 中     | Legacy EJS 后端的两处遗产：编译缓存只服务已停用路径，同步渲染路径在生产恒被闸门关死却仍作为第二套完整实现维护      |
| [Q-22](#q-22) | 中     | combat-v3 公共面上的两个装饰性字段：bundle 贯穿整条攻击路径却从不被读，CombatSession.completed 是构造时快照        |

<a id="q-04"></a>

### Q-04 五处僵尸模块（v3 世界书栈 / v2 战斗遗留 / stream-parser / variableContext 提示词）零生产引用却仍带测试与提示词正文

- **严重度**：中
- **主题**：僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路
- **位置**：`src/sillytavern/index.ts:7`、`src/sillytavern/lorebook-engine.ts:4`、`src/sillytavern/prompt-assembler.ts:210`、`src/sillytavern/editor-utils.ts:1`、`src/sillytavern/importer.ts:1`、`src/sillytavern/stream-parser.ts:24`、`src/sillytavern/agent-client.ts:781`、`src/sillytavern/agent-client.ts:788`、`src/sillytavern/combat-panel.ts:1`、`src/sillytavern/cluster-system.ts:1`、`src/sillytavern/combat-morale-pipeline.ts:1`、`src/sillytavern/death-system.ts:1`、`src/sillytavern/fp-system.ts:1`、`src/sillytavern/agent-templates.ts:733`、`src/sillytavern/agent-templates.ts:893`、`src/sillytavern/placeholder-registry.ts:502`、`src/sillytavern/types.ts:407`、`docs/ARCHITECTURE.md:357`
- **工作量**：M　**风险**：低
- **来源**：WB-04, XCUT-03, CMBT-04, AGENT-07, AGENT-03

**证据**

五片互不相干的尸体，每一条 dead-code 断言都用「排除自身与自身测试」的全仓 grep 反证过。

第一片是 v3 世界书栈。`src/sillytavern/index.ts` 这个 barrel 在 `src/` 与 `tests/` 下零 import（`grep -rn "from '@engine'|sillytavern/index" src tests` 无结果），应用一律走 `@engine/<module>` 深导入；它只作为 `package.json:5` 的 `"main": "dist/sillytavern/index.js"` 对外面存在。经它唯一保活的三个模块：`prompt-assembler.ts`（231 行，`assemblePrompt`/`replaceMacros`/`SUPPORTED_MACROS` 在 barrel 之外零引用）、`lorebook-engine.ts`（178 行，文件头自己写着「仅保留供 v3 prompt-assembler.ts 兼容使用」，唯一消费者就是同样已死的 prompt-assembler.ts:6）、`importer.ts`（233 行，8 个导出 `importLorebook`/`exportLorebook`/`importPreset`/`exportPreset`/`importJsonFile`/`exportToJson`/`importMultipleLorebooks`/`renameLorebook` 逐个 grep 全仓含 tests 命中数均为 0）。`editor-utils.ts`（87 行）连 barrel 都没进，`grep -rn "editor-utils|editorUtils"` 全仓零命中。四个文件均无 sibling `*.test.ts`，违反 AGENTS.md「每个新模块必须配套 `*.test.ts`」。`prompt-assembler.ts:210` 的 `replaceMacros` 还是仓库里第三份 `{{user}}`/`{{char}}` 宏替换实现。现役实现在 `worldbook-loader.ts` 的 `matchKeyword`/`filterActiveEntries` 与 `placeholder-registry.ts`/`agent-templates.ts`。

> 复核修正：删掉这三个文件**不会**让 `Lorebook`/`LorebookEntry` 变成孤儿——它们仍被 `importer.ts:5,45,47,96,231` 与 `database.ts:11,51,535,802,806`（AGENTS.md 明确要求保留的 v1-v3 死表）消费。只有 `MatchedEntry` 随之孤立。`importer.ts` 本身零引用，因此三件套整体删掉后才轮到类型收口。

第二片是 `stream-parser.ts`：157 行、四状态（NORMAL/BUFFER_TAG/TAGGED/OPAQUE）、带 `PARTIAL_LIMIT` 溢出回吐的状态机，全仓唯一命中是 `marker-protocol.ts:18` 的一句注释「正则扫描而非 StreamTagParser」——它连 barrel 都没被 re-export，是彻底的孤儿；实际 SSE 解析内联在 `AgentClient.chatStream` 里。同域的 `buildUserId(781)`/`parseUserId(788)` 非测试引用为零，`buildUserId` 的签名还留着废弃的 `saveId` 参数、函数体第一行就是 `void saveId;`。三份文档（AGENTS.md 架构树、`docs/ARCHITECTURE.md:220/:323/:357`）都把 stream-parser 列为「✅ 已完成 — XML 增量解析 + SSE」的承重件。

第三片是 M5 之后幸存的五个 v2 战斗模块。AGENTS.md:409-410 称 v2 纯计算文件「v3 内核仍调用」，这对 `combat-intention.ts`/`combat-damage.ts`/`combat-turn.ts`/`morale-system.ts` 成立，对下面五个不成立：`combat-panel.ts`（非测试引用 0；`projection-agent.ts:8` 写「复用 combat-panel.ts 的格式化风格」实为重写，`CombatActionCard.vue:9` 写「替代旧 combat-panel.ts」）、`cluster-system.ts`（只有 `combat-integration-scenario.test.ts:50`）、`combat-morale-pipeline.ts`（零 importer；v3 用自己的 `runMoraleCheck`，在 `phases/unit-turn.ts:241` 实现、`reducer.ts:654` 接线）、`death-system.ts`（文件与 `detectDeath`/`detectDeaths` 在 `src/` 零命中）、`fp-system.ts`（文件与 `$fp`/`calcContractCost` 零命中，FP 算术真源已是 `save-profile.ts`）。被它们吊着的测试合计 1439 行：cluster-system.test.ts 414、combat-panel.test.ts 404、combat-morale-pipeline.test.ts 291、fp-system.test.ts 274、death-system.test.ts 56。

第四片是 `agent-templates.ts` 里 11 个 Agent 的 `variableContext`/`variableInstruction` 闭包。`buildAgentMessages:733` 是 `let template = configuredTemplate || defaultTemplate`，只有 template 为空才落到 `buildFallbackMessages:893`，而后者是这两个字段的唯一调用点；`placeholder-registry.ts:502` 的 `DEFAULT_TEMPLATES` 覆盖了 story/memory_recall/plot_pre_check/request_dispatcher/vars_update/memory_summary/plot_post_check/plot_outline/craft_gen/char_gen/item_gen 共 11 个，这 11 个的闭包永远不会执行。`types.ts:399` 的注释自己写着 "are no longer used"。随之死掉的还有私有 `formatMemories(308)`/`formatVariables(326)`/`formatLorebook(333)`——`formatVariables` 在文件里连一处调用都没有。这些死闭包里仍留着实际提示词正文（如 char_gen 的「请调用工具获取随机值，只输出 `<char_result>` XML」），与「agent-config.json 唯一来源」的架构决策直接冲突；`agent-templates.test.ts:88/94/159` 还在断言这些死闭包「返回字符串」。

**影响**

约 2000 行没人执行的代码在读者与 AI 工具眼里和活代码等价。三条具体误导：改「提示怎么拼」的人会先打开名字最像的 `prompt-assembler.ts`；给士气修 bug 的人有一半概率改进 `combat-morale-pipeline.ts` 这条从不执行的完整第二实现；调提示词的人改了 `variableContext` 里的句子却毫无效果，白烧一整轮 prompt 调试。文档层面更糟——AGENTS.md 与 `docs/ARCHITECTURE.md` 三处断言 stream-parser 是承重件，实际零调用。测试层面，1439 行 v2 战斗测试 + 三条死闭包断言给出的是虚假覆盖率信号，让「哪些模块没测试」的账永远洗不干净。这批尸体还把 v3 死类型钉在 `types.ts` 上删不掉。必须排在任何巨石拆分之前，否则会被一起拖进新文件。

**重构建议**

按「零风险 → 需拍板」四批推进，每批一个 commit。

第一批（无需任何决策）：删 `src/sillytavern/editor-utils.ts`、`combat-morale-pipeline.ts`、`death-system.ts`、`fp-system.ts` 及后三者的测试文件。

第二批（v2 战斗收尾）：删 `combat-panel.ts` 与 `combat-panel.test.ts`；`cluster-system.ts` 与 `cluster-system.test.ts` 一并删（`combat-damage.ts` 重复实现的那两个 cluster helper 本身也无生产引用，不要「折进活模块」，两份一起删，除非 v3 明确要长 cluster 路径）。**不要整份删** `combat-integration-scenario.test.ts`——它是活着的四个 v2 纯计算模块的唯一端到端覆盖（文件头 :9-20 列了这四个），只摘掉其中 combat-panel/cluster-system 两节。随后把 AGENTS.md:409-410 改成精确点名 v3 仍调用的四个文件。

第三批（v3 世界书栈 + stream-parser，需与 owner 确认发布面）：先确认 `main: dist/sillytavern/index.js` 是否是真实发布面（仓库内无打包发布证据）。若否，删 `index.ts`、`prompt-assembler.ts`、`lorebook-engine.ts`、`importer.ts`、`stream-parser.ts`，同批把 `MatchedEntry` 从 types.ts 摘掉、给 `Lorebook`/`LorebookEntry`/`SillyTavernLorebookExport` 加 `@deprecated 仅为 Dexie v1-v3 死表保留形状`。若是，则新建 `src/sillytavern/public-api.ts` 只 re-export 应用真正在用的 `database`/`types`/`marker-protocol`/`story-output`/`beautifier`，**同一 commit 内**改 `package.json` 的 `main`，并加一条断言测试「public-api 的每个导出至少有一个 `src/` 内消费者或一条测试」。删 `parseUserId` 前先确认没有持久化产物（缓存 run 记录、导出的 endpoint 配置）还在回读 `fp|saveId|agentId` 旧格式字符串——目前未发现此类读者，但检查很便宜。三批都要同步修 `docs/ARCHITECTURE.md:220/:323/:357`，不能只改 AGENTS.md。

第四批（提示词死闭包）：把 `types.ts:407-409` 的 `variableContext`/`variableInstruction` 改成可选；给 combat/plot_check/plot_correct 三个尚无默认模板的 Agent 补 `DEFAULT_TEMPLATES` 条目（它们现有的这两个字段本就是空串，无内容损失），然后整体删掉 `buildFallbackMessages` 与 11 个 Agent 的闭包、随之无引用的 `formatMemories`/`formatVariables`/`formatLorebook`，让「无模板 → 返回 null」成为唯一分支；删 `agent-templates.test.ts:88-96/159-162`。顺带把 `buildAgentMessages:754-798` 与 `buildFallbackMessages:903-922` 重复的兜底级联提成 `resolveSystemPromptContent`——注意两者**并非完全相同**：前者多一个 story 分支（`resolveTemplateWithGlobals` 预解析 + `STORY_PRESET_PLACEHOLDER_RE` 检测），只有后两级（systemPrompt 兜底、fixedSystem+fixedExamples 兜底）逐字一致，抽取时要么把 story 预解析作为参数传入，要么只收敛那两级。

<a id="q-10"></a>

### Q-10 Legacy EJS 后端的两处遗产：编译缓存只服务已停用路径，同步渲染路径在生产恒被闸门关死却仍作为第二套完整实现维护

- **严重度**：中
- **主题**：僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路
- **位置**：`src/sillytavern/ejs-backend.ts:79`、`src/sillytavern/ejs-backend.ts:85`、`src/sillytavern/ejs-backend.ts:119`、`src/sillytavern/ejs-backend.ts:193`、`src/sillytavern/worldbook-loader.ts:278`、`src/sillytavern/worldbook-loader.ts:287`、`src/sillytavern/worldbook-loader.ts:366`、`src/sillytavern/worldbook-loader.ts:387`、`src/sillytavern/worldbook-loader.ts:405`、`src/sillytavern/worldbook-loader.ts:439`、`src/sillytavern/ejs-quickjs-backend.ts:636`、`src/sillytavern/ejs-quickjs-backend.ts:1061`、`src/sillytavern/placeholder-registry.ts:155`、`src/sillytavern/agent-templates.ts:939`
- **工作量**：M　**风险**：中
- **来源**：WB-03, WB-07

**证据**

两件事共享同一个根因：Legacy 后端已经退到生产之外，但为它写的基础设施仍完整活着，并且是生产路径拿不到的那一份。

其一，编译缓存重复且只服务死路。`type CompileCacheHit = { ok: true; compiled: CompiledEjsEntry } | { ok: false; error: string }` 在 ejs-backend.ts:79 与 worldbook-loader.ts:278 各声明一次；`getCompiledEntry`（ejs-backend.ts:85-99）与 `getCompiled`（worldbook-loader.ts:287-300）函数体逐行相同，只是变量名不同（`compileCache` / `ejsCompileCache`），各配一个 clear 函数。两者都只被 Legacy 路径消费：前者只在 `LegacyBackend.runPass`（:119）用，后者只在同步 `renderWorldBookEntries`（:405）用。生产真正在跑的 `QuickJsBackend.runEntry` 每个条目都现调 `compileToGuestBody(source)`（ejs-quickjs-backend.ts:637 → 1061），内部 `tokenizeTrimmed` 全量重新分词 + 字符串拼接，**零记忆化**，随后 `context.evalCode(wrapped)` 让 QuickJS 再解析一遍同样的源码。文件自记的实测是「109 条目单 pass 348-583ms（同口径 Legacy 6-73ms）」。

其二，同步渲染路径在生产恒被闸门关死。`renderWorldBookEntries`（worldbook-loader.ts:366-424）与 `prerenderWorldBookEntries`（:439-487）是两条并行实现（分区与组装已抽成 `partitionEntries` / `assembleResult` 共用，求值、回退收集、告警各写一份）。同步那条在 :386-387 自带闸门 `const hostEvalAllowed = getEjsBackend() instanceof LegacyBackend`，而 ejs-backend.ts:193 的注释明说生产**永远不会**停在 LegacyBackend 上（`installProductionEjsBackend` 第一件事就是换成 FailClosedBackend）。也就是说生产里 `hostEvalAllowed` 恒为 false，那条路只会给每个动态条目产出一条「EJS 未求值（同步路径不在宿主 realm 求值…）」的回退记录。

> 复核修正：该同步路径的调用点不止两处。除 placeholder-registry.ts:155-160（注释自陈「这里只剩测试与外部直接调 resolver 的极端路径」）与已在 2026-08-01 改走 Async 的 create-store.ts:1071 外，agent-templates.ts:939 在同步的 `buildAgentMessages` 内使用 `memo && memo.agentId === agentId ? memo : renderWorldBookEntries(activeEntries, ejsCtx)`，而 `buildAgentMessages` 是 :849 文档化的公共导出。所以下面的重命名/降格方案会碰到面向生产的引擎代码，不只是两个测试路径。

**影响**

性能侧：每一次装配 pass 都把所有动态条目重新分词、重新拼串、重新交给 QuickJS 解析字节码，而条目正文在回合之间几乎从不变。这是 348-583ms 主线程占用里可以直接省掉的一块，也是 `passTimeoutMs` 从 1500 被迫上调到 5000 的背景。同时仓库维护着两份为它准备好、却服务不到它的缓存代码。

可读性侧：读者面对两个名字近似、语义号称一致的导出函数，无法从签名判断哪个是生产路径，而其中一个在生产里只会产出回退。它还把 `LegacyBackend` 钉成「不能删」，让备忘录里的 Legacy 退役计划多背一个耦合点；同步路径的 `fallbackEntries` 还会在测试里制造与生产完全不同的诊断输出，掩盖真实回退率。

**重构建议**

分两个可独立合入的步骤：

1. 缓存合一并接到生产路径。删掉 worldbook-loader.ts:278-305 的 `ejsCompileCache` / `getCompiled` / `clearEjsCompileCache`，同步路径改 import ejs-backend 的 `getCompiledEntry`。再给 QuickJS 加它自己那层：在 ejs-quickjs-backend.ts 内加 `const guestBodyCache = new Map<string, string>()` 包住 `compileToGuestBody`（键 = 条目正文，与另两处同键）。进一步可在 guest 侧把 wrapped 源码编成一个挂在 `globalThis` 上的具名函数、按条目正文哈希复用，把 `evalCode` 从「每回合每条目」降到「每 pass 每新条目」。
2. 把同步路径降格为它实际的样子。先审计 `buildAgentMessages` 的侧链调用者（char-gen / craft-gen / item-gen 的注释都引用它），确认现行管线全部走 Async 变体；然后让 placeholder-registry.ts:161 的兜底分支不再求值——直接 `partitionEntries` + 原文注入（动态区透传），删掉 :386-387 的闸门与 :405-420 的求值分支。这样同步侧只剩「分区 + 原文」，Legacy 退役时无需再改这里，生产诊断口只剩 prerender 一条，回退率统计才可信。注意这会改测试期望：worldbook-loader.test.ts:398-513、worldbook-ejs-corpus.test.ts（约 10 条断言）与 ejs-synthetic-corpus.test.ts:227-244 都在 Legacy 默认后端下断言同步路径的真实渲染输出，需要在同一 PR 里把这批基线一并迁到 prerender。

<a id="q-22"></a>

### Q-22 combat-v3 公共面上的两个装饰性字段：bundle 贯穿整条攻击路径却从不被读，CombatSession.completed 是构造时快照

- **严重度**：中
- **主题**：僵尸与空壳：删不掉的旧实现正在给新人和 AI 指路
- **位置**：`src/sillytavern/combat-v3/phases/attack.ts:59`、`src/sillytavern/combat-v3/phases/attack.ts:287`、`src/sillytavern/combat-v3/phases/attack.ts:349`、`src/sillytavern/combat-v3/phases/attack.ts:506`、`src/sillytavern/combat-v3/reducer.ts:288`、`src/sillytavern/combat-v3/kernel.ts:81`、`src/sillytavern/combat-v3/types.ts:1064`、`src/sillytavern/combat-v3/replay.ts:274`、`src/sillytavern/combat-v3/coordinator.ts:137`
- **工作量**：S　**风险**：低
- **来源**：CMBT-06, CMBT-07

**证据**

其一，`bundle` 是装饰性参数。`grep -n bundle src/sillytavern/combat-v3/phases/attack.ts` 在这个 931 行的文件里只返回五行：三处参数声明（`handleAttack` :59、`finalizeAttack` :349、`resumeBlockedAttack` :506）与两处透传（:295、:552）。全文没有任何 `bundle.*` 的读取，终点消费者 `finalizeAttack` 也从不碰它。因为签名要一个，reducer 就造了一个来满足 DeclareBlock 的 resume 路径：

```ts
function bundleOf(state: CombatState): CombatDefinitionBundle {
  // resumeBlockedAttack 只用 state.units + recompute；bundle 仅供签名
  return {
    participants: Object.values(state.units as never) as never,
    combatType: '标准',
    rulesetRevision: 'v3-m3',
  };
}
```

（reducer.ts:288-298）注释本身就承认了这一点。而 attack.ts:287 的文档注释仍宣称「bundle 参与 runDamagePipeline 的 skill 解析」——正是这句过期理由让参数活到今天。

其二，`CombatSession.completed` 是构造时快照。kernel.ts:81 在闭包体里、任何 dispatch 发生之前算一次 `const completed = state.phase === 'Terminal' || state.phase === 'SettlementCommitted';`，然后把这个捕获到的布尔值放进 :87 返回的对象。`state` 在 `dispatch` 内会被重新赋值（:56），但 `completed` 是普通 `const` 而非 getter，所以对任何经 `openCombat({kind:'new'})` 建出的 session 它永远是 `false`；反过来，`openCombat({kind:'restore'})` 恢复一个已在 Terminal/SettlementCommitted 的状态时它永远是 `true`——两个方向都错。types.ts:1064 把它声明为 `readonly completed: boolean`，读起来像活状态。两个既有消费者朝相反方向理解错：replay.ts:274 循环 `while (!session.completed && steps < MAX_TOTAL_STEPS)`，这个条件恒真，终止完全依赖 :293 的 `break` 与步数上限；coordinator.ts:137-139 的注释写「用的是 phase 而非 session.completed，因为 completed 在 Terminal 就返回 true，会漏掉结算」，断言了一种并不存在的实时更新行为。

**影响**

index.ts:1-11 宣称内核是「单一公共面的深模块」，而这个公共面上有一个非功能字段，还被相邻注释错误描述。下一个照着 `openCombat` 写驱动循环的人会用 `completed`——那是最显然的选择——然后得到一个只被自己加的步数上限兜住的无限循环。两个既有消费者对同一字段的语义理解相反，本身就是「这个形状学不会」的证据。`bundle` 一侧的危害是前瞻性的：调用方无法从签名看出它是装饰品，每个新调用点都得弄一个或伪造一个；reducer 已经伪造并硬编了一个错的 `combatType: '标准'`，将来若真有人在 `finalizeAttack` 里读 `bundle.combatType`（例如按士气类型算伤害），block-recompute 路径会把每场战斗静默判成标准——一个能通过类型检查、通过全部测试、只在 block 路径显形的 bug。今天 `completed` 没有任何测试覆盖。

**重构建议**

两处都是纯签名收敛，风险在于必须同一次提交改到两个调用点：

1. 删掉 `bundle` 参数：从 `handleAttack`（:59）、`finalizeAttack`（:349）、`resumeBlockedAttack`（:506）移除，删掉 reducer.ts 的 `bundleOf`（连带删掉那两个 `as never` 强转），更新两个调用点，并删掉 attack.ts:287 那条过期注释。将来某个窗口若真需要战斗级事实，传具体字段（`combatType: CombatType`）而不是整个 bundle——产出 `PhaseOutcome` 的函数应当只拿它读的东西。顺带把 `finalizeAttack` 的 `ability: Record<string, unknown> & { … }`（:352-360）换成 combat-v3/types.ts 里真正的 `AbilityProfile`，:489 的 `damageType: ability.damageType as never` 随之消失。
2. 把 `completed` 变成活 getter：在 `createSession` 里用 `get completed() { return state.phase === 'SettlementCommitted'; }` 替换捕获的 const（取 SettlementCommitted 而非 Terminal——这正是两个消费者实际想要的，见 coordinator 注释），types.ts:1064 的文档改成「结算已提交」。然后把 replay.ts:274 与 coordinator.ts:139 改成用它，删掉 coordinator.ts:137-139 的过期注释。谓词从 `Terminal || SettlementCommitted` 收窄到 `SettlementCommitted` 是公共字段的语义变更，replay 目前依赖 Terminal 在循环体内处理，两个消费者必须同一次提交更新，否则 replay 会多转一圈。补一条 kernel 测试：dispatch 到结算后断言 `session.completed === true`。
