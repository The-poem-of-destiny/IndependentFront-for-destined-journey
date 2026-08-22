# LLM 组装层 Delta 分层架构 —— 讨论整理与初稿

> **状态**：⏳ 初稿 / 讨论成果整理（2026-08-22）
> **用途**：作为更强模型进行正式设计的**输入材料**。本文件客观记录讨论中确认的决策、
> 摸底数据与遗留问题，正式设计文档应在本文件基础上产出并落回 `docs/planning/`。
> 本文件不是最终设计，可能存在需要推翻的点，正式设计时逐条复核。

## 1. 背景与目标

当前 LLM 组装层（`src/sillytavern/agent-templates.ts` 的 `buildAgentMessages`）为每个
Agent 组装**一条 system 消息**，把世界书、角色状态、对话历史、时间地点、玩家输入全部
拼进这一条文本。每轮全量重拼。

**硬指标**：每轮总未命中（uncacheable，DeepSeek `usage.prompt_cache_miss_tokens` 口径）
**大于 3 万字（≈3 万 token）就"玩不起"**。当前已超标。

**目标**：将组装层重构为"分层 delta"架构，把每轮真正要重新计算的（miss）token 压进
3 万字以内，并支持更多轮次（当前 story 单轮 ~195k token，400k 上下文撑不了 2 轮）。

## 2. 现状摸底（真实导出数据分析）

数据来源：`tests/realtime_export/fated-poem-debug-7c342726-1787405*.json`（2026-08-22
三个**真相邻轮**，同会话连续导出，messages 44 → 46 → 49）。

### 2.1 KVCache 机制前提

- DeepSeek 缓存 = **前缀精确匹配**。miss = 从第一个变化 token 到 prompt 末尾的整段。
- 因此"变量中段变化"会把**后面所有没变的内容**（含旧历史）卷进 miss —— 这是
  "变量破坏缓存"的确切机制。
- 固定前缀（世界信息/系统提示词）命中不花钱，**成本只看 miss**，prompt 总量大不是问题。

### 2.2 三轮 API 权威数据（常驻 6 agent：plot_pre_check/story/request_dispatcher/memory_summary/vars_update/plot_post_check）

| agent              | 21:24 冷轮 (hit/miss) |       21:29 热轮 |      21:42 热轮 |
| ------------------ | --------------------: | ---------------: | --------------: |
| story              |           0 / 185,092 | 169,472 / 15,977 | 175,232 / 8,709 |
| request_dispatcher |            0 / 37,133 |  26,752 / 10,429 |  32,512 / 4,714 |
| vars_update        |            0 / 62,588 |  47,360 / 16,350 |  53,120 / 9,007 |
| memory_summary     |            0 / 14,846 |   2,176 / 12,095 |   7,936 / 6,389 |
| plot_post_check    |            0 / 17,879 |   4,736 / 12,304 |  10,496 / 6,056 |
| plot_pre_check     |            0 / 10,979 |    2,048 / 9,048 |     10,880 / 50 |
| **常驻合计 miss**  |           **328,517** |       **76,203** |      **34,925** |

- 冷轮（21:24）全 miss：328,517。缓存预热后收敛到 34,925（最热轮），**仍超 3 万**。
- plot_pre_check 在最热轮已近全命中（miss 仅 50）。

### 2.3 内容真新增（shingling 内容指纹法，K=64，不受长度变化/位移影响）

|                    | 1→2 (21:24→21:29) | 2→3 (21:29→21:42) |
| ------------------ | ----------------: | ----------------: |
| 常驻合计内容真新增 |       20,118 字符 |       14,541 字符 |
| 对应 API miss      |            76,203 |            34,925 |
| delta 后理论 miss  |          ≈ 20,118 |          ≈ 14,541 |

- **内容真新增稳定在 1.5~2 万字符/轮**（与缓存冷热无关，是内容层固有变化量）。
- **delta 后理论 miss 两对都 < 3 万** → delta 架构可行，能把最热轮 34,925 压到 ~14,541（省 58%）。
- 各 agent 真新增（2→3）：story 1,798 / request_dispatcher 2,346 / vars_update 3,313 /
  memory_summary 2,286 / plot_post_check 3,579 / plot_pre_check 1,219。
