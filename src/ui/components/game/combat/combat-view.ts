/**
 * combat-view.ts — 新战斗前端的**展示层纯函数**（C6）
 *
 * 数据源 = 沙盒权威 `CombatState`（`@engine/combat/sandbox/types`）。本模块只做
 * 「CombatState → 视图」的只读投影，零 store、零副作用、不 mount 可测 —— 照
 * `scene-image-view.ts` / `plot-thread-view.ts` 的规矩。
 *
 * 🔴 全部集中映射（属性标签 / 状态类别 / 特殊动作卡）都在这里，组件模板里**禁止**
 *    再散落字面量；单位、技能、数值一律从传入的 `CombatState` 读取，绝不写死。
 *
 * 🔴 中文措辞（属性短标签、特殊动作说明）住在这一层 —— 它消费的是
 *    协议动作，不是数据面（AI 正文里的面板解析在 `lib/action-panel.ts`）。
 *    数据面（单位名/技能名/数值）永远来自状态。
 */

import type {
  CombatFacing,
  CombatOutcome,
  CombatSide,
  CombatState,
  CombatStatusEffect,
  CombatUnit,
  CombatUnitAttributes,
} from '@engine/combat/sandbox/types';
import { MORALE_STATE_LABELS } from '@engine/types/types';

// ═══════════════════════════════════════════════════════════
// 集中映射
// ═══════════════════════════════════════════════════════════

/** 五维中文标签（力量/敏捷/体质/智力/精神）—— 战斗面板唯一出处 */
export const COMBAT_ATTRIBUTE_LABELS: ReadonlyArray<{
  key: keyof CombatUnitAttributes;
  label: string;
  short: string;
}> = [
  { key: 'str', label: '力量', short: '力' },
  { key: 'dex', label: '敏捷', short: '敏' },
  { key: 'con', label: '体质', short: '体' },
  { key: 'int', label: '智力', short: '智' },
  { key: 'spi', label: '精神', short: '精' },
];

/** 朝向 → 中文展示 */
export const COMBAT_FACING_LABELS: Record<CombatFacing, string> = {
  right: '面向 →',
  left: '面向 ←',
};

/** 终局结果 → 中文标题 */
export const COMBAT_OUTCOME_LABELS: Record<CombatOutcome, string> = {
  ally_win: '胜利',
  enemy_win: '战败',
  draw: '平局',
  fled: '撤退',
};

/** 行动顺序选择（只影响拼装出的意图文本） */
export const COMBAT_ORDER_OPTIONS: ReadonlyArray<{
  value: 'attack-action' | 'action-attack';
  label: string;
}> = [
  { value: 'attack-action', label: '攻击 → 动作' },
  { value: 'action-attack', label: '动作 → 攻击' },
];

/**
 * 协议级特殊动作卡（移动 / 蓄力 / 定位 / 逃跑）。
 *
 * 这些是战斗协议里对每个单位恒可用的战术动作，**不是**某个单位的技能数据 ——
 * 因此集中在这里作为「协议常量」，组件只遍历渲染；具体单位技能永远读 `unit.skills`。
 */
export const COMBAT_SPECIAL_ACTIONS: ReadonlyArray<{
  key: string;
  name: string;
  cost: string;
  effect: string;
  tags: readonly string[];
}> = [
  { key: 'move', name: '移动', cost: '1 动作', effect: '移动 1 格', tags: ['点位'] },
  {
    key: 'charge',
    name: '蓄力',
    cost: '1 动作',
    effect: '近战攻击、可蓄力法术 / 弓箭增伤 20%',
    tags: ['自身'],
  },
  { key: 'aim', name: '定位', cost: '1 动作', effect: '法术 / 射击命中 +2', tags: ['自身'] },
  { key: 'flee', name: '逃跑', cost: '1 动作', effect: '敏捷对抗', tags: ['自身'] },
];

/** 状态类别 → BuffChip 类型 */
type CombatChipType = 'buff' | 'debuff' | 'special';

function statusChipType(fx: CombatStatusEffect): CombatChipType {
  switch (fx.category) {
    case '增益':
      return 'buff';
    case '减益':
      return 'debuff';
    default:
      return 'special';
  }
}

