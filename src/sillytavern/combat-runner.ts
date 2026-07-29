/**
 * Combat Runner — 战斗独立循环 (M4 战斗 v2 · 任务 5.2 + 5.7 / M5 路径 X 重构)
 *
 * 触发: GamePipeline onCombatTrigger 回调（<combat_trigger> 标记，由 orchestrator processStageMarkers 暂存后调用）
 * 定位: 独立循环，**不在主编排 DAG 内**（对齐架构 §6.1 + 计划 5.2）。
 *
 * ═══ M5 路径 X · 按行动轴逐单位调度 ═══
 * M4 是「agent 一次 chatWithTools 自主打全场」的黑盒；M5 改为 runner 当回合调度器：
 *  1. 初始化回合：agent 调 combat_start → runner 拿到 CombatState(turnOrder)
 *  2. 行动轴循环（while status !== 'ended'）:
 *     - 敌方单位 → agent 自主打（一次 chatWithTools = 一单位回合，D2-a）
 *     - 我方单位 → emit awaiting_player_input + await pendingResolver 暂停等玩家文本
 *  3. 每次 chatWithTools 返回 → emit round_narrative；每次工具调用 → emit action_resolved
 *  4. 事件流（onCombatEvent）旁路给前端，不改主流程（纯增量，可选）
 *
 * 暂停/恢复: runner 持 pendingResolver；pipeline 通过 deps.registerSubmitter 拿到 submitPlayerInput，
 *           前端发送文本 → pipeline 转发 → resolve → runner 继续。
 *
 * ═══ 计算分工不变 ═══
 *  代码管数值（HP/骰/伤害管线 via executeCombatToolCall）；AI 管决策与叙事。
 *  patches 落库走 stateManager（ADR-21）；摘要回注 Story。
 *
 * 对齐: docs/planning/2026-07-29-combat-v2-m5-rfc.md（路径 X + 事件流 + 决策点）
 *      docs/reference/combat-agent-api.md §5（轮次协议）
 */

import type {
  AgentContext,
  ApiEndpoint,
  CombatTriggerMarker,
  StatePatch,
  AgentConfig,
  WorldBook,
  AgentPreset,
  CombatSummaryResult,
  CombatState,
  CombatActionResult,
  CharacterState,
  ReadonlyHookSet,
} from './types';
import { buildAgentMessages } from './agent-templates';
import { getToolsForAgent, executeCombatToolCall } from './agent-tools';
import type { CombatToolContext } from './agent-tools';
import type { EventBus } from './game-event';

// ========== Types ==========

export interface CombatRunRequest {
  saveId: string;
  marker: CombatTriggerMarker;
  storyOutput: string;
  context: AgentContext;
  endpoint: ApiEndpoint;
  /** 侧链 buildAgentMessages 需要完整配置才能拿到 systemPrompt + 世界书（对齐 craft/char 链） */
  configs?: AgentConfig[];
  worldBooks?: WorldBook[];
  presets?: AgentPreset[];
}

export interface CombatRunDeps {
  /** AgentClient 工厂 — 每次调用创建新实例（缓存隔离），对齐 craft/char 链的 clientFactory */
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient;
  /** StateManager 写入入口（可选，测试可不提供） */
  stateManager?: {
    commitChatState: (patches: StatePatch[]) => Promise<void>;
  };
  /** 战斗 EventBus（19 event emitChain，按存档隔离） */
  eventBus: EventBus;
  /** 当前角色列表（CombatToolContext.characters + status 按名查询） */
  characters: CharacterState[];
  variables?: Record<string, any>;
  /** 只读查询钩子（M1，供 handler / $status 读角色状态） */
  readHooks?: ReadonlyHookSet;
  /**
   * 🆕 M5: runner 注册「玩家文本提交器」。runner 启动时调一次 registerSubmitter(submit)，
   * pipeline 存下 submit；前端 CombatActionBar 发送文本 → pipeline 调 submit(text) →
   * resolve runner 的 pendingResolver → 战斗继续。
   */
  registerSubmitter?: (submit: (text: string) => void) => void;
}

/** 抽象的 combat agent 调用客户端（生产用 AgentClient，测试用 mock） */
export interface CombatClient {
  chatWithTools?: (
    request: {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      tool_choice?: string;
    },
    toolExecutor: (name: string, args: Record<string, any>) => Promise<unknown>,
    options?: { maxRounds?: number; signal?: AbortSignal },
  ) => Promise<CombatClientResult>;
  chat: (messages: Array<{ role: string; content: string }>) => Promise<CombatClientResult>;
}

