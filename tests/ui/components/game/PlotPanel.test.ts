/**
 * PlotPanel.test.ts — 列表视图的章节防剧透（PLT-01）
 * @vitest-environment jsdom
 *
 * 剧透模式关闭时，未到达章节的标题与摘要不得出现在渲染结果里；当前章与总纲摘要
 * （类型契约里的可见层）照常显示；剧透模式下逐条点开才揭示。时间线章节条同样不泄露。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import PlotPanel from '../../../../src/ui/components/game/PlotPanel.vue';
import PlotTimeline from '../../../../src/ui/components/game/PlotTimeline.vue';
import { useGameStore } from '../../../../src/ui/stores/game-store';
import type { PlotEvent, PlotOutline, SaveProfile } from '@engine/types/types';
import { createDefaultTime } from '@engine/time/time-system';

function ev(over: Partial<PlotEvent> & { id: string; title: string }): PlotEvent {
  return {
    saveId: 'save-p',
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

function outline(): PlotOutline {
  return {
    id: 'o1',
    saveId: 'save-p',
    mode: 'main',
    title: '命定之诗',
    summary: '总纲摘要：王冠终将易主',
    content: '',
    chapters: [
      { title: '王都惊变', summary: '当前章摘要', status: 'active' },
      { title: '血色纹章', summary: '未来章摘要：纹章的主人现身', status: 'pending' },
    ],
    confirmed: true,
    version: 1,
    timeRange: { start: '488-01', end: '489-01' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function seed(): void {
  const game = useGameStore();
  game.saveProfile = {
    saveId: 'save-p',
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
    worldFlags: {},
    updatedAt: 0,
  } as SaveProfile;
  game.activeSaveId = 'save-p';
  game.saves = [{ id: 'save-p', name: '测试', slot: 0, metadata: {} }] as never;
  game.plotOutline = outline();
  game.activePlotEvents = [
    ev({ id: 'ch-1', title: '王都惊变', chapterTitle: '王都惊变', depth: 0, status: 'active' }),
    ev({
      id: 'ch-2',
      title: '血色纹章',
      chapterTitle: '血色纹章',
      depth: 0,
      order: 1,
      visibility: 'hidden',
    }),
    ev({ id: 'e1', title: '名录上的名字', chapterTitle: '王都惊变', parentId: 'ch-1' }),
    ev({
      id: 'e2',
      title: '纹章现世',
      chapterTitle: '血色纹章',
      parentId: 'ch-2',
      visibility: 'hidden',
    }),
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  seed();
});

afterEach(() => {
  document.body.innerHTML = '';
});

async function mountList() {
  const wrapper = mount(PlotPanel);
  await wrapper.findAll('.vs-btn')[1].trigger('click');
  return wrapper;
}

describe('PlotPanel 列表视图 —— 章节防剧透', () => {
  it('🔴 剧透模式关闭：未到达章节的标题与摘要不出现，总纲摘要照常显示', async () => {
    const wrapper = await mountList();
    const html = wrapper.html();
    expect(html).not.toContain('血色纹章');
    expect(html).not.toContain('未来章摘要');
    expect(html).toContain('第 2 章 · ？？？');
    // 总纲摘要按类型契约是防剧透层下的可见部分，不打码
    expect(wrapper.get('.oh-summary').text()).toBe('总纲摘要：王冠终将易主');
    // 当前章照常可见
    expect(html).toContain('王都惊变');
    expect(html).toContain('当前章摘要');
    wrapper.unmount();
  });

  it('剧透模式关闭时点击蒙版章节不揭示', async () => {
    const wrapper = await mountList();
    const headers = wrapper.findAll('.chap-header');
    await headers[1].trigger('click');
    await wrapper.find('.chap-masked').trigger('click');
    expect(wrapper.html()).not.toContain('血色纹章');
    wrapper.unmount();
  });

  it('剧透模式下逐条点开章节才揭示；关闭后重新蒙回，总纲摘要始终在', async () => {
    const wrapper = await mountList();
    await wrapper.find('.spoiler-toggle').trigger('click');
    await wrapper.findAll('.chap-header')[1].trigger('click');
    await wrapper.find('.chap-masked').trigger('click');
    expect(wrapper.html()).toContain('血色纹章');
    expect(wrapper.html()).toContain('未来章摘要');

    // 关闭剧透模式 → 重新蒙回
    await wrapper.find('.spoiler-toggle').trigger('click');
    expect(wrapper.html()).not.toContain('血色纹章');
    expect(wrapper.html()).toContain('总纲摘要：王冠终将易主');
    wrapper.unmount();
  });
});

describe('PlotTimeline —— 章节条防剧透', () => {
  it('🔴 剧透模式关闭：未到达章节名不进章节条（含 title 属性）', () => {
    const wrapper = mount(PlotTimeline);
    const html = wrapper.html();
    expect(html).not.toContain('血色纹章');
    expect(html).toContain('第 2 章 · ？？？');
    expect(html).toContain('王都惊变');
    wrapper.unmount();
  });

  it('剧透模式下点开章节条才揭示', async () => {
    const wrapper = mount(PlotTimeline);
    await wrapper.find('.spoiler-toggle').trigger('click');
    await wrapper.find('.tl-chapter.masked').trigger('click');
    expect(wrapper.html()).toContain('血色纹章');
    wrapper.unmount();
  });
});
