# 直出模式

状态：2026-11-09 已实施于 `direct-generation-v1`。本地测试和建档界面已验证，尚未用真实付费模型验证叙事与规则遵循。

2026-11-10：`direct-generation-cache-v1` 增加[缓存优化直出](direct-generation-cache.md)。两种直出共用输出与状态契约，缓存版独立配置模型和预设，既有记忆与 Agent 流程保留。

2026-11-10 审查修复：两种直出的预设选择统一按「用户选择 → 对应模式的项目默认 → 内置预设」解析。前置记忆回溯返回实际错误时停止本次主生成；原有空召回结果仍可继续。建档说明补充各模式适用的计费方式，并修正模式选择的可访问标签和缓存渠道控件的布局。

## 使用

1. 在「设置 → API 配置」添加模型来源。
2. 在「Agent 配置 → 直出主生成」检查独立的 API 池、输出长度和预设。首次初始化从正文生成复制有效连接与参数，此后独立调整。默认预设为「直出 · 角色卡体验」；预设可导入 ST JSON，但不运行 ST 扩展脚本。
3. 新建存档，在准备页明确选择「Agent 模式」「直出（无缓存优化）」或「直出（缓存优化）」。初始为空，选择后才继续建档；确认页再次显示。创建后不可切换，模型和文风设置仍可调整。
4. 正常聊天。战斗和制作由同一主回复裁定并叙述，战斗可跨楼持续；角色、背包、资源、地图和任务继续使用 app 的原生界面。

📌 2026-11-17 更正（第 4 步，分支 `feat/direct-prose-combat`，未真机验证）：直出战斗默认改为**正文战斗**。新增全局设置 `directStructuredCombat`（默认关），在「Agent 配置 → 直出主生成」与「直出主生成（缓存优化）」两页的「战斗」卡里显示为开关「结构化战斗」，目前置灰不可点，提示「暂未开放」；代码路径保留在设置后面。关闭时战斗在正文里叙述，不再输出 `combat` 块，也不建立跨楼战斗记录；HP/MP/SP 走 `state.characters` 的 replace/delta，状态走 effects；临时敌人不入库，其状态留在正文与 action_info 里。制作不受影响。详见下文「正文战斗」。

无 `metadata.generationMode` 的旧存档按 Agent 运行。新档写入 `agent`、`direct` 或 `direct_cached`，备份、导入与快照保留模式；不提供旧档转换。

## 请求预算与体验边界

每次楼生成尝试至多一次非记忆请求，身份为 `direct_main`，不调用资料选择器或工具，不自动重试或修复主回复。无缓存优化模式不建立主生成 Delta 会话，供应商自动缓存不受此开关控制；缓存优化模式按[独立会话契约](direct-generation-cache.md)组装上下文。

记忆回溯、摘要、Story v2 缺摘要补建、归档与维护继续使用现有代码和各自配置，因此一楼总请求数可能超过两次。Agent 模式继续原有多 Agent 流程。

主 AI 一次输出正文、选项、角色档案／经历和结构化状态。代码检查格式、写入范围、引用、库存数量和战斗资源等，并将核心状态与来源消息一起提交；不会重新执行全部战斗／制作公式，也不保证模型算术正确。提供本地骰池供主 AI 使用。战斗终局只写回声明的资源与状态，不额外发放自动战斗经验或 FP。

📌 2026-11-17 补充（请求预算不变）：`directStructuredCombat` 关闭（当前唯一可用状态）时，上段「战斗资源」检查与「战斗终局」写回不再发生，战斗相关的数值变化全部走普通状态写入。请求数不变：仍是每次楼生成尝试至多一次非记忆主请求，正文战斗不另开请求。

