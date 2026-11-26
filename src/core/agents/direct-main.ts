/**
 * direct-main.ts — 直出单次主请求的编排：整轮取一次开关 → 组装（direct-request.ts）→
 * 发送与空正文重发（direct-send.ts）→ 解析 → 告警与写入统计（direct-write-stats.ts）。
 * 失败时按「模型是否已回复」处置缓存会话，并把本次结果包进 DirectTurnError。
 */
import {
  discardDirectContext,
  invalidateDirectContext,
  type DirectCacheTicket,
} from '../prompts/direct-context-session';
import type { AgentResult } from '../types/types';
import type { AgentClient } from './agent-client';
import { parseDirectOutput, type DirectTurnDraft } from './direct-output';
import { isDirectStructuredCombatEnabled } from '../combat/direct-combat';
import { logEngine } from '../runtime/engine-logger';
import { getEngineSettings } from '../runtime/engine-settings';
import { rollDirectDice } from './direct-dice';
import { buildDirectRequest, type DirectGenerationInput } from './direct-request';
import { sendDirectTurn, type DirectSendState } from './direct-send';
import {
  logStateWriteStats,
  rejectedStateWrites,
  summarizeStateWrites,
} from './direct-write-stats';

export type { DirectGenerationInput } from './direct-request';

/**
 * 直出主请求已拿到模型回复、但随后失败（输出被拒或 provider 返回 error 结果）。
 * 携带本次 `AgentResult` 供调试记录使用；`original` 是原始错误，调用方记录后应重新抛出它。
 */
export class DirectTurnError extends Error {
  readonly result: AgentResult;
  readonly original: unknown;

  constructor(original: unknown, result: AgentResult) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'DirectTurnError';
    this.result = result;
    this.original = original;
  }
}

export async function generateDirectTurn(
  input: DirectGenerationInput,
  client: AgentClient,
): Promise<{
  draft: DirectTurnDraft;
  result: AgentResult;
  cache?: { ticket: DirectCacheTicket };
}> {
  const { config, context } = input;
  // 开关整轮只取一次：协议、读侧投影、缓存分区与写侧解析必须同一口径；随草稿带到接纳与统计
  const structuredCombat = isDirectStructuredCombatEnabled();
  const stateProtocol = getEngineSettings().stateProtocol;
  const dice = input.dice ?? rollDirectDice();
  const { request, ticket } = await buildDirectRequest(input, {
    structuredCombat,
    stateProtocol,
    dice,
  });
  const sent: DirectSendState = { rejected: false };
  try {
    const result = await sendDirectTurn(
      client,
      request,
      config,
      { cached: !!input.cache, ...(ticket ? { ticket } : {}) },
      sent,
    );
    sent.rejected = true;
    let draft: DirectTurnDraft;
    try {
      draft = parseDirectOutput(result.rawResponse, dice, {
        structuredCombat,
        plotEnabled: context.plotSettings?.mode !== 'off',
        stateProtocol,
      });
    } catch (error) {
      // 整楼拒收（§7.1）：本楼只记这一条统计；被接纳的楼由调用方在建补丁后补全并记日志
      result.stateWriteStats = rejectedStateWrites(stateProtocol);
      logStateWriteStats(result.stateWriteStats, request.model ?? '');
      throw error;
    }
    // 解析期的初步统计；建补丁阶段的丢弃与纠正由调用方经 summarizeStateWrites 补全
    result.stateWriteStats = summarizeStateWrites(stateProtocol, draft);
    // 丢弃项随结果进调试记录（DebugAgentEntry.outputWarnings），UI 在接纳后汇总提示
    if (draft.dropped) result.outputWarnings = [...draft.dropped];
    logDraftWarnings(draft, result.finishReason);
    return {
      draft,
      result,
      ...(ticket ? { cache: { ticket } } : {}),
    };
  } catch (error) {
    if (ticket) {
      // 模型已回复但输出被拒绝，或本次被取消：存档未变，上一份已接纳会话仍可复用，只丢弃本次尝试。
      // 供应商/传输失败可能源自会话本身（如原生签名失效），整体失效让下一次冷建自愈。
      if (sent.rejected || config.abortSignal?.aborted) discardDirectContext(ticket);
      else invalidateDirectContext(ticket.saveId);
    }
    // 模型已回复（被拒或 provider 返回 error 结果）：带上本次结果，供调试记录保留原文与请求消息。
    // 取消时原样抛出，下游靠原始错误判定取消。
    if (sent.result && !config.abortSignal?.aborted) throw new DirectTurnError(error, sent.result);
    throw error;
  }
}

/** 解析期草稿的五路告警（各一条 warn，payload 惰性求值） */
function logDraftWarnings(draft: DirectTurnDraft, finishReason: string | undefined): void {
  const warn = (event: string, message: string, payload?: () => unknown) =>
    logEngine('warn', event, message, payload, { agentId: 'direct_main' });
  if (draft.combatIgnored)
    warn('direct.combat_ignored', '结构化战斗未启用，已忽略模型输出的 combat 区块');
  if (draft.flattenedCharacters)
    warn(
      'direct.entity_flattened',
      `角色实体字段未放进 output.character，已自动归位：${draft.flattenedCharacters.join('、')}`,
    );
  const { normalized, dropped } = draft;
  if (normalized)
    warn(
      'direct.output_normalized',
      `直出结果形状有偏差，已自动纠正 ${normalized.length} 处`,
      () => ({ notes: normalized }),
    );
  if (dropped)
    warn('direct.output_dropped', `直出结果有 ${dropped.length} 项格式有误，已忽略`, () => ({
      notes: dropped,
    }));
  if (draft.updatesMissing)
    warn('direct.updates_missing', '直出结果没有 direct_updates 区块，本楼只保存正文', () => ({
      finishReason: finishReason ?? null,
    }));
}
