/**
 * image-prompt-agent.ts — `image_prompt` 侧链的两个纯函数（设计 §8.5 / D28）
 *
 * 侧链一共三步：
 *   ① `buildImagePromptInput`  —— 标记 + 所属消息 → `ImagePromptRequest`（纯函数，本文件）
 *   ② `callImagePromptAgent`   —— 唯一有 I/O 的一步（G 阶段接线，本文件）
 *   ③ `parseImagePromptOutput` —— 模型原文 → `ImagePromptOutput` 或明确失败（纯函数，本文件）
 *
 * 🔴 **两端都是纯函数**，中间那次调用是唯一的 I/O —— 于是抽取逻辑照样可测（设计 §13）。
 *    本文件**不 import** `agent-client` / Dexie / DOM 里的任何东西，别顺手加：
 *    ② 只经 `agent-templates` 装配消息，真正的 HTTP 客户端由 `deps.clientFactory`
 *    从外面交进来（`char-gen-agent` 的 `CharGenClient` 同一形状）。
 *    图像 v1.4 起多 import 了 `agent-tools`（工具 schema + 纯查询分发器）与
 *    `image-tag-bank`（纯函数），两者都不做 I/O —— **词库本身由调用方从 Dexie 读好
 *    经 `tagBank` 交进来**，这条边界一寸没退。
 *
 * 🔴 `normalizeTagString` 从 `image-prompt.ts` import —— 那是全仓唯一一份（D27）。
 *    这里**绝不另抄一份**。
 */

