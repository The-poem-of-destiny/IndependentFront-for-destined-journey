# 图像生成 v2 —— lean-delegation 实施编排

> 设计全文: 同目录 `2026-08-08-comfyui-image-provider-design.md`（C1–C16）。
> 模式: 主会话（Fable）只做 grounding / 编排 / 审查；实现全部由 Opus 子代理承担。
> 每个任务 = 一个子代理；同一波内的任务文件面互不相交，可并行。

## 波次总览

```
波 0  scout        —— 缝的精确契约（forward() GET / seams 类型 / 注册表加面步骤 / 测试钉点）
波 1  T1           —— 类型地基 + 方言注册表面（独占 types-image.ts，避免后续冲突）
波 2  T2 ∥ T3      —— 方言化装配（engine 纯函数） ∥ ComfyUI provider 全链（engine+BFF+client）
波 3  T5           —— 设置重构 + 迁移（settings-types / settings-store / 读者改址）
波 4  T6           —— seams + store + pipeline 接线（依赖 T1-T5 全部）
波 5  T7a ∥ T7b    —— 设置页 UI ∥ 游戏页 UI
波 6  验收         —— 四闸门 + 分册文档 + 真机三走查（需要用户开 ComfyUI）
```

依赖关系: T2/T3 依赖 T1 的类型；T6 依赖 T2/T3/T5 的全部产物；T7 依赖 T5/T6 的设置形状与告警数据。
T5 与 T2/T3 无文件交集，理论上可并入波 2，但 settings 是全应用最热状态，独占一波降低回滚成本。

## 逐任务 brief 要点

### T1 类型 + 方言面（波 1）

- `types-image.ts`: `ImageDialect`（C4 全旋钮）、`ImageGenFailureKind` 增 `'workflow' | 'execution'`、
  `SceneImageRecord` 增 `provider? / dialectId? / composeWarnings?`（缺席 provider 读作 novelai，C14）、
  `ImageProviderCapabilities`（C1 能力位）。
- `image-defaults.ts`: `IMAGE_FAILURE_RETRYABLE` 补两格（workflow:false / execution:true）——
  `satisfies Record` 会强制补齐。
- `data/content/image-dialects.json`: danbooru-anime（systemPrompt 从
  `public/data/defaults/agent-config.json` 的 image_prompt **逐字节**搬）+ natural-prose 占位。
- `content-store.ts` 加第 7 面 `imageDialects`（scout 报告列出的每一处）+ 解析容错
  （形状照 `workshop-manifest` 的容忍原则: 未知旋钮值回落默认并告警，不炸）。
- 引擎侧 `image-dialect.ts`: `resolveImageDialect(raw, overrides)` 纯函数（默认+覆盖合并、
  旋钮值校验回落）。
- 🔴 中文 JSON → 改完必跑编码三判据；pack-install 契约测试若钉面清单要同步。

### T2 方言化装配（波 2）

- `composePrompt` 增方言参数: separator / normalize 开关（'none' 时恒等）/
  appearance 渲染器二选一 / world·rating·count 三段的 'tag'|'none' /
  qualitySuffix·baseNegative·composition 从方言来 / `flattenCharacters`（C7: 无槽后端
  角色 positive 插在场景段后、negative 并 baseNegative，标记顺序）。
- prose 下 legacy 手写串 = missing-preset 跳过（C15，用户裁定）；warnings 原样返回。
- 🔴 **金测试**: danbooru-anime + 槽后端下，新旧 `composePrompt` 对同输入逐字节同输出
  （拿现有测试的 fixture 跑双份对比，或直接把旧输出录成 golden）。
- `count` 段 'none' 时也**不剥**模型写的人数标签?—— 剥离逻辑 `COUNT_TAG_RE` 只在
  count:'tag' 时启用（prose 模型不吃 1girl，但句子里 "two women" 不该被正则误伤——
  该正则只匹配 tag 形态，确认后保持仅 tag 档启用）。

### T3 ComfyUI provider 全链（波 2）

- `image-providers/comfyui.ts`（纯函数）: `substituteWorkflow(parsedGraph, values)`
  值级替换（整值占位符→类型化值，字符串内嵌→字符串替换；`%prompt%`/`%negative_prompt%`
  别名；未知 `%xxx%` 原样保留不报错）、`parseComfyQueueResponse`（🔴 200 + `node_errors`
  非空 → `workflow` 失败，文案点名节点 id，C12）、`parseComfyHistory`（completed/失败/
  仍在跑三态 + outputs→filename 列表）、`BUILTIN_COMFY_WORKFLOW`（最小 SDXL 图）。