📌 2026-11-20 被拒输出的调试记录保留模型原文与请求消息；多余字段报错列出键名与路径。分支 `fix/direct-rejected-output-observability`，校验宽严不变。模型已回复但 `parseDirectOutput` 拒绝（或供应商返回 error 结果）时，`generateDirectTurn` 抛 `DirectTurnError`（`direct-main.ts`）携带本次 `AgentResult`；`AgentOrchestrator.runDirect` 把它作为 `onAgentError` 第三参交给调试记录，再向下游抛原始错误（取消判定不变）。多余字段报 `<路径> 含未支持的字段：a、b`，最多列 5 个、单键超 24 字符截断，超出追加「等 N 个」；实体路径形如 `entities[0].output.character.skills`。`direct_updates` 不是合法 JSON 时也明确报出。

### 正文战斗（2026-11-17）

📌 2026-11-17 新增，分支 `feat/direct-prose-combat`，未真机验证。只作用于两种直出（`direct`、`direct_cached`）；Agent 模式的战斗沙盒不变。

- **设置**：`directStructuredCombat` 是全局设置（`UiSettings`，引擎经 `runtime/engine-settings.ts` 注入缝读取，缺省按关）。判定入口 `isDirectStructuredCombatEnabled()`（`src/core/combat/direct-combat.ts`）。界面开关目前锁定为关。
- **协议**：原 `DIRECT_PROTOCOL` 常量改为 `buildDirectProtocol(structuredCombat)`（`src/core/prompts/direct-prompt.ts`）。关闭时把战斗那一行换成正文战斗指令：战斗写进叙事、不输出战斗块，HP/MP/SP 用 `state.characters` 的 replace/delta，状态用 effects，临时敌人不入库、其状态由正文与 action_info 承载。`direct_state` 与缓存帧分区里去掉 `combat` 键。
- **解析**：`parseDirectOutput` 新增选项 `structuredCombat`。关闭时模型若仍输出战斗块，整块丢弃，草稿标记 `combatIgnored`，引擎日志记 warn `direct.combat_ignored`；本楼照常接纳，不算失败。
- **旧记录**：`readDirectCombat` 在关闭时返回 null，已存在的 `worldFlags.directCombat` 记录保持休眠、不删除；`commitDirectTurn` 收到的 combat 为 undefined 时原样保留它。`game-pipeline` 的 `acceptDirectTurn` 在关闭时跳过 `buildDirectCombat`。
- **后果**：
  - 缓存直出：静态前缀（协议文字）变了，每个 `direct_cached` 存档会冷建一次会话。
  - 战斗中途的存档升级后，HP/MP/SP 与状态回到开战前已存的值（战斗投影不再读）。
  - `isInCombat` 恒为 false，正文战斗期间随机事件与人设编辑锁不再拦截。
  - 以后重新开放开关时，休眠的旧记录会重新浮现；届时需要定一条过期处理规则。
  - 私有内容包的直出预设可能仍要求模型输出战斗块（会被丢弃并记 warn）；未用真实模型验证。

### 正文分节与逐节演出（2026-11-19）

📌 2026-11-19 新增，分支 `feat/interactive-progression`，未真机验证。只作用于两种直出；Agent 模式不变。设计见[交互式推进设计](../planning/2026-11-19-interactive-progression-design.md)。

