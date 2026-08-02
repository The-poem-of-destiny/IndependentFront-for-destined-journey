/**
 * WorkshopPage.vue — 编排壳测试（Phase 1 / P1-4）
 *
 * 守的是**页面自己那条时序**，不是 store 的行为（后者在 workshop-store.test.ts）。
 * 因此 store 整层被替成一个可断言的假，重点只有三处:
 *
 * 1. **D15 闸门**：`plan.conflicts` 非空时，覆盖警告必须出现在 `commitInstall`
 *    **之前** —— 这是全页唯一一条不可颠倒的时序，颠倒了就是用户改过的条目被静默盖掉。
 * 2. **丢弃 loud（D16）**：`droppedNotes` 在折叠态就露出「N 项内容未导入」，展开可看全文。
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
import type { WorkshopUpdateDiff } from '@engine/workshop-diff';
import WorkshopPage from './WorkshopPage.vue';
import { fetchProject, listProjects } from '../../lib/workshop-client';

// ── 网络层：整层替掉，一发请求都不许出去 ──
vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return {
    ...actual,
    listProjects: vi.fn(async () => ({
      ok: true,
      fromCache: false,
      data: {
        total: 0,
        page: 0,
        pageSize: 20,
        projects: [],
        droppedCount: 0,
        socials: {},
        listings: {},
      },
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
    commitInstall: vi.fn(),
    checkUpdate: vi.fn(),
    uninstall: vi.fn(async () => true),
    // B3：更新前的改动预告。默认返回「无改动」，关心 diff 的用例自己覆盖。
    // 显式标注返回类型：不标的话空数组被推成 never[]，用例再想 mockReturnValue
    // 一份真的 diff 就会被类型系统拒掉。
    previewUpdate: vi.fn((): WorkshopUpdateDiff => ({
      entries: { added: [], modified: [], removed: [] },
      rules: { added: [], modified: [], removed: [] },
      unchangedEntryCount: 0,
      hasChanges: false,
    })),
  };
  return { fns };
});

// ready 默认 true：绝大多数用例关心的是水合**之后**的样子。
// 水合中（ready:false）另有专门用例——那时列表渲染骨架而**不是**空态。
const state = reactive<{ projects: WorkshopProject[]; ready: boolean }>({
  projects: [],
  ready: true,
});

vi.mock('../../stores/workshop-store', () => ({
  useWorkshopStore: () => ({
    ...h.fns,
    get projects() {
      return state.projects;
    },
    get ready() {
      return state.ready;
    },
    getProject: (id: string) => state.projects.find((p) => p.id === id),
  }),
}));

/**
 * social store 同样整层替掉（P3c）。
 *
 * 不这么做的话，点一下「Discord 登录」就会经真 store 走到 client 的 `startLogin()`
 * ——那是一发**真实**网络请求，还会试图开一个弹窗。登录编排本身的时序（双重验签 /
 * 快路径 / 60 秒超时）在 `workshop-social-store.test.ts` 里守。
 */
const socialFns = vi.hoisted(() => ({
  init: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  toggleLike: vi.fn(),
  toggleSubscribe: vi.fn(),
}));

const socialState = reactive<{
  loggedIn: boolean;
  phase: 'idle' | 'pending' | 'success' | 'failed';
  user: { userId: string; username: string; globalName: string; avatar: string } | null;
}>({ loggedIn: false, phase: 'idle', user: null });

