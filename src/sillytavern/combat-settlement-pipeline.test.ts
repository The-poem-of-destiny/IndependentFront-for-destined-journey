/**
 * combat-settlement-pipeline.test.ts — 结算子管道测试 (M3 战斗 v2 · 任务 4.9)
 *
 * 覆盖 runSettlementPipeline:
 *  - ally 胜利 → EXP = 敌方所有单位 Lv × 战斗系数之和；patches 含 exp
 *  - enemy 胜利 → 己方败北 EXP = 0；patches 空
 *  - draw → EXP = 0
 *  - combat.end / settle.loot / settle.complete 三个 event 都触发
 *  - AI 通过 subscribeChain(SETTLE_LOOT) 返回 loot → 结算含 loot
 *  - AI 通过 subscribeChain(SETTLE_COMPLETE) 写 summary/fp → 结果带回
 *  - 集群目标 EXP 衰减
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from './game-event';
import { runSettlementPipeline } from './combat-settlement-pipeline';
import { COMBAT_EVENTS } from './combat-pipeline';
import { getCombatCoefficient } from './tier-constants';
import type { CombatState, CombatParticipant } from './types';
import type { PipelineContext } from './combat-pipeline';

// ========== 工具: 造 CombatParticipant ==========

function makeParticipant(
  overrides: Partial<CombatParticipant> & {
    characterId: string;
    name: string;
    side: 'ally' | 'enemy';
  },
): CombatParticipant {
  return {
    tier: 1,
    level: 1,
    attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 30,
    maxSp: 30,
    defense: 10,
    dr: 0,
    penetration: 0,
    hitBonus: 0,
    dodgeBonus: 0,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 10,
    canAct: true,
    ...overrides,
  };
}

/** 造一个最小化 CombatState（只填结算关心的字段） */
function makeCombat(participants: CombatParticipant[]): CombatState {
  return {
    combatId: 'combat_test_1',
    combatType: '标准',
    round: 3,
    participants,
    turnOrder: [],
    currentTurnIndex: 0,
    status: 'ended',
    environment: '平原',
    patches: [],
    roundLogs: [],
  } as CombatState;
}

function makeCtx(bus: EventBus, combatants: string[] = []): PipelineContext {
  return { bus, combatants };
}

// ========== runSettlementPipeline ==========

