/**
 * random-event-snapshot.ts — 条件求值的只读快照，**全仓唯一一份**
 * （随机事件系统 v1 / 设计 §2 词汇表·§4）
 *
 * 装什么: 两件事的唯一实现 ——
 *         · `resolveRandomEventPlaceKey`：地点键（落位成功 = 地块名，失败 = 位置路径最深段）
 *         · `buildRandomEventRollContext`：`RandomEventRollContext` 的组装
 * 不装什么: 任何写入、任何 I/O（角色行由调用方查好交进来 —— 写侧在 StateManager 用
 *           `getCharacters`，读侧在 game-pipeline 用 Pinia 里那份，两条取角色的路本来就不同）。
 *
 * 为什么要有这个文件（2026-08-16 审查修复）:
 * 这两个函数此前在 `state-manager.ts`（入池时用）与 `ui/lib/game-pipeline.ts`（注入时用）
 * **各有一份逐字相同的实现**，靠注释里一句「改一处必须改另一处」维持。漂了不报错，
 * 症状是「入池时按 A 键记账、注入时按 B 键过滤」—— 首访条目在注入面静默消失，
 * 或者反过来「注入块里看得见、库里已经撤掉」。两边都不抛、都不 warn。
 *
 * 🔴 **写侧与读侧必须共用这一份**（同 `isPendingStillValid` 那条纪律）。要改判据，改这里。
 *
 * 🔴 **零中文字面量**（`random-event-*.ts` 通配自动进结构闸门）：地点名与季节/时段词全是
 *    数据 —— 前者来自地图包与角色的位置路径，后者来自 `time-system`。
 *
 * 设计全文: `docs/planning/2026-08-15-random-event-system-design.md`。
 */

import { splitLocationSegments } from './map-index';
import { isEmptyMapPack } from './map-pack';
import { getMapIndex, getMapPack } from './map-runtime';
import { getMapFlags } from './save-profile';
import { getSeason, getTimeOfDay } from './time-system';
import type { CharacterState, SaveProfile } from './types';
import type { RandomEventRollContext } from './types-random-events';

/**
 * 地点键（§2 词汇表）：**落位成功 = 地块名，失败 = 位置路径最深段**。
 *
 * 🔴 取地块**名**而不是 `lastTileId`：足迹（`visited`）要在换图后存活，名字比编号稳定
 *    （§4.2）。也正因如此，没装地图包 / 落位失败时降级到位置路径最深段 ——
 *    首访语义降级但不失效，且**永不模糊匹配**（承 ADR-31）。
 * 🔴 分段走 `splitLocationSegments`（`map-index.ts` 那份是全仓正典）：条件 DSL 的地点面
 *    用的也是它，两处口径必须逐字符相同。
 */
export function resolveRandomEventPlaceKey(
  lastTileId: number | undefined,
  locationPath: string,
): string | undefined {
  if (lastTileId !== undefined && !isEmptyMapPack(getMapPack())) {
    const name = getMapIndex().tileById.get(lastTileId)?.name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const segments = splitLocationSegments(locationPath ?? '');
  return segments.length > 0 ? segments[0] : undefined;
}

/**
 * 条件求值的只读快照（`RandomEventRollContext`）。
 *
 * 🔴 **每一格缺席时相关条件求值为假**（不是「通过」）—— 所以这里宁可少供一格，
 *    也绝不为了让条件好过而编一个值。玩家角色不在（新档 / 已删）时 `playerLevel`
 *    与 `placeKey` 双双缺席，于是带地点或等级门槛的事件都不会触发，这是对的。
 *
 * `player` 由调用方交进来：写侧从 Dexie 查（`getCharacters`），读侧用 store 里那份 ——
 * 两条路不同，但**答案必须同一份**，所以组装在这里而不是各自拼。
 */
export function buildRandomEventRollContext(
  profile: SaveProfile,
  player: CharacterState | undefined,
): RandomEventRollContext {
  const mapFlags = getMapFlags(profile);

  const quests: Record<string, string> = {};
  for (const [name, quest] of Object.entries(profile.quests ?? {})) {
    if (typeof quest?.status === 'string') quests[name] = quest.status;
  }

  const ctx: RandomEventRollContext = {
    journeyActive: mapFlags.journey !== undefined,
    season: getSeason(profile.gameTime.month),
    timeOfDay: getTimeOfDay(profile.gameTime),
    variables: profile.variables ?? {},
    quests,
    affections: profile.affections ?? {},
  };

  if (player !== undefined) {
    ctx.locationPath = player.location;
    const placeKey = resolveRandomEventPlaceKey(mapFlags.lastTileId, player.location);
    if (placeKey !== undefined) ctx.placeKey = placeKey;
    if (typeof player.level === 'number' && Number.isFinite(player.level)) {
      ctx.playerLevel = player.level;
    }
  }
  return ctx;
}
