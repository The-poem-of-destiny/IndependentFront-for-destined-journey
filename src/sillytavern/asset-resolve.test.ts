/**
 * asset-resolve.test.ts — 素材查找 + 类型回退链
 *
 * 覆盖:
 * 1. 精确命中 / 变体命中 / 变体缺席退 base
 * 2. ★ 立牌链 立绘 → 立绘bg → 头像 —— 只有头像的角色照样填得进立牌槽位
 *    （§7/§11 这条是整个移植最值钱的一行）
 * 3. ★ 脸位链 头像 → 立绘 → 立绘bg —— 反序，因为全身立牌裁进小圆里露的是躯干；
 *    但只有立绘时照样退给它，两种槽位都不留洞
 * 4. ★ 单个类型仍是精确匹配、**绝不降级**（导入 / 设为主图靠它）
 * 5. ★ 严格 `===`（D2）: 大小写差一个字母、尾随一个空格，都**不得**命中
 * 6. 多索引优先级: 数组序在前的索引先赢，哪怕它只有更靠后的类型
 * 7. 边界: 全 miss / 空索引数组 / 只有变体没有 base 时继续走链
 */

import { describe, it, expect } from 'vitest';
import { buildAssetIndex, type AssetIndex } from './asset-index';
import { resolveAsset, ASSET_TYPE_FALLBACK_CHAIN, ASSET_TYPE_AVATAR_CHAIN } from './asset-resolve';
import type { AssetMetaRecord, AssetType } from './types';

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

/** 一个索引 = 一批行 */
function indexOf(...rows: AssetMetaRecord[]): AssetIndex {
  return buildAssetIndex(rows);
}

describe('resolveAsset — 精确命中', () => {
  const index = indexOf(
    row({ id: 'p-base', name: '苏婉', type: '立绘' }),
    row({ id: 'p-smile', name: '苏婉', type: '立绘', variant: '微笑' }),
    row({ id: 'av', name: '苏婉', type: '头像' }),
  );

  it('指定类型 → 该类型的 base', () => {
    expect(resolveAsset([index], '苏婉', '立绘')).toBe('p-base');
    expect(resolveAsset([index], '苏婉', '头像')).toBe('av');
  });

  it('指定变体且存在 → 变体', () => {
    expect(resolveAsset([index], '苏婉', '立绘', '微笑')).toBe('p-smile');
  });

  it('指定变体但不存在 → 退回 base（空手比错图好，但有 base 就别空手）', () => {
    expect(resolveAsset([index], '苏婉', '立绘', '愤怒')).toBe('p-base');
  });

  it('空串变体等同未指定 → base', () => {
    expect(resolveAsset([index], '苏婉', '立绘', '')).toBe('p-base');
  });

  it('指定的类型该角色完全没有 → null（显式类型不走回退链）', () => {
    expect(resolveAsset([index], '苏婉', '立绘bg')).toBeNull();
  });
});

describe('resolveAsset — 类型回退链 立绘 → 立绘bg → 头像', () => {
  it('链的顺序就是这三档（不是 ASSET_TYPES 的展示序）', () => {
    expect(ASSET_TYPE_FALLBACK_CHAIN).toEqual(['立绘', '立绘bg', '头像']);
  });

  it('三档都有 → 取 立绘', () => {
    const index = indexOf(
      row({ id: 'av', name: '苏婉', type: '头像' }),
      row({ id: 'bg', name: '苏婉', type: '立绘bg' }),
      row({ id: 'p', name: '苏婉', type: '立绘' }),
    );
    expect(resolveAsset([index], '苏婉')).toBe('p');
  });

  it('缺 立绘 → 退 立绘bg', () => {
    const index = indexOf(
      row({ id: 'av', name: '苏婉', type: '头像' }),
      row({ id: 'bg', name: '苏婉', type: '立绘bg' }),
    );
    expect(resolveAsset([index], '苏婉')).toBe('bg');
  });

  it('★ 只有 头像 → 照样命中（半成品美术包优雅降级，不留洞）', () => {
    const index = indexOf(row({ id: 'av', name: '苏婉', type: '头像' }));
    expect(resolveAsset([index], '苏婉')).toBe('av');
  });

  it('回退时变体请求跟着走: 立绘bg 有该变体就给变体', () => {
    const index = indexOf(
      row({ id: 'bg-base', name: '苏婉', type: '立绘bg' }),
      row({ id: 'bg-night', name: '苏婉', type: '立绘bg', variant: '夜' }),
    );
    expect(resolveAsset([index], '苏婉', undefined, '夜')).toBe('bg-night');
  });

  it('某档只有别的变体、连 base 都没有 → 继续走链下一档，不乱挑变体', () => {
    const index = indexOf(
      row({ id: 'p-smile', name: '苏婉', type: '立绘', variant: '微笑' }),
      row({ id: 'av', name: '苏婉', type: '头像' }),
    );
    // 请求「愤怒」: 立绘 只有「微笑」且无 base → 不返回 p-smile，落到 头像
    expect(resolveAsset([index], '苏婉', undefined, '愤怒')).toBe('av');
  });

  it('该名字整个不在库里 → null', () => {
    const index = indexOf(row({ id: 'av', name: '苏婉' }));
    expect(resolveAsset([index], '羡愚')).toBeNull();
  });
});

