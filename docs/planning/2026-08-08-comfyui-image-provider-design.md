# 图像生成 v2 —— ComfyUI 本地后端 + 提示词方言系统 设计文档 v1.0

> 日期: 2026-08-08 · 分支: `txt-2-img-comfyui`
> 前置: `docs/planning/2026-08-04-image-generation-design.md`（图像 v1 / NovelAI，D1–D62）。
> 本文的决策编号用 **C1–C16**，与 v1 的 D 编号不冲突；v1 的裁定除本文明确推翻处一律继续有效。
> 实施编排见同目录 `2026-08-08-comfyui-implementation-plan.md`。

## 0. 目标与范围

两件事，仅此两件:

1. **接入 ComfyUI** 作为第二个出图后端（本地跑模型，零费用），与 NovelAI 并存、可切换。
2. **提示词方言（dialect）系统**: 本地模型分两大类吃法 —— danbooru 标签系（anime 检查点）
   与自然语系（krea2 / flux 类），侧链提示词与装配方式必须能整套切换。
   **真正的提示词内容住在私有内容仓**（内容分离既有路线）；本仓只带最小可用的占位方言。

不在范围: WebSocket 逐步进度、区域条件（regional conditioning）的一等 UI、
第三家云端 provider、img2img / inpaint。

## 1. 现状（v1 的 NAI 耦合点，实测清单）

| 层     | 文件                                         | 耦合                                                                                     |
| ------ | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| BFF    | `server/routes/image.ts`                     | 路径 `/ai/generate-image` 写死；SSRF 名单**放行 localhost**（ollama 先例）→ ComfyUI 可达 |
| 传输   | `src/ui/lib/image-client.ts`                 | `generateNaiImage` / zip 解包 / 401·402·429 分类                                         |
| 请求体 | `src/sillytavern/image-providers/novelai.ts` | V4.5 三重冗余（input / v4_prompt / characterPrompts）                                    |
| 接线   | `src/ui/lib/scene-image-seams.ts`            | 无条件调 `buildNaiRequest`                                                               |

**danbooru 比 NovelAI 埋得更深**: `normalizeTagString`、`rating:*`、`NAI_QUALITY_SUFFIXES`、
构图词、`image-world-tags.ts`（时段/天气→标签）、九槽外貌的 `renderAppearanceDanbooru`、
`image_prompt` 的 systemPrompt —— 全部假定逗号分隔标签。
已有的缝: `ImagePreset.dialects.prose` 与 `renderAppearanceProse`（零消费者，D11 预留）。

## 2. 决策

### C1 分叉线 = `ImageProvider` 接口

一个契约: provider 无关的装配产物 + 参数进，字节或 `ImageGenFailure` 出。
`novelai/` 保留 `buildNaiRequest` + `parseNaiZip` + 自己的失败分类；`comfyui/` 自己管
排队→轮询→取图。**store / 队列 / 七态真值表 / CG 图鉴 / 记录 schema 全部共用，一份不复制**
（那些地方的 🔴 注释全在警告第二份拷贝）。

Provider 携带**能力位**（是后端的属性，不是方言的）:

```ts
{ id: 'novelai' | 'comfyui',
  supportsCharacterSlots: boolean,   // C7
  costModel: 'paid' | 'local',       // C9
  defaultTimeoutMs: number }         // C13
```

### C2 方言是独立实体，用户选，与 provider 正交

ComfyUI 同时跑 anime 检查点与 krea2 —— 吃法不是后端的属性。方言在设置里独立选择；
NAI 恒用 danbooru 系方言也只是「用户没换」而已。

### C3 方言拥有**整个装配契约**

只换 systemPrompt 的方言仍会对 krea2 产出
`a girl sits in the tavern, night, rain, wide shot, rating:explicit, masterpiece, no text` ——
`composePrompt` 螺栓上去的六段没有一段来自侧链。所以方言拥有:
systemPrompt、分隔符、归一化器、外貌渲染器、世界/分级/人数三类附加段的形态、
`supportsNegative`、画质后缀、基础负向、构图词。`composePrompt` 从 danbooru 硬编码
改为方言参数化。

### C4 方言是**纯数据 + 封闭旋钮集**（内容注册表第 7 面）

私有仓不能跨边界发代码。行为压成引擎解释的封闭枚举:

```jsonc
{
  "id": "danbooru-anime",
  "label": "动漫标签",
  "separator": ", ",
  "normalize": "danbooru", // 'danbooru' | 'none'
  "appearance": "danbooru", // 'danbooru' | 'prose'（renderAppearance* 二选一）
  "world": "tags", // 'tags' | 'none'（'phrase' 预留，v2 不做）
  "rating": "tag", // 'tag' | 'none'
  "count": "tag", // 'tag' | 'none'
  "supportsNegative": true, // flux/krea CFG 1.0 根本不吃负向
  "qualitySuffix": "…",
  "baseNegative": "…",
  "composition": "…",
  "systemPrompt": "…",
}
```

