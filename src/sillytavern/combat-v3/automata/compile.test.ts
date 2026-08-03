/**
 * combat-v3/automata/compile.test.ts — 编译链测试（M3, 验收 A3-3）
 *
 * 覆盖（plan §5.8 / 验收 A3-3）：
 *   - 9 条校验项逐条 1 个反例（不合规 automaton 编译期剔除）
 *   - errors[] 结构（automatonId / code / message）
 *   - 合规 automaton 进 index（不进 errors、出现在 automata[]）
 *   - modifiers[] → collect_*_mods push-handler（A3-4）
 */

import { describe, it, expect } from 'vitest';
import { compileEffectProgram } from './compile';
import { V3_WINDOW_KEYS_LIVE, V3_WINDOW_KEYS_RESERVED } from '../../combat-item-validator';
import type { EffectAutomaton } from '../types';

const base = {
  owner: '理查德',
  source: '幽怨之剑',
  idPrefix: 'item',
  divinity: 3,
};

/** 一条合规的 DSL automaton（18 窗口内、合法 trigger、合法 intent 类） */
const validAutomaton: EffectAutomaton = {
  id: 'item.幽怨之剑.dsc',
  name: '幽怨之剑·嗜血',
  source: '幽怨之剑',
  owner: '理查德',
  subscribe: 'damage.after',
  trigger: 'ctx.damage.final > 0',
  priority: 0,
  divinity: 1,
  intents: [{ kind: 'Heal', targetId: '理查德', amount: 'ctx.damage.final * 0.1' }],
};

/** 构造一个「故意不合规」的 automaton（subscribe 越界 / trigger 非法等）供编译校验测试 */
function invalid(patch: {
  subscribe?: string;
  trigger?: string;
  intents?: unknown[];
  divinity?: number;
}): EffectAutomaton {
  return { ...(validAutomaton as object), ...(patch as object) } as unknown as EffectAutomaton;
}

describe('compile — 合规 automaton 进 index（A3-3 正向）', () => {
  it('合规 DSL automaton 进入 automata[] 且无 errors', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [validAutomaton],
    });
    expect(errors).toHaveLength(0);
    expect(automata).toHaveLength(1);
    expect(automata[0].subscribe).toBe('damage.after');
    expect(automata[0].isAdapter).toBe(false);
    expect(automata[0].triggerAst.t).toBe('bin');
  });
});

describe('compile — 9 条校验逐条反例', () => {
  it('#1 subscribe 不在 18 窗口 → 剔除 + WINDOW_NOT_FOUND', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [invalid({ subscribe: 'event.evil' })],
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('WINDOW_NOT_FOUND');
  });

  // Q-07：窗口在 18 枚举里、但 phases 里没有求值器。以前这类 automaton 过全部校验、
  // 进索引、tooltip 里显示，然后什么都不做 —— 作者查「反伤为什么不触发」要烧一天。
  it('#1b subscribe 是未接线窗口 → 剔除 + WINDOW_NOT_WIRED', () => {
    for (const w of V3_WINDOW_KEYS_RESERVED) {
      const { automata, errors } = compileEffectProgram({
        ...base,
        automata: [invalid({ subscribe: w })],
      });
      expect(automata, w).toHaveLength(0);
      expect(
        errors.map((e) => e.code),
        w,
      ).toContain('WINDOW_NOT_WIRED');
    }
  });

  it('#1c 已接线窗口不被 WINDOW_NOT_WIRED 误伤', () => {
    for (const w of V3_WINDOW_KEYS_LIVE) {
      const { errors } = compileEffectProgram({
        ...base,
        automata: [invalid({ subscribe: w })],
      });
      expect(
        errors.map((e) => e.code),
        w,
      ).not.toContain('WINDOW_NOT_WIRED');
    }
  });

  it('#2 trigger 表达式文法不合规 → 剔除 + TRIGGER_SYNTAX 带列号', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [invalid({ trigger: 'ctx.damage.final === 0' })], // 单等号
    });
    expect(automata).toHaveLength(0);
    const err = errors.find((e) => e.code === 'TRIGGER_SYNTAX');
    expect(err).toBeTruthy();
    expect(err!.message).toContain('列');
  });

  it('#3 intents[].kind 非法 → 剔除 + INTENT_KIND_ILLEGAL', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [invalid({ intents: [{ kind: 'SetStats', targetId: 'x', amount: 1 } as never] })],
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('INTENT_KIND_ILLEGAL');
  });

  it('#4 OverrideIntent.ruleKey ∈ closed 白名单', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [
        invalid({
          intents: [
            {
              kind: 'OverrideIntent',
              ruleKey: 'kaboom.whatever',
              payload: {},
              divinity: 5,
            } as never,
          ],
        }),
      ],
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('RULEKEY_ILLEGAL');
  });

  it('#5 divinity 超过所有者声明 → 剔除 + DIVINITY_EXCEEDED', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [invalid({ divinity: 8 })], // 所有者 divinity 3
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('DIVINITY_EXCEEDED');
  });

  it('#7 ctx.* 路径根段不在窗口白名单 → 剔除 + CTX_PATH_ILLEGAL', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [
        // damage.after 窗口没有 ctx.enemy 根段 → CTX_PATH_ILLEGAL
        invalid({ trigger: 'ctx.enemy.hp > 0' }),
      ],
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('CTX_PATH_ILLEGAL');
  });

  it('#8 五维直改 → 剔除 + FIVE_DIM_STRAIGHT', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [
        invalid({
          intents: [
            {
              kind: 'AddModifier',
              slot: 'str',
              value: 5,
              scope: 'whole_action',
              targetId: '理查德',
              divinity: 0,
            },
          ] as never,
        }),
      ],
    });
    expect(automata).toHaveLength(0);
    expect(errors.map((e) => e.code)).toContain('FIVE_DIM_STRAIGHT');
  });

  it('#6 超护栏数值 clamp（warn 不剔除）', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      automata: [
        invalid({
          intents: [{ kind: 'Heal', targetId: '理查德', amount: 4_000_000 } as never],
        }),
      ],
    });
    // clamp 是 warn：不剔除，但 errors 含 WARN_CLAMPED
    expect(automata).toHaveLength(1);
    expect(errors.map((e) => e.code)).toContain('WARN_CLAMPED');
  });
});

