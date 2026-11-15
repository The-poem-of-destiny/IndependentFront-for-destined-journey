/**
 * CreateStepDifficulty — 花完点后换成更低难度时就地提示超支（C-06）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { reactive } from 'vue';
import CreateStepDifficulty from '../../../../src/ui/components/create/CreateStepDifficulty.vue';

let mockCreate: any;

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));

beforeEach(() => {
  mockCreate = reactive({
    difficulty: { id: 'hell', label: '地狱', points: 100 },
    selectDifficulty: vi.fn(),
    totalCost: 100,
    overspentPoints: 0,
  });
});

describe('CreateStepDifficulty — 超支提示', () => {
  it('未超支时不提示', () => {
    expect(shallowMount(CreateStepDifficulty).find('.overspent-hint').exists()).toBe(false);
  });

  it('★ 已花费超过所选难度的点数时写出超支额', () => {
    mockCreate.totalCost = 150;
    mockCreate.overspentPoints = 50;
    const hint = shallowMount(CreateStepDifficulty).find('.overspent-hint');
    expect(hint.text()).toContain('已花费 150 点');
    expect(hint.text()).toContain('超出本难度');
    expect(hint.text()).toContain('50 点');
  });
});
