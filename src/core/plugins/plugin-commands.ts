/**
 * plugin-commands.ts — 插件命令翻译与前置条件求值（插件系统设计 §5.3、§5.4、§7）
 *
 * 为什么存在: 插件经 `host.commit({ commands, expect })` 提交的东西来自不受信任的帧，
 * 这里是它们进入引擎前唯一的翻译口。每条命令严格校验后翻译成一条 `StatePatch`，
 * 整批交给 `StateManager.commitPluginCommand` 在写锁和事务里原子应用。
 *
 * 线上形状（插件作者看到的）:
 * - 命令 = `{ type: '<命令名>', ...载荷 }`，命令名见 `PLUGIN_COMMANDS`；载荷里不认识的键一律 `INVALID`。
 * - 角色类命令的 `target` 是角色名（逻辑键 = 名字，数据字段规范铁律 1），缺省为主角。
 * - 载荷任何深度出现 `id` / `saveId` 键即 `INVALID`（铁律 3：插件永远不产 id）。
 *
 * 校验顺序: 整体形状 → 整次提交序列化体积 → 逐条（命令名 → 声明 → 禁用键 → 载荷）→ 前置条件。
 * 第一处错误即返回，`index` 指向出错命令的下标（前置条件出错不带 `index`，消息里写明第几条）。
 *
 * 纯度约束: 无 Dexie、无 I/O、无 Vue。
 */

import {
  QUEST_STATUSES,
  RARITY_LEVELS,
  STATUS_CATEGORIES,
  normalizeItemType,
  normalizeRarity,
  normalizeSlot,
  normalizeStatusCategory,
} from '../content/field-enums';
import { createDefaultCharacterState } from '../types/types';
import type { CharacterState, StatePatch, StatePatchOp } from '../types/types';
import type { PluginExpect, PluginExpectState } from '../types/types-plugin';
import { DANGEROUS_PATH_SEGMENTS, getVar, parseVarPath } from '../variables/var-resolver';
import { PLUGIN_COMMANDS, PLUGIN_DEFERRED_OPS, PLUGIN_LIMITS } from './plugin-surface';

// ========== 上限 ==========

/** 名字类字段（角色、物品、技能、状态、任务、地块、建筑）的长度上限 */
const NAME_MAX = 100;
/** 短文本（种族、性别、分类、来源等） */
const SHORT_MAX = 200;
/** 长文本（描述、背景、新闻正文等） */
const TEXT_MAX = 10_000;
/** 变量路径长度上限 */
const PATH_MAX = 256;
/** 字符串数组的项数上限 */
const ARRAY_MAX = 64;
/** 记录类字段（effects、stats）的键数上限 */
const RECORD_MAX = 64;
/** JSON 值的嵌套深度上限 */
const JSON_DEPTH_MAX = 32;

/** 载荷里任何深度都不得出现的键（铁律 3 + 原型污染防御） */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['id', 'saveId', ...DANGEROUS_PATH_SEGMENTS]);

/** 引擎认作「主角」的别名（`StateManager.resolveCharacter` ②），插件不得拿来给角色起名 */
const PLAYER_ALIASES: readonly string[] = ['主角', '玩家'];

/** `memory.add` 正文的长度上限（与 AI 写的单条记忆同一量级） */
const MEMORY_CONTENT_MAX = 2000;
/** `memory.add` 关键词的项数与单项长度上限 */
const MEMORY_KEYWORDS_MAX = 16;
const MEMORY_KEYWORD_MAX = 32;
/** 记忆重要度取值范围（与 `memory-summarizer` 解析 AI 输出时的钳制一致：1–10 的整数） */
const MEMORY_IMPORTANCE_MIN = 1;
const MEMORY_IMPORTANCE_MAX = 10;

/**
 * 推迟开放的命令 → 它将来翻译成的 op（§5.3「推迟开放」）。当前为空：`memory.add` 已接入；
 * 只有 op 同时在 `PLUGIN_DEFERRED_OPS` 里才会被拦成 `DENIED`。
 */
const DEFERRED_COMMANDS: Readonly<Record<string, StatePatchOp>> = {};

// ========== 公共类型 ==========

/** `PLUGIN_COMMANDS` 里的命令名 */
type PluginCommandName = keyof typeof PLUGIN_COMMANDS;

/** `translatePluginCommands` 的输入 */
interface TranslatePluginCommandsInput {
  /** 插件提交的命令数组（不受信任） */
  commands: unknown;
  /** 插件提交的前置条件数组（不受信任；可缺省） */
  expect: unknown;
  /** 插件 manifest 声明的 `capabilities.commands` */
  declared: readonly string[];
  /** 当前存档 id（只用于 `character.add` 补账务字段） */
  saveId: string;
  /** 主角名（`target` 缺省时的寻址键） */
  playerName: string;
}

/** `translatePluginCommands` 的结果 */
type TranslatePluginCommandsResult =
  | {
      ok: true;
      patches: StatePatch[];
      /** 插件自己的前置条件（规整后）在前，宿主补的隐含前置条件在后 */
      expect: PluginExpect[];
      /** `patches[i]` 来自 `commands[commandIndexOfPatch[i]]` */
      commandIndexOfPatch: number[];
    }
  | { ok: false; code: 'INVALID' | 'DENIED'; message: string; index?: number };

/** `evaluatePluginExpect` 的结果；`index` 是第一条不满足的前置条件的下标 */
type EvaluatePluginExpectResult = { ok: true } | { ok: false; index: number; message: string };

// ========== 内部校验工具 ==========

/** 载荷校验失败：只在本模块内抛出，由逐条循环捕获并转成 `INVALID` */
class PayloadError extends Error {}

function fail(message: string): never {
  throw new PayloadError(message);
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function expectObject(value: unknown, label: string): Obj {
  if (!isPlainObject(value)) fail(`「${label}」必须是对象`);
  return value;
}

/** 只允许列出的键；多出来的键大概率是拼写错误，宁可拒绝也不静默丢弃 */
function onlyKeys(obj: Obj, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${label}不认识的字段「${key}」`);
  }
}

function has(obj: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

/** 必填文本：去首尾空白后非空，长度不超过上限 */
function reqText(obj: Obj, key: string, max: number): string {
  const value = obj[key];
  if (typeof value !== 'string') fail(`「${key}」必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) fail(`「${key}」不能为空`);
  if (trimmed.length > max) fail(`「${key}」不能超过 ${max} 个字符`);
  return trimmed;
}

/** 可选文本：允许空串，长度不超过上限 */
function optText(obj: Obj, key: string, max: number): string | undefined {
  if (!has(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value !== 'string') fail(`「${key}」必须是字符串`);
  if (value.length > max) fail(`「${key}」不能超过 ${max} 个字符`);
  return value;
}

/** 名字（逻辑键）：非空、不含 `.`（`characters.<名>` 寻址按点切段） */
function reqName(obj: Obj, key: string): string {
  const name = reqText(obj, key, NAME_MAX);
  if (name.includes('.')) fail(`「${key}」不能包含「.」`);
  return name;
}

function optName(obj: Obj, key: string): string | undefined {
  return has(obj, key) ? reqName(obj, key) : undefined;
}

function reqFinite(obj: Obj, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`「${key}」必须是有限数`);
  return value;
}