- **story 每轮真新增仅 ~1,800 字符**，其 8,709 miss 中约 79% 是"位置伪 miss"
  （中段状态/动态块变化把后面旧历史卷进 miss）→ 正是 delta + 尾部化能救的部分。

### 2.4 侧链（未计入上述常驻合计）

- char_gen：miss 9,448 / 轮（文件1、3 有，文件2 无——不每轮跑）。prompt 常达 26 万字符
  （全量角色状态快照）。
- item_gen：miss 10,552 / 轮。
- 战斗轮（8/12 数据）：combat_v3 会话内连续调用，偶发大 miss（如 combat_v3#3 一次 20,887，
  敌方入场 system 整体变化）。

## 3. 已确认的设计决策（讨论成果）

1. **消息形态 = A 方案：多轮 messages 数组**，不是单条 system 拼接。
   ```
   messages = [ system(储存层/基线，永远不动)
              , user1, assistant1, ...   ← 对话自然追加（历史零 delta，前缀天然命中）
              , delta块（每轮追加的世界状态变化）
              ]
   ```
2. **对话历史不做 delta**：多轮形式下旧历史在前缀里自然命中，只新增对话是 miss。
   用户判断"输出会进 KVCache，不需要历史 delta"成立。
3. **只给非战斗 agent 用**：combat_v3 排除（chatWithTools 持久会话 + 战斗状态引擎侧持有，
   不需要这套）。
4. **框架统一，注入量按 agent 调**：统一 delta 消息层，但"保留多少历史/参考"是 per-agent
   旋钮（类似现有 historyLayers）。
5. **侧链**：item_gen 保留最近 1~2 轮生成结果做参考（few-shot，格式/数值平衡更好）；
   char_gen 不保留（每个 NPC 独立，参考只会同质化，且状态快照走储存层）。craft_gen /
   image_prompt 参考价值低，按需给 0。防"参考污染"：systemPrompt 里钉"参考格式与平衡，
   内容基于当前请求"。
6. **delta 累积式（持续对话层）**：第 N 轮 = 基线 + delta1 + delta2 + ... + deltaN。
   缓存友好（delta1 稳定命中），AI 能看到变化轨迹。到达上下文上限 → 清空累积，回到基线。
7. **用户有每轮固定注入末尾的提示词需求** → 需开口（见问题 4）。

## 4. 最初设计草案（供正式设计复核）

### 4.1 分层结构

- **第一层 储存层（基线）**：不重复、可直接注入第一轮的静态/慢变内容 —— 世界书、
  角色慢变字段（身份/背景/外貌/性格/血脉/技能全量/装备全量）、systemPrompt。
- **第二层 持续对话层（delta 累积）**：保留上一轮全部内容，只在末尾追加变化。
  对话历史自然追加（作为 user/assistant 消息），世界状态变化以 delta 块追加。
- 到达限制（token 估算，如 400k/500k 模型上限）→ 清空 delta 累积，持续层 = 基线。

### 4.2 delta 协议（变量范式）方向

- **最小单位** = 现有 `StatePatch` 的"单条 op + target 路径 + value"（`types.ts:1916` 已有
  完整 op 集 + 路径寻址 `characters.妲丽安` / `affections.妲丽安` / `variables.sys.金钱`）。
  两档：标量字段级（整条替换）与集合元素级（技能/装备/状态效果**整元素**增删改，不细分
  元素内部字段）。
- **索引**：块索引（递增 `#N` + 游戏内时间戳）+ 条目路径（`对象.字段` / `对象[元素].字段`）
  - **覆盖规则声明**（"同路径以编号最大的块为准；未出现的路径以储存层基线为准"）——
    让 AI 正确合并"基线 + 累积 delta"。
- **进 delta（高频变）**：角色资源 hp/mp/sp、好感度、心里话、状态效果、位置/在场、时间、
  高频全局变量（金钱/进度）、剧情事件状态流转。
- **留储存层（慢变）**：身份/背景/外貌/性格/血脉/技能全量/装备全量/世界书。

### 4.3 实现方向

- 引擎维护 **per-saveId 持续层**（内存）：初始=基线，每轮读当前全量状态 → 与"上一轮
  快照"diff → 产出 delta 块（带 #N + 时间戳）→ 渲染成文本追加 → 更新快照 → 达上限重置。
