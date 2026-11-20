/**
 * `<action_info>` 行动面板 — 纯解析器
 *
 * 世界书与直出协议都让 AI 在正文里写一段竖线表面板（检定 / 伤害 / 资源变化 / 制作三阶段……）。
 * 本模块只负责把那段文本拆成结构，渲染交给 `components/game/ActionPanel.vue`：
 *
 *   - `splitActionInfo()`  — 正文 → 文本片段与面板片段（容忍流式中未闭合 / 半截标签）
 *   - `rulesClaimActionInfo()` — 启用的美化规则是否自己接管 `<action_info>`（是则渲染面让位）
 *   - `parseActionPanel()` — 面板原文 → 分节 / 行 / 格（label·value·tone）
 *   - `summaryCells()`     — 收起时标题条右侧的 ≤3 个关键格
 *   - `highlightValue()`   — 值 → 着色 token（骰值 / 增减 / 箭头），组件按 token 插值渲染，不走 v-html
 *
 * 全部是纯函数，任何输入都**不抛**：AI 输出什么样都有可能，面板解析失败不能拖垮整条消息。
 */

import type { BeautifierRule } from '@engine/types/types';

// ── 类型 ──────────────────────────────────────────────────────

/** 正文片段：普通文本或一个面板原文（不含 `<action_info>` 标签本身） */
export type ActionInfoSegment = { kind: 'text'; text: string } | { kind: 'panel'; raw: string };

/** 结论色：成功类 / 失败类 */
export type ActionPanelTone = 'success' | 'error';

/** 分节色相：总览·准备 / 出手（A → B）/ 检定 / 结算 */
export type ActionPanelHue = 'info' | 'strike' | 'check' | 'gain';

export interface ActionPanelCell {
  /** 标签；无冒号的单格与散行备注为空串 */
  label: string;
  value: string;
  tone?: ActionPanelTone;
}

interface ActionPanelRow {
  cells: ActionPanelCell[];
}

export interface ActionPanelSection {
  /** 分节标题；第一个 `{标题}` 之前的内容与全无标题的面板为空串（渲染时显示「行动详情」） */
  title: string;
  hue: ActionPanelHue;
  rows: ActionPanelRow[];
}

export interface ActionPanel {
  sections: ActionPanelSection[];
}

/** 值高亮 token；无 `kind` 的是普通文本 */
export interface HighlightToken {
  text: string;
  kind?: 'dice' | 'up' | 'down' | 'arrow';
}

export interface SplitActionInfoOptions {
  /** 流式中：裁掉结尾半截的 `<action_i…` / `</action_…` 残标签 */
  partial?: boolean;
  /**
   * 战斗流专用：标签**外**的「整行 `{标题}` + 以竖线开头的行」也当面板。
   * 战斗 DM 常不写外层 `<action_info>`，直接甩一张竖线表；主线正文不开（`{…}` 在小说里另有用处）。
   */
  bareSheets?: boolean;
}

// ── 关键词表 ──────────────────────────────────────────────────

/**
 * 结论词条。`tone` 一律是**出手方**视角；`attacker` 标的是本身已经写明了攻守关系的复合词
 * （`闪避成功` / `被格挡`），防守标签下不再翻转它们。
 */
interface ConclusionWord {
  word: string;
  tone: ActionPanelTone;
  attacker?: boolean;
}

/** 失败类结论词 */
const FAILURE_WORDS: readonly string[] = [
  '大失败',
  '未命中',
  '未通过',
  '不通过',
  '不满足',
  '不足',
  '失败',
  '落空',
  '终止',
];

/** 写明攻守关系的失败类复合词（对出手方而言，被闪避 / 被格挡都是失败） */
const ATTACKER_FAILURE_WORDS: readonly string[] = [
  '闪避成功',
  '格挡成功',
  '招架成功',
  '被闪避',
  '被格挡',
  '被招架',
  '格挡',
];

/** 成功类结论词 */
const SUCCESS_WORDS: readonly string[] = [
  '大成功',
  '成功',
  '暴击',
  '命中',
  '充足',
  '满足',
  '通过',
  '完成',
];

/**
 * 否定前缀：接在成功类词前就是失败（`未成功`、`没有命中`、`未能通过`、`未完成`）。
 * 长的在前，免得 `没有命中` 只认出 `没` 之后的 `有命中`。
 */
