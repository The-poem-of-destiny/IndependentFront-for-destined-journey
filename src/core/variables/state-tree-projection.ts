/**
 * 状态树投影（状态树协议 T4，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §3.1、§3.4）
 *
 * 把内核状态（角色数组 + 存档档案）投影成 AI 读、玩家在修改器里看的那棵中文键状态树（`stat_data`）。
 * 直出读侧（T9a）与变量修改器（T11）共用这一份；缓存分区切分见 `state-tree-sections.ts`。
 *
 * 约定：
 * - **纯函数**：无 I/O、无时钟、无随机，不改入参；同一输入两次投影深相等。
 * - `undefined` 不出键；键名一律取自 `state-tree-spec.ts` 的词表，**键序按词表子节点顺序**
 *   （人物节点键序因此固定）；按名字作键的字典（背包 / 技能 / 关系列表 …）按内核数组顺序。
 * - 只投叙事与可写字段：id / saveId / definition / introducedBy / customFields / ageAnchor 等账务键不出现。
 * - 背包只放未穿戴的物品，装备只放已穿戴的（`位置` = equippedSlot，`数量` 只在大于 1 时出现）；
 *   背包条目不带 `位置`（§9 #9）。
 * - 主角没有 `地点` 键，主角位置投影在 `/世界/地点`；关系列表里的人物才有 `在场 / 地点 / 好感度`。
 * - 上限投 `{_基础, 额外}`（`readResourceCaps`），有效总值不单独投影。
 * - 可见性（§3.4）：主角、在场角色、调用方点名的角色给全量人物节点，其余给摘要
 *   `{在场: false, 地点, 好感度}`；`mode: 'all'` 全部全量（修改器用）。
 * - **取值由词表驱动**（L6，2026-11-27）：子节点按 `kernel` 从所在实体取缺省值，需要改写的值
 *   （技能类型、消耗、剩余时间、数量 / 位置条件、上限拆分、类别、好感度等）按内核字段名登记在各实体的
 *   变换表里；现算节点（年龄、生日、基础上限、时段、天气、回合）按词表的派生标识取值；没有 `kernel`
 *   的名字字典与主角节点按词表节点本身登记组装方式。本文件不出现「中文键 → 字段」映射
 *   （`tests/core/variables/state-tree-spec-source-gate.test.ts` 钉住）。
 */

import {
  ATTRIBUTE_LABELS,
  CHARACTER_CATEGORY_TYPES,
  findChildSpec,
  SKILL_TYPE_LABELS,
  STATE_TREE_SPEC,
} from './state-tree-spec';
import type {
  StateTreeBranchSpec,
  StateTreeDerivedKind,
  StateTreeNodeSpec,
  StateTreeRecordSpec,
} from './state-tree-spec';
import { coerceEffectDict, formatDuration, formatSkillCost } from './state-tree-codecs';
import { isPlainObject, jsonClone } from './state-tree-utils';
import { readResourceCaps, type ResourceCaps, type ResourceKey } from '../character/resource-caps';
import { characterAge, hasGivenBirthday } from '../character/character-age';
import { formatGameTime, getTimeOfDay } from '../time/time-system';
import type {
  CharacterState,
  NewsItem,
  Quest,
  SaveProfile,
  Skill,
  StatusEffect,
} from '../types/types';

// ========== 输入与选项 ==========

/** 投影需要的存档档案字段。 */
export type StateTreeProfile = Pick<
  SaveProfile,
  'fp' | 'quests' | 'news' | 'variables' | 'gameTime' | 'affections'
>;

/** `buildStateTree` 的输入：内核状态的最小切片。 */
export interface StateTreeInput {
  /** 本存档全部角色（内核数组顺序即关系列表顺序）。 */
  readonly characters: readonly CharacterState[];
  readonly profile: StateTreeProfile;
  /** 当前天气（调用方按 worldFlags 现算好传入；缺省不出 `_天气`）。 */
  readonly weather?: string;
  /** 当前回合号（缺省不出 `_回合`）。 */
  readonly turn?: number;
}

/**
 * 可见性：
 * - `focus`（缺省）：主角与 `present === true` 的角色恒为全量；`fullNames` 里的名字（本轮输入点名、
 *   结构化战斗参战者等，由调用方算好）也给全量；其余给摘要。
 * - `all`：全部全量（变量修改器用）。
 */
