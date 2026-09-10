/**
 * plot-threads.ts —— 主线细化层（事件线 / plot threads）纯领域逻辑
 *
 * 定位（设计真源 docs/planning/2026-09-07-mainline-refinement-layer-design.md）：
 * 主线是宏观大方向，细化层把它实例化为带动机的 NPC 行动。本模块是 **纯函数**：
 * 无 I/O、无 Dexie、无时钟、无 Math.random（确定性随机只经 createEjsRng）。
 *
 * 职责边界：
 * - 节点状态袋 `worldFlags.plotThreads` 的读/getter（在 save-profile.ts）与纯 reducer（本文件）。
 * - 节奏闸门 `evaluatePlotThreadGate`：Code 决定「本轮能否推进细化」，AI 决定内容。
 * - 连线推导 `collectPlotThreadEdges`：边由节点引用推导，不独立存边表（设计 §4.2）。
 * - 上下文快照 `buildPlotThreadSnapshot` / 表层投影 `projectPlotThreadSurface`
 *   （快照喂 pre/post，表层投影喂 dispatcher / char_gen —— §11.4 防剧透边界）。
 *
 * 🔴 状态枚举按设计的四个英文值存储；中文显示映射在 UI 层（fields 规范明确例外）。
 * 🔴 时间字段一律 **游戏 epoch minutes**（toEpochMinutes 口径），不是宿主 Unix 毫秒。
 * 🔴 本文件禁 `Math.random`（快照回退/重发必须可复现，同 ejs-rng 的先例）。
 */
import type { GameTime } from './time-system';
import { toEpochMinutes, parseMonthTime, compareMonthTime } from './time-system';
import { createEjsRng } from './ejs-rng';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/** 节点状态（设计 §4.1；四值英文存储，中文映射在 UI 层） */
export type PlotThreadStatus = 'dormant' | 'active' | 'resolved' | 'dissolved';

/** 玩家可见性：hidden=玩家未见过 / revealed=正文已向玩家呈现（与 PlotEvent.visibility 同值域） */
export type PlotThreadVisibility = 'hidden' | 'revealed';

/** 一个主线细化节点（设计 §4.1 + 实施计划 §3.2 的最小账务字段） */
export interface PlotThreadNode {
  /** 节点名 —— AI 产，铁律①按名寻址，pre/post 都用名字引用；稳定身份，无重命名 */
  name: string;
  /** 一句话简述：这个节点是什么 */
  gist: string;
  /** 所属主线锚：挂到哪个大纲事件/大方向标题下 */
  thread: string;
  /** 动机：谁、因为什么、做了这件事（未揭示时玩家不可见） */
  motive: string;
  /** 涉及 NPC 名单 */
  involvedNpcs: string[];
  status: PlotThreadStatus;
  /** 它埋向哪些节点（伏笔引用，可选） */
  foreshadows: string[];
  /** 它回收了哪些节点的伏笔（可选） */
  payoffs: string[];
  /** 玩家可见性（post 依据正文 revealedNames 单向置 revealed） */
  visibility: PlotThreadVisibility;
  /** 埋设时间（游戏 epoch minutes；首次插入由 Code 写，更新不改） */
  seededAt: number;
  /** 回收时间（游戏 epoch minutes；仅首次确认终态时写） */
  resolvedAt?: number;
}

/** `worldFlags.plotThreads` 的形状（事实态；零新 Dexie 表，随 SaveProfile 进出） */
export interface PlotThreadFlags {
  nodes: Record<string, PlotThreadNode>;
  /** 最近一次推进细化的**成功回合序号**（1-based）；冷却判据用 */
  lastAdvancedTurn?: number;
  /** 最近一次成功提交细化状态的回合序号（幂等防重） */
  lastCommittedTurn?: number;
}

/** plot_pre_check 的新增输出（设计 §11.3：只提出节点与连线，不产时间戳/揭示状态/账务） */
export interface PlotThreadDeclaration {
  name: string;
  gist: string;
  thread: string;
  motive: string;
  involvedNpcs: string[];
  status: 'active' | 'dormant';
  foreshadows?: string[];
  payoffs?: string[];
}

