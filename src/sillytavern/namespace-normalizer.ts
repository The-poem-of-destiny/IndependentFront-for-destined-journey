/**
 * 命名空间规范化 — stat_data.* ↔ engine 命名空间双向映射 (Phase 5)
 *
 * ADR-23: JSON 使用扁平 stat_data.*，引擎使用语义命名空间
 */

// ========== 映射表 ==========

/** stat_data 扁平路径 → engine 语义路径 */
export const FLAT_TO_ENGINE: Record<string, string> = {
  // 主角
  'stat_data.主角': 'char.player',
  'stat_data.主角.HP': 'char.player.hp',
  'stat_data.主角.MP': 'char.player.mp',
  'stat_data.主角.SP': 'char.player.sp',
  'stat_data.主角.maxHP': 'char.player.maxHp',
  'stat_data.主角.maxMP': 'char.player.maxMp',
  'stat_data.主角.maxSP': 'char.player.maxSp',
  'stat_data.主角.等级': 'char.player.level',
  'stat_data.主角.生命层级': 'char.player.tier',
  'stat_data.主角.经验': 'char.player.totalExp',
  'stat_data.主角.力量': 'char.player.str',
  'stat_data.主角.敏捷': 'char.player.dex',
  'stat_data.主角.体质': 'char.player.con',
  'stat_data.主角.智力': 'char.player.int',
  'stat_data.主角.精神': 'char.player.spi',
  'stat_data.主角.金钱': 'char.player.money',
  'stat_data.主角.位置': 'char.player.location',
  'stat_data.主角.背包': 'char.player.inventory',
  'stat_data.主角.技能': 'char.player.skills',
  'stat_data.主角.装备': 'char.player.equipment',
  'stat_data.主角.状态效果': 'char.player.statusEffects',
  'stat_data.主角.种族': 'char.player.race',
  'stat_data.主角.身份': 'char.player.identity',
  'stat_data.主角.职业': 'char.player.occupation',
  'stat_data.主角.冒险者等级': 'char.player.adventurerRank',
  // 世界
  'stat_data.世界': 'sys.world',
  'stat_data.世界.地点': 'sys.world.location',
  'stat_data.世界.时间': 'sys.world.time',
  'stat_data.世界.年': 'sys.world.year',
  'stat_data.世界.月': 'sys.world.month',
  'stat_data.世界.日': 'sys.world.day',
  'stat_data.世界.星期': 'sys.world.weekday',
  // 系统
  'stat_data.命运点数': 'sys.fp',
  'stat_data.任务列表': 'sys.quests',
  'stat_data.事件': 'sys.events',
  'stat_data.事件.标题': 'sys.events.title',
  'stat_data.事件.阶段': 'sys.events.phase',
  'stat_data.事件.已完成事件': 'sys.events.completed',
  'stat_data.关系列表': 'sys.relationships',
  'stat_data.新闻': 'sys.news',
};

// ========== 转换函数 ==========

/** stat_data 扁平路径 → engine 语义路径 */
export function flatToEngine(flatPath: string): string {
  // 精确匹配
  if (FLAT_TO_ENGINE[flatPath]) return FLAT_TO_ENGINE[flatPath];

  // 前缀匹配: stat_data.主角.xxx → char.player.xxx
  if (flatPath.startsWith('stat_data.主角.')) {
    const rest = flatPath.slice('stat_data.主角.'.length);
    return 'char.player.' + rest;
  }
  if (flatPath.startsWith('stat_data.世界.')) {
    const rest = flatPath.slice('stat_data.世界.'.length);
    return 'sys.world.' + rest;
  }
  if (flatPath.startsWith('stat_data.事件.')) {
    const rest = flatPath.slice('stat_data.事件.'.length);
    return 'sys.events.' + rest;
  }
  if (flatPath.startsWith('stat_data.')) {
    const rest = flatPath.slice('stat_data.'.length);
    return 'sys.' + rest;
  }

  // 已有 engine 前缀: 直接返回
  return flatPath;
}

/** engine 语义路径 → stat_data 扁平路径 */
export function engineToFlat(enginePath: string): string {
  // 反向查找精确映射
  for (const [flat, engine] of Object.entries(FLAT_TO_ENGINE)) {
    if (engine === enginePath) return flat;
  }

  // 前缀反向: char.player.xxx → stat_data.主角.xxx
  if (enginePath.startsWith('char.player.')) {
    const rest = enginePath.slice('char.player.'.length);
    return 'stat_data.主角.' + rest;
  }
  if (enginePath.startsWith('sys.world.')) {
    const rest = enginePath.slice('sys.world.'.length);
    return 'stat_data.世界.' + rest;
  }
  if (enginePath.startsWith('sys.events.')) {
    const rest = enginePath.slice('sys.events.'.length);
    return 'stat_data.事件.' + rest;
  }
  if (enginePath.startsWith('sys.')) {
    const rest = enginePath.slice('sys.'.length);
    return 'stat_data.' + rest;
  }

  return enginePath;
}

/** 批量转换: flat → engine（递归处理整个变量树） */
export function normalizeVariables(flatVars: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { user: {}, sys: {}, char: {}, world: {}, temp: {} };

  // 遍历顶层键进行命名空间分配
  for (const [key, value] of Object.entries(flatVars)) {
    const enginePath = flatToEngine(key);
    const parts = enginePath.split('.');
    const ns = parts[0];
    if (!result[ns]) result[ns] = {};

    let current = result[ns];
    for (let i = 1; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  return result;
}

/** 批量转换: engine → flat */
export function denormalizeVariables(engineVars: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};

  function walk(obj: Record<string, any>, prefix: string) {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        walk(value, fullPath);
      } else {
        const flatPath = engineToFlat(fullPath);
        result[flatPath] = value;
      }
    }
  }

  walk(engineVars, '');
  return result;
}
