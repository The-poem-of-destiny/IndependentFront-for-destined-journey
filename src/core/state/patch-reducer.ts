/**
 * patch-reducer.ts — 角色类补丁的纯变换（审查报告 R5b，唯一实现）
 *
 * 角色域补丁（update_character、三种资源、状态效果、物品与穿戴、技能、地点、经验 / 升级、
 * 新建人物的内容整理）怎样改一个角色，只在这里写一次：
 * - `StateManager` 的对应 handler 是「读角色 → 本模块 → 落库」；
 * - 状态树翻译层（`variables/state-tree-translator.ts`）的影子状态调同一份，
 *   所以翻译层记下的后值就是提交后真实落库的值。
 *
 * 契约：
 * - 不碰 DB / 时钟 / 随机 / 日志；需要的上下文（游戏时间等）由调用方传入。
 * - 在传入的角色对象上**就地**变换 —— 调用方传的是自己的工作副本（StateManager 是提交作用域
 *   缓存里那份，翻译层是影子深拷贝）。补丁里的值会被并进角色，调用方若还要用补丁对象，
 *   自己先拷贝。
 * - 非法补丁在动角色之前抛错（文案对齐提交时的报错）；抛错时角色不被改动。
 * - 返回纠正说明（`notes`）：值被钳、找不到目标被忽略、登神封顶等。调用方决定记日志还是忽略。
 *
 * 档案域（审查报告 R5c）：变量、任务、好感、命运点、新闻、人物增删与改名（含同名查重、
 * 好感按名搬迁）同样只在这里写一次（见文末「档案域」一节）。`StateManager` 的对应 handler
 * 「读 profile / 角色表 → 本模块 → 落库」；时间账本、地图钩子、saveId 注入、FP 账目的 id 与时间戳、
 * 新闻的 id 与发布时间等 I/O 与副作用留在调用方（经入参传进来）。
 * 翻译层的工作状态与建补丁预演（`state/patch-rehearsal.ts`）都经 `reduceStatePatch` 推进。
 */

import { getTierConfig } from '../character/tier-constants';
import { ensureCharacterAge } from '../character/character-age';
import {
  applyExpFloor,
  getTierForLevel,
  MILESTONE_LEVELS,
  resolveAscensionFlyup,
  resolveLevelUps,
  tierNameForTier,
  xpToNextNumber,
} from '../character/exp-table';
// 资源上限拆分（状态树协议 §5.6）：基础 + 额外的不变式唯一出处在 resource-caps，本模块只接触发点
import {
  RESOURCE_FIELDS,
  RESOURCE_KEYS,
  baseResourceCaps,
  recomputeResourceCaps,
  solidifyResourceBonuses,
  type ResourceKey,
} from '../character/resource-caps';
import {
  normalizeItemType,
  normalizeRarity,
  normalizeSlot,
  normalizeStatusCategory,
} from '../content/field-enums';
import { clampAffection } from '../character/affection-system';
import { normalizeQuestStatus } from '../content/field-enums';
import {
  createDefaultQuest,
  type CharacterState,
  type FPTransaction,
  type InventoryItem,
  type NewsItem,
  type Quest,
  type SaveProfile,
  type Skill,
  type StatePatch,
  type StatePatchOp,
  type StatusEffect,
} from '../types/types';
import type { GameTime } from '../time/time-system';
import { delVar, getVar, insertVar, setVar } from '../variables/var-resolver';
import { resolveCharacterByName } from './patch-rules';

// ========== 对外类型 ==========

/** 一条纠正说明：`fix` 是值被纠正（调用方通常不记日志），`info` / `warn` 对应原先的日志级别。 */
interface ReduceNote {
  level: 'fix' | 'info' | 'warn';
  text: string;
}

/** 一次变换的结果（角色已就地改好）。 */
export interface ReduceResult {
  notes: ReduceNote[];
}

/** 本模块负责的单角色补丁（transfer_item 涉及两人，走 `reduceTransferItem`）。 */
type CharacterPatchOp = Extract<
  StatePatchOp,
  | 'update_character'
  | 'set_location'
  | 'set_hp'
  | 'set_mp'
  | 'set_sp'
  | 'delta_hp'
  | 'delta_mp'
  | 'delta_sp'
  | 'add_status_effect'
  | 'update_status_effect'
  | 'remove_status_effect'
  | 'add_item'
  | 'remove_item'
  | 'update_item'
  | 'equip_item'
  | 'unequip_item'
  | 'add_skill'
  | 'update_skill'
  | 'remove_skill'
>;

/** 集合内按名字查找 — M2 铁律1（逻辑键=名字）：inventory / skills / statusEffects 按名寻址。 */
export function findByName<T extends { name: string }>(
  list: readonly T[],
  name: string,
): T | undefined {
  return list.find((item) => item.name === name);
}

// ========== update_character 白名单 (M2 T9, #19 #20 #21) ==========

/**
 * update_character value 白名单 — 从 CharacterState (types.ts) 逐字段推导:
 * 全部字段 MINUS 禁止项（数组实体 / name / 账务字段）。
 * 白名单外的未知键一律 loud 拒绝（大概率 AI 拼写错误）。
 */
const UPDATE_CHAR_WHITELIST = new Set<string>([
  // 基础信息（name 除外 — 改名走 rename_character）
  'type',
  'race',
  'identity',
  'occupation',
  // 生命层级
  'tier',
  'tierName',
  'level',
  'totalExp',
  'expToNext',
  // 五维属性
  'attributes',
  'freeAttrPoints',
  // 资源
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  // 资源上限的「额外」部分（§5.6）：有效上限 = 基础 + 额外，由代码重算后写回 max*
  'maxHpBonus',
  'maxMpBonus',
  'maxSpBonus',
  // 登神长阶
  'ascension',
  // 经济 / 位置 / 冒险者等级 / 当前行为
  'money',
  'location',
  'present',
  'adventurerRank',
  'currentAction',
  // 血脉 / 集群数量 / 叙事字段
  'bloodlineIds',
  'quantity',
  'appearance',
  'background',
  'personality',
  'gender',
  'outfit',
  'thoughts',
  // 🔴 `customFields` **刻意不在白名单**（2026-09-26）：它是建号快照 / 真扩展数据袋
  //    （age / destinyCoreId / destinyPoints / extra）。此前 AI 会写 `customFields.destinyPoints`
  //    （点路径被拒）或整对象 `customFields`（Object.assign 会连带盖掉其余键）。
  //    命运点数(FP) 的真源是 SaveProfile.fp，走 `fp.delta → delta_variable profile.fp`。
]);

/** 禁止的数组实体字段 → 必须走各自专用 op（杀 #21 假字段污染） */
const UPDATE_CHAR_FORBIDDEN_ARRAY_FIELDS = new Set<string>([
  'inventory',
  'skills',
  'statusEffects',
  'equipment', // equipment 在 M2 T12 删除前同样禁止
]);

/** 禁止的账务字段 — 仅 Code 层维护（铁律3） */
const UPDATE_CHAR_FORBIDDEN_LEDGER_FIELDS = new Set<string>(['id', 'saveId']);

/** 可 delta 加法的数值字段（metadata.delta=true 时仅允许这些键，杀 #20 delta 变替换） */
const UPDATE_CHAR_NUMERIC_FIELDS = new Set<string>([
  'tier',
  'level',
  'totalExp',
  'expToNext',
  'freeAttrPoints',
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  'maxHpBonus',
  'maxMpBonus',
  'maxSpBonus',
  'money',
  'quantity',
]);

/** 五维属性键（英文，对齐 CharacterState.attributes；升层自动加点逐键遍历用） */
const ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'spi'] as const;

// ========== 小工具 ==========

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 非空文本（时长 / 消耗）→ 去首尾空白后的原文；其余（缺席、空串、非字符串）→ undefined。 */
function readText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

/**
 * 资源当前值的钳制上限：就是角色身上的有效上限字段（`maxHp` 等）。
 * 上限为 0 的数据（无法力的怪物）当前值只能是 0 —— 翻译层纠正写入值也按这一个口径。
 */
export function resourceCeiling(char: CharacterState, key: ResourceKey): number {
  return char[RESOURCE_FIELDS[key].max];
}

// ========== 资源上限拆分（状态树协议 §5.6）==========

/**
 * 角色是否具备按公式管理上限的全部输入：层级、五维、三个上限都是有限数。
 * 脏数据（缺五维 / 上限非数）一律不碰，保持旧行为 —— 算出 NaN 写回比不重算糟得多。
 */