/** plot_post_check 的新增输出（只结算已有节点或同轮接受节点；不凭空创建节点） */
export interface PlotThreadUpdate {
  name: string;
  status: 'resolved' | 'dissolved';
  payoffs?: string[];
}

/** 有向边：from 埋向 to（由节点引用推导，去重） */
export interface PlotThreadEdge {
  from: string;
  to: string;
}

/** 同轮临时工作集（post 可见；不是持久真源） */
export interface PlotThreadTurnContext {
  /** 本轮成功后的回合序号 */
  turnNo: number;
  /** pre 通过闸门并接受的声明 */
  acceptedDeclarations: PlotThreadDeclaration[];
  /** post 暂存的结算 */
  acceptedUpdates: PlotThreadUpdate[];
  /** post 暂存的揭示名单 */
  revealedNames: string[];
  /** 本轮闸门结果（pre 开始时求值；未启用时 reason=mode_off） */
  gate: PlotThreadGateResult;
}

/** 闸门原因（机器可读 token；中文展示在 UI 层） */
export type PlotThreadGateReason =
  | 'allowed'
  | 'mode_off'
  | 'no_anchor'
  | 'no_window'
  | 'blank_period'
  | 'combat_active'
  | 'cooldown'
  | 'roll_failed';

/** 闸门结果（调试面板直接消费） */
export interface PlotThreadGateResult {
  allowed: boolean;
  reason: PlotThreadGateReason;
  /** 最近未来窗口起点距今天数（游戏日）—— 概率分带的依据 */
  distanceDays?: number;
  /** 本轮采用的概率 */
  probability?: number;
  /** 掷出的 [0,1) 抽样值 */
  sample?: number;
  /** 距允许推进还需几个成功回合 */
  cooldownRemaining?: number;
  /** 最近未来窗口起点（"512-03"；undefined = 无可用窗口） */
  windowAt?: string;
}

/** 状态中文标签（集中定义；「中文枚举」通则的明确例外 —— 存储用英文四值） */
export const PLOT_THREAD_STATUS_LABELS: Record<PlotThreadStatus, string> = {
  active: '活跃',
  dormant: '沉睡',
  resolved: '已回收',
  dissolved: '已消散',
};

/** 状态 → 中文标签（唯一映射；UI 与模板层共用，别各处内联） */
export function plotThreadStatusLabel(status: PlotThreadStatus): string {
  return PLOT_THREAD_STATUS_LABELS[status] ?? status;
}

/**
 * 场景 A 的查名投影（节点先于角色：生成前玩家未见过该角色另一面 → 全量含 motive，
 * 供「行为化改写」进 char_gen 请求描述）。**只读、纯函数、不落库**。
 */
export function buildCharGenProjectionA(
  flags: PlotThreadFlags,
  name: string,
): (PlotThreadSurfaceEntry & { motive: string }) | undefined {
  const node = findNodeByInvolvedNpc(flags, name);
  if (!node) return undefined;
  return {
    name: node.name,
    gist: node.gist,
    involvedNpcs: [...node.involvedNpcs],
    thread: node.thread,
    motive: node.motive,
  };
}

/**
 * 场景 B 的表层投影（角色先于节点：玩家已认识 → 只给 name/gist/involvedNpcs/thread。
 * **无 motive、无连线意向** —— §11.4 红线 1/3）。
 */
export function buildCharGenProjectionB(
  flags: PlotThreadFlags,
  name: string,
): PlotThreadSurfaceEntry | undefined {
  const node = findNodeByInvolvedNpc(flags, name);
  if (!node) return undefined;
  return {
    name: node.name,
    gist: node.gist,
    involvedNpcs: [...node.involvedNpcs],
    thread: node.thread,
  };
}

/** 按 involvedNpcs 命中节点（多条命中取 seededAt 最早那条 —— 引用口径唯一） */
function findNodeByInvolvedNpc(flags: PlotThreadFlags, name: string): PlotThreadNode | undefined {
  return Object.values(flags.nodes)
    .filter((n) => (n.involvedNpcs ?? []).includes(name))
    .sort((a, b) => a.seededAt - b.seededAt)[0];
}