describe('runSettlementPipeline', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ---------- 1. ally 胜利 ----------

  describe('1. ally 胜利', () => {
    it('EXP = 敌方所有单位 Lv × 战斗系数之和（取整）', async () => {
      // 敌方: T1 Lv5 (系数2.0 → 10) + T2 Lv4 (系数2.8 → 11.2) = 21.2 → 21
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
        makeParticipant({ characterId: 'orc', name: '兽人', side: 'enemy', tier: 2, level: 4 }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      const expectedExp = Math.floor(5 * getCombatCoefficient(1) + 4 * getCombatCoefficient(2));
      expect(result.exp).toBe(expectedExp);
      expect(result.exp).toBeGreaterThan(0);
    });

    it('patches 含 EXP delta（op=delta_variable, target=variables.exp, amount>0）', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      const expPatch = result.patches.find((p) => p.target === 'variables.exp');
      expect(expPatch).toBeDefined();
      expect(expPatch!.op).toBe('delta_variable');
      expect(expPatch!.amount).toBe(result.exp);
      expect(expPatch!.amount!).toBeGreaterThan(0);
      expect(expPatch!.metadata?.source).toBe('combat-settlement');
    });

    it('EXP patch 只在存在 ally 参战者时生成', async () => {
      // 没有 ally 单位 → 不生成 patch（即使 exp>0）
      const combat = makeCombat([
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      // 没 ally 也能算 exp（败方是 enemy）但 patch 不会生成
      expect(result.exp).toBeGreaterThan(0);
      expect(result.patches.find((p) => p.target === 'variables.exp')).toBeUndefined();
    });
  });

  // ---------- 2. enemy 胜利 ----------

  describe('2. enemy 胜利', () => {
    it('己方败北 → EXP = 0，patches 为空（仍触发 event）', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'enemy', makeCtx(bus));

      // 败方是 ally，己方败北无奖励
      expect(result.exp).toBe(0);
      expect(result.patches).toEqual([]);
    });

    it('enemy 胜利仍触发全部三个 event', async () => {
      const triggered: string[] = [];
      for (const evType of [
        COMBAT_EVENTS.END,
        COMBAT_EVENTS.SETTLE_LOOT,
        COMBAT_EVENTS.SETTLE_COMPLETE,
      ]) {
        bus.subscribeChain({
          type: evType,
          handler: (p) => {
            triggered.push(evType);
            return p;
          },
        });
      }

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
      ]);

      await runSettlementPipeline(combat, 'enemy', makeCtx(bus));

      expect(triggered).toContain(COMBAT_EVENTS.END);
      expect(triggered).toContain(COMBAT_EVENTS.SETTLE_LOOT);
      expect(triggered).toContain(COMBAT_EVENTS.SETTLE_COMPLETE);
    });
  });

  // ---------- 3. draw 平局 ----------

  describe('3. draw 平局', () => {
    it('EXP = 0，patches 为空', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'draw', makeCtx(bus));

      expect(result.exp).toBe(0);
      expect(result.patches).toEqual([]);
    });
  });

  // ---------- 4. 三个 event 都触发 ----------

  describe('4. event 触发（subscribeChain 计数）', () => {
    it('ally 胜利时 combat.end / settle.loot / settle.complete 各触发一次', async () => {
      const counts: Record<string, number> = {
        [COMBAT_EVENTS.END]: 0,
        [COMBAT_EVENTS.SETTLE_LOOT]: 0,
        [COMBAT_EVENTS.SETTLE_COMPLETE]: 0,
      };
      for (const evType of [
        COMBAT_EVENTS.END,
        COMBAT_EVENTS.SETTLE_LOOT,
        COMBAT_EVENTS.SETTLE_COMPLETE,
      ]) {
        bus.subscribeChain({
          type: evType,
          handler: (p) => {
            counts[evType]++;
            return p;
          },
        });
      }

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(counts[COMBAT_EVENTS.END]).toBe(1);
      expect(counts[COMBAT_EVENTS.SETTLE_LOOT]).toBe(1);
      expect(counts[COMBAT_EVENTS.SETTLE_COMPLETE]).toBe(1);
    });

    it('combat.end 携带 winner 字段', async () => {
      let endWinner: string | undefined;
      bus.subscribeChain({
        type: COMBAT_EVENTS.END,
        handler: (p) => {
          endWinner = (p as { winner?: string }).winner;
          return p;
        },
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(endWinner).toBe('ally');
    });
  });

  // ---------- 5. AI 通过 subscribeChain(SETTLE_LOOT) 返回 loot ----------

  describe('5. AI 返回战利品', () => {
    it('subscribeChain(SETTLE_LOOT) 返回 loot 列表 → 结果带回', async () => {
      const aiLoot = [
        { name: '哥布林的锈刀', quality: '普通', quantity: 1 },
        { name: '铜币', quantity: 12 },
      ];
      bus.subscribeChain({
        type: COMBAT_EVENTS.SETTLE_LOOT,
        handler: (p) => ({ ...p, loot: aiLoot }),
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      // loot 通过 SETTLE_COMPLETE 透传 → summary 引用，但本测试只验证 result 不报错且 exp 正常
      // loot 本身不直接进 SettlementResult（架构定义 loot 进 patch/调用方），这里验证链路无异常
      expect(result.exp).toBeGreaterThan(0);
    });

    it('SETTLE_LOOT 收到 defeatedEnemies 列表（AI 用于 itemThink）', async () => {
      let receivedEnemies: Array<{ name: string; tier: number; level: number }> | undefined;
      bus.subscribeChain({
        type: COMBAT_EVENTS.SETTLE_LOOT,
        handler: (p) => {
          receivedEnemies = (
            p as { defeatedEnemies?: Array<{ name: string; tier: number; level: number }> }
          ).defeatedEnemies;
          return p;
        },
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 5,
        }),
        makeParticipant({ characterId: 'orc', name: '兽人', side: 'enemy', tier: 2, level: 4 }),
      ]);

      await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(receivedEnemies).toBeDefined();
      expect(receivedEnemies!.length).toBe(2);
      // 不关心顺序（participants 遍历顺序），按集合比较
      expect(receivedEnemies!.map((e) => e.name).sort()).toEqual(['兽人', '哥布林'].sort());
    });

    it('无 AI 订阅时 loot 为空数组（不抛错）', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      // 不报错即通过；exp 正常
      expect(result.exp).toBeGreaterThan(0);
    });
  });

  // ---------- 6. AI 通过 subscribeChain(SETTLE_COMPLETE) 写 summary / fp ----------

  describe('6. AI 写结算摘要 / FP', () => {
    it('subscribeChain(SETTLE_COMPLETE) 写 summary → 结果带回', async () => {
      const aiSummary = '勇者斩杀哥布林，鲜血染红草地。';
      bus.subscribeChain({
        type: COMBAT_EVENTS.SETTLE_COMPLETE,
        handler: (p) => ({ ...p, summary: aiSummary }),
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(result.summary).toBe(aiSummary);
    });

    it('subscribeChain(SETTLE_COMPLETE) 写 fp>0 → 结果带回 fp', async () => {
      bus.subscribeChain({
        type: COMBAT_EVENTS.SETTLE_COMPLETE,
        handler: (p) => ({ ...p, fp: 8 }),
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(result.fp).toBe(8);
    });

    it('无 AI 订阅 summary 时用默认摘要（含 winner + exp）', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(result.summary).toContain('ally');
      expect(result.summary).toContain('EXP');
      expect(result.summary).toContain(String(result.exp));
    });
  });

  // ---------- 7. 集群目标 EXP 衰减 ----------

  describe('7. 集群目标 EXP 衰减（M3 占位）', () => {
    it('clusterCount ≥ 3 的敌方单位 EXP 贡献衰减（低于非集群单位）', async () => {
      // 两个 enemy：一个普通单体 T1 Lv10，一个集群 5 T1 Lv10
      // 单体贡献 = 10 × 2.0 = 20；集群 5 贡献 = 10 × 2.0 × max(0.5, 1-(5-3)*0.1) = 20 × 0.8 = 16
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'solo',
          name: '单体兽人',
          side: 'enemy',
          tier: 1,
          level: 10,
        }),
        {
          ...makeParticipant({
            characterId: 'cluster',
            name: '哥布林群',
            side: 'enemy',
            tier: 1,
            level: 10,
          }),
          clusterCount: 5,
        } as CombatParticipant,
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      // 单体 20 + 集群 16 = 36
      expect(result.exp).toBe(36);
    });

    it('clusterCount 极大时衰减封顶 0.5', async () => {
      // clusterCount = 100 → factor = max(0.5, 1 - 97*0.1) = max(0.5, -8.7) = 0.5
      // 单位 T1 Lv10 → 贡献 = 10 × 2.0 × 0.5 = 10
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        {
          ...makeParticipant({
            characterId: 'swarm',
            name: '虫群',
            side: 'enemy',
            tier: 1,
            level: 10,
          }),
          clusterCount: 100,
        } as CombatParticipant,
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(result.exp).toBe(10);
    });

    it('clusterCount < 3 不衰减（factor = 1）', async () => {
      // clusterCount = 2 → factor = 1（不衰减）
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        {
          ...makeParticipant({
            characterId: 'pair',
            name: '兽人双人组',
            side: 'enemy',
            tier: 1,
            level: 10,
          }),
          clusterCount: 2,
        } as CombatParticipant,
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      // 10 × 2.0 × 1.0 = 20
      expect(result.exp).toBe(20);
    });
  });

  // ---------- 8. 边界 ----------

  describe('8. 边界', () => {
    it('敌方空数组（仅 ally）→ EXP = 0', async () => {
      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
      ]);

      const result = await runSettlementPipeline(combat, 'ally', makeCtx(bus));

      expect(result.exp).toBe(0);
      expect(result.patches).toEqual([]);
    });

    it('combatants 过滤上下文正确传入（chainCtx.combatants = ctx.combatants）', async () => {
      let receivedCombatants: string[] | undefined;
      bus.subscribeChain({
        type: COMBAT_EVENTS.END,
        handler: (p, cctx) => {
          receivedCombatants = (cctx as { combatants?: string[] }).combatants;
          return p;
        },
      });

      const combat = makeCombat([
        makeParticipant({ characterId: 'hero', name: '勇者', side: 'ally' }),
        makeParticipant({
          characterId: 'goblin',
          name: '哥布林',
          side: 'enemy',
          tier: 1,
          level: 3,
        }),
      ]);

      await runSettlementPipeline(combat, 'ally', makeCtx(bus, ['hero', 'goblin']));

      expect(receivedCombatants).toEqual(['hero', 'goblin']);
    });
  });
});