落点: `data/content/image-dialects.json`，`content-store` 新增 `imageDialects` 面，
pack 可整份替换（与 catalog 等六面同一机制）。

### C5 内置两条方言；agent-config 的 systemPrompt 退役

- `danbooru-anime`: 从今天的 `agent-config.json image_prompt.systemPrompt` **逐字节搬运** ——
  现有用户零行为变化，diff 可证明是纯重构。
- `natural-prose`: 刻意单薄的占位（真货在私有仓）—— 让 ComfyUI+krea2 不配置也能跑通、
  CI 不依赖私有仓即可测试。
- `agent-config.json` 里 `image_prompt.systemPrompt` **删除**（第三份拷贝正是 D53 警告的漂移）；
  该 agent 的 model/温度/世界书旋钮不动。

### C6 方言字符串的覆盖规则: 方言 JSON 是默认值，用户改动按方言 id 键控

`systemPrompt` / `qualitySuffix` / `baseNegative` / `composition` 四项同一条规则:
存 `imageDialectOverrides[dialectId]`，空 = 回落方言 JSON。
🔴 全局单份覆盖会把 danbooru 调优带进 prose 档，静默废掉整个特性 —— 必须按 id 键控。
**唯一例外** `imageExtraNegative`（用户口味「永远别画 X」，非方言属性）保持全局，
但 `supportsNegative:false` 时 UI **可见地禁用**，不是静默丢弃。

### C7 角色槽是 provider 能力；无槽后端由装配层压平

NAI 的 per-character 槽是官方抗串味手段（§6.2），保留。ComfyUI 无对应物:
`supportsCharacterSlots:false` 时，各角色 positive 按标记顺序并进 base（场景段之后）、
negative 并进 baseNegative，用方言分隔符。`%character1%…%characterN%` 占位符
随 C11 的替换机制免费获得 —— 将来接区域条件工作流不必重设计。
🔴 能力位放 provider 不放方言: 方言作者声明一个后端没有的能力，败法是静默丢角色。

### C8 设置全面重构为 per-provider 袋子（含一次性迁移）

现状 17 个平铺 `image*` 字段全是 NAI 形。重构为:

```txt
imageProvider: 'novelai' | 'comfyui'
imageDialectId: string
imageDialectOverrides: Record<dialectId, { systemPrompt? qualitySuffix? baseNegative? composition? }>
共享（两家都读；comfy 侧作为 %token% 替换值）:
  imageGenMode imageWidth imageHeight imageSteps imageScale
  imageMaxRating imageBlurByDefault imageAutoConfirmed imageExtraNegative
imageNovelai: { endpointId model sampler noiseSchedule ucPreset tier
                maxPerMessage maxPerHour }   ← 限额随 C9 归 paid 后端
imageComfy:   { baseUrl workflowJson timeoutMs pollIntervalMs }
```

迁移照 `agent-settings-migration` 先例: 同对象内重排、零跨存储、无标志位
（旧平铺键在不在就是信号）、在 `ref()` **之前**同步跑。
旧 `imageQualitySuffix` / `imageBaseNegative`（以及 agents 袋里用户改过的
`image_prompt.systemPrompt`）若与 danbooru 方言默认值**不同**，迁成
`imageDialectOverrides['danbooru-anime']` 的对应项；相同则不落（回落即默认）。

### C9 限额按保护对象拆分: L1/L2 仅 paid，L3 恒开

L1（每消息）与 L2（滚动一小时）是**花钱防线** —— `costModel:'local'` 时不启用，
ComfyUI 不设上限（用户裁定，推翻我推荐的「本地也留队列保护」）。
L3（同回合去重，仅 auto 源）是**正确性规则**: 一回合重复开火产出两张近同图 +
图鉴双条目，与谁付钱无关 —— 对所有 provider 恒开。
Anlas 卡与「按订阅规则估算」文案在 local 下整体隐藏。

### C10 ComfyUI 走 BFF，三条透传路由

`forward()` 的 SSRF 名单已放行 localhost。新增（全部复用 `forward()`，一行不自己写）:

```
POST /api/image/comfy/prompt        → {base}/prompt
GET  /api/image/comfy/history/:id   → {base}/history/:id
GET  /api/image/comfy/view?…        → {base}/view?…（PNG 字节，管道直通）
```

用户免 CORS 配置（ComfyUI 默认不发 CORS 头）；假定应用与 ComfyUI 同机（dev.bat 场景成立）。

### C11 工作流 = 用户粘贴的 API-format JSON + 占位符替换

