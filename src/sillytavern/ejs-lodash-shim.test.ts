/**
 * ejs-lodash-shim.ts 测试 — 逐方法覆盖（工坊 Phase 2 / D5、D10）
 *
 * 口径：语义对齐 lodash 文档；文件头声明的简化项（matches 浅比较等）按简化后语义断言。
 */

import { describe, it, expect } from 'vitest';
import {
  toPath,
  get,
  trim,
  isArray,
  isObject,
  isObjectLike,
  isEmpty,
  mapValues,
  find,
  flatMap,
  pick,
  pickBy,
  values,
  keys,
  has,
  uniq,
  keyBy,
  chain,
  ejsLodash,
} from './ejs-lodash-shim';

describe('toPath', () => {
  it('点路径切段', () => {
    expect(toPath('a.b.c')).toEqual(['a', 'b', 'c']);
  });

  it('数字下标括号形态', () => {
    expect(toPath('a.b[0].c')).toEqual(['a', 'b', '0', 'c']);
  });

  it('字符串键括号形态', () => {
    expect(toPath('a["b c"].d')).toEqual(['a', 'b c', 'd']);
  });

  it('数组形态原样转字符串', () => {
    expect(toPath(['a', 0, 'b'])).toEqual(['a', '0', 'b']);
  });

  it('空串 / null 返回空数组', () => {
    expect(toPath('')).toEqual([]);
    expect(toPath(null as any)).toEqual([]);
  });
});

describe('get', () => {
  it('取深层值', () => {
    expect(get({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
  });

  it('穿数组下标', () => {
    expect(get({ a: [{ b: 2 }] }, 'a[0].b')).toBe(2);
  });

  it('缺失返回 defaultValue', () => {
    expect(get({ a: 1 }, 'x.y', 'fallback')).toBe('fallback');
  });

  it('值为 undefined 时也返回 defaultValue', () => {
    expect(get({ a: undefined }, 'a', 9)).toBe(9);
  });

  it('值为 null 时返回 null（不落 default）', () => {
    expect(get({ a: null }, 'a', 9)).toBeNull();
  });

  it('中途撞 null 不抛', () => {
    expect(get({ a: null }, 'a.b.c', 'd')).toBe('d');
  });

  it('空路径返回 defaultValue', () => {
    expect(get({ a: 1 }, '', 'd')).toBe('d');
  });
});

describe('trim', () => {
  it('默认去首尾空白', () => {
    expect(trim('  hi \n')).toBe('hi');
  });

  it('指定字符集', () => {
    expect(trim('--abc--', '-')).toBe('abc');
  });

  it('非字符串转字符串', () => {
    expect(trim(42)).toBe('42');
  });

  it('null / undefined 返回空串', () => {
    expect(trim(null)).toBe('');
    expect(trim(undefined)).toBe('');
  });

  it('全是待剥字符时返回空串', () => {
    expect(trim('---', '-')).toBe('');
  });
});

describe('isArray / isObject / isObjectLike', () => {
  it('isArray', () => {
    expect(isArray([])).toBe(true);
    expect(isArray({})).toBe(false);
    expect(isArray('ab')).toBe(false);
  });

  it('isObject 含函数与数组，不含 null', () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(true);
    expect(isObject(() => 0)).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject(1)).toBe(false);
  });

  it('isObjectLike 不含函数', () => {
    expect(isObjectLike({})).toBe(true);
    expect(isObjectLike([])).toBe(true);
    expect(isObjectLike(() => 0)).toBe(false);
    expect(isObjectLike(null)).toBe(false);
  });
});

describe('isEmpty', () => {
  it('null / undefined 为空', () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
  });

  it('数组与字符串按长度', () => {
    expect(isEmpty([])).toBe(true);
    expect(isEmpty([1])).toBe(false);
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('a')).toBe(false);
  });

  it('对象按自有键数', () => {
    expect(isEmpty({})).toBe(true);
    expect(isEmpty({ a: 1 })).toBe(false);
  });

  it('Map / Set 按 size', () => {
    expect(isEmpty(new Map())).toBe(true);
    expect(isEmpty(new Set([1]))).toBe(false);
  });

  it('数字与布尔恒为空', () => {
    expect(isEmpty(0)).toBe(true);
    expect(isEmpty(42)).toBe(true);
    expect(isEmpty(true)).toBe(true);
  });
});