function hasResourceCapInputs(char: CharacterState): boolean {
  if (!hasResourceCapInputsAfterPatch(char)) return false;
  return RESOURCE_KEYS.every((k) => isFiniteNumber(char[RESOURCE_FIELDS[k].max]));
}

/** 落地后只校验层级与五维（上限字段会被重算覆盖，旧写法写进来的值另行读取）。 */
function hasResourceCapInputsAfterPatch(char: CharacterState): boolean {
  if (!isFiniteNumber(char.tier)) return false;
  const attrs = char.attributes as Record<string, unknown> | undefined;
  if (!attrs || typeof attrs !== 'object') return false;
  return ATTRIBUTE_KEYS.every((k) => isFiniteNumber(attrs[k]));
}

/** update_character 补丁落地前抓下的上限基准（§5.6 触发点第 1 步）。 */
interface ResourceCapBaseline {
  prevTier: number;
  prevAttributes: Record<string, number>;
  prevMax: Record<ResourceKey, number>;
}

/**
 * §5.6 触发点第 1 步：补丁落地**之前**把缺席的额外按「现上限 − 旧基础」固化进字段。
 * 必须早于属性 / 层级变化，否则差值会按新基础算错。返回落地后重算要用的基准；输入不全返回 null。
 */
function solidifyResourceCaps(char: CharacterState): ResourceCapBaseline | null {
  if (!hasResourceCapInputs(char)) return null;
  const solid = solidifyResourceBonuses(char);
  const prevMax = {} as Record<ResourceKey, number>;
  for (const key of RESOURCE_KEYS) {
    const fields = RESOURCE_FIELDS[key];
    if (!isFiniteNumber(char[fields.bonus])) char[fields.bonus] = solid[key];
    prevMax[key] = char[fields.max];
  }
  return {
    prevTier: char.tier,
    prevAttributes: { ...(char.attributes as unknown as Record<string, number>) },
    prevMax,
  };
}

/** 把重算结果并回角色。当前值只在原本是有限数时才写（脏数据不被 NaN 化）。 */
function applyRecomputedCaps(
  char: CharacterState,
  bonuses: Record<ResourceKey, number>,
  previousMax: Record<ResourceKey, number>,
  keys: readonly ResourceKey[],
  writeBonus = true,
): void {
  const current = {} as Record<ResourceKey, number>;
  for (const key of RESOURCE_KEYS) {
    current[key] = isFiniteNumber(char[key]) ? char[key] : 0;
  }
  const r = recomputeResourceCaps({
    tier: char.tier,
    attributes: char.attributes,
    bonuses,
    previousMax,
    current,
  });
  for (const key of keys) {
    const fields = RESOURCE_FIELDS[key];
    char[fields.max] = r[fields.max];
    if (writeBonus) char[fields.bonus] = r[fields.bonus];
    if (isFiniteNumber(char[key])) char[key] = r[key];
  }
}

/**
 * §5.6 触发点第 2 步：补丁落地、升级与登神推进都跑完**之后**，按新层级 / 五维重算有效上限。
 *
 * 额外的取值：
 * - 本次写了 `max*Bonus`（替换或 delta）→ 用写后的字段值（第 1 步已固化，delta 从固化值起加）；
 * - 本次只写了 `maxHp` 等（旧写法）→ 解释为「总上限设为 n」（delta 则为「旧总值 + d」），
 *   换算成额外 = n − 新基础，所以同一补丁里属性 / 层级也变了，最终总上限仍是 n；
 * - 都没写 → 保持固化值。
 *
 * 重算哪几项（重算会把有效上限抬到至少 1，上限为 0 的旧数据 —— 如无法力的怪物 —— 不该被无关写入改掉）：
 * - 层级、五维、上限相关键都没变 → 一项都不重算（只留第 1 步的固化）；
 * - 层级或五维变了 → 三项都重算，但原上限为 0 且本次没写到它上限键的项保持 0；
 * - 只写到某几项的上限键（`maxHp` / `maxHpBonus` 等）→ 只重算那几项。
 */
function finishResourceCaps(
  char: CharacterState,
  baseline: ResourceCapBaseline,
  touchedKeys: readonly string[],
): void {
  if (!hasResourceCapInputsAfterPatch(char)) return;
  const attrs = char.attributes as unknown as Record<string, number>;
  const shapeChanged =
    char.tier !== baseline.prevTier ||
    ATTRIBUTE_KEYS.some((k) => attrs[k] !== baseline.prevAttributes[k]);
  const capTouchedKeys = RESOURCE_KEYS.filter((key) => {
    const fields = RESOURCE_FIELDS[key];
    return touchedKeys.includes(fields.max) || touchedKeys.includes(fields.bonus);
  });
  const keys = shapeChanged
    ? RESOURCE_KEYS.filter((key) => capTouchedKeys.includes(key) || baseline.prevMax[key] !== 0)
    : capTouchedKeys;
  if (keys.length === 0 && !shapeChanged) return;

  const bases = baseResourceCaps(char.tier, char.attributes);
  if (shapeChanged) {
    // 保持 0 的项按新基础重固化额外（= −新基础），使「基础 + 额外」恒为 0：
    // 否则额外停在旧基础对应的值，之后一次 +d 的额外写入会让上限从 0 跳到「新旧基础差 + d」
    for (const key of RESOURCE_KEYS) {
      if (!keys.includes(key)) char[RESOURCE_FIELDS[key].bonus] = -bases[key];
    }
  }
  if (keys.length === 0) return;
  const bonuses = {} as Record<ResourceKey, number>;
  for (const key of RESOURCE_KEYS) {
    const fields = RESOURCE_FIELDS[key];
    const writtenTotal = char[fields.max];
    let bonus: unknown = char[fields.bonus];
    if (
      !touchedKeys.includes(fields.bonus) &&
      touchedKeys.includes(fields.max) &&
      isFiniteNumber(writtenTotal)
    ) {
      bonus = writtenTotal - bases[key];
    }
    // 补丁把额外写成了非数（白名单不查替换值类型）→ 退回落地前的有效值对应的额外
    bonuses[key] = isFiniteNumber(bonus) ? bonus : baseline.prevMax[key] - bases[key];
  }
  applyRecomputedCaps(char, bonuses, baseline.prevMax, keys);
}

// ========== update_character ==========

/** 白名单校验（先验证后赋值 — 原子拒绝，任一非法键则整个 value 不落地）。 */
function assertUpdateCharacterKeys(value: Record<string, unknown>, isDelta: boolean): void {
  for (const k of Object.keys(value)) {
    if (UPDATE_CHAR_FORBIDDEN_ARRAY_FIELDS.has(k)) {
      // #21: 数组实体禁走 update_character，防假字段污染
      throw new Error(
        `update_character 禁止写数组字段 "${k}" — 请使用专用 op（add/update/remove_status_effect、add/update/remove_skill、add/update/remove_item、equip/unequip_item）`,
      );
    }
    if (k === 'name') {
      // 改名唯一途径 rename_character（名字是逻辑键，铁律1）
      throw new Error(`update_character 禁止改 name — 改名请使用 rename_character`);
    }
    if (UPDATE_CHAR_FORBIDDEN_LEDGER_FIELDS.has(k)) {
      // 账务字段仅 Code 层维护（铁律3）
      throw new Error(`update_character 禁止写账务字段 "${k}"（仅引擎内部维护）`);
    }
    if (!UPDATE_CHAR_WHITELIST.has(k)) {
      // 未知键 = 大概率 AI 拼写错误，loud 拒绝优于静默吞掉
      throw new Error(`update_character 不认识的字段 "${k}" — 白名单外的键一律拒绝`);
    }
    if (isDelta) {
      // delta 模式: 数值字段直接加；attributes 为嵌套对象（五维），其内部数值键各自加法
      if (k === 'attributes') {
        if (typeof value[k] !== 'object' || value[k] === null) {
          throw new Error(`update_character delta=true 的 attributes 必须是对象`);
        }
      } else if (!UPDATE_CHAR_NUMERIC_FIELDS.has(k)) {
        throw new Error(`update_character delta=true 仅支持数值字段，"${k}" 不是数值字段`);
      } else if (typeof value[k] !== 'number') {
        throw new Error(
          `update_character delta=true 要求 "${k}" 的值为 number，实际为 ${typeof value[k]}`,
        );
      }
      // NaN / ±Infinity 通过了 typeof 检查，落地时由 `isIgnoredDelta` 忽略（金钱除外）
    }
  }
}

