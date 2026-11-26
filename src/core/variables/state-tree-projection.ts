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
 */

import { ATTRIBUTE_LABELS, findChildSpec, STATE_TREE_SPEC } from './state-tree-spec';
import type { StateTreeBranchSpec, StateTreeNodeSpec } from './state-tree-spec';
import { coerceEffectDict, formatDuration, formatSkillCost } from './state-tree-codecs';
import { jsonClone } from './state-tree-utils';
import { readResourceCaps, type ResourceKey } from '../character/resource-caps';
import { characterAge, hasGivenBirthday } from '../character/character-age';
import { formatGameTime, getTimeOfDay } from '../time/time-system';
import type {
  CharacterState,
  InventoryItem,
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

/** 关系列表里不在场角色的摘要。 */
interface StateTreePersonSummary extends StateTreeObject {
  在场: false;
  地点: string;
  好感度: number;
}

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

type Getters = Readonly<Record<string, () => StateTreeValue | undefined>>;

/**
 * 按词表分支的子节点顺序取值组装对象：键序 = 词表顺序，`undefined` 不出键。
 * `keep` 可再按子节点过滤（关系列表专属键）。
 */
function assemble(
  spec: StateTreeBranchSpec,
  getters: Getters,
  keep: (child: StateTreeNodeSpec) => boolean = () => true,
): StateTreeObject {
  const out: StateTreeObject = {};
  for (const child of spec.children) {
    if (!keep(child)) continue;
    const get = getters[child.key];
    if (!get) continue;
    const value = get();
    if (value !== undefined) setEntry(out, child.key, value);
  }
  return out;
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

function branchSpec(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const found = findChildSpec(parent, key);
  if (!found || found.type !== 'branch') throw new Error(`状态树词表缺少分支「${key}」`);
  return found;
}

function recordEntrySpec(parent: StateTreeBranchSpec, key: string): StateTreeBranchSpec {
  const found = findChildSpec(parent, key);
  if (!found || found.type !== 'record' || found.entry.type !== 'branch') {
    throw new Error(`状态树词表缺少字典「${key}」`);
  }
  return found.entry;
}

/** 文本数组浅拷贝（不把内核数组引用交出去）。 */
function texts(list: readonly string[] | undefined): string[] | undefined {
  return list ? [...list] : undefined;
}

/** 字典浅拷贝；键序沿用原对象。 */
function dictCopy<V extends StateTreeValue>(
  dict: Readonly<Record<string, V>> | undefined,
): StateTreeObject | undefined {
  if (!dict) return undefined;
  const out: StateTreeObject = {};
  for (const [k, v] of Object.entries(dict)) setEntry(out, k, v);
  return out;
}

// ========== 词表节点（模块加载时从 spec 取一次） ==========

const WORLD_SPEC = branchSpec(STATE_TREE_SPEC, '世界');
const PLAYER_SPEC = branchSpec(STATE_TREE_SPEC, '主角');
const RELATION_SPEC = recordEntrySpec(STATE_TREE_SPEC, '关系列表');
const QUEST_SPEC = recordEntrySpec(STATE_TREE_SPEC, '任务列表');
const PROFILE_SPEC = branchSpec(PLAYER_SPEC, '档案');
const GROWTH_SPEC = branchSpec(PLAYER_SPEC, '成长');
const ATTR_SPEC = branchSpec(GROWTH_SPEC, '_属性');
const HP_SPEC = branchSpec(PLAYER_SPEC, '生命值');
const CAP_SPEC = branchSpec(HP_SPEC, '上限');
const BAG_ITEM_SPEC = recordEntrySpec(PLAYER_SPEC, '背包');
const EQUIP_ITEM_SPEC = recordEntrySpec(PLAYER_SPEC, '装备');
const DURABILITY_SPEC = branchSpec(BAG_ITEM_SPEC, '耐久');
const SKILL_SPEC = recordEntrySpec(PLAYER_SPEC, '技能');
const STATUS_SPEC = recordEntrySpec(PLAYER_SPEC, '状态效果');
const ASCENSION_SPEC = branchSpec(PLAYER_SPEC, '登神长阶');
const ELEMENT_SPEC = recordEntrySpec(ASCENSION_SPEC, '要素');
const AUTHORITY_SPEC = recordEntrySpec(ASCENSION_SPEC, '权能');
const LAW_SPEC = recordEntrySpec(ASCENSION_SPEC, '法则');
const KINGDOM_SPEC = branchSpec(ASCENSION_SPEC, '神国');

// ========== 物品 / 技能 / 状态 ==========

function projectDurability(item: InventoryItem): StateTreeValue | undefined {
  if (item.durability === undefined && item.maxDurability === undefined) return undefined;
  return assemble(DURABILITY_SPEC, {
    当前: () => item.durability,
    上限: () => item.maxDurability,
  });
}

function projectItem(item: InventoryItem, equipped: boolean): StateTreeValue {
  const spec = equipped ? EQUIP_ITEM_SPEC : BAG_ITEM_SPEC;
  return assemble(spec, {
    品质: () => item.rarity,
    类型: () => item.type,
    数量: () => (equipped ? (item.quantity > 1 ? item.quantity : undefined) : item.quantity),
    位置: () => (equipped ? (item.equippedSlot ?? undefined) : undefined),
    标签: () => texts(item.tags),
    效果: () => dictCopy(item.effects),
    描述: () => item.description,
    属性: () => dictCopy(item.stats),
    耐久: () => projectDurability(item),
    规则文本: () => item.protocolText,
  });
}

function projectSkill(skill: Skill): StateTreeValue {
  return assemble(SKILL_SPEC, {
    品质: () => skill.rarity,
    类型: () => (skill.type === 'passive' ? '被动' : '主动'),
    消耗: () => formatSkillCost(skill) || undefined,
    冷却: () => skill.cooldown,
    标签: () => texts(skill.tags),
    效果: () => dictCopy(skill.effects),
    描述: () => skill.description,
    威力: () => skill.skillPower,
    关联属性: () =>
      skill.relevantAttribute ? ATTRIBUTE_LABELS[skill.relevantAttribute] : undefined,
    伤害类型: () => skill.damageType,
    规则文本: () => skill.protocolText,
  });
}

function projectStatus(effect: StatusEffect): StateTreeValue {
  return assemble(STATUS_SPEC, {
    类型: () => effect.category,
    描述: () => effect.description,
    效果: () => dictCopy(effect.effectDescriptions),
    层数: () => effect.stacks,
    层数上限: () => effect.maxStacks,
    剩余时间: () => formatDuration(effect),
    来源: () => effect.source,
  });
}

// ========== 登神长阶 ==========

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

function projectAscensionDetail(spec: StateTreeBranchSpec, detail: AscensionDetail) {
  return assemble(spec, {
    描述: () => detail.description,
    效果: () => ascensionEffects(detail),
    消耗: () => detail.costDescription,
  });
}

function projectAscension(
  asc: CharacterState['ascension'] | undefined,
): StateTreeValue | undefined {
  if (!asc) return undefined;
  const byName = (spec: StateTreeBranchSpec, list: readonly AscensionDetail[] | undefined) =>
    recordOf(
      list ?? [],
      (d) => d.name,
      (d) => projectAscensionDetail(spec, d),
    );
  return assemble(ASCENSION_SPEC, {
    是否开启: () => asc.enabled,
    要素: () => byName(ELEMENT_SPEC, asc.elements),
    权能: () => byName(AUTHORITY_SPEC, asc.authority),
    法则: () => byName(LAW_SPEC, asc.law),
    神位: () => asc.deityPosition,
    神国: () =>
      asc.divineKingdom
        ? assemble(KINGDOM_SPEC, {
            名称: () => asc.divineKingdom.name,
            描述: () => asc.divineKingdom.description,
          })
        : undefined,
  });
}

// ========== 人物节点 ==========

const CATEGORY_LABELS: Partial<Record<CharacterState['type'], string>> = {
  monster: '怪物',
  summon: '召唤物',
};

function projectResource(
  char: CharacterState,
  key: ResourceKey,
  caps: ReturnType<typeof readResourceCaps>,
) {
  const cap = caps[key];
  return assemble(HP_SPEC, {
    当前: () => char[key],
    上限: () =>
      assemble(CAP_SPEC, {
        _基础: () => cap.base,
        额外: () => cap.bonus,
      }),
  });
}

interface PersonContext {
  readonly profile: StateTreeProfile;
  readonly relation: boolean;
}

function projectPerson(char: CharacterState, ctx: PersonContext): StateTreeObject {
  const { profile, relation } = ctx;
  const caps = readResourceCaps(char);
  const age = characterAge(char, profile.gameTime);
  const anchor = char.ageAnchor;
  const isGroup = char.type === 'monster' || char.type === 'summon';
  const spec = relation ? RELATION_SPEC : PLAYER_SPEC;
  const inventory = char.inventory ?? [];

  return assemble(spec, {
    档案: () =>
      assemble(
        PROFILE_SPEC,
        {
          种族: () => char.race,
          性别: () => char.gender,
          身份: () => texts(char.identity),
          职业: () => texts(char.occupation),
          _年龄: () => age ?? undefined,
          _生日: () =>
            age !== null && anchor && hasGivenBirthday(char)
              ? `${anchor.month}月${anchor.day}日`
              : undefined,
          外貌: () => char.appearance,
          着装: () => char.outfit,
          性格: () => char.personality,
          背景故事: () => char.background,
          类别: () => CATEGORY_LABELS[char.type],
        },
        (c) => relation || !c.relationOnly,
      ),
    成长: () =>
      assemble(GROWTH_SPEC, {
        _生命层级: () => char.tier,
        等级: () => char.level,
        累计经验值: () => char.totalExp,
        _升级所需经验: () => char.expToNext,
        _属性点: () => char.freeAttrPoints,
        _属性: () =>
          assemble(ATTR_SPEC, {
            力量: () => char.attributes?.str,
            敏捷: () => char.attributes?.dex,
            体质: () => char.attributes?.con,
            智力: () => char.attributes?.int,
            精神: () => char.attributes?.spi,
          }),
      }),
    生命值: () => projectResource(char, 'hp', caps),
    法力值: () => projectResource(char, 'mp', caps),
    体力值: () => projectResource(char, 'sp', caps),
    金钱: () => char.money,
    当前行动: () => char.currentAction,
    心里话: () => char.thoughts,
    背包: () =>
      recordOf(
        inventory.filter((i) => !i.equippedSlot),
        (i) => i.name,
        (i) => projectItem(i, false),
      ),
    装备: () =>
      recordOf(
        inventory.filter((i) => !!i.equippedSlot),
        (i) => i.name,
        (i) => projectItem(i, true),
      ),
    技能: () => recordOf(char.skills ?? [], (s) => s.name, projectSkill),
    状态效果: () => recordOf(char.statusEffects ?? [], (s) => s.name, projectStatus),
    登神长阶: () => projectAscension(char.ascension),
    在场: () => char.present === true,
    地点: () => char.location,
    好感度: () => affectionOf(profile, char.name),
    数量: () => (isGroup ? (char.quantity ?? 1) : undefined),
  });
}

function affectionOf(profile: StateTreeProfile, name: string): number {
  const affections = profile.affections ?? {};
  return hasOwn(affections, name) ? affections[name] : 0;
}

function projectSummary(char: CharacterState, profile: StateTreeProfile): StateTreePersonSummary {
  return { 在场: false, 地点: char.location, 好感度: affectionOf(profile, char.name) };
}

// ========== 世界 / 任务 / 新闻 ==========

function projectWorld(input: StateTreeInput, player: CharacterState | undefined): StateTreeObject {
  const time = input.profile.gameTime;
  return assemble(WORLD_SPEC, {
    时间: () => (time ? formatGameTime(time) : undefined),
    地点: () => player?.location,
    _时段: () => (time ? getTimeOfDay(time) : undefined),
    _天气: () => input.weather,
    _回合: () => input.turn,
  });
}

function projectQuest(quest: Quest): StateTreeValue {
  return assemble(QUEST_SPEC, {
    状态: () => quest.status,
    关注度: () => quest.priority,
    进展: () => quest.progress,
    详情: () => quest.detail,
    目标: () => quest.objective,
    奖励: () => quest.reward,
  });
}

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
  const isFull = makeFullPredicate(options.visibility);
  const newsLimit = options.newsLimit ?? DEFAULT_STATE_TREE_NEWS_LIMIT;

  return assemble(STATE_TREE_SPEC, {
    世界: () => projectWorld(input, player),
    命运点数: () => profile.fp,
    主角: () => (player ? projectPerson(player, { profile, relation: false }) : undefined),
    关系列表: () =>
      recordOf(
        characters.filter((c) => c.type !== 'player'),
        (c) => c.name,
        (c) =>
          isFull(c) ? projectPerson(c, { profile, relation: true }) : projectSummary(c, profile),
      ),
    任务列表: () => {
      const out: StateTreeObject = {};
      for (const [name, quest] of Object.entries(profile.quests ?? {})) {
        setEntry(out, name, projectQuest(quest));
      }
      return out;
    },
    新闻: () => projectNews(profile.news, newsLimit),
    // 叙事变量空间原样深拷贝（JSON 往返：切断引用与 Proxy，丢掉 undefined）
    变量: () => jsonClone(profile.variables ?? {}) as StateTreeValue,
  });
}

/** 关系列表条目是否摘要（不在场且未点名的角色）。全量人物节点恒有 `档案`。 */
export function isStateTreePersonSummary(node: StateTreeValue | undefined): boolean {
  return typeof node === 'object' && node !== null && !Array.isArray(node) && !hasOwn(node, '档案');
}
