/**
 * ejs-rng.ts —— 种子随机（能力面设计 §3.10 / §7 / 切片 T2）
 *
 * ## 为什么不能用 `Math.random`
 * 引擎有快照回退 / 重发（Phase 10k）。EJS 用真随机时，同一个存档点重放会产出**不同的世界书正文** ——
 * 玩家会看到「同一时间点、不同的世界内容」，而且 debug loop 里没法复现。
 *
 * 故 `rng.*` 的序列由**种子**决定：
 * ```
 * 种子 = hash(pass 种子 ‖ 条目正文)      pass 种子 = hash(saveId ‖ 回合号)
 * ```
 * - 同一回合、同一条目重放 → 逐值一致
 * - 不同条目 / 不同回合 → 互不相关（条目正文进 hash，所以两个条目不会同相位）
 * - 条目正文改了 → 序列变（可接受：内容变了本来就不是同一条目）
 *
 * `Math.random` 仍然注入（原生直传，不刻意封杀），但文档明说**不可复现**；
 * `_.random` / `_.sample` 与 `{{roll}}` / `{{random::}}` 宏一律走本模块。
 *
 * 纯函数模块：无 I/O、无全局状态。每次执行现造一个实例。
 */

import { parseDiceFormula } from './dice';

// ═══════════════════════════════════════════════════════════
// 种子与序列
// ═══════════════════════════════════════════════════════════

/** FNV-1a 32 位 —— 与仓库其它地方同款，稳定跨平台 */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 构造 pass 级种子串。
 *
 * `saveId` 缺失时退化成固定串 —— 那种情况（测试/预览）本来就不需要跨会话复现，
 * 但**同一次运行内仍然确定**，这才是不变式所在。
 */
export function buildPassSeed(saveId: string | undefined, turn: number | undefined): string {
  return `${saveId ?? 'no-save'}#${turn ?? 0}`;
}

/** xorshift32 —— 小、快、无状态泄漏；不做密码学用途 */
function makeSequence(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

// ═══════════════════════════════════════════════════════════
// rng 命名空间
// ═══════════════════════════════════════════════════════════

export interface EjsRollDetail {
  总计: number;
  骰值: number[];
  修正: number;
}

export interface EjsRng {
  /** `'1d100'` / `'2d6+3'`；公式不可解析返回 0（数值位不抛错，见设计 P3） */
  roll(formula: string): number;
  rollDetail(formula: string): EjsRollDetail;
  /** 闭区间整数 */
  int(min: number, max: number): number;
  /** [0, 1) */
  float(): number;
  pick<T>(items: T[]): T | undefined;
  /** 不重复抽样；n ≥ 长度时返回整份洗牌 */
  pickN<T>(items: T[], n: number): T[];
  shuffle<T>(items: T[]): T[];
  /** p ∈ [0,1]，越界自动夹紧 */
  chance(p: number): boolean;
}

/**
 * 造一个 rng 实例。
 *
 * @param seedText 种子串（通常是 `pass 种子 ‖ 条目正文`）
 */
export function createEjsRng(seedText: string): EjsRng {
  const next = makeSequence(hashSeed(seedText));

  const intInclusive = (min: number, max: number): number => {
    const lo = Math.ceil(Number(min));
    const hi = Math.floor(Number(max));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return 0;
    return lo + Math.floor(next() * (hi - lo + 1));
  };

  const shuffle = <T>(items: T[]): T[] => {
    if (!Array.isArray(items)) return [];
    const out = items.slice();
    // Fisher-Yates，用同一条序列 → 洗牌结果同样可复现
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const rollDetail = (formula: string): EjsRollDetail => {
    const parsed = parseDiceFormula(String(formula ?? ''));
    if (!parsed) return { 总计: 0, 骰值: [], 修正: 0 };
    const 骰值: number[] = [];
    for (let i = 0; i < parsed.count; i++) 骰值.push(1 + Math.floor(next() * parsed.sides));
    const 总计 = 骰值.reduce((a, b) => a + b, 0) + parsed.modifier;
    return { 总计, 骰值, 修正: parsed.modifier };
  };

  return {
    roll: (formula) => rollDetail(formula).总计,
    rollDetail,
    int: intInclusive,
    float: () => next(),
    pick: (items) =>
      Array.isArray(items) && items.length > 0
        ? items[Math.floor(next() * items.length)]
        : undefined,
    pickN: (items, n) => {
      if (!Array.isArray(items)) return [];
      const count = Math.max(0, Math.min(Math.floor(Number(n) || 0), items.length));
      return shuffle(items).slice(0, count);
    },
    shuffle,
    chance: (p) => {
      const prob = Number(p);
      if (!Number.isFinite(prob)) return false;
      return next() < Math.min(1, Math.max(0, prob));
    },
  };
}