function optFinite(obj: Obj, key: string): number | undefined {
  return has(obj, key) ? reqFinite(obj, key) : undefined;
}

function reqPositive(obj: Obj, key: string): number {
  const value = reqFinite(obj, key);
  if (value <= 0) fail(`「${key}」必须大于 0`);
  return value;
}

function optNonNegative(obj: Obj, key: string): number | undefined {
  const value = optFinite(obj, key);
  if (value !== undefined && value < 0) fail(`「${key}」不能为负数`);
  return value;
}

function optPositiveInt(obj: Obj, key: string): number | undefined {
  const value = optFinite(obj, key);
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    fail(`「${key}」必须是正整数`);
  }
  return value;
}

function optBool(obj: Obj, key: string): boolean | undefined {
  if (!has(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value !== 'boolean') fail(`「${key}」必须是布尔值`);
  return value;
}

function optEnum<T extends string>(obj: Obj, key: string, values: readonly T[]): T | undefined {
  if (!has(obj, key)) return undefined;
  const value = obj[key];
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    fail(`「${key}」只能是 ${values.join(' / ')} 之一`);
  }
  return value as T;
}

function optStringArray(obj: Obj, key: string, max = SHORT_MAX): string[] | undefined {
  if (!has(obj, key)) return undefined;
  const value = obj[key];
  if (!Array.isArray(value)) fail(`「${key}」必须是字符串数组`);
  if (value.length > ARRAY_MAX) fail(`「${key}」不能超过 ${ARRAY_MAX} 项`);
  return value.map((item) => {
    if (typeof item !== 'string') fail(`「${key}」必须是字符串数组`);
    if (item.length > max) fail(`「${key}」的每项不能超过 ${max} 个字符`);
    return item;
  });
}

/** `memory.add` 的关键词：可缺省（视为空），每项去首尾空白后非空，项数与长度有上限 */
function readMemoryKeywords(obj: Obj): string[] {
  if (!has(obj, 'keywords')) return [];
  const value = obj.keywords;
  if (!Array.isArray(value)) fail('「keywords」必须是字符串数组');
  if (value.length > MEMORY_KEYWORDS_MAX) fail(`「keywords」不能超过 ${MEMORY_KEYWORDS_MAX} 项`);
  return value.map((item) => {
    if (typeof item !== 'string') fail('「keywords」必须是字符串数组');
    const trimmed = item.trim();
    if (trimmed.length === 0) fail('「keywords」的每项不能为空');
    if (trimmed.length > MEMORY_KEYWORD_MAX) {
      fail(`「keywords」的每项不能超过 ${MEMORY_KEYWORD_MAX} 个字符`);
    }
    return trimmed;
  });
}

/** `memory.add` 的重要度：可缺省（取中值 5），给了就必须是 1–10 的整数 */
function readMemoryImportance(obj: Obj): number {
  const value = optFinite(obj, 'importance');
  if (value === undefined) return 5;
  if (!Number.isInteger(value) || value < MEMORY_IMPORTANCE_MIN || value > MEMORY_IMPORTANCE_MAX) {
    fail(`「importance」必须是 ${MEMORY_IMPORTANCE_MIN}–${MEMORY_IMPORTANCE_MAX} 的整数`);
  }
  return value;
}

/** 词条名 → 数值（状态效果的 effects、物品的 stats） */
function optNumberRecord(obj: Obj, key: string): Record<string, number> | undefined {
  if (!has(obj, key)) return undefined;
  const record = expectObject(obj[key], key);
  const entries = Object.entries(record);
  if (entries.length > RECORD_MAX) fail(`「${key}」不能超过 ${RECORD_MAX} 项`);
  const out: Record<string, number> = {};
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > NAME_MAX) fail(`「${key}」的键长度不合法`);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`「${key}.${name}」必须是有限数`);
    }
    out[name] = value;
  }
  return out;
}

/** 词条名 → 中文描述（物品、技能的 effects，状态的 effectDescriptions） */
function optTextRecord(obj: Obj, key: string): Record<string, string> | undefined {
  if (!has(obj, key)) return undefined;
  const record = expectObject(obj[key], key);
  const entries = Object.entries(record);
  if (entries.length > RECORD_MAX) fail(`「${key}」不能超过 ${RECORD_MAX} 项`);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.length === 0 || name.length > NAME_MAX) fail(`「${key}」的键长度不合法`);
    if (typeof value !== 'string' || value.length > TEXT_MAX) {
      fail(`「${key}.${name}」必须是不超过 ${TEXT_MAX} 个字符的字符串`);
    }
    out[name] = value;
  }
  return out;
}

/** 纯 JSON 值：null / 布尔 / 有限数 / 字符串 / 数组 / 普通对象 */
function assertJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > JSON_DEPTH_MAX) fail(`「${label}」嵌套过深`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`「${label}」里不能有非有限数`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) assertJsonValue(item, label, depth + 1);
    return;
  }
  fail(`「${label}」必须是 JSON 值`);
}

/** 变量路径：非空、无空段、无危险段（与 `parseVarPath` 同口径） */
function reqVarPath(obj: Obj, key: string): string {
  const path = reqText(obj, key, PATH_MAX);
  if (path.split('.').some((part) => part.length === 0)) fail(`「${key}」不能有空段`);
  if (parseVarPath(path) === null) fail(`「${key}」不是合法的变量路径`);
  return path;
}

