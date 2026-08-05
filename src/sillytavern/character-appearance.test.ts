/**
 * character-appearance.test.ts — 属性槽模型与合并（D56 / D58）
 *
 * 🔴 这份测试守的是**真机实验逮到的那条定律**：锚里没钉住的属性，模型每张图都
 * 重新决定一次。槽模型消灭它的办法是让「没提到」与「明确不变」在类型上就分开 ——
 * `undefined` 是没说，空串是清空。下面大半条断言都在钉这一条。
 */
import { describe, it, expect } from 'vitest';

import {
  APPEARANCE_SLOT_ORDER,
  EMPTY_APPEARANCE,
  diffFromBase,
  isMeaningfulPatch,
  mergeAppearance,
  renderAppearanceDanbooru,
  renderAppearanceProse,
  stackPatches,
  type CharacterAppearance,
} from './character-appearance';

const ALICE: CharacterAppearance = {
  count: '1girl',
  hairColor: 'silver hair',
  hairStyle: 'very long hair',
  eyes: 'golden eyes',
  build: 'slender',
  features: '',
  outfit: 'white mage robe, gold trim',
  condition: '',
  expression: '',
};

describe('槽表本身（加槽时最容易漏的那一处）', () => {
  it('🔴 渲染顺序表覆盖全部槽 —— 漏一个 = 那个槽永远不进提示词，且静默', () => {
    expect([...APPEARANCE_SLOT_ORDER].sort()).toEqual(Object.keys(EMPTY_APPEARANCE).sort());
  });

  it('空基线里每个槽都存在（值是空串，不是 undefined）', () => {
    for (const slot of APPEARANCE_SLOT_ORDER) {
      expect(EMPTY_APPEARANCE[slot]).toBe('');
    }
  });

  it('count 排第一 —— NAI 的角色槽靠它判断这一格画几个人', () => {
    expect(APPEARANCE_SLOT_ORDER[0]).toBe('count');
  });

  it('condition / expression 压在最后，不该盖过身份特征', () => {
    const tail = APPEARANCE_SLOT_ORDER.slice(-2);
    expect(tail).toEqual(['condition', 'expression']);
  });
});

describe('mergeAppearance —— 「没说」与「清空」必须是两件事', () => {
  it('patch 为空/undefined → 原样返回基线（且是副本，不共享引用）', () => {
    const out = mergeAppearance(ALICE, undefined);
    expect(out).toEqual(ALICE);
    expect(out).not.toBe(ALICE);
    expect(mergeAppearance(ALICE, {})).toEqual(ALICE);
  });

  it('换装：只覆盖 outfit，身份槽一个都不动', () => {
    const out = mergeAppearance(ALICE, { outfit: 'dark travel cloak, leather chestplate' });
    expect(out.outfit).toBe('dark travel cloak, leather chestplate');
    expect(out.hairColor).toBe('silver hair');
    expect(out.hairStyle).toBe('very long hair');
    expect(out.eyes).toBe('golden eyes');
  });

  it('🔴 永久改变：剪发 + 留疤各自落在自己的槽里', () => {
    const out = mergeAppearance(ALICE, {
      hairStyle: 'short hair, shoulder length',
      features: 'scar on face',
    });
    expect(out.hairStyle).toBe('short hair, shoulder length');
    expect(out.features).toBe('scar on face');
    // 发色没被顺手改掉
    expect(out.hairColor).toBe('silver hair');
  });

  it('🔴 空串是**明确清空**，不退回基线（脱掉外袍 ≠ 没提到外袍）', () => {
    const out = mergeAppearance(ALICE, { outfit: '' });
    expect(out.outfit).toBe('');
  });

  it('🔴 没有这个键就是没说 —— 绝不因为「值是假值」而覆盖', () => {
    // 这条正是 `patch.outfit || base.outfit` 那种写法会翻车的地方
    const out = mergeAppearance(ALICE, { condition: 'soaked' });
    expect(out.outfit).toBe('white mage robe, gold trim');
    expect(out.condition).toBe('soaked');
  });

  it('不改动入参（基线与 patch 都不许被就地改）', () => {
    const base = { ...ALICE };
    const patch = { outfit: 'armor' };
    mergeAppearance(base, patch);
    expect(base).toEqual(ALICE);
    expect(patch).toEqual({ outfit: 'armor' });
  });
});