const NEGATION_PREFIXES: readonly string[] = ['没有', '未能', '无法', '未', '不', '没'];

/** 全部结论词，按长度降序（同一位置取最长的那个） */
const CONCLUSION_WORDS: readonly ConclusionWord[] = [
  ...FAILURE_WORDS.map((word) => ({ word, tone: 'error' as const })),
  ...ATTACKER_FAILURE_WORDS.map((word) => ({ word, tone: 'error' as const, attacker: true })),
  // 被否定的防守复合词：`未被格挡` = 出手方没被挡下，不算结论（后面通常跟着真正的结论）
  ...['被闪避', '被格挡', '被招架'].map((w) => ({
    word: `未${w}`,
    tone: 'success' as const,
    attacker: true,
  })),
  ...SUCCESS_WORDS.flatMap((w) => [
    { word: w, tone: 'success' as const },
    ...NEGATION_PREFIXES.map((p) => ({ word: p + w, tone: 'error' as const })),
  ]),
].sort((a, b) => b.word.length - a.word.length);

/**
 * 「结论标签」：这些标签下的值直接在整串里找结论词（`结果: 命中`、`|检定|d20=12，成功|`）。
 * 其他标签（如 `闪避: 13`、`品质要求检查: …`）只有当值本身就是一个结论词时才上色，
 * 免得把「闪避」这类标签名或普通描述误判成结论。
 */
const RESULT_LABEL_RE = /(?:结果|结论|判定|状态)$|^(?:检定|命中)$/;

/**
 * 防守动作标签：值里的裸结论是**防守方**视角，对出手方要翻过来 ——
 * `闪避: 成功` = 攻击落空（失败色），`闪避: 失败` = 攻击命中（成功色）。
 * 已写明攻守关系的复合词（`闪避成功`、`被格挡`）不翻。
 */
const DEFENSE_LABEL_RE = /^(?:闪避|格挡|招架)$/;

/** 值「本身就是结论」时允许的动作前缀：`[制作成功]`、`检定失败` */
const CONCLUSION_PREFIXES = ['制作', '检定', '攻击', '判定', ''];

/** 收起时优先展示的关键标签 */
const SUMMARY_LABEL_RE = /^(?:结果|伤害|治疗|产物|品质|掷骰)$|(?:HP|MP|SP)$/i;

const UNTITLED_HUE: ActionPanelHue = 'info';

// ── splitActionInfo ───────────────────────────────────────────

const OPEN_TAG_RE = /<\s*action_info\s*>/i;
const CLOSE_TAG_RE = /<\s*\/\s*action_info\s*>/i;
const ANY_TAG_RE = /<\s*(\/?)\s*action_info\s*>/gi;
const TAG_NAME = 'action_info';

