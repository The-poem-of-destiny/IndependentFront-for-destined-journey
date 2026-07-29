/**
 * Combat Runner — 战斗独立循环 (M4 战斗 v2 · 任务 5.2 + 5.7)
 *
 * 触发: GamePipeline onCombatTrigger 回调（<combat_trigger> 标记，由 orchestrator processStageMarkers 暂存后调用）
 * 定位: 独立循环，**不在主编排 DAG 内**（对齐架构 §6.1 + 计划 5.2）。对标 runCraftGenChain 的注入模式，
 *      但 combat 是跨回合多轮对话（craft 是一次性 Agentic）。
 *
 * 职责:
 *  1. 构造 combat agent messages（system + 战斗触发 user 消息）
 *  2. 跨回合循环（≤MAX_TURNS）: client.chatWithTools(messages, executeCombatToolCall callback)
 *     - combat agent 调工具（combat_start 初始化 / combat_attack 攻击 / combat_end 结算 / status_* ...）
 *     - 工具回调里维护战斗实例（combat_start 后更新 combatState）+ 收集 patches
 *     - combat agent 输出本轮叙事 → push assistant 消息
 *     - 检测 <combat_summary> → 结束；否则 push user 反馈（战斗状态快照）→ 下一回合
 *  3. patches 落库（stateManager.commitChatState，ADR-21 唯一写入入口）
 *  4. 返回 CombatSummaryResult（narrativeSummary 回注 Story 正文）
 *
 * B 方案（独立工具执行通道）: combat 工具走 executeCombatToolCall + CombatToolContext，
 *      不污染现有 ToolExecutionContext。
 *
 * 对齐: docs/reference/combat-agent-api.md §5（轮次协议）+ §8（接入点）
 *      docs/planning/2026-07-28-combat-system-v2-plan.md §5（任务 5.2/5.7）
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

// ========== 常量 ==========

/** 外层最大回合数（防死循环；combat agent 通常在一次 chatWithTools 内跑完，外层多为 1-2 轮） */
const MAX_TURNS = 10;
/** 单次 chatWithTools 内的最大工具调用轮数（一个完整战斗可能 10-40 次工具调用） */
const MAX_TOOL_ROUNDS = 40;

// ========== Public API ==========

/**
 * 运行一场战斗的完整独立循环。
 *
 * @returns CombatSummaryResult（narrativeSummary 回注 Story；patches 已落库）
 */
