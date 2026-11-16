// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';
import { defineComponent, h, reactive } from 'vue';
import CreatePage from '../../../../src/ui/components/create/CreatePage.vue';

let create: any;
let settings: any;
const navigate = vi.fn();
const back = vi.fn();
const openSettings = vi.fn();
vi.mock('../../../../src/ui/stores/create-store', () => ({ useCreateStore: () => create }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({ useSettingsStore: () => settings }));
vi.mock('../../../../src/ui/stores/content-store', () => ({
  useContentStore: () => ({ contentStatus: 'pack' }),
}));
const confirmDialog = vi.fn(async (_opts: { danger?: boolean }) => true);
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (opts: { danger?: boolean }) => confirmDialog(opts),
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ navigate, back, openSettings }),
}));

// Vue Test Utils 的布尔异步组件 stub 仍会调用 __asyncLoader() 来登记真实组件。
// <script setup> 会把八个异步组件识别为 Step0–Step7，按这些绑定名使用具体组件替身
// 才能在浅挂载入口截断动态 import，避免测试环境销毁后继续加载步骤依赖。
// 替身渲染真实元素：out-in <Transition> 只有在旧节点是元素时才会走 leave 钩子（滚动复位用例依赖）
const AsyncStepStub = defineComponent({
  name: 'AsyncStepStub',
  render: () => h('div', { class: 'step-stub' }),
});

