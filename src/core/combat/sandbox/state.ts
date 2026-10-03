/**
 * 战斗沙盒状态层（Phase 2 战斗重写）—— 建状态 + 纯函数操作 + 轻量不变量校验
 *
 * 🔴 权威状态只有 `CombatState` 一份；AI 通过工具改它，Code 只做校验与账面兜底。
 * 🔴 不变量违规（负数 / 超出上限）**只 warn 不抛**：协议驱动的主持过程允许 AI
 *    在中间步骤出现越界值，Code 硬抛会打断整个主持；真正落库前由 settlement 走
 *    StateManager 既有 op 的 clamp 语义兜底。
 */

import type { StatusEffect } from '../../types/types';
import { calcResources } from '../../character/tier-constants';
import type {
  CombatBundle,
  CombatStatusEffect,
  CombatUnit,
  CombatUnitAttributes,
  CombatUnitEquipment,
  CombatUnitOp,
  CombatUnitSkill,
  CombatantInput,
  CombatCluster,
  CombatState,
  CombatUnitSlots,
} from './types';

const DEFAULT_ATTRIBUTES: CombatUnitAttributes = { str: 0, dex: 0, con: 0, int: 0, spi: 0 };
const DEFAULT_SLOTS: CombatUnitSlots = { attack: 1, action: 1 };

/** 深拷贝（战斗状态是纯 JSON 数据，无函数/循环引用） */
export function cloneCombatState(state: CombatState): CombatState {
  return JSON.parse(JSON.stringify(state)) as CombatState;
}

/** 每回合快照（供回退）—— 与 cloneCombatState 同义，名字表达用途 */
export function snapshotCombatState(state: CombatState): CombatState {
  return cloneCombatState(state);
}

/** 按名字取单位；未命中返回 undefined */
export function getCombatUnit(state: CombatState, name: string): CombatUnit | undefined {
  return state.units[name];
}

/** 列出全部单位（插入序） */
export function listCombatUnits(state: CombatState): CombatUnit[] {
  return Object.values(state.units);
}

// ═══════════════════════════════════════════════════════════
// 建单位 / 建状态
// ═══════════════════════════════════════════════════════════

function toCombatSkill(skill: {
  name: string;
  type?: string;
  cost?: { type: string; amount: number };
  description?: string;
  protocolText?: string;
  tags?: string[];
  skillPower?: number;
  relevantAttribute?: string;
  damageType?: string;
}): CombatUnitSkill {
  return {
    name: skill.name,
    type: skill.type,
    cost: skill.cost ? `${skill.cost.type} ${skill.cost.amount}` : undefined,
    description: skill.description,
    protocolText: skill.protocolText,
    tags: skill.tags,
    skillPower: skill.skillPower,
    relevantAttribute: skill.relevantAttribute,
    damageType: skill.damageType as CombatUnitSkill['damageType'],
  };
}

function toCombatEquipment(item: {
  name: string;
  equippedSlot?: string | null;
  rarity?: string;
  description?: string;
  protocolText?: string;
  tags?: string[];
}): CombatUnitEquipment {
  return {
    name: item.name,
    slot: item.equippedSlot ?? undefined,
    rarity: item.rarity,
    description: item.description,
    protocolText: item.protocolText,
    tags: item.tags,
  };
}

/** 落库 StatusEffect → 战斗状态效果（保留战斗临时标记） */
export function toCombatStatus(fx: StatusEffect): CombatStatusEffect {
  return {
    name: fx.name,
    description: fx.description,
    category: fx.category,
    stacks: fx.stacks,
    maxStacks: fx.maxStacks,
    stackable: fx.stackable,
    remainingTime: fx.remainingTime,
    timeUnit: fx.timeUnit,
    source: fx.source,
    effects: fx.effects,
    effectDescriptions: fx.effectDescriptions,
  };
}

