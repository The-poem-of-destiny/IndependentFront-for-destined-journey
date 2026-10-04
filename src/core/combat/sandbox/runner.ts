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
    options?: {
      maxRounds?: number;
      signal?: AbortSignal;
      /** 流式正文增量回调（战斗「边想边说」） */
      onTextDelta?: (delta: string) => void;
      /** 思维链增量回调（reasoning_content delta） */
      onReasoning?: (delta: string) => void;
      /** 每轮工具循环开始边界（1-based）—— 供思维链按轮切块 */
      onRoundStart?: (round: number) => void;
    },
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
    '🔴 一条对话（一次交换）只结算「当前行动单位」这**一个**单位：把它的[攻击]/[动作]结算完、写回状态，然后结束本条输出。**不要替其它单位行动**（谁轮到、由系统提示指定；我方单位由玩家下令，轮到我方时系统会直接把玩家的命令给你）。',
    '',
    '战斗流程：',
    '1. 开场（战前，仅整场一次）：读参战单位面板，宣布战场。🔴 **行动顺序与回合数由 Code 维护**（见 <参战单位> 顶部「行动顺序」）——你**不要**掷先攻、不要写 actionOrder、不要改 round，也不要按协议里「行动顺序」阶段自行定序。',
    '2. 战前资源推演：Code 已按公式把全体 HP/MP/SP 填好；你输出 {战前资源推演} 面板**确认**即可（除非发现与公式不符，才用 combat_update_unit 修正）。**不结算任何单位的行动。**',
    '3. 逐单位结算：每条只处理系统指定的那**一个**单位；结算完用 combat_set_meta 把**下一个该行动的单位**写进 `activeUnit`（本轮全部行动完就留空/不写，Code 会进入下一回合）。',
    '4. 🔴 即时写回（硬性）：每一次伤害 / 资源变化，都必须在**同一条输出内**用 combat_update_unit 写进状态；状态变化用 combat_add_status / combat_remove_status。**只在正文里描述、不发工具调用 = 该变化未发生**；单位死亡必须写 alive=false（或把 hp 写到 ≤0）。该单位两个槽（攻击/动作）都结算完再前移到下一个。',
    '5. 状态维护：回合结束时结算持续状态、层数衰减与冷却，用 combat_remove_status / combat_update_unit 落实。',
    '6. 战意：在协议阈值处判定，用 combat_update_unit 写 morale。',
    '7. 终局：一方全灭 / 溃逃 / 投降 / 中止时，**先把全体参战单位的最终 HP/MP/SP/存活写回状态（尤其是被击败的敌方）**，再用 combat_set_meta 把 phase 置为 "ended" 并写 outcome（**枚举**：ally_win / enemy_win / draw / fled）。随后 🔴 **用 `combat_write_summary` 工具写一段自然语言战报**（谁和谁交手、过程与结果、我方现在的状况）——像讲故事一样、**不要罗列数值或面板**；主叙事 AI 读到的就是这段，它要据此接着往下写。',
    '',
    '禁止自己编造骰值 —— 所有随机一律走 roll_d20 / roll_d100 / roll_dice；所有确定性的公式运算走 calc / calc_damage / calc_initiative。',
    '🔴 输出前自检：正文里发生的每一次伤害 / 死亡 / 状态变化，状态里是否都有对应写入？没有就补上工具调用 —— 结算面板只认状态，不认正文。',
  ].join('\n');
}

