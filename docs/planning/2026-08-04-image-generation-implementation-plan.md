# 图像生成 v1 实施计划（lean-delegation 编排）

> 配套设计：`docs/planning/2026-08-04-image-generation-design.md`（v1.1，D1–D55）
> 日期：2026-08-04 · 状态：**已执行完毕**（代码层全绿，真机走查未做）
> 编排方式：**lean-delegation** —— 主会话只做规划与验收，全部实现交给子 agent。

---

## 0.0 实际执行情况（回填，2026-08-04）

**本节以下的计划正文一字未改，保留成当初的样子** —— 下面记的是实际怎么跑的，以及每一处偏差为什么值得。
下次照这份计划编排类似规模的工作时，先读这一节。

### 结果

**7 波 22 个任务**（计划是 6 波 19 个 + 1 个延后）。代码层 `npm run typecheck` 与全量测试全绿；
真机走查（L）与 T20（正式撰写 `image_prompt` 的 systemPrompt）仍未做，后者仍带 TODO。
提交落在分支 `txt-2-img-v1` 上，共 7 个提交，按波次切。

### 与原计划的五处偏差

1. **T7 从波 2 挪到波 3。** 原计划让 T4 与 T7 在同一波里各写一份 `normalizeTagString`，
   §4 的风险表已经预见到这一点，兜底方案是「T7 自己实现一份，波次收尾时主会话决定合并」——
   那是**自找的冲突**，而且合并的判断成本比推迟一波高。挪一波之后 T4 的导出成为唯一一份，
   T7 直接 `import`，风险表那一行自动作废。
   **教训**：两个并行任务共用一个还不存在的纯函数时，不要靠「事后合并」兜，让它们错一波。

2. **波 3 的 T7 / T11 / T12 提前与波 2 的 T3 一起起跑。** 波的边界是**依赖**不是仪式：
   这三个的前置（T1 的类型面）在波 1 就已经交付，它们并不需要等波 2 那 7 个全部收完。
   实际是 T3 一落地就把它们放出去。
   **教训**：波次表画的是依赖偏序，不是同步栅栏。谁的依赖满足了谁就起跑。

3. **T18 / T19 / T21 合成波 6，且 T19 吞并了三件事。** 原计划 T19 只做右键菜单，
   但「ChatFlow 把 `imageBlurByDefault` 传下去」「右键菜单加配图项」「D24 的手动确认流」
   三件事**都要改 `SceneImageSegment.vue` 与 `ChatFlow.vue`**，拆成三个并行任务就是三方写冲突。
   **教训**：并行的切分依据是**文件重叠**，不是功能编号。功能上正交、文件上重叠的任务，合并比协调便宜。

4. **新增 T21（用量与清理）。** 原计划把它算在 T15（图像分区）里，实施时挪进了**存档数据分区**：
   用量是**每存档**的数字，图像分区却是全局设置；而「清理」与那个分区里其余的清除动作是同一类事。
   于是它变成一个独立任务（改的是 `DataSection.vue`，与 T15 零重叠）。

5. **新增 T22（`done` 态交互）。** 原计划的 T13 只写到「五种态各自长什么样」，
   而 `done` 那一格之内还有打码揭示、take 切换、放大、悬停菜单四件事没人认领。
   T22 是补这个缺口时才发现的 —— 顺带逮到 `blurByDefault` 声明了但没人传（见下）。

### 三条值得记下来的发现

1. 🔴 **T18 的目标字段是错的。** 那句给 story 的指令**不能**写进 `agents.story.systemPrompt`：
   story 有预设短路（`assemblePresetContent` 拿到内容就不看 systemPrompt），写进去要么永不生效、
   要么在没预设时**顶掉整份** `fixedSystem + fixedExamples`。真源是**预设条目**，
   且条目按自身 `enabled` 过滤、**不读 `prompt_order`**。设计 §8.5 已补一节记这件事。

2. 🔴 **`blurByDefault` 声明了但没人传**，D46 打码整个是死的。它有单组件测试而且全绿——
   **那种测试能证明逻辑对，证明不了有人供值**。已补从 `ChatFlow` 真渲染到底的链路测试。
   凡是「一个 prop 从顶层穿三层传下来」的功能，单组件测试都不足以说它接上了。

3. `data/defaults/agent-config.json` 里有 **47 个 U+FFFD 坏字符**（16 段 / 6 个 agent），
   其中一处落在闭合 XML 标签的标签名里。**既有问题，本轮未修**，已另开任务。

### 编排本身的复盘

§0.1 那三条铁律都成立且值得保留。真正省下成本的是 §0.3 的围栏那一句
「不要顺手重构、把发现的问题写进报告里」—— 上面三条发现全部是从各 agent 报告的最后一行捞出来的。

---

## 0. 这份文件是什么

设计文档 §15 给的是**阶段依赖表**（A→B→C…）。这份文件把它翻译成**可直接派发的 agent 任务**：分几波、每波谁跟谁并行、每个 agent 的完整 brief、每波之间主会话做什么。

**照着往下读就能开工，不需要再回去读设计文档的全部** —— 但每个 agent 的 brief 里都写明了它自己该读设计文档的哪几节。

### 0.1 三条编排铁律

1. **主会话不读实现文件、不写代码、不跑测试套件。** 要看代码就派 scout，要验收就派 verifier。主会话读进来的每一个 token 都会在之后每一轮被重新计费。
2. **所有 agent 一律 `model: opus` + medium reasoning effort。** 高 effort 不会让实现更对，写清楚的 brief 才会。
3. **agent 不再派 agent。** 只有一层：主会话 → agent。每个 brief 里都要写这句。

### 0.2 每个 agent 的报告格式（所有 brief 共用，逐字带上）

