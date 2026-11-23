import type {
  AgentResult,
  CharacterState,
  EntityGenOutput,
  EntityStatusOutput,
  StatePatch,
  StateUpdateRecord,
  StoryStage,
} from '../types/types';
import type { CharacterDefinition, CharacterNarrativeUpdate } from '../types/types-character';
import { isRecord, parseCharacterUpdates } from '../character/character-updates';
import {
  assembleCharacterState,
  bindGeneratedCharacter,
  buildEntityGenPatches,
} from './entity-gen-agent';
import {
  buildDispatcherPatches,
  buildQuestPatches,
  buildVarsUpdatePatches,
} from '../variables/vars-update-translator';
import { projectStoryOutput, STORY_ENVELOPE_TAGS } from '../story/story-output';
import type { DirectCombatOutput } from '../combat/direct-combat';
import type { DirectDicePool } from './direct-dice';
import { extractJsonPayload } from '../utils/model-json';
import {
  DIRECT_AFFECTION_OPERATIONS,
  DIRECT_ASCENSION_LIST_KEYS,
  DIRECT_ATTRIBUTE_KEYS,
  DIRECT_CHARACTER_FIELDS,
  DIRECT_CHARACTER_LIST_FIELDS,
  DIRECT_CHARACTER_OPERATIONS,
  DIRECT_CHARACTER_TEXT_FIELDS,
  DIRECT_DELTA_PATHS,
  DIRECT_EFFECT_ACTIONS,
  DIRECT_EFFECT_CATEGORIES,
  DIRECT_EFFECT_REMOVE_KEYS,
  DIRECT_EFFECT_ROW_KEYS,
  DIRECT_EFFECT_TIME_UNITS,
  DIRECT_EFFECT_UPDATE_KEYS,
  DIRECT_ENTITY_LIST_KEYS,
  DIRECT_ENTITY_OUTPUT_KEYS,
  DIRECT_ENTITY_ROW_KEYS,
  DIRECT_FORBIDDEN_KEYS,
  DIRECT_ITEM_MODIFY_KEYS,
  DIRECT_ITEM_OPERATIONS,
  DIRECT_PLOT_KEYS,
  DIRECT_QUEST_OPERATIONS,
  DIRECT_REMOVE_PATHS,
  DIRECT_SECTIONS,
  DIRECT_STATE_KEYS,
  DIRECT_STRIPPED_KEYS,
  DIRECT_WORLD_KEYS,
  DIRECT_WORLD_RESERVED_SEGMENTS,
} from './direct-contract';
import { normalizeDirectUpdates } from './direct-normalize';
import { normalizeSlot } from '../content/field-enums';
import { resolveCharacterByName } from '../state/patch-rules';
import { PatchRehearsal } from '../state/patch-rehearsal';
import { parseTreePatchBlock, type TreeOp, type TreeOpIssue } from '../variables/state-tree-patch';
import { translateTreeOps } from '../variables/state-tree-translator';
import type { StateTreeProfile } from '../variables/state-tree-projection';

type Row = Record<string, unknown>;
export interface DirectUpdates {
  version: 1;
  world: Row;
  time: { delta_time: number };
  entities: Array<
    | {
        kind: 'character';
        placement: { location: string; present: boolean };
        output: EntityGenOutput;
      }
    | { kind: 'loadout'; owner: string; output: EntityGenOutput }
  >;
  state: Row;
  effects: Array<{
    owner: string;
    action: 'add' | 'update' | 'remove';
    value: Partial<EntityStatusOutput> & { name: string };
  }>;
  plot: { pre?: Row; post?: Row };
  combat: DirectCombatOutput | null;
  /** 按 (骰面数, 组内下标) 定位骰池里的一颗骰 */
  diceUsed: Array<{ sides: number; index: number; purpose: string; target: string }>;
}

export interface DirectTurnDraft {
  content: string;
  options: string[];
  /** 正文分节（来自 projectStoryOutput；模型没写 `<beat/>` 时缺席） */
  stage?: StoryStage;
  characterUpdates: CharacterNarrativeUpdate[];
  updates: DirectUpdates;
  raw: string;
  /** 结构化战斗关闭时模型仍写了非 null 的 combat：已丢弃，仅供告警 */
  combatIgnored?: true;
  /** 模型把人物字段平铺在 entities[i].output 上（未放进 output.character）：已自动归位，仅供告警 */
  flattenedCharacters?: string[];
  /** 做过的无损纠正（中文，带路径），仅供告警；无纠正时缺席 */
  normalized?: string[];
  /**
   * 按最小单元丢弃的内容（中文，形如「模型原文路径：原因，已忽略」），仅供告警；无丢弃时缺席。
   * 正文与其余更新照常接纳。
   */
  dropped?: string[];
  /** 模型没写 direct_updates 区块（零个开标签）：按空更新接纳，仅供告警 */
  updatesMissing?: true;
  /**
   * 状态树协议（`stateProtocol: 'tree'`）下解析出的路径补丁；此时 `updates` 的 entities / state /
   * effects 恒为空，只承载 plot / diceUsed / tile_ops / combat 与旧写法 time。
   * 缺席 = 旧协议形状（含 tree 下回落到旧解析器的楼）。
   */
  treePatch?: DirectTreePatch;
}

/** 状态树协议下一楼的路径补丁（`parseTreePatchBlock` 的产物，翻译在 `buildDirectPatches`）。 */
interface DirectTreePatch {
  ops: readonly TreeOp[];
  /** 逐条 op 的解析期纠正（按 op 序号并进翻译记录）；整块级纠正已并入草稿 `normalized` */
  normalized: readonly TreeOpIssue[];
}

export interface ParseDirectOutputOptions {
  /**
   * 状态协议；缺省 legacy（逐字节沿用 v1 解析）。tree 下认 `{"version":2,"patch":[…]}`，
   * 旧形状回落到 v1 解析并记一条纠正，原型污染键或一条 op 都没救回时整楼拒收。
   */
  stateProtocol?: 'legacy' | 'tree';
  /** 是否启用结构化战斗；缺省 true（严格校验 combat 区块） */
  structuredCombat?: boolean;
  /** 剧情系统是否启用；缺省 true。关闭时模型写的非空 plot 被丢弃（记入 normalized） */
  plotEnabled?: boolean;
}

/** 模型可见正文为空（含纯空白）：常见于只产出原生思考、没写正文的回复 */
export function isEmptyDirectReply(raw: string | null | undefined): boolean {
  return !raw?.trim();
}

