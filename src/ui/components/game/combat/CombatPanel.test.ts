/**
 * CombatPanel.test.ts — F2（2026-08-10）就绪态面板：combat_trigger 检出 →
 * 就绪面板（参战方/类型/环境/起因）→ 玩家点「开始战斗」→ 才开打。
 *
 * 四条核心断言：
 * 1. combatReady 置位时渲染就绪分支（战斗就绪 + 类型/环境 + 我方（player 排头）/
 *    敌方名单 + 起因），**不渲染**开打态视图（CombatActionBar / CombatMessageFlow）。
 * 2. 点「开始战斗」→ game.startCombat 被调（就绪态到开打态的唯一入口）。
 * 3. 开打态（v3ActiveCombat 有值、combatReady null）→ 不渲染就绪分支，渲染战斗视图。
 * 4. 就绪态「跳过战斗」→ game.skipCombat 确认弹窗路径可用（AppModal 确认后调用）。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { mount } from '@vue/test-utils';

const startCombat = vi.fn(async () => {});
const skipCombat = vi.fn();
const restartCombat = vi.fn(async () => ({ ok: true }));
const toast = vi.fn();
let mockGame: Record<string, unknown>;

vi.mock('../../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../../stores/ui-store', () => ({ useUIStore: () => ({ toast }) }));

import CombatPanel from './CombatPanel.vue';

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = reactive({
    isInCombat: true,
    // F2 就绪态：战斗还没开（v3ActiveCombat=null），面板数据 = marker 快照
    combatReady: {
      combatType: '死斗',
      environment: '竞技场',
      allies: ['妲丽安'],
      enemies: ['冠军'],
      bodyText: '决一死战',
    },
    v3ActiveCombat: null,
    combatLog: [],
    combatAwaitingInput: null,
    combatCurrentUnitId: null,
    player: { name: '理查德' },
    characters: [],
    startCombat,
    skipCombat,
    restartCombat,
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

describe('CombatPanel F2 就绪态', () => {
  it('combatReady 置位：渲染就绪分支（类型/环境/我方含 player 排头/敌方/起因），不渲染开打态视图', async () => {
    const wrapper = await mountPanel();

    // 就绪分支：标题 + 类型/环境
    expect(wrapper.find('.combat-ready-title').text()).toContain('战斗就绪');
    expect(wrapper.find('.combat-ready-meta').text()).toContain('类型：死斗');
    expect(wrapper.find('.combat-ready-meta').text()).toContain('环境：竞技场');
    // 参战方：我方 = player 排头 + allies；敌方 = enemies（两个独立 roster 块）
    const rosters = wrapper.findAll('.combat-ready-roster');
    expect(rosters).toHaveLength(2);
    expect(rosters[0].text()).toContain('【我方】');
    expect(rosters[0].text()).toContain('理查德、妲丽安');
    expect(rosters[1].text()).toContain('【敌方】');
    expect(rosters[1].text()).toContain('冠军');
    // 起因（bodyText）
    expect(wrapper.find('.combat-ready-brief').text()).toContain('决一死战');
    // 开打态视图不出现（战斗还没开：无操作栏、无消息流）
    expect(wrapper.find('.combat-action-bar').exists()).toBe(false);
    expect(wrapper.find('.combat-header').exists()).toBe(false);
    // 开始/跳过按钮在
    expect(wrapper.text()).toContain('开始战斗');
    expect(wrapper.text()).toContain('跳过战斗');
  });

  it('点「开始战斗」→ game.startCombat 被调（就绪 → 开打的唯一入口）', async () => {
    const wrapper = await mountPanel();
    const buttons = wrapper.findAll('button');
    const startBtn = buttons.find((b) => b.text().includes('开始战斗'));
    expect(startBtn).toBeTruthy();
    await startBtn!.trigger('click');
    await nextTick();
    expect(startCombat).toHaveBeenCalledTimes(1);
  });

  it('就绪态「跳过战斗」确认后 → game.skipCombat 被调（跳过确认弹窗复用开打态文案）', async () => {
    const wrapper = await mountPanel();
    // 面板跳过按钮（ghost）→ 打开确认弹窗
    const skipBtn = wrapper.find('button.btn-ghost');
    expect(skipBtn.text()).toContain('跳过战斗');
    await skipBtn.trigger('click');
    await nextTick();
    // 弹窗确认按钮（primary，文本也是「跳过战斗」）→ 确认后 skipCombat
    const confirm = wrapper
      .findAll('button.btn-primary')
      .find((b) => b.text().trim() === '跳过战斗');
    expect(confirm).toBeTruthy();
    await confirm!.trigger('click');
    await nextTick();
    expect(skipCombat).toHaveBeenCalledTimes(1);
  });

  it('开打态（combatReady=null + v3ActiveCombat 有值）：不渲染就绪分支，渲染战斗视图', async () => {
    mockGame.combatReady = null;
    mockGame.v3ActiveCombat = {
      combatId: 'c1',
      revision: 0,
      phase: 'CombatOpen',
      round: 1,
      initiativeOrder: ['理查德', '冠军'],
      currentTurnIndex: 0,
      units: {
        理查德: { id: '理查德', name: '理查德', side: 'player', tier: 1, hp: 100, maxHp: 100, mp: 50, maxMp: 50, sp: 50, maxSp: 50, attacksRemaining: 1, actionsRemaining: 1, canAct: true, morale: 'steady', statusEffects: [] },
        冠军: { id: '冠军', name: '冠军', side: 'enemy', tier: 1, hp: 80, maxHp: 80, mp: 0, maxMp: 0, sp: 0, maxSp: 0, attacksRemaining: 1, actionsRemaining: 1, canAct: true, morale: 'steady', statusEffects: [] },
      },
      resourceSnapshots: { FP: 0 },
    };
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-ready').exists()).toBe(false);
    expect(wrapper.find('.combat-header').exists()).toBe(true); // 开打态视图
    expect(wrapper.find('.combat-action-bar').exists()).toBe(true);
  });
});