```
用不超过 15 行汇报：
- 改了什么：文件路径 + 一句话说明（不要贴代码、不要贴 diff、不要贴文件内容）
- 验证：跑的确切命令 + 结果（过/不过；不过就只给失败的用例名和一句话原因）
- 阻塞项、以及顺手发现但没动的问题：各一行
做不完就直说，并写下你已经查明的东西，好让下一次从热的状态开始。
```

### 0.3 每个 brief 都要有的围栏（逐字带上）

```
- 只做本任务范围内的事。不要顺手重构、不要修你注意到的无关问题 —— 把它们写进报告里。
- 自己用工具直接做，不要派生子 agent。
- 本仓 CLAUDE.md / AGENTS.md 的规矩仍然生效：新模块必须配 *.test.ts；
  类型只从 types.ts / types-image.ts 来；Dexie 操作一律 await。
- 改完自己跑验证命令，不要把「我觉得应该没问题」当验证。
```

### 0.4 全局验证命令

| 场景               | 命令                                     |
| ------------------ | ---------------------------------------- |
| 单模块             | `npm test -- --run <测试文件路径>`       |
| 类型               | `npm run typecheck`                      |
| 波次收尾（全量）   | `npm run typecheck && npm test -- --run` |
| 文档改动后（必须） | `npx prettier --write <改过的每个 .md>`  |

🔴 **不要跑仓库级 `npm run format`** —— Windows 上 `core.autocrlf` 会把约 520 个文件重写成 LF（AGENTS.md 已记）。

---

## 1. 波次总览

```
波 1  ┌ T1  A   types-image.ts + image-defaults.ts
      └ T2  I0  AgentConfigPanel 抽壳                        ← 与图像功能无关，纯前置重构
        │
波 2  ├ T3  C   marker-protocol：MARKER_SPECS + sanitizeCaption
      ├ T4  B2  image-prompt.ts（承重）
      ├ T5  B3  image-quota.ts
      ├ T6  B4  image-providers/novelai.ts
      ├ T7  B5  image-prompt-agent.ts 纯函数半边
      ├ T8  B6  image-world-tags.ts
      └ T9  B7  image-anlas.ts                               ← 7 个并行，零文件重叠
        │
波 3  ├ T10 B1  image-segments.ts                            ← 依赖 T3 的 MARKER_SPECS
      ├ T11 D   Dexie v17 + scene-image-store + image-preset-store
      └ T12 E   server/routes/image.ts + image-client.ts
        │
波 4  ├ T13 F   BeautifiedNarrative 改造 + SceneImageSegment
      ├ T14 G   image_prompt 进 agent-config + 侧链接线（临时 prompt）
      ├ T15 I   第 13 分区 settings/image/ 三张卡
      └ T16 J   CG 图鉴
        │
波 5  └ T17 H   GamePipeline.onSceneImage 接线                ← 集成拱心石，独占一波
        │
波 6  ├ T18 K   story systemPrompt 加那一句话
      └ T19 M   ChatFlow 右键「为这一段配图」
        │
波 7  └ 主人真机走查 + §6.3 三点 curl（L）—— 不是 agent 任务
        │
延后  └ T20 N   ✍️ 正式撰写 image_prompt 的 systemPrompt（D55）
```

**19 个 agent 任务 + 1 个延后任务。** 最宽的一波是 7 个并行。

### 1.1 为什么这么分波

- **波 2 的 7 个模块彼此零依赖、零文件重叠** —— 设计文档 §5 已经把每个的契约与不变式写死了，这是本计划能大幅并行的唯一原因。
- **T3（C）排在 T10（B1）前面**：`splitSceneImageSegments` 要调 `scanByTag(text, 'scene_image')`，而那个标签得先在 `MARKER_SPECS` 里注册过（设计文档 §5.1 明令**不许写第二个解析器**）。
- **T17（H）独占一波**：它是把标记扫描、限额、侧链、出图、落库串起来的地方，且要保证 D32（限额在侧链之前）的排序。前面任何一个契约没对，都在这里暴露 —— 让它单独跑，报告才好读。
- **T19（M）不与 T17 同波**：两者都可能碰 `scene-image-store` 的 `generate()` 入口，并行有写冲突风险。

### 1.2 主会话在每波之间做什么

1. 读各 agent 的 ≤15 行报告
2. 有人报告做不完 → **不要自己接手**，把它学到的东西附上，重新 brief（能续同一个 agent 就续，它还带着上下文）
3. 波次收尾跑一次全量验证（派一个 verifier agent 跑，不要在主会话跑）
4. 决定下一波是否照原计划派发

---

## 2. 逐任务 brief

> 下面每个 brief 都是**可直接粘贴**的。用的时候把 §0.2 的报告格式与 §0.3 的围栏附在末尾。
> 每个 brief 都已经写明「读设计文档的哪几节」—— agent 自己去读，主会话不代读。

### 波 1

#### T1 — `types-image.ts` + `image-defaults.ts`（阶段 A）

