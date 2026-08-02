/**
 * WorkshopBrowseModal.vue — 浏览模态测试（Phase 1 / P1-4）
 *
 * 守四件事:
 * 1. 搜索词 / 标签 / 分页**如实传给 `listProjects`** —— 组件与 client 之间的这道缝
 *    没有任何工具能拦，传错了表现成「筛选没反应」，最难查。
 * 2. **空态与失败态**是这一屏的常态而非异常路径（上游是第三方 worker）。
 * 3. `kind: 'cancelled'` **不算错误** —— 用户每敲一个字都会掐掉上一发请求，
 *    把它当失败就是每敲一个字闪一次红。
 * 4. 已装项目在卡片上带徽章。
 *
 * `listProjects` 整层 mock，**绝不发真实请求**。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type {
  WorkshopListingMeta,
  WorkshopProjectMeta,
  WorkshopSocialMeta,
} from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import WorkshopBrowseModal from './WorkshopBrowseModal.vue';
import {
  deleteProject,
  invalidateWorkshopProject,
  listMyProjects,
  listProjects,
} from '../../lib/workshop-client';

vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return {
    ...actual,
    listProjects: vi.fn(),
    listMyProjects: vi.fn(),
    deleteProject: vi.fn(),
    invalidateWorkshopProject: vi.fn(),
  };
});

/**
 * social store 整层替掉 —— 本组件只用它两处: `user.userId`（判「这是不是我的项目」，
 * 决定卡片上出不出管理动作）与 `socialOf`（「订阅与已装」认订阅）。
 * 用真 store 的话 `user` 恒为 null，管理动作永远不渲染。
 */
const socialState = reactive<{ userId: string | null }>({ userId: null });
vi.mock('../../stores/workshop-social-store', () => ({
  useWorkshopSocialStore: () => ({
    get user() {
      return socialState.userId === null ? null : { userId: socialState.userId };
    },
    socialOf: (_id: string, from?: unknown) => from,
    isBusy: () => false,
    isLoggedIn: socialState.userId !== null,
  }),
}));

const listMock = vi.mocked(listProjects);
const myMock = vi.mocked(listMyProjects);
const deleteMock = vi.mocked(deleteProject);
const invalidateMock = vi.mocked(invalidateWorkshopProject);

function meta(over: Partial<WorkshopProjectMeta> = {}): WorkshopProjectMeta {
  return {
    id: 'p1',
    rootProjectId: 'r1',
    name: '维拉的旅途',
    description: '一段外传',
    version: '1.2.0',
    authorName: '某位作者',
    tags: ['系统'],
    coverUrl: undefined,
    downloadUrl: 'https://example.invalid/p1.json',
    fileSize: 2048,
    ...over,
  };
}

function page(projects: WorkshopProjectMeta[], over: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    fromCache: false,
    data: {
      total: projects.length,
      page: 0,
      pageSize: 20,
      projects,
      droppedCount: 0,
      // 社交面（D22）默认空 —— 多数用例断言的是浏览/筛选；派发计数另有专门用例
      socials: {} as Record<string, WorkshopSocialMeta>,
      listings: {} as Record<string, WorkshopListingMeta>,
      ...over,
    },
  };
}

