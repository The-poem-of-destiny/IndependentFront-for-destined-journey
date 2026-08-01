/**
 * stat-projection.ts — 契约轴①：`stats` 只读面投影（工坊 Phase 2 / ADR-30 D4）
 *
 * 职责：把引擎的**纯代码推导数值**投影成一个供世界书 EJS 求值使用的中文键快照。
 * 纯函数模块，零依赖、零副作用、零 I/O。
 *
 * 「只读」的实现方式（设计 D4）：
 * - 返回值是**深拷贝孤儿对象**——与入参零共享引用。EJS 就地改它不会污染引擎状态，
 *   pass 结束即弃；「写了不生效」由拷贝语义保证。
 * - **刻意不 freeze**：语料存在「读出来做局部数组操作再判断」的模式，freeze 会误伤。
 * - 每个装配 pass 独立调用本函数重新克隆（体量极小），杜绝跨 pass 写泄漏。
 *
 * 范围（设计 D4 钉死，不得自行扩面）：仅资源/等级/层级/经验/五维/命运点数/世界时间。
 * **不含**背包、技能、装备、状态效果、任务列表、关系列表——那些是设计 §5 的挂起项，
 * 由 `vars` 轴或后续设计决定，别在这里自作主张加。
 */

import type { CharacterState } from './types';
import { formatGameTime, type GameTime } from './time-system';

/** buildStatData 的入参 */
export interface StatProjectionInput {
  /** 全部角色；玩家 = 首个 `type === 'player'` 的那个 */
  characters: CharacterState[];
  /** 游戏内时间；缺失时结果不含 `世界` 键 */
  gameTime?: GameTime;
  /** 存档级命运点数（SaveProfile.fp）；缺失时结果不含 `命运点数` 键 */
  fp?: number;
}

/**
 * 构建 `stats` 只读面快照。
 *
 * @param input 角色列表 + 可选的游戏时间 / 命运点数
 * @returns 深拷贝孤儿对象。无玩家角色时不含 `主角` 键；
 *          `gameTime` 缺失时不含 `世界` 键；`fp` 缺失时不含 `命运点数` 键。
 */
export function buildStatData(input: StatProjectionInput): Record<string, any> {
  const stats: Record<string, any> = {};

  const player = input.characters?.find((c) => c.type === 'player');
  if (player) {
    const attrs = player.attributes;
    stats['主角'] = {
      // 资源
      生命值: player.hp,
      生命值上限: player.maxHp,
      法力值: player.mp,
      法力值上限: player.maxMp,
      体力值: player.sp,
      体力值上限: player.maxSp,
      // 等级 / 层级 / 经验
      等级: player.level,
      生命层级: player.tierName,
      累计经验值: player.totalExp,
      升级所需经验: player.expToNext,
      // 五维 + 未分配点
      属性: {
        力量: attrs?.str ?? 0,
        敏捷: attrs?.dex ?? 0,
        体质: attrs?.con ?? 0,
        智力: attrs?.int ?? 0,
        精神: attrs?.spi ?? 0,
        属性点: player.freeAttrPoints,
      },
    };
  }

  if (input.fp !== undefined) {
    stats['命运点数'] = input.fp;
  }

  if (input.gameTime) {
    // 引擎既有规范串：复兴纪元0001年-05月-24日-周日-15:30
    stats['世界'] = { 时间: formatGameTime(input.gameTime) };
  }

  return stats;
}
