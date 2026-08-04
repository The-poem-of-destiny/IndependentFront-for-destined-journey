/**
 * image-defaults.ts — 图像生成子系统的常量默认值（设计 §6.2 / §5.2 / §5.3）
 *
 * 装什么: 画质后缀表 / 固定构图词 / 基础负向 / 限额默认值。
 * 不装什么: 任何逻辑。本文件是纯常量，被 `image-prompt.ts`、`image-quota.ts` 与
 *           设置页的 `getDefaults()` 共用 —— 它存在的意义就是让这些值只有一处。
 *
 * 🔴 这些默认值大多是**可配置项的初值**（`ComposeOptions` / `UiSettings`），
 *    不是硬编码常量。改这里等于改所有新存档的起点。
 */

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