/** 上下文快照的一行（pre/post 可见；含未揭示 —— 防剧透只在 UI/dispatcher 面） */
export interface PlotThreadSnapshotEntry {
  name: string;
  gist: string;
  thread: string;
  motive: string;
  involvedNpcs: string[];
  status: PlotThreadStatus;
  visibility: PlotThreadVisibility;
  foreshadows: string[];
  payoffs: string[];
  seededAt: number;
  resolvedAt?: number;
}

/** pre/post 上下文用的事件线快照（全量活动 + 未回收休眠 + 被引用闭包 + 近期终态） */
export interface PlotThreadSnapshot {
  entries: PlotThreadSnapshotEntry[];
  /** 快照生成时的游戏 epoch minutes（调试/渲染用） */
  atEpochMinutes: number;
}

/** dispatcher / char_gen 可见的表层投影（仅 revealed+active 的四个字段，无动机/无连线） */
export interface PlotThreadSurfaceEntry {
  name: string;
  gist: string;
  involvedNpcs: string[];
  thread: string;
}

// ═══════════════════════════════════════════════════════════
// 常量与默认策略（实施计划 §3.1 收口；测试固定输入不要求真实概率分布）
// ═══════════════════════════════════════════════════════════

/** 每 N 个成功普通回合至多推进一次（全存档冷却） */
export const PLOT_THREAD_COOLDOWN_TURNS = 4;

/** 距离窗口概率分带（game days → p）。窗口起点当天由 blank_period 拦截，不进本表。 */
export const PLOT_THREAD_PROBABILITY_BANDS: ReadonlyArray<{
  minDays: number;
  probability: number;
}> = [
  { minDays: 61, probability: 0.15 }, // > 60 日
  { minDays: 31, probability: 0.3 }, // 31–60 日
  { minDays: 8, probability: 0.5 }, // 8–30 日
  { minDays: 1, probability: 0.7 }, // 1–7 日
];

/** 上下文中保留的近期终态节点条数（其余仍在库中、UI 可查） */
export const PLOT_THREAD_RESOLVED_HISTORY_LIMIT = 10;

/** 闸门随机盐的命名空间前缀（专用 salt，不挤占 ADR-32/33 的随机序列） */
const PLOT_THREAD_SALT = 'plot-thread';

// ═══════════════════════════════════════════════════════════
// 纯函数工具
// ═══════════════════════════════════════════════════════════

/** 月窗口起点（当月首日 00:00）的游戏 epoch minutes */
function monthStartEpochMinutes(year: number, month: number): number {
  return toEpochMinutes({ era: '', year, month, day: 1, weekday: 1, hour: 0, minute: 0 });
}

/** month 窗口的期间（[start, end)）换算成 epoch minutes */
function monthWindowEpochRange(t: { year: number; month: number }): [number, number] {
  const start = monthStartEpochMinutes(t.year, t.month);
  const nextMonth =
    t.month === 12 ? { year: t.year + 1, month: 1 } : { year: t.year, month: t.month + 1 };
  const end = monthStartEpochMinutes(nextMonth.year, nextMonth.month);
  return [start, end];
}

/** 概率分带（days > 0）；days <= 0 表示已在窗口内（正常由 blank_period 拦截，这里兜底 0.7） */
export function plotThreadProbabilityForDistance(days: number): number {
  for (const band of PLOT_THREAD_PROBABILITY_BANDS) {
    if (days >= band.minDays) return band.probability;
  }
  return 0.7;
}

/** 名字空（trim 后为空）视为无效 */
function hasName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 计算「最近未来窗口起点」距离与窗口起点字符串。
 *
 * - 只考虑有合法 `timeWindow` 的事件；月窗口起点从该月首日开始。
 * - 返回 null = 没有合法窗口 / 没有未来窗口（旧目录全是过期窗口时同样 null）。
 * - 若当前已处于任一 pending 事件窗口内，调用方依据 `insideWindow=true` 判定位空白期。
 */
