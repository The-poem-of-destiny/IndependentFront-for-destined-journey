/**
 * image-prompt-agent.ts — `image_prompt` 侧链的两个纯函数（设计 §8.5 / D28）
 *
 * 侧链一共三步：
 *   ① `buildImagePromptInput`  —— 标记 + 所属消息 → `ImagePromptRequest`（纯函数，本文件）
 *   ② callAgent                —— 唯一有 I/O 的一步（见下方 `ImagePromptAgentCall`，尚未接线）
 *   ③ `parseImagePromptOutput` —— 模型原文 → `ImagePromptOutput` 或明确失败（纯函数，本文件）
 *
 * 🔴 **两端都是纯函数**，中间那次调用是唯一的 I/O —— 于是抽取逻辑照样可测（设计 §13）。
 *    本文件**不 import** `agent-client` / Dexie / DOM 里的任何东西，别顺手加。
 *
 * 🔴 `normalizeTagString` 从 `image-prompt.ts` import —— 那是全仓唯一一份（D27）。
 *    这里**绝不另抄一份**。
 */

import { normalizeTagString } from './image-prompt';
import { CAPTION_DESC_MAX, sanitizeCaption, stripMarkers } from './marker-protocol';
import type {
  ImageGenFailure,
  ImagePromptOutput,
  ImagePromptRequest,
  ImageRating,
  SceneImageMarker,
} from './types-image';

// ═══════════════════════════════════════════════════════════
// ① 输入装配
// ═══════════════════════════════════════════════════════════

/**
 * 把一个 `<scene_image>` 标记与它所在的那条消息装成侧链的输入。
 *
 * 三件事全部由 Code 补齐，**agent 不必自己查、也不许自己猜**（设计 §8.5 的输入表）：
 * 出场角色名（D30：来自标记，agent 抽名字会漂）、所属消息正文、当前地点名。
 *
 * @param marker      标记本身。`bodyText` 就是 story 写的那句中文（D28），
 *                    🔴 **不过 `normalizeTagString`** —— 全角标点在中文句子里是正确的（§3.1）
 * @param messageText 所属消息的**原文**（含全部标记）。本函数负责剥 ——
 *                    调用方传原文即可，别在外面先剥一遍再传进来
 * @param location    当前地点名。引擎自己知道，不由 AI 在标记里报（D40 同口径）
 * @param rating      🔴 **已钳位**的分级。钳位逻辑（`min(标记要求, 用户上限)`，D38）
 *                    住在 `composePrompt` 那侧，这里**不重算一份** —— 两处各算一遍
 *                    正是「同一个上限有两个真相」的来路
 */
export function buildImagePromptInput(
  marker: Pick<SceneImageMarker, 'bodyText' | 'characters'>,
  messageText: string,
  location: string | undefined,
  rating: ImageRating,
): ImagePromptRequest {
  // 🔴 正文必须**剥掉全部标记**：`<combat_trigger>` / `<craft_request>` / 别的
  //    `<scene_image>` 混进去，只会让侧链把标记里的字当成场景描写画出来。
  //    走 `stripMarkers`（= `scanMarkers().cleanText`），不另写第二个剥离器。
  const narrative = stripMarkers(messageText).trim();

  const request: ImagePromptRequest = {
    intent: marker.bodyText.trim(),
    // 原样、不去重、不排序 —— 与 `composePrompt` 的角色槽顺序保持同一份来源（D30）
    characters: [...marker.characters],
    narrative,
    rating,
  };
  // 空地点名与「没有地点」是一回事，都别占位（`ImagePromptRequest.location` 是可选的）
  if (location !== undefined && location.trim() !== '') request.location = location.trim();
  return request;
}

// ═══════════════════════════════════════════════════════════
// ② 中间那次调用（尚未接线）
// ═══════════════════════════════════════════════════════════

/**
 * 侧链那一次 LLM 调用的**注入缝**。
 *
 * 形状刻意只有「请求进、模型原文出」：装配与抽取都在本文件的纯函数里，
 * 于是实现方只需要负责 I/O（选 API 池 / 拼上下文模板 / 重试 / 取消）。
 *
 * TODO(G 阶段): 实现方住在调用侧（`scene-image-store`），照既有侧链的样子
 * 走 `agent-orchestrator` 的普通补全（**非 Agentic**，不需要工具调用，§8.5）。
 * 串起来的顺序是：`checkQuota`（🔴 在侧链**之前**，D32）→ `buildImagePromptInput`
 * → 本调用 → `parseImagePromptOutput`；调用抛错与抽取失败**都**降级成
 * `errorKind: 'prompt-agent'`，到此为止，不发 NAI。
 */
export type ImagePromptAgentCall = (
  request: ImagePromptRequest,
  signal?: AbortSignal,
) => Promise<string>;

