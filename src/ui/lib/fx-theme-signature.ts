/**
 * fx-theme-signature.ts — 主题招牌微动效（T3）的纯数据与纯函数
 *
 * 每个「招牌主题」至多两样东西：
 * - `ornament`：顶栏轮数旁的回合纹饰（FxTurnOrnament）。只有星盘 / 机巧两套有。
 * - `ambient`：游戏页侧条 / 顶带里的氛围（FxThemeAmbient）。只住在左右侧条或顶栏带，
 *   **绝不**垫在正文阅读栏（GamePage 三分屏的中间 50%）背后。
 *
 * 🔴 docs/design.md §6.0 第 3 条禁止常驻循环动画。本模块是**有记录的例外**：每个主题
 *    **至多一个**超慢循环（星盘刻度环约 600s 一圈、深海焦散慢漂、极光带约 140s 往返），
 *    其余一律一次性（回合步进、偶发水珠、偶发金线）。
 * 🔴 crimson（血色玫瑰窗）在 DESIGN.md 里明令「不做氛围 / 常驻动画」，sakura / parchment /
 *    indigo 本轮不做 —— 四者一律什么都不渲染。
 *
 * 主题 slug 与身份名对照见根目录 DESIGN.md「Theme identity to stylesheet map」；
 * 身份名不进代码，这里只写 slug。
 *
 * 除最末的 `readThemeSlug` / `observeThemeSlug`（读 `<html data-theme>`）外全部是纯函数。
 */

/** 回合纹饰种类 */
type OrnamentKind = 'orrery' | 'escapement';

/** 氛围种类 */
type AmbientKind = 'caustics' | 'aurora' | 'condensation' | 'gold-thread';

export interface ThemeSignature {
  ornament: OrnamentKind | null;
  ambient: AmbientKind | null;
}

const NONE: ThemeSignature = Object.freeze({ ornament: null, ambient: null });

/** slug → 招牌。表外的 slug（含 crimson / sakura / parchment / indigo）一律视为「无」 */
export const THEME_SIGNATURES: Readonly<Record<string, Readonly<ThemeSignature>>> = Object.freeze({
  // 玄金星盘：刻度环超慢自转（本主题唯一循环）+ 指针按回合步进
  obsidian: Object.freeze({ ornament: 'orrery', ambient: null }),
  // 古铜机巧：擒纵轮每回合走一齿、带一点回弹，平时静止（无循环）
  bronze: Object.freeze({ ornament: 'escapement', ambient: null }),
  // 深海圣堂：侧条焦散，静态噪声纹理两份慢漂（本主题唯一循环）
  ocean: Object.freeze({ ornament: null, ambient: 'caustics' }),
  // 极光霜晶：顶带一条柔和极光，约 140s 往返（本主题唯一循环）
  'misty-lilac': Object.freeze({ ornament: null, ambient: 'aurora' }),
  // 翡翠温室：偶发一颗凝露沿玻璃边滑下（一次性，无循环）
  forest: Object.freeze({ ornament: null, ambient: 'condensation' }),
  // 月白云锦：偶发一缕金线沿织纹亮过（一次性，无循环）
  ivory: Object.freeze({ ornament: null, ambient: 'gold-thread' }),
});

/** 查招牌；未知 / 空 slug 返回「全无」 */
export function signatureOf(slug: string | null | undefined): Readonly<ThemeSignature> {
  if (!slug) return NONE;
  return Object.prototype.hasOwnProperty.call(THEME_SIGNATURES, slug)
    ? THEME_SIGNATURES[slug]
    : NONE;
}

// ── 回合纹饰 ────────────────────────────────────────────────

/** 星盘指针每个落定回合走的角度 */
export const ORRERY_POINTER_STEP_DEG = 6;
/** 擒纵轮齿数；每回合走一齿 */
export const ESCAPEMENT_TEETH = 12;
/**
 * 一次跳变超过这么多回合就直接到位、不播过渡：读档 / 回档 / 批量导入时
 * 指针一口气转好几十度只会像在甩，不像在「走」。
 */
export const MAX_ANIMATED_TURN_STEP = 3;

/** 把回合数规整成非负整数（NaN / 负数 / 小数一律收敛） */
function normalizeTurn(turn: number): number {
  if (!Number.isFinite(turn) || turn <= 0) return 0;
  return Math.floor(turn);
}

/**
 * 星盘指针角度（度）。**不取模**：从 354° 到 360° 要顺着走一格，
 * 取模成 0° 会让 CSS 过渡倒转一整圈。
 */
export function orreryPointerAngle(settledTurn: number): number {
  return normalizeTurn(settledTurn) * ORRERY_POINTER_STEP_DEG;
}

/** 擒纵轮每齿角度 */
export function escapementStepDeg(teeth = ESCAPEMENT_TEETH): number {
  return 360 / Math.max(1, Math.floor(teeth));
}

/** 擒纵轮角度（度），同样不取模 */
export function escapementGearAngle(settledTurn: number, teeth = ESCAPEMENT_TEETH): number {
  return normalizeTurn(settledTurn) * escapementStepDeg(teeth);
}

