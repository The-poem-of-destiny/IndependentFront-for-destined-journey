/**
 * WorkshopAdminModal.vue — 审核面板测试（Phase 4 / B5）
 *
 * 守三件事:
 * 1. **驳回必须带理由** —— 不带的话作者只看到「已被拒绝」，无从改起。这一条在
 *    客户端拦，是为了少一次注定要被作者追问的驳回，不是安全措施。
 * 2. **超管专属的两个 Tab 对普通管理员不出现** —— 上游对它们额外做了 isSuperAdmin
 *    校验，画出来只会得到 403。
 * 3. **处理完的项目立刻离开队列** —— 不等整体重拉，队列长时那一下很慢。
 *
 * client 整层 mock，**绝不发真实请求**。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import WorkshopAdminModal from './WorkshopAdminModal.vue';
import {
  listAdminLogs,
  listAdmins,
  listPendingProjects,
  reviewProject,
  setAdmin,
} from '../../lib/workshop-client';
import type { WorkshopProjectMeta } from '@engine/workshop-types';

vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return {
    ...actual,
    listPendingProjects: vi.fn(),
    listAdmins: vi.fn(),
    listAdminLogs: vi.fn(),
    reviewProject: vi.fn(),
    setAdmin: vi.fn(),
  };
});

const pendingMock = vi.mocked(listPendingProjects);
const adminsMock = vi.mocked(listAdmins);
const logsMock = vi.mocked(listAdminLogs);
const reviewMock = vi.mocked(reviewProject);
const setAdminMock = vi.mocked(setAdmin);

// social store：只需要 user.isSuperAdmin
const socialState = reactive<{ superAdmin: boolean }>({ superAdmin: false });
vi.mock('../../stores/workshop-social-store', () => ({
  useWorkshopSocialStore: () => ({
    get user() {
      return { userId: 'me', isAdmin: true, isSuperAdmin: socialState.superAdmin };
    },
  }),
}));

function meta(over: Partial<WorkshopProjectMeta> = {}): WorkshopProjectMeta {
  return {
    id: 'p1',
    rootProjectId: 'r1',
    name: '待审的项目',
    description: '简介',
    version: '1.0.0',
    authorName: '投稿人',
    tags: ['系统'],
    coverUrl: undefined,
    downloadUrl: 'https://example.invalid/p1.json',
    fileSize: 1024,
    ...over,
  };
}

function pendingPage(projects: WorkshopProjectMeta[]) {
  return {
    ok: true as const,
    fromCache: false,
    data: {
      total: projects.length,
      page: 0,
      pageSize: projects.length,
      projects,
      droppedCount: 0,
      socials: {},
      listings: {},
    },
  };
}

async function open() {
  const wrapper = mount(WorkshopAdminModal, { props: { open: false }, attachTo: document.body });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

function bodyButton(label: string): HTMLButtonElement {
  return [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  socialState.superAdmin = false;
  pendingMock.mockResolvedValue(pendingPage([meta()]));
  adminsMock.mockResolvedValue({ ok: true, fromCache: false, data: [] });
  logsMock.mockResolvedValue({ ok: true, fromCache: false, data: [] });
  reviewMock.mockResolvedValue({ ok: true, fromCache: false, data: null });
  setAdminMock.mockResolvedValue({ ok: true, fromCache: false, data: null });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkshopAdminModal', () => {
  it('打开即拉待审核队列并渲染', async () => {
    const wrapper = await open();
    expect(pendingMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('待审的项目');
    expect(document.body.textContent).toContain('投稿人');
    wrapper.unmount();
  });

  it('通过：带 approve 调上游，且该项目立刻离开队列', async () => {
    const wrapper = await open();
    bodyButton('通过').click();
    await flushPromises();

    expect(reviewMock).toHaveBeenCalledWith('p1', 'approve', '');
    // 不等整体重拉 —— 队列长时那一下很慢
    expect(pendingMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('待审的项目');
    wrapper.unmount();
  });

  it('★ 驳回不填理由：一发请求都不出去，且明说要填理由', async () => {
    const wrapper = await open();
    bodyButton('驳回').click();
    await flushPromises();

    expect(reviewMock).not.toHaveBeenCalled();
    expect(wrapper.emitted('notify')?.[0]?.[0]).toContain('理由');
    wrapper.unmount();
  });

  it('驳回填了理由：理由如实带给上游（作者要靠它知道改什么）', async () => {
    const wrapper = await open();
    const reason = document.body.querySelector('.wk-admin-reason') as HTMLInputElement;
    reason.value = '与命定核心冲突';
    reason.dispatchEvent(new Event('input'));
    await flushPromises();

    bodyButton('驳回').click();
    await flushPromises();

    expect(reviewMock).toHaveBeenCalledWith('p1', 'reject', '与命定核心冲突');
    wrapper.unmount();
  });

  it('★ 普通管理员看不到超管专属的两个 Tab', async () => {
    const wrapper = await open();
    const tabs = [...document.body.querySelectorAll('.wk-admin-tab')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['待审核']);
    wrapper.unmount();
  });

  it('超管能看到管理员与日志两个 Tab，并各自拉各自的数据', async () => {
    socialState.superAdmin = true;
    const wrapper = await open();
    const tabs = [...document.body.querySelectorAll('.wk-admin-tab')].map((t) =>
      t.textContent?.trim(),
    );
    expect(tabs).toEqual(['待审核', '管理员', '操作日志']);

    bodyButton('管理员').click();
    await flushPromises();
    expect(adminsMock).toHaveBeenCalledTimes(1);

    bodyButton('操作日志').click();
    await flushPromises();
    expect(logsMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('授予管理员：id 传给上游后重拉名册', async () => {
    socialState.superAdmin = true;
    const wrapper = await open();
    bodyButton('管理员').click();
    await flushPromises();
    adminsMock.mockClear();

    const input = document.body.querySelector('.wk-admin-reason') as HTMLInputElement;
    input.value = '123456';
    input.dispatchEvent(new Event('input'));
    await flushPromises();

    bodyButton('授予管理员').click();
    await flushPromises();

    expect(setAdminMock).toHaveBeenCalledWith('123456', true);
    expect(adminsMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('403 之类的失败说人话，不是空白面板', async () => {
    pendingMock.mockResolvedValue({
      ok: false,
      error: { kind: 'http', status: 403, message: 'Admin only', url: 'u' },
    });
    const wrapper = await open();
    expect(document.body.querySelector('.wk-admin-failure')).not.toBeNull();
    wrapper.unmount();
  });

  it('队列为空时说清楚是空的，而不是留一片白', async () => {
    pendingMock.mockResolvedValue(pendingPage([]));
    const wrapper = await open();
    expect(document.body.textContent).toContain('队列是空的');
    wrapper.unmount();
  });
});