// ═══════════════════════════════════════════════════════════
// ③ 输出抽取
// ═══════════════════════════════════════════════════════════

/** `parseImagePromptOutput` 的产出。失败分支直接复用 `ImageGenFailure`（§12.2 的一行） */
export type ImagePromptParseResult = { ok: true; value: ImagePromptOutput } | ImageGenFailure;

/** §12.2：「侧链失败/抽不到标签」那一行的文案与可重试性 */
const PROMPT_AGENT_MESSAGE = '提示词生成失败了，点重试；或自己写一份';

/** `detail` 只进 console 与记录，不进 UI —— 截一段够排查即可 */
const DETAIL_MAX = 300;

/** 三个标签名。抽取时互为**边界**（模型漏写闭合标签时靠它们收尾） */
const IMAGE_TAGS = ['image_prompt', 'image_negative', 'image_desc'] as const;

/**
 * 属性段：`"…"|'…'|[^>"']` 逐段吞，于是属性值里的 `>` 不会被当成标签结束。
 * 与 `marker-protocol` 的扫描器同口径（模型偶尔会写成 `<image_prompt lang="en">`）。
 */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*?`;

/** 任意一个已知标签的开标签 —— 无闭合时用它当右边界 */
const ANY_OPEN = new RegExp(`<(?:${IMAGE_TAGS.join('|')})${ATTRS}>`, 'gi');

/**
 * 抽出 `<tag>…</tag>` 的正文。找不到返回 `undefined`。
 *
 * 两条与 `story-rescue.ts` 同源的经验：
 *
 * ① **取最后一个有内容的**。模型爱在答案前面写一段废话（"好的，我来把这个场景
 *    转换成标签："），而废话里常常连格式一起复述一遍（"用 <image_prompt> 包裹"）。
 *    锚在最后一处，前面的复述就伤不到抽取 —— `story-rescue` 的「最后一个 `<maintext`」
 *    就是这条。
 *
 * ② **漏写闭合标签也认**。没有 `</tag>` 时右边界取「下一个已知开标签」或文末。
 *    这不是猜内容，是宽松地读一个**确实存在**的标签（`marker-protocol` 的
 *    `lenientClosing` 同一口径）；标签压根不在时仍然返回 `undefined`。
 */
function extractTag(text: string, tag: string): string | undefined {
  const open = new RegExp(`<${tag}${ATTRS}>`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'i');
  let found: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = open.exec(text)) !== null) {
    const from = m.index + m[0].length;
    const rest = text.slice(from);

    const closeMatch = close.exec(rest);
    let end = closeMatch === null ? rest.length : closeMatch.index;
    if (closeMatch === null) {
      // 无闭合：收在下一个已知开标签之前（没有就收到文末）
      ANY_OPEN.lastIndex = 0;
      const next = ANY_OPEN.exec(rest);
      if (next !== null) end = next.index;
    }

    const body = rest.slice(0, end).trim();
    if (body !== '') found = body; // 后面的覆盖前面的 → 天然取最后一个有内容的
  }
  return found;
}

/**
 * 把 `image_prompt` 的模型原文抽成 `ImagePromptOutput`。
 *
 * 🔴 **抽不到 `<image_prompt>`（或它归一化之后是空串）就是明确失败**
 * （`errorKind: 'prompt-agent'`，§8.5）。**不猜、不用启发式兜一个出来** ——
 * 没有一条"从最后一个冒号后面截"之类的兜底路径，这是设计要求不是遗漏：
 * 猜出来的标签串会静默画出一张莫名其妙的图，而失败态给的是「重试 / 自己写一份」
 * 两条看得见的出路（D42）。
 *
 * `<image_negative>` 与 `<image_desc>` 缺失是**正常的**（前者通常本来就空），
 * 各自退化成空串，不影响成功判定。
 */
export function parseImagePromptOutput(raw: string): ImagePromptParseResult {
  const text = raw ?? '';

  // 🔴 两个 danbooru 串都要过归一化（D27）——
  //    模型工作在中文语境里，全角逗号会让整串被当成一个巨型标签。
  const scenePrompt = normalizeTagString(extractTag(text, 'image_prompt') ?? '');
  if (scenePrompt === '') {
    return {
      ok: false,
      kind: 'prompt-agent',
      message: PROMPT_AGENT_MESSAGE,
      detail: text.trim().slice(0, DETAIL_MAX),
      retryable: true,
    } satisfies ImageGenFailure;
  }

  const sceneNegative = normalizeTagString(extractTag(text, 'image_negative') ?? '');
  // desc 是**中文副标题**，不是标签串 —— 走 sanitizeCaption（收敛+截断），
  // 绝不过 normalizeTagString（那会把中文标点改坏）
  const desc = sanitizeCaption(extractTag(text, 'image_desc'), CAPTION_DESC_MAX);

  return { ok: true, value: { scenePrompt, sceneNegative, desc } };
}
