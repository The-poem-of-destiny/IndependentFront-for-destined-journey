/**
 * StatusOverview — 自由属性点的分配入口
 *
 * 覆盖:
 * - 有点可花 → 剩余点数徽章 + 五维各一个「+」
 * - 没点（0 / 字段缺席）→ 一个按钮一个徽章都不出现（与本次改动之前逐字节一致）
 * - 🔴 上限判据取自 `getTierConfig(tier).attributeCap`，与引擎同一张表:
 *   到顶那一维的「+」禁用，其余照常；层级查不到时**不禁用**（上限未知就拦死，
 *   等于把玩家已到手的点数扣在手里，引擎那侧对同一情况也是放行的）
 * - 点击 → 转 store 动作（数值与落库全在引擎，组件不自己算）
 * - 失败原因走 toast（引擎给的中文原样播报，不换成含糊的「操作失败」）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import StatusOverview from './StatusOverview.vue';

// ---- Mocks ----

let mockGame: any;
let mockAssets: any;
const toast = vi.fn();

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockGame,
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}));
vi.mock('../../stores/ui-store', () => ({
  useUIStore: () => ({ toast }),
}));
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}));

/** tier 4 → attributeCap 14（核心数值表）；str 到顶，其余还有余量 */
function makePlayer(over: Record<string, unknown> = {}) {
  return {
    name: '苏婉',
    level: 12,
    tier: 4,
    tierName: '史诗',
    hp: 10,
    maxHp: 10,
    mp: 5,
    maxMp: 5,
    sp: 5,
    maxSp: 5,
    totalExp: 0,
    expToNext: 100,
    money: 0,
    freeAttrPoints: 2,
    attributes: { str: 14, dex: 9, con: 8, int: 7, spi: 6 },
    inventory: [],
    skills: [],
    statusEffects: [],
    race: '人族',
    identity: [],
    occupation: [],
    ...over,
  };
}

function mountWith(player: Record<string, unknown>) {
  mockGame.player = player;
  return mount(StatusOverview);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = {
    player: makePlayer(),
    fp: 0,
    isGenerating: false,
    activeSaveId: 'save_1',
    showModal: vi.fn(),
    loadSave: vi.fn(),
    allocateAttrPoint: vi.fn(async () => ({ ok: true })),
  };
  // reactive —— usePlayerPortrait 的素材索引是 computed(() => buildAssetIndex(source.assets))，
  // 裸对象读不出依赖（见 StatusOverview.assets.test.ts 那条注释）
  mockAssets = reactive({
    assets: [],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
    importForCharacter: vi.fn(),
    importPortraitPair: vi.fn(),
    setAssetFraming: vi.fn(),
  });
});

describe('StatusOverview — 自由属性点', () => {
  it('有点可花 → 徽章报剩余点数 + 五维各一个「+」', async () => {
    const wrapper = mountWith(makePlayer({ freeAttrPoints: 2 }));
    await flushPromises();

    expect(wrapper.find('.attr-free').text()).toContain('2');
    expect(wrapper.findAll('.attr-grid .attr-plus')).toHaveLength(5);
  });

  it('没有点 → 徽章与按钮都不出现（渲染与改动前一致）', async () => {
    const wrapper = mountWith(makePlayer({ freeAttrPoints: 0 }));
    await flushPromises();

    expect(wrapper.find('.attr-free').exists()).toBe(false);
    expect(wrapper.findAll('.attr-plus')).toHaveLength(0);
    // 属性值本身照旧
    expect(wrapper.findAll('.attr-grid .kv-value')).toHaveLength(5);
  });

  it('字段缺席（老存档）当作 0 处理', async () => {
    const p = makePlayer();
    delete (p as Record<string, unknown>).freeAttrPoints;
    const wrapper = mountWith(p);
    await flushPromises();

    expect(wrapper.find('.attr-free').exists()).toBe(false);
    expect(wrapper.findAll('.attr-plus')).toHaveLength(0);
  });

  it('到当前层级上限的那一维禁用，其余可点', async () => {
    const wrapper = mountWith(makePlayer());
    await flushPromises();

    const buttons = wrapper.findAll('.attr-grid .attr-plus');
    // 顺序同 attributes 的键序：str(14, 到 T4 的 14 上限) / dex / con / int / spi
    expect(buttons[0].attributes('disabled')).toBeDefined();
    expect(buttons[0].attributes('title')).toContain('上限');
    expect(buttons[1].attributes('disabled')).toBeUndefined();
  });

  it('层级配置查不到（脏数据/越界层级）→ 不禁用', async () => {
    const wrapper = mountWith(makePlayer({ tier: 99, attributes: { str: 999, dex: 1 } }));
    await flushPromises();

    const buttons = wrapper.findAll('.attr-grid .attr-plus');
    expect(buttons[0].attributes('disabled')).toBeUndefined();
  });

  it('点「+」→ 转 store 动作（带上那一维的键）', async () => {
    const wrapper = mountWith(makePlayer());
    await flushPromises();

    await wrapper.findAll('.attr-grid .attr-plus')[1].trigger('click');
    await flushPromises();

    expect(mockGame.allocateAttrPoint).toHaveBeenCalledWith('dex');
    expect(toast).not.toHaveBeenCalled();
  });

  it('失败 → 把引擎给的原因原样 toast 出去', async () => {
    mockGame.allocateAttrPoint = vi.fn(async () => ({
      ok: false,
      error: '属性已达当前层级上限（14），无法继续分配',
    }));
    const wrapper = mountWith(makePlayer());
    await flushPromises();

    await wrapper.findAll('.attr-grid .attr-plus')[1].trigger('click');
    await flushPromises();

    expect(toast).toHaveBeenCalledWith('属性已达当前层级上限（14），无法继续分配', 'error');
  });
});
