/**
 * `<action_info>` 行动面板 — 视图模型（纯函数，不依赖 Vue）
 *
 * `action-digest.ts` 回答「面板说了什么」；本模块再走一步，回答「卡片上该画什么」：
 * 把各款卡片样式都要现算的东西（出手方消耗、目标 HP 变化、状态归属、是否治疗、结算产物、
 * 展开算式 …）收成带类型的字段，渲染层只管照着画，不再自己推导。
 *
 *   - `targets`：每个目标一条 —— 打没打中、HP 变化、其余资源变化、它身上的新状态、它自己的掷骰；
 *     没列在目标里、但有资源变化的旁人也补进来（群体标签没有自己的变化时换成有变化的成员）
 *   - `ownDeltas`：出手方自己的消耗（行动者且不在目标里，或没写名字的 `who: ''`）
 *   - `looseStatuses`：认不出归属的状态句
 *   - `outcome`：结算类的产物 / 品质（含调色板变量与档位）/ 经验 / 结果句 / 检定骰
 *   - `calc`：展开体的算式分节，值已切成高亮 token，结论行打 `result`
 *
 * 🔴 「行动者行」不等于交锋：技能检定失败这类面板写了 `|行动者|`，摘要就判 exchange；
 *    但它没有目标、也没有打到别人身上的 HP 变化，只有一次检定与结论 —— 视图把这种面板
 *    改判为 outcome（见 `resolveKind`）。摘要层的 kind 不动。
 *
 * 任何输入都**不抛**：失败退回空的 generic 视图。
 */

import { RARITY_LEVELS } from '@engine/content/field-enums';
import {
  digestActionPanel,
  EXP_LABEL_RE,
  PRODUCT_LABEL_RE,
  QUALITY_LABEL_RE,
  type ActionDigest,
  type ActionDigestKind,
  type DigestRoll,
  type DigestTargetHit,
  type DigestVerdict,
  type ResourceDelta,
  type RosterUnit,
} from './action-digest';
import {
  highlightValue,
  sectionHue,
  type ActionPanel,
  type ActionPanelCell,
  type ActionPanelHue,
  type ActionPanelTone,
  type HighlightToken,
} from './action-panel';
import { qualityVar } from './quality-colors';

// ── 类型 ──────────────────────────────────────────────────────

type ActionViewKind = ActionDigestKind;

export interface ActionViewTarget {
  name: string;
  /** 来自摘要的逐目标命中；拿不出证据（如只挂了增益）时是 unknown，不是 miss */
  hit: DigestTargetHit;
  /** 这个目标的 HP 变化（没有就缺席） */
  hp?: ResourceDelta;
  /** 这个目标的全部资源变化（含 HP） */
  deltas: ResourceDelta[];
  /** 以它名字开头的状态句，去掉名字与「获得」（`流血(2回合)`） */
  statuses: string[];
  /** 它自己那一行的掷骰 */
  roll?: DigestRoll;
}

interface ActionViewOutcome {
  /** 产物名（`产物` / `产出` / `产出列表`，取最后一次） */
  product?: string;
  /** 品质原文（`稀有`） */
  quality?: string;
  /** 品质的 CSS `var()`；认不出的品质落到普通色 */
  qualityVar?: string;
  /** 品质在 7 级表里的下标（普通 = 0 … 唯一 = 6）；没有或认不出为 −1 */
  qualityRank: number;
  /** 经验（`+45`，原文） */
  exp?: string;
  /** `结果` 行的叙述句 */
  resultText?: string;
  /** 检定骰 */
  roll?: DigestRoll;
}

interface ActionCalcRow {
  label: string;
  tokens: HighlightToken[];
  tone?: ActionPanelTone;
  /** 结论行（判定 / 伤害 / 变更 / 结果 … 或本身带结论色）：加粗显示 */
  result: boolean;
  /** 跨两列：无标签的散行备注，或值太长 */
  wide: boolean;
}

export interface ActionCalcSection {
  /** 分节标题；可能是空串（渲染层显示「行动详情」） */
  title: string;
  hue: ActionPanelHue;
  rows: ActionCalcRow[];
}

export interface ActionView {
  kind: ActionViewKind;
  title: string;
  actor?: string;
  action?: string;
  verdict?: DigestVerdict;
  /** 结论是暴击 / 会心 */
  crit: boolean;
  /** 有目标得到正向资源变化（治疗 / 回复类） */
  heal: boolean;
  /** 主掷骰（摘要原样） */
  roll?: DigestRoll;
  /**
   * 交锋里是被打的人；结算（outcome）里没有单一出手方时（回合结束的多人状态结算），
   * 是结算涉及的各人 —— 收起视图要逐人画出来（`action-style-helpers` 的 `settledDeltas`），
   * 否则这些变化在收起态就看不见了。
   */
  targets: ActionViewTarget[];
  ownDeltas: ResourceDelta[];
  looseStatuses: string[];
  roster: RosterUnit[];
  /** 仅 outcome */
  outcome?: ActionViewOutcome;
  facts: ActionPanelCell[];
  calc: ActionCalcSection[];
}