/**
 * 主角经验/登神推进（经验系统改造 v1，2026-08-24）。
 *
 * 本次 update_character 触及主角 `totalExp` 或 `ascension` 时调用。
 * 两段式（ADR-11：确定性数值规则归 Code，不交给 AI 算）：
 *  ① 登神飞升（`resolveAscensionFlyup`，主人裁定放宽版）：持物即飞升 + 层级-1 硬性限制 ——
 *     等级跳到目标层起点（13/17/21/25）、tier 同步，**顺便升级**（每级 +1 属性点 + 里程碑全属性+1）；
 *  ② 升级循环（`resolveLevelUps`）：totalExp 攒够就逐级升，里程碑全属性+1 且 tier 提升，
 *     关键等级（12/16/20/24）登神条件不满足时 totalExp 截断到当前级门槛。
 */
function applyPlayerProgression(char: CharacterState, notes: ReduceNote[]): void {
  // 旧档经验保底归一化（幂等兜底，方案 A）：totalExp 抬到「升当前等级门槛」、expToNext 重算。
  // 加载时（game-store）已做过一次，这里再兜一道——任何 totalExp/ascension 提交路径都自愈。
  applyExpFloor(char);
  // ① 登神飞升（放宽版）
  const fly = resolveAscensionFlyup({ level: char.level, ascension: char.ascension });
  if (fly.flyup && fly.nextLevel !== undefined && fly.nextTier !== undefined) {
    const oldLevel = char.level;
    char.level = fly.nextLevel;
    char.tier = fly.nextTier;
    char.tierName = tierNameForTier(fly.nextTier);
    char.expToNext = xpToNextNumber(fly.nextLevel);
    // 顺便升级：每级 +1 自由属性点 + 里程碑全属性+1
    char.freeAttrPoints = (char.freeAttrPoints ?? 0) + (fly.nextLevel - oldLevel);
    for (let lv = oldLevel + 1; lv <= fly.nextLevel; lv++) {
      const milestone = MILESTONE_LEVELS[lv];
      if (milestone) {
        const base = (char.attributes ?? {}) as Record<string, number>;
        const next: Record<string, number> = { ...base };
        for (const attr of ATTRIBUTE_KEYS) {
          next[attr] = (typeof base[attr] === 'number' ? base[attr] : 0) + milestone.attributeBonus;
        }
        char.attributes = next as CharacterState['attributes'];
      }
    }
  }

  // ② 升级循环（totalExp 驱动）
  const res = resolveLevelUps({
    level: char.level,
    totalExp: char.totalExp,
    expToNext: char.expToNext,
    freeAttrPoints: char.freeAttrPoints,
    attributes: char.attributes,
    tier: char.tier,
    tierName: char.tierName,
    ascension: char.ascension,
  });
  char.level = res.level;
  char.totalExp = res.totalExp;
  char.expToNext = res.expToNext;
  char.freeAttrPoints = res.freeAttrPoints;
  char.attributes = res.attributes;
  char.tier = res.tier;
  char.tierName = res.tierName;
  if (res.ascensionBlocked) {
    notes.push({
      level: 'info',
      text: `登神长阶未开启，${char.name} 经验已封顶于 Lv.${res.level}（需持有对应登神物突破）`,
    });
  }
}

/** update_character delta 里被忽略的非有限增量的说明（warn）。 */
function ignoredDeltaNote(char: CharacterState, key: string, raw: unknown): ReduceNote {
  return {
    level: 'warn',
    text: `update_character delta 的 ${key} 不是有限数（${String(raw)}），已忽略（${char.name}）`,
  };
}

function reduceUpdateCharacter(char: CharacterState, patch: StatePatch, notes: ReduceNote[]): void {
  // §5.6 上限基准：在白名单校验通过之后、value 落地之前抓（见下方第 1 步）
  let capBaseline: ResourceCapBaseline | null = null;

  if (patch.value && typeof patch.value === 'object') {
    const value = patch.value as Record<string, any>;
    const keys = Object.keys(value);
    const isDelta = patch.metadata?.delta === true;

    // 升级/升层自动加点的取值基准 —— 必须在 value 落地**之前**抓，
    // 否则 delta 与 set 两条路径都会把旧值就地改掉，差值恒为 0（ADR-11：数值规则归 Code）
    const prevLevel = char.level;
    const prevTier = char.tier;

    assertUpdateCharacterKeys(value, isDelta);

    // ===== §5.6 第 1 步：落地前固化缺席的额外（按旧层级 / 旧五维）=====
    capBaseline = solidifyResourceCaps(char);

    // ===== 全部合法 → 落地 =====
    if (isDelta) {
      // #20: delta 真加法（缺省/脏数据从 0 起加），不再退化为替换
      for (const k of keys) {
        if (k === 'attributes') {
          // 五维属性 delta：逐键加法（读缺省 0），不动未提及的维度
          const incoming = value.attributes as Record<string, number>;
          const base = (char.attributes ?? {}) as Record<string, number>;
          const next: Record<string, number> = { ...base };
          for (const attr of Object.keys(incoming)) {
            const d = incoming[attr] ?? 0;
            if (!isFiniteNumber(d)) {
              notes.push(ignoredDeltaNote(char, `attributes.${attr}`, d));
              continue;
            }
            const cur = typeof base[attr] === 'number' ? base[attr] : 0;
            next[attr] = cur + d;
          }
          char.attributes = next as CharacterState['attributes'];
        } else if (k !== 'money' && !isFiniteNumber(value[k])) {
          // 非有限增量（NaN / ±Infinity）忽略这一键并记 warn：NaN 的 totalExp 增量会让升级循环的
          // 比较全为 false，主角从 Lv.1 一路直升到关键等级。金钱例外：沿 V1 口径落地后由下方守卫钳到 0
          notes.push(ignoredDeltaNote(char, k, value[k]));
        } else {
          const current = (char as any)[k];
          (char as any)[k] = (typeof current === 'number' ? current : 0) + value[k];
        }
      }
    } else {
      // attributes 深合并: AI 只发 {attributes:{力量:12}} 不得抹掉其余维度（终审修复）
      const { attributes: incomingAttrs, ...rest } = value;
      Object.assign(char, rest);
      if (incomingAttrs && typeof incomingAttrs === 'object') {
        char.attributes = { ...char.attributes, ...incomingAttrs };
      }
    }

    // 金钱不为负（A9）：落地后钳到 0，旧协议 delta / 整值写与 Agent 模式同样受保护；
    // 非有限值（NaN / Infinity / 非数值）同样归 0，免得脏值落库后续加减全变 NaN
    if (keys.includes('money') && !(isFiniteNumber(char.money) && char.money >= 0)) {
      notes.push({ level: 'fix', text: `金钱 ${String(char.money)} 无效或为负，已钳到 0` });
      char.money = 0;
    }

    // ===== NPC 写等级 → 层级由代码按等级推出（§3.3 / §9 #2）=====
    // 主角的等级 / 层级归经验表推进（下方 applyPlayerProgression），这里只管非主角。
    // 本次补丁自带的 tier 被推导值覆盖：两者矛盾时以等级为准，层级名同步（补丁自己写了名字则不动）。
    if (char.type !== 'player' && keys.includes('level') && isFiniteNumber(char.level)) {
      char.tier = getTierForLevel(char.level);
      if (!keys.includes('tierName')) char.tierName = tierNameForTier(char.tier);
    }

    // ===== 升级 / 升层自动加点（ADR-11：确定性数值规则归 Code，不交给 AI 算）=====
    // 只认主角：NPC/怪物/召唤物的等级由生成器一次性给定，没有「攒点数分配」这回事。
    //
    // 🔴 两条路径互斥（防双发放，经验系统改造 v1 2026-08-24）：
    //  · 本次 patch 触及 totalExp 或 ascension → 走下面的 applyPlayerProgression ——
    //    升级/登神全部由 exp-table 的纯函数判定，属性点/里程碑统一发放；
    //  · 否则 → 保留下面的旧兜底逻辑（兼容 AI 直接写 level/tier 的存量行为）。
    if (char.type === 'player' && !keys.includes('totalExp') && !keys.includes('ascension')) {
      // ① 升级：每升 1 级 +1 自由属性点
      //    双重发放 guard —— patch 自己写了 freeAttrPoints 时不再叠加，
      //    否则 AI 一边发点数一边升级，玩家会白拿一倍。
      if (
        typeof prevLevel === 'number' &&
        typeof char.level === 'number' &&
        !keys.includes('freeAttrPoints')
      ) {
        const levelGain = char.level - prevLevel;
        // 降级不回收（剧情降级/数据修正不该没收玩家已到手的点数）
        if (levelGain > 0) {
          char.freeAttrPoints = (char.freeAttrPoints ?? 0) + levelGain;
        }
      }

      // ② 升层：每升 1 层五维各 +1，钳到**新层级**上限
      //    同样的双重发放 guard —— patch 自己写了 attributes 时不再叠加。
      if (
        typeof prevTier === 'number' &&
        typeof char.tier === 'number' &&
        !keys.includes('attributes')
      ) {
        const tierGain = char.tier - prevTier;
        if (tierGain > 0) {
          // 层级配置查不到（越界层级/脏数据）时只加不钳 —— 少给上限强于把属性削掉
          const cap = getTierConfig(char.tier)?.attributeCap;
          const base = (char.attributes ?? {}) as Record<string, number>;
          const next: Record<string, number> = { ...base };
          for (const attr of ATTRIBUTE_KEYS) {
            const cur = typeof base[attr] === 'number' ? base[attr] : 0;
            const raw = cur + tierGain;
            // 钳制只封顶不回削 —— delta 五维加法不钳上限，已超上限的属性升层时不得被静默压低
            next[attr] = typeof cap === 'number' ? Math.max(cur, Math.min(raw, cap)) : raw;
          }
          char.attributes = next as CharacterState['attributes'];
        }
      }
    }
  }

  // ===== 经验系统改造 v1：totalExp / ascension 驱动的主角推进（升级循环 + 登神飞升）=====
  // 战斗（combat）与制作（craft_gen）的经验都经 update_character delta 累加 totalExp；
  // 登神物（ascension 字段）由 AI 写入。这两条变化一落地，升级/登神就由 Code 统一接管。
  // 放在旧自动加点块之外、且在 value 落地之后 —— resolveLevelUps 读的是「落地后」的新状态。
  const touchedKeys =
    patch.value && typeof patch.value === 'object'
      ? Object.keys(patch.value as Record<string, unknown>)
      : [];
  if (
    char.type === 'player' &&
    (touchedKeys.includes('totalExp') || touchedKeys.includes('ascension'))
  ) {
    applyPlayerProgression(char, notes);
  }

  // ===== §5.6 第 2 步：落地与推进都跑完后，按新层级 / 五维重算三个有效上限 =====
  // 上限下降：当前值钳到新上限；上升：当前值不变（§9 #10）
  if (capBaseline) finishResourceCaps(char, capBaseline, touchedKeys);

  // ===== hp/mp/sp 钳制: 与 set_hp 语义一致 [0, 对应 max]（终审修复）=====
  // 仅在本次 patch 涉及资源、其 max 或额外时钳制；放在重算之后，以最终有效上限为准。
  for (const res of RESOURCE_KEYS) {
    const fields = RESOURCE_FIELDS[res];
    if (
      touchedKeys.includes(res) ||
      touchedKeys.includes(fields.max) ||
      touchedKeys.includes(fields.bonus)
    ) {
      const cur = char[res];
      const max = char[fields.max];
      if (typeof cur === 'number' && typeof max === 'number') {
        char[res] = Math.max(0, Math.min(cur, max));
      }
    }
  }
  // metadata.action 保留原行为: 有则覆盖 currentAction（可与 value.currentAction 并存，metadata 优先）
  char.currentAction = patch.metadata?.action ?? char.currentAction;
}