```
目标：建立图像生成子系统的全部类型定义与常量，后续 7 个纯函数模块都从这里取类型。

要读：docs/planning/2026-08-04-image-generation-design.md 的 §4（类型定义，逐字照抄它给的
      接口与注释）与 §6.2（画质后缀表）。另外读 src/sillytavern/marker-protocol.ts 里
      DetectedMarker 联合的现有形状，SceneImageMarker 要能加进去。

产出：
- src/sillytavern/types-image.ts —— §4 的全部类型。**注释一并照抄**，那些 🔴 标记记录的是
  踩过的坑，不是装饰。
- src/sillytavern/image-defaults.ts —— 画质后缀（按 §6.2 那张表，默认取 V4.5 Full 那一行）、
  固定构图词、基础负向、限额默认值（每消息 2 / 每小时 20）。
- 把 SceneImageMarker 加进 marker-protocol.ts 的 DetectedMarker 联合（**只加联合成员，
  MARKER_SPECS 那一行不是本任务的事**，另有人做）。

🔴 关键点：
- 画质后缀的默认值**绝不能含 rating:general**（§6.2 讲了为什么：那是 Curated 模型的规范
  后缀，本项目要支持露骨内容，带上它等于每张图都在跟自己的提示词打架）。为这条写一个断言。
- SceneImageStatus 是四个值 queued/generating/done/failed，不是三个（D35）。
- ImagePreset 的主键是 `${kind}:${name}`，name 保原样（D40）。

验证：npm run typecheck
```

#### T2 — `AgentConfigPanel` 抽壳（阶段 I0，D54）

```
目标：把 AgentSection.vue 里「两个草稿 + 三个动作 + 两张卡」的壳抽成可复用的
      AgentConfigPanel.vue，让图像分区之后能传一个不同的 agentId 复用它。
      **本任务与图像功能无关，是纯前置重构** —— 做完既有 11 个 Agent 页必须行为不变。

要读：src/ui/components/settings/agent/AgentSection.vue（现状）、AgentParamsCard.vue、
      AgentPromptCard.vue（看它俩的 props 与 defineModel）。
      AGENTS.md 里 settings/agent/ 那一段的注释。

产出：
- src/ui/components/settings/agent/AgentConfigPanel.vue —— 收 agentId prop，内部持有
  promptDraft / templateDraft 两个草稿，提供保存 / 恢复默认 / 存为项目默认三个动作，
  渲染 AgentParamsCard + AgentPromptCard。
- AgentSection.vue 改为渲染 AgentConfigPanel，自己只留分区壳（页头等）。

🔴 关键点（AGENTS.md 已记，抽壳时极易丢）：
- 草稿载入必须 watch(..., { immediate: true })。主导航每次点击都把 activeAgent 置 null，
  宿主组件永远是新挂载，普通 watch 不触发 → 文本框空着渲染 → 用户一点「保存设置」
  就把空串写进了自己的用户提示词。**抽壳之后这个 watch 必须在 AgentConfigPanel 里**。
- AgentSection 必须保持**单根**（section.centered），否则宽屏下分区会摊满整行。
- agent-chrome.css 里的 @keyframes 必须与用它的规则待在同一组件里 —— Vue 的 scoped
  编译器按组件 hash 重命名关键帧，分家动画就停了。

验证：npm run typecheck && npm test -- --run
      并说明你怎么确认既有 Agent 页没坏（至少人工核对：切两个不同 agent，
      systemPrompt 文本框有内容、不是空的）。
```

### 波 2 —— 7 个并行，零文件重叠

#### T3 — `MARKER_SPECS` + `sanitizeCaption`（阶段 C）

```
目标：让 <scene_image> 成为引擎认识的标记。

要读：设计文档 §3（标记协议）、§3.1（MARKER_SPECS 增量）、§3.2（sanitizeCaption 规格）、
      §3.4（漏写闭合标签的兜底）。src/sillytavern/marker-protocol.ts 现有的
      MARKER_SPECS 与 scanPlayAudioMarkers（后者是三种写法兜底的先例）。

产出：MARKER_SPECS 加 scene_image 一行 + sanitizeCaption 纯函数 + marker-protocol.test.ts 增量。

🔴 关键点：
- Q-05：加标记**只动 MARKER_SPECS** —— 扫描器、MARKER_TAGS、scanMarkers 全由那张表推导，
  别去手改它们。
- 标记正文（那句中文）**不过 normalizeTagString**。全角标点在中文句子里是对的，
  归一化会把它改坏（§3.1 的警告）。
- 自闭合 <scene_image ... /> = 没有正文 = 没说要画什么 → 当无效标记剥掉，不建记录。
- 🔴 绝不因为 title 畸形就拒绝整个标记 —— 那会把一次装饰性失误升级成一张画不出来的图。
  title 含引号 / 超长 / 缺省，一律只收敛不拒绝。

验证：npm test -- --run src/sillytavern/marker-protocol.test.ts
```

#### T4 — `image-prompt.ts`（阶段 B2，**承重模块**）

```
目标：把「danbooru 场景串 + 角色/地点预设 + 世界状态」装配成 ComposedPrompt。
      这是整个子系统最承重的纯函数，测试要求最细。

要读：设计文档 §5.2 全节（签名、拼接顺序、全部不变式）、§3.2b（normalizeTagString 规格）、
      §6.2 的多角色官方规则那张表。

产出：src/sillytavern/image-prompt.ts（composePrompt + normalizeTagString）+ image-prompt.test.ts。

🔴 不变式（每一条都要有对应测试）：
- 角色预设**绝不拼进 base**，分别进 characters[]；角色的 negative 进**该角色的槽**，
  不并入 baseNegative（官方文档确认多角色会串味，解法就是逐角色 UC）。
- 地点预设进 base（它描述场景不是人）；查不到**静默跳过、不产 warning**。
- 查不到角色预设 → 跳过该角色 + 产 missing-preset 告警，**不报错**。
- 超过 6 个角色 → 截断 + 产 characters-truncated 告警，**不静默丢**。
- rating 钳到 opts.maxRating，**静默钳、不产 warning**（D38）。
- 拼接顺序：场景 → 地点 → 世界状态 → 构图 → rating → 画质后缀（**后缀在末尾**）。
- 权重语法 {{}} / [[]] / -0.8::x:: / <lora:...> **原样透传，一个字符都不改**。
- normalizeTagString 只动标点：全角逗号/顿号/全角分号 → ASCII 逗号；《》→ <>；
  换行与 <br> → ", "；折叠连续逗号与空白。
- 本函数**不产随机、不读时钟、不做任何 I/O**。worldTags 是调用方算好传进来的字符串。

验证：npm test -- --run src/sillytavern/image-prompt.test.ts
```