describe('resolveAsset — 脸位链 头像 → 立绘 → 立绘bg', () => {
  it('两条链装同一批类型，只是首选相反（谁都不会漏掉一档）', () => {
    expect(ASSET_TYPE_AVATAR_CHAIN).toEqual(['头像', '立绘', '立绘bg']);
    expect([...ASSET_TYPE_AVATAR_CHAIN].sort()).toEqual([...ASSET_TYPE_FALLBACK_CHAIN].sort());
    expect(ASSET_TYPE_AVATAR_CHAIN[0]).not.toBe(ASSET_TYPE_FALLBACK_CHAIN[0]);
  });

  it('★ 头像与立绘都有 → 取 头像（与立牌链在同一份库上得出相反答案）', () => {
    const index = indexOf(
      row({ id: 'p', name: '苏婉', type: '立绘' }),
      row({ id: 'av', name: '苏婉', type: '头像' }),
    );
    expect(resolveAsset([index], '苏婉', ASSET_TYPE_AVATAR_CHAIN)).toBe('av');
    expect(resolveAsset([index], '苏婉', ASSET_TYPE_FALLBACK_CHAIN)).toBe('p');
  });

  it('★ 只有 立绘 → 脸位照样命中（这条曾经是坏的: 圆框显示首字母）', () => {
    const index = indexOf(row({ id: 'p', name: '苏婉', type: '立绘' }));
    expect(resolveAsset([index], '苏婉', ASSET_TYPE_AVATAR_CHAIN)).toBe('p');
  });

  it('只有 立绘bg → 退到第三档', () => {
    const index = indexOf(row({ id: 'bg', name: '苏婉', type: '立绘bg' }));
    expect(resolveAsset([index], '苏婉', ASSET_TYPE_AVATAR_CHAIN)).toBe('bg');
  });

  it('走链时变体请求跟着走到命中的那一档', () => {
    const index = indexOf(
      row({ id: 'p-base', name: '苏婉', type: '立绘' }),
      row({ id: 'p-smile', name: '苏婉', type: '立绘', variant: '微笑' }),
    );
    expect(resolveAsset([index], '苏婉', ASSET_TYPE_AVATAR_CHAIN, '微笑')).toBe('p-smile');
  });

  it('该名字整个不在库里 → null（链走完也不瞎给）', () => {
    const index = indexOf(row({ id: 'av', name: '苏婉', type: '头像' }));
    expect(resolveAsset([index], '羡愚', ASSET_TYPE_AVATAR_CHAIN)).toBeNull();
  });

  it('自定义链也照走（链就是个有序数组，没有白名单）', () => {
    const index = indexOf(
      row({ id: 'av', name: '苏婉', type: '头像' }),
      row({ id: 'bg', name: '苏婉', type: '立绘bg' }),
    );
    expect(resolveAsset([index], '苏婉', ['立绘bg', '头像'])).toBe('bg');
    // 空链 = 什么都不接受 → null（不偷偷回落到缺省链）
    expect(resolveAsset([index], '苏婉', [])).toBeNull();
  });
});

describe('resolveAsset — 单个类型绝不降级（向后兼容 / 导入与设为主图靠它）', () => {
  const index = indexOf(
    row({ id: 'av', name: '苏婉', type: '头像' }),
    row({ id: 'p', name: '苏婉', type: '立绘' }),
  );

  it('单个类型 = 精确匹配，其它档一个都不看', () => {
    expect(resolveAsset([index], '苏婉', '头像')).toBe('av');
    expect(resolveAsset([index], '苏婉', '立绘')).toBe('p');
    // 库里有另外两档，但请求的是 立绘bg → 必须空手（若降级，这里会给 av 或 p）
    expect(resolveAsset([index], '苏婉', '立绘bg')).toBeNull();
  });

  it('单元素数组与单个类型等价', () => {
    expect(resolveAsset([index], '苏婉', ['立绘bg'])).toBeNull();
    expect(resolveAsset([index], '苏婉', ['头像'])).toBe('av');
  });
});

