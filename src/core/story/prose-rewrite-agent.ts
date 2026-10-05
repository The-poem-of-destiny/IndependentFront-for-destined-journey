/**
 * prose-rewrite-agent.ts — 「正文润色」侧链（手动触发，Phase 文档见根 AGENTS.md）。
 *
 * 与其它侧链（image_prompt / entity_gen）同一形状：装配与抽取**两端都是纯函数**，
 * 中间那次 LLM 调用是唯一的 I/O（客户端由 `deps.clientFactory` 从外面交进来）。
 *
 * 🔴 它**不是普通补全**：走 DeepSeek beta 的**前缀续写**——
 *   最后一条 assistant 消息带 `prefix: true`（`content` 为空），模型从那里往后续写；
 *   `reasoning_content` 是思维链前缀种子。因此真正的改写指令放 system、待改写正文放 user，
 *   且调用时强制 `thinking.enabled` + `reasoning_effort=max`（见 `EXTRA_BODY`）。
 *
 * 🔴 本文件不含任何世界观/小说内容（内容-引擎分离）。真实文风提示词由内容包下发，
 *   经 agent-config.json 的 `prose_rewrite.systemPrompt` 注入；这里的兜底提示词是通用版。
 *
 * 不走主 DAG：由玩家在最新一条正文上手动触发（ChatFlow 右键「润色正文」）。
 */

import type { AgentConfig, ApiEndpoint } from '../types/types';
import type { JsonObject, LlmMessage } from '../types/types-api';

/** 侧链 agent id（与 agent-config.json / agent-templates.ts / game-store 一致） */
export const PROSE_REWRITE_AGENT_ID = 'prose_rewrite';

/**
 * assistant 前缀的思维链种子（DeepSeek beta 前缀续写）。
 *
 * 🔴 通用、无内容 IP：只负责把模型引进「先分析、再重写」的思维链，
 *    具体文风规范一律来自 system 提示词（内容包）。
 */
export const PROSE_REWRITE_PREFIX_SEED = '思考过程：\n\n1. 分析系统要求以及用户输入：\n\n';

/** 强制开启 DeepSeek 思考模式 + 高推理强度（前缀续写的默认行为，不依赖 API 源配置）。 */
export const PROSE_REWRITE_EXTRA_BODY: JsonObject = {
  thinking: { type: 'enabled' },
  reasoning_effort: 'max',
};

/** 兜底提示词：agent-config 缺 systemPrompt 时用（通用、无世界观/小说内容）。 */
export const PROSE_REWRITE_FALLBACK_PROMPT = [
  '你是一名中文文风编辑。你的任务是改写用户给出的一段小说正文，使其文风更凝练、节奏更好。',
  '',
  '工作流程：',
  '1. 先通读原文，逐段理解它真正想表达的内容、用了哪些比喻与修辞，识别哪些是有实在信息的部分。',
  '2. 删除不必要的环境堆砌、过度比喻与重复修饰。',
  '3. 保留原文的专有名词、人称，以及结构化格式（括号、代码块、HTML 等一律原样保留）。',
  '4. 按系统给定的文风规范重写，不要沿用原文的坏文风。',
  '',
  '输出要求：只输出改写后的正文本身，不要解释、不要开场白、不要 Markdown 代码块或任何标签。',
].join('\n');

/**
 * 装配侧链的三条消息（纯函数）：
 *   system    = 改写提示词（内容包下发）
 *   user      = 待改写的正文
 *   assistant = 空前缀 + `prefix: true` + 思维链种子（模型从这里往后续写）
 */
export function buildProseRewriteMessages(
  systemPrompt: string,
  bodyText: string,
  prefixSeed: string = PROSE_REWRITE_PREFIX_SEED,
): LlmMessage[] {
  const system = systemPrompt.trim() || PROSE_REWRITE_FALLBACK_PROMPT;
  return [
    { role: 'system', content: system },
    { role: 'user', content: bodyText },
    { role: 'assistant', content: '', prefix: true, reasoning_content: prefixSeed },
  ];
}