// ========== 资源 ==========

function writeResource(
  char: CharacterState,
  key: ResourceKey,
  raw: number,
  notes: ReduceNote[],
): void {
  const max = resourceCeiling(char, key);
  const next = Math.max(0, Math.min(raw, max));
  if (next !== raw) notes.push({ level: 'fix', text: `${key} ${raw} 越界，已钳到 ${next}` });
  char[key] = next;
}

// ========== 状态效果 ==========

/**
 * add_status_effect — M2 按名寻址 (#4)
 *
 * value = { name(必), ... } — 不要求 id（AI 永不产 id，铁律1/3）
 * 同名叠层规则:
 * - stackable=false: 永远 1 层，只刷新时长（取 max；新效果永久则覆盖为永久）
 * - 其他（含缺省）: stacks 累加（缺省视作 1 层），有 maxStacks 则封顶
 * category 过 normalizeStatusCategory 归一（'buff' → '增益' 等，铁律5）
 */
function reduceAddStatusEffect(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as Partial<StatusEffect>;
  if (!value?.name) throw new Error('add_status_effect 需要 value.name');

  const incomingStacks = typeof value.stacks === 'number' && value.stacks > 0 ? value.stacks : 1;
  // §5.2 时长互斥：有文本时长时 remainingTime 存 null；文本与数值同给时以文本为准
  const incomingDurationText = readText(value.durationText);

  // 刷新时长: 双方有限取 max；新效果永久(null) 覆盖为永久；未提供(undefined) 不动
  // F07：时长被真正拉长（取到了更大的新窗口）时 carryMinutes 归零 —— 余量属于旧窗口的
  // 已流逝分钟，新起点不应继承；反之保留现有时长则保留其已累积余量。
  const refreshTime = (existing: StatusEffect): void => {
    if (value.remainingTime === undefined) return;
    if (value.remainingTime === null) {
      existing.remainingTime = null;
      existing.carryMinutes = undefined;
    } else if (existing.remainingTime == null) {
      // 遗留数据 remainingTime === undefined → 直接取来值，防 Math.max(undefined, n) 产 NaN（终审修复）
      // existing 已是永久(null) → 保持永久不覆盖
      if (existing.remainingTime === undefined) {
        existing.remainingTime = value.remainingTime;
        existing.carryMinutes = undefined;
      }
    } else {
      const prev = existing.remainingTime;
      existing.remainingTime = Math.max(existing.remainingTime, value.remainingTime);
      if (existing.remainingTime !== prev) {
        existing.carryMinutes = undefined;
      }
    }
  };

  // 时长写入的总入口：文本时长 → 存文本、remainingTime=null；数值 / null → 清文本。
  // 既有状态挂着文本时长时，数值不与「永久」取 max（那会把它永远钉成永久），而是直接取代。
  const writeDuration = (existing: StatusEffect): void => {
    if (incomingDurationText !== undefined) {
      existing.durationText = incomingDurationText;
      existing.remainingTime = null;
      existing.carryMinutes = undefined;
      return;
    }
    if (value.remainingTime === undefined) return;
    if (existing.durationText !== undefined) {
      existing.remainingTime = value.remainingTime;
      existing.carryMinutes = undefined;
      delete existing.durationText;
      return;
    }
    refreshTime(existing);
  };

  const existing = findByName(char.statusEffects, value.name);
  if (existing) {
    if (existing.stackable === false) {
      // 不可叠加: 同名再施加不重复插入，保持 1 层，只刷新时长
      existing.stacks = 1;
    } else {
      // 可叠加（含缺省）: 累加层数，有上限则封顶
      existing.stacks += incomingStacks;
      if (existing.maxStacks && existing.maxStacks > 0) {
        existing.stacks = Math.min(existing.stacks, existing.maxStacks);
      }
    }
    writeDuration(existing);
    return;
  }
  // 新效果: 不写 id（铁律1，id 字段 @deprecated），category 归一，缺省补账务字段
  const effect: StatusEffect = {
    name: value.name,
    description: value.description ?? '',
    category: normalizeStatusCategory(value.category ?? ''),
    stacks: incomingStacks,
    maxStacks: value.maxStacks,
    stackable: value.stackable,
    remainingTime: incomingDurationText !== undefined ? null : (value.remainingTime ?? null),
    ...(incomingDurationText !== undefined ? { durationText: incomingDurationText } : {}),
    timeUnit: value.timeUnit ?? '分钟',
    source: value.source ?? '',
    effects: value.effects ?? {},
    effectDescriptions: value.effectDescriptions,
    protocolText: value.protocolText,
    tags: value.tags,
  };
  if (effect.maxStacks && effect.maxStacks > 0) {
    effect.stacks = Math.min(effect.stacks, effect.maxStacks);
  }
  char.statusEffects.push(effect);
}

/**
 * update_status_effect — daily_check（Phase 3）按名改既有状态。
 *
 * value = { name(必), remainingTime?, durationText?, stacks? }：
 *   · `remainingTime`：数值=剩余量（timeUnit 口径，**取代**旧值，不是取 max）；`null`=改为永久；缺省不动。
 *   · `stacks`：正数才生效，有 `maxStacks` 则封顶；缺省不动。
 *   · 只改这几个字段，别的（描述/来源/层数上限）不动。
 *
 * 🔴 **找不到该状态名 → 记 warn 说明、不抛**（照地图落位「按名寻址失败不否决」口径）：
 *    AI 报的一条倒计时可能对应已被同回合 remove 掉的状态，硬抛会连坐整批补丁。
 */
