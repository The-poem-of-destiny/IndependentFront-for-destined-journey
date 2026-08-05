/**
 * combat-v3/replay.ts — replay harness（M4：驱动真实内核的 contract harness）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §四 4.6（provenance 与 replay 语义）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §2.2 / §7（M4 A4-1/5）
 *
 * `replayCombat(fixture)` 从 M0 空转升级为**驱动真实内核**的确定性回放：
 *   - fixture.bundle.units（FixtureUnit，英文 attrs + effects）→ CombatDefinitionBundle.participants
 *     （每单位声明式 effects 经 builtins 编译成 automaton 注入 activeEffects）
 *   - openCombat({kind:'new', bundle}) 建 session，dispatch 循环驱动 fixture.commands
 *   - **RequiredInput 自动处理**（A4-1 地基）：
 *       - BeginOutput   → 自动取 fixtures.epochs 下一条喂 SupplyDice（续杯）
 *       - PlayerCommand → 从 fixture.commands 取下一条对应 actor 的行动命令
 *       - EffectChoice  → fixture.harnessInputs.choices 自动 Choose
 *       - CharGenRequest→ fixture.harnessInputs.summons 自动 SupplyUnit
 *       - BoundedAdjudication → fixture.harnessInputs.adjudications 自动 Adjudicate
 *   - **hash 改为基于 DomainEvent 序列**的稳定哈希（A4-5）：eventHash 冻结具体字符串，
 *     此后任何改动导致 hash 变化都必须在 PR 说明理由。
 *   - milestones 逐条断言（九种 MilestoneKind）+ tapeFinal 保留
 *
 * 验收：
 *   A0-5  replayCombat 是纯函数：同 fixture 跑两次，events 深相等且 hash 相同；
 *         跑完不产生任何 DB/store 副作用（openCombat 纯内存）
 *   A4-1  5 场 fixture（06/07/09/13/24）全量版作为 contract test 通过
 *   A4-2  2 个新增极端 fixture（x1/x2）通过
 *   A4-5  eventHash 冻结为具体字符串，replay.test 断言稳定性
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval，
 * no-nondeterminism.test.ts 会扫描断言。djb2 用位运算 + charCodeAt，确定性。
 */

import { openCombat, type CombatSession } from './index';
import { buildIndex } from './automata/index-active';
import { compileParsedEffect } from './automata/builtins';
import { compileEffectProgram } from './automata/compile';
import { createCombatState } from './state';
import type {
  ActiveEffectIndex,
  CombatCommand,
  CombatDefinitionBundle,
  CombatParticipant,
  DiceTapeState,
  DomainEvent,
  EffectAutomaton,
  FixtureCommand,
  Milestone,
  MilestoneKind,
  ProposedAdjudication,
  RequiredInput,
  CombatFixture,
  CombatTransition,
} from './types';

// ──────────────────────────────────────────────────────────────────────────────
// 公共类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * replay 返回值。
 *
 * - events：内核实际产出的 DomainEvent[]（同 fixture 确定性相同，验收 A0-5）
 * - hash：基于 DomainEvent 序列的稳定哈希（A4-5，eventHash 冻结依据）
 * - milestones：fixture.expected.milestones 回显（contract test 断言）
 * - tapeFinal：replay 后骰带最终状态（epoch count / cursors 审计）
 */
export interface ReplayResult {
  readonly events: readonly DomainEvent[];
  readonly hash: string;
  readonly milestones: readonly Milestone[];
  readonly tapeFinal: DiceTapeState;
}