/** 递归找禁用键；找到返回它的路径 */
function findForbiddenKey(value: unknown, path: string, depth = 0): string | null {
  if (depth > JSON_DEPTH_MAX) return path;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return path ? `${path}.${key}` : key;
    const hit = findForbiddenKey((value as Obj)[key], path ? `${path}.${key}` : key, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// ========== 翻译上下文 ==========

interface TranslateContext {
  saveId: string;
  playerName: string;
  /** 主角的寻址键：主角名本身不能用作 `characters.<名>` 时退回别名「主角」 */
  playerKey: string;
  /** 本批 `money.spend` 的合计（隐含前置条件用） */
  spendTotal: number;
}

function isPlayerRef(name: string, ctx: TranslateContext): boolean {
  return name === ctx.playerName || PLAYER_ALIASES.includes(name);
}

/** 角色类命令的 `target`：缺省为主角 */
function charTarget(obj: Obj, ctx: TranslateContext): string {
  return `characters.${optName(obj, 'target') ?? ctx.playerKey}`;
}

// ========== 各命令的载荷规整 ==========

/** `character.update` 可写的字段及其类型（引擎白名单 state-manager.ts:270-313 的子集） */
const CHARACTER_UPDATE_FIELDS = {
  race: 'text',
  identity: 'texts',
  occupation: 'texts',
  tier: 'number',
  tierName: 'text',
  level: 'number',
  totalExp: 'number',
  expToNext: 'number',
  attributes: 'attributes',
  freeAttrPoints: 'number',
  hp: 'number',
  maxHp: 'number',
  mp: 'number',
  maxMp: 'number',
  sp: 'number',
  maxSp: 'number',
  money: 'number',
  present: 'boolean',
  adventurerRank: 'text',
  currentAction: 'text',
  quantity: 'number',
  appearance: 'longText',
  background: 'longText',
  personality: 'longText',
  gender: 'text',
  outfit: 'longText',
  thoughts: 'longText',
} as const;

const ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'spi'] as const;

function readAttributes(obj: Obj, key: string): Record<string, number> {
  const attrs = expectObject(obj[key], key);
  onlyKeys(attrs, ATTRIBUTE_KEYS, `「${key}」`);
  const out = optNumberRecord(obj, key) ?? {};
  return out;
}

function readCharacterChanges(raw: unknown, delta: boolean): Obj {
  const changes = expectObject(raw, 'changes');
  const keys = Object.keys(changes);
  if (keys.length === 0) fail('「changes」不能为空');
  onlyKeys(changes, Object.keys(CHARACTER_UPDATE_FIELDS), 'character.update ');
  const out: Obj = {};
  for (const key of keys as (keyof typeof CHARACTER_UPDATE_FIELDS)[]) {
    const kind = CHARACTER_UPDATE_FIELDS[key];
    if (delta && kind !== 'number' && kind !== 'attributes') {
      fail(`delta 模式只能改数值字段，「${key}」不是数值字段`);
    }
    switch (kind) {
      case 'number':
        out[key] = reqFinite(changes, key);
        break;
      case 'text':
        out[key] = optText(changes, key, SHORT_MAX);
        break;
      case 'longText':
        out[key] = optText(changes, key, TEXT_MAX);
        break;
      case 'texts':
        out[key] = optStringArray(changes, key);
        break;
      case 'boolean':
        out[key] = optBool(changes, key);
        break;
      case 'attributes':
        out[key] = readAttributes(changes, key);
        break;
    }
    if (out[key] === undefined) fail(`「${key}」不能为 undefined`);
  }
  return out;
}

/** `character.add` 允许插件给的叙事字段；数值、背包等账务与成长字段一律由宿主补默认值 */
const CHARACTER_ADD_KEYS = [
  'name',
  'type',
  'race',
  'identity',
  'occupation',
  'gender',
  'appearance',
  'background',
  'personality',
  'outfit',
  'thoughts',
  'goals',
  'aliases',
  'location',
  'present',
  'currentAction',
] as const;

function buildNewCharacter(raw: unknown, ctx: TranslateContext): CharacterState {
  const c = expectObject(raw, 'character');
  onlyKeys(c, CHARACTER_ADD_KEYS, 'character.add 的「character」');
  const name = reqName(c, 'name');
  if (isPlayerRef(name, ctx)) fail(`「${name}」是主角的名字或别名，不能用作新角色名`);
  const overrides: Partial<CharacterState> = {
    name,
    saveId: ctx.saveId,
    type: optEnum(c, 'type', ['npc', 'monster', 'summon'] as const) ?? 'npc',
  };
  const race = optText(c, 'race', SHORT_MAX);
  if (race !== undefined) overrides.race = race;
  const identity = optStringArray(c, 'identity');
  if (identity !== undefined) overrides.identity = identity;
  const occupation = optStringArray(c, 'occupation');
  if (occupation !== undefined) overrides.occupation = occupation;
  const aliases = optStringArray(c, 'aliases', NAME_MAX);
  if (aliases !== undefined) {
    for (const alias of aliases) {
      if (alias.trim().length === 0 || isPlayerRef(alias, ctx)) {
        fail(`别名「${alias}」不合法（不能为空，也不能是主角的名字或别名）`);
      }
    }
    overrides.aliases = aliases;
  }
  for (const key of ['gender', 'location', 'currentAction'] as const) {
    const value = optText(c, key, SHORT_MAX);
    if (value !== undefined) overrides[key] = value;
  }
  for (const key of [
    'appearance',
    'background',
    'personality',
    'outfit',
    'thoughts',
    'goals',
  ] as const) {
    const value = optText(c, key, TEXT_MAX);
    if (value !== undefined) overrides[key] = value;
  }
  const present = optBool(c, 'present');
  if (present !== undefined) overrides.present = present;
  // id 由 createDefaultCharacterState 生成，年龄锚点由引擎 applyAddCharacter 的实例化闸门补
  return createDefaultCharacterState(overrides);
}

const STATUS_FIELDS = [
  'name',
  'description',
  'category',
  'stacks',
  'maxStacks',
  'stackable',
  'remainingTime',
  'timeUnit',
  'source',
  'effects',
  'effectDescriptions',
  'tags',
] as const;

/** 状态分类：只收中文枚举与 buff / debuff / special（`normalizeStatusCategory` 认得的写法） */
function readStatusCategory(obj: Obj): string | undefined {
  const raw = optText(obj, 'category', SHORT_MAX);
  if (raw === undefined) return undefined;
  const normalized = normalizeStatusCategory(raw);
  const trimmed = raw.trim();
  const recognized =
    (STATUS_CATEGORIES as readonly string[]).includes(trimmed) ||
    ['buff', 'debuff', 'special'].includes(trimmed.toLowerCase());
  if (!recognized) fail(`「category」只能是 ${STATUS_CATEGORIES.join(' / ')} 之一`);
  return normalized;
}

function readRemainingTime(obj: Obj): number | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, 'remainingTime')) return undefined;
  if (obj.remainingTime === null) return null;
  return optNonNegative(obj, 'remainingTime');
}

function buildStatus(raw: unknown): Obj {
  const s = expectObject(raw, 'status');
  onlyKeys(s, STATUS_FIELDS, 'status.add 的「status」');
  const out: Obj = { name: reqName(s, 'name') };
  const values: Obj = {
    description: optText(s, 'description', TEXT_MAX),
    category: readStatusCategory(s),
    stacks: optPositiveInt(s, 'stacks'),
    maxStacks: optPositiveInt(s, 'maxStacks'),
    stackable: optBool(s, 'stackable'),
    remainingTime: readRemainingTime(s),
    timeUnit: optEnum(s, 'timeUnit', ['回合', '分钟', '小时'] as const),
    source: optText(s, 'source', SHORT_MAX),
    effects: optNumberRecord(s, 'effects'),
    effectDescriptions: optTextRecord(s, 'effectDescriptions'),
    tags: optStringArray(s, 'tags'),
  };
  return assignDefined(out, values);
}

