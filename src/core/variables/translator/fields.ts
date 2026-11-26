/**
 * 字段构造：树上的值 → 内核字段（物品 / 技能 / 状态 / 登神长阶；自 `state-tree-translator.ts` 拆出，行为不变）。
 * 键 → 内核字段一律取自词表。
 */

import type { CharacterState, InventoryItem, Skill, StatusEffect } from '../../types/types';
import {
  coerceAttribute,
  coerceBoolean,
  coerceDamageType,
  coerceEffectDict,
  coerceItemType,
  coerceNumber,
  coerceNumberDict,
  coerceQuantity,
  coerceRarity,
  coerceSkillType,
  coerceSlot,
  coerceStacks,
  coerceStatusCategory,
  coerceText,
  coerceTextArray,
  parseDuration,
  parseSkillCost,
  pickKnownKeys,
  type SlotValue,
} from '../state-tree-codecs';
import {
  stateTreeBranchAt,
  stateTreeChildKeys,
  stateTreeKernelOf,
  stateTreeKeyOfKernel,
} from '../state-tree-spec';
import { isPlainObject, jsonClone } from '../state-tree-utils';
import { Drop, take, type Row } from './common';
import { ASCENSION_SPEC, EQUIP_ITEM_SPEC, SKILL_SPEC, STATUS_SPEC, childOf, keyOf } from './rules';

interface ItemFields {
  fields: Partial<InventoryItem>;
  quantity?: number;
  slot?: SlotValue;
}

/**
 * 物品条目对象 → 内核字段（键 → 内核字段取自词表）。`lenient`：认不出的枚举省略而不是丢弃（整实体写入）。
 */
export function buildItemFields(raw: Row, notes: string[], lenient: boolean): ItemFields {
  const out: ItemFields = { fields: {} };
  const f = out.fields;
  for (const [k, v] of Object.entries(raw)) {
    const node = childOf(EQUIP_ITEM_SPEC, k);
    if (!node) continue;
    if (node.type === 'branch') {
      // 耐久：{当前, 上限} 两个数值叶子
      if (!isPlainObject(v)) throw new Drop(`${k}要写成 {${stateTreeChildKeys(node).join(', ')}}`);
      const d = take(pickKnownKeys(v, stateTreeChildKeys(node)), notes, k);
      for (const c of node.children) {
        if (d[c.key] === undefined || !c.kernel) continue;
        (f as Row)[c.kernel] = take(
          coerceNumber(d[c.key], { integer: true }),
          notes,
          `${k}.${c.key}`,
        );
      }
      continue;
    }
    switch (node.kernel) {
      case 'rarity': {
        const r = take(coerceRarity(v), notes, k);
        if (r === undefined && !lenient) throw new Drop(`${k} ${JSON.stringify(v)} 认不出`);
        if (r !== undefined) f.rarity = r;
        break;
      }
      case 'type': {
        const t = take(coerceItemType(v), notes, k);
        if (t === undefined && !lenient) throw new Drop(`物品类型 ${JSON.stringify(v)} 认不出`);
        if (t !== undefined) f.type = t;
        break;
      }
      case 'quantity': {
        const q = take(coerceQuantity(v), notes, k);
        if (q.remove) throw new Drop(`${k} ≤ 0`);
        out.quantity = q.count;
        break;
      }
      case 'equippedSlot':
        out.slot = take(coerceSlot(v), notes, k);
        break;
      case 'tags':
        f.tags = take(coerceTextArray(v), notes, k);
        break;
      case 'effects':
        f.effects = take(coerceEffectDict(v), notes, k);
        break;
      case 'description':
        f.description = take(coerceText(v), notes, k);
        break;
      case 'stats':
        f.stats = take(coerceNumberDict(v), notes, k);
        break;
      case 'protocolText':
        f.protocolText = take(coerceText(v), notes, k);
        break;
      default:
        break;
    }
  }
  return out;
}

interface SkillFields {
  fields: Partial<Skill>;
  /** 消耗写成「无」：update 时清掉 cost 与 costText。 */
  clearCost?: boolean;
}

