/**
 * model-json.test.ts — 从模型输出抢救 JSON 的唯一入口（Q-05）
 *
 * 四种包裹形态 + 前后夹带解说文字，是真机 debug loop 里天天遇到的现实。
 */

import { describe, it, expect } from 'vitest';
import {
  extractJsonPayload,
  parseModelJson,
  asArray,
  asString,
  asNumber,
  asBoolean,
} from './model-json';

describe('extractJsonPayload —— 四种包裹形态', () => {
  it('① 裸 JSON', () => {
    expect(extractJsonPayload('{"a":1}')).toBe('{"a":1}');
  });

  it('① 裸 JSON 数组', () => {
    expect(extractJsonPayload('  [1,2]  ')).toBe('[1,2]');
  });

  it('② markdown 围栏（带 json 标注）', () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('② markdown 围栏（不带标注）', () => {
    expect(extractJsonPayload('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('② 多个围栏时取第一个内容像 JSON 的', () => {
    expect(extractJsonPayload('```\n不是 JSON\n```\n```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('③ <json> 标签', () => {
    expect(extractJsonPayload('<json>{"a":1}</json>')).toBe('{"a":1}');
  });

  it('④ 前后夹带解说文字 → 贪婪切片', () => {
    expect(extractJsonPayload('好的，这是结果：\n{"a":1}\n希望有帮助！')).toBe('{"a":1}');
  });

  it('抠不到返回 null（不是空串，也不是原文）', () => {
    expect(extractJsonPayload('完全没有 JSON')).toBeNull();
    expect(extractJsonPayload('')).toBeNull();
  });
});

describe('parseModelJson —— 剥壳 + parse + 一次 normalize', () => {
  interface Shape {
    items: string[];
    title: string;
  }
  const normalize = (p: unknown): Shape => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { items: asArray<string>(o.items), title: asString(o.title) };
  };

  it('正常路径', () => {
    expect(parseModelJson('{"items":["a"],"title":"t"}', normalize)).toEqual({
      items: ['a'],
      title: 't',
    });
  });

  // 关键回归：以前主分支逐字段兜底、catch 分支裸 JSON.parse，
  // 缺键输出走兜底路径直接 TypeError，再被上层 catch 吞成 console.warn
  it('缺键输出也过同一条 normalize（不会漏出裸对象）', () => {
    expect(parseModelJson('{"title":"t"}', normalize)).toEqual({ items: [], title: 't' });
  });

  it('字段类型不对也被 normalize 收住', () => {
    expect(parseModelJson('{"items":"不是数组"}', normalize)).toEqual({ items: [], title: '' });
  });

  it('parse 失败返回 null', () => {
    expect(parseModelJson('{坏掉的 JSON', normalize)).toBeNull();
  });

  it('抠不到 JSON 返回 null', () => {
    expect(parseModelJson('没有 JSON', normalize)).toBeNull();
  });

  it('normalize 自己抛错也收成 null，不外泄异常', () => {
    expect(
      parseModelJson('{"a":1}', () => {
        throw new Error('boom');
      }),
    ).toBeNull();
  });
});

describe('字段兜底工具', () => {
  it('asArray', () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray('x')).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });
  it('asString', () => {
    expect(asString('x')).toBe('x');
    expect(asString(1, 'd')).toBe('d');
  });
  it('asNumber（NaN/Infinity 算缺失）', () => {
    expect(asNumber(1)).toBe(1);
    expect(asNumber(NaN, 7)).toBe(7);
    expect(asNumber(Infinity, 7)).toBe(7);
    expect(asNumber('1', 7)).toBe(7);
  });
  it('asBoolean', () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean('true', false)).toBe(false);
  });
});