export function evaluateNextPlotWindow(
  pendingEvents: ReadonlyArray<{ timeWindow?: { start: string; end: string } }>,
  currentTime: GameTime,
): { windowStart: string; distanceDays: number; insideWindow: boolean } | null {
  const nowEpoch = toEpochMinutes(currentTime);
  let nearest: { windowStart: string; startEpoch: number } | null = null;
  let currentWindowStart: string | null = null;

  for (const event of pendingEvents) {
    const win = event.timeWindow;
    if (!win) continue;
    const parsedStart = parseMonthTime(win.start);
    const parsedEnd = parseMonthTime(win.end);
    // 窗口缺一边/格式坏 → 该事件不参与（保守跳过，不当坏数据）
    if (!parsedStart || !parsedEnd || compareMonthTime(parsedEnd, parsedStart) < 0) continue;
    const [startEpoch, endEpoch] = monthWindowEpochRange(parsedStart);
    if (nowEpoch >= startEpoch && nowEpoch < endEpoch) {
      // 已处于某 pending 事件窗口 —— 空白期判据；记下窗口起点（供 gate 的 windowAt）
      if (currentWindowStart === null) currentWindowStart = win.start;
      continue;
    }
    if (startEpoch > nowEpoch) {
      if (nearest === null || startEpoch < nearest.startEpoch) {
        nearest = { windowStart: win.start, startEpoch };
      }
    }
  }

  if (currentWindowStart !== null) {
    // 已进窗口：distanceDays 记 0（「距离为零」由 blank_period 语义表达，不是「缺日期当零」）
    return { windowStart: currentWindowStart, distanceDays: 0, insideWindow: true };
  }
  if (!nearest) return null;
  const distanceDays = Math.floor((nearest.startEpoch - nowEpoch) / (24 * 60));
  return { windowStart: nearest.windowStart, distanceDays, insideWindow: false };
}

/** 建立去重精确锚集（大纲标题 → 章节标题 → 所属大纲事件标题；directionAnchors 是自由文本，不拆） */
export function collectPlotThreadAnchors(
  outlineTitle?: string,
  chapterTitles: string[] = [],
  chapterEventTitles: string[] = [],
): string[] {
  const seen = new Set<string>();
  for (const name of [outlineTitle, ...chapterTitles, ...chapterEventTitles]) {
    if (name === undefined || name === null) continue;
    const t = String(name).trim();
    if (t === '') continue;
    seen.add(t);
  }
  return Array.from(seen);
}

// ═══════════════════════════════════════════════════════════
// 节奏闸门（Code 保证——纯判据；调试面板直接消费同函数，不复制实现）
// ═══════════════════════════════════════════════════════════

export interface PlotThreadGateInput {
  /** 稳定存档标识（确定性随机种子件） */
  saveId: string;
  /** 本轮成功后的回合序号（= totalTurns + 1；失败重试时不变 → 不重掷） */
  turnNo: number;
  currentTime: GameTime;
  combatActive: boolean;
  mode: 'off' | 'side' | 'main';
  outlineTitle?: string;
  chapterTitles?: string[];
  chapterEventTitles?: string[];
  pendingEvents: ReadonlyArray<{ timeWindow?: { start: string; end: string } }>;
  activeEventCount: number;
  flags: PlotThreadFlags;
}

/**
 * 純闸门求值（幂等）：决定本轮是否放行「新建/推进」细化节点。
 *
 * 顺序：mode → 锚 → 窗口 → 空白期 → 战斗 → 冷却 → 概率抽样。
 * 抽样 = createEjsRng(`plot-thread|saveId|turnNo|gate`).float()；同回合重试输入不变 → 结果不变。
 * 闸门只控制「新建/推进」；post 对已存在节点做有正文证据的结算不受闸门约束。
 */