const LEADING_FENCE = /^\s*```[^\n]*\n?/;
const TRAILING_FENCE = /\n?\s*```\s*$/;

/**
 * 从模型原文里取改写后的正文：剥代码围栏 + trim。
 *
 * 🔴 **不做启发式猜测**（照 image-prompt-agent 的口径）：模型只被要求输出正文本身，
 *    抽到的空串就是明确失败，由调用方报错，绝不从「最后一个冒号之后」之类的地方截。
 */
export function extractProseRewriteOutput(raw: string): string {
  return (raw ?? '').replace(LEADING_FENCE, '').replace(TRAILING_FENCE, '').trim();
}

/**
 * 侧链客户端 —— `AgentClient` 的**最小子集**（只要 `chat`）。
 *
 * 🔴 消息类型是 `LlmMessage[]`（而非 image_prompt 的 `{role,content}`）：前缀续写
 *    必须把 `prefix` / `reasoning_content` 透传到请求体，窄化成两字段就丢了这两样。
 */
export interface ProseRewriteClient {
  chat(
    request: {
      model?: string;
      messages: LlmMessage[];
      temperature?: number;
      maxTokens?: number;
      topP?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      extraBody?: JsonObject;
    },
    signal?: AbortSignal,
  ): Promise<{ output: string | null; rawResponse: string; error?: string }>;
}

/** 侧链一次调用的全部输入。`config` 缺席时 systemPrompt 走兜底、采样参数交给源默认。 */
export interface ProseRewriteChainRequest {
  saveId: string;
  /** 待改写正文（最新一条 assistant 消息的投影正文） */
  bodyText: string;
  endpoint: ApiEndpoint;
  /** 该 Agent 的运行时配置（systemPrompt + 采样参数 + model） */
  config?: AgentConfig;
  /** 覆盖思维链前缀种子（优先级低于 `config.tailPrompt`） */
  prefixSeed?: string;
  signal?: AbortSignal;
}

export interface ProseRewriteAgentDeps {
  /** 每次调用建新实例（缓存隔离），与 image_prompt / entity_gen 同口径 */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => ProseRewriteClient;
}

export type ProseRewriteResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * 侧链的那一次调用：装消息 → `chat`（带前缀续写 + 思考模式）→ 抽正文。
 *
 * 🔴 **本函数不抛错**：网络挂了、模型只写废话 —— 一律降级成 `{ok:false}`，
 *    由调用方（GamePipeline）转成活动账本错误 + toast，不阻断界面。
 */
export async function callProseRewriteAgent(
  req: ProseRewriteChainRequest,
  deps: ProseRewriteAgentDeps,
): Promise<ProseRewriteResult> {
  const bodyText = req.bodyText.trim();
  if (!bodyText) return { ok: false, error: '没有可改写的正文' };

  try {
    // 思维链前缀种子优先级：内容包经该 Agent 的 `tailPrompt` 下发 > 调用方入参 >
    // 引擎通用默认（`buildProseRewriteMessages` 的第二默认参数）。
    const configSeed = req.config?.tailPrompt?.trim();
    const messages = buildProseRewriteMessages(
      req.config?.systemPrompt ?? '',
      bodyText,
      configSeed || req.prefixSeed,
    );
    const config = req.config;
    const client = deps.clientFactory(PROSE_REWRITE_AGENT_ID, req.endpoint, req.saveId);
    const result = await client.chat(
      {
        ...(config?.model ? { model: config.model } : {}),
        messages,
        ...(config === undefined
          ? {}
          : {
              temperature: config.temperature,
              maxTokens: config.maxTokens,
              topP: config.topP,
              frequencyPenalty: config.frequencyPenalty,
              presencePenalty: config.presencePenalty,
            }),
        extraBody: PROSE_REWRITE_EXTRA_BODY,
      },
      req.signal,
    );
    if (result.error) return { ok: false, error: result.error };

    const text = extractProseRewriteOutput(result.output ?? result.rawResponse ?? '');
    if (!text) return { ok: false, error: '模型没有产出可用的正文' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
