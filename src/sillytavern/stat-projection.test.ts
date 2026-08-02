/**
 * stat-projection.test.ts — `stats` 只读面投影单元测试（工坊 Phase 2 / ADR-30 D4）
 *
 * 覆盖: 完整字段映射 / 无玩家角色 / 无 gameTime / 无 fp /
 *       深拷贝隔离（改返回值不脏入参）/ 范围栅栏（不含背包技能等挂起项）。
 * 纯函数模块，无 seam 注入、无 DB。
 */

import { describe, it, expect } from 'vitest';
import { buildStatData } from './stat-projection';
import { createDefaultCharacterState } from './types';
import { formatGameTime, getTimeOfDay, type GameTime } from './time-system';
import type { CharacterState } from './types';

/** 一个数值全部互不相同的玩家角色——任何字段错位都会被断言抓到 */
function makePlayer(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: 'p1',
    saveId: 's1',
    type: 'player',
    name: '莉泽尔',
    hp: 71,
    maxHp: 120,
    mp: 33,
    maxMp: 80,
    sp: 45,
    maxSp: 90,
    level: 12,
    tier: 3,
    tierName: '精英',
    totalExp: 3400,
    expToNext: 4000,
    attributes: { str: 5, dex: 6, con: 7, int: 8, spi: 9 },
    freeAttrPoints: 4,
    ...overrides,
  });
}

const TIME: GameTime = {
  era: '复兴纪元',
  year: 1,
  month: 5,
  day: 24,
  weekday: 1,
  hour: 15,
  minute: 30,
};