export function evaluatePlotThreadGate(input: PlotThreadGateInput): PlotThreadGateResult {
  const { saveId, turnNo, currentTime, combatActive, mode, activeEventCount, flags } = input;

  if (mode !== 'main') return { allowed: false, reason: 'mode_off' };

  const anchors = collectPlotThreadAnchors(
    input.outlineTitle,
    input.chapterTitles,
    input.chapterEventTitles,
  );
  if (anchors.length === 0) return { allowed: false, reason: 'no_anchor' };

  const windowInfo = evaluateNextPlotWindow(input.pendingEvents, currentTime);
  if (windowInfo === null) return { allowed: false, reason: 'no_window' };

  if (activeEventCount > 0 || windowInfo.insideWindow) {
    return {
      allowed: false,
      reason: 'blank_period',
      distanceDays: windowInfo.insideWindow ? 0 : windowInfo.distanceDays,
      windowAt: windowInfo.windowStart,
    };
  }

  if (combatActive) {
    return {
      allowed: false,
      reason: 'combat_active',
      distanceDays: windowInfo.distanceDays,
      windowAt: windowInfo.windowStart,
    };
  }

  const cooldownRemaining = cooldownRemainingTurns(
    PLOT_THREAD_COOLDOWN_TURNS,
    flags.lastAdvancedTurn,
    turnNo,
  );
  if (cooldownRemaining > 0) {
    return {
      allowed: false,
      reason: 'cooldown',
      distanceDays: windowInfo.distanceDays,
      windowAt: windowInfo.windowStart,
      cooldownRemaining,
    };
  }

  const probability = plotThreadProbabilityForDistance(windowInfo.distanceDays);
  const rng = createEjsRng(`${PLOT_THREAD_SALT}|${saveId}|${turnNo}|gate`);
  const sample = rng.float();

  if (sample >= probability) {
    return {
      allowed: false,
      reason: 'roll_failed',
      distanceDays: windowInfo.distanceDays,
      windowAt: windowInfo.windowStart,
      probability,
      sample,
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    distanceDays: windowInfo.distanceDays,
    windowAt: windowInfo.windowStart,
    probability,
    sample,
  };
}

/** 冷却判据：若上次推进于成功回合 t，则 t + COOLDOWN 最早再次允许 */
export function cooldownRemainingTurns(
  cooldown: number,
  lastAdvancedTurn: number | undefined,
  turnNo: number,
): number {
  if (lastAdvancedTurn === undefined) return 0; // 首次无冷却
  return Math.max(0, cooldown - (turnNo - lastAdvancedTurn));
}

// ═══════════════════════════════════════════════════════════
// 纯 reducer
// ═══════════════════════════════════════════════════════════

function nonEmptyArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((v): v is string => hasName(v));
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

/** 深拷贝一份节点（reducer 不改入参） */
function cloneFlags(flags: PlotThreadFlags): PlotThreadFlags {
  const nodes: Record<string, PlotThreadNode> = {};
  for (const [name, node] of Object.entries(flags.nodes)) {
    nodes[name] = {
      ...node,
      involvedNpcs: [...node.involvedNpcs],
      foreshadows: [...node.foreshadows],
      payoffs: [...node.payoffs],
    };
  }
  return {
    nodes,
    lastAdvancedTurn: flags.lastAdvancedTurn,
    lastCommittedTurn: flags.lastCommittedTurn,
  };
}

/**
 * AI 输出 → 归一化声明列表（**模型输出入口的唯一归一化点**；坏条目独立丢弃，有返回值+告警）。
 * 内部消费（applyThreadDeclarations）收的已是归一化对象。
 */
export function parseThreadDeclarations(value: unknown): PlotThreadDeclaration[] {
  if (!Array.isArray(value)) return [];
  const out: PlotThreadDeclaration[] = [];
  for (const raw of value) {
    const decl = normalizeDeclaration(raw as Partial<PlotThreadDeclaration>);
    if (decl) out.push(decl);
  }
  return out;
}

/** AI 输出 → 归一化结算列表（未知名字由 reducer 层 warn/ignored，本层只管形状） */
export function parseThreadUpdates(value: unknown): PlotThreadUpdate[] {
  if (!Array.isArray(value)) return [];
  const out: PlotThreadUpdate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const name = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).name : undefined;
    const status = (raw as Record<string, unknown>).status;
    if (!hasName(name)) continue;
    const st = status === 'resolved' ? 'resolved' : status === 'dissolved' ? 'dissolved' : null;
    if (st === null) continue;
    out.push({
      name: String(name).trim(),
      status: st,
      payoffs: nonEmptyArray((raw as Record<string, unknown>).payoffs),
    });
  }
  return out;
}