/** 战斗状态效果 → 落库 StatusEffect（剥掉 tempSource + 补齐必填字段） */
export function toSaveStatus(fx: CombatStatusEffect): StatusEffect {
  return {
    name: fx.name,
    description: fx.description ?? '',
    category: fx.category ?? '特殊',
    stacks: fx.stacks ?? 1,
    maxStacks: fx.maxStacks,
    stackable: fx.stackable,
    remainingTime: fx.remainingTime ?? null,
    timeUnit: fx.timeUnit ?? '回合',
    source: fx.source ?? '',
    effects: fx.effects ?? {},
    effectDescriptions: fx.effectDescriptions,
  };
}

function pickAttributes(
  base: CombatUnitAttributes | undefined,
  override: Partial<CombatUnitAttributes> | undefined,
): CombatUnitAttributes {
  return { ...DEFAULT_ATTRIBUTES, ...base, ...override };
}

/**
 * 建单个战斗单位。
 *
 * 有 `input.character` → 从存档角色取真实字段（hp/mp/sp/五维/技能/装备/状态），
 * `origin:'save'`；否则按 input 自填，`origin:'temp'`。
 * `fillResources` 为真且某上限 ≤0 时，按 `calcResources(tier, attrs)` 补齐 max*。
 */
export function createCombatUnit(input: CombatantInput, fillResources = true): CombatUnit {
  const character = input.character;
  const name = input.name ?? character?.name ?? '';
  if (!name) {
    throw new Error('createCombatUnit: 缺少单位名（name 或 character.name）');
  }

  const attrs = pickAttributes(character?.attributes, input.attributes);
  const tier = input.tier ?? character?.tier ?? 1;
  const level = input.level ?? character?.level ?? 1;
  const race = input.race ?? character?.race ?? '';

  let maxHp = input.maxHp ?? character?.maxHp ?? 0;
  let maxMp = input.maxMp ?? character?.maxMp ?? 0;
  let maxSp = input.maxSp ?? character?.maxSp ?? 0;

  if (fillResources && tier > 0 && (maxHp <= 0 || maxMp <= 0 || maxSp <= 0)) {
    const filled = calcResources(tier, attrs);
    if (maxHp <= 0) maxHp = filled.maxHp;
    if (maxMp <= 0) maxMp = filled.maxMp;
    if (maxSp <= 0) maxSp = filled.maxSp;
  }

  const statusEffects =
    input.statusEffects ?? (character?.statusEffects ?? []).map((fx) => toCombatStatus(fx));

  const unit: CombatUnit = {
    name,
    origin: character ? 'save' : 'temp',
    side: input.side,
    tier,
    level,
    race,
    attributes: attrs,
    hp: input.hp ?? character?.hp ?? maxHp,
    maxHp,
    mp: input.mp ?? character?.mp ?? maxMp,
    maxMp,
    sp: input.sp ?? character?.sp ?? maxSp,
    maxSp,
    statusEffects,
    pos: input.pos ?? 0,
    facing: input.facing ?? 'right',
    slots: { ...DEFAULT_SLOTS, ...input.slots },
    alive: input.alive ?? true,
    canAct: input.canAct ?? true,
    morale: input.morale ?? 'steady',
    cluster: input.cluster,
  };

  if (input.skills) {
    unit.skills = input.skills;
  } else if (character?.skills && character.skills.length > 0) {
    unit.skills = character.skills.map((s) => toCombatSkill(s));
  }
  if (input.equipment) {
    unit.equipment = input.equipment;
  } else if (character?.inventory) {
    const equipped = character.inventory.filter((i) => i.equippedSlot);
    if (equipped.length > 0) unit.equipment = equipped.map((i) => toCombatEquipment(i));
  }

  return unit;
}

/** 把单位加入状态（同名覆盖，返回新状态） */
export function addCombatUnit(
  state: CombatState,
  input: CombatantInput,
  fillResources = true,
): CombatState {
  const unit = createCombatUnit(input, fillResources);
  const next = cloneCombatState(state);
  next.units[unit.name] = unit;
  if (!next.meta.actionOrder.includes(unit.name)) {
    next.meta.actionOrder.push(unit.name);
  }
  return next;
}

