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
import { createPinia, setActivePinia } from 'pinia';
import type { WorkshopProjectMeta } from '@engine/workshop-types';
import type { WorkshopProject } from '@engine/types';
import WorkshopBrowseModal from './WorkshopBrowseModal.vue';
import { listProjects } from '../../lib/workshop-client';

vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return { ...actual, listProjects: vi.fn() };
});

const listMock = vi.mocked(listProjects);

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

function page(projects: WorkshopProjectMeta[], over: Record<string, number> = {}) {
  return {
    ok: true as const,
    fromCache: false,
    data: {
      total: projects.length,
      page: 0,
      pageSize: 20,
      projects,
      droppedCount: 0,
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

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  listMock.mockResolvedValue(page([meta()]));
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

    // 先翻到第 2 页，再改排序 —— 排序在服务端做，停在第 2 页会排出自相矛盾的结果
    const next = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '下一页',
    ) as HTMLButtonElement;
    next.click();
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

  it('翻页把 page 传给 client；首页的「上一页」不可点', async () => {
    listMock.mockResolvedValue(page([meta()], { total: 60, pageSize: 20 }));
    const wrapper = await open();
    listMock.mockClear();

    const buttons = [...document.body.querySelectorAll('.wk-pager button')] as HTMLButtonElement[];
    const prev = buttons.find((b) => b.textContent?.includes('上一页'))!;
    const next = buttons.find((b) => b.textContent?.includes('下一页'))!;
    expect(prev.disabled).toBe(true);

    next.click();
    await flushPromises();
    expect(lastQuery()).toMatchObject({ page: 1 });
    expect(document.body.textContent).toContain('第 2 / 3 页');
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

  it('网络失败：说人话 + 给重试 + 指出本地导入这条后路', async () => {
    listMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    const wrapper = await open();

    const box = document.body.querySelector('.wk-failure');
    expect(box).toBeTruthy();
    expect(box!.textContent).toContain('连不上创意工坊');
    expect(box!.textContent).toContain('Failed to fetch');
    expect(box!.textContent).toContain('project-xxx.json');

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
});