function reduceUpdateStatusEffect(
  char: CharacterState,
  patch: StatePatch,
  notes: ReduceNote[],
): void {
  const value = patch.value as {
    name?: string;
    remainingTime?: number | null;
    durationText?: string;
    stacks?: number;
  };
  const name = value?.name;
  if (!name) throw new Error('update_status_effect 需要 value.name');

  const existing = findByName(char.statusEffects, name);
  if (!existing) {
    notes.push({
      level: 'warn',
      text: `update_status_effect 找不到状态 "${name}"（${char.name}），忽略该条`,
    });
    return;
  }

  // §5.2 时长互斥：写文本时长 → remainingTime 存 null；写数值或 null → 清文本（含 daily_check）
  const durationText = readText(value.durationText);
  if (durationText !== undefined) {
    existing.durationText = durationText;
    existing.remainingTime = null;
    existing.carryMinutes = undefined;
  } else if (value.remainingTime !== undefined) {
    // null=永久；数值=取代（负数钳到 0，由 daily_check 决定何时改发 remove）
    existing.remainingTime = value.remainingTime === null ? null : Math.max(0, value.remainingTime);
    delete existing.durationText;
    // F07 余量随脚本退役一并作废：时间口径全交 AI，不再维护 carryMinutes
    existing.carryMinutes = undefined;
  }
  if (typeof value.stacks === 'number' && value.stacks > 0) {
    existing.stacks = value.stacks;
    if (existing.maxStacks && existing.maxStacks > 0) {
      existing.stacks = Math.min(existing.stacks, existing.maxStacks);
    }
  }
}

/** remove_status_effect — M2 按名删除 (#22) / M3 统一 {name} 对象形态 */
function reduceRemoveStatusEffect(char: CharacterState, patch: StatePatch): void {
  const name = (patch.value as { name?: string })?.name;
  if (!name) throw new Error('remove_status_effect 需要 value.name');
  char.statusEffects = char.statusEffects.filter((e) => e.name !== name);
}

// ========== 物品 ==========

/**
 * add_item — M2 按名寻址 + 同名合并 (#5)
 *
 * 同名合并: 只累加 quantity，既有字段不覆盖（改字段走 update_item）。
 * 归一化（铁律5）: type→normalizeItemType / rarity→normalizeRarity / equippedSlot→normalizeSlot
 * （equippedSlot 无法识别 → null，不 throw，物品视作躺背包）。
 */
function reduceAddItem(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as Partial<InventoryItem>;
  if (!value?.name) throw new Error('add_item 需要 value.name');

  const quantity = typeof value.quantity === 'number' && value.quantity > 0 ? value.quantity : 1;

  const existing = findByName(char.inventory, value.name);
  if (existing) {
    // 同名合并: 只累加数量，不动既有字段
    existing.quantity += quantity;
    return;
  }
  // 新物品: 不写 id（铁律1，id @deprecated），枚举字段归一
  char.inventory.push({
    name: value.name,
    quantity,
    description: value.description,
    type: value.type !== undefined ? normalizeItemType(value.type) : undefined,
    rarity: value.rarity !== undefined ? normalizeRarity(value.rarity) : undefined,
    equippedSlot:
      value.equippedSlot != null ? normalizeSlot(value.equippedSlot) : value.equippedSlot,
    stats: value.stats,
    durability: value.durability,
    maxDurability: value.maxDurability,
    protocolText: value.protocolText,
    tags: value.tags,
    data: value.data,
    effects: value.effects,
  });
}

/** remove_item — 扣减到 0 时删除条目；找不到 / 库存不足 → throw（P1-07：不静默扣成负数）。 */
function reduceRemoveItem(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as { name?: string; quantity?: number };
  const name = value?.name;
  const qty = value?.quantity ?? 1;
  if (!name) throw new Error('remove_item 需要 value.name');

  const idx = char.inventory.findIndex((i) => i.name === name);
  if (idx < 0) throw new Error(`物品不存在: ${name}`);
  if (char.inventory[idx].quantity < qty) {
    throw new Error(`物品「${name}」库存不足: 持有 ${char.inventory[idx].quantity}，需要 ${qty}`);
  }
  char.inventory[idx].quantity -= qty;
  if (char.inventory[idx].quantity === 0) {
    char.inventory.splice(idx, 1);
  }
}

/**
 * update_item — value = { name(必), changes }；changes 禁 name / quantity，
 * id 剥离（铁律1），type / rarity / equippedSlot 归一化（铁律5）。
 */
function reduceUpdateItem(char: CharacterState, patch: StatePatch): void {
  const update = patch.value as { name?: string; changes?: Partial<InventoryItem> };
  if (!update?.name) throw new Error('update_item 需要 value.name');

  const item = findByName(char.inventory, update.name);
  if (!item) throw new Error(`物品不存在: ${update.name}`);

  const rawChanges = update.changes ?? {};
  if ('name' in rawChanges)
    throw new Error('update_item 禁止改 name（改名走 remove_item + add_item）');
  if ('quantity' in rawChanges)
    throw new Error('update_item 禁止改 quantity（数量走 add_item / remove_item）');

  const { id: _ignoredId, ...changes } = rawChanges;
  if (changes.type !== undefined) changes.type = normalizeItemType(changes.type);
  if (changes.rarity !== undefined) changes.rarity = normalizeRarity(changes.rarity);
  if (changes.equippedSlot != null) changes.equippedSlot = normalizeSlot(changes.equippedSlot);
  Object.assign(item, changes);
}

/**
 * equip_item — equippedSlot 单真源（M2 #10 #23 #24）：穿 = 设 equippedSlot，零数据搬运。
 * slot 无法识别 / 堆叠物品 → throw；同槽已有穿戴者 → 只清其 equippedSlot。
 */
function reduceEquipItem(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as { name?: string; slot?: string };
  if (!value?.name) throw new Error('equip_item 需要 value.name');
  if (!value.slot) throw new Error('equip_item 需要 value.slot');

  const slot = normalizeSlot(value.slot);
  if (!slot) throw new Error(`无法识别的装备槽位: ${value.slot}`);

  const item = findByName(char.inventory, value.name);
  if (!item) throw new Error(`物品不存在: ${value.name}`);

  // 堆叠穿戴互斥: 堆叠物品穿上后 quantity 语义会撕裂（穿 1 件还是 5 件？）
  if (item.quantity > 1) {
    throw new Error(`堆叠物品不可直接穿戴: ${value.name}（数量 ${item.quantity}），请先拆分为单件`);
  }

  // 同槽顶替: 仅清旧穿戴者的 equippedSlot，物品留在背包字段无损（杀 #10 有损穿脱）
  for (const other of char.inventory) {
    if (other !== item && other.equippedSlot === slot) {
      other.equippedSlot = null;
    }
  }
  item.equippedSlot = slot;
}

/** unequip_item — value = { name } 或 { slot }（slot 先归一化）；找不到 → throw。 */
function reduceUnequipItem(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as { name?: string; slot?: string };
  let item: InventoryItem | undefined;

  if (value?.name) {
    item = findByName(char.inventory, value.name);
    if (!item) throw new Error(`物品不存在: ${value.name}`);
  } else if (value?.slot) {
    const slot = normalizeSlot(value.slot);
    if (!slot) throw new Error(`无法识别的装备槽位: ${value.slot}`);
    item = char.inventory.find((i) => i.equippedSlot === slot);
    if (!item) throw new Error(`该槽位无穿戴: ${slot}`);
  } else {
    throw new Error('unequip_item 需要 value.name 或 value.slot');
  }
  item.equippedSlot = null;
}

/** transfer_item 的请求（已校验形状）。 */
interface TransferItemRequest {
  name: string;
  to: string;
  quantity: number;
}

/** 读 transfer_item 的 value：缺物品名 / 接收方 → throw（调用方先读它，再按 `to` 解析接收方）。 */
export function readTransferItemRequest(patch: StatePatch): TransferItemRequest {
  const value = patch.value as { name?: string; to?: string; quantity?: number };
  if (!value?.name) throw new Error('transfer_item 需要 value.name');
  if (!value.to) throw new Error('transfer_item 需要 value.to（接收方名字）');
  const quantity = typeof value.quantity === 'number' && value.quantity > 0 ? value.quantity : 1;
  return { name: value.name, to: value.to, quantity };
}

/**
 * transfer_item — 原子转移 (#5)：先全部校验（非自我转移 + 甲有该物品且数量足够）再变更，
 * 任一失败两人都不动。乙同名合并；乙新增时物品字段随转移带过去（剥 id、脱下）。
 */
