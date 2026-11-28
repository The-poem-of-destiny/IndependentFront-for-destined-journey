/**
 * entity-gen-parse.test.ts — 状态解析的层数 / 上限非有限回落
 *
 * 2026-11-27（L5）：`stacks` / `maxStacks` 解析不出数值时不得产出 NaN，
 * 写法与同函数 `remainingTime` 一致（非有限回落、显式 0 保留）。
 */

import { describe, it, expect } from 'vitest';
import { parseStatusEffectsXML, parseStatusesXML } from '../../../src/core/agents/entity-gen-parse';

const effect = (attrs: string) =>
  `<effect owner="理查德" name="中毒" category="减益" ${attrs} timeUnit="回合">毒素侵蚀</effect>`;

describe('parseStatusEffectsXML 层数回落', () => {
  it('stacks 解析不出数值回落 1，maxStacks 跟随回落', () => {
    const [e] = parseStatusEffectsXML(effect('stacks="三层"'));
    expect(e.stacks).toBe(1);
    expect(e.maxStacks).toBe(1);
  });

  it('maxStacks 解析不出数值回落已解析的 stacks', () => {
    const [e] = parseStatusEffectsXML(effect('stacks="3" maxStacks="x"'));
    expect(e.stacks).toBe(3);
    expect(e.maxStacks).toBe(3);
  });

  it('maxStacks 回落时至少为 1（stacks 显式 0 保留）', () => {
    const [e] = parseStatusEffectsXML(effect('stacks="0" maxStacks="x"'));
    expect(e.stacks).toBe(0);
    expect(e.maxStacks).toBe(1);
  });

  it('两者都解析不出时都回落 1', () => {
    const [e] = parseStatusEffectsXML(effect('stacks="三层" maxStacks="满"'));
    expect([e.stacks, e.maxStacks]).toEqual([1, 1]);
  });

  it('合法数值与缺省行为不变', () => {
    const out = parseStatusEffectsXML(
      effect('stacks="2" maxStacks="5"') + effect('stacks="4"') + effect(''),
    );
    expect(out.map((e) => [e.stacks, e.maxStacks])).toEqual([
      [2, 5],
      [4, 4],
      [1, 1],
    ]);
  });

  it('任何输入都不产出 NaN', () => {
    const out = parseStatusEffectsXML(
      effect('stacks="三层"') + effect('maxStacks="x"') + effect('stacks="?" maxStacks="?"'),
    );
    for (const e of out) {
      expect(Number.isFinite(e.stacks)).toBe(true);
      expect(Number.isFinite(e.maxStacks)).toBe(true);
    }
  });
});

describe('parseStatusesXML 层数回落', () => {
  it('stacks / maxStacks 解析不出数值时回落 1，不产出 NaN', () => {
    const out = parseStatusesXML(
      '<status name="中毒" category="减益" stacks="三层" maxStacks="x">毒素侵蚀</status>' +
        '<status name="祝福" category="增益" stacks="2" maxStacks="5">庇佑</status>',
    );
    expect(out.map((s) => [s.name, s.stacks, s.maxStacks])).toEqual([
      ['中毒', 1, 1],
      ['祝福', 2, 5],
    ]);
  });
});