/** 结束原因表示输出预算已用尽（length / max_tokens）：重试会再烧一整份预算，故不重试 */
export function isDirectOutputBudgetExhausted(finishReason: string | undefined): boolean {
  const reason = finishReason?.toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * 空正文的报错文案。🔴 前缀「模型返回了空正文」是契约：UI 的失败分类按它识别，别改字。
 * 写「输出 N token」而不是「token: N」——后者会被 redactSecrets 当凭据抹掉。
 */
export function describeEmptyDirectReply(
  result: Pick<AgentResult, 'reasoning' | 'finishReason' | 'completionTokens'>,
  retried: boolean,
): string {
  const reasoning = result.reasoning?.trim() ?? '';
  const head = reasoning
    ? `模型返回了空正文：只输出了思考（约 ${reasoning.length} 字），没有写出正文。`
    : '模型返回了空正文：没有任何输出。';
  const tokens =
    typeof result.completionTokens === 'number' ? `；输出 ${result.completionTokens} token` : '';
  const tail = retried
    ? '已自动重试 1 次仍为空。'
    : isDirectOutputBudgetExhausted(result.finishReason)
      ? '已达到输出上限，未自动重试，可调高输出上限后重试。'
      : '';
  return `${head}结束原因：${result.finishReason || '未知'}${tokens}。${tail}`;
}

/**
 * 最小单元的校验失败：由最近的 `attempt` / `salvageRows` 接住，删掉那个单元并记入 dropped。
 * 不在任何 attempt 里抛出的（结构外壳）照旧冒到调用方，整楼拒收（fail-closed）。
 */
class DirectUnitError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DirectUnitError(message);
}

/** 必须整楼拒收的错误（不被任何 attempt 接住）；文案前缀「直出结果无效：」是契约 */
function fatal(message: string): never {
  throw new Error(`直出结果无效：${message}`);
}

/** 一次解析过程中累积的两类记录 */
interface Notes {
  /** 无损纠正 */
  normalized: string[];
  /** 有损丢弃 */
  dropped: string[];
}

/** 「路径：原因，已忽略」；原因若以同一路径开头则只留相对部分，避免路径写两遍 */
function dropNote(path: string, reason: string): string {
  const rest = reason.slice(path.length);
  const detail =
    reason.startsWith(path) && /^[.\s[]/.test(rest) ? rest.replace(/^[.\s]+/, '') : reason;
  return `${path}：${detail}，已忽略`;
}

/**
 * 跑一个单元的校验；单元失败时调用 onFail（删掉该单元）并记 dropped，返回是否通过。
 * 一个单元只记一条：单元被丢时，它内部已记的剥键 / 子单元说明一并撤回，只留最终结果。
 */
function attempt(notes: Notes, path: string, run: () => void, onFail?: () => void): boolean {
  const mark = notes.dropped.length;
  try {
    run();
    return true;
  } catch (error) {
    if (!(error instanceof DirectUnitError)) throw error;
    onFail?.();
    notes.dropped.length = mark;
    notes.dropped.push(dropNote(path, error.message));
    return false;
  }
}

/**
 * 逐行校验一个数组：不是对象、含账务键 / 非有限数值、或 validate 失败的行被删掉。
 * 就地替换数组内容（buildDirectPatches 读的是同一个对象），note 下标指模型原文。
 * 跨行登记（去重集合）必须写在 validate 的最后，保证只有通过的行才登记。
 */
function salvageRows(
  notes: Notes,
  list: unknown[],
  path: string,
  validate: (row: Row, label: string) => void,
): Row[] {
  const kept: unknown[] = [];
  list.forEach((row, i) => {
    const label = `${path}[${i}]`;
    const ok = attempt(notes, label, () => {
      check(isRecord(row), '不是对象');
      unitSafe(row, label);
      validate(row, label);
    });
    if (ok) kept.push(row);
  });
  if (kept.length !== list.length) list.splice(0, list.length, ...kept);
  return list as Row[];
}

/**
 * 取 container[key] 作数组：缺失视为空（不往对象上加键）。null 或给了但不是数组时，
 * `empty` 模式换成 []、`delete` 模式删键；非 null 的错类型记 dropped。
 */
function arrayField(
  notes: Notes,
  container: Row,
  key: string,
  label: string,
  mode: 'empty' | 'delete',
): unknown[] {
  const value = container[key];
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  if (value !== null) notes.dropped.push(dropNote(`${label}.${key}`, '必须是数组'));
  if (mode === 'empty') {
    container[key] = [];
    return container[key] as unknown[];
  }
  delete container[key];
  return [];
}

/** 报错里最多列出的多余键数 */
const MAX_LISTED_KEYS = 5;
/** 单个键名在报错里的最大长度，超出截断加「…」 */
const MAX_KEY_LENGTH = 24;

/** 白名单常量是 readonly 元组；判定时按普通字符串集合用 */
function among(list: readonly string[], value: unknown): boolean {
  return list.includes(String(value));
}

/** 剥掉白名单外的键并记 dropped（最多列 5 个键名，单个键名按码点截断到 24 字） */
function stripKeys(notes: Notes, value: Row, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return;
  for (const key of extra) delete value[key];
  const listed = extra
    .slice(0, MAX_LISTED_KEYS)
    .map((key) => {
      // 按码点截断，避免切开代理对留下孤立代理项
      const chars = Array.from(key);
      return chars.length > MAX_KEY_LENGTH ? `${chars.slice(0, MAX_KEY_LENGTH).join('')}…` : key;
    })
    .join('、');
  const more = extra.length > MAX_LISTED_KEYS ? ` 等 ${extra.length} 个` : '';
  notes.dropped.push(`${label}：含未支持的字段 ${listed}${more}，已剥除`);
}

function named(value: unknown, label?: string): asserts value is string {
  check(
    typeof value === 'string' && value.trim().length > 0,
    label ? `${label} 名字／引用不能为空` : '名字／引用不能为空',
  );
}

function object(value: unknown, label: string): Row {
  check(isRecord(value), `${label} 必须是对象`);
  return value;
}

/** 原型污染键：任何层级出现即整楼拒收 */
function rejectForbidden(value: unknown): void {
  if (Array.isArray(value)) value.forEach(rejectForbidden);
  else if (isRecord(value))
    for (const [key, child] of Object.entries(value)) {
      if (among(DIRECT_FORBIDDEN_KEYS, key)) fatal(`不允许模型填写 ${key}`);
      rejectForbidden(child);
    }
}

/**
 * 单元内的值检查：数值必须有限；账务键（结构化位置已在归一化里剥除，
 * 剩下的只会在 world value 等自由内容里）不许出现。失败只丢这个单元。
 */
function unitSafe(value: unknown, label: string): void {
  if (typeof value === 'number') check(Number.isFinite(value), `${label} 数值必须有限`);
  if (Array.isArray(value)) value.forEach((child, i) => unitSafe(child, `${label}[${i}]`));
  else if (isRecord(value))
    for (const [key, child] of Object.entries(value)) {
      check(!among(DIRECT_STRIPPED_KEYS, key), `不允许模型填写 ${key}`);
      unitSafe(child, `${label}.${key}`);
    }
}

/** 战斗块整体检查（结构化战斗开启时战斗数值坏了整楼拒收） */
function rejectUnsafeCombat(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) fatal('combat 含非有限数值');
  if (Array.isArray(value)) value.forEach(rejectUnsafeCombat);
  else if (isRecord(value)) Object.values(value).forEach(rejectUnsafeCombat);
}