export function reduceTransferItem(
  from: CharacterState,
  to: CharacterState,
  request: TransferItemRequest,
): ReduceResult {
  const { name, quantity: qty } = request;
  // 自转移防复制: 甲乙为同一角色时 bulkPut 同主键后写覆盖前写，会凭空复制物品
  if (to === from || to.id === from.id) {
    throw new Error(`transfer_item 不允许自我转移: ${from.name}`);
  }
  const idx = from.inventory.findIndex((i) => i.name === name);
  if (idx < 0) throw new Error(`物品不存在: ${name}`);
  if (from.inventory[idx].quantity < qty) {
    throw new Error(`物品数量不足: ${name}（持有 ${from.inventory[idx].quantity}，需 ${qty}）`);
  }

  const source = from.inventory[idx];
  const received = findByName(to.inventory, name);
  if (received) {
    received.quantity += qty;
  } else {
    const { id: _ignoredId, ...fields } = source;
    to.inventory.push({ ...fields, quantity: qty, equippedSlot: null });
  }
  source.quantity -= qty;
  if (source.quantity <= 0) {
    from.inventory.splice(idx, 1);
  }
  return { notes: [] };
}

// ========== 技能 ==========

/** `Skill.cost` 是否为可解析的结构化消耗（HP / MP / SP + 有限数量）。 */
function isParsedSkillCost(v: unknown): v is NonNullable<Skill['cost']> {
  if (!v || typeof v !== 'object') return false;
  const c = v as { type?: unknown; amount?: unknown };
  return (c.type === 'HP' || c.type === 'MP' || c.type === 'SP') && isFiniteNumber(c.amount);
}

/**
 * 一份写入的消耗值 → 结构化消耗或可读文本；空值（空串、空对象）→ null。
 * - HP / MP / SP（大小写不敏感）+ 有限数量 → 结构化 `cost`；
 * - 其余带类型的对象（如 `{type:'信仰',amount:3}`）→「信仰 3」；
 * - 非空字符串 / 有限数 → 原文；其余认不出的值 → JSON 文本（宁可难看也不丢）。
 */
function coerceSkillCost(
  raw: unknown,
): { cost: NonNullable<Skill['cost']> } | { text: string } | null {
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? { text: t } : null;
  }
  if (isFiniteNumber(raw)) return { text: String(raw) };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const c = raw as { type?: unknown; amount?: unknown };
    const type = typeof c.type === 'string' ? c.type.trim() : '';
    const upper = type.toUpperCase();
    if ((upper === 'HP' || upper === 'MP' || upper === 'SP') && isFiniteNumber(c.amount)) {
      return { cost: { type: upper, amount: c.amount } };
    }
    if (type) {
      const amount = c.amount === undefined || c.amount === null ? '' : String(c.amount).trim();
      return { text: amount ? `${type} ${amount}` : type };
    }
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    json = undefined;
  }
  return json && json !== '{}' && json !== '[]' ? { text: json } : null;
}

/**
 * 把本次写入的 `cost` 规整成 §5.2 互斥两形之一，认不出的消耗不丢（就地改 `written`）：
 * 能解析成 HP / MP / SP 的写成结构化 `cost`，其余转成可读文本进 `costText`
 * （本次另给了非空 `costText` 时以显式文本为准）。没写 `cost` 或写的是 null / undefined（清除）时不动。
 */
function normalizeWrittenSkillCost(written: Partial<Skill>): void {
  if (!('cost' in written)) return;
  const raw: unknown = written.cost;
  if (raw === null || raw === undefined || isParsedSkillCost(raw)) return;
  const coerced = coerceSkillCost(raw);
  if (coerced && 'cost' in coerced) {
    written.cost = coerced.cost;
    return;
  }
  delete written.cost;
  if (coerced && readText(written.costText) === undefined) written.costText = coerced.text;
}

/**
 * 技能消耗互斥（§5.2）：本次写入可解析的 `cost` → 清 `costText`；
 * 写入文本消耗 → 清 `cost`。两者同给时以可解析的 `cost` 为准。只看本次写入的字段。
 */
function enforceSkillCostExclusion(skill: Skill, written: Partial<Skill>): void {
  if (isParsedSkillCost(written.cost)) {
    delete skill.costText;
    return;
  }
  const text = readText(written.costText);
  if (text !== undefined) {
    skill.costText = text;
    delete skill.cost;
  } else if ('costText' in written) {
    // 写了空文本 / 非字符串：不留脏值
    delete skill.costText;
  }
}

/**
 * add_skill — M2 按名寻址 (#4)。同名 = 覆盖升级（规范 §4）：提供的字段逐一覆盖，未提供的保留。
 */
function reduceAddSkill(char: CharacterState, patch: StatePatch): void {
  const value = patch.value as Partial<Skill>;
  if (!value?.name) throw new Error('add_skill 需要 value.name');

  // 剥离 id: 无论上游是否夹带，引擎不再读写技能 id（铁律1，id @deprecated）
  const { id: _ignoredId, ...fields } = value;
  // §5.2：认不出的消耗转成可读文本而不是丢掉；新建与覆盖两支共用规整后的 fields
  normalizeWrittenSkillCost(fields);

  const existing = findByName(char.skills, value.name);
  if (existing) {
    Object.assign(existing, fields);
    enforceSkillCostExclusion(existing, fields);
    return;
  }
  char.skills.push({
    name: value.name,
    description: value.description ?? '',
    type: value.type ?? 'active',
    // §5.2 消耗互斥：可解析的 cost 优先，否则留原文 costText
    cost: isParsedSkillCost(fields.cost) ? fields.cost : undefined,
    ...(!isParsedSkillCost(fields.cost) && readText(fields.costText) !== undefined
      ? { costText: readText(fields.costText) }
      : {}),
    cooldown: value.cooldown,
    protocolText: value.protocolText,
    tags: value.tags,
    maxCooldown: value.maxCooldown,
    level: value.level,
    effects: value.effects,
    // 技能品质（item_gen `<skill quality>` → rarity），归一化口径同 add_item
    rarity: value.rarity !== undefined ? normalizeRarity(value.rarity) : undefined,
    // 主体威力三字段透传（skillPower 链路修复 2026-08-12：漏收则战斗兜底 0 伤害）
    skillPower: value.skillPower,
    relevantAttribute: value.relevantAttribute,
    damageType: value.damageType,
  });
}

/** update_skill — value = { name, changes }；技能不存在 → throw；changes 的 id 剥离（铁律1）。 */
function reduceUpdateSkill(char: CharacterState, patch: StatePatch): void {
  const update = patch.value as { name?: string; changes?: Partial<Skill> };
  if (!update?.name) throw new Error('update_skill 需要 value.name');

  const skill = findByName(char.skills, update.name);
  if (!skill) throw new Error(`技能不存在: ${update.name}`);

  const { id: _ignoredId, ...changes } = update.changes ?? {};
  normalizeWrittenSkillCost(changes);
  Object.assign(skill, changes);
  enforceSkillCostExclusion(skill, changes);
}

/** remove_skill — value = { name }；删除不存在的技能 → throw。 */
function reduceRemoveSkill(char: CharacterState, patch: StatePatch): void {
  const name = (patch.value as { name?: string })?.name;
  if (!name) throw new Error('remove_skill 需要 value.name');
  if (!findByName(char.skills, name)) throw new Error(`技能不存在: ${name}`);
  char.skills = char.skills.filter((s) => s.name !== name);
}

// ========== 分发 ==========

/** 是否为本模块负责的单角色补丁。 */
export function isCharacterPatchOp(op: StatePatchOp): op is CharacterPatchOp {
  return CHARACTER_REDUCERS[op as CharacterPatchOp] !== undefined;
}

type CharacterReducer = (char: CharacterState, patch: StatePatch, notes: ReduceNote[]) => void;

const setResource = (key: ResourceKey): CharacterReducer => {
  return (char, patch, notes) => writeResource(char, key, patch.value as number, notes);
};

const deltaResource = (key: ResourceKey): CharacterReducer => {
  return (char, patch, notes) => writeResource(char, key, char[key] + (patch.amount ?? 0), notes);
};

