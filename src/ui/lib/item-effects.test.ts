/**
 * item-effects.test.ts —— 效果词条归一化（真机 2026-08-02：字符串 effects 一字一个的回归防护）
 */
import { describe, it, expect } from 'vitest';
import { normalizeEffects } from './item-effects';

describe('normalizeEffects', () => {
  it('🔴 回归: 字符串形态（item_gen 落库常见）按 `名:描述` 逐条拆解', () => {
    const out = normalizeEffects('材料分析:进行任意生产制作时DC-4');
    expect(out).toEqual({ 材料分析: '进行任意生产制作时DC-4' });
    // 关键断言：不会按字符拆成「材」「料」「分」—— 那正是 2026-08-02 的 bug
    expect(Object.keys(out)).toHaveLength(1);
  });

  it('多词条分号分隔', () => {
    const out = normalizeEffects(
      '能量伤害:造成100%能量伤害; 持续伤害:目标回合开始时造成30点能量伤害，持续2回合',
    );
    expect(out).toEqual({
      能量伤害: '造成100%能量伤害',
      持续伤害: '目标回合开始时造成30点能量伤害，持续2回合',
    });
  });

  it('对象形态原样透传（值里的冒号是描述内容，不是分隔符）', () => {
    const out = normalizeEffects({ 能量伤害: '造成100%能量伤害', 破甲: '无视30%防御' });
    expect(out).toEqual({ 能量伤害: '造成100%能量伤害', 破甲: '无视30%防御' });
  });

  it('数组形态逐条拆解', () => {
    const out = normalizeEffects(['材料分析:进行任意生产制作时DC-4', '炼金加成:检定+4']);
    expect(out).toEqual({ 材料分析: '进行任意生产制作时DC-4', 炼金加成: '检定+4' });
  });

  it('空/undefined → 空对象', () => {
    expect(normalizeEffects(undefined)).toEqual({});
    expect(normalizeEffects('')).toEqual({});
    expect(normalizeEffects(null)).toEqual({});
  });

  it('无冒号片段 → 整个作为 key，desc 为空', () => {
    expect(normalizeEffects('简单被动效果')).toEqual({ 简单被动效果: '' });
  });
});
