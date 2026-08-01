/**
 * combat-v3/rule-keys.ts — closed RuleKey 注册表 + override 解析 + divinity 压制（M4 全量）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §八（closed RuleKey 与 divinity 压制）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §7.3（M4 补全三把锁 + 泛化压制）
 *
 * M1 只注册 `terminal.forceTerminal`（概念级终局，第 09 场）。
 * M4 补全三个：morale.forceState / action.freezeSlot / death.threshold（架构 §八 8.2 表）。
 *
 * 每个 RuleKey 有独立 schema / scope / divinity 门槛 / merge policy：
 *   - terminal.forceTerminal：概念级终局；≥5；首个通过者生效，后续 reject
 *   - morale.forceState：强制濒死反扑；≥5；取 divinity 高者
 *   - action.freezeSlot：时间暂停冻结敌方槽；≥5；同目标同槽取 rounds 最大
 *   - death.threshold：PreventDeath/复活出口；≥5；取 hp 高者，charges 各自消耗
 *
 * resolveOverride 从 M1 空转改为真正解析：检查门槛 + 按 key 定型 payload + merge policy，
 * 返回 OverrideResult。
 *
 * divinitySuppression(atk, def) 泛化压制表（架构 §八 8.3）：返回 ±20%/40%/60%/80%/100%，
 * ≥5 级返回 { certain: true } 让调用方跳过掷骰（A4-4 不消费骰子）。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { DivinityLevel } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// RuleKey 规格类型
// ──────────────────────────────────────────────────────────────────────────────

/** morale.forceState 载荷：强制濒死反扑（第 09 场概念崩坏）。 */
export interface MoraleForceStatePayload {
  /** 强制进入的战意状态（原版用濒死反扑） */
  state: string;
  /** 是否无视 HP 阈值（濒死反扑通常无视） */
  ignoreHpThreshold?: boolean;
}

/** terminal.forceTerminal 载荷：概念级终局（第 09 场认知剥夺）。 */
export interface TerminalForceTerminalPayload {
  /** 终局原因（进 terminal.reason，用 'force_terminal'） */
  reason: string;
  /** 胜方（可选） */
  winner?: string;
}

/** action.freezeSlot 载荷：时间暂停冻结敌方槽（第 13 场）。 */
export interface FreezeSlotPayload {
  /** 被冻结的目标单位（用逻辑键名字寻址，铁律 ①） */
  targetId: string;
  /** 冻结的槽位类型 */
  slotType: 'attack' | 'action' | 'both';
  /** 冻结持续回合数 */
  rounds: number;
}

/** death.threshold 载荷：PreventDeath/复活出口（第 07 / 24 场）。 */
export interface DeathThresholdPayload {
  /** 生效后目标是否保持活着 */
  alive: true;
  /** 复活/保留的 HP：绝对数，0~maxHp */
  hp: number;
}

/**
 * RuleKeySpec.payload 按 key 定型的判别。
 * 保留 M1 兼容（unknown 兼容性用联合兜底），但 M4 起按 key 用具体类型校验。
 */
export type RuleKeyPayload =
  | { rule: 'morale.forceState'; payload: MoraleForceStatePayload }
  | { rule: 'terminal.forceTerminal'; payload: TerminalForceTerminalPayload }
  | { rule: 'action.freezeSlot'; payload: FreezeSlotPayload }
  | { rule: 'death.threshold'; payload: { alive: true; hp: number } };

/**
 * 一把 closed RuleKey 的规格。
 * M4 四把全注册；payload 按 key 定型（架构 §八 8.2）。
 */
export interface RuleKeySpec<P = unknown> {
  /** 用途说明 */
  description: string;
  /** 激活所需的最低 divinity（架构 §八 8.2，法则级 ≥5） */
  divinityThreshold: DivinityLevel;
  /** Override 载荷（M4 按 key 定型） */
  payload: P;
}

/** closed RuleKey 钥匙串（四把全量）。 */
export type RuleKey =
  'terminal.forceTerminal' | 'morale.forceState' | 'action.freezeSlot' | 'death.threshold';

