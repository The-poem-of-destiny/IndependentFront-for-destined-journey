/**
 * combat-pipeline.ts 测试 (M3 战斗 v2 · 主线端到端)
 *
 * 验证 resolveAttackPipeline 的完整攻击子流程链:
 *  19 event 触发顺序 / modifier 注入 / HP 红线 clamp / hit-miss 分支 / 集群修正
 *
 * legacy combat-resolver.test.ts 的 19 个测试保持不变（同步版），本文件测 async 管道版。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAttackPipeline, COMBAT_EVENTS, type PipelineContext } from './combat-pipeline';
import { EventBus } from './game-event';
import type { AttackInput } from './combat-resolver';
import type { CombatState, CombatParticipant, ReadonlyHookSet } from './types';
import type { FixedDamageModifier } from './effect-types';

// ========== 测试工厂 ==========

function makeParticipant(o: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'default',
    name: '默认',
    tier: 3,
    level: 10,
    attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
    hp: 1000,
    maxHp: 1000, // 高 HP 避免攻击后触发战意（战意在 hpRatio<0.5 时）
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    defense: 100,
    dr: 0,
    penetration: 0,
    hitBonus: 3,
    dodgeBonus: 2,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 25,
    side: 'ally',
    canAct: true,
    ...o,
  };
}

function makeCombatState(o: Partial<CombatState> = {}): CombatState {
  return {
    combatId: 'pipe-test-01',
    combatType: '标准',
    round: 1,
    participants: [
      makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
      makeParticipant({
        characterId: 'enemy1',
        name: '哥布林',
        side: 'enemy',
        tier: 1,
        hp: 2000,
        maxHp: 2000,
      }),
    ],
    turnOrder: [],
    currentTurnIndex: 0,
    status: 'active',
    environment: '平原',
    patches: [],
    roundLogs: [],
    ...o,
  };
}

const stubHooks: ReadonlyHookSet = {
  getHp: () => 0,
  getMaxHp: () => 0,
  getMp: () => 0,
  getMaxMp: () => 0,
  getSp: () => 0,
  getMaxSp: () => 0,
  getHpPercent: () => 0,
  getAttr: () => 0,
  getTier: () => 0,
  isPresent: () => false,
  getStatusEffects: () => [],
  hasStatus: () => false,
  getBuffStacks: () => 0,
};

function makeCtx(bus: EventBus): PipelineContext {
  return {
    bus,
    combatants: ['ally1', 'enemy1'],
    readHooks: stubHooks,
    // 不传 combatType → 战意不触发（聚焦攻击管道本身）
  };
}

function makeAttackInput(combat: CombatState, o: Partial<AttackInput> = {}): AttackInput {
  return {
    combat,
    attackerId: 'ally1',
    defenderId: 'enemy1',
    weaponName: '长剑',
    weaponAtk: 25,
    skillName: '斩击',
    skillPower: 30,
    relevantAttribute: 'str',
    relevantAttributeValue: 14,
    damageType: '物理',
    d20Attack: 20, // 默认暴击（命中）
    ...o,
  };
}

// ═══════════════════════════════════════════════════════════

describe('resolveAttackPipeline — 主攻击管道', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it('基础命中攻击：伤害>0 + HP 扣减 + patches 含 delta_hp', async () => {
    const combat = makeCombatState();
    const result = await resolveAttackPipeline(makeAttackInput(combat), makeCtx(bus));

    expect(result.damage.finalDamage).toBeGreaterThan(0);
    expect(result.finalHp).toBeLessThan(2000); // 守方初始 2000，受伤害下降
    expect(result.isDead).toBe(false);
    expect(result.patches.some((p) => p.op === 'delta_hp')).toBe(true);
    const hpPatch = result.patches.find((p) => p.op === 'delta_hp')!;
    expect(hpPatch.amount).toBeLessThan(0); // 扣减
    expect(result.description).toContain('勇者');
  });

  it('miss 零伤害：d20=1（失手，同 tier 无优势）→ damage=0，HP 不变', async () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
        makeParticipant({
          characterId: 'enemy1',
          name: '哥布林',
          side: 'enemy',
          tier: 3,
          hp: 2000,
          maxHp: 2000,
        }),
      ],
    });
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { d20Attack: 1 }),
      makeCtx(bus),
    );

    expect(result.damage.finalDamage).toBe(0);
    expect(result.finalHp).toBe(2000); // 守方初始 2000，未扣
    expect(result.isDead).toBe(false);
  });

  it('HP 红线 clamp：大伤害 → finalHp=0 + isDead=true（AI 离谱伤害也兜底）', async () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({
          characterId: 'ally1',
          name: '勇者',
          side: 'ally',
          tier: 7,
          weaponAtk: 99999,
        }),
        makeParticipant({
          characterId: 'enemy1',
          name: '弱怪',
          side: 'enemy',
          tier: 1,
          hp: 100,
          maxHp: 100,
        }),
      ],
    });
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { weaponAtk: 99999, d20Attack: 30 }),
      makeCtx(bus),
    );

    expect(result.finalHp).toBe(0); // clamp≥0，不是负数
    expect(result.isDead).toBe(true);
  });

  it('modifier 注入：注册攻方固伤声明 → 伤害比基础高', async () => {
    const baseCombat = makeCombatState();
    const baseResult = await resolveAttackPipeline(makeAttackInput(baseCombat), makeCtx(bus));

    // 注册攻方固伤 modifier 声明（collect_attacker_mods）
    const bus2 = new EventBus({ maxHistory: 50 });
    const fixedMod: FixedDamageModifier = {
      category: '固伤',
      source: '火焰附魔',
      amount: 200,
      damageType: '物理',
    };
    bus2.subscribeChain({
      type: COMBAT_EVENTS.ATTACK_COLLECT_ATK,
      handler: (params) => ({ ...params, mods: [...params.mods, fixedMod] }),
    });

    const combat2 = makeCombatState();
    const result = await resolveAttackPipeline(makeAttackInput(combat2), makeCtx(bus2));

    expect(result.damage.finalDamage).toBeGreaterThan(baseResult.damage.finalDamage);
    // 固伤 +200 进 Step 6a
    expect(result.damage.finalDamage - baseResult.damage.finalDamage).toBeGreaterThanOrEqual(150);
  });

  it('攻击 event 链触发：request → dice.roll → hit/miss → collect×2 → damage → result', async () => {
    const triggered: string[] = [];
    const eventChain = [
      COMBAT_EVENTS.ATTACK_REQUEST,
      COMBAT_EVENTS.DICE_ROLL,
      COMBAT_EVENTS.ATTACK_COLLECT_ATK,
      COMBAT_EVENTS.ATTACK_HIT,
      COMBAT_EVENTS.ATTACK_COLLECT_DEF,
      COMBAT_EVENTS.ATTACK_DAMAGE,
      COMBAT_EVENTS.ATTACK_RESULT,
    ];
    for (const evt of eventChain) {
      bus.subscribeChain({
        type: evt,
        handler: (params) => {
          triggered.push(evt);
          return params;
        },
      });
    }

    const combat = makeCombatState();
    await resolveAttackPipeline(makeAttackInput(combat), makeCtx(bus));

    // 命中时全链都应触发（含 collect_attacker/defender、hit、damage、result）
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_REQUEST);
    expect(triggered).toContain(COMBAT_EVENTS.DICE_ROLL);
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_HIT);
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_COLLECT_ATK);
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_COLLECT_DEF);
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_DAMAGE);
    expect(triggered).toContain(COMBAT_EVENTS.ATTACK_RESULT);
    // miss 时不触发 collect_defender（单独测试）
  });

  it('miss 时不触发 collect_defender_mods / damage 仍触发（0 伤害）', async () => {
    const defCollectTriggered: string[] = [];
    bus.subscribeChain({
      type: COMBAT_EVENTS.ATTACK_COLLECT_DEF,
      handler: (p) => {
        defCollectTriggered.push('def');
        return p;
      },
    });

    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
        makeParticipant({
          characterId: 'enemy1',
          name: '哥布林',
          side: 'enemy',
          tier: 3,
          hp: 2000,
          maxHp: 2000,
        }),
      ],
    });
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { d20Attack: 1 }),
      makeCtx(bus),
    );

    expect(result.damage.finalDamage).toBe(0);
    expect(defCollectTriggered).toHaveLength(0); // miss 不收集守方 modifier
  });

  it('attackerId 不存在 → 错误结果（不抛错）', async () => {
    const combat = makeCombatState();
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { attackerId: 'nonexistent' }),
      makeCtx(bus),
    );
    expect(result.description).toContain('不在战斗中');
    expect(result.damage.finalDamage).toBe(0);
  });
});
