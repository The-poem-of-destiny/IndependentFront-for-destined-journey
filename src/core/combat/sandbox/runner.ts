/**
 * 战斗沙盒编排（Phase 2 战斗重写）—— 单一 DM Agent 会话
 *
 * 组装「战斗流程 + 协议注入 + 参战表单 + 当前战斗状态」系统提示，绑定战斗工具，
 * 调用一次 `chatWithTools`（多轮工具循环），玩家输入以 user 消息回注续战。
 *
 * 🔴 单一步骤 = 一次 exchange：调用方拿返回的 `transcript` 与 `state`，等玩家输入后
 *    再喂回 `runCombatSandbox`。`runCombatSandboxLoop` 是给「预设一串玩家输入」的便捷壳。
 * 🔴 终局判据 = `state.meta.phase === 'ended'`（AI 用 combat_set_meta 写入）；此时
 *    Code 才把白名单字段转成 StatePatch 写回（见 settlement.ts）。
 */

import type { StatePatch } from '../../types/types';
import type { CharacterState } from '../../types/types';
import { createCombatToolBinding } from './tools';
import {
  buildCombatSettlementPatches,
  type CombatSettlementExtras,
  type SettleableCharacter,
} from './settlement';
import type { CombatOutcome, CombatSandboxMessage, CombatState } from './types';

// ═══════════════════════════════════════════════════════════
// 会话消息 / 客户端契约
// ═══════════════════════════════════════════════════════════

/** 单次 exchange 的客户端返回 */
export interface CombatSandboxClientResult {
  output: string | null;
  rawResponse?: string;
  error?: string;
  toolCalls?: Array<{ name: string; arguments: unknown; result?: unknown }>;
  continuationMessages?: unknown[];
}