/**
 * 回合数从 `prev` 变到 `next` 时是否播放一次性过渡。
 * 只有「前进 1..MAX_ANIMATED_TURN_STEP 个回合」才动；首帧（prev 缺省）、
 * 原地、倒退（回档 / 重试）、大跨度跳变都直接到位。
 */
export function shouldAnimateTurnStep(prev: number | undefined, next: number): boolean {
  if (prev === undefined) return false;
  const delta = normalizeTurn(next) - normalizeTurn(prev);
  return delta >= 1 && delta <= MAX_ANIMATED_TURN_STEP;
}

/**
 * 擒纵轮齿形（锯齿）多边形顶点串，供 `<polygon points>` 使用。
 * 每齿两个顶点：齿根在 a，齿尖在 a + 0.8·步距（斜背），下一齿根接着回到内径。
 */
export function escapementGearPoints(
  teeth: number,
  outerR: number,
  innerR: number,
  cx: number,
  cy: number,
): string {
  const n = Math.max(3, Math.floor(teeth));
  const step = (Math.PI * 2) / n;
  const pts: string[] = [];
  const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
  for (let i = 0; i < n; i++) {
    const root = i * step - Math.PI / 2;
    const tip = root + step * 0.8;
    pts.push(`${fmt(cx + innerR * Math.cos(root))},${fmt(cy + innerR * Math.sin(root))}`);
    pts.push(`${fmt(cx + outerR * Math.cos(tip))},${fmt(cy + outerR * Math.sin(tip))}`);
  }
  return pts.join(' ');
}

export interface RingTick {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
}

/**
 * 星盘刻度环的刻度线。`count` 条均布，每 `majorEvery` 条一条长刻度 ——
 * 长短交替让超慢自转「看得出在转」，同时不需要任何会闪的东西。
 */
export function orreryRingTicks(
  count: number,
  majorEvery: number,
  r: number,
  minorLen: number,
  majorLen: number,
  cx: number,
  cy: number,
): RingTick[] {
  const n = Math.max(1, Math.floor(count));
  const every = Math.max(1, Math.floor(majorEvery));
  const fmt = (v: number) => Math.round(v * 100) / 100;
  const ticks: RingTick[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const major = i % every === 0;
    const inner = r - (major ? majorLen : minorLen);
    ticks.push({
      x1: fmt(cx + inner * Math.cos(a)),
      y1: fmt(cy + inner * Math.sin(a)),
      x2: fmt(cx + r * Math.cos(a)),
      y2: fmt(cy + r * Math.sin(a)),
      major,
    });
  }
  return ticks;
}

// ── 氛围（偶发效果） ────────────────────────────────────────

/** 凝露偶发间隔（毫秒） */
export const CONDENSATION_INTERVAL = Object.freeze({ minMs: 50_000, maxMs: 120_000 });
/** 金线偶发间隔（毫秒） */
export const GOLD_THREAD_INTERVAL = Object.freeze({ minMs: 45_000, maxMs: 110_000 });

/** 侧条宽度（视口宽的百分比）。三分屏左右各 25%，这里只用外侧一截，离正文栏留足余量 */
export const SIDE_STRIP_VW = 14;

export interface SideStripSpot {
  side: 'left' | 'right';
  /** 距所在侧视口边缘的距离（vw），恒在 [1, SIDE_STRIP_VW - 1] 内 */
  edgeVw: number;
  /** 距视口顶部（vh） */
  topVh: number;
}

/**
 * 在侧条里随机取一个落点（凝露 / 金线共用）。`rng` 取三次：边、横向、纵向。
 * 纵向落在 [12, 52] vh：避开顶栏，也给向下滑留出行程。
 */
export function pickSideStripSpot(rng: () => number = Math.random): SideStripSpot {
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 0.999) : 0);
  const side = clamp01(rng()) < 0.5 ? 'left' : 'right';
  const edgeVw = 1 + clamp01(rng()) * (SIDE_STRIP_VW - 2);
  const topVh = 12 + clamp01(rng()) * 40;
  return {
    side,
    edgeVw: Math.round(edgeVw * 100) / 100,
    topVh: Math.round(topVh * 100) / 100,
  };
}

// ── 读当前主题（唯一碰 DOM 的部分） ─────────────────────────

const THEME_ATTR = 'data-theme';

/** 读 `<html data-theme>`；无 DOM 时返回 null */
export function readThemeSlug(): string | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.getAttribute(THEME_ATTR);
}

/**
 * 监听 `<html data-theme>` 变化，变了才回调（同值不回调）。
 * 主题 store 每次 `apply()` 都直接写这个属性，所以它就是当前主题的呈现真相。
 * @returns 取消函数（幂等）
 */
export function observeThemeSlug(onChange: (slug: string | null) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  let last = readThemeSlug();
  const observer = new MutationObserver(() => {
    const next = readThemeSlug();
    if (next === last) return;
    last = next;
    onChange(next);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [THEME_ATTR] });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
  };
}