#### T5 — `image-quota.ts`（阶段 B3）

```
目标：三层限额的**唯一**判定处。自动档与手动档共用它。

要读：设计文档 §5.3 全节（含那张三层表与不变式）、D21–D24。

产出：src/sillytavern/image-quota.ts（checkQuota）+ image-quota.test.ts。

🔴 不变式：
- 三层互相独立，任一不满足即拒：L1 每消息上限（默认 2）· L2 滚动一小时窗（默认 20）
  · L3 同回合去重。
- **L3 只对 source==='auto' 生效** —— 玩家想为同一段剧情多画几张是他的钱、他的选择。
- L1/L2 两种 source 都计（一个 UI bug 造成的连点也该被拦）。
- 记录集合**含 queued/generating/failed** —— 在飞的也要计入，否则连点能绕过限额。
- now 从参数进，**不碰 Date.now()**。
- 返回的 message 是**可读中文**，会直接出现在按钮 tooltip 上，不是错误码。
- **手动永不被判成不可用**，最多是「要确认」——为这条单独写测试。

验证：npm test -- --run src/sillytavern/image-quota.test.ts
```

#### T6 — `image-providers/novelai.ts`（阶段 B4）

```
目标：把 ComposedPrompt 变成 NAI V4.5 请求体，以及解它返回的 zip。

要读：设计文档 §5.4（签名与不变式）、§6.1（**真实录制的请求体全文**，照它写）、
      §6.2（ucPreset 按模型各自编号的警告）。

产出：src/sillytavern/image-providers/novelai.ts（buildNaiRequest + parseNaiZip）
      + novelai.test.ts。

🔴 三重冗余是本任务的全部要害：
  V4 的同一份内容要展开到**三处**，字段名还各不相同 ——
    prompt.base         → body.input
                        → parameters.v4_prompt.caption.base_caption           （逐字相同）
    prompt.baseNegative → parameters.negative_prompt
                        → parameters.v4_negative_prompt.caption.base_caption  （逐字相同）
    prompt.characters[i]→ parameters.characterPrompts[i]  {prompt, uc, center, enabled}
                        → v4_prompt.caption.char_captions[i]                  {char_caption, centers}
                        → v4_negative_prompt.caption.char_captions[i]         {char_caption, centers}
  **只填一处不会报错，只会静默产出不对的图。** 所以必须由单一中间结构一次性展开，
  测试要断言「三处一致 + 顺序一致」。
- 0 角色时两个数组都传 []（v4_* 信封是 V4 分支的固定结构，多角色关闭时同样发送）。
- 恒 n_samples: 1（D9）。
- 本函数**不产随机** —— seed 缺省时由调用方给。
- parseNaiZip：content-type 不含 zip → bad-response；zip 解出 0 张图 → bad-response。
  解 zip 用仓库已有的 fflate。

验证：npm test -- --run src/sillytavern/image-providers/novelai.test.ts
      zip 测试如果手头没有真 NAI 响应样本，就用 fflate 自己压一个当 fixture，
      并在报告里说明这一点。
```

#### T7 — `image-prompt-agent.ts` 的纯函数半边（阶段 B5）

```
目标：侧链 agent 的**输入装配**与**输出抽取**两个纯函数。
      🔴 本任务**不接网络、不调 agent** —— 那半边是 T14 的事。

要读：设计文档 §8.5（侧链规格）、§4 里 ImagePromptRequest 与 ImagePromptOutput 的定义。

产出：src/sillytavern/image-prompt-agent.ts，导出 buildImagePromptInput 与
      parseImagePromptOutput 两个纯函数（中间那次 callAgent 留空/留接口给 T14）
      + image-prompt-agent.test.ts。

🔴 关键点：
- 输出是三个 XML 标签：<image_prompt> / <image_negative> / <image_desc>。
- **模型爱在答案前面写一段废话**（"好的，我来把这个场景转换成标签："）—— 抽取必须能
  越过它。本仓 story-rescue.ts 处理的是同一类缺陷，去看它怎么做的。
- 🔴 抽不到 <image_prompt> 就是**明确失败**（errorKind: 'prompt-agent'），
  **不要猜、不要用启发式兜一个出来**。为这条写测试。
- 抽出来的 scenePrompt 要过 normalizeTagString（T4 会导出它；如果 T4 还没落地，
  先按 §3.2b 的规格自己实现一份并在报告里说明，由主会话决定合并）。
- buildImagePromptInput 要带上地点与所属消息正文，且正文**已剥掉全部标记**。

验证：npm test -- --run src/sillytavern/image-prompt-agent.test.ts
```

#### T8 — `image-world-tags.ts`（阶段 B6，D39）

```
目标：把引擎知道的「时段 + 天气」变成 danbooru 标签，让夜里的戏不被画成白天。

要读：设计文档 D39 与 §5.2 里 ComposeOptions.worldTags 的注释。
      src/sillytavern/time-system.ts 的 getTimeOfDay() / isDaytime()（已存在，直接用）。
      src/sillytavern/stat-projection.ts 里 world['天气'] 的形状（自由文本 string）。

产出：src/sillytavern/image-world-tags.ts（buildWorldTags 纯函数）+ image-world-tags.test.ts。

🔴 关键点：
- 🔴 **映射不中的值一律不贡献标签，返回空串。绝不猜。** 天气是自由文本，猜错比留空糟得多
  —— 这是本任务唯一真正重要的约束，测试要专门盖它。
- 引擎没有时间/天气信息时同样返回空串（合法情况，不是错误）。
- 纯函数：时间从参数进，不读时钟、不做 I/O。
- 天气映射表放小、放明确，只收常见中文天气词；宁可漏不可错。

验证：npm test -- --run src/sillytavern/image-world-tags.test.ts
```

