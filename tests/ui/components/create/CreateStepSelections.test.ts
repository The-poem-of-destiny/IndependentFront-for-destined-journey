/**
 * CreateStepSelections — 选择步骤经 store 统一闸门添加（C-05）与自定义物品的超支提示（C-06）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { reactive } from 'vue';
import CreateStepSelections from '../../../../src/ui/components/create/CreateStepSelections.vue';
import type { CatalogItem } from '@engine/content/start-catalog';

let mockCreate: any;

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));

const cheap: CatalogItem = {
  id: 'e_剑类_铁剑',
  name: '铁剑',
  category: 'equipment',
  type: '武器',
  rarity: 'common',
  tag: [],
  effect: {},
  description: '',
  cost: 10,
};
const pricey: CatalogItem = { ...cheap, id: 'e_剑类_神兵', name: '神兵', cost: 5000 };

beforeEach(() => {
  mockCreate = reactive({
    activeCategory: 'equipment',
    rarityFilter: 'all',
    typeFilter: 'all',
    subCategories: [],
    filteredPool: [cheap, pricey],
    selectedEquipments: [],
    selectedItems: [],
    selectedSkills: [],
    equipmentCost: 0,
    itemCost: 0,
    skillCost: 0,
    remainingPoints: 100,
    isSelected: () => false,
    canSelect: (i: CatalogItem) => i.cost <= 100,
    selectBlockReason: (i: CatalogItem) =>
      i.cost <= 100 ? null : `点数不足，还差 ${i.cost - 100} 点`,
    selectCatalogItem: vi.fn(() => true),
    addEquipment: vi.fn(),
  });
});

function mountStep() {
  return shallowMount(CreateStepSelections, {
    global: { stubs: { CategorySelectionLayout: false } },
  });
}

describe('CreateStepSelections — 选择闸门（C-05）', () => {
  it('卡片拿到禁用态与可见原因', () => {
    const wrapper = mountStep();
    const cards = wrapper.findAllComponents({ name: 'SelectableCard' });
    expect(cards).toHaveLength(2);
    expect(cards[0].props('disabled')).toBe(false);
    expect(cards[0].props('disabledReason')).toBeNull();
    expect(cards[1].props('disabled')).toBe(true);
    expect(cards[1].props('disabledReason')).toBe('点数不足，还差 4900 点');
  });

  it('★ 选择经 store.selectCatalogItem，而不是直接 add*', () => {
    const wrapper = mountStep();
    wrapper.findAllComponents({ name: 'SelectableCard' })[1].vm.$emit('select', pricey);
    expect(mockCreate.selectCatalogItem).toHaveBeenCalledWith(pricey);
    expect(mockCreate.addEquipment).not.toHaveBeenCalled();
  });

  it('自定义物品表单拿到当前可用点数（C-06 就地超支提示）', () => {
    const wrapper = mountStep();
    expect(wrapper.findComponent({ name: 'CustomItemForm' }).props('availablePoints')).toBe(100);
  });
});