/** `Record<CharacterPatchOp, …>`：漏接一个角色 op 是编译错误。 */
const CHARACTER_REDUCERS: Record<CharacterPatchOp, CharacterReducer> = {
  update_character: reduceUpdateCharacter,
  set_location: (char, patch) => {
    char.location = String(patch.value);
  },
  set_hp: setResource('hp'),
  set_mp: setResource('mp'),
  set_sp: setResource('sp'),
  delta_hp: deltaResource('hp'),
  delta_mp: deltaResource('mp'),
  delta_sp: deltaResource('sp'),
  add_status_effect: reduceAddStatusEffect,
  update_status_effect: reduceUpdateStatusEffect,
  remove_status_effect: reduceRemoveStatusEffect,
  add_item: reduceAddItem,
  remove_item: reduceRemoveItem,
  update_item: reduceUpdateItem,
  equip_item: reduceEquipItem,
  unequip_item: reduceUnequipItem,
  add_skill: reduceAddSkill,
  update_skill: reduceUpdateSkill,
  remove_skill: reduceRemoveSkill,
};

/**
 * 把一条单角色补丁作用到角色上（就地）。非法补丁在动角色之前抛错。
 * 静态形状校验（`validateStatePatch`）与按名寻址由调用方先做。
 */
export function reduceCharacterPatch(char: CharacterState, patch: StatePatch): ReduceResult {
  const reducer = CHARACTER_REDUCERS[patch.op as CharacterPatchOp];
  if (!reducer) throw new Error(`不是角色类补丁: ${patch.op}`);
  const notes: ReduceNote[] = [];
  reducer(char, patch, notes);
  return { notes };
}

// ========== 新建人物 ==========

/**
 * add_character 的人物内容整理（就地）：补年龄锚点、按 §5.6 规整自带额外的上限。
 * 名字查重、saveId 注入与落库是档案域的事，由调用方负责。
 *
 * - 实例化闸门：年龄线索缺失或无效时兜底此刻 18 岁 / 生日 1 月 1 日；自带合法 ageAnchor 原样保留。
 * - §5.6 新建角色（协调者裁定 2026-11-22）：缺席的额外固化为「带来的上限 − 公式基础」，
 *   带进来的总上限一分不变；只重算角色**自带**了 *Bonus 的那几项 —— 其余项重算只会把
 *   上限为 0 的数据（无法力的怪物）抬成 1。「自带」必须在固化之前判断。
 */
export function prepareNewCharacter(
  character: CharacterState,
  gameTime: Pick<GameTime, 'year' | 'month' | 'day'>,
): ReduceResult {
  ensureCharacterAge(character, gameTime);
  const carried = RESOURCE_KEYS.filter((k) => isFiniteNumber(character[RESOURCE_FIELDS[k].bonus]));
  const capBaseline = solidifyResourceCaps(character);
  if (capBaseline && carried.length > 0) {
    const bonuses = {} as Record<ResourceKey, number>;
    for (const key of RESOURCE_KEYS) bonuses[key] = character[RESOURCE_FIELDS[key].bonus]!;
    applyRecomputedCaps(character, bonuses, capBaseline.prevMax, carried, false);
  }
  return { notes: [] };
}

// ========== 档案域（审查报告 R5c）==========

/** 档案域补丁要读写的 SaveProfile 切片（翻译层工作状态没有 FP 账目时 `fpHistory` 缺席）。 */
export type ReducibleProfile = Pick<
  SaveProfile,
  'fp' | 'quests' | 'news' | 'variables' | 'gameTime' | 'affections'
> & { fpHistory?: FPTransaction[] };

/** 一份完整的可推进状态：本存档全部角色 + 档案切片。 */
export interface ReducibleState {
  characters: CharacterState[];
  profile: ReducibleProfile;
}

/** 命运点账目的落款（id 与时间戳由调用方给：本模块不读时钟、不取随机）。 */
interface FatePointLedger {
  reason: string;
  id: string;
  timestamp: number;
}

/** 命运点补丁的口径（V1）：AI 来源扣超余额钳到 0；领域命令与玩家编辑不足照旧抛错。 */
export interface FatePointOptions {
  clampSpend: boolean;
  /** 给了就记一笔 `fpHistory`（StateManager）；不给不记（翻译层工作状态）。 */
  ledger?: FatePointLedger;
}

/** `reduceStatePatch` 的上下文：档案域里那几处要调用方补的东西。 */
export interface StateReduceContext {
  fatePoints: FatePointOptions;
  /** 新闻的账务字段（铁律3：Code 补 id / 发布时间）。 */
  newsStamp: () => { id: string; publishedAt: number };
}

/**
 * 从 `characters.<名>` 解析角色：剥前缀后只取第一段（防御子路径写法 `characters.X.skills`，#11），
 * 再按名寻址（`patch-rules` 的别名与「主角／玩家」口径）。找不到 → throw。
 */
export function resolveCharacterTarget(
  characters: readonly CharacterState[],
  target: string,
): CharacterState {
  const raw = target.startsWith('characters.') ? target.slice('characters.'.length) : target;
  const key = raw.split('.')[0];
  if (!key) throw new Error(`无效的 character target: ${target}`);
  return resolveCharacterByName(characters, key);
}

// ---------- 变量 ----------

/** 变量补丁的路径：`variables.` 前缀可写可不写。 */
function variablePath(target: string): string {
  return target.startsWith('variables.') ? target.slice('variables.'.length) : target;
}

const VARIABLE_OPS = new Set<StatePatchOp>([
  'set_variable',
  'delta_variable',
  'remove_variable',
  'move_variable',
  'insert_variable',
]);

/**
 * 变量补丁（真源 `SaveProfile.variables`，M5）。按字面路径写：`delta_variable profile.fp`
 * 在这里会写进 `variables.profile.fp` —— 命运点要走 `reduceFatePointPatch`，由调用方分流。
 */
export function reduceVariablePatch(
  profile: Pick<ReducibleProfile, 'variables'>,
  patch: StatePatch,
): ReduceResult {
  const vars = profile.variables ?? {};
  const path = variablePath(patch.target);
  switch (patch.op) {
    case 'set_variable':
      profile.variables = setVar(vars, path, patch.value);
      break;
    case 'delta_variable': {
      const current = getVar(vars, path);
      profile.variables = setVar(
        vars,
        path,
        (typeof current === 'number' ? current : 0) + (patch.amount ?? 0),
      );
      break;
    }
    case 'remove_variable':
      profile.variables = delVar(vars, path);
      break;
    case 'move_variable': {
      const toPath = patch.metadata?.toPath as string;
      if (!toPath) throw new Error('move_variable 需要 metadata.toPath');
      const value = getVar(vars, path);
      profile.variables = setVar(delVar(vars, path), toPath, value);
      break;
    }
    case 'insert_variable':
      profile.variables = insertVar(vars, path, patch.value, patch.metadata?.index as number);
      break;
    default:
      throw new Error(`不是变量补丁: ${patch.op}`);
  }
  return { notes: [] };
}

// ---------- 命运点 ----------

/**
 * 命运点补丁（`delta_variable profile.fp`），真源 `SaveProfile.fp`。
 * 增：直接加；减：`clampSpend` 时扣到 0 为止，否则余额不足抛错。增减为 0 时不动、不记账。
 */
export function reduceFatePointPatch(
  profile: Pick<ReducibleProfile, 'fp' | 'fpHistory'>,
  patch: StatePatch,
  options: FatePointOptions,
): ReduceResult {
  const amount = patch.amount!;
  if (!Number.isFinite(amount)) throw new Error('FP change must be finite');
  let change = amount;
  if (amount < 0) {
    const balance = Number.isFinite(profile.fp) ? Math.max(0, profile.fp) : 0;
    const spend = options.clampSpend ? Math.min(-amount, balance) : -amount;
    if (spend > 0 && profile.fp < spend) {
      throw new Error(`FP 不足: 需要 ${spend}, 当前 ${profile.fp}`);
    }
    change = -spend;
  }
  if (change === 0) return { notes: [] };
  profile.fp += change;
  if (options.ledger) {
    (profile.fpHistory ??= []).push({
      id: options.ledger.id,
      timestamp: options.ledger.timestamp,
      amount: change,
      reason: options.ledger.reason,
      balance: profile.fp,
      source: 'other',
    });
  }
  return { notes: [] };
}

// ---------- 任务 ----------

/** 任务 upsert 的合并语义（缺省任务补 `createDefaultQuest`）—— 全仓只此一份。 */
export function upsertQuest(
  profile: Pick<ReducibleProfile, 'quests'>,
  name: string,
  fields: Partial<Quest>,
): void {
  const existing = profile.quests[name] ?? createDefaultQuest();
  profile.quests[name] = { ...existing, ...fields };
}

