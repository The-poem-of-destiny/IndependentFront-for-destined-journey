// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { defineComponent, reactive } from 'vue';
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

// Vue Test Utils 的布尔异步组件 stub 仍会调用 __asyncLoader() 来登记真实组件。
// <script setup> 会把八个异步组件识别为 Step0–Step7，按这些绑定名使用具体组件替身
// 才能在浅挂载入口截断动态 import，避免测试环境销毁后继续加载步骤依赖。
const AsyncStepStub = defineComponent({
  name: 'AsyncStepStub',
  render: () => null,
});

function mountCreatePage(renderStubDefaultSlot = false) {
  return shallowMount(CreatePage, {
    global: {
      renderStubDefaultSlot,
      stubs: {
        Step0: AsyncStepStub,
        Step1: AsyncStepStub,
        Step2: AsyncStepStub,
        Step3: AsyncStepStub,
        Step4: AsyncStepStub,
        Step5: AsyncStepStub,
        Step6: AsyncStepStub,
        Step7: AsyncStepStub,
      },
    },
  });
}

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
    const wrapper = mountCreatePage(true);
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
    const wrapper = mountCreatePage();
    await flushPromises();
    expect(wrapper.text()).toContain('配置 API');
    expect(wrapper.findComponent({ name: 'CreateFooter' }).exists()).toBe(false);
    expect(create.nextStep).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('clicking a step indicator jumps directly to that step', async () => {
    settings.settings.apiPool = [
      { id: 'chat', baseUrl: 'http://localhost:1234/v1', model: 'local', apiType: 'chat' },
    ];
    const wrapper = mountCreatePage(true);
    await flushPromises();
    wrapper
      .findAllComponents({ name: 'AppButton' })
      .find((button) => button.text() === '开始创建角色')!
      .vm.$emit('click');
    await flushPromises();

    wrapper.findComponent({ name: 'CreateSteps' }).vm.$emit('select', 6);

    expect(create.currentStep).toBe(6);
    wrapper.unmount();
  });
});
