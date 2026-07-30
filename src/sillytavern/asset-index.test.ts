/**
 * asset-index.test.ts — 由行构建索引
 *
 * 覆盖:
 * 1. 分组: 大类派生（不读行）/ 按名字 / 按类型
 * 2. base vs variant 归位；空串变体等同无变体
 * 3. ★ 撞车决胜确定性: createdAt 最早者胜、同 createdAt 按 id 升序，
 *    且**与数组顺序无关**（打乱输入结论不变）—— 这是本文件最重要的一组
 * 4. ★ 原型污染: 名字/变体是攻击者可控字符串（`__proto__.png` 能过导入管线
 *    的每一道过滤器），构建索引**绝不能**在 `Object.prototype` 上挂键
 * 5. 边界: 空输入 / 名字原样保留（不 trim 不折叠大小写，D2）
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildAssetIndex } from './asset-index';
import type { AssetMetaRecord, AssetType } from './types';

/** 造一行；只写关心的字段，其余给合理缺省 */
function row(over: Partial<AssetMetaRecord> & { id: string; name: string }): AssetMetaRecord {
  const type: AssetType = over.type ?? '头像';
  return {
    type,
    ext: 'png',
    mime: 'image/png',
    bytes: 1024,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

describe('buildAssetIndex — 分组', () => {
  it('空输入给一棵空树（character 桶存在但为空）', () => {
    const index = buildAssetIndex([]);
    expect(index).toEqual({ character: {} });
  });

  it('大类由 type 派生 —— v1 三个类型全落 character', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: '苏婉', type: '头像' }),
      row({ id: 'a2', name: '苏婉', type: '立绘' }),
      row({ id: 'a3', name: '苏婉', type: '立绘bg' }),
    ]);
    expect(Object.keys(index)).toEqual(['character']);
    expect(Object.keys(index.character['苏婉'] ?? {})).toEqual(['头像', '立绘', '立绘bg']);
  });

  it('行里带 category 也不影响分组 —— 大类永不读行（§4.1）', () => {
    const dirty = {
      ...row({ id: 'a1', name: '苏婉', type: '立绘' }),
      category: 'background',
    } as AssetMetaRecord;
    const index = buildAssetIndex([dirty]);
    expect(index.character['苏婉']?.['立绘']?.base).toBe('a1');
    expect((index as Record<string, unknown>)['background']).toBeUndefined();
  });

  it('按名字分桶，互不干扰', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: '苏婉' }),
      row({ id: 'a2', name: '羡愚' }),
    ]);
    expect(index.character['苏婉']?.['头像']?.base).toBe('a1');
    expect(index.character['羡愚']?.['头像']?.base).toBe('a2');
  });

  it('存的是 asset id，不是文件名', () => {
    const index = buildAssetIndex([row({ id: 'asset-7', name: '苏婉' })]);
    expect(index.character['苏婉']?.['头像']?.base).toBe('asset-7');
  });
});

describe('buildAssetIndex — base vs variant', () => {
  it('无变体行占 base，带变体行进 variants', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: '苏婉', type: '立绘' }),
      row({ id: 'a2', name: '苏婉', type: '立绘', variant: '微笑' }),
      row({ id: 'a3', name: '苏婉', type: '立绘', variant: '愤怒' }),
    ]);
    const slot = index.character['苏婉']?.['立绘'];
    expect(slot?.base).toBe('a1');
    expect(slot?.variants).toEqual({ 微笑: 'a2', 愤怒: 'a3' });
  });

  it('只有变体时 base 缺省，variants 恒为对象', () => {
    const index = buildAssetIndex([row({ id: 'a1', name: '苏婉', type: '立绘', variant: '微笑' })]);
    const slot = index.character['苏婉']?.['立绘'];
    expect(slot?.base).toBeUndefined();
    expect(slot?.variants).toEqual({ 微笑: 'a1' });
  });

  it('只有 base 时 variants 是空对象（调用方不必判空）', () => {
    const index = buildAssetIndex([row({ id: 'a1', name: '苏婉' })]);
    expect(index.character['苏婉']?.['头像']?.variants).toEqual({});
  });

  it('空串变体等同无变体 —— 占 base，不产出一个空键', () => {
    const index = buildAssetIndex([row({ id: 'a1', name: '苏婉', variant: '' })]);
    const slot = index.character['苏婉']?.['头像'];
    expect(slot?.base).toBe('a1');
    expect(slot?.variants).toEqual({});
  });

  it('同名不同类型的变体互不覆盖', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: '苏婉', type: '头像', variant: '微笑' }),
      row({ id: 'a2', name: '苏婉', type: '立绘', variant: '微笑' }),
    ]);
    expect(index.character['苏婉']?.['头像']?.variants).toEqual({ 微笑: 'a1' });
    expect(index.character['苏婉']?.['立绘']?.variants).toEqual({ 微笑: 'a2' });
  });
});