- diff 规则：标量 `!==` → delta；数组按元素 key（名字）diff → add/remove/update。
- **渲染层走占位符/模板系统**（`{{STATE_DELTA}}` 注入），机制在代码、措辞可配。

## 5. 待解决的 6 个问题（讨论原题 + 初步思考）

> 以下是设计发起者提出的 6 个核心问题，正式设计必须逐条给出定案。

### Q1. delta 的最小单位是什么？

初步：StatePatch 单条（标量字段级 / 集合元素级）。需复核：元素内部字段（如技能描述）
变了是否整元素重发；数组顺序敏感度；每个状态类的"AI 能理解的最小 block"定义。

### Q2. 注入的索引怎么写？

初步：块 #N + 游戏内时间戳 + 路径条目 + 覆盖规则声明。需复核：编号是否每轮一个块、
时间戳用什么格式、AI 理解"基线 + delta = 当前"的认知负担如何缓解。

### Q3. 要给多少个变量写这套 delta？每个的索引分别怎么写？

初步：不逐个变量，而是**每类状态一个模板**（schema 声明式）。清单（高频变 vs 慢变）见
§4.2。需复核：清单是否完备、有没有遗漏的高频变字段、各类的索引格式统一还是各异。

### Q4. 每轮固定注入末尾的用户自定义提示词，怎么开口？

初步：per-agent 配置 `tailPrompt`，作为消息数组最后一条渲染（`{{TAIL_PROMPT}}`）。
需复核：与预设/占位符系统的关系、多个开口的优先级、缓存影响。

### Q5. 要不要做成像提示词/占位符那样高度可自定义？

初步：**分两层**——机制层（diff/索引/累积/重置）代码不可配；措辞层（delta 块怎么渲染）
走模板/占位符可配。需复核：可配边界划在哪、避免变成"第二个模板系统"。

### Q6. delta 具体怎么实现？要不要写一套"变量范式"（schema）？

初步：需要一套 delta 协议（最小单位 + 索引格式 + diff 规则 + 渲染模板），基于现有
`StatePatch` + `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`
定义，不另起炉灶。需复核：schema 放哪、声明式还是代码生成、如何与现有 StatePatch/
vars_update 翻译层衔接。

## 6. 其他待决策点

- **重置判据**：到达模型注意力上限（~400k/500k？）触发。用户原话"10 轮感觉有点少，不好说，
  后面再决定"。
- **侧链 2 万 miss**：delta 对侧链（char_gen/item_gen 真生成新内容）帮助有限，需另想办法
  （summon-pool 预生成池复用、状态快照瘦身）。
- **delta 块位置**：紧跟对应轮次之后，还是统一放最末尾（注意力集中在最新）？"顺序稳定"
  是铁律。
- **持久化**：想法.txt 讨论结论"持续层不持久化，只影响启动后第一轮，缓存会过期"。
- **硬指标口径**：3 万字是否只算常驻 6 agent？含侧链的峰值轮会超（14,541 + ~20,000 ≈ 3.4 万）。
- **哪些 agent 是"常驻"**：plot_pre_check / story / request_dispatcher / memory_summary /
  vars_update / plot_post_check 每轮都跑；char_gen / item_gen / craft_gen / image_prompt /
  combat_v3 是侧链/会话式。

## 7. 相关现状代码索引（正式设计前必读）

- `src/sillytavern/agent-templates.ts` — `buildAgentMessages(Async)` 现组装入口
- `src/sillytavern/agent-client.ts` — AgentClient（chat/chatStream/chatWithTools + 缓存字段）
- `src/sillytavern/agent-orchestrator.ts` — DAG 编排（每 agent 调 buildAgentMessagesAsync）
- `src/sillytavern/types.ts` — `StatePatch`(1916) / `CharacterState`(1029)
- `src/sillytavern/vars-update-translator.ts` — AI JSON → StatePatch 翻译层（delta 落库侧）
- `src/sillytavern/placeholder-registry.ts` / `template-resolver.ts` — 占位符系统
- `src/sillytavern/preset-loader.ts` / `worldbook-loader.ts` — 预设与世界书装载
- `src/ui/lib/game-pipeline.ts` — buildContext（AgentContext 组装）/ emitMessage（消息落库）
- `src/ui/stores/game-store.ts` — addMessage / persistMessage（Dexie messages 表）
- `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md` — 数据字段规范