ComfyUI「Save (API Format)」导出，粘进设置，值位写
`%positive% %negative% %seed% %width% %height% %steps% %scale% %character1..N%`
（兼容 ST 习惯别名 `%prompt%` / `%negative_prompt%`）。
🔴 **在解析后的对象上按值替换**，不做原文字符串替换 —— 提示词里第一个引号就会打断 JSON。
整值是占位符 → 替换成对应类型的值（seed/steps 数字）；字符串内嵌占位符 → 字符串内替换。
内置一份最小 SDXL txt2img 图，未配置也能跑通。LoRA 栈 / 上采样 / 自定义采样器
天然支持 —— 图是用户的，我们只填值。

### C12 ComfyUI 失败分类: 新增 `workflow` 与 `execution` 两类

重试语义相反，不许合并:

- `workflow`（图在跑前被拒: 缺 checkpoint、未知节点、占位符替换失败）→ **不可重试**，
  文案点名违规节点 id。
- `execution`（跑到一半挂: OOM、节点崩溃）→ 可重试。

🔴 **`POST /prompt` 会带着 `node_errors` 返回 HTTP 200** —— 只看状态码的分类器会把它
当成功。必须在 200 响应上检查 `node_errors`（与 v1「content-type 撒谎扔掉付费图」
同形状的坑，这次提前钉死）。`auth`/`payment`/`rate-limit` 在本地后端天然不出现。

### C13 进度 = 轮询 /history，超时 per-provider，不做 WebSocket

provider 的 `send()` 保持单 Promise 契约: 排队 → 每 ~1.5s 轮询 `/history/{id}` → 取字节。
超时是 provider 属性: NAI 维持 120s；ComfyUI 默认 600s 且可配 ——
2 分钟硬闸会把仍在渲染的图记成失败，随后图又悄悄落在输出目录里。
UI 沿用 queued/generating + 「已用 N 秒」。

### C14 记录带 `provider` + `dialectId`；重画用当下配置，方言不匹配时重跑侧链

- `SceneImageRecord.provider`（缺席 → `'novelai'`，老记录免迁移）、`.dialectId`。
- 重画 = 「用我现在的配置再来一次」（本地生成存在的头号理由）。
  `record.dialectId === 当前` → 复用缓存 `scenePrompt`（D31 保留）；
  不匹配 → 重跑 `image_prompt` 侧链（D31 的缓存只在方言内有效）。
- `editedScenePrompt` 仍逐字优先（D26），但方言不匹配时 UI 提示「这份是为另一方言写的」。

### C15 旧手写预设在 prose 方言下: 判 missing-preset 跳过 + 告警面补齐

用户裁定跳过（不做降级透传）。配套堵洞 —— 现状 `ComposedPrompt.warnings`
**产出后无人消费**（查证: 全仓只有一处注释提及），静默跳过不可接受:

- `ImagePresetList` 每角色标注「当前方言下无可用形象（只有标签形式）」;
- `SceneImageRecord.composeWarnings[]` 落库，CG 详情页一行说明为何某角色缺席。
  不做运行时 toast（每张图都会响）；不做阻断（AI 新造 NPC 无预设仍需只画场景，v1 既有裁定）。

### C16 ComfyUI 地址住 provider 袋，不进 API 池

`imageComfy.baseUrl` 在图像分区「出图」卡上，与工作流粘贴框相邻。
API 池维持 NAI-only，`ApiSection.isImageEntry` 与两处钉死测试原样存活 ——
不重开 2026-08-05 那格误导过两轮排查的输入框。不对称是真实的:
池建模的是带 key 的远端服务，ComfyUI 是无 key 的本地地址，
且这格填错的败法是诚实的 connection-refused，不是指向别处的上游错。

## 3. 完成定义（DoD）

- [ ] `npm run typecheck` / `npm run test -- --run` / `npm run lint` / `npm run knip:ratchet` 全绿
- [ ] `tests/encoding-invariants.test.ts` 过（新 JSON 含中文提示词）
- [ ] 金测试: danbooru-anime + novelai 下 `composePrompt` 产物与重构前**逐字节一致**
- [ ] 真机: ComfyUI 全链路 标记→侧链→排队→轮询→字节→正文→CG 图鉴
- [ ] 真机: NovelAI 回归出一张图（设置迁移 + systemPrompt 退役都碰了它那条路）
- [ ] 真机: danbooru ↔ prose 切换，四条字符串整套跟着换

## 4. 两处用户明确推翻推荐的裁定（如实记录）

1. **设置全面重构**（C8）而非平铺字段旁挂 —— 接受一次真实迁移的风险，换对称的形状。
2. **本地后端完全不设 L1/L2 限额**（C9）而非降档保留 —— 接受失控循环压满本地 GPU
   的可能，换「本地免费就该无上限」的直觉一致性。L3 恒开是对偶后补上的正确性底线。