export async function runCombat(
  request: CombatRunRequest,
  deps: CombatRunDeps,
): Promise<CombatSummaryResult> {
  const { marker, storyOutput } = request;

  // ===== 1. 构造 combat agent 初始 messages =====
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
    undefined, // combat 无自定义 localParams（触发信息走 user 消息）
  );
  if (!messages) {
    throw new Error('combat 模板未找到 — 请检查 agent-templates.ts 注册 + agent-config.json');
  }
  messages = [...messages];
  // 追加 user 消息：战斗触发 + 指令（combat agent 第一步应 combat_start）
  messages.push({
    role: 'user',
    content:
      `<combat_trigger>\n${triggerInfo}\n</combat_trigger>\n\n` +
      `<正文上文>\n${storyOutput.slice(-2000)}\n</正文上文>\n\n` +
      `请开始主持这场战斗。第一步：判定参战方（敌/我）与战斗类型，为每个单位掷先攻（roll_d20），然后调用 combat_start 初始化。`,
  });

  // ===== 2. 战斗状态（可变，工具回调里更新） =====
  let combatState: CombatState | undefined;
  let winner: 'ally' | 'enemy' | 'draw' | undefined;
  let settlement: { exp?: number; fp?: number; loot?: CombatSummaryResult['loot']; summary?: string } | undefined;
  const allPatches: StatePatch[] = [];

  const client = deps.clientFactory('combat', request.endpoint, request.saveId);
  if (!client.chatWithTools) {
    throw new Error('combat agent 需要 chatWithTools 能力（function calling），当前 client 不支持');
  }
  const tools = getToolsForAgent('combat');

  let turns = 0;
  let summaryText: string | undefined;

  // ===== 3. 跨回合循环 =====
  for (let i = 0; i < MAX_TURNS; i++) {
    turns = i + 1;

    // 构造 combatCtx（combat 初始占位；combat_start 后 combatState 有值）
    const combatCtx: CombatToolContext = {
      characters: deps.characters,
      variables: deps.variables ?? {},
      saveId: request.saveId,
      bus: deps.eventBus,
      combatants: combatState?.participants.map((p) => p.characterId) ?? [],
      combat: combatState ?? ({} as CombatState),
      readHooks: deps.readHooks,
    };

    const result = await client.chatWithTools(
      { messages, tools, tool_choice: 'auto' },
      async (name: string, args: Record<string, any>) => {
        const r = await executeCombatToolCall(name, args, combatCtx);
        const res = (r?.result ?? {}) as Record<string, any>;
        // combat_start 后更新战斗实例
        if (name === 'combat_start' && res._combatState) {
          combatState = res._combatState as CombatState;
        }
        // combat_end 记录胜负 + 结算
        if (name === 'combat_end') {
          if (args?.winner) winner = args.winner;
          settlement = {
            exp: typeof res.exp === 'number' ? res.exp : undefined,
            fp: typeof res.fp === 'number' ? res.fp : undefined,
            loot: Array.isArray(res.loot) ? res.loot : undefined,
            summary: typeof res.summary === 'string' ? res.summary : undefined,
          };
        }
        // 收集 patches（combat_attack / status_* / combat_end 都可能产 patch）
        if (Array.isArray(res.patches)) {
          allPatches.push(...(res.patches as StatePatch[]));
        }
        return r;
      },
      { maxRounds: MAX_TOOL_ROUNDS },
    );

    const output = result.output ?? '';
    if (output) {
      messages.push({ role: 'assistant', content: output });
    }

    // 检测 <combat_summary>（结束标志）
    const summaryMatch = output.match(/<combat_summary>([\s\S]*?)<\/combat_summary>/);
    if (summaryMatch) {
      summaryText = summaryMatch[1].trim();
      break;
    }

    // 未结束：构造下一回合 user 反馈（战斗状态快照）
    messages.push({ role: 'user', content: buildRoundFeedback(combatState, turns) });
  }

  // ===== 4. patches 落库 =====
  if (deps.stateManager && allPatches.length > 0) {
    try {
      await deps.stateManager.commitChatState(allPatches);
    } catch (e) {
      console.error('[combat-runner] patches 落库失败:', e);
    }
  }

  // ===== 5. 返回 CombatSummaryResult =====
  const outcome = inferOutcome(summaryText, winner);
  return {
    narrativeSummary: summaryText ?? settlement?.summary ?? '战斗结束（未生成摘要）',
    patches: allPatches,
    totalExp: settlement?.exp ?? 0,
    totalFp: settlement?.fp ?? 0,
    loot: settlement?.loot ?? [],
    rounds: combatState?.round ?? turns,
    outcome,
  };
}

// ========== Helpers ==========

/** 构造每回合的战斗状态反馈（给 combat agent 下一回合上下文） */
function buildRoundFeedback(combatState: CombatState | undefined, turn: number): string {
  if (!combatState) {
    return '战斗尚未初始化。请先调用 combat_start（传 combatType/allies/enemies/environment/d20Rolls）初始化战斗。';
  }
  const fmt = (p: { name: string; hp: number; maxHp: number; canAct: boolean }) =>
    `${p.name} HP${p.hp}/${p.maxHp}${p.canAct ? '' : '[无法行动]'}`;
  const ally = combatState.participants.filter((p) => p.side === 'ally').map(fmt).join(', ') || '无';
  const enemy = combatState.participants.filter((p) => p.side === 'enemy').map(fmt).join(', ') || '无';
  return (
    `<战斗状态 第${combatState.round}回合（外层第${turn}轮）>\n` +
    `我方: ${ally}\n敌方: ${enemy}\n\n` +
    `请继续主持本回合行动。敌人由你决策；我方单位若无明确用户指令，按战术合理性代为行动。` +
    `若胜负已定，调用 combat_end 结算并输出 <combat_summary>。`
  );
}

/** 推断胜负结果 */
function inferOutcome(
  summaryText: string | undefined,
  winner: 'ally' | 'enemy' | 'draw' | undefined,
): CombatSummaryResult['outcome'] {
  if (winner === 'ally') return 'ally_win';
  if (winner === 'enemy') return 'enemy_win';
  const s = summaryText ?? '';
  if (/逃跑|逃脱|撤退成功|成功逃脱/.test(s)) return 'fled';
  if (/(我方|主角|玩家).*?(胜|获胜|胜利)/.test(s) && !/敌方.*?胜/.test(s)) return 'ally_win';
  if (/(敌方|敌人).*?(胜|获胜)|战败|全军覆没|阵亡|主角.*?死/.test(s)) return 'enemy_win';
  return 'draw';
}
