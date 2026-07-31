/**
 * WorkshopPage.vue — 编排壳测试（Phase 1 / P1-4）
 *
 * 守的是**页面自己那条时序**，不是 store 的行为（后者在 workshop-store.test.ts）。
 * 因此 store 整层被替成一个可断言的假，重点只有三处:
 *
 * 1. **D15 闸门**：`plan.conflicts` 非空时，覆盖警告必须出现在 `commitInstall`
 *    **之前** —— 这是全页唯一一条不可颠倒的时序，颠倒了就是用户改过的条目被静默盖掉。
 * 2. **丢弃 loud（D16）**：`droppedNotes` 在折叠态就露出「N 项内容未导入」，展开可看全文。
 * 3. **两个入口一条管线**：网络安装与本地文件导入都经同一个 prepare → 闸门 → commit。
 *
 * 网络层（workshop-client）整层 mock，**绝不发真实请求**。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { WorkshopProject } from '@engine/types';
import type { InstallConflict, InstallPlan } from '@engine/workshop-types';
import WorkshopPage from './WorkshopPage.vue';

// ── 网络层：整层替掉，一发请求都不许出去 ──
vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return {
    ...actual,
    listProjects: vi.fn(async () => ({
      ok: true,
      fromCache: false,
      data: { total: 0, page: 0, pageSize: 20, projects: [], droppedCount: 0 },
    })),
    fetchProject: vi.fn(async () => ({
      ok: false,
      error: { kind: 'network', message: 'stub', url: '' },
    })),
  };
});

// ── store：可断言的假（projects 走 reactive，否则「落库后列表自己刷新」的断言恒真） ──
const h = vi.hoisted(() => {
  const fns = {
    init: vi.fn(async () => {}),
    prepareInstall: vi.fn(),
    prepareInstallFromFile: vi.fn(),
    commitInstall: vi.fn(),
    checkUpdate: vi.fn(),
    uninstall: vi.fn(async () => true),
  };
  return { fns };
});

const state = reactive<{ projects: WorkshopProject[] }>({ projects: [] });

vi.mock('../../stores/workshop-store', () => ({
  useWorkshopStore: () => ({
    ...h.fns,
    get projects() {
      return state.projects;
    },
    getProject: (id: string) => state.projects.find((p) => p.id === id),
  }),
}));

// ── 夹具 ──

function makeProject(over: Partial<WorkshopProject> = {}): WorkshopProject {
  return {
    id: 'p1',
    rootProjectId: 'r1',
    name: '维拉的旅途',
    description: '一段外传',
    version: '1.2.0',
    authorName: '某位作者',
    tags: ['系统', '命定核心'],
    coverUrl: undefined,
    downloadUrl: 'https://example.invalid/p1.json',
    fileSize: 2048,
    installState: 'installed',
    installedVersion: '1.1.0',
    installedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    uidRange: { start: 0, end: 3 },
    droppedNotes: [],
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function makePlan(conflicts: InstallConflict[] = []): InstallPlan {
  return {
    projectId: 'p1',
    projectName: '维拉的旅途',
    bookId: 'workshop:p1',
    partition: 'creative_workshop',
    entries: [{ uid: 0 }, { uid: 1 }] as InstallPlan['entries'],
    rules: [{ id: 'workshop-rule:p1:a' }] as InstallPlan['rules'],
    uidRange: { start: 0, end: 2 },
    allocatedUidRange: { start: 0, end: 2 },
    nextUid: 2,
    retiredUids: [],
    conflicts,
    droppedNotes: [],
    isUpdate: conflicts.length > 0,
  };
}

function makePrepared(conflicts: InstallConflict[] = []) {
  return {
    projectId: 'p1',
    input: { project: makeProject(), worldbookEntries: [], regexEntries: [] },
    plan: makePlan(conflicts),
    sourceNotes: [],
    entriesSource: 'download' as const,
  };
}

const CONFLICT: InstallConflict = {
  uid: 7,
  name: '维拉·序章',
  sourceHash: 'aaa',
  currentHash: 'bbb',
};

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  state.projects = [];
  h.fns.init.mockResolvedValue(undefined);
  h.fns.uninstall.mockResolvedValue(true);
  h.fns.commitInstall.mockResolvedValue({ project: makeProject(), plan: makePlan() });
});

/** 找一个文案匹配的按钮 */
function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(text));
}

function findBodyButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

describe('WorkshopPage', () => {
  it('挂载时踢一脚 store.init，并渲染顶栏两个入口', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(h.fns.init).toHaveBeenCalled();
    expect(findButton(wrapper, '浏览工坊')).toBeTruthy();
    expect(findButton(wrapper, '导入本地文件')).toBeTruthy();
    wrapper.unmount();
  });

  it('没有已装项目时渲染空态（装饰符 + 斜体说明）', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    const empty = wrapper.find('.empty-tab');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('尚未安装');
    wrapper.unmount();
  });

  it('已装项目渲染名字/作者/版本对比/标签', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('维拉的旅途');
    expect(text).toContain('某位作者');
    // 版本对比：装的是 1.1.0，上游是 1.2.0
    expect(text).toContain('已装 v1.1.0');
    expect(text).toContain('上游 v1.2.0');
    expect(text).toContain('有更新');
    // D12：标签必须摆在明面上
    expect(text).toContain('命定核心');
    wrapper.unmount();
  });

  // ═══ D16：丢弃必须 loud ═══

  it('droppedNotes 折叠态露出「N 项内容未导入」，展开后逐条可见', async () => {
    state.projects = [
      makeProject({
        droppedNotes: ['promptOnly 不受支持，已丢弃', 'placement 无对应物，已丢弃'],
      }),
    ];
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    const toggle = wrapper.find('.wk-notes-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('2 项内容未导入');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    // 折叠态不渲染正文
    expect(wrapper.find('.wk-notes-list').exists()).toBe(false);

    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    const items = wrapper.findAll('.wk-notes-list li');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('promptOnly');

    // 再点收起
    await toggle.trigger('click');
    expect(wrapper.find('.wk-notes-list').exists()).toBe(false);
    wrapper.unmount();
  });

  it('没有处置记录的项目不显示「未导入」提示', async () => {
    state.projects = [makeProject({ droppedNotes: [] })];
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(wrapper.find('.wk-notes-toggle').exists()).toBe(false);
    wrapper.unmount();
  });

  // ═══ ★ D15：冲突警告必须先于 commitInstall ═══

  it('网络更新遇到冲突：先弹警告，此时一行都没写', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([CONFLICT]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();

    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    // 警告出现了…
    expect(document.body.textContent).toContain('确认覆盖你修改过的条目');
    expect(document.body.textContent).toContain('维拉·序章');
    expect(document.body.textContent).toContain('1');
    // …而落库一次都没发生
    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('在警告上点确认之后才落库，且提交的是同一份 prepared', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    const prepared = makePrepared([CONFLICT]);
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();
    expect(h.fns.commitInstall).not.toHaveBeenCalled();

    findBodyButton('覆盖并更新')!.click();
    await flushPromises();

    expect(h.fns.commitInstall).toHaveBeenCalledTimes(1);
    // 提交的是警告前算好的那一份（ref 存取会套一层 Vue proxy，故比内容不比引用），
    // 且**没有**重新 prepare —— 重算一次就等于用户确认的清单与实际写的内容对不上
    expect(h.fns.commitInstall.mock.calls[0][0]).toStrictEqual(prepared);
    expect(h.fns.prepareInstall).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('在警告上点取消：不落库，警告关闭', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([CONFLICT]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    findBodyButton('取消')!.click();
    await flushPromises();

    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('确认覆盖你修改过的条目');
    wrapper.unmount();
  });

  it('无冲突时不弹警告，直接落库', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    expect(document.body.textContent).not.toContain('确认覆盖你修改过的条目');
    expect(h.fns.commitInstall).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('prepare 失败：说人话且不落库', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({
      ok: false,
      error: { kind: 'timeout', message: '上游 15 秒未响应', url: 'u' },
    });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('一直没有响应');
    wrapper.unmount();
  });

  // ═══ 本地文件导入：同一条管线 ═══

  /** 造一个只有 name/text 的假 File —— jsdom 各版本 Blob.text 支持不一 */
  function fakeFile(name: string, body: string): File {
    return { name, text: async () => body } as unknown as File;
  }

  async function pickFile(wrapper: ReturnType<typeof mount>, file: File): Promise<void> {
    const input = wrapper.find('input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    await input.trigger('change');
    await flushPromises();
  }

  it('本地文件导入走 prepareInstallFromFile，无冲突直接落库', async () => {
    const prepared = makePrepared([]);
    h.fns.prepareInstallFromFile.mockReturnValue({ ok: true, prepared });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await pickFile(wrapper, fakeFile('project-p1.json', '{"id":"p1"}'));

    expect(h.fns.prepareInstallFromFile).toHaveBeenCalledTimes(1);
    expect(h.fns.prepareInstallFromFile.mock.calls[0][0]).toEqual({ id: 'p1' });
    expect(h.fns.commitInstall).toHaveBeenCalledTimes(1);
    // 本地这条路不许碰网络
    expect(h.fns.prepareInstall).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('本地文件导入遇到冲突：同样先弹警告再落库', async () => {
    h.fns.prepareInstallFromFile.mockReturnValue({ ok: true, prepared: makePrepared([CONFLICT]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await pickFile(wrapper, fakeFile('project-p1.json', '{"id":"p1"}'));

    expect(document.body.textContent).toContain('确认覆盖你修改过的条目');
    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('本地文件不是合法 JSON：报错且完全不进管线', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await pickFile(wrapper, fakeFile('broken.json', 'not json at all'));

    expect(h.fns.prepareInstallFromFile).not.toHaveBeenCalled();
    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('不是合法的 JSON');
    wrapper.unmount();
  });

  it('文件里没有项目 id：把 store 的判定原样说给用户', async () => {
    h.fns.prepareInstallFromFile.mockReturnValue({
      ok: false,
      error: { kind: 'malformed', message: '文件里没有项目 id', url: '' },
    });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await pickFile(wrapper, fakeFile('p.json', '{}'));

    expect(h.fns.commitInstall).not.toHaveBeenCalled();
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('文件里没有项目 id');
    wrapper.unmount();
  });

  // ═══ 查更新 / 卸载 ═══

  it('查更新把结果播报出来', async () => {
    state.projects = [makeProject({ installState: 'installed', version: '1.1.0' })];
    h.fns.checkUpdate.mockResolvedValue({
      ok: true,
      project: makeProject({ version: '2.0.0', installedVersion: '1.1.0' }),
      hasUpdate: true,
    });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '查更新')!.trigger('click');
    await flushPromises();

    expect(h.fns.checkUpdate).toHaveBeenCalledWith('p1', { force: true });
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('有新版本 2.0.0');
    wrapper.unmount();
  });

  it('卸载先弹确认，取消则不动手', async () => {
    state.projects = [makeProject()];
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    await findButton(wrapper, '卸载')!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('卸载工坊项目');

    findBodyButton('取消')!.click();
    await flushPromises();
    expect(h.fns.uninstall).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('卸载确认后调用 store.uninstall', async () => {
    state.projects = [makeProject()];
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '卸载')!.trigger('click');
    await flushPromises();

    // footer 里那个 danger「卸载」
    const confirm = [...document.body.querySelectorAll('.modal-footer button')].find((b) =>
      b.textContent?.includes('卸载'),
    ) as HTMLButtonElement;
    confirm.click();
    await flushPromises();

    expect(h.fns.uninstall).toHaveBeenCalledWith('p1');
    wrapper.unmount();
  });
});
