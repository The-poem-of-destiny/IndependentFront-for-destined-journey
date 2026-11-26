/**
 * 新建人物（§4.4）的翻译（自 `state-tree-translator.ts` 拆出，行为不变）。
 */

import { assembleCharacterState, bindGeneratedCharacter } from '../../agents/entity-gen-agent';
import { getTierForLevel } from '../../character/exp-table';
import { RESOURCE_FIELDS, baseResourceCaps, effectiveCap } from '../../character/resource-caps';
import type {
  CharacterState,
  EntityGenOutput,
  InventoryItem,
  Skill,
  StatePatch,
} from '../../types/types';
import {
  coerceAffection,
  coerceBoolean,
  coerceCapBonus,
  coerceCapTotal,
  coerceMoneyResult,
  coerceNumber,
  coerceQuantity,
  coerceResourceCurrent,
  coerceText,
  coerceTextArray,
  pickKnownKeys,
} from '../state-tree-codecs';
import type { ResolvedTreePath } from '../state-tree-patch';
import {
  ATTRIBUTE_LABELS,
  CHARACTER_CATEGORY_TYPES,
  stateTreeChildKeys,
  stripReadonlyPrefix,
} from '../state-tree-spec';
import { isPlainObject } from '../state-tree-utils';
import { Drop, charTarget, errorText, take, type OpContext, type Row } from './common';
import { buildItemFields, buildSkillFields, buildStatusFields, treeToAscension } from './fields';
import type { TranslatorHost } from './host';
import {
  ASCENSION_SPEC,
  EQUIP_ITEM_SPEC,
  GROWTH_SPEC,
  PERSON_SPEC,
  PROFILE_SPEC,
  RESOURCE_NODES,
  SKILL_SPEC,
  SLOT_KEY,
  STATUS_SPEC,
  emptyTree,
  keyOf,
  type ProfileListField,
  type ProfileTextField,
} from './rules';

