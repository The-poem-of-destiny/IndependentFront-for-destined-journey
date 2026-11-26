/**
 * 状态树路径补丁 → StatePatch 的翻译层（状态树协议 T6，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §4.3–4.4、§5、§11.2、§12.2）
 *
 * 输入是 `parseTreePatchBlock` 规范化后的 op 列表（AI 写的，或变量修改器 / 更新块修订产生的），
 * 输出是交给 `StateManager` 的 `StatePatch[]`，外加本楼分钟数、档案文字改动、新人物与逐条结果记录。
 *
 * 流程（每条 op，§5.1）：
 * 1. 解析路径（`resolveTreePath`，对的是工作状态 —— 完整内核状态，不是投影）。
 * 2. 按叶子类型纠正值（`state-tree-codecs.ts`）。
 * 3. 映射成 StatePatch（§5.3 全表）。
 * 4. `validateStatePatch` 核形状，再用 `state/patch-reducer.ts`（与 StateManager 提交时同一份纯变换，
 *    审查报告 R5c）作用到工作状态 —— 提交时会抛的补丁在这里同样抛、被丢；成组的补丁整组落或整组丢。
 * 5. 后面的 op 看得到前面的结果（「先 add 再穿戴」自然成立），记下的后值就是提交后真实落库的值。
 *
 * 顺序：按 AI 原顺序逐条作用；唯一例外是新建人物先落（§4.3）。翻译前先把同批的
 * 「删一边、加一边」（背包 ↔ 装备）折叠成一条 move（§5.3）。
 *
 * 每条 op 都产出一条 `StateUpdateOpRecord`：状态（已应用 / 已纠正 / 已丢弃）、说明、
 * 纠正后的写入值、前值与后值（取自工作状态的投影，§11 撤销与 §12 补差靠它）。
 *
 * 🔴 已裁定（§9）：不加 fitSlot（#9，穿戴槽位只从 op 自带或同批后续写入取）；不加槽位别名（#6）；
 *    从装备 remove = 物品离开人物（#11）；主角等级只读、NPC 等级可写（#2）；金钱钳到 0（#5）。
 * 🔴 本模块不碰 I/O：工作状态是入参的深拷贝，入参不被修改。新人物的 id 由 `createDefaultCharacterState` 生成。
 */

import { assembleCharacterState, bindGeneratedCharacter } from '../agents/entity-gen-agent';
import { getTierForLevel } from '../character/exp-table';
import {
  RESOURCE_FIELDS,
  baseResourceCaps,
  effectiveCap,
  readResourceCaps,
  type ResourceKey,
} from '../character/resource-caps';
import type { EquipSlot } from '../content/field-enums';
import {
  findByName,
  isCharacterPatchOp,
  readTransferItemRequest,
  reduceStatePatch,
  resolveCharacterTarget,
  resourceCeiling,
  type ReducibleState,
  type StateReduceContext,
} from '../state/patch-reducer';
import { resolveCharacterByName, validateStatePatch } from '../state/patch-rules';
import { advanceTime } from '../time/time-system';
import {
  createDefaultQuest,
  type CharacterState,
  type EntityGenOutput,
  type InventoryItem,
  type Quest,
  type Skill,
  type StatePatch,
  type StatusEffect,
  type StateUpdateOpRecord,
} from '../types/types';
import type { CharacterDefinition, CharacterNarrativeUpdate } from '../types/types-character';
import {
  clampQuantityDecrease,
  coerceAffection,
  coerceAttribute,
  coerceBoolean,
  coerceCapBonus,
  coerceCapTotal,
  coerceDamageType,
  coerceEffectDict,
  coerceFatePointsDelta,
  coerceItemType,
  coerceMoneyResult,
  coerceNumber,
  coerceNumberDict,
  coerceQuantity,
  coerceQuestPriority,
  coerceQuestStatus,
  coerceRarity,
  coerceResourceCurrent,
  coerceSkillType,
  coerceSlot,
  coerceStacks,
  coerceStatusCategory,
  coerceText,
  coerceTextArray,
  coerceTimeAdvance,
  parseDuration,
  parseSkillCost,
  pickKnownKeys,
  type CodecResult,
  type SlotValue,
} from './state-tree-codecs';
import {
  resolveTreePath,
  type ResolvedTreePath,
  type TreeOp,
  type TreeOpIssue,
  type TreeOpKind,
  type TreePathStyle,
} from './state-tree-patch';
import {
  buildStateTree,
  UNCATEGORIZED_NEWS_COLUMN,
  type StateTreeProfile,
  type StateTreeValue,
} from './state-tree-projection';
import {
  ATTRIBUTE_LABELS,
  CHARACTER_CATEGORY_TYPES,
  STATE_TREE_DEPLETABLE_LEAF,
  listStateTreePaths,
  stateTreeBranchAt,
  stateTreeChildKeys,
  stateTreeKernelOf,
  stateTreeKeyOfKernel,
  stateTreeRowAt,
  stripReadonlyPrefix,
  type StateTreeBranchSpec,
  type StateTreeNodeSpec,
  type StateTreeWriteRule,
} from './state-tree-spec';
import { VAR_NAMESPACES, getVar } from './var-resolver';

// ========== 对外类型 ==========

/** 谁在写：AI（直出 / Agent 模式）或玩家（变量修改器、更新块修订，§11.3 的放宽项）。 */
export type TreeTranslateActor = 'ai' | 'player';

/** 翻译所需的内核状态（不会被修改）。 */
export interface TreeTranslateSnapshot {
  readonly characters: readonly CharacterState[];
  readonly profile: StateTreeProfile;
}

export interface TreeTranslateOptions {
  readonly actor: TreeTranslateActor;
  /** 新人物的 `introducedBy`（本楼来源回合键）。 */
  readonly sourceTurnKey?: string;
  /** 作者定义（新人物按名字或别名绑定，同直出现有口径）。 */
  readonly definitions?: readonly CharacterDefinition[];
  /** 本楼的叙事更新（新人物绑定档案用）。 */
  readonly characterUpdates?: readonly CharacterNarrativeUpdate[];
  /** 区块解析阶段的纠正说明（按 op 序号并入该条记录）。 */
  readonly parseNormalized?: readonly TreeOpIssue[];
}

export interface TreeTranslateResult {
  /** 按落下顺序排好的补丁（新人物在前）。 */
  readonly patches: StatePatch[];
  /** 本楼推进的游戏分钟数（交给 applyTimeAdvance，不产补丁）。 */
  readonly deltaMinutes: number;
  /** 恒为空：档案文字字段已改走 `update_character` 补丁（2026-11-25，审查 A8）；字段待后续任务删除。 */
  readonly profileChanges: CharacterNarrativeUpdate[];
  /** 本楼新建的人物（已组装，与 add_character 补丁里的是同一份）。 */
  readonly newCharacters: CharacterState[];
  /** 每条 op 一条记录，按 op 原序号排序。 */
  readonly records: StateUpdateOpRecord[];
  /** 「模型原文路径：原因，已忽略」。 */
  readonly dropped: string[];
  /** 「路径：纠正说明」。 */
  readonly normalized: string[];
}

// ========== 词表映射（审查报告 R6a：键 → 规则 / 内核字段只从 state-tree-spec 读） ==========

/**
 * 路径模式（`listStateTreePaths` 的 `pattern`）的翻译规则，读自词表（`StateTreeWriteRule`，本模块不再另登记）；
 * 不在词表里返回 undefined。登神长阶下任意路径都按「整份重建」处理（规则由 `登神长阶` 节点向下继承）。
 */
export function stateTreeTranslationRuleOf(pattern: string): StateTreeWriteRule | undefined {
  return stateTreeRowAt(pattern)?.rule;
}

/** 路径模式对应的内核字段键（词表 `kernel`）；闸门测试据此核对「每个可写叶子都映射到内核字段」。 */
export function stateTreeKernelFieldOf(pattern: string): string | undefined {
  return stateTreeRowAt(pattern)?.spec.kernel;
}

// 各实体的形状（键、内核字段、规则）一律取自词表
const PERSON_SPEC = stateTreeBranchAt('/关系列表/{人物名}');
const PROFILE_SPEC = stateTreeBranchAt('/关系列表/{人物名}/档案');
const GROWTH_SPEC = stateTreeBranchAt('/关系列表/{人物名}/成长');
const EQUIP_ITEM_SPEC = stateTreeBranchAt('/主角/装备/{物品名}');
const BAG_ITEM_SPEC = stateTreeBranchAt('/主角/背包/{物品名}');
const SKILL_SPEC = stateTreeBranchAt('/主角/技能/{技能名}');
const STATUS_SPEC = stateTreeBranchAt('/主角/状态效果/{状态名}');
const ASCENSION_SPEC = stateTreeBranchAt('/主角/登神长阶');
const QUEST_SPEC = stateTreeBranchAt('/任务列表/{任务名}');

/** 档案文字 / 列表叶子的内核字段（词表 `档案` 下 profileText / profileList 规则的 `kernel`）。 */
type ProfileTextField = 'race' | 'gender' | 'appearance' | 'outfit' | 'personality' | 'background';
type ProfileListField = 'identity' | 'occupation';

/** 分支下按键（精确）取子节点。 */
function childOf(parent: StateTreeBranchSpec, key: string): StateTreeNodeSpec | undefined {
  return parent.children.find((c) => c.key === key);
}

/** 分支下内核字段为 `kernel` 的子键；词表里没有即抛（编程错误）。 */
function keyOf(parent: StateTreeBranchSpec, kernel: string): string {
  const key = stateTreeKeyOfKernel(parent, kernel);
  if (key === undefined) throw new Error(`词表「${parent.key}」下没有内核字段 ${kernel}`);
  return key;
}

/** 装备条目的位置键（字符串值直写成 `{位置: 值}` 时用）。 */
const SLOT_KEY = keyOf(EQUIP_ITEM_SPEC, 'equippedSlot');

/** 人物节点下的资源分支（生命值 / 法力值 / 体力值）：键 → 资源与其子键。 */
interface ResourceNode {
  readonly label: string;
  readonly key: ResourceKey;
  readonly current: string;
  readonly cap: string;
  readonly bonus: string;
}

const RESOURCE_NODES: readonly ResourceNode[] = PERSON_SPEC.children.flatMap((node) => {
  if (node.type !== 'branch') return [];
  const current = node.children.find((c) => c.rule === 'resourceCurrent');
  const cap = node.children.find((c) => c.rule === 'capTotal');
  if (!current || !cap || cap.type !== 'branch') return [];
  const bonus = cap.children.find((c) => c.rule === 'capBonus');
  if (!bonus) return [];
  return [
    {
      label: node.key,
      key: node.kernel as ResourceKey,
      current: current.key,
      cap: cap.key,
      bonus: bonus.key,
    },
  ];
});

function resourceOf(label: string): ResourceKey {
  const r = RESOURCE_NODES.find((n) => n.label === label);
  if (!r) throw new Drop(`「${label}」不是资源`);
  return r.key;
}

/** 整对象展开时先写的键：上限类键决定「当前」的钳制范围，必须先落（见 `expand`） */
const CAP_FIRST_KEYS: ReadonlySet<string> = new Set(
  listStateTreePaths()
    .filter((r) => r.rule === 'capTotal' || r.rule === 'capBonus')
    .map((r) => r.spec.key),
);

/** 登神长阶的空树（键与顺序取自词表）：布尔 false、文本空串、字典空对象、分支递归。 */
function emptyTree(spec: StateTreeBranchSpec): Row {
  const out: Row = {};
  for (const c of spec.children) {
    if (c.type === 'branch') out[c.key] = emptyTree(c);
    else if (c.type === 'record') out[c.key] = {};
    else out[c.key] = c.leaf === 'boolean' ? false : '';
  }
  return out;
}

// ========== 内部类型 ==========

/** 丢弃信号：handler 里抛出，顶层收成「已丢弃」记录。 */
class Drop extends Error {}

interface WorkOp {
  readonly index: number;
  readonly op: TreeOpKind;
  readonly rawPath: string;
  readonly segments: readonly string[];
  readonly style: TreePathStyle;
  readonly value?: unknown;
  readonly hasValue: boolean;
  readonly fromRaw?: string;
  readonly fromSegments?: readonly string[];
  readonly fromStyle?: TreePathStyle;
  /** 折叠进本条的另一条 op 的序号（删一边加一边）。 */
  readonly foldedFrom?: number;
  readonly preNotes: readonly string[];
}