export interface CombatClientResult {
  output: string | null;
  rawResponse: string;
  tokensUsed: number;
  cacheHit: boolean;
  duration: number;
  error?: string;
}

/**
 * 🆕 M5 战斗事件流 — runner 旁路给前端的过程数据（消息流 + 单位卡片 + 伤害面板的数据源）。
 * onCombatEvent 可选；不传时 runner 照跑（无前端 / 纯引擎调用场景）。
 */
export type CombatEvent =
  | { type: 'combat_started'; state: CombatState }
  | { type: 'turn_started'; unit: string; unitId: string; round: number }
  | { type: 'action_resolved'; result: Record<string, any>; toolName: string }
  | { type: 'round_narrative'; text: string; round: number }
  | { type: 'round_started'; round: number }
  | { type: 'awaiting_player_input'; unit: string; unitId: string; round: number }
  | { type: 'combat_ended'; summary: CombatSummaryResult };

// ========== 常量 ==========

/** 最大回合数（行动轴完整走一圈 = 1 回合）。防死循环兜底。 */
const MAX_TURNS = 10;
/** 单次 chatWithTools 内的最大工具调用轮数（一个单位回合可能 2-4 次工具调用：骰+攻击+状态） */
const MAX_TOOL_ROUNDS = 40;

/** 产出「动作结果」的工具集 → emit action_resolved（前端渲染数值卡片）。
 *  不含 combat_start（→ combat_started 事件）/ combat_end（→ combat_ended）/ get_*（只读查询）。 */
const ACTION_TOOLS = new Set([
  'combat_attack',
  'combat_use_skill',
  'combat_use_item',
  'combat_block',
  'combat_move',
  'combat_focus',
  'combat_flee',
  'status_apply',
  'status_remove',
]);

// ========== Public API ==========

/**
 * 运行一场战斗的完整独立循环（M5 路径 X：按行动轴逐单位调度）。
 *
 * @param request       战斗触发请求
 * @param deps          依赖（client/stateManager/bus/characters + registerSubmitter）
 * @param onCombatEvent 可选事件流回调（前端消息流数据源）
 * @returns CombatSummaryResult（narrativeSummary 回注 Story；patches 已落库）
 */