/** world path 的禁用段：原型污染键 + 系统状态段 */
const WORLD_RESERVED_PATH = new RegExp(
  String.raw`(^|\.)(${[...DIRECT_FORBIDDEN_KEYS, ...DIRECT_WORLD_RESERVED_SEGMENTS].join('|')})(\.|$)`,
);

/** 原样记下实体行在模型原文中的路径，供 buildDirectPatches 丢弃时写 note */
const ENTITY_PATHS = new WeakMap<object, string>();
/** 同上，effects 行 */
const EFFECT_PATHS = new WeakMap<object, string>();

/** 随身条目（技能／装备／背包）：列表不是数组换成 []，坏条目逐条丢 */
function validateCarried(notes: Notes, output: Row, label: string): void {
  for (const key of DIRECT_ENTITY_LIST_KEYS) {
    const list = arrayField(notes, output, key, label, 'empty');
    salvageRows(notes, list, `${label}.${key}`, (item, itemLabel) => {
      named(item.name, `${itemLabel}.name`);
      check(typeof item.description === 'string', '缺少 description');
      if (key === 'inventory')
        check(Number.isInteger(item.quantity) && Number(item.quantity) > 0, '物品数量必须为正整数');
      if (key === 'equipment') {
        named(item.slot, `${itemLabel}.slot`);
        object(item.stats, '装备属性');
      }
      if (item.tags !== undefined)
        check(
          Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string'),
          'tags 必须是文本数组',
        );
      if (item.protocolText !== undefined)
        check(typeof item.protocolText === 'string', 'protocolText 必须是文本');
      // replace 是「被替换的条目名」：写成 true 之类会产出 remove_item {name: true}，提交时必抛
      if (item.replace === null) delete item.replace;
      else if (item.replace !== undefined) named(item.replace, `${itemLabel}.replace`);
    });
  }
}

/**
 * 一个实体行。种类 / 人物核心（name、tier、level、attributes）/ placement / loadout owner
 * 坏了整个实体丢弃；其余（多余键、随身条目、人物文本字段、状态）按更小单元丢。
 * 返回该实体初始状态的「归属/名字」键，调用方在实体通过后登记。
 */
function validateEntityRow(
  notes: Notes,
  row: Row,
  label: string,
  effectOwners: ReadonlySet<string>,
): string[] {
  const kind = row.kind;
  check(kind === 'character' || kind === 'loadout', '实体种类无效');
  const character = kind === 'character';
  stripKeys(notes, row, DIRECT_ENTITY_ROW_KEYS[kind], label);
  const outputLabel = `${label}.output`;
  const output = object(row.output, outputLabel);
  let owner: string;
  let c: Row | undefined;
  if (character) {
    const placement = object(row.placement, 'placement');
    named(placement.location, `${label}.placement.location`);
    check(typeof placement.present === 'boolean', 'placement.present 缺失');
    c = object(output.character, '人物');
    named(c.name, `${outputLabel}.character.name`);
    check(Number.isInteger(c.tier) && Number(c.tier) >= 1 && Number(c.tier) <= 7, '人物层级无效');
    check(
      Number.isInteger(c.level) && Number(c.level) >= 1 && Number(c.level) <= 25,
      '人物等级无效',
    );
    const attrs = object(c.attributes, '人物属性');
    for (const attr of DIRECT_ATTRIBUTE_KEYS)
      check(typeof attrs[attr] === 'number' && Number(attrs[attr]) >= 0, `缺少属性 ${attr}`);
    // 登神形状已在归一化 N5 逐项纠正；仍不完整说明归一化之外的形状，丢整个实体
    const ascension = object(c.ascension, '登神状态');
    check(
      typeof ascension.enabled === 'boolean' &&
        typeof ascension.path === 'string' &&
        typeof ascension.description === 'string' &&
        DIRECT_ASCENSION_LIST_KEYS.every((key) => Array.isArray(ascension[key])),
      '登神状态不完整',
    );
    owner = c.name;
  } else {
    named(row.owner, `${label}.owner`);
    owner = row.owner;
    if (output.character !== undefined) {
      delete output.character;
      notes.dropped.push(dropNote(`${outputLabel}.character`, '归属物不能再次创建人物'));
    }
  }
  stripKeys(notes, output, DIRECT_ENTITY_OUTPUT_KEYS, outputLabel);
  validateCarried(notes, output, outputLabel);
  if (c) {
    const characterLabel = `${outputLabel}.character`;
    for (const key of DIRECT_CHARACTER_TEXT_FIELDS)
      if (typeof c[key] !== 'string') {
        c[key] = '';
        notes.dropped.push(`${characterLabel}.${key}：不是文本，已置为空串`);
      }
    for (const key of DIRECT_CHARACTER_LIST_FIELDS) {
      const list = c[key];
      if (!Array.isArray(list) || !list.every((v) => typeof v === 'string')) {
        c[key] = [];
        notes.dropped.push(`${characterLabel}.${key}：不是文本数组，已置为空数组`);
      }
    }
    validateCarried(notes, c, characterLabel);
  }
  const claimed: string[] = [];
  const statuses = arrayField(notes, output, 'statuses', outputLabel, 'empty');
  salvageRows(notes, statuses, `${outputLabel}.statuses`, (status, statusLabel) => {
    named(status.name, `${statusLabel}.name`);
    named(status.owner, `${statusLabel}.owner`);
    check(status.owner === owner, '实体初始状态的归属错误');
    const key = `${owner}/${status.name}`;
    check(!effectOwners.has(key) && !claimed.includes(key), '状态效果重复声明');
    claimed.push(key);
  });
  return claimed;
}

/** 一个 state 子键：不是对象删掉；剥未知操作键；操作值不是数组删掉那个操作 */
function stateSection(
  notes: Notes,
  state: Row,
  key: string,
  operations: readonly string[],
): Row | undefined {
  const label = `state.${key}`;
  if (state[key] === undefined) return undefined;
  if (state[key] === null) {
    delete state[key];
    notes.normalized.push(`${label}：为 null，已删除`);
    return undefined;
  }
  if (!isRecord(state[key])) {
    delete state[key];
    notes.dropped.push(dropNote(label, '必须是对象'));
    return undefined;
  }
  const section = state[key] as Row;
  stripKeys(notes, section, operations, label);
  for (const op of Object.keys(section))
    if (section[op] === null) {
      delete section[op];
      notes.normalized.push(`${label}.${op}：为 null，已删除`);
    } else arrayField(notes, section, op, label, 'delete');
  return section;
}