export function createCharacter(h: TranslatorHost, ctx: OpContext, t: ResolvedTreePath): void {
  const w = ctx.op;
  const name = t.person!.name.trim();
  if (!name) throw new Drop('人物名不能为空');
  if (!isPlainObject(w.value)) throw new Drop('新建人物需要整对象');
  const notes = ctx.notes;
  const v = take(pickKnownKeys(w.value, stateTreeChildKeys(PERSON_SPEC)), notes);
  ctx.value = v;
  // 人物整对象的键一律按内核字段从词表反查（PERSON / 档案 / 成长）
  const pk = (kernel: string) => keyOf(PERSON_SPEC, kernel);
  const growthRaw = v[GROWTH_SPEC.key];
  const growth: Row = isPlainObject(growthRaw) ? growthRaw : {};
  const g = GROWTH_SPEC.key;
  const levelKey = keyOf(GROWTH_SPEC, 'level');
  const attrsKey = keyOf(GROWTH_SPEC, 'attributes');
  const attrsBare = stripReadonlyPrefix(attrsKey);
  const missing: string[] = [];
  const levelRaw = growth[levelKey];
  const attrsRaw = isPlainObject(growth[attrsBare])
    ? growth[attrsBare]
    : isPlainObject(growth[attrsKey])
      ? growth[attrsKey]
      : undefined;
  if (levelRaw === undefined) missing.push(`${g}.${levelKey}`);
  if (!attrsRaw) missing.push(`${g}.${attrsBare}`);
  if (v[pk('location')] === undefined) missing.push(pk('location'));
  if (v[pk('present')] === undefined) missing.push(pk('present'));
  if (missing.length > 0) throw new Drop(`新建人物缺少核心字段：${missing.join('、')}`);
  const level = take(coerceNumber(levelRaw, { integer: true }), notes, levelKey);
  if (level < 1 || level > 25) throw new Drop(`${levelKey} ${level} 越界`);
  const attributes = {} as CharacterState['attributes'];
  for (const [k, label] of Object.entries(ATTRIBUTE_LABELS) as Array<
    [keyof typeof ATTRIBUTE_LABELS, string]
  >) {
    const raw = attrsRaw![label] ?? attrsRaw![k];
    if (raw === undefined) throw new Drop(`新建人物缺少核心字段：${g}.${attrsBare}.${label}`);
    attributes[k] = take(coerceNumber(raw, { integer: true }), notes, label);
  }
  const location = take(coerceText(v[pk('location')]), notes, pk('location'));
  if (!location) throw new Drop(`新建人物缺少核心字段：${pk('location')}`);
  const present = take(coerceBoolean(v[pk('present')]), notes, pk('present'));
  const tier = getTierForLevel(level);
  const profileRaw = v[PROFILE_SPEC.key];
  const profile: Row = isPlainObject(profileRaw) ? profileRaw : {};
  const text = (raw: unknown, label: string): string | undefined => {
    if (raw === undefined) return undefined;
    const r = coerceText(raw);
    if (!r.ok) {
      notes.push(`${label}：${r.reason}，已忽略`);
      return undefined;
    }
    if (r.note) notes.push(`${label}：${r.note}`);
    return r.value;
  };
  const list = (raw: unknown, label: string): string[] =>
    raw === undefined ? [] : take(coerceTextArray(raw), notes, label);
  /** 档案文字 / 列表：按内核字段取键与值。 */
  const profText = (kernel: ProfileTextField | 'type') => {
    const key = keyOf(PROFILE_SPEC, kernel);
    return text(profile[key], key);
  };
  const profList = (kernel: ProfileListField) => {
    const key = keyOf(PROFILE_SPEC, kernel);
    return list(profile[key], key);
  };
  const personText = (kernel: 'thoughts' | 'currentAction') => text(v[pk(kernel)], pk(kernel));
  const output: EntityGenOutput = {
    character: {
      name,
      race: profText('race') ?? '人类',
      gender: profText('gender') ?? '',
      tier,
      level,
      attributes,
      identity: profList('identity'),
      occupation: profList('occupation'),
      background: profText('background') ?? '',
      appearance: profText('appearance') ?? '',
      clothing: profText('outfit') ?? '',
      personality: profText('personality') ?? '',
      likes: '',
      thoughts: personText('thoughts'),
      ascension: {
        enabled: false,
        path: '',
        description: '',
        elements: [],
        authorities: [],
        laws: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      skills: [],
      equipment: [],
      inventory: [],
    },
    skills: [],
    equipment: [],
    inventory: [],
  };
  const typeKey = keyOf(PROFILE_SPEC, 'type');
  const typeText = profile[typeKey] !== undefined ? profText('type') : undefined;
  const type = typeText !== undefined ? CHARACTER_CATEGORY_TYPES[typeText] : 'npc';
  if (type === undefined) notes.push(`${typeKey}「${typeText}」认不出，按普通人物处理`);
  const overrides: Partial<CharacterState> = {
    type: type ?? 'npc',
    location,
    present,
    currentAction: personText('currentAction') ?? '',
  };
  const moneyKey = pk('money');
  if (v[moneyKey] !== undefined)
    overrides.money = take(
      coerceMoneyResult(take(coerceNumber(v[moneyKey], { integer: true }), notes, moneyKey)),
      notes,
      moneyKey,
    );
  const qtyKey = pk('quantity');
  if (v[qtyKey] !== undefined && (type === 'monster' || type === 'summon')) {
    const q = take(coerceQuantity(v[qtyKey]), notes, qtyKey);
    if (!q.remove) overrides.quantity = q.count;
  }
  let character: CharacterState;
  try {
    character = assembleCharacterState(output, overrides);
    const expKey = keyOf(GROWTH_SPEC, 'totalExp');
    if (growth[expKey] !== undefined) {
      const exp = take(coerceNumber(growth[expKey], { integer: true }), notes, expKey);
      character.totalExp = Math.max(0, exp);
    }
    // 资源：额外与当前值（基础由公式推导）
    const bases = baseResourceCaps(character.tier, character.attributes);
    for (const r of RESOURCE_NODES) {
      const { label, key } = r;
      const res = isPlainObject(v[label]) ? v[label] : undefined;
      const fields = RESOURCE_FIELDS[key];
      let bonus = 0;
      const capRaw = res?.[r.cap];
      if (isPlainObject(capRaw) && capRaw[r.bonus] !== undefined)
        bonus = take(coerceCapBonus(capRaw[r.bonus], bases[key]), notes, `${label}.${r.bonus}`);
      else if (capRaw !== undefined && !isPlainObject(capRaw))
        bonus = take(coerceCapTotal(capRaw, bases[key]), notes, `${label}.${r.cap}`);
      const max = effectiveCap(bases[key], bonus);
      character[fields.bonus] = bonus;
      character[fields.max] = max;
      character[key] =
        res?.[r.current] !== undefined
          ? take(coerceResourceCurrent(res[r.current], max), notes, `${label}.${r.current}`)
          : max;
    }
    // 随身条目：坏的只丢那一条
    character.inventory = [
      ...entryList(v['背包'], '背包', notes, (n, raw) => newItem(n, raw, false, notes)),
      ...entryList(v['装备'], '装备', notes, (n, raw) => newItem(n, raw, true, notes)),
    ];
    const slots = new Set<string>();
    for (const it of character.inventory) {
      if (!it.equippedSlot) continue;
      if (slots.has(it.equippedSlot)) {
        notes.push(`装备「${it.name}」与同槽物品冲突，已放回背包`);
        it.equippedSlot = null;
      } else slots.add(it.equippedSlot);
    }
    character.skills = entryList(v['技能'], '技能', notes, (n, raw) => {
      if (!isPlainObject(raw)) throw new Drop('需要对象');
      const sub: string[] = [];
      const built = buildSkillFields(
        take(pickKnownKeys(raw, stateTreeChildKeys(SKILL_SPEC)), sub),
        sub,
        true,
      );
      notes.push(...sub.map((s) => `技能「${n}」：${s}`));
      return { description: '', type: 'active', ...built.fields, name: n } as Skill;
    });
    character.statusEffects = entryList(v['状态效果'], '状态效果', notes, (n, raw) => {
      if (!isPlainObject(raw)) throw new Drop('需要对象');
      const sub: string[] = [];
      const built = buildStatusFields(
        take(pickKnownKeys(raw, stateTreeChildKeys(STATUS_SPEC)), sub),
        sub,
        undefined,
      );
      if (built.removeByStacks) throw new Drop('层数 ≤ 0');
      notes.push(...sub.map((s) => `状态「${n}」：${s}`));
      const fx = built.fields;
      return {
        name: n,
        description: fx.description ?? '',
        category: fx.category ?? '特殊',
        stacks: fx.stacks ?? 1,
        ...(fx.maxStacks !== undefined ? { maxStacks: fx.maxStacks } : {}),
        remainingTime: fx.durationText !== undefined ? null : (fx.remainingTime ?? null),
        ...(fx.durationText !== undefined ? { durationText: fx.durationText } : {}),
        timeUnit: fx.timeUnit ?? '分钟',
        source: fx.source ?? '',
        effects: {},
        ...(fx.effectDescriptions ? { effectDescriptions: fx.effectDescriptions } : {}),
      };
    });
    const ascRaw = v[ASCENSION_SPEC.key];
    if (isPlainObject(ascRaw)) {
      const asc: Row = { ...emptyTree(ASCENSION_SPEC), ...ascRaw };
      character.ascension = treeToAscension(asc, {}, character.ascension, notes);
    }
    bindGeneratedCharacter(character, {
      narrativeCharacter: h.options.characterUpdates?.find((u) => u.name === name),
      characterDefinition: h.options.definitions?.find(
        (d) => d.name === name || d.profile.aliases?.includes(name),
      ),
      introducedBy: h.options.sourceTurnKey,
    });
  } catch (e) {
    if (e instanceof Drop) throw e;
    throw new Drop(`人物组装失败（${errorText(e)}）`);
  }
  if (h.state.characters.some((c) => c.name === character.name))
    throw new Drop(`人物「${character.name}」已存在`);
  const group: StatePatch[] = [
    { op: 'add_character', target: charTarget(character.name), value: character },
  ];
  const affKey = pk('affections');
  if (v[affKey] !== undefined) {
    const aff = take(coerceAffection(v[affKey]), notes, affKey);
    group.push({ op: 'set_affection', target: `affections.${character.name}`, value: aff });
  }
  h.commit(group);
  h.newCharacters.push(character);
  if (character.name !== name) {
    ctx.notes.push(`按作者定义绑定为「${character.name}」`);
    ctx.pointer = `/关系列表/${character.name}`;
    ctx.segments = ['关系列表', character.name];
  }
}

/** 新人物的随身字典 → 条目数组；坏条目只丢那一条（§4.4）。 */
function entryList<T>(
  raw: unknown,
  label: string,
  notes: string[],
  build: (name: string, raw: unknown) => T,
): T[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) {
    notes.push(`${label}：要写成名字字典，已忽略`);
    return [];
  }
  const out: T[] = [];
  for (const [n, entry] of Object.entries(raw)) {
    try {
      out.push(build(n, entry));
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      notes.push(`${label}「${n}」：${e.message}，已忽略`);
    }
  }
  return out;
}

function newItem(name: string, raw: unknown, equipped: boolean, notes: string[]): InventoryItem {
  let obj = raw;
  if (equipped && typeof obj === 'string') obj = { [SLOT_KEY]: obj };
  if (!isPlainObject(obj)) throw new Drop('需要对象');
  const sub: string[] = [];
  const built = buildItemFields(
    take(pickKnownKeys(obj, stateTreeChildKeys(EQUIP_ITEM_SPEC)), sub),
    sub,
    true,
  );
  notes.push(...sub.map((s) => `物品「${name}」：${s}`));
  let slot: string | null = null;
  if (equipped) {
    if (!built.slot || built.slot.kind !== 'equip') throw new Drop('缺少位置');
    if ((built.quantity ?? 1) > 1) throw new Drop('堆叠物品不能穿戴');
    slot = built.slot.slot;
  }
  return { ...built.fields, name, quantity: built.quantity ?? 1, equippedSlot: slot };
}
