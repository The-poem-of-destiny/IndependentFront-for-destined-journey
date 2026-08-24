/**
 * CharacterListPanel — NPC 角色面板的重铸（2026-08-24）
 *
 * 覆盖：
 * - 背包 tab（M6 缺口：此前角色面板只有 装备/技能，看不到背包）
 * - 装备/技能/背包条目各自的重铸按钮 → 调 game.rewriteLoadoutItem（角色名 = 当前 NPC）
 * - 查看脚本升级为新版：modifiers/automata 原始 JSON 也展示（旧版只有第一个条目的 scripts）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CharacterListPanel from './CharacterListPanel.vue';

// ---- Mocks ----

let mockGame: any;
let mockUi: any;

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../stores/ui-store', () => ({
  useUIStore: () => mockUi,
}));
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => ({
    assets: [],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
  }),
}));

function makeNpc() {
  return {
    id: 'c1',
    name: '苏婉',
    type: 'npc',
    race: '人族',
    tierName: '普通',
    level: 5,
    inventory: [
      {
        name: '精铁剑',
        quantity: 1,
        type: '装备',
        rarity: '稀有',
        equippedSlot: '武器',
        stats: { 攻击力: 25 },
        description: '精铁锻造的长剑',
        modifiers: [{ category: '固伤', source: '精铁剑', amount: 10 }],
      },
      { name: '草药', quantity: 2, type: '材料', rarity: '普通', description: '野外采的草药' },
    ],
    skills: [
      {
        name: '斩击',
        type: 'active',
        description: '挥剑斩击',
        level: 1,
        cost: { type: 'SP', amount: 5 },
      },
    ],
    statusEffects: [],
    hp: 10,
    maxHp: 10,
    mp: 10,
    maxMp: 10,
    sp: 10,
    maxSp: 10,
    attributes: { str: 1, dex: 1, con: 1, int: 1, spi: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = {
    npcs: [makeNpc()],
    fp: 3,
    saveProfile: { affections: {}, contracts: [] },
    getThoughts: vi.fn(() => ''),
    removeCharacter: vi.fn(async () => ({ ok: true })),
    rewriteLoadoutItem: vi.fn(async () => ({ ok: true })),
  };
  mockUi = {
    toast: vi.fn(),
  };
});

function mountPanel() {
  return mount(CharacterListPanel);
}

describe('CharacterListPanel — 背包 tab', () => {
  it('新增背包 tab：显示非装备物品', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const tabs = wrapper.findAll('.tab-row button');
    const bagTab = tabs.find((b) => b.text().startsWith('背包'));
    expect(bagTab).toBeDefined();

    await bagTab!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('草药');
    // 装备（精铁剑）不出现在背包 tab
    const bagCards = wrapper.findAll('.equip-card');
    expect(bagCards).toHaveLength(1);
  });
});

describe('CharacterListPanel — 重铸', () => {
  it('装备条目重铸：确认后调 rewriteLoadoutItem（角色名 = 当前 NPC）', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    // 装备 tab
    const tabs = wrapper.findAll('.tab-row button');
    await tabs.find((b) => b.text().startsWith('装备'))!.trigger('click');
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    expect(mockGame.rewriteLoadoutItem).toHaveBeenCalledTimes(1);
    const [charId, target] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(charId).toBe('苏婉');
    expect(target.kind).toBe('equipment');
    expect(target.entry.name).toBe('精铁剑');
    expect(target.entry.slot).toBe('武器');
    expect(target.entry.modifiers).toHaveLength(1);
  });

  it('技能条目重铸：target 是 skill', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const tabs = wrapper.findAll('.tab-row button');
    await tabs.find((b) => b.text().startsWith('技能'))!.trigger('click');
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    const [, target] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(target.kind).toBe('skill');
    expect(target.entry.name).toBe('斩击');
  });

  it('背包条目重铸：target 是 inventory', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const tabs = wrapper.findAll('.tab-row button');
    await tabs.find((b) => b.text().startsWith('背包'))!.trigger('click');
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    const [, target] = mockGame.rewriteLoadoutItem.mock.calls[0];
    expect(target.kind).toBe('inventory');
    expect(target.entry.name).toBe('草药');
    expect(target.entry.quantity).toBe(2);
  });

  it('玩家描述透传：确认时把输入框内容作为 userDescription', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const tabs = wrapper.findAll('.tab-row button');
    await tabs.find((b) => b.text().startsWith('技能'))!.trigger('click');
    await flushPromises();

    await wrapper.find('.rewrite-btn').trigger('click');
    await wrapper.find('.rewrite-desc').setValue('斩击伤害类型错了');
    await wrapper.find('.rewrite-confirm').trigger('click');
    await flushPromises();

    expect(mockGame.rewriteLoadoutItem.mock.calls[0][2]).toBe('斩击伤害类型错了');
  });
});

describe('CharacterListPanel — 查看脚本升级（modifiers/automata）', () => {
  it('装备带 modifiers → 查看原始数据 同时展示 modifiers JSON 与 scripts', async () => {
    const wrapper = mountPanel();
    await flushPromises();

    const tabs = wrapper.findAll('.tab-row button');
    await tabs.find((b) => b.text().startsWith('装备'))!.trigger('click');
    await flushPromises();

    await wrapper.find('.script-toggle').trigger('click');
    await flushPromises();

    const body = wrapper.find('.script-body');
    expect(body.exists()).toBe(true);
    expect(body.text()).toContain('modifiers / automata');
    expect(body.text()).toContain('固伤');
    expect(body.text()).toContain('"source": "精铁剑"');
  });
});
