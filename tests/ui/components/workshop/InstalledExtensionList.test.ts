/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import InstalledExtensionList from '../../../../src/ui/components/workshop/InstalledExtensionList.vue';
import { useWorkshopStore } from '../../../../src/ui/stores/workshop-store';

const h = vi.hoisted(() => ({
  workshop: {
    projects: [] as any[],
    uninstall: vi.fn(async (_id: string) => true),
  },
  worldbooks: {
    books: [] as any[],
    getBook(id: string) {
      return this.books.find((b: any) => b.id === id);
    },
  },
  beautifier: { userRules: [] as any[] },
  game: {
    saves: [] as any[],
    loadSaves: vi.fn(async () => {}),
  },
  ui: { toast: vi.fn() },
  confirmDialog: vi.fn(async (_opts: unknown) => true),
}));

vi.mock('../../../../src/ui/stores/workshop-store', async () => {
  const { reactive } = await import('vue');
  const store = reactive(h.workshop);
  return { useWorkshopStore: () => store };
});
vi.mock('../../../../src/ui/stores/worldbook-store', () => ({
  useWorldBookStore: () => h.worldbooks,
}));
vi.mock('../../../../src/ui/stores/beautifier-store', () => ({
  useBeautifierStore: () => h.beautifier,
}));
vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => h.game }));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => h.ui }));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({ confirmDialog: h.confirmDialog }));

const ENTRY_A = 'workshop.p1:creative_workshop/first';
const ENTRY_B = 'workshop.p1:creative_workshop/second';

function save(id: string, name: string, tokens: string[]) {
  return {
    id,
    name,
    slot: 0,
    updatedAt: 1,
    metadata: { characterName: '主角', enabledWorldBookEntries: tokens },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.workshop.uninstall.mockImplementation(async () => true);
  h.confirmDialog.mockImplementation(async () => true);
  (useWorkshopStore() as unknown as { projects: unknown[] }).projects = [
    {
      id: 'p1',
      name: '社区扩展一',
      authorName: '作者甲',
      installedVersion: '1.2.0',
      version: '1.2.0',
      installedAt: new Date(2026, 10, 1).getTime(),
      tags: [],
      droppedNotes: [],
    },
  ];
  h.worldbooks.books = [
    {
      id: 'workshop:p1',
      partition: 'creative_workshop',
      entries: [{ uid: ENTRY_A }, { uid: ENTRY_B }],
    },
  ];
  h.beautifier.userRules = [
    { id: 'workshop-rule:p1:r1' },
    { id: 'workshop-rule:p1:r2' },
    { id: 'workshop-rule:p1:r3' },
    { id: 'workshop-rule:other:r1' },
  ];
  h.game.saves = [
    save('s1', '旅途一', [ENTRY_A, ENTRY_B]),
    save('s2', '旅途二', ['fated:system_core/core']),
    save('s3', '', [ENTRY_A, ENTRY_B]),
  ];
});

describe('InstalledExtensionList', () => {
  it('显示名称、已装版本、世界书条目与美化规则数量，不提供联网动作', () => {
    const wrapper = mount(InstalledExtensionList);
    const text = wrapper.text();

    expect(text).toContain('已安装的社区扩展');
    expect(text).toContain('社区扩展一');
    expect(text).toContain('已装 v1.2.0');
    expect(text).toContain('2 条世界书条目');
    expect(text).toContain('3 条美化规则');
    expect(text).not.toContain('查更新');
    expect(text).not.toMatch(/(^|[^卸])更新/);
  });

  it('卸载前以危险确认点名项目，并列出勾选启用了它的存档', async () => {
    const wrapper = mount(InstalledExtensionList);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(h.game.loadSaves).toHaveBeenCalled();
    expect(h.confirmDialog).toHaveBeenCalledOnce();
    const opts = h.confirmDialog.mock.calls[0][0] as {
      title: string;
      message: string;
      details?: string[];
      danger?: boolean;
    };
    expect(opts.title).toContain('社区扩展一');
    expect(opts.danger).toBe(true);
    expect(opts.message).toContain('2 个存档');
    // 无存档名时退回角色名
    expect(opts.details).toEqual(['旅途一', '主角']);
  });

  it('确认后调用 store 卸载并提示成功', async () => {
    const wrapper = mount(InstalledExtensionList);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(h.workshop.uninstall).toHaveBeenCalledWith('p1');
    expect(h.ui.toast).toHaveBeenCalledWith('已卸载「社区扩展一」', 'success');
  });

  it('没有存档启用时也说明清楚，不带空清单', async () => {
    h.game.saves = [save('s2', '旅途二', [])];
    const wrapper = mount(InstalledExtensionList);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    const opts = h.confirmDialog.mock.calls[0][0] as { message: string; details?: string[] };
    expect(opts.message).toContain('目前没有存档勾选启用它');
    expect(opts.details).toBeUndefined();
  });

  it('取消确认时不卸载', async () => {
    h.confirmDialog.mockImplementation(async () => false);
    const wrapper = mount(InstalledExtensionList);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(h.workshop.uninstall).not.toHaveBeenCalled();
    expect(h.ui.toast).not.toHaveBeenCalled();
  });

  it('卸载失败或抛错时提示错误', async () => {
    h.workshop.uninstall.mockImplementation(async () => {
      throw new Error('写库失败');
    });
    const wrapper = mount(InstalledExtensionList);
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(h.ui.toast).toHaveBeenCalledWith('卸载「社区扩展一」失败，请稍后重试', 'error');
  });

  it('卸载后列表随 store 刷新', async () => {
    const store = useWorkshopStore() as unknown as { projects: unknown[] };
    const wrapper = mount(InstalledExtensionList);
    expect(wrapper.findAll('.installed-row')).toHaveLength(1);
    h.workshop.uninstall.mockImplementation(async () => {
      store.projects = [];
      return true;
    });
    await wrapper.get('button').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.installed-row')).toHaveLength(0);
  });
});