type StateTreeVisibility =
  { readonly mode: 'focus'; readonly fullNames?: Iterable<string> } | { readonly mode: 'all' };

export interface StateTreeOptions {
  readonly visibility?: StateTreeVisibility;
  /** 新闻只投最近若干条（按内核数组末尾计）；缺省 `DEFAULT_STATE_TREE_NEWS_LIMIT`，0 = 不投新闻条目。 */
  readonly newsLimit?: number;
}

/** 新闻缺省投影条数。 */
export const DEFAULT_STATE_TREE_NEWS_LIMIT = 10;

/** 新闻栏目为空串时使用的栏目键（内核 `category` 缺省为空串，键不能为空段）。 */
export const UNCATEGORIZED_NEWS_COLUMN = '未分类';

// ========== 输出类型 ==========

/** 树上的值：JSON 可序列化，无 undefined。 */
export type StateTreeValue =
  string | number | boolean | null | StateTreeValue[] | { [key: string]: StateTreeValue };

export type StateTreeObject = { [key: string]: StateTreeValue };

// ========== 工具 ==========

/** 安全写键：名字可能是 `__proto__` 之类，不能用 `obj[key] = v`（会改原型）。 */
function setEntry(target: StateTreeObject, key: string, value: StateTreeValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** 按名字组装字典：内核数组顺序，同名只取第一条（内核保证同名唯一，这里只兜底确定性）。 */
function recordOf<T>(
  list: readonly T[],
  nameOf: (el: T) => string,
  project: (el: T) => StateTreeValue,
): StateTreeObject {
  const out: StateTreeObject = {};
  for (const el of list) {
    const name = nameOf(el);
    if (hasOwn(out, name)) continue;
    setEntry(out, name, project(el));
  }
  return out;
}

/** 字典浅拷贝；键序沿用原对象。 */
function dictCopy(dict: Readonly<Record<string, unknown>>): StateTreeObject {
  const out: StateTreeObject = {};
  for (const [k, v] of Object.entries(dict)) setEntry(out, k, v as StateTreeValue);
  return out;
}

/**
 * 内核原值 → 树上的值（缺省取值）：数组与字典浅拷贝（不把内核引用交出去），其余原样。
 *
 * 文本数组（`textArray`）与词条 / 数值字典（`effectDict` / `numberDict`）与词表驱动前的投影逐字一致：
 * 假值（含 `null`）不出键；存量档的宽松形状（`effects` 是数组或分号串、`identity` 是字符串，见
 * `src/ui/lib/item-effects.ts` 头注释）照旧按可迭代展开 / 按 `Object.entries` 拆键。这几种结果本身不对，
 * 但修正它会让该类存档在 tree 协议下对应分区内容变化一次，不在本次纯重构里做。
 */
function copyValue(node: StateTreeNodeSpec, raw: unknown): StateTreeValue | undefined {
  if (node.type === 'leaf' && node.leaf === 'textArray') {
    return raw ? [...(raw as Iterable<StateTreeValue>)] : undefined;
  }
  if (node.type === 'leaf' && (node.leaf === 'effectDict' || node.leaf === 'numberDict')) {
    return raw ? dictCopy(raw as Readonly<Record<string, unknown>>) : undefined;
  }
  if (Array.isArray(raw)) return [...(raw as StateTreeValue[])];
  if (isPlainObject(raw)) return dictCopy(raw);
  return raw as StateTreeValue | undefined;
}

// ========== 取值框架（词表驱动） ==========

/** 取值源：某个内核实体（角色 / 物品 / 技能 / 状态 / 任务 / 登神条目 …）或其子对象。 */
type Source = Readonly<Record<string, unknown>>;

/** 一次 `buildStateTree` 的公共上下文。 */
interface ProjectionContext {
  readonly characters: readonly CharacterState[];
  readonly profile: StateTreeProfile;
  readonly player: CharacterState | undefined;
  readonly isFull: (char: CharacterState) => boolean;
  readonly newsLimit: number;
}

/**
 * 取值框架：子节点按词表 `kernel` 从 `src` 取缺省值，`scope` 里按内核字段名登记的变换改写取值，
 * 带派生标识（`derived`）的现算节点从 `derived` 取。
 */
interface Frame {
  readonly src: Source;
  readonly scope: Scope;
  readonly ctx: ProjectionContext;
  /** 现算值，按派生标识取；随下钻继承。 */
  readonly derived: Partial<Record<StateTreeDerivedKind, StateTreeValue | undefined>>;
  /** 是否关系列表里的人物（决定 `relationOnly` 节点出不出）。 */
  readonly relation: boolean;
  /** 人物的上限拆分（人物框架才有）。 */
  readonly caps?: ResourceCaps;
}

/** 按内核字段名登记的值变换。 */
interface Transform {
  /** 叶子 / 字典：由内核原值（与所在框架）算出树上的值；undefined 不出键。 */
  readonly value?: (raw: unknown, frame: Frame) => StateTreeValue | undefined;
  /** 分支：给出下钻用的框架；undefined 不出键。 */
  readonly frame?: (frame: Frame) => Frame | undefined;
}

/** 一类实体的变换表（键 = 词表 `kernel`）。 */
type Scope = Readonly<Record<string, Transform>>;

/** 没有 `kernel` 的结构节点（按名字作键的字典 / 主角节点）：按词表节点本身登记组装方式。 */
const STRUCTURAL = new Map<StateTreeNodeSpec, (frame: Frame) => StateTreeValue | undefined>();

function transformOf(node: StateTreeNodeSpec, scope: Scope): Transform | undefined {
  return node.kernel !== undefined && hasOwn(scope, node.kernel) ? scope[node.kernel] : undefined;
}

/** 词表节点 → 树上的值。 */
function read(node: StateTreeNodeSpec, frame: Frame): StateTreeValue | undefined {
  if (node.derived) return frame.derived[node.derived];
  const structural = STRUCTURAL.get(node);
  if (structural) return structural(frame);
  const t = transformOf(node, frame.scope);
  if (node.type === 'branch') {
    const sub = t?.frame ? t.frame(frame) : descend(frame, node);
    if (!sub) return undefined;
    const out = assemble(node, sub);
    return node.optional && Object.keys(out).length === 0 ? undefined : out;
  }
  const raw = node.kernel === undefined ? undefined : frame.src[node.kernel];
  if (t?.value) return t.value(raw, frame);
  if (node.type === 'record') return namedEntries(node.entry, raw, frame);
  return copyValue(node, raw);
}

/** 分支的缺省下钻：无 `kernel` 的分支是同一实体的字段分组；有 `kernel` 的取该字段的子对象。 */
function descend(frame: Frame, node: StateTreeBranchSpec): Frame | undefined {
  if (node.kernel === undefined) return frame;
  const raw = frame.src[node.kernel];
  return isPlainObject(raw) ? { ...frame, src: raw } : undefined;
}

/**
 * 内核数组（带 `name` 的条目）→ 按名字作键的字典（只有登神长阶的三张清单走这里）。
 * 与词表驱动前的投影逐字一致：字符串按字符展开（每个字符没有 `name`，合成一条 `undefined` 键）；
 * 旧投影对其他非数组值直接抛错，这里按空清单处理。
 */
function namedEntries(entry: StateTreeNodeSpec, raw: unknown, frame: Frame): StateTreeObject {
  const list: Source[] = Array.isArray(raw)
    ? (raw as Source[])
    : typeof raw === 'string'
      ? ([...raw] as unknown as Source[])
      : [];
  return recordOf(
    list,
    (el) => String(el.name),
    (el) => (entry.type === 'branch' ? assemble(entry, { ...frame, src: el }) : null),
  );
}

/**
 * 按词表分支的子节点顺序取值组装对象：键序 = 词表顺序，`undefined` 不出键。
 * `relationOnly` 的节点只在关系列表人物上出；`keep` 可另给过滤（不在场摘要）。
 */
function assemble(
  spec: StateTreeBranchSpec,
  frame: Frame,
  keep: (child: StateTreeNodeSpec) => boolean = (c) => frame.relation || !c.relationOnly,
): StateTreeObject {
  const out: StateTreeObject = {};
  for (const child of spec.children) {
    if (!keep(child)) continue;
    const value = read(child, frame);
    if (value !== undefined) setEntry(out, child.key, value);
  }
  return out;
}

function branchSpec(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const found = findChildSpec(parent, key);
  if (!found || found.type !== 'branch') throw new Error(`状态树词表缺少分支「${key}」`);
  return found;
}

function recordSpec(parent: StateTreeBranchSpec, key: string): StateTreeRecordSpec {
  const found = findChildSpec(parent, key);
  if (!found || found.type !== 'record') throw new Error(`状态树词表缺少字典「${key}」`);
  return found;
}

function recordEntrySpec(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const entry = recordSpec(parent, key).entry;
  if (entry.type !== 'branch') throw new Error(`状态树词表缺少字典「${key}」`);
  return entry;
}

// ========== 词表节点（模块加载时从 spec 取一次） ==========

const PLAYER_SPEC = branchSpec(STATE_TREE_SPEC, '主角');
const RELATION_SPEC = recordEntrySpec(STATE_TREE_SPEC, '关系列表');
const QUEST_SPEC = recordEntrySpec(STATE_TREE_SPEC, '任务列表');
const BAG_ITEM_SPEC = recordEntrySpec(PLAYER_SPEC, '背包');
const EQUIP_ITEM_SPEC = recordEntrySpec(PLAYER_SPEC, '装备');
const SKILL_SPEC = recordEntrySpec(PLAYER_SPEC, '技能');
const STATUS_SPEC = recordEntrySpec(PLAYER_SPEC, '状态效果');

// ========== 值变换（按内核字段名登记） ==========

/** 内核 `CharacterState.type` → `档案/类别` 的中文（反查词表 `CHARACTER_CATEGORY_TYPES`；普通人物不出）。 */
const CATEGORY_LABEL_OF_TYPE = new Map<string, string>();
for (const [label, type] of Object.entries(CHARACTER_CATEGORY_TYPES)) {
  if (type !== 'npc' && !CATEGORY_LABEL_OF_TYPE.has(type)) CATEGORY_LABEL_OF_TYPE.set(type, label);
}

function isGroup(char: CharacterState): boolean {
  return char.type === 'monster' || char.type === 'summon';
}

interface AscensionDetail {
  name: string;
  description: string;
  effects?: string[];
  effectDescriptions?: Record<string, string>;
  costDescription?: string;
}

/** 词条：`effectDescriptions` 优先；旧数据只有 `effects: string[]` 时合并成一条词条。 */
function ascensionEffects(detail: AscensionDetail): StateTreeValue | undefined {
  if (detail.effectDescriptions) return dictCopy(detail.effectDescriptions);
  if (detail.effects && detail.effects.length > 0) {
    const coerced = coerceEffectDict(detail.effects);
    return coerced.ok ? dictCopy(coerced.value) : undefined;
  }
  return undefined;
}

function affectionOf(profile: StateTreeProfile, name: string): number {
  const affections = profile.affections ?? {};
  return hasOwn(affections, name) ? affections[name] : 0;
}

const asChar = (frame: Frame) => frame.src as unknown as CharacterState;

/**
 * 资源三项（生命 / 法力 / 体力）：分支的 `kernel` 是当前值字段，其下 `上限` 分支（规则 capTotal）的
 * `kernel` 是总上限字段、`额外`（规则 capBonus）的 `kernel` 是 `max*Bonus`。
 * 上限拆分（`readResourceCaps`）的基础给 `_基础`（派生），额外给 `额外`；总上限不单独投影。
 */
function resourceTransforms(): Record<string, Transform> {
  const out: Record<string, Transform> = {};
  for (const node of PLAYER_SPEC.children) {
    if (node.type !== 'branch' || node.kernel === undefined) continue;
    const cap = node.children.find((c) => c.rule === 'capTotal');
    if (cap?.type !== 'branch' || cap.kernel === undefined) continue;
    const bonus = cap.children.find((c) => c.rule === 'capBonus');
    const key = node.kernel as ResourceKey;
    out[node.kernel] = {
      frame: (f) => ({ ...f, derived: { ...f.derived, capBase: f.caps?.[key].base } }),
    };
    out[cap.kernel] = { frame: (f) => f };
    if (bonus?.kernel !== undefined) out[bonus.kernel] = { value: (_, f) => f.caps?.[key].bonus };
  }
  return out;
}

/**
 * 子对象分支按「真值即下钻」取源：与词表驱动前的投影逐字一致，登神长阶 / 神国是非对象真值
 * （字符串、数字、数组 …）时照旧出各自的空壳，而不是不出键。
 */
const truthyChild = (kernel: string): Transform => ({
  frame: (f) => {
    const raw = f.src[kernel];
    return raw ? { ...f, src: raw as Source } : undefined;
  },
});

/** 人物（含其档案 / 成长 / 资源 / 登神长阶分组）。 */
const PERSON_SCOPE: Scope = {
  type: { value: (raw) => (typeof raw === 'string' ? CATEGORY_LABEL_OF_TYPE.get(raw) : undefined) },
  attributes: { frame: (f) => ({ ...f, src: asChar(f).attributes ?? {} }) },
  ...resourceTransforms(),
  present: { value: (raw) => raw === true },
  affections: { value: (_, f) => affectionOf(f.ctx.profile, asChar(f).name) },
  quantity: {
    value: (raw, f) => (isGroup(asChar(f)) ? ((raw as number | undefined) ?? 1) : undefined),
  },
  ascension: truthyChild('ascension'),
  divineKingdom: truthyChild('divineKingdom'),
  // 登神条目的词条（旧数据只有 effects 数组）
  effectDescriptions: { value: (_, f) => ascensionEffects(f.src as unknown as AscensionDetail) },
};

const BAG_ITEM_SCOPE: Scope = {};

/** 已穿戴物品：`数量` 只在大于 1 时出现。 */
const EQUIP_ITEM_SCOPE: Scope = {
  quantity: { value: (raw) => (typeof raw === 'number' && raw > 1 ? raw : undefined) },
  equippedSlot: { value: (raw) => (raw ?? undefined) as StateTreeValue | undefined },
};

const SKILL_SCOPE: Scope = {
  type: {
    value: (raw) => (raw === 'passive' ? SKILL_TYPE_LABELS.passive : SKILL_TYPE_LABELS.active),
  },
  cost: { value: (_, f) => formatSkillCost(f.src as unknown as Skill) || undefined },
  relevantAttribute: {
    value: (raw) => (raw ? ATTRIBUTE_LABELS[raw as keyof typeof ATTRIBUTE_LABELS] : undefined),
  },
};

const STATUS_SCOPE: Scope = {
  remainingTime: { value: (_, f) => formatDuration(f.src as unknown as StatusEffect) },
};

const QUEST_SCOPE: Scope = {};

/** 根与 `世界`：源是存档档案（外加主角位置）。 */
const ROOT_SCOPE: Scope = {
  gameTime: { value: (raw) => (raw ? formatGameTime(raw as SaveProfile['gameTime']) : undefined) },
  news: {
    value: (raw, f) => projectNews(raw as readonly NewsItem[] | undefined, f.ctx.newsLimit),
  },
  // 叙事变量空间原样深拷贝（JSON 往返：切断引用与 Proxy，丢掉 undefined）
  variables: { value: (raw) => jsonClone(raw ?? {}) as StateTreeValue },
};

// ========== 人物节点 ==========

function entityFrame(src: object, scope: Scope, ctx: ProjectionContext): Frame {
  return { src: src as Source, scope, ctx, derived: {}, relation: false };
}

function projectPerson(char: CharacterState, ctx: ProjectionContext, relation: boolean) {
  const age = characterAge(char, ctx.profile.gameTime);
  const anchor = char.ageAnchor;
  const frame: Frame = {
    src: char as unknown as Source,
    scope: PERSON_SCOPE,
    ctx,
    relation,
    caps: readResourceCaps(char),
    derived: {
      age: age ?? undefined,
      birthday:
        age !== null && anchor && hasGivenBirthday(char)
          ? `${anchor.month}月${anchor.day}日`
          : undefined,
    },
  };
  return assemble(relation ? RELATION_SPEC : PLAYER_SPEC, frame);
}

/** 不在场且未点名的角色：只投关系列表专属的非可选键（在场 / 地点 / 好感度）。 */
function projectSummary(char: CharacterState, ctx: ProjectionContext): StateTreeObject {
  const frame: Frame = { ...entityFrame(char, PERSON_SCOPE, ctx), relation: true };
  return assemble(RELATION_SPEC, frame, (c) => c.relationOnly === true && !c.optional);
}

function itemRecord(spec: StateTreeBranchSpec, scope: Scope, equipped: boolean) {
  return (f: Frame) =>
    recordOf(
      (asChar(f).inventory ?? []).filter((i) => !!i.equippedSlot === equipped),
      (i) => i.name,
      (i) => assemble(spec, entityFrame(i, scope, f.ctx)),
    );
}

STRUCTURAL.set(recordSpec(PLAYER_SPEC, '背包'), itemRecord(BAG_ITEM_SPEC, BAG_ITEM_SCOPE, false));
STRUCTURAL.set(
  recordSpec(PLAYER_SPEC, '装备'),
  itemRecord(EQUIP_ITEM_SPEC, EQUIP_ITEM_SCOPE, true),
);
STRUCTURAL.set(recordSpec(PLAYER_SPEC, '技能'), (f) =>
  recordOf(
    asChar(f).skills ?? [],
    (s) => s.name,
    (s) => assemble(SKILL_SPEC, entityFrame(s, SKILL_SCOPE, f.ctx)),
  ),
);
STRUCTURAL.set(recordSpec(PLAYER_SPEC, '状态效果'), (f) =>
  recordOf(
    asChar(f).statusEffects ?? [],
    (s) => s.name,
    (s) => assemble(STATUS_SPEC, entityFrame(s, STATUS_SCOPE, f.ctx)),
  ),
);

// ========== 根：主角 / 关系列表 / 任务列表 / 新闻 ==========

STRUCTURAL.set(PLAYER_SPEC, (f) =>
  f.ctx.player ? projectPerson(f.ctx.player, f.ctx, false) : undefined,
);
STRUCTURAL.set(recordSpec(STATE_TREE_SPEC, '关系列表'), (f) =>
  recordOf(
    f.ctx.characters.filter((c) => c.type !== 'player'),
    (c) => c.name,
    (c) => (f.ctx.isFull(c) ? projectPerson(c, f.ctx, true) : projectSummary(c, f.ctx)),
  ),
);
STRUCTURAL.set(recordSpec(STATE_TREE_SPEC, '任务列表'), (f) => {
  const out: StateTreeObject = {};
  for (const [name, quest] of Object.entries(f.ctx.profile.quests ?? {})) {
    setEntry(out, name, assemble(QUEST_SPEC, entityFrame(quest as Quest, QUEST_SCOPE, f.ctx)));
  }
  return out;
});

function projectNews(news: readonly NewsItem[] | undefined, limit: number): StateTreeObject {
  const out: StateTreeObject = {};
  if (!news || limit <= 0) return out;
  for (const item of news.slice(-limit)) {
    const column = item.category || UNCATEGORIZED_NEWS_COLUMN;
    if (!hasOwn(out, column)) setEntry(out, column, {});
    // 同栏目同标题：后发的覆盖先发的（新闻只增不删，最新一条为准）
    setEntry(out[column] as StateTreeObject, item.title, item.content);
  }
  return out;
}

// ========== 入口 ==========

/** 判断关系列表里的角色是否给全量节点。 */
function makeFullPredicate(visibility: StateTreeVisibility | undefined) {
  if (visibility?.mode === 'all') return () => true;
  const names = new Set(visibility?.fullNames ?? []);
  return (char: CharacterState) => char.present === true || names.has(char.name);
}

/**
 * 内核状态 → 状态树（`stat_data`，§3.1）。
 *
 * 根键顺序：世界 / 命运点数 / 主角 / 关系列表 / 任务列表 / 新闻 / 变量。
 * `关系列表` 与 `任务列表` 恒出现（可能为空对象），没有主角时不出 `主角`。
 */
export function buildStateTree(
  input: StateTreeInput,
  options: StateTreeOptions = {},
): StateTreeObject {
  const { characters, profile } = input;
  const player = characters.find((c) => c.type === 'player');
  const ctx: ProjectionContext = {
    characters,
    profile,
    player,
    isFull: makeFullPredicate(options.visibility),
    newsLimit: options.newsLimit ?? DEFAULT_STATE_TREE_NEWS_LIMIT,
  };
  const time = profile.gameTime;
  const root: Frame = {
    ...entityFrame({ ...profile, location: player?.location }, ROOT_SCOPE, ctx),
    derived: {
      timeOfDay: time ? getTimeOfDay(time) : undefined,
      weather: input.weather,
      turn: input.turn,
    },
  };
  return assemble(STATE_TREE_SPEC, root);
}

/** 关系列表条目是否摘要（不在场且未点名的角色）。全量人物节点恒有 `档案`。 */
export function isStateTreePersonSummary(node: StateTreeValue | undefined): boolean {
  return typeof node === 'object' && node !== null && !Array.isArray(node) && !hasOwn(node, '档案');
}