function assignDefined(target: Obj, values: Obj): Obj {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) target[key] = value;
  }
  return target;
}

function readItemType(obj: Obj): string | undefined {
  const raw = optText(obj, 'type', SHORT_MAX);
  if (raw === undefined) return undefined;
  const normalized = normalizeItemType(raw);
  if (normalized === undefined) fail(`无法识别的物品类型「${raw}」`);
  return normalized;
}

function readRarity(obj: Obj): string | undefined {
  const raw = optText(obj, 'rarity', SHORT_MAX);
  if (raw === undefined) return undefined;
  const normalized = normalizeRarity(raw);
  if (normalized === undefined) {
    fail(`无法识别的品质「${raw}」（应为 ${RARITY_LEVELS.join(' / ')} 之一）`);
  }
  return normalized;
}

/** 物品的可写字段（不含 name、quantity、equippedSlot —— 它们各有专用命令） */
function readItemFields(obj: Obj): Obj {
  const data = has(obj, 'data') ? expectObject(obj.data, 'data') : undefined;
  if (data !== undefined) assertJsonValue(data, 'data');
  return assignDefined(
    {},
    {
      description: optText(obj, 'description', TEXT_MAX),
      type: readItemType(obj),
      rarity: readRarity(obj),
      stats: optNumberRecord(obj, 'stats'),
      effects: optTextRecord(obj, 'effects'),
      durability: optNonNegative(obj, 'durability'),
      maxDurability: optNonNegative(obj, 'maxDurability'),
      tags: optStringArray(obj, 'tags'),
      data,
    },
  );
}

const ITEM_FIELD_KEYS = [
  'description',
  'type',
  'rarity',
  'stats',
  'effects',
  'durability',
  'maxDurability',
  'tags',
  'data',
] as const;

function buildItem(raw: unknown): Obj {
  const item = expectObject(raw, 'item');
  onlyKeys(item, ['name', 'quantity', ...ITEM_FIELD_KEYS], 'item.grant 的「item」');
  const out: Obj = { name: reqName(item, 'name'), quantity: optPositiveInt(item, 'quantity') ?? 1 };
  return Object.assign(out, readItemFields(item));
}

const SKILL_FIELD_KEYS = [
  'description',
  'type',
  'rarity',
  'cost',
  'cooldown',
  'maxCooldown',
  'level',
  'effects',
  'skillPower',
  'relevantAttribute',
  'damageType',
  'tags',
] as const;

function readSkillFields(obj: Obj): Obj {
  let cost: Obj | undefined;
  if (has(obj, 'cost')) {
    const c = expectObject(obj.cost, 'cost');
    onlyKeys(c, ['type', 'amount'], '「cost」');
    const type = optEnum(c, 'type', ['HP', 'MP', 'SP'] as const);
    if (type === undefined) fail('「cost.type」必填');
    const amount = optNonNegative(c, 'amount');
    if (amount === undefined) fail('「cost.amount」必填');
    cost = { type, amount };
  }
  return assignDefined(
    {},
    {
      description: optText(obj, 'description', TEXT_MAX),
      type: optEnum(obj, 'type', ['active', 'passive'] as const),
      rarity: readRarity(obj),
      cost,
      cooldown: optNonNegative(obj, 'cooldown'),
      maxCooldown: optNonNegative(obj, 'maxCooldown'),
      level: optNonNegative(obj, 'level'),
      effects: optTextRecord(obj, 'effects'),
      skillPower: optNonNegative(obj, 'skillPower'),
      relevantAttribute: optEnum(obj, 'relevantAttribute', ATTRIBUTE_KEYS),
      damageType: optEnum(obj, 'damageType', ['物理', '能量', '精神', '真实'] as const),
      tags: optStringArray(obj, 'tags'),
    },
  );
}

function requireNonEmpty(changes: Obj, label: string): Obj {
  if (Object.keys(changes).length === 0) fail(`「${label}」不能为空`);
  return changes;
}

const QUEST_FIELD_KEYS = [
  'name',
  'status',
  'priority',
  'progress',
  'detail',
  'objective',
  'reward',
] as const;

function buildQuest(raw: unknown): Obj {
  const q = expectObject(raw, 'quest');
  onlyKeys(q, QUEST_FIELD_KEYS, 'quest.upsert 的「quest」');
  return assignDefined(
    { name: reqName(q, 'name') },
    {
      status: optEnum(q, 'status', QUEST_STATUSES),
      priority: optEnum(q, 'priority', ['低', '中', '高'] as const),
      progress: optText(q, 'progress', TEXT_MAX),
      detail: optText(q, 'detail', TEXT_MAX),
      objective: optText(q, 'objective', TEXT_MAX),
      reward: optText(q, 'reward', TEXT_MAX),
    },
  );
}

const PLOT_CHANGE_KEYS = [
  'status',
  'visibility',
  'description',
  'triggerCondition',
  'completeCondition',
  'failCondition',
  'location',
  'npcAgendas',
  'ifAbsent',
  'worldLineChanged',
] as const;

function readPlotChanges(raw: unknown): Obj {
  const c = expectObject(raw, 'changes');
  onlyKeys(c, PLOT_CHANGE_KEYS, 'plot.updateEvent 的「changes」');
  const out = assignDefined(
    {},
    {
      status: optEnum(c, 'status', [
        'pending',
        'active',
        'completed',
        'skipped',
        'failed',
      ] as const),
      visibility: optEnum(c, 'visibility', ['hidden', 'revealed'] as const),
      description: optText(c, 'description', TEXT_MAX),
      triggerCondition: optText(c, 'triggerCondition', TEXT_MAX),
      completeCondition: optText(c, 'completeCondition', TEXT_MAX),
      failCondition: optText(c, 'failCondition', TEXT_MAX),
      location: optText(c, 'location', SHORT_MAX),
      npcAgendas: optText(c, 'npcAgendas', TEXT_MAX),
      ifAbsent: optText(c, 'ifAbsent', TEXT_MAX),
      worldLineChanged: optBool(c, 'worldLineChanged'),
    },
  );
  return requireNonEmpty(out, 'changes');
}

/** 建筑收益：插件只给金额，周期与锚由引擎补（铁律 3） */
function readIncome(obj: Obj): Obj | undefined {
  if (!has(obj, 'income')) return undefined;
  const income = expectObject(obj.income, 'income');
  onlyKeys(income, ['amount'], '「income」');
  return { amount: reqPositive(income, 'amount') };
}

