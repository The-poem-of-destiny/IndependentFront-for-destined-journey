/**
 * WorkshopSubmitModal.vue — 投稿 / 编辑测试（Phase 4 / B4）
 *
 * 守三件事，都是「错了会在上游留下垃圾」的那种:
 *
 * 1. 🔴 **编辑已发布项目会换 id** —— 上游开草稿并返回草稿 id，后续文件必须传到
 *    新 id 上。传回旧 id 就是在改线上那一版。
 * 2. **中途失败要说清楚已经落地了什么** —— 元数据建好之后失败，重走一遍新建会
 *    留下第二个空项目。
 * 3. **新建必须带载荷** —— 只建元数据 = 工坊里一个空项目。
 *
 * client 整层 mock，**绝不发真实请求**。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import WorkshopSubmitModal from './WorkshopSubmitModal.vue';
import {
  createProject,
  invalidateWorkshopProject,
  updateProject,
  uploadProjectCover,
  uploadProjectFile,
} from '../../lib/workshop-client';

vi.mock('../../lib/workshop-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../lib/workshop-client');
  return {
    ...actual,
    createProject: vi.fn(),
    updateProject: vi.fn(),
    uploadProjectFile: vi.fn(),
    uploadProjectCover: vi.fn(),
    invalidateWorkshopProject: vi.fn(),
  };
});

const createMock = vi.mocked(createProject);
const updateMock = vi.mocked(updateProject);
const uploadMock = vi.mocked(uploadProjectFile);
const coverMock = vi.mocked(uploadProjectCover);
const invalidateMock = vi.mocked(invalidateWorkshopProject);

const OK_UPLOAD = { ok: true as const, fromCache: false, data: null };

function ack(projectId: string, isDraft = false) {
  return { ok: true as const, fromCache: false, data: { projectId, isDraft, message: '' } };
}

async function open(editing?: {
  id: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
}) {
  const wrapper = mount(WorkshopSubmitModal, {
    props: { open: false, editing },
    attachTo: document.body,
  });
  await wrapper.setProps({ open: true });
  await flushPromises();
  return wrapper;
}

function setInput(selector: string, value: string): void {
  const el = document.body.querySelector(selector) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

/** 往某个 file input 里塞一个假文件 */
function attachFile(index: number, name = 'p.json'): void {
  const inputs = [...document.body.querySelectorAll('input[type="file"]')] as HTMLInputElement[];
  const file = new File(['{}'], name, { type: 'application/json' });
  Object.defineProperty(inputs[index], 'files', { value: [file], configurable: true });
  inputs[index].dispatchEvent(new Event('change'));
}

