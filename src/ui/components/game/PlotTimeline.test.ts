/**
 * PlotTimeline.test.ts — 剧情时间线的 DOM 契约（jsdom）
 * @vitest-environment jsdom
 *
 * 钉的是：大纲关键事件与事件线节点同轴渲染、章节跨度条、缩放/定位控件、
 * 蒙版节点零泄漏、遮蔽边不渲染、剧透 peek、空态、时间线/列表切换。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import PlotTimeline from './PlotTimeline.vue';
import PlotPanel from './PlotPanel.vue';
import { useGameStore } from '../../stores/game-store';
import {
  applyPlotThreadRevealed,
  applyThreadDeclarations,
  type PlotThreadFlags,
} from '@engine/plot-threads';
import type { PlotEvent, SaveProfile } from '@engine/types';
import { createDefaultTime, toEpochMinutes } from '@engine/time-system';

/** depth=1 关键事件（落轴节点） */
function ev(over: Partial<PlotEvent> & { id: string; title: string }): PlotEvent {
  return {
    saveId: 'save-tl',
    description: '',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    visibility: 'revealed',
    depth: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** depth=0 章节容器（章节条） */
function chapter(title: string): PlotEvent {
  return ev({ id: 'ch-' + title, title, chapterTitle: title, depth: 0 });
}

function makeFlags(): PlotThreadFlags {
  const flags = applyThreadDeclarations(
    { nodes: {} },
    [
      {
        name: '雾蕈商情',
        gist: '商贩秘密收购雾蕈',
        thread: '北境暗流',
        motive: '幕后指使',
        involvedNpcs: ['商贩'],
        status: 'active',
        foreshadows: ['外乡人'],
      },
      {
        name: '外乡人',
        gist: '身份不明的旅人',
        thread: '北境暗流',
        motive: '秘密监视',
        involvedNpcs: [],
        status: 'dormant',
      },
    ],
    toEpochMinutes({ era: '', year: 488, month: 2, day: 1, weekday: 1, hour: 0, minute: 0 }),
  ).flags;
  return applyPlotThreadRevealed(flags, ['雾蕈商情']).flags;
}

function buildProfile(flags?: PlotThreadFlags): SaveProfile {
  return {
    saveId: 'save-tl',
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
  opts: { flags?: PlotThreadFlags; events?: PlotEvent[] } = {},
): void {
  game.saveProfile = buildProfile(opts.flags);
  game.activeSaveId = 'save-tl';
  game.saves = [{ id: 'save-tl', name: '测试', slot: 0, metadata: {} }] as never;
  game.plotOutline = null;
  game.activePlotEvents = opts.events ?? [];
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PlotTimeline —— 同轴渲染 + 章节条', () => {
  it('大纲关键事件与事件线节点都渲染；章节名进章节条；时间标尺出现', () => {
    const game = useGameStore();
    seedGame(game, {
      flags: makeFlags(),
      events: [
        chapter('王都惊变'),
        ev({
          id: 'e1',
          title: '名录上第一个消失的名字',
          chapterTitle: '王都惊变',
          parentId: 'ch-王都惊变',
          timeWindow: { start: '488-01', end: '488-02' },
        }),
      ],
    });
    const wrapper = mount(PlotTimeline);
    const html = wrapper.html();
    expect(html).toContain('名录上第一个消失的名字');
    expect(html).toContain('雾蕈商情');
    // 章节名在章节跨度条上
    expect(wrapper.find('.tl-chapter').text()).toContain('王都惊变');
    // 时间标尺刻度（含年份）
    expect(html).toContain('488');
    expect(wrapper.findAll('.tl-node').length).toBeGreaterThanOrEqual(3);
    // 缩放标尺 + 定位到现在 控件存在
    expect(wrapper.find('.tl-range').exists()).toBe(true);
    expect(wrapper.findAll('.tl-zbtn')).toHaveLength(2);
    expect(wrapper.find('.tl-btn').text()).toContain('定位到现在');
    wrapper.unmount();
  });

  it('无 timeWindow 的关键事件落到「未定时间」竖条', () => {
    const game = useGameStore();
    seedGame(game, {
      events: [chapter('第一章'), ev({ id: 'e1', title: '未定时事件', chapterTitle: '第一章' })],
    });
    const wrapper = mount(PlotTimeline);
    const html = wrapper.html();
    expect(html).toContain('未定时间');
    wrapper.unmount();
  });
});

describe('PlotTimeline —— 防剧透', () => {
  it('🔴 隐藏事件线节点零泄漏；剧透模式下逐条 peek 才揭示', async () => {
    const game = useGameStore();
    seedGame(game, { flags: makeFlags() });
    const wrapper = mount(PlotTimeline);
    expect(wrapper.html()).toContain('雾蕈商情');
    expect(wrapper.html()).not.toContain('外乡人');
    expect(wrapper.html()).toContain('？？？');
    expect(wrapper.findAll('.tl-node.masked').length).toBe(1);

    await wrapper.find('.spoiler-toggle').trigger('click');
    await wrapper.findAll('.tl-node.masked')[0].trigger('click');
    expect(wrapper.html()).toContain('外乡人');
    wrapper.unmount();
  });

  it('🔴 指向隐藏节点的边整条不渲染', () => {
    const game = useGameStore();
    seedGame(game, { flags: makeFlags() });
    const wrapper = mount(PlotTimeline);
    expect(wrapper.findAll('.tl-edges path')).toHaveLength(0);
    wrapper.unmount();
  });

  it('章节条 → 关键事件渲染一条曲线', () => {
    const game = useGameStore();
    seedGame(game, {
      events: [
        chapter('第一章'),
        ev({
          id: 'e1',
          title: '关键事件',
          chapterTitle: '第一章',
          parentId: 'ch-第一章',
          timeWindow: { start: '488-01', end: '488-02' },
        }),
      ],
    });
    const wrapper = mount(PlotTimeline);
    expect(wrapper.findAll('.tl-edges path')).toHaveLength(1);
    wrapper.unmount();
  });

  it('空态：无任何节点时显示空态而非报错', () => {
    const game = useGameStore();
    seedGame(game);
    const wrapper = mount(PlotTimeline);
    expect(wrapper.html()).toContain('尚无剧情锚点');
    wrapper.unmount();
  });
});

describe('PlotPanel —— 时间线 / 列表 切换', () => {
  it('默认时间线；切到列表出现章节手风琴', async () => {
    const game = useGameStore();
    seedGame(game, {
      events: [
        chapter('王都惊变'),
        ev({
          id: 'e1',
          title: '名录上第一个消失的名字',
          chapterTitle: '王都惊变',
          timeWindow: { start: '488-01', end: '488-02' },
        }),
      ],
    });
    const wrapper = mount(PlotPanel);
    expect(wrapper.find('[data-testid="plot-timeline"]').exists()).toBe(true);
    const btns = wrapper.findAll('.vs-btn');
    expect(btns).toHaveLength(2);
    await btns[1].trigger('click'); // 列表
    expect(wrapper.find('[data-testid="plot-timeline"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