/** AI 输出 → 揭示名单（非字符串条目独立丢弃） */
export function parsePlotThreadRevealedNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (hasName(raw)) out.push(String(raw).trim());
  }
  return out;
}

/** 清洗一条声明：坏条目丢弃（返回 null），不含自引用 */
function normalizeDeclaration(decl: Partial<PlotThreadDeclaration>): PlotThreadDeclaration | null {
  if (!decl || typeof decl !== 'object') return null;
  if (!hasName(decl.name)) return null;
  const status = decl.status === 'dormant' ? 'dormant' : decl.status === 'active' ? 'active' : null;
  if (status === null) return null;
  return {
    name: decl.name.trim(),
    gist: typeof decl.gist === 'string' ? decl.gist : '',
    thread: typeof decl.thread === 'string' ? decl.thread : '',
    motive: typeof decl.motive === 'string' ? decl.motive : '',
    involvedNpcs: nonEmptyArray(decl.involvedNpcs).map((n) => n.trim()),
    status,
    foreshadows: nonEmptyArray(decl.foreshadows)
      .map((n) => n.trim())
      .filter((n) => n !== decl.name?.trim()),
    payoffs: nonEmptyArray(decl.payoffs)
      .map((n) => n.trim())
      .filter((n) => n !== decl.name?.trim()),
  };
}

/**
 * 应用 pre 的节点声明（纯；每次调用摊开一个**申请**，不承诺原子性）。
 *
 * 规则（实施计划 §3.2）：
 * - 同名更新不重复插入；空字段不覆盖已有非空叙事（gist/thread/motive/involvedNpcs/引用；
 *   给定非空列表时**替换** —— JSON 引用是完整列表语义）。
 * - pre 只声明 active/dormant；终态（resolved/dissolved）不可被 pre 降级覆盖。
 * - dormant 再次按名声明可复活（转回 active）。声明 dormant 的既有 active 节点置为 dormant。
 * - seededAt 首次插入时写、更新不改；visibility 新节点默认 hidden。
 * - 前向引用允许目标暂未出现：保存引用但不制造空节点。自引用剔除。
 *
 * @returns 新 flags（入参不变）；ignored = 无法接受的名字（unknown 同样记录）。
 */
export function applyThreadDeclarations(
  flags: PlotThreadFlags,
  declarations: ReadonlyArray<Partial<PlotThreadDeclaration>>,
  seededAtEpochMinutes: number,
): { flags: PlotThreadFlags; accepted: string[]; ignored: string[] } {
  const next = cloneFlags(flags);
  const accepted: string[] = [];
  const ignored: string[] = [];

  for (const raw of declarations) {
    const decl = normalizeDeclaration(raw);
    if (!decl) {
      ignored.push(
        typeof raw === 'object' && raw !== null && hasName(raw.name)
          ? String(raw.name)
          : '<invalid>',
      );
      continue;
    }
    const existing = next.nodes[decl.name];
    if (!existing) {
      next.nodes[decl.name] = {
        name: decl.name,
        gist: decl.gist,
        thread: decl.thread,
        motive: decl.motive,
        involvedNpcs: dedupeStrings(decl.involvedNpcs),
        status: decl.status,
        foreshadows: dedupeStrings(decl.foreshadows ?? []),
        payoffs: dedupeStrings(decl.payoffs ?? []),
        visibility: 'hidden',
        seededAt: seededAtEpochMinutes,
      };
      accepted.push(decl.name);
      continue;
    }
    // 既有节点：非空字段覆盖；终态不可被 pre 降级
    if (existing.status === 'resolved' || existing.status === 'dissolved') {
      ignored.push(decl.name);
      continue;
    }
    // 「空字段不覆盖已有非空叙事」= 空值跳过；非空新值照常更新。
    if (decl.gist !== '') existing.gist = decl.gist;
    if (decl.thread !== '') existing.thread = decl.thread;
    if (decl.motive !== '') existing.motive = decl.motive;
    if (decl.involvedNpcs.length > 0) existing.involvedNpcs = dedupeStrings(decl.involvedNpcs);
    if (decl.foreshadows && decl.foreshadows.length > 0) {
      existing.foreshadows = dedupeStrings([...existing.foreshadows, ...decl.foreshadows]);
    }
    if (decl.payoffs && decl.payoffs.length > 0) {
      existing.payoffs = dedupeStrings([...existing.payoffs, ...decl.payoffs]);
    }
    // 状态推移：dormant 复活 / active 可转入 dormant；不覆盖终态（上面已拦）
    if (existing.status === 'dormant' && decl.status === 'active') existing.status = 'active';
    else if (decl.status === 'dormant') existing.status = 'dormant';
    accepted.push(decl.name);
  }

  return { flags: next, accepted, ignored };
}