function submitButton(): HTMLButtonElement {
  return [...document.body.querySelectorAll('button')].find((b) =>
    /投稿|提交修改|提交中/.test(b.textContent ?? ''),
  ) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  createMock.mockResolvedValue(ack('new-1'));
  updateMock.mockResolvedValue(ack('p1'));
  uploadMock.mockResolvedValue(OK_UPLOAD);
  coverMock.mockResolvedValue(OK_UPLOAD);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('WorkshopSubmitModal', () => {
  it('新建：先建元数据，再把载荷传到返回的 id 上', async () => {
    const wrapper = await open();
    setInput('.wk-input', '我的新项目');
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '我的新项目', version: '1.0.0' }),
    );
    expect(uploadMock).toHaveBeenCalledWith('new-1', 'payload', expect.anything());
    expect(wrapper.emitted('submitted')?.[0]).toEqual(['new-1']);
    wrapper.unmount();
  });

  it('★ 新建不带载荷时按钮不可点 —— 只建元数据会在工坊里留下一个空项目', async () => {
    const wrapper = await open();
    setInput('.wk-input', '有名字但没文件');
    await flushPromises();

    expect(submitButton().disabled).toBe(true);
    wrapper.unmount();
  });

  it('名字为空时按钮不可点', async () => {
    const wrapper = await open();
    attachFile(0);
    await flushPromises();
    expect(submitButton().disabled).toBe(true);
    wrapper.unmount();
  });

  it('★★ 编辑已发布项目：后续文件传到上游返回的**草稿 id**，不是入参的 id', async () => {
    // 上游对已过审的项目不原地改，而是开一份草稿并返回草稿 id
    updateMock.mockResolvedValue(ack('draft-9', true));
    const wrapper = await open({
      id: 'p1',
      name: '老项目',
      description: '',
      version: '1.0.0',
      tags: [],
    });
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(updateMock).toHaveBeenCalledWith('p1', expect.anything());
    // 🔴 这一条错了就是在改线上那一版
    expect(uploadMock).toHaveBeenCalledWith('draft-9', 'payload', expect.anything());
    expect(wrapper.emitted('submitted')?.[0]).toEqual(['draft-9']);
    wrapper.unmount();
  });

  it('编辑可以只改元数据、不传任何文件', async () => {
    const wrapper = await open({
      id: 'p1',
      name: '老项目',
      description: '',
      version: '1.0.0',
      tags: [],
    });
    submitButton().click();
    await flushPromises();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('★ 元数据那一步就失败：什么都没落地，善后话是「直接重试」', async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch', url: 'u' },
    });
    const wrapper = await open();
    setInput('.wk-input', 'x');
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(document.body.textContent).toContain('什么都还没提交');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(wrapper.emitted('submitted')).toBeUndefined();
    wrapper.unmount();
  });

  it('★ 传文件那一步失败：明确说项目已经建好了，别再走一遍新建', async () => {
    uploadMock.mockResolvedValue({
      ok: false,
      error: { kind: 'timeout', message: '超时', url: 'u' },
    });
    const wrapper = await open();
    setInput('.wk-input', 'x');
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    // 已落地的 id 要报出来，否则用户根本找不到那个半成品
    expect(document.body.textContent).toContain('new-1');
    expect(document.body.textContent).toContain('别再走一遍新建');
    expect(wrapper.emitted('submitted')).toBeUndefined();
    wrapper.unmount();
  });

  it('封面失败不影响前面几步已经完成的事实（进度条上仍是 ✓）', async () => {
    coverMock.mockResolvedValue({
      ok: false,
      error: { kind: 'http', status: 413, message: '太大', url: 'u' },
    });
    const wrapper = await open();
    setInput('.wk-input', 'x');
    attachFile(0); // payload
    attachFile(2, 'c.png'); // cover
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(document.body.querySelectorAll('.step-done').length).toBeGreaterThanOrEqual(2);
    wrapper.unmount();
  });

  it('重新打开时清空上一次的残留', async () => {
    const wrapper = await open();
    setInput('.wk-input', '上一次填的');
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await flushPromises();

    const first = document.body.querySelector('.wk-input') as HTMLInputElement;
    expect(first.value).toBe('');
    wrapper.unmount();
  });

  // ═══ 缓存失效（真机反馈 2026-08-01：改完点进去还是旧的） ═══

  it('★ 提交成功后丢掉该项目的缓存 —— 否则详情那 5 分钟 TTL 会继续端出旧副本', async () => {
    const wrapper = await open();
    setInput('.wk-input', 'x');
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(invalidateMock).toHaveBeenCalledWith('new-1');
    wrapper.unmount();
  });

  it('★ 编辑走草稿时两个 id 都要丢 —— 原项目详情里带着 hasPendingDraft', async () => {
    updateMock.mockResolvedValue(ack('draft-9', true));
    const wrapper = await open({
      id: 'p1',
      name: '老项目',
      description: '',
      version: '1.0.0',
      tags: [],
    });
    submitButton().click();
    await flushPromises();

    expect(invalidateMock).toHaveBeenCalledWith('draft-9');
    expect(invalidateMock).toHaveBeenCalledWith('p1');
    wrapper.unmount();
  });

  it('失败时不动缓存 —— 什么都没变，丢缓存只是白白多一轮请求', async () => {
    createMock.mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'x', url: 'u' },
    });
    const wrapper = await open();
    setInput('.wk-input', 'x');
    attachFile(0);
    await flushPromises();

    submitButton().click();
    await flushPromises();

    expect(invalidateMock).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
