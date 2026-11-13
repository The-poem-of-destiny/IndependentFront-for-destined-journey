/**
 * StatusOverview — 「持有物」区的物品面板入口与页签命名（UIL-18）。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { mount } from '@vue/test-utils';
import StatusOverview from '../../../../src/ui/components/game/StatusOverview.vue';

let mockGame: any;
let mockAssets: any;
const toast = vi.fn();

vi.mock('../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));
vi.mock('../../../../src/ui/stores/asset-store', () => ({ useAssetStore: () => mockAssets }));

function player() {
  return {
    id: 'hero',
    name: '阿黑',
    level: 1,
    tier: 1,
    tierName: '普通',
    hp: 10,
    maxHp: 10,
    mp: 5,
    maxMp: 5,
    sp: 5,
    maxSp: 5,
    totalExp: 0,
    expToNext: 120,
    money: 0,
    freeAttrPoints: 0,
    attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
    inventory: [],
    skills: [],
    statusEffects: [],
    race: '人族',
    identity: ['异界来客'],
    occupation: [],
    personality: '天真',
    appearance: '身形纤细',
    background: '来自异世界',
  };
}

function mountOverview() {
  return mount(StatusOverview, {
    global: { stubs: { PlayerPersonaEditorModal: true } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = reactive({
    player: player(),
    fp: 0,
    isGenerating: false,
    isInCombat: false,
    activeSaveId: 'save-1',
    showModal: vi.fn(),
    loadSave: vi.fn(),
    allocateAttrPoint: vi.fn(async () => ({ ok: true })),
    updatePlayerPersona: vi.fn(async () => ({ ok: true, changed: true, character: player() })),
  });
  mockAssets = reactive({
    assets: [],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
    importForCharacter: vi.fn(),
    importPortraitPair: vi.fn(),
    setAssetFraming: vi.fn(),
  });
});

describe('StatusOverview — 持有物入口（UIL-18）', () => {
  it('标题行常驻「›」按钮，点击打开物品面板且不触发折叠', async () => {
    const wrapper = mountOverview();
    const open = wrapper.get('button[aria-label="打开物品面板"]');
    expect(wrapper.find('.hold-body').exists()).toBe(true);

    await open.trigger('click');

    expect(mockGame.showModal).toHaveBeenCalledWith('items');
    // 冒泡被拦住：持有物区仍展开
    expect(wrapper.find('.hold-body').exists()).toBe(true);
  });

  it('按钮上的 Enter 不会冒泡到标题行触发折叠', async () => {
    const wrapper = mountOverview();

    await wrapper.get('button[aria-label="打开物品面板"]').trigger('keydown', { key: 'Enter' });

    expect(wrapper.find('.hold-body').exists()).toBe(true);
  });

  it('收起后入口仍可见', async () => {
    const wrapper = mountOverview();
    const header = wrapper.get('.hold-open-action').element.closest('.section-header')!;

    header.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.hold-body').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="打开物品面板"]').exists()).toBe(true);
  });

  it('子集页签叫「杂物」而非「背包」，避免与物品面板的全量「背包」同名', () => {
    const wrapper = mountOverview();
    const labels = wrapper
      .get('.hold-body')
      .findAll('.tab-item')
      .map((tab) => tab.text());

    expect(labels).toEqual(['装备', '杂物', '消耗品', '技能']);
  });
});