/** update_quest — value = { name(必), ...字段 }；status 自由字符串归一化（#32）。 */
function reduceUpdateQuest(profile: Pick<ReducibleProfile, 'quests'>, patch: StatePatch): void {
  const questData = patch.value as { name?: string } & Record<string, unknown>;
  const questName = questData?.name;
  if (!questName) throw new Error('缺少任务名称');
  const questFields: Record<string, unknown> = { ...questData };
  delete questFields.name;
  if (questFields.status !== undefined) {
    questFields.status = normalizeQuestStatus(questFields.status as string);
  }
  upsertQuest(profile, questName, questFields as Partial<Quest>);
}

/** update_quest / remove_quest（remove 的 value 统一为 { name } 对象，#40）。 */
export function reduceQuestPatch(
  profile: Pick<ReducibleProfile, 'quests'>,
  patch: StatePatch,
): ReduceResult {
  if (patch.op === 'update_quest') {
    reduceUpdateQuest(profile, patch);
  } else if (patch.op === 'remove_quest') {
    const questName = (patch.value as { name?: string })?.name;
    if (!questName) throw new Error('缺少任务名称');
    delete profile.quests[questName];
  } else {
    throw new Error(`不是任务补丁: ${patch.op}`);
  }
  return { notes: [] };
}

// ---------- 好感 / 新闻 ----------

const AFFECTION_PREFIX = 'affections.';

/**
 * set_affection / delta_affection（规范 §7）。target = `affections.<角色名>`，名字是自由键
 * （不要求角色实体存在）；结果取整并钳到 [-100, 100]。
 */
export function reduceAffectionPatch(
  profile: Pick<ReducibleProfile, 'affections'>,
  patch: StatePatch,
): ReduceResult {
  if (!patch.target.startsWith(AFFECTION_PREFIX)) {
    throw new Error(`${patch.op} target 必须为 affections.<角色名> 格式: ${patch.target}`);
  }
  const charName = patch.target.slice(AFFECTION_PREFIX.length).trim();
  if (!charName) throw new Error(`${patch.op} target 缺少角色名: ${patch.target}`);
  if (patch.op === 'set_affection') {
    if (typeof patch.value !== 'number' || Number.isNaN(patch.value)) {
      throw new Error(`set_affection value 必须是数字: ${JSON.stringify(patch.value)}`);
    }
    profile.affections[charName] = clampAffection(patch.value);
  } else if (patch.op === 'delta_affection') {
    if (typeof patch.amount !== 'number' || Number.isNaN(patch.amount)) {
      throw new Error(`delta_affection amount 必须是数字: ${JSON.stringify(patch.amount)}`);
    }
    const current = profile.affections[charName] ?? 0;
    profile.affections[charName] = clampAffection(current + patch.amount);
  } else {
    throw new Error(`不是好感补丁: ${patch.op}`);
  }
  return { notes: [] };
}

/** add_news（规范 §8）：AI 只填 title(必) / content(必) / category?，账务字段由调用方给（铁律3）。 */
export function reduceAddNews(
  profile: { news: NewsItem[] },
  patch: StatePatch,
  stamp: { id: string; publishedAt: number },
): ReduceResult {
  const newsData = patch.value as { title?: string; content?: string; category?: string };
  if (!newsData?.title) throw new Error('add_news 缺少 title');
  if (!newsData.content) throw new Error('add_news 缺少 content');
  profile.news.push({
    title: newsData.title,
    content: newsData.content,
    category: newsData.category ?? '',
    id: stamp.id,
    publishedAt: stamp.publishedAt,
    read: false,
  });
  return { notes: [] };
}

// ---------- 人物增删与改名 ----------

/**
 * add_character：校验（id、非空名字、同存档同名查重 —— 同 id 重放不算撞名）→ 人物内容整理
 * （`prepareNewCharacter`）→ 追加进 `characters`（同 id 已在表里则不重复追加）。
 * saveId 注入是账务字段，由调用方负责。
 */
export function reduceAddCharacter(
  characters: CharacterState[],
  character: CharacterState,
  gameTime: Pick<GameTime, 'year' | 'month' | 'day'>,
): ReduceResult {
  if (!character?.id) throw new Error('缺少角色数据');
  // 名字是逻辑键（铁律1）: 非空必填
  const name = typeof character.name === 'string' ? character.name.trim() : '';
  if (!name) throw new Error('add_character 需要非空 name（名字是逻辑键，铁律1）');
  // 与 rename_character 查重口径一致；同一批里连着加两个同名角色，第二个在这里被拦下
  if (characters.some((c) => c.name === name && c.id !== character.id)) {
    throw new Error(`同名角色已存在: ${name}`);
  }
  const result = prepareNewCharacter(character, gameTime);
  if (!characters.some((c) => c.id === character.id)) characters.push(character);
  return result;
}

/** remove_character：把这个角色从 `characters` 里摘掉（按 id；生命周期策略在上游）。 */
export function reduceRemoveCharacter(
  characters: CharacterState[],
  character: CharacterState,
): ReduceResult {
  const idx = characters.findIndex((c) => c.id === character.id);
  if (idx >= 0) characters.splice(idx, 1);
  return { notes: [] };
}

/** rename_character 的结果：改没改名、好感有没有跟着搬（调用方据此决定落不落库）。 */
interface RenameResult extends ReduceResult {
  renamed: boolean;
  affectionMoved: boolean;
}

/**
 * rename_character — value = 新名（裸字符串）。新名 trim 后非空；与旧名相同 → no-op；
 * 同存档撞名（排除自身）→ throw；按名引用迁移：`affections[旧名]` 键搬到新名
 * （当前按名引用仅好感；任务叙事文本不迁移，接受陈旧）。
 */
export function reduceRenameCharacter(
  state: { characters: readonly CharacterState[]; profile: Pick<ReducibleProfile, 'affections'> },
  character: CharacterState,
  rawName: unknown,
): RenameResult {
  if (typeof rawName !== 'string') {
    throw new Error(`rename_character value 必须是新名字符串: ${JSON.stringify(rawName)}`);
  }
  const newName = rawName.trim();
  if (!newName) throw new Error('rename_character 新名不能为空');
  const oldName = character.name;
  if (newName === oldName) return { notes: [], renamed: false, affectionMoved: false };
  if (state.characters.some((c) => c.name === newName && c.id !== character.id)) {
    throw new Error(`rename_character 新名已被占用: ${newName}`);
  }
  character.name = newName;
  const affections = state.profile.affections;
  if (!affections || !Object.prototype.hasOwnProperty.call(affections, oldName)) {
    return { notes: [], renamed: true, affectionMoved: false };
  }
  affections[newName] = affections[oldName];
  delete affections[oldName];
  return { notes: [], renamed: true, affectionMoved: true };
}

// ---------- 总分发 ----------

/**
 * 把任意一条（本模块覆盖的）补丁作用到一份完整状态上（就地）。翻译层的工作状态与建补丁预演
 * 经这里推进；StateManager 的各 handler 直接调上面对应的单项函数（中间夹着各自的 I/O）。
 * 记忆、剧情事件、地块事实等不在状态切片里的 op → throw。
 */
export function reduceStatePatch(
  state: ReducibleState,
  patch: StatePatch,
  ctx: StateReduceContext,
): ReduceResult {
  if (isCharacterPatchOp(patch.op)) {
    return reduceCharacterPatch(resolveCharacterTarget(state.characters, patch.target), patch);
  }
  if (patch.op === 'delta_variable' && patch.target === 'profile.fp') {
    return reduceFatePointPatch(state.profile, patch, ctx.fatePoints);
  }
  if (VARIABLE_OPS.has(patch.op)) return reduceVariablePatch(state.profile, patch);
  switch (patch.op) {
    case 'transfer_item': {
      const from = resolveCharacterTarget(state.characters, patch.target);
      const request = readTransferItemRequest(patch);
      return reduceTransferItem(
        from,
        resolveCharacterByName(state.characters, request.to),
        request,
      );
    }
    case 'add_character':
      return reduceAddCharacter(
        state.characters,
        patch.value as CharacterState,
        state.profile.gameTime,
      );
    case 'remove_character':
      return reduceRemoveCharacter(
        state.characters,
        resolveCharacterTarget(state.characters, patch.target),
      );
    case 'rename_character':
      return reduceRenameCharacter(
        state,
        resolveCharacterTarget(state.characters, patch.target),
        patch.value,
      );
    case 'update_quest':
    case 'remove_quest':
      return reduceQuestPatch(state.profile, patch);
    case 'set_affection':
    case 'delta_affection':
      return reduceAffectionPatch(state.profile, patch);
    case 'add_news':
      return reduceAddNews(state.profile, patch, ctx.newsStamp());
    default:
      throw new Error(`状态切片不认识 ${patch.op}`);
  }
}