describe('buildStatData — 完整映射', () => {
  it('把玩家的资源/等级/层级/经验/五维投影成中文键，并带上命运点数与世界时间', () => {
    const stats = buildStatData({ characters: [makePlayer()], gameTime: TIME, fp: 7 });

    expect(stats).toEqual({
      主角: {
        生命值: 71,
        生命值上限: 120,
        法力值: 33,
        法力值上限: 80,
        体力值: 45,
        体力值上限: 90,
        等级: 12,
        生命层级: '精英',
        累计经验值: 3400,
        升级所需经验: 4000,
        属性: {
          力量: 5,
          敏捷: 6,
          体质: 7,
          智力: 8,
          精神: 9,
          属性点: 4,
        },
        // T3 扩面：默认角色的这几项都是空集，但**键必须在** ——
        // 创作者写 `stats.主角.背包.some(...)` 不该因为背包空就炸
        金钱: 0,
        背包: [],
        装备: {},
        技能: [],
        状态效果: [],
        登神长阶: { 已开启: false, 要素: [], 权能: [], 法则: [], 神位: '', 神国: '' },
      },
      命运点数: 7,
      世界: { 时间: formatGameTime(TIME), 时段: getTimeOfDay(TIME) },
    });
  });

  it('T3 扩面：背包/装备/技能/状态效果 逐字段投影', () => {
    const player = makePlayer({
      money: 250,
      inventory: [
        {
          id: 'i1',
          name: '青铜钥匙',
          description: '锈迹斑斑',
          quantity: 2,
          type: 'quest',
          rarity: '稀有',
        } as never,
        { id: 'i2', name: '铁剑', quantity: 1, equippedSlot: '武器' } as never,
      ],
      skills: [
        {
          id: 's1',
          name: '斩击',
          description: '劈砍',
          type: 'active',
          level: 3,
          cooldown: 2,
        } as never,
        { id: 's2', name: '坚韧', description: '被动减伤', type: 'passive' } as never,
      ],
      statusEffects: [
        {
          id: 'e1',
          name: '中毒',
          description: '每回合掉血',
          category: '减益',
          stacks: 2,
          remainingTime: 3,
          timeUnit: '回合',
        } as never,
      ],
    });
    const stats = buildStatData({ characters: [player] });
    const 主角 = stats['主角'];

    expect(主角['金钱']).toBe(250);
    expect(主角['背包']).toEqual([
      { 名字: '青铜钥匙', 类型: 'quest', 品质: '稀有', 数量: 2, 装备槽位: '', 描述: '锈迹斑斑' },
      { 名字: '铁剑', 类型: '', 品质: '普通', 数量: 1, 装备槽位: '武器', 描述: '' },
    ]);
    // 装备是背包的索引视图，不是第二份真源
    expect(主角['装备']).toEqual({ 武器: '铁剑' });
    expect(主角['技能']).toEqual([
      { 名字: '斩击', 类型: '主动', 等级: 3, 描述: '劈砍', 剩余冷却: 2 },
      { 名字: '坚韧', 类型: '被动', 等级: 1, 描述: '被动减伤', 剩余冷却: 0 },
    ]);
    expect(主角['状态效果']).toEqual([
      { 名字: '中毒', 分类: '减益', 层数: 2, 剩余时间: 3, 时间单位: '回合', 描述: '每回合掉血' },
    ]);
  });

  it('T3：状态效果的 剩余时间 保留 null（= 永久），不塞 0/-1 特殊值', () => {
    const player = makePlayer({
      statusEffects: [
        {
          id: 'e1',
          name: '祝福',
          description: '',
          category: '增益',
          stacks: 1,
          remainingTime: null,
          timeUnit: '回合',
        } as never,
      ],
    });
    expect(buildStatData({ characters: [player] })['主角']['状态效果'][0]['剩余时间']).toBeNull();
  });

  it('T3：不投效果编译输入（effects/scripts/modifiers/automata 不是对创作者的承诺）', () => {
    const player = makePlayer({
      inventory: [
        {
          id: 'i1',
          name: '魔剑',
          quantity: 1,
          effects: { 攻击: '+5' },
          scripts: { init: 'x' },
          modifiers: [{ k: 'v' }],
          automata: [{ a: 1 }],
        } as never,
      ],
    });
    const item = buildStatData({ characters: [player] })['主角']['背包'][0];
    for (const forbidden of ['effects', 'scripts', 'modifiers', 'automata', 'id']) {
      expect(item).not.toHaveProperty(forbidden);
    }
  });

  it('T3 队伍：在场同伴进 stats.队伍，怪物与倒地者不进', () => {
    const ally = createDefaultCharacterState({
      id: 'a1',
      type: 'npc',
      name: '艾波丽斯',
      hp: 50,
      maxHp: 60,
      level: 9,
      tierName: '中坚',
      race: '智人种',
    });
    const downed = createDefaultCharacterState({ id: 'a2', type: 'npc', name: '倒地者', hp: 0 });
    const monster = createDefaultCharacterState({ id: 'm1', type: 'monster', name: '狼', hp: 30 });
    const stats = buildStatData({ characters: [makePlayer(), ally, downed, monster] });

    expect(stats['队伍']).toEqual([
      { 名字: '艾波丽斯', 生命值: 50, 生命值上限: 60, 等级: 9, 生命层级: '中坚', 种族: '智人种' },
    ]);
  });

  it('T3 世界：回合 / 天气 / 地点 各自独立缺省', () => {
    const player = makePlayer({ location: '晨曦镇' });
    const full = buildStatData({ characters: [player], gameTime: TIME, turn: 12, weather: '小雨' });
    expect(full['世界']).toEqual({
      时间: formatGameTime(TIME),
      时段: getTimeOfDay(TIME),
      回合: 12,
      天气: '小雨',
      地点: '晨曦镇',
    });

    // 只有回合时也建 世界 键（不再是「无 gameTime 就没有世界」）
    expect(buildStatData({ characters: [], turn: 3 })['世界']).toEqual({ 回合: 3 });
  });

  it('世界.时间 用引擎既有规范串，不自造格式', () => {
    const stats = buildStatData({ characters: [], gameTime: TIME });
    expect(stats['世界']['时间']).toBe('复兴纪元0001年-05月-24日-周日-15:30');
  });

  it('玩家取首个 type==="player"，忽略 npc/monster/summon', () => {
    const npc = createDefaultCharacterState({ id: 'n1', type: 'npc', name: '路人', hp: 999 });
    const monster = createDefaultCharacterState({ id: 'm1', type: 'monster', hp: 888 });
    const stats = buildStatData({ characters: [npc, monster, makePlayer()] });
    expect(stats['主角']['生命值']).toBe(71);
  });

  it('fp 为 0 时仍然设键（0 不是缺失）', () => {
    const stats = buildStatData({ characters: [makePlayer()], fp: 0 });
    expect(stats['命运点数']).toBe(0);
  });
});

