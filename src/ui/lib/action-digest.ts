/**
 * `<action_info>` 行动面板 — 摘要提取（纯函数）
 *
 * `action-panel.ts` 把面板原文拆成「分节 / 行 / 格」；本模块在那份结构之上再读一层语义，
 * 回答收起态卡片真正想说的那几件事：
 *
 *   - 谁对谁做了什么（`actor` / `targets` / `action`）
 *   - 结论是什么（`verdict`：命中评级、成功失败、胜利战败）
 *   - 谁的 HP/MP/SP 变了多少（`deltas`，同一单位同一资源合并成一条）
 *   - 场上各单位的资源现值（`roster`，战况总览类面板）
 *   - 掷了什么骰（`roll`，手写游标解析）、每个目标打没打中（`targetResults`，与 targets 等长同序）
 *   - 不是结论的状态格（`statuses`）与结果句（`result`）
 *   - 其余要紧的几格（`facts`）
 *
 * `kind` 按优先级 exchange > roster > outcome > generic 取一个，渲染层据此选版式。
 * generic 单节面板的 `facts` 恒等于旧的 `summaryCells(第一节)` —— 认不出的老面板收起时与以前一模一样；
 * 多节面板改从全部分节里挑结论格（结果常写在最后一节末尾）。
 *
 * 数据全是模型自述的文字，这里只做认读与归并，不校验数值对不对。
 *
 * 🔴 线性扫描纪律（同 action-panel.ts）：资源记号用手写游标扫，不写「`\s*` 夹可选组」那类
 *    会在超长空白上回溯的正则；名字回看窗口有上限，失败的记号不会让后面反复切同一段长前缀。
 *    任何输入都**不抛**：面板摘要失败只退回 generic，不拖垮整条消息。
 */

import { HIT_RATINGS } from '@engine/types/types';
import {
  cellTone,
  summaryCells,
  type ActionPanel,
  type ActionPanelCell,
  type ActionPanelTone,
} from './action-panel';

// ── 类型 ──────────────────────────────────────────────────────

type Resource = 'HP' | 'MP' | 'SP';

export interface ResourceDelta {
  /** 单位名（去掉方括号与人数括注） */
  who: string;
  resource: Resource;
  /** 变化量：起止都知道时 = to − from，否则取模型写的 ±N */
  delta: number | null;
  from?: number;
  to?: number;
  max?: number;
}

export interface DigestVerdict {
  text: string;
  tone?: ActionPanelTone;
}

interface ResourceGauge {
  cur: number;
  max: number;
}

export interface RosterUnit {
  name: string;
  hp?: ResourceGauge;
  mp?: ResourceGauge;
  sp?: ResourceGauge;
  /** 集群单位名后的 `(存活/总数)` */
  cluster?: { alive: number; total: number };
}

export type ActionDigestKind = 'exchange' | 'roster' | 'outcome' | 'generic';

/**
 * 一次掷骰：`d20=17 +5 → 22 / 闪避 14`、`1d20(13)+4=17`、`d100=31 / 成功率 78`。
 * 多骰（`4d6(6,5,4,3)`）的 `value` 是各骰之和。
 */
export interface DigestRoll {
  /** 骰面：d20 → 20 */
  die: number;
  /** 骰出的值（多骰取和） */
  value: number;
  /** 加减值合计（`+敏捷5`、`+ 命中0 - 闪避0`）；没写就缺席 */
  modifier?: number;
  /** `→ 22` / `= 17` 给的合计 */
  total?: number;
  /** 对抗值：`/ 闪避 14`、`vs 12`、`≤ 暴击率 15`；没写标签时 label 为空串 */
  against?: { label: string; value: number };
  /** 掷骰所在的整格原文 */
  raw: string;
}

/** 单个目标是否被打中；拿不出证据时是 unknown */
export type DigestTargetHit = 'hit' | 'miss' | 'unknown';

interface DigestTargetResult {
  name: string;
  hit: DigestTargetHit;
  /** 这个目标自己那一行 / 那一段里的掷骰 */
  roll?: DigestRoll;
}

export interface ActionDigest {
  kind: ActionDigestKind;
  /** 第一个非空分节标题；没有就是空串 */
  title: string;
  actor?: string;
  targets: string[];
  action?: string;
  verdict?: DigestVerdict;
  /** 主掷骰：优先 判定 / 检定 / 命中 / 掷骰 格，其次任意格里的单骰 */
  roll?: DigestRoll;
  /** 与 targets 等长同序 */
  targetResults: DigestTargetResult[];
  deltas: ResourceDelta[];
  roster: RosterUnit[];
  facts: ActionPanelCell[];
  /** 不是结论的 `状态` 格（`灰狼 获得 流血(2回合)`） */
  statuses: string[];
  /** `结果` 行的叙述句（不是结论词本身时） */
  result?: string;
}

// ── 常量 ──────────────────────────────────────────────────────

/** 结论文字超过这个长度就不当结论（放进 facts） */
const MAX_VERDICT_LENGTH = 12;
/** 单位名长度上限；更长的多半是一句描述 */
const MAX_NAME_LENGTH = 24;
/** 名字回看窗口：资源记号前最多看这么多字符 */
const NAME_LOOKBACK = 64;
/** 散行「标签：值」补拆时标签的长度上限，免得把整句叙述劈开 */
const MAX_LOOSE_LABEL_LENGTH = 8;
const MAX_FACTS = 3;

/** 「无」类占位 → 没有目标 */
const EMPTY_TARGET = /^(无|没有|—+|-+|－+|n\/?a|none)$/i;
/** 「对象」写自己 → 没有目标 */
const SELF_TARGET = /^(自身|自己|本人|self)$/i;

/** 命中评级（来自引擎的 7 级表）：失手是失败，其余都打中了 */
const HIT_RATING_TONES: ReadonlyMap<string, ActionPanelTone> = new Map(
  HIT_RATINGS.map((r) => [r.level, r.coefficient > 0 ? 'success' : 'error'] as const),
);

/** 结算类结论词 */
const OUTCOME_WORD_TONES: ReadonlyMap<string, ActionPanelTone> = new Map([
  ['胜利', 'success'],
  ['精益求精', 'success'],
  ['战败', 'error'],
]);

/** 结论标签，按优先级分组；同组取最后一个有效值（最终状态写在后面） */
const VERDICT_LABEL_GROUPS: readonly RegExp[] = [
  /^结果$/,
  /^检定结果$/,
  /^(?:判定|检定)$/,
  /^状态$/,
];
/** `状态` 组只有带结论色时才算结论（否则多半是「林狼 流血」这类状态描述） */
const STATUS_GROUP_INDEX = 3;

/**
 * 结算类资源标签 —— 唯一一份，摘要（这里）与视图模型（action-panel-view.ts）共用。
 * 产物 / 品质 / 经验（`|经验|` 与 `|实得EXP|` 等英文写法同义）。
 */
export const PRODUCT_LABEL_RE = /^(?:产出列表|产出|产物)$/;
export const QUALITY_LABEL_RE = /^品质$/;
export const EXP_LABEL_RE = /^(?:经验|实得EXP|EXP合计|EXP)$/i;

/** outcome 关键格，按重要度排序；每个取最后一次出现 */
const OUTCOME_FACT_LABELS: readonly RegExp[] = [
  PRODUCT_LABEL_RE,
  QUALITY_LABEL_RE,
  /^奖励$/,
  /^损失$/,
  /^掉落$/,
  EXP_LABEL_RE,
  /^FP$/i,
  /^战果$/,
  /^序列$/,
];

/** 分节标题带这些字的面板是结算类 */
const OUTCOME_TITLE_RE = /结算|结果|胜利|战败|判定|总结/;

const COST_LABEL_RE = /^(?:资源)?消耗$/;
const EFFECT_LABEL_RE = /^(?:效果|恢复|治疗|回复)$/;
/** 直出旧格式 `|伤害|36|` / `|恢复|20|` */
const LEGACY_DAMAGE_LABEL_RE = /^伤害$/;
const LEGACY_HEAL_LABEL_RE = /^(?:恢复|治疗)$/;
/**
 * `|变更|…|` 汇总行：它常把前面 `伤害` / `消耗` 行写过的同一笔账再说一遍（去重见 mergeDeltas）；
 * 记号没写名字时 MP/SP 记给行动者（多半是出手消耗），HP 仍按行首名 / 唯一目标（多半是挨打）。
 */