function readTileStatusEffects(obj: Obj): Obj[] | undefined {
  if (!has(obj, 'effects')) return undefined;
  const raw = obj.effects;
  if (!Array.isArray(raw)) fail('「effects」必须是数组');
  if (raw.length > ARRAY_MAX) fail(`「effects」不能超过 ${ARRAY_MAX} 项`);
  return raw.map((item) => {
    const e = expectObject(item, 'effects[]');
    onlyKeys(e, ['kind', 'amount'], '「effects[]」');
    if (e.kind !== 'devProgressPerMonth') fail('「effects[].kind」只能是 devProgressPerMonth');
    const amount = reqFinite(e, 'amount');
    if (amount === 0) fail('「effects[].amount」不能为 0');
    return { kind: 'devProgressPerMonth', amount };
  });
}

function readDurationDays(obj: Obj): number | undefined {
  const days = optFinite(obj, 'durationDays');
  if (days !== undefined && (!Number.isInteger(days) || days < -1)) {
    fail('「durationDays」必须是非负整数，或 -1 表示永久');
  }
  return days;
}

// ========== 命令表 ==========

interface CommandSpec {
  /** 载荷允许的键（不含 `type`） */
  keys: readonly string[];
  build: (cmd: Obj, ctx: TranslateContext) => StatePatch;
}

const RESOURCES = ['hp', 'mp', 'sp'] as const;
const SET_RESOURCE_OP = { hp: 'set_hp', mp: 'set_mp', sp: 'set_sp' } as const;
const DELTA_RESOURCE_OP = { hp: 'delta_hp', mp: 'delta_mp', sp: 'delta_sp' } as const;

function reqResource(cmd: Obj): (typeof RESOURCES)[number] {
  const resource = optEnum(cmd, 'resource', RESOURCES);
  if (resource === undefined) fail('「resource」必填（hp / mp / sp）');
  return resource;
}

/** 六条地块命令共用：寻址一律走 `value.tile`（地块名），`target` 只作标识 `'map'` */
function tilePatch(op: StatePatchOp, value: Obj): StatePatch {
  return { op, target: 'map', value };
}

/**
 * 每条命令的载荷形状与翻译。键集合与 `PLUGIN_COMMANDS` 逐项一致（类型钉住），
 * 翻译出的 op 必须落在该命令的 `PLUGIN_COMMANDS` 条目里（运行时再核一次）。
 */
