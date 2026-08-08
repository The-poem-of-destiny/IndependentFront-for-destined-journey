/**
 * image-defaults.ts — 图像生成子系统的常量默认值（设计 §6.2 / §5.2 / §5.3）
 *
 * 装什么: 画质后缀表 / 固定构图词 / 基础负向 / 限额默认值 / §12.2 那张表里被
 *         **多方共用**的两格（`bad-response` 文案与「要不要显示重试」）。
 * 不装什么: 任何逻辑。本文件是纯常量，被 `image-prompt.ts`、`image-quota.ts` 与
 *           设置页的 `getDefaults()` 共用 —— 它存在的意义就是让这些值只有一处。
 *
 * 🔴 这些默认值大多是**可配置项的初值**（`ComposeOptions` / `UiSettings`），
 *    不是硬编码常量。改这里等于改所有新存档的起点。
 */

import type { ImageGenFailureKind } from './types-image';

// ═══ 模型 ═══

/**
 * v1 默认模型（§6.2 裁定 1）。
 *
 * 🔴 **刻意不是 Curated**：Curated 既是过滤子集模型，其官方规范画质后缀又强制带
 * `rating:general`（见下表）。本项目明确要支持露骨内容，用 Curated = 每张图都在
 * 跟自己的提示词打架。
 */
export const DEFAULT_IMAGE_MODEL = 'nai-diffusion-4-5-full';

// ═══ 画质后缀（§6.2）═══

/**
 * NAI 官方 [Add Quality Tags](https://docs.novelai.net/en/image/qualitytags/) 各模型后缀。
 *
 * 🔴 **这张表是文档，不是路由表**。v1 只用 `'V4.5 Full'` 那一行；其余行照抄官方文档
 * 留在这里，唯一用途是让「为什么不用 Curated 那一行」这条理由**看得见**（并且被
 * `image-defaults.test.ts` 钉住 —— 有人想把默认值换成 Curated 时测试会红）。
 *
 * 🔴 键用的是**官方文档里的展示名**，不是 API 的 model id。除 V4.5 Full 外的
 *    model id 未经核准，不在这里编造。
 *
 * 🔴 **V3 之后后缀一律追加在提示词末尾**（不是开头）—— 顺序即权重，画质词压在最后。
 * 🔴 表里的值**不带前导 `, `**。官方文档写成 `, location, …` 是在描绘「追加」这个动作；
 *    我们的 `composePrompt` 用 `, ` 连接各段且不允许产出 `, ,`（§5.2 不变式），
 *    所以存的是**标签内容本身**。
 */
export const NAI_QUALITY_SUFFIXES = {
  'V4.5 Full': 'location, very aesthetic, masterpiece, no text',
  'V4.5 Curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'V4 Full': 'no text, best quality, very aesthetic, absurdres',
  'V4 Curated': 'rating:general, amazing quality, very aesthetic, absurdres',
  'Anime V3': 'best quality, amazing quality, very aesthetic, absurdres',
} as const satisfies Record<string, string>;

/**
 * `ComposeOptions.qualitySuffix` / `UiSettings.imageQualitySuffix` 的默认值。
 *
 * 🔴 **绝不能含 `rating:general`**（§6.2）。分级是我们自己显式控制的一个 tag
 * （由 `ImageRating` 钳位后拼进 base），后缀里再塞一个 = 两条互相打架的指令，
 * 而且是**静默**打架 —— 不报错，只是画出来的东西永远保守。
 * `image-defaults.test.ts` 为这条写了断言。
 */
export const DEFAULT_IMAGE_QUALITY_SUFFIX = NAI_QUALITY_SUFFIXES['V4.5 Full'];

// ═══ 构图（§5.2 拼接顺序 [4]）═══

/**
 * `ComposeOptions.compositionTags` 的默认值 —— 固定的横构图词。
 *
 * 默认尺寸是 NAI 官方横构图预设 1216×832（≈3:2），构图词让模型知道画面是横的。
 *
 * 🔴 **刻意极简**。这一段排在场景与地点之后（顺序即权重），写多了会盖掉
 * 「这一刻正在发生什么」。想加氛围词请加进角色/地点预设或世界状态标签，不要往这里堆。
 * 🔴 不写 `scenery` 之类会挤掉人物的强景物标签 —— 情景插画里多数画面是有人的。
 */
