/**
 * direct-normalize.ts — 直出 `direct_updates` 的无损归一化预处理
 *
 * 模型输出形状稍有偏差（字符串当对象、缺默认字段、写了 id 等账务键）时，
 * 在严格校验之前就地纠正，并为每一处纠正记一条中文 note（带路径）。
 * 这里只做「意思明确、不丢信息」的纠正；给了但类型或范围错的值一律原样留给
 * direct-output.ts 的校验器，由它按最小单元丢弃并记入 dropped（📌 2026-11-25 起登神状态的
 * 有损丢弃也归校验器，本模块不再产出 dropped）。
 * 唯一例外是状态效果的 category：枚举外的文本值经 normalizeStatusCategory 映射到最接近的
 * 分类（认不出的落「特殊」），note 写明原值与映射后的值 —— 分类只是归类，效果名照旧保留，
 * 比为一个分类词作废整楼划算。
 *
 * 🔴 原型污染键（`__proto__` / `prototype` / `constructor`）由调用方 direct-output.ts 在调用本模块
 * 之前整体扫描并拒收：归一化里有按动态键复制的地方，带着这些键进来会把「设原型」混成普通赋值、
 * 键就此消失。别在没扫过的对象上调用 `normalizeDirectUpdates`。
 */
import { normalizeStatusCategory } from '../content/field-enums';
import {
  DIRECT_ASCENSION_LIST_KEYS,
  DIRECT_CHARACTER_LIST_FIELDS,
  DIRECT_CHARACTER_TEXT_FIELDS,
  DIRECT_EFFECT_CATEGORIES,
  DIRECT_EFFECT_REMOVE_KEYS,
  DIRECT_ENTITY_LIST_KEYS,
  DIRECT_ENTITY_OUTER_KEYS,
  DIRECT_PLOT_KEYS,
  DIRECT_QUEST_UPSERT_KEYS,
  DIRECT_STRIPPED_KEYS,
  emptyDirectSections,
} from './direct-contract';

type Row = Record<string, unknown>;

export interface NormalizeDirectOptions {
  /** 是否启用结构化战斗；关闭时 combat 由调用方先行丢弃，这里补 null */
  structuredCombat: boolean;
  /** 剧情系统是否启用；关闭时非空 plot 整体丢弃 */
  plotEnabled: boolean;
}

export interface NormalizeDirectResult {
  /** 每处无损纠正一条（中文，带路径）；无纠正为空数组 */
  notes: string[];
  /** 平铺在 output 上、已归位进 output.character 的人物名（独立告警，不计入 notes） */
  flattenedCharacters: string[];
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(row: Row, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key);
}

/** 键缺失、undefined 或 null */
function absent(row: Row, key: string): boolean {
  return !has(row, key) || row[key] === null || row[key] === undefined;
}

/** 缺失或 null 时填默认值并记 note；返回是否填了 */
function fill(row: Row, key: string, value: unknown, path: string, notes: string[]): boolean {
  if (!absent(row, key)) return false;
  row[key] = value;
  notes.push(`${path}.${key}：缺失，已补默认值`);
  return true;
}

/**
 * 不经原型链写入自有数据属性。键已过 direct-output.ts 的 `rejectForbidden`
 * （归一化之前对整个 direct_updates 扫一遍原型污染键，任何层级出现即整楼拒收），这里再兜一层。
 */