/** 从参战角色（真实变量）+ 战斗指派建权威状态 */
export function createCombatState(bundle: CombatBundle): CombatState {
  const fillResources = bundle.fillResources ?? true;
  const units: Record<string, CombatUnit> = {};
  const actionOrder: string[] = [];

  for (const input of bundle.combatants) {
    const unit = createCombatUnit(input, fillResources);
    units[unit.name] = unit;
    if (!actionOrder.includes(unit.name)) actionOrder.push(unit.name);
  }

  const meta = bundle.meta ?? {};
  return {
    meta: {
      round: meta.round ?? 1,
      combatType: meta.combatType ?? '标准',
      environment: meta.environment ?? '',
      coordinateRange: meta.coordinateRange ?? 0,
      actionOrder: meta.actionOrder ?? actionOrder,
      phase: meta.phase ?? 'active',
      regions: meta.regions ?? [],
      pendingPlayerUnit: meta.pendingPlayerUnit,
      pendingOptions: meta.pendingOptions,
      outcome: meta.outcome,
      notes: meta.notes,
    },
    units,
  };
}

// ═══════════════════════════════════════════════════════════
// 字段读写（op 解释器）
// ═══════════════════════════════════════════════════════════

/** 可写顶层数值字段 */
const NUMERIC_FIELDS = new Set([
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  'pos',
  'tier',
  'level',
  'defense',
  'dr',
  'penetration',
  'hitBonus',
  'dodgeBonus',
  'weaponAtk',
]);
/** 可写顶层布尔字段 */
const BOOLEAN_FIELDS = new Set(['alive', 'canAct']);
/** 可写顶层字符串字段 */
const STRING_FIELDS = new Set(['facing', 'morale', 'race']);

function readField(unit: CombatUnit, field: string): unknown {
  const dot = field.indexOf('.');
  if (dot > 0) {
    const head = field.slice(0, dot);
    const rest = field.slice(dot + 1);
    if (head === 'extras') return unit.extras?.[rest];
    if (head === 'attributes') return unit.attributes[rest as keyof CombatUnitAttributes];
    if (head === 'slots') return unit.slots[rest as keyof CombatUnitSlots];
    if (head === 'cluster') return unit.cluster?.[rest as keyof CombatCluster];
    return undefined;
  }
  return (unit as unknown as Record<string, unknown>)[field];
}

function writeField(unit: CombatUnit, field: string, value: unknown): boolean {
  const dot = field.indexOf('.');
  if (dot > 0) {
    const head = field.slice(0, dot);
    const rest = field.slice(dot + 1);
    if (head === 'extras') {
      unit.extras = { ...(unit.extras ?? {}), [rest]: value };
      return true;
    }
    if (head === 'attributes') {
      unit.attributes[rest as keyof CombatUnitAttributes] = Number(value);
      return true;
    }
    if (head === 'slots') {
      unit.slots[rest as keyof CombatUnitSlots] = Number(value);
      return true;
    }
    if (head === 'cluster') {
      unit.cluster = { alive: 0, total: 0, ...(unit.cluster ?? {}), [rest]: Number(value) };
      return true;
    }
    return false;
  }

  if (NUMERIC_FIELDS.has(field)) {
    (unit as unknown as Record<string, number>)[field] = Number(value);
    return true;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    (unit as unknown as Record<string, boolean>)[field] = Boolean(value);
    return true;
  }
  if (STRING_FIELDS.has(field)) {
    (unit as unknown as Record<string, string>)[field] = String(value);
    return true;
  }
  return false;
}

function removeField(unit: CombatUnit, field: string): boolean {
  const dot = field.indexOf('.');
  if (dot > 0) {
    const head = field.slice(0, dot);
    const rest = field.slice(dot + 1);
    if (head === 'extras' && unit.extras) {
      delete unit.extras[rest];
      return true;
    }
    if (head === 'cluster') {
      delete unit.cluster;
      return true;
    }
    return false;
  }
  if (field === 'cluster') {
    delete unit.cluster;
    return true;
  }
  const optional = [
    'skills',
    'equipment',
    'defense',
    'dr',
    'penetration',
    'hitBonus',
    'dodgeBonus',
    'weaponAtk',
    'extras',
  ];
  if (optional.includes(field)) {
    delete (unit as unknown as Record<string, unknown>)[field];
    return true;
  }
  return false;
}