describe('buildStatData — 缺失输入', () => {
  it('无玩家角色时不设 主角 键，其余键照常', () => {
    const npc = createDefaultCharacterState({ id: 'n1', type: 'npc' });
    const stats = buildStatData({ characters: [npc], gameTime: TIME, fp: 3 });

    expect('主角' in stats).toBe(false);
    expect(stats['命运点数']).toBe(3);
    expect(stats['世界']['时间']).toBe(formatGameTime(TIME));
  });

  it('无 gameTime 时不设 世界 键（不留空壳对象，避免子树读误命中 stats 骨架）', () => {
    const stats = buildStatData({ characters: [makePlayer()], fp: 3 });
    expect('世界' in stats).toBe(false);
  });

  it('无 fp 时不设 命运点数 键', () => {
    const stats = buildStatData({ characters: [makePlayer()], gameTime: TIME });
    expect('命运点数' in stats).toBe(false);
  });

  it('角色列表为空且无 gameTime/fp 时返回空对象', () => {
    expect(buildStatData({ characters: [] })).toEqual({});
  });
});

describe('buildStatData — 深拷贝隔离', () => {
  it('返回值与入参零共享引用（顶层与嵌套对象都不是同一引用）', () => {
    const player = makePlayer();
    const stats = buildStatData({ characters: [player], gameTime: TIME, fp: 7 });

    expect(stats['主角']).not.toBe(player);
    expect(stats['主角']['属性']).not.toBe(player.attributes);
  });

  it('改返回值不污染入参 characters', () => {
    const player = makePlayer();
    const stats = buildStatData({ characters: [player], gameTime: TIME, fp: 7 });

    // EJS 就地写：改标量、改嵌套、加新键、删键
    stats['主角']['生命值'] = 1;
    stats['主角']['属性']['力量'] = 999;
    stats['主角']['属性']['新增键'] = '脏数据';
    stats['主角']['背包'] = [{ 名字: '不该存在' }];
    delete stats['主角']['等级'];
    stats['命运点数'] = -1;
    stats['世界']['时间'] = '篡改';

    expect(player.hp).toBe(71);
    expect(player.attributes.str).toBe(5);
    expect(player.attributes).not.toHaveProperty('新增键');
    expect(player).not.toHaveProperty('背包');
    expect(player.level).toBe(12);
  });

  it('两次调用互不影响（每 pass 独立克隆）', () => {
    const player = makePlayer();
    const first = buildStatData({ characters: [player], fp: 7 });
    first['主角']['生命值'] = 1;
    first['命运点数'] = -1;

    const second = buildStatData({ characters: [player], fp: 7 });
    expect(second['主角']['生命值']).toBe(71);
    expect(second['命运点数']).toBe(7);
  });

  it('不 freeze —— 语料存在读出后就地改的模式，冻结会误伤', () => {
    const stats = buildStatData({ characters: [makePlayer()] });
    expect(Object.isFrozen(stats)).toBe(false);
    expect(Object.isFrozen(stats['主角'])).toBe(false);
    expect(Object.isFrozen(stats['主角']['属性'])).toBe(false);
  });
});

describe('buildStatData — 范围栅栏（能力面 §3.1 T3 扩面口径）', () => {
  it('主角 只含约定的 17 个键；任务/关系/位置 仍不在 stats 内', () => {
    const player = makePlayer({
      inventory: [{ id: 'i1', name: '铁剑' } as never],
      skills: [{ id: 's1', name: '斩击' } as never],
      statusEffects: [{ id: 'e1', name: '中毒' } as never],
    });
    const stats = buildStatData({ characters: [player], gameTime: TIME, fp: 7 });

    expect(Object.keys(stats['主角']).sort()).toEqual(
      [
        '生命值',
        '生命值上限',
        '法力值',
        '法力值上限',
        '体力值',
        '体力值上限',
        '等级',
        '生命层级',
        '累计经验值',
        '升级所需经验',
        '属性',
        // —— T3 扩面（能力面 §3.1）——
        '金钱',
        '背包',
        '装备',
        '技能',
        '状态效果',
        '登神长阶',
      ].sort(),
    );
    // 仍然不投的：任务/关系走 quest / char 命名空间；位置在 世界.地点
    for (const forbidden of ['任务', '关系', '位置', '任务列表', '关系列表']) {
      expect(stats['主角']).not.toHaveProperty(forbidden);
    }
  });

  it('顶层只有 主角 / 命运点数 / 世界 三个键', () => {
    const stats = buildStatData({ characters: [makePlayer()], gameTime: TIME, fp: 7 });
    expect(Object.keys(stats).sort()).toEqual(['世界', '主角', '命运点数'].sort());
  });
});
