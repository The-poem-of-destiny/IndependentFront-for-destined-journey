/**
 * CombatActionBar.test.ts — 玩家输入链路（主持人/DM 模式，2026-08-12）
 *
 * 🎭 核心改造：玩家输入**一律走意图文本 → 战斗主持人解析**（不再本地产 Command）。
 * 核心断言：
 * 1. 四步拼装产出**自然语言意图文本**（如「我方艾萨使用技能火焰术攻击骷髅兵」）
 *    → 调 submitCombatIntent —— 提交的是**文本**，不是 Command 对象。
 * 2. 自由文本原样 → submitCombatIntent —— 不做本地正则解析。
 * 3. 拼装四步不完整 → 「执行行动」按钮禁用。
 * 4. 结束回合 / 逃跑 / 防御 → 也是意图文本（交给主持人理解）。
 * 5. 攻击槽耗尽（Bug 2 UI 侧）→ 普攻/技能 Tab 禁用 + 行内提示。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import type { CombatView } from '@engine/combat-v3';
import type { CharacterState } from '@engine/types';

/** CombatUnitView 不在 combat-v3 公共出口（index.ts 只导 CombatView 等），照
 *  combat-v3-projection.ts 的方式从 CombatView.units 索引推导 */
type CombatUnitView = CombatView['units'][string];

const submitCombatIntent = vi.fn(async (_text: unknown) => {});
const toast = vi.fn();
let mockGame: Record<string, unknown>;
const mockUi = { toast };

vi.mock('../../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../../stores/ui-store', () => ({ useUIStore: () => mockUi }));

import CombatActionBar from './CombatActionBar.vue';

function unit(id: string, side: 'player' | 'enemy'): CombatUnitView {
  return {
    id,
    name: id,
    side,
    tier: 1,
    hp: 100,
    maxHp: 100,
    mp: 20,
    maxMp: 20,
    sp: 10,
    maxSp: 10,
    attacksRemaining: 1,
    actionsRemaining: 1,
    canAct: true,
    morale: 'steady',
    statusEffects: [],
  };
}

function combatView(): CombatView {
  return {
    combatId: 'c1',
    revision: 3,
    phase: 'UnitTurnOpen',
    round: 1,
    initiativeOrder: ['艾萨', '骷髅兵'],
    currentTurnIndex: 0,
    units: { 艾萨: unit('艾萨', 'player'), 骷髅兵: unit('骷髅兵', 'enemy') },
    resourceSnapshots: { FP: 0 },
  };
}

const hero = {
  id: '艾萨',
  name: '艾萨',
  type: 'player',
  hp: 100,
  maxHp: 100,
  skills: [{ name: '火焰术', type: 'active', cost: { type: 'MP', amount: 10 } }],
  inventory: [{ name: '治疗药水', type: 'consumable', quantity: 2 }],
} as unknown as CharacterState;

beforeEach(() => {
  vi.clearAllMocks();
  mockGame = reactive({
    v3ActiveCombat: combatView(),
    combatAwaitingInput: { unit: '艾萨', unitId: '艾萨', round: 1 },
    characters: [hero],
    submitCombatIntent,
  });
});

async function mountBar() {
  const wrapper = mount(CombatActionBar);
  await nextTick();
  return wrapper;
}

/** 点击「行动」Tab（按文案找） */
async function clickTab(wrapper: ReturnType<typeof mount>, label: string) {
  const tab = wrapper.findAll('.action-tab').find((b) => b.text() === label);
  expect(tab, `行动 Tab「${label}」应存在`).toBeDefined();
  await tab!.trigger('click');
}

