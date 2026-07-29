/**
 * combat-morale-pipeline.test.ts — 战意子管道测试 (M3 战斗 v2 · 任务 4.8)
 *
 * 覆盖 runMoraleCheckPipeline:
 *  1. HP 高于阈值 → checkMorale 不触发 → 返回 triggered=false
 *  2. HP 低于阈值（低阈值类型「标准」）→ 触发，有 outcome
 *  3. AI 覆盖 outcome: subscribeChain(MORALE_CHECK) 改 params.outcome='投降' → 返回 '投降'
 *  4. AI 不响应（无订阅）→ 走 checkMorale 纯函数兜底 outcome
 *  5. morale.check / morale.result 两个 event 都触发
 *  6. 高阈值类型（切磋）自动触发；低阈值类型（标准）需 d20<12
 *
 * 注: emitChain 只触发 chainHandlers，不触发 subscribeAll/publish 的 handler。
 *     故 event 触发计数用 subscribeChain passthrough；状态字段断言用独立 case。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from './game-event';
import { runMoraleCheckPipeline } from './combat-morale-pipeline';
import { COMBAT_EVENTS } from './combat-pipeline';
import type { PipelineContext } from './combat-pipeline';
import type { CombatType } from './types';

// ========== 工具: 造 ctx ==========

function makeCtx(bus: EventBus, combatants: string[] = []): PipelineContext {
  return { bus, combatants };
}

/** 在指定 type 上挂 passthrough 计数器，返回 { counts, types } */
function attachCounters(bus: EventBus, types: string[]): {
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  for (const t of types) counts[t] = 0;
  for (const t of types) {
    bus.subscribeChain({
      type: t,
      handler: (p) => {
        counts[t]++;
        return p;
      },
    });
  }
  return { counts };
}

// ========== runMoraleCheckPipeline ==========

