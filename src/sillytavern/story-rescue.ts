/**
 * Story 正文救援模块
 *
 * 修正两类 AI 输出缺陷（仅对 story agent 生效）：
 *
 * 1. 【正文吞进思维链】(raw 空)
 *    AI 把 <maintext> 正文写进了 reasoning_content 通道，content 通道为空。
 *    → 从 reasoning 最后一个 '<maintext' 起截取到末尾，塞回 rawResponse。
 *
 * 2. 【思维链泄漏进正文】(raw 非空)
 *    AI 把思维链文字写进了 content 通道（先"首先确认..."再写正文）。
 *    → 截掉 rawResponse 中最后一个 '<maintext' 之前的全部内容。
 *
 * 设计要点：
 * - 两类都以「最后一个 <maintext」为锚点，避免思维链前部对格式的提及
 *   （如 "用 <maintext> 包裹"）被误判为正文起点。
 * - 场景 1 的 raw 空门控保证正常轮（rawResponse 有值）完全不受影响。
 * - 场景 2 仅在 rawResponse 含 <maintext 且不在开头时才截；裸正文（无标签）不动。
 *
 * 流式局限：本模块只修正最终 AgentResult，不重写流式过程中已推给前端的
 * onChunk 增量。场景 1 流式时前端会短暂空白，场景 2 流式时前端会先看到
 * 泄漏的思维链，待流结束后以最终 result 重渲染修正。
 */

import type { AgentResult } from './types';

/** 开头的代码块围栏（可能带语言标识如 ```xml） */
const LEADING_FENCE = /^\s*```[^\n]*\n?/;
/** 结尾的代码块围栏 */
const TRAILING_FENCE = /\n?\s*```\s*$/;

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
    result.rawResponse = rescued;
    result.output = rescued;
    return true;
  }

  // ===== 场景 2: 思维链泄漏进正文（raw 非空，<maintext> 不在开头）=====
  const idx = lastMaintextIndex(raw);
  // -1 = 无标签（裸正文，不动）；0 = 已在最开头（无需截）
  if (idx <= 0) return false;
  const rescued = stripCodeFences(raw.slice(idx));
  if (!rescued) return false;
  result.rawResponse = rescued;
  result.output = rescued;
  return true;
}