function validateState(notes: Notes, state: Row): void {
  stripKeys(notes, state, DIRECT_STATE_KEYS, 'state');
  const chars = stateSection(notes, state, 'characters', DIRECT_CHARACTER_OPERATIONS);
  const owned = new Set<string>();
  if (chars)
    for (const operation of DIRECT_CHARACTER_OPERATIONS) {
      if (!Array.isArray(chars[operation])) continue;
      salvageRows(notes, chars[operation], `state.characters.${operation}`, (row, label) => {
        named(row.name, `${label}.name`);
        const key = `${row.name}/${row.path}/${operation === 'remove' ? row.target : ''}`;
        check(!owned.has(key), '人物字段重复声明');
        if (operation === 'remove') {
          check(
            among(DIRECT_REMOVE_PATHS, row.path),
            'state.characters.remove 只支持 skills／equipment（状态效果走 effects）',
          );
          named(row.target, `${label}.target`);
        } else {
          check(among(DIRECT_CHARACTER_FIELDS, row.path), '人物字段不属于 direct state 白名单');
          if (operation === 'delta')
            check(
              among(DIRECT_DELTA_PATHS, row.path) && typeof row.amount === 'number',
              'delta 只能用于资源／金钱／经验',
            );
          else if (row.path === 'present')
            check(typeof row.value === 'boolean', 'present 必须是布尔值');
          else if (among(DIRECT_DELTA_PATHS, row.path))
            check(typeof row.value === 'number' && Number(row.value) >= 0, '资源值无效');
          else check(typeof row.value === 'string', '人物字段必须为文本');
        }
        owned.add(key);
      });
    }
  const items = stateSection(notes, state, 'items', DIRECT_ITEM_OPERATIONS);
  if (items)
    for (const [op, list] of Object.entries(items))
      salvageRows(notes, list as unknown[], `state.items.${op}`, (row, label) => {
        named(row.target, `${label}.target`);
        if (op === 'transfer') {
          named(row.from, `${label}.from`);
          named(row.to, `${label}.to`);
        } else named(row.owner, `${label}.owner`);
        if (op === 'consume' || op === 'transfer')
          check(
            Number.isInteger(row.quantity) && Number(row.quantity) > 0,
            '消耗／转移数量必须为正整数',
          );
        if (op === 'equip') {
          named(row.slot, `${label}.slot`);
          // 槽位枚举与提交时同一份（field-enums.normalizeSlot）
          check(normalizeSlot(row.slot) !== null, `无法识别的装备槽位：${row.slot}`);
        }
        if (op === 'modify') {
          const changes = object(row.changes, '物品修改');
          stripKeys(notes, changes, DIRECT_ITEM_MODIFY_KEYS, `${label}.changes`);
          check(Object.keys(changes).length > 0, '物品修改没有可改的字段');
        }
      });
  const affections = stateSection(notes, state, 'affections', DIRECT_AFFECTION_OPERATIONS);
  if (affections)
    for (const [op, list] of Object.entries(affections))
      salvageRows(notes, list as unknown[], `state.affections.${op}`, (row, label) => {
        named(row.name, `${label}.name`);
        check(typeof row[op === 'set' ? 'value' : 'amount'] === 'number', '好感度必须为数值');
      });
  if (Object.prototype.hasOwnProperty.call(state, 'fp')) {
    const fp = state.fp;
    const noDelta = isRecord(fp) && (fp.delta === undefined || fp.delta === null);
    // 「没有命运点变化」的真空写法：null / {} / {delta:null} —— 删键，不记 note
    if (fp === null || fp === undefined || (noDelta && Object.keys(fp).every((k) => k === 'delta')))
      delete state.fp;
    else if (noDelta) {
      // 写了别的键（如 {amount:-3}）却没有 delta：意图可能是改命运点，丢掉是有损的
      delete state.fp;
      notes.dropped.push(dropNote('state.fp', '缺少 delta'));
    } else if (!isRecord(fp)) {
      delete state.fp;
      notes.dropped.push(dropNote('state.fp', '必须是对象'));
    } else if (typeof fp.delta !== 'number' || !Number.isFinite(fp.delta)) {
      delete state.fp;
      notes.dropped.push(dropNote('state.fp', 'fp.delta 必须为数值'));
    } else stripKeys(notes, fp, ['delta'], 'state.fp');
  }
  const quests = stateSection(notes, state, 'quests', DIRECT_QUEST_OPERATIONS);
  if (quests)
    for (const [op, list] of Object.entries(quests))
      salvageRows(notes, list as unknown[], `state.quests.${op}`, (row, label) =>
        named(row.name, `${label}.name`),
      );
}