function mountCreatePage(renderStubDefaultSlot = false) {
  return shallowMount(CreatePage, {
    global: {
      renderStubDefaultSlot,
      stubs: {
        // 准入页经真实的 CreateReadiness 驱动（其内部的 AppButton / AppCard 仍是浅挂载桩）
        CreateReadiness: false,
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
    generationMode: 'agent',
    contentStatus: 'ready',
    stepValid: Array(8).fill(true),
    stepMissing: { 0: [], 1: [], 2: [] },
    missingItems: [],
    initContent: vi.fn(),
    loadWorldBookEntries: vi.fn(),
    nextStep: vi.fn(),
    startJourney: vi.fn(),
    resetAll: vi.fn(),
    prevStep: vi.fn(),
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
    create.generationMode = '';
    create.currentStep = 7;
    create.startJourney
      .mockRejectedValueOnce(new Error('disk failure'))
      .mockResolvedValueOnce('new-save');
    const wrapper = mountCreatePage(true);
    await flushPromises();
    const start = wrapper
      .findAllComponents({ name: 'AppButton' })
      .find((button) => button.text() === '开始创建角色')!;
    expect(start.props('disabled')).toBe(true);
    wrapper.findComponent({ name: 'CreateReadiness' }).vm.$emit('update:generationMode', 'direct');
    await flushPromises();
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
    // 建档成功才重置草稿；失败那一次没有重置（填写要保留给重试）
    expect(create.resetAll).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
  it('missing API is explained before any character step can advance', async () => {
    const wrapper = mountCreatePage(true);
    await flushPromises();
    expect(wrapper.text()).toContain('配置 API');
    wrapper
      .findAllComponents({ name: 'AppButton' })
      .find((button) => button.text() === '配置 API')!
      .vm.$emit('click');
    expect(openSettings).toHaveBeenCalledWith('api');
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

  async function enterSteps() {
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
    return wrapper;
  }

  it('返回按钮原路返回（游戏内开新档取消后回到游戏页），不硬编码首页', async () => {
    const wrapper = mountCreatePage();
    await flushPromises();
    const btn = wrapper.find('.back-btn');
    expect(btn.text()).toContain('返回');
    await btn.trigger('click');
    expect(back).toHaveBeenCalledWith('home');
    expect(navigate).not.toHaveBeenCalled();
    // 未建档就离开：草稿保留，不重置
    expect(create.resetAll).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('下一步被禁用时向页脚传入当前步骤的缺项提示', async () => {
    create.currentStep = 1;
    create.stepValid = [true, false, true, true, true, true, true, true];
    create.stepMissing = { 0: [], 1: ['角色名', '基础属性点'], 2: [] };
    const wrapper = await enterSteps();
    const footer = wrapper.findComponent({ name: 'CreateFooter' });
    expect(footer.props('canNext')).toBe(false);
    expect(footer.props('blocked')).toEqual({
      prefix: '还需完成：',
      currentStep: 1,
      items: [
        { label: '角色名', step: 1 },
        { label: '基础属性点', step: 1 },
      ],
    });
    create.currentStep = 7;
    create.missingItems = [
      { label: '难度', step: 0 },
      { label: '命定核心', step: 2 },
      { label: '转生点数超支 50 点', step: 1 },
    ];
    await flushPromises();
    // 最后一步直接用 store 的聚合清单（含转生点数超支，C-06）
    expect(footer.props('blocked').items).toEqual([
      { label: '难度', step: 0 },
      { label: '命定核心', step: 2 },
      { label: '转生点数超支 50 点', step: 1 },
    ]);
    // 点缺项跳到所属步骤
    footer.vm.$emit('jump', 2);
    expect(create.currentStep).toBe(2);
    wrapper.unmount();
  });

  it('最终提交因必填缺失被拒时显示缺项原文', async () => {
    create.currentStep = 7;
    create.startJourney.mockRejectedValueOnce(new Error('创建前请先补全：角色名'));
    const wrapper = await enterSteps();
    wrapper.findComponent({ name: 'CreateFooter' }).vm.$emit('next');
    await flushPromises();
    expect(wrapper.find('.creation-error').text()).toContain('创建前请先补全：角色名');
    expect(navigate).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('★ 「重新开始」经确认后清空草稿并重新加载命定核心名单（H-04）', async () => {
    const wrapper = await enterSteps();
    const footer = wrapper.findComponent({ name: 'CreateFooter' });

    confirmDialog.mockResolvedValueOnce(false);
    footer.vm.$emit('restart');
    await flushPromises();
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(create.resetAll).not.toHaveBeenCalled();

    confirmDialog.mockResolvedValueOnce(true);
    footer.vm.$emit('restart');
    await flushPromises();
    expect(confirmDialog.mock.calls[1][0]).toMatchObject({ danger: true });
    expect(create.resetAll).toHaveBeenCalledTimes(1);
    expect(create.loadWorldBookEntries).toHaveBeenCalledTimes(2); // 进页一次 + 重新开始一次
    wrapper.unmount();
  });

  describe('切步骤时滚动复位', () => {
    function mountWithRealTransition() {
      return shallowMount(CreatePage, {
        global: {
          renderStubDefaultSlot: true,
          stubs: {
            CreateReadiness: false,
            Transition: false,
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
    async function accept(wrapper: ReturnType<typeof mountWithRealTransition>) {
      wrapper
        .findAllComponents({ name: 'AppButton' })
        .find((button) => button.text() === '开始创建角色')!
        .vm.$emit('click');
      await flushPromises();
    }

    beforeEach(() => {
      settings.settings.apiPool = [
        { id: 'chat', baseUrl: 'http://localhost:1234/v1', model: 'local', apiType: 'chat' },
      ];
    });

    it('点步骤条换步后，内容区滚回顶部', async () => {
      const wrapper = mountWithRealTransition();
      await flushPromises();
      await accept(wrapper);
      const main = wrapper.find('main.create-content').element as HTMLElement;
      main.scrollTop = 127;
      wrapper.findComponent({ name: 'CreateSteps' }).vm.$emit('select', 1);
      await vi.waitFor(() => expect(main.scrollTop).toBe(0));
      expect(create.currentStep).toBe(1);
      wrapper.unmount();
    });

    it('准入页滚动后点开始创建，第 1 步从顶部开始', async () => {
      const wrapper = mountWithRealTransition();
      await flushPromises();
      const main = wrapper.find('main.create-content').element as HTMLElement;
      main.scrollTop = 127;
      await accept(wrapper);
      expect(main.scrollTop).toBe(0);
      wrapper.unmount();
    });
  });
});
