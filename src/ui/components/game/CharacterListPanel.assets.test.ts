/**
 * CharacterListPanel — 左栏列表头像 + 右栏详情头像的素材渲染
 *
 * 覆盖两个位（都是 `头像` 类型）:
 * - `.npc-avatar`（2.5rem 圆）与 `.d-avatar`（3.5rem 圆）
 * - 无素材 → 保留原本的 `name[0]` 单字兜底
 * - 有素材 → 图片渲染在圆框内部（框的尺寸/形状不变）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CharacterListPanel from './CharacterListPanel.vue';
import type { AssetMetaRecord } from '@engine/types';

// ---- Mocks ----

let mockGame: any;
let mockAssets: any;

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}));

function makeNpc(id: string, name: string) {
  return {
    id,
    name,
    type: 'npc',
    race: '人族',
    tierName: '普通',
    level: 1,
    inventory: [],
    skills: [],
    statusEffects: [],
    hp: 1,
    maxHp: 1,
    mp: 1,
    maxMp: 1,
    sp: 1,
    maxSp: 1,
    attributes: { str: 1, dex: 1, con: 1, int: 1, spi: 1 },
  };
}

function makeRow(name: string, id = 'asset_1'): AssetMetaRecord {
  return {
    id,
    name,
    type: '头像',
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
    npcs: [makeNpc('c1', '苏婉')],
    fp: 3,
    saveProfile: { affections: {}, contracts: [] },
    getThoughts: vi.fn(() => ''),
  };
  mockAssets = {
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
  };
});

describe('CharacterListPanel — 头像素材', () => {
  it('无素材 → 列表与详情都保留 name[0] 单字兜底', async () => {
    const wrapper = mount(CharacterListPanel);
    await flushPromises();

    expect(wrapper.find('.npc-avatar').text()).toBe('苏');
    expect(wrapper.find('.npc-avatar img').exists()).toBe(false);
    expect(wrapper.find('.d-avatar').text()).toBe('苏');
    expect(wrapper.find('.d-avatar img').exists()).toBe(false);
  });

  it('有同名头像 → 两处圆框内部都渲染 <img>，单字让位', async () => {
    mockAssets.assets = [makeRow('苏婉')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:avatar');

    const wrapper = mount(CharacterListPanel);
    await flushPromises();

    const listImg = wrapper.find('.npc-avatar img');
    expect(listImg.exists()).toBe(true);
    expect(listImg.attributes('src')).toBe('blob:avatar');
    expect(wrapper.find('.npc-avatar').text()).toBe('');

    const detailImg = wrapper.find('.d-avatar img');
    expect(detailImg.exists()).toBe(true);
    expect(detailImg.attributes('src')).toBe('blob:avatar');
  });

  it('每个角色各解析各的 —— 只有一个有素材时另一个仍是单字', async () => {
    mockGame.npcs = [makeNpc('c1', '苏婉'), makeNpc('c2', '林澈')];
    mockAssets.assets = [makeRow('林澈')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:lin');

    const wrapper = mount(CharacterListPanel);
    await flushPromises();

    const cards = wrapper.findAll('.npc-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].find('.npc-avatar img').exists()).toBe(false);
    expect(cards[0].find('.npc-avatar').text()).toBe('苏');
    expect(cards[1].find('.npc-avatar img').attributes('src')).toBe('blob:lin');
  });

  it('名字对不上 → 静默退回单字（D2 严格 ===）', async () => {
    mockAssets.assets = [makeRow('苏 婉')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:avatar');

    const wrapper = mount(CharacterListPanel);
    await flushPromises();

    expect(wrapper.find('.npc-avatar img').exists()).toBe(false);
    expect(wrapper.find('.npc-avatar').text()).toBe('苏');
  });
});
