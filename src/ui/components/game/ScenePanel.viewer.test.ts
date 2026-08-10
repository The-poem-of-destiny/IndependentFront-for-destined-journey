/**
 * ScenePanel — 点在场角色开角色查看器
 *
 * 这一条测的是**接线**，不是弹窗内容（那在 CharacterViewerModal.test.ts）:
 * - 在场那一行点下去，弹窗带着**这个人的名字**开出来
 * - 传的是名字不是对象（弹窗要靠它回查最新状态）
 * - 弹窗 close 之后不再渲染
 * - 🔴 **不经 `game.showModal`**: 那是页面级弹窗的单选位（一次只能开一个），
 *   查看器是场景栏自己的一层。走那条路会把「角色列表」之类顶掉。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import ScenePanel from './ScenePanel.vue';
import CharacterViewerModal from './CharacterViewerModal.vue';

let mockGame: any;
let mockAssets: any;

vi.mock('@engine/save-profile', () => ({ markNewsRead: vi.fn(async (p: any) => p) }));
vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: () => ({ settings: {} }) }));
vi.mock('../../stores/asset-store', () => ({ useAssetStore: () => mockAssets }));

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = {
    activeSaveId: 'save_1',
    gameTime: null,
    player: null,
    characters: [
      { id: 'c1', name: '苏婉', type: 'npc', present: true, level: 4, tier: 2, attributes: {} },
      { id: 'c2', name: '林霜', type: 'npc', present: true, level: 6, tier: 2, attributes: {} },
    ],
    saveProfile: { affections: {}, quests: {}, news: [] },
    news: [],
    getThoughts: vi.fn(() => ''),
    showModal: vi.fn(),
  };
  mockAssets = { assets: [], assetUrl: vi.fn(async () => null), releaseAssetUrl: vi.fn() };
});

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('ScenePanel — 角色查看器接线', () => {
  it('未点之前查看器关着（name=null）', async () => {
    wrapper = mount(ScenePanel, { attachTo: document.body });
    await flushPromises();
    expect(wrapper.findComponent(CharacterViewerModal).props('name')).toBeNull();
  });

  it('★ 点第二位在场角色 → 查看器收到的是**那一位的名字**', async () => {
    wrapper = mount(ScenePanel, { attachTo: document.body });
    await flushPromises();

    const items = wrapper.findAll('.scene-npc-item');
    expect(items).toHaveLength(2);
    await items[1].trigger('click');
    await flushPromises();

    expect(wrapper.findComponent(CharacterViewerModal).props('name')).toBe('林霜');
    expect(document.querySelector('.head-name')?.textContent).toBe('林霜');
  });

  it('★ 不经 game.showModal —— 那个位是页面级弹窗的单选位', async () => {
    wrapper = mount(ScenePanel, { attachTo: document.body });
    await flushPromises();
    await wrapper.find('.scene-npc-item').trigger('click');
    expect(mockGame.showModal).not.toHaveBeenCalled();
  });

  it('查看器抛 close → 关回去', async () => {
    wrapper = mount(ScenePanel, { attachTo: document.body });
    await flushPromises();
    await wrapper.find('.scene-npc-item').trigger('click');
    await flushPromises();

    wrapper.findComponent(CharacterViewerModal).vm.$emit('close');
    await flushPromises();
    expect(wrapper.findComponent(CharacterViewerModal).props('name')).toBeNull();
    expect(document.querySelector('.viewer')).toBeNull();
  });
});
