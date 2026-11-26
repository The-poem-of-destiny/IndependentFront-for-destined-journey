/**
 * direct-contract.ts — 直出 `direct_updates` 的契约常量（白名单唯一真源）
 *
 * 校验器（direct-output.ts）、归一化预处理（direct-normalize.ts）与协议文本共用这些清单，
 * 改一处即三处同步。本模块只许依赖 content/field-enums，保持为纯数据层
 * （唯二的函数只产出分区空值，不含逻辑）。
 *
 * 📌 2026-11-25：可写位置的值类型集中在 `DIRECT_VALUE_TYPES`，校验器按表检查；
 * 它不进协议文本（契约闸门只核对白名单与协议行）。
 */
import { STATUS_CATEGORIES } from '../content/field-enums';

/** direct_updates 顶层分区（combat 仅在结构化战斗开启时属于契约） */
export const DIRECT_SECTIONS = [
  'version',
  'world',
  'time',
  'entities',
  'state',
  'effects',
  'plot',
  'combat',
  'diceUsed',
] as const;

/** world 分区的操作键 */
export const DIRECT_WORLD_KEYS = ['replace', 'insert', 'tile_ops'] as const;

/** world.replace/insert 的 path 按「.」分段后不许出现的系统状态段（原型污染键另行拒收） */
export const DIRECT_WORLD_RESERVED_SEGMENTS = [
  'gameTime',
  'worldFlags',
  'directCombat',
  'generationMode',
  'profile',
  'characters',
  'fp',
] as const;

/** entities[i] 行的键（按实体种类） */
export const DIRECT_ENTITY_ROW_KEYS = {
  character: ['kind', 'placement', 'output'],
  loadout: ['kind', 'owner', 'output'],
} as const;

/** entities[i].output 允许的键 */
export const DIRECT_ENTITY_OUTPUT_KEYS = [
  'character',
  'skills',
  'equipment',
  'inventory',
  'statuses',
  'ascension',
  'elements',
  'authorities',
] as const;

/** 实体外层（非人物）字段；平铺人物归位时留在 output 顶层 */
export const DIRECT_ENTITY_OUTER_KEYS = ['statuses', 'elements', 'authorities'] as const;

/** 实体随身条目列表（output 顶层与 output.character 内共用） */
export const DIRECT_ENTITY_LIST_KEYS = ['skills', 'equipment', 'inventory'] as const;

/** 人物文本字段（必须是字符串） */
export const DIRECT_CHARACTER_TEXT_FIELDS = [
  'race',
  'gender',
  'background',
  'appearance',
  'clothing',
  'personality',
  'likes',
] as const;

/** 人物文本列表字段（必须是字符串数组） */
export const DIRECT_CHARACTER_LIST_FIELDS = ['identity', 'occupation'] as const;

/** 人物五维属性键 */
export const DIRECT_ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'spi'] as const;

/** 登神状态的三个条目列表 */
export const DIRECT_ASCENSION_LIST_KEYS = ['elements', 'authorities', 'laws'] as const;

/** state 分区的子键 */
export const DIRECT_STATE_KEYS = ['characters', 'items', 'affections', 'fp', 'quests'] as const;

/** state.characters 的操作 */
export const DIRECT_CHARACTER_OPERATIONS = ['replace', 'delta', 'remove'] as const;

/** state.characters.replace/delta 可写的人物字段白名单 */
export const DIRECT_CHARACTER_FIELDS = [
  'hp',
  'mp',
  'sp',
  'location',
  'present',
  'currentAction',
  'thoughts',
  'money',
  'totalExp',
] as const;

/** state.characters.delta 可用的数值路径（资源／金钱／经验） */
export const DIRECT_DELTA_PATHS = ['hp', 'mp', 'sp', 'money', 'totalExp'] as const;

/** state.characters.remove 可用的路径（状态效果走 effects） */
export const DIRECT_REMOVE_PATHS = ['skills', 'equipment'] as const;

/** state.items 的操作 */
export const DIRECT_ITEM_OPERATIONS = [
  'consume',
  'equip',
  'unequip',
  'transfer',
  'modify',
] as const;

/** state.items.modify 的 changes 可改键 */
export const DIRECT_ITEM_MODIFY_KEYS = [
  'description',
  'type',
  'rarity',
  'stats',
  'durability',
  'maxDurability',
  'effects',
  'protocolText',
  'tags',
] as const;

/** state.affections 的操作 */
export const DIRECT_AFFECTION_OPERATIONS = ['set', 'delta'] as const;

/** state.quests 的操作 */
export const DIRECT_QUEST_OPERATIONS = ['upsert', 'remove'] as const;

/** state.quests.upsert 行的键（白名单外的键在归一化时剥除） */
export const DIRECT_QUEST_UPSERT_KEYS = [
  'name',
  'status',
  'priority',
  'progress',
  'detail',
  'objective',
  'reward',
] as const;

/** effects 行的键 */
export const DIRECT_EFFECT_ROW_KEYS = ['owner', 'action', 'value'] as const;

/** effects 行的动作 */
export const DIRECT_EFFECT_ACTIONS = ['add', 'update', 'remove'] as const;