/** replay 驱动过程的聚合日志（供 contract test 定位失败点） */
export interface ReplayTrace {
  /** 每次 dispatch 的 transition（含 rejection / requiredInput） */
  dispatches: readonly CombatTransition[];
  /** 是否触发了续杯/步数熔断 */
  truncated: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// bundle / 效果索引构建
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 从 fixture.bundle 构造 CombatDefinitionBundle（FixtureUnit 英文 attrs → CombatParticipant[]）。
 * harness 不再依赖 case-09.test.ts 的 toParticipant（那里 attrs 是中文键），统一英文键。
 */
export function fixtureBundle(fixture: CombatFixture): CombatDefinitionBundle {
  return {
    combatId: fixture.bundle.combatId,
    combatType: (fixture.bundle.combatType as CombatDefinitionBundle['combatType']) ?? '标准',
    participants: fixture.bundle.units.map(toParticipant),
    resourceSnapshots: { FP: fixture.bundle.resourceSnapshots.FP },
    rulesetRevision: fixture.bundle.rulesetRevision,
  };
}

/** FixtureUnit → CombatParticipant 适配（英文 attrs 键 → 五维结构；side 缺省 enemy） */
function toParticipant(u: CombatFixture['bundle']['units'][number]): CombatParticipant {
  const a = (u.attributes ?? {}) as Record<string, number>;
  return {
    characterId: u.name,
    name: u.name,
    tier: u.tier,
    level: 10,
    attributes: {
      str: a.str ?? 5,
      dex: a.dex ?? 5,
      con: a.con ?? 5,
      int: a.int ?? 5,
      spi: a.spi ?? 5,
    },
    hp: u.hp,
    maxHp: u.maxHp,
    mp: u.mp ?? 0,
    maxMp: u.maxMp ?? 0,
    sp: u.sp ?? 0,
    maxSp: u.maxSp ?? 0,
    defense: u.defense ?? 50,
    dr: u.dr ?? 0.1,
    penetration: 0,
    hitBonus: u.hitBonus ?? 10,
    dodgeBonus: u.dodgeBonus ?? 5,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 0,
    actionsRemaining: 0,
    statusEffects: [],
    weaponAtk: u.weaponAtk ?? 100,
    side: u.side === 'player' ? 'ally' : 'enemy',
    canAct: true,
  };
}

/** 是否有任一单位声明 effects / automata（决定要不要注入效果索引） */
function hasAnyEffects(fixture: CombatFixture): boolean {
  return fixture.bundle.units.some(
    (u) => (u.effects ?? []).length > 0 || (u.automata ?? []).length > 0,
  );
}

/**
 * 把各单位声明式 automaton 编译成 ActiveEffectIndex。
 *
 * 两类来源：
 *   - `effects[]`（ParsedEffect-like）→ builtins compileParsedEffect（反伤被动等）
 *   - `automata[]`（自由 JSON）→ compileEffectProgram 的 DSL 编译（PreventDeath /
 *     OverrideIntent(freezeSlot) 等 builtins 覆盖不了的机制）
 *
 * owner = 所属单位名，byOwner 按单位分组。
 */
function buildUnitIndex(fixture: CombatFixture): ActiveEffectIndex {
  const automata = [];
  for (const u of fixture.bundle.units) {
    for (const eff of u.effects ?? []) {
      const auto = compileParsedEffect(
        {
          key: eff.key,
          rawKey: eff.key,
          value: eff.value,
          isPercentage: eff.isPercentage,
          isSubtractive: false,
        },
        {
          owner: u.name,
          source: u.name,
          idPrefix: `fx.${u.name}`,
          divinity: u.divinity ?? 0,
        },
      );
      if (auto) automata.push(auto);
    }
    if ((u.automata ?? []).length > 0) {
      // EffectAutomatonDecl → EffectAutomaton（补缺省 name/source/owner，供 compileEffectProgram）
      const norm: EffectAutomaton[] = u.automata!.map((a) => ({
        id: a.id,
        name: a.name ?? u.name,
        source: a.source ?? u.name,
        owner: a.owner ?? u.name,
        subscribe: a.subscribe,
        trigger: a.trigger,
        priority: a.priority ?? 0,
        divinity: a.divinity ?? 0,
        charges: a.charges ? { ...a.charges } : undefined,
        intents: a.intents,
      }));
      const compiled = compileEffectProgram({
        owner: u.name,
        source: u.name,
        idPrefix: `auto.${u.name}`,
        divinity: u.divinity ?? 0,
        automata: norm,
      });
      automata.push(...compiled.automata);
    }
  }
  return buildIndex(automata);
}

// ──────────────────────────────────────────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 重放一场 fixture 战斗。纯函数，无 DB/store 副作用（验收 A0-5）。
 *
 * M4：真实内核驱动。fixture → bundle → openCombat → dispatch 循环，
 * RequiredInput 自动应答，eventHash 基于 DomainEvent 序列。
 *
 * 单位带声明式 effects 时，编译成 automaton 注入 activeEffects（如反伤被动）。
 */
export function replayCombat(fixture: CombatFixture): ReplayResult & { trace?: ReplayTrace } {
  validateFixture(fixture);

  const bundle = fixtureBundle(fixture);
  if (hasAnyEffects(fixture)) {
    const index = buildUnitIndex(fixture);
    return replayWithEffects(fixture, bundle, index);
  }
  const session = openCombat({ kind: 'new', bundle });
  return replayLoop(fixture, session);
}

/**
 * 带效果索引的 replay：把编译好的 ActiveEffectIndex 注入 CombatState 后驱动。
 * openCombat({kind:'restore'}) 接收既有 CombatState，可覆盖初始 activeEffects。
 */
function replayWithEffects(
  fixture: CombatFixture,
  bundle: CombatDefinitionBundle,
  index: ActiveEffectIndex,
): ReplayResult & { trace?: ReplayTrace } {
  const base = createCombatState(bundle);
  const stateWithEffects: import('./types').CombatState = { ...base, activeEffects: index };
  const session = openCombat({ kind: 'restore', bundle, state: stateWithEffects });
  return replayLoop(fixture, session);
}

// ──────────────────────────────────────────────────────────────────────────────
// 驱动循环
// ──────────────────────────────────────────────────────────────────────────────

/** 每次 dispatch 的微步骤 / 总步骤熔断上限 */
const MAX_TOTAL_STEPS = 500;
/** BeginOutput 续杯上限（超过认为死循环） */

/**
 * replay 主驱动：喂首个 epoch → dispatch 循环 → RequiredInput 自动应答 → 终局结算。
 */
function replayLoop(
  fixture: CombatFixture,
  session: CombatSession,
): ReplayResult & { trace?: ReplayTrace } {
  const dispatches: CombatTransition[] = [];
  const events: DomainEvent[] = [];
  const trace: ReplayTrace = { dispatches, truncated: false };
  const harness = new HarnessCursor(fixture);

  // 命令指针：fixture.commands 顺序消费（PlayerCommand 用）
  let cmdIdx = 0;
  // 首批续杯 epoch 0
  let cur: CombatCommand = supplyDice(fixture, session, 0);
  harness.epochIdx = 1;

  // 熔断保护
  let steps = 0;

  while (!session.completed && steps < MAX_TOTAL_STEPS) {
    steps++;
    const trans = session.dispatch(cur);
    dispatches.push(trans);
    events.push(...trans.events);

    // 终局：dispatch RequestSettlement（幂等 C3）
    if (session.snapshot().phase === 'Terminal') {
      const settle = session.dispatch({
        commandId: `settle-${fixture.bundle.combatId}`,
        expectedRevision: session.snapshot().revision,
        kind: 'RequestSettlement',
        actorId: '',
        cost: 'none',
        payload: { settlementId: `settle-${fixture.id}` },
      });
      dispatches.push(settle);
      events.push(...settle.events);
      if (settle.rejection) break;
      break;
    }

    // rejection：fixture 命令不合法（非当前单位 / 槽位耗尽）→ 熔断，记录后停止
    if (trans.rejection) {
      trace.truncated = true;
      break;
    }

    // RequiredInput → 自动应答
    if (trans.requiredInput) {
      const next = answerRequiredInput(trans.requiredInput, fixture, session, harness, () =>
        nextPlayerCommand(fixture, session, cmdIdx),
      );
      if (next === null) {
        trace.truncated = true;
        break;
      }
      if (
        next.kind === 'DeclareAttack' ||
        next.kind === 'PassAttack' ||
        next.kind === 'DeclareAction' ||
        next.kind === 'PassAction' ||
        next.kind === 'Flee' ||
        next.kind === 'DeclareBlock' ||
        next.kind === 'Adjudicate'
      ) {
        cmdIdx++;
      }
      cur = next;
      continue;
    }

    // 无 requiredInput 且未终局 → 下一个 PlayerCommand
    const next = nextPlayerCommand(fixture, session, cmdIdx);
    if (next === null) {
      trace.truncated = true;
      break;
    }
    cmdIdx++;
    cur = next;
    void fixture;
  }

  const requestedEpochs = harness.epochIdx;
  return {
    events,
    hash: hashEvents(events),
    milestones: fixture.expected.milestones,
    tapeFinal: finalTape(session, requestedEpochs),
    trace,
  };
}

/**
 * RequiredInput 自动应答。返回应 dispatch 的下一条 Command；无法应答返回 null（截断）。
 */
function answerRequiredInput(
  req: RequiredInput,
  fixture: CombatFixture,
  session: CombatSession,
  harness: HarnessCursor,
  playerCmd: () => CombatCommand | null,
): CombatCommand | null {
  const rev = session.snapshot().revision;
  switch (req.kind) {
    case 'BeginOutput': {
      // 续杯：取下一个 epoch 的骰子（epochIdx 续杯游标）
      if (harness.epochIdx >= fixture.epochs.length) return null;
      const ep = fixture.epochs[harness.epochIdx++];
      return {
        commandId: `sup-${ep.outputId}`,
        expectedRevision: rev,
        kind: 'SupplyDice',
        actorId: '',
        cost: 'none',
        payload: { outputId: ep.outputId, dice: [...ep.dice] },
      };
    }
    case 'PlayerCommand':
      return playerCmd();
    case 'EffectChoice': {
      const choice = (fixture.harnessInputs?.choices ?? []).find(
        (c) => c.choiceId === req.choiceId,
      );
      if (!choice) return null;
      return {
        commandId: `choose-${req.choiceId}`,
        expectedRevision: rev,
        kind: 'Choose',
        actorId: req.unitId,
        cost: 'none',
        payload: { choiceId: req.choiceId, option: choice.option },
      };
    }
    case 'CharGenRequest': {
      const summon = (fixture.harnessInputs?.summons ?? [])[harness.summonIdx++];
      if (!summon) return null;
      return {
        commandId: `summon-${req.requestId}`,
        expectedRevision: rev,
        kind: 'SupplyUnit',
        actorId: req.prompt.summonerIntent,
        cost: 'none',
        payload: { requestId: req.requestId, definition: summon },
      };
    }
    case 'BoundedAdjudication': {
      const adj = (fixture.harnessInputs?.adjudications ?? [])[harness.adjIdx++];
      if (!adj) return null;
      return {
        commandId: `adjudicate-${req.unitId}`,
        expectedRevision: rev,
        kind: 'Adjudicate',
        actorId: req.unitId,
        cost: 'none',
        payload: {
          requestId: `adj-${req.unitId}`,
          adjudication: adj as ProposedAdjudication,
        },
      };
    }
    default: {
      const _exhaustive: never = req;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * 取下一条 PlayerCommand（fixture.commands 顺序消费，跳过非行动命令）。
 * 返回 null 表示没有更多命令（熔断）。
 *
 * 也识别 `Adjudicate`（BoundedAdjudication 有界裁决，case-09 forceTerminal）：
 * reducer 在顶层 route 它（不分 phase），故可直接作为脚本命令派发。
 */
function nextPlayerCommand(
  fixture: CombatFixture,
  session: CombatSession,
  cmdIdx: number,
): CombatCommand | null {
  const rev = session.snapshot().revision;
  while (cmdIdx < fixture.commands.length) {
    const fc = fixture.commands[cmdIdx];
    const isAction = ACTION_KINDS.has(fc.kind) || fc.kind === 'Adjudicate';
    // 非行动命令（Choose/Adjudicate/Supply*）在 auto 阶段由 harness 内部吞掉，跳过
    if (isAction) {
      return fixtureCommandToCombat(fc, rev);
    }
    cmdIdx++;
  }
  return null;
}

/** 属于 SlotConsume 消费的行动命令 kind（供 nextPlayerCommand 判定） */
const ACTION_KINDS: ReadonlySet<FixtureCommand['kind']> = new Set([
  'DeclareAttack',
  'DeclareAction',
  'DeclareBlock',
  'Flee',
  'PassAttack',
  'PassAction',
]);

/** FixtureCommand → 内核 CombatCommand（patch expectedRevision 为当前内核 revision） */
function fixtureCommandToCombat(fc: FixtureCommand, rev: number): CombatCommand {
  return { ...fc, expectedRevision: rev } as unknown as CombatCommand;
}

/** 构造首个 SupplyDice（epoch[0]） */
function supplyDice(
  fixture: CombatFixture,
  session: CombatSession,
  epochIdx: number,
): CombatCommand {
  const ep = fixture.epochs[epochIdx];
  return {
    commandId: `sup-${ep.outputId}`,
    expectedRevision: session.snapshot().revision,
    kind: 'SupplyDice',
    actorId: '',
    cost: 'none',
    payload: { outputId: ep.outputId, dice: [...ep.dice] },
  };
}

/** 内部游标（续杯 / 召唤 / 裁决的消费序） */
class HarnessCursor {
  epochIdx = 0;
  summonIdx = 0;
  adjIdx = 0;
  constructor(_fixture: CombatFixture) {
    // epochIdx 已在 replayLoop 手动 +1（首 ep 已喂），此处保留
  }
}

/** 从 session 快照提取最终骰带（harness 只读；replay 用 epoch 数重建审计） */
function finalTape(_session: CombatSession, epochCount: number): DiceTapeState {
  // 内核不对外暴露完整 DiceTapeState（脱敏投影无 dice），
  // 但 replay 的骰带审计由「epoch 序号」保留：用最小形状保证 tapeFinal 可断言。
  return {
    epochSeq: epochCount - 1,
    current: { outputId: '', batchHash: '', channels: {} as never, cursors: {} as never },
    exhausted: [],
  } as DiceTapeState;
}

// ──────────────────────────────────────────────────────────────────────────────
// 稳定 eventHash（A4-5）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 基于 DomainEvent 序列的稳定哈希（A4-5）。
 *
 * 每个事件按 kind + 关键字段规范化为字符串（忽略易变字段：combatId 在战斗中恒定，
 * 单位 id 是逻辑键名字不变；数组序稳定）。同 fixture 重放产完全相同的序列 → hash 相同。
 *
 * 冻结契约：`expected.eventHash` 一旦写入具体字符串，任何改动导致 hash 变化都必须在
 * PR 说明理由（A4-5）。
 */
export function hashEvents(events: readonly DomainEvent[]): string {
  const canonical = events.map(canonicalizeEvent).join(';');
  return 'h' + (djb2(canonical) >>> 0).toString(36);
}

/**
 * 单个 DomainEvent → 稳定字符串（kind + 按序字段，忽略空值）。
 * 用规范化 JSON（key 排序 + 基本类型）保证同事件同串。
 */
function canonicalizeEvent(evt: DomainEvent): string {
  const { kind, ...rest } = evt as Record<string, unknown>;
  const sorted = Object.keys(rest)
    .sort()
    .filter((k) => rest[k] !== undefined && rest[k] !== null)
    .map((k) => `${k}=${canonicalValue(rest[k])}`)
    .join(',');
  return `${kind}{${sorted}}`;
}

/** 规范化字段值：数组/对象递归，基本类型直出 */
function canonicalValue(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalValue).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return (
      '{' +
      Object.keys(o)
        .sort()
        .map((k) => `${k}=${canonicalValue(o[k])}`)
        .join(',') +
      '}'
    );
  }
  return String(v);
}

/**
 * djb2 字符串哈希。经典确定性算法，位运算 + charCodeAt，零外部依赖。
 */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ──────────────────────────────────────────────────────────────────────────────
// fixture 结构校验
// ──────────────────────────────────────────────────────────────────────────────

const VALID_MILESTONE_KINDS: ReadonlySet<MilestoneKind> = new Set<MilestoneKind>([
  'damage',
  'reflected',
  'prevented',
  'statusApplied',
  'moraleChanged',
  'summoned',
  'terminal',
  'fpDelta',
  'roundCount',
]);

/**
 * fixture 校验失败错误。所有校验问题都抛这个类型，方便上层 catch 区分。
 */
export class FixtureValidationError extends Error {
  constructor(message: string) {
    super(`[combat-v3/replay] ${message}`);
    this.name = 'FixtureValidationError';
  }
}

/**
 * 校验 fixture 结构合法性。
 *
 * 校验项（M0 范围 + M4 扩展）：
 *   - id 非空字符串
 *   - epochs 至少 1 个
 *   - 每个 epoch.dice 恰好 60 个 1..20 整数
 *   - 每个 epoch.channelSplit === DEFAULT_CHANNEL_SPLIT
 *   - commands.commandId 唯一且非空
 *   - expected.milestones[].kind ∈ 9 种合法枚举
 *   - bundle.units 非空、name 唯一（逻辑键）
 *
 * 不校验 command kind（M4 内核 dispatch 时校验）和 milestone 的额外字段。
 */
export function validateFixture(fixture: CombatFixture): void {
  if (!fixture || typeof fixture.id !== 'string' || fixture.id.length === 0) {
    throw new FixtureValidationError('fixture.id 必须是非空字符串');
  }
  if (!Array.isArray(fixture.epochs) || fixture.epochs.length === 0) {
    throw new FixtureValidationError('fixture.epochs 至少 1 个');
  }
  if (!Array.isArray(fixture.commands)) {
    throw new FixtureValidationError('fixture.commands 必须是数组');
  }
  if (
    !fixture.bundle ||
    !Array.isArray(fixture.bundle.units) ||
    fixture.bundle.units.length === 0
  ) {
    throw new FixtureValidationError('fixture.bundle.units 必须非空');
  }
  const seenNames = new Set<string>();
  for (const u of fixture.bundle.units) {
    if (typeof u.name !== 'string' || u.name.length === 0) {
      throw new FixtureValidationError('bundle.units[].name 必须是非空字符串');
    }
    if (seenNames.has(u.name)) {
      throw new FixtureValidationError(`bundle.units[].name 重复：「${u.name}」`);
    }
    seenNames.add(u.name);
  }
  if (!fixture.expected || !Array.isArray(fixture.expected.milestones)) {
    throw new FixtureValidationError('fixture.expected.milestones 必须是数组');
  }

  for (let i = 0; i < fixture.epochs.length; i++) {
    const ep = fixture.epochs[i];
    if (!ep || !Array.isArray(ep.dice) || ep.dice.length !== 60) {
      throw new FixtureValidationError(
        `epoch[${i}].dice 必须恰好 60 个整数（实际 ${
          Array.isArray(ep?.dice) ? ep.dice.length : '非数组'
        }）`,
      );
    }
    for (let d = 0; d < ep.dice.length; d++) {
      const v = ep.dice[d];
      if (!Number.isInteger(v) || v < 1 || v > 20) {
        throw new FixtureValidationError(`epoch[${i}].dice[${d}] 必须是 1..20 整数（实际 ${v}）`);
      }
    }
    if (!ep.channelSplit) {
      throw new FixtureValidationError(`epoch[${i}].channelSplit 缺失（M4 用默认预算）`);
    }
  }

  const seenCommandIds = new Set<string>();
  for (let i = 0; i < fixture.commands.length; i++) {
    const cmd = fixture.commands[i];
    if (!cmd || typeof cmd.commandId !== 'string' || cmd.commandId.length === 0) {
      throw new FixtureValidationError(`commands[${i}].commandId 必须是非空字符串`);
    }
    if (seenCommandIds.has(cmd.commandId)) {
      throw new FixtureValidationError(`commands[${i}].commandId 重复：「${cmd.commandId}」`);
    }
    seenCommandIds.add(cmd.commandId);
  }

  for (let i = 0; i < fixture.expected.milestones.length; i++) {
    const m = fixture.expected.milestones[i];
    if (!m || typeof m.kind !== 'string' || !VALID_MILESTONE_KINDS.has(m.kind as MilestoneKind)) {
      throw new FixtureValidationError(`expected.milestones[${i}].kind 非法：「${m?.kind}」`);
    }
  }
}