vi.mock('../../stores/workshop-social-store', () => ({
  useWorkshopSocialStore: () => ({
    ...socialFns,
    get isLoggedIn() {
      return socialState.loggedIn;
    },
    get loginPhase() {
      return socialState.phase;
    },
    get user() {
      return socialState.user;
    },
    socialOf: (_id: string, from?: unknown) => from,
    isBusy: () => false,
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

function makePlan(conflicts: InstallConflict[] = [], isUpdate = conflicts.length > 0): InstallPlan {
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
    isUpdate,
  };
}

function makePrepared(conflicts: InstallConflict[] = [], isUpdate = conflicts.length > 0) {
  return {
    projectId: 'p1',
    input: { project: makeProject(), worldbookEntries: [], regexEntries: [] },
    plan: makePlan(conflicts, isUpdate),
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
  state.ready = true;
  h.fns.init.mockResolvedValue(undefined);
  h.fns.uninstall.mockResolvedValue(true);
  h.fns.commitInstall.mockResolvedValue({ project: makeProject(), plan: makePlan() });
  socialState.loggedIn = false;
  socialState.phase = 'idle';
  socialState.user = null;
  socialFns.login.mockResolvedValue({ status: 'success', user: null });
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
  it('挂载时踢一脚 store.init，并渲染「浏览工坊」入口', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(h.fns.init).toHaveBeenCalled();
    expect(findButton(wrapper, '浏览工坊')).toBeTruthy();
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

  it('★ 转圈只出现在按下的那个按钮上，不是整行一起转', async () => {
    // 一行并排「查更新 / 卸载」，若只按 busyId 判定就会一起转，用户看不出跑的是哪个
    // —— 卸载不可逆，让它看起来在跑而实际在跑别的是会吓到人的。
    state.projects = [makeProject()];
    let release: (v: unknown) => void = () => {};
    h.fns.checkUpdate.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '查更新')!.trigger('click');
    await flushPromises();

    const spinning = wrapper
      .findAll('button')
      .filter((b) => b.find('.btn-spinner').exists())
      .map((b) => b.text());
    expect(spinning).toHaveLength(1);
    expect(spinning[0]).toContain('查询中');
    // 卸载按钮同时被禁用（同一行不许并发），但**不**转圈
    const uninstall = findButton(wrapper, '卸载')!;
    expect(uninstall.attributes('disabled')).toBeDefined();
    expect(uninstall.find('.btn-spinner').exists()).toBe(false);

    release({ ok: true, hasUpdate: false, project: makeProject() });
    await flushPromises();
    // 收工后一个都不转，按钮回到可点
    expect(wrapper.findAll('.btn-spinner')).toHaveLength(0);
    wrapper.unmount();
  });

  it('★ 覆盖警告在写入跑完之前不关闭 —— 它的忙碌态才不是死代码', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    let release: (v: unknown) => void = () => {};
    h.fns.prepareInstall.mockResolvedValue({
      ok: true,
      prepared: makePrepared([{ uid: 5, name: '被改过的条目' } as InstallConflict]),
    });
    h.fns.commitInstall.mockImplementation(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('被改过的条目');

    const confirm = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('覆盖并更新'),
    ) as HTMLButtonElement;
    confirm.click();
    await flushPromises();

    // 写入进行中：模态仍在，按钮转圈，取消被禁 —— 旧实现这时模态早已消失
    expect(document.body.textContent).toContain('正在覆盖');
    expect(document.body.querySelector('.btn-spinner')).not.toBeNull();

    release({ project: makeProject(), plan: makePlan() });
    await flushPromises();
    expect(document.body.textContent).not.toContain('正在覆盖');
    wrapper.unmount();
  });

  it('★ 水合未完成时渲染骨架，而不是「尚未安装」', async () => {
    // 这句空态对一个装了十个项目的用户来说是错的，而它恰好出现在每次进页面的头一瞬
    state.ready = false;
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(wrapper.find('.wk-row-skeleton').exists()).toBe(true);
    expect(wrapper.find('.empty-tab').exists()).toBe(false);
    // 这时 projects 恒为空，报「已安装（0）」同样是在说假话
    expect(wrapper.text()).not.toContain('已安装（0）');
    wrapper.unmount();
  });

  it('水合完成后骨架让位给真实内容', async () => {
    state.ready = false;
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(wrapper.find('.wk-row-skeleton').exists()).toBe(true);

    state.ready = true;
    state.projects = [makeProject()];
    await flushPromises();
    expect(wrapper.find('.wk-row-skeleton').exists()).toBe(false);
    expect(wrapper.text()).toContain('维拉的旅途');
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

  // ═══ 登录位（P3c / D19·D25） ═══

  it('挂载时也踢一脚 social.init —— 它负责注册 token provider 与恢复登录态', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(socialFns.init).toHaveBeenCalled();
    wrapper.unmount();
  });

  it('未登录时顶栏是一个「Discord 登录」按钮', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(findButton(wrapper, 'Discord 登录')).toBeTruthy();
    expect(wrapper.find('.wk-account').exists()).toBe(false);
    wrapper.unmount();
  });

  it('点登录交给 store 编排（弹窗/轮询/超时都不在本页）', async () => {
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, 'Discord 登录')!.trigger('click');
    await flushPromises();
    expect(socialFns.login).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('已登录');
    wrapper.unmount();
  });

  it('★ 授权途中按钮转圈且不可再点 —— 连点两下会开出两个弹窗', async () => {
    socialState.phase = 'pending';
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    const btn = findButton(wrapper, '等待 Discord 授权')!;
    expect(btn.find('.btn-spinner').exists()).toBe(true);
    expect(btn.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('★ 登录失败：原话照登 + 补一句 Discord 服务器门槛（D25）', async () => {
    socialFns.login.mockResolvedValue({
      status: 'failed',
      message: '你不在允许的服务器中',
    });
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, 'Discord 登录')!.trigger('click');
    await flushPromises();

    const live = wrapper.find('[aria-live="polite"]').text();
    expect(live).toContain('你不在允许的服务器中');
    // 光有上游原话说不清「我该怎么办」
    expect(live).toContain('命定之诗');
    wrapper.unmount();
  });

  it('已登录时顶栏换成头像 + 名字 + 登出', async () => {
    socialState.loggedIn = true;
    socialState.user = { userId: 'u1', username: 'vera', globalName: '维拉', avatar: 'abc' };
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    // 头像哈希要自己拼成 URL（JWT 里给的不是 URL）
    expect(wrapper.find('.wk-avatar').attributes('src')).toContain(
      'cdn.discordapp.com/avatars/u1/abc.webp',
    );
    // globalName 优先：改过显示名的用户不该看到自己早就不用的旧 ID
    expect(wrapper.find('.wk-account-name').text()).toBe('维拉');
    expect(findButton(wrapper, 'Discord 登录')).toBeUndefined();

    await findButton(wrapper, '登出')!.trigger('click');
    expect(socialFns.logout).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[aria-live="polite"]').text()).toContain('已登出');
    wrapper.unmount();
  });

  it('没设过头像时退回 Discord 默认头像，不留一个碎图标', async () => {
    socialState.loggedIn = true;
    socialState.user = { userId: 'u1', username: 'vera', globalName: '', avatar: '' };
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    expect(wrapper.find('.wk-avatar').attributes('src')).toContain('embed/avatars/0.png');
    // globalName 空 → 退回 username
    expect(wrapper.find('.wk-account-name').text()).toBe('vera');
    wrapper.unmount();
  });

  // ═══ D16：丢弃必须 loud ═══

  it('droppedNotes 折叠态露出计数，展开后逐条可见', async () => {
    state.projects = [
      makeProject({
        droppedNotes: [
          { kind: 'dropped', text: 'promptOnly 不受支持，已丢弃' },
          { kind: 'dropped', text: 'placement 无对应物，已丢弃' },
        ],
      }),
    ];
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    const toggle = wrapper.find('.wk-notes-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('2 项未导入');
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

  it('★ 三类 note 分组计数：只有 dropped 叫「未导入」，degraded/sideEffect 各自成组', async () => {
    state.projects = [
      makeProject({
        droppedNotes: [
          { kind: 'dropped', text: '丢弃 placement' },
          { kind: 'degraded', text: '含 <script>：已装上但不执行' },
          { kind: 'degraded', text: '围栏原样显示' },
          { kind: 'sideEffect', text: '含 <style>：样式会全局生效' },
        ],
      }),
    ];
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    const toggle = wrapper.find('.wk-notes-toggle');
    const summary = toggle.text();
    expect(summary).toContain('1 项未导入');
    expect(summary).toContain('2 项已装但效果受限');
    expect(summary).toContain('1 项有全局副作用');
    // ★ 4 条 note 绝不能被报成「4 项未导入」—— 那正是本次要修的谎
    expect(summary).not.toContain('4 项未导入');
    // 副作用那一段单独有类，视觉上最显眼
    expect(wrapper.find('.wk-note-seg.seg-sideEffect').exists()).toBe(true);

    await toggle.trigger('click');
    const groups = wrapper.findAll('.wk-note-group');
    expect(groups).toHaveLength(3);
    // 分组互不串：degraded 组里 3 条 note 只属于自己那 2 条
    const degraded = wrapper.find('.wk-note-group.group-degraded');
    expect(degraded.findAll('li')).toHaveLength(2);
    expect(degraded.text()).not.toContain('placement');
    const side = wrapper.find('.wk-note-group.group-sideEffect');
    expect(side.findAll('li')).toHaveLength(1);
    expect(side.text()).toContain('<style>');
    wrapper.unmount();
  });

  it('★ 旧 string[] 数据照常渲染（P1 首版落库形态，不做迁移）', async () => {
    state.projects = [
      makeProject({
        // 老行就是裸字符串数组 —— 归 dropped，不炸、不丢
        droppedNotes: ['promptOnly 不受支持，已丢弃', '丢弃 runOnEdit'],
      }),
    ];
    const wrapper = mount(WorkshopPage);
    await flushPromises();

    const toggle = wrapper.find('.wk-notes-toggle');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('2 项未导入');
    await toggle.trigger('click');
    expect(wrapper.findAll('.wk-note-group')).toHaveLength(1);
    expect(wrapper.findAll('.wk-notes-list li')).toHaveLength(2);
    expect(wrapper.text()).toContain('丢弃 runOnEdit');
    wrapper.unmount();
  });

  it('★ 旧串与新结构混在同一行时两者都渲染', async () => {
    state.projects = [
      makeProject({
        droppedNotes: ['老的裸串记录', { kind: 'sideEffect', text: '含 <style>：全局生效' }],
      }),
    ];
    const wrapper = mount(WorkshopPage);
    await flushPromises();
    const toggle = wrapper.find('.wk-notes-toggle');
    expect(toggle.text()).toContain('1 项未导入');
    expect(toggle.text()).toContain('1 项有全局副作用');
    await toggle.trigger('click');
    expect(wrapper.findAll('.wk-notes-list li')).toHaveLength(2);
    wrapper.unmount();
  });

  it('没有处置记录的项目不显示折叠区', async () => {
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

  it('★ 首装无冲突：一道闸都不拦，直接落库', async () => {
    // 首装时全部内容都是新的，预告等于把详情模态里刚看过的东西再念一遍
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([], false) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    expect(document.body.textContent).not.toContain('确认覆盖你修改过的条目');
    expect(document.body.textContent).not.toContain('确认更新');
    expect(h.fns.commitInstall).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('★ 更新即使没有冲突也先给改动预告 —— 加/删条目同样不可逆', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([], true) });
    h.fns.previewUpdate.mockReturnValue({
      entries: {
        added: [{ name: '新条目', before: '', after: 'x' }],
        modified: [],
        removed: [{ name: '被删的条目', before: 'y', after: '' }],
      },
      rules: { added: [], modified: [], removed: [] },
      unchangedEntryCount: 7,
      hasChanges: true,
    });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    // 不是那句惊悚标题 —— 没有冲突时它只是一次普通确认
    expect(document.body.textContent).toContain('确认更新');
    expect(document.body.textContent).not.toContain('确认覆盖你修改过的条目');
    expect(document.body.textContent).toContain('新条目');
    expect(document.body.textContent).toContain('被删的条目');
    expect(document.body.textContent).toContain('7 条条目原样保留');
    // 一行都没写
    expect(h.fns.commitInstall).not.toHaveBeenCalled();

    findBodyButton('确认更新')!.click();
    await flushPromises();
    expect(h.fns.commitInstall).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('预告拿的是「即将提交的那份计划」，不是另拉一次重算的', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    const prepared = makePrepared([], true);
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    expect(h.fns.previewUpdate).toHaveBeenCalledWith(prepared);
    wrapper.unmount();
  });

  // ═══ force：只有「更新」该越过 5 分钟详情缓存 ═══

  it('★ 更新已装项目时 force —— 按钮上写的版本必须是刚拉回来的那个', async () => {
    state.projects = [makeProject({ installState: 'update_available' })];
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '更新')!.trigger('click');
    await flushPromises();

    expect(h.fns.prepareInstall).toHaveBeenCalledWith('p1', { force: true });
    wrapper.unmount();
  });

  it('★ 首次安装不 force —— 用户几秒前在详情里看到的就是他同意装的那一份', async () => {
    // 走真实入口：浏览列表 → 点卡片开详情 → 按「安装」。此时 getProject 找不到它，
    // 页面就该沿用刚刚那份热缓存，而不是让「安装」比「浏览」多等一个往返。
    vi.mocked(listProjects).mockResolvedValue({
      ok: true,
      fromCache: false,
      data: {
        total: 1,
        page: 0,
        pageSize: 20,
        projects: [makeProject()],
        droppedCount: 0,
        socials: {},
        listings: {},
      },
    });
    vi.mocked(fetchProject).mockResolvedValue({
      ok: true,
      fromCache: false,
      data: {
        project: makeProject(),
        regexEntries: [],
        previewEntries: [],
        listing: {
          authorId: '',
          authorAvatarUrl: '',
          status: 'approved',
          reviewTarget: 'project',
          rejectReason: '',
          hasPendingDraft: false,
          visibility: true,
          updatedAt: '',
        },
        social: {
          likesCount: 0,
          subscribesCount: 0,
          downloadsCount: 0,
          userLiked: false,
          userSubscribed: false,
        },
      },
    });
    h.fns.prepareInstall.mockResolvedValue({ ok: true, prepared: makePrepared([]) });

    const wrapper = mount(WorkshopPage);
    await flushPromises();
    await findButton(wrapper, '浏览工坊')!.trigger('click');
    await flushPromises();
    (document.body.querySelector('.wk-card') as HTMLButtonElement).click();
    await flushPromises();
    findBodyButton('安装')!.click();
    await flushPromises();

    expect(h.fns.prepareInstall).toHaveBeenCalledWith('p1', { force: false });
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
