/**
 * PlotThreadsPanel.test.ts — 事件线面板的防剧透 DOM 契约（jsdom）
 * @vitest-environment jsdom
 *
 * 钉的都是「蒙上了一层，其实字还在 DOM 里/ARIA 里/隐藏文本里漏了」那一类：
 * - 蒙版节点（未揭示 + 未 peek）：名字/简述/thread/时间/人物/动机 **一个字符都不进 DOM**
 * - 分组名蒙版：组内无可见节点时 group label 不外泄
 * - 边任一端隐藏 → 整条边不渲染
 * - 剧透模式只允许逐条 peek；关闭剧透 → 全部蒙回；切档 → 状态清零
 * - motive 只在「剧透模式 + details 展开」时显示
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import PlotThreadsPanel from './PlotThreadsPanel.vue';
import { useGameStore } from '../../stores/game-store';
import {
  applyPlotThreadRevealed,
  applyThreadDeclarations,
  type PlotThreadFlags,
} from '@engine/plot-threads';
import type { SaveProfile } from '@engine/types';
import { createDefaultTime } from '@engine/time-system';

vi.mock('./plot-thread-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plot-thread-view')>();
  return { ...actual };
});

function makeFlags(): PlotThreadFlags {
  let flags = { nodes: {} } as PlotThreadFlags;
  flags = applyThreadDeclarations(
    flags,
    [
      {
        name: '雾蕈商情',
        gist: '商贩秘密收购雾蕈',
        thread: '北境暗流',
        motive: '神秘幕后指使',
        involvedNpcs: ['商贩'],
        status: 'active',
        foreshadows: ['外乡人'],
      },
      {
        name: '外乡人',
        gist: '身份不明的旅人出没',
        thread: '北境暗流',
        motive: '秘密监视商情',
        involvedNpcs: [],
        status: 'dormant',
      },
    ],
    100,
  ).flags;
  flags = applyPlotThreadRevealed(flags, ['雾蕈商情']).flags;
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

function seedGame(game: ReturnType<typeof useGameStore>, flags?: PlotThreadFlags): void {
  game.saveProfile = buildProfile(flags);
  game.activeSaveId = 'save-thread';
  game.saves = [
    { id: 'save-thread', name: '测试存档', slot: 0, metadata: { totalTurns: 5 } },
  ] as never;
  game.plotOutline = null;
  game.activePlotEvents = [];
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PlotThreadsPanel —— 防剧透', () => {
  it('🔴 隐藏节点零泄漏：名字/gist/thread/时间/人物/动机不出现在 DOM（含 aria/title）', () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(PlotThreadsPanel);
    const html = wrapper.html();
    expect(html).toContain('雾蕈商情'); // 已揭示节点正常
    expect(html).not.toContain('外乡人');
    expect(html).not.toContain('身份不明的旅人出没');
    expect(html).not.toContain('秘密监视商情');
    // 分组名『北境暗流』：组内已有揭示节点 → 允许显示（与大纲标题同源，玩家已知情）
    expect(html).toContain('北境暗流');
    // 蒙版卡文字
    expect(html).toContain('？？？');
    wrapper.unmount();
  });

  it('🔴 组内全隐藏时分组名不外泄（整组蒙版）', () => {
    const game = useGameStore();
    const flags = applyThreadDeclarations(
      { nodes: {} },
      [
        {
          name: 'A',
          gist: 'g',
          thread: '机密锚组',
          motive: 'm',
          involvedNpcs: [],
          status: 'active',
        },
      ],
      100,
    ).flags;
    seedGame(game, flags);
    const wrapper = mount(PlotThreadsPanel);
    expect(wrapper.html()).not.toContain('机密锚组');
    expect(wrapper.html()).toContain('？？？');
    wrapper.unmount();
  });

  it('🔴 边遮蔽：指向隐藏节点的边整条不渲染（A→??? 也不出现）', () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(PlotThreadsPanel);
    const html = wrapper.html();
    expect(html).toContain('雾蕈商情');
    // 雾蕈商情埋向外乡人；外乡人隐藏 → 这条边不得渲染（边按钮一个都不许有）
    expect(wrapper.findAll('.thread-edge')).toHaveLength(0);
    expect(html).not.toContain('edge-arrow');
    wrapper.unmount();
  });

  it('剧透模式：只允许逐条 peek；关闭后全部蒙回（peek 清空）', async () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(PlotThreadsPanel);
    const toggle = wrapper.find('.spoiler-toggle');
    await toggle.trigger('click'); // 开
    expect(wrapper.find('[aria-pressed="true"]').exists()).toBe(true);
    // 仍未揭示的卡片是蒙版 + 可点击
    const maskedCard = wrapper.findAll('.thread-card.masked');
    expect(maskedCard).toHaveLength(1);
    await maskedCard[0].trigger('click'); // peek
    expect(wrapper.html()).toContain('外乡人');
    await toggle.trigger('click'); // 关 → 清 peek
    expect(wrapper.html()).not.toContain('外乡人');
    expect(wrapper.html()).toContain('？？？');
    wrapper.unmount();
  });

  it('🔴 motive 只在剧透模式下出现；非剧透 mode 下详情里也不给动机', () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(PlotThreadsPanel);
    expect(wrapper.html()).not.toContain('神秘幕后指使'); // 未开剧透，motive 不出现在任何 DOM
    const toggle = wrapper.find('.spoiler-toggle');
    return (async () => {
      await toggle.trigger('click');
      const afterOpen = wrapper.html();
      expect(afterOpen).toContain('神秘幕后指使');
      wrapper.unmount();
    })();
  });

  it('切档：临时 peek / 剧透模式清零', async () => {
    const game = useGameStore();
    seedGame(game, makeFlags());
    const wrapper = mount(PlotThreadsPanel);
    const toggle = wrapper.find('.spoiler-toggle');
    await toggle.trigger('click');
    await wrapper.findAll('.thread-card.masked')[0].trigger('click');
    expect(wrapper.html()).toContain('外乡人');
    // 切档
    game.activeSaveId = 'save-other';
    await wrapper.vm.$nextTick();
    expect(wrapper.html()).not.toContain('外乡人');
    expect(wrapper.find('[aria-pressed="true"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('零节点：正常空态，不显示成错误', () => {
    const game = useGameStore();
    seedGame(game);
    const wrapper = mount(PlotThreadsPanel);
    const html = wrapper.html();
    expect(html).toContain('尚未发现主线明线');
    expect(html).not.toContain('错误');
    wrapper.unmount();
  });
});
