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
import { formatGameTime, type GameTime } from './time-system';
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
      },
      命运点数: 7,
      世界: { 时间: formatGameTime(TIME) },
    });
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

describe('buildStatData — 范围栅栏（D4 钉死，§5 挂起项不得投影）', () => {
  it('主角 只含约定的 11 个键，不含背包/技能/装备/状态效果/任务/关系', () => {
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
      ].sort(),
    );
    for (const forbidden of ['背包', '技能', '装备', '状态效果', '任务', '关系', '金钱', '位置']) {
      expect(stats['主角']).not.toHaveProperty(forbidden);
    }
  });

  it('顶层只有 主角 / 命运点数 / 世界 三个键', () => {
    const stats = buildStatData({ characters: [makePlayer()], gameTime: TIME, fp: 7 });
    expect(Object.keys(stats).sort()).toEqual(['世界', '主角', '命运点数'].sort());
  });
});