/**
 * 应用 post 的节点结算（终态 + 连线确认）。只结算**已有节点**或同轮接受节点 ——
 * 未知名字不创建、不给终态（ignored 返回供调用方告警）。
 *
 * `resolvedAt` 仅首次确认终态时写。payoffs 非空才并（连线意向由 post 确认后才固化）。
 */
export function applyThreadUpdates(
  flags: PlotThreadFlags,
  updates: ReadonlyArray<Partial<PlotThreadUpdate>>,
  resolvedAtEpochMinutes: number,
): { flags: PlotThreadFlags; settled: string[]; ignored: string[] } {
  const next = cloneFlags(flags);
  const settled: string[] = [];
  const ignored: string[] = [];

  for (const raw of updates) {
    if (!raw || typeof raw !== 'object' || !hasName(raw.name)) {
      ignored.push(
        typeof raw === 'object' && raw !== null && hasName(raw.name)
          ? String(raw.name)
          : '<invalid>',
      );
      continue;
    }
    const name = String(raw.name).trim();
    const status =
      raw.status === 'resolved' ? 'resolved' : raw.status === 'dissolved' ? 'dissolved' : null;
    if (status === null) {
      ignored.push(name);
      continue;
    }
    const node = next.nodes[name];
    if (!node) {
      ignored.push(name);
      continue;
    }
    // 终态不复活：已终态的节点再结算 no-op（幂等，不改 resolvedAt）
    if (node.status === 'resolved' || node.status === 'dissolved') continue;
    node.status = status;
    if (node.resolvedAt === undefined) node.resolvedAt = resolvedAtEpochMinutes;
    if (Array.isArray(raw.payoffs) && nonEmptyArray(raw.payoffs).length > 0) {
      const payoffs = nonEmptyArray(raw.payoffs).filter((p) => p.trim() !== name);
      node.payoffs = dedupeStrings([...node.payoffs, ...payoffs]);
    }
    settled.push(name);
  }

  return { flags: next, settled, ignored };
}

/**
 * 应用 post 的揭示名单（单向置 revealed；未知名字告警并跳过）。
 * 「活跃/已回收」均不自动等于玩家知道 —— 只有这里能置 revealed。
 */
export function applyPlotThreadRevealed(
  flags: PlotThreadFlags,
  revealedNames: ReadonlyArray<unknown>,
): { flags: PlotThreadFlags; revealed: string[]; ignored: string[] } {
  const next = cloneFlags(flags);
  const revealed: string[] = [];
  const ignored: string[] = [];

  for (const raw of revealedNames) {
    if (!hasName(raw)) continue;
    const name = String(raw).trim();
    const node = next.nodes[name];
    if (!node) {
      ignored.push(name);
      continue;
    }
    if (node.visibility !== 'revealed') {
      node.visibility = 'revealed';
      revealed.push(name);
    }
  }

  return { flags: next, revealed, ignored };
}

/**
 * 连线推导（设计 §4.2 唯一定义）：`A.foreshadows=[B]` 与 `B.payoffs=[A]` 都推导为 A→B，
 * 去重；自引用剔除。
 */
