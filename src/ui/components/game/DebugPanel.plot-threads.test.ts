/**
 * DebugPanel.vue — 主线细化区块（jsdom）
 * @vitest-environment jsdom
 *
 * 钉的是「调试面板不得复制判据 / 不得推进随机状态」：
 * - 区块存在且数字来自生产 getter + 生产函数（gates 显示 allowed/未放行 与原因中文）
 * - 非主线模式 → 「模式: off … 闸门恒关」
 * - 查看面板无副作用（纯函数求值，不写库）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DebugPanel from './DebugPanel.vue';
import { useGameStore } from '../../stores/game-store';
import {
  applyPlotThreadRevealed,
  applyThreadDeclarations,
  type PlotThreadFlags,
} from '@engine/plot-threads';
import type { SaveProfile } from '@engine/types';
import { createDefaultTime } from '@engine/time-system';

function makeFlags(): PlotThreadFlags {
  let flags = { nodes: {} } as PlotThreadFlags;
  flags = applyThreadDeclarations(
    flags,
    [
      { name: 'A', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'active' },
      { name: 'B', gist: 'g', thread: 't', motive: 'm', involvedNpcs: [], status: 'dormant' },
    ],
    100,
  ).flags;
  flags = applyPlotThreadRevealed(flags, ['A']).flags;
  flags = { ...flags, lastAdvancedTurn: 3, lastCommittedTurn: 3 };
  return flags;
}

function buildProfile(flags?: PlotThreadFlags): SaveProfile {
  return {
    saveId: 'save-thread',
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: createDefaultTime(),
    variables: {},
    worldFlags: flags === undefined ? {} : { plotThreads: flags },
    updatedAt: 0,
  };
}

function seedGame(
  game: ReturnType<typeof useGameStore>,
  flags?: PlotThreadFlags,
  mode: 'off' | 'side' | 'main' = 'main',
): void {
  game.saveProfile = buildProfile(flags);
  game.activePlotEvents = [] as never;
  game.activeSaveId = 'save-thread';
  game.saves = [
    {
      id: 'save-thread',
      name: '测试存档',
      slot: 0,
      metadata: { plotSettings: { mode }, totalTurns: 1 },
    },
  ] as never;
  game.plotOutline = null as never;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('DebugPanel —— 主线细化区块', () => {
  it('区块存在：节点计数 / 未揭示数 / 收口回合 / 闸门结果（生产函数直接输出）', () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(DebugPanel);
    const html = wrapper.html();
    expect(html).toContain('主线细化');
    expect(html).toContain('节点: 2');
    expect(html).toContain('未揭示 1'); // B 未揭示
    expect(html).toContain('上次推进回合: 3');
    expect(html).toContain('上次收口回合: 3');
    // 闸门（turnNo=2，无 cooldown；主线下无锚无窗口 → 按生产判据先报 no_anchor）
    expect(html).toContain('未放行');
    expect(html).toContain('无有效主线锚');
    wrapper.unmount();
  });

  it('非主线模式：标注且明确闸门恒关（mode_off）', () => {
    const game = useGameStore();
    seedGame(game, makeFlags(), 'off');
    const wrapper = mount(DebugPanel);
    expect(wrapper.html()).toContain('模式: off');
    expect(wrapper.html()).toContain('非主线模式');
    wrapper.unmount();
  });

  it('查看面板不推进随机状态：连续两次求值结果一致（纯函数无副作用）', () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const w1 = mount(DebugPanel);
    const first = w1.text();
    w1.unmount();
    const w2 = mount(DebugPanel);
    const text2 = w2.text();
    const firstGate = first.split('下一轮闸门')[1] ?? '';
    const secondGate = text2.split('下一轮闸门')[1] ?? '';
    expect(firstGate.trim()).toBe(secondGate.trim());
    w2.unmount();
  });
});