// ── 常量 ──────────────────────────────────────────────────────

const CRIT_RE = /暴击|会心/;
/** 展开体里加粗的结论行标签 */
const RESULT_LABELS: ReadonlySet<string> = new Set([
  '判定',
  '伤害',
  '恢复',
  '变更',
  '状态',
  '结果',
  '产物',
  '品质',
  '经验',
]);
/** 值超过这个长度就跨两列 */
const WIDE_VALUE_LENGTH = 28;
const RESULT_LABEL = '结果';
const HUES: ReadonlySet<string> = new Set(['info', 'strike', 'check', 'gain']);
const GAIN_PREFIX_RE = /^\s*获得\s*/;
/** 群体目标标签的尾字：`盗匪们` → 成员名以 `盗匪` 开头 */
const GROUP_SUFFIX_RE = /(?:们|群|等人|等)$/;

// ── 小工具 ────────────────────────────────────────────────────

/** 标签去尾冒号（与摘要的 normalizeCell 同口径；散行补拆不在这里做） */
function cleanLabel(label: unknown): string {
  return String(label ?? '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

function panelCells(panel: ActionPanel): ActionPanelCell[] {
  const sections = Array.isArray(panel?.sections) ? panel.sections : [];
  return sections.flatMap((s) =>
    (Array.isArray(s?.rows) ? s.rows : []).flatMap((r) => (Array.isArray(r?.cells) ? r.cells : [])),
  );
}

/** 某类标签最后一个非空值 */
function lastValue(cells: readonly ActionPanelCell[], re: RegExp): string | undefined {
  let out: string | undefined;
  for (const c of cells) {
    const value = String(c?.value ?? '').trim();
    if (value && re.test(cleanLabel(c?.label))) out = value;
  }
  return out;
}

/** 状态句开头是哪个目标（取最长的，免得 `盗匪` 抢了 `盗匪头目`） */
function statusOwner(status: string, targets: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const name of targets) {
    if (name && status.startsWith(name) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

/**
 * 摘要 → 视图 kind。exchange 但没有目标、也没有打到别人的 HP 变化，
 * 只有「掷骰 + 结论」或一行 `结果` —— 是一次检定，不是交锋。
 */
function resolveKind(d: ActionDigest, cells: readonly ActionPanelCell[]): ActionViewKind {
  if (d.kind !== 'exchange' || d.targets.length > 0) return d.kind;
  const hitsOthers = d.deltas.some(
    (x) => x.resource === 'HP' && x.who !== '' && x.who !== d.actor && x.delta,
  );
  if (hitsOthers) return d.kind;
  const checked = Boolean(d.roll && d.verdict);
  const hasResultRow = cells.some(
    (c) => cleanLabel(c?.label) === RESULT_LABEL && String(c?.value ?? '').trim(),
  );
  return checked || hasResultRow ? 'outcome' : d.kind;
}

/**
 * 出手方：摘要给的行动者；结算面板常不写行动者行（制作三阶段），
 * 此时没有目标且所有资源变化都记在同一个人身上 —— 那就是他自己的消耗。
 */
function resolveActor(
  d: ActionDigest,
  kind: ActionViewKind,
  targets: readonly string[],
): string | undefined {
  if (d.actor) return d.actor;
  if (kind !== 'outcome' || targets.length > 0) return undefined;
  const owners = new Set(d.deltas.map((x) => x.who).filter(Boolean));
  return owners.size === 1 ? [...owners][0] : undefined;
}

/**
 * 最终的目标名单：摘要列出的目标，加上有资源变化却既不是行动者也不在名单里的旁人。
 * 群体标签（`盗匪们`）自己没有变化、而成员（`盗匪甲` / `盗匪乙`）有时，用成员替换该条。
 * 返回名单与补进来的名字（补进来的没有摘要给的逐目标命中）。
 */
function resolveTargetNames(
  d: ActionDigest,
  actor: string | undefined,
): { names: string[]; extras: Set<string> } {
  const listed = new Set(d.targets);
  const extras: string[] = [];
  for (const x of d.deltas) {
    if (!x.who || x.who === actor || listed.has(x.who) || extras.includes(x.who)) continue;
    extras.push(x.who);
  }
  const placed = new Set<string>();
  const names: string[] = [];
  for (const name of d.targets) {
    const base = name.replace(GROUP_SUFFIX_RE, '');
    const members =
      base && base !== name && !d.deltas.some((x) => x.who === name)
        ? extras.filter((e) => e.startsWith(base) && !placed.has(e))
        : [];
    if (members.length === 0) {
      names.push(name);
      continue;
    }
    for (const m of members) {
      placed.add(m);
      names.push(m);
    }
  }
  for (const e of extras) if (!placed.has(e)) names.push(e);
  return { names, extras: new Set(extras) };
}

function buildOutcome(d: ActionDigest, cells: readonly ActionPanelCell[]): ActionViewOutcome {
  const out: ActionViewOutcome = { qualityRank: -1 };
  const product = lastValue(cells, PRODUCT_LABEL_RE);
  if (product) out.product = product;
  const quality = lastValue(cells, QUALITY_LABEL_RE);
  if (quality) {
    out.quality = quality;
    out.qualityVar = qualityVar(quality);
    out.qualityRank = (RARITY_LEVELS as readonly string[]).indexOf(quality);
  }
  const exp = lastValue(cells, EXP_LABEL_RE);
  if (exp) out.exp = exp;
  if (d.result) out.resultText = d.result;
  if (d.roll) out.roll = d.roll;
  return out;
}

function buildCalcRow(cell: ActionPanelCell): ActionCalcRow {
  const label = cleanLabel(cell?.label);
  const value = String(cell?.value ?? '');
  const row: ActionCalcRow = {
    label,
    tokens: highlightValue(value),
    result: RESULT_LABELS.has(label) || cell?.tone !== undefined,
    wide: label === '' || value.trim().length > WIDE_VALUE_LENGTH,
  };
  if (cell?.tone) row.tone = cell.tone;
  return row;
}

function buildCalc(panel: ActionPanel): ActionCalcSection[] {
  const sections = Array.isArray(panel?.sections) ? panel.sections : [];
  return sections.map((s) => {
    const title = String(s?.title ?? '');
    const hue: ActionPanelHue = HUES.has(s?.hue as string) ? s.hue : sectionHue(title);
    const rows = (Array.isArray(s?.rows) ? s.rows : [])
      .flatMap((r) => (Array.isArray(r?.cells) ? r.cells : []))
      .map(buildCalcRow);
    return { title, hue, rows };
  });
}

// ── 入口 ──────────────────────────────────────────────────────

function emptyView(): ActionView {
  return {
    kind: 'generic',
    title: '',
    crit: false,
    heal: false,
    targets: [],
    ownDeltas: [],
    looseStatuses: [],
    roster: [],
    facts: [],
    calc: [],
  };
}

function build(panel: ActionPanel): ActionView {
  const d = digestActionPanel(panel);
  const cells = panelCells(panel);
  const kind = resolveKind(d, cells);
  const actor = resolveActor(d, kind, d.targets);
  const { names: targetNames, extras } = resolveTargetNames(d, actor);

  const targets: ActionViewTarget[] = targetNames.map((name) => {
    const deltas = d.deltas.filter((x) => x.who === name);
    const hp = deltas.find((x) => x.resource === 'HP');
    const result = extras.has(name) ? undefined : d.targetResults.find((r) => r.name === name);
    // 补进来的旁人没有逐目标证据：交锋里掉了 HP 算打中，否则 unknown
    const hit: DigestTargetHit =
      result?.hit ?? (kind === 'exchange' && (hp?.delta ?? 0) < 0 ? 'hit' : 'unknown');
    const t: ActionViewTarget = { name, hit, deltas, statuses: [] };
    if (hp) t.hp = hp;
    if (result?.roll) t.roll = result.roll;
    return t;
  });

  const looseStatuses: string[] = [];
  for (const status of d.statuses) {
    const owner = statusOwner(status, targetNames);
    const target = owner ? targets.find((t) => t.name === owner) : undefined;
    if (!target || !owner) {
      looseStatuses.push(status);
      continue;
    }
    const rest = status.slice(owner.length).replace(GAIN_PREFIX_RE, '').trim();
    target.statuses.push(rest || status);
  }

  const ownDeltas = d.deltas.filter(
    (x) => x.who === '' || (actor !== undefined && x.who === actor && !targetNames.includes(x.who)),
  );

  const view: ActionView = {
    kind,
    title: d.title,
    crit: CRIT_RE.test(d.verdict?.text ?? ''),
    heal: d.deltas.some((x) => targetNames.includes(x.who) && (x.delta ?? 0) > 0),
    targets,
    ownDeltas,
    looseStatuses,
    roster: d.roster,
    facts: d.facts,
    calc: buildCalc(panel),
  };
  if (actor) view.actor = actor;
  if (d.action) view.action = d.action;
  if (d.verdict) view.verdict = d.verdict;
  if (d.roll) view.roll = d.roll;
  if (kind === 'outcome') view.outcome = buildOutcome(d, cells);
  return view;
}

/**
 * 面板结构 → 视图模型。**永不抛**：任何异常都退回空的 generic 视图。
 */
export function buildActionView(panel: ActionPanel): ActionView {
  try {
    return build(panel);
  } catch {
    return emptyView();
  }
}