/** 结尾若是半截的 `<action_info` / `</action_info` 残标签就裁掉 */
function trimPartialTag(text: string): string {
  const lt = text.lastIndexOf('<');
  if (lt < 0) return text;
  const tail = text.slice(lt + 1);
  if (tail.includes('>')) return text;
  const name = tail.replace(/\s+/g, '').replace(/^\//, '').toLowerCase();
  return TAG_NAME.startsWith(name) ? text.slice(0, lt) : text;
}

/**
 * 定稿消息里未闭合的 `<action_info>`：面板到哪儿为止（返回 `afterOpen` 里的切点）。
 *
 * 面板内容开始之后，遇到**空行**或**既不是 `{标题}` 行也不是竖线行**的行就收束；
 * 开标签之后、内容之前的空行跳过。切点落在那一行的行首，其后原样还给正文。
 */
function unclosedPanelEnd(afterOpen: string): number {
  let seenContent = false;
  let pos = 0;
  while (pos <= afterOpen.length) {
    const nl = afterOpen.indexOf('\n', pos);
    const lineEnd = nl < 0 ? afterOpen.length : nl;
    const line = afterOpen.slice(pos, lineEnd).trim();
    if (!line) {
      if (seenContent) return pos;
    } else if (TITLE_LINE_RE.test(line) || PIPE_RE.test(line)) {
      seenContent = true;
    } else {
      return pos;
    }
    if (nl < 0) break;
    pos = nl + 1;
  }
  return afterOpen.length;
}

/**
 * 把正文切成文本 / 面板片段。
 *
 * - 标签大小写不敏感，允许内部空白（`< ACTION_INFO >`、`</ action_info>`）
 * - 未闭合的 `<action_info>`：`partial`（流式中）把其后全部算作面板；定稿消息只吃到
 *   第一个空行或第一个不像面板的行为止（`unclosedPanelEnd`），其后仍是正文
 * - 孤立的 `</action_info>` 丢掉
 * - `partial` 下裁掉结尾半截的残标签
 * - 纯空白的文本片段丢掉；文本片段本身不 trim，保持原样
 */
export function splitActionInfo(
  text: string,
  options: SplitActionInfoOptions = {},
): ActionInfoSegment[] {
  const source = typeof text === 'string' ? text : String(text ?? '');
  try {
    const segments: ActionInfoSegment[] = [];
    const pushText = (t: string): void => {
      if (t.trim()) segments.push({ kind: 'text', text: t });
    };

    let rest = source;
    while (rest) {
      const open = OPEN_TAG_RE.exec(rest);
      const close = CLOSE_TAG_RE.exec(rest);
      // 孤立的闭标签：先于任何开标签出现 → 丢掉标签，前面算文本
      if (close && (!open || close.index < open.index)) {
        pushText(rest.slice(0, close.index));
        rest = rest.slice(close.index + close[0].length);
        continue;
      }
      if (!open) {
        pushText(rest);
        break;
      }
      pushText(rest.slice(0, open.index));
      const afterOpen = rest.slice(open.index + open[0].length);
      const end = CLOSE_TAG_RE.exec(afterOpen);
      // 闭标签之前又出现开标签：这一个也算没闭合（闭标签属于后面那个）
      const nextOpen = OPEN_TAG_RE.exec(afterOpen);
      if (!end || (nextOpen && nextOpen.index < end.index)) {
        if (options.partial && !nextOpen) {
          // 流式中未闭合：其后全部算面板（闭标签还没到）
          segments.push({ kind: 'panel', raw: afterOpen });
          break;
        }
        // 漏写了闭标签：面板只吃到「面板样子」的行为止（且不越过下一个开标签），其后仍是正文
        const scope = nextOpen ? afterOpen.slice(0, nextOpen.index) : afterOpen;
        const cut = options.partial ? scope.length : unclosedPanelEnd(scope);
        segments.push({ kind: 'panel', raw: afterOpen.slice(0, cut) });
        rest = afterOpen.slice(cut);
        continue;
      }
      segments.push({ kind: 'panel', raw: afterOpen.slice(0, end.index) });
      rest = afterOpen.slice(end.index + end[0].length);
    }

    if (options.partial && segments.length > 0) {
      const last = segments[segments.length - 1];
      if (last.kind === 'text') {
        const trimmed = trimPartialTag(last.text);
        if (trimmed.trim()) last.text = trimmed;
        else segments.pop();
      } else {
        last.raw = trimPartialTag(last.raw);
      }
    }
    if (!options.bareSheets) return segments;
    return segments.flatMap((seg) => (seg.kind === 'text' ? splitBareSheets(seg.text) : [seg]));
  } catch {
    return source.trim() ? [{ kind: 'text', text: source }] : [];
  }
}

/**
 * `bareSheets`：把一段（标签外的）文本里的裸面板切出来。
 *
 * 逐行扫：整行 `{标题}`（可一行多个）开一张面板（已在面板里就另起一节），以竖线开头的行
 * 并入当前面板（没有就新开一张无标题的），空行不打断面板，其余行收束面板、回到文本。
 * 只有标题、没跟任何竖线行的 `{…}` 行原样还给文本 —— 不吞内容。
 */
function splitBareSheets(text: string): ActionInfoSegment[] {
  const out: ActionInfoSegment[] = [];
  let prose: string[] = [];
  let sheet: { lines: string[]; hasRows: boolean } | null = null;
  const flushProse = (): void => {
    const t = prose.join(NEWLINE);
    if (t.trim()) out.push({ kind: 'text', text: t });
    prose = [];
  };
  const flushSheet = (): void => {
    if (!sheet) return;
    if (sheet.hasRows) out.push({ kind: 'panel', raw: sheet.lines.join(NEWLINE) });
    else prose.push(...sheet.lines);
    sheet = null;
  };
  for (const rawLine of text.split(LINE_BREAK_RE)) {
    const line = rawLine.trim();
    if (TITLE_LINE_RE.test(line)) {
      // 连续的标题 / 竖线行同属一张面板，各 `{标题}` 在面板里各成一节
      if (sheet) sheet.lines.push(line);
      else {
        flushProse();
        sheet = { lines: [line], hasRows: false };
      }
      continue;
    }
    if (BARE_ROW_RE.test(line)) {
      if (!sheet) {
        flushProse();
        sheet = { lines: [], hasRows: false };
      }
      sheet.lines.push(line);
      sheet.hasRows = true;
      continue;
    }
    if (!line && sheet) continue;
    flushSheet();
    prose.push(rawLine);
  }
  flushSheet();
  flushProse();
  return out;
}

const NEWLINE = '\n';
const LINE_BREAK_RE = /\r?\n/;

/** 规则 pattern 里提到 `action_info`（大小写不敏感）就算接管 */
const ACTION_INFO_IN_PATTERN_RE = /action_info/i;

/** 正文里闭合的整块 `<action_info>…</action_info>`（含标签） */
const CLOSED_BLOCK_RE = /<\s*action_info\s*>[\s\S]*?<\s*\/\s*action_info\s*>/gi;

/** 规则能不能把这一整块吃下来：从块首开始匹配，且匹配到的正是整块 */
function matchesWholeBlock(rule: BeautifierRule, block: string): boolean {
  try {
    const flags = (rule.flags ?? '').replace(/[gy]/g, '');
    const m = new RegExp(rule.pattern, flags).exec(block);
    return !!m && m.index === 0 && m[0] === block;
  } catch {
    // 编译不过的规则在美化管线里是惰性的，当然也接管不了
    return false;
  }
}

/**
 * 当前生效的美化规则里，是否有规则真的接管了这段正文里的 `<action_info>`。
 *
 * 判据（全部满足）：`enabled` 为真、scope 覆盖 `scope`（同名或 `global`）、`depth` 落在规则的
 * `minDepth`/`maxDepth` 之内（前三条与 `compileBeautifierSegments` 的规则筛选同口径）、
 * `pattern` 源码提到 `action_info`（大小写不敏感），**并且**规则能编译、能把正文里
 * 至少一整块闭合的 `<action_info>…</action_info>` 从头到尾匹配下来。
 * 只是提到这个词、或只能吃下半块的规则不算 —— 那种时候让位只会把面板漏成原文。
 * 正文里没有闭合块（流式中）就不让位。「美化开关开没开」由调用方先判。
 */
export function rulesClaimActionInfo(
  rules: readonly BeautifierRule[] | null | undefined,
  text: string,
  scope = 'maintext',
  depth = 0,
): boolean {
  try {
    const blocks = typeof text === 'string' ? (text.match(CLOSED_BLOCK_RE) ?? []) : [];
    if (blocks.length === 0) return false;
    return (rules ?? []).some(
      (rule) =>
        !!rule &&
        rule.enabled === true &&
        (rule.scope === 'global' || rule.scope === scope) &&
        (rule.minDepth === undefined || depth >= rule.minDepth) &&
        (rule.maxDepth === undefined || depth <= rule.maxDepth) &&
        typeof rule.pattern === 'string' &&
        ACTION_INFO_IN_PATTERN_RE.test(rule.pattern) &&
        blocks.some((block) => matchesWholeBlock(rule, block)),
    );
  } catch {
    return false;
  }
}

// ── parseActionPanel ──────────────────────────────────────────

const TITLE_LINE_RE = /^(?:[{｛][^{}｛｝]*[}｝]\s*)+$/;
/** 裸面板行：以半角 / 全角竖线开头 */
const BARE_ROW_RE = /^[|｜]/;
const TITLE_PART_RE = /[{｛]([^{}｛｝]*)[}｝]/g;
const PIPE_RE = /[|｜]/;
const COLON_RE = /[:：]/;

function stripComments(raw: string): string {
  // 闭合的注释整段删；流式中未闭合的 `<!--` 删到结尾
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/<!--[\s\S]*$/, '');
}