import { buildAgentMessagesAsync } from './agent-templates';
import { executeToolCall, getToolsForAgent } from './agent-tools';
import { formatTagBankCatalogue } from './image-tag-bank';
import { normalizeTagString } from './image-prompt';
import { APPEARANCE_PROMPT_RULES, parseCharacterAppearances } from './character-appearance-agent';
import { CAPTION_DESC_MAX, sanitizeCaption, stripMarkers } from './marker-protocol';
import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  ApiEndpoint,
  ToolDefinition,
  WorldBook,
} from './types';
import type {
  ImageGenFailure,
  ImagePromptOutput,
  ImagePromptRequest,
  ImageRating,
  SceneImageMarker,
  TagBankEntry,
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
// ② 中间那次调用
// ═══════════════════════════════════════════════════════════

/**
 * 侧链那一次 LLM 调用的**注入缝**。
 *
 * 形状刻意只有「请求进、模型原文出」：装配与抽取都在本文件的纯函数里，
 * 于是实现方只需要负责 I/O（选 API 池 / 拼上下文模板 / 重试 / 取消）。
 *
 * 生产实现是下面的 {@link callImagePromptAgent}；测试里换成一个返回定值的函数即可。
 */
export type ImagePromptAgentCall = (
  request: ImagePromptRequest,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * 侧链客户端 —— `AgentClient` 的**最小子集**。
 *
 * 🔴 **`chat` 必备，`chatWithTools` 按需**（图像 v1.4 修订）。
 *
 * 此处原本写着「image_prompt 是普通补全，非 Agentic —— 它不查库、不掷骰、不写状态，
 * 没有一件事需要工具调用」。**标签词库让第一句不再成立**：用户导入的几千条中文→标签
 * 映射装不进一次提示词，检索模型是「AI 看目录 → 调工具取标签 → 自己组装」（用户裁定，
 * 2026-08-05）。那句话的其余部分仍然有效 —— 词库工具是**纯查询**，不掷骰、不写状态、
 * 不花钱，白名单里也只有这两口（见 `AGENT_TOOL_MAP.image_prompt` 的注释）。
 *
 * 没导入词库时**一个字都不变**：`callImagePromptAgent` 走原来的单次 `chat`，
 * 既不发工具 schema 也不多跑一轮。所以 `chatWithTools` 是可选的 ——
 * 老的测试替身与任何只实现 `chat` 的客户端继续能用。
 */
export interface ImagePromptClient {
  chat(
    request: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
    },
    signal?: AbortSignal,
  ): Promise<{ output: string | null; rawResponse: string; error?: string }>;
  /** 有词库时走这一口（多轮 function calling）。缺席 → 自动退回 `chat` */
  chatWithTools?(
    request: {
      model?: string;
      messages: Array<{ role: string; content: string }>;
      tools: ToolDefinition[];
      tool_choice: string;
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
    },
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    options: { maxRounds: number; signal?: AbortSignal },
  ): Promise<{ output: string | null; rawResponse: string; error?: string }>;
}

/** 侧链一次调用的全部输入。`configs`/`worldBooks`/`presets` 缺席 = systemPrompt 退化成 stub */
export interface ImagePromptChainRequest {
  saveId: string;
  /** `buildImagePromptInput` 的产出（或 store 从记录里重建的等价物） */
  request: ImagePromptRequest;
  /** 装配上下文。世界书/占位符都从这里取 */
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 🔴 真机教训（char-gen 2026-07-17）：这三个不透传，systemPrompt 会退化成一行 stub */
  configs?: AgentConfig[];
  worldBooks?: WorldBook[];
  presets?: AgentPreset[];
  /**
   * 标签词库（图像 v1.4）—— **已由调用方从 Dexie 读好、且已过两层启用开关**
   * （`image-tag-bank.collectEnabledEntries`）。
   *
   * 缺席或空数组 = 用户没导入词库 → 侧链走原来的单次补全，行为与 v1.3 逐字相同。
   */
  tagBank?: TagBankEntry[];
  /** 切存档 / 离开页面时取消（§8.2） */
  signal?: AbortSignal;
}

export interface ImagePromptAgentDeps {
  /** 每次调用建新实例（缓存隔离），与 `char-gen-agent` 同口径 */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => ImagePromptClient;
}

/** rating 在提示词里的中文说明 —— **只作上下文**，标签由 Code 追加（§5.2） */
const RATING_LABEL: Record<ImageRating, string> = {
  general: '全年龄',
  sensitive: '轻微敏感',
  questionable: '较敏感',
  explicit: '成人向',
};

/**
 * `ImagePromptRequest` → 注进 `{{IMAGE_REQUEST}}` 的那段文本（**纯函数**）。
 *
 * 🔴 正文放在最后。前面几行是短字段，正文可能上千字 —— 短的在前读起来才不费劲，
 * 也让「这段是正文」这件事不必靠标点去猜。
 */
export function formatImagePromptRequest(req: ImagePromptRequest): string {
  const lines: string[] = [`画面意图: ${req.intent.trim()}`];
  if (req.characters.length > 0) lines.push(`出场角色: ${req.characters.join('、')}`);
  if (req.location !== undefined && req.location.trim() !== '') {
    lines.push(`当前地点: ${req.location.trim()}`);
  }
  lines.push(`分级: ${RATING_LABEL[req.rating]}`);
  const narrative = req.narrative.trim();
  if (narrative !== '') lines.push(`所属正文:\n${narrative}`);
  if (req.charactersNeedingBaseline?.length) {
    // D57：模型看不到库，「谁是第一次出场」只能由引擎告诉它
    lines.push(
      `尚无外观设定的角色（请为他们写全九个槽）: ${req.charactersNeedingBaseline.join(', ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * 侧链的那一次调用：装消息 → `chat` → 抽三个标签。
 *
 * 调用顺序（🔴 `checkQuota` 在**本函数之前**，D32 —— 两处花钱，闸门要在最前面）：
 * `checkQuota` → `buildImagePromptInput` → **本函数** → `parseImagePromptOutput`。
 *
 * 🔴 **本函数不抛错**。网络挂了、模板没注册、模型只写了废话 —— 一律降级成
 * `errorKind: 'prompt-agent'` 的失败值，到此为止**不发 NAI**（§8.5）。理由是
 * 上游 `scene-image-store` 的泵不该因为一张图的侧链而停摆，而失败态本身给了
 * 「重试 / 自己写一份」两条看得见的出路（D42）。
 */
export async function callImagePromptAgent(
  req: ImagePromptChainRequest,
  deps: ImagePromptAgentDeps,
): Promise<ImagePromptParseResult> {
  let raw: string;
  try {
    // 词库目录（图像 v1.4）。空词库 → 空串 → 模板里那一段整个不出现，
    // 且下面不会挂工具 —— 没导入词库的用户付的 token 与 v1.3 一模一样。
    const tagBank = req.tagBank ?? [];
    const catalogue = tagBank.length > 0 ? formatTagBankCatalogue(tagBank) : '';

    const messages = await buildAgentMessagesAsync(
      'image_prompt',
      req.context,
      req.configs,
      req.worldBooks,
      req.presets,
      { IMAGE_REQUEST: formatImagePromptRequest(req.request), IMAGE_TAG_BANK: catalogue },
    );
    if (!messages) {
      return agentFailure('image_prompt 模板未注册（AGENT_TEMPLATES / DEFAULT_TEMPLATES）');
    }

    // 🔴 外貌上报规则在**装配期**追加，不写进 `agent-config.json`（D56）：
    //    格式的定义与解析器必须同源，否则会出现「提示词教它写 A、解析器只认 B」
    //    那种静默失效 —— 用户看到的只是外貌永远不更新，没有任何报错。
    //    追加在 system 消息末尾；没有 system 消息时补一条（模板理论上一定有）。
    const systemIndex = messages.findIndex((m) => m.role === 'system');
    if (systemIndex >= 0) {
      messages[systemIndex] = {
        ...messages[systemIndex],
        content: `${messages[systemIndex].content}

${APPEARANCE_PROMPT_RULES}`,
      };
    } else {
      messages.unshift({ role: 'system', content: APPEARANCE_PROMPT_RULES });
    }

    const config = req.configs?.find((c) => c.agentId === 'image_prompt');
    const client = deps.clientFactory('image_prompt', req.endpoint, req.saveId);

    const baseRequest = {
      // 空串会让下游把它当成"显式指定了空模型"，一律退回 endpoint 的默认模型
      ...(config?.model ? { model: config.model } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(config === undefined
        ? {}
        : {
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            topP: config.topP,
            frequencyPenalty: config.frequencyPenalty,
            presencePenalty: config.presencePenalty,
          }),
    };

    // 🔴 只有**同时**满足「有词库」与「客户端支持工具」时才走多轮：
    //    少了任一条都退回单次补全，而不是报错。这条链每张图都要跑，
    //    为一个可选的增强让整张图失败是把「没有词库」升级成「没有图」。
    const useTools = tagBank.length > 0 && typeof client.chatWithTools === 'function';

    const result = useTools
      ? await client.chatWithTools!(
          { ...baseRequest, tools: getToolsForAgent('image_prompt'), tool_choice: 'auto' },
          async (name, args) =>
            executeToolCall(name, args as Record<string, unknown>, {
              // 词库以外的上下文这条链一概用不上（白名单里只有两口查询工具），
              // 给空值即可 —— 塞真角色数据反而给了模型一条编数值的路
              characters: [],
              variables: {},
              saveId: req.saveId,
              tagBank,
            }),
          // 取标签通常一轮就够（一次 get_image_tags 传多个名字）；给到 4 轮是留给
          // 「先 search 没找到、换个词再 search」这类来回，同时挡住无限循环
          { maxRounds: 4, ...(req.signal ? { signal: req.signal } : {}) },
        )
      : await client.chat(baseRequest, req.signal);

    if (result.error) return agentFailure(result.error);
    raw = result.output ?? result.rawResponse;
  } catch (e) {
    return agentFailure(e instanceof Error ? e.message : String(e));
  }

  return parseImagePromptOutput(raw);
}

/** 调用侧的失败（网络/模板/异常）—— 与抽取失败同一个 `kind`，UI 只有一种文案 */
function agentFailure(detail: string): ImageGenFailure {
  return {
    ok: false,
    kind: 'prompt-agent',
    message: PROMPT_AGENT_MESSAGE,
    detail: detail.slice(0, DETAIL_MAX),
    retryable: true,
  };
}

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

  // 外貌上报（D56/D57）：抽不到就是空数组，**不影响本次成功与否** ——
  // 它是锦上添花，为一个畸形的附加块让整张图失败是把「少件衣服」升级成「没有图」。
  const appearances = parseCharacterAppearances(text);

  return {
    ok: true,
    value: { scenePrompt, sceneNegative, desc, ...(appearances.length ? { appearances } : {}) },
  };
}