describe('CombatActionBar — 四步拼装产出意图文本（主持人模式）', () => {
  it('普攻：单位+行动+目标 → submitCombatIntent 收到「对XX发动普通攻击」文本', async () => {
    const w = await mountBar();
    await clickTab(w, '普攻');
    await w.find('select[aria-label="选择目标"]').setValue('骷髅兵');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    const arg = submitCombatIntent.mock.calls[0][0] as string;
    // 🔴 核心断言：提交的是**意图文本**，绝不是 Command 对象
    expect(typeof arg).toBe('string');
    expect(arg).toContain('艾萨');
    expect(arg).toContain('骷髅兵');
    expect(arg).toContain('普通攻击');
  });

  it('技能：单位+技能+目标 → 意图文本含技能名与目标', async () => {
    const w = await mountBar();
    await clickTab(w, '技能');
    await w.find('select[aria-label="选择技能"]').setValue('火焰术');
    await w.find('select[aria-label="选择目标"]').setValue('骷髅兵');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    const arg = submitCombatIntent.mock.calls[0][0] as string;
    expect(arg).toContain('火焰术');
    expect(arg).toContain('骷髅兵');
    expect(arg).toContain('使用技能');
  });

  it('防御：→ 意图文本含「防御姿态」', async () => {
    const w = await mountBar();
    await clickTab(w, '防御');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    const arg = submitCombatIntent.mock.calls[0][0] as string;
    expect(arg).toContain('防御');
  });

  it('逃跑：→ 意图文本含「逃跑」', async () => {
    const w = await mountBar();
    await clickTab(w, '逃跑');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    const arg = submitCombatIntent.mock.calls[0][0] as string;
    expect(arg).toContain('逃跑');
  });

  it('拼装四步不完整 → 「执行行动」禁用', async () => {
    const w = await mountBar();
    expect((w.find('button.inject-btn').element as HTMLButtonElement).disabled).toBe(true);

    await clickTab(w, '普攻');
    await nextTick();
    // 选了行动但没选目标 → 仍禁用
    expect((w.find('button.inject-btn').element as HTMLButtonElement).disabled).toBe(true);

    await w.find('select[aria-label="选择目标"]').setValue('骷髅兵');
    await nextTick();
    expect((w.find('button.inject-btn').element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('CombatActionBar — 结束回合按钮', () => {
  it('按钮存在：点击 → submitCombatIntent 收到「结束本回合」意图文本', async () => {
    const w = await mountBar();
    const btn = w.find('button.end-turn-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    const arg = submitCombatIntent.mock.calls[0][0] as string;
    expect(arg).toContain('结束本回合');
  });

  it('锁定态（敌方回合）→ 结束回合按钮禁用，不触发提交', async () => {
    mockGame.combatAwaitingInput = null;
    const w = await mountBar();
    const btn = w.find('button.end-turn-btn');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    await btn.trigger('click');
    expect(submitCombatIntent).not.toHaveBeenCalled();
  });
});

describe('CombatActionBar — 自由文本原样交主持人（不本地解析）', () => {
  it('攻击文本 → submitCombatIntent 收到原文本（不做正则解析）', async () => {
    const w = await mountBar();
    await w.find('textarea.combat-textarea').setValue('用灼热射线打它，瞄准眼睛！');
    await w.find('button.send-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    // 🔴 核心断言：原文直接交给主持人，不是本地转 Command
    expect(submitCombatIntent).toHaveBeenCalledWith('用灼热射线打它，瞄准眼睛！');
  });

  it('任意文本都原样提交（主持人理解意图，本地不再拒绝）', async () => {
    const w = await mountBar();
    await w.find('textarea.combat-textarea').setValue('随便瞎写点什么自由发挥');
    await w.find('button.send-btn').trigger('click');

    expect(submitCombatIntent).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it('空文本 → 发送按钮禁用，不触发任何提交', async () => {
    const w = await mountBar();
    expect((w.find('button.send-btn').element as HTMLButtonElement).disabled).toBe(true);
    await w.find('textarea.combat-textarea').setValue('  ');
    expect((w.find('button.send-btn').element as HTMLButtonElement).disabled).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Bug 2（2026-08-12）UI 侧：攻击槽耗尽后攻击/技能按钮禁用 + 提示。
// 根因：每单位每回合 1[攻击]+1[动作]（世界书 uid 435），攻击槽用完后 UI 仍允许
// 再点攻击 → 内核 SLOT_EXHAUSTED → coordinator 熔断 abandon 整场（页面闪退）。
// 修复：按钮层直接禁用占攻击槽的行动（普攻/技能），并 toast + 行内文案提示。
// ══════════════════════════════════════════════════════════════════════════
describe('CombatActionBar — 攻击槽耗尽时禁用攻击/技能（Bug 2 UI 侧）', () => {
  it('attacksRemaining=0 → 普攻/技能 Tab 禁用 + 行内提示可见', async () => {
    const view = combatView();
    const exhaustedUnit = { ...view.units['艾萨'], attacksRemaining: 0 };
    mockGame.v3ActiveCombat = reactive({
      ...view,
      units: { ...view.units, 艾萨: exhaustedUnit },
    });

    const w = await mountBar();
    const atkTab = w.findAll('.action-tab').find((b) => b.text() === '普攻');
    const skillTab = w.findAll('.action-tab').find((b) => b.text() === '技能');
    expect((atkTab!.element as HTMLButtonElement).disabled).toBe(true);
    expect((skillTab!.element as HTMLButtonElement).disabled).toBe(true);

    // 被禁用按钮不触发点击 handler（浏览器原生行为）→ 不提交意图
    await atkTab!.trigger('click');
    expect(submitCombatIntent).not.toHaveBeenCalled();

    // 行内提示可见（「攻击槽已用完 · 可点结束回合」）
    const hint = w.find('.attack-slot-hint');
    expect(hint.exists()).toBe(true);
    expect(hint.text()).toContain('攻击槽已用完');
  });

  it('attacksRemaining=1 → 普攻/技能可点，无行内提示', async () => {
    const w = await mountBar();
    const atkTab = w.findAll('.action-tab').find((b) => b.text() === '普攻');
    const skillTab = w.findAll('.action-tab').find((b) => b.text() === '技能');
    expect((atkTab!.element as HTMLButtonElement).disabled).toBe(false);
    expect((skillTab!.element as HTMLButtonElement).disabled).toBe(false);
    expect(w.find('.attack-slot-hint').exists()).toBe(false);
  });
});