#### T9 — `image-anlas.ts`（阶段 B7，D43）

```
目标：按当前参数估算这一张图会不会消耗 Anlas，好在设置页给出「在免费额度内 ✅ /
      会消耗 Anlas ⚠️」的提示。

要读：设计文档 D43 与 §11.2、§6 里关于 Opus 订阅免费档的那两段
      （常规尺寸 + 单张不消耗点数；模板的 1216×832 / 23 步 / n_samples:1 在免费档内）。

产出：src/sillytavern/image-anlas.ts（estimateAnlasCost 纯函数）+ image-anlas.test.ts。

🔴 关键点：
- **这条规则会变，所以测试就是它的文档** —— 边界值逐个钉死，每个断言写清依据。
- 规则常量集中在一处，将来 NAI 改规则时只动那一处。
- 措辞是**估算**不是保证（UI 层会写「按当前订阅规则估算」）。

验证：npm test -- --run src/sillytavern/image-anlas.test.ts
```

### 波 3

#### T10 — `image-segments.ts`（阶段 B1）

```
目标：把一条消息正文切成「文本段 / 图片段」序列，供渲染层使用。

要读：设计文档 §5.1 全节（不变式）、§10.1（分段在美化之前）。
      src/sillytavern/marker-protocol.ts 的 scanByTag（T3 刚把 scene_image 注册进去）。
      src/ui/lib/beautifier.ts 的 appendText（相邻文本段合并的做法照它）。

产出：src/sillytavern/image-segments.ts（splitSceneImageSegments）+ image-segments.test.ts。

🔴 不变式：
- 🔴 **不许自己写第二个解析器** —— 调 scanByTag(text, 'scene_image') 拿 position 与
  rawContent，用它们切。一个标签两个解析器就是漂移的来路。
- occurrence 在**整条消息**上从 0 递增。
- 相邻文本段合并；空文本段不产出。
- 正文为空的标记（自闭合/只有属性）**不产出任何段**，等价于剥掉。
- 输入无标记时返回 [{kind:'text', text}]（**不是空数组**，调用方不必特判）；
  输入空串返回 []。

验证：npm test -- --run src/sillytavern/image-segments.test.ts
```

#### T11 — Dexie v17 + 两个 store（阶段 D）

```
目标：落库层。三张新表 + 读写口 + 生成队列。

要读：设计文档 §7 全节（Dexie v17 / 删存档连带删 / FullBackup / 回滚 / 用量与清理）、
      §4 的 SceneImageRecord 与 ImagePreset、§8 的 generate() 流程图。
      src/sillytavern/database.ts 的 v16 schema、withSchema 用法、删存档那个事务
      （约 :1083）、FullBackup 的表清单。

产出：
- database.ts：version(17) 加 sceneImages / sceneImageBlobs / imagePresets 三表
- src/ui/stores/scene-image-store.ts：Dexie 唯一读写口 + generate() 串行队列
- src/ui/stores/image-preset-store.ts：视觉预设 CRUD
- 两个 *.test.ts（用 fake-indexeddb）

🔴 关键点：
- 索引：sceneImages 'id, saveId, messageId, [saveId+messageId], turn'；
  imagePresets 'key, kind, name'（主键是 `${kind}:${name}`，name 保原样供 === 匹配）。
- 删存档要连带删 sceneImages + 对应 blobs；**imagePresets 不删**（它是全局的）。
- FullBackup：sceneImages ✅ + imagePresets ✅ + sceneImageBlobs ❌（字节进 JSON 会爆炸）。
- 记录**先落库再发请求**（D5），状态 queued；轮到它时改 generating 并写 startedAt。
  🔴 startedAt 不是 createdAt —— 排第三位的图不能一上来就显示「已用 180 秒」。
- 队列**串行**（NAI 有速率限制且并发同时扣费）。取消 queued 项**不产生任何网络调用** ——
  为这条写测试。
- 「清理」= 删 blob 行 + 给记录打 blobDropped，**sceneImages 行数不变**（D47）。
- 重画**追加 take 不覆盖**；同一锚点下 pinned 至多一条。
- anchorKind 'marker' 与 'message-end' 的 occurrence **各自独立计数**。

验证：npm test -- --run src/ui/stores/scene-image-store.test.ts src/ui/stores/image-preset-store.test.ts
```

#### T12 — BFF 路由 + 网络客户端（阶段 E）

```
目标：让前端能经 BFF 打到 NAI 并原样拿回 zip。

要读：设计文档 §12.1（BFF 改动）、§12.2（错误分类与文案表）、§4 的 ImageGenFailure。
      server/ 下 forward() 的实现、app.ts 的 cors 配置、vite.config.ts 的 hono 挂载前缀。
      src/ui/lib/workshop-client.ts —— 判别联合永不抛穿 + 超时 + 取消的先例，照它写。

产出：
- server/routes/image.ts（**复用 forward()**）
- vite.config.ts 挂载前缀加 /api/image
- src/ui/lib/image-client.ts（唯一网络接触点）+ image-client.test.ts

🔴 关键点：
- 🔴 **复用 forward()** —— 它已经是 new Response(upstream.body, …) 管道直通且剥掉了
  content-encoding，zip 原样过。**绝不要**另写一条会 await res.json() 的路径，
  那会把二进制读坏。
- Accept: application/x-zip-compressed 由前端设置，forward() 已透传。
- SSRF 黑名单、Authorization 透传**都不动**。
- image-client 的返回是**判别联合，永不抛穿**；带 AbortController。
- 错误分类照 §12.2 那张表逐条实现，文案就用表里的中文原文。
  detail 只进 console 与记录，**不进 UI**。

验证：npm run typecheck && npm test -- --run src/ui/lib/image-client.test.ts
```

