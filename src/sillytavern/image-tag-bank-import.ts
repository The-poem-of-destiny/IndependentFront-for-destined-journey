/**
 * image-tag-bank-import.ts — ST 世界书 JSON → 标签词库（**纯同步、不抛错**）
 *
 * 上游语料长这样（一条 = 一个画面要素）：
 *
 * ```json
 * { "uid": 2, "comment": "[特征]：兽耳",
 *   "key": ["兽耳", "猫耳朵", "狐狸耳"],
 *   "content": "- 兽耳：animal ears/cat ears/fox ears\n<U+FEFF>" }
 * ```
 *
 * 三个字段各有用处：`comment` 给分类与名字、`key` 给检索别名、`content` 给标签。
 *
 * 🔴 **本模块不抛错，一条也不抛**（照 `workshop-install-plan.planInstall` 的先例）。
 *    真实词库有几千条，是许多人许多年手写堆出来的 —— 里面一定有本文件没见过的写法。
 *    读不懂的那一条记进 `notes` 跳过即可；抛错等于让一个畸形条目否掉整本。
 *
 * 🔴 **不 import Dexie / DOM / 任何有 I/O 的东西**。落库是调用方的事，
 *    于是几千条的转换在测试里就是一次函数调用。
 */

import type {
  TagAlternatives,
  TagBankEntry,
  TagBankImportNote,
  TagBankImportPlan,
} from './types-image';

/** 没有 `[方括号]` 的条目落进这一类 */
export const UNCATEGORIZED_LABEL = '未分类';

/**
 * 标签左边那个中文标签名最长能有多长 —— 超过就不当标签名看。
 *
 * 用来把 `- 温泉：onsen, hot spring` 的 `温泉：` 剥掉，同时**不去动** `rating:general`
 * 或 NAI 的 `1.5::tag::` 这类标签自带的冒号。判据是「冒号左边含中日韩字符且够短」，
 * 两条都满足才剥 —— 只看冒号会把带权重语法的标签拦腰截断，而那是静默的（截出来的
 * 前半段仍是一个语法合法的标签串，只是意思全变了）。
 */
const LABEL_MAX_LEN = 32;

/** 中日韩字符 —— 用来分辨「这是中文标签名」与「这是 danbooru 标签」 */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

/** 行首的列表符号：`- ` / `* ` / `• ` / `· `，允许前置空白 */
const BULLET = /^[\s]*[-*•·]+[\s]*/;

/** `[分类]：名字` / `【分类】名字` —— 全角半角括号与冒号都吃 */
const COMMENT_SHAPE = /^\s*[[【]([^\]】]*)[\]】]\s*[:：]?\s*(.*)$/;

/**
 * 导入期会被抹掉的**不可见字符**。
 *
 * 语料里是真的有：样本 uid 2 的 content 就以一个 U+FEFF 结尾。它们进不了标签串
 * （NAI 只会把它当成标签名的一部分从而匹配不到任何东西），却能骗过肉眼与 diff。
 * 本仓的编码闸门（`tests/encoding-invariants.test.ts`）扫的是 `data/` 与源码，
 * 扫不到用户运行时导入的库 —— 所以这道关必须由导入器自己把。
 *
 * U+FFFD（替换字符）单独处理：它代表**已经丢失的字节**，不是不可见字符。
 */
const INVISIBLE = /[\uFEFF\u200B-\u200D\u2060]/g;

/** 已经损坏的编码留下的替换字符 */
const REPLACEMENT_CHAR = /\uFFFD/g;

/** 上游 entries 的两种形状：`{"0":{…}}` 对象表 与 `[…]` 数组 */
type RawEntryBag = Record<string, unknown> | unknown[];

/** 我们真正会读的上游字段。其余字段（probability/depth/…）与词库无关，读都不读 */
interface RawEntry {
  uid?: unknown;
  comment?: unknown;
  key?: unknown;
  content?: unknown;
  order?: unknown;
  disable?: unknown;
  constant?: unknown;
}

export interface ParseTagBankOptions {
  /** 落进 `TagBankEntry.key` 前缀，缺省 `'bank'`（调用方落库前会给真 id） */
  bankId?: string;
}

/**
 * ST 世界书 JSON → 导入计划。
 *
 * @param raw 已 `JSON.parse` 的整个文件。形状不认识时返回**空计划**而不是抛错
 */