/** M4 四把 RuleKey 全注册。 */
export const RULE_KEYS: Readonly<Record<RuleKey, RuleKeySpec>> = {
  'terminal.forceTerminal': {
    description: '概念级终局，非 HP 清空判胜（第 09 场认知剥夺）',
    divinityThreshold: 5,
    payload: { reason: 'string', winner: 'string' },
  },
  'morale.forceState': {
    description: '概念崩坏等强制濒死反扑（第 09 场）',
    divinityThreshold: 5,
    payload: { state: 'string', ignoreHpThreshold: 'boolean' },
  },
  'action.freezeSlot': {
    description: '时间暂停冻结敌方槽（第 13 场）',
    divinityThreshold: 5,
    payload: { targetId: 'string', slotType: 'string', rounds: 'number' },
  },
  'death.threshold': {
    description: 'PreventDeath / 复活出口（第 07 / 24 场）',
    divinityThreshold: 5,
    payload: { alive: 'true', hp: 'number' },
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Override 解析结果
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Override 解析结果。
 * M1 恒为 applied/rejected 二态；M4 扩展为含 merge 信息的判别，供各生效点消费
 * （freezeSlot 取 rounds 最大、death.threshold 取 hp 高者、forceTerminal 首个 reject）。
 */
export type OverrideResult =
  | { kind: 'applied'; detail: string; merge?: 'none' | 'max_rounds' | 'max_hp' | 'first_wins' }
  | { kind: 'not_applied'; reason: string };

/**
 * 解析一次 RuleKey override（架构 §八 8.2 + 8.3）。
 *
 * M4 真正解析：
 *   1. 注册表存在性（不存在 → rejected）
 *   2. divinity 门槛（<5 → rejected，法则级）
 *   3. 载荷合法性（按 key 定型校验，非法 → rejected）
 *   4. 返回 applied（含 merge policy 元数据，供生效点合并冲突）
 *
 * 这是 adjudication / 内核内部触发的统一前缀校验。实际的「改为行为」由各生效点
 * （attack.check.intent / intents.ApplyStatus / unit-turn.freezeSlot / outcome.beforeDown）
 * 在拿到 applied 结果后消费 payload 执行。
 */
export function resolveOverride(key: RuleKey, divinity: number, payload: unknown): OverrideResult {
  const spec = RULE_KEYS[key];
  if (!spec) {
    return { kind: 'not_applied', reason: `RuleKey「${key}」未注册（M4 四把齐全）` };
  }
  if (divinity < spec.divinityThreshold) {
    return {
      kind: 'not_applied',
      reason: `divinity ${divinity} < 门槛 ${spec.divinityThreshold}（法则级）`,
    };
  }
  // 载荷定型校验（架构 §八 8.2 payload 列）
  const payloadErr = validatePayload(key, payload);
  if (payloadErr) {
    return { kind: 'not_applied', reason: payloadErr };
  }
  return { kind: 'applied', detail: `RuleKey「${key}」已解析`, merge: mergePolicyOf(key) };
}

/** 各 RuleKey 的 merge policy（架构 §八 8.2 merge 列）。 */
type MergePolicy = 'none' | 'max_rounds' | 'max_hp' | 'first_wins';
function mergePolicyOf(key: RuleKey): MergePolicy {
  switch (key) {
    case 'morale.forceState':
      return 'max_hp';
    case 'terminal.forceTerminal':
      return 'first_wins';
    case 'action.freezeSlot':
      return 'max_rounds';
    case 'death.threshold':
      return 'max_hp';
  }
}

/** 按 key 校验载荷形状（非法返回中文原因，合法返回 null）。 */
function validatePayload(key: RuleKey, payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') {
    return `RuleKey「${key}」载荷必须是对象`;
  }
  const p = payload as Record<string, unknown>;
  switch (key) {
    case 'morale.forceState':
      if (typeof p.state !== 'string' || p.state.length === 0)
        return 'morale.forceState.state 必须是非空字符串';
      return null;
    case 'terminal.forceTerminal':
      if (typeof p.reason !== 'string' || p.reason.length === 0)
        return 'terminal.forceTerminal.reason 必须是非空字符串';
      return null;
    case 'action.freezeSlot': {
      if (typeof p.targetId !== 'string' || p.targetId.length === 0)
        return 'action.freezeSlot.targetId 必须是非空字符串';
      if (p.slotType !== 'attack' && p.slotType !== 'action' && p.slotType !== 'both') {
        return 'action.freezeSlot.slotType 必须是 attack|action|both';
      }
      if (typeof p.rounds !== 'number' || p.rounds < 1)
        return 'action.freezeSlot.rounds 必须是 ≥1 整数';
      return null;
    }
    case 'death.threshold': {
      if (p.alive !== true) return 'death.threshold.alive 必须为 true';
      if (typeof p.hp !== 'number' || p.hp < 0) return 'death.threshold.hp 必须是非负数字';
      return null;
    }
  }
}

/**
 * 检查一个 terminal.forceTerminal 是否被允许（内核内部触发用，A1-6 forceTerminal 出口）。
 * 只要 registry 注册且 divinity ≥ 门槛即可。
 */
export function canForceTerminal(divinity: number): boolean {
  const spec = RULE_KEYS['terminal.forceTerminal'];
  return !!spec && divinity >= spec.divinityThreshold;
}

// ──────────────────────────────────────────────────────────────────────────────
// divinity 差值压制（架构 §八 8.3 泛化）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * divinity 差值压制结果（架构 §八 8.3）。
 *
 * - 差 1~4 级：返回压制幅度（0~1，攻高为正 / 攻低为负）
 * - 差 ≥5 级：返回 { certain: true } —— 必成/必败，调用方**跳过掷骰**（A4-4，不消费骰子）
 */
export type DivinitySuppression =
  { certain: false; magnitude: number; direction: 1 | -1 } | { certain: true; direction: 1 | -1 };

/**
 * 泛化 divinity 差值压制（架构 §八 8.3 表）。
 *
 * @param atk 攻方（发起对抗者）divinity
 * @param def 守方 divinity
 * @returns
 *   - 差 ∈ {1,2,3,4}：magnitude = 0.2/0.4/0.6/0.8，direction 攻高=1 / 守高=-1
 *   - 差 ≥5：{ certain: true }（必成/必败，方向跟随攻守高低）
 *   - 差 ≤0：magnitude 0 的方向由高低决定（不压制）
 */
export function divinitySuppression(atk: number, def: number): DivinitySuppression {
  const diff = atk - def;
  if (diff >= 5) return { certain: true, direction: 1 };
  if (diff <= -5) return { certain: true, direction: -1 };
  if (Math.abs(diff) < 1) return { certain: false, magnitude: 0, direction: diff > 0 ? 1 : -1 };
  // 压制幅度：差×0.2（0.2/0.4/0.6/0.8），round 到 2 位小数避免浮点误差（3×0.2=0.6000…01）
  const magnitude = Math.round(Math.abs(diff) * 0.2 * 100) / 100;
  return { certain: false, magnitude, direction: diff > 0 ? 1 : -1 };
}

/**
 * 把一个法系压制幅度转成对抗检定的数值加值（对意图/状态对抗通用的「加值」语义）。
 *
 * 攻方 divinity 高 ⇒ 攻方检定获 `magnitude > 0` 的加值（方向=1）；
 * 守方 divinity 高 ⇒ relative='defender' 侧获加值，即攻方检定额外加 −magnitude（方向=-1）。
 *
 * @param suppression divinitySuppression 的结果
 * @param fromAttackerPerspective true=返回攻方视角加值；false=返回守方视角加值
 */
export function suppressionAsModifier(
  suppression: DivinitySuppression,
  fromAttackerPerspective: boolean,
): number {
  if (suppression.certain) {
    return suppression.direction === 1
      ? fromAttackerPerspective
        ? 100
        : -100
      : fromAttackerPerspective
        ? -100
        : 100;
  }
  const signed = suppression.direction === 1 ? suppression.magnitude : -suppression.magnitude;
  return fromAttackerPerspective ? signed : -signed;
}
