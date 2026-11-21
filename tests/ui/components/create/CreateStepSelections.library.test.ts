/**
 * CreateStepSelections — 「我的自定义」全局库的接线
 *
 * 真库 store（真 Dexie + fake-indexeddb）+ 替身 create-store（卡片池 = 库条目 + 一条目录条目）。
 * 覆盖：挂载即重读（同一 Pinia 下库被外部改写后重挂载能看到新行）、勾选保存后重挂载仍在「我的自定义」、不勾选绝不碰库、
 * 删除只从库里删（已选副本保持选中）、取消删除、存库失败 toast、编辑时 inLibrary 透传。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shallowMount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { getCreateCustomItems, getDatabase } from '@engine/persistence/database';
import type { CatalogItem } from '@engine/content/start-catalog';
import CreateStepSelections from '../../../../src/ui/components/create/CreateStepSelections.vue';
import { useCreateCustomLibraryStore } from '../../../../src/ui/stores/create-custom-library-store';

let mockCreate: any;
const toast = vi.fn();
const confirmDialog = vi.fn();

vi.mock('../../../../src/ui/stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ toast }),
}));
vi.mock('../../../../src/ui/lib/confirm-dialog', () => ({
  confirmDialog: (...args: unknown[]) => confirmDialog(...args),
}));

const catalogSword: CatalogItem = {
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

function mkCustom(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: 'custom_equipment_aaaa0001',
    name: '自制短剑',
    category: 'equipment',
    type: '武器',
    rarity: 'rare',
    tag: [],
    effect: {},
    description: '玩家自己打的短剑',
    cost: 30,
    ...overrides,
  };
}

function makeCreateMock() {
  return reactive({
    activeCategory: 'equipment',
    rarityFilter: 'all',
    typeFilter: 'all',
    subCategories: [],
    // 与真 create-store 同口径：库条目并进池子（「我的自定义」组）
    get filteredPool() {
      return [...useCreateCustomLibraryStore().byCategory('equipment'), catalogSword];
    },
    selectedEquipments: [] as CatalogItem[],
    selectedItems: [],
    selectedSkills: [],
    equipmentCost: 0,
    itemCost: 0,
    skillCost: 0,
    remainingPoints: 100,
    isSelected(i: CatalogItem) {
      return this.selectedEquipments.some((e: CatalogItem) => e.id === i.id);
    },
    canSelect: () => true,
    selectBlockReason: () => null,
    selectCatalogItem: vi.fn(() => true),
    addEquipment: vi.fn(),
    updateEquipment: vi.fn(),
    removeEquipment: vi.fn(),
  });
}

const mounted: VueWrapper[] = [];
function mountStep() {
  const wrapper = shallowMount(CreateStepSelections, {
    global: { stubs: { CategorySelectionLayout: false } },
  });
  mounted.push(wrapper);
  return wrapper;
}

function cardFor(wrapper: VueWrapper, id: string) {
  return wrapper
    .findAllComponents({ name: 'SelectableCard' })
    .find((c) => (c.props('item') as CatalogItem).id === id);
}

/** 模拟刷新页面：换一个 Pinia（库 store 的内存与 init 标志都清掉），再挂载 */
async function remount() {
  mounted.splice(0).forEach((w) => w.unmount());
  setActivePinia(createPinia());
  const wrapper = mountStep();
  await vi.waitFor(() => expect(useCreateCustomLibraryStore().loading).toBe(false));
  return wrapper;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await getDatabase().createCustomItems.clear();
  mockCreate = makeCreateMock();
  toast.mockReset();
  confirmDialog.mockReset();
});

afterEach(async () => {
  mounted.splice(0).forEach((w) => w.unmount());
  await getDatabase().createCustomItems.clear();
});

