/**
 * CharacterListPanel — 键盘可达、按名字保持选中、从列表打开只读档案
 * （审计 CHR-01 / CHR-02 / CHR-07，2026-11-14）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import CharacterListPanel from '../../../../src/ui/components/game/CharacterListPanel.vue';
import CharacterViewerModal from '../../../../src/ui/components/game/CharacterViewerModal.vue';

let mockGame: any;

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ toast: vi.fn() }),
}));
vi.mock('../../../../src/ui/stores/asset-store', () => ({
  useAssetStore: () => ({
    assets: [],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
  }),
}));

function npc(id: string, name: string, extra: Record<string, unknown> = {}) {
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
    hp: 10,
    maxHp: 10,
    mp: 10,
    maxMp: 10,
    sp: 10,
    maxSp: 10,
    attributes: { str: 1, dex: 1, con: 1, int: 1, spi: 1 },
    ...extra,
  };
}

beforeEach(() => {
  // reactive：用例中途换 npcs 要能触发面板的 computed（真 store 也是响应式的）
  mockGame = reactive({
    npcs: [npc('c1', '苏婉'), npc('c2', '林舟'), npc('c3', '白芷')],
    fp: 0,
    saveProfile: { affections: {}, contracts: [] },
    getThoughts: vi.fn(() => ''),
    removeCharacter: vi.fn(async () => ({ ok: true })),
    rewriteLoadoutItem: vi.fn(async () => ({ ok: true })),
  });
});

function mountPanel() {
  // 查看器本体有自己的测试；这里只验「谁、什么时候」被交给它
  return mount(CharacterListPanel, {
    attachTo: document.body,
    global: { stubs: { CharacterViewerModal: true } },
  });
}

describe('CharacterListPanel — NPC 行键盘可达（CHR-02）', () => {
  it('列表是 listbox，行是 option；只有选中行在 Tab 序里', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('.npc-list').attributes('role')).toBe('listbox');
    const rows = wrapper.findAll('.npc-card');
    expect(rows.map((r) => r.attributes('role'))).toEqual(['option', 'option', 'option']);
    expect(rows.map((r) => r.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(rows.map((r) => r.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    wrapper.unmount();
  });

  it('Enter / 空格选中该行', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('.npc-card')[2].trigger('keydown', { key: 'Enter' });
    expect(wrapper.find('.d-name').text()).toBe('白芷');
    await wrapper.findAll('.npc-card')[1].trigger('keydown', { key: ' ' });
    expect(wrapper.find('.d-name').text()).toBe('林舟');
    expect(wrapper.findAll('.npc-card')[1].attributes('aria-selected')).toBe('true');
    wrapper.unmount();
  });

  it('↓ / ↑ / End / Home 换人，焦点跟过去', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const list = wrapper.find('.npc-list');
    await list.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(wrapper.find('.d-name').text()).toBe('林舟');
    expect(document.activeElement).toBe(wrapper.findAll('.npc-card')[1].element);

    await list.trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(wrapper.find('.d-name').text()).toBe('白芷');
    // 末尾再 ↓ 不越界
    await list.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.find('.d-name').text()).toBe('白芷');

    await list.trigger('keydown', { key: 'Home' });
    expect(wrapper.find('.d-name').text()).toBe('苏婉');
    await list.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.find('.d-name').text()).toBe('苏婉');
    wrapper.unmount();
  });

  it('状态效果行是真按钮，点开/收起说明并带 aria-expanded', async () => {
    mockGame.npcs = [
      npc('c1', '苏婉', {
        statusEffects: [
          {
            name: '中毒',
            category: '减益',
            stacks: 1,
            remainingTime: 3,
            timeUnit: '小时',
            description: '持续掉血',
            source: '蛇咬',
          },
        ],
      }),
    ];
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper
      .findAll('.tab-row button')
      .find((b) => b.text().startsWith('状态'))!
      .trigger('click');

    const row = wrapper.find('.status-row');
    expect(row.element.tagName).toBe('BUTTON');
    expect(row.attributes('aria-expanded')).toBe('false');
    await row.trigger('click');
    expect(wrapper.find('.st-detail').text()).toContain('持续掉血');
    expect(wrapper.find('.status-row').attributes('aria-expanded')).toBe('true');
    wrapper.unmount();
  });
});

describe('CharacterListPanel — 选中项按名字保持（CHR-07）', () => {
  it('新角色登场（数量变化）不把选中项跳回第一个', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('.npc-card')[2].trigger('click');
    expect(wrapper.find('.d-name').text()).toBe('白芷');

    // 新角色插在最前面：按下标记会变成「林舟」，按名字记仍是「白芷」
    mockGame.npcs = [npc('c0', '新来者'), ...mockGame.npcs];
    await flushPromises();
    expect(wrapper.find('.d-name').text()).toBe('白芷');
    wrapper.unmount();
  });

  it('选中的角色被删掉 → 退回第一位', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    await wrapper.findAll('.npc-card')[1].trigger('click');
    mockGame.npcs = mockGame.npcs.filter((n: { name: string }) => n.name !== '林舟');
    await flushPromises();
    expect(wrapper.find('.d-name').text()).toBe('苏婉');
    wrapper.unmount();
  });
});

describe('CharacterListPanel — 从列表打开只读档案（CHR-01）', () => {
  it('「查看档案 / 编年史」按当前选中 NPC 的名字打开查看器，关掉回到列表', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    const viewer = () => wrapper.findComponent(CharacterViewerModal);
    expect(viewer().props('name')).toBeNull();

    await wrapper.findAll('.npc-card')[1].trigger('click');
    const button = wrapper.find('.d-view-btn');
    expect(button.text()).toContain('查看档案 / 编年史');
    await button.trigger('click');
    expect(viewer().props('name')).toBe('林舟');

    viewer().vm.$emit('close');
    await flushPromises();
    expect(viewer().props('name')).toBeNull();
    // 列表与选中项原样还在
    expect(wrapper.find('.d-name').text()).toBe('林舟');
    wrapper.unmount();
  });
});