interface OpContext {
  readonly op: WorkOp;
  readonly notes: string[];
  /** 解析后的路径（记录用）；解析不了时缺席。 */
  pointer?: string;
  segments?: readonly string[];
  fromPointer?: string;
  fromSegments?: readonly string[];
  /** 纠正后的写入值（树上的形状）。 */
  value?: unknown;
  hasValue: boolean;
  /** 本条消费掉的同批后续 op（槽位取自它们）。 */
  readonly consumed: number[];
  /** 记录里写的动作（纠正后与原动作不同时才给，如叠到已穿戴物品上的 add 记成 `装备/<物>/数量` 的 delta）。 */
  recordOp?: TreeOpKind;
}

type Row = Record<string, unknown>;

// ========== 小工具 ==========

function isPlainObject(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 取纠正结果：失败抛 Drop；有说明记进 notes（带标签）。 */
function take<T>(r: CodecResult<T>, notes: string[], label?: string): T {
  if (!r.ok) throw new Drop(label ? `${label}：${r.reason}` : r.reason);
  if (r.note) notes.push(label ? `${label}：${r.note}` : r.note);
  return r.value;
}

const charTarget = (name: string): string => `characters.${name}`;

/** 读树上某路径的值（投影出来的那棵）。 */
export function readStateTreeValue(
  tree: StateTreeValue | undefined,
  segments: readonly string[],
): StateTreeValue | undefined {
  let cur: StateTreeValue | undefined = tree;
  for (const s of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const i = Number(s);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else {
      if (!hasOwn(cur, s)) return undefined;
      cur = cur[s];
    }
  }
  return cur;
}

const NAMESPACES = new Set<string>(Object.values(VAR_NAMESPACES));
const NAMESPACE_ROOT_REASON = '不能整块写或删变量命名空间，请写到 /变量/<命名空间>/<键>';

/** 在字典 / 文本数组叶子上按子键编辑（`效果/<词条>`、`标签/<序号>`）。 */
function editKeyed(
  current: unknown,
  op: TreeOpKind,
  leafKey: string,
  value: unknown,
  asArray: boolean,
): unknown {
  if (asArray) {
    const arr = Array.isArray(current) ? [...(current as unknown[])] : [];
    const idx = leafKey === '-' ? arr.length : Number(leafKey);
    if (op === 'remove') {
      if (Number.isInteger(idx) && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
      else {
        const at = arr.indexOf(leafKey);
        if (at < 0) throw new Drop(`标签里没有「${leafKey}」`);
        arr.splice(at, 1);
      }
      return arr;
    }
    if (!Number.isInteger(idx) || idx < 0) throw new Drop(`「${leafKey}」不是数组序号`);
    if (op === 'add') arr.splice(Math.min(idx, arr.length), 0, value);
    else arr[idx] = value;
    return arr;
  }
  const dict: Row = isPlainObject(current) ? { ...current } : {};
  if (op === 'remove') {
    if (!hasOwn(dict, leafKey)) throw new Drop(`没有子键「${leafKey}」`);
    delete dict[leafKey];
  } else if (op === 'delta') {
    const cur = typeof dict[leafKey] === 'number' ? (dict[leafKey] as number) : 0;
    const n = coerceNumber(value);
    if (!n.ok) throw new Drop(n.reason);
    dict[leafKey] = cur + n.value;
  } else {
    Object.defineProperty(dict, leafKey, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return dict;
}

// ========== 字段构造（树上的值 → 内核字段） ==========

interface ItemFields {
  fields: Partial<InventoryItem>;
  quantity?: number;
  slot?: SlotValue;
}

/**
 * 物品条目对象 → 内核字段（键 → 内核字段取自词表）。`lenient`：认不出的枚举省略而不是丢弃（整实体写入）。
 */
function buildItemFields(raw: Row, notes: string[], lenient: boolean): ItemFields {
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

function buildSkillFields(raw: Row, notes: string[], lenient: boolean): SkillFields {
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

function buildStatusFields(raw: Row, notes: string[], maxStacks: number | undefined): StatusFields {
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
function statusPayload(e: StatusEffect): Partial<StatusEffect> {
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

// ========== 工作状态：经 patch-reducer 推进 ==========

/**
 * 翻译层推进工作状态的上下文（审查报告 R5c）：命运点按提交口径（V1：AI 来源扣超余额钳到 0，
 * 玩家编辑不足抛错 —— 抛错即这条 op 被丢）；新闻的账务字段只在工作状态里占位，真值由提交时补。
 */
function workingReduceContext(
  actor: TreeTranslateActor,
  state: ReducibleState,
): StateReduceContext {
  return {
    fatePoints: { clampSpend: actor === 'ai' },
    newsStamp: () => ({ id: `pending-${state.profile.news.length}`, publishedAt: 0 }),
  };
}

/**
 * 写时复制：补丁作用前，把它要改的角色 / 档案分区在 `next` 里换成深拷副本（同一组里只拷一次）。
 * `next` 的角色数组与档案对象本身已是浅拷；增删角色只动数组，命运点只改档案上的数值，不必再拷。
 * 找不到目标角色时不拷（reducer 随后同样找不到、抛错，整组不落）。
 */
function cowTouch(next: ReducibleState, patch: StatePatch, copied: Set<object>): void {
  const own = <T extends object>(v: T): T => {
    if (copied.has(v)) return v;
    const c = structuredClone(v);
    copied.add(c);
    return c;
  };
  const touchChar = (resolve: () => CharacterState): void => {
    let char: CharacterState;
    try {
      char = resolve();
    } catch {
      return;
    }
    const at = next.characters.indexOf(char);
    if (at >= 0) next.characters[at] = own(char);
  };
  const p = next.profile;
  if (isCharacterPatchOp(patch.op)) {
    touchChar(() => resolveCharacterTarget(next.characters, patch.target));
    return;
  }
  switch (patch.op) {
    case 'transfer_item':
      touchChar(() => resolveCharacterTarget(next.characters, patch.target));
      touchChar(() => resolveCharacterByName(next.characters, readTransferItemRequest(patch).to));
      return;
    case 'rename_character':
      touchChar(() => resolveCharacterTarget(next.characters, patch.target));
      if (!copied.has(p.affections)) {
        p.affections = { ...p.affections };
        copied.add(p.affections);
      }
      return;
    case 'set_affection':
    case 'delta_affection':
      if (!copied.has(p.affections)) {
        p.affections = { ...p.affections };
        copied.add(p.affections);
      }
      return;
    case 'update_quest':
    case 'remove_quest':
      if (!copied.has(p.quests)) {
        p.quests = { ...p.quests };
        copied.add(p.quests);
      }
      return;
    case 'add_news':
      if (!copied.has(p.news)) {
        p.news = [...p.news];
        copied.add(p.news);
      }
      return;
    case 'set_variable':
    case 'delta_variable':
    case 'remove_variable':
    case 'move_variable':
    case 'insert_variable':
      // 命运点（delta_variable profile.fp）只改档案上的 fp 数值，变量空间不动
      if (patch.op === 'delta_variable' && patch.target === 'profile.fp') return;
      p.variables = own(p.variables);
      return;
    default:
      return;
  }
}

// ========== 状态视图：只投影被读到的分区 ==========

/** 顶层分区（状态树根下的键）。 */
const WORLD_KEY = '世界';
const PLAYER_KEY = '主角';
const RELATION_KEY = '关系列表';
const QUESTS_KEY = '任务列表';
const NEWS_KEY = '新闻';
const VARIABLES_KEY = '变量';

/**
 * 某一版工作状态的树视图（审查报告 R6a 性能修复）：按读到的路径只投影那一个分区 ——
 * `关系列表/<名>` 只投那一个人物，`主角` / `世界` 只带主角，任务 / 新闻 / 变量只带那一份档案切片；
 * 结果按分区缓存。工作状态按写时复制推进（见 `commit`），旧版本的对象永不被改，
 * 视图读到的就是建视图那一刻的值。
 */
class StateView {
  private readonly cache = new Map<string, StateTreeValue>();

  constructor(private readonly state: ReducibleState) {}

  read(segments: readonly string[]): StateTreeValue | undefined {
    return readStateTreeValue(this.section(segments), segments);
  }

  private section(segments: readonly string[]): StateTreeValue {
    const top: string | undefined = segments[0];
    const personName = top === RELATION_KEY && segments.length >= 2 ? segments[1] : undefined;
    const key = personName !== undefined ? `${RELATION_KEY}/${personName}` : (top ?? '');
    let tree = this.cache.get(key);
    if (tree === undefined) {
      tree = this.project(top, personName);
      this.cache.set(key, tree);
    }
    return tree;
  }

  private project(top: string | undefined, personName: string | undefined): StateTreeValue {
    const { characters, profile } = this.state;
    let chars: readonly CharacterState[];
    if (personName !== undefined) {
      chars = characters.filter((c) => c.type !== 'player' && c.name === personName);
    } else if (top === PLAYER_KEY || top === WORLD_KEY) {
      chars = characters.filter((c) => c.type === 'player');
    } else if (top === undefined || top === RELATION_KEY) {
      chars = characters;
    } else {
      chars = [];
    }
    const whole = top === undefined;
    return buildStateTree(
      {
        characters: chars,
        profile: {
          fp: profile.fp,
          gameTime: profile.gameTime,
          affections: profile.affections,
          quests: whole || top === QUESTS_KEY ? profile.quests : {},
          news: whole || top === NEWS_KEY ? profile.news : [],
          variables: whole || top === VARIABLES_KEY ? profile.variables : {},
        },
      },
      { visibility: { mode: 'all' }, newsLimit: Number.MAX_SAFE_INTEGER },
    );
  }
}

// ========== 翻译器 ==========

class TreeTranslator {
  /** 工作状态：入参的深拷贝，按补丁顺序经 patch-reducer 推进（后面的 op 看得到前面的结果）。 */
  private state: ReducibleState;
  private readonly patches: StatePatch[] = [];
  private deltaMinutes = 0;
  private readonly newCharacters: CharacterState[] = [];
  private readonly records = new Map<number, StateUpdateOpRecord>();
  private readonly dropped: string[] = [];
  private readonly normalized: string[] = [];
  /** 当前版本工作状态的视图（每次换状态时作废重建）。 */
  private currentView: StateView | null = null;
  private queue: WorkOp[] = [];
  private readonly consumed = new Set<number>();
  /** 被折叠 / 被消费的 op 序号 → 代表它落地的那条 op 序号（记录里转成 `foldedInto` / `mergedFrom`）。 */
  private readonly links = new Map<number, { host: number; kind: 'fold' | 'slot' }>();
  /** 本批开始时各人物的类别（按名；改名时跟着搬）。删人物按它判，不信本批中途的改动。 */
  private readonly startTypes = new Map<string, CharacterState['type']>();

  constructor(
    snapshot: TreeTranslateSnapshot,
    private readonly options: TreeTranslateOptions,
  ) {
    const prof = snapshot.profile;
    this.state = {
      characters: jsonClone([...snapshot.characters]),
      profile: {
        fp: typeof prof.fp === 'number' ? prof.fp : 0,
        quests: jsonClone(prof.quests ?? {}),
        news: jsonClone(prof.news ?? []),
        variables: jsonClone(prof.variables ?? {}),
        gameTime: jsonClone(prof.gameTime),
        affections: jsonClone(prof.affections ?? {}),
      },
    };
    for (const c of snapshot.characters) this.startTypes.set(c.name, c.type);
  }

  // ---------- 读工作状态 ----------

  /** 当前工作状态的树视图（按读到的分区惰性投影）。 */
  private view(): StateView {
    this.currentView ??= new StateView(this.state);
    return this.currentView;
  }

  /** 换上新一版工作状态（旧版对象原样留给已建的视图读）。 */
  private setState(next: ReducibleState): void {
    this.state = next;
    this.currentView = null;
  }

  private resolve(segments: readonly string[], style: TreePathStyle, notes: string[]) {
    const r = resolveTreePath(
      segments,
      { characters: this.state.characters, profile: this.state.profile },
      style,
    );
    if (!r.ok) {
      // 背包条目没有 `位置` 键：给出裁定的说法（§5.3，不加 fitSlot）
      const n = segments.length;
      if (n >= 3 && segments[n - 1] === '位置' && segments[n - 3] === '背包') {
        throw new Drop('背包物品不记位置，穿戴请 move 到装备并写位置');
      }
      throw new Drop(r.reason);
    }
    notes.push(...r.notes);
    return r.target;
  }

  private character(name: string): CharacterState {
    return resolveCharacterByName(this.state.characters, name);
  }

  // ---------- 落补丁 ----------

  /**
   * 一组补丁：在工作状态的写时副本上逐条跑 `patch-reducer`（与 StateManager 提交时同一份纯变换），
   * 全部成功才换上副本；任一条抛错整组不落，报错文案即提交时的报错。
   *
   * 写时复制（审查报告 R6a 性能修复）：副本只浅拷角色数组与档案，补丁要改的那几个角色 / 档案分区
   * 在作用前才深拷一份（`cowTouch`），其余对象与旧版共享 —— 旧版对象因此永不被改。
   */
  private commit(group: readonly StatePatch[]): void {
    if (group.length === 0) return;
    const next: ReducibleState = {
      characters: [...this.state.characters],
      profile: { ...this.state.profile },
    };
    const copied = new Set<object>();
    const ctx = workingReduceContext(this.options.actor, next);
    for (const patch of group) {
      try {
        validateStatePatch(patch);
        cowTouch(next, patch, copied);
        // 补丁先深拷一份：reducer 会把补丁里的值并进状态，工作状态不与要提交的补丁共享引用
        // （structuredClone 保留 undefined 键，清除语义不丢）
        reduceStatePatch(next, structuredClone(patch), ctx);
      } catch (e) {
        throw new Drop(`${patch.op}（${patch.target}）：${errorText(e)}`);
      }
    }
    this.setState(next);
    this.patches.push(...group);
  }

  // ---------- 入口 ----------

  run(ops: readonly TreeOp[]): TreeTranslateResult {
    const parseNotes = new Map<number, string[]>();
    for (const n of this.options.parseNormalized ?? []) {
      if (n.index < 0) continue;
      parseNotes.set(n.index, [...(parseNotes.get(n.index) ?? []), n.message]);
    }
    const work: WorkOp[] = ops.map((o) => ({
      index: o.index,
      op: o.op,
      rawPath: o.path,
      segments: o.segments,
      style: o.pathStyle,
      ...(o.hasValue ? { value: o.value } : {}),
      hasValue: o.hasValue,
      ...(o.fromSegments
        ? { fromRaw: o.from, fromSegments: o.fromSegments, fromStyle: o.fromStyle }
        : {}),
      preNotes: parseNotes.get(o.index) ?? [],
    }));
    this.queue = this.fold(work);
    // 新建人物先落（§4.3）
    const creations = this.queue.filter((w) => this.isCreation(w));
    const rest = this.queue.filter((w) => !creations.includes(w));
    for (const w of [...creations, ...rest]) {
      if (this.consumed.has(w.index)) continue;
      this.process(w);
    }
    return {
      patches: this.patches,
      deltaMinutes: this.deltaMinutes,
      profileChanges: [],
      newCharacters: this.newCharacters,
      records: this.linkedRecords(),
      dropped: this.dropped,
      normalized: this.normalized,
    };
  }

  /** 记录按 op 序号排好，并把折叠关系写成结构化下标（`ops` 数组位置，不是 op 序号）。 */
  private linkedRecords(): StateUpdateOpRecord[] {
    const sorted = [...this.records.entries()].sort((a, b) => a[0] - b[0]);
    const position = new Map(sorted.map(([index], pos) => [index, pos]));
    const out = sorted.map((e) => e[1]);
    for (const [index, link] of this.links) {
      const pos = position.get(index);
      const hostPos = position.get(link.host);
      if (pos === undefined || hostPos === undefined) continue;
      out[pos].foldedInto = hostPos;
      out[pos].foldKind = link.kind;
      const host = out[hostPos];
      host.mergedFrom = [...(host.mergedFrom ?? []), pos].sort((a, b) => a - b);
    }
    return out;
  }

  private isCreation(w: WorkOp): boolean {
    if ((w.op !== 'add' && w.op !== 'replace') || !isPlainObject(w.value)) return false;
    try {
      const t = this.resolve(w.segments, w.style, []);
      return (
        t.root === 'relation' &&
        t.segments.length === 2 &&
        t.person !== undefined &&
        !t.person.exists
      );
    } catch {
      return false;
    }
  }

  /** 同批「删一边、加一边」（背包 ↔ 装备，同人同物）折叠成一条 move（§5.3）。 */
  private fold(work: WorkOp[]): WorkOp[] {
    const info = work.map((w) => {
      if (w.op !== 'remove' && w.op !== 'add') return null;
      try {
        const t = this.resolve(w.segments, w.style, []);
        const e = t.entry;
        if (!t.isEntryRoot || !t.person || !e || (e.record !== '背包' && e.record !== '装备'))
          return null;
        return {
          person: t.person.name,
          item: e.name,
          dict: e.record,
          exists: e.exists,
          loc: e.itemLocation,
          t,
        };
      } catch {
        return null;
      }
    });
    const out = [...work];
    const used = new Set<number>();
    for (let i = 0; i < work.length; i++) {
      const a = info[i];
      if (!a || used.has(i)) continue;
      for (let j = i + 1; j < work.length; j++) {
        const b = info[j];
        if (!b || used.has(j) || b.person !== a.person || b.item !== a.item || b.dict === a.dict)
          continue;
        if (work[i].op === work[j].op) continue;
        const rm = work[i].op === 'remove' ? a : b;
        const add = work[i].op === 'remove' ? work[j] : work[i];
        const removed = work[i].op === 'remove' ? work[i] : work[j];
        // 只折叠「物品确实在被删的那一边」的情形
        const expected = rm.dict === '背包' ? 'bag' : 'equipped';
        if (!rm.exists || rm.loc !== expected) continue;
        used.add(i);
        used.add(j);
        out[i] = {
          index: work[i].index,
          op: 'move',
          rawPath: add.rawPath,
          segments: add.segments,
          style: add.style,
          ...(add.hasValue ? { value: add.value } : {}),
          hasValue: add.hasValue,
          fromRaw: removed.rawPath,
          fromSegments: removed.segments,
          fromStyle: removed.style,
          foldedFrom: work[j].index,
          preNotes: [
            ...work[i].preNotes,
            ...work[j].preNotes,
            `与第 ${work[j].index + 1} 条（删一边、加一边）折叠成 move`,
          ],
        };
        this.consumed.add(work[j].index);
        break;
      }
    }
    return out;
  }

  private process(w: WorkOp): void {
    const ctx: OpContext = {
      op: w,
      notes: [...w.preNotes],
      hasValue: w.hasValue,
      ...(w.hasValue ? { value: jsonClone(w.value) } : {}),
      consumed: [],
    };
    const beforeTree = this.view();
    try {
      this.translate(ctx);
    } catch (e) {
      if (!(e instanceof Drop)) throw e;
      this.record(ctx, beforeTree, beforeTree, e.message);
      if (w.foldedFrom !== undefined)
        this.recordSibling(
          w.foldedFrom,
          ctx,
          beforeTree,
          beforeTree,
          `随第 ${w.index + 1} 条一并丢弃`,
          true,
          'fold',
        );
      return;
    }
    const afterTree = this.view();
    this.record(ctx, beforeTree, afterTree);
    if (w.foldedFrom !== undefined)
      this.recordSibling(
        w.foldedFrom,
        ctx,
        beforeTree,
        afterTree,
        `已与第 ${w.index + 1} 条折叠成 move`,
        false,
        'fold',
      );
    for (const idx of ctx.consumed) {
      this.consumed.add(idx);
      this.recordSibling(
        idx,
        ctx,
        beforeTree,
        afterTree,
        `位置已并入第 ${w.index + 1} 条的穿戴`,
        false,
        'slot',
      );
    }
  }

  private record(
    ctx: OpContext,
    beforeTree: StateView,
    afterTree: StateView,
    dropReason?: string,
  ): void {
    const w = ctx.op;
    const path = ctx.pointer ?? w.rawPath;
    const rec: StateUpdateOpRecord = { path, op: ctx.recordOp ?? w.op, status: '已应用' };
    if (w.op === 'move') rec.from = ctx.fromPointer ?? w.fromRaw;
    if (w.op !== 'remove' && ctx.hasValue) rec.value = jsonClone(ctx.value);
    const segs = ctx.segments;
    const fromSegs = ctx.fromSegments;
    const before =
      w.op === 'move' && fromSegs
        ? beforeTree.read(fromSegs)
        : segs
          ? beforeTree.read(segs)
          : undefined;
    const after = segs ? afterTree.read(segs) : undefined;
    if (before !== undefined) rec.before = jsonClone(before);
    if (
      dropReason === undefined &&
      segs &&
      (w.op === 'delta' || w.op === 'replace' || w.op === 'add')
    ) {
      const entry = depletedEntry(segs, beforeTree, afterTree);
      if (entry !== undefined) rec.entryBefore = jsonClone(entry);
    }
    if (dropReason !== undefined) {
      rec.status = '已丢弃';
      const notes = [...ctx.notes];
      rec.note = [dropReason, ...notes].join('；');
      if (before !== undefined) rec.after = jsonClone(before);
      this.dropped.push(`${w.rawPath || path}：${dropReason}，已忽略`);
    } else {
      if (after !== undefined) rec.after = jsonClone(after);
      if (ctx.notes.length > 0) {
        rec.status = '已纠正';
        rec.note = ctx.notes.join('；');
        for (const n of ctx.notes) this.normalized.push(`${path}：${n}`);
      }
    }
    this.records.set(w.index, rec);
  }

  /** 被折叠或被消费的那条 op 的记录。 */
  private recordSibling(
    index: number,
    host: OpContext,
    beforeTree: StateView,
    afterTree: StateView,
    note: string,
    dropped: boolean,
    kind: 'fold' | 'slot',
  ): void {
    this.links.set(index, { host: host.op.index, kind });
    const w = this.queue.find((q) => q.index === index) ?? null;
    const raw = w?.rawPath ?? '';
    const op: TreeOpKind = w?.op ?? 'replace';
    const segs = host.segments;
    const rec: StateUpdateOpRecord = {
      path: raw,
      op,
      status: dropped ? '已丢弃' : '已纠正',
      note,
    };
    if (w?.hasValue) rec.value = jsonClone(w.value);
    const before = segs ? beforeTree.read(segs) : undefined;
    const after = segs ? (dropped ? beforeTree : afterTree).read(segs) : undefined;
    if (before !== undefined) rec.before = jsonClone(before);
    if (after !== undefined) rec.after = jsonClone(after);
    if (dropped) this.dropped.push(`${raw}：${note}，已忽略`);
    else this.normalized.push(`${raw}：${note}`);
    this.records.set(index, rec);
  }

  // ---------- 分派 ----------

  private translate(ctx: OpContext): void {
    const w = ctx.op;
    const t = this.resolve(w.segments, w.style, ctx.notes);
    ctx.pointer = t.pointer;
    ctx.segments = t.segments;
    let f: ResolvedTreePath | undefined;
    if (w.op === 'move') {
      if (!w.fromSegments) throw new Drop('move 缺少 from');
      f = this.resolve(w.fromSegments, w.fromStyle ?? 'pointer', ctx.notes);
      ctx.fromPointer = f.pointer;
      ctx.fromSegments = f.segments;
      if (f.readonly) throw new Drop(`from：${f.readonlyReason ?? '只读'}`);
      if (f.root !== t.root && !(isPersonRoot(f.root) && isPersonRoot(t.root)))
        throw new Drop('move 不能跨区移动');
    }
    if (t.readonly) throw new Drop(t.readonlyReason ?? '由代码维护');
    switch (t.root) {
      case 'world':
        return this.world(ctx, t);
      case 'fatePoints':
        return this.fatePoints(ctx);
      case 'player':
      case 'relation':
        return this.person(ctx, t, f);
      case 'quests':
        return this.quest(ctx, t, f);
      case 'news':
        return this.news(ctx, t);
      case 'variables':
        return this.variables(ctx, t, f);
    }
  }

  /** 把一个对象写入展开成逐键子 op（分支写成整对象、已有人物整对象写入）。 */
  private expand(ctx: OpContext, t: ResolvedTreePath, note?: string): void {
    const w = ctx.op;
    if (w.op === 'remove') throw new Drop('不能删除整个分支，请删具体条目');
    if (w.op !== 'add' && w.op !== 'replace')
      throw new Drop(`${w.op} 不能用在分支「${t.pattern}」上`);
    if (!isPlainObject(w.value)) throw new Drop('写入分支需要对象');
    if (note) ctx.notes.push(note);
    let ok = 0;
    // 「上限」「额外」先于「当前」展开：当前值按上限钳制，整对象写资源（如
    // `{当前:6000,上限:7000}`）若先写当前，会被旧上限钳掉 —— 结果不能依赖模型写的键序（A7）。
    // 稳定排序：其余键保持原有相对顺序。
    const keys = Object.keys(w.value).sort(
      (a, b) => Number(!CAP_FIRST_KEYS.has(a)) - Number(!CAP_FIRST_KEYS.has(b)),
    );
    for (const key of keys) {
      const sub: OpContext = {
        op: {
          index: w.index,
          op: w.op,
          rawPath: `${t.pointer}/${key}`,
          segments: [...t.segments, key],
          style: 'array',
          value: w.value[key],
          hasValue: true,
          preNotes: [],
        },
        notes: [],
        hasValue: true,
        value: jsonClone(w.value[key]),
        consumed: ctx.consumed,
      };
      try {
        this.translate(sub);
        ok++;
        for (const n of sub.notes) ctx.notes.push(`${key}：${n}`);
      } catch (e) {
        if (!(e instanceof Drop)) throw e;
        ctx.notes.push(`${key}：${e.message}，已忽略`);
      }
    }
    if (keys.length > 0 && ok === 0) throw new Drop('对象里的每个键都写不进去');
  }

  // ---------- 世界 / 命运点数 ----------

  private world(ctx: OpContext, t: ResolvedTreePath): void {
    const w = ctx.op;
    const key = t.segments[1];
    if (key === undefined) return this.expand(ctx, t);
    if (key === '时间') {
      if (w.op !== 'delta' && w.op !== 'replace' && w.op !== 'add')
        throw new Drop('时间只能 delta（分钟）或 replace 成时间串');
      const minutes = take(
        coerceTimeAdvance(
          w.op === 'delta' ? 'delta' : 'replace',
          w.value,
          this.state.profile.gameTime,
        ),
        ctx.notes,
      );
      ctx.value = w.op === 'delta' ? minutes : w.value;
      if (minutes > 0) {
        this.deltaMinutes += minutes;
        // 写时复制：换一份档案，不改旧版对象（已建的视图还要读它）
        this.setState({
          characters: this.state.characters,
          profile: {
            ...this.state.profile,
            gameTime: advanceTime(this.state.profile.gameTime, minutes),
          },
        });
      }
      return;
    }
    if (key === '地点') {
      const player = this.state.characters.find((c) => c.type === 'player');
      if (!player) throw new Drop('存档里没有主角');
      return this.setLocation(ctx, player);
    }
    throw new Drop(`「${key}」不可写`);
  }

  private fatePoints(ctx: OpContext): void {
    const w = ctx.op;
    if (w.op !== 'delta' && w.op !== 'replace' && w.op !== 'add')
      throw new Drop('命运点数只能 replace 或 delta');
    const cur = this.state.profile.fp;
    const amount = take(
      coerceFatePointsDelta(cur, w.op === 'delta' ? 'delta' : 'replace', w.value),
      ctx.notes,
    );
    ctx.value = w.op === 'delta' ? amount : cur + amount;
    if (amount !== 0) this.commit([{ op: 'delta_variable', target: 'profile.fp', amount }]);
  }

  private setLocation(ctx: OpContext, char: CharacterState): void {
    const w = ctx.op;
    if (w.op !== 'replace' && w.op !== 'add') throw new Drop('地点只能 replace');
    const loc = take(coerceText(w.value), ctx.notes);
    if (!loc) throw new Drop('地点不能为空');
    ctx.value = loc;
    if (loc === char.location) return;
    this.commit([{ op: 'set_location', target: charTarget(char.name), value: loc }]);
  }

  // ---------- 人物 ----------

  private person(ctx: OpContext, t: ResolvedTreePath, f: ResolvedTreePath | undefined): void {
    const w = ctx.op;
    const p = t.person!;
    const relSegs = t.segments.slice(p.isPlayer ? 1 : 2);
    if (relSegs.length === 0) return this.personRoot(ctx, t, f);
    if (!p.exists) throw new Drop(`人物「${p.name}」不存在`);
    const char = this.character(p.name);
    const rule = stateTreeTranslationRuleOf(t.pattern);
    if (rule === 'ascension') return this.ascension(ctx, t, f, char);
    const inner = t.entries.find((e) => e.record !== '关系列表');
    if (inner) {
      if (inner.record === '背包' || inner.record === '装备') return this.item(ctx, t, f, char);
      if (inner.record === '技能') return this.skill(ctx, t, f, char);
      if (inner.record === '状态效果') return this.status(ctx, t, f, char);
    }
    if (w.op === 'move') throw new Drop('move 只用于名字字典的条目');
    if (rule === undefined) throw new Drop(`「${t.pattern}」没有翻译规则`);
    if (rule === 'expand') {
      if (t.spec.type === 'record' && w.op === 'replace')
        return this.expand(ctx, t, '按条目逐条写入，未列出的条目保留');
      return this.expand(ctx, t);
    }
    if (w.op === 'add') {
      ctx.notes.push('add 用在叶子上，按 replace 处理');
    }
    const op = w.op === 'add' ? 'replace' : w.op;
    switch (rule) {
      case 'profileText':
      case 'profileList':
        return this.profileField(ctx, t, char, rule, op);
      case 'category':
        return this.category(ctx, char, op);
      case 'level':
        return this.level(ctx, char, op);
      case 'totalExp':
        return this.totalExp(ctx, char, op);
      case 'resourceCurrent':
        return this.resourceCurrent(ctx, char, resourceOf(relSegs[0]), op);
      case 'capTotal':
        if (isPlainObject(w.value)) return this.expand(ctx, t);
        return this.capBonus(ctx, char, resourceOf(relSegs[0]), op, true);
      case 'capBonus':
        return this.capBonus(ctx, char, resourceOf(relSegs[0]), op, false);
      case 'money':
        return this.money(ctx, char, op);
      case 'personText':
        return this.personText(
          ctx,
          char,
          stateTreeKernelOf(PERSON_SPEC, relSegs[0]) as 'currentAction' | 'thoughts',
          op,
        );
      case 'present':
        return this.present(ctx, char, op);
      case 'location':
        if (op !== 'replace') throw new Drop('地点只能 replace');
        return this.setLocation(ctx, char);
      case 'affection':
        return this.affection(ctx, char, op);
      case 'groupQuantity':
        return this.groupQuantity(ctx, char, op);
      default:
        throw new Drop(`「${t.pattern}」不可写`);
    }
  }

  private personRoot(ctx: OpContext, t: ResolvedTreePath, f: ResolvedTreePath | undefined): void {
    const w = ctx.op;
    const p = t.person!;
    if (w.op === 'remove') {
      if (p.isPlayer) throw new Drop('主角不可删除');
      if (!p.exists) throw new Drop(`人物「${p.name}」不存在`);
      const c = this.character(p.name);
      // 双保险：按本批开始时的类别判（本批新建的人物没有起始类别，按现值）
      const startType = this.startTypes.get(c.name) ?? c.type;
      if (this.options.actor === 'ai' && startType !== 'monster' && startType !== 'summon')
        throw new Drop('AI 只能删除怪物或召唤物');
      this.commit([{ op: 'remove_character', target: charTarget(c.name) }]);
      return;
    }
    if (w.op === 'move') {
      if (!f || !f.person || f.segments.length !== 2 || f.root !== 'relation')
        throw new Drop('改名要从 /关系列表/<旧名> move 到 /关系列表/<新名>');
      if (p.isPlayer || t.root !== 'relation') throw new Drop('改名的目标不能是主角');
      if (!f.person.exists) throw new Drop(`人物「${f.person.name}」不存在`);
      if (p.exists) throw new Drop(`新名「${p.name}」已被占用`);
      const newName = p.name.trim();
      if (!newName) throw new Drop('新名不能为空');
      const oldName = this.character(f.person.name).name;
      this.commit([{ op: 'rename_character', target: charTarget(f.person.name), value: newName }]);
      // 起始类别跟着改名走（改名后再删仍按本批开始时的类别判）
      const startType = this.startTypes.get(oldName);
      if (startType !== undefined) {
        this.startTypes.delete(oldName);
        this.startTypes.set(newName, startType);
      }
      ctx.value = newName;
      return;
    }
    if (w.op === 'delta') throw new Drop('人物不能 delta');
    if (!p.exists) return this.createCharacter(ctx, t);
    return this.expand(ctx, t, '人物已存在，按逐字段写入处理');
  }

  private profileField(
    ctx: OpContext,
    t: ResolvedTreePath,
    char: CharacterState,
    rule: 'profileText' | 'profileList',
    op: TreeOpKind,
  ): void {
    const key = t.segments[t.segments.length - (t.leafKey !== undefined ? 2 : 1)];
    const kernel = stateTreeKernelOf(PROFILE_SPEC, key);
    if (kernel === undefined) throw new Drop(`「${key}」不是档案字段`);
    if (rule === 'profileText') {
      if (op !== 'replace') throw new Drop('档案文字只能 replace');
      const text = take(coerceText(ctx.op.value), ctx.notes);
      if (!text) throw new Drop('档案文字不能为空');
      ctx.value = text;
      this.writeProfile(char, kernel as ProfileTextField, text);
      return;
    }
    const field = kernel as ProfileListField;
    let list: string[];
    if (t.leafKey !== undefined) {
      if (op === 'delta') throw new Drop('文本数组不能 delta');
      const item = op === 'remove' ? undefined : take(coerceText(ctx.op.value), ctx.notes);
      list = editKeyed(char[field], op, t.leafKey, item, true) as string[];
    } else {
      if (op !== 'replace') throw new Drop('档案列表只能 replace');
      list = take(coerceTextArray(ctx.op.value), ctx.notes);
    }
    ctx.value = list;
    this.writeProfile(char, field, list);
  }

  /**
   * 档案文字字段 → `update_character` 补丁（八个字段都在白名单里），与改名、其余补丁同一事务落。
   * 设计稿 §5.5 原定转成 profile_changes 旁路，2026-11-25 改走补丁（审查 A8：同批改名后旁路按旧名落空）。
   */
  private writeProfile(
    char: CharacterState,
    field: ProfileTextField | ProfileListField,
    value: string | string[],
  ): void {
    this.commit([
      {
        op: 'update_character',
        target: charTarget(char.name),
        value: { [field]: jsonClone(value) },
      },
    ]);
  }

  private category(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    if (op !== 'replace') throw new Drop('类别只能 replace');
    if (char.type === 'player') throw new Drop('主角没有类别');
    // AI 改已有人物的类别 = 绕过「只能删怪物 / 召唤物」（先改类别再删），对 AI 只读；新建人物整对象里的类别走组装管线
    if (this.options.actor === 'ai') throw new Drop('类别由代码维护，AI 不能改已有人物的类别');
    const text = take(coerceText(ctx.op.value), ctx.notes);
    const type = CHARACTER_CATEGORY_TYPES[text];
    if (type === undefined) throw new Drop(`类别「${text}」认不出（怪物 / 召唤物）`);
    ctx.value = text;
    if (type !== char.type)
      this.commit([{ op: 'update_character', target: charTarget(char.name), value: { type } }]);
  }

  private numberWrite(ctx: OpContext, op: TreeOpKind, current: number, label: string): number {
    if (op !== 'replace' && op !== 'delta') throw new Drop(`${label}只能 replace 或 delta`);
    const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
    return op === 'delta' ? current + n : n;
  }

  private level(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    let next = this.numberWrite(ctx, op, char.level, '等级');
    if (next < 1 || next > 25) {
      const c = Math.max(1, Math.min(25, next));
      ctx.notes.push(`等级 ${next} 越界，已钳到 ${c}`);
      next = c;
    }
    ctx.value = next;
    if (next !== char.level)
      this.commit([
        { op: 'update_character', target: charTarget(char.name), value: { level: next } },
      ]);
  }

  private totalExp(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    let next = this.numberWrite(ctx, op, char.totalExp, '累计经验值');
    if (next < 0) {
      ctx.notes.push(`累计经验值 ${next} 低于 0，已钳到 0`);
      next = 0;
    }
    ctx.value = next;
    if (next === char.totalExp) return;
    this.commit([
      { op: 'update_character', target: charTarget(char.name), value: { totalExp: next } },
    ]);
    // 主角经验由代码接管（保底门槛、登神封顶）：结果与写入值不同时如实记下
    const after = this.character(char.name).totalExp;
    if (after !== next) ctx.notes.push(`累计经验值由代码调整为 ${after}（等级门槛 / 登神封顶）`);
  }

  private resourceCurrent(
    ctx: OpContext,
    char: CharacterState,
    key: ResourceKey,
    op: TreeOpKind,
  ): void {
    // 钳制口径与提交时同一个（角色身上的有效上限字段；上限为 0 的怪物只能写 0）
    const cap = resourceCeiling(char, key);
    const cur = char[key];
    let next: number;
    if (op === 'replace') next = take(coerceResourceCurrent(ctx.op.value, cap), ctx.notes);
    else if (op === 'delta') {
      const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
      next = take(coerceResourceCurrent(cur + n, cap), ctx.notes);
    } else throw new Drop('当前值只能 replace 或 delta');
    ctx.value = op === 'delta' ? next - cur : next;
    if (next === cur) return;
    this.commit([
      op === 'replace'
        ? { op: `set_${key}`, target: charTarget(char.name), value: next }
        : { op: `delta_${key}`, target: charTarget(char.name), amount: next - cur },
    ]);
  }

  private capBonus(
    ctx: OpContext,
    char: CharacterState,
    key: ResourceKey,
    op: TreeOpKind,
    total: boolean,
  ): void {
    const caps = readResourceCaps(char)[key];
    const field = RESOURCE_FIELDS[key].bonus;
    let next: number;
    let usedDelta = false;
    if (op === 'replace') {
      next = take(
        total ? coerceCapTotal(ctx.op.value, caps.base) : coerceCapBonus(ctx.op.value, caps.base),
        ctx.notes,
      );
    } else if (op === 'delta') {
      if (total) ctx.notes.push('上限的 delta 按额外的增量处理');
      const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
      const notesBefore = ctx.notes.length;
      next = take(coerceCapBonus(caps.bonus + n, caps.base), ctx.notes);
      usedDelta = ctx.notes.length === notesBefore;
    } else throw new Drop('上限只能 replace 或 delta');
    ctx.value =
      total && op === 'replace'
        ? effectiveCap(caps.base, next)
        : op === 'delta'
          ? next - caps.bonus
          : next;
    if (next === caps.bonus && typeof char[field] === 'number') return;
    this.commit([
      usedDelta
        ? {
            op: 'update_character',
            target: charTarget(char.name),
            value: { [field]: next - caps.bonus },
            metadata: { delta: true },
          }
        : { op: 'update_character', target: charTarget(char.name), value: { [field]: next } },
    ]);
  }

  private money(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    const cur = typeof char.money === 'number' ? char.money : 0;
    const raw = this.numberWrite(ctx, op, cur, '金钱');
    const notesBefore = ctx.notes.length;
    const next = take(coerceMoneyResult(raw), ctx.notes);
    const clamped = ctx.notes.length !== notesBefore;
    ctx.value = op === 'delta' ? next - cur : next;
    if (next === cur) return;
    this.commit([
      op === 'delta' && !clamped
        ? {
            op: 'update_character',
            target: charTarget(char.name),
            value: { money: next - cur },
            metadata: { delta: true },
          }
        : { op: 'update_character', target: charTarget(char.name), value: { money: next } },
    ]);
  }

  private personText(
    ctx: OpContext,
    char: CharacterState,
    field: 'currentAction' | 'thoughts',
    op: TreeOpKind,
  ): void {
    let text: string;
    if (op === 'remove') text = '';
    else if (op === 'replace') text = take(coerceText(ctx.op.value), ctx.notes);
    else throw new Drop('文本只能 replace');
    ctx.value = text;
    if (text === (char[field] ?? '')) return;
    this.commit([
      { op: 'update_character', target: charTarget(char.name), value: { [field]: text } },
    ]);
  }

  private present(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    if (op !== 'replace') throw new Drop('在场只能 replace');
    const b = take(coerceBoolean(ctx.op.value), ctx.notes);
    ctx.value = b;
    if (b === (char.present === true)) return;
    this.commit([{ op: 'update_character', target: charTarget(char.name), value: { present: b } }]);
  }

  private affection(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    const aff = this.state.profile.affections;
    const cur = hasOwn(aff, char.name) ? aff[char.name] : 0;
    const target = `affections.${char.name}`;
    if (op === 'replace') {
      const v = take(coerceAffection(ctx.op.value), ctx.notes);
      ctx.value = v;
      if (v !== cur || !hasOwn(aff, char.name))
        this.commit([{ op: 'set_affection', target, value: v }]);
      return;
    }
    if (op !== 'delta') throw new Drop('好感度只能 replace 或 delta');
    const n = take(coerceNumber(ctx.op.value, { integer: true }), ctx.notes);
    const next = take(coerceAffection(cur + n), ctx.notes);
    ctx.value = next - cur;
    if (next !== cur) this.commit([{ op: 'delta_affection', target, amount: next - cur }]);
  }

  private groupQuantity(ctx: OpContext, char: CharacterState, op: TreeOpKind): void {
    if (char.type !== 'monster' && char.type !== 'summon')
      throw new Drop('只有怪物 / 召唤物有数量');
    const cur = char.quantity ?? 1;
    const raw = this.numberWrite(ctx, op, cur, '数量');
    const q = take(coerceQuantity(raw), ctx.notes);
    ctx.value = op === 'delta' ? raw - cur : raw;
    if (q.remove) {
      this.commit([{ op: 'remove_character', target: charTarget(char.name) }]);
      return;
    }
    if (q.count !== cur)
      this.commit([
        { op: 'update_character', target: charTarget(char.name), value: { quantity: q.count } },
      ]);
  }

  // ---------- 物品（背包与装备，§5.3） ----------

  /** 穿戴槽位：op 自带 → 同批后续对 `<P>/装备/<物>/位置` 的写入 → 丢「缺少位置」。 */
  private slotFor(
    ctx: OpContext,
    person: string,
    item: string,
    own: SlotValue | undefined,
  ): EquipSlot {
    if (own) {
      if (own.kind === 'unequip') throw new Drop('穿戴的位置不能为空');
      return own.slot;
    }
    const pos = this.queue.findIndex((q) => q.index === ctx.op.index);
    for (const later of this.queue.slice(pos + 1)) {
      if (this.consumed.has(later.index) || ctx.consumed.includes(later.index)) continue;
      if (later.op !== 'replace' && later.op !== 'add') continue;
      let lt: ResolvedTreePath;
      try {
        lt = this.resolve(later.segments, later.style, []);
      } catch {
        continue;
      }
      const e = lt.entry;
      if (!lt.person || lt.person.name !== person || !e || e.record !== '装备' || e.name !== item)
        continue;
      if (lt.subPath.length !== 1 || lt.subPath[0] !== '位置') continue;
      const s = coerceSlot(later.value);
      if (!s.ok || s.value.kind !== 'equip') continue;
      ctx.consumed.push(later.index);
      ctx.notes.push(`位置取自第 ${later.index + 1} 条的写入`);
      return s.value.slot;
    }
    throw new Drop('缺少位置');
  }

  /** 同槽顶替说明（§5.3）。 */
  private displacementNote(
    ctx: OpContext,
    char: CharacterState,
    item: string,
    slot: EquipSlot,
  ): void {
    const other = char.inventory.find((i) => i.name !== item && i.equippedSlot === slot);
    if (other) ctx.notes.push(`「${other.name}」已自动卸回背包`);
  }

  private item(
    ctx: OpContext,
    t: ResolvedTreePath,
    f: ResolvedTreePath | undefined,
    char: CharacterState,
  ): void {
    const w = ctx.op;
    const e = t.entry!;
    const dict = e.record as '背包' | '装备';
    const name = e.name;
    const target = charTarget(char.name);
    const item = findByName(char.inventory, name);
    if (w.op === 'move') {
      if (t.subPath.length > 0 || t.leafKey !== undefined) throw new Drop('move 只用于物品条目');
      return this.itemMove(ctx, t, f!, char);
    }
    if (t.subPath.length === 0 && t.leafKey === undefined) {
      // ---- 整条 ----
      if (w.op === 'remove') {
        if (!item) throw new Drop(`物品「${name}」不存在`);
        if (dict === '背包' && item.equippedSlot) ctx.notes.push('物品在装备中，已一并移除');
        this.commit([{ op: 'remove_item', target, value: { name, quantity: item.quantity } }]);
        return;
      }
      if (w.op === 'delta') throw new Drop('物品条目不能 delta');
      let raw: unknown = w.value;
      if (dict === '装备' && typeof raw === 'string') raw = { [SLOT_KEY]: raw };
      if (!isPlainObject(raw)) throw new Drop('写入物品条目需要对象');
      const picked = take(
        pickKnownKeys(raw, stateTreeChildKeys(dict === '装备' ? EQUIP_ITEM_SPEC : BAG_ITEM_SPEC)),
        ctx.notes,
      );
      if (
        dict === '背包' &&
        hasOwn(raw, SLOT_KEY) &&
        raw[SLOT_KEY] !== null &&
        raw[SLOT_KEY] !== ''
      )
        ctx.notes.push('背包物品不记位置，已忽略；穿戴请 move 到装备并写位置');
      const built = buildItemFields(picked, ctx.notes, true);
      ctx.value = picked;
      const changes = built.fields;
      const hasChanges = Object.keys(changes).length > 0;
      if (dict === '背包') {
        if (!item) {
          this.commit([
            {
              op: 'add_item',
              target,
              value: { name, ...changes, quantity: built.quantity ?? 1, equippedSlot: null },
            },
          ]);
          return;
        }
        if (w.op === 'add') {
          if (hasChanges) ctx.notes.push('同名物品已存在，只叠数量；改字段请写叶子');
          const quantity = built.quantity ?? 1;
          if (item.equippedSlot) {
            // 背包投影里没有这件（它在装备里）：记录改成 `装备/<物>/数量` 的 delta，前后值才对得上，
            // 撤销 / 改值只动叠加的那几件，不会把这行当成新建物品
            ctx.notes.push('同名物品已穿戴，数量叠在装备上');
            const leaf = this.resolve(
              [...t.segments.slice(0, -2), '装备', name, '数量'],
              'array',
              [],
            );
            ctx.pointer = leaf.pointer;
            ctx.segments = leaf.segments;
            ctx.recordOp = 'delta';
            ctx.value = quantity;
          }
          this.commit([{ op: 'add_item', target, value: { name, quantity } }]);
          return;
        }
        // replace 已有物品：改字段 + 调数量；在装备中则卸回背包
        const group: StatePatch[] = [];
        if (item.equippedSlot) {
          ctx.notes.push('物品原在装备，已卸回背包');
          group.push({ op: 'unequip_item', target, value: { name } });
        }
        if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
        if (built.quantity !== undefined)
          group.push(...this.quantityPatches(target, name, item.quantity, built.quantity));
        this.commit(group);
        return;
      }
      // dict === '装备'
      const group: StatePatch[] = [];
      if (!item) {
        if ((built.quantity ?? 1) > 1) throw new Drop('堆叠物品不能穿戴（数量要为 1）');
        const slot = this.slotFor(ctx, char.name, name, built.slot);
        this.displacementNote(ctx, char, name, slot);
        group.push(
          { op: 'add_item', target, value: { name, ...changes, quantity: 1, equippedSlot: null } },
          { op: 'equip_item', target, value: { name, slot } },
        );
      } else if (!item.equippedSlot) {
        if (item.quantity > 1) throw new Drop(`堆叠物品不能穿戴：「${name}」数量 ${item.quantity}`);
        const slot = this.slotFor(ctx, char.name, name, built.slot);
        this.displacementNote(ctx, char, name, slot);
        if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
        group.push({ op: 'equip_item', target, value: { name, slot } });
      } else {
        if (built.quantity !== undefined) ctx.notes.push('装备条目的数量请写 数量 叶子，已忽略');
        if (hasChanges) group.push({ op: 'update_item', target, value: { name, changes } });
        if (built.slot?.kind === 'equip' && built.slot.slot !== item.equippedSlot) {
          this.displacementNote(ctx, char, name, built.slot.slot);
          group.push({ op: 'equip_item', target, value: { name, slot: built.slot.slot } });
        } else if (built.slot?.kind === 'unequip') {
          group.push({ op: 'unequip_item', target, value: { name } });
        }
      }
      this.commit(group);
      return;
    }
    // ---- 叶子 ----
    if (!item) throw new Drop(`物品「${name}」不存在`);
    const fieldRule = childOf(EQUIP_ITEM_SPEC, t.subPath[0] ?? '')?.rule;
    if (fieldRule === 'itemQuantity') {
      if (w.op === 'remove') throw new Drop('数量不能删除，请写 0 或删条目');
      const op = w.op === 'add' ? 'replace' : w.op;
      if (op !== 'replace' && op !== 'delta') throw new Drop('数量只能 replace 或 delta');
      const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
      const want = op === 'delta' ? item.quantity + n : n;
      // delta 恰好减到 0 是正常消耗（用掉最后一件），不是纠正；显式写 ≤0 的 replace、超扣才记纠正
      const q = take(coerceQuantity(want), op === 'delta' && want === 0 ? [] : ctx.notes);
      if (q.count > item.quantity && item.equippedSlot)
        ctx.notes.push('同名物品已穿戴，数量叠在装备上');
      ctx.value = op === 'delta' ? (q.remove ? -item.quantity : q.count - item.quantity) : q.count;
      this.commit(
        this.quantityPatches(
          target,
          name,
          item.quantity,
          q.remove ? 0 : q.count,
          ctx.notes,
          op === 'delta' ? -n : undefined,
        ),
      );
      return;
    }
    if (fieldRule === 'itemSlot') {
      const slot =
        w.op === 'remove'
          ? ({ kind: 'unequip' } as SlotValue)
          : take(coerceSlot(w.value), ctx.notes);
      if (w.op !== 'remove' && w.op !== 'replace' && w.op !== 'add')
        throw new Drop('位置只能 replace');
      ctx.value = slot.kind === 'equip' ? slot.slot : '';
      if (slot.kind === 'unequip') {
        if (!item.equippedSlot) {
          ctx.notes.push('物品本就在背包');
          return;
        }
        this.commit([{ op: 'unequip_item', target, value: { name } }]);
        return;
      }
      if (item.equippedSlot === slot.slot) return;
      if (item.quantity > 1) throw new Drop(`堆叠物品不能穿戴：「${name}」数量 ${item.quantity}`);
      if (!item.equippedSlot) ctx.notes.push('物品原在背包，已按穿戴处理');
      this.displacementNote(ctx, char, name, slot.slot);
      this.commit([{ op: 'equip_item', target, value: { name, slot: slot.slot } }]);
      return;
    }
    const changes = this.itemLeafChanges(ctx, t, item);
    this.commit([{ op: 'update_item', target, value: { name, changes } }]);
  }

  /** 物品叶子写入 → update_item 的 changes。 */
  private itemLeafChanges(
    ctx: OpContext,
    t: ResolvedTreePath,
    item: InventoryItem,
  ): Partial<InventoryItem> {
    const w = ctx.op;
    const field = t.subPath[0] ?? '';
    const node = childOf(EQUIP_ITEM_SPEC, field);
    if (node?.type === 'branch') {
      // 耐久：整份 {当前, 上限} 或其中一个数值叶子
      const sub = t.subPath[1];
      const kernels = node.children.map((c) => c.kernel as keyof InventoryItem);
      if (sub === undefined) {
        if (w.op === 'remove') return Object.fromEntries(kernels.map((k) => [k, undefined]));
        if (!isPlainObject(w.value))
          throw new Drop(`${field}要写成 {${stateTreeChildKeys(node).join(', ')}}`);
        const built = buildItemFields({ [field]: w.value }, ctx.notes, false).fields;
        ctx.value = w.value;
        return built;
      }
      const kernel = stateTreeKernelOf(node, sub) as 'durability' | 'maxDurability';
      if (w.op === 'remove') return { [kernel]: undefined };
      const cur = typeof item[kernel] === 'number' ? item[kernel] : 0;
      const next = this.numberWrite(ctx, w.op === 'add' ? 'replace' : w.op, cur, field);
      ctx.value = w.op === 'delta' ? next - cur : next;
      return { [kernel]: next };
    }
    const kernel = node?.rule === 'itemField' ? (node.kernel as keyof InventoryItem) : undefined;
    if (!kernel) throw new Drop(`「${field}」不可写`);
    if (w.op === 'remove' && t.leafKey === undefined) {
      if (kernel === 'rarity' || kernel === 'type' || kernel === 'description')
        throw new Drop(`${field}不能删除，请用 replace`);
      return { [kernel]: undefined };
    }
    if (w.op === 'delta' && t.leafKey === undefined) throw new Drop(`${field}不能 delta`);
    let raw: unknown = w.value;
    if (t.leafKey !== undefined) {
      if (w.op === 'delta' && kernel !== 'stats') throw new Drop(`${field}不能 delta`);
      raw = editKeyed(
        item[kernel],
        w.op,
        t.leafKey,
        w.op === 'remove' ? undefined : w.value,
        kernel === 'tags',
      );
    }
    const built = buildItemFields({ [field]: raw }, ctx.notes, false).fields;
    ctx.value = t.leafKey !== undefined ? w.value : raw;
    return built;
  }

  /** 数量从 held 调到 want：增 add_item，减 remove_item（超扣钳到持有量，§5.2）。 */
  private quantityPatches(
    target: string,
    name: string,
    held: number,
    want: number,
    notes?: string[],
    requestedDecrease?: number,
  ): StatePatch[] {
    if (want > held) return [{ op: 'add_item', target, value: { name, quantity: want - held } }];
    if (want < held) {
      let dec = held - want;
      if (requestedDecrease !== undefined && notes) {
        const c = clampQuantityDecrease(held, requestedDecrease);
        if (c.ok && c.note) notes.push(c.note);
        if (c.ok) dec = c.value;
      }
      return [{ op: 'remove_item', target, value: { name, quantity: dec } }];
    }
    return [];
  }

  private itemMove(
    ctx: OpContext,
    t: ResolvedTreePath,
    f: ResolvedTreePath,
    dstChar: CharacterState,
  ): void {
    const w = ctx.op;
    const fe = f.entry;
    if (
      !f.person ||
      !fe ||
      (fe.record !== '背包' && fe.record !== '装备') ||
      f.subPath.length > 0 ||
      f.leafKey !== undefined
    )
      throw new Drop('物品只能从 背包 / 装备 条目 move');
    if (!f.person.exists) throw new Drop(`人物「${f.person.name}」不存在`);
    const srcChar = this.character(f.person.name);
    const item = findByName(srcChar.inventory, fe.name);
    if (!item) throw new Drop(`物品「${fe.name}」不存在`);
    const dict = t.entry!.record as '背包' | '装备';
    const dstName = t.entry!.name;
    const srcTarget = charTarget(srcChar.name);
    const dstTarget = charTarget(dstChar.name);
    // value：装备一侧给位置（字符串或含 位置 的对象）；对象的其余字段并入 update_item；背包一侧可给数量
    let slotOwn: SlotValue | undefined;
    let extra: Partial<InventoryItem> = {};
    let qtyOwn: number | undefined;
    if (w.hasValue && w.value !== null && w.value !== undefined) {
      if (typeof w.value === 'string' && dict === '装备')
        slotOwn = take(coerceSlot(w.value), ctx.notes, '位置');
      else if (isPlainObject(w.value)) {
        const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(EQUIP_ITEM_SPEC)), ctx.notes);
        const built = buildItemFields(picked, ctx.notes, true);
        extra = built.fields;
        slotOwn = built.slot;
        qtyOwn = built.quantity;
        if (dict === '背包' && built.slot) ctx.notes.push('卸下时的位置已忽略');
      } else if (typeof w.value === 'number' || typeof w.value === 'string') {
        const q = take(coerceQuantity(w.value), ctx.notes, '数量');
        if (q.remove) throw new Drop('数量 ≤ 0');
        qtyOwn = q.count;
      }
    }
    const hasExtra = Object.keys(extra).length > 0;
    const group: StatePatch[] = [];
    if (srcChar === dstChar) {
      if (dstName === item.name) {
        if (dict === '装备') {
          if (item.quantity > 1)
            throw new Drop(`堆叠物品不能穿戴：「${item.name}」数量 ${item.quantity}`);
          const slot = this.slotFor(ctx, dstChar.name, item.name, slotOwn);
          if (item.equippedSlot === slot && !hasExtra) throw new Drop('物品已穿在这个位置');
          this.displacementNote(ctx, dstChar, item.name, slot);
          if (hasExtra)
            group.push({
              op: 'update_item',
              target: dstTarget,
              value: { name: item.name, changes: extra },
            });
          if (item.equippedSlot !== slot)
            group.push({ op: 'equip_item', target: dstTarget, value: { name: item.name, slot } });
          ctx.value = slot;
        } else {
          if (!item.equippedSlot) throw new Drop('物品本就在背包');
          group.push({ op: 'unequip_item', target: dstTarget, value: { name: item.name } });
          if (hasExtra)
            group.push({
              op: 'update_item',
              target: dstTarget,
              value: { name: item.name, changes: extra },
            });
        }
        this.commit(group);
        return;
      }
      // 同一人物改名：删旧加新，字段与位置照搬
      if (findByName(dstChar.inventory, dstName)) throw new Drop(`物品「${dstName}」已存在`);
      const copy = jsonClone(item);
      delete copy.id;
      const fromDict = fe.record;
      group.push({
        op: 'remove_item',
        target: srcTarget,
        value: { name: item.name, quantity: item.quantity },
      });
      if (dict === fromDict || (dict === '背包' && !item.equippedSlot)) {
        group.push({
          op: 'add_item',
          target: dstTarget,
          value: {
            ...copy,
            ...extra,
            name: dstName,
            equippedSlot: dict === '背包' ? null : copy.equippedSlot,
          },
        });
      } else if (dict === '背包') {
        group.push({
          op: 'add_item',
          target: dstTarget,
          value: { ...copy, ...extra, name: dstName, equippedSlot: null },
        });
      } else {
        if (item.quantity > 1)
          throw new Drop(`堆叠物品不能穿戴：「${item.name}」数量 ${item.quantity}`);
        const slot = this.slotFor(ctx, dstChar.name, item.name, slotOwn);
        this.displacementNote(ctx, dstChar, item.name, slot);
        group.push(
          {
            op: 'add_item',
            target: dstTarget,
            value: { ...copy, ...extra, name: dstName, equippedSlot: null },
          },
          { op: 'equip_item', target: dstTarget, value: { name: dstName, slot } },
        );
      }
      this.commit(group);
      return;
    }
    // 跨人物：转移
    if (dstName !== item.name) throw new Drop('转移时不能改名');
    let qty = qtyOwn ?? item.quantity;
    if (qty > item.quantity) {
      const c = clampQuantityDecrease(item.quantity, qty);
      if (c.ok && c.note) ctx.notes.push(c.note);
      qty = item.quantity;
    }
    if (item.equippedSlot && qty >= item.quantity) ctx.notes.push('转出的物品已从装备卸下');
    group.push({
      op: 'transfer_item',
      target: srcTarget,
      value: { name: item.name, to: dstChar.name, quantity: qty },
    });
    if (dict === '装备') {
      const held = findByName(dstChar.inventory, item.name)?.quantity ?? 0;
      if (held + qty > 1) throw new Drop('接收方得到的是堆叠物品，不能直接穿戴');
      const slot = this.slotFor(ctx, dstChar.name, item.name, slotOwn);
      this.displacementNote(ctx, dstChar, item.name, slot);
      group.push({ op: 'equip_item', target: dstTarget, value: { name: item.name, slot } });
    }
    if (hasExtra)
      group.push({
        op: 'update_item',
        target: dstTarget,
        value: { name: item.name, changes: extra },
      });
    ctx.value = qty;
    this.commit(group);
  }

  // ---------- 技能 ----------

  private skill(
    ctx: OpContext,
    t: ResolvedTreePath,
    f: ResolvedTreePath | undefined,
    char: CharacterState,
  ): void {
    const w = ctx.op;
    const name = t.entry!.name;
    const target = charTarget(char.name);
    const skill = findByName(char.skills, name);
    if (t.subPath.length === 0 && t.leafKey === undefined) {
      if (w.op === 'remove') {
        if (!skill) throw new Drop(`技能「${name}」不存在`);
        this.commit([{ op: 'remove_skill', target, value: { name } }]);
        return;
      }
      if (w.op === 'move') {
        const fe = f?.entry;
        if (!f?.person || !fe || fe.record !== '技能' || f.subPath.length > 0)
          throw new Drop('技能只能从技能条目 move');
        if (f.person.name !== char.name) throw new Drop('技能不能在人物之间转移');
        const old = findByName(char.skills, fe.name);
        if (!old) throw new Drop(`技能「${fe.name}」不存在`);
        if (skill) throw new Drop(`技能「${name}」已存在`);
        const copy = jsonClone(old);
        delete copy.id;
        this.commit([
          { op: 'remove_skill', target, value: { name: old.name } },
          { op: 'add_skill', target, value: { ...copy, name } },
        ]);
        return;
      }
      if (w.op === 'delta') throw new Drop('技能条目不能 delta');
      if (!isPlainObject(w.value)) throw new Drop('写入技能条目需要对象');
      const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(SKILL_SPEC)), ctx.notes);
      const built = buildSkillFields(picked, ctx.notes, true);
      ctx.value = picked;
      if (!skill || w.op === 'add') {
        this.commit([{ op: 'add_skill', target, value: { name, ...built.fields } }]);
        return;
      }
      const changes: Partial<Skill> = { ...built.fields };
      if (built.clearCost) Object.assign(changes, { cost: undefined, costText: '' });
      this.commit([{ op: 'update_skill', target, value: { name, changes } }]);
      return;
    }
    if (!skill) throw new Drop(`技能「${name}」不存在`);
    if (w.op === 'move') throw new Drop('move 只用于技能条目');
    const field = t.subPath[0] ?? '';
    const node = childOf(SKILL_SPEC, field);
    const kernel = node?.rule === 'skillField' ? (node.kernel as keyof Skill) : undefined;
    if (!kernel) throw new Drop(`「${field}」不可写`);
    let changes: Partial<Skill>;
    if (w.op === 'remove' && t.leafKey === undefined) {
      if (kernel === 'type' || kernel === 'description')
        throw new Drop(`${field}不能删除，请用 replace`);
      changes =
        kernel === 'cost'
          ? ({ cost: undefined, costText: '' } as Partial<Skill>)
          : { [kernel]: undefined };
    } else if (t.leafKey !== undefined) {
      if (w.op === 'delta') throw new Drop(`${field}不能 delta`);
      const raw = editKeyed(
        skill[kernel],
        w.op,
        t.leafKey,
        w.op === 'remove' ? undefined : w.value,
        kernel === 'tags',
      );
      changes = buildSkillFields({ [field]: raw }, ctx.notes, false).fields;
    } else if (w.op === 'delta') {
      if (kernel !== 'cooldown' && kernel !== 'skillPower') throw new Drop(`${field}不能 delta`);
      const cur = typeof skill[kernel] === 'number' ? (skill[kernel] as number) : 0;
      const n = take(coerceNumber(w.value, { integer: kernel === 'cooldown' }), ctx.notes);
      changes = { [kernel]: cur + n };
      ctx.value = n;
    } else {
      const built = buildSkillFields({ [field]: w.value }, ctx.notes, false);
      changes = { ...built.fields };
      if (built.clearCost) Object.assign(changes, { cost: undefined, costText: '' });
    }
    this.commit([{ op: 'update_skill', target, value: { name, changes } }]);
  }

  // ---------- 状态效果 ----------

  private status(
    ctx: OpContext,
    t: ResolvedTreePath,
    f: ResolvedTreePath | undefined,
    char: CharacterState,
  ): void {
    const w = ctx.op;
    const name = t.entry!.name;
    const target = charTarget(char.name);
    const effect = findByName(char.statusEffects, name);
    if (t.subPath.length === 0 && t.leafKey === undefined) {
      if (w.op === 'remove') {
        if (!effect) throw new Drop(`状态「${name}」不存在`);
        this.commit([{ op: 'remove_status_effect', target, value: { name } }]);
        return;
      }
      if (w.op === 'move') {
        const fe = f?.entry;
        if (!f?.person || !fe || fe.record !== '状态效果' || f.subPath.length > 0)
          throw new Drop('状态只能从状态条目 move');
        if (f.person.name !== char.name) throw new Drop('状态不能在人物之间转移');
        const old = findByName(char.statusEffects, fe.name);
        if (!old) throw new Drop(`状态「${fe.name}」不存在`);
        if (effect) throw new Drop(`状态「${name}」已存在`);
        this.commit([
          { op: 'remove_status_effect', target, value: { name: old.name } },
          { op: 'add_status_effect', target, value: { ...statusPayload(old), name } },
        ]);
        return;
      }
      if (w.op === 'delta') throw new Drop('状态条目不能 delta');
      if (!isPlainObject(w.value)) throw new Drop('写入状态条目需要对象');
      const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(STATUS_SPEC)), ctx.notes);
      const built = buildStatusFields(picked, ctx.notes, effect?.maxStacks);
      if (built.removeByStacks) throw new Drop('层数 ≤ 0，不施加');
      if (picked[keyOf(STATUS_SPEC, 'category')] === undefined && !effect) {
        built.fields.category = '特殊';
        ctx.notes.push('缺少类型，兜底「特殊」');
      }
      ctx.value = picked;
      const payload = { name, ...built.fields };
      if (!effect || w.op === 'add') {
        this.commit([{ op: 'add_status_effect', target, value: payload }]);
        return;
      }
      // replace 已有状态：整份覆盖（删旧加新）
      this.commit([
        { op: 'remove_status_effect', target, value: { name } },
        { op: 'add_status_effect', target, value: payload },
      ]);
      return;
    }
    if (!effect) throw new Drop(`状态「${name}」不存在`);
    if (w.op === 'move') throw new Drop('move 只用于状态条目');
    const field = t.subPath[0] ?? '';
    const node = childOf(STATUS_SPEC, field);
    if (node?.rule === 'statusStacks') {
      const op = w.op === 'add' ? 'replace' : w.op;
      if (op !== 'replace' && op !== 'delta') throw new Drop('层数只能 replace 或 delta');
      const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
      const wantStacks = op === 'delta' ? effect.stacks + n : n;
      // delta 恰好减到 0 是正常消耗（层数用完），不是纠正；显式写 ≤0 的 replace、减过头才记纠正
      const s = take(
        coerceStacks(wantStacks, effect.maxStacks),
        op === 'delta' && wantStacks === 0 ? [] : ctx.notes,
      );
      ctx.value = op === 'delta' ? n : s.remove ? 0 : s.count;
      if (s.remove) {
        this.commit([{ op: 'remove_status_effect', target, value: { name } }]);
        return;
      }
      if (s.count !== effect.stacks)
        this.commit([{ op: 'update_status_effect', target, value: { name, stacks: s.count } }]);
      return;
    }
    if (node?.rule === 'statusDuration') {
      if (w.op === 'remove') throw new Drop('剩余时间不能删除，请写「永久」');
      if (w.op === 'delta') {
        if (effect.durationText || effect.remainingTime === null)
          throw new Drop('文本或永久时长不能 delta');
        const n = take(coerceNumber(w.value), ctx.notes);
        const next = Math.max(0, effect.remainingTime + n);
        ctx.value = n;
        this.commit([{ op: 'update_status_effect', target, value: { name, remainingTime: next } }]);
        return;
      }
      const d = take(parseDuration(w.value), ctx.notes);
      ctx.value = w.value;
      if (d.kind === 'text') {
        this.commit([
          { op: 'update_status_effect', target, value: { name, durationText: d.durationText } },
        ]);
      } else if (d.kind === 'permanent') {
        this.commit([{ op: 'update_status_effect', target, value: { name, remainingTime: null } }]);
      } else if (d.timeUnit === effect.timeUnit) {
        this.commit([
          { op: 'update_status_effect', target, value: { name, remainingTime: d.remainingTime } },
        ]);
      } else {
        // 单位变了：update_status_effect 改不了单位，删旧加新
        const p = statusPayload(effect);
        delete p.durationText;
        this.commit([
          { op: 'remove_status_effect', target, value: { name } },
          {
            op: 'add_status_effect',
            target,
            value: { ...p, remainingTime: d.remainingTime, timeUnit: d.timeUnit },
          },
        ]);
      }
      return;
    }
    // 其余叶子：内核没有改描述的 op，读出现值后删旧加新（§5.3）
    const kernel = node?.rule === 'statusField' ? (node.kernel as keyof StatusEffect) : undefined;
    if (!kernel) throw new Drop(`「${field}」不可写`);
    const payload = statusPayload(effect);
    if (w.op === 'remove' && t.leafKey === undefined) {
      if (kernel !== 'effectDescriptions' && kernel !== 'maxStacks')
        throw new Drop(`${field}不能删除，请用 replace`);
      delete (payload as Row)[kernel];
    } else if (w.op === 'delta' && t.leafKey === undefined) {
      if (kernel !== 'maxStacks') throw new Drop(`${field}不能 delta`);
      const n = take(coerceNumber(w.value, { integer: true }), ctx.notes);
      const built = buildStatusFields(
        { [field]: (effect.maxStacks ?? 0) + n },
        ctx.notes,
        undefined,
      );
      Object.assign(payload, built.fields);
      ctx.value = n;
    } else {
      if (w.op === 'delta') throw new Drop(`${field}不能 delta`);
      let raw: unknown = w.value;
      if (t.leafKey !== undefined)
        raw = editKeyed(
          effect.effectDescriptions,
          w.op,
          t.leafKey,
          w.op === 'remove' ? undefined : w.value,
          false,
        );
      const built = buildStatusFields({ [field]: raw }, ctx.notes, undefined);
      Object.assign(payload, built.fields);
    }
    if (payload.maxStacks && payload.stacks && payload.stacks > payload.maxStacks) {
      ctx.notes.push(`层数已按新上限封顶为 ${payload.maxStacks}`);
      payload.stacks = payload.maxStacks;
    }
    this.commit([
      { op: 'remove_status_effect', target, value: { name } },
      { op: 'add_status_effect', target, value: payload },
    ]);
  }

  // ---------- 登神长阶 ----------

  private ascension(
    ctx: OpContext,
    t: ResolvedTreePath,
    f: ResolvedTreePath | undefined,
    char: CharacterState,
  ): void {
    const w = ctx.op;
    const at = t.segments.indexOf(ASCENSION_SPEC.key);
    const rel = t.segments.slice(at + 1);
    const base = t.segments.slice(0, at + 1);
    const current = (jsonClone(this.view().read(base)) ?? {}) as Row;
    const original = jsonClone(current);
    const tree: Row = { ...emptyTree(ASCENSION_SPEC), ...current };
    let fromValue: unknown;
    if (w.op === 'move') {
      const fa = f?.segments.indexOf(ASCENSION_SPEC.key) ?? -1;
      if (!f || fa < 0 || f.person?.name !== char.name)
        throw new Drop('登神长阶只能在同一人物内 move');
      const fromRel = f.segments.slice(fa + 1);
      fromValue = readStateTreeValue(tree as StateTreeValue, fromRel);
      if (fromValue === undefined) throw new Drop('from 不存在');
      setPlain(tree, fromRel, undefined, true);
    }
    if (rel.length === 0) {
      if (w.op === 'remove') throw new Drop('登神长阶不能整份删除');
      if (w.op !== 'replace' && w.op !== 'add') throw new Drop('登神长阶整份只能 replace');
      if (!isPlainObject(w.value)) throw new Drop('写入登神长阶需要对象');
      Object.assign(tree, w.value);
    } else if (w.op === 'remove') {
      if (readStateTreeValue(tree as StateTreeValue, rel) === undefined)
        throw new Drop('要删除的条目不存在');
      setPlain(tree, rel, undefined, true);
    } else if (w.op === 'delta') {
      throw new Drop('登神长阶没有数值叶子');
    } else {
      setPlain(tree, rel, w.op === 'move' ? fromValue : jsonClone(w.value), false);
    }
    const asc = treeToAscension(tree, original, char.ascension, ctx.notes);
    this.commit([
      { op: 'update_character', target: charTarget(char.name), value: { ascension: asc } },
    ]);
  }

  // ---------- 新建人物（§4.4） ----------

  private createCharacter(ctx: OpContext, t: ResolvedTreePath): void {
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
        ...this.entryList(v['背包'], '背包', notes, (n, raw) => this.newItem(n, raw, false, notes)),
        ...this.entryList(v['装备'], '装备', notes, (n, raw) => this.newItem(n, raw, true, notes)),
      ];
      const slots = new Set<string>();
      for (const it of character.inventory) {
        if (!it.equippedSlot) continue;
        if (slots.has(it.equippedSlot)) {
          notes.push(`装备「${it.name}」与同槽物品冲突，已放回背包`);
          it.equippedSlot = null;
        } else slots.add(it.equippedSlot);
      }
      character.skills = this.entryList(v['技能'], '技能', notes, (n, raw) => {
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
      character.statusEffects = this.entryList(v['状态效果'], '状态效果', notes, (n, raw) => {
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
        narrativeCharacter: this.options.characterUpdates?.find((u) => u.name === name),
        characterDefinition: this.options.definitions?.find(
          (d) => d.name === name || d.profile.aliases?.includes(name),
        ),
        introducedBy: this.options.sourceTurnKey,
      });
    } catch (e) {
      if (e instanceof Drop) throw e;
      throw new Drop(`人物组装失败（${errorText(e)}）`);
    }
    if (this.state.characters.some((c) => c.name === character.name))
      throw new Drop(`人物「${character.name}」已存在`);
    const group: StatePatch[] = [
      { op: 'add_character', target: charTarget(character.name), value: character },
    ];
    const affKey = pk('affections');
    if (v[affKey] !== undefined) {
      const aff = take(coerceAffection(v[affKey]), notes, affKey);
      group.push({ op: 'set_affection', target: `affections.${character.name}`, value: aff });
    }
    this.commit(group);
    this.newCharacters.push(character);
    if (character.name !== name) {
      ctx.notes.push(`按作者定义绑定为「${character.name}」`);
      ctx.pointer = `/关系列表/${character.name}`;
      ctx.segments = ['关系列表', character.name];
    }
  }

  /** 新人物的随身字典 → 条目数组；坏条目只丢那一条（§4.4）。 */
  private entryList<T>(
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

  private newItem(name: string, raw: unknown, equipped: boolean, notes: string[]): InventoryItem {
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

  // ---------- 任务 ----------

  private quest(ctx: OpContext, t: ResolvedTreePath, f: ResolvedTreePath | undefined): void {
    const w = ctx.op;
    if (!t.entry) return this.expand(ctx, t);
    const name = t.entry.name;
    const quests = this.state.profile.quests;
    const exists = hasOwn(quests, name);
    if (t.subPath.length === 0) {
      if (w.op === 'remove') {
        if (!exists) throw new Drop(`任务「${name}」不存在`);
        this.commit([{ op: 'remove_quest', target: 'quests', value: { name } }]);
        return;
      }
      if (w.op === 'move') {
        if (!f?.entry || f.root !== 'quests' || f.subPath.length > 0)
          throw new Drop('任务只能从任务条目 move');
        const old = quests[f.entry.name];
        if (!old) throw new Drop(`任务「${f.entry.name}」不存在`);
        if (exists) throw new Drop(`任务「${name}」已存在`);
        this.commit([
          { op: 'remove_quest', target: 'quests', value: { name: f.entry.name } },
          { op: 'update_quest', target: 'quests', value: { ...jsonClone(old), name } },
        ]);
        return;
      }
      if (w.op === 'delta') throw new Drop('任务不能 delta');
      if (!isPlainObject(w.value)) throw new Drop('写入任务需要对象');
      const picked = take(pickKnownKeys(w.value, stateTreeChildKeys(QUEST_SPEC)), ctx.notes);
      const fields: Partial<Quest> = {};
      for (const [k, v] of Object.entries(picked))
        Object.assign(fields, this.questField(k, v, ctx.notes));
      ctx.value = picked;
      const value = w.op === 'replace' ? { ...createDefaultQuest(), ...fields } : fields;
      if (!exists && fields.status === undefined) {
        value.status = '进行中';
        ctx.notes.push('缺少状态，兜底「进行中」');
      }
      this.commit([{ op: 'update_quest', target: 'quests', value: { name, ...value } }]);
      return;
    }
    if (w.op === 'remove') throw new Drop('任务字段不能删除，请用 replace');
    if (w.op === 'delta' || w.op === 'move') throw new Drop(`任务字段不能 ${w.op}`);
    const key = t.subPath[0];
    if (!exists) ctx.notes.push(`任务「${name}」不存在，已新建`);
    const fields = this.questField(key, w.value, ctx.notes);
    ctx.value = Object.values(fields)[0];
    this.commit([{ op: 'update_quest', target: 'quests', value: { name, ...fields } }]);
  }

  private questField(key: string, raw: unknown, notes: string[]): Partial<Quest> {
    const field = stateTreeKernelOf(QUEST_SPEC, key) as keyof Quest | undefined;
    if (!field) throw new Drop(`「${key}」不是任务字段`);
    if (field === 'status') return { status: take(coerceQuestStatus(raw), notes, key) };
    if (field === 'priority') return { priority: take(coerceQuestPriority(raw), notes, key) };
    return { [field]: take(coerceText(raw), notes, key) };
  }

  // ---------- 新闻（只增不删） ----------

  private news(ctx: OpContext, t: ResolvedTreePath): void {
    const w = ctx.op;
    if (w.op === 'remove') throw new Drop('新闻只增不删');
    if (w.op === 'move' || w.op === 'delta') throw new Drop(`新闻不能 ${w.op}`);
    if (t.segments.length < 3) return this.expand(ctx, t);
    const column = t.segments[1];
    const title = t.segments[2];
    const content = take(coerceText(w.value), ctx.notes);
    if (!content) throw new Drop('新闻正文不能为空');
    const known = (this.state.profile.news ?? []).some((n) => n.category === column);
    const category = column === UNCATEGORIZED_NEWS_COLUMN && !known ? '' : column;
    if (t.entry?.exists) ctx.notes.push('新闻只增不删，已追加一条同标题新闻');
    ctx.value = content;
    this.commit([{ op: 'add_news', target: 'news', value: { title, content, category } }]);
  }

  // ---------- 变量（ADR-30 vars 空间） ----------

  private variables(ctx: OpContext, t: ResolvedTreePath, f: ResolvedTreePath | undefined): void {
    const w = ctx.op;
    const vp = t.variablePath ?? [];
    if (vp.length === 0) throw new Drop('请写到具体变量（/变量/<命名空间>/…）');
    if (!NAMESPACES.has(vp[0]))
      throw new Drop(`变量顶层只认命名空间（${[...NAMESPACES].join(' / ')}）`);
    // 命名空间根不可整块写或删（AI 与玩家同样）：至少写到 /变量/<命名空间>/<键>
    if (vp.length < 2) throw new Drop(NAMESPACE_ROOT_REASON);
    const path = vp.join('.');
    const target = `variables.${path}`;
    const vars = this.state.profile.variables;
    switch (w.op) {
      case 'replace':
        this.commit([{ op: 'set_variable', target, value: jsonClone(w.value) }]);
        return;
      case 'add': {
        const last = vp[vp.length - 1];
        const parent = vp.slice(0, -1).join('.');
        const parentValue = vp.length > 1 ? getVar(vars, parent) : undefined;
        if (Array.isArray(parentValue) && (last === '-' || /^\d+$/.test(last))) {
          this.commit([
            {
              op: 'insert_variable',
              target: `variables.${parent}`,
              value: jsonClone(w.value),
              ...(last === '-' ? {} : { metadata: { index: Number(last) } }),
            },
          ]);
          // 记录读父数组（前后值 = 插入前后的整个数组）：撤销按前值整份写回，下标插入也一样
          ctx.pointer = t.pointer;
          ctx.segments = ['变量', ...vp.slice(0, -1)];
          return;
        }
        this.commit([{ op: 'set_variable', target, value: jsonClone(w.value) }]);
        return;
      }
      case 'remove':
        if (getVar(vars, path) === undefined) throw new Drop('变量不存在');
        this.commit([{ op: 'remove_variable', target }]);
        return;
      case 'delta': {
        const cur = getVar(vars, path);
        if (cur !== undefined && typeof cur !== 'number') throw new Drop('变量现值不是数值');
        const n = take(coerceNumber(w.value), ctx.notes);
        ctx.value = n;
        this.commit([{ op: 'delta_variable', target, amount: n }]);
        return;
      }
      case 'move': {
        const fp = f?.variablePath;
        if (f?.root !== 'variables' || !fp || fp.length === 0)
          throw new Drop('变量只能在 /变量 内 move');
        if (!NAMESPACES.has(fp[0]))
          throw new Drop(`变量顶层只认命名空间（${[...NAMESPACES].join(' / ')}）`);
        if (fp.length < 2) throw new Drop(`from：${NAMESPACE_ROOT_REASON}`);
        if (getVar(vars, fp.join('.')) === undefined) throw new Drop('from 变量不存在');
        this.commit([
          { op: 'move_variable', target: `variables.${fp.join('.')}`, metadata: { toPath: path } },
        ]);
        return;
      }
    }
  }
}

/**
 * 本条把条目减没了（`数量` / `层数` 叶子写入前条目在、写入后不在）时返回条目整对象前值（§12.3），否则 undefined。
 * 供撤销整对象重建、改值先重建再设置。
 */
function depletedEntry(
  segs: readonly string[],
  beforeTree: StateView,
  afterTree: StateView,
): unknown {
  const n = segs.length;
  // 可减没的字典与叶子取自词表（`STATE_TREE_DEPLETABLE_LEAF`：背包 / 装备 → 数量，状态效果 → 层数）
  if (n < 4 || STATE_TREE_DEPLETABLE_LEAF[segs[n - 3]] !== segs[n - 1]) return undefined;
  const entrySegs = segs.slice(0, -1);
  const before = beforeTree.read(entrySegs);
  if (before === undefined) return undefined;
  return afterTree.read(entrySegs) === undefined ? before : undefined;
}

function isPersonRoot(root: ResolvedTreePath['root']): boolean {
  return root === 'player' || root === 'relation';
}

/** 在普通对象上按段写值（`remove` 时删键）；中间缺的层补空对象。 */
function setPlain(obj: Row, segs: readonly string[], value: unknown, remove: boolean): void {
  let cur: Row = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (!isPlainObject(cur[s])) {
      if (remove) return;
      cur[s] = {};
    }
    cur = cur[s] as Row;
  }
  const last = segs[segs.length - 1];
  if (remove) delete cur[last];
  else
    Object.defineProperty(cur, last, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

type AscensionEntryKind = 'elements' | 'authority' | 'law';

/**
 * 登神长阶的树形 → 内核形状（「工作状态现值 + 本条」重建整份，§5.3）。
 * 没被这次写入改动的条目原样保留内核数据（含旧的 `effects` 字符串数组）。
 */
function treeToAscension(
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

// ========== 入口 ==========

/**
 * 状态树 op 列表 → StatePatch 等（§5）。
 *
 * @param ops `parseTreePatchBlock` 产出的 op（或修改器 / 补差规划出的 op）
 * @param snapshot 当前内核状态（角色 + 档案），不会被修改
 * @param options `actor` 区分 AI 与玩家（玩家可删任意 NPC，§11.3）
 */
export function translateTreeOps(
  ops: readonly TreeOp[],
  snapshot: TreeTranslateSnapshot,
  options: TreeTranslateOptions,
): TreeTranslateResult {
  return new TreeTranslator(snapshot, options).run(ops);
}