const COMMAND_SPECS: { [K in PluginCommandName]: CommandSpec } = {
  'vars.set': {
    keys: ['path', 'value'],
    build: (cmd) => {
      if (!has(cmd, 'value')) fail('「value」必填');
      assertJsonValue(cmd.value, 'value');
      return {
        op: 'set_variable',
        target: `variables.${reqVarPath(cmd, 'path')}`,
        value: cmd.value,
      };
    },
  },
  'vars.delta': {
    keys: ['path', 'amount'],
    build: (cmd) => ({
      op: 'delta_variable',
      target: `variables.${reqVarPath(cmd, 'path')}`,
      amount: reqFinite(cmd, 'amount'),
    }),
  },
  'vars.remove': {
    keys: ['path'],
    build: (cmd) => ({ op: 'remove_variable', target: `variables.${reqVarPath(cmd, 'path')}` }),
  },
  'vars.move': {
    keys: ['path', 'toPath'],
    build: (cmd) => ({
      op: 'move_variable',
      target: `variables.${reqVarPath(cmd, 'path')}`,
      metadata: { toPath: reqVarPath(cmd, 'toPath') },
    }),
  },
  'vars.insert': {
    keys: ['path', 'value', 'index'],
    build: (cmd) => {
      if (!has(cmd, 'value')) fail('「value」必填');
      assertJsonValue(cmd.value, 'value');
      const index = optFinite(cmd, 'index');
      if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
        fail('「index」必须是非负整数');
      }
      const patch: StatePatch = {
        op: 'insert_variable',
        target: `variables.${reqVarPath(cmd, 'path')}`,
        value: cmd.value,
      };
      if (index !== undefined) patch.metadata = { index };
      return patch;
    },
  },
  // FP 走 `delta_variable` + `target='profile.fp'` 的账务分支；数额必须为正，
  // 否则 `fp.spend` 填负数就成了加 FP
  'fp.add': {
    keys: ['amount'],
    build: (cmd) => ({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: reqPositive(cmd, 'amount'),
    }),
  },
  'fp.spend': {
    keys: ['amount'],
    build: (cmd) => ({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: -reqPositive(cmd, 'amount'),
    }),
  },
  'character.update': {
    keys: ['target', 'changes', 'delta'],
    build: (cmd, ctx) => {
      const delta = optBool(cmd, 'delta') === true;
      const patch: StatePatch = {
        op: 'update_character',
        target: charTarget(cmd, ctx),
        value: readCharacterChanges(cmd.changes, delta),
      };
      if (delta) patch.metadata = { delta: true };
      return patch;
    },
  },
  'money.add': {
    keys: ['target', 'amount'],
    build: (cmd, ctx) => ({
      op: 'update_character',
      target: charTarget(cmd, ctx),
      value: { money: reqPositive(cmd, 'amount') },
      metadata: { delta: true },
    }),
  },
  // 只能花主角的钱：隐含前置条件只有 `player.money` 这一种口径能表达
  'money.spend': {
    keys: ['target', 'amount'],
    build: (cmd, ctx) => {
      const target = optName(cmd, 'target');
      if (target !== undefined && !isPlayerRef(target, ctx)) {
        fail('money.spend 只能花主角的钱；其他角色请用 character.update');
      }
      const amount = reqPositive(cmd, 'amount');
      ctx.spendTotal += amount;
      return {
        op: 'update_character',
        target: `characters.${ctx.playerKey}`,
        value: { money: -amount },
        metadata: { delta: true },
      };
    },
  },
  'resource.set': {
    keys: ['target', 'resource', 'value'],
    build: (cmd, ctx) => ({
      op: SET_RESOURCE_OP[reqResource(cmd)],
      target: charTarget(cmd, ctx),
      value: reqFinite(cmd, 'value'),
    }),
  },
  'resource.delta': {
    keys: ['target', 'resource', 'amount'],
    build: (cmd, ctx) => ({
      op: DELTA_RESOURCE_OP[reqResource(cmd)],
      target: charTarget(cmd, ctx),
      amount: reqFinite(cmd, 'amount'),
    }),
  },
  'character.add': {
    keys: ['character'],
    build: (cmd, ctx) => {
      const character = buildNewCharacter(cmd.character, ctx);
      return { op: 'add_character', target: `characters.${character.name}`, value: character };
    },
  },
  'character.remove': {
    keys: ['target'],
    build: (cmd, ctx) => {
      const name = reqName(cmd, 'target');
      if (isPlayerRef(name, ctx)) fail('不能移除主角');
      return { op: 'remove_character', target: `characters.${name}` };
    },
  },
  'character.rename': {
    keys: ['target', 'name'],
    build: (cmd, ctx) => {
      // 主角改名走人设编辑的命名写入口，插件不开放；目标必须显式给出
      const target = reqName(cmd, 'target');
      if (isPlayerRef(target, ctx)) fail('不能给主角改名');
      const name = reqName(cmd, 'name');
      if (PLAYER_ALIASES.includes(name)) fail(`「${name}」是保留别名，不能用作角色名`);
      return { op: 'rename_character', target: `characters.${target}`, value: name };
    },
  },
  'status.add': {
    keys: ['target', 'status'],
    build: (cmd, ctx) => ({
      op: 'add_status_effect',
      target: charTarget(cmd, ctx),
      value: buildStatus(cmd.status),
    }),
  },
  'status.update': {
    keys: ['target', 'name', 'remainingTime', 'stacks'],
    build: (cmd, ctx) => {
      const value = assignDefined(
        { name: reqName(cmd, 'name') },
        { remainingTime: readRemainingTime(cmd), stacks: optPositiveInt(cmd, 'stacks') },
      );
      if (Object.keys(value).length === 1) fail('「remainingTime」与「stacks」至少给一个');
      return { op: 'update_status_effect', target: charTarget(cmd, ctx), value };
    },
  },
  'status.remove': {
    keys: ['target', 'name'],
    build: (cmd, ctx) => ({
      op: 'remove_status_effect',
      target: charTarget(cmd, ctx),
      value: { name: reqName(cmd, 'name') },
    }),
  },
  'item.grant': {
    keys: ['target', 'item'],
    build: (cmd, ctx) => ({
      op: 'add_item',
      target: charTarget(cmd, ctx),
      value: buildItem(cmd.item),
    }),
  },
  'item.remove': {
    keys: ['target', 'name', 'quantity'],
    build: (cmd, ctx) => ({
      op: 'remove_item',
      target: charTarget(cmd, ctx),
      value: { name: reqName(cmd, 'name'), quantity: optPositiveInt(cmd, 'quantity') ?? 1 },
    }),
  },
  'item.update': {
    keys: ['target', 'name', 'changes'],
    build: (cmd, ctx) => {
      const changes = expectObject(cmd.changes, 'changes');
      onlyKeys(changes, ITEM_FIELD_KEYS, 'item.update 的「changes」（不能改 name / quantity）');
      return {
        op: 'update_item',
        target: charTarget(cmd, ctx),
        value: {
          name: reqName(cmd, 'name'),
          changes: requireNonEmpty(readItemFields(changes), 'changes'),
        },
      };
    },
  },
  'item.transfer': {
    keys: ['target', 'name', 'to', 'quantity'],
    build: (cmd, ctx) => {
      const from = charTarget(cmd, ctx);
      const to = reqName(cmd, 'to');
      if (from === `characters.${to}`) fail('不能把物品转给自己');
      return {
        op: 'transfer_item',
        target: from,
        value: { name: reqName(cmd, 'name'), to, quantity: optPositiveInt(cmd, 'quantity') ?? 1 },
      };
    },
  },
  'item.equip': {
    keys: ['target', 'name', 'slot'],
    build: (cmd, ctx) => {
      const raw = reqText(cmd, 'slot', SHORT_MAX);
      const slot = normalizeSlot(raw);
      if (slot === null) fail(`无法识别的装备槽位「${raw}」`);
      return {
        op: 'equip_item',
        target: charTarget(cmd, ctx),
        value: { name: reqName(cmd, 'name'), slot },
      };
    },
  },
  'item.unequip': {
    keys: ['target', 'name', 'slot'],
    build: (cmd, ctx) => {
      const name = optName(cmd, 'name');
      const rawSlot = has(cmd, 'slot') ? reqText(cmd, 'slot', SHORT_MAX) : undefined;
      if ((name === undefined) === (rawSlot === undefined)) {
        fail('「name」与「slot」必须且只能给一个');
      }
      let value: Obj;
      if (name !== undefined) {
        value = { name };
      } else {
        const slot = normalizeSlot(rawSlot!);
        if (slot === null) fail(`无法识别的装备槽位「${rawSlot}」`);
        value = { slot };
      }
      return { op: 'unequip_item', target: charTarget(cmd, ctx), value };
    },
  },
  'skill.add': {
    keys: ['target', 'skill'],
    build: (cmd, ctx) => {
      const skill = expectObject(cmd.skill, 'skill');
      onlyKeys(skill, ['name', ...SKILL_FIELD_KEYS], 'skill.add 的「skill」');
      return {
        op: 'add_skill',
        target: charTarget(cmd, ctx),
        value: { name: reqName(skill, 'name'), ...readSkillFields(skill) },
      };
    },
  },
  'skill.update': {
    keys: ['target', 'name', 'changes'],
    build: (cmd, ctx) => {
      const changes = expectObject(cmd.changes, 'changes');
      onlyKeys(changes, SKILL_FIELD_KEYS, 'skill.update 的「changes」（不能改 name）');
      return {
        op: 'update_skill',
        target: charTarget(cmd, ctx),
        value: {
          name: reqName(cmd, 'name'),
          changes: requireNonEmpty(readSkillFields(changes), 'changes'),
        },
      };
    },
  },
  'skill.remove': {
    keys: ['target', 'name'],
    build: (cmd, ctx) => ({
      op: 'remove_skill',
      target: charTarget(cmd, ctx),
      value: { name: reqName(cmd, 'name') },
    }),
  },
  // 地图落位由引擎钩子做（set_location 之后的 syncMapLocation）
  'location.set': {
    keys: ['target', 'location'],
    build: (cmd, ctx) => ({
      op: 'set_location',
      target: charTarget(cmd, ctx),
      value: reqText(cmd, 'location', SHORT_MAX),
    }),
  },
  'quest.upsert': {
    keys: ['quest'],
    build: (cmd) => {
      const quest = buildQuest(cmd.quest);
      return { op: 'update_quest', target: `quests.${String(quest.name)}`, value: quest };
    },
  },
  'quest.remove': {
    keys: ['name'],
    build: (cmd) => {
      const name = reqName(cmd, 'name');
      return { op: 'remove_quest', target: `quests.${name}`, value: { name } };
    },
  },
  // 好感度的键是角色名，不要求角色实体存在（规范第 7 章）；引擎钳到 ±100
  'affection.set': {
    keys: ['name', 'value'],
    build: (cmd) => ({
      op: 'set_affection',
      target: `affections.${reqName(cmd, 'name')}`,
      value: reqFinite(cmd, 'value'),
    }),
  },
  'affection.delta': {
    keys: ['name', 'amount'],
    build: (cmd) => ({
      op: 'delta_affection',
      target: `affections.${reqName(cmd, 'name')}`,
      amount: reqFinite(cmd, 'amount'),
    }),
  },
  'news.add': {
    keys: ['title', 'content', 'category'],
    build: (cmd) => ({
      op: 'add_news',
      target: 'news',
      value: assignDefined(
        { title: reqText(cmd, 'title', SHORT_MAX), content: reqText(cmd, 'content', TEXT_MAX) },
        { category: optText(cmd, 'category', SHORT_MAX) },
      ),
    }),
  },
  // 只翻译插件能给的三项；id、saveId、时间、关联角色等由引擎在提交事务里补齐
  // （`StateManager.commitPluginCommand`），补丁里不带 id
  'memory.add': {
    keys: ['content', 'keywords', 'importance'],
    build: (cmd) => ({
      op: 'add_memory',
      target: 'memories',
      value: {
        content: reqText(cmd, 'content', MEMORY_CONTENT_MAX),
        keywords: readMemoryKeywords(cmd),
        importance: readMemoryImportance(cmd),
      },
    }),
  },
  // 剧情事件按引擎的 `eventId` 寻址（PlotEvent 没有名字类逻辑键）；只开放叙事字段
  'plot.updateEvent': {
    keys: ['eventId', 'changes'],
    build: (cmd) => {
      const eventId = reqText(cmd, 'eventId', NAME_MAX);
      return {
        op: 'update_plot_event',
        target: `plotEvents.${eventId}`,
        value: { eventId, changes: readPlotChanges(cmd.changes) },
      };
    },
  },
  'map.tile.statusAdd': {
    keys: ['tile', 'title', 'description', 'effects', 'durationDays', 'reason'],
    build: (cmd) =>
      tilePatch(
        'tile_status_add',
        assignDefined(
          { tile: reqText(cmd, 'tile', NAME_MAX), title: reqText(cmd, 'title', NAME_MAX) },
          {
            description: optText(cmd, 'description', TEXT_MAX),
            effects: readTileStatusEffects(cmd),
            durationDays: readDurationDays(cmd),
            reason: optText(cmd, 'reason', SHORT_MAX),
          },
        ),
      ),
  },
  'map.tile.statusRemove': {
    keys: ['tile', 'title'],
    build: (cmd) =>
      tilePatch('tile_status_remove', {
        tile: reqText(cmd, 'tile', NAME_MAX),
        title: reqText(cmd, 'title', NAME_MAX),
      }),
  },
  // 不收 `main`：主建筑恒有一座，不能新建（state-manager applyTileBuildingAdd）
  'map.tile.buildingAdd': {
    keys: ['tile', 'name', 'description', 'ownerFlavor', 'playerOwned', 'income', 'reason'],
    build: (cmd) =>
      tilePatch(
        'tile_building_add',
        assignDefined(
          { tile: reqText(cmd, 'tile', NAME_MAX), name: reqText(cmd, 'name', NAME_MAX) },
          {
            description: optText(cmd, 'description', TEXT_MAX),
            ownerFlavor: optText(cmd, 'ownerFlavor', SHORT_MAX),
            playerOwned: optBool(cmd, 'playerOwned'),
            income: readIncome(cmd),
            reason: optText(cmd, 'reason', SHORT_MAX),
          },
        ),
      ),
  },
  // `main: true` 时按主建筑寻址，`name` 变成改名
  'map.tile.buildingUpdate': {
    keys: ['tile', 'name', 'main', 'description', 'ownerFlavor', 'playerOwned', 'income', 'reason'],
    build: (cmd) => {
      const main = optBool(cmd, 'main');
      const name = has(cmd, 'name') ? reqText(cmd, 'name', NAME_MAX) : undefined;
      if (main !== true && name === undefined) fail('「name」必填（改主建筑请写 main: true）');
      return tilePatch(
        'tile_building_update',
        assignDefined(
          { tile: reqText(cmd, 'tile', NAME_MAX) },
          {
            name,
            main,
            description: optText(cmd, 'description', TEXT_MAX),
            ownerFlavor: optText(cmd, 'ownerFlavor', SHORT_MAX),
            playerOwned: optBool(cmd, 'playerOwned'),
            income: readIncome(cmd),
            reason: optText(cmd, 'reason', SHORT_MAX),
          },
        ),
      );
    },
  },
  'map.tile.devProgressAdd': {
    keys: ['tile', 'amount', 'reason'],
    build: (cmd) => {
      const amount = reqFinite(cmd, 'amount');
      if (amount === 0) fail('「amount」不能为 0');
      return tilePatch(
        'tile_dev_progress_add',
        assignDefined(
          { tile: reqText(cmd, 'tile', NAME_MAX), amount },
          { reason: optText(cmd, 'reason', SHORT_MAX) },
        ),
      );
    },
  },
  'map.tile.historyNote': {
    keys: ['tile', 'text'],
    build: (cmd) =>
      tilePatch('tile_history_note', {
        tile: reqText(cmd, 'tile', NAME_MAX),
        text: reqText(cmd, 'text', TEXT_MAX),
      }),
  },
};

