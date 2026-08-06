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
 * 范围（**能力面设计 §3.1 / 切片 T3 已扩面**，取代 P2 设计 D4 的窄口径）：
 * 资源 / 等级层级经验 / 五维 / 金钱 / **背包 / 装备 / 技能 / 状态效果 / 登神长阶** /
 * 队伍 / 命运点数 / 世界（时间·时段·回合·天气·地点）。
 *
 * 扩面理由：D4 把背包等列为挂起项，实际后果是真机语料 17 处读全部走守卫默认分支
 *（「当作未持有」）——对创作者是**沉默的错误**，不是降级。
 *
 * **仍然不含**：任务列表 / 关系列表（走 `quest` / `char` 命名空间，不塞进 stats）、
 * 物品与技能的 `effects` / `scripts` / `modifiers` / `automata`（引擎内部效果编译输入，
 * 形状随战斗 v3 演进；暴露出去等于把内部结构变成对创作者的长期承诺）。
 */

import type { CharacterState } from './types';
import { formatGameTime, getTimeOfDay, type GameTime } from './time-system';

/** buildStatData 的入参 */
export interface StatProjectionInput {
  /** 全部角色；玩家 = 首个 `type === 'player'` 的那个 */
  characters: CharacterState[];
  /** 游戏内时间；缺失时结果不含 `世界` 键 */
  gameTime?: GameTime;
  /** 存档级命运点数（SaveProfile.fp）；缺失时结果不含 `命运点数` 键 */
  fp?: number;
  /** 回合号（= 历史长度）；缺失时不含 `世界.回合` */
  turn?: number;
  /** 当前天气；缺失时不含 `世界.天气` */
  weather?: string;
}

// ═══════════════════════════════════════════════════════════
// 子投影（T3 扩面：背包/装备/技能/状态效果/队伍）
// ═══════════════════════════════════════════════════════════

/**
 * 背包投影。
 *
 * 只投**叙事与判断需要的字段**，刻意不投 `effects` / `scripts` / `modifiers` / `automata`：
 * 那些是引擎内部的效果编译输入，形状随战斗 v3 演进，暴露出去等于把内部结构变成对创作者的承诺。
 * 创作者要判断「有没有这把武器」「够不够数量」「装没装备」，这几个字段就够。
 */
function projectInventory(chars: CharacterState['inventory'] | undefined): any[] {
  if (!Array.isArray(chars)) return [];
  return chars.map((item) => ({
    名字: item.name,
    类型: item.type ?? '',
    品质: item.rarity ?? '普通',
    数量: item.quantity,
    装备槽位: item.equippedSlot ?? '',
    描述: item.description ?? '',
  }));
}

/**
 * 装备索引视图：`{ 槽位: 物品名 }`。
 *
 * M2 起装备不再是独立数组 —— 装备 = 背包里 `equippedSlot` 非空的物品（数据字典规范 §3）。
 * 这里只是给创作者一个免遍历的快捷入口，真源仍是背包。
 */
function projectEquipment(inv: CharacterState['inventory'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(inv)) return out;
  for (const item of inv) {
    const slot = item.equippedSlot;
    if (typeof slot === 'string' && slot.length > 0) out[slot] = item.name;
  }
  return out;
}

function projectSkills(skills: CharacterState['skills'] | undefined): any[] {
  if (!Array.isArray(skills)) return [];
  return skills.map((s) => ({
    名字: s.name,
    类型: s.type === 'passive' ? '被动' : '主动',
    等级: s.level ?? 1,
    描述: s.description ?? '',
    // 冷却是「现在能不能用」的判断依据，属于叙事可见信息
    剩余冷却: s.cooldown ?? 0,
  }));
}

function projectStatusEffects(effects: CharacterState['statusEffects'] | undefined): any[] {
  if (!Array.isArray(effects)) return [];
  return effects.map((e) => ({
    名字: e.name,
    分类: e.category,
    层数: e.stacks,
    // `null` = 永久。保留 null 而不是塞 0/-1 —— 创作者写 `?? '永久'` 比记特殊值容易
    剩余时间: e.remainingTime,
    时间单位: e.timeUnit,
    描述: e.description ?? '',
  }));
}

/** 登神长阶（Lv.13+）；未开启时返回一个「已开启: false」的空壳，免得创作者到处判 undefined */
function projectAscension(asc: CharacterState['ascension'] | undefined): Record<string, any> {
  if (!asc) return { 已开启: false, 要素: [], 权能: [], 法则: [], 神位: '', 神国: '' };
  return {
    已开启: asc.enabled === true,
    要素: (asc.elements ?? []).map((x: any) => x?.name ?? String(x ?? '')),
    权能: (asc.authority ?? []).map((x: any) => x?.name ?? String(x ?? '')),
    法则: (asc.law ?? []).map((x: any) => x?.name ?? String(x ?? '')),
    神位: asc.deityPosition ?? '',
    神国: asc.divineKingdom?.name ?? '',
  };
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
      // —— T3 扩面（能力面 §3.1）——
      // P2 设计 D4 曾把这几项列为挂起项，实际后果是语料 17 处读全走守卫默认分支
      //（「当作未持有」），对创作者是**沉默的错误**而不是降级。故全部纳入。
      金钱: player.money ?? 0,
      背包: projectInventory(player.inventory),
      装备: projectEquipment(player.inventory),
      技能: projectSkills(player.skills),
      状态效果: projectStatusEffects(player.statusEffects),
      登神长阶: projectAscension(player.ascension),
    };
  }

  // 队伍：在场同伴的精简同构投影（不含背包/技能 —— 那是主角面，同伴给数值就够）
  const party = (input.characters ?? []).filter(
    (c) => c.type !== 'player' && c.type !== 'monster' && isPresentish(c),
  );
  if (party.length > 0) {
    stats['队伍'] = party.map((c) => ({
      名字: c.name,
      生命值: c.hp,
      生命值上限: c.maxHp,
      等级: c.level,
      生命层级: c.tierName,
      种族: c.race ?? '',
    }));
  }

  if (input.fp !== undefined) {
    stats['命运点数'] = input.fp;
  }

  // 世界面：任一子项存在即建键（时间/回合/天气各自独立缺省）
  const world: Record<string, any> = {};
  if (input.gameTime) {
    // 引擎既有规范串：<纪元名>0001年-05月-24日-周日-15:30（纪元名来自存档，引擎不产生）
    world['时间'] = formatGameTime(input.gameTime);
    world['时段'] = getTimeOfDay(input.gameTime);
  }
  if (input.turn !== undefined) world['回合'] = input.turn;
  if (input.weather !== undefined) world['天气'] = input.weather;
  // 地点/势力取玩家所在处（引擎真源是角色字段，不是独立的世界状态）
  const playerForWorld = input.characters?.find((c) => c.type === 'player');
  if (playerForWorld?.location) world['地点'] = playerForWorld.location;
  if (Object.keys(world).length > 0) stats['世界'] = world;

  return stats;
}

/**
 * 「算不算在场」——`char-query.isPresent` 的宽松版。
 *
 * 刻意不 import `char-query`：本模块的纯度约束是零依赖（除 types 与 time-system），
 * 而在场判定在这里只是个筛子，判宽了最多多投一个同伴，判窄了会漏。
 */
function isPresentish(c: CharacterState): boolean {
  return c.hp > 0;
}
