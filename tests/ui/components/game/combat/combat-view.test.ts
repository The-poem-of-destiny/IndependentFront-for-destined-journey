/**
 * combat-view.test.ts — C6 战斗展示层纯函数（数据源 CombatState → 视图投影）。
 * AI 输出的面板解析已迁到 lib/action-panel.ts，用例见 tests/ui/lib/action-panel.test.ts。
 */
import { describe, expect, it } from 'vitest';
import type { CombatState, CombatUnit } from '@engine/combat/sandbox/types';
import {
  axisTicks,
  currentActor,
  isAwaitingPlayer,
  orderedUnits,
  parseCombatBeat,
  posToPercent,
  splitBeatNames,
  statusViewsOf,
} from '../../../../../src/ui/components/game/combat/combat-view';
import { parseActionPanel } from '../../../../../src/ui/lib/action-panel';

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

  it('有 durationText 时不算剩余回合，交出原文（状态树协议 §5.7）', () => {
    const u = unit('甲', 'ally', {
      statusEffects: [
        { name: '诅咒', category: '减益', remainingTime: null, durationText: '直到离开城镇' },
        // 防御：即便误带了回合数，文本仍优先
        {
          name: '迷雾',
          category: '特殊',
          remainingTime: 2,
          timeUnit: '回合',
          durationText: '雾散为止',
        },
        { name: '中毒', category: '减益', remainingTime: 3, timeUnit: '回合' },
      ],
    });
    const views = statusViewsOf(u);
    expect(views[0]).toMatchObject({ remainRounds: null, durationText: '直到离开城镇' });
    expect(views[1]).toMatchObject({ remainRounds: null, durationText: '雾散为止' });
    expect(views[2]).toMatchObject({ remainRounds: 3, durationText: null });
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

describe('parseCombatBeat（直出战斗逐拍 → 行为卡）', () => {
  // 认行走 master 的 action-panel 解析（与 BeautifiedNarrative 同一条路）
  const rowsOf = (raw: string) =>
    parseActionPanel(raw).sections.flatMap((section) => section.rows.flatMap((row) => row.cells));

  it('固定三行 + 判定/伤害/消耗/状态归位', () => {
    const beat = parseCombatBeat(
      rowsOf(
        '<action_info>\n|行动者|艾琳|\n|目标|灰狼|\n|行动|裂风斩|\n|判定|14 ≥ 12 命中|\n|伤害|36|\n|消耗|SP 12|\n|状态|灰狼 HP 40/76，流血+1|\n</action_info>',
      ),
    );
    expect(beat).toEqual({
      actor: '艾琳',
      target: '灰狼',
      targets: ['灰狼'],
      action: '裂风斩',
      roll: '14 ≥ 12 命中',
      damage: '36',
      heal: null,
      cost: 'SP 12',
      status: ['灰狼 HP 40/76，流血+1'],
      rest: [],
    });
  });

  it('缺「行动者」行或值为空 → null（调用方退回通用面板）', () => {
    expect(parseCombatBeat(rowsOf('<action_info>| 掷骰 | 12 |</action_info>'))).toBeNull();
    expect(parseCombatBeat([{ label: '行动者', value: '' }])).toBeNull();
    expect(parseCombatBeat([])).toBeNull();
  });

  it('目标写「无」→ null；多目标按顿号拆名', () => {
    expect(
      parseCombatBeat([
        { label: '行动者', value: '甲' },
        { label: '目标', value: '无' },
      ])?.target,
    ).toBeNull();
    const multi = parseCombatBeat([
      { label: '行动者', value: '甲' },
      { label: '目标', value: '乙、丙' },
    ]);
    expect(multi?.target).toBe('乙、丙');
    expect(multi?.targets).toEqual(['乙', '丙']);
    expect(splitBeatNames('A, B／C')).toEqual(['A', 'B', 'C']);
  });

  it('同义标签、冒号形态、恢复行、多条状态与未知行', () => {
    const beat = parseCombatBeat([
      { label: '', value: '行动者：牧师' },
      { label: '行动:', value: '圣愈' },
      { label: '检定', value: '自动成功' },
      { label: '治疗', value: '24' },
      { label: '状态', value: '甲 HP 50/60' },
      { label: '状态', value: '乙 祝福+1' },
      { label: '行动者', value: '冒名者' },
      { label: '备注', value: '光芒' },
    ]);
    expect(beat?.actor).toBe('牧师');
    expect(beat?.action).toBe('圣愈');
    expect(beat?.roll).toBe('自动成功');
    expect(beat?.heal).toBe('24');
    expect(beat?.damage).toBeNull();
    expect(beat?.status).toEqual(['甲 HP 50/60', '乙 祝福+1']);
    expect(beat?.rest).toEqual([
      { label: '行动者', value: '冒名者' },
      { label: '备注', value: '光芒' },
    ]);
  });
});