describe('mapValues', () => {
  it('函数 iteratee', () => {
    expect(mapValues({ a: 1, b: 2 }, (v: number) => v * 2)).toEqual({ a: 2, b: 4 });
  });

  it('iteratee 拿得到 key', () => {
    expect(mapValues({ a: 1 }, (_v: number, k: string) => k)).toEqual({ a: 'a' });
  });

  it('字符串简写取属性', () => {
    expect(mapValues({ x: { n: 7 }, y: { n: 8 } }, 'n')).toEqual({ x: 7, y: 8 });
  });

  it('省略 iteratee = identity', () => {
    expect(mapValues({ a: 1 })).toEqual({ a: 1 });
  });

  it('非对象返回空对象', () => {
    expect(mapValues(null)).toEqual({});
  });

  it('不修改源对象', () => {
    const src = { a: 1 };
    mapValues(src, (v: number) => v + 1);
    expect(src).toEqual({ a: 1 });
  });
});

describe('find', () => {
  it('数组 + 函数谓词', () => {
    expect(find([1, 2, 3], (v: number) => v > 1)).toBe(2);
  });

  it('部分对象简写', () => {
    const list = [
      { n: 'a', ok: false },
      { n: 'b', ok: true },
    ];
    expect(find(list, { ok: true })).toEqual({ n: 'b', ok: true });
  });

  it('属性名简写取真值', () => {
    const list = [{ ok: false }, { ok: true }];
    expect(find(list, 'ok')).toEqual({ ok: true });
  });

  it('[路径, 值] 简写', () => {
    const list = [{ n: 'a' }, { n: 'b' }];
    expect(find(list, ['n', 'b'])).toEqual({ n: 'b' });
  });

  it('fromIndex 跳过前缀', () => {
    expect(find([5, 5, 6], (v: number) => v === 5, 1)).toBe(5);
    expect(find([5, 1, 1], (v: number) => v === 5, 1)).toBeUndefined();
  });

  it('对象集合按值查找', () => {
    expect(find({ a: 1, b: 9 }, (v: number) => v > 5)).toBe(9);
  });

  it('无命中返回 undefined', () => {
    expect(find([1], (v: number) => v > 100)).toBeUndefined();
  });
});

describe('flatMap', () => {
  it('展平一层', () => {
    expect(flatMap([1, 2], (v: number) => [v, v])).toEqual([1, 1, 2, 2]);
  });

  it('非数组结果直接入列', () => {
    expect(flatMap([1, 2], (v: number) => v * 2)).toEqual([2, 4]);
  });

  it('只展一层', () => {
    expect(flatMap([1], () => [[9]])).toEqual([[9]]);
  });

  it('对象集合', () => {
    expect(flatMap({ a: 1, b: 2 }, (v: number) => [v])).toEqual([1, 2]);
  });
});