function isCommandName(name: string): name is PluginCommandName {
  return Object.prototype.hasOwnProperty.call(PLUGIN_COMMANDS, name);
}

// ========== 前置条件 ==========

const EXPECT_COMPARATORS = ['gte', 'eq', 'exists'] as const;

/** 规整一条前置条件；形状不对抛 `PayloadError` */
function parseExpect(raw: unknown): PluginExpect {
  const e = expectObject(raw, '前置条件');
  if (has(e, 'view')) {
    onlyKeys(e, ['view', 'gte'], '前置条件');
    if (e.view !== 'player.money') fail('「view」只支持 player.money');
    return { view: 'player.money', gte: reqFinite(e, 'gte') };
  }
  if (has(e, 'item')) {
    onlyKeys(e, ['item', 'owner', 'gte'], '前置条件');
    const item = reqName(e, 'item');
    const owner = optName(e, 'owner');
    const gte = reqFinite(e, 'gte');
    return owner === undefined ? { item, gte } : { item, owner, gte };
  }
  if (has(e, 'var')) {
    onlyKeys(e, ['var', ...EXPECT_COMPARATORS], '前置条件');
    const path = reqVarPath(e, 'var');
    const given = EXPECT_COMPARATORS.filter((key) => Object.prototype.hasOwnProperty.call(e, key));
    if (given.length !== 1) fail('「var」前置条件必须且只能带 gte / eq / exists 之一');
    if (given[0] === 'gte') return { var: path, gte: reqFinite(e, 'gte') };
    if (given[0] === 'exists') {
      const exists = optBool(e, 'exists');
      if (exists === undefined) fail('「exists」必须是布尔值');
      return { var: path, exists };
    }
    assertJsonValue(e.eq, 'eq');
    return { var: path, eq: e.eq };
  }
  fail('前置条件必须是 view / item / var 三种之一');
}

function parseExpectList(
  raw: unknown,
): { ok: true; list: PluginExpect[] } | { ok: false; index?: number; message: string } {
  if (raw === undefined) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, message: '「expect」必须是数组' };
  const list: PluginExpect[] = [];
  for (let i = 0; i < raw.length; i++) {
    try {
      list.push(parseExpect(raw[i]));
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      return { ok: false, index: i, message: `前置条件第 ${i} 条：${err.message}` };
    }
  }
  return { ok: true, list };
}