const CHANGE_LABEL_RE = /^变更$/;
/**
 * 能「点名」的行：只有这些行里资源记号前认不出的词才当新单位名（旁人、群体成员）。
 * 其余行（伤害 / 效果 / 消耗 …）的记号前常是修饰语（`造成 HP -34`、`减伤后 HP -34`、`回复量 HP +20`），
 * 认不出的词一律退回行首已知名 / 唯一目标（消耗退回行动者），不凭空造出一个单位。
 */
const NAMING_LABEL_RE = /^(?:变更|波及|溅射|连带)$/;
const PLAIN_NUMBER_RE = /^\d+(?:\.\d+)?$/;

/**
 * 协议里的固定标签：它们不是单位名，不能当行首名字兜底。
 * 只在「资源记号前没写名字」时才用得上行首名字，所以这张表漏几个只会少认，不会认错人。
 */
const KNOWN_LABELS: ReadonlySet<string> = new Set([
  '行动者',
  '目标',
  '行动',
  '攻方',
  '守方',
  '招式',
  '所使武器',
  '单位',
  '角色',
  '对象',
  '执行',
  '类型',
  '消耗',
  '资源消耗',
  '资源预检',
  '伤害',
  '恢复',
  '治疗',
  '判定',
  '检定',
  '检定结果',
  '结果',
  '状态',
  '当前状态',
  '变更',
  '触发',
  '回合',
  '环境',
  '序列',
  '意图',
  '效果',
  '掷骰',
  '战果',
  '奖励',
  '掉落',
  '品质',
  '产出',
  '产物',
  '产出列表',
  '损失',
  '数量',
  '行业',
  '核心属性',
  '投入物',
  '认证',
  '精益求精',
  '经验依据',
  '结算状态',
  '上限检查',
  '集群减员',
  '是否存活',
  '先攻',
  '经验',
  '波及',
  '溅射',
  '连带',
]);
/** 以这些词结尾的标签同样是协议标签（`最终伤害`、`伤害修正`、`品质要求检查` …） */
const KNOWN_LABEL_SUFFIX_RE =
  /(?:伤害|修正|加值|减值|计算|结算|次数|检查|状态|效果|结果|施加|公式|基准|衰减|压制|合计|EXP|FP)$/i;

/** 名字回看时在这些字符处截断（括号不算 —— `食尸鬼(集群)` 的括号是名字的一部分） */
const NAME_SEPARATORS = ':：,，;；、|→=。！!？?·・';
/** 资源记号前紧挨的动词：给无符号的数定方向 */
const GAIN_VERBS = ['恢复', '回复', '治疗'];
const LOSS_VERBS = ['消耗', '损失', '扣除', '流失', '减少'];
/** 不是名字的词 */
const NOT_NAMES: ReadonlySet<string> = new Set([
  '剩余',
  '当前',
  '现有',
  '目标',
  '受到',
  '造成',
  '最终',
  '敌方',
  '我方',
  '对方',
  '己方',
]);
/** `恢复 50 点 HP` 这类后置资源名：从记号往回最多看这么多字符找「动词 + 数 + 点」 */
const AMOUNT_LOOKBACK = 16;
const EMPTY_NAMES: ReadonlySet<string> = new Set();

/** 主掷骰优先看的标签 */
const ROLL_LABEL_RE = /(?:判定|检定|命中|掷骰|检定结果)$/;
/** 修正 / 对抗标签（`+敏捷5`、`/ 闪避 14`）的长度上限 */
const MAX_ROLL_LABEL_LENGTH = 8;
/** 修正 / 对抗标签里不会出现的字符 */
const ROLL_LABEL_STOP = '+＋-−－=＝→/／|｜,，;；、。·・()（）[]【】<>＜＞≤≥:：';
/** 多骰括注里至多读这么多个数 */
const MAX_DICE_LIST = 32;
/** 目标被躲开 / 打空的词（「闪避」单字不算：`/ 闪避 14` 只是对抗值） */
const MISS_WORDS: readonly string[] = [
  '失手',
  '未命中',
  '未击中',
  '没有命中',
  '没命中',
  '落空',
  '闪避成功',
  '被闪避',
  '闪开',
  '躲开',
  '躲过',
];
/** 目标证据分段处 */
const PIECE_SEPARATORS = /[·・;；]/;

const OPEN_BRACKETS = '([（【';
const CLOSE_BRACKETS = ')]）】';
const PLUS = '+＋';
const MINUS = '-−－';

// ── 小工具 ────────────────────────────────────────────────────

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}

/** 从 p 起跳过 `chars` 里的字符 */
function skip(text: string, p: number, chars: string): number {
  while (p < text.length && chars.includes(text[p])) p += 1;
  return p;
}

const SPACES = ' \t　';

/**
 * 千分位逗号：逗号后恰好三位数字、第四位不是数字才算（`1,200`）。
 * `26,3回合`、`-15,2回合` 里的逗号是分句，不是千分位。
 */
function isThousandsComma(text: string, q: number): boolean {
  return (
    text[q] === ',' &&
    isDigit(text[q + 1]) &&
    isDigit(text[q + 2]) &&
    isDigit(text[q + 3]) &&
    !isDigit(text[q + 4])
  );
}

/** 读一个非负数（千分位 / 小数）；读不到返回 null */
function readNumber(text: string, p: number): { value: number; end: number } | null {
  if (!isDigit(text[p])) return null;
  let q = p;
  while (q < text.length) {
    if (isDigit(text[q])) q += 1;
    else if (isThousandsComma(text, q)) q += 4;
    else break;
  }
  if (text[q] === '.' && isDigit(text[q + 1])) {
    q += 1;
    while (isDigit(text[q])) q += 1;
  }
  const value = Number(text.slice(p, q).replace(/,/g, ''));
  return Number.isFinite(value) ? { value, end: q } : null;
}

