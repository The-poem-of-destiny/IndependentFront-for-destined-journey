/**
 * StatusOverview — 玩家人设编辑入口与保存编排。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import StatusOverview from './StatusOverview.vue';
import PlayerPersonaEditorModal from './PlayerPersonaEditorModal.vue';

let mockGame: any;
let mockAssets: any;
const toast = vi.fn();

vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: () => ({ settings: {} }) }));
vi.mock('../../stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));
vi.mock('../../stores/asset-store', () => ({ useAssetStore: () => mockAssets }));

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
    global: {
      stubs: {
        PlayerPersonaEditorModal: {
          name: 'PlayerPersonaEditorModal',
          props: ['open', 'persona', 'saving', 'error'],
          emits: ['close', 'save'],
          template: '<div v-if="open" class="persona-modal-stub" />',
        },
      },
    },
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

describe('StatusOverview — 编辑玩家人设', () => {
  it('主角姓名下方提供文字入口，生成或战斗中禁用', async () => {
    const wrapper = mountOverview();
    const entry = wrapper.find('.persona-edit-button');
    expect(entry.text()).toBe('编辑人设');
    expect(entry.attributes('disabled')).toBeUndefined();

    mockGame.isGenerating = true;
    await flushPromises();
    expect(entry.attributes('disabled')).toBeDefined();
    expect(entry.attributes('title')).toContain('当前回合');

    mockGame.isGenerating = false;
    mockGame.isInCombat = true;
    await flushPromises();
    expect(entry.attributes('disabled')).toBeDefined();
    expect(entry.attributes('title')).toContain('战斗');
  });

  it('保存成功调用 store、关闭弹窗并提示下一次行动生效', async () => {
    const wrapper = mountOverview();
    await wrapper.find('.persona-edit-button').trigger('click');
    const modal = wrapper.findComponent(PlayerPersonaEditorModal);
    expect(modal.props('open')).toBe(true);
    expect(modal.props('persona')).toEqual({
      personality: '天真',
      appearance: '身形纤细',
      background: '来自异世界',
    });

    const draft = { personality: '冷静', appearance: '银发金瞳', background: '边境出身' };
    modal.vm.$emit('save', draft);
    await flushPromises();

    expect(mockGame.updatePlayerPersona).toHaveBeenCalledWith(draft);
    expect(wrapper.findComponent(PlayerPersonaEditorModal).props('open')).toBe(false);
    expect(toast).toHaveBeenCalledWith('人设已更新，将从下一次行动起生效', 'success');
  });

  it('保存失败保留弹窗和草稿，并把原因交给弹窗与 toast', async () => {
    mockGame.updatePlayerPersona.mockResolvedValue({ ok: false, error: '人设保存失败，请重试' });
    const wrapper = mountOverview();
    await wrapper.find('.persona-edit-button').trigger('click');
    const modal = wrapper.findComponent(PlayerPersonaEditorModal);

    modal.vm.$emit('save', {
      personality: '冷静',
      appearance: '银发金瞳',
      background: '边境出身',
    });
    await flushPromises();

    expect(wrapper.findComponent(PlayerPersonaEditorModal).props('open')).toBe(true);
    expect(wrapper.findComponent(PlayerPersonaEditorModal).props('error')).toBe(
      '人设保存失败，请重试',
    );
    expect(toast).toHaveBeenCalledWith('人设保存失败，请重试', 'error');
  });
});