export function parseTagBankLorebook(
  raw: unknown,
  options: ParseTagBankOptions = {},
): TagBankImportPlan {
  const bankId = options.bankId ?? 'bank';
  const bag = extractEntryBag(raw);
  const notes: TagBankImportNote[] = [];
  const entries: TagBankEntry[] = [];

  const rows: Array<[string, RawEntry]> = Array.isArray(bag)
    ? bag.map((v, i) => [String(i), (v ?? {}) as RawEntry])
    : Object.entries(bag ?? {}).map(([k, v]) => [k, (v ?? {}) as RawEntry]);

  let index = 0;
  for (const [bagKey, row] of rows) {
    const parsed = parseOne(row, bagKey, index++, bankId, notes);
    if (parsed) entries.push(parsed);
  }

  // 同名条目 —— **不是错误**：`get_image_tags` 会把同名的都返回。
  // 记一条 note 只为让用户在导入报告里看见「这本里有 12 组重名」。
  const byName = new Map<string, TagBankEntry[]>();
  for (const e of entries) {
    const list = byName.get(e.name);
    if (list) list.push(e);
    else byName.set(e.name, [e]);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    notes.push({
      kind: 'duplicate',
      uid: list[0].uid,
      label: name,
      text: `同名条目 ${list.length} 条，查询时会一并返回`,
    });
  }

  return { entries, notes, stats: buildStats(rows.length, entries) };
}

/** 找到 entries 容器。整个文件本身就是数组 / `{entries:…}` 两种都吃 */
function extractEntryBag(raw: unknown): RawEntryBag {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === 'object') {
    const holder = raw as { entries?: unknown };
    const entries = holder.entries;
    if (Array.isArray(entries)) return entries;
    if (entries !== null && typeof entries === 'object') return entries as Record<string, unknown>;
    // 没有 entries 字段 —— 也可能整个对象就是 uid→条目的表
    return raw as Record<string, unknown>;
  }
  return {};
}

function parseOne(
  row: RawEntry,
  bagKey: string,
  index: number,
  bankId: string,
  notes: TagBankImportNote[],
): TagBankEntry | undefined {
  const uid = typeof row.uid === 'number' || typeof row.uid === 'string' ? row.uid : bagKey;
  const rawComment = asString(row.comment);
  const rawContent = asString(row.content);
  const label = rawComment.trim() !== '' ? rawComment.trim() : `uid ${String(uid)}`;

  // ① 不可见字符与坏字节 —— 先清，再解析。顺序反过来的话，`温泉` 与 `温泉`
  //    会被当成两个不同的名字，而它们在屏幕上一模一样。
  const cleanedComment = stripInvisible(rawComment);
  const cleanedContent = stripInvisible(rawContent);
  const repaired =
    countMatches(rawComment + rawContent, INVISIBLE) +
    countMatches(rawComment + rawContent, REPLACEMENT_CHAR);
  if (repaired > 0) {
    notes.push({
      kind: 'repaired',
      uid,
      label,
      text: `清掉 ${repaired} 个不可见/损坏字符（BOM、零宽、U+FFFD）`,
    });
  }

  // ② comment → 分类 + 名字
  const { category, name: commentName } = splitComment(cleanedComment);

  // ③ content → 标签行。一条上游条目可能写了好几行 `- xxx：tags`
  const lines = cleanedContent
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET, '').trim())
    .filter((l) => l !== '');

  const tags: TagAlternatives[] = [];
  let lineName = '';
  for (const line of lines) {
    const { label: lineLabel, expression } = splitLabeledLine(line);
    if (lineLabel !== '' && lineName === '') lineName = lineLabel;
    tags.push(...parseTagExpression(expression));
  }

  // 名字取 comment 的，comment 没有就用正文里那个中文标签名，再没有就跳过
  const name = commentName !== '' ? commentName : lineName;

  if (name === '' || tags.length === 0) {
    notes.push({
      kind: 'skipped',
      uid,
      label,
      text: name === '' ? '没有可用的条目名（comment 与正文都读不出名字）' : '正文里没有标签',
    });
    return undefined;
  }

  // ④ 标签里混着中文 —— 进库，但值得看一眼：NAI 读不懂中文标签，
  //    多半是作者把注释写进了标签串里。
  const cjkTags = tags.flat().filter((t) => CJK.test(t));
  if (cjkTags.length > 0) {
    notes.push({
      kind: 'warning',
      uid,
      label,
      text: `${cjkTags.length} 个标签含中文（模型读不懂，可能是注释混进了标签串）: ${cjkTags
        .slice(0, 3)
        .join(' / ')}`,
    });
  }

  const aliases = buildAliases(name, row.key);

  return {
    key: `${bankId}:${String(uid)}`,
    uid,
    category,
    name,
    aliases,
    tags,
    alwaysOn: row.constant === true,
    raw: cleanedContent,
    order: typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : index,
    enabled: row.disable !== true,
  };
}