/** 去方括号 / 黑括号，压空白 */
function stripBrackets(s: string): string {
  return s
    .replace(/[[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 单位名清洗：去方括号，去结尾括注（`(单体目标)`、`(2/2)`），但保留 `(集群)`。
 */
function cleanName(raw: string): string {
  let s = stripBrackets(raw);
  for (let guard = 0; guard < 3; guard += 1) {
    const last = s[s.length - 1];
    if (last !== ')' && last !== '）') break;
    const open = Math.max(s.lastIndexOf('('), s.lastIndexOf('（'));
    if (open <= 0) break;
    if (s.slice(open + 1, -1).trim() === '集群') break;
    s = s.slice(0, open).trim();
  }
  return s.length <= MAX_NAME_LENGTH ? s : '';
}

const NAME_LIST_SEPARATORS = '、,，/／&＆';

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * 名字列表拆分（「甲、乙」「甲,乙」「甲/乙」「甲 和 乙」）。
 * 手写扫描：`\s+和\s+` 这种正则在超长空白上逐位回溯（10 万空格实测数秒），
 * 这里每段空白只走一遍。
 */
function splitNames(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (NAME_LIST_SEPARATORS.includes(ch)) {
      pieces.push(text.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    if (!isWhitespace(ch)) {
      i += 1;
      continue;
    }
    let j = i;
    while (isWhitespace(text[j])) j += 1;
    if (text[j] === '和' && isWhitespace(text[j + 1])) {
      let k = j + 1;
      while (isWhitespace(text[k])) k += 1;
      pieces.push(text.slice(start, i));
      start = k;
      i = k;
    } else {
      i = j;
    }
  }
  pieces.push(text.slice(start));
  return pieces.map((s) => cleanName(s)).filter(Boolean);
}

function isKnownLabel(label: string): boolean {
  return KNOWN_LABELS.has(label) || KNOWN_LABEL_SUFFIX_RE.test(label);
}

/** 标签结尾是不是资源名（`林狼 HP`、`HP`） */
function labelResource(label: string): Resource | null {
  const tail = label.slice(-2).toUpperCase();
  if (tail !== 'HP' && tail !== 'MP' && tail !== 'SP') return null;
  if (isAsciiLetter(label[label.length - 3])) return null;
  return tail;
}

// ── 资源记号扫描 ──────────────────────────────────────────────

interface ResourceToken {
  res: Resource;
  /** 记号前的名字（清洗后，可能为空） */
  name: string;
  /** 名字是已知参与者（最长后缀命中），不是退回的「最后一个词」 */
  known: boolean;
  /** 记号前紧挨的动词给的方向：+1 恢复类 / −1 消耗类 / 0 无 */
  hint: number;
  cur?: number;
  curMax?: number;
  to?: number;
  toMax?: number;
  /** 带符号的变化量（`HP -30`、`(+150)`、箭头后的 `(-64)`） */
  amount?: number;
  end: number;
}

/** ASCII 字母或数字 */
function isAsciiWordChar(ch: string | undefined): boolean {
  return isDigit(ch) || isAsciiLetter(ch);
}

/**
 * s 结尾处最长的已知名字（参与者名，可含空格）。逐长度查集合，与名字数量无关。
 * 名字以 ASCII 字母数字开头时，前一个字符不能也是 —— `Wolf` 不该从 `Werewolf` 里认出来。
 */
function knownSuffix(s: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return '';
  for (let len = Math.min(s.length, MAX_NAME_LENGTH); len > 0; len -= 1) {
    const cand = s.slice(s.length - len);
    if (!names.has(cand)) continue;
    if (len < s.length && isAsciiWordChar(cand[0]) && isAsciiWordChar(s[s.length - len - 1])) {
      continue;
    }
    return cand;
  }
  return '';
}

/** s 开头处最长的已知名字；跳过行首的 `→` / `目标` 引导 */
function knownPrefix(text: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return '';
  let p = skip(text, 0, SPACES + '→->');
  if (text.startsWith('目标', p)) p = skip(text, p + 2, SPACES);
  const s = text.slice(p, p + MAX_NAME_LENGTH + 1);
  for (let len = Math.min(s.length, MAX_NAME_LENGTH); len > 0; len -= 1) {
    const cand = s.slice(0, len);
    if (!names.has(cand)) continue;
    if (isAsciiWordChar(cand[len - 1]) && isAsciiWordChar(s[len])) continue;
    return cand;
  }
  return '';
}

/**
 * 记号前的名字与动词方向。先在已知参与者名里找最长的后缀（`暗影 骑士 HP` 认整名），
 * 找不到再退回最后一个词（`wordFallback` 为假时直接给空名）。
 */
function nameBefore(
  text: string,
  from: number,
  at: number,
  names: ReadonlySet<string> = EMPTY_NAMES,
  wordFallback = true,
): { name: string; known: boolean; hint: number } {
  let s = text.slice(Math.max(from, at - NAME_LOOKBACK), at);
  for (let k = s.length - 1; k >= 0; k -= 1) {
    if (NAME_SEPARATORS.includes(s[k])) {
      s = s.slice(k + 1);
      break;
    }
  }
  s = stripBrackets(s);
  let hint = 0;
  for (const verb of GAIN_VERBS) {
    if (s.endsWith(verb)) {
      hint = 1;
      s = s.slice(0, -verb.length).trim();
      break;
    }
  }
  if (hint === 0) {
    for (const verb of LOSS_VERBS) {
      if (s.endsWith(verb)) {
        hint = -1;
        s = s.slice(0, -verb.length).trim();
        break;
      }
    }
  }
  const known = knownSuffix(s.endsWith('的') ? s.slice(0, -1).trimEnd() : s, names);
  if (known) return { name: known, known: true, hint };
  if (!wordFallback) return { name: '', known: false, hint };
  const words = s.split(' ');
  let name = words[words.length - 1] ?? '';
  if (name.endsWith('的')) name = name.slice(0, -1);
  // `灰狼受创 HP 60→26`：词以已知参与者开头时认那个参与者，不造出「灰狼受创」。
  // 剩下的尾巴至少两个字才算（`盗匪甲` 不归 `盗匪`：单字尾多半是编号，是另一个人）
  const head = knownPrefix(name, names);
  if (head && name.length - head.length >= 2) return { name: head, known: true, hint };
  name = cleanName(name);
  if (!name || NOT_NAMES.has(name) || isDigit(name[0])) name = '';
  return { name, known: false, hint };
}

/** 读 `a` 或 `a/b`，返回读到的值与终点 */
function readGauge(text: string, p: number): { value: number; max?: number; end: number } | null {
  const num = readNumber(text, p);
  if (!num) return null;
  const q = skip(text, num.end, SPACES);
  if (text[q] === '/' || text[q] === '／') {
    const m = readNumber(text, skip(text, q + 1, SPACES));
    if (m) return { value: num.value, max: m.value, end: m.end };
  }
  return { value: num.value, end: num.end };
}

/** 读一个符号；没有返回 0 */
function signAt(text: string, p: number): number {
  const ch = text[p];
  if (ch !== undefined && PLUS.includes(ch)) return 1;
  if (ch !== undefined && MINUS.includes(ch)) return -1;
  return 0;
}

/**
 * 数值后面跟的括注组：`[94%]`、`(-64)`、`(剩余HP: 120)`。至多吃三组。
 */
function readTrailingGroups(text: string, p: number, tok: ResourceToken): number {
  for (let guard = 0; guard < 3; guard += 1) {
    const q = skip(text, p, SPACES);
    if (!OPEN_BRACKETS.includes(text[q] ?? '\0')) break;
    let r = skip(text, q + 1, SPACES);
    if (text.startsWith('剩余', r)) {
      r = skip(text, r + 2, SPACES);
      const res = text.slice(r, r + 2).toUpperCase();
      if (res === 'HP' || res === 'MP' || res === 'SP') r += 2;
      const num = readNumber(text, skip(text, r, SPACES + ':：'));
      if (!num) break;
      if (tok.to === undefined) tok.to = num.value;
      r = num.end;
    } else {
      const sign = signAt(text, r);
      const num = readNumber(text, sign ? skip(text, r + 1, SPACES) : r);
      if (!num) break;
      r = num.end;
      if (text[r] === '%') r += 1;
      else if (sign && tok.amount === undefined) tok.amount = sign * num.value;
      else if (!sign) break;
    }
    r = skip(text, r, SPACES);
    if (!CLOSE_BRACKETS.includes(text[r] ?? '\0')) break;
    p = r + 1;
  }
  return p;
}

/** 从 `HP` 记号之后读数值形态；读不出返回 null */
function readResource(
  text: string,
  at: number,
  from: number,
  res: Resource,
  names: ReadonlySet<string>,
): ResourceToken | null {
  let p = skip(text, at + 2, SPACES + ':：[]【】(（');
  const sign = signAt(text, p);
  const { name, known, hint } = nameBefore(text, from, at, names);
  const tok: ResourceToken = { res, name, known, hint, end: p };
  if (sign) {
    const num = readNumber(text, skip(text, p + 1, SPACES));
    if (!num) return null;
    // `HP -10%` 是百分比，不是点数：不记成 −10
    if (text[skip(text, num.end, SPACES)] === '%' || text[skip(text, num.end, SPACES)] === '％') {
      return null;
    }
    tok.amount = sign * num.value;
    tok.end = readTrailingGroups(text, num.end, tok);
    return tok;
  }
  const cur = readGauge(text, p);
  if (!cur) return null;
  tok.cur = cur.value;
  if (cur.max !== undefined) tok.curMax = cur.max;
  p = cur.end;
  const q = skip(text, p, SPACES + ']】)）');
  if (text[q] === '→') {
    const to = readGauge(text, skip(text, q + 1, SPACES + '[【'));
    if (to) {
      tok.to = to.value;
      if (to.max !== undefined) tok.toMax = to.max;
      tok.end = readTrailingGroups(text, to.end, tok);
      return tok;
    }
  }
  tok.end = skip(text, p, ']】');
  return tok;
}

/** 往回跳过空白，不越过 lo */
function skipBack(text: string, p: number, lo: number): number {
  while (p > lo && SPACES.includes(text[p - 1])) p -= 1;
  return p;
}

/**
 * 后置资源名：`恢复 50 点 HP`、`消耗 12 点 MP`、`回复了30HP`。
 * 只在记号后面读不出数值时才试；回看窗口 ≤ AMOUNT_LOOKBACK 字符。
 * 名字只认已知参与者（`触发[石肤] 恢复 50 点 HP` 里的 `石肤` 是技能名，不是人），
 * 认不出就留空，交给行首名字 / 行动者兜底。
 */
function readLookbackAmount(
  text: string,
  from: number,
  at: number,
  res: Resource,
  names: ReadonlySet<string>,
): ResourceToken | null {
  const lo = Math.max(from, at - AMOUNT_LOOKBACK);
  let p = skipBack(text, at, lo);
  if (p > lo && text[p - 1] === '点') p = skipBack(text, p - 1, lo);
  let q = p;
  while (q > lo && (isDigit(text[q - 1]) || text[q - 1] === ',' || text[q - 1] === '.')) q -= 1;
  if (q === p) return null;
  const num = readNumber(text, q);
  if (!num || num.end !== p) return null;
  let v = skipBack(text, q, lo);
  if (v > lo && text[v - 1] === '了') v -= 1;
  let hint = 0;
  let verbStart = v;
  for (const verb of GAIN_VERBS) {
    if (v - verb.length >= lo && text.startsWith(verb, v - verb.length)) {
      hint = 1;
      verbStart = v - verb.length;
      break;
    }
  }
  if (hint === 0) {
    for (const verb of LOSS_VERBS) {
      if (v - verb.length >= lo && text.startsWith(verb, v - verb.length)) {
        hint = -1;
        verbStart = v - verb.length;
        break;
      }
    }
  }
  if (hint === 0) return null;
  const { name, known } = nameBefore(text, from, verbStart, names, false);
  return { res, name, known, hint, cur: num.value, end: at + 2 };
}

/**
 * 扫出一段文字里全部 HP/MP/SP 记号。线性：每个位置至多被游标访问常数次，
 * 名字回看有窗口上限。
 */
function scanResources(text: string, names: ReadonlySet<string> = EMPTY_NAMES): ResourceToken[] {
  const out: ResourceToken[] = [];
  let segStart = 0;
  let i = 0;
  while (i < text.length - 1) {
    const pair = text.slice(i, i + 2).toUpperCase();
    if (
      (pair === 'HP' || pair === 'MP' || pair === 'SP') &&
      !isAsciiLetter(text[i - 1]) &&
      !isAsciiLetter(text[i + 2])
    ) {
      const tok =
        readResource(text, i, segStart, pair, names) ??
        readLookbackAmount(text, segStart, i, pair, names);
      if (tok) {
        out.push(tok);
        i = Math.max(tok.end, i + 2);
        segStart = i;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// ── 格归一 ────────────────────────────────────────────────────

interface DigestCell {
  label: string;
  value: string;
  source: ActionPanelCell;
}

/** 标签去尾冒号；无标签的散行「行动者：甲」补拆 */
function normalizeCell(cell: ActionPanelCell): DigestCell {
  let label = String(cell.label ?? '');
  let value = String(cell.value ?? '');
  if (label === '') {
    const m = /[:：]/.exec(value.slice(0, MAX_LOOSE_LABEL_LENGTH + 1));
    if (m && m.index > 0) {
      label = value.slice(0, m.index);
      value = value.slice(m.index + 1);
    }
  }
  return { label: label.replace(/[:：]\s*$/, '').trim(), value: value.trim(), source: cell };
}

/** 多目标行行首：`→ 名字` / `→ 目标名字` */
function arrowName(text: string): string | null {
  if (!text.startsWith('→')) return null;
  let s = text.slice(1).trim();
  if (s.startsWith('目标')) s = s.slice(2).trim();
  const space = s.indexOf(' ');
  if (space > 0) s = s.slice(0, space);
  return cleanName(s) || null;
}

/** 行首名字：首格标签是单位名（非协议标签），或 `→ 名字` 多目标行 */
function rowLeadName(cells: readonly DigestCell[]): string | undefined {
  const first = cells[0];
  if (!first) return undefined;
  if (first.label) {
    const arrow = arrowName(first.label);
    if (arrow) return arrow;
    if (isKnownLabel(first.label) || labelResource(first.label)) return undefined;
    const name = cleanName(first.label);
    return name && !isDigit(name[0]) ? name : undefined;
  }
  return arrowName(first.value) ?? undefined;
}

// ── 行动者 / 目标 / 行动 ──────────────────────────────────────

interface Participants {
  actor?: string;
  targets: string[];
  action?: string;
}

/**
 * 一段文字像不像单位名：清洗后非空、不以数字开头、不是「目标 / 剩余」那类词，
 * 且不含句读与分隔符（`制作流程: 熔炼` 带冒号，是「标签: 值」不是名字）。
 */
function isNameShaped(raw: string): boolean {
  const name = cleanName(raw);
  if (!name || isDigit(name[0]) || NOT_NAMES.has(name)) return false;
  for (const ch of name) {
    if (NAME_SEPARATORS.includes(ch)) return false;
  }
  return true;
}

function parseTargets(raw: string, actor: string | undefined, selfAllowed: boolean): string[] {
  const value = raw.trim();
  if (!value || EMPTY_TARGET.test(value)) return [];
  return splitNames(value).filter(
    (n) => !EMPTY_TARGET.test(n) && (selfAllowed || (!SELF_TARGET.test(n) && n !== actor)),
  );
}

/**
 * 标题箭头两侧的名字有没有在面板正文里**作为单位**出现：行首单位名（`|林狼|HP 30→20|`）、
 * 资源记号前的名字（`林狼 HP -34`，按最长后缀认已知名）、名册单位（`林狼: HP 60/60`）、
 * 多目标行 `→ 林狼`。只出现在叙述句里不算 —— 那证明不了标题是「谁对谁」。
 * 全部复用手写游标扫描（scanResources / rowLeadName / arrowName），线性、不回溯。
 */
function titleNamesInBody(rows: DigestCell[][], candidates: readonly string[]): boolean {
  const names = new Set(candidates.filter(Boolean));
  if (names.size === 0) return false;
  for (const row of rows) {
    const lead = rowLeadName(row);
    if (lead && names.has(lead)) return true;
    const first = row[0];
    const arrow = first
      ? (arrowName(first.label) ?? (first.label ? null : arrowName(first.value)))
      : null;
    if (arrow && names.has(arrow)) return true;
    for (const cell of row) {
      const text = labelResource(cell.label) ? `${cell.label} ${cell.value}` : cell.value;
      for (const tok of scanResources(text, names)) {
        if (tok.known || names.has(tok.name)) return true;
      }
    }
  }
  return collectRoster(rows).some((u) => names.has(u.name));
}

function collectParticipants(panel: ActionPanel, rows: DigestCell[][]): Participants {
  const cells = rows.flat();
  const has = (label: string): boolean => cells.some((c) => c.label === label);
  const direct = has('行动者');
  const tactical = has('对象') || has('执行');

  let actor: string | undefined;
  let targetRaw: { value: string; self: boolean } | undefined;
  let action: string | undefined;
  for (const c of cells) {
    if (!c.value) continue;
    switch (c.label) {
      case '行动者':
      case '攻方':
        actor ??= cleanName(c.value) || undefined;
        break;
      case '单位':
      case '角色':
        if (tactical) actor ??= cleanName(c.value) || undefined;
        break;
      case '目标':
        // `|目标|自身|` / `|目标|<行动者>|` 是对自己用：不另列目标，变化归行动者自己
        if (direct) targetRaw ??= { value: c.value, self: false };
        break;
      case '守方':
        targetRaw ??= { value: c.value, self: true };
        break;
      case '对象':
        targetRaw ??= { value: c.value, self: false };
        break;
      case '行动':
        if (direct) action ??= c.value;
        break;
      case '招式':
        action ??= c.value;
        break;
      case '执行':
        action ??= c.value.replace(/^使用\s*/, '') || undefined;
        break;
      default:
        break;
    }
  }

  let targets = targetRaw ? parseTargets(targetRaw.value, actor, targetRaw.self) : [];

  // 兜底：分节标题 `甲 → 乙 · 招式`。
  // 带 `→` 的标题不一定是交锋（`制作流程: 熔炼 → 锻打` 是流程，`{晨 → 昏 · 赶路}` 是叙述）：
  // 格子里已经认出了行动者 / 目标（别的交锋证据）时照取；否则左边得是名字形态，
  // **且**箭头任一侧的名字在面板正文里作为单位出现过（见 titleNamesInBody），才从标题取。
  if (!actor || targets.length === 0 || !action) {
    const title = panel.sections.find((s) => s.title.includes('→'))?.title;
    const arrow = title ? title.indexOf('→') : -1;
    const left = title ? cleanName(title.slice(0, arrow)) : '';
    const leftIsName = isNameShaped(title ? title.slice(0, arrow) : '');
    const right = title
      ? title
          .slice(arrow + 1)
          .split(/[·・]/)
          .map((s) => s.trim())
      : [];
    const trusted =
      !!actor ||
      (leftIsName &&
        (targets.length > 0 ||
          titleNamesInBody(rows, [left, ...parseTargets(right[0] ?? '', left, true)])));
    if (title && trusted) {
      if (!actor && left) actor = left;
      if (targets.length === 0 && right[0]) targets = parseTargets(right[0], actor, true);
      if (!action && right[1]) action = right[1];
    }
  }

  // 多目标行 `→ 名字: …`
  for (const row of rows) {
    const first = row[0];
    if (!first) continue;
    const name = arrowName(first.label) ?? (first.label ? null : arrowName(first.value));
    if (name && !targets.includes(name)) targets.push(name);
  }

  const out: Participants = { targets };
  if (actor) out.actor = actor;
  if (action?.trim()) out.action = action.trim();
  return out;
}

/** 已知参与者名（行动者 + 目标），给名字回看做最长后缀匹配 */
function participantNames(who: Participants): ReadonlySet<string> {
  const names = new Set(who.targets);
  if (who.actor) names.add(who.actor);
  return names;
}

// ── 资源变化 ──────────────────────────────────────────────────

interface DeltaEntry {
  who: string;
  resource: Resource;
  from?: number;
  to?: number;
  max?: number;
  amount?: number;
  /** 来自 `变更` 汇总行 */
  summary?: boolean;
}

interface DeltaAcc {
  who: string;
  resource: Resource;
  arrow: boolean;
  from?: number;
  to?: number;
  max?: number;
  /** 明细行（伤害 / 消耗 / 效果 …）的裸增减之和 */
  detail: number;
  hasDetail: boolean;
  /** `变更` 汇总行的裸增减之和 */
  summary: number;
  hasSummary: boolean;
  amountTo?: number;
}

function mergeDeltas(entries: readonly DeltaEntry[]): ResourceDelta[] {
  const byKey = new Map<string, DeltaAcc>();
  for (const e of entries) {
    const key = `${e.who}\u0000${e.resource}`;
    let acc = byKey.get(key);
    if (!acc) {
      acc = {
        who: e.who,
        resource: e.resource,
        arrow: false,
        detail: 0,
        hasDetail: false,
        summary: 0,
        hasSummary: false,
      };
      byKey.set(key, acc);
    }
    if (e.from !== undefined && e.to !== undefined) {
      // 起止齐全的条目胜过裸增减：首个 from、末个 to
      if (!acc.arrow) {
        acc.arrow = true;
        acc.from = e.from;
      }
      acc.to = e.to;
      if (e.max !== undefined) acc.max = e.max;
    } else if (e.amount !== undefined) {
      if (e.summary) {
        acc.summary += e.amount;
        acc.hasSummary = true;
      } else {
        acc.detail += e.amount;
        acc.hasDetail = true;
      }
      // 写了剩余值的那条胜出
      if (e.to !== undefined) acc.amountTo = e.to;
    }
  }
  const out: ResourceDelta[] = [];
  for (const acc of byKey.values()) {
    if (acc.arrow && acc.from !== undefined && acc.to !== undefined) {
      const d: ResourceDelta = {
        who: acc.who,
        resource: acc.resource,
        delta: acc.to - acc.from,
        from: acc.from,
        to: acc.to,
      };
      if (acc.max !== undefined) d.max = acc.max;
      out.push(d);
    } else if (acc.hasDetail || acc.hasSummary) {
      // `|伤害|灰狼 HP -15|` + `|变更|灰狼 HP -15|` 是同一笔账说了两遍：汇总与明细相等时只记一次
      const restated = acc.hasDetail && acc.hasSummary && acc.detail === acc.summary;
      const amount = restated ? acc.detail : acc.detail + acc.summary;
      const d: ResourceDelta = { who: acc.who, resource: acc.resource, delta: amount };
      if (acc.amountTo !== undefined) d.to = acc.amountTo;
      out.push(d);
    }
  }
  return out;
}

function collectDeltas(rows: DigestCell[][], who: Participants): ResourceDelta[] {
  const entries: DeltaEntry[] = [];
  const legacy: DeltaEntry[] = [];
  const soleTarget = who.targets.length === 1 ? who.targets[0] : undefined;
  const names = participantNames(who);

  for (const row of rows) {
    const rawLead = rowLeadName(row);
    let mode: 'none' | 'cost' | 'effect' | 'change' = 'none';
    /** 本格所在行能不能点出新名字（见 NAMING_LABEL_RE） */
    let naming = false;
    for (const cell of row) {
      if (cell.label && mode === 'change' && labelResource(cell.label)) {
        // 汇总行里被冒号劈开的后半格（标签 `灰狼 HP -15 (剩余HP`）仍属这一行的汇总
      } else if (cell.label) {
        naming = NAMING_LABEL_RE.test(cell.label);
        mode = COST_LABEL_RE.test(cell.label)
          ? 'cost'
          : EFFECT_LABEL_RE.test(cell.label)
            ? 'effect'
            : CHANGE_LABEL_RE.test(cell.label)
              ? 'change'
              : 'none';
      } else if (CHANGE_LABEL_RE.test(cell.value.trim())) {
        // `|变更|灰狼 HP -15 (剩余HP: 45)|` 被冒号拆成「无标签的 `变更`」+ 后面的格：同样算汇总行
        mode = 'change';
        naming = true;
        continue;
      }
      if (PLAIN_NUMBER_RE.test(cell.value) && Number(cell.value) !== 0) {
        // `|伤害|0|` 是落空，不是「HP −0」—— 不记变化，命中判定才会落到 miss
        const n = Number(cell.value);
        if (LEGACY_DAMAGE_LABEL_RE.test(cell.label) && soleTarget) {
          legacy.push({ who: soleTarget, resource: 'HP', amount: -n });
        } else if (LEGACY_HEAL_LABEL_RE.test(cell.label) && (soleTarget ?? who.actor)) {
          legacy.push({ who: (soleTarget ?? who.actor) as string, resource: 'HP', amount: n });
        }
      }

      const text = labelResource(cell.label) ? `${cell.label} ${cell.value}` : cell.value;
      const tokens = scanResources(text, names);
      // 同一格里有两个以上带名字的记号（`盗匪甲 HP -18；盗匪乙 HP -18`）：这是一张逐人清单，
      // 每个词后面都跟着它自己的资源记号，认不出的词也是真单位（旧协议的 `|伤害|` 行就这么写）
      const listing = tokens.filter((t) => t.name).length >= 2;
      // 同一格里后面的记号没写名字时沿用前一个写明的名字（`艾琳 HP 80→70，MP 40→28`）
      let carried = '';
      for (const tok of tokens) {
        // 行首名：点名行、没有参与者的面板（回合状态结算）、已知参与者照认；其余行只有起止齐全
        // （`|幼狼|HP 30→20|`）才像真单位 —— `|减伤后|HP -34|` 的 `减伤后` 不是人
        const lead =
          rawLead !== undefined &&
          !NOT_NAMES.has(rawLead) &&
          (naming ||
            names.size === 0 ||
            names.has(rawLead) ||
            (tok.cur !== undefined && tok.to !== undefined))
            ? rawLead
            : undefined;
        // 记号前认不出的词：点名行 / 逐人清单里当名字；没有参与者、也没有行首名时只能信它；
        // 其余是修饰语（`造成 HP -34`、`减伤后 HP -34`），退回兜底，**不**沿用前一个名字
        const acceptWord =
          tok.known || naming || listing || (names.size === 0 && lead === undefined);
        let rejected = false;
        if (tok.name && acceptWord) carried = tok.name;
        else if (tok.name) rejected = true;
        // 消耗格没写名字、面板也没有行动者时记给空名（`who: ''`）：渲染层当「出手方」显示，
        // 不丢掉这笔账（制作面板就是这样 —— 只有资源消耗，没有行动者行）
        const fallback =
          mode === 'cost'
            ? (who.actor ?? '')
            : mode === 'effect'
              ? (lead ?? soleTarget ?? who.actor)
              : mode === 'change' && tok.res !== 'HP'
                ? (lead ?? who.actor ?? soleTarget)
                : (lead ?? soleTarget);
        const name = rejected ? fallback : carried || fallback;
        if (name === undefined || (name === '' && mode !== 'cost')) continue;
        if (tok.to !== undefined && tok.cur !== undefined) {
          const e: DeltaEntry = { who: name, resource: tok.res, from: tok.cur, to: tok.to };
          const max = tok.toMax ?? tok.curMax;
          if (max !== undefined) e.max = max;
          entries.push(e);
          continue;
        }
        let amount = tok.amount;
        if (amount === undefined && tok.cur !== undefined && tok.curMax === undefined) {
          // ⚠️ 已知限制（刻意不修）：消耗格里的裸数一律当「消耗量」。模型若在消耗格里写的是
          //    现值（`消耗: HP 100` 意为「HP 现在 100」）且没写上限，会被误记成扣 100 ——
          //    没有 `/上限` 时两种写法字面上无从区分，猜错的代价比少认一条更大。
          if (mode === 'cost') amount = -tok.cur;
          else if (tok.hint !== 0) amount = tok.hint * tok.cur;
        }
        if (amount === undefined) continue;
        if (mode === 'cost') amount = -Math.abs(amount);
        if (amount === 0 && tok.to === undefined) continue;
        const e: DeltaEntry = { who: name, resource: tok.res, amount };
        if (tok.to !== undefined) e.to = tok.to;
        if (mode === 'change') e.summary = true;
        entries.push(e);
      }
    }
  }

  const merged = mergeDeltas(entries);
  // 旧格式裸伤害 / 恢复：该单位没有别的 HP 变化时才用
  for (const e of mergeDeltas(legacy)) {
    if (!merged.some((d) => d.who === e.who && d.resource === 'HP')) merged.push(e);
  }
  return merged;
}

// ── 战况名册 ──────────────────────────────────────────────────

/** `腐化食尸鬼(集群) (2/2)` → 名字 + 人数 */
function splitClusterCount(label: string): { name: string; cluster?: RosterUnit['cluster'] } {
  const s = stripBrackets(label);
  const last = s[s.length - 1];
  if (last === ')' || last === '）') {
    const open = Math.max(s.lastIndexOf('('), s.lastIndexOf('（'));
    const m = open > 0 ? /^\s*(\d+)\s*[/／]\s*(\d+)\s*$/.exec(s.slice(open + 1, -1)) : null;
    if (m) {
      return {
        name: cleanName(s.slice(0, open)),
        cluster: { alive: Number(m[1]), total: Number(m[2]) },
      };
    }
  }
  return { name: cleanName(s) };
}

function collectRoster(rows: DigestCell[][]): RosterUnit[] {
  const units = new Map<string, RosterUnit>();
  for (const row of rows) {
    const first = row[0];
    if (!first?.label || isKnownLabel(first.label) || labelResource(first.label)) continue;
    if (first.label.startsWith('→')) continue;
    const head = scanResources(first.value)[0];
    // 首格值必须以 `HP a/b` 这类现值开头（不是变化）
    if (!head || head.name || head.curMax === undefined || head.to !== undefined) continue;
    const { name, cluster } = splitClusterCount(first.label);
    if (!name || isDigit(name[0])) continue;
    const unit: RosterUnit = units.get(name) ?? { name };
    if (cluster) unit.cluster = cluster;
    row.forEach((cell, idx) => {
      if (idx > 0 && cell.label) return;
      for (const tok of scanResources(cell.value)) {
        if (tok.name || tok.cur === undefined || tok.curMax === undefined || tok.to !== undefined)
          continue;
        const gauge = { cur: tok.cur, max: tok.curMax };
        if (tok.res === 'HP') unit.hp = gauge;
        else if (tok.res === 'MP') unit.mp = gauge;
        else unit.sp = gauge;
      }
    });
    units.set(name, unit);
  }
  return [...units.values()];
}

// ── 结论 ──────────────────────────────────────────────────────

function verdictWordTone(word: string): ActionPanelTone | undefined {
  return HIT_RATING_TONES.get(word) ?? OUTCOME_WORD_TONES.get(word);
}

function isVerdictWord(word: string): boolean {
  return verdictWordTone(word) !== undefined || cellTone('结果', word) !== undefined;
}

const TRAILING_STOPS = '。！!.';

/** 剥掉结尾的句号 / 叹号。手写从尾往回扫：`[。！!.]+$` 在一长串 `.` 后跟别的字时逐位回溯 */
function trimTrailingStops(s: string): string {
  let end = s.length;
  while (end > 0 && TRAILING_STOPS.includes(s[end - 1])) end -= 1;
  return s.slice(0, end);
}

/** 值 → 结论文字：取最后一个箭头之后，去括号括注；末尾是结论词就只取那个词 */
function verdictText(value: string): string {
  let t = value;
  const arrow = t.lastIndexOf('→');
  if (arrow >= 0) t = t.slice(arrow + 1);
  t = trimTrailingStops(stripBrackets(t));
  const last = t[t.length - 1];
  if (last === ')' || last === '）') {
    const open = Math.max(t.lastIndexOf('('), t.lastIndexOf('（'));
    if (open > 0) t = t.slice(0, open).trim();
  }
  const parts = t.split(/[\s,，;；]+/).filter(Boolean);
  const tail = parts[parts.length - 1];
  if (parts.length > 1 && tail && isVerdictWord(tail)) return tail;
  return t;
}

interface VerdictPick {
  verdict?: DigestVerdict;
  /** 结论取自哪一格 */
  source?: DigestCell;
  overflow?: ActionPanelCell;
}

/** 一格的结论色（结论词表优先，再看格子本身） */
function verdictTone(c: DigestCell): ActionPanelTone | undefined {
  const text = verdictText(c.value);
  return (text ? verdictWordTone(text) : undefined) ?? cellTone(c.label, c.value);
}

/**
 * 按组取结论：带结论色的胜过不带的（`判定: 失败` 胜过 `结果: 锁芯卡死，撬针折断`），
 * 同为带色 / 同为不带色时按组优先级。
 */
function collectVerdict(cells: readonly DigestCell[]): VerdictPick {
  let overflow: ActionPanelCell | undefined;
  let untoned: VerdictPick | undefined;
  for (let g = 0; g < VERDICT_LABEL_GROUPS.length; g += 1) {
    const re = VERDICT_LABEL_GROUPS[g];
    let found: VerdictPick | undefined;
    let groupOverflow: ActionPanelCell | undefined;
    for (const c of cells) {
      if (!re.test(c.label) || !c.value) continue;
      const text = verdictText(c.value);
      if (!text) continue;
      const tone = verdictTone(c);
      if (g === STATUS_GROUP_INDEX && !tone) continue;
      if (text.length > MAX_VERDICT_LENGTH) {
        groupOverflow = c.source;
        continue;
      }
      found = { verdict: tone ? { text, tone } : { text }, source: c };
    }
    if (found?.verdict?.tone) return found;
    if (found) untoned ??= found;
    else if (!untoned) overflow ??= groupOverflow;
  }
  if (untoned) return untoned;
  return overflow ? { overflow } : {};
}

/** 不是结论的 `状态` 格 */
function collectStatuses(cells: readonly DigestCell[]): string[] {
  const out: string[] = [];
  for (const c of cells) {
    if (c.label !== '状态' || !c.value || EMPTY_TARGET.test(c.value)) continue;
    if (verdictTone(c)) continue;
    out.push(c.value);
  }
  return out;
}

/** `结果` 行的叙述句：最后一个不是结论来源、也不只是一个结论词的 `结果` 格 */
function collectResult(cells: readonly DigestCell[], source?: DigestCell): string | undefined {
  let result: string | undefined;
  for (const c of cells) {
    if (c.label !== '结果' || !c.value || c === source) continue;
    if (isVerdictWord(verdictText(c.value))) continue;
    result = c.value;
  }
  return result;
}

// ── 掷骰 ──────────────────────────────────────────────────────

interface DiceHead {
  die: number;
  value: number;
  /** 骰子个数（`4d6` / 括注里的数个数取大者） */
  count: number;
  end: number;
}

/** 读一个不带千分位的非负整数 */
function readPlainInt(text: string, p: number): { value: number; end: number } | null {
  let q = p;
  while (q < text.length && isDigit(text[q])) q += 1;
  if (q === p) return null;
  const value = Number(text.slice(p, q));
  return Number.isFinite(value) ? { value, end: q } : null;
}

/** 读修正 / 对抗标签（`敏捷`、`闪避`、`DC`），返回终点；不含空白、不超过上限 */
function readRollLabel(text: string, p: number): number {
  let k = p;
  while (
    k < text.length &&
    k - p < MAX_ROLL_LABEL_LENGTH &&
    !isDigit(text[k]) &&
    !SPACES.includes(text[k]) &&
    !ROLL_LABEL_STOP.includes(text[k])
  ) {
    k += 1;
  }
  return k;
}

/** 在 i 处（`d` / `D`）读 `NdM=V`、`NdM(V,…)`、`dM[V]`；读不出返回 null */
function readDiceHead(text: string, i: number): DiceHead | null {
  let q = i;
  while (q > 0 && i - q < 3 && isDigit(text[q - 1])) q -= 1;
  if (q > 0 && (isAsciiWordChar(text[q - 1]) || text[q - 1] === '.')) return null;
  let count = q < i ? Number(text.slice(q, i)) : 1;
  const die = readPlainInt(text, i + 1);
  if (!die) return null;
  let p = skip(text, die.end, SPACES);
  const ch = text[p];
  if (ch === '=' || ch === '＝') {
    p = skip(text, p + 1, SPACES);
    const bracket = OPEN_BRACKETS.includes(text[p] ?? '\0');
    if (bracket) p = skip(text, p + 1, SPACES);
    const v = readPlainInt(text, p);
    if (!v) return null;
    p = v.end;
    if (bracket) {
      const r = skip(text, p, SPACES);
      if (CLOSE_BRACKETS.includes(text[r] ?? '\0')) p = r + 1;
    }
    return { die: die.value, value: v.value, count, end: p };
  }
  if (ch === undefined || !OPEN_BRACKETS.includes(ch)) return null;
  p = skip(text, p + 1, SPACES);
  let sum = 0;
  let read = 0;
  while (read < MAX_DICE_LIST) {
    // 不用 readNumber：`(6,5,4)` 的逗号是分隔，不是千分位
    const v = readPlainInt(text, p);
    if (!v) return null;
    sum += v.value;
    read += 1;
    p = skip(text, v.end, SPACES);
    if (text[p] !== '，' && text[p] !== ',') break;
    p = skip(text, p + 1, SPACES);
  }
  if (!CLOSE_BRACKETS.includes(text[p] ?? '\0')) return null;
  count = Math.max(count, read);
  return { die: die.value, value: sum, count, end: p + 1 };
}

/** 读骰值之后的修正、合计与对抗值 */
function readRollTail(text: string, head: DiceHead, raw: string): DigestRoll {
  const roll: DigestRoll = { die: head.die, value: head.value, raw };
  let p = head.end;
  let modifier = 0;
  let hasModifier = false;
  for (let guard = 0; guard < 6; guard += 1) {
    let r = skip(text, p, SPACES);
    const sign = signAt(text, r);
    if (!sign || text[r + 1] === '>') break;
    r = skip(text, readRollLabel(text, skip(text, r + 1, SPACES)), SPACES);
    const num = readPlainInt(text, r);
    if (!num) break;
    modifier += sign * num.value;
    hasModifier = true;
    p = num.end;
  }
  if (hasModifier) roll.modifier = modifier;

  let r = skip(text, p, SPACES);
  let arrow = 0;
  if (text[r] === '→' || text[r] === '=' || text[r] === '＝') arrow = 1;
  else if (MINUS.includes(text[r] ?? '\0') && text[r + 1] === '>') arrow = 2;
  if (arrow) {
    const total = readPlainInt(text, skip(text, r + arrow, SPACES));
    if (total) {
      roll.total = total.value;
      p = total.end;
      r = skip(text, p, SPACES);
    }
  }

  let cmp = 0;
  const c = text[r];
  if (c === '/' || c === '／' || c === '≤' || c === '≥' || c === '对') cmp = 1;
  else if (c === '<' || c === '>' || c === '＜' || c === '＞') cmp = text[r + 1] === '=' ? 2 : 1;
  else if ((c === 'v' || c === 'V') && (text[r + 1] === 's' || text[r + 1] === 'S')) cmp = 2;
  if (cmp) {
    const labelStart = skip(text, r + cmp, SPACES);
    const labelEnd = readRollLabel(text, labelStart);
    const num = readPlainInt(text, skip(text, labelEnd, SPACES));
    if (num) roll.against = { label: text.slice(labelStart, labelEnd), value: num.value };
  }
  return roll;
}

/**
 * 一格里的第一个掷骰。`singleOnly` 时只认单骰（`1d20(13)`、`d100=31`）——
 * `2d8(5,6)` 这类多骰多半是伤害 / 治疗量，不是检定。
 * 线性：每个 `d` 处的尝试只读有界的一小段（跳空白除外，空白段只会被跳一次）。
 */
function findRoll(text: string, singleOnly: boolean): DigestRoll | undefined {
  for (let i = text.indexOf('d'), j = text.indexOf('D'); i >= 0 || j >= 0;) {
    const at = i < 0 ? j : j < 0 ? i : Math.min(i, j);
    const head = readDiceHead(text, at);
    if (head && (!singleOnly || head.count === 1)) return readRollTail(text, head, text.trim());
    if (at === i) i = text.indexOf('d', at + 1);
    else j = text.indexOf('D', at + 1);
  }
  return undefined;
}

/** 主掷骰：先看判定类标签格，再看其他格里的单骰；目标自己那一行不算 */
function collectMainRoll(
  rows: readonly DigestCell[][],
  targets: ReadonlySet<string>,
): DigestRoll | undefined {
  const pool = rows.filter((row) => !rowTarget(row, targets)).flat();
  const multi = targets.size > 1;
  for (const c of pool) {
    if (!ROLL_LABEL_RE.test(c.label) || !c.value) continue;
    if (multi && knownPrefix(c.value, targets)) continue;
    const roll = findRoll(c.value, false);
    if (roll) return roll;
  }
  for (const c of pool) {
    if (!c.value || ROLL_LABEL_RE.test(c.label)) continue;
    const roll = findRoll(c.value, true);
    if (roll) return roll;
  }
  return undefined;
}

// ── 逐目标命中 ────────────────────────────────────────────────

/** 这一行是不是以某个目标名开头（标签 `盗匪甲` / `→ 目标赛琳` / 散行 `盗匪乙 闪开了`） */
function rowTarget(row: readonly DigestCell[], targets: ReadonlySet<string>): string {
  const first = row[0];
  if (!first) return '';
  return knownPrefix(first.label || first.value, targets);
}

/** 每个目标的证据文字：以它开头的行里各格的值，以及任意格里以它开头的分段 */
function collectTargetEvidence(
  rows: readonly DigestCell[][],
  targets: ReadonlySet<string>,
): Map<string, string[]> {
  const evidence = new Map<string, string[]>();
  const push = (name: string, text: string): void => {
    const list = evidence.get(name);
    if (list) list.push(text);
    else evidence.set(name, [text]);
  };
  for (const row of rows) {
    const lead = rowTarget(row, targets);
    for (const cell of row) {
      if (lead && cell.value) push(lead, cell.value);
      for (const piece of cell.value.split(PIECE_SEPARATORS)) {
        const name = knownPrefix(piece, targets);
        if (name && name !== lead) push(name, piece.trim());
      }
    }
  }
  return evidence;
}

/** `伤害: 21 / 0 / 18` 按目标顺序给出的伤害；个数对不上目标数就不用 */
function positionalDamage(cells: readonly DigestCell[], count: number): number[] | undefined {
  for (const c of cells) {
    if (!LEGACY_DAMAGE_LABEL_RE.test(c.label) || !c.value) continue;
    const parts = c.value.split(/[/／]/).map((s) => s.trim());
    if (parts.length !== count || !parts.every((s) => PLAIN_NUMBER_RE.test(s))) continue;
    return parts.map(Number);
  }
  return undefined;
}

/**
 * 逐目标命中，证据按序：
 * ① 以目标名开头的行写了失手 / 未命中 / 闪避成功 … → miss
 * ② 该目标有 HP 变化 → hit
 * ③ 只有一个目标且结论是命中评级 → 按评级
 * ④ `伤害` 按位置列出（个数 = 目标数）→ 非零 hit、零 miss
 * ⑤ 否则 unknown
 */
function collectTargetResults(
  rows: readonly DigestCell[][],
  cells: readonly DigestCell[],
  targets: readonly string[],
  deltas: readonly ResourceDelta[],
  verdict: DigestVerdict | undefined,
): DigestTargetResult[] {
  if (targets.length === 0) return [];
  const set = new Set(targets);
  const evidence = collectTargetEvidence(rows, set);
  const positional = positionalDamage(cells, targets.length);
  const rating = targets.length === 1 && verdict ? HIT_RATING_TONES.get(verdict.text) : undefined;
  return targets.map((name, idx) => {
    const ev = evidence.get(name) ?? [];
    let roll: DigestRoll | undefined;
    for (const text of ev) {
      roll = findRoll(text, false);
      if (roll) break;
    }
    let hit: DigestTargetHit = 'unknown';
    if (ev.some((text) => MISS_WORDS.some((w) => text.includes(w)))) hit = 'miss';
    else if (deltas.some((d) => d.who === name && d.resource === 'HP' && d.delta)) hit = 'hit';
    else if (rating) hit = rating === 'success' ? 'hit' : 'miss';
    else if (positional) hit = positional[idx] > 0 ? 'hit' : 'miss';
    const out: DigestTargetResult = { name, hit };
    if (roll) out.roll = roll;
    return out;
  });
}

// ── 关键格 ────────────────────────────────────────────────────

function outcomeFacts(cells: readonly DigestCell[]): ActionPanelCell[] {
  const picked: ActionPanelCell[] = [];
  for (const re of OUTCOME_FACT_LABELS) {
    let last: ActionPanelCell | undefined;
    for (const c of cells) if (c.value && re.test(c.label)) last = c.source;
    if (last && !picked.includes(last)) picked.push(last);
    if (picked.length >= MAX_FACTS) break;
  }
  return picked;
}

/** generic 多节面板里的结论格（带结论色的格也算） */
const CONCLUSION_LABEL_RE = /^(?:结果|检定结果|判定|检定)$/;
/** 次一等的关键格（与 action-panel 的 summaryCells 同口径） */
const KEY_FACT_LABEL_RE = /^(?:结果|伤害|治疗|产物|品质|掷骰)$|(?:HP|MP|SP)$/i;

/**
 * generic 多节面板的关键格：新协议把结果写在最后一节末尾，只看第一节会漏掉结论。
 * 先取全部分节里的结论格（带色 / `结果` 类，偏向靠后的），不足再补关键标签格（同样偏向靠后的），
 * 按原文顺序输出、至多 MAX_FACTS 个；一个都没有时退回第一节的 summaryCells。
 */
function multiSectionFacts(
  sections: ActionPanel['sections'],
  cells: readonly DigestCell[],
): ActionPanelCell[] {
  const primary: DigestCell[] = [];
  const secondary: DigestCell[] = [];
  for (const c of cells) {
    if (!c.value.trim()) continue;
    if (c.source.tone || CONCLUSION_LABEL_RE.test(c.label)) primary.push(c);
    else if (KEY_FACT_LABEL_RE.test(c.label)) secondary.push(c);
  }
  const picked = new Set(primary.slice(-MAX_FACTS));
  for (let i = secondary.length - 1; i >= 0 && picked.size < MAX_FACTS; i -= 1) {
    picked.add(secondary[i]);
  }
  if (picked.size === 0) return sections[0] ? summaryCells(sections[0]) : [];
  return cells.filter((c) => picked.has(c)).map((c) => c.source);
}

// ── 入口 ──────────────────────────────────────────────────────

function emptyDigest(): ActionDigest {
  return {
    kind: 'generic',
    title: '',
    targets: [],
    targetResults: [],
    deltas: [],
    roster: [],
    facts: [],
    statuses: [],
  };
}

function digest(panel: ActionPanel): ActionDigest {
  const sections = Array.isArray(panel?.sections) ? panel.sections : [];
  const rows: DigestCell[][] = sections.flatMap((s) =>
    (s.rows ?? []).map((r) => (r.cells ?? []).map(normalizeCell)),
  );
  const cells = rows.flat();

  const who = collectParticipants({ sections }, rows);
  const deltas = collectDeltas(rows, who);
  const roster = collectRoster(rows);
  const { verdict, source, overflow } = collectVerdict(cells);
  const outcomeCells = outcomeFacts(cells);
  // 单独一格「品质」不足以说明是结算面板（`生产准备` 里也写目标品质）
  const outcomeSignal = cells.some(
    (c) => c.value && OUTCOME_FACT_LABELS.some((re) => re !== QUALITY_LABEL_RE && re.test(c.label)),
  );

  const kind: ActionDigestKind = who.actor
    ? 'exchange'
    : roster.length > 0
      ? 'roster'
      : outcomeSignal || sections.some((s) => OUTCOME_TITLE_RE.test(s.title))
        ? 'outcome'
        : 'generic';

  let facts: ActionPanelCell[];
  if (kind === 'generic') {
    // 单节面板保持旧行为：facts 恒等于 summaryCells(第一节)
    const filled = sections.filter((s) =>
      (s.rows ?? []).some((r) => (r.cells ?? []).some((c) => String(c.value ?? '').trim())),
    );
    if (filled.length > 1) facts = multiSectionFacts(sections, cells);
    else facts = sections[0] ? summaryCells(sections[0]) : [];
  } else {
    facts = kind === 'outcome' ? [...outcomeCells] : [];
    if (overflow && facts.length < MAX_FACTS && !facts.includes(overflow)) facts.push(overflow);
  }

  const out: ActionDigest = {
    kind,
    title: sections.find((s) => s.title)?.title ?? '',
    targets: who.targets,
    targetResults: collectTargetResults(rows, cells, who.targets, deltas, verdict),
    deltas,
    roster,
    facts,
    statuses: collectStatuses(cells),
  };
  if (who.actor) out.actor = who.actor;
  if (who.action) out.action = who.action;
  if (verdict) out.verdict = verdict;
  const roll = collectMainRoll(rows, new Set(who.targets));
  if (roll) out.roll = roll;
  const result = collectResult(cells, source);
  if (result) out.result = result;
  return out;
}

/**
 * 面板结构 → 摘要。**永不抛**：任何异常都退回空的 generic 摘要。
 */
export function digestActionPanel(panel: ActionPanel): ActionDigest {
  try {
    return digest(panel);
  } catch {
    return emptyDigest();
  }
}