/** 收集单位的不变量违规（非负 / hp≤maxHp），供调用方 warn */
export function collectInvariantViolations(unit: CombatUnit): string[] {
  const out: string[] = [];
  const pairs: Array<[string, number, number]> = [
    ['hp', unit.hp, unit.maxHp],
    ['mp', unit.mp, unit.maxMp],
    ['sp', unit.sp, unit.maxSp],
  ];
  for (const [label, value, max] of pairs) {
    if (!Number.isFinite(value)) out.push(`${unit.name}.${label} 非有限数（${value}）`);
    if (value < 0) out.push(`${unit.name}.${label} 为负（${value}）`);
    if (Number.isFinite(max) && value > max)
      out.push(`${unit.name}.${label} 超出上限（${value} > ${max}）`);
  }
  return out;
}

/**
 * 对一个单位施加一串字段操作，返回**新状态**（纯函数）。
 *
 * 违规只 `console.warn`、照写不抛（见文件头）。
 */
export function applyOps(
  state: CombatState,
  name: string,
  ops: readonly CombatUnitOp[],
): CombatState {
  const next = cloneCombatState(state);
  const unit = next.units[name];
  if (!unit) {
    console.warn(`[combat-sandbox] applyOps 目标单位不存在: ${name}`);
    return next;
  }

  for (const raw of ops) {
    const op = raw as CombatUnitOp;
    switch (op.op) {
      case 'set':
        if (!writeField(unit, op.field, op.value)) {
          console.warn(`[combat-sandbox] 未知字段（set）: ${op.field}`);
        }
        break;
      case 'inc':
        writeField(unit, op.field, Number(readField(unit, op.field) ?? 0) + op.value);
        break;
      case 'dec':
        writeField(unit, op.field, Number(readField(unit, op.field) ?? 0) - op.value);
        break;
      case 'remove':
        if (!removeField(unit, op.field)) {
          console.warn(`[combat-sandbox] 无法移除字段: ${op.field}`);
        }
        break;
      default:
        console.warn(`[combat-sandbox] 未知 op: ${String((op as { op: unknown }).op)}`);
    }
  }

  for (const violation of collectInvariantViolations(unit)) {
    console.warn(`[combat-sandbox] 不变量违规（照写）: ${violation}`);
  }
  return next;
}

// ═══════════════════════════════════════════════════════════
// 状态效果增删
// ═══════════════════════════════════════════════════════════

/** 给单位加/刷新状态效果（同名覆盖），返回新状态 */
export function addStatusEffect(
  state: CombatState,
  name: string,
  status: CombatStatusEffect,
): CombatState {
  const next = cloneCombatState(state);
  const unit = next.units[name];
  if (!unit) {
    console.warn(`[combat-sandbox] addStatusEffect 目标单位不存在: ${name}`);
    return next;
  }
  const idx = unit.statusEffects.findIndex((fx) => fx.name === status.name);
  if (idx >= 0) unit.statusEffects[idx] = status;
  else unit.statusEffects.push(status);
  return next;
}

/** 移除单位的某状态效果，返回新状态 */
export function removeStatusEffect(
  state: CombatState,
  name: string,
  statusName: string,
): CombatState {
  const next = cloneCombatState(state);
  const unit = next.units[name];
  if (!unit) {
    console.warn(`[combat-sandbox] removeStatusEffect 目标单位不存在: ${name}`);
    return next;
  }
  unit.statusEffects = unit.statusEffects.filter((fx) => fx.name !== statusName);
  return next;
}

/** 移除单位（同时从行动轴摘掉），返回新状态 */
export function removeCombatUnit(state: CombatState, name: string): CombatState {
  const next = cloneCombatState(state);
  delete next.units[name];
  next.meta.actionOrder = next.meta.actionOrder.filter((n) => n !== name);
  if (next.meta.pendingPlayerUnit === name) delete next.meta.pendingPlayerUnit;
  return next;
}

/** 合并 meta（浅合并），返回新状态 */
export function setCombatMeta(
  state: CombatState,
  patch: Partial<CombatState['meta']>,
): CombatState {
  const next = cloneCombatState(state);
  next.meta = { ...next.meta, ...patch };
  return next;
}