### 波 4

#### T13 — 正文渲染（阶段 F）

```
目标：把标记渲染成图 / 按钮 / 排队 / 生成中 / 失败五种态。

要读：设计文档 §10.1（分段在美化之前）、§10.2（**状态真值表**，逐格实现）、
      §10.2b 里关于 message-end 图带的那两条。
      src/ui/components/game/BeautifiedNarrative.vue 现状、src/ui/lib/beautifier.ts 的
      compileBeautifierSegments、src/ui/lib/asset-url.ts。docs/design.md（前端规范，必读）。

产出：BeautifiedNarrative.vue 改造 + 新建 SceneImageSegment.vue（+ 状态判定纯函数抽出来单测）。

🔴 关键点：
- 分段在美化**之前**且**不受美化开关约束**（D3）：美化关掉 / 流式输出中，
  标记也绝不能漏成尖括号给玩家看见。
- 真值表五态：无记录+off（什么都不渲染）· 无记录+manual/auto（按钮）· queued（可零成本取消）
  · generating（转圈 + 已用秒数 + 中止，文案要说明**本次仍会计费**）· done · failed
  （原因 + 重试 + **自己写提示词**）。
- 🔴 **「无记录 + auto」出的是按钮，不是去生成** —— 这是将来最可能被人「顺手补全」掉的
  一环，为它单独写测试。
- 占位框里始终写 title + intent 那句中文（D37）。
- 缺预设时图下一行小字 + [去设置] 深链（D41）。
- 布局：按钮态 / 排队态 / 生成中态**必须占同样高度**，否则每张图落地时对话流会跳。
- alt 取 title，title 属性取 description。
- 🔴 object URL 必须走 src/ui/lib/asset-url.ts 的引用计数 LRU，**不要写第二个**。
- message-end 的图**不走 splitSceneImageSegments**，是段落渲染完之后追加的一条图带。

验证：npm run typecheck && npm test -- --run
```

#### T14 — 侧链接线 + 临时 systemPrompt（阶段 G，含 D55）

```
目标：让 image_prompt 成为第 13 个 agent 并真的能被调用。

要读：设计文档 §8.5（侧链规格）、D28 / D31 / D32 / **D55**、§11.3 里
      「image_prompt 不进 AGENT_LIST」那一节。
      data/defaults/agent-config.json 现有 12 个 agent 的条目形状。
      src/sillytavern/char-gen-agent.ts —— 侧链编排的先例，照它的形状写。

产出：
- agent-config.json 加第 13 个 agent `image_prompt`
- image-prompt-agent.ts 补上中间那次 callAgent（T7 已把两头的纯函数写好）
- 侧链调用接线

🔴 关键点：
- 🔴 **systemPrompt 只写一份临时最小版**（D55）：够覆盖 §8.5 的四点、够跑通管道即可，
  **必须带 TODO 标注**说明正式版待撰写。不要在这个任务上打磨提示词质量 ——
  那是延后的独立任务（N），因为提示词好不好要看真机出的图才谈得上调。
- 🔴 **image_prompt 不进 src/ui/components/settings/agent/agent-list.ts 的 AGENT_LIST**
  （D53）—— 它渲染在第 13 分区里（T15 做），同一份配置不开两个入口。
  先例：combat_v3 也在 agent-config.json 里但不在 AGENT_LIST。
- 类型是**普通补全，非 Agentic**（不需要工具调用）。
- 默认挂便宜快模型；世界书默认关。
- 产出缓存进记录，重试/重画不再跑侧链（除非用户改过 editedScenePrompt）。

验证：npm run typecheck && npm test -- --run
```

#### T15 — 第 13 分区（阶段 I，D50/D51）

```
目标：新建「🖼 图像生成」设置分区，三张卡。

要读：设计文档 §11 全节（含 §11.1 三档开关文案、§11.2 免费额度指示、
      §11.3 三张卡与两处「提示词」的区别）。
      docs/design.md（前端规范，必读）。
      src/ui/components/settings/ 下任一既有分区的写法（照 Q-25 的拆法）、settings-chrome.css。
      src/ui/components/settings/agent/AgentConfigPanel.vue（T2 抽出来的，第一张卡要用）。

产出：src/ui/components/settings/image/ 下 ImageSection / ImagePromptCard /
      ImageRenderCard / ImagePresetList，并挂进设置页主导航。

🔴 关键点：
- ⚠️ **UiSettings 要改两处**（Q-18 硬规矩）：settings-types.ts 的声明 **+**
  getDefaults() 给默认值。少一处那个设置项就是 undefined。
- 🔴 分区壳必须**单根** section.centered，否则宽屏下会摊满整行（既有分区踩过）。
- 第一张卡「提示词生成」= 薄壳，内部就是 AgentConfigPanel 传 agentId="image_prompt"。
  **它渲染的是 agents 袋子里的同一份存储**，不要复制一份到 UiSettings（D52）。
- 🔴 **两处「提示词」必须各自写清作用范围**：第一张卡的 systemPrompt 是「教模型怎么
  转标签」，第二张卡的画质后缀/全局负向是「直接拼进每张图」。写错框两边都不报错，
  只是画出来不对。
- 三档开关的 auto 项底下带后果行；首次切到 auto 弹一次确认（imageAutoConfirmed 记住）。
- 免费额度指示调 T9 的 estimateAnlasCost，措辞是「按当前订阅规则**估算**」。
- ⚠️ apiType 加 'image' 时 api-key-migration.ts 的 :16 与 :65 **两处一起改**，
  否则症状是「图像 API 存了、重开变成 chat」。
- 分区用 <style scoped src="../settings-chrome.css"> 引共用外壳样式。

验证：npm run typecheck && npm test -- --run
```

