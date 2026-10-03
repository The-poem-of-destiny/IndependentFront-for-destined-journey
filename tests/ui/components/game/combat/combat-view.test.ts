/**
 * combat-view.test.ts — C6 战斗展示层纯函数（数据源 CombatState → 视图投影 + AI 输出解析）。
 */
import { describe, expect, it } from 'vitest';
import type { CombatState, CombatUnit } from '@engine/combat/sandbox/types';
import {
  axisTicks,
  currentActor,
  isAwaitingPlayer,
  orderedUnits,
  parseCombatNarrative,
  parsePanelRow,
  posToPercent,
  statusViewsOf,
} from '../../../../../src/ui/components/game/combat/combat-view';

function unit(
  name: string,
  side: 'ally' | 'enemy',
  overrides: Partial<CombatUnit> = {},
): CombatUnit {
  return {
    name,
    tier: 1,
    level: 1,
    race: '人类',
    attributes: { str: 1, dex: 2, con: 3, int: 4, spi: 5 },
    hp: 10,
    maxHp: 10,
    mp: 5,
    maxMp: 5,
    sp: 5,
    maxSp: 5,
    statusEffects: [],
    origin: 'save',
    side,
    pos: 1,
    facing: side === 'ally' ? 'right' : 'left',
    slots: { attack: 1, action: 0 },
    alive: true,
    canAct: true,
    morale: 'steady',
    ...overrides,
  };
}

function makeState(units: CombatUnit[], meta: Partial<CombatState['meta']> = {}): CombatState {
  const map: Record<string, CombatUnit> = {};
  for (const u of units) map[u.name] = u;
  return {
    meta: {
      round: 1,
      combatType: '标准',
      environment: '',
      coordinateRange: 8,
      actionOrder: Object.keys(map),
      phase: 'active',
      regions: [],
      ...meta,
    },
    units: map,
  };
}

describe('orderedUnits — 行动轴优先 + 轴外按名补齐', () => {
  it('严格跟随 actionOrder，轴外单位名字稳定补齐', () => {
    const state = makeState([unit('甲', 'ally'), unit('乙', 'ally'), unit('丙', 'ally')], {
      actionOrder: ['丙', '甲'],
    });
    expect(orderedUnits(state, 'ally').map((u) => u.name)).toEqual(['丙', '甲', '乙']);
  });

  it('按 side 过滤；null → 空数组', () => {
    const state = makeState([unit('甲', 'ally'), unit('乙', 'enemy')]);
    expect(orderedUnits(state, 'ally').map((u) => u.name)).toEqual(['甲']);
    expect(orderedUnits(state, 'enemy').map((u) => u.name)).toEqual(['乙']);
    expect(orderedUnits(null, 'ally')).toEqual([]);
  });
});

describe('currentActor / isAwaitingPlayer', () => {
  it('优先 pendingPlayerUnit（存活）；否则第一个存活我方', () => {
    const state = makeState([unit('甲', 'ally'), unit('乙', 'ally')], { pendingPlayerUnit: '乙' });
    expect(currentActor(state)?.name).toBe('乙');
    expect(isAwaitingPlayer(state)).toBe(true);

    const noPending = makeState([unit('甲', 'ally')]);
    expect(currentActor(noPending)?.name).toBe('甲');
    expect(isAwaitingPlayer(noPending)).toBe(false);
  });

  it('pending 指向已倒下单位 → 不算等待，退回存活我方', () => {
    const state = makeState([unit('甲', 'ally'), unit('乙', 'ally', { alive: false })], {
      pendingPlayerUnit: '乙',
    });
    expect(isAwaitingPlayer(state)).toBe(false);
    expect(currentActor(state)?.name).toBe('甲');
  });
});

describe('statusViewsOf / axisTicks / posToPercent', () => {
  it('状态类别 → chip 类型 + 回合剩余', () => {
    const u = unit('甲', 'ally', {
      statusEffects: [
        { name: '祝福', category: '增益' },
        { name: '中毒', category: '减益', remainingTime: 3, timeUnit: '回合' },
        { name: '标记', category: '特殊', remainingTime: 5, timeUnit: '分钟' },
      ],
    });
    const views = statusViewsOf(u);
    expect(views[0]).toMatchObject({ type: 'buff', name: '祝福', remainRounds: null });
    expect(views[1]).toMatchObject({ type: 'debuff', name: '中毒', remainRounds: 3 });
    expect(views[2]).toMatchObject({ type: 'special', name: '标记', remainRounds: null });
  });

  it('axisTicks 含端点；非法范围退化单格', () => {
    expect(axisTicks(4)).toEqual([0, 1, 2, 3, 4]);
    expect(axisTicks(0)).toEqual([0]);
    expect(axisTicks(Number.NaN)).toEqual([0]);
  });

  it('posToPercent 夹逼到 [0,100]', () => {
    expect(posToPercent(4, 8)).toBe(50);
    expect(posToPercent(99, 8)).toBe(100);
    expect(posToPercent(-1, 8)).toBe(0);
  });
});

describe('parseCombatNarrative — AI 输出 → 叙事 / 面板块', () => {
  it('{标题} + | 行 | → 面板；纯文本 → 叙事', () => {
    const blocks = parseCombatNarrative(
      ['雨点砸在石栏上。', '{战况总览}', '| 理查德 | HP 78/100 |', '| 骷髅兵 | HP 40/40 |'].join(
        '\n',
      ),
    );
    expect(blocks[0]).toEqual({ kind: 'narrative', text: '雨点砸在石栏上。' });
    expect(blocks[1]).toEqual({
      kind: 'panel',
      title: '战况总览',
      rows: [
        { label: '理查德', value: 'HP 78/100' },
        { label: '骷髅兵', value: 'HP 40/40' },
      ],
    });
  });

  it('<action_info> 包裹 → 无标题面板；单格冒号行拆标签', () => {
    const blocks = parseCombatNarrative('<action_info>\n| 检定: 17\n| 伤害: 620\n</action_info>');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'panel' });
    const panel = blocks[0] as Extract<(typeof blocks)[number], { kind: 'panel' }>;
    expect(panel.rows).toEqual([
      { label: '检定', value: '17' },
      { label: '伤害', value: '620' },
    ]);
  });

  it('空文本 / 坏格式永不抛', () => {
    expect(parseCombatNarrative('')).toEqual([]);
    expect(parseCombatNarrative('{')).toEqual([{ kind: 'narrative', text: '{' }]);
  });
});

describe('parsePanelRow', () => {
  it('两格 → 标签/值；单格冒号 → 拆分；单格无冒号 → 只值', () => {
    expect(parsePanelRow('| 攻方 → 守方 | 理查德 → 骷髅兵 |')).toEqual([
      { label: '攻方 → 守方', value: '理查德 → 骷髅兵' },
    ]);
    expect(parsePanelRow('| 伤害: 620 |')).toEqual([{ label: '伤害', value: '620' }]);
    expect(parsePanelRow('| 状态: [胜利] |')).toEqual([{ label: '状态', value: '[胜利]' }]);
  });
});