export async function runCombat(
  request: CombatRunRequest,
  deps: CombatRunDeps,
  onCombatEvent?: (evt: CombatEvent) => void,
): Promise<CombatSummaryResult> {
  const { marker, storyOutput } = request;

  // ===== 1. 构造 combat agent 初始 messages（沿用 M4）=====
  const triggerInfo = [
    `战斗类型: ${marker.combatType ?? '标准'}`,
    marker.environment ? `环境: ${marker.environment}` : '',
    `战斗场景与参战方: ${marker.bodyText ?? marker.rawContent}`,
  ]
    .filter(Boolean)
    .join('\n');

  const ctxWithStory: AgentContext = {
    ...request.context,
    agentOutputs: new Map([['story', storyOutput]]),
  };

  let messages = buildAgentMessages(
    'combat',
    ctxWithStory,
    request.configs,
    request.worldBooks,
    request.presets,
    undefined,
  );
  if (!messages) {
    throw new Error('combat 模板未找到 — 请检查 agent-templates.ts 注册 + agent-config.json');
  }
  messages = [...messages];
  messages.push({
    role: 'user',
    content:
      `<combat_trigger>\n${triggerInfo}\n</combat_trigger>\n\n` +
      `<正文上文>\n${storyOutput.slice(-2000)}\n</正文上文>\n\n` +
      `请开始主持这场战斗。第一步：判定参战方（敌/我）与战斗类型，为每个单位掷先攻（roll_d20），然后调用 combat_start 初始化。`,
  });

  // ===== 2. 战斗状态（可变）+ 事件流 + 暂停恢复 =====
  let combatState: CombatState | undefined;
  let winner: 'ally' | 'enemy' | 'draw' | undefined;
  let settlement:
    | { exp?: number; fp?: number; loot?: CombatSummaryResult['loot']; summary?: string }
    | undefined;
  let summaryText: string | undefined;
  const allPatches: StatePatch[] = [];

  const emit = (evt: CombatEvent): void => {
    try {
      onCombatEvent?.(evt);
    } catch (e) {
      // 前端回调报错不应影响战斗主流程
      console.warn('[combat-runner] onCombatEvent 回调出错（已忽略）:', e);
    }
  };

  // 暂停/恢复机制（M5：我方单位回合等玩家文本）
  let pendingResolver: ((text: string) => void) | null = null;
  let pendingRejecter: ((err: Error) => void) | null = null;

  const awaitPlayerInput = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      pendingResolver = resolve;
      pendingRejecter = reject;
    });
  const submitPlayerInput = (text: string): void => {
    const r = pendingResolver;
    pendingResolver = null;
    pendingRejecter = null;
    if (r) r(text);
  };
  const failPending = (err: Error): void => {
    const r = pendingRejecter;
    pendingResolver = null;
    pendingRejecter = null;
    if (r) r(err);
  };
  if (deps.registerSubmitter) deps.registerSubmitter(submitPlayerInput);

  // ===== 3. 工具回调（combat_start 更新 state / combat_end 记胜负 / 同步 hp / 收集 patches / emit）=====
  const toolCallback = async (name: string, args: Record<string, any>) => {
    const combatCtx: CombatToolContext = {
      characters: deps.characters,
      variables: deps.variables ?? {},
      saveId: request.saveId,
      bus: deps.eventBus,
      combatants: combatState?.participants.map((p) => p.characterId) ?? [],
      combat: combatState ?? ({} as CombatState),
      readHooks: deps.readHooks,
    };
    const r = await executeCombatToolCall(name, args, combatCtx);
    const res = (r?.result ?? {}) as Record<string, any>;

    // combat_start → 更新战斗实例 + emit combat_started
    if (name === 'combat_start' && res._combatState) {
      combatState = res._combatState as CombatState;
      emit({ type: 'combat_started', state: combatState });
    }

    // combat_end → 胜负 + 结算
    if (name === 'combat_end') {
      if (args?.winner) winner = args.winner;
      settlement = {
        exp: typeof res.exp === 'number' ? res.exp : undefined,
        fp: typeof res.fp === 'number' ? res.fp : undefined,
        loot: Array.isArray(res.loot) ? res.loot : undefined,
        summary: typeof res.summary === 'string' ? res.summary : undefined,
      };
    }

    // combat_attack → 同步 defender hp 到 combatState（管线不 mutate participants.hp，M5 修正）
    if (name === 'combat_attack' && res && typeof res === 'object' && 'finalHp' in res) {
      const req = (res as CombatActionResult).request;
      const defenderId = req?.defenderId;
      if (defenderId && combatState) {
        const defender = combatState.participants.find((p) => p.characterId === defenderId);
        if (defender) {
          defender.hp = (res as CombatActionResult).finalHp;
          if ((res as CombatActionResult).isDead) defender.canAct = false;
        }
      }
    }

    // 收集 patches（combat_attack / status_* / combat_end 都可能产 patch）
    if (Array.isArray(res.patches)) {
      allPatches.push(...(res.patches as StatePatch[]));
    }

    // 动作类工具 → emit action_resolved（前端渲染伤害/状态卡片）
    if (ACTION_TOOLS.has(name)) {
      emit({ type: 'action_resolved', result: res, toolName: name });
    }

    return r;
  };

  const client = deps.clientFactory('combat', request.endpoint, request.saveId);
  if (!client.chatWithTools) {
    throw new Error('combat agent 需要 chatWithTools 能力（function calling），当前 client 不支持');
  }
  const tools = getToolsForAgent('combat');

  // ===== 4. 阶段一：初始化回合（agent 调 combat_start）=====
  try {
    const initResult = await client.chatWithTools(
      { messages, tools, tool_choice: 'auto' },
      toolCallback,
      { maxRounds: MAX_TOOL_ROUNDS },
    );
    const initOutput = initResult.output ?? '';
    if (initOutput) {
      messages.push({ role: 'assistant', content: initOutput });
      emit({ type: 'round_narrative', text: initOutput, round: 1 });
    }
  } catch (err) {
    failPending(err as Error);
    throw err;
  }

  if (!combatState) {
    throw new Error('combat agent 未调 combat_start 初始化战斗（无法进入回合调度）');
  }

  // 兜底：agent 可能在初始化叙事里就结束（极端短战斗，如对手认输）
  const earlySummary = (messages[messages.length - 1]?.content ?? '').match(
    /<combat_summary>([\s\S]*?)<\/combat_summary>/,
  );
  if (earlySummary) {
    summaryText = earlySummary[1].trim();
  }

  // ===== 5. 阶段二：行动轴逐单位调度（路径 X 核心）=====
  if (!summaryText) {
    const sideOf = new Map(
      combatState.participants.map((p) => [p.characterId, p.side]),
    );
    let turnPtr = 0;
    let roundsCompleted = 0;

    while (combatState.status !== 'ended' && !summaryText && roundsCompleted < MAX_TURNS) {
      const orderLen = combatState.turnOrder.length;
      if (orderLen === 0) break;

      const unit = combatState.turnOrder[turnPtr];
      const participant = combatState.participants.find((p) => p.characterId === unit.characterId);
      // 跳过：无数据 / 无法行动 / 已死亡（hp 同步后由 combat_attack 结果驱动）
      if (!participant || !participant.canAct || participant.hp <= 0) {
        turnPtr = (turnPtr + 1) % orderLen;
        if (turnPtr === 0) {
          roundsCompleted++;
          combatState.round++;
          emit({ type: 'round_started', round: combatState.round });
        }
        continue;
      }

      emit({
        type: 'turn_started',
        unit: unit.name,
        unitId: unit.characterId,
        round: combatState.round,
      });

      const isEnemy = sideOf.get(unit.characterId) === 'enemy';
      let userContent: string;
      if (isEnemy) {
        userContent =
          `轮到【敌方】${unit.name} 行动（第${combatState.round}回合）。你控制其战术` +
          `（攻击/技能/道具/格挡/移动/专注），调对应工具执行，并输出本回合战斗叙事。` +
          `若胜负已定，调用 combat_end 结算并输出 <combat_summary>。`;
      } else {
        emit({
          type: 'awaiting_player_input',
          unit: unit.name,
          unitId: unit.characterId,
          round: combatState.round,
        });
        let playerText: string;
        try {
          playerText = await awaitPlayerInput();
        } catch (err) {
          // abort / 外部失败 → 退出循环
          throw err;
        }
        userContent =
          `【玩家指令】我方 ${unit.name}：${playerText}\n` +
          `请理解意图后调对应工具执行，并输出本回合战斗叙事。` +
          `若胜负已定，调用 combat_end 结算并输出 <combat_summary>。`;
      }
      messages.push({ role: 'user', content: userContent });

      const result = await client.chatWithTools(
        { messages, tools, tool_choice: 'auto' },
        toolCallback,
        { maxRounds: MAX_TOOL_ROUNDS },
      );
      const output = result.output ?? '';
      if (output) {
        messages.push({ role: 'assistant', content: output });
        emit({ type: 'round_narrative', text: output, round: combatState.round });
      }

      // 检测 <combat_summary>（结束标志）
      const m = output.match(/<combat_summary>([\s\S]*?)<\/combat_summary>/);
      if (m) {
        summaryText = m[1].trim();
        break;
      }

      // 推进行动轴
      turnPtr = (turnPtr + 1) % orderLen;
      if (turnPtr === 0) {
        roundsCompleted++;
        combatState.round++;
        emit({ type: 'round_started', round: combatState.round });
      }
    }
  }

  // ===== 6. 阶段三：patches 落库 =====
  if (deps.stateManager && allPatches.length > 0) {
    try {
      await deps.stateManager.commitChatState(allPatches);
    } catch (e) {
      console.error('[combat-runner] patches 落库失败:', e);
    }
  }

  // ===== 7. 返回 CombatSummaryResult + emit combat_ended =====
  const outcome = inferOutcome(summaryText, winner);
  const summary: CombatSummaryResult = {
    narrativeSummary: summaryText ?? settlement?.summary ?? '战斗结束（未生成摘要）',
    patches: allPatches,
    totalExp: settlement?.exp ?? 0,
    totalFp: settlement?.fp ?? 0,
    loot: settlement?.loot ?? [],
    rounds: combatState?.round ?? 1,
    outcome,
  };
  emit({ type: 'combat_ended', summary });
  return summary;
}

// ========== Helpers ==========

/** 推断胜负结果（从摘要文本 + combat_end 的 winner 参数） */
export function inferOutcome(
  summaryText: string | undefined,
  winner: 'ally' | 'enemy' | 'draw' | undefined,
): CombatSummaryResult['outcome'] {
  if (winner === 'ally') return 'ally_win';
  if (winner === 'enemy') return 'enemy_win';
  const s = summaryText ?? '';
  if (/逃跑|逃脱|撤退成功|成功逃脱/.test(s)) return 'fled';
  if (/(我方|主角|玩家|英雄).*?(胜|获胜|胜利)/.test(s) && !/敌方.*?胜/.test(s)) return 'ally_win';
  if (/(敌方|敌人).*?(胜|获胜)|战败|全军覆没|阵亡|主角.*?死/.test(s)) return 'enemy_win';
  return 'draw';
}
