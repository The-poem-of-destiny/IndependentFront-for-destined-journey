/**
 * CreateStepConfirm — 确认页头像的素材渲染（只读，无导入入口）
 *
 * 覆盖:
 * - 无素材 / 还没起名 → 保留 AvatarPanel 的首字母占位
 * - 有同名头像 → 渲染 `<img>`
 * - 这一位**不可点** —— 导入入口只有 StatusOverview 那一个
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CreateStepConfirm from './CreateStepConfirm.vue';
import type { AssetMetaRecord } from '@engine/types';

// ---- Mocks ----

let mockCreate: any;
let mockAssets: any;

vi.mock('../../stores/create-store', () => ({
  useCreateStore: () => mockCreate,
}));
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}));

function makeRow(name: string): AssetMetaRecord {
  return {
    id: 'asset_1',
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
  mockCreate = {
    name: '苏婉',
    race: '人族',
    customRace: '',
    identity: '游侠',
    customIdentity: '',
    level: 1,
    tier: 1,
    tierName: '普通',
    startLocation: '翡翠之心',
    destinyCore: null,
    hpPreview: 10,
    mpPreview: 5,
    spPreview: 5,
    finalAttributes: { 力量: 1, 敏捷: 1, 体质: 1, 智力: 1, 精神: 1 },
    selectedEquipments: [],
    selectedSkills: [],
    selectedItems: [],
    selectedBackground: null,
    customBackgroundText: '',
    plotOutline: null,
    remainingPoints: 0,
  };
  mockAssets = {
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
  };
});

describe('CreateStepConfirm — 头像素材', () => {
  it('无素材 → 保留首字母占位', async () => {
    const wrapper = mount(CreateStepConfirm);
    await flushPromises();

    expect(wrapper.find('.hero-row img').exists()).toBe(false);
    expect(wrapper.find('.hero-row .avatar-text').text()).toBe('苏婉');
  });

  it('还没起名（空串）→ 静默不解析，占位符照旧', async () => {
    mockCreate.name = '';
    mockAssets.assets = [makeRow('')];

    const wrapper = mount(CreateStepConfirm);
    await flushPromises();

    expect(wrapper.find('.hero-row img').exists()).toBe(false);
    expect(wrapper.find('.hero-row .avatar-text').text()).toBe('?');
  });

  it('有同名头像 → 渲染 <img>', async () => {
    mockAssets.assets = [makeRow('苏婉')];
    mockAssets.assetUrl = vi.fn(async () => 'blob:avatar');

    const wrapper = mount(CreateStepConfirm);
    await flushPromises();

    expect(wrapper.find('.hero-row img').attributes('src')).toBe('blob:avatar');
  });

  it('这一位没有导入入口（只有玩家状态栏那一处可点）', async () => {
    const wrapper = mount(CreateStepConfirm);
    await flushPromises();

    expect(wrapper.find('input[type="file"]').exists()).toBe(false);
    expect(wrapper.find('.hero-row [role="button"]').exists()).toBe(false);
  });
});