/** 战斗沙盒客户端（生产用 AgentClient，测试用 mock） */
export interface CombatSandboxClient {
  chatWithTools?: (
    request: {
      messages: CombatSandboxMessage[];
      tools?: unknown;
      tool_choice?: unknown;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
    options?: { maxRounds?: number; signal?: AbortSignal },
  ) => Promise<CombatSandboxClientResult>;
}

// ═══════════════════════════════════════════════════════════
// 系统提示组装
// ═══════════════════════════════════════════════════════════

/**
 * 战斗主持流程（一条连贯线走完，写进系统提示）。
 * 中文字面量在这里是刻意的：这是给模型的指令面，不是数据面。
 */
export function buildCombatFlowText(): string {
  return [
    '你主持一场战斗：按协议裁决每一次交手，并用工具维护唯一权威的战斗状态。Code 只掷骰与计算，不给结论；结论由你按协议判定后写回状态。',
    '',
    '战斗流程（一条线走完）：',
    '1. 开场：读参战单位面板与协议，宣布战场（环境 / 坐标范围 / 区域），掷先攻后把行动轴写进 combat_set_meta.actionOrder。',
    '2. 战前资源推演：为每个单位确认生命 / 魔力 / 体力上限与当前值；按协议公式推演，必要时用 combat_update_unit 写回。',
    '3. 回合开始：把 combat_set_meta.round 加一，按 actionOrder 逐个结算。',
    '4. 逐单位行动：敌方与 NPC 由你自动决策并结算（掷骰 / 伤害计算走工具）；轮到我方单位时调用 combat_yield_to_player 停下，等待玩家输入。',
    '5. 即时写回：每次伤害 / 资源变化立刻用 combat_update_unit；状态变化用 combat_add_status / combat_remove_status。',
    '6. 状态维护：回合结束时结算持续状态、层数衰减与冷却，用 combat_remove_status / combat_update_unit 落实。',
    '7. 战意：在协议阈值处判定，用 combat_update_unit 写 morale。',
    '8. 终局：一方全灭 / 溃逃 / 投降 / 中止时，用 combat_set_meta 把 phase 置为 "ended" 并写 outcome；随后输出结算总结，不再调用战斗工具。',
    '',
    '禁止自己编造骰值 —— 所有随机一律走 roll_d20 / roll_d100 / roll_dice；所有确定性的公式运算走 calc / calc_damage / calc_initiative。',
  ].join('\n');
}

/** 参战单位速览（名字 / 阵营 / 层级 / 资源 / 战意） */
export function buildCombatRosterText(state: CombatState): string {
  const lines = Object.values(state.units).map((u) => {
    const side = u.side === 'ally' ? '我方' : '敌方';
    return `- ${u.name}（${side} / T${u.tier} / Lv.${u.level}）HP ${u.hp}/${u.maxHp} MP ${u.mp}/${u.maxMp} SP ${u.sp}/${u.maxSp} 战意 ${u.morale}${u.alive ? '' : ' [已倒下]'}`;
  });
  return lines.length > 0 ? lines.join('\n') : '（无参战单位）';
}

/** 组装战斗沙盒系统提示 */
export function assembleCombatSystemPrompt(input: {
  protocolText?: string;
  state: CombatState;
  /** 主持流程正文（agent-config 的 combat.systemPrompt）；缺省用内置 buildCombatFlowText() */
  flowText?: string;
}): string {
  const protocol =
    input.protocolText && input.protocolText.trim().length > 0
      ? input.protocolText.trim()
      : '（未装载战斗协议文本 —— 请仅依据已注入的世界书条目与常识裁决；拿不准就如实留白）';
  const flow =
    input.flowText && input.flowText.trim().length > 0
      ? input.flowText.trim()
      : buildCombatFlowText();
  return [
    '你是本场战斗的主持人（DM）。你读战斗协议、自己裁决结算，并用工具维护权威的战斗状态。',
    `<战斗协议>\n${protocol}\n</战斗协议>`,
    `<战斗流程>\n${flow}\n</战斗流程>`,
    `<参战单位>\n${buildCombatRosterText(input.state)}\n</参战单位>`,
    `<当前战斗状态>\n${JSON.stringify(input.state)}\n</当前战斗状态>`,
  ].join('\n\n');
}

// ═══════════════════════════════════════════════════════════
// 编排
// ═══════════════════════════════════════════════════════════

/** 单次 exchange 入参 */
export interface RunCombatSandboxOpts {
  state: CombatState;
  client: CombatSandboxClient;
  protocolText?: string;
  /** 主持流程正文（agent-config 的 combat.systemPrompt）；缺省用内置流程 */
  systemPrompt?: string;
  /** 既有会话（续战）。空则由 Code 建 system 首条 */
  transcript?: CombatSandboxMessage[];
  /** 本轮玩家输入；缺省 = 开场语 */
  playerInput?: string;
  saveCharacters?: ReadonlyArray<SettleableCharacter>;
  settlementExtras?: CombatSettlementExtras;
  maxRounds?: number;
  signal?: AbortSignal;
  /** 每次工具执行后回调（供持久化 / UI 追加） */
  onToolResult?: (name: string, args: Record<string, any>, result: unknown) => void;
}

/** 单次 exchange 返回 */
export interface CombatSandboxResult {
  state: CombatState;
  output: string;
  ended: boolean;
  awaitingPlayer: boolean;
  outcome?: CombatOutcome;
  patches: StatePatch[];
  transcript: CombatSandboxMessage[];
  error?: string;
}

/**
 * 跑一次战斗沙盒 exchange。
 *
 * 首次调用（无 transcript）会先建 system 消息；之后调用沿用返回的 transcript。
 * 终局时返回的 `patches` 才是写回补丁（未终局恒为空数组）。
 */
export async function runCombatSandbox(opts: RunCombatSandboxOpts): Promise<CombatSandboxResult> {
  const client = opts.client;
  if (typeof client.chatWithTools !== 'function') {
    throw new Error('runCombatSandbox: client 缺少 chatWithTools');
  }

  const binding = createCombatToolBinding(
    opts.state,
    opts.saveCharacters as ReadonlyArray<CharacterState> | undefined,
  );
  const transcript: CombatSandboxMessage[] = opts.transcript ? [...opts.transcript] : [];

  if (transcript.length === 0) {
    transcript.push({
      role: 'system',
      content: assembleCombatSystemPrompt({
        protocolText: opts.protocolText,
        state: binding.getState(),
        flowText: opts.systemPrompt,
      }),
    });
  }
  transcript.push({ role: 'user', content: opts.playerInput ?? '战斗开始。' });

  const result = await client.chatWithTools(
    { messages: transcript, tools: binding.definitions, tool_choice: 'auto' },
    async (name, args) => {
      const toolResult = await binding.execute(name, args);
      opts.onToolResult?.(name, args, toolResult);
      return toolResult;
    },
    { maxRounds: opts.maxRounds ?? 12, signal: opts.signal },
  );

  // 生产路径（AgentClient）把本次工具往返都放进 continuationMessages —— 必须整段续接，
  // 否则下一轮模型看不到自己的工具调用与结果（单据丢失，只能凭空重算状态）。
  const continuation = Array.isArray(result.continuationMessages)
    ? (result.continuationMessages as CombatSandboxMessage[])
    : [];
  if (continuation.length > 0) {
    transcript.push(...continuation);
  } else if (result.output) {
    transcript.push({ role: 'assistant', content: result.output });
  }

  const state = binding.getState();
  const ended = state.meta.phase === 'ended';
  const patches = ended
    ? buildCombatSettlementPatches(state, opts.saveCharacters ?? [], opts.settlementExtras)
    : [];

  return {
    state,
    output: result.output ?? '',
    ended,
    awaitingPlayer: !ended && state.meta.pendingPlayerUnit !== undefined,
    outcome: state.meta.outcome,
    patches,
    transcript,
    error: result.error,
  };
}

/** 预设一串玩家输入自动续战的便捷壳 */
export interface RunCombatSandboxLoopOpts extends Omit<
  RunCombatSandboxOpts,
  'transcript' | 'playerInput'
> {
  /** 依次回注的玩家输入；第一项对应开场（空则用默认开场语） */
  playerInputs?: string[];
}

/**
 * 连续跑多个 exchange，直到终局 / 出错 / 玩家输入用尽。
 * 每次 `playerInputs[i]` 作为第 i 轮的玩家输入回注。
 */
export async function runCombatSandboxLoop(
  opts: RunCombatSandboxLoopOpts,
): Promise<CombatSandboxResult> {
  const inputs = opts.playerInputs ?? [];
  const total = Math.max(1, inputs.length);
  let transcript: CombatSandboxMessage[] | undefined;
  let last: CombatSandboxResult | undefined;

  for (let i = 0; i < total; i += 1) {
    last = await runCombatSandbox({
      ...opts,
      transcript,
      playerInput: inputs[i],
    });
    transcript = last.transcript;
    if (last.ended || last.error) break;
    if (last.awaitingPlayer && i >= inputs.length - 1) break;
  }

  if (!last) throw new Error('runCombatSandboxLoop: 未产生任何 exchange');
  return last;
}