/**
 * `->` / `-->` 归一成 `→`，两侧空白原样保留。
 *
 * 🔴 正则必须保持线性：旧写法 `\s*-+>\s*` 在超长空白上逐位回溯（20 万个空格约 22 秒，
 *    流式中每个 token 重算一次）。`(?<!-)` 让一串 `-` 只从开头试一次。
 */
function normalizeArrows(s: string): string {
  return s.replace(/(?<!-)-+>/g, '→');
}

/** 按分节标题决定色相 */
export function sectionHue(title: string): ActionPanelHue {
  if (/→|->/.test(title)) return 'strike';
  if (title.includes('检定')) return 'check';
  if (/结算|结果/.test(title)) return 'gain';
  return 'info';
}

/**
 * 从左到右扫值里的结论词（同一位置取最长、不重叠），返回**最后一个**。
 * 混合分句以最后的结论为准：`闪避失败，命中`、`未被格挡，命中` → 命中。
 */
function lastConclusion(value: string): ConclusionWord | undefined {
  let last: ConclusionWord | undefined;
  let i = 0;
  while (i < value.length) {
    const hit = CONCLUSION_WORDS.find((c) => value.startsWith(c.word, i));
    if (hit) {
      last = hit;
      i += hit.word.length;
    } else i += 1;
  }
  return last;
}

