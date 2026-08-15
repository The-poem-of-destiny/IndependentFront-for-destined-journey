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
const confirmCombatSummary = vi.fn();
const discardCombatSummary = vi.fn();
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
    combatSummaryReview: null,
    v3ActiveCombat: null,
    combatLog: [],
    combatAwaitingInput: null,
    combatCurrentUnitId: null,
    player: { name: '理查德' },
    characters: [],
    startCombat,
    skipCombat,
    restartCombat,
    confirmCombatSummary,
    discardCombatSummary,
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
        理查德: {
          id: '理查德',
          name: '理查德',
          side: 'player',
          tier: 1,
          hp: 100,
          maxHp: 100,
          mp: 50,
          maxMp: 50,
          sp: 50,
          maxSp: 50,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
        冠军: {
          id: '冠军',
          name: '冠军',
          side: 'enemy',
          tier: 1,
          hp: 80,
          maxHp: 80,
          mp: 0,
          maxMp: 0,
          sp: 0,
          maxSp: 0,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
      },
      resourceSnapshots: { FP: 0 },
    };
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-ready').exists()).toBe(false);
    expect(wrapper.find('.combat-header').exists()).toBe(true); // 开打态视图
    expect(wrapper.find('.combat-action-bar').exists()).toBe(true);
    expect(wrapper.text()).toContain('100 / 100');
  });

  it('开打态 v3_action 日志（attackerId/targetId 是 UUID）：units 字典经 CombatMessageFlow 透传，卡片标题渲染中文名', async () => {
    mockGame.combatReady = null;
    // 生产形状：单位 id 是 UUID、name 是中文名；v3_action 里塞的是 UUID
    const A = '2011502d-0fb3-4d0e-97d9-cd1e300edd86';
    const B = '7f3c9b21-5a4e-4d8f-9b1a-2c6d8e0f4a53';
    mockGame.v3ActiveCombat = {
      combatId: 'c1',
      revision: 0,
      phase: 'CombatOpen',
      round: 1,
      initiativeOrder: [A, B],
      currentTurnIndex: 0,
      units: {
        [A]: {
          id: A,
          name: '奥利雅思',
          side: 'player',
          tier: 1,
          hp: 100,
          maxHp: 100,
          mp: 50,
          maxMp: 50,
          sp: 50,
          maxSp: 50,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
        [B]: {
          id: B,
          name: '灰皮巨鼠',
          side: 'enemy',
          tier: 1,
          hp: 80,
          maxHp: 80,
          mp: 0,
          maxMp: 0,
          sp: 0,
          maxSp: 0,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
      },
      resourceSnapshots: { FP: 0 },
    };
    mockGame.combatLog = [
      {
        id: 'log-1',
        kind: 'action',
        toolName: 'attack',
        result: {
          attackerId: A,
          targetId: B,
          skill: '灼热射线',
          checkValue: 15,
          rating: '有效',
          hit: true,
          final: 161,
          damageType: '能量',
          targetHpBefore: 625,
          targetHpAfter: 464,
        },
      },
    ];
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-action-card').exists()).toBe(true);
    // 标题的攻方/守方两个 .cac-name（中间是 CSS 伪元素箭头，text() 不含 →）
    const names = wrapper.findAll('.combat-action-card .cac-name').map((n) => n.text());
    expect(names).toEqual(['奥利雅思', '灰皮巨鼠']);
    const text = wrapper.find('.combat-action-card').text();
    expect(text).not.toContain(A);
    expect(text).not.toContain(B);
  });

  it('开打态 AI 思考中（非等玩家输入）→ 消息流末尾显示「思考中…」转圈；等玩家输入时不显示', async () => {
    mockGame.combatReady = null;
    mockGame.v3ActiveCombat = {
      combatId: 'c1',
      revision: 0,
      phase: 'SlotConsume',
      round: 1,
      initiativeOrder: ['理查德', '冠军'],
      currentTurnIndex: 1,
      units: {
        理查德: {
          id: '理查德',
          name: '理查德',
          side: 'player',
          tier: 1,
          hp: 100,
          maxHp: 100,
          mp: 50,
          maxMp: 50,
          sp: 50,
          maxSp: 50,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
        冠军: {
          id: '冠军',
          name: '冠军',
          side: 'enemy',
          tier: 1,
          hp: 80,
          maxHp: 80,
          mp: 0,
          maxMp: 0,
          sp: 0,
          maxSp: 0,
          attacksRemaining: 1,
          actionsRemaining: 1,
          canAct: true,
          morale: 'steady',
          statusEffects: [],
        },
      },
      resourceSnapshots: { FP: 0 },
    };
    // 不等玩家输入 → AI 思考中
    mockGame.combatAwaitingInput = null;
    const wrapper = await mountPanel();
    expect(wrapper.find('.thinking-indicator').exists()).toBe(true);
    expect(wrapper.find('.thinking-text').text()).toContain('思考中');

    // 等玩家输入 → 不显示思考中
    mockGame.combatAwaitingInput = { unit: '理查德', unitId: '理查德', round: 1 };
    await nextTick();
    expect(wrapper.find('.thinking-indicator').exists()).toBe(false);
  });

  it('终局 phase（Terminal / SettlementCommitted）→ 不显示思考中（战斗已结束）', async () => {
    mockGame.combatReady = null;
    mockGame.v3ActiveCombat = {
      combatId: 'c1',
      revision: 0,
      phase: 'SettlementCommitted',
      round: 3,
      initiativeOrder: ['理查德', '冠军'],
      currentTurnIndex: 0,
      units: {},
      resourceSnapshots: { FP: 0 },
    };
    mockGame.combatAwaitingInput = null;
    const wrapper = await mountPanel();
    expect(wrapper.find('.thinking-indicator').exists()).toBe(false);
  });
});

describe('CombatPanel 结算确认态（2026-08-13 需求 D）', () => {
  function setSettlement() {
    mockGame.combatReady = null;
    mockGame.combatSummaryReview = {
      outcome: 'ally_win',
      totalExp: 2,
      totalFp: 5,
      loot: [{ name: '断爪', description: '魔物爪甲', quantity: 2, quality: '普通' }],
      rounds: 2,
      summaryText: '奥利雅思以灼热射线贯穿魔物咽喉，获胜。',
    };
  }

  it('combatSummaryReview 置位：渲染结算分支（结果/回合/经验/战利品 + 预填摘要），不渲染就绪/开打态', async () => {
    setSettlement();
    const wrapper = await mountPanel();

    expect(wrapper.find('.combat-settlement').exists()).toBe(true);
    expect(wrapper.find('.combat-ready-title').text()).toContain('战斗结算');
    expect(wrapper.find('.combat-ready-title').text()).toContain('胜利');
    const stats = wrapper.find('.css-stats').text();
    expect(stats).toContain('2'); // rounds
    expect(stats).toContain('+2'); // exp
    expect(stats).toContain('断爪×2'); // loot
    // 摘要 textarea 预填 AI 文本
    const editor = wrapper.find('.css-editor');
    expect((editor.element as HTMLTextAreaElement).value).toContain('灼热射线');
    // 其它两态不出现
    expect(wrapper.find('.combat-ready').exists()).toBe(false);
    expect(wrapper.find('.combat-header').exists()).toBe(false);
  });

  it('玩家编辑摘要后点「注入正文」→ confirmCombatSummary 收到编辑后的文本', async () => {
    setSettlement();
    const wrapper = await mountPanel();
    const editor = wrapper.find('.css-editor');
    await editor.setValue('我改过的战斗总结。');
    const btn = wrapper.findAll('button').find((b) => b.text().includes('注入正文'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await nextTick();
    expect(confirmCombatSummary).toHaveBeenCalledTimes(1);
    expect(confirmCombatSummary).toHaveBeenCalledWith('我改过的战斗总结。');
  });

  it('点「放弃注入」→ discardCombatSummary（数值不回滚，叙事不进正文）', async () => {
    setSettlement();
    const wrapper = await mountPanel();
    const btn = wrapper.findAll('button').find((b) => b.text().includes('放弃注入'));
    expect(btn).toBeTruthy();
    await btn!.trigger('click');
    await nextTick();
    expect(discardCombatSummary).toHaveBeenCalledTimes(1);
  });
});