// ═══════════════════════════════════════════════════════════
// CombatState → 视图
// ═══════════════════════════════════════════════════════════

/**
 * 按「行动轴顺序 + 名字」投影某一阵营的单位数组。
 *
 * 顺序先跟随 `meta.actionOrder`，轴外单位按名字稳定补齐（字典无序，不能靠它）。
 */
export function orderedUnits(state: CombatState | null, side: CombatSide): CombatUnit[] {
  if (!state) return [];
  const pool = Object.values(state.units).filter((u) => u.side === side);
  const byName = new Map(pool.map((u) => [u.name, u]));
  const out: CombatUnit[] = [];
  for (const name of state.meta.actionOrder ?? []) {
    const u = byName.get(name);
    if (u) {
      out.push(u);
      byName.delete(name);
    }
  }
  for (const u of [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    out.push(u);
  }
  return out;
}

/**
 * 当前行动者：优先等待玩家输入的单位；否则第一个存活的我方单位。
 * 返回 null = 无（战斗已终局 / 无我方单位）。
 */
export function currentActor(state: CombatState | null): CombatUnit | null {
  if (!state) return null;
  const pending = state.meta.pendingPlayerUnit;
  if (pending && state.units[pending] && state.units[pending].alive) return state.units[pending];
  return orderedUnits(state, 'ally').find((u) => u.alive) ?? null;
}

/** 是否在等待玩家输入（`meta.pendingPlayerUnit` 指向存活单位） */
export function isAwaitingPlayer(state: CombatState | null): boolean {
  if (!state) return false;
  const pending = state.meta.pendingPlayerUnit;
  if (!pending) return false;
  const unit = state.units[pending];
  return !!unit && unit.alive;
}

/** 地位百分比（0-100），max<=0 时返回 0 */
export function resourcePercent(current: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, (current / max) * 100));
}

/** 战意中文标签（`MORALE_STATE_LABELS` 唯一出处） */
export function moraleLabel(unit: CombatUnit): string {
  return MORALE_STATE_LABELS[unit.morale] ?? unit.morale;
}

/** 状态效果的展示项（不侵入 BuffChip 通用组件） */
export interface CombatStatusView {
  type: CombatChipType;
  name: string;
  stacks?: number;
  remainRounds: number | null;
  /** 解析不了的时长原文（状态树协议 §5.7）；有值时 `remainRounds` 恒为 null，显示它 */
  durationText: string | null;
}

/**
 * 有 `durationText`（条件型时长，如「直到离开城镇」）时不算剩余回合，交出原文；
 * 否则只有以「回合」计的数值时长才算剩余回合。
 */
export function statusViewsOf(unit: CombatUnit): CombatStatusView[] {
  return (unit.statusEffects ?? []).map((fx) => {
    const durationText = fx.durationText?.trim() || null;
    return {
      type: statusChipType(fx),
      name: fx.name,
      stacks: fx.stacks,
      remainRounds:
        !durationText && fx.timeUnit === '回合' && fx.remainingTime != null
          ? fx.remainingTime
          : null,
      durationText,
    };
  });
}

/** 位置槽位是否用尽 */
export function slotStatesOf(unit: CombatUnit): Array<{ label: string; remaining: number }> {
  return [
    { label: '攻击', remaining: unit.slots.attack },
    { label: '动作', remaining: unit.slots.action },
  ];
}

/** 坐标轴刻度：0..coordinateRange（含端点），range 非法时退化成单格 0 */
export function axisTicks(range: number): number[] {
  const n = Number.isFinite(range) && range > 0 ? Math.floor(range) : 0;
  return Array.from({ length: n + 1 }, (_, i) => i);
}

/** 位置（pos）→ 坐标轴百分比（0-100） */
export function posToPercent(pos: number, range: number): number {
  const n = Number.isFinite(range) && range > 0 ? range : 1;
  const clamped = Math.min(Math.max(Number.isFinite(pos) ? pos : 0, 0), n);
  return (clamped / n) * 100;
}
