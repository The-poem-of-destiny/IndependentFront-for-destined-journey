import { describe, expect, it } from 'vitest';

import {
  canonical,
  escapeStateTreeSegment,
  isPlainObject,
  jsonClone,
  unescapeStateTreeSegment,
} from '../../../src/core/variables/state-tree-utils';

describe('state-tree-utils', () => {
  it('isPlainObject 只认非 null、非数组的对象', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });

  it('jsonClone 深拷贝、丢 undefined 键，undefined 原样返回', () => {
    const src = { a: { b: [1, 2] }, c: undefined };
    const out = jsonClone(src);
    expect(out).toEqual({ a: { b: [1, 2] } });
    expect(out).not.toHaveProperty('c');
    expect(out.a).not.toBe(src.a);
    expect(jsonClone(undefined)).toBeUndefined();
  });

  it('canonical 键序无关，值为 undefined 的键视同缺席', () => {
    expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonical({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
    expect(canonical({ a: 1, x: undefined })).toBe(canonical({ a: 1 }));
    expect(canonical(undefined)).toBe('undefined');
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });

  it('路径段转义与反转义互逆（RFC 6901）', () => {
    expect(escapeStateTreeSegment('a/b~c')).toBe('a~1b~0c');
    expect(unescapeStateTreeSegment('a~1b~0c')).toBe('a/b~c');
    for (const s of ['~1', '/~', '普通名字', '~0/~1']) {
      expect(unescapeStateTreeSegment(escapeStateTreeSegment(s))).toBe(s);
    }
  });
});
