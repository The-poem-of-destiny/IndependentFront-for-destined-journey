/**
 * CreateStepBasic — 消耗明细列全（C-09）与超支就地提示（C-06）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount } from '@vue/test-utils';
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