function setOwn(row: Row, key: string, value: unknown): void {
  Object.defineProperty(row, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * world 各操作的 value 是作者自由内容（世界变量词汇），其中的 id / definition 可能有语义：
 * N10 不进入这棵子树，照旧交给校验器拒收。
 */
const WORLD_FREE_CONTENT = /^direct_updates\.world\.[^.[]+\[\d+\]\.value$/;

/** N10：结构化位置剥除账务键（world 各操作的 value 子树除外） */
function stripAccountKeys(value: unknown, path: string, notes: string[]): void {
  if (WORLD_FREE_CONTENT.test(path)) return;
  if (Array.isArray(value)) {
    value.forEach((child, i) => stripAccountKeys(child, `${path}[${i}]`, notes));
    return;
  }
  if (!isRow(value)) return;
  for (const key of Object.keys(value)) {
    if ((DIRECT_STRIPPED_KEYS as readonly string[]).includes(key)) {
      delete value[key];
      notes.push(`${path}.${key}：模型不应填写，已剥除`);
      continue;
    }
    stripAccountKeys(value[key], `${path}.${key}`, notes);
  }
}

/** N2：顶层分区缺失或 null 时补空值 */
function fillSections(parsed: Row, options: NormalizeDirectOptions, notes: string[]): void {
  if (!has(parsed, 'version')) {
    parsed.version = 1;
    notes.push('direct_updates.version：缺失，已补 1');
  }
  for (const [key, empty] of Object.entries(emptyDirectSections()))
    if (absent(parsed, key)) {
      parsed[key] = empty;
      notes.push(`direct_updates.${key}：缺失，已补空值`);
    }
  // 结构化战斗开启时 combat 缺失仍拒（必须显式写 null）；关闭时调用方已丢弃，这里补 null
  if (!options.structuredCombat) parsed.combat = null;
}

/** N3：plot.pre/post 为 null 删键；剧情关闭时非空 plot 整体丢弃 */
function normalizePlot(parsed: Row, options: NormalizeDirectOptions, notes: string[]): void {
  const plot = parsed.plot;
  if (isRow(plot))
    for (const key of DIRECT_PLOT_KEYS)
      if (has(plot, key) && plot[key] === null) {
        delete plot[key];
        notes.push(`plot.${key}：为 null，已删除`);
      }
  if (!options.plotEnabled && !(isRow(plot) && Object.keys(plot).length === 0)) {
    parsed.plot = {};
    notes.push('plot：剧情系统未启用，已丢弃');
  }
}

/** 文本 → 单元素数组 */
function textToList(row: Row, key: string, path: string, notes: string[]): void {
  if (typeof row[key] === 'string') {
    row[key] = [row[key]];
    notes.push(`${path}.${key}：文本已转为数组`);
  }
}

/**
 * N5：登神条目的丢弃原因 —— 缺名（没有 name、不是文本或只含空白；纯文本条目为空串），
 * 或既不是文本也不是对象；条目可用时返回 undefined。
 * 归一化只纠正可用条目、按可用条目推断 enabled；丢弃由校验器（direct-output.ts）按同一判据做。
 */
export function ascensionEntryProblem(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry.trim() === '' ? '缺少名字' : undefined;
  if (!isRow(entry)) return '不是对象';
  return typeof entry.name !== 'string' || entry.name.trim() === '' ? '缺少名字' : undefined;
}

/** N5：登神条目（要素／权能／法则） */
function normalizeAscensionEntry(
  list: unknown[],
  i: number,
  kind: (typeof DIRECT_ASCENSION_LIST_KEYS)[number],
  path: string,
  notes: string[],
): void {
  const label = `${path}[${i}]`;
  if (typeof list[i] === 'string') {
    list[i] = { name: list[i], description: '' };
    notes.push(`${label}：文本条目已转为对象`);
  }
  const entry = list[i];
  if (!isRow(entry)) return;
  fill(entry, 'description', '', label, notes);
  if (kind === 'laws') {
    if (has(entry, 'effects') && !has(entry, 'passiveEffects') && !has(entry, 'activeEffects')) {
      textToList(entry, 'effects', label, notes);
      entry.passiveEffects = entry.effects;
      delete entry.effects;
      notes.push(`${label}.effects：已并入 passiveEffects`);
    }
    for (const key of ['passiveEffects', 'activeEffects']) {
      textToList(entry, key, label, notes);
      fill(entry, key, [], label, notes);
    }
  } else {
    textToList(entry, 'effects', label, notes);
    fill(entry, 'effects', [], label, notes);
  }
  if (kind !== 'elements') fill(entry, 'costDescription', '', label, notes);
}

/** enabled 的推断依据：三个条目列表里有没有可用（不会被丢弃）的条目 */
export function hasUsableAscensionEntry(asc: Row): boolean {
  return DIRECT_ASCENSION_LIST_KEYS.some((key) => {
    const list = asc[key];
    return Array.isArray(list) && list.some((entry) => ascensionEntryProblem(entry) === undefined);
  });
}

/** 未登神默认对象 */
export function emptyAscension(): Row {
  return {
    enabled: false,
    path: '',
    description: '',
    elements: [],
    authorities: [],
    laws: [],
    deityPosition: '',
    divineKingdom: { name: '', description: '' },
  };
}

/**
 * N5：登神状态的无损纠正。`fillMissing` 为 true（人物内）时缺失或 null 补未登神默认对象；
 * loadout 顶层的 ascension 缺席表示「不改登神」，故只纠正已给出的对象。
 *
 * 给了但形状坏的部分原样留给校验器（direct-output.ts 的 `salvageAscension`）按单元丢弃：
 * 不是对象、条目列表不是数组、条目缺名或不是对象、enabled 不是布尔、path / description 不是文本。
 * 这里只纠正可用条目（note 下标指模型原文），enabled 缺失时只按可用条目推断。
 */
function normalizeAscension(
  container: Row,
  path: string,
  fillMissing: boolean,
  notes: string[],
): void {
  if (absent(container, 'ascension')) {
    if (!fillMissing) return;
    container.ascension = emptyAscension();
    notes.push(`${path}.ascension：缺失，已补未登神默认值`);
    return;
  }
  const label = `${path}.ascension`;
  if (!isRow(container.ascension)) return;
  const asc = container.ascension;
  for (const [alias, key] of [
    ['authority', 'authorities'],
    ['law', 'laws'],
  ] as const)
    if (has(asc, alias) && !has(asc, key)) {
      asc[key] = asc[alias];
      delete asc[alias];
      notes.push(`${label}.${alias}：已改名为 ${key}`);
    }
  // 只纠正可用条目，按模型原文下标记 note；坏条目留给校验器丢弃
  for (const key of DIRECT_ASCENSION_LIST_KEYS) {
    const list = asc[key];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++)
      if (ascensionEntryProblem(list[i]) === undefined)
        normalizeAscensionEntry(list, i, key, `${label}.${key}`, notes);
  }
  if (absent(asc, 'enabled')) {
    asc.enabled = hasUsableAscensionEntry(asc);
    notes.push(`${label}.enabled：缺失，已按条目推断`);
  }
  for (const key of ['path', 'description']) fill(asc, key, '', label, notes);
  for (const key of DIRECT_ASCENSION_LIST_KEYS) fill(asc, key, [], label, notes);
  if (typeof asc.divineKingdom === 'string') {
    asc.divineKingdom = { name: asc.divineKingdom, description: '' };
    notes.push(`${label}.divineKingdom：文本已转为对象`);
  }
}

/**
 * N8：新增状态效果的默认字段（与 state-manager 新效果的缺省口径一致）。
 *
 * `fillRemainingTime` 只对顶层 effects 的 add 为真：实体 statuses 缺时长时保持缺席——
 * state-manager 把 undefined 当「不动已有时长」、null 当「覆盖为永久」，
 * 给 loadout 补 null 会把已有限时效果改成永久。
 */
function fillStatusDefaults(
  value: Row,
  path: string,
  notes: string[],
  fillRemainingTime: boolean,
): void {
  fill(value, 'description', '', path, notes);
  if (absent(value, 'category')) {
    value.category = normalizeStatusCategory('');
    notes.push(`${path}.category：缺失，已补默认值`);
  } else if (
    typeof value.category === 'string' &&
    !(DIRECT_EFFECT_CATEGORIES as readonly string[]).includes(value.category)
  ) {
    // 刻意的例外：分类只是归类，映射后效果名不变，比整楼作废划算
    const normalized = normalizeStatusCategory(value.category);
    notes.push(
      `${path}.category：「${value.category}」不在分类枚举内，已映射为「${normalized}」（效果名不变）`,
    );
    value.category = normalized;
  }
  fill(value, 'stacks', 1, path, notes);
  if (fillRemainingTime && (!has(value, 'remainingTime') || value.remainingTime === undefined)) {
    value.remainingTime = null;
    notes.push(`${path}.remainingTime：缺失，已补 null（按永久处理）`);
  }
  fill(value, 'timeUnit', '分钟', path, notes);
}

/** N4 + N9：随身条目列表 */
function normalizeLists(output: Row, path: string, notes: string[]): void {
  for (const key of DIRECT_ENTITY_LIST_KEYS) {
    fill(output, key, [], path, notes);
    const list = output[key];
    if (!Array.isArray(list)) continue;
    list.forEach((item, i) => {
      if (!isRow(item)) return;
      const label = `${path}.${key}[${i}]`;
      fill(item, 'description', '', label, notes);
      if (key === 'equipment') fill(item, 'stats', {}, label, notes);
      if (key === 'inventory') fill(item, 'quantity', 1, label, notes);
    });
  }
}

/** N7：人物文本与列表字段 */
function normalizeCharacter(character: Row, path: string, notes: string[]): void {
  for (const key of DIRECT_CHARACTER_LIST_FIELDS) {
    textToList(character, key, path, notes);
    fill(character, key, [], path, notes);
  }
  for (const key of DIRECT_CHARACTER_TEXT_FIELDS) fill(character, key, '', path, notes);
  normalizeLists(character, path, notes);
  normalizeAscension(character, path, true, notes);
}

/**
 * kind 为 character 时登神只写在 output.character 里。模型若写在 output 顶层而人物内没有，
 * 搬进人物（随后按 N5 纠正）并返回 false；两处都写时不动、返回 true ——
 * 校验器保留人物内那份、丢弃顶层的（记入 dropped）。
 */
function moveCharacterAscension(
  output: Row,
  character: Row,
  label: string,
  notes: string[],
): boolean {
  if (absent(output, 'ascension')) return false;
  if (!absent(character, 'ascension')) return true;
  character.ascension = output.ascension;
  delete output.ascension;
  notes.push(`${label}.ascension：已搬进 ${label}.character.ascension`);
  return false;
}

function normalizeEntityOutput(row: Row, path: string, notes: string[]): void {
  const output = row.output;
  if (!isRow(output)) return;
  const label = `${path}.output`;
  normalizeLists(output, label, notes);
  if (has(output, 'statuses') && output.statuses === null) {
    output.statuses = [];
    notes.push(`${label}.statuses：为 null，已补空数组`);
  }
  let ownerName: unknown = row.owner;
  // 两处都写登神时顶层那份会被校验器丢弃，不为它记纠正
  let duplicateAscension = false;
  if (row.kind === 'character' && isRow(output.character)) {
    duplicateAscension = moveCharacterAscension(output, output.character, label, notes);
    normalizeCharacter(output.character, `${label}.character`, notes);
    ownerName = output.character.name;
  }
  if (!duplicateAscension) normalizeAscension(output, label, false, notes);
  if (Array.isArray(output.statuses))
    output.statuses.forEach((status, i) => {
      if (!isRow(status)) return;
      const statusLabel = `${label}.statuses[${i}]`;
      if (absent(status, 'owner') && typeof ownerName === 'string') {
        status.owner = ownerName;
        notes.push(`${statusLabel}.owner：缺失，已补为「${ownerName}」`);
      }
      fillStatusDefaults(status, statusLabel, notes, false);
    });
  if (row.kind === 'character' && isRow(row.placement) && absent(row.placement, 'present')) {
    row.placement.present = true;
    notes.push(`${path}.placement.present：缺失，已补 true`);
  }
}

/**
 * 模型常把人物字段直接平铺在 output 上（name、race… 与 skills/equipment/inventory/ascension 同层），
 * 而不是放进 output.character。识别到这种形状时把人物字段（含随身技能/装备/背包/登神）
 * 收进 output.character，顶层 skills/equipment/inventory 置空 —— 与规范嵌套形状
 * 经 assembleCharacterState 组装出的人物一致。返回归位的人物名；不是平铺形状返回 undefined。
 */
function unflattenCharacterEntity(row: Row): string | undefined {
  if (row.kind !== 'character' || !isRow(row.output)) return undefined;
  const output = row.output;
  if (output.character !== undefined || typeof output.name !== 'string') return undefined;
  const character: Row = {};
  const outer: Row = {};
  for (const [key, value] of Object.entries(output))
    setOwn(
      (DIRECT_ENTITY_OUTER_KEYS as readonly string[]).includes(key) ? outer : character,
      key,
      value,
    );
  row.output = { ...outer, character, skills: [], equipment: [], inventory: [] };
  return output.name;
}

/** N8：effects 行 */
function normalizeEffects(effects: unknown, notes: string[]): void {
  if (!Array.isArray(effects)) return;
  effects.forEach((row, i) => {
    if (!isRow(row)) return;
    const label = `effects[${i}]`;
    if (row.value === undefined && typeof row.name === 'string') {
      const value: Row = {};
      for (const key of Object.keys(row))
        if (key !== 'owner' && key !== 'action') {
          setOwn(value, key, row[key]);
          delete row[key];
        }
      row.value = value;
      notes.push(`${label}：效果字段已收进 value`);
    }
    const value = row.value;
    if (!isRow(value)) return;
    if (row.action === 'add') fillStatusDefaults(value, `${label}.value`, notes, true);
    if (row.action === 'remove')
      for (const key of Object.keys(value))
        if (!(DIRECT_EFFECT_REMOVE_KEYS as readonly string[]).includes(key)) {
          delete value[key];
          notes.push(`${label}.value.${key}：移除效果不需要，已剥除`);
        }
  });
}

/** N11：delta 行缺 amount 但 value 是数值 → 取 value */
function normalizeDeltaRows(rows: unknown, path: string, notes: string[]): void {
  if (!Array.isArray(rows)) return;
  rows.forEach((row, i) => {
    if (!isRow(row) || has(row, 'amount') || typeof row.value !== 'number') return;
    row.amount = row.value;
    delete row.value;
    notes.push(`${path}[${i}]：value 已改为 amount`);
  });
}

/** N12：任务 upsert 行剥除契约外的键（协议只列了这几个字段，多写的键不入库） */
function normalizeQuestRows(rows: unknown, notes: string[]): void {
  if (!Array.isArray(rows)) return;
  rows.forEach((row, i) => {
    if (!isRow(row)) return;
    for (const key of Object.keys(row))
      if (!(DIRECT_QUEST_UPSERT_KEYS as readonly string[]).includes(key)) {
        delete row[key];
        notes.push(`state.quests.upsert[${i}].${key}：任务没有此字段，已剥除`);
      }
  });
}

/**
 * 就地归一化已解析的 direct_updates 对象（调用方后续校验与建补丁都读这同一个对象）。
 * 前提：调用方已拒收原型污染键。
 * 顺序：账务键剥除 → 分区补齐 → plot → 实体（平铺归位后逐项补默认）→ effects → state delta / 任务。
 */
export function normalizeDirectUpdates(
  parsed: Row,
  options: NormalizeDirectOptions,
): NormalizeDirectResult {
  const notes: string[] = [];
  const flattenedCharacters: string[] = [];
  stripAccountKeys(parsed, 'direct_updates', notes);
  fillSections(parsed, options, notes);
  normalizePlot(parsed, options, notes);
  if (Array.isArray(parsed.entities))
    parsed.entities.forEach((row, i) => {
      if (!isRow(row)) return;
      const flattened = unflattenCharacterEntity(row);
      if (flattened !== undefined) flattenedCharacters.push(flattened);
      normalizeEntityOutput(row, `entities[${i}]`, notes);
    });
  normalizeEffects(parsed.effects, notes);
  if (isRow(parsed.state)) {
    const { characters, affections, quests } = parsed.state;
    if (isRow(characters)) normalizeDeltaRows(characters.delta, 'state.characters.delta', notes);
    if (isRow(affections)) normalizeDeltaRows(affections.delta, 'state.affections.delta', notes);
    if (isRow(quests)) normalizeQuestRows(quests.upsert, notes);
  }
  return { notes, flattenedCharacters };
}