/** 「值本身就是结论」的长度上限（含动作前缀与括注） */
const MAX_CONCLUSION_VALUE_LENGTH = 40;

/** 值本身是不是一个结论：`成功`、`[制作成功]`、`不足(终止)`、`闪避成功` */
function conclusionOf(value: string): ConclusionWord | undefined {
  let core = value.trim();
  // 结论本身很短；长值直接判「不是结论」，也让下面两条去尾正则碰不到超长输入（否则会平方级回溯）
  if (core.length > MAX_CONCLUSION_VALUE_LENGTH) return undefined;
  // 整串被括号包住：`[制作成功]`
  const wrapped = /^[[【(（]([^[\]【】()（）]*)[\]】)）]$/.exec(core);
  if (wrapped) core = wrapped[1];
  core = core
    // 允许结论后跟一段括注：`不足(终止)`、`不满足(原因)`
    .replace(/\s*[(（【[][^)）】\]]*[)）】\]]$/, '')
    .replace(/[!！。.]+$/, '')
    .trim();
  if (!core) return undefined;
  for (const prefix of CONCLUSION_PREFIXES) {
    if (!core.startsWith(prefix)) continue;
    const rest = core.slice(prefix.length);
    const hit = CONCLUSION_WORDS.find((c) => c.word === rest);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 判定一格的结论色（出手方视角）。
 *
 * 1. 标签是结论标签（结果 / 检定结果 / 状态 / 检定 …）→ 取整串值里**最后一个**结论词；
 *    否定前缀（未 / 不 / 没 / 没有 / 未能 / 无法）接成功类词算失败
 * 2. 否则只有值本身就是结论词（可带动作前缀与括注）才上色 —— `闪避: 13` 不会被误标
 * 3. 防守动作标签（闪避 / 格挡 / 招架）下的裸结论翻转：防守成功 = 出手失败，反之亦然；
 *    已写明攻守关系的复合词（`闪避成功`、`被格挡`）不翻
 */
export function cellTone(label: string, value: string): ActionPanelTone | undefined {
  const l = label.trim();
  const v = value.trim();
  if (!v) return undefined;
  const hit = RESULT_LABEL_RE.test(l) ? lastConclusion(v) : conclusionOf(v);
  if (!hit) return undefined;
  if (DEFENSE_LABEL_RE.test(l) && !hit.attacker) {
    return hit.tone === 'success' ? 'error' : 'success';
  }
  return hit.tone;
}

function makeCell(label: string, value: string): ActionPanelCell {
  const cell: ActionPanelCell = { label, value };
  const tone = cellTone(label, value);
  if (tone) cell.tone = tone;
  return cell;
}

function splitCell(text: string): ActionPanelCell {
  const m = COLON_RE.exec(text);
  if (!m || m.index === 0) {
    return makeCell('', m ? text.slice(1).trim() : text);
  }
  return makeCell(text.slice(0, m.index).trim(), text.slice(m.index + 1).trim());
}

function parsePipeLine(line: string): ActionPanelRow | null {
  const parts = line
    .split(PIPE_RE)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  // 直出格式 `|名称|值|`：恰好两格且都无冒号 → 合成一格
  if (parts.length === 2 && !COLON_RE.test(parts[0]) && !COLON_RE.test(parts[1])) {
    return { cells: [makeCell(parts[0], parts[1])] };
  }
  return { cells: parts.map(splitCell) };
}

function parsePanel(raw: string): ActionPanel {
  const text = normalizeArrows(stripComments(raw).replace(ANY_TAG_RE, '\n'));
  const sections: ActionPanelSection[] = [];
  let current: ActionPanelSection | null = null;
  const ensure = (): ActionPanelSection => {
    if (!current) {
      current = { title: '', hue: UNTITLED_HUE, rows: [] };
      sections.push(current);
    }
    return current;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (TITLE_LINE_RE.test(line)) {
      const titles = Array.from(line.matchAll(TITLE_PART_RE), (m) => m[1].trim()).filter(Boolean);
      const title = titles.join(' · ');
      current = { title, hue: title ? sectionHue(title) : UNTITLED_HUE, rows: [] };
      sections.push(current);
      continue;
    }
    if (PIPE_RE.test(line)) {
      const row = parsePipeLine(line);
      if (row) ensure().rows.push(row);
      continue;
    }
    // 散行备注：不丢，作为无标签的一格并入当前分节
    ensure().rows.push({ cells: [makeCell('', line)] });
  }

  return { sections: sections.filter((s) => s.rows.length > 0) };
}

/**
 * 面板原文 → 分节结构。传入带不带 `<action_info>` 标签都行；永不抛，失败返回空面板。
 */
export function parseActionPanel(raw: string): ActionPanel {
  try {
    return parsePanel(typeof raw === 'string' ? raw : String(raw ?? ''));
  } catch {
    return { sections: [] };
  }
}

// ── summaryCells ──────────────────────────────────────────────

/**
 * 收起时标题条右侧的关键格（≤3）：先结论格，再关键标签格（结果 / 伤害 / 治疗 / 产物 /
 * 品质 / 掷骰，以及以 HP/MP/SP 结尾的）；两样都没有就取前两格。
 */
export function summaryCells(section: ActionPanelSection): ActionPanelCell[] {
  try {
    const cells = section.rows.flatMap((r) => r.cells).filter((c) => c.value.trim());
    const picked: ActionPanelCell[] = cells.filter((c) => c.tone);
    for (const c of cells) {
      if (!c.tone && SUMMARY_LABEL_RE.test(c.label.trim())) picked.push(c);
    }
    return (picked.length > 0 ? picked : cells.slice(0, 2)).slice(0, 3);
  } catch {
    return [];
  }
}

// ── highlightValue ────────────────────────────────────────────

/** 一个数：千分位（`1,200`）或普通整数，可带小数 */
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
/** 箭头一侧的量：可带符号，可是 `a/b` 分数（比较时取分子） */
const SIDE = String.raw`[-−]?${NUM}(?:\s*/\s*${NUM})?`;
/** 「独立」的增减：前面是开头、空白或开括号 / 分隔标点，不能连在字母或汉字后 */
const DELTA_LEAD = String.raw`(?<=^|[\s(（\[【,，:：;；/])`;
const HIGHLIGHT_RE = new RegExp(
  [
    // 骰值：d20=15、2d6=7、D6 = 4、d20(11) / d20(11,17)
    String.raw`(?<dice>(?<![A-Za-z\d])\d*[dD]\d+(?:\s*=\s*\d+|\(\d+(?:[,，]\s*\d+)*\)))`,
    // 数值变化：60 → 26、20/100 → 60/100、1,200 → 900（两端不能是更长数串的一截）
    String.raw`(?<![\d.])(?<!\d[,/])(?<from>${SIDE})(?<s1>[ \t]*)(?:→|->)(?<s2>[ \t]*)(?<to>${SIDE})(?![\d.]|[,/]\d)`,
    // 增益：+5 / ＋35
    String.raw`${DELTA_LEAD}(?<up>[+＋]\d+(?:\.\d+)?)(?![\d.A-Za-z])`,
    // 减损：−20 / -3
    String.raw`${DELTA_LEAD}(?<down>[-−]\d+(?:\.\d+)?)(?![\d.A-Za-z])`,
  ].join('|'),
  'g',
);

/** 箭头一侧的「第一个数」：分数取分子，去千分位；读不出来返回 NaN */
function leadingNumber(side: string): number {
  const m = /^([-−]?)((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/.exec(side.trim());
  if (!m) return Number.NaN;
  return Number((m[1] ? '-' : '') + m[2].replace(/,/g, ''));
}

const OPERATORS = '+＋-−×*/÷';
const OPEN_BRACKETS = '(（[【';
const CLOSE_BRACKETS = ')）]】';

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '　';
}

/**
 * `±N` 是不是一个独立的增减（才上色）。以下都不算：
 * - 算式里的项：值里它后面还有 `=`（`17 +5 -2 +1 = 21`、`50 -8 -5 = 37`）
 * - 连在数字 / 运算符链上：`50 -8`、`-8 -5`、`+5 ×2`
 * - 括号 / 坐标里：`(-3, 5)`
 * - 冒号后的负数是带符号的值不是减损：`位置: -2`（`经验: +35` 仍算增益）
 *
 * 🔴 整串只扫一遍：括号深度随游标增量推进、等号位置预先算好。每个匹配都去切前缀 / 后缀
 *    再扫一遍是平方级的（两万个 `-1 ` 就要两秒）。
 */
function createDeltaJudge(source: string): (at: number, end: number, down: boolean) => boolean {
  const lastEquals = Math.max(source.lastIndexOf('='), source.lastIndexOf('＝'));
  let scanned = 0;
  let depth = 0;
  return (at, end, down) => {
    for (; scanned < at; scanned += 1) {
      const ch = source[scanned];
      if (OPEN_BRACKETS.includes(ch)) depth += 1;
      else if (CLOSE_BRACKETS.includes(ch) && depth > 0) depth -= 1;
    }
    if (lastEquals >= end || depth > 0) return false;
    let p = at - 1;
    while (p >= 0 && isSpace(source[p])) p -= 1;
    const prev = p >= 0 ? source[p] : '';
    if (/[\d)）]/.test(prev) || (prev && OPERATORS.includes(prev))) return false;
    if (down && (prev === ':' || prev === '：')) return false;
    let n = end;
    while (n < source.length && isSpace(source[n])) n += 1;
    if (n < source.length && OPERATORS.includes(source[n])) {
      let d = n + 1;
      while (d < source.length && isSpace(source[d])) d += 1;
      if (/\d/.test(source[d] ?? '')) return false;
    }
    return true;
  };
}

/**
 * 值 → 着色 token。拼接所有 token 的 text 恒等于入参（`->` 除外，会被换成 `→`）。
 *
 * 箭头比较两侧的**第一个数**（分数取分子、去千分位）；任一侧读不出数就不上色。
 */
export function highlightValue(value: string): HighlightToken[] {
  const source = typeof value === 'string' ? value : String(value ?? '');
  try {
    const tokens: HighlightToken[] = [];
    const push = (text: string, kind?: HighlightToken['kind']): void => {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (!kind && last && !last.kind) last.text += text;
      else tokens.push(kind ? { text, kind } : { text });
    };
    const isStandaloneDelta = createDeltaJudge(source);
    let cursor = 0;
    for (const m of source.matchAll(HIGHLIGHT_RE)) {
      const g = m.groups ?? {};
      const at = m.index ?? 0;
      const end = at + m[0].length;
      push(source.slice(cursor, at));
      if (g.dice) push(g.dice, 'dice');
      else if (g.from !== undefined && g.to !== undefined) {
        const a = leadingNumber(g.from);
        const b = leadingNumber(g.to);
        push(g.from + (g.s1 ?? ''));
        push('→', 'arrow');
        push(g.s2 ?? '');
        const kind =
          Number.isNaN(a) || Number.isNaN(b)
            ? undefined
            : b > a
              ? 'up'
              : b < a
                ? 'down'
                : undefined;
        push(g.to, kind);
      } else if (g.up) push(g.up, isStandaloneDelta(at, end, false) ? 'up' : undefined);
      else if (g.down) push(g.down, isStandaloneDelta(at, end, true) ? 'down' : undefined);
      cursor = end;
    }
    push(source.slice(cursor));
    return tokens;
  } catch {
    return source ? [{ text: source }] : [];
  }
}