describe('stackPatches —— 会话层逐回合叠加', () => {
  it('新的压旧的', () => {
    const out = stackPatches({ outfit: 'robe' }, { outfit: 'armor' });
    expect(out.outfit).toBe('armor');
  });

  it('新 patch 没提到的槽，保留旧 patch 的值', () => {
    const out = stackPatches({ outfit: 'robe', condition: 'muddy' }, { condition: 'clean' });
    expect(out.outfit).toBe('robe');
    expect(out.condition).toBe('clean');
  });

  it('空串照样是清空，不会被当成「没说」而保留旧值', () => {
    const out = stackPatches({ condition: 'muddy' }, { condition: '' });
    expect(out.condition).toBe('');
  });

  it('两边都空 → 空 patch', () => {
    expect(stackPatches(undefined, undefined)).toEqual({});
  });
});

describe('isMeaningfulPatch —— 挡住与基线等价的噪音行', () => {
  it('与基线逐槽相同的 patch 不值得落库', () => {
    expect(isMeaningfulPatch(ALICE, { hairColor: 'silver hair', outfit: ALICE.outfit })).toBe(
      false,
    );
  });

  it('只要有一个槽不同就值得落库', () => {
    expect(isMeaningfulPatch(ALICE, { hairColor: 'silver hair', condition: 'soaked' })).toBe(true);
  });

  it('空 patch / undefined → false', () => {
    expect(isMeaningfulPatch(ALICE, {})).toBe(false);
    expect(isMeaningfulPatch(ALICE, undefined)).toBe(false);
  });

  it('把某个槽清空**也是**一次有意义的改变', () => {
    expect(isMeaningfulPatch(ALICE, { outfit: '' })).toBe(true);
  });
});

describe('diffFromBase —— 会话行只记差异，不记全量快照', () => {
  it('只留与基线不同的槽', () => {
    const next = { ...ALICE, outfit: 'armor', condition: 'muddy' };
    expect(diffFromBase(ALICE, next)).toEqual({ outfit: 'armor', condition: 'muddy' });
  });

  it('完全一样 → 空 patch', () => {
    expect(diffFromBase(ALICE, { ...ALICE })).toEqual({});
  });

  it('与 mergeAppearance 互为逆运算（差异回填基线得回原值）', () => {
    const next = { ...ALICE, hairStyle: 'short hair', features: 'scar on face' };
    expect(mergeAppearance(ALICE, diffFromBase(ALICE, next))).toEqual(next);
  });
});

describe('渲染', () => {
  it('按槽序拼接，空槽跳过，绝不产出 ", ," 或首尾逗号', () => {
    const out = renderAppearanceDanbooru(ALICE);
    expect(out).toBe(
      '1girl, silver hair, very long hair, golden eyes, slender, white mage robe, gold trim',
    );
    expect(out).not.toMatch(/,\s*,/);
    expect(out.startsWith(',')).toBe(false);
    expect(out.endsWith(',')).toBe(false);
  });

  it('全空基线 → 空串（不是一串逗号）', () => {
    expect(renderAppearanceDanbooru(EMPTY_APPEARANCE)).toBe('');
  });

  it('🔴 权重语法原样透传，不归一化', () => {
    const out = renderAppearanceDanbooru({
      ...EMPTY_APPEARANCE,
      count: '1girl',
      hairColor: '{{silver hair}}',
      eyes: '2::golden eyes::',
      outfit: '[white robe]',
    });
    expect(out).toContain('{{silver hair}}');
    expect(out).toContain('2::golden eyes::');
    expect(out).toContain('[white robe]');
  });

  it('临时状态排在身份特征之后（顺序即权重）', () => {
    const out = renderAppearanceDanbooru({ ...ALICE, condition: 'soaked', expression: 'sad' });
    expect(out.indexOf('silver hair')).toBeLessThan(out.indexOf('soaked'));
    expect(out.indexOf('soaked')).toBeLessThan(out.indexOf('sad'));
  });

  it('prose 方言：同一份槽的第二种渲染（v2 的 OpenAI/Gemini 用）', () => {
    const out = renderAppearanceProse(ALICE);
    expect(out).toContain('silver hair');
    // count 不进自然语 —— 「1girl」在句子里是噪音
    expect(out).not.toContain('1girl');
  });
});
