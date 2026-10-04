/**
 * 战斗参战名单 → 参战单位（集群聚合）
 *
 * marker 的 `allies` / `enemies` 是逗号分隔的名单，支持 `名字×N` 计数语法：
 *   enemies="林沼食腐兽×5" → 5 只同类聚合为一个**集群单位**（世界书 [战斗协议]：
 *   ≥3 个同类低级单位可聚合为集群），资源 = 个体上限 × N、`cluster.alive/total = N`；
 *   攻击/结算按协议集群公式，经验走 `computeCombatExpRewards` 的集群衰减。
 *
 * 🔴 纯函数（无 I/O / 无 store），逻辑键 = 名字（铁律 1），AI 永不产 id。
 */

import type { CharacterState } from '../../types/types';
import type { CombatTriggerMarker } from '../../types/types';
import type { CombatantInput, CombatFacing, CombatSide } from './types';

/** 集群聚合阈值（世界书 [战斗协议]：≥3 个同类可聚合） */
export const COMBAT_CLUSTER_THRESHOLD = 3;

/**
 * 解析 marker 名单：`名字` 或 `名字×N`（`×` / `*` / `x` / `X` 都吃），逗号（半/全角）分隔。
 * 同名累加人数；未写数量按 1。返回 名字 → 数量。
 */
export function parseCombatRoster(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of (raw ?? '').split(/[,，]/)) {
    const t = token.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)\s*[×*xX]\s*(\d+)\s*$/);
    const name = (m ? m[1] : t).trim();
    if (!name) continue;
    const count = m ? Math.max(1, Number(m[2])) : 1;
    out.set(name, (out.get(name) ?? 0) + count);
  }
  return out;
}

/** 名单里的纯名字集（去掉数量），供按名分阵营 / 匹配存档角色 */
export function rosterNames(entries: Map<string, number>): Set<string> {
  return new Set(entries.keys());
}

/** 建一个集群单位：N 个同类个体聚合，资源 = 个体上限 × N（满编出场） */
export function buildClusterCombatant(
  character: CharacterState,
  side: CombatSide,
  pos: number,
  facing: CombatFacing,
  count: number,
): CombatantInput {
  const scale = (v: number): number => (Number.isFinite(v) ? v * count : v);
  return {
    character,
    side,
    pos,
    facing,
    cluster: { alive: count, total: count },
    hp: scale(character.maxHp),
    maxHp: scale(character.maxHp),
    mp: scale(character.maxMp),
    maxMp: scale(character.maxMp),
    sp: scale(character.maxSp),
    maxSp: scale(character.maxSp),
  };
}

/**
 * 从 marker 名单 + 存档角色建参战单位。同一名字人数 ≥3 → 聚合为一个集群单位。
 * 返回 null 表示名单为空 / 无可参战角色。
 */
export function buildCombatRosterFromMarker(
  marker: CombatTriggerMarker,
  characters: readonly CharacterState[],
): { combatants: CombatantInput[]; rosterText: string } | null {
  const allyEntries = parseCombatRoster(marker.allies);
  const enemyEntries = parseCombatRoster(marker.enemies);
  const allyNames = rosterNames(allyEntries);
  const enemyNames = rosterNames(enemyEntries);
  const hasListedSides = allyNames.size > 0 || enemyNames.size > 0;

  const sideOf = (c: CharacterState): CombatSide => {
    if (hasListedSides) {
      if (allyNames.has(c.name)) return 'ally';
      if (enemyNames.has(c.name)) return 'enemy';
      return c.type === 'player' ? 'ally' : 'enemy';
    }
    return c.type === 'player' ? 'ally' : 'enemy';
  };
  const inRoster = (c: CharacterState): boolean =>
    c.type === 'player' || allyNames.has(c.name) || enemyNames.has(c.name);

  const roster = characters.filter((c) => {
    if (c.hp <= 0) return false;
    if (!hasListedSides) return true;
    return inRoster(c);
  });
  if (roster.length === 0) return null;

  const combatants: CombatantInput[] = roster.map((c, index) => {
    const side = sideOf(c);
    const pos = index + 1;
    const facing: CombatFacing = side === 'ally' ? 'right' : 'left';
    const count = (side === 'ally' ? allyEntries : enemyEntries).get(c.name) ?? 1;
    if (count >= COMBAT_CLUSTER_THRESHOLD) {
      return buildClusterCombatant(c, side, pos, facing, count);
    }
    return { character: c, side, pos, facing };
  });
  const rosterText = hasListedSides
    ? '我方: ' + (marker.allies ?? '') + '；敌方: ' + (marker.enemies ?? '')
    : '';
  return { combatants, rosterText };
}
