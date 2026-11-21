/**
 * direct-contract.ts — 直出 `direct_updates` 的契约常量（白名单唯一真源）
 *
 * 校验器（direct-output.ts）、归一化预处理（direct-normalize.ts）与协议文本共用这些清单，
 * 改一处即三处同步。本模块只许依赖 content/field-enums，保持为纯数据层。
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