describe('CreateStepSelections — 我的自定义库', () => {
  it('★ 同一 Pinia（不刷新页面）库被外部改写后，重挂载显示新行', async () => {
    const lib = useCreateCustomLibraryStore();
    await lib.save(mkCustom());
    const first = mountStep();
    await vi.waitFor(() => expect(cardFor(first, 'custom_equipment_aaaa0001')).toBeTruthy());
    mounted.splice(0).forEach((w) => w.unmount());

    // 整库备份导入：直接换掉库内容，store 内存仍是旧的
    const db = getDatabase();
    await db.createCustomItems.clear();
    const imported = mkCustom({ id: 'custom_equipment_imp00001', name: '导入的长剑' });
    await db.createCustomItems.put({
      id: imported.id,
      category: imported.category,
      name: imported.name,
      createdAt: 1,
      updatedAt: 1,
      data: imported,
    });

    const again = mountStep();
    await vi.waitFor(() => expect(cardFor(again, imported.id)).toBeTruthy());
    expect(cardFor(again, 'custom_equipment_aaaa0001')).toBeUndefined();
  });

  it('挂载即读库：库里已有的条目出现在池里且可删除，目录条目不可删除', async () => {
    const lib = useCreateCustomLibraryStore();
    await lib.save(mkCustom());
    const wrapper = await remount();
    await vi.waitFor(() => expect(cardFor(wrapper, 'custom_equipment_aaaa0001')).toBeTruthy());
    expect(cardFor(wrapper, 'custom_equipment_aaaa0001')!.props('deletable')).toBe(true);
    expect(cardFor(wrapper, catalogSword.id)!.props('deletable')).toBe(false);
  });

  it('★ 勾选「保存到我的自定义库」：加进本次配置，且重挂载后仍在「我的自定义」', async () => {
    const wrapper = mountStep();
    const item = mkCustom();
    wrapper.findComponent({ name: 'CustomItemForm' }).vm.$emit('save', item, { toLibrary: true });
    expect(mockCreate.addEquipment).toHaveBeenCalledWith(item);
    await vi.waitFor(async () => expect(await getCreateCustomItems()).toHaveLength(1));

    const again = await remount();
    await vi.waitFor(() => expect(cardFor(again, item.id)).toBeTruthy());
    expect(cardFor(again, item.id)!.props('deletable')).toBe(true);
  });

  it('★ 不勾选：只加进本次配置，绝不碰库', async () => {
    const wrapper = mountStep();
    const lib = useCreateCustomLibraryStore();
    const saveSpy = vi.spyOn(lib, 'save');
    const item = mkCustom();
    wrapper.findComponent({ name: 'CustomItemForm' }).vm.$emit('save', item, { toLibrary: false });
    expect(mockCreate.addEquipment).toHaveBeenCalledWith(item);
    expect(saveSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(await getCreateCustomItems()).toHaveLength(0);
  });

  it('编辑库里的条目并勾选：更新库里那份（同 id 替换，不新增）', async () => {
    const lib = useCreateCustomLibraryStore();
    const original = mkCustom();
    await lib.save(original);
    const wrapper = mountStep();
    wrapper.findComponent({ name: 'SelectedPanel' }).vm.$emit('edit-equipment', original);
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'CustomItemForm' }).props('inLibrary')).toBe(true);

    const edited = { ...original, cost: 45 };
    wrapper.findComponent({ name: 'CustomItemForm' }).vm.$emit('save', edited, { toLibrary: true });
    expect(mockCreate.updateEquipment).toHaveBeenCalledWith(edited);
    await vi.waitFor(async () => {
      const rows = await getCreateCustomItems();
      expect(rows).toHaveLength(1);
      expect(rows[0].data.cost).toBe(45);
    });
  });

  it('编辑不在库里的条目时 inLibrary 为 false', async () => {
    const wrapper = mountStep();
    wrapper.findComponent({ name: 'SelectedPanel' }).vm.$emit('edit-equipment', mkCustom());
    await wrapper.vm.$nextTick();
    expect(wrapper.findComponent({ name: 'CustomItemForm' }).props('inLibrary')).toBe(false);
  });

  it('存库失败时 toast 报错（本次配置照常加入）', async () => {
    const wrapper = mountStep();
    const bad = { ...catalogSword, name: '改过的铁剑' }; // 非 custom_ id，库拒收
    wrapper.findComponent({ name: 'CustomItemForm' }).vm.$emit('save', bad, { toLibrary: true });
    expect(mockCreate.addEquipment).toHaveBeenCalledWith(bad);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(await getCreateCustomItems()).toHaveLength(0);
  });

  it('★ 删除：确认后只从库里删，已选中的副本保持选中', async () => {
    const lib = useCreateCustomLibraryStore();
    const item = mkCustom();
    await lib.save(item);
    mockCreate.selectedEquipments.push({ ...item });
    const wrapper = mountStep();
    confirmDialog.mockResolvedValue(true);

    cardFor(wrapper, item.id)!.vm.$emit('delete', item);
    await vi.waitFor(() => expect(lib.has(item.id)).toBe(false));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
    expect(await getCreateCustomItems()).toHaveLength(0);
    await wrapper.vm.$nextTick();
    expect(cardFor(wrapper, item.id)).toBeUndefined();
    expect(mockCreate.removeEquipment).not.toHaveBeenCalled();
    expect(mockCreate.selectedEquipments.map((e: CatalogItem) => e.id)).toEqual([item.id]);
  });

  it('取消删除时库不变', async () => {
    const lib = useCreateCustomLibraryStore();
    const item = mkCustom();
    await lib.save(item);
    const wrapper = mountStep();
    confirmDialog.mockResolvedValue(false);
    const removeSpy = vi.spyOn(lib, 'remove');

    cardFor(wrapper, item.id)!.vm.$emit('delete', item);
    await vi.waitFor(() => expect(confirmDialog).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(removeSpy).not.toHaveBeenCalled();
    expect(lib.has(item.id)).toBe(true);
  });
});
