// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import CreatePage from './CreatePage.vue';

let create: any;
let settings: any;
const navigate = vi.fn();
const openSettings = vi.fn();
vi.mock('../../stores/create-store', () => ({ useCreateStore: () => create }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: () => settings }));
vi.mock('../../stores/content-store', () => ({
  useContentStore: () => ({ contentStatus: 'pack' }),
}));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ({ navigate, openSettings }) }));

beforeEach(() => {
  vi.clearAllMocks();
  create = reactive({
    currentStep: 0,
    contentStatus: 'ready',
    stepValid: Array(8).fill(true),
    initContent: vi.fn(),
    loadWorldBookEntries: vi.fn(),
    nextStep: vi.fn(),
    startJourney: vi.fn(),
    plotMode: 'off',
    isCreating: false,
    showPresetModal: false,
  });
  settings = reactive({
    settings: { apiPool: [], agents: {} },
    projectAgentDefaults: { agents: {} },
    initApiSecrets: vi.fn(async () => ({ status: 'ready' })),
    loadAgentProjectDefaults: vi.fn(),
  });
});

describe('first journey readiness', () => {
  it('configured users can continue, and a creation failure stays visible for retry', async () => {
    settings.settings.apiPool = [
      { id: 'chat', baseUrl: 'http://localhost:1234/v1', model: 'local', apiType: 'chat' },
    ];
    create.currentStep = 7;
    create.startJourney
      .mockRejectedValueOnce(new Error('disk failure'))
      .mockResolvedValueOnce('new-save');
    const wrapper = shallowMount(CreatePage, { global: { renderStubDefaultSlot: true } });
    await flushPromises();
    const start = wrapper
      .findAllComponents({ name: 'AppButton' })
      .find((button) => button.text() === '开始创建角色')!;
    expect(start.props('disabled')).toBe(false);
    start.vm.$emit('click');
    await flushPromises();
    wrapper.findComponent({ name: 'CreateFooter' }).vm.$emit('next');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('你的填写仍在');
    expect(navigate).not.toHaveBeenCalled();
    wrapper.findComponent({ name: 'CreateFooter' }).vm.$emit('next');
    await flushPromises();
    expect(navigate).toHaveBeenCalledWith('game', 'new-save');
    wrapper.unmount();
  });
  it('missing API is explained before any character step can advance', async () => {
    const wrapper = shallowMount(CreatePage);
    await flushPromises();
    expect(wrapper.text()).toContain('配置 API');
    expect(wrapper.findComponent({ name: 'CreateFooter' }).exists()).toBe(false);
    expect(create.nextStep).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