export function buildSkillFields(raw: Row, notes: string[], lenient: boolean): SkillFields {
  const out: SkillFields = { fields: {} };
  const f = out.fields;
  for (const [k, v] of Object.entries(raw)) {
    switch (stateTreeKernelOf(SKILL_SPEC, k)) {
      case 'rarity': {
        const r = take(coerceRarity(v), notes, k);
        if (r === undefined && !lenient) throw new Drop(`${k} ${JSON.stringify(v)} 认不出`);
        if (r !== undefined) f.rarity = r;
        break;
      }
      case 'type':
        f.type = take(coerceSkillType(v), notes, k);
        break;
      case 'cost': {
        const c = take(parseSkillCost(v), notes, k);
        if (c.kind === 'cost') f.cost = c.cost;
        else if (c.kind === 'text') f.costText = c.costText;
        else out.clearCost = true;
        break;
      }
      case 'cooldown':
        f.cooldown = take(coerceNumber(v, { integer: true }), notes, k);
        break;
      case 'tags':
        f.tags = take(coerceTextArray(v), notes, k);
        break;
      case 'effects':
        f.effects = take(coerceEffectDict(v), notes, k);
        break;
      case 'description':
        f.description = take(coerceText(v), notes, k);
        break;
      case 'skillPower':
        f.skillPower = take(coerceNumber(v), notes, k);
        break;
      case 'relevantAttribute': {
        const a = take(coerceAttribute(v), notes, k);
        if (a === undefined && !lenient) throw new Drop(`${k} ${JSON.stringify(v)} 认不出`);
        if (a !== undefined) f.relevantAttribute = a;
        break;
      }
      case 'damageType': {
        const d = take(coerceDamageType(v), notes, k);
        if (d === undefined && !lenient) throw new Drop(`${k} ${JSON.stringify(v)} 认不出`);
        if (d !== undefined) f.damageType = d;
        break;
      }
      case 'protocolText':
        f.protocolText = take(coerceText(v), notes, k);
        break;
      default:
        break;
    }
  }
  return out;
}

interface StatusFields {
  fields: Partial<StatusEffect>;
  removeByStacks?: boolean;
}

export function buildStatusFields(
  raw: Row,
  notes: string[],
  maxStacks: number | undefined,
): StatusFields {
  const out: StatusFields = { fields: {} };
  const f = out.fields;
  const capKey = keyOf(STATUS_SPEC, 'maxStacks');
  const cap =
    raw[capKey] !== undefined
      ? take(coerceNumber(raw[capKey], { integer: true }), notes, capKey)
      : maxStacks;
  for (const [k, v] of Object.entries(raw)) {
    switch (stateTreeKernelOf(STATUS_SPEC, k)) {
      case 'category':
        f.category = take(coerceStatusCategory(v), notes, k);
        break;
      case 'description':
        f.description = take(coerceText(v), notes, k);
        break;
      case 'effectDescriptions':
        f.effectDescriptions = take(coerceEffectDict(v), notes, k);
        break;
      case 'stacks': {
        const s = take(coerceStacks(v, cap), notes, k);
        if (s.remove) out.removeByStacks = true;
        else f.stacks = s.count;
        break;
      }
      case 'maxStacks':
        if (cap !== undefined && cap < 1) throw new Drop(`${k}要大于 0`);
        f.maxStacks = cap;
        break;
      case 'remainingTime': {
        const d = take(parseDuration(v), notes, k);
        if (d.kind === 'timed') {
          f.remainingTime = d.remainingTime;
          f.timeUnit = d.timeUnit;
        } else if (d.kind === 'permanent') {
          f.remainingTime = null;
        } else {
          f.durationText = d.durationText;
        }
        break;
      }
      case 'source':
        f.source = take(coerceText(v), notes, k);
        break;
      default:
        break;
    }
  }
  return out;
}

/** 状态的完整内核形状（删旧加新时整份带上）。 */
export function statusPayload(e: StatusEffect): Partial<StatusEffect> {
  const p: Partial<StatusEffect> = {
    name: e.name,
    description: e.description,
    category: e.category,
    stacks: e.stacks,
    ...(e.maxStacks !== undefined ? { maxStacks: e.maxStacks } : {}),
    ...(e.stackable !== undefined ? { stackable: e.stackable } : {}),
    timeUnit: e.timeUnit,
    source: e.source,
    effects: e.effects ?? {},
    ...(e.effectDescriptions ? { effectDescriptions: e.effectDescriptions } : {}),
    ...(e.protocolText ? { protocolText: e.protocolText } : {}),
    ...(e.tags ? { tags: e.tags } : {}),
  };
  // 时长互斥：有文本时长只带文本（数值与文本同给时 StateManager 以文本为准）
  if (e.durationText) p.durationText = e.durationText;
  else p.remainingTime = e.remainingTime;
  return p;
}