/** 参战单位速览（行动顺序 + 名字 / 阵营 / 层级 / 资源 / 战意；集群附存活数） */
export function buildCombatRosterText(state: CombatState): string {
  const order = state.meta.actionOrder ?? [];
  const header = order.length ? `行动顺序（Code 已定序，勿改）：${order.join(' → ')}\n` : '';
  const lines = Object.values(state.units).map((u) => {
    const side = u.side === 'ally' ? '我方' : '敌方';
    const cluster = u.cluster ? ` ｜ 集群 ${u.cluster.alive}/${u.cluster.total}` : '';
    return `- ${u.name}（${side} / T${u.tier} / Lv.${u.level}）HP ${u.hp}/${u.maxHp} MP ${u.mp}/${u.maxMp} SP ${u.sp}/${u.maxSp} 战意 ${u.morale}${cluster}${u.alive ? '' : ' [已倒下]'}`;
  });
  return header + (lines.length > 0 ? lines.join('\n') : '（无参战单位）');
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
  /**
   * 本轮输入的注入角色：玩家下令 = 'user'（默认）；Code 自动给敌方的回合指令 = 'system'。
   * 只影响 transcript 里那条消息的角色（UI 也据此画 system 气泡）。
   */
  playerInputRole?: 'user' | 'system';
  saveCharacters?: ReadonlyArray<SettleableCharacter>;
  settlementExtras?: CombatSettlementExtras;
  maxRounds?: number;
  signal?: AbortSignal;
  /** 每次工具执行前回调（供 UI 画「调用了什么工具」的一行） */
  onToolCall?: (name: string, args: Record<string, any>) => void;
  /** 每次工具执行后回调（供持久化 / UI 追加） */
  onToolResult?: (name: string, args: Record<string, any>, result: unknown) => void;
  /** 流式正文增量回调（实时显示「边想边说」）；缺省则整轮结束后一次性返回 */
  onTextDelta?: (delta: string) => void;
  /** 思维链增量回调（实时显示「思考」折叠块） */
  onReasoningDelta?: (delta: string) => void;
  /** 每轮工具循环开始边界（1-based）—— 上层据此切思维链块，让思考/工具交替 */
  onRoundStart?: (round: number) => void;
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
  transcript.push({
    role: opts.playerInputRole ?? 'user',
    content: opts.playerInput ?? '战斗开始。',
  });

  const result = await client.chatWithTools(
    { messages: transcript, tools: binding.definitions, tool_choice: 'auto' },
    async (name, args) => {
      opts.onToolCall?.(name, args);
      const toolResult = await binding.execute(name, args);
      opts.onToolResult?.(name, args, toolResult);
      return toolResult;
    },
    {
      maxRounds: opts.maxRounds ?? 12,
      signal: opts.signal,
      onTextDelta: opts.onTextDelta,
      onReasoning: opts.onReasoningDelta,
      onRoundStart: opts.onRoundStart,
    },
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
  assignPlayerTurn(state);
  const displayOutput = result.output ?? '';
  const ended = state.meta.phase === 'ended';
  const patches = ended
    ? buildCombatSettlementPatches(state, opts.saveCharacters ?? [], opts.settlementExtras)
    : [];

  return {
    state,
    output: displayOutput,
    ended,
    awaitingPlayer: !ended && state.meta.pendingPlayerUnit !== undefined,
    outcome: state.meta.outcome,
    patches,
    transcript,
    error: result.error,
  };
}

// ═══════════════════════════════════════════════════════════
// 玩家回合指派（Code 侧）
// ═══════════════════════════════════════════════════════════

/**
 * 每轮 exchange 结束后，把「当前行动单位」指派给玩家 —— 供前端行动规划区显示。
 *
 * 🔴 为什么不需要一个 `combat_yield_to_player` 工具：玩家回合的交接**本来就是输入框** ——
 *    管线每轮 exchange 结束必然 `waitForCombatIntent()`，玩家提交即续战。工具唯一多做的是
 *    给 `meta.pendingPlayerUnit` 赋值（UI 显示用），而这点信息 Code 直接算得出来，不必让模型
 *    调工具、更不必让弱模型「记得调」。
 *    未终局且尚无指派、且有存活我方 → 指派第一个存活我方；终局则不动。
 */
export function assignPlayerTurn(state: CombatState): void {
  if (state.meta.phase === 'ended' || state.meta.pendingPlayerUnit) return;
  const ally = Object.values(state.units).find((u) => u.side === 'ally' && u.alive);
  if (ally) state.meta.pendingPlayerUnit = ally.name;
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
