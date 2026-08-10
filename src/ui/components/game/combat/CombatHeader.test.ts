/**
 * CombatHeader.test.ts — Command Table 行动轴投影。
 *
 * 行动轴只可视化 CombatView 已有的 initiativeOrder / units / 当前行动者，
 * 不创建新战斗状态或控制入口。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';

let mockGame: Record<string, unknown>;

vi.mock('../../../stores/game-store', () => ({ useGameStore: () => mockGame }));

import CombatHeader from './CombatHeader.vue';

beforeEach(() => {
  mockGame = reactive({
    v3ActiveCombat: {
      round: 2,
      initiativeOrder: ['莱恩', '灰刃', '紫岚'],
      units: {
        莱恩: { id: '莱恩', name: '莱恩', side: 'player' },
        灰刃: { id: '灰刃', name: '灰刃·科尔', side: 'enemy' },
        紫岚: { id: '紫岚', name: '紫岚', side: 'player' },
      },
    },
    combatCurrentUnitId: '灰刃',
    combatAwaitingInput: null,
  });
});

describe('CombatHeader — existing initiative projection', () => {
  it('renders the existing initiative order and marks the current unit without changing geometry', () => {
    const wrapper = mount(CombatHeader);
    const entries = wrapper.findAll('.initiative-entry');

    expect(entries.map((entry) => entry.find('.initiative-name').text())).toEqual([
      '莱恩',
      '灰刃·科尔',
      '紫岚',
    ]);
    expect(entries[1].classes()).toContain('is-active');
    expect(entries[1].classes()).toContain('is-enemy');
    expect(entries[1].attributes('aria-current')).toBe('step');
    expect(wrapper.find('.combat-round').text()).toBe('第 2 回合');
  });

  it('uses the existing awaiting-player unit when no turn event is active', () => {
    mockGame.combatCurrentUnitId = null;
    mockGame.combatAwaitingInput = { unitId: '紫岚' };

    const wrapper = mount(CombatHeader);
    const entries = wrapper.findAll('.initiative-entry');

    expect(entries[2].classes()).toContain('is-active');
    expect(entries[2].classes()).toContain('is-player');
    expect(wrapper.find('.combat-your-turn').text()).toBe('轮到你了');
  });
});