describe('compile — modifiers[] → push-handler（A3-4）', () => {
  it('固伤 modifier 编译为 collect_attacker_mods + AddModifier(fixedDamage)', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      modifiers: [{ category: '固伤', amount: 50, source: '幽怨之剑' }],
    });
    expect(errors).toHaveLength(0);
    const a = automata.find((x) => x.subscribe === 'collect_attacker_mods');
    expect(a).toBeTruthy();
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'fixedDamage', value: 50 });
  });

  it('DR modifier 编译为 collect_defender_mods + AddModifier(dr)', () => {
    const { automata } = compileEffectProgram({
      ...base,
      modifiers: [{ category: '特殊机制', mechanism: 'DR', value: 20, source: '幽怨之剑' }],
    });
    const a = automata.find((x) => x.subscribe === 'collect_defender_mods');
    expect(a).toBeTruthy();
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'dr', value: 0.2 });
  });

  it('非法 modifier → errors 且不崩', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      modifiers: [{ category: '不存在', amount: 5 }],
    });
    expect(automata).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  // 🆕 S2a 防泄漏（2026-08-01 制造反向链路）：checkType='生产' 不编译进战斗。
  //    否则 slotMap['生产']=undefined 会落到 hitBonus，装备生产加值误成命中（计划 §5 风险）
  it('检定 checkType=生产 → 不编译进战斗（零 automaton、零 errors）', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      modifiers: [{ category: '检定', checkType: '生产', bonus: 5, source: '锻造锤' }],
    });
    expect(automata).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe('compile — ParsedEffect → 内建 adapter', () => {
  it('中文词条「物理伤害: +30」编译为固伤 push-handler', () => {
    const { automata, errors } = compileEffectProgram({
      ...base,
      effects: '物理伤害: +30',
    });
    expect(errors).toHaveLength(0);
    const a = automata.find((x) => x.subscribe === 'collect_attacker_mods');
    expect(a).toBeTruthy();
    expect(a!.intents[0]).toMatchObject({ kind: 'AddModifier', slot: 'fixedDamage', value: 30 });
  });
});

describe('compile — errors[] 结构', () => {
  it('自动化剔除时 errors 记录 automatonId + code + message', () => {
    const { errors } = compileEffectProgram({
      ...base,
      automata: [invalid({ subscribe: 'bad.window' })],
    });
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) {
      expect(typeof e.automatonId).toBe('string');
      expect(typeof e.code).toBe('string');
      expect(typeof e.message).toBe('string');
    }
  });
});
