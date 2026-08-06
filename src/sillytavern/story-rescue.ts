/**
 * Story 正文救援模块
 *
 * 修正若干 AI 输出缺陷（仅对 story agent 生效）：
 *
 * 1. 【正文吞进思维链】(raw 空)
 *    AI 把 <maintext> 正文写进了 reasoning_content 通道，content 通道为空。
 *    → 从 reasoning 最后一个 '<maintext' 起截取到末尾，塞回 rawResponse。
 *
 * 2. 【思维链泄漏进正文】(raw 非空，<maintext> 不在开头)
 *    AI 把思维链文字写进了 content 通道（先"首先确认..."再写正文）。
 *    → 截掉 rawResponse 中最后一个 '<maintext' 之前的全部内容。
 *
 * 3. 【思维链混进 <maintext> 内部】(<maintext> 在开头，但内部正文前有计划块)
 *    AI 不开 <thinking>、不走 reasoning 通道，把计划写进 <maintext> 内部，
 *    用独占一行的 --- 把"计划"与"正文"隔开。
 *    → 剥掉顶部命中思维链元语言的 --- 分隔块。
 *
 * 4. 【CoT 思考注释残留】
 *    世界书 cot 协议教 AI 在 <item_info>/<task_info> 前强制写
 *    <!-- itemThink/taskThink/charThink/actionThink: ... -->。这些是给模型看
 *    的思考，不应进正文展示 → 剥掉所有 <!-- \w*Think... --> 注释。
 *
 * 设计要点：
 * - 场景 1/2 都以「最后一个 <maintext」为锚点，避免思维链前部对格式的提及
 *   （如 "用 <maintext> 包裹"）被误判为正文起点。
 * - 场景 3 只剥 --- 分隔且命中思维链元语言的块；顶部第一个块就是正文时不动。
 * - 场景 1 的 raw 空门控保证正常轮（rawResponse 有值）完全不受影响。
 * - 场景 2 仅在 rawResponse 含 <maintext 且不在开头时才截；裸正文（无标签）不动。
 *
 * 流式边界：本模块只修正最终 AgentResult，不改传输层的 onChunk 增量。
 * GamePipeline 会把累计原文交给 story-output 投影；`<maintext>` 到达前的内容会缓冲，
 * 到达后只显示正文。场景 1 的正文仍要等最终救援后才可见。
 */

import type { AgentResult } from './types';

/** 开头的代码块围栏（可能带语言标识如 ```xml） */
const LEADING_FENCE = /^\s*```[^\n]*\n?/;
/** 结尾的代码块围栏 */
const TRAILING_FENCE = /\n?\s*```\s*$/;

/**
 * 思维链元语言 —— 只会出现在模型的思维链/计划里，正文叙事绝不含这些词。
 * 用于检测 <maintext> 内部、正文前的"思维链泄漏"（场景 3）。
 */
const THINKING_PLAN_PATTERNS: readonly RegExp[] = [
  /Final step/i,
  /生成思维链/,
  /思维链[\s\S]{0,8}闭合/,
  /闭合[\s\S]{0,6}标签/,
  /开始正文/,
  /开始叙事/,
  // 计划要"生成 <某标签>"——正文叙事里只直接嵌标签，不会写"生成 <标签>"
  /(生成|输出|产出)[^<\n]{0,20}<[a-z_]+\b/,
];

/**
 * 世界书 CoT 协议的思考注释 (<!-- itemThink/taskThink/charThink/actionThink: ... -->)。
 * 模型按 cot 规则在产出实体/任务标签前强制写思考，这些是给模型看的，不应进正文展示。
 */
const COT_THINK_COMMENT = /<!--\s*\w*[Tt]hink\b[\s\S]*?-->/g;

/** 去掉首尾代码块围栏 + 首尾空白 */
function stripCodeFences(text: string): string {
  return text.replace(LEADING_FENCE, '').replace(TRAILING_FENCE, '').trim();
}

/**
 * 找 text 中最后一个 '<maintext' 词边界位置。
 * 用 \b 排除 <maintextual 之类的误匹配；未找到返回 -1。
 */
function lastMaintextIndex(text: string): number {
  let lastIdx = -1;
  const re = /<maintext\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    lastIdx = m.index;
  }
  return lastIdx;
}

/** 判断一个 --- 分隔块是否为思维链/计划（用于场景 3 顶部块剥离） */
function isThinkingPlan(block: string): boolean {
  return THINKING_PLAN_PATTERNS.some((re) => re.test(block));
}

/**
 * 场景 3: 剥掉 <maintext> 内部、正文前的思维链计划块。
 *
 * 模型不开 <thinking>、不走 reasoning 通道，而是把计划写进 <maintext> 标签内部，
 * 用独占一行的 --- 把"计划"和"正文"隔开。本函数从顶部剥掉连续命中思维链元语言
 * 的计划块，保留最后一个非计划块（即正文）。
 *
 * 安全保证：只剥 --- 分隔且命中思维链元语言的块；顶部第一个块就是正文时不动。
 */
function stripThinkingInsideMaintext(text: string): string {
  const open = /^<maintext\b[^>]*>\s*/.exec(text);
  if (!open) return text;
  const after = text.slice(open[0].length);
  // 独占一行的 --- 作为计划/正文分隔符
  const blocks = after.split(/\n\s*---\s*\n/);
  if (blocks.length <= 1) return text;
  let start = 0;
  for (let i = 0; i < blocks.length - 1; i++) {
    if (isThinkingPlan(blocks[i])) start = i + 1;
    else break;
  }
  if (start === 0) return text;
  return open[0] + blocks.slice(start).join('\n---\n');
}

/** 场景 4: 剥 CoT 思考注释 + 整理残留的多余空行 */
function stripCotThinkComments(text: string): string {
  return text
    .replace(COT_THINK_COMMENT, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 原地救援 story 正文。修改 result.rawResponse / result.output。
 * @returns true 表示已改动
 */
export function rescueStoryOutput(result: AgentResult): boolean {
  const raw = (result.rawResponse ?? '').trim();
  const reasoning = result.reasoning ?? '';

  // ===== 场景 1: 正文吞进思维链（raw 空，reasoning 里有 <maintext>）=====
  if (!raw) {
    const idx = lastMaintextIndex(reasoning);
    if (idx < 0) return false;
    const rescued = stripCodeFences(reasoning.slice(idx));
    if (!rescued) return false;
    const cleaned = stripCotThinkComments(stripThinkingInsideMaintext(rescued));
    result.rawResponse = cleaned;
    result.output = cleaned;
    return true;
  }

  // ===== 场景 2/3/4: raw 非空 =====
  const idx = lastMaintextIndex(raw);
  // 裸正文（无 <maintext> 标签）→ 不动（保持既有行为，不误伤无标签输出）
  if (idx < 0) return false;

  // 场景 2: <maintext> 不在开头 → 截掉之前的思维链
  let working = idx > 0 ? stripCodeFences(raw.slice(idx)) : raw;
  // 场景 3: 剥 <maintext> 内部、正文前的思维链计划块
  working = stripThinkingInsideMaintext(working);
  // 场景 4: 剥 CoT 思考注释
  working = stripCotThinkComments(working);

  if (working === raw) return false;
  result.rawResponse = working;
  result.output = working;
  return true;
}