#### T16 — CG 图鉴（阶段 J）

```
目标：同一批记录的第二个视图 —— 按剧情顺序回看全部插画。

要读：设计文档 §10.3 全节。docs/design.md（前端规范，必读）。
      src/ui/components/game/SnapshotPanel.vue（同级面板的写法先例）、
      src/ui/lib/asset-url.ts。

产出：CgGalleryPanel.vue + CgGalleryDetail.vue + SideToolbar.vue 加入口。

🔴 关键点：
- **零新数据模型** —— 就是 SceneImageRecord 的第二个视图。
- 列表按 turn 升序；同锚点的多 take 折成一格，角标显示张数。
- 详情：标题/说明双击就地改 · 可编辑场景提示词（改完重画走 editedScenePrompt）
  · 钉成正文显示的那张 · **「把这次的 seed 钉给他」**（图里恰好一个角色时才出现，
  旁边照实写「同一 seed 只让构图更接近，不保证同一张脸」）。
- 已清理的格子（blobDropped）显示「字节已清理」+ 重画按钮，**不要渲染成破图**。
- **未生成的标记与失败的记录都不进图鉴** —— 图鉴是「已经画出来的东西」，
  塞灰格子会让它从战利品陈列变成待办清单。
- 🔴 懒加载**双保险**：IntersectionObserver **加上**一个约 500ms 的定时兜底
  （按 getBoundingClientRect() 对视口 ±1500px 复查）。单靠观察器在低带宽/弱设备上
  会不触发，表现为一屏空白框 —— 那种「我这边好好的」的 bug。
- 🔴 object URL 必须走 asset-url.ts 的引用计数 LRU，不要写第二个。

验证：npm run typecheck && npm test -- --run
```

### 波 5

#### T17 — GamePipeline 接线（阶段 H，**集成拱心石**）

```
目标：把标记扫描 → 三档分流 → 限额 → 侧链 → 出图 → 落库整条串起来。
      前面所有契约对不对，都在这个任务里暴露。

要读：设计文档 §8 全节（执行链路图）、§8.1（D15 的实现面）、§8.2（并发）、
      D15 / D21 / D24 / D32 / D48。
      src/ui/lib/game-pipeline.ts 里 onPlayAudio 回调的现成先例 —— 照它的形状加 onSceneImage。

产出：GamePipeline.onSceneImage 接线 + 三档分流 + 限额调用。

🔴 排序与安全约束（这个任务的全部要害）：
- 🔴 **checkQuota 在 image_prompt 之前**（D32）。两处花钱（LLM token + Anlas），
  闸门要在最前面 —— 否则自动档会为被限流器拦下的插画白烧一次侧链调用。
- 🔴 **自动档绝不追溯开火**（D15）：只对本回合新到的消息。onSceneImage 回调只在编排器
  刚产出这条消息时触发一次，历史消息重新渲染走 store 查询、根本不经过这个回调 ——
  所以 D15 是默认成立的。**代码里必须留一句注释**：日后千万别为了「补全历史插画」
  加一条扫描全部消息的路径，那会把这条安全性一次性拆掉。
- 🔴 **auto 绝不在流式未完成的消息上开火**（D48）。
- 限额拒绝时**绝不丢弃标记** —— 什么都不做，让它落到「无记录」格，渲染成手动按钮（D21）。
- 自动硬停（降级成按钮），手动只弹一次确认（D24）。
- off 档：标记照扫（否则会漏成文本），但不建记录、不发请求。
- 串行发；切存档/离开页面 → AbortController 取消，对应记录标 aborted。
- **永不自动重试**（D25）。

验证：npm run typecheck && npm test -- --run
```

### 波 6

#### T18 — story systemPrompt 加一句话（阶段 K）

```
目标：让 story agent 知道可以输出 <scene_image>。

要读：设计文档 §8.5 末尾「story 那边的改动缩到一句话」、§3（标记协议）。
      data/defaults/agent-config.json 里 story 的 systemPrompt 现状。

产出：story 的 systemPrompt 增加一句话，说明何时输出 <scene_image>、属性怎么写、要克制。

🔴 关键点：
- 🔴 **绝不在 story 的 systemPrompt 里教 danbooru**（D28）。story 全程只写中文 ——
  它不需要知道 danbooru 长什么样。方言知识全在 image_prompt 那边。
  验收标准第 0 条就是「story 的 systemPrompt 里没有一个 danbooru 词」。
- 这是**全游戏最要紧的系统提示词**，改动要最小：加一句话，不重排、不顺手优化别的。
- 报告里贴出你加的那一句话原文（这一条例外，因为它很短且需要主会话过目）。

验证：npm run typecheck && npm test -- --run
```

#### T19 — ChatFlow 右键「为这一段配图」（阶段 M，D33/D34）