export function collectPlotThreadEdges(flags: PlotThreadFlags): PlotThreadEdge[] {
  const edges: PlotThreadEdge[] = [];
  const seen = new Set<string>();
  const push = (from: string, to: string) => {
    if (from === to) return;
    const key = `${from}\u0001${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };
  for (const [name, node] of Object.entries(flags.nodes)) {
    for (const target of node.foreshadows) push(name, target.trim());
  }
  for (const [name, node] of Object.entries(flags.nodes)) {
    for (const source of node.payoffs) push(source.trim(), name);
  }
  return edges;
}

// ═══════════════════════════════════════════════════════════
// 上下文快照与表层投影
// ═══════════════════════════════════════════════════════════

/**
 * 事件线快照（pre/post 上下文的原料；T3 接通）。
 *
 * 面 = 全部 active + 全部未回收 dormant（含未被引用者，不让休眠伏笔永久藏在过滤外）
 *   ∪ 被上述节点通过 foreshadows/payoffs **递归引用的** 已出现节点（visited 去重，防合法环无限展开）
 *   ∪ 近期终态（按终态时间倒序取最新 PLOT_THREAD_RESOLVED_HISTORY_LIMIT 条）。
 *
 * 排序：先 active/dormant（seededAt 升序 → 名字），再终态（seededAt 升序）。稳定且不在渲染时写状态。
 */
export function buildPlotThreadSnapshot(
  flags: PlotThreadFlags,
  atEpochMinutes: number,
): PlotThreadSnapshot {
  const entries: PlotThreadSnapshotEntry[] = [];
  const visited = new Set<string>();
  const includeNode = (name: string): void => {
    if (name === '') return;
    if (visited.has(name)) return;
    const node = flags.nodes[name];
    if (!node) return;
    visited.add(name);
    entries.push(nodeToEntry(node));
    // 递归展开引用闭包（合法的环由 visited 截断）
    for (const ref of [...node.foreshadows, ...node.payoffs]) includeNode(ref.trim());
  };

  const live = Object.values(flags.nodes)
    .filter((n) => n.status === 'active' || n.status === 'dormant')
    .sort((a, b) => a.seededAt - b.seededAt || a.name.localeCompare(b.name));
  for (const node of live) includeNode(node.name);

  const terminal = Object.values(flags.nodes)
    .filter((n) => n.status === 'resolved' || n.status === 'dissolved')
    .sort((a, b) => a.seededAt - b.seededAt || a.name.localeCompare(b.name))
    .slice(-PLOT_THREAD_RESOLVED_HISTORY_LIMIT);
  for (const node of terminal) includeNode(node.name);

  return { entries, atEpochMinutes };
}

function nodeToEntry(node: PlotThreadNode): PlotThreadSnapshotEntry {
  return {
    name: node.name,
    gist: node.gist,
    thread: node.thread,
    motive: node.motive,
    involvedNpcs: [...node.involvedNpcs],
    status: node.status,
    visibility: node.visibility,
    foreshadows: [...node.foreshadows],
    payoffs: [...node.payoffs],
    seededAt: node.seededAt,
    resolvedAt: node.resolvedAt,
  };
}

/**
 * dispatcher / char_gen 的表层投影（§11.4 裁定 1/4）。
 *
 * 🔴 只开放 **revealed + active** 节点的 name/gist/involvedNpcs/thread 四个字段：
 *    无 motive、无连线意向（foreshadows/payoffs 不作任何出现）、无 hidden/dormant/
 *    终态节点 —— 任何一边漏出去都构成剧透入口。
 */
export function projectPlotThreadSurface(flags: PlotThreadFlags): PlotThreadSurfaceEntry[] {
  return Object.values(flags.nodes)
    .filter((n) => n.visibility === 'revealed' && n.status === 'active')
    .sort((a, b) => a.seededAt - b.seededAt || a.name.localeCompare(b.name))
    .map((n) => ({
      name: n.name,
      gist: n.gist,
      involvedNpcs: [...n.involvedNpcs],
      thread: n.thread,
    }));
}

/** 深层重检：快照中的引用是否都指向存在的节点（调试/测试辅助，不参与运行时） */
export function collectDanglingReferences(
  flags: PlotThreadFlags,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const [name, node] of Object.entries(flags.nodes)) {
    for (const ref of node.foreshadows) {
      if (!flags.nodes[ref.trim()]) out.push({ from: name, to: ref.trim() });
    }
    for (const ref of node.payoffs) {
      if (!flags.nodes[ref.trim()]) out.push({ from: ref.trim(), to: name });
    }
  }
  return out;
}
