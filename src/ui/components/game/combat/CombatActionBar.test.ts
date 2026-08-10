/**
 * CombatActionBar.test.ts — T14 玩家输入改造（设计 2026-08-09 §3.2「统一 AI 解析意图」）
 *
 * 三条核心断言：
 * 1. 四步拼装产出**结构化 Command**（DeclareAttack / DeclareAction / Flee）并调
 *    submitCombatCommand —— 不经过文本解析，不把拼装结果当文本发。
 * 2. 自由文本走引擎解析路径转 Command —— 提交的是 Command 对象，**不是原始文本**。
 * 3. 自由文本解析失败 → 明确拒绝（submitCombatCommand 不被调用）+ toast 提示 + 输入保留。
 * 4. 拼装四步不完整 → 「执行行动」按钮禁用。
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

const submitCombatCommand = vi.fn(async (_cmd: unknown) => {});
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
    submitCombatCommand,
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

describe('CombatActionBar — 四步拼装产出结构化 Command', () => {
  it('普攻：单位+行动+目标 → DeclareAttack（payload 带 targetId + 意图常规）', async () => {
    const w = await mountBar();
    await clickTab(w, '普攻');
    await w.find('select[aria-label="选择目标"]').setValue('骷髅兵');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    expect(submitCombatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'DeclareAttack',
        actorId: '艾萨',
        cost: 'attack',
        payload: expect.objectContaining({ targetId: '骷髅兵', intentionLevel: '常规' }),
      }),
    );
  });

  it('技能：单位+技能+目标 → DeclareAttack（payload 带 skill）', async () => {
    const w = await mountBar();
    await clickTab(w, '技能');
    await w.find('select[aria-label="选择技能"]').setValue('火焰术');
    await w.find('select[aria-label="选择目标"]').setValue('骷髅兵');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    expect(submitCombatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'DeclareAttack',
        cost: 'attack',
        payload: expect.objectContaining({ targetId: '骷髅兵', skill: '火焰术' }),
      }),
    );
  });

  it('防御：→ DeclareAction(actionType: defend)', async () => {
    const w = await mountBar();
    await clickTab(w, '防御');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    expect(submitCombatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'DeclareAction',
        actorId: '艾萨',
        cost: 'action',
        payload: { actionType: 'defend' },
      }),
    );
  });

  it('逃跑：→ Flee', async () => {
    const w = await mountBar();
    await clickTab(w, '逃跑');
    await w.find('button.inject-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    expect(submitCombatCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'Flee', actorId: '艾萨', cost: 'both', payload: {} }),
    );
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
  it('按钮存在：点击 → submitCombatCommand({kind:EndTurn, actorId:当前单位, cost:none})', async () => {
    const w = await mountBar();
    const btn = w.find('button.end-turn-btn');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    expect(submitCombatCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'EndTurn',
        actorId: '艾萨',
        cost: 'none',
        payload: {},
      }),
    );
  });

  it('锁定态（敌方回合）→ 结束回合按钮禁用，不触发提交', async () => {
    mockGame.combatAwaitingInput = null;
    const w = await mountBar();
    const btn = w.find('button.end-turn-btn');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    await btn.trigger('click');
    expect(submitCombatCommand).not.toHaveBeenCalled();
  });
});

describe('CombatActionBar — 自由文本走解析路径（不直接当 Command）', () => {
  it('攻击文本 → 解析成 DeclareAttack Command 提交（不是原始文本）', async () => {
    const w = await mountBar();
    await w.find('textarea.combat-textarea').setValue('攻击骷髅兵');
    await w.find('button.send-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    const arg = submitCombatCommand.mock.calls[0][0] as {
      kind: string;
      payload: { targetId: string };
    };
    // 🔴 核心断言：提交的是 Command 对象，绝不是玩家输入的原字符串
    expect(typeof arg).toBe('object');
    expect(arg).not.toBe('攻击骷髅兵');
    expect(arg.kind).toBe('DeclareAttack');
    expect(arg.payload.targetId).toBe('骷髅兵');
  });

  it('逃跑文本 → 解析成 Flee Command', async () => {
    const w = await mountBar();
    await w.find('textarea.combat-textarea').setValue('我们赶紧逃跑！');
    await w.find('button.send-btn').trigger('click');

    expect(submitCombatCommand).toHaveBeenCalledTimes(1);
    const arg = submitCombatCommand.mock.calls[0][0] as { kind: string };
    expect(arg.kind).toBe('Flee');
  });

  it('解析失败 → 拒绝提交 + toast 提示 + 输入保留（可修改重发）', async () => {
    const w = await mountBar();
    await w.find('textarea.combat-textarea').setValue('随便瞎写点什么');
    await w.find('button.send-btn').trigger('click');

    expect(submitCombatCommand).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('没看懂'), 'warning');
    expect((w.find('textarea.combat-textarea').element as HTMLTextAreaElement).value).toContain(
      '随便瞎写',
    );
  });

  it('空文本 → 发送按钮禁用，不触发任何提交', async () => {
    const w = await mountBar();
    expect((w.find('button.send-btn').element as HTMLButtonElement).disabled).toBe(true);
    await w.find('textarea.combat-textarea').setValue('  ');
    expect((w.find('button.send-btn').element as HTMLButtonElement).disabled).toBe(true);
  });
});
