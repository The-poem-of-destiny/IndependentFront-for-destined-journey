# T2 AI 文本与引擎状态之间没有唯一的编解码缝

> 本文是《[代码质量与重构审查报告（2026-08-03）](README.md)》的一部分。返回 [索引与优先级总表](README.md) · [重构路线图](roadmap.md) · [健康面与覆盖缺口](health-and-gaps.md)

## 成因

从模型文本抢救结构（XML 标签 / marker 扫描 / JSON 围栏 / 子元素）与把结构写回状态（翻译层、落库回执）这两个方向，都没有一个被测试钉住的共享模块，每条 Agent 链各自演化出一份容忍度。真机 debug loop 每修好一处，其余五处不受惠；失败回执又有三种形态，落库失败会伪装成解析失败，把调试引向改 prompt。

## 本主题的发现

| ID            | 严重度 | 问题                                                                                                                                                          |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Q-05](#q-05) | 高     | AI 输出解析没有共享缝：XML 标签 / marker 扫描 / JSON 抢救 / 元素解析共 15+ 份拷贝，同名 extractTag 语义相反，effect 正则已漂出静默数据丢失                    |
| [Q-13](#q-13) | 中     | assembleCharacterState 里 14 处无谓的 as any，同一对象字面量一半字段带转型一半不带                                                                            |
| [Q-14](#q-14) | 中     | 失败回执三处口径各异：解析失败与落库失败混成一条 warn、同层写操作并存四种回执、executeToolCall 一半 throw 一半返回 error                                      |
| [Q-17](#q-17) | 中     | agent-client 的流式与非流式路径各写一份请求体组装、fetch 与错误翻译                                                                                           |
| [Q-19](#q-19) | 中     | AI→状态 的写入链是两个无缝巨型函数：翻译层挤在 orchestrator 一个 560 行私有方法里，提交层是 30 分支手写 switch + 14 处非必要动态 import + 10 处 (char as any) |

<a id="q-05"></a>

### Q-05 AI 输出解析没有共享缝：XML 标签 / marker 扫描 / JSON 抢救 / 元素解析共 15+ 份拷贝，同名 extractTag 语义相反，effect 正则已漂出静默数据丢失

- **严重度**：高
- **主题**：AI 文本与引擎状态之间没有唯一的编解码缝
- **位置**：`src/sillytavern/char-gen-agent.ts:1646`、`src/sillytavern/char-gen-agent.ts:1713`、`src/sillytavern/char-gen-agent.ts:1297`、`src/sillytavern/char-gen-agent.ts:1376`、`src/sillytavern/char-gen-agent.ts:720`、`src/sillytavern/char-gen-agent.ts:793`、`src/sillytavern/craft-gen-chain.ts:664`、`src/sillytavern/craft-gen-chain.ts:682`、`src/sillytavern/placeholder-registry.ts:70`、`src/sillytavern/plot-outline.ts:150`、`src/sillytavern/marker-protocol.ts:40`、`src/sillytavern/marker-protocol.ts:131`、`src/sillytavern/marker-protocol.ts:201`、`src/sillytavern/marker-protocol.ts:322`
- **工作量**：M　**风险**：低
- **来源**：AGENT-02, XCUT-02, AGENT-04, CORE-10, AGENT-09

**证据**

「AI 文本 → 引擎状态」这条唯一入口被拆成四类互不通气的拷贝。

第一类，XML 标签抽取。`craft-gen-chain.ts:664` 的注释直说 `// (mirrors char-gen-agent.ts helpers for self-contained operation)`。两个同名函数语义完全相反：`char-gen-agent.ts:1646` 是 `extractTag(xml, tagName)` 返回 `match[1].trim()`（标签内文本，先传 xml），`craft-gen-chain.ts:682` 是 `extractTag(tagName, text)` 返回 `match[0]`（含标签整块，先传 tag）。同一文件里另有 `extractXML(text, tagName)`（:1639，返回 `match[0]`）与 `extractTagBlock(xml, tagName)`（:1682，返回 `match[1].trim()`）——四个函数两两互为对方的语义。正则本体也已漂移：craft 侧过 `escapeRegex`（:727）且不 trim，char-gen 侧直接内插且 trim。属性解析同理：`char-gen-agent.ts:1695` 的 `parseAttrsStr` 用 `/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g`（单双引号都吃、容忍等号旁空格），`craft-gen-chain.ts:717` 的同名函数只有 `/(\w+)="([^"]*)"/g`。第三处镜像在 `placeholder-registry.ts:70`：`/** Mirror of agent-templates.ts formatCharacters (private, not exported) */`，三个格式化函数只因原版没 export 而被整份复刻。

第二类，item_gen 的元素解析器五份复制粘贴。`parseSkillsXML`(1288)/`parseEquipmentXML`(1361)/`parseInventoryXML`(1420)/`parseElementsXML`(1476)/`parseAuthoritiesXML`(1517) 各自重写同一段「抠 `<effect name>`/`<script name>` 子元素 + 预剥离块 + 取纯文本 description」。正则已经不一致：:1297 用 `/<effect\s+name="([^"]*)">([\s\S]*?)<\/effect>/g`（要求 name 是第一个属性且紧跟 `>`），:1376 用 `/<effect\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/g`（容忍前置属性）。同一条 AI 输出 `<effect type="buff" name="灼烧">` 写在装备里能收到，写在技能里被丢掉——elements(1486) 与 authorities(1527) 同样用严格版，五类里有三类会静默丢失 effect 描述。另有 `parseAutomataXML`(793) 是 `parseModifiersXML`(720) 的逐行复制（约 50 行，:786 注释自陈「复用 parseModifiersXML 模式」），以及三处逐字重复的四连 replace 剥壳链（1324-1329、1394-1399、1447-1452）。

第三类，「从模型输出里抢救 JSON」。同一句 `const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);` 出现在 `plot-engine.ts:93`、`plot-engine.ts:212`、`plot-outline.ts:134`、`memory-summarizer.ts:89`，加上 UI 侧 `game-pipeline.ts:1194`、`create-store.ts:1038`，共六份；`char-gen-agent.ts:1715` 与 `craft-gen-chain.ts:695` 另有一套 ```json 围栏剥壳、`game-pipeline.ts:1272` 又有一套 `<json>` 标签剥壳，四处都各不相认。`plot-engine.ts:201` 的 `parsePostCheckOutput` 更在同一函数内两个分支不一致：主分支逐字段兜底 `eventUpdates: Array.isArray(...) ? ... : []`，catch 兜底分支却是裸的 `return JSON.parse(jsonMatch[0]) as PostCheckResult;`。而 `postCheckPlot` 在 :259/:290 无守卫地遍历 `parsed.eventUpdates` 与 `parsed.newChildEvents`——兜底路径遇到缺键输出直接抛 TypeError，再被 `game-pipeline.persistPlotPostCheck` 的 catch（:1264）吞成 console.warn，整条剧情后检查静默空转。

第四类，marker 扫描。`marker-protocol.ts` 里 `scanCraftRequests`(131)/`scanCombatTriggers`(156)/`scanCharDetects`(178)/`scanCharGenRequests`(201)/`scanCharUpdateRequests`(227)/`scanItemGenRequests`(249)/`scanItemUpdateRequests`(273)/`scanCraftGenRequests`(299) 八个函数骨架完全一致，只差 TAG 常量与字段映射；`scanMarkers`(384) 因此要手工列出八个结果再 concat 再排序。:322 的 doc 还写着「全部 8 种标记」，而 `MARKER_TAGS`(:40) 已有 9 项（play_audio 补进来时没更文案）。`escapeRegex` 第三份也在这里（:71）。

> 复核修正：两处子主张需要收窄。其一，`bodyText` 兜底 `|| undefined`（:131）与 `|| ''`（:201）不是抄漏——`types.ts` 把四个较早 marker 的 `bodyText` 声明为可选（2875/2889/2903/2929），五个 Phase-10 request marker 声明为必填（2957/2969/2983/2998/3013），两种写法各自正确，不应统一成空串。其二，`craft-gen-chain.ts` 的弱版 `parseAttrsStr` 只有一个调用点（:623），且 craft 链的物品解析委托给 char-gen 的 `parseItemGenOutput`，所以「同一段输出走两条链解析出不同结果」的可达面是一个 parser 而非整条链。此外 `escapeRegex` 的分歧目前是惰性的（所有调用点都传无正则元字符的字面标签名）。

**影响**

AI 输出的包裹形态（裸 JSON / 围栏 / 标签 / 前后夹带解说）和容错口径（属性单引号、缺闭合、属性顺序）是天天在真机踩的现实问题，而修好一处不会惠及其余，下一个人也无从知道哪几种形态已被兼容过。item_gen 的 effect 正则漂移是已经在发生的字段丢失；剧情后检查的兜底分支是已经在发生的静默空转。同名不同语义的 `extractTag` 是一枚长期地雷：两边签名都是 `(string, string)`，把定义连同调用一起复制过去编译照过，运行时把整块 XML 当字段值写进角色档案。

**重构建议**

分三步，每步独立可合入：

1. 立刻单独修 `plot-engine.ts:201` 的 catch 分支，补上与主分支相同的字段兜底（一行改动，不依赖后续抽取）。
2. 新建 `src/sillytavern/agent-xml.ts` 作为 AI 输出解析的唯一工具面，参数顺序统一为 `(source, tag)`，只导出语义无歧义的名字：`tagInner(source, tag): string | null`（内文，trim）、`tagBlock(source, tag): string | null`（含标签整块）、`tagAttr(source, tag, attr): string | null`（单双引号都吃）、`parseAttrsStr`、`stripInnerTags`、`escapeRegex`。配 `agent-xml.test.ts`，把三份现有容错行为的并集钉成回归。随后删掉 `char-gen-agent.ts:1639-1730` 与 `craft-gen-chain.ts:664-740` 两段 helper 改为 import；`escapeRegex` 从 `marker-protocol.ts:71` 提入本模块共享。新模块不得反向 import 这两个宿主（craft-gen-chain 已有一处 `await import('./char-gen-agent')` 用于 `parseItemGenOutput`，那处与本次抽取无关，保持原样）。`agent-templates.ts` 把 `formatCharacters`/`formatMemories`/`formatPlotEvents` 改成 export，`placeholder-registry.ts` 删掉 mirror。
3. 新建 `src/sillytavern/model-json.ts`，导出 `extractJsonPayload(raw): string | null`（依次尝试：裸 trim → ```json 围栏 → `<json>` 标签 → 首个 `{` 到末个 `}` 的贪婪切片 → 截掉 JSON 之后的解说文字，即 char-gen:739 那种按注释下标切片的场景）与 `parseModelJson<T>(raw, normalize)`。上述六处全部改调它，各自只保留 normalize 回调，从形态上消灭「两个分支两套兜底」。配 `model-json.test.ts` 覆盖四种包裹形态与前后夹带文字。
4. 在 `char-gen-agent.ts` 内提三个私有 helper 收掉五份元素解析：`parseNamedChildren(inner, 'effect' | 'script')`（一律用宽松正则）、`parseJsonLinesBlock<T>(inner, tagName, requiredKeys)`（`parseModifiersXML` 与 `parseAutomataXML` 合并成它的两次调用，**tagName 必须穿进 warn 文案**——真机调试依赖 `[item_gen] <modifiers> 第 N 行…` 这类信息）、`stripKnownChildBlocks(inner)`（那段四连 replace）。
5. `marker-protocol.ts` 建一张 `MARKER_SPECS: Record<MarkerType, { attrKeys: string[]; nested: boolean; selfClosing?: boolean }>`，写一个 `scanByTag<T>(text, tag): T[]` 走表出结果；八个具名 `scanXxx` 保留为一行 wrapper（`scanCharDetects` 被 `char-gen-agent.ts:38` import，外部调用点不能断），`scanMarkers` 改成遍历 `MARKER_TAGS`；`bodyText` 兜底作为 per-tag spec 的一项而非全局统一；play_audio 按 `selfClosing: true` 变体处理，不塞进通用正则；顺手更正 :322 的「8 种」文案。

<a id="q-13"></a>

### Q-13 assembleCharacterState 里 14 处无谓的 as any，同一对象字面量一半字段带转型一半不带

- **严重度**：中
- **主题**：AI 文本与引擎状态之间没有唯一的编解码缝
- **位置**：`src/sillytavern/char-gen-agent.ts:346`、`src/sillytavern/char-gen-agent.ts:376`、`src/sillytavern/char-gen-agent.ts:398`、`src/sillytavern/types.ts:3111`、`src/sillytavern/types.ts:3227`
- **工作量**：S　**风险**：低
- **来源**：AGENT-08

**证据**

`types.ts:3112` 的 `CharGenOutput` 与 `types.ts:3227` 的 `ItemGenOutput` 在 skills/equipment/inventory 三个数组上都已显式声明了 `modifiers?`/`buffs?`/`divinity?`/`automata?`，但 `assembleCharacterState` 仍写：

```ts
...((s as any).modifiers && (s as any).modifiers.length > 0 ? { modifiers: (s as any).modifiers } : {})
```

更能说明这是习惯而非必要的是 364-382 那个对象字面量：376 行 `...(e.modifiers ? ...)` 不转型，380 行 `...((e as any).automata && ...)` 转型——同一个 `e`、同样都是已声明的可选字段。398-406 的 inventory 分支同样如此。全文 14 处 `as any`，其中 11 处属于这一类。

> 复核修正：原文建议「直接去掉这些 as any，跑一次 typecheck 即可确认」，若对全部 14 处照做会失败——14 处里只有 11 处可直接移除，另 3 处对应的字段今天确实不在类型上。正确顺序与原文相反：先给 `CharGenOutput.equipment` / `CharGenOutput.inventory` 补 `effects?`/`scripts?`（或直接做具名类型抽取让两个 Output 共用同一形状），再统一删断言。`CharGenOutput.skills` 与 `ItemGenOutput.skills` 已字段一致，346-354 那 8 处可以立刻清掉、零类型改动。

**影响**

`as any` 会连带屏蔽真正的错误：把 `automata` 打成 `automatas`、把 `divinity` 当数组用，编译器一句都不吭——而这些恰是战斗 v3 刚接进来、最可能改形状的字段。这个 60 行的字段逐条搬运函数是 char_gen / item_gen / craft_gen 三条生成链共同的落库口，静默丢字段的代价最高。

**重构建议**

按下列顺序：

1. 先清 skills 一半：删掉 346-354 的 8 处断言，`npm run typecheck` 应零报错。
2. 把 `CharGenOutput` 与 `ItemGenOutput` 的 skills/equipment/inventory 三份逐字重复的内联匿名结构提成具名类型 `GeneratedSkill` / `GeneratedEquipment` / `GeneratedItem` 放进 `types.ts`，两个 Output 接口引用它们；同时给 `CharGenOutput.equipment`/`inventory` 补 `effects?`/`scripts?`。此步涉及游戏数据实体字段定义，按 AGENTS.md 必须先读 `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`。
3. 删掉剩余全部断言，再跑一次 typecheck。
4. 三段合并逻辑随之可收成一个泛型 `mergePreferCharGen<T extends { name: string }>(charSide, itemSide)`——注意这个泛型只有在第 2 步做完（两侧结构统一）之后才可能通过类型检查，今天两侧结构不同正是断言堆积的原因。

<a id="q-14"></a>

### Q-14 失败回执三处口径各异：解析失败与落库失败混成一条 warn、同层写操作并存四种回执、executeToolCall 一半 throw 一半返回 error

- **严重度**：中
- **主题**：AI 文本与引擎状态之间没有唯一的编解码缝
- **位置**：`src/sillytavern/agent-orchestrator.ts:856`、`src/sillytavern/agent-orchestrator.ts:1259`、`src/sillytavern/agent-orchestrator.ts:1321`、`src/sillytavern/agent-orchestrator.ts:1330`、`src/ui/stores/asset-store.ts:230`、`src/ui/stores/audio-store.ts:688`、`src/ui/stores/audio-store.ts:704`、`src/ui/components/settings/audio/AudioLibrary.vue:413`、`src/sillytavern/agent-tools.ts:606`、`src/sillytavern/agent-tools.ts:934`、`src/sillytavern/agent-tools.ts:1011`、`src/sillytavern/char-gen-agent.ts:288`、`src/sillytavern/craft-gen-chain.ts:342`、`src/sillytavern/item-gen-chain.ts:247`
- **工作量**：M　**风险**：低
- **来源**：AGENT-06, STORE-06, AGENT-10

**证据**

同一个问题在三个层上各有一种表现形式：失败没有唯一编码方式，于是每个调用点自己猜。

编排层把两类失败混成一条。agent-orchestrator 里三个 try 块的范围都从 `JSON.parse` 一直包到 `await sm.commitChatState()`，catch 却是无参 catch：

```ts
} catch { console.warn('[Orchestrator] vars_update <json> 解析失败，跳过状态更新'); }
```

:1260 如上，:856 与 :1322 同型。也就是说 `commitChatState` 真抛异常（Dexie 写失败、校验器 throw）时，用户看到的文案是「`<json>` 解析失败」，异常对象整个丢弃，而专为把落库失败上浮给 UI 才存在的 `onStateCommitError` 回调（`reportCommitResult`:1330）不会触发。同一 stage 里另一处 catch（:1283 status_effects）反而带了 `e`，可见口径不统一。此外 :1290-1291 把 :934 已经 parse 过的同一个 `jsonMatch[1]` 又 parse 一遍（只为读 `parsed.quests`），两次 parse 的失败还分别落进两个不同的 catch。需要注意 `commitChatState` 的契约是返回带 `errors[]` 的 `StateCommitResult` 而非抛错，所以被吞掉的是更窄的一类——真正的 throw；这也是本条定中而非高的原因。另外 :855 的 `applyTimeAdvance` 目前也在同一个吞异常的 try 里，时间推进抛错同样会被标成「解析失败」。

Store 层同层并存四种回执。audio-store 的曲目写操作：`deleteTrack(id): Promise<void>`（:688，**无 try/catch**，`dbDeleteAudioTrack` 失败直接把 rejection 抛给调用方）、`deleteTracks(ids): Promise<AudioBatchResult>`（:704，逐条 try/catch 并在 :723 弹「有 N 首没能删除，它们仍留在曲库里」）、`renameTrack(id, name): Promise<boolean>`（:664）、`setTrackTags` / `setTrackKind: Promise<void>`（:673/:680，遇 builtin 静默 return）、`createPlaylist: Promise<AudioPlaylist | null>`（:747）。调用侧 AudioLibrary.vue:413 是裸 `await audio.deleteTrack(t.id);`，无 catch。asset-store 侧同样并存 `boolean`（`deleteAssetById` :2101）、`AssetMutationResult`（:230 声明，:1999 处为消费方签名）、`AudioBatchResult`（:2122）三种。

工具层一半 throw 一半返回。`executeToolCall(functionName, args, context): Promise<any>`（agent-tools.ts:606-610）是 17 个工具的唯一分发口，:630/644/707/830/836/841/956/968/1011 走 `throw new Error`（「缺少必需参数: formula」「未知工具: X」），而 :934 同样是「参数不合法」却走 `return { query, error: '未知分类 ...' }`。返回类型 `any` 意味着 `ALL_TOOL_DEFINITIONS` 声明的 schema 与实际返回结构之间没有任何编译期联系；六个调用点（agent-client.ts:253 的 toolExecutor、char-gen-agent.ts:288、craft-gen-chain.ts:342、item-gen-chain.ts:247 等）拿到的都是 `any` 再 `JSON.stringify` 回喂给模型。

**影响**

落库失败伪装成 AI 输出格式问题，debug loop 会去改 prompt 而不是查 StateManager——在真机迭代阶段这是最贵的一类误导，掉状态且界面无任何提示。「删一首静默失败、删多首有明确解释」是用户能直接撞上的不一致；`boolean` 的多义性把判定逻辑漏到每个调用点（AudioLibrary.vue:376-381 被迫 `audio.findTrack(t.id)` 反查 store 早就知道的失败理由），第二个调用点必然忘记反查。工具层两种失败形态在模型眼里长得不一样（一个是 `{"error":...}` 的 tool 消息，一个是被 `chatWithTools` 包成 `{error: message}`），prompt 侧无法统一教模型如何应对失败。

**重构建议**

三处可放进同一个 PR，互不阻塞：

1. 编排层（S）：把 try 缩到只包 `JSON.parse`，catch 带上 err；翻译与 commit 移到 try 之外，commit 用独立 try/catch 调 `this.events.onStateCommitError?.(source, [String(err)])`。这不新增写入路径，只新增一条失败上报路径，与 ADR-21 不冲突。顺带把 `vars_update` 的 `<json>` 只 parse 一次，quests 分支复用同一个 `parsed`；:855 的 `applyTimeAdvance` 同时挪出吞异常的 try。
2. Store 层（M）：新建 `src/ui/stores/store-result.ts`，声明 `type MutationResult<T = void> = { ok: true; value: T } | { ok: false; reason: 'not-found' | 'builtin' | 'name-taken' | 'quota' | 'failed'; message: string }`。`deleteTrack` 改为复用 `deleteTracks` 的单条实现并返回该类型；`renameTrack` 返回带 reason 的失败，AudioLibrary.vue 直接 `switch (res.reason)` 出文案，删掉 :376 的反查；asset-store 的 `AssetMutationOutcome` 已是判别式，收敛进同一家族。两条硬约束：`deleteTracks` 的 skipped 桶刻意把 builtin + not-found 归为「非错误」（:697-702 文档），批量调用点不能因为统一回执把它们变成失败；`setTrackTags` / `setTrackKind` 的 builtin 静默返回是同一策略，改成判别式会改变 AudioLibrary 必须处理的分支集。
3. 工具层（S）：`executeToolCall` 所有失败路径统一 throw（把 :934 改掉），由 `agent-client.chatWithTools` 的既有 catch 统一转成 `{ error }` 消息——「工具失败长什么样」只在一处定义；返回类型从 `Promise<any>` 收成 `Promise<ToolResult>`（`type ToolResult = Record<string, unknown>`，放进 types.ts）。注意 :934 的改动是模型可见的契约变更（今天 `get_script_reference` 传坏分类会得到一条可读可重试的正常 tool 结果），按 AGENTS.md 要先在 `reference/agent流程测试/agent预期分析.md` 里对齐后再翻。

<a id="q-17"></a>

### Q-17 agent-client 的流式与非流式路径各写一份请求体组装、fetch 与错误翻译

- **严重度**：中
- **主题**：AI 文本与引擎状态之间没有唯一的编解码缝
- **位置**：`src/sillytavern/agent-client.ts:321`、`src/sillytavern/agent-client.ts:348`、`src/sillytavern/agent-client.ts:362`、`src/sillytavern/agent-client.ts:642`、`src/sillytavern/agent-client.ts:658`
- **工作量**：S　**风险**：低
- **来源**：AGENT-05

**证据**

`chatStream`（声明于 :321，请求体字面量始于 :362）与 `callOnce`（声明于 :642，字面量始于 :658）逐字重复：同一份 body 字段表（model/messages/temperature/max_tokens/top_p/frequency_penalty/presence_penalty/stop/user_id）；同一句 max_tokens 兜底注释「真机修(2026-07-17): 侧链 request 不带 maxTokens，2048 兜底会截断 char_gen 思考链+XML」抄在 367 与 663 两行；同一段 tools/tool_choice 注入（377-380 / 673-676）；同一段 thinking 模式分支（383-388 / 687-692，后者带 15 行踩坑注释，前者只写「与 callOnce 对齐，详见该处注释」）；同一段 fetch 头（`X-Target-Base-URL` + Bearer）与同一段 `!res.ok` 错误处理含两条 console.error（401-411 / 705-715）。两者唯一实质差异是 `stream: true` + `stream_options`。超时口径却又各写各的：非流式用 `this.timeout`，流式在 :348 硬编码 `this.timeout * 3`（该行有两行说明注释，不算裸魔数，但仍是无名字面量）。

**影响**

每调一个采样参数、每加一个厂商兼容字段（Cline 解包、ollama thinking 这类已经踩过两次）都要记得改两处；漏一处就是「流式能跑、非流式空回」这种最难查的症状。

**重构建议**

提两个私有方法，两条路径各自只剩「调这两个 + 解析响应」：

- `private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown>` —— 含 thinking 分支与 tools 注入，那份长注释只留一份。`stream` 必须是真正的形参而非事后 merge：`stream_options` 只能在 `stream: true` 时出现，部分网关会拒绝非流式请求携带它。
- `private async postCompletions(body: unknown, signal: AbortSignal): Promise<Response>` —— 含请求头与 `!res.ok` 抛错。

顺手把 :348 的倍率提成具名常量 `STREAM_TIMEOUT_MULTIPLIER`。现有的取消与超时语义质量本身很高，不要动，只抽装配部分。

<a id="q-19"></a>

### Q-19 AI→状态 的写入链是两个无缝巨型函数：翻译层挤在 orchestrator 一个 560 行私有方法里，提交层是 30 分支手写 switch + 14 处非必要动态 import + 10 处 (char as any)

- **严重度**：中
- **主题**：AI 文本与引擎状态之间没有唯一的编解码缝
- **位置**：`src/sillytavern/agent-orchestrator.ts:765-1327`、`src/sillytavern/agent-orchestrator.ts:896-917`、`src/sillytavern/agent-orchestrator.test.ts:1247`、`src/sillytavern/state-manager.ts:264`、`src/sillytavern/state-manager.ts:271`、`src/sillytavern/state-manager.ts:1471`、`src/sillytavern/state-manager.ts:1508`
- **工作量**：M　**风险**：低
- **来源**：AGENT-01, CORE-09

**证据**

**翻译层（orchestrator）。** `private async processStageMarkers(stageIndex)` 从 765 行写到 1327 行，一个方法里塞了五件互不相干的事：(1) stage 归类；(2) `<json>` / `<status_effects>` 正则抠块；(3) M3/M4/M5 的全部翻译规则——`characters` 的 replace/delta/add/remove 四个 switch、`items` 的 consume/equip/unequip/transfer/modify 五个循环、`affections` 的 set/delta、`quests` 的 upsert/remove，纯 JSON→StatePatch 映射约 330 行；(4) 动态 `await import('./state-manager')` + `commitChatState` 落库；(5) marker 回调编排（896-917 的 position 偏移重算）。第 (3) 块本质是纯函数（输入 parsed 对象，输出 `StatePatch[]`）却没有函数边界，于是 `agent-orchestrator.test.ts` 里 `describe('Stage3 characters.add 解析')`(1247)、`describe('Stage3 affections 解析')`(1458)、`describe('Stage2 世界新闻 → add_news')`(1537) 都必须搭一整条 pipeline + mock client + mock StateManager，才能断言「AI 给 `path=equipment` 应该产一条 `add_item`」。

**提交层（state-manager）。** 14 处 `await import(...)`：`save-profile` 被动态 import 了 9 次（541/548/1166/1204/1222/1248/1283/1327/1403），另有 `affection-system`(1247)、`time-system`(1470)、`script-executor`(1508)、`database`(1471)。而 `save-profile.ts` 只 import `./types` 与 `./database`（第 8-9 行），不 import state-manager——不存在循环依赖，这 9 次动态 import 没有技术理由。最直接的证据是 1471 行：

```ts
const { getCharacters, saveCharacter } = await import('./database');
```

这两个符号在文件顶部 28/29 行已经静态 import 过，这行只是在函数作用域里把它们遮蔽一遍。同文件 `applyPatch`(264，switch 在 271) 是 30 个 case 的手写 switch，每个 case 都是同形的 `event = await this.applyXxx(patch); break;`；资源类 handler 靠 `(char as any)[resource]` / `(char as any)[maxField]` 逃逸类型（599/600/617/618/620/639/640/653/655/656 共 10 处），`maxField` 还要手工拼 `` `max${res.charAt(0).toUpperCase()}${res.slice(1)}` `` 再断言成 `'maxHp'|'maxMp'|'maxSp'`。

**影响**

AGENTS.md 把这层称作「M3 翻译层」并要求改动前查数据字典规范，但它没有一个可指向的文件——新人和 AI 都找不到那条缝。改一条 AI 输出契约（比如给 `items` 加一种 op）要在 1475 行文件的私有方法中间动刀，改完只能靠端到端 pipeline 测试验证。动态 import 让依赖图在静态分析里消失（打包器不能 tree-shake，读代码的人 grep import 找不到关系），并给每条 patch 的应用加一次 promise 微任务；`commitChatState` 对每条 patch 串行调用，一批 20 条 quest/affection patch 就是 20 次模块解析 + 20 次「读整份 profile → 改 → 写整份 profile」。`as any` 让「hp/maxHp 成对」这条不变式只靠人眼维护。

> 复核修正：原始发现称「新增一条翻译规则的测试成本是 40 行 mock pipeline」略有夸大——测试文件已有共享 helper `runVarsUpdateWithJson(...)`，Stage3 那批 describe 都走它，新增一条规则的测试是几行而非 40 行。1805 行测试文件的体量也不全是这一个方法的脚手架。

**重构建议**

两个独立 PR，都不改语义。

**PR 1（抽翻译层）：** 新建 `src/sillytavern/vars-update-translator.ts`，导出两个纯同步函数：

- `buildVarsUpdatePatches(parsed) → { patches, skipped }`
- `buildDispatcherPatches(parsed) → { patches, deltaTime }`（把现有文件级私有函数 `isWorldNewsPath` / `buildNewsPatches` 一起搬过去）

orchestrator 里只剩「抠 `<json>` → 调翻译函数 → `commitChatState` → `reportCommitResult`」四行，`processStageMarkers` 拆成 `handleStoryStage` / `handleDispatcherStage` / `handleVarsUpdateStage` 三个方法。**marker 的 position 偏移重算（896-917）必须留在 orchestrator**——它会 mutate `this.pendingCraftMarkers` 与 `this.context.agentOutputs`，所以 `buildDispatcherPatches` 只能覆盖 dispatcher stage 的 `<json>` 那一半。测试把 1247-1600 那批改成直接喂 parsed 对象断言 patch 数组，pipeline 只保留一条冒烟。该缝不违反 ADR-21：`commitChatState` 仍是唯一写入口，搬走的只是纯映射，反而让 ADR-21 更容易审计。

**PR 2（清提交层）：**

1. `save-profile` / `affection-system` / `time-system` 三个改成顶部静态 import，删掉 1471 行那句遮蔽；`script-executor` 是唯一可能有循环风险的，单独验证后再决定。
2. switch 换成模块级 `const PATCH_HANDLERS: Record<StatePatchOp, (sm: StateManager, p: StatePatch) => Promise<GameEvent>>`，`applyPatch` 退化成 `const h = PATCH_HANDLERS[patch.op]; if (!h) throw ...`。这是本 PR 价值最高的一项：`Record<StatePatchOp, ...>` 让「新增 op 忘记接线」变成编译错误，取代现在的 default throw。
3. 消 `as any`：定义 `const RESOURCE_FIELDS = { hp: 'maxHp', mp: 'maxMp', sp: 'maxSp' } as const satisfies Record<'hp'|'mp'|'sp', keyof CharacterState>`，`applySetResource`/`applyDeltaResource`/`applyUpdateCharacter` 的钳制段统一走它。**动手前先确认 `maxHp`/`maxMp`/`maxSp` 确实声明在 `CharacterState` 上**，否则 satisfies 子句编译不过，`as any` 只是换了个位置。
4. 顺带把变量类 5 个 handler（478/489/501/511/525）各抄一遍的 `patch.target.startsWith('variables.') ? patch.target.slice(10) : patch.target` 提成 `private varPath(target: string)`。