- `server/routes/image.ts`: 三条 forward() 透传（C10；scout 确认 GET+query 支持后照做）。
- `image-client.ts`: `generateComfyImage`（队→轮询→取图单 Promise；轮询间隔与超时
  从 opts 来，超时默认 600s；signal 贯穿三段；PNG 字节 arrayBuffer 纪律同 NAI）。
- 测试: 替换含引号/反斜杠提示词、node_errors on 200、轮询假计时器、view 字节路径。

### T5 设置重构 + 迁移（波 3）

- `settings-types.ts` 照 C8 重排（type 不是 interface 的既有约束记得）；`getDefaults()` 同步。
- 新 `image-settings-migration.ts` 照 `agent-settings-migration` 先例（同对象重排 /
  无标志位 / `ref()` 之前同步跑）；qualitySuffix/baseNegative/agents 袋 systemPrompt
  与 danbooru 默认**不同**才迁成 override（C8）。
- 全仓 `imageModel` 等旧字段读者改址（scene-image-seams 的 `ImageRuntimeSettings` Pick、
  ImageRenderCard、image-anlas 调用点…以 typecheck 扫尾）。
- 测试: 迁移幂等、老档全默认不产 override、自定义值迁对格。

### T6 seams + store + pipeline（波 4）

- `scene-image-seams.ts`: 按 `imageProvider` 选 provider 实现; comfy 分支不查端点池
  （baseUrl 从袋里来）; 方言经 `resolveImageDialect` 进 `composePrompt`;
  `checkQuota` 传 costModel（L1/L2 仅 paid，L3 恒开 —— 改 `image-quota.ts` 本体，C9）。
- `scene-image-store.ts`: 建记录写 `provider`/`dialectId`/`composeWarnings`;
  重画路径: dialectId 不匹配 → 弃缓存重跑侧链（C14）。
- `game-pipeline.ts` `runImagePromptAgent`: 合成 `AgentConfig{agentId:'image_prompt',
systemPrompt: 方言有效值}` 注入 configs（scout 确认 buildAgentMessagesAsync 的
  覆盖语义后照做）; `public/data/defaults/agent-config.json` 删 image_prompt.systemPrompt（C5）。
- 测试: provider 分流、quota 三层新语义、redraw 方言不匹配重跑侧链、prompt 注入。

### T7a 设置页 UI / T7b 游戏页 UI（波 5）

- T7a `ImageRenderCard`: 后端选择器; comfy 字段（地址/工作流粘贴框/超时）; NAI 字段与
  端点选择器仅 novelai 下渲染; Anlas 卡与限额输入 local 下隐藏（C9/C16）;
  extra-negative 在 `supportsNegative:false` 时可见禁用（C6）; 方言选择器。
  `ImagePromptCard`: AgentConfigPanel 藏 systemPrompt 卡（或等价方案），新增按方言
  的 prompt 覆盖编辑器（当前方言 + override 文本框 + 「恢复本档默认」）。
- T7b `ImagePresetList`: 「当前方言下无可用形象」标注（C15）; CG 详情
  `composeWarnings` 一行; SceneImageSegment 重画在方言不匹配时的提示文案（C14）。
- 两任务文件面不相交，可并行。设计规范 `docs/design.md` 必读进 brief。

### 波 6 验收

- 四闸门 + encoding-invariants; AGENTS.md 两分册（sillytavern/ui 架构图补 comfyui.ts /
  image-dialect.ts / 设置形状变化）+ 根表进度行 + `docs/CHANGELOG.md`。
- 真机（需用户配合开 ComfyUI）: ①comfy 全链路出图进正文与图鉴 ②NAI 回归一张
  ③danbooru↔prose 切换四字符串整套换。真机前本分支不合 master。

## 报告纪律（写进每个 brief）

≤15 行: 改动文件+一行摘要 / 跑过的命令与结果（失败只报名字+一行原因）/
阻塞或顺手发现（只列不修）。禁止贴回文件内容或 diff。禁止自行 spawn 子代理。
禁止 push。失败两次停手上报。