/** 与 `StateManager.resolveCharacter` 同口径：名字精确 → 唯一别名 → 主角别名 */
function findCharacter(characters: readonly CharacterState[], key: string): CharacterState | null {
  const byName = characters.find((c) => c.name === key);
  if (byName) return byName;
  const byAlias = characters.filter((c) => c.aliases?.includes(key));
  if (byAlias.length === 1) return byAlias[0];
  if (byAlias.length > 1) return null;
  if (PLAYER_ALIASES.includes(key)) return characters.find((c) => c.type === 'player') ?? null;
  return null;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(b, key) && jsonEqual((a as Obj)[key], (b as Obj)[key]),
  );
}

/** 求值一条已规整的前置条件；不满足返回中文原因，满足返回 null */
function checkExpect(e: PluginExpect, state: PluginExpectState): string | null {
  if ('view' in e) {
    const player = state.characters.find((c) => c.type === 'player');
    if (!player) return '本存档没有主角';
    const money = typeof player.money === 'number' ? player.money : 0;
    return money >= e.gte ? null : `余额不足：持有 ${money}，需要 ${e.gte}`;
  }
  if ('item' in e) {
    const owner = findCharacter(state.characters, e.owner ?? '主角');
    if (!owner) return `角色不存在：${e.owner ?? '主角'}`;
    const quantity = owner.inventory
      .filter((row) => row.name === e.item)
      .reduce((sum, row) => sum + (typeof row.quantity === 'number' ? row.quantity : 0), 0);
    return quantity >= e.gte ? null : `物品「${e.item}」数量不足：持有 ${quantity}，需要 ${e.gte}`;
  }
  const value = getVar(state.profile.variables ?? {}, e.var);
  if ('gte' in e) {
    if (typeof value !== 'number') return `变量「${e.var}」不是数值`;
    return value >= e.gte ? null : `变量「${e.var}」为 ${value}，需要至少 ${e.gte}`;
  }
  if ('exists' in e) {
    const exists = value !== undefined;
    if (exists === e.exists) return null;
    return e.exists ? `变量「${e.var}」不存在` : `变量「${e.var}」已存在`;
  }
  return jsonEqual(value, e.eq) ? null : `变量「${e.var}」的值与期望不符`;
}

// ========== 导出 ==========

/**
 * 把一次 `commit` 的命令与前置条件翻译成 `StatePatch` 批次（§5.3）。
 * 全部校验通过才返回 `ok: true`；任何一条不合格整批拒绝。
 */
export function translatePluginCommands(
  input: TranslatePluginCommandsInput,
): TranslatePluginCommandsResult {
  const { commands, expect, declared } = input;
  if (!Array.isArray(commands)) {
    return { ok: false, code: 'INVALID', message: '「commands」必须是数组' };
  }
  if (commands.length === 0) {
    return { ok: false, code: 'INVALID', message: '「commands」不能为空' };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify({ commands, expect: expect ?? [] });
  } catch {
    return { ok: false, code: 'INVALID', message: '提交内容无法序列化' };
  }
  if (utf8Bytes(serialized) > PLUGIN_LIMITS.commitBytes) {
    return {
      ok: false,
      code: 'INVALID',
      message: `提交内容超过 ${PLUGIN_LIMITS.commitBytes / 1024}KB 上限`,
    };
  }

  const playerName = typeof input.playerName === 'string' ? input.playerName.trim() : '';
  const ctx: TranslateContext = {
    saveId: input.saveId,
    playerName,
    playerKey: playerName.length > 0 && !playerName.includes('.') ? playerName : PLAYER_ALIASES[0],
    spendTotal: 0,
  };

  const patches: StatePatch[] = [];
  const commandIndexOfPatch: number[] = [];
  for (let index = 0; index < commands.length; index++) {
    const raw: unknown = commands[index];
    if (!isPlainObject(raw) || typeof raw.type !== 'string') {
      return { ok: false, code: 'INVALID', message: `第 ${index} 条命令缺少「type」`, index };
    }
    const type = raw.type;
    const deferred = Object.prototype.hasOwnProperty.call(DEFERRED_COMMANDS, type)
      ? DEFERRED_COMMANDS[type]
      : undefined;
    if (deferred !== undefined && (PLUGIN_DEFERRED_OPS as readonly string[]).includes(deferred)) {
      return { ok: false, code: 'DENIED', message: `命令「${type}」暂未开放`, index };
    }
    if (!isCommandName(type)) {
      return { ok: false, code: 'INVALID', message: `未知命令「${type}」`, index };
    }
    if (!declared.includes(type)) {
      return {
        ok: false,
        code: 'DENIED',
        message: `命令「${type}」未在 manifest 的 capabilities.commands 中声明`,
        index,
      };
    }
    const forbidden = findForbiddenKey(raw, '');
    if (forbidden !== null) {
      return {
        ok: false,
        code: 'INVALID',
        message: `命令「${type}」的载荷不得包含「${forbidden}」（id 与 saveId 由宿主维护）`,
        index,
      };
    }
    const spec = COMMAND_SPECS[type];
    try {
      const payload: Obj = { ...raw };
      delete payload.type;
      onlyKeys(payload, spec.keys, `命令「${type}」`);
      const patch = spec.build(payload, ctx);
      if (!(PLUGIN_COMMANDS[type] as readonly StatePatchOp[]).includes(patch.op)) {
        throw new Error(`内部错误：命令「${type}」翻译出了未登记的 op ${patch.op}`);
      }
      patches.push(patch);
      commandIndexOfPatch.push(index);
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      return { ok: false, code: 'INVALID', message: `命令「${type}」：${err.message}`, index };
    }
  }

  const parsed = parseExpectList(expect);
  if (!parsed.ok) return { ok: false, code: 'INVALID', message: parsed.message };
  const expectList = parsed.list;
  // 同批多次花钱合成一条：前置条件在应用补丁之前对同一份状态求值，逐条各验会放过透支
  if (ctx.spendTotal > 0) expectList.push({ view: 'player.money', gte: ctx.spendTotal });

  return { ok: true, patches, expect: expectList, commandIndexOfPatch };
}

/**
 * 在写锁和事务内对新读的状态求值前置条件（§5.4）。
 * 形状不合法也算不满足；返回第一条失败的下标。
 */
export function evaluatePluginExpect(
  expect: unknown,
  state: PluginExpectState,
): EvaluatePluginExpectResult {
  const parsed = parseExpectList(expect);
  if (!parsed.ok) return { ok: false, index: parsed.index ?? 0, message: parsed.message };
  for (let index = 0; index < parsed.list.length; index++) {
    const reason = checkExpect(parsed.list[index], state);
    if (reason !== null)
      return { ok: false, index, message: `前置条件第 ${index} 条不满足：${reason}` };
  }
  return { ok: true };
}