```
目标：玩家能对任意 assistant 消息主动要一张图，不依赖 story 有没有写标记。

要读：设计文档 §10.2b 全节、D33 / D34。
      src/ui/components/game/ChatFlow.vue:126 起的右键菜单（现在只绑最新一条 assistant
      消息，做回退/复制）。

产出：右键菜单放宽到任意 assistant 消息 + 加「为这一段配图」菜单项。

🔴 关键点：
- 菜单项要**按消息过滤**：回退仍只在最新一条上出现，配图哪条都行。
- 锚点是 anchorKind:'message-end'，渲染在该消息正文之后。
- intent = 整条消息正文（已剥标记）喂给侧链。**不做选中文本锚定** ——
  那是最脆弱的一半（原文一改锚点就丢），收益只是位置更精确一点。
- 限额走同一个 checkQuota({source:'manual'})，不要另写一份判定。
- 🔴 **off 档下这一项不出现** —— 整个功能关掉时右键菜单里还留着一个能开始花钱的入口，
  是「关掉了但没完全关掉」那类最招人烦的 bug。

验证：npm run typecheck && npm test -- --run
```

### 延后

#### T20 — ✍️ 正式撰写 `image_prompt` 的 systemPrompt（阶段 N，D55）

**在 L（真机走查）之后做**，因为提示词质量要看真机出的图才谈得上调。

```
目标：把 T14 留下的临时 systemPrompt 换成正式版，摘掉 TODO。

要读：设计文档 §8.5「systemPrompt 要教的四件事」、reference/narrative_context_example.md
      （叙事内容规范）、docs/reference/agent_system_prompt_guide.md（配置流程与踩坑）。

要教的四件事：
1. 输出 danbooru 标签，逗号分隔，**全部 ASCII 标点**
2. **不写角色外观** —— 那由角色预设负责。它只写场景、动作、光线、构图、数量标签
3. 不写画质词与 rating —— Code 会追加
4. 输出 <image_prompt> / <image_negative> / <image_desc> 三个标签，不要别的

🔴 硬性禁止（这条是本任务存在的主要原因之一）：
- 不写任何人格覆写、越狱、"过滤器已关闭"、"限制已解除"类框架。
- 不枚举任何内容类别授权。分级是**参数**（ImageRating），由 Code 变成 rating:* 标签，
  **永远不是提示词里的散文**。
- 不写预填的 assistant 轮次。
- 写完自查一遍：bypass / filter / restriction / unrestricted / override / 绕过 / 审查 /
  覆写 / 无限制 —— 这些词一个都不该出现。
- 提示词要**短**。上游同类实现动辄 8–11 轮，其中真正干活的只有一轮。

验证：npm run typecheck && npm test -- --run
      并说明你怎么确认它还能跑通（至少：临时版的管道测试仍然过）。
```

---

## 3. 主会话的验收清单

每波结束后对照，**不要在主会话读代码来核对，派 verifier agent**。

| 波  | 收了就该成立的事                                                                      |
| --- | ------------------------------------------------------------------------------------- |
| 1   | `npm run typecheck` 过；既有 11 个 Agent 页切换正常、systemPrompt 框有内容不是空的    |
| 2   | 7 个模块各自测试全绿；**画质后缀默认值不含 `rating:general`** 有断言                  |
| 3   | 落库层测试全绿；**取消 queued 不产生网络调用**有断言                                  |
| 4   | 设置页能进新分区；图鉴能开；正文里标记不再漏成尖括号                                  |
| 5   | 🔴 **限额拒绝时侧链一次都没被调用**（D32）有断言；「无记录 + auto」出按钮而非自动开火 |
| 6   | story 加的那句话里**没有一个 danbooru 词**                                            |
| 7   | 真机：§6.3 三点 curl 确认 + 验收标准 §0.2 那 15 条逐条走                              |

### 3.1 最后一次全量

派一个 verifier agent：

```
跑 npm run typecheck && npm test -- --run，然后对照
docs/planning/2026-08-04-image-generation-design.md §0.2 的 15 条验收标准逐条检查
（代码层面能检的那些），用不超过 10 行汇报：哪几条成立、哪几条不成立、不成立的原因一句话。
不要贴代码、不要贴 diff。不要派生子 agent。
```

---

## 4. 已知风险与它们的兜底

| 风险                                                        | 兜底                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| T4 与 T7 都要 `normalizeTagString`，可能各写一份            | brief 里已写明 T7 若发现 T4 未落地就自己实现并**在报告里说明**，由主会话决定合并。波次收尾时核对一次 |
| T6 手头没有真 NAI zip 样本                                  | brief 已允许用 fflate 自压 fixture 并声明。真样本要等 L 阶段的 curl —— 那时补一个真 fixture 回来     |
| §6.3 那三点（0 角色数组、端到端换 zip、ucPreset）没真机验证 | 设计文档已判定风险很低且**不阻塞纯函数层开工**。若 L 阶段发现不对，改动只落在 T6 一个文件里          |
| T2 抽壳碰的是既有 11 个 Agent 页，回归面比图像功能本身大    | 独占波 1、单独验收；它与图像功能零耦合，出问题可以单独回滚而不影响其余                               |
| T17 是集成点，前面任何契约错了都在这暴露                    | 独占波 5，报告单独读。前面每一波都已各自验证过，到这里失败大概率是接线而非模块内部                   |

---

## 5. 与设计文档的对应关系

| 本文任务 | 设计文档阶段 | 本文任务 | 设计文档阶段 |
| -------- | ------------ | -------- | ------------ |
| T1       | A            | T11      | D            |
| T2       | I0           | T12      | E            |
| T3       | C            | T13      | F            |
| T4       | B2           | T14      | G            |
| T5       | B3           | T15      | I            |
| T6       | B4           | T16      | J            |
| T7       | B5           | T17      | H            |
| T8       | B6           | T18      | K            |
| T9       | B7           | T19      | M            |
| T10      | B1           | T20      | N（延后）    |

真机走查（L）不是 agent 任务，由主人执行。
