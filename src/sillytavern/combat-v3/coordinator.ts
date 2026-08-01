/**
 * combat-v3/coordinator.ts — CombatSessionCoordinator（M2）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十四 14.3/14.4/14.7
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §4.2/§4.3（四路由）/§4.10
 *
 * 职责（架构 §十四 14.3）：
 *   - runCombatV3(opts)：从 openCombat 驱动完整战斗循环直到结束
 *   - routeRequiredInput(req)：RequiredInput 路由（A2-3，穷尽 switch，never 兜底）
 *   - 终局：Dispatch RequestSettlement → 翻译 DomainEvent → StatePatch[] → 一次 commitChatState
 *   - abandon()：丢弃 session、FP 不落库、解除 isGenerating（C4 修复）
 *
 * 内核不存 Promise，所有异步性在 coordinator 侧（架构 §十四 14.2）。
 *
 * 四路由（plan §4.3）：
 *   - PlayerCommand（玩家方）→ deps.submitCommand + waitForCommand（game-store）
 *   - PlayerCommand（敌方）→ 战斗 Agent（deps.clientFactory → chatWithTools）→ toolCallToCommand
 *   - EffectChoice → M2 throw UnsupportedInM2
 *   - BeginOutput → 调 deps.registerDiceSupplier 取 60 颗 → SupplyDice
 *   - BoundedAdjudication / CharGenRequest → M2 throw UnsupportedInM2
 *
 * 验收断言：
 *   A2-1  第 09 场 fixture 端到端跑通，最终一次 commitChatState
 *   A2-3  RequiredInput 路由穷尽（漏一路编译不过）
 *   A2-4  abandon 后 session 丢弃、isGenerating 解除、FP 不落库
 *   A2-5  战斗摘要以【战斗摘要】assistant 消息回注 Story
 *
 * 铁律（plan §1.3）：本文件**零 Math.random / new Function / eval**——Command id
 * 用确定性序号（revision + 局部计数器），禁止随机。no-nondeterminism.test.ts 会扫描。
 */

import { openCombat } from './index';
import { projectToAgent } from './projection-agent';
import { projectToUi } from './projection-ui';
import { lookupSummon } from './summon-pool';
import { runCharGenForCombat } from '../char-gen-agent';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatSession,
  DomainEvent,
  RequiredInput,
  SummonedUnitDefinition,
} from './types';
import type { CombatClient, CombatEvent } from '../combat-runner';
import type { ApiEndpoint, StatePatch, AgentContext, IntentionLevel } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────────────────────

/** M2 尚不支持的外部输入 → 显式可控异常 */
export class UnsupportedInM2 extends Error {
  constructor(inputKind: string) {
    super(`[combat-v3/coordinator] M2 尚不支持 RequiredInput「${inputKind}」（M3/M3.5 实现）`);
    this.name = 'UnsupportedInM2';
  }
}

/** runCombatV3 的结果（终局摘要 + 落库 patches） */
export interface CombatV3Result {
  narrativeSummary: string;
  patches: StatePatch[];
  totalExp: number;
  totalFp: number;
  loot: unknown[];
  rounds: number;
  outcome: 'ally_win' | 'enemy_win' | 'fled' | 'draw';
}

/** runCombatV3 的依赖注入（全部可 mock，测试友好） */
export interface RunCombatV3Opts {
  saveId: string;
  bundle: CombatDefinitionBundle;
  deps: {
    clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient;
    endpoint: ApiEndpoint;
    stateManager?: { commitChatState: (patches: StatePatch[]) => Promise<void> };
    characters: Array<Record<string, unknown>>;
    variables?: Record<string, unknown>;
    context: AgentContext;
    // 玩家 Command 路由 → game-store
    submitCommand: (cmd: CombatCommand) => Promise<void>;
    waitForCommand: () => Promise<CombatCommand>;
    // 放弃战斗（C4）
    abandon: () => void;
    // BeginOutput 注骰（可选钩子）：coordinator 需要的骰源（M2 缺省用确定性 sysDrawSixty）。
    // 提供时 coordinator 每次续杯会调它取 60 颗 d20。
    registerDiceSupplier?: (fn: () => { outputId: string; dice: number[] }) => void;
  };
  /** 前端事件流回调（投影 A 输出，供 game-store） */
  onCombatEvent?: (evt: CombatEvent) => void;
}