export const DEFAULT_IMAGE_COMPOSITION_TAGS = 'wide shot, depth of field';

// ═══ 负向（§5.2 baseNegative）═══

/**
 * `ComposeOptions.baseNegative` / `UiSettings.imageBaseNegative` 的默认值 ——
 * 我们自己维护的基础负向。
 *
 * 🔴 **不用 `ucPreset` 的具名清单代替**（§6.2）：UC 预设是**每模型一套**的具名清单，
 * `ucPreset: 0` 是那个模型清单里的第 0 项，换模型语义就变。所以负向文本由我们自己拿着，
 * `ucPreset` 只按录制值原样发。官方明述用户负向是**叠加**在预设之上而非替换，
 * 我们的全局负向照此语义。
 *
 * 🔴 只写画质与解剖类缺陷，**不写内容分级**相关的词 —— 分级归 `rating:*` tag 管，
 * 在这里加 `nsfw` 之类等于绕过用户设的上限反着来。
 */
export const DEFAULT_IMAGE_BASE_NEGATIVE =
  'lowres, aliasing, blurry, jpeg artifacts, worst quality, bad quality, bad anatomy, bad hands, extra digits, fewer digits, watermark, signature, username, artist name, text, logo';

// ═══ 限额（§5.3）═══

/**
 * L1 每条消息上限。挡的是「单条正文蹦出 15 个标记」。
 * 两种 source（auto / manual）都计入。
 */
export const DEFAULT_IMAGE_MAX_PER_MESSAGE = 2;

/**
 * L2 滚动时间窗（1 小时）上限 —— **真正的失效保护**。
 *
 * 挡的是回退重发风暴、UI 双触发、以及任何没预料到的循环。这是本子系统唯一一条
 * 「错了会直接花钱」的防线，调大之前请先读设计 §9。
 */
export const DEFAULT_IMAGE_MAX_PER_HOUR = 20;

/** L2 的窗口长度，毫秒。判据是 `now - createdAt < IMAGE_QUOTA_WINDOW_MS`。 */
export const IMAGE_QUOTA_WINDOW_MS = 3_600_000;

// ═══ 失败面（§12.2）═══

/**
 * `bad-response` 那一行的 UI 文案。
 *
 * 🔴 **两处产出它，判据不重叠**: `image-providers/novelai.ts` 判的是「zip 解不开 /
 * 里面没有图」，`ui/lib/image-client.ts` 判的是「字节根本读不出来」。判据分开是对的，
 * 但玩家看到的是同一句话 —— 各存一份字符串就会在某次改文案时只改了一半，于是同一种
 * 失败在两条路径上说两种话。所以字符串在这里，判据留在各自那边。
 */
export const IMAGE_BAD_RESPONSE_MESSAGE = 'NovelAI 返回了看不懂的内容';

/**
 * §12.2 最后一列：哪几类值得再试。**唯一一份**（客户端构造失败时用它，渲染层决定
 * 失败段上要不要画「重试」按钮时也用它）。
 *
 * - `aborted` 是 ✅ —— 用户自己取消的，当然还能再点一次；它不是错误，UI 收到这一类
 *   **不该弹红字**（对齐工坊的 `cancelled`）
 * - `prompt-agent` 是 ✅ —— 侧链是一次 LLM 调用，重跑常常就好了（§12.2 第一行）
 * - `auth` / `payment` / `bad-request` 是 ❌ —— 同样的请求再发一百次也是同样的结果，
 *   给一个注定失败的按钮只会让人多花一次时间
 *
 * 🔴 `workflow` 与 `execution` 在这张表里取**相反**的值 —— 这正是 C12 把它们立成两类
 *   而不是合并成一个「comfy 失败」的全部理由。工作流被拒（缺 checkpoint / 未知节点 /
 *   占位符没替换上）是图本身的问题，重试一百次仍是同一个拒绝；跑到一半挂（OOM /
 *   节点崩溃）换个时机常常就过了。合并成一类的话，总有一半的用户拿到错的按钮。
 */
export const IMAGE_FAILURE_RETRYABLE = {
  'prompt-agent': true,
  auth: false,
  payment: false,
  'rate-limit': true,
  'bad-request': false,
  upstream: true,
  network: true,
  aborted: true,
  'bad-response': true,
  workflow: false,
  execution: true,
} as const satisfies Record<ImageGenFailureKind, boolean>;