- **协议**：`buildDirectProtocol` 两种战斗口径都带「正文分节」一行：模型在 `<maintext>` 内用独占一行的 `<beat/>` 切节，本楼经 entities 新建实体的人物在其首次现身那一节之前写 `<beat enter="人物名"/>`。正文战斗口径另加「战斗逐拍」：一名角色的一次行为单独成一节，`action_info` 前三行固定为 `|行动者|`、`|目标|`、`|行动|`。协议常驻，不随前端开关变化。
- **解析**：`src/core/story/story-beats.ts` 把标记从正文剥掉，节间以 `\n\n` 拼接，断点偏移与登场锚点存进 `ChatMessage.stage`。记忆、摘要、缓存会话、复制与润色读到的都是剥过标记的正文。没有标记时正文逐字节不变、不带 `stage`。`parseDirectOutput` 不校验标记，写错不拒楼。读取方经 `resolveBeatBreaks` 自校验，断点失效（例如润色后）就按段落切。
- **流式**：`game-pipeline` 的流式回调只在直出主笔给出第三参（断点、登场锚点、`</maintext>` 是否已到）。
- **前端**：全局设置 `stagedNarrative`（默认开）。只对本次会话新到的直出正文逐节放出，历史消息整段显示；行动选项等末节放完且回合已接纳后才出现。键位 Space / Enter 推进、按住 Ctrl 快进、End 全部显示、鼠标左键点正文推进；小条「全文」直接关闭该设置，重新开启在「设置 → 消息显示」。📌 2026-11-20：小条移到输入框正上方，可收起（设置 `stagedControlsCollapsed`）。
- **新角色登场**：名字不在本楼开始时的名册里才演，立绘走立牌链，没有素材只浮现名字题签。
- **战斗行为卡**：`action_info` 带 `|行动者|` 行时画成行为卡，否则沿用通用面板；与演出开关无关。卡里的数值是模型自述，不是权威值。
- **后果**：每个 `direct_cached` 存档冷建一次会话（协议文字变了）；每节独立跑美化，跨节的美化规则不再匹配；真实模型是否稳定输出标记与固定行未验证。

新角色复用原生实体组装与作者定义绑定；新装备先入背包，穿戴需明确声明。角色经历、地图旅程、时间与随机事件维护接回既有系统。动作面板只展示结果，不能代替结构化入库。

格式或核心写入失败时本楼不接纳，允许手动重试一次新的生成尝试；已接纳楼不能直接重放，需要先回退。接纳后的时间、剧情、经历、快照或记忆失败会警告，不会重复消耗材料或发奖励。

直出不启动旧战斗覆盖层、制作链、角色生成子调用、自动插画、润色链或 EJS 变量提交。主回复承担这些非记忆裁定职责；自动插画本版停用。普通音频标记与既有显示设置保留。

### 角色年龄（2026-11-20）

📌 2026-11-20 修正，未真机验证。`direct_state` 的角色快照（`generateDirectTurn` 的 `state.characters`）不再带 `ageAnchor` 原值与开局时冻结的 `customFields.age`，改为经 `projectCharacterAge`（`src/core/character/character-age.ts`）按当前游戏时间现算的 `age`；只有给定了生日才另带 `birthday: 'M月D日'`，兜底的 1 月 1 日不展示。协议加一句：`age` 与 `birthday` 由代码现算，只读，模型不必也不应写回。缓存直出的 `profile` 分区同口径，协议文字变了，已有 `direct_cached` 存档会冷建一次，见[缓存直出](direct-generation-cache.md)。

## 内容包

世界书沿用现有开关、条件、分区和依赖，只读取明确授权 `direct_main` 的条目。在世界书编辑器为相关规则、世界设定、种族、区域、产业等配置读取范围；不要直接把各 Agent 的旧输出模板全部合并进来，它们会与直出契约冲突。

2026-11-09 与 master 集成后，世界书引用统一使用完整命名空间 UID（例如 `fated:character/guide`），原生角色的旧资料关联也使用同一 UID。占位清单 1.3.0 纳入直出配置与角色分节。Discord 授权门同样适用于直出生成。

公开演示内容已配置。旧私有内容包若没有这项授权，不会自动获得直出读取权限；需要内容作者适配。原卡与 Prime 仅作结构参考，未复制其私有正文，原 ST 脚本及变量路径不适用于 app。

### 各模式的默认预设怎么声明（2026-11-14）

