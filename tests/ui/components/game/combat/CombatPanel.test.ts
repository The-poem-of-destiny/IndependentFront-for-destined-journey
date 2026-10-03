/**
 * CombatPanel.test.ts — C6 新战斗前端：三态（就绪 / 战斗中 / 结算）数据源 = CombatState。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { CombatState, CombatUnit } from '@engine/combat/sandbox/types';
import type { TimelineRestoreResult } from '../../../../../src/ui/stores/game-store';

const startCombat = vi.fn(async () => {});
const skipCombat = vi.fn();
const restartCombat = vi.fn<() => Promise<TimelineRestoreResult>>(async () => ({
  status: 'restored',
  continuation: 'same-save',
}));
const submitCombatIntent = vi.fn(async (_text: string) => {});
const continueCombatSettlement = vi.fn();
const exitCombat = vi.fn();
const toast = vi.fn();
const navigate = vi.fn();
let mockGame: Record<string, unknown>;

vi.mock('../../../../../src/ui/stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../../../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ toast, navigate }),
}));

import CombatPanel from '../../../../../src/ui/components/game/combat/CombatPanel.vue';

function unit(
  name: string,
  side: 'ally' | 'enemy',
  overrides: Partial<CombatUnit> = {},
): CombatUnit {
  return {
    name,
    tier: 1,
    level: 1,
    race: '人类',
    attributes: { str: 5, dex: 5, con: 5, int: 5, spi: 5 },
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    statusEffects: [],
    origin: 'save',
    side,
    pos: side === 'ally' ? 1 : 8,
    facing: side === 'ally' ? 'right' : 'left',
    slots: { attack: 1, action: 1 },
    alive: true,
    canAct: true,
    morale: 'steady',
    skills: [{ name: '碎裂锤击', type: '主动', cost: 'SP 120', description: '一记重锤' }],
    ...overrides,
  };
}

function makeState(
  overrides: Partial<CombatState['meta']> = {},
  units?: CombatUnit[],
): CombatState {
  const list = units ?? [unit('理查德', 'ally'), unit('骷髅兵', 'enemy')];
  const map: Record<string, CombatUnit> = {};
  for (const u of list) map[u.name] = u;
  return {
    meta: {
      round: 2,
      combatType: '标准',
      environment: '雨夜的桥头',
      coordinateRange: 8,
      actionOrder: Object.keys(map),
      phase: 'active',
      regions: [],
      ...overrides,
    },
    units: map,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  restartCombat.mockResolvedValue({ status: 'restored', continuation: 'same-save' });
  mockGame = reactive({
    isInCombat: true,
    combatReady: null,
    combatState: null,
    combatSettlement: null,
    combatFlow: [],
    combatContinue: null,
    combatPendingUnit: null,
    startCombat,
    skipCombat,
    restartCombat,
    submitCombatIntent,
    continueCombatSettlement,
    exitCombat,
  });
});

async function mountPanel() {
  const wrapper = mount(CombatPanel, {
    global: { stubs: { teleport: true } },
    attachTo: document.body,
  });
  await nextTick();
  return wrapper;
}

describe('CombatPanel 就绪态', () => {
  it('渲染类型/环境/我方/敌方/起因 + 开始/跳过，不渲染战斗视图', async () => {
    mockGame.combatReady = {
      combatType: '死斗',
      environment: '竞技场',
      allies: ['理查德', '妲丽安'],
      enemies: ['冠军'],
      bodyText: '决一死战',
    };
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-ready').exists()).toBe(true);
    const text = wrapper.find('.combat-ready').text();
    expect(text).toContain('战斗就绪');
    expect(text).toContain('死斗');
    expect(text).toContain('竞技场');
    expect(text).toContain('理查德、妲丽安');
    expect(text).toContain('冠军');
    expect(text).toContain('决一死战');
    expect(wrapper.find('.combat-planner').exists()).toBe(false);
    expect(wrapper.find('.combat-head').exists()).toBe(false);
  });

  it('点「开始战斗」→ startCombat；「跳过战斗」确认 → skipCombat', async () => {
    mockGame.combatReady = { combatType: '标准' };
    const wrapper = await mountPanel();

    const startBtn = wrapper.findAll('button').find((b) => b.text().includes('开始战斗'))!;
    await startBtn.trigger('click');
    expect(startCombat).toHaveBeenCalledTimes(1);

    const skipBtn = wrapper.findAll('button').find((b) => b.text().includes('跳过战斗'))!;
    await skipBtn.trigger('click');
    await nextTick();
    const confirm = wrapper
      .findAll('button')
      .find((b) => b.text().trim() === '跳过战斗' && b.classes().includes('btn-primary'))!;
    await confirm.trigger('click');
    await nextTick();
    expect(skipCombat).toHaveBeenCalledTimes(1);
  });
});

describe('CombatPanel 战斗中', () => {
  it('遍历 CombatState 渲染我方/敌方单位卡 + 头/资源条/坐标轴', async () => {
    mockGame.combatState = makeState();
    mockGame.combatPendingUnit = '理查德';
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-head').text()).toContain('战斗行动 · 第 2 回合');
    expect(wrapper.find('.combat-head').text()).toContain('标准');
    expect(wrapper.find('.combat-head').text()).toContain('雨夜的桥头');
    expect(wrapper.find('.axis-wrap').exists()).toBe(true);
    // 单位卡：我方 1 + 敌方 1
    expect(wrapper.findAll('.combat-unit-card')).toHaveLength(2);
    expect(wrapper.find('.combat-col').text()).toContain('理查德');
    // 技能从单位数据读
    expect(wrapper.findAll('.cu-item-name').map((n) => n.text())).toContain('碎裂锤击');
    // 顶部资源条
    expect(wrapper.find('.resbar').exists()).toBe(true);
  });

  it('等待玩家 → 渲染行动规划区；不等待 → 显示「敌方行动中…」', async () => {
    mockGame.combatState = makeState({ pendingPlayerUnit: '理查德' });
    mockGame.combatPendingUnit = '理查德';
    const wrapper = await mountPanel();
    expect(wrapper.find('.combat-planner').exists()).toBe(true);

    mockGame.combatState = makeState();
    mockGame.combatPendingUnit = null;
    await nextTick();
    expect(wrapper.find('.combat-planner').exists()).toBe(false);
    expect(wrapper.find('.combat-waiting').exists()).toBe(true);
  });

  it('点技能卡 → 输入框填入意图；确定 → submitCombatIntent', async () => {
    mockGame.combatState = makeState({ pendingPlayerUnit: '理查德' });
    mockGame.combatPendingUnit = '理查德';
    const wrapper = await mountPanel();

    const skillCard = wrapper.findAll('.skillrow .acard')[0];
    await skillCard.trigger('click');
    const input = wrapper.find('.planner-input').element as HTMLTextAreaElement;
    expect(input.value).toContain('碎裂锤击');

    const send = wrapper.find('.planner-send');
    await send.trigger('click');
    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    expect(submitCombatIntent.mock.calls[0][0]).toContain('碎裂锤击');
  });

  it('右上角「↺ 重开战斗」→ 确认弹窗 → restartCombat', async () => {
    mockGame.combatState = makeState();
    const wrapper = await mountPanel();

    await wrapper.find('.restart-btn').trigger('click');
    await nextTick();
    const confirm = wrapper.findAll('button').find((b) => b.text().trim() === '确认重开')!;
    await confirm.trigger('click');
    await nextTick();
    expect(restartCombat).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('重开投影失败 → toast(error) + 返回首页', async () => {
    mockGame.combatState = makeState();
    restartCombat.mockResolvedValueOnce({
      status: 'projection-failed',
      error: '时间线已恢复，但界面重载失败，请重新进入存档',
    });
    const wrapper = await mountPanel();

    await wrapper.find('.restart-btn').trigger('click');
    await nextTick();
    const confirm = wrapper.findAll('button').find((b) => b.text().trim() === '确认重开')!;
    await confirm.trigger('click');
    await nextTick();
    expect(toast).toHaveBeenCalledWith('时间线已恢复，但界面重载失败，请重新进入存档', 'error');
    expect(navigate).toHaveBeenCalledWith('home');
  });
});

describe('CombatPanel 结算态', () => {
  beforeEach(() => {
    mockGame.combatState = makeState({ pendingPlayerUnit: undefined });
    mockGame.combatSettlement = {
      outcome: 'ally_win',
      totalExp: 20,
      totalFp: 3,
      loot: [{ name: '生锈短剑', description: '', quantity: 1, quality: '稀有' }],
      rounds: 4,
      summaryText: '战斗总结',
    };
  });

  it('渲染结果/回合/经验/命运点/战利品/状态结算', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.combat-settlement').exists()).toBe(true);
    const text = wrapper.find('.combat-settlement').text();
    expect(text).toContain('战斗结算');
    expect(text).toContain('胜利');
    expect(text).toContain('+20');
    expect(text).toContain('生锈短剑');
    // 结算态不渲染战斗头 / 规划区
    expect(wrapper.find('.combat-head').exists()).toBe(false);
    expect(wrapper.find('.combat-planner').exists()).toBe(false);
  });

  it('输入「接下来做什么」并点继续 → continueCombatSettlement(文本)', async () => {
    const wrapper = await mountPanel();
    const input = wrapper.find('.next-input');
    await input.setValue('搜刮尸体后继续赶路');
    const btn = wrapper.findAll('button').find((b) => b.text().trim() === '继续')!;
    await btn.trigger('click');
    expect(continueCombatSettlement).toHaveBeenCalledWith('搜刮尸体后继续赶路');
  });

  it('结算态「重开战斗」→ 确认弹窗 → restartCombat', async () => {
    const wrapper = await mountPanel();
    const restart = wrapper.findAll('button').find((b) => b.text().includes('重开战斗'))!;
    await restart.trigger('click');
    await nextTick();
    const confirm = wrapper.findAll('button').find((b) => b.text().trim() === '确认重开')!;
    await confirm.trigger('click');
    await nextTick();
    expect(restartCombat).toHaveBeenCalledTimes(1);
  });
});