describe('resolveAsset — 严格 === (D2，刻意不归一化)', () => {
  const index = indexOf(row({ id: 'av', name: '苏婉' }), row({ id: 'en', name: 'Suwan' }));

  it('尾随空格不命中', () => {
    expect(resolveAsset([index], '苏婉 ')).toBeNull();
  });

  it('前导空格不命中', () => {
    expect(resolveAsset([index], ' 苏婉')).toBeNull();
  });

  it('大小写差异不命中', () => {
    expect(resolveAsset([index], 'suwan')).toBeNull();
    expect(resolveAsset([index], 'SUWAN')).toBeNull();
    expect(resolveAsset([index], 'Suwan')).toBe('en');
  });

  it('内部空白不折叠', () => {
    const spaced = indexOf(row({ id: 'a1', name: '苏  婉' }));
    expect(resolveAsset([spaced], '苏 婉')).toBeNull();
    expect(resolveAsset([spaced], '苏  婉')).toBe('a1');
  });

  it('变体也是严格相等', () => {
    const withVariant = indexOf(row({ id: 'a1', name: '苏婉', variant: '微笑' }));
    expect(resolveAsset([withVariant], '苏婉', '头像', '微笑 ')).toBeNull();
    expect(resolveAsset([withVariant], '苏婉', '头像', '微笑')).toBe('a1');
  });
});

describe('resolveAsset — 多索引优先级', () => {
  it('数组序在前的索引赢', () => {
    const first = indexOf(row({ id: 'first', name: '苏婉', type: '立绘' }));
    const second = indexOf(row({ id: 'second', name: '苏婉', type: '立绘' }));
    expect(resolveAsset([first, second], '苏婉', '立绘')).toBe('first');
    expect(resolveAsset([second, first], '苏婉', '立绘')).toBe('second');
  });

  it('★ 前面的索引只有 头像 也胜过后面索引的 立绘 —— 索引序是外层循环', () => {
    const highPriority = indexOf(row({ id: 'hi-av', name: '苏婉', type: '头像' }));
    const lowPriority = indexOf(row({ id: 'lo-portrait', name: '苏婉', type: '立绘' }));
    expect(resolveAsset([highPriority, lowPriority], '苏婉')).toBe('hi-av');
  });

  it('★ 脸位链同理: 前面索引只有 立绘 也胜过后面索引的 头像（索引序永远是外层）', () => {
    const highPriority = indexOf(row({ id: 'hi-portrait', name: '苏婉', type: '立绘' }));
    const lowPriority = indexOf(row({ id: 'lo-av', name: '苏婉', type: '头像' }));
    // 若把循环嵌套写反（链在外、索引在内），这里会给 lo-av —— 来源优先级就没了
    expect(resolveAsset([highPriority, lowPriority], '苏婉', ASSET_TYPE_AVATAR_CHAIN)).toBe(
      'hi-portrait',
    );
  });

  it('前面的索引没有该名字 → 落到后面的索引', () => {
    const other = indexOf(row({ id: 'x', name: '羡愚' }));
    const mine = indexOf(row({ id: 'av', name: '苏婉' }));
    expect(resolveAsset([other, mine], '苏婉')).toBe('av');
  });

  it('前面索引有该名字但该类型只有变体、无 base → 仍可落到后面索引', () => {
    const front = indexOf(row({ id: 'f-smile', name: '苏婉', type: '立绘', variant: '微笑' }));
    const back = indexOf(row({ id: 'b-base', name: '苏婉', type: '立绘' }));
    expect(resolveAsset([front, back], '苏婉', '立绘', '愤怒')).toBe('b-base');
  });
});

describe('resolveAsset — 边界', () => {
  it('空索引数组 → null', () => {
    expect(resolveAsset([], '苏婉')).toBeNull();
    expect(resolveAsset([], '苏婉', '立绘', '微笑')).toBeNull();
  });

  it('空树索引 → null', () => {
    expect(resolveAsset([indexOf()], '苏婉')).toBeNull();
  });

  it('空名字不误命中（库里没有空名字的行）', () => {
    expect(resolveAsset([indexOf(row({ id: 'av', name: '苏婉' }))], '')).toBeNull();
  });

  it('不会命中到 Object.prototype 上的键（__proto__ / toString）', () => {
    const index = indexOf(row({ id: 'av', name: '苏婉' }));
    expect(resolveAsset([index], 'toString')).toBeNull();
    expect(resolveAsset([index], 'constructor')).toBeNull();
  });
});