/** 合规空白的 direct_updates（模型没写 direct_updates 区块时使用） */
function emptyUpdates(): Row {
  return {
    version: 1,
    world: {},
    time: { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: {},
    combat: null,
    diceUsed: [],
  };
}

/** 顶层分区的期望形状 */
const SECTION_SHAPES: Array<[string, 'object' | 'array', () => unknown]> = [
  ['world', 'object', () => ({})],
  ['time', 'object', () => ({ delta_time: 0 })],
  ['entities', 'array', () => []],
  ['state', 'object', () => ({})],
  ['effects', 'array', () => []],
  ['plot', 'object', () => ({})],
  ['diceUsed', 'array', () => []],
];

/** 归一化之后的逐单元校验（就地改写 parsed） */
function validateUpdates(
  parsed: Row,
  pool: DirectDicePool,
  notes: Notes,
  structuredCombat: boolean,
): void {
  rejectForbidden(parsed);
  stripKeys(notes, parsed, DIRECT_SECTIONS, 'direct_updates');
  if (parsed.version !== 1) {
    notes.dropped.push(
      `direct_updates.version：不支持的版本 ${JSON.stringify(parsed.version)}，已按 1 处理`,
    );
    parsed.version = 1;
  }
  if (structuredCombat) {
    if (!Object.prototype.hasOwnProperty.call(parsed, 'combat'))
      fatal('v1 分区不完整（结构化战斗开启时必须写 combat，无战斗写 null）');
    if (parsed.combat !== null) {
      if (!isRecord(parsed.combat)) fatal('combat 必须是对象');
      rejectUnsafeCombat(parsed.combat);
    }
  }
  for (const [key, shape, make] of SECTION_SHAPES) {
    const value = parsed[key];
    if (shape === 'array' ? Array.isArray(value) : isRecord(value)) continue;
    // 空 {} / [] 写成另一种：无损纠正；非空的错类型：内容丢弃
    const empty =
      (Array.isArray(value) && value.length === 0) ||
      (isRecord(value) && Object.keys(value).length === 0);
    parsed[key] = make();
    if (empty)
      notes.normalized.push(
        `direct_updates.${key}：空值类型不符，已改为空${shape === 'array' ? '数组' : '对象'}`,
      );
    else
      notes.dropped.push(
        dropNote(`direct_updates.${key}`, `必须是${shape === 'array' ? '数组' : '对象'}`),
      );
  }

  const time = parsed.time as Row;
  stripKeys(notes, time, ['delta_time'], 'time');
  if (time.delta_time === undefined || time.delta_time === null) {
    time.delta_time = 0;
    notes.normalized.push('time.delta_time：缺失，已补 0');
  } else if (
    typeof time.delta_time !== 'number' ||
    !Number.isFinite(time.delta_time) ||
    time.delta_time < 0
  ) {
    notes.dropped.push('time.delta_time：必须是非负分钟数，已按 0 处理');
    time.delta_time = 0;
  }

  const world = parsed.world as Row;
  stripKeys(notes, world, DIRECT_WORLD_KEYS, 'world');
  for (const op of ['replace', 'insert']) {
    const list = arrayField(notes, world, op, 'world', 'delete');
    // 系统状态段是整楼拒收：先于逐行丢弃扫一遍，免得被别的单元错误掩盖
    for (const row of list)
      if (isRecord(row) && typeof row.path === 'string' && WORLD_RESERVED_PATH.test(row.path))
        fatal(`world 不能写系统状态（${row.path}）`);
    salvageRows(notes, list, `world.${op}`, (row, label) => {
      named(row.path, `${label}.path`);
      check(Object.prototype.hasOwnProperty.call(row, 'value'), '缺少 value');
    });
  }
  salvageRows(
    notes,
    arrayField(notes, world, 'tile_ops', 'world', 'delete'),
    'world.tile_ops',
    (row) =>
      check(buildDispatcherPatches({ tile_ops: [row] }).patches.length === 1, '地块操作无效'),
  );

  // 实体初始状态之间在这里去重；它们与 effects 行的撞名要看实体建补丁时是否真被留下，
  // 在 buildDirectPatches 里判（实体可能在那一步才被丢）
  const statusOwners = new Set<string>();
  salvageRows(notes, parsed.entities as unknown[], 'entities', (row, label) => {
    const claimed = validateEntityRow(notes, row, label, statusOwners);
    for (const key of claimed) statusOwners.add(key);
    ENTITY_PATHS.set(row, label);
  });
  const effectOwners = new Set<string>();

  validateState(notes, parsed.state as Row);

  salvageRows(notes, parsed.effects as unknown[], 'effects', (effect, label) => {
    stripKeys(notes, effect, DIRECT_EFFECT_ROW_KEYS, label);
    named(effect.owner, `${label}.owner`);
    check(among(DIRECT_EFFECT_ACTIONS, effect.action), '效果动作无效');
    const value = object(effect.value, '效果');
    named(value.name, `${label}.value.name`);
    if (effect.action === 'add') {
      check(
        typeof value.description === 'string' && among(DIRECT_EFFECT_CATEGORIES, value.category),
        '效果缺少描述／分类',
      );
      check(typeof value.stacks === 'number' && value.stacks > 0, '效果层数无效');
      check(
        value.remainingTime === null ||
          (typeof value.remainingTime === 'number' && value.remainingTime >= 0),
        '效果时长无效',
      );
      check(among(DIRECT_EFFECT_TIME_UNITS, value.timeUnit), '效果时间单位无效');
    }
    if (effect.action === 'update') {
      stripKeys(notes, value, DIRECT_EFFECT_UPDATE_KEYS, `${label}.value`);
      check(Object.keys(value).length > 1, '效果更新只能改 remainingTime／stacks');
    }
    if (effect.action === 'remove')
      stripKeys(notes, value, DIRECT_EFFECT_REMOVE_KEYS, `${label}.value`);
    const key = `${effect.owner}/${value.name}`;
    check(!effectOwners.has(key), '状态效果重复声明');
    effectOwners.add(key);
    EFFECT_PATHS.set(effect, label);
  });

  const plot = parsed.plot as Row;
  stripKeys(notes, plot, DIRECT_PLOT_KEYS, 'plot');
  for (const key of Object.keys(plot))
    attempt(
      notes,
      `plot.${key}`,
      () => {
        object(plot[key], '剧情判断');
        unitSafe(plot[key], `plot.${key}`);
      },
      () => delete plot[key],
    );

  const consumed = new Set<string>();
  salvageRows(notes, parsed.diceUsed as unknown[], 'diceUsed', (die, label) => {
    const group = Number.isInteger(die.sides) ? pool.find((g) => g.sides === die.sides) : undefined;
    check(group, '骰面数不在骰池中');
    check(
      Number.isInteger(die.index) &&
        Number(die.index) >= 0 &&
        Number(die.index) < group.values.length,
      `骰索引超出 d${group.sides} 骰组范围`,
    );
    const key = `${group.sides}/${Number(die.index)}`;
    check(!consumed.has(key), '重复使用了同一颗骰');
    named(die.purpose, `${label}.purpose`);
    named(die.target, `${label}.target`);
    consumed.add(key);
  });
}

export function parseDirectOutput(
  raw: string,
  pool: DirectDicePool,
  options: ParseDirectOutputOptions = {},
): DirectTurnDraft {
  const structuredCombat = options.structuredCombat ?? true;
  const plotEnabled = options.plotEnabled ?? true;
  const opens = [...raw.matchAll(/<direct_updates\b/gi)].length;
  const blocks = [...raw.matchAll(/<direct_updates\s*>([\s\S]*?)<\/direct_updates\s*>/gi)];
  // 一个开标签都没有：当作「本楼无状态变化」接纳（updatesMissing 供告警）；
  // 写了但不完整 / 多于一个，意图不明，整楼拒收
  const updatesMissing = opens === 0;
  if (!updatesMissing && (blocks.length !== 1 || opens !== 1))
    fatal('需要一个完整的 direct_updates 区块');
  // 正文信封认 maintext 与同义的 gametxt：每种开标签至多一个、至少出现一种，
  // 出现的那几种都要有对应闭标签（单 maintext / 单 gametxt / 两种各一嵌套或并列均可）
  const envelopeCounts = STORY_ENVELOPE_TAGS.map((tag) => ({
    tag,
    opens: [...raw.matchAll(new RegExp(String.raw`<${tag}\b`, 'gi'))].length,
  }));
  if (!(
    envelopeCounts.some(({ opens }) => opens > 0) &&
    envelopeCounts.every(
      ({ tag, opens }) =>
        opens === 0 || (opens === 1 && new RegExp(String.raw`<\/${tag}\s*>`, 'i').test(raw)),
    )
  ))
    fatal('需要一个完整的 maintext（或 gametxt）区块');
  const notes: Notes = { normalized: [], dropped: [] };
  let parsed: Row;
  let combatIgnored = false;
  let flattenedCharacters: string[] = [];
  let treePatch: DirectTreePatch | undefined;
  const tree = !updatesMissing && options.stateProtocol === 'tree';
  const treeResult = tree ? parseTreePatchBlock(blocks[0][1]) : undefined;
  if (treeResult?.kind === 'rejected') fatal(treeResult.reason);
  if (treeResult?.kind === 'unparseable') fatal(`direct_updates ${treeResult.reason}`);
  if (treeResult?.kind === 'legacy')
    // 并存期回落（设计 §2）：tree 下模型仍写了旧形状，交给旧解析器，记一条纠正
    notes.normalized.push(`direct_updates：${treeResult.note}`);
  if (updatesMissing) parsed = emptyUpdates();
  else if (treeResult?.kind === 'patch') {
    // 只在整段 JSON 写坏、逐元素恢复后一条都没救回时整楼拒收（§5.4）；JSON 完好时坏 op 只丢那一条
    if (treeResult.nothingRecovered)
      fatal('direct_updates 整段 JSON 写坏了，逐条恢复后一条操作都没能救回');
    for (const issue of treeResult.dropped)
      notes.dropped.push(dropNote(treeIssueLabel(issue), issue.message));
    // 整块级的纠正直接记；逐条的交给翻译层并进那条 op 的记录（translateTreeOps 的 parseNormalized）
    for (const issue of treeResult.normalized)
      if (issue.index < 0) notes.normalized.push(`direct_updates：${issue.message}`);
    treePatch = {
      ops: treeResult.ops,
      normalized: treeResult.normalized.filter((issue) => issue.index >= 0),
    };
    // 信封（plot / diceUsed / tile_ops / combat / 旧写法 time）装进 v1 骨架，复用既有归一化与逐单元校验
    parsed = treeEnvelopeUpdates(treeResult.envelope, notes, structuredCombat);
    if (!structuredCombat) {
      combatIgnored = parsed.combat !== null && parsed.combat !== undefined;
      delete parsed.combat;
    }
    const normalization = normalizeDirectUpdates(parsed, { structuredCombat, plotEnabled });
    notes.normalized.push(...normalization.notes);
    notes.dropped.push(...normalization.dropped);
    validateUpdates(parsed, pool, notes, structuredCombat);
  } else {
    // N1：内文先过 JSON 抢救入口，剥掉 ```json 围栏、<json> 标签或 JSON 之前夹带的说明文字
    // （以 { 开头的内文按整段解析，JSON 之后跟文字不剥，照旧拒收为非法 JSON）
    const inner = blocks[0][1];
    const payload = extractJsonPayload(inner) ?? inner;
    if (payload !== inner.trim())
      notes.normalized.push('direct_updates：已剥除 JSON 外的围栏或说明文字');
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch (error) {
      fatal(
        `direct_updates 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    if (!isRecord(json)) fatal('direct_updates 必须是对象');
    parsed = json;
    // 结构化战斗关闭：combat 区块一律丢弃（不校验、不要求存在），只记下模型是否写了非 null 内容
    if (!structuredCombat) {
      combatIgnored =
        Object.prototype.hasOwnProperty.call(parsed, 'combat') &&
        parsed.combat !== null &&
        parsed.combat !== undefined;
      delete parsed.combat;
    }
    // 无损纠正：就地改写 parsed（buildDirectPatches 读的是同一个对象）；关闭战斗时这里补回 combat: null
    const normalization = normalizeDirectUpdates(parsed, { structuredCombat, plotEnabled });
    notes.normalized.push(...normalization.notes);
    notes.dropped.push(...normalization.dropped);
    flattenedCharacters = normalization.flattenedCharacters;
    validateUpdates(parsed, pool, notes, structuredCombat);
  }
  // character_updates 坏了不再拒收整楼：解析告警记入 dropped，无损纠正并入 normalized
  const character = parseCharacterUpdates(raw);
  if (!character.present)
    notes.dropped.push('character_updates：缺少 character_updates 区块，已忽略');
  notes.dropped.push(...character.warnings.map((warning) => `character_updates：${warning}`));
  notes.normalized.push(...character.notes.map((note) => `character_updates：${note}`));
  const projection = projectStoryOutput(raw);
  if (projection.content.length === 0) fatal('正文为空');
  return {
    ...projection,
    raw,
    characterUpdates: character.updates,
    updates: parsed as unknown as DirectUpdates,
    ...(combatIgnored ? { combatIgnored: true as const } : {}),
    ...(flattenedCharacters.length > 0 ? { flattenedCharacters } : {}),
    ...(notes.normalized.length > 0 ? { normalized: notes.normalized } : {}),
    ...(notes.dropped.length > 0 ? { dropped: notes.dropped } : {}),
    ...(updatesMissing ? { updatesMissing: true as const } : {}),
    ...(treePatch ? { treePatch } : {}),
  };
}

/** 状态树信封里认的键：plot / diceUsed / tile_ops / combat 缺了按空处理；time 是旧写法 `time.delta_time`。 */
const TREE_ENVELOPE_KEYS = ['version', 'plot', 'diceUsed', 'tile_ops', 'combat', 'time'] as const;
/** 与 patch 并存的旧字段：区块解析已记过「只按 patch 处理」，这里静默剥掉不重复记 */
const TREE_LEGACY_ENVELOPE_KEYS = ['state', 'entities', 'effects'] as const;

/** 树补丁一条解析问题的原文路径（缺路径时按 patch 下标或整块标注） */
function treeIssueLabel(issue: TreeOpIssue): string {
  if (issue.path) return issue.path;
  return issue.index >= 0 ? `direct_updates.patch[${issue.index}]` : 'direct_updates';
}

/**
 * 状态树信封 → v1 形状的骨架（entities / state / effects 恒为空，状态变化全在 `treePatch`），
 * 供 `normalizeDirectUpdates` + `validateUpdates` 复用 plot / diceUsed / tile_ops / combat 的既有校验。
 * 逐元素恢复时信封为 null，按全空处理。
 */
function treeEnvelopeUpdates(
  envelope: Readonly<Row> | null,
  notes: Notes,
  structuredCombat: boolean,
): Row {
  const source: Row = { ...(envelope ?? {}) };
  for (const key of TREE_LEGACY_ENVELOPE_KEYS) delete source[key];
  if (source.version !== undefined && source.version !== 2)
    notes.normalized.push(
      `direct_updates.version：状态树协议应为 2，收到 ${JSON.stringify(source.version)}，已按 2 处理`,
    );
  stripKeys(notes, source, TREE_ENVELOPE_KEYS, 'direct_updates');
  const has = (key: string) => source[key] !== undefined && source[key] !== null;
  return {
    version: 1,
    world: has('tile_ops') ? { tile_ops: source.tile_ops } : {},
    time: has('time') ? source.time : { delta_time: 0 },
    entities: [],
    state: {},
    effects: [],
    plot: has('plot') ? source.plot : {},
    // 结构化战斗开启时 v1 要求显式 combat；树协议缺了按 null（无在办战斗）处理
    combat: Object.prototype.hasOwnProperty.call(source, 'combat')
      ? source.combat
      : structuredCombat
        ? null
        : undefined,
    diceUsed: has('diceUsed') ? source.diceUsed : [],
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 按名寻址角色（与提交时同一份规则，含别名与「主角／玩家」）；找不到返回 undefined */
function findCharacter(
  characters: readonly CharacterState[],
  key: string,
): CharacterState | undefined {
  try {
    return resolveCharacterByName(characters, key);
  } catch {
    return undefined;
  }
}

/** 只装一条替换条目用的空归属物输出 */
const EMPTY_LOADOUT: EntityGenOutput = { skills: [], equipment: [], inventory: [], statuses: [] };

/** 实体输出里的初始状态名 */
function statusNames(output: EntityGenOutput): string[] {
  return (output.statuses ?? []).map((status) => status.name);
}

/**
 * 草稿 → 状态补丁。人物已存在 / 组装失败、loadout 归属不存在 / 组装失败 / 替换目标不在身上、
 * character_updates 指向不存在的人物、effects 与已留下实体的初始状态撞名、
 * 以及提交时注定抛错的补丁（静态形状、引用的人物、物品 / 技能不存在等，规则与提交时同一份）——
 * 都只丢那一项并记入 `dropped`，由此截断「实体被丢 → 引用它的更新」的连锁。
 */
export interface DirectPatchInput {
  characters: CharacterState[];
  definitions: CharacterDefinition[];
  sourceTurnKey: string;
  /**
   * 存档档案（命运点数 / 任务 / 新闻 / 变量 / 时间 / 好感度）。状态树协议的草稿（`draft.treePatch`）
   * 必须提供：路径解析与翻译对的是完整内核状态；legacy 草稿忽略。
   */
  profile?: StateTreeProfile;
}

export interface DirectPatchResult {
  patches: StatePatch[];
  /** 本楼结束时的角色（含本楼新建人物），供结构化战斗等后续步骤寻址 */
  characters: CharacterState[];
  /** 建补丁时丢弃的项（中文，带路径）；无丢弃为空数组 */
  dropped: string[];
  /** 建补丁时的纠正说明（状态树翻译层的「路径：纠正」）；legacy 恒为空数组 */
  normalized: string[];
  /**
   * 过滤后的主叙事角色更新（去掉指向不存在人物的条目）；
   * 状态树协议下已并入 `档案` 路径写入（同名人物合并，character_updates 显式写的字段优先）
   */
  characterUpdates: CharacterNarrativeUpdate[];
  /**
   * 本楼推进的游戏分钟数，交给 `applyTimeAdvance`。legacy = `time.delta_time`；
   * tree = `/世界/时间` 的汇总，没写时接受旧写法 `time.delta_time`。
   */
  deltaTime: number;
  /** 本楼状态更新记录（§12.2，挂到本楼 assistant 消息上）；只有状态树协议的草稿才有 */
  stateUpdates?: StateUpdateRecord;
}

export function buildDirectPatches(
  draft: DirectTurnDraft,
  input: DirectPatchInput,
): DirectPatchResult {
  if (draft.treePatch) return buildTreeDirectPatches(draft, draft.treePatch, input);
  return {
    ...buildLegacyDirectPatches(draft, input),
    normalized: [],
    deltaTime: draft.updates.time.delta_time,
  };
}

/** 按名字合并档案路径写入与 character_updates：同名人物合并 profile_changes，显式写的优先 */
function mergeProfileChanges(
  updates: readonly CharacterNarrativeUpdate[],
  changes: readonly CharacterNarrativeUpdate[],
  characters: readonly CharacterState[],
): CharacterNarrativeUpdate[] {
  const merged = updates.map((update) => ({ ...update }));
  const canonical = (name: string) => findCharacter(characters, name)?.name ?? name;
  for (const change of changes) {
    const target = merged.find((update) => canonical(update.name) === canonical(change.name));
    if (target) target.profile_changes = { ...change.profile_changes, ...target.profile_changes };
    else merged.push({ ...change, chronicle: [...change.chronicle] });
  }
  return merged;
}

/** 状态树协议：op → StatePatch 由翻译层完成（纠正、预演、成组丢弃都在那里），这里只做接线 */
function buildTreeDirectPatches(
  draft: DirectTurnDraft,
  tree: DirectTreePatch,
  input: DirectPatchInput,
): DirectPatchResult {
  if (!input.profile) throw new Error('状态树协议的直出草稿需要存档档案（profile）才能建补丁');
  const translated = translateTreeOps(
    tree.ops,
    { characters: input.characters, profile: input.profile },
    {
      actor: 'ai',
      sourceTurnKey: input.sourceTurnKey,
      definitions: input.definitions,
      characterUpdates: draft.characterUpdates,
      parseNormalized: tree.normalized,
    },
  );
  const dropped = [...translated.dropped];
  const characters = [...input.characters, ...translated.newCharacters];
  const legacyMinutes = draft.updates.time.delta_time;
  let deltaTime = translated.deltaMinutes;
  if (legacyMinutes > 0) {
    if (deltaTime > 0) dropped.push('time.delta_time：本楼已用 /世界/时间 推进时间，旧写法已忽略');
    else deltaTime = legacyMinutes;
  }
  const characterUpdates = mergeProfileChanges(
    draft.characterUpdates,
    translated.profileChanges,
    characters,
  ).filter((update) => {
    const known = findCharacter(characters, update.name) !== undefined;
    if (!known) dropped.push(`character_updates：人物 ${update.name} 缺少完整实体，已忽略`);
    return known;
  });
  // 信封里的 tile_ops 仍走既有地块翻译（逐条校验已在解析期做过）
  const patches = [...translated.patches, ...buildDispatcherPatches(draft.updates.world).patches];
  return {
    patches,
    characters,
    dropped,
    normalized: [...translated.normalized],
    characterUpdates,
    deltaTime,
    stateUpdates: { ops: translated.records, deltaMinutes: deltaTime },
  };
}

function buildLegacyDirectPatches(
  draft: DirectTurnDraft,
  input: DirectPatchInput,
): Omit<DirectPatchResult, 'normalized' | 'deltaTime' | 'stateUpdates'> {
  const characters = [...input.characters];
  /** 预演单元：普通补丁一条一组；替换（删旧 + 加新）一组，整组落或整组丢 */
  const units: Array<{ patches: StatePatch[]; label?: string }> = [];
  const patches = {
    push: (...list: StatePatch[]) => list.forEach((p) => units.push({ patches: [p] })),
  };
  const dropped: string[] = [];
  /** 真正留下的实体的初始状态（「角色名/状态名」），effects 行与之撞名才算重复 */
  const keptStatuses = new Set<string>();
  const pathOf = (entity: object, i: number) => ENTITY_PATHS.get(entity) ?? `entities[${i}]`;
  draft.updates.entities.forEach((entity, i) => {
    if (entity.kind !== 'character') return;
    const name = entity.output.character!.name;
    if (characters.some((c) => c.name === name)) {
      dropped.push(dropNote(pathOf(entity, i), `人物 ${name} 已存在`));
      return;
    }
    const narrativeCharacter = draft.characterUpdates.find((update) => update.name === name);
    const definition = input.definitions.find(
      (d) => d.name === name || d.profile.aliases?.includes(name),
    );
    let character: CharacterState;
    try {
      character = assembleCharacterState(entity.output, entity.placement);
      bindGeneratedCharacter(character, {
        narrativeCharacter,
        characterDefinition: definition,
        introducedBy: input.sourceTurnKey,
      });
    } catch (error) {
      dropped.push(dropNote(pathOf(entity, i), `人物组装失败（${errorText(error)}）`));
      return;
    }
    if (characters.some((c) => c.name === character.name)) {
      dropped.push(dropNote(pathOf(entity, i), `人物 ${character.name} 已存在`));
      return;
    }
    characters.push(character);
    for (const status of statusNames(entity.output))
      keptStatuses.add(`${character.name}/${status}`);
    patches.push({ op: 'add_character', target: `characters.${character.name}`, value: character });
  });
  const characterUpdates = draft.characterUpdates.filter((update) => {
    const known = findCharacter(characters, update.name) !== undefined;
    if (!known) dropped.push(`character_updates：人物 ${update.name} 缺少完整实体，已忽略`);
    return known;
  });
  draft.updates.entities.forEach((entity, i) => {
    if (entity.kind !== 'loadout') return;
    const path = pathOf(entity, i);
    const owner = findCharacter(characters, entity.owner);
    if (!owner) {
      dropped.push(dropNote(path, `物品归属人物 ${entity.owner} 不存在`));
      return;
    }
    const output = entity.output;
    let generated: StatePatch[];
    try {
      generated = buildEntityGenPatches(
        {
          ...output,
          skills: output.skills.filter((item) => !item.replace),
          equipment: output.equipment.filter((item) => !item.replace),
          inventory: output.inventory.filter((item) => !item.replace),
        },
        entity.owner,
      );
    } catch (error) {
      dropped.push(dropNote(path, `归属物组装失败（${errorText(error)}）`));
      return;
    }
    // 替换 = 删旧 + 加新：逐条目成组（同名的两条替换各自成组，不按名字去重），
    // 预演时整组落下或整组丢弃，旧的不在身上（含被本楼前面的替换删掉）就连新的也不加
    const replacements: Array<{ patches: StatePatch[]; label: string }> = [];
    for (const key of DIRECT_ENTITY_LIST_KEYS)
      output[key].forEach((item, index) => {
        if (!item.replace) return;
        const label = `${path}.output.${key}[${index}]（${item.name} 替换 ${item.replace}）`;
        try {
          replacements.push({
            label,
            patches: [
              {
                op: key === 'skills' ? 'remove_skill' : 'remove_item',
                target: `characters.${entity.owner}`,
                value: { name: item.replace },
              },
              ...buildEntityGenPatches({ ...EMPTY_LOADOUT, [key]: [item] }, entity.owner),
            ],
          });
        } catch (error) {
          dropped.push(dropNote(label, `替换组装失败（${errorText(error)}）`));
        }
      });
    // Acquisition does not equip. Explicit state.items.equip passes the normal slot checks.
    for (const patch of [...generated, ...replacements.flatMap((unit) => unit.patches)])
      if (patch.op === 'add_item') (patch.value as Record<string, unknown>).equippedSlot = null;
    for (const status of statusNames(output)) keptStatuses.add(`${owner.name}/${status}`);
    patches.push(...generated);
    units.push(...replacements);
  });
  patches.push(...buildDispatcherPatches(draft.updates.world).patches);
  patches.push(...buildVarsUpdatePatches(draft.updates.state));
  if (draft.updates.state.quests)
    patches.push(...buildQuestPatches(draft.updates.state.quests as Row));
  draft.updates.effects.forEach((effect, i) => {
    const owner = findCharacter(characters, effect.owner);
    if (owner && keptStatuses.has(`${owner.name}/${effect.value.name}`)) {
      dropped.push(
        dropNote(
          EFFECT_PATHS.get(effect) ?? `effects[${i}]`,
          '状态效果重复声明（实体初始状态已写过）',
        ),
      );
      return;
    }
    patches.push({
      op:
        effect.action === 'add'
          ? 'add_status_effect'
          : effect.action === 'update'
            ? 'update_status_effect'
            : 'remove_status_effect',
      target: `characters.${effect.owner}`,
      value: effect.value,
    });
  });
  const rehearsal = new PatchRehearsal(characters);
  const kept: StatePatch[] = [];
  for (const unit of units) {
    const before = rehearsal.snapshot();
    let failed: { patch: StatePatch; error: unknown } | undefined;
    for (const patch of unit.patches) {
      try {
        rehearsal.vet(patch)();
      } catch (error) {
        failed = { patch, error };
        break;
      }
    }
    if (failed) {
      rehearsal.restore(before);
      const { patch, error } = failed;
      dropped.push(
        unit.label
          ? dropNote(unit.label, `${patch.op}：${errorText(error)}`)
          : `${patch.op}（${patch.target}）：${errorText(error)}，已忽略`,
      );
      continue;
    }
    kept.push(...unit.patches);
  }
  for (const patch of kept) {
    if (patch.op === 'add_status_effect') {
      const value = patch.value as EntityStatusOutput;
      if (value.effects)
        patch.value = {
          ...value,
          effects: {},
          effectDescriptions: value.effectDescriptions ?? value.effects,
        };
    }
  }
  return { patches: kept, characters, dropped, characterUpdates };
}