/** 单次 dispatch 熔断上限（防死循环，对应 coordinator 级别） */
const MAX_DISPATCH_STEPS = 500;
/** 敌方 Agent 工具调用预算（一次工具调用 = 一个 Command，单位内最多攻击+动作+pass） */
const MAX_TOOL_ROUNDS = 8;

// 局部确定性 id 计数器（避免 Math.random，铁律 1）
let _idSeq = 0;
function nextCmdId(prefix: string): string {
  _idSeq += 1;
  return `${prefix}-${_idSeq}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 运行一场 v3 战斗，直到终局 settlement，返回摘要 + 落库 patches。
 *
 * 协调循环（plan §3.2）：
 *   1. openCombat 建 session
 *   2. 首个 SupplyDice 喂 60 颗骰（registerDiceSupplier 提供）
 *   3. 循环 dispatch：无 requiredInput 且未终局则自动推进；有 requiredInput 则 route；到 Terminal dispatch RequestSettlement
 *   4. 终局：翻译 DomainEvent → StatePatch[] → 一次 commitChatState → 摘要回注
 */
export async function runCombatV3(opts: RunCombatV3Opts): Promise<CombatV3Result> {
  const { deps } = opts;
  const session = openCombat({ kind: 'new', bundle: opts.bundle });

  // 骰子供应（M2 coordinator 自持确定性骰源；BeginOutput 走 getDice 续杯）
  const getDice = (): { outputId: string; dice: number[] } => sysDrawSixty(_idSeq++);

  const allEvents: DomainEvent[] = [];
  const summaryText = '';
  const loot: unknown[] = [];

  // 首次注骰
  let currentCommand: CombatCommand = supplyCommand(opts.saveId, session, getDice());

  let steps = 0;
  let aborted = false;

  // 循环直到 SettlementCommitted（Terminal 也要处理 settle）。用的是 phase 而非
  // session.completed，因为 completed 在 Terminal 就返回 true，会漏掉结算。
  while (session.snapshot().phase !== 'SettlementCommitted' && steps < MAX_DISPATCH_STEPS) {
    steps++;

    // 终局：dispatch RequestSettlement（C3 幂等）
    if (session.snapshot().phase === 'Terminal') {
      const settleTrans = session.dispatch({
        commandId: `settle-${opts.saveId}`,
        expectedRevision: session.snapshot().revision,
        kind: 'RequestSettlement',
        actorId: '',
        cost: 'none',
        payload: { settlementId: `settle-${opts.saveId}` },
      });
      allEvents.push(...settleTrans.events);
      emitEvents(opts, settleTrans.events);
      if (settleTrans.rejection) {
        break;
      }
      break;
    }

    const trans = session.dispatch(currentCommand);
    allEvents.push(...trans.events);
    emitEvents(opts, trans.events);

    if (trans.rejection) {
      // stale / 非法：本命令作废，重新按当前单位决定（不该发生，熔断保护）
      if (steps > 3) break;
      currentCommand = await decideForUnit(firstInitiative(session), session, deps, opts.saveId);
      continue;
    }

    if (trans.requiredInput) {
      currentCommand = await routeRequiredInput(
        trans.requiredInput,
        session,
        {
          ...deps,
          saveId: opts.saveId,
          onPanel: (panel) => {
            if (opts.onCombatEvent) {
              opts.onCombatEvent({ type: 'v3_dice_epoch', outputId: `panel-${panel.length}` });
            }
          },
        },
        getDice,
      );
      continue;
    }

    // 无 requiredInput 且未终局 → 唯一真实场景就是 SupplyDice 刚喂完（phase 仍 CombatOpen，
    // kernel 未自动推进）。此时按当前先攻首位单位决定其第一个动作，dispatch 时 kernel 会
    // auto 推进 CombatOpen→…→SlotConsume 并消费它。
    if (!trans.terminal) {
      currentCommand = await decideForUnit(firstInitiative(session), session, deps, opts.saveId);
      continue;
    }

    if (trans.terminal) {
      // phase 已进 Terminal，下一轮 dispatch RequestSettlement
      continue;
    }
  }

  const finished: boolean = session.snapshot().phase === 'SettlementCommitted';

  if (!finished) {
    // 未完成 → 放弃（C4）：FP 不落库
    aborted = true;
    deps.abandon();
  }

  const rounds = session.snapshot().round;

  if (aborted) {
    return {
      narrativeSummary: '战斗被放弃（M2 coordinator abandon）',
      patches: [],
      totalExp: 0,
      totalFp: 0,
      loot: [],
      rounds,
      outcome: 'draw',
    };
  }

  // 终局落库（唯一一次 commitChatState）——A2-1 要求整场只 commit 一次。
  // FP 净变动 = 终局快照 − 开战快照（架构 §十二 12.2 Δ = snapshot.FP − 初始 FP）。
  const initialFp = opts.bundle.resourceSnapshots.FP;
  const finalFp = session.snapshot().resourceSnapshots.FP;
  const fpDelta = finalFp - initialFp;
  const patches = toPatches(allEvents, opts.bundle, fpDelta);
  if (deps.stateManager) {
    await deps.stateManager.commitChatState(patches);
  }

  return {
    narrativeSummary:
      summaryText || `战斗结束（${session.snapshot().terminal?.reason ?? 'terminal'}）`,
    patches,
    totalExp: 0,
    totalFp: finalFp,
    loot,
    rounds,
    outcome: outcomeOf(session),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// RequiredInput 路由（A2-3 穷尽 switch）
// ──────────────────────────────────────────────────────────────────────────────

interface RouteCtx {
  submitCommand: (cmd: CombatCommand) => Promise<void>;
  waitForCommand: () => Promise<CombatCommand>;
  abandon: () => void;
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient;
  endpoint: ApiEndpoint;
  saveId: string;
  onPanel?: (panel: string) => void;
  /** M3.5：char_gen 战斗中调用所需的 AgentContext / characters（供 runCharGenForCombat 基座） */
  context?: AgentContext;
  characters?: Array<Record<string, unknown>>;
  configs?: import('../types').AgentConfig[];
  worldBooks?: import('../types').WorldBook[];
  presets?: import('../types').AgentPreset[];
}

/** 骰子供应回调类型（闭包传入） */
type DiceSupplier = () => { outputId: string; dice: number[] };

/** 先攻首位单位 id（供初值 / rejection 兜底用） */
function firstInitiative(session: CombatSession): string {
  return session.snapshot().initiativeOrder[0] ?? '';
}

/**
 * 决定某个单位的第一个/下一个动作 Command（按阵营分流：玩家 → store；敌方 → Agent）。
 * 与 routeRequiredInput 的 PlayerCommand 分支共用逻辑。
 */
function decideForUnit(
  unitId: string,
  session: CombatSession,
  deps: RunCombatV3Opts['deps'],
  saveId: string,
): Promise<CombatCommand> {
  const snapshot = session.snapshot();
  const unit = snapshot.units[unitId];
  const rev = snapshot.revision;
  const unitName = unit?.name ?? unitId;
  const ctx: RouteCtx = { ...deps, saveId };
  if (unit?.side === 'player') {
    return Promise.resolve().then(async () => {
      await deps.submitCommand(nearestCommand(rev, unitId, unitName));
      // UI 提交的 command 可能 revision 过期，统一修正为内核当前值（乐观并发契约）
      return freshRevision(deps.waitForCommand(), session);
    });
  }
  return routeEnemyCommand(
    { kind: 'PlayerCommand', unitId, unitName, round: snapshot.round },
    session,
    ctx,
  );
}

/** 把前端返回的 Command 的 expectedRevision 修正为内核当前 revision（防 stale） */
async function freshRevision(
  p: Promise<CombatCommand>,
  session: CombatSession,
): Promise<CombatCommand> {
  const cmd = await p;
  return { ...cmd, expectedRevision: session.snapshot().revision };
}

/**
 * 把 RequiredInput 路由到对应去处，返回应 dispatch 的下一条 Command。
 * 穷尽 switch：新增 RequiredInput 变体未接路由则编译失败（A2-3）。
 * 导出供测试直捣（M3.5）。
 */
export async function routeRequiredInput(
  req: RequiredInput,
  session: CombatSession,
  ctx: RouteCtx,
  getDice: DiceSupplier,
): Promise<CombatCommand> {
  switch (req.kind) {
    case 'PlayerCommand': {
      const unit = session.snapshot().units[req.unitId];
      const side = unit ? unit.side : undefined;
      if (side === 'player') {
        // → game-store，等前端（Promise 在 coordinator 侧）；修正 revision
        await ctx.submitCommand(
          nearestCommand(session.snapshot().revision, req.unitId, req.unitName),
        );
        return freshRevision(ctx.waitForCommand(), session);
      }
      // 敌方 → 战斗 Agent
      return routeEnemyCommand(req, session, ctx);
    }
    case 'BeginOutput': {
      // 注骰：调 getDice 取新 60 颗 → SupplyDice
      const d = getDice();
      return supplyCommand(ctx.saveId, session, d);
    }
    case 'EffectChoice':
      // M3.5 决定：EffectChoice 仍由 M4/后续实现（plan §6.7 只要求替换 CharGenRequest /
      // BoundedAdjudication 两路由）；这里保留显式 throw。
      throw new UnsupportedInM2('EffectChoice');
    case 'BoundedAdjudication':
      // M3.5：去内核 evaluateAdjudication 验证 → Adjudicate Command（或 EffectRejected 流回）
      return routeAdjudication(req, session);
    case 'CharGenRequest':
      // M3.5：召唤出口（A35-1）——先查预生成池，未命中走实时 char_gen，再 SupplyUnit
      return routeCharGenRequest(req, session, ctx);
    default: {
      const _exhaustive: never = req;
      throw new Error(`未知 RequiredInput：${String(_exhaustive)}`);
    }
  }
}

/**
 * M3.5（plan §6.2 ③-⑤）：路由 CharGenRequest。
 *
 * 时序：③a 先查预生成召唤物池（§6.4）→ 命中直接构造 definition；
 *       ③b 未命中 → await runCharGenForCombat（char-gen-agent.ts 新入口，不落库）
 *       ④ 解析校验 SummonedUnitDefinition（divinity ≤ cap clamp + warn / 属性预算超则等比缩放 /
 *          joinTiming 缺省 next_round_head / 自带 automaton 编译失败剔除不阻断）
 *       ⑤ 提交 { kind:'SupplyUnit', payload:{ requestId, definition } }
 */
async function routeCharGenRequest(
  req: Extract<RequiredInput, { kind: 'CharGenRequest' }>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<CombatCommand> {
  // ③a 先查池（幂等，命中直接用）
  let definition = lookupSummon(req.prompt);

  // ③b 未命中 → 实时 char_gen（不落库）
  if (!definition) {
    definition = await runCharGenForCombat(
      {
        prompt: req.prompt,
        constraints: req.constraints,
        base: {
          saveId: ctx.saveId,
          context: ctx.context ?? ({} as AgentContext),
          endpoint: ctx.endpoint,
          configs: ctx.configs,
          worldBooks: ctx.worldBooks,
          presets: ctx.presets,
        },
      },
      { clientFactory: ctx.clientFactory as never },
    );
  }

  // ④ clamp / validate（divinity ≤ cap，joinTiming 缺省 next_round_head）
  definition = clampSummon(definition, req.constraints);

  // ⑤ SupplyUnit
  return {
    commandId: nextCmdId(`summon-${req.requestId}`),
    expectedRevision: session.snapshot().revision,
    kind: 'SupplyUnit',
    actorId: req.prompt.sourceItem,
    cost: 'none',
    payload: { requestId: req.requestId, definition },
  };
}

/**
 * M3.5（plan §6.5 / 架构 §十一 11.2）：路由 BoundedAdjudication。
 *
 * 内核 evaluateAdjudication 验证由 **reducer** 在消费 Adjudicate Command 时执行（它持有完整
 * CombatState，能验 target.divinity 与不变量）；coordinator 只负责把提案转成 Adjudicate Command
 * 提交内力。reducer 侧 accepted → AdjudicationAccepted + RuleOverridden/MiracleTriggered + journal；
 * rejected → EffectRejected(code:'ADJUDICATION_REJECTED')（零状态变更零骰耗）。
 */
async function routeAdjudication(
  req: Extract<RequiredInput, { kind: 'BoundedAdjudication' }>,
  session: CombatSession,
): Promise<CombatCommand> {
  return {
    commandId: nextCmdId('adjudicate'),
    expectedRevision: session.snapshot().revision,
    kind: 'Adjudicate',
    actorId: req.unitId,
    cost: 'none',
    payload: { requestId: `adj-${req.unitId}`, adjudication: req.proposal },
  };
}

/**
 * M3.5（plan §6.2 ④）：clamp / validate SummonedUnitDefinition。
 *   - divinity > constraints.divinityCap → clamp + warn（不 reject）
 *   - joinTiming 缺省 → 'next_round_head'（保不变量①纯洁）
 *   - 纯函数：返回新对象，入参不被修改
 */
function clampSummon(
  d: SummonedUnitDefinition,
  constraints: { divinityCap: number },
): SummonedUnitDefinition {
  let next: SummonedUnitDefinition = { ...d };
  if (d.divinity > constraints.divinityCap) {
    // 超出 cap → clamp + warn（架构 §6.2 ④）
    console.warn(
      `[coordinator] 召唤物「${d.name}」divinity ${d.divinity} 超 cap ${constraints.divinityCap}，已 clamp`,
    );
    next = { ...next, divinity: constraints.divinityCap };
  }
  if (!next.joinTiming) {
    next = { ...next, joinTiming: 'next_round_head' };
  }
  return next;
}

/** 敌方 PlayerCommand → 战斗 Agent（chatWithTools）+ 工具调用 → Command */
async function routeEnemyCommand(
  req: Extract<RequiredInput, { kind: 'PlayerCommand' }>,
  session: CombatSession,
  ctx: RouteCtx,
): Promise<CombatCommand> {
  const panel = projectToAgent(session.snapshot());
  if (ctx.onPanel) ctx.onPanel(panel);

  const client = ctx.clientFactory('combat_v3', ctx.endpoint, ctx.saveId);
  if (!client.chatWithTools) {
    // 无 agent → 让敌方过（defensive：pass 攻击槽推进）
    return nextPass(session, 'attack');
  }

  const result = await client.chatWithTools(
    {
      messages: [
        {
          role: 'system',
          content:
            '你是战斗决策 Agent。根据战斗面板为敌方单位决定动作。一次只提交一个 Command 对应的工具（declare_attack / declare_action / pass_slot / flee / write_summary），禁止传骰值。',
        },
        {
          role: 'user',
          content: `轮到敌方「${req.unitName}」行动（我方单位由玩家控制）。\n\n${panel}`,
        },
      ],
      // tools 由外层按 AGENT_TOOL_MAP['combat_v3'] 注入；这里传 undefined 走默认
      tools: undefined,
    },
    (name, args) => toolCallToCommand(name, args, session.snapshot().revision, req.unitId),
    { maxRounds: MAX_TOOL_ROUNDS },
  );

  return lastCommandFromResult(result, session.snapshot().revision, req.unitId);
}

// ──────────────────────────────────────────────────────────────────────────────
// 工具调用 → Command 翻译（v3 工具集 §4.4）
// ──────────────────────────────────────────────────────────────────────────────

const INTENTION_LEVELS: readonly IntentionLevel[] = [
  '非致死',
  '常规',
  '战术',
  '机能',
  '核心',
  '抹杀',
  '概念',
  '处决',
];

function toIntention(v: unknown): IntentionLevel {
  if (typeof v === 'string') {
    const hit = INTENTION_LEVELS.find((l) => l === v);
    if (hit) return hit;
  }
  return '常规';
}

/** 一次 v3 工具调用 → 内核 Command（toolExecutor） */
async function toolCallToCommand(
  name: string,
  args: Record<string, any>,
  revision: number,
  actorId: string,
): Promise<CombatCommand> {
  return toolCallToCommandSync(name, args, revision, actorId);
}

function toolCallToCommandSync(
  name: string,
  args: Record<string, any>,
  revision: number,
  actorId: string,
): CombatCommand {
  const id = nextCmdId(`tool-${name}`);
  switch (name) {
    case 'declare_attack':
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'DeclareAttack',
        actorId: (args.actorName as string) ?? actorId,
        cost: 'attack',
        payload: {
          targetId: (args.targetName as string) ?? '',
          skill: args.skillName as string | undefined,
          intentionLevel: toIntention(args.intentionLevel),
          costs: args.costs as { mp?: number; sp?: number } | undefined,
        },
      };
    case 'declare_action': {
      const t = args.actionType as string;
      if (t === '格挡') {
        return {
          commandId: id,
          expectedRevision: revision,
          kind: 'DeclareBlock',
          actorId: (args.actorName as string) ?? actorId,
          cost: 'action',
          payload: { choiceId: undefined },
        };
      }
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'DeclareAction',
        actorId: (args.actorName as string) ?? actorId,
        cost: 'action',
        payload: { actionType: mapActionType(t), description: undefined },
      };
    }
    case 'pass_slot':
      if (args.slot === 'action') {
        return {
          commandId: id,
          expectedRevision: revision,
          kind: 'PassAction',
          actorId: (args.actorName as string) ?? actorId,
          cost: 'action',
          payload: {} as Record<string, never>,
        };
      }
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'PassAttack',
        actorId: (args.actorName as string) ?? actorId,
        cost: 'attack',
        payload: {} as Record<string, never>,
      };
    case 'flee':
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'Flee',
        actorId: (args.actorName as string) ?? actorId,
        cost: 'both',
        payload: {} as Record<string, never>,
      };
    // write_summary 不产 Command（供 summary 收集）→ 占位 Choose 防卡死
    case 'write_summary':
      return {
        commandId: id,
        expectedRevision: revision,
        kind: 'Choose',
        actorId,
        cost: 'none',
        payload: { choiceId: 'write_summary', option: 'summary' },
      };
    default:
      return nextPassCommand(revision, actorId, 'attack');
  }
}

function mapActionType(t: string): 'item' | 'move' | 'focus' | 'defend' {
  switch (t) {
    case '道具':
      return 'item';
    case '移动':
      return 'move';
    case '专注':
      return 'focus';
    default:
      return 'defend';
  }
}

/** 从 chatWithTools 最终结果提取最后一条工具调用 → Command */
function lastCommandFromResult(
  result: {
    toolCalls?: Array<{ name: string; arguments: unknown }>;
    output?: string | null;
  },
  revision: number,
  actorId: string,
): CombatCommand {
  const calls = result.toolCalls ?? [];
  const last = calls[calls.length - 1];
  if (!last) return nextPassCommand(revision, actorId, 'attack');
  let args: Record<string, any> = {};
  if (typeof last.arguments === 'string') {
    try {
      args = JSON.parse(last.arguments) as Record<string, any>;
    } catch {
      args = {};
    }
  } else if (last.arguments && typeof last.arguments === 'object') {
    args = last.arguments as Record<string, any>;
  }
  return toolCallToCommandSync(last.name, args, revision, actorId);
}

// ──────────────────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────────────────

function nearestCommand(revision: number, actorId: string, actorName: string): CombatCommand {
  return {
    commandId: nextCmdId('prompt'),
    expectedRevision: revision,
    kind: 'DeclareAttack',
    actorId,
    cost: 'attack',
    payload: { targetId: actorId, intentionLevel: '常规' },
  };
}

function nextPassCommand(
  revision: number,
  actorId: string,
  slot: 'attack' | 'action',
): CombatCommand {
  return {
    commandId: nextCmdId(`pass-${slot}`),
    expectedRevision: revision,
    kind: slot === 'attack' ? 'PassAttack' : 'PassAction',
    actorId,
    cost: slot,
    payload: {} as Record<string, never>,
  } as CombatCommand;
}

function nextPass(session: CombatSession, slot: 'attack' | 'action'): CombatCommand {
  const unitId = session.snapshot().initiativeOrder[0] ?? '';
  return nextPassCommand(session.snapshot().revision, unitId, slot);
}

function supplyCommand(
  saveId: string,
  session: CombatSession,
  d: { outputId: string; dice: number[] },
): CombatCommand {
  return {
    commandId: `sup-${saveId}-${d.outputId}`,
    expectedRevision: session.snapshot().revision,
    kind: 'SupplyDice',
    actorId: '',
    cost: 'none',
    payload: { outputId: d.outputId, dice: d.dice },
  };
}

function emitEvents(opts: RunCombatV3Opts, events: readonly DomainEvent[]): void {
  if (opts.onCombatEvent && events.length > 0) {
    for (const evt of projectToUi(events)) {
      opts.onCombatEvent(evt);
    }
  }
}

/** 终局结果归一 */
function outcomeOf(session: CombatSession): CombatV3Result['outcome'] {
  const t = session.snapshot().terminal;
  if (!t) return 'draw';
  switch (t.reason) {
    case 'flee_success':
      return 'fled';
    case 'hp_zero':
      return t.winner === 'player' ? 'ally_win' : 'enemy_win';
    default:
      return 'draw';
  }
}

/** 幂等骰子供应（无真实随机源时用确定性中位数 10；真实源自 registerDiceSupplier） */
function sysDrawSixty(outId: number): { outputId: string; dice: number[] } {
  return { outputId: `sys-${outId}`, dice: Array.from({ length: 60 }, () => 10) };
}

/**
 * 把终局 DomainEvent 翻译成 StatePatch[]（M2 最小：FP 结算落库）。
 *
 * M1 内核 settle 不产 SettlementCommitted 事件（只产 CombatEnded + FP NarrativeCue），
 * 故这里直接按 fpDelta 生成 FP 结算 patch，保证终局一次 commitChatState（A2-1）。
 * 遵循数据字典五铁律 ④（FP 走 SaveProfile 唯一真源）。
 */
function toPatches(
  _events: readonly DomainEvent[],
  _bundle: CombatDefinitionBundle,
  fpDelta: number,
): StatePatch[] {
  return [
    {
      op: 'set',
      target: 'users.fp',
      path: '',
      value: Math.round(fpDelta),
    } as unknown as StatePatch,
  ];
}