/** effects update 允许改的键 */
export const DIRECT_EFFECT_UPDATE_KEYS = ['name', 'remainingTime', 'stacks'] as const;

/** effects remove 允许的键 */
export const DIRECT_EFFECT_REMOVE_KEYS = ['name'] as const;

/** 状态效果分类（来自 field-enums） */
export const DIRECT_EFFECT_CATEGORIES = STATUS_CATEGORIES;

/** 状态效果时间单位 */
export const DIRECT_EFFECT_TIME_UNITS = ['回合', '分钟', '小时'] as const;

/** plot 分区的子键 */
export const DIRECT_PLOT_KEYS = ['pre', 'post'] as const;

/**
 * 不许模型填写的账务键（逻辑键=名字，AI 永不产 id）：结构化位置在预处理时剥除；
 * world 各操作的 value 子树不剥（那里是自由内容），残留的由校验器拒收。
 */
export const DIRECT_STRIPPED_KEYS = ['id', 'saveId', 'introducedBy', 'definition'] as const;

/** 任何层级都不许出现的原型污染键（直接拒收） */
export const DIRECT_FORBIDDEN_KEYS = ['__proto__', 'prototype', 'constructor'] as const;

/**
 * 可写位置的值类型（校验器按 `DIRECT_VALUE_TYPES` 逐键检查，坏值只丢所在那一行）：
 * - text：字符串；name：非空白字符串；textList：字符串数组；
 * - number：有限数；nonNegative：≥0 有限数；boolean：布尔；
 * - duration：null（永久）或 ≥0 有限数；
 * - numberRecord：值全为有限数的对象；textRecord：值全为字符串的对象。
 * 可选键写成 null 当缺席（剥掉并记纠正）；name 型必填，duration 型的 null 表示永久，都不剥。
 */
export type DirectValueType =
  | 'text'
  | 'name'
  | 'textList'
  | 'number'
  | 'nonNegative'
  | 'boolean'
  | 'duration'
  | 'numberRecord'
  | 'textRecord';

type TypeTable<Keys extends readonly string[]> = Record<Keys[number], DirectValueType>;

/**
 * 每个可写位置的「键 → 值类型」表，键集合与上面对应的白名单一一对应（`satisfies` 编译期钉住）。
 * 只给校验器用，不进协议文本：协议措辞仍按各白名单插值，改这里不会让 `direct_cached` 冷建。
 */
export const DIRECT_VALUE_TYPES = {
  /** state.characters.replace 的 value（按 path 取类型） */
  characterReplace: {
    hp: 'nonNegative',
    mp: 'nonNegative',
    sp: 'nonNegative',
    location: 'text',
    present: 'boolean',
    currentAction: 'text',
    thoughts: 'text',
    money: 'nonNegative',
    totalExp: 'nonNegative',
  } satisfies TypeTable<typeof DIRECT_CHARACTER_FIELDS>,
  /** state.items.modify[i].changes */
  itemModify: {
    description: 'text',
    type: 'text',
    rarity: 'text',
    stats: 'numberRecord',
    durability: 'nonNegative',
    maxDurability: 'nonNegative',
    effects: 'textRecord',
    protocolText: 'text',
    tags: 'textList',
  } satisfies TypeTable<typeof DIRECT_ITEM_MODIFY_KEYS>,
  /** state.quests.upsert[i] */
  questUpsert: {
    name: 'name',
    status: 'text',
    priority: 'text',
    progress: 'text',
    detail: 'text',
    objective: 'text',
    reward: 'text',
  } satisfies TypeTable<typeof DIRECT_QUEST_UPSERT_KEYS>,
  /** effects 行 action 为 update 时的 value */
  effectUpdate: {
    name: 'name',
    remainingTime: 'duration',
    // 只查是数值：非正层数照旧行收下，由 StateManager 忽略该字段（时长照改），不丢整行
    stacks: 'number',
  } satisfies TypeTable<typeof DIRECT_EFFECT_UPDATE_KEYS>,
  /** effects 行 action 为 remove 时的 value */
  effectRemove: { name: 'name' } satisfies TypeTable<typeof DIRECT_EFFECT_REMOVE_KEYS>,
} as const;

/** 有缺省空值的顶层分区（version 恒为 1、combat 另有规则，不在此列） */
export type DirectFilledSection = Exclude<(typeof DIRECT_SECTIONS)[number], 'version' | 'combat'>;

/**
 * 顶层分区空值的唯一出处：缺失补齐（归一化）、类型不符换空（校验器）、
 * 没写 direct_updates 区块时的空骨架、状态树信封装骨架都从这里取。每次调用返回新对象。
 */
export function emptyDirectSections(): Record<DirectFilledSection, unknown> {
  return {
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: {},
    diceUsed: [],
  };
}

/** 合规的空 direct_updates（键序同 DIRECT_SECTIONS；combat 为 null） */
export function emptyDirectUpdates(): Record<string, unknown> {
  const sections: Record<string, unknown> = emptyDirectSections();
  const result: Record<string, unknown> = {};
  for (const key of DIRECT_SECTIONS)
    result[key] = key === 'version' ? 1 : key === 'combat' ? null : sections[key];
  return result;
}
