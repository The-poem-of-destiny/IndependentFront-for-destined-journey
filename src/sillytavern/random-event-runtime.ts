/**
 * random-event-runtime.ts — 现行随机事件包的**注入缝**（随机事件系统 v1 / 设计 §3.3·§4）
 *
 * 装什么: 「当前装着哪一份事件包」这一个模块级事实。`installRandomEventPack` 由前端
 *         （内容注册表第 13 面 `randomEvents`）在存档加载 / 换包时调用，引擎侧
 *         （`state-manager` 的掷骰与首访钩子、注入块的 resolver）只读。
 * 不装什么: **任何 I/O**（不 fetch、不读 Dexie、不碰内容注册表）、任何容错解析、任何策略。
 *           容错在 `random-event-pack.coerceRandomEventPack`（调用方在装之前过一遍），
 *           调度策略在接线层（`state-manager`）。
 *
 * 为什么要一条缝而不是让引擎自己去读注册表:
 * 逐字同 `map-runtime.ts` 的理由（先例 `engine-settings.ts` / Q-06）—— 引擎要的是
 * 「当前生效的事件包」这个**能力**，不是「某张表」这个位置。让引擎去 import 前端 store
 * 就是把依赖方向反过来。
 *
 * 没装时返回**空包**（零定义 + 默认 config）—— 那是兜底合同不是异常：
 * `isEmptyRandomEventPack` 为真，于是掷骰 / 首访 / 保洁 / 注入四条钩子整段 no-op，
 * 游戏一个字节都不受影响（引擎仓零内置事件，承内容-引擎分离 v1.3）。
 *
 * 🔴 **没有索引缓存**（与 `map-runtime` 刻意不同）：调度器吃的是 `defs` 数组本身
 *    （`rollRandomEvents` / `armFirstVisitEvent` 各自按需建一次 Map），而事件包是几十条
 *    量级、不是 316 块地。加一层缓存只会多出「什么时候失效」这个必须有人记得维护的问题。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（设计 §10，结构闸门 `random-event-literals-gate.test.ts`
 *    按 `random-event-*.ts` 通配自动收本文件）。注释里写中文是对的，闸门只管注释之外的代码。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md`。
 */

import type { RandomEventPack } from './random-event-pack';
import { DEFAULT_RANDOM_EVENT_CONFIG } from './types-random-events';

/**
 * 空包工厂。
 *
 * 🔴 **每次返回新对象**，不导出一个共享常量（照 `createEmptyMapPack` /
 *    `DEFAULT_RANDOM_EVENT_CONFIG` 那条注释的同一个理由）：导出的引用被下游 push 一条
 *    定义或改一格 config，此后所有走兜底路径的调用都被污染 —— 而兜底恰恰是没人手工验的那条。
 */
function createEmptyPack(): RandomEventPack {
  return { config: { ...DEFAULT_RANDOM_EVENT_CONFIG }, defs: [] };
}

/** 现行包。没人装过时是空包（兜底合同，见文件头） */
let installedPack: RandomEventPack = createEmptyPack();

/**
 * 装上一份包。**刻意不做容错**（keep dumb）：入参必须是已经过 `coerceRandomEventPack`
 * 的包 —— 在这里再收窄一遍就等于有两处容错口径，而两处不一致时先出错的那一处永远没人手工验。
 *
 * 两个运行时闸都只是「不是包」：
 *   · `null`（显式卸包 —— 换存档 / 内容注册表这一面缺席）
 *   · 不是对象 / `defs` 不是数组（跨模块 JSON 边界上 TS 类型拦不住 `undefined`）
 * 两者都落成空包（= 没装）比让调度钩子在读 `pack.defs` 时抛穿好 —— 随机事件整个是**可选**子系统。
 */
export function installRandomEventPack(pack: RandomEventPack | null): void {
  const usable =
    pack !== null && typeof pack === 'object' && Array.isArray(pack.defs) && pack.config !== null;
  installedPack = usable ? pack : createEmptyPack();
}

/** 现行包；没装过 → 空包（判据一律走 `isEmptyRandomEventPack`，不比定义条数） */
export function getRandomEventPack(): RandomEventPack {
  return installedPack;
}

/**
 * 回到「没装过」（测试用）。
 *
 * 模块级状态在 vitest 里跨用例存活，装过真包的用例不还原就会让后面每一个「空包应当整段
 * no-op」的断言悄悄测在一份真包上 —— 那种失败方向是**变绿**，不是变红。
 */
export function resetRandomEventRuntime(): void {
  installedPack = createEmptyPack();
}
