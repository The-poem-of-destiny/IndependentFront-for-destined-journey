/**
 * CreateStepBasic — 消耗明细列全（C-09）与超支就地提示（C-06）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import CreateStepBasic from '../../../../src/ui/components/create/CreateStepBasic.vue';

let mockCreate: any;

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));

beforeEach(() => {
  mockCreate = reactive({
    GENDER_OPTIONS: ['男', '女'],
    raceOptions: [],
    identityOptions: [],
    flatLocationOptions: [],
    race: '人类',
    identity: '非贵族平民',
    startLocation: '',
    level: 5,
    tier: 2,
    tierName: '中坚',
    tierBonus: 1,
    basePoints: {},
    attributePoints: {},
    finalAttributes: {},
    BP_PER_ATTR_MAX: 6,
    MAX_BP: 25,
    usedBP: 25,
    remainingBP: 0,
    usedAP: 4,
    maxAP: 4,
    remainingAP: 0,
    hpPreview: 10,
    mpPreview: 10,
    spPreview: 10,
    raceCost: 0,
    identityCost: 10,
    levelCost: 20,
    moneyCost: 3,
    destinyCost: 5,
    equipmentCost: 30,
    itemCost: 0,
    skillCost: 0,
    totalCost: 72,
    reincarnationPoints: 1000,
    overspentPoints: 0,
    addBasePoint: vi.fn(),
    removeBasePoint: vi.fn(),
    setBasePoint: vi.fn(),
    distributeBasePointsEvenly: vi.fn(),
    randomizeBasePoints: vi.fn(),
    resetBasePoints: vi.fn(),
  });
});

describe('CreateStepBasic — 消耗明细', () => {
  it('★ 列出等级、额外属性点、金钱、命运点数的花费与合计（C-09）', () => {
    const text = shallowMount(CreateStepBasic).find('.cost-summary').text();
    expect(text).toContain('等级 Lv.5 20点');
    expect(text).toContain('额外属性点 4点');
    expect(text).toContain('金钱 3点');
    expect(text).toContain('命运点数 5点');
    expect(text).toContain('合计 72 / 1000 点');
  });

  it('未超支时不显示超支提示', () => {
    const wrapper = shallowMount(CreateStepBasic);
    expect(wrapper.find('.cost-over').exists()).toBe(false);
  });

  it('★ 超支时在明细处写出超支额与调整方向（C-06）', () => {
    mockCreate.overspentPoints = 120;
    const wrapper = shallowMount(CreateStepBasic);
    expect(wrapper.find('.cost-summary').classes()).toContain('over');
    expect(wrapper.find('.cost-over').text()).toContain('转生点数超支 120');
    expect(wrapper.find('.cost-over').text()).toContain('无法创建角色');
  });
});

describe('CreateStepBasic — 基础点快捷分配', () => {
  // 只挂真 AppButton，其余子组件仍 stub（mount 才点得到 <button>）
  const mountQuick = () =>
    mount(CreateStepBasic, {
      global: {
        stubs: {
          FormInput: true,
          FormSelect: true,
          FormStepper: true,
          ResourceBar: true,
          AttributeEditor: true,
        },
      },
    });

  it('渲染平均分配 / 随机分配 / 重置三个按钮', () => {
    const quick = mountQuick().find('[data-test="bp-quick"]');
    expect(quick.text()).toContain('平均分配');
    expect(quick.text()).toContain('随机分配');
    expect(quick.text()).toContain('重置');
  });

  it('剩余为 0 时禁用平均分配；已用为 0 时禁用重置；随机分配始终可用', () => {
    mockCreate.remainingBP = 0;
    mockCreate.usedBP = 25;
    let wrapper = mountQuick();
    expect(wrapper.find('[data-test="bp-even"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="bp-reset"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="bp-random"]').attributes('disabled')).toBeUndefined();

    mockCreate.remainingBP = 25;
    mockCreate.usedBP = 0;
    wrapper = mountQuick();
    expect(wrapper.find('[data-test="bp-even"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="bp-reset"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-test="bp-random"]').attributes('disabled')).toBeUndefined();
  });

  it('点击按钮调用对应 store 动作；随机分配不把点击事件当 rng 传入', async () => {
    mockCreate.remainingBP = 10;
    mockCreate.usedBP = 15;
    const wrapper = mountQuick();
    await wrapper.find('[data-test="bp-even"]').trigger('click');
    await wrapper.find('[data-test="bp-random"]').trigger('click');
    await wrapper.find('[data-test="bp-reset"]').trigger('click');
    expect(mockCreate.distributeBasePointsEvenly).toHaveBeenCalledTimes(1);
    expect(mockCreate.randomizeBasePoints).toHaveBeenCalledTimes(1);
    expect(mockCreate.randomizeBasePoints).toHaveBeenCalledWith();
    expect(mockCreate.resetBasePoints).toHaveBeenCalledTimes(1);
  });

  it('基础列 AttributeEditor 带 editable，额外列不带', () => {
    const wrapper = shallowMount(CreateStepBasic);
    const editors = (sel: string) =>
      wrapper.findAll(sel).map((td) => td.findComponent({ name: 'AttributeEditor' }));
    const bpEditors = editors('.attr-bp');
    const apEditors = editors('.attr-ap');
    expect(bpEditors.length).toBe(5);
    expect(apEditors.length).toBe(5);
    expect(bpEditors.every((w) => w.props('editable') === true)).toBe(true);
    expect(apEditors.every((w) => !w.props('editable'))).toBe(true);
  });
});

describe('CreateStepBasic — 初始等级上限', () => {
  it('★ 等级步进器上限为 Lv.10，并提示「初始等级最高 Lv.10」', () => {
    const wrapper = shallowMount(CreateStepBasic);
    const stepper = wrapper
      .findAllComponents({ name: 'FormStepper' })
      .find((w) => w.props('label') === '等级')!;
    expect(stepper.props('max')).toBe(10);
    expect(wrapper.find('[data-test="level-cap-hint"]').text()).toBe('初始等级最高 Lv.10');
  });
});
