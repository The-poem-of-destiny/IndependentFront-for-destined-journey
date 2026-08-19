/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import CommunityExtensionSettings from './CommunityExtensionSettings.vue';

const h = vi.hoisted(() => ({
  game: {
    activeSaveId: null as string | null,
    saves: [] as any[],
    loadSaves: vi.fn(async () => {}),
    setSaveEnabledWorldBookEntries: vi.fn(async () => true),
  },
  workshop: {
    projects: [] as any[],
    init: vi.fn(async () => {}),
  },
  worldbooks: {
    books: [] as any[],
    init: vi.fn(async () => {}),
  },
}));

vi.mock('../../stores/game-store', () => ({ useGameStore: () => h.game }));
vi.mock('../../stores/workshop-store', () => ({ useWorkshopStore: () => h.workshop }));
vi.mock('../../stores/worldbook-store', () => ({ useWorldBookStore: () => h.worldbooks }));

beforeEach(() => {
  vi.clearAllMocks();
  h.game.activeSaveId = null;
  h.game.saves = [
    {
      id: 'save-1',
      name: '旅途一',
      slot: 0,
      updatedAt: 200,
      metadata: { characterName: '维拉', enabledWorldBookEntries: ['system_core:1'] },
    },
  ];
  h.workshop.projects = [
    {
      id: 'p1',
      name: '社区扩展一',
      description: '测试扩展',
      authorName: '作者',
      installedVersion: '1.0.0',
      tags: ['扩展'],
    },
  ];
  h.worldbooks.books = [
    {
      id: 'workshop:p1',
      partition: 'creative_workshop',
      entries: [{ uid: 10 }, { uid: 11 }],
    },
  ];
});

describe('CommunityExtensionSettings', () => {
  it('默认选择最近存档并显示已安装社区扩展', async () => {
    const wrapper = mount(CommunityExtensionSettings);
    await flushPromises();

    expect(wrapper.get('select').element.value).toBe('save-1');
    expect(wrapper.text()).toContain('社区扩展一');
    expect(wrapper.text()).toContain('启用状态按存档分别保存');
  });

  it('勾选项目时只改指定存档，并保留非工坊 token', async () => {
    const wrapper = mount(CommunityExtensionSettings);
    await flushPromises();

    await wrapper.get('input[type="checkbox"]').setValue(true);
    await flushPromises();

    expect(h.game.setSaveEnabledWorldBookEntries).toHaveBeenCalledWith('save-1', [
      'system_core:1',
      'creative_workshop:10',
      'creative_workshop:11',
    ]);
  });

  it('没有存档时显示空态而不是不可解释的禁用列表', async () => {
    h.game.saves = [];
    const wrapper = mount(CommunityExtensionSettings);
    await flushPromises();
    expect(wrapper.text()).toContain('尚无可配置的存档');
    expect(wrapper.find('select').exists()).toBe(false);
  });
});