describe('runMoraleCheckPipeline', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ---------- 1. HP 高于阈值 → 不触发 ----------

  describe('1. HP 高于阈值', () => {
    it('hpRatio=0.8（标准阈值 0.30）→ triggered=false，无 outcome', async () => {
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.8,
        '标准',
        makeCtx(bus),
      );

      expect(result.triggered).toBe(false);
      expect(result.outcome).toBeUndefined();
      expect(result.moraleState).toBe('steady');
    });

    it('hpRatio=0.6（切磋阈值 0.40）→ triggered=false', async () => {
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.6,
        '切磋',
        makeCtx(bus),
      );

      expect(result.triggered).toBe(false);
      expect(result.outcome).toBeUndefined();
    });
  });

  // ---------- 2. HP 低于阈值（低阈值类型）→ 触发 ----------

  describe('2. HP 低于阈值（低阈值类型「标准」）', () => {
    it('hpRatio=0.1 d20=5 (<12) → triggered=true，有 outcome，state=routing', async () => {
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.1,
        '标准',
        makeCtx(bus),
        5, // d20<12 触发
      );

      expect(result.triggered).toBe(true);
      expect(result.outcome).toBeDefined();
      expect(typeof result.outcome).toBe('string');
      expect(result.moraleState).toBe('routing');
    });

    it('hpRatio=0.2 d20=5 → state=routing（routing 结果池）', async () => {
      const result = await runMoraleCheckPipeline(
        'orc',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      // routing 池: 溃逃/阵线溃散/被击昏/被俘虏/内讧/投降/求饶
      const routingPool = [
        '溃逃', '阵线溃散', '被击昏', '被俘虏', '内讧', '投降', '求饶',
      ];
      expect(result.triggered).toBe(true);
      expect(result.outcome).toBeDefined();
      expect(routingPool).toContain(result.outcome);
    });
  });

  // ---------- 3. AI 覆盖 outcome ----------

  describe('3. AI 覆盖 outcome', () => {
    it('subscribeChain(MORALE_CHECK) 改 params.outcome="投降" → 返回 "投降"', async () => {
      bus.subscribeChain({
        type: COMBAT_EVENTS.MORALE_CHECK,
        handler: (p) => ({ ...p, outcome: '投降' }),
      });

      // 用一个本来会触发 checkMorale 的场景（标准 0.2 + d20=5 routing）
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(result.outcome).toBe('投降');
      expect(result.triggered).toBe(true);
    });

    it('即使 checkMorale 未触发（HP 高），AI 写 outcome → 触发且 outcome 带回', async () => {
      bus.subscribeChain({
        type: COMBAT_EVENTS.MORALE_CHECK,
        handler: (p) => ({ ...p, outcome: '撤退' }),
      });

      // hpRatio=0.8 → checkMorale 未触发；但 AI 选了 outcome
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.8,
        '标准',
        makeCtx(bus),
      );

      expect(result.outcome).toBe('撤退');
      // baseResult.triggered=false 但 outcome 有值 → triggered=true
      expect(result.triggered).toBe(true);
    });
  });

  // ---------- 4. AI 不响应 → 走 checkMorale 兜底 ----------

  describe('4. AI 不响应（无订阅）→ 纯函数兜底', () => {
    it('无 MORALE_CHECK 订阅 → 用 checkMorale 纯函数 outcome', async () => {
      // 标准 0.2 + d20=5 → routing → outcome 来自 routing 池第 0 个（seed 默认 0）
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(result.triggered).toBe(true);
      expect(result.outcome).toBeDefined();
      // checkMorale 在 routing 时 pickRandomOutcome(routing, seed=0) → 池[0]='溃逃'
      expect(result.outcome).toBe('溃逃');
    });

    it('高 HP 但无订阅 → triggered=false 无 outcome', async () => {
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.9,
        '标准',
        makeCtx(bus),
      );

      expect(result.triggered).toBe(false);
      expect(result.outcome).toBeUndefined();
    });
  });

  // ---------- 5. 两个 event 都触发 ----------

  describe('5. event 触发计数', () => {
    it('morale.check / morale.result 各触发一次（用 subscribeChain passthrough 计数）', async () => {
      const { counts } = attachCounters(bus, [
        COMBAT_EVENTS.MORALE_CHECK,
        COMBAT_EVENTS.MORALE_RESULT,
      ]);

      await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(counts[COMBAT_EVENTS.MORALE_CHECK]).toBe(1);
      expect(counts[COMBAT_EVENTS.MORALE_RESULT]).toBe(1);
    });

    it('高 HP 不触发场景下两个 event 仍各触发一次（链路常通）', async () => {
      const { counts } = attachCounters(bus, [
        COMBAT_EVENTS.MORALE_CHECK,
        COMBAT_EVENTS.MORALE_RESULT,
      ]);

      await runMoraleCheckPipeline(
        'goblin',
        0.9,
        '标准',
        makeCtx(bus),
      );

      // 不管是否触发战意事件本身，emitChain 调用恒发生
      expect(counts[COMBAT_EVENTS.MORALE_CHECK]).toBe(1);
      expect(counts[COMBAT_EVENTS.MORALE_RESULT]).toBe(1);
    });
  });

  // ---------- 6. 高阈值类型自动触发 / 低阈值类型需 d20<12 ----------

  describe('6. 阈值类型行为', () => {
    it('高阈值类型「切磋」HP 低于阈值 0.40 → 自动触发（无需 d20 检定）', async () => {
      // 切磋阈值 0.40；hpRatio=0.2 → 自动触发
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '切磋',
        makeCtx(bus),
        // d20 不传（高阈值类型忽略 d20）
      );

      expect(result.triggered).toBe(true);
      expect(result.outcome).toBeDefined();
    });

    it('低阈值类型「标准」d20=15 (≥12) → 不触发（triggered=false）', async () => {
      // 标准 0.30；hpRatio=0.2 < 0.30 但 d20=15 ≥ 12 → checkMorale 返回 triggered=false
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        15,
      );

      // checkMorale 在 d20>=12 时 triggered=false 但 moraleState=shaken
      // 我们的实现: triggered = baseResult.triggered || outcome !== undefined
      // baseResult.triggered=false 且 outcome=undefined（checkMorale 在 failed 时无 outcome）→ triggered=false
      expect(result.triggered).toBe(false);
      // 但 checkMorale 给了 moraleState='shaken'
      expect(result.moraleState).toBe('shaken');
    });

    it('低阈值类型「标准」d20=5 (<12) → 触发', async () => {
      const result = await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(result.triggered).toBe(true);
      expect(result.outcome).toBeDefined();
    });

    it('所有 6 种 CombatType 都能调用不抛错', async () => {
      const types: CombatType[] = ['切磋', '竞技', '压制', '死斗', '标准', '守卫'];
      for (const t of types) {
        const result = await runMoraleCheckPipeline(
          'goblin',
          0.05, // 极低 HP，所有类型都该到阈值下
          t,
          makeCtx(bus),
          3, // 低阈值类型 d20<12 触发
        );
        // 只断言不抛错 + 字段存在
        expect(typeof result.triggered).toBe('boolean');
      }
    });
  });

  // ---------- 7. 参数透传（morale.check 携带 hpRatio/combatType/outcomePool）----------

  describe('7. 参数透传给 AI handler', () => {
    it('MORALE_CHECK handler 收到 defenderId/hpRatio/combatType/baseState/outcomePool', async () => {
      let received: Record<string, unknown> | undefined;
      bus.subscribeChain({
        type: COMBAT_EVENTS.MORALE_CHECK,
        handler: (p) => {
          received = p as Record<string, unknown>;
          return p;
        },
      });

      await runMoraleCheckPipeline(
        'orc_chief',
        0.15,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(received).toBeDefined();
      expect(received!.defenderId).toBe('orc_chief');
      expect(received!.hpRatio).toBeCloseTo(0.15);
      expect(received!.combatType).toBe('标准');
      expect(received!.baseState).toBe('routing'); // 0.15/0.30 < 0.25 → routing
      expect(Array.isArray(received!.outcomePool)).toBe(true);
      expect((received!.outcomePool as string[]).length).toBeGreaterThan(0);
    });

    it('MORALE_RESULT handler 收到最终 outcome + triggered', async () => {
      let received: Record<string, unknown> | undefined;
      bus.subscribeChain({
        type: COMBAT_EVENTS.MORALE_CHECK,
        handler: (p) => ({ ...p, outcome: '求饶' }),
      });
      bus.subscribeChain({
        type: COMBAT_EVENTS.MORALE_RESULT,
        handler: (p) => {
          received = p as Record<string, unknown>;
          return p;
        },
      });

      await runMoraleCheckPipeline(
        'goblin',
        0.2,
        '标准',
        makeCtx(bus),
        5,
      );

      expect(received).toBeDefined();
      expect(received!.defenderId).toBe('goblin');
      expect(received!.outcome).toBe('求饶');
      expect(received!.triggered).toBe(true);
    });
  });
});
