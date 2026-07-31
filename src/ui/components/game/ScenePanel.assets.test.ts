/**
 * ScenePanel — 在场角色立牌的素材渲染
 *
 * 覆盖:
 * - 无素材 → 保留 `initialsOf` 首字母 + `--npc-avatar-color` 兜底（改版前的原样）
 * - 有素材 → 图片渲染在 `.npc-portrait` **内部**
 *   🔴 `.npc-portrait` 同时是心声气泡的 `anchorSelector`，类必须留在外层元素上
 * - 这一位是 46×58 的 4:5 竖幅 = 立牌形状，走**立牌链** `立绘 → 立绘bg → 头像`
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ScenePanel from './ScenePanel.vue';
import type { AssetMetaRecord, AssetType } from '@engine/types';

// ---- Mocks ----

let mockGame: any;
let mockAssets: any;

vi.mock('@engine/save-profile', () => ({
  markNewsRead: vi.fn(async (p: any) => p),
}));
vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}));

function makeRow(name: string, type: AssetType, id = 'asset_1'): AssetMetaRecord {
  return {
    id,
    name,
    type,
    ext: 'png',
    mime: 'image/png',
    bytes: 12,
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = {
    activeSaveId: 'save_1',
    gameTime: null,
    player: null,
    characters: [{ id: 'c1', name: '苏婉', type: 'npc', present: true, level: 4, tier: 2 }],
    saveProfile: { affections: {}, quests: {}, news: [] },
    news: [],
    getThoughts: vi.fn(() => ''),
    showModal: vi.fn(),
  };
  mockAssets = {
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
  };
});

describe('ScenePanel — 在场角色立牌素材', () => {
  it('无素材 → 首字母兜底原样保留，容器仍带 --npc-avatar-color', async () => {
    const wrapper = mount(ScenePanel);
    await flushPromises();

    const portrait = wrapper.find('.npc-portrait');
    expect(portrait.exists()).toBe(true);
    expect(portrait.text()).toBe('苏婉');
    expect(portrait.find('img').exists()).toBe(false);
    expect(portrait.attributes('style')).toContain('--npc-avatar-color');
  });

  it('有立绘 → 图片渲染在 .npc-portrait 内部，类留在外层（心声气泡的锚点）', async () => {
    mockAssets.assets = [makeRow('苏婉', '立绘')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:standee');

    const wrapper = mount(ScenePanel);
    await flushPromises();

    const portrait = wrapper.find('.npc-portrait');
    expect(portrait.exists()).toBe(true);
    const img = portrait.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('blob:standee');
    // 图片顶掉了首字母
    expect(portrait.text()).toBe('');
  });

  /**
   * ★ 立牌链最值钱的一条: 只有头像的角色照样占得住立牌位。
   *
   * 这曾经是坏的 —— `resolveAsset` 只在 type 省略时才走链，而 `useAssetImage`
   * 把省略兜成单个 `'头像'`，于是链从 composable 这一层根本走不到，本位显示首字母。
   * 现在 ScenePanel 显式传 `ASSET_TYPE_FALLBACK_CHAIN`，第三档兜住。
   */
  it('★ 只有头像 → 立牌位照样出图（立牌链退到第三档，不留洞）', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:avatar');

    const wrapper = mount(ScenePanel);
    await flushPromises();

    const img = wrapper.find('.npc-portrait img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('blob:avatar');
    expect(wrapper.find('.npc-portrait').text()).toBe('');
  });

  /** 链的优先级方向: 立牌位有立绘就绝不用头像（脸位链是反的，见 asset-resolve.test.ts） */
  it('立绘与头像都有 → 立牌位取立绘', async () => {
    mockAssets.assets = [makeRow('苏婉', '头像', 'av'), makeRow('苏婉', '立绘', 'st')];
    mockAssets.assetUrl = vi.fn(async (id: string) => `blob:${id}`);

    const wrapper = mount(ScenePanel);
    await flushPromises();

    expect(wrapper.find('.npc-portrait img').attributes('src')).toBe('blob:st');
  });

  it('名字对不上 → 静默退回首字母（D2 严格 ===）', async () => {
    mockAssets.assets = [makeRow('苏 婉', '立绘')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:standee');

    const wrapper = mount(ScenePanel);
    await flushPromises();

    expect(wrapper.find('.npc-portrait img').exists()).toBe(false);
    expect(wrapper.find('.npc-portrait').text()).toBe('苏婉');
  });
});
