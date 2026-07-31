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
  CombatParticipant,
  CharacterState,
  ReadonlyHookSet,
} from './types';
import { buildAgentMessages } from './agent-templates';
import { getToolsForAgent, executeCombatToolCall } from './agent-tools';
import type { CombatToolContext } from './agent-tools';
import type { EventBus } from './game-event';
import type { StatusEffect } from './types';
import { applyBuff, removeBuff, tickBuffs, collectDotTicks } from './buff-registry';

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
  | {
      type: 'dot_tick';
      unit: string;
      unitId: string;
      round: number;
      ticks: Array<{ name: string; amount: number }>;
      hpAfter: number;
    }
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
    { exp?: number; fp?: number; loot?: CombatSummaryResult['loot']; summary?: string } | undefined;
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
  // 🐛修复: registerSubmitter 未提供时 awaitPlayerInput 永远不 resolve —— 含我方单位的
  // 战斗必死锁（与"不传时 runner 照跑"的声明矛盾）。无提交通道时降级为 agent 代打我方单位。
  const playerControlled = !!deps.registerSubmitter;
  if (deps.registerSubmitter) deps.registerSubmitter(submitPlayerInput);

  // 🐛修复: 行动经济（1 攻击 + 1 动作/回合）此前完全未强制，agent 一个单位回合内可
  // 无限次 combat_attack（仅受 MAX_TOOL_ROUNDS 限制）。按当前行动单位计数并拦截超额调用。
  // 对抗验证补充: ①初始化阶段（combat_start 的同一次 chatWithTools，turnEconomy 尚未建立）
  // 也要拦截动作类工具，否则 agent 可在初始化调用内无限攻击绕过经济；②扣减放在工具
  // **成功执行后**，寻址失败等错误不再吞掉额度（一次拼写错误曾吞掉整回合攻击）。
  let combatPhase: 'init' | 'turns' = 'init';
  let turnEconomy: { actorId: string; attacks: number; actions: number } | null = null;
  const ATTACK_TOOLS = new Set(['combat_attack']);
  const GENERIC_ACTION_TOOLS = new Set([
    'combat_use_skill',
    'combat_use_item',
    'combat_block',
    'combat_move',
    'combat_focus',
    'combat_flee',
  ]);
  const econError = (name: string, msg: string) => ({
    toolCallId: `combat_econ_${Date.now()}`,
    functionName: name,
    result: null,
    error: msg,
  });

  // ===== 3. 工具回调（combat_start 更新 state / combat_end 记胜负 / 同步 hp / 收集 patches / emit）=====
  const toolCallback = async (name: string, args: Record<string, any>) => {
    const isActionTool = ATTACK_TOOLS.has(name) || GENERIC_ACTION_TOOLS.has(name);

    // 初始化阶段: 只允许 combat_start/combat_end/掷骰/只读查询，动作类一律拦截
    if (combatPhase === 'init' && isActionTool) {
      return econError(
        name,
        '初始化阶段不可执行战斗动作（先 combat_start，行动由行动轴逐单位调度）',
      );
    }
    // 战斗已初始化后不接受重复 combat_start（重调会把 HP/buff/回合进度整体重置回开战前）
    if (name === 'combat_start' && combatState) {
      return econError(name, '战斗已初始化，不支持中途重新 combat_start（增援请用叙事处理）');
    }

    // 行动经济预检（仅动作类工具；status_*/get_*/roll_* 不受限）。此处只校验不扣减。
    let econCharge: 'attack' | 'action' | null = null;
    if (turnEconomy && combatState && isActionTool) {
      const actorName: string | undefined = args?.attackerId ?? args?.characterId;
      const actor = actorName
        ? combatState.participants.find((p) => p.name === actorName)
        : undefined;
      if (actor && actor.characterId !== turnEconomy.actorId) {
        return econError(
          name,
          `行动经济: 当前行动单位不是「${actorName}」，一次单位回合只能操作当前单位`,
        );
      }
      if (ATTACK_TOOLS.has(name)) {
        if (turnEconomy.attacks <= 0) {
          return econError(name, '行动经济: 本回合攻击次数已用完（每回合 1 攻击 + 1 动作）');
        }
        econCharge = 'attack';
      } else {
        if (turnEconomy.actions <= 0) {
          return econError(name, '行动经济: 本回合动作次数已用完（每回合 1 攻击 + 1 动作）');
        }
        econCharge = 'action';
      }
    }

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

    // 行动经济扣减 —— 仅在工具成功执行后
    if (econCharge && turnEconomy && !r?.error) {
      if (econCharge === 'attack') turnEconomy.attacks--;
      else turnEconomy.actions--;
    }

    // combat_start → 更新战斗实例 + emit combat_started
    if (name === 'combat_start' && res._combatState) {
      combatState = res._combatState as CombatState;
      emit({ type: 'combat_started', state: combatState });
    }

    // combat_end → 胜负 + 结算 + 终止行动轴循环
    if (name === 'combat_end') {
      if (args?.winner) winner = args.winner;
      settlement = {
        exp: typeof res.exp === 'number' ? res.exp : undefined,
        fp: typeof res.fp === 'number' ? res.fp : undefined,
        loot: Array.isArray(res.loot) ? res.loot : undefined,
        summary: typeof res.summary === 'string' ? res.summary : undefined,
      };
      // 🐛修复: 旧实现 combatState.status 永不置 'ended'，agent 调了 combat_end 但漏输出
      // <combat_summary> 标签时，行动轴循环会继续空转到 MAX_TURNS。
      if (combatState) combatState.status = 'ended';
    }

    // combat_attack → 同步 defender hp + 攻击方消耗到 combatState（管线不 mutate participants）
    if (name === 'combat_attack' && res && typeof res === 'object' && 'finalHp' in res) {
      const atkResult = res as CombatActionResult;
      const req = atkResult.request;
      if (combatState) {
        const defender = combatState.participants.find((p) => p.characterId === req?.defenderId);
        if (defender) {
          defender.hp = atkResult.finalHp;
          if (atkResult.isDead) defender.canAct = false;
          // 非致死击昏（statusApplied 含 昏迷）→ 失去行动能力但不算死亡
          if (atkResult.statusApplied?.some((s) => s.name === '昏迷')) {
            defender.canAct = false;
          }
        }
        // 🐛修复: 攻击方 hp/mp/sp 消耗同步进 combatState（此前只进 patches，战中数值不减）
        const attacker = combatState.participants.find((p) => p.characterId === req?.attackerId);
        const costs = req?.costs;
        if (attacker && costs) {
          if (costs.hp) attacker.hp = Math.max(0, attacker.hp - costs.hp);
          if (costs.mp) attacker.mp = Math.max(0, attacker.mp - costs.mp);
          if (costs.sp) attacker.sp = Math.max(0, attacker.sp - costs.sp);
          if (attacker.hp <= 0) attacker.canAct = false;
        }
        // 🐛修复(真机压测): 专注是"下次攻击命中+5"的一次性 buff —— 攻击结算后立即消耗，
        // 防止 rt=2 的存活窗口内被多次攻击复用（配合 combat-actions-pipeline rt=1→2 修复）
        if (attacker) {
          const hadFocus = (attacker.statusEffects ?? []).some((e) => e.name === '专注');
          if (hadFocus) {
            attacker.statusEffects = removeBuff(attacker.statusEffects ?? [], '专注').remaining;
            allPatches.push({
              op: 'remove_status_effect',
              target: `characters.${attacker.characterId}`,
              value: { name: '专注' },
              metadata: { source: 'combat-focus-consumed' },
            });
          }
        }
      }
    }

    // 🐛修复(真机压测): combat_end 的 winner 与终局战场状态矛盾时软告警（agent 单方面
    // 宣胜/宣败照单全收会污染 EXP 结算）。不硬拦 —— 投降/谈判等叙事性收场是合法的。
    if (name === 'combat_end' && args?.winner && combatState) {
      const derived = deriveWinnerFromState(combatState);
      if (derived && derived !== args.winner) {
        console.warn(
          `[combat-runner] combat_end winner=「${args.winner}」与终局状态推导「${derived}」矛盾 —— ` +
            `请核查是否为叙事性收场（投降/放走），否则可能是 agent 误判胜负`,
        );
      }
    }

    // combat_flee 成功 → 逃跑者退出战斗（跳过其后续回合；打 fled 标记与"昏迷失能"区分，
    // 失能恢复逻辑不得唤醒已逃跑单位）
    if (name === 'combat_flee' && res?.success === true && combatState) {
      const fleeName: string | undefined = args?.characterId;
      const fled = fleeName ? combatState.participants.find((p) => p.name === fleeName) : undefined;
      if (fled) {
        fled.canAct = false;
        (fled as { fled?: boolean }).fled = true;
      }
    }

    // 🐛修复: status_apply/remove、combat_block/focus 的 buff patch 同步进
    // combatState.participants.statusEffects —— 否则战中施加的 buff 在后续攻击检定/
    // 伤害管线里读不到（collectBuffCombatMods 读的是 participant.statusEffects）。
    if (Array.isArray(res.patches) && combatState) {
      for (const patch of res.patches as StatePatch[]) {
        const m = /^characters\.(.+)$/.exec(patch.target ?? '');
        if (!m) continue;
        const p = combatState.participants.find((pp) => pp.characterId === m[1]);
        if (!p) continue;
        if (patch.op === 'add_status_effect' && patch.value && typeof patch.value === 'object') {
          const eff = patch.value as StatusEffect;
          const applied = applyBuff(p.statusEffects ?? [], eff);
          if (applied.index === -1) {
            p.statusEffects = [...(p.statusEffects ?? []), applied.merged];
          } else {
            p.statusEffects = p.statusEffects.map((e, i) =>
              i === applied.index ? applied.merged : e,
            );
          }
        } else if (patch.op === 'remove_status_effect') {
          // 对抗验证补充: 兼容 string（旧 status-api）与 {name}（state-manager 契约/新 status-api）
          const key =
            typeof patch.value === 'string'
              ? patch.value
              : (patch.value as { name?: string } | undefined)?.name;
          if (key) {
            p.statusEffects = removeBuff(p.statusEffects ?? [], key).remaining;
          }
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
  combatPhase = 'turns';
  if (!summaryText) {
    let turnPtr = 0;
    let roundsCompleted = 0;

    // 🐛修复: 回合结束时 tick buff（增益在 round.start、减益/特殊在 round.end 递减），
    // 并把递减后的列表写回 participants —— 此前 runner 从不 tick，战斗内 buff 永不过期。
    // 失能类 buff（昏迷/眩晕等）过期后恢复 canAct，否则被击昏的单位永远不会醒。
    // 对抗验证补充: 过期 buff 生成补偿性 remove_status_effect patch —— 否则战中已过期的
    // 防御姿态/昏迷等会随战前/战中 add patch 一起落库，DB 角色带着"永不递减的战斗 buff"脱战。
    const INCAPACITATING_BUFFS = ['昏迷', '眩晕', '禁锢', '麻痹', '冰冻', '石化', '沉睡'];
    const tickRoundBuffs = (): void => {
      if (!combatState) return;
      for (const p of combatState.participants) {
        // DoT 结算(2026-07-31 补,架构 §5.4: 减益在回合结束后结算)——在时长递减前,
        // 本回合在场的减益先咬一口;死亡/已倒地单位不再流血
        if (p.hp > 0 && p.statusEffects && p.statusEffects.length > 0) {
          const ticks = collectDotTicks(p.statusEffects, p.maxHp);
          if (ticks.length > 0) {
            for (const t of ticks) {
              if (p.hp <= 0) break;
              const dmg = Math.min(t.amount, p.hp);
              p.hp -= dmg;
              allPatches.push({
                op: 'delta_hp',
                target: `characters.${p.characterId}`,
                amount: -dmg,
                metadata: { source: 'combat-dot-tick', buff: t.name },
              });
            }
            if (p.hp <= 0) {
              p.hp = 0;
              p.canAct = false; // DoT 击倒 → deriveWinnerFromState 按整侧存活推导终局
            }
            emit({
              type: 'dot_tick',
              unit: p.name,
              unitId: p.characterId,
              round: combatState.round,
              ticks,
              hpAfter: p.hp,
            });
          }
        }
        if (p.statusEffects && p.statusEffects.length > 0) {
          const end = tickBuffs(p.statusEffects, 'round.end');
          const start = tickBuffs(end.remaining, 'round.start');
          p.statusEffects = start.remaining;
          for (const expired of [...end.expired, ...start.expired]) {
            allPatches.push({
              op: 'remove_status_effect',
              target: `characters.${p.characterId}`,
              value: { name: expired.name },
              metadata: { source: 'combat-buff-expired' },
            });
          }
        }
        // 失能恢复: 活着 + 未逃跑 + 已无失能类 buff → 恢复行动能力
        if (p.hp > 0 && !p.canAct && !(p as { fled?: boolean }).fled) {
          const stillIncapacitated = (p.statusEffects ?? []).some((e) =>
            INCAPACITATING_BUFFS.some((n) => e.name.includes(n)),
          );
          if (!stillIncapacitated) p.canAct = true;
        }
      }
    };

    // 对抗验证补充: 补发 round.start/end 总线事件 —— 架构 §6.2 承诺"脚本订阅 round 事件做
    // 增益结算/DoT tick"，runner 此前从不 emit，事件消费方在真实战斗中永远不会被触发。
    const advanceRound = async (): Promise<void> => {
      roundsCompleted++;
      const combatants = combatState!.participants.map((p) => p.characterId);
      try {
        await deps.eventBus.emitChain(
          'combat.round.end',
          { round: combatState!.round, combatType: combatState!.combatType },
          { combatants },
        );
      } catch {
        /* 事件链失败不阻塞回合推进 */
      }
      tickRoundBuffs();
      combatState!.round++;
      try {
        await deps.eventBus.emitChain(
          'combat.round.start',
          { round: combatState!.round, combatType: combatState!.combatType },
          { combatants },
        );
      } catch {
        /* 同上 */
      }
      emit({ type: 'round_started', round: combatState!.round });
    };

    while (combatState.status !== 'ended' && !summaryText && roundsCompleted < MAX_TURNS) {
      const orderLen = combatState.turnOrder.length;
      if (orderLen === 0) break;
      // 🐛修复: combat_start 可能被重调（增援/重开），turnOrder 长度变化时防越界
      if (turnPtr >= orderLen) turnPtr = 0;

      const unit = combatState.turnOrder[turnPtr];
      const participant = combatState.participants.find((p) => p.characterId === unit.characterId);
      // 跳过：无数据 / 无法行动 / 已死亡（hp 同步后由 combat_attack 结果驱动）
      if (!participant || !participant.canAct || participant.hp <= 0) {
        turnPtr = (turnPtr + 1) % orderLen;
        if (turnPtr === 0) await advanceRound();
        continue;
      }

      emit({
        type: 'turn_started',
        unit: unit.name,
        unitId: unit.characterId,
        round: combatState.round,
      });

      // 🐛修复: 阵营实时取自 participant.side（旧实现用循环外一次性构建的 sideOf Map，
      // combat_start 重调后映射过期，新单位会被误判为我方并卡在等玩家输入）
      const isEnemy = participant.side === 'enemy';
      let userContent: string;
      if (isEnemy) {
        userContent =
          `轮到【敌方】${unit.name} 行动（第${combatState.round}回合）。你控制其战术` +
          `（攻击/技能/道具/格挡/移动/专注），调对应工具执行，并输出本回合战斗叙事。` +
          `每单位回合限 1 次攻击 + 1 个动作。` +
          `若胜负已定：必须先调用 combat_end（传 winner）完成结算，然后才输出 <combat_summary> —— ` +
          `跳过 combat_end 将没有任何 EXP/战利品。`;
      } else if (playerControlled) {
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
          `每单位回合限 1 次攻击 + 1 个动作。` +
          `若胜负已定：必须先调用 combat_end（传 winner）完成结算，然后才输出 <combat_summary> —— ` +
          `跳过 combat_end 将没有任何 EXP/战利品。`;
      } else {
        // 🐛修复: 无玩家提交通道时降级为 agent 代打（旧实现在此 await 一个永不 resolve 的
        // Promise，整场战斗死锁）
        userContent =
          `轮到【我方】${unit.name} 行动（第${combatState.round}回合）。当前无玩家输入通道，` +
          `请按该角色的性格与战术素养代为决策（攻击/技能/道具/格挡/移动/专注），` +
          `调对应工具执行，并输出本回合战斗叙事。每单位回合限 1 次攻击 + 1 个动作。` +
          `若胜负已定：必须先调用 combat_end（传 winner）完成结算，然后才输出 <combat_summary> —— ` +
          `跳过 combat_end 将没有任何 EXP/战利品。`;
      }
      messages.push({ role: 'user', content: userContent });

      // 行动经济计数器: 本单位回合 1 攻击 + 1 动作
      turnEconomy = { actorId: unit.characterId, attacks: 1, actions: 1 };
      const result = await client.chatWithTools(
        { messages, tools, tool_choice: 'auto' },
        toolCallback,
        { maxRounds: MAX_TOOL_ROUNDS },
      );
      turnEconomy = null;
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
      if (turnPtr === 0) await advanceRound();
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
  // 🐛修复(真机压测): agent 漏调 combat_end 时，优先用终局战场状态确定性推导胜负，
  // 再退回摘要文本推断（按名主语绑定）。
  const effectiveWinner = winner ?? deriveWinnerFromState(combatState);
  const sides = combatState
    ? {
        allyNames: combatState.participants.filter((p) => p.side === 'ally').map((p) => p.name),
        enemyNames: combatState.participants.filter((p) => p.side === 'enemy').map((p) => p.name),
      }
    : undefined;
  const outcome = inferOutcome(summaryText, effectiveWinner, sides);
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

/** 推断胜负结果（combat_end 的 winner 参数 > 终局战场状态 > 摘要文本） */
export function inferOutcome(
  summaryText: string | undefined,
  winner: 'ally' | 'enemy' | 'draw' | undefined,
  /** 🐛修复(真机压测): 参战者名单。真机 agent 摘要用角色名（"刀疤溃败投降"）而非
   *  我方/敌方泛称，仅靠泛称词表会把明确胜局误判成 draw。传入后按名绑定主语。 */
  sides?: { allyNames: string[]; enemyNames: string[] },
): CombatSummaryResult['outcome'] {
  if (winner === 'ally') return 'ally_win';
  if (winner === 'enemy') return 'enemy_win';
  const s = summaryText ?? '';
  // 🐛修复: 逃跑检测必须先于 winner==='draw' —— combat_end 的 winner 枚举没有
  // 'fled'，逃跑收场只能传 'draw'，若先返回 draw 则 outcome:'fled' 在合规流程中永不可达。
  if (/逃跑|逃脱|撤退成功|成功逃脱/.test(s)) return 'fled';
  if (winner === 'draw') return 'draw';

  // 🐛修复(对抗验证 ×2): 主语绑定按**分句**进行，不用 .{0,12} 距离窗口 ——
  // 窗口会跨越逗号让败方主语"借用"胜方子句的动词（"敌人全灭，主角获胜"曾误判 draw），
  // 也会被"殊死搏斗"这类复合词内的裸字击中（"主角…殊死搏斗最终获胜"曾误判 enemy_win）。
  // 规则: 按标点切分句；每个分句内同时含主语词与结果词才计票；用完整词（阵亡/获胜）不用裸字（死/胜）。
  const ALLY_SUBJECT = /(我方|主角|玩家|英雄|队友)/;
  const ENEMY_SUBJECT = /(敌方|敌人|敌军|对手)/;
  const WIN_WORDS = /(获胜|胜利|战胜|取胜|告捷|大胜|凯旋|压制性?胜)/;
  const DEFEAT_WORDS =
    /(阵亡|战死|身亡|殒命|全灭|覆灭|溃败|被歼|被击败|败北|战败|全军覆没|倒下|被击倒|死亡|投降|被制服|被俘|被斩杀|被终结)/;

  const hasName = (clause: string, names: string[]): boolean =>
    names.some((n) => n && clause.includes(n));

  let allyWin = false;
  let enemyWin = false;
  for (const clause of s.split(/[，。！？；、\n,!?;]/)) {
    if (!clause) continue;
    const allySide = ALLY_SUBJECT.test(clause) || hasName(clause, sides?.allyNames ?? []);
    const enemySide = ENEMY_SUBJECT.test(clause) || hasName(clause, sides?.enemyNames ?? []);
    // 主语歧义的分句（两方都出现）不计票，避免"敌人被主角战胜"类被动句误判
    if (allySide === enemySide) continue;
    if (allySide) {
      if (WIN_WORDS.test(clause)) allyWin = true;
      if (DEFEAT_WORDS.test(clause)) enemyWin = true;
    } else {
      if (WIN_WORDS.test(clause)) enemyWin = true;
      if (DEFEAT_WORDS.test(clause)) allyWin = true;
    }
  }
  if (allyWin && !enemyWin) return 'ally_win';
  if (enemyWin && !allyWin) return 'enemy_win';
  return 'draw';
}

/**
 * 🐛修复(真机压测): 终局战场状态推导胜负 —— agent 有 2/10 概率不调 combat_end 直接输出
 * <combat_summary>（跳过结算），此时 winner 为空、文本推断不可靠。一方全部倒下/失能/
 * 逃光而另一方仍有战力时，引擎可确定性判定胜负，优先于文本推断。
 */
export function deriveWinnerFromState(
  combat: CombatState | undefined,
): 'ally' | 'enemy' | undefined {
  if (!combat) return undefined;
  const isDown = (p: CombatParticipant): boolean =>
    p.hp <= 0 || !p.canAct || (p as { fled?: boolean }).fled === true;
  const allies = combat.participants.filter((p) => p.side === 'ally');
  const enemies = combat.participants.filter((p) => p.side === 'enemy');
  if (allies.length === 0 || enemies.length === 0) return undefined;
  const alliesDown = allies.every(isDown);
  const enemiesDown = enemies.every(isDown);
  if (enemiesDown && !alliesDown) return 'ally';
  if (alliesDown && !enemiesDown) return 'enemy';
  return undefined;
}