- 内容包在 `agentDefaults.agents.direct_main.presetId`（无缓存直出）与 `agentDefaults.agents.direct_cached.presetId`（缓存直出）里点名默认预设，预设本体随包放进 `presets`（或作为同一条目的 `preset` 内嵌）。没有声明、或点名的 id 在包里找不到时，回退到引擎内置的那份直出预设。
- story 的默认预设以 `agentDefaults.agents.story.presetId` 为准，**不是** `presets` 数组的第一项；只有它缺席时才取第一个 story 范围的内容预设。
- 玩家侧：设置里选择键为空即「跟随默认」。内容包自带直出默认时，引擎内置预设仍在「预设」下拉的「引擎内置」组里可选；内容包与引擎内置的预设都是只读的，改动会先复制成玩家预设。解析实现见 `src/core/prompts/preset-resolution.ts`。

📌 2026-11-17 补充：预设的 `scope` 从两值扩成四值（`src/core/types/types.ts` 的 `PresetScope`），判定唯一入口是 `presetScopeMatches`：

- 不写 `scope` = 所有生成方式可见；`story` = 仅剧情；`direct` = 两种直出都可见（旧含义不变，旧行无需迁移）；
- `direct_main` = 仅无缓存直出；`direct_cached` = 仅缓存直出。
- 内容包可以用后两者把直出预设钉在单一模式上，例如内容仓的 Prime 1.18 直出预设（`direct_main`，作 `direct_main` 的默认）与直出缓存预设（`direct_cached`，作 `direct_cached` 的默认）。`agentDefaults.agents.direct_cached` 只是设置档案，**不是**世界书 audiences 身份，读取权限仍按 `direct_main` 授予（见上文缓存直出说明）。
- 复制（「复制为我的预设」与写时复制）单一模式的预设时副本保留原 `scope`，其余情况取当前生成方式的 scope（`copyScopeFor`）；导入仍按当前生成方式取 `direct`（两种直出共用）。引擎内置直出预设保持 `direct`。
- 🔴 兼容性：旧版引擎不认识 `direct_main` / `direct_cached`，这类预设不会出现在下拉里（默认解析仍能命中）。用到这两个值的内容包需要包含此改动的引擎版本。

## 实现与验证

- `src/core/agents/direct-main.ts`：完整上下文、骰池、单请求。
- `src/core/agents/direct-output.ts`：原生输出校验与补丁转换。
- `src/core/combat/direct-combat.ts`：跨楼战斗投影与终局结算。
- `src/ui/lib/game-pipeline.ts`：独立分支及既有记忆调用。
- `src/core/state/state-manager.ts`：核心状态与消息原子接纳。
- 📌 2026-11-17：`src/core/prompts/direct-prompt.ts` 的 `buildDirectProtocol(structuredCombat)` 按设置生成协议；`direct-combat.ts` 的跨楼战斗只在 `directStructuredCombat` 开启时生效，见上文「正文战斗」。
- 📌 2026-11-19：`src/core/story/story-beats.ts` 正文分节；前端演出在 `src/ui/composables/useStagedPlayback.ts`、`src/ui/lib/stage-playback.ts`、`src/ui/lib/stage-entrance.ts` 与 `StagedNarrative.vue`，见上文「正文分节与逐节演出」。

运行：`npm run dev`。Windows 测试如遇临时目录 EPERM，可先将 `TEMP` 与 `TMP` 指向仓内 `node_modules/.cache/vitest-tmp`。

```powershell
npm run typecheck
npm run typecheck:vue
npm run typecheck:tools
npm run test:run
npm run build
npm run lint
npm run format:check
npm run knip:ratchet
```

重点回归覆盖单次请求、旧档默认 Agent、显式建档选择、非法输出无写入、库存事务回滚、已接纳楼防重放、战斗跨楼与精确终局、定义绑定、备份／快照和后续维护失败。2026-11-09 推送后补测：旧记忆召回和摘要落库、三楼制作与战斗状态衔接、真实客户端 SSE 分片解析、HTTP 503／断流零自动重试，以及每轮发送完整上下文。干净副本的 knip 棘轮通过，未新增死代码。自动化使用模拟模型；真实模型的输出稳定性、原卡体验和成本需另行实测。

设计契约见 [直出 v1 设计](../planning/2026-11-09-direct-generation-v1-design.md)。
