/**
 * ScenePanel 新闻已读接线测试 (M6 Task 4, #36)
 *
 * 验证: 展开未读新闻 → 本地 reactive 标记 read=true → persistNewsRead(saveId, newsId) 持久化。
 * 跟随 QuestsPanel focusQuest 回写模式: 先改内存 reactive，再交给引擎的窄字段写入口落库。
 *
 * 🔴 2026-08-17 评审修改了这条接线的形状: 交出去的不再是整份 profile（那份写会与
 *    commitChatState 的整档 flush 互相覆盖），而是 `(saveId, newsId)` 两个标量 ——
 *    落库前的重读发生在引擎的锁段里（真实读-改-写的断言在 save-profile.ui-writes.test.ts）。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount as vtuMount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import ScenePanel from './ScenePanel.vue';

// ---- Mocks ----

const mockPersistNewsRead = vi.fn(async (_saveId: string, _newsId: string) => undefined);
vi.mock('@engine/save-profile', () => ({
  persistNewsRead: (...args: any[]) => (mockPersistNewsRead as any)(...args),
}));

let mockProfile: any;
let mockStore: any;

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockStore,
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));

/**
 * 🔴 **必须给 Pinia**，哪怕本文件的 game-store / settings-store 都是 mock 的。
 *
 * 在场角色位用的 `AssetMedia` 会调 `useAssetStore()`（真 store，本文件没 mock 它）。
 * 本文件的 fixture 恰好 `characters: []`，所以那条路径今天走不到 —— 但那是巧合，
 * 不是保障: 谁往 fixture 里加一个在场角色，就会撞上「no active Pinia」而摸不着头脑。
 * 这里一次性把陷阱填掉。
 */
function mount(component: typeof ScenePanel) {
  const pinia = createPinia();
  setActivePinia(pinia);
  return vtuMount(component, { global: { plugins: [pinia] } });
}

function makeNews(id: string, read: boolean) {
  return {
    id,
    title: `新闻${id}`,
    content: `内容${id}`,
    category: 'world',
    publishedAt: 100,
    read,
  };
}

/**
 * 世界消息自 UI 改版起挂在「世界」页签下（页签序：角色 / 任务 / 世界 / 万象），
 * 默认页签是「角色」，所以取 .news-item 之前必须先切过去。
 */
async function openWorldTab(wrapper: ReturnType<typeof mount>) {
  const tabs = wrapper.findAll('.tab-item');
  expect(tabs).toHaveLength(4);
  await tabs[2].trigger('click');
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProfile = reactive({
    saveId: 'save_1',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [makeNews('n1', false), makeNews('n2', true)],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: null,
    variables: {},
    worldFlags: {},
    updatedAt: 0,
  });
  mockStore = {
    activeSaveId: 'save_1',
    gameTime: null,
    player: null,
    characters: [],
    saveProfile: mockProfile,
    get news() {
      return mockProfile.news;
    },
    getThoughts: vi.fn(() => ''),
    showModal: vi.fn(),
  };
});

describe('ScenePanel — 新闻展开标记已读 (M6 #36)', () => {
  it('展开未读新闻 → 本地 read=true + persistNewsRead(saveId, id) 持久化', async () => {
    const wrapper = await openWorldTab(mount(ScenePanel));
    const items = wrapper.findAll('.news-item');
    expect(items).toHaveLength(2);

    await items[0].trigger('click');
    await flushPromises();

    // reactive 即时标记（未读红点消失、其他面板即时可见）
    expect(mockProfile.news[0].read).toBe(true);
    // 持久化路径: 只交出两个标量，整份 profile 一律不出界（评审修 2026-08-17）
    expect(mockPersistNewsRead).toHaveBeenCalledTimes(1);
    expect(mockPersistNewsRead.mock.calls[0]).toEqual(['save_1', 'n1']);
  });

  it('展开已读新闻不调用 persistNewsRead（只标未读项）', async () => {
    const wrapper = await openWorldTab(mount(ScenePanel));

    await wrapper.findAll('.news-item')[1].trigger('click'); // n2 已读
    await flushPromises();

    expect(mockPersistNewsRead).not.toHaveBeenCalled();
    expect(mockProfile.news[1].read).toBe(true);
  });

  it('收起不触发标记；再次展开已标记项也不重复调用', async () => {
    const wrapper = await openWorldTab(mount(ScenePanel));
    const first = () => wrapper.findAll('.news-item')[0];

    await first().trigger('click'); // 展开 → 标记
    await flushPromises();
    await first().trigger('click'); // 收起
    await flushPromises();
    await first().trigger('click'); // 再展开（此时已读）
    await flushPromises();

    expect(mockPersistNewsRead).toHaveBeenCalledTimes(1);
  });

  it('未读红点随标记消失', async () => {
    const wrapper = await openWorldTab(mount(ScenePanel));
    expect(wrapper.findAll('.news-dot')).toHaveLength(1);

    await wrapper.findAll('.news-item')[0].trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.news-dot')).toHaveLength(0);
  });
});