async function open(installed: WorkshopProject[] = []) {
  const wrapper = mount(WorkshopBrowseModal, {
    props: { open: false, installed },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

/** 最后一次调用传给 client 的查询对象 */
function lastQuery(): Record<string, unknown> {
  return listMock.mock.calls[listMock.mock.calls.length - 1][0] as Record<string, unknown>;
}

/** 最后一次调用传给 client 的第二参数（signal + force） */
function lastOpts(): Record<string, unknown> {
  return listMock.mock.calls[listMock.mock.calls.length - 1][1] as Record<string, unknown>;
}

/** 「加载更多」按钮 —— 只在 total 大于已加载条数时存在 */
function loadMoreButton(): HTMLButtonElement {
  return document.body.querySelector('.wk-more button') as HTMLButtonElement;
}

/** 视图切换按钮 */
function scopeButton(label: string): HTMLButtonElement {
  return [...document.body.querySelectorAll('.wk-scopechip')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  listMock.mockResolvedValue(page([meta()]));
  myMock.mockResolvedValue(page([]));
  deleteMock.mockResolvedValue({ ok: true, fromCache: false, data: null });
  socialState.userId = null;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkshopBrowseModal', () => {
  it('打开即拉第一页，并渲染卡片', async () => {
    const wrapper = await open();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toMatchObject({ page: 0 });
    const cards = document.body.querySelectorAll('.wk-card');
    expect(cards).toHaveLength(1);
    expect(document.body.textContent).toContain('维拉的旅途');
    expect(document.body.textContent).toContain('某位作者');
    expect(document.body.textContent).toContain('v1.2.0');
    wrapper.unmount();
  });

  it('★ 只有「刷新」传 force —— 打开/翻页都乐意吃 45 秒列表缓存', async () => {
    listMock.mockResolvedValue(page([meta()], { total: 100 }));
    const wrapper = await open();
    // 打开模态：关掉又立刻打开是常见动作，这一发本就该命中缓存
    expect(lastOpts()).toMatchObject({ force: false });

    loadMoreButton().click();
    await flushPromises();
    // 加载更多是另一把缓存钥匙，本来就拉的是新内容，不需要 force
    expect(lastOpts()).toMatchObject({ force: false });

    const refresh = [...document.body.querySelectorAll('.wk-toolbar button')].find((b) =>
      b.textContent?.includes('刷新'),
    ) as HTMLButtonElement;
    refresh.click();
    await flushPromises();
    // 「刷新」是用户说「我要最新的」的唯一入口 —— 唯一一处 force
    expect(lastOpts()).toMatchObject({ force: true });
    wrapper.unmount();
  });

  it('失败态的「重试」不必 force —— 失败从不入缓存，重试天然是真请求', async () => {
    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    const wrapper = await open();

    listMock.mockResolvedValue(page([meta()]));
    const retry = [...document.body.querySelectorAll('.wk-failure button')].find((b) =>
      b.textContent?.includes('重试'),
    ) as HTMLButtonElement;
    retry.click();
    await flushPromises();
    expect(lastOpts()).toMatchObject({ force: false });
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(1);
    wrapper.unmount();
  });

  it('关着的时候不发请求', async () => {
    const wrapper = mount(WorkshopBrowseModal, { props: { open: false, installed: [] } });
    await flushPromises();
    expect(listMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('搜索词防抖后如实传给 client，且回到第一页', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(WorkshopBrowseModal, {
        props: { open: true, installed: [] },
        attachTo: document.body,
      });
      // open 的 watch 不带 immediate，手动触发一次首拉以对齐真实时序
      await wrapper.setProps({ open: false });
      await wrapper.setProps({ open: true });
      await vi.advanceTimersByTimeAsync(0);
      listMock.mockClear();

      const input = document.body.querySelector('.wk-search') as HTMLInputElement;
      input.value = '维拉';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(10);
      // 防抖窗口内不该发
      expect(listMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      expect(listMock).toHaveBeenCalledTimes(1);
      expect(lastQuery()).toMatchObject({ search: '维拉', page: 0 });
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('点标签 → 带上 tag 重拉；再点一次 → 清除筛选', async () => {
    listMock.mockResolvedValue(page([meta({ tags: ['系统', '外挂'] })]));
    const wrapper = await open();
    listMock.mockClear();

    const chips = [...document.body.querySelectorAll('.wk-tagchip')] as HTMLButtonElement[];
    const sys = chips.find((c) => c.textContent?.trim() === '系统')!;
    sys.click();
    await flushPromises();
    expect(lastQuery()).toMatchObject({ tag: '系统', page: 0 });

    const sysAgain = [...document.body.querySelectorAll('.wk-tagchip')].find(
      (c) => c.textContent?.trim() === '系统',
    ) as HTMLButtonElement;
    sysAgain.click();
    await flushPromises();
    // 清除后不带 tag（client 侧 undefined 即不拼这个参数）
    expect(lastQuery().tag).toBeUndefined();
    wrapper.unmount();
  });

  it('★ 网格只在结果落地时重建，打字期间不重放入场动画', async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(WorkshopBrowseModal, {
        props: { open: true, installed: [] },
        attachTo: document.body,
      });
      await wrapper.setProps({ open: false });
      await wrapper.setProps({ open: true });
      await vi.advanceTimersByTimeAsync(0);

      const before = document.body.querySelector('.wk-grid');
      expect(before).not.toBeNull();

      // 敲三个字：防抖窗口内一发请求都没出去，网格就不该动
      const input = document.body.querySelector('.wk-search') as HTMLInputElement;
      for (const ch of ['a', 'ab', 'abc']) {
        input.value = ch;
        input.dispatchEvent(new Event('input'));
        await vi.advanceTimersByTimeAsync(10);
      }
      // 同一个 DOM 节点 = 没重建 = 没重放动画（旧实现在这里已经重建三次了）
      expect(document.body.querySelector('.wk-grid')).toBe(before);

      // 防抖到点、结果落地 → 这时才该换一片新的
      await vi.advanceTimersByTimeAsync(400);
      expect(document.body.querySelector('.wk-grid')).not.toBe(before);
      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('排序恒带且改排序回到第 0 页', async () => {
    // total 要够多，「下一页」才是可点的
    listMock.mockResolvedValue(page([meta()], { total: 100 }));
    const wrapper = await open();
    // 缺省排序必须显式带上：请求可复现，缓存键才稳定
    expect(lastQuery()).toMatchObject({ sort: 'published' });

    // 先追加一页，再改排序 —— 排序在服务端做，接着第 2 页排会排出自相矛盾的结果
    loadMoreButton().click();
    await flushPromises();
    expect(lastQuery()).toMatchObject({ page: 1 });

    const select = document.body.querySelector('.wk-sort') as HTMLSelectElement;
    select.value = 'downloads';
    select.dispatchEvent(new Event('change'));
    await flushPromises();
    expect(lastQuery()).toMatchObject({ sort: 'downloads', page: 0 });
    wrapper.unmount();
  });

  it('标签条恒定四项，不随当前页的项目漂移', async () => {
    // 这一页只有一个带「系统」的项目，「扩展/角色/事件」照样在条上
    const wrapper = await open();
    const chips = [...document.body.querySelectorAll('.wk-tagchip')].map((c) =>
      c.textContent?.trim(),
    );
    expect(chips).toEqual(['系统', '扩展', '角色', '事件']);

    // 换成一页完全不含基础标签的结果，条上仍是同样四项（不塌不长 → 下方网格不被顶动）
    listMock.mockResolvedValue(page([meta({ tags: ['外挂', '路边'] })]));
    const refresh = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '刷新',
    ) as HTMLButtonElement;
    refresh.click();
    await flushPromises();
    expect(
      [...document.body.querySelectorAll('.wk-tagchip')].map((c) => c.textContent?.trim()),
    ).toEqual(['系统', '扩展', '角色', '事件']);
    wrapper.unmount();
  });

  it('「加载更多」把下一页追加在现有结果之后，不替换', async () => {
    listMock.mockResolvedValue(page([meta({ id: 'p1', name: '第一批' })], { total: 3 }));
    const wrapper = await open();
    expect(document.body.textContent).toContain('已加载 1 / 3');
    expect(loadMoreButton().textContent).toContain('剩余 2 个');

    listMock.mockResolvedValue(page([meta({ id: 'p2', name: '第二批' })], { total: 3, page: 1 }));
    loadMoreButton().click();
    await flushPromises();

    // page 递增，且两批同时在屏幕上 —— 追加语义的全部内容
    expect(lastQuery()).toMatchObject({ page: 1 });
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(2);
    expect(document.body.textContent).toContain('第一批');
    expect(document.body.textContent).toContain('第二批');
    expect(document.body.textContent).toContain('已加载 2 / 3');
    wrapper.unmount();
  });

  it('★ 追加时按 id 去重 —— 上游按可变列排序 + OFFSET 分页会让同一条跨页重复', async () => {
    listMock.mockResolvedValue(page([meta({ id: 'p1' })], { total: 5 }));
    const wrapper = await open();

    // 第 2 页把 p1 又端回来一次（有人在两次请求之间更新了它）
    listMock.mockResolvedValue(
      page([meta({ id: 'p1' }), meta({ id: 'p2' })], { total: 5, page: 1 }),
    );
    loadMoreButton().click();
    await flushPromises();

    // 重复的那条被丢掉，不是渲染成两张卡片（重复 key 会让整片网格的复用错乱）
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(2);
    wrapper.unmount();
  });

  it('★ 追加失败不清空已加载的内容', async () => {
    listMock.mockResolvedValue(page([meta({ name: '已经看到的' })], { total: 9 }));
    const wrapper = await open();

    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    loadMoreButton().click();
    await flushPromises();

    // 报错归报错，翻了半天的结果还在
    expect(document.body.textContent).toContain('已经看到的');
    wrapper.unmount();
  });

  it('全部加载完毕后不再出现「加载更多」', async () => {
    listMock.mockResolvedValue(page([meta()], { total: 1 }));
    const wrapper = await open();
    expect(loadMoreButton()).toBeNull();
    expect(document.body.textContent).toContain('已加载 1 / 1');
    wrapper.unmount();
  });

  it('结果为空时渲染空态', async () => {
    listMock.mockResolvedValue(page([]));
    const wrapper = await open();
    const empty = document.body.querySelector('.empty-tab');
    expect(empty).toBeTruthy();
    expect(empty!.textContent).toContain('工坊里还空着');
    wrapper.unmount();
  });

  it('筛选后为空时说的是「没有符合条件」而不是「工坊空着」', async () => {
    const wrapper = await open();
    listMock.mockResolvedValue(page([]));
    const chip = document.body.querySelector('.wk-tagchip') as HTMLButtonElement;
    chip.click();
    await flushPromises();
    expect(document.body.querySelector('.empty-tab')!.textContent).toContain('没有符合条件');
    wrapper.unmount();
  });

  it('网络失败：说人话 + 给重试', async () => {
    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    const wrapper = await open();

    const box = document.body.querySelector('.wk-failure');
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain('连不上创意工坊');
    expect(box!.textContent).toContain('Failed to fetch');
    /*
     * ★ **不许**再出现「从工坊网页下载 project-xxx.json」那句话（2026-08-01 删）。
     * 上游工坊页没有下载按钮 —— 三个 file input 全是投稿用的上传口。指着一个不存在
     * 的入口，等于在用户最急的时候让他白找一趟。
     */
    expect(box!.textContent).not.toContain('project-xxx.json');

    listMock.mockResolvedValue(page([meta()]));
    const retry = [...box!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('重试'),
    ) as HTMLButtonElement;
    retry.click();
    await flushPromises();
    expect(document.body.querySelector('.wk-failure')).toBeNull();
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(1);
    wrapper.unmount();
  });

  it('超时与 HTTP 各有各的说法', async () => {
    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'timeout', message: '上游 15 秒未响应', url: 'u' },
    });
    const wrapper = await open();
    expect(document.body.querySelector('.wk-failure')!.textContent).toContain('一直没有响应');
    wrapper.unmount();

    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'http', status: 503, message: '上游返回 503', url: 'u' },
    });
    const w2 = await open();
    expect(document.body.querySelector('.wk-failure')!.textContent).toContain('503');
    w2.unmount();
  });

  it('cancelled 不是错误：不写错误态，也不清空已有结果', async () => {
    const wrapper = await open();
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(1);

    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'cancelled', message: '请求已取消', url: 'u' },
    });
    const refresh = [...document.body.querySelectorAll('.wk-toolbar button')].find((b) =>
      b.textContent?.includes('刷新'),
    ) as HTMLButtonElement;
    refresh.click();
    await flushPromises();

    expect(document.body.querySelector('.wk-failure')).toBeNull();
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(1);
    wrapper.unmount();
  });

  /** 让 listProjects 挂着不兑现 —— 模拟上游卡死 */
  function hangingList(): { signalOf: () => AbortSignal } {
    listMock.mockReturnValue(new Promise(() => {}) as ReturnType<typeof listProjects>);
    return {
      signalOf: () =>
        (listMock.mock.calls[listMock.mock.calls.length - 1][1] as { signal: AbortSignal }).signal,
    };
  }

  it('「取消」掐掉在飞请求并退出忙碌态', async () => {
    const { signalOf } = hangingList();
    const wrapper = await open();
    const signal = signalOf();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    const cancel = [...document.body.querySelectorAll('.wk-toolbar button')].find((b) =>
      b.textContent?.includes('取消'),
    ) as HTMLButtonElement;
    expect(cancel).toBeTruthy();
    cancel.click();
    await flushPromises();

    expect(signal.aborted).toBe(true);
    // 忙碌态退出 → 工具条换回「刷新」
    expect(document.body.querySelector('.wk-toolbar')!.textContent).toContain('刷新');
    wrapper.unmount();
  });

  it('关闭模态 / 卸载组件都会掐掉在飞请求', async () => {
    const { signalOf } = hangingList();
    const wrapper = await open();
    const first = signalOf();
    await wrapper.setProps({ open: false });
    expect(first.aborted).toBe(true);

    await wrapper.setProps({ open: true });
    await flushPromises();
    const second = signalOf();
    wrapper.unmount();
    expect(second.aborted).toBe(true);
  });

  it('已装项目在卡片上带「已安装」徽章', async () => {
    const installed = [
      { id: 'p1', installState: 'installed', installedVersion: '1.2.0' } as WorkshopProject,
    ];
    const wrapper = await open(installed);
    expect(document.body.querySelector('.wk-badge')!.textContent).toContain('已安装');
    wrapper.unmount();
  });

  // ═══ 社交计数：同一份响应顺带带回来（D22），本组件只负责按 id 派给卡片 ═══

  it('★ 把响应里的 socials 按 id 派给对应卡片', async () => {
    listMock.mockResolvedValue(
      page([meta(), meta({ id: 'p2', name: '另一段外传' })], {
        socials: {
          p1: {
            likesCount: 12,
            subscribesCount: 4,
            downloadsCount: 88,
            userLiked: true,
            userSubscribed: false,
          },
          // p2 上游没给 —— 它那张卡就该一个数字都不显示（§3.3 不编数字）
        } as Record<string, WorkshopSocialMeta>,
      }),
    );
    const wrapper = await open();

    const cards = [...document.body.querySelectorAll('.wk-card')];
    expect(cards).toHaveLength(2);
    const first = [...cards[0].querySelectorAll('.wk-social-count')].map((n) => n.textContent);
    expect(first).toEqual(['12', '4']);
    // 派错了 id 的话，第二张卡会拿到第一张的计数 —— 这是最容易犯又最难看出的一种错
    expect(cards[1].querySelector('.wk-social-count')).toBeNull();
    wrapper.unmount();
  });

  it('上游没给 socials 时卡片照常渲染，只是没有计数', async () => {
    const wrapper = await open();
    expect(document.body.querySelectorAll('.wk-social-btn')).toHaveLength(2);
    expect(document.body.querySelector('.wk-social-count')).toBeNull();
    wrapper.unmount();
  });

  it('上游有缺 id 的项目时如实报数', async () => {
    listMock.mockResolvedValue(page([meta()], { droppedCount: 3 }));
    const wrapper = await open();
    expect(document.body.querySelector('.wk-dropped-note')!.textContent).toContain('3 个项目');
    wrapper.unmount();
  });

  it('点卡片向上抛出项目 id', async () => {
    const wrapper = await open();
    (document.body.querySelector('.wk-card') as HTMLButtonElement).click();
    await flushPromises();
    expect(wrapper.emitted('open')).toEqual([['p1']]);
    wrapper.unmount();
  });

  // ═══ 视图切换（Phase 4 / B2） ═══

  it('切到「我的项目」走 listMyProjects，且不再带任何筛选参数', async () => {
    const wrapper = await open();
    myMock.mockResolvedValue(page([meta({ id: 'mine1', name: '我的草稿' })]));

    scopeButton('我的项目').click();
    await flushPromises();

    expect(myMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('我的草稿');
    wrapper.unmount();
  });

  it('★ 非服务端视图里排序控件整个不出现 —— 摆一个点了没反应的控件比没有更糟', async () => {
    const wrapper = await open();
    expect(document.body.querySelector('.wk-sort')).not.toBeNull();

    scopeButton('我的项目').click();
    await flushPromises();
    expect(document.body.querySelector('.wk-sort')).toBeNull();
    // 「加载更多」同理：上游一次全量返回，没有下一页可加载
    expect(loadMoreButton()).toBeNull();
    wrapper.unmount();
  });

  it('★ 本地视图里搜索不过网 —— displayProjects 自己重算', async () => {
    myMock.mockResolvedValue(
      page([meta({ id: 'a', name: '维拉的旅途' }), meta({ id: 'b', name: '别的项目' })]),
    );
    const wrapper = await open();
    scopeButton('我的项目').click();
    await flushPromises();
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(2);

    myMock.mockClear();
    listMock.mockClear();
    const input = document.body.querySelector('.wk-search') as HTMLInputElement;
    input.value = '维拉';
    input.dispatchEvent(new Event('input'));
    await flushPromises();

    // 一发请求都没有，但结果已经筛过了
    expect(myMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(document.body.querySelectorAll('.wk-card')).toHaveLength(1);
    expect(document.body.textContent).toContain('维拉的旅途');
    wrapper.unmount();
  });

  it('★ 「订阅与已装」不发请求，且已装项目一定在里面', async () => {
    const installed = [
      { ...meta({ id: 'inst1', name: '已装的' }), installState: 'installed' },
    ] as unknown as WorkshopProject[];
    const wrapper = await open(installed);

    listMock.mockClear();
    myMock.mockClear();
    scopeButton('订阅与已装').click();
    await flushPromises();

    expect(listMock).not.toHaveBeenCalled();
    expect(myMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('已装的');
    wrapper.unmount();
  });

  it('切视图先清空结果 —— 不留一个「我的项目 + 全站计数」的中间态', async () => {
    const wrapper = await open();
    expect(document.body.textContent).toContain('维拉的旅途');

    // 「我的项目」返回空 → 切过去之后旧卡片必须已经消失
    myMock.mockResolvedValue(page([]));
    scopeButton('我的项目').click();
    await flushPromises();
    expect(document.body.textContent).not.toContain('维拉的旅途');
    expect(document.body.textContent).toContain('你还没有投稿过项目');
    wrapper.unmount();
  });

  it('审核状态与拒绝原因渲染在卡片上', async () => {
    myMock.mockResolvedValue(
      page([meta({ id: 'r1', name: '被拒的' })], {
        listings: {
          r1: {
            authorId: 'a',
            authorAvatarUrl: '',
            status: 'rejected',
            reviewTarget: 'project',
            rejectReason: '与命定核心冲突',
            hasPendingDraft: false,
            visibility: true,
            updatedAt: '',
          },
        },
      }),
    );
    const wrapper = await open();
    scopeButton('我的项目').click();
    await flushPromises();

    expect(document.body.textContent).toContain('已被拒绝');
    expect(document.body.textContent).toContain('与命定核心冲突');
    wrapper.unmount();
  });

  // ═══ 删除（真机反馈 2026-08-01：原生 confirm 在内嵌浏览器里被自动关掉） ═══

  /** 让当前登录用户拥有这个项目，卡片上才会出管理动作 */
  function mineListing(id: string) {
    return {
      [id]: {
        authorId: 'me',
        authorAvatarUrl: '',
        status: 'pending',
        reviewTarget: 'project',
        rejectReason: '',
        hasPendingDraft: false,
        visibility: true,
        updatedAt: '',
      },
    };
  }

  it('★ 删除确认走应用内模态，**不碰** window.confirm', async () => {
    // 原生 confirm 在内嵌 webview 里会被直接自动关掉并返回 false，
    // 于是「删除」表现成「点了什么都没发生」—— 最难查的一种坏法
    socialState.userId = 'me';
    const nativeConfirm = vi.fn(() => true);
    vi.stubGlobal('confirm', nativeConfirm);
    try {
      myMock.mockResolvedValue(
        page([meta({ id: 'p1', name: '待审的项目' })], { listings: mineListing('p1') }),
      );
      const wrapper = await open();
      scopeButton('我的项目').click();
      await flushPromises();

      const del = [...document.body.querySelectorAll('.wk-manage-btn')].find(
        (b) => b.textContent?.trim() === '删除',
      ) as HTMLButtonElement;
      del.click();
      await flushPromises();

      // 原生对话框一次都没被叫到；确认改由应用内模态承担
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('工坊没有回收站');
      // 还没确认，一发请求都不该出去
      expect(deleteMock).not.toHaveBeenCalled();

      const confirmBtn = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '删除' && !b.classList.contains('wk-manage-btn'),
      ) as HTMLButtonElement;
      confirmBtn.click();
      await flushPromises();

      expect(deleteMock).toHaveBeenCalledWith('p1');
      // 删完要丢缓存，否则列表/详情还会端出这条已经不存在的项目
      expect(invalidateMock).toHaveBeenCalledWith('p1');
      wrapper.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('★ 回归：「编辑」转达的是上游整行，不是光一个 id', async () => {
    /*
     * 页面拿这个载荷填表单，而「提交修改」是整份 PUT。只给 id 的话，页面只能回头
     * 查本地已装库 —— 而「我的项目」里绝大多数项目根本没装过，查空就开出空表单，
     * 一提交就把上游还在的简介清成空串、标签清光。
     */
    socialState.userId = 'me';
    const row = meta({
      id: 'p1',
      name: '维拉的旅途',
      description: '一段外传，写了很久',
      version: '2.1.0',
      tags: ['剧情', '角色'],
    });
    myMock.mockResolvedValue(page([row], { listings: mineListing('p1') }));
    const wrapper = await open(); // 注意：installed 为空 —— 这个项目没在本地装过
    scopeButton('我的项目').click();
    await flushPromises();

    const edit = [...document.body.querySelectorAll('.wk-manage-btn')].find(
      (b) => b.textContent?.trim() === '编辑',
    ) as HTMLButtonElement;
    edit.click();
    await flushPromises();

    const payload = wrapper.emitted('edit')?.[0]?.[0] as WorkshopProjectMeta;
    expect(payload).toBeTruthy();
    expect(payload.id).toBe('p1');
    expect(payload.description).toBe('一段外传，写了很久');
    expect(payload.version).toBe('2.1.0');
    expect(payload.tags).toEqual(['剧情', '角色']);
    wrapper.unmount();
  });

  it('在确认框上取消：一行都不删', async () => {
    socialState.userId = 'me';
    myMock.mockResolvedValue(
      page([meta({ id: 'p1', name: '待审的项目' })], { listings: mineListing('p1') }),
    );
    const wrapper = await open();
    scopeButton('我的项目').click();
    await flushPromises();

    const del = [...document.body.querySelectorAll('.wk-manage-btn')].find(
      (b) => b.textContent?.trim() === '删除',
    ) as HTMLButtonElement;
    del.click();
    await flushPromises();

    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '取消',
    ) as HTMLButtonElement;
    cancel.click();
    await flushPromises();

    expect(deleteMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('删除失败：报出来，且项目仍在屏幕上（它并没有被删掉）', async () => {
    socialState.userId = 'me';
    deleteMock.mockResolvedValue({
      ok: false,
      error: { kind: 'http', status: 403, message: 'Permission denied', url: 'u' },
    });
    myMock.mockResolvedValue(
      page([meta({ id: 'p1', name: '待审的项目' })], { listings: mineListing('p1') }),
    );
    const wrapper = await open();
    scopeButton('我的项目').click();
    await flushPromises();

    (
      [...document.body.querySelectorAll('.wk-manage-btn')].find(
        (b) => b.textContent?.trim() === '删除',
      ) as HTMLButtonElement
    ).click();
    await flushPromises();
    (
      [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === '删除' && !b.classList.contains('wk-manage-btn'),
      ) as HTMLButtonElement
    ).click();
    await flushPromises();

    const notify = wrapper.emitted('notify') ?? [];
    expect(notify.some((c) => String(c[0]).includes('删除失败'))).toBe(true);
    expect(invalidateMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('待审的项目');
    wrapper.unmount();
  });

  it('★ 回归：逛过「我的项目」之后，「全部」的每页条数不许被带跑', async () => {
    /*
     * 真机症状（2026-08-01）：列表每次只出一个项目，「加载更多」也一次只加一个。
     * 根因是「我的项目」不分页，它回执里的 pageSize 只是「这把拿到几条」，
     * 却被无条件写进了共用的查询状态 —— 名下只有 1 个项目就把 pageSize 钉成 1。
     */
    socialState.userId = 'me';
    listMock.mockResolvedValue(page([meta()], { total: 100, pageSize: 20 }));
    const wrapper = await open();
    expect(lastQuery()).toMatchObject({ pageSize: 20 });

    // 名下只有 1 个项目
    myMock.mockResolvedValue(page([meta({ id: 'mine1' })], { total: 1, pageSize: 1 }));
    scopeButton('我的项目').click();
    await flushPromises();

    scopeButton('全部').click();
    await flushPromises();

    // 切回来仍然按 20 要，不是 1
    expect(lastQuery()).toMatchObject({ pageSize: 20 });
    wrapper.unmount();
  });
});