/** `[场景]：温泉` → `{category:'场景', name:'温泉'}`；没有括号时整串当名字 */
function splitComment(comment: string): { category: string; name: string } {
  const trimmed = comment.trim();
  if (trimmed === '') return { category: UNCATEGORIZED_LABEL, name: '' };

  const m = COMMENT_SHAPE.exec(trimmed);
  if (!m) return { category: UNCATEGORIZED_LABEL, name: trimmed };

  const category = m[1].trim();
  const name = m[2].trim();
  return {
    category: category === '' ? UNCATEGORIZED_LABEL : category,
    // `[场景]` 后面什么都没写时，拿分类当名字总好过丢掉这一条
    name: name === '' ? category : name,
  };
}

/**
 * `温泉：onsen, hot spring` → `{label:'温泉', expression:'onsen, hot spring'}`。
 *
 * 冒号左边**不是中文**（或太长）时一律不剥 —— 见 {@link LABEL_MAX_LEN}。
 */
function splitLabeledLine(line: string): { label: string; expression: string } {
  const colon = firstColon(line);
  if (colon < 0) return { label: '', expression: line };

  const left = line.slice(0, colon).trim();
  const right = line.slice(colon + 1).trim();
  if (right === '') return { label: '', expression: line };
  if (left === '' || left.length > LABEL_MAX_LEN || !CJK.test(left)) {
    return { label: '', expression: line };
  }
  return { label: left, expression: right };
}

/** 第一个冒号的位置。全角 `：` 与半角 `:` 同权 */
function firstColon(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ':' || c === '：') return i;
  }
  return -1;
}

/**
 * `onsen, hot spring` → `[['onsen'], ['hot spring']]`
 * `cat ears/fox ears` → `[['cat ears','fox ears']]`
 *
 * 逗号分格、斜杠分候选（见 {@link TagAlternatives}）。全角逗号与顿号按逗号处理 ——
 * 中文输入法下它们是同一个键打出来的，语料里混用是常态。
 */
function parseTagExpression(expression: string): TagAlternatives[] {
  const groups: TagAlternatives[] = [];
  for (const chunk of expression.split(/[,，、]/)) {
    const alternatives = chunk
      .split('/')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    if (alternatives.length > 0) groups.push(alternatives);
  }
  return groups;
}

/**
 * 检索别名 = 上游 `key[]` ∪ `{名字}` ∪ 名字里被 `/` 分开的那几段。
 *
 * 最后一项是为 `[场景]：公园/长椅` 这种写法准备的：它的 `key` 恰好是
 * `["公园","长椅"]`，但不是每条都这么规矩，补一手不花什么代价。
 */
function buildAliases(name: string, rawKey: unknown): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return;
    const s = stripInvisible(v).trim();
    if (s !== '' && !out.includes(s)) out.push(s);
  };

  push(name);
  for (const part of name.split('/')) push(part);
  if (Array.isArray(rawKey)) for (const k of rawKey) push(k);
  return out;
}

function buildStats(total: number, entries: TagBankEntry[]): TagBankImportPlan['stats'] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    // 条数降序；同条数按分类名排，于是同一份文件每次导入的报告逐字一致
    .sort((a, b) => b.count - a.count || compareCategory(a.category, b.category));
  return { total, imported: entries.length, skipped: total - entries.length, categories };
}

/**
 * 分类名排序 —— **不用 `localeCompare`**。
 *
 * 它依赖运行环境的 ICU 数据：同一份文件在不同浏览器/Node 上会排出不同顺序，
 * 于是「导入报告的字节是稳定的」这句话就不成立了（`ejs-fmt.compareName` 同一条）。
 */
function compareCategory(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function stripInvisible(s: string): string {
  return s.replace(INVISIBLE, '').replace(REPLACEMENT_CHAR, '');
}

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}