describe('buildAssetIndex — 撞车决胜（确定性）', () => {
  it('两行争 base: createdAt 最早者胜', () => {
    const older = row({ id: 'zzz', name: '苏婉', createdAt: 100 });
    const newer = row({ id: 'aaa', name: '苏婉', createdAt: 900 });
    expect(buildAssetIndex([newer, older]).character['苏婉']?.['头像']?.base).toBe('zzz');
    expect(buildAssetIndex([older, newer]).character['苏婉']?.['头像']?.base).toBe('zzz');
  });

  it('createdAt 相同: id 升序取小', () => {
    const a = row({ id: 'a-1', name: '苏婉', createdAt: 500 });
    const b = row({ id: 'b-1', name: '苏婉', createdAt: 500 });
    expect(buildAssetIndex([b, a]).character['苏婉']?.['头像']?.base).toBe('a-1');
    expect(buildAssetIndex([a, b]).character['苏婉']?.['头像']?.base).toBe('a-1');
  });

  it('变体撞车走同一条规则', () => {
    const older = row({ id: 'zzz', name: '苏婉', variant: '微笑', createdAt: 100 });
    const newer = row({ id: 'aaa', name: '苏婉', variant: '微笑', createdAt: 900 });
    expect(buildAssetIndex([newer, older]).character['苏婉']?.['头像']?.variants['微笑']).toBe('zzz');
  });

  it('★ 结论与数组顺序无关 —— 任意排列都给同一棵树', () => {
    const rows = [
      row({ id: 'c', name: '苏婉', createdAt: 300 }),
      row({ id: 'a', name: '苏婉', createdAt: 100 }),
      row({ id: 'b', name: '苏婉', createdAt: 100 }),
      row({ id: 'd', name: '苏婉', variant: '微笑', createdAt: 200 }),
      row({ id: 'e', name: '苏婉', variant: '微笑', createdAt: 200 }),
    ];
    const expected = buildAssetIndex(rows);
    // 三种打乱: 反转 / 旋转 / 交错
    const reversed = [...rows].reverse();
    const rotated = [...rows.slice(2), ...rows.slice(0, 2)];
    const interleaved = [rows[4], rows[0], rows[3], rows[1], rows[2]];
    for (const shuffled of [reversed, rotated, interleaved]) {
      expect(buildAssetIndex(shuffled)).toEqual(expected);
    }
    expect(expected.character['苏婉']?.['头像']?.base).toBe('a');
    expect(expected.character['苏婉']?.['头像']?.variants['微笑']).toBe('d');
  });
});

describe('buildAssetIndex — 原型污染 (安全)', () => {
  /** 每个用例后把可能被挂上的 own 键擦干净，免得污染泄漏到别的测试文件 */
  function protoKeys(): string[] {
    return Object.getOwnPropertyNames(Object.prototype);
  }
  const pristine = protoKeys();
  afterEach(() => {
    for (const key of protoKeys()) {
      if (!pristine.includes(key)) delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  const dangerous = ['__proto__', 'constructor', 'prototype'];

  it.each(dangerous)('名字为 %s 不写脏 Object.prototype', (name) => {
    buildAssetIndex([row({ id: 'evil', name, type: '头像' })]);
    expect(({} as Record<string, unknown>)['头像']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('头像');
  });

  it('变体为 __proto__ 不写脏 Object.prototype（变体也由用户输入做键）', () => {
    buildAssetIndex([row({ id: 'evil', name: '苏婉', type: '头像', variant: '__proto__' })]);
    expect(({} as Record<string, unknown>)['evil']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(protoKeys()).toEqual(pristine);
  });

  it('危险名字仍然照常入索引（防污染不等于丢数据）', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: '__proto__', type: '头像' }),
      row({ id: 'a2', name: '__proto__', type: '头像', variant: '__proto__' }),
    ]);
    const slot = index.character['__proto__']?.['头像'];
    expect(slot?.base).toBe('a1');
    expect(slot?.variants['__proto__']).toBe('a2');
  });

  it('用户输入做键的层是无原型字典（不继承 toString/hasOwnProperty）', () => {
    const index = buildAssetIndex([row({ id: 'a1', name: '苏婉', variant: '微笑' })]);
    expect(Object.getPrototypeOf(index.character)).toBeNull();
    expect(Object.getPrototypeOf(index.character['苏婉'])).toBeNull();
    expect(Object.getPrototypeOf(index.character['苏婉']?.['头像']?.variants)).toBeNull();
    // 于是"名字叫 toString"再也读不出原型上的函数
    expect(index.character['toString']).toBeUndefined();
  });
});

describe('buildAssetIndex — 名字原样保留 (D2)', () => {
  it('大小写 / 尾随空格是不同的键，不归一化', () => {
    const index = buildAssetIndex([
      row({ id: 'a1', name: 'Suwan' }),
      row({ id: 'a2', name: 'suwan' }),
      row({ id: 'a3', name: '苏婉 ' }),
      row({ id: 'a4', name: '苏婉' }),
    ]);
    expect(Object.keys(index.character).sort()).toEqual(['Suwan', 'suwan', '苏婉', '苏婉 '].sort());
    expect(index.character['苏婉']?.['头像']?.base).toBe('a4');
    expect(index.character['苏婉 ']?.['头像']?.base).toBe('a3');
  });

  it('名字带下划线/空格也只是普通键', () => {
    const index = buildAssetIndex([row({ id: 'a1', name: '圣殿_内庭' })]);
    expect(index.character['圣殿_内庭']?.['头像']?.base).toBe('a1');
  });
});
