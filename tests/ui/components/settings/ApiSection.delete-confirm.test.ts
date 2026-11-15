/**
 * S-09：删除 API 源 / 图像连接前必须确认，并列出正在用它的配置。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

const state = vi.hoisted(() => ({
  settings: null as unknown as Record<string, any>,
  sourceStore: null as unknown as Record<string, any>,
  toast: vi.fn(),
}));
const confirmDialog = vi.hoisted(() => vi.fn(async (_options: Record<string, unknown>) => true));

vi.mock('@ui/lib/confirm-dialog', () => ({ confirmDialog }));
vi.mock('@ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: state.settings,
    apiRpmPolicies: [],
    apiRpmPoliciesError: null,
    apiSecretsError: null,
    updateRpmPolicy: vi.fn(),
  }),
}));
vi.mock('@ui/stores/api-source-store', async (importActual) => {
  const actual = await importActual<typeof import('@ui/stores/api-source-store')>();
  return { ...actual, useApiSourceStore: () => state.sourceStore };
});
vi.mock('@ui/stores/ui-store', () => ({ useUIStore: () => ({ toast: state.toast }) }));
vi.mock('@engine/api/api-rpm-limiter', () => ({
  credentialIdFor: async ({ baseUrl }: { baseUrl: string }) => `cred:${baseUrl}`,
}));

import ApiSection from '@ui/components/settings/ApiSection.vue';
import ImageConnectionCard from '@ui/components/settings/image/ImageConnectionCard.vue';

const llmA = {
  id: 'a',
  name: '主力 API',
  baseUrl: 'https://a.test',
  apiKey: 'k',
  model: 'm',
  kind: 'llm',
};
const llmB = {
  id: 'b',
  name: '备用 API',
  baseUrl: 'https://b.test',
  apiKey: 'k',
  model: 'm',
  kind: 'llm',
};

beforeEach(() => {
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  state.toast.mockReset();
  state.settings = reactive({
    apiPool: [llmA, llmB],
    agents: { story: { model: 'a' }, image_prompt: { model: 'a' }, vars_update: { model: 'b' } },
    embeddingSourceId: '',
    rerankerSourceId: 'a',
    imageNovelai: { endpointId: 'nai-1' },
    imageComfy: { baseUrl: '' },
  });
  state.sourceStore = reactive({
    sources: [],
    imageConnections: [
      { id: 'nai-1', name: '我的 NAI', provider: 'novelai', baseUrl: 'https://nai', apiKey: 'x' },
      { id: 'nai-2', name: '备用 NAI', provider: 'novelai', baseUrl: 'https://nai', apiKey: 'y' },
    ],
    invalidSourceIds: [],
    initialize: vi.fn(async () => undefined),
    removeSource: vi.fn(async () => undefined),
    removeImageConnection: vi.fn(async () => undefined),
  });
});

function deleteButtonOf(wrapper: ReturnType<typeof mount>, name: string) {
  const card = wrapper.findAll('.api-card-body').find((el) => el.text().includes(name))!;
  return card.findAll('button').find((b) => b.text() === '删除')!;
}

describe('ApiSection 删除 API 源', () => {
  it('先确认，并列出正在显式使用它的 Agent 与检索绑定；说明删后改为跟随默认', async () => {
    const wrapper = mount(ApiSection);
    await flushPromises();
    await deleteButtonOf(wrapper, '主力 API').trigger('click');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    const options = confirmDialog.mock.calls[0][0] as unknown as {
      message: string;
      details: string[];
      danger: boolean;
    };
    expect(options.danger).toBe(true);
    expect(options.details).toEqual([
      'Agent：正文生成',
      'Agent：图像提示词生成',
      '记忆：Reranker 重排',
    ]);
    expect(options.message).toContain('跟随默认');
    expect(options.message).toContain('备用 API');
    expect(state.sourceStore.removeSource).toHaveBeenCalledWith('a');
  });

  it('取消 → 什么都不删', async () => {
    confirmDialog.mockResolvedValue(false);
    const wrapper = mount(ApiSection);
    await flushPromises();
    await deleteButtonOf(wrapper, '备用 API').trigger('click');
    await flushPromises();
    expect(state.sourceStore.removeSource).not.toHaveBeenCalled();
  });
});

describe('ImageConnectionCard 删除图像连接', () => {
  it('删的是当前出图用的连接 → 弹窗说明；确认后删除并清掉选择', async () => {
    const wrapper = mount(ImageConnectionCard);
    await flushPromises();
    const row = wrapper.findAll('.connection-row').find((el) => el.text().includes('我的 NAI'))!;
    await row
      .findAll('button')
      .find((b) => b.text() === '删除')!
      .trigger('click');
    await flushPromises();
    const options = confirmDialog.mock.calls[0][0] as unknown as {
      message: string;
      danger: boolean;
    };
    expect(options.danger).toBe(true);
    expect(options.message).toContain('当前出图使用的连接');
    expect(state.sourceStore.removeImageConnection).toHaveBeenCalledWith('nai-1');
    expect(state.settings.imageNovelai.endpointId).toBeNull();
  });

  it('取消 → 不删；删除失败 → 报错且不清选择', async () => {
    confirmDialog.mockResolvedValueOnce(false);
    const wrapper = mount(ImageConnectionCard);
    await flushPromises();
    const del = () =>
      wrapper
        .findAll('.connection-row')
        .find((el) => el.text().includes('我的 NAI'))!
        .findAll('button')
        .find((b) => b.text() === '删除')!
        .trigger('click');
    await del();
    await flushPromises();
    expect(state.sourceStore.removeImageConnection).not.toHaveBeenCalled();

    state.sourceStore.removeImageConnection.mockRejectedValueOnce(new Error('写入失败'));
    await del();
    await flushPromises();
    expect(state.toast).toHaveBeenCalledWith(expect.stringContaining('写入失败'), 'error');
    expect(state.settings.imageNovelai.endpointId).toBe('nai-1');
  });
});
