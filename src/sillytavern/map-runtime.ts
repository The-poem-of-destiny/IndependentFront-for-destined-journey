/**
 * map-runtime.ts — 现行地图包的**注入缝**（地图系统 v1 / 设计 §3.3·§5）
 *
 * 装什么: 「当前装着哪一份 map-pack」这一个模块级事实，外加它的派生索引缓存。
 *         `installMapPack` 由前端（内容注册表第 8 面 `mapPack`）在存档加载 / 换包时调用，
 *         引擎侧（`state-manager` 的落位与天气钩子）只读。
 * 不装什么: **任何 I/O**（不 fetch、不读 Dexie、不碰内容注册表）、任何容错解析、任何策略。
 *           容错在 `map-pack.coerceMapPack`（调用方在装之前过一遍），落位/天气/在途的策略
 *           在接线层（`state-manager`）。
 *
 * 为什么要一条缝而不是让引擎自己去读注册表:
 * 先例 `engine-settings.ts`（Q-06）—— 引擎要的是「当前生效的地图」这个**能力**，不是「某张表」
 * 这个位置。引擎里一次注册表读取都不该有（§5「参数拿数据，不自己读注册表」），而地图 v1 的
 * 全部消费方都在引擎侧：让它们各自去 import 前端 store 就是把依赖方向反过来。
 * 没注册时返回**空包**（`EMPTY_MAP_PACK`）—— 那是兜底合同不是异常（`map-pack.ts` 文件头）：
 * 落位永远 `null`、天气永远不断言、`MAP_CONTEXT` 整段不出，游戏照常进行。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（§3.4-1，结构闸门 `map-literals-gate.test.ts` 钉死）。
 *    注释里写中文是对的，闸门只管注释之外的代码。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`（§3.3 内容分离 / §3.4 换图
 * 零改码 / §5 接线表）。领域词汇在根目录 `CONTEXT.md`「地图系统」节。
 */

import { buildMapIndex, type MapIndex } from './map-index';
import { EMPTY_MAP_PACK } from './map-pack';
import type { MapPack } from './types-map';

/** 现行包。没人装过时是空包（兜底合同，见文件头） */
let installedPack: MapPack = EMPTY_MAP_PACK;

/**
 * 索引缓存 + 它对应的那一份包。
 *
 * 🔴 缓存键是**包对象的同一性**，不是 `contentHash`：`installMapPack` 是这个缓存唯一的失效点，
 *    而「同一个引用」这个判据不需要任何人记得去维护它。拿 hash 当键会多出一条「hash 相同但
 *    对象被换过」的路径（手搓包 / 测试夹具 / 编译脚本忘了更新 hash），那条路径的症状是
 *    **沿着旧地图落位**，而它不报错（`map-index.ts` 文件头那条「没有缓存，因为重建就该是便宜的」
 *    说的是同一件事：任何按版本键控的记忆化都要回答「什么时候失效」）。
 */
let cachedIndex: MapIndex | null = null;
let cachedIndexPack: MapPack | null = null;

/**
 * 装上一份包。**刻意不做容错**（keep dumb）：入参必须是已经过 `coerceMapPack` 的包 ——
 * 在这里再收窄一遍就等于有两处容错口径，而两处不一致时先出错的那一处永远没人手工验。
 *
 * 唯一的运行时闸是「不是对象」：调用方是前端注册表，那一面缺席时交过来的是 `undefined`，
 * 而 TS 类型在跨模块 JSON 边界上拦不住它。落成空包（= 没装）比让 `getMapIndex()`
 * 在读 `pack.tiles` 时抛穿好 —— 地图整个是**可选**子系统。
 */
export function installMapPack(pack: MapPack): void {
  const next = pack !== null && typeof pack === 'object' ? pack : EMPTY_MAP_PACK;
  if (next === installedPack) return;
  installedPack = next;
  cachedIndex = null;
  cachedIndexPack = null;
}

/** 现行包；没装过 → 空包（判据一律走 `isEmptyMapPack`，不比版本串） */
export function getMapPack(): MapPack {
  return installedPack;
}

/**
 * 现行包的运行时索引（按现行包记忆化）。
 *
 * 落位每回合至少跑一次、天气每次跨天跑一次，而 316 块地建一次索引不是零成本；
 * 记忆化的失效点只有一个（`installMapPack`），所以这份缓存不会长出「什么时候失效」的问题。
 */
export function getMapIndex(): MapIndex {
  if (cachedIndex === null || cachedIndexPack !== installedPack) {
    cachedIndex = buildMapIndex(installedPack);
    cachedIndexPack = installedPack;
  }
  return cachedIndex;
}

/**
 * 回到「没装过」（测试用）。
 *
 * 模块级状态在 vitest 里跨用例存活，装过真包的用例不还原就会让后面每一个「空包应当整段不出」
 * 的断言悄悄测在一份真包上 —— 那种失败方向是**变绿**，不是变红。
 */
export function resetMapRuntime(): void {
  installedPack = EMPTY_MAP_PACK;
  cachedIndex = null;
  cachedIndexPack = null;
}