describe('pick / pickBy', () => {
  it('挑扁平键', () => {
    expect(pick({ a: 1, b: 2, c: 3 }, 'a', 'c')).toEqual({ a: 1, c: 3 });
  });

  it('数组形式传路径列表', () => {
    expect(pick({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });
  });

  it('深路径按路径重建', () => {
    expect(pick({ a: { b: 1, c: 2 } }, 'a.b')).toEqual({ a: { b: 1 } });
  });

  it('缺失路径跳过', () => {
    expect(pick({ a: 1 }, 'zzz')).toEqual({});
  });

  it('危险段路径不落地', () => {
    expect(pick({ a: 1 }, '__proto__.polluted')).toEqual({});
    expect(({} as any).polluted).toBeUndefined();
  });

  it('pickBy 默认按真值', () => {
    expect(pickBy({ a: 1, b: 0, c: '' })).toEqual({ a: 1 });
  });

  it('pickBy 自定义谓词拿得到 key', () => {
    expect(pickBy({ aa: 1, b: 2 }, (_v: number, k: string) => k.length > 1)).toEqual({ aa: 1 });
  });

  it('pickBy 非对象返回空对象', () => {
    expect(pickBy(null)).toEqual({});
  });
});

describe('values / keys', () => {
  it('对象', () => {
    expect(values({ a: 1, b: 2 })).toEqual([1, 2]);
    expect(keys({ a: 1, b: 2 })).toEqual(['a', 'b']);
  });

  it('数组', () => {
    expect(values([1, 2])).toEqual([1, 2]);
    expect(keys([1, 2])).toEqual(['0', '1']);
  });

  it('字符串', () => {
    expect(values('ab')).toEqual(['a', 'b']);
    expect(keys('ab')).toEqual(['0', '1']);
  });

  it('null 返回空数组', () => {
    expect(values(null)).toEqual([]);
    expect(keys(null)).toEqual([]);
  });

  it('values 返回数组副本而非原引用', () => {
    const arr = [1];
    expect(values(arr)).not.toBe(arr);
  });
});

describe('has', () => {
  it('自有深路径', () => {
    expect(has({ a: { b: 1 } }, 'a.b')).toBe(true);
  });

  it('缺失路径', () => {
    expect(has({ a: {} }, 'a.b')).toBe(false);
  });

  it('值为 undefined 但键存在 → true', () => {
    expect(has({ a: undefined }, 'a')).toBe(true);
  });

  it('继承属性 → false', () => {
    expect(has({}, 'toString')).toBe(false);
  });

  it('空路径 → false', () => {
    expect(has({ a: 1 }, '')).toBe(false);
  });
});

describe('uniq', () => {
  it('去重保序', () => {
    expect(uniq([3, 1, 3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('NaN 按 SameValueZero 视为相同', () => {
    expect(uniq([NaN, NaN])).toEqual([NaN]);
  });

  it('非数组返回空数组', () => {
    expect(uniq('abc')).toEqual([]);
  });
});

describe('keyBy', () => {
  it('属性名简写', () => {
    const list = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ];
    expect(keyBy(list, 'id')).toEqual({ a: { id: 'a', v: 1 }, b: { id: 'b', v: 2 } });
  });

  it('函数 iteratee', () => {
    expect(keyBy([1, 2], (v: number) => `k${v}`)).toEqual({ k1: 1, k2: 2 });
  });

  it('后来者覆盖同键', () => {
    expect(
      keyBy(
        [
          { id: 'a', v: 1 },
          { id: 'a', v: 2 },
        ],
        'id',
      ),
    ).toEqual({ a: { id: 'a', v: 2 } });
  });

  it('危险键跳过', () => {
    const out = keyBy([{ id: '__proto__' }], 'id');
    expect(Object.keys(out)).toEqual([]);
  });
});

describe('chain', () => {
  it('链式调用后 .value() 取值', () => {
    const out = chain({ a: { b: [3, 1, 3] } })
      .get('a.b')
      .uniq()
      .value();
    expect(out).toEqual([3, 1]);
  });

  it('单步链等价于直调', () => {
    expect(chain('  x  ').trim().value()).toBe('x');
  });

  it('.value() 直接返回原值', () => {
    expect(chain(5).value()).toBe(5);
  });

  it('链上支持谓词类方法', () => {
    expect(chain([]).isEmpty().value()).toBe(true);
  });

  it('多步混合链', () => {
    const out = chain({ a: 1, b: 0, c: 2 }).pickBy().keys().value();
    expect(out).toEqual(['a', 'c']);
  });
});

describe('ejsLodash 注入面', () => {
  it('导出全部 17 个方法 + toPath', () => {
    for (const name of [
      'get',
      'trim',
      'isArray',
      'isObject',
      'isObjectLike',
      'isEmpty',
      'mapValues',
      'find',
      'flatMap',
      'pick',
      'pickBy',
      'values',
      'keys',
      'has',
      'uniq',
      'keyBy',
      'chain',
      'toPath',
    ]) {
      expect(typeof (ejsLodash as any)[name]).toBe('function');
    }
  });
});