type AscensionEntryKind = 'elements' | 'authority' | 'law';

/**
 * 登神长阶的树形 → 内核形状（「工作状态现值 + 本条」重建整份，§5.3）。
 * 没被这次写入改动的条目原样保留内核数据（含旧的 `effects` 字符串数组）。
 */
export function treeToAscension(
  tree: Row,
  original: Row,
  existing: CharacterState['ascension'] | undefined,
  notes: string[],
): CharacterState['ascension'] {
  const A = ASCENSION_SPEC;
  const picked = take(pickKnownKeys(tree, stateTreeChildKeys(A)), notes);
  const enabledKey = keyOf(A, 'enabled');
  const enabled = take(coerceBoolean(picked[enabledKey] ?? false), notes, enabledKey);
  const kingdomSpec = stateTreeBranchAt(`/主角/${A.key}/${keyOf(A, 'divineKingdom')}`);
  const kingdomKeys = stateTreeChildKeys(kingdomSpec);
  const kingdomRaw = picked[kingdomSpec.key] ?? {};
  if (!isPlainObject(kingdomRaw))
    throw new Drop(`${kingdomSpec.key}要写成 {${kingdomKeys.join(', ')}}`);
  const kingdom = take(pickKnownKeys(kingdomRaw, kingdomKeys), notes, kingdomSpec.key);
  /** 要素 / 权能 / 法则：名字字典 → 条目数组（条目键与内核字段取自词表的条目形状）。 */
  const list = (kind: AscensionEntryKind) => {
    const key = keyOf(A, kind);
    const entrySpec = stateTreeBranchAt(`/主角/${A.key}/${key}`);
    const descKey = keyOf(entrySpec, 'description');
    const fxKey = keyOf(entrySpec, 'effectDescriptions');
    const costKey = stateTreeKeyOfKernel(entrySpec, 'costDescription');
    const raw = picked[key] ?? {};
    if (!isPlainObject(raw)) throw new Drop(`${key}要写成名字字典`);
    const origDict = isPlainObject(original[key]) ? (original[key] as Row) : {};
    const prev = (existing?.[kind] ?? []) as Array<{
      name: string;
      description: string;
      effects: string[];
      effectDescriptions?: Record<string, string>;
      costDescription?: string;
    }>;
    return Object.entries(raw).map(([name, entry]) => {
      const old = prev.find((p) => p.name === name);
      if (old && JSON.stringify(origDict[name]) === JSON.stringify(entry)) return jsonClone(old);
      if (!isPlainObject(entry)) throw new Drop(`${key}「${name}」要写成对象`);
      const e = take(
        pickKnownKeys(entry, stateTreeChildKeys(entrySpec)),
        notes,
        `${key}「${name}」`,
      );
      const out: {
        name: string;
        description: string;
        effects: string[];
        effectDescriptions?: Record<string, string>;
        costDescription?: string;
      } = {
        name,
        description:
          e[descKey] !== undefined
            ? take(coerceText(e[descKey]), notes, `${name}.${descKey}`)
            : (old?.description ?? ''),
        effects: old?.effects ?? [],
      };
      if (e[fxKey] !== undefined)
        out.effectDescriptions = take(coerceEffectDict(e[fxKey]), notes, `${name}.${fxKey}`);
      else if (old?.effectDescriptions) out.effectDescriptions = old.effectDescriptions;
      if (costKey !== undefined)
        out.costDescription =
          e[costKey] !== undefined
            ? take(coerceText(e[costKey]), notes, `${name}.${costKey}`)
            : (old?.costDescription ?? '');
      return out;
    });
  };
  const deityKey = keyOf(A, 'deityPosition');
  const kNameKey = keyOf(kingdomSpec, 'name');
  const kDescKey = keyOf(kingdomSpec, 'description');
  return {
    enabled,
    elements: list('elements') as CharacterState['ascension']['elements'],
    authority: list('authority') as CharacterState['ascension']['authority'],
    law: list('law') as CharacterState['ascension']['law'],
    deityPosition: take(coerceText(picked[deityKey] ?? ''), notes, deityKey),
    divineKingdom: {
      name: take(coerceText(kingdom[kNameKey] ?? ''), notes, `${kingdomSpec.key}.${kNameKey}`),
      description: take(
        coerceText(kingdom[kDescKey] ?? ''),
        notes,
        `${kingdomSpec.key}.${kDescKey}`,
      ),
    },
  };
}
