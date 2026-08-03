import { describe, it, expect } from 'vitest';
import {
  diffVars,
  measureDiffSize,
  deepEqualVars,
  EJS_DIFF_SIZE_LIMIT,
  EJS_VARS_PATH_PREFIX,
  type EjsVarsDiff,
} from './ejs-vars-diff';
import { applyPathOps } from './var-resolver';

/** 取某条 replace 的值（找不到返回 undefined） */
function replaceValue(diff: EjsVarsDiff, path: string): unknown {
  return diff.replace.find((r) => r.path === path)?.value;
}

function removedPaths(diff: EjsVarsDiff): string[] {
  return diff.remove.map((r) => r.path);
}

describe('diffVars — 基础增删改', () => {
  it('两侧相同 → 无任何 op', () => {
    const base = { 计数: 1, 事件: { 冰之歌: { 触发时间: 3 } } };
    const diff = diffVars(base, JSON.parse(JSON.stringify(base)));
    expect(diff).toEqual({ replace: [], remove: [] });
  });

  it('新增顶层键 → replace，路径带 sys. 前缀', () => {
    const diff = diffVars({}, { 计数: 1 });
    expect(diff.replace).toEqual([{ path: 'sys.计数', value: 1 }]);
    expect(diff.remove).toEqual([]);
    expect(EJS_VARS_PATH_PREFIX).toBe('sys');
  });

  it('修改已有值 → replace', () => {
    const diff = diffVars({ 计数: 1 }, { 计数: 2 });
    expect(diff.replace).toEqual([{ path: 'sys.计数', value: 2 }]);
    expect(diff.remove).toEqual([]);
  });

  it('base 有 draft 无 → remove', () => {
    const diff = diffVars({ 计数: 1, 保留: true }, { 保留: true });
    expect(diff.replace).toEqual([]);
    expect(removedPaths(diff)).toEqual(['sys.计数']);
  });

  it('空对象对空对象 → 无 op', () => {
    expect(diffVars({}, {})).toEqual({ replace: [], remove: [] });
  });
});

describe('diffVars — 深嵌套', () => {
  it('嵌套修改只产出叶子路径', () => {
    const base = { 事件: { 冰之歌: { 触发时间: 3, 次数: 1 } } };
    const draft = { 事件: { 冰之歌: { 触发时间: 3, 次数: 2 } } };
    const diff = diffVars(base, draft);
    expect(diff.replace).toEqual([{ path: 'sys.事件.冰之歌.次数', value: 2 }]);
    expect(diff.remove).toEqual([]);
  });

  it('嵌套删除产出嵌套 remove 路径', () => {
    const base = { 事件: { 冰之歌: { 触发时间: 3, 次数: 1 } } };
    const draft = { 事件: { 冰之歌: { 触发时间: 3 } } };
    const diff = diffVars(base, draft);
    expect(diff.replace).toEqual([]);
    expect(removedPaths(diff)).toEqual(['sys.事件.冰之歌.次数']);
  });

  it('base 侧不存在的整棵子树 → 单条 replace 整体写入', () => {
    const diff = diffVars({}, { 事件: { 冰之歌: { 触发时间: 3 } } });
    expect(diff.replace).toEqual([{ path: 'sys.事件', value: { 冰之歌: { 触发时间: 3 } } }]);
  });

  it('子对象被清空 → 逐键 remove，父键保留', () => {
    const diff = diffVars({ 事件: { a: 1, b: 2 } }, { 事件: {} });
    expect(diff.replace).toEqual([]);
    expect(removedPaths(diff).sort()).toEqual(['sys.事件.a', 'sys.事件.b']);
  });

  it('replace 的值是深拷贝 —— 事后改草稿不污染补丁', () => {
    const draft: Record<string, unknown> = { 事件: { 列表: [1, 2] } };
    const diff = diffVars({}, draft);
    (draft.事件 as { 列表: number[] }).列表.push(3);
    expect(replaceValue(diff, 'sys.事件')).toEqual({ 列表: [1, 2] });
  });
});

describe('diffVars — 数组整体替换', () => {
  it('数组深相等 → 不产 op', () => {
    const diff = diffVars({ 信号: [1, { a: 2 }] }, { 信号: [1, { a: 2 }] });
    expect(diff).toEqual({ replace: [], remove: [] });
  });

  it('数组元素变化 → 整根替换（不做元素级 diff）', () => {
    const diff = diffVars({ 信号: [1, 2, 3] }, { 信号: [1, 9, 3] });
    expect(diff.replace).toEqual([{ path: 'sys.信号', value: [1, 9, 3] }]);
  });

  it('数组长度变化 → 整根替换', () => {
    const diff = diffVars({ 信号: [1, 2] }, { 信号: [1, 2, 3] });
    expect(diff.replace).toEqual([{ path: 'sys.信号', value: [1, 2, 3] }]);
    expect(diff.remove).toEqual([]);
  });

  it('嵌套在对象里的数组同样整根替换', () => {
    const diff = diffVars({ 事件: { 信号: [] } }, { 事件: { 信号: ['冰之歌'] } });
    expect(diff.replace).toEqual([{ path: 'sys.事件.信号', value: ['冰之歌'] }]);
  });
});

describe('diffVars — 类型变化', () => {
  it('对象 → 数组：整体替换，不下钻', () => {
    const diff = diffVars({ a: { x: 1 } }, { a: [1] });
    expect(diff.replace).toEqual([{ path: 'sys.a', value: [1] }]);
    expect(diff.remove).toEqual([]);
  });

  it('对象 → 标量：整体替换', () => {
    const diff = diffVars({ a: { x: 1 } }, { a: 5 });
    expect(diff.replace).toEqual([{ path: 'sys.a', value: 5 }]);
  });

  it('标量 → 对象：整体替换', () => {
    const diff = diffVars({ a: 5 }, { a: { x: 1 } });
    expect(diff.replace).toEqual([{ path: 'sys.a', value: { x: 1 } }]);
  });

  it('null 与对象互相转换：整体替换（null 不当对象下钻）', () => {
    expect(diffVars({ a: null }, { a: { x: 1 } }).replace).toEqual([
      { path: 'sys.a', value: { x: 1 } },
    ]);
    expect(diffVars({ a: { x: 1 } }, { a: null }).replace).toEqual([
      { path: 'sys.a', value: null },
    ]);
  });

  it('数组 → 对象：整体替换', () => {
    const diff = diffVars({ a: [1] }, { a: { 0: 1 } });
    expect(diff.replace).toEqual([{ path: 'sys.a', value: { 0: 1 } }]);
  });

  it('字符串 "1" 与数字 1 不相等', () => {
    expect(diffVars({ a: 1 }, { a: '1' }).replace).toEqual([{ path: 'sys.a', value: '1' }]);
  });
});

describe('diffVars — 危险键跳过（原型污染防御）', () => {
  it('draft 侧的 __proto__ / prototype / constructor 自有键不产出 op', () => {
    const draft = JSON.parse(
      '{"__proto__": {"polluted": 1}, "prototype": 2, "constructor": 3, "正常": 4}',
    );
    const diff = diffVars({}, draft);
    expect(diff.replace).toEqual([{ path: 'sys.正常', value: 4 }]);
    expect(diff.remove).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('base 侧的危险键不产出 remove', () => {
    const base = JSON.parse('{"__proto__": {"x": 1}, "constructor": 2, "正常": 3}');
    const diff = diffVars(base, { 正常: 3 });
    expect(diff).toEqual({ replace: [], remove: [] });
  });

  it('嵌套层里的危险键同样跳过', () => {
    const draft = JSON.parse('{"事件": {"__proto__": {"polluted": 1}, "次数": 2}}');
    const diff = diffVars({ 事件: { 次数: 1 } }, draft);
    expect(diff.replace).toEqual([{ path: 'sys.事件.次数', value: 2 }]);
    expect(diff.remove).toEqual([]);
  });

  it('replace 的深拷贝值内部也剔除危险键', () => {
    const draft = JSON.parse('{"事件": {"__proto__": {"polluted": 1}, "次数": 2}}');
    const diff = diffVars({}, draft);
    const value = replaceValue(diff, 'sys.事件') as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(['次数']);
  });
});

describe('diffVars — NaN 与 undefined', () => {
  it('NaN 与 NaN 视为相等 → 无 op', () => {
    expect(diffVars({ a: NaN }, { a: NaN })).toEqual({ replace: [], remove: [] });
  });

  it('NaN 与数字不相等 → replace', () => {
    expect(diffVars({ a: NaN }, { a: 1 }).replace).toEqual([{ path: 'sys.a', value: 1 }]);
    expect(diffVars({ a: 1 }, { a: NaN }).replace).toEqual([{ path: 'sys.a', value: NaN }]);
  });

  it('数组内 NaN 深相等', () => {
    expect(diffVars({ a: [NaN, 1] }, { a: [NaN, 1] })).toEqual({ replace: [], remove: [] });
  });

  it('draft 侧值为 undefined 视同不存在 → 产出 remove', () => {
    const diff = diffVars({ a: 1 }, { a: undefined });
    expect(diff.replace).toEqual([]);
    expect(removedPaths(diff)).toEqual(['sys.a']);
  });

  it('base 侧值为 undefined 视同不存在 → 新增按 replace 处理', () => {
    const diff = diffVars({ a: undefined }, { a: 1 });
    expect(diff.replace).toEqual([{ path: 'sys.a', value: 1 }]);
    expect(diff.remove).toEqual([]);
  });

  it('两侧都是 undefined → 无 op', () => {
    expect(diffVars({ a: undefined }, { a: undefined })).toEqual({ replace: [], remove: [] });
  });
});

describe('deepEqualVars', () => {
  it('基础值与嵌套结构', () => {
    expect(deepEqualVars(1, 1)).toBe(true);
    expect(deepEqualVars(NaN, NaN)).toBe(true);
    expect(deepEqualVars(null, undefined)).toBe(false);
    expect(deepEqualVars({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqualVars({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqualVars([1], { 0: 1 })).toBe(false);
  });

  it('undefined 值的键不参与相等判定', () => {
    expect(deepEqualVars({ a: 1, b: undefined }, { a: 1 })).toBe(true);
  });
});

describe('measureDiffSize 与体积护栏', () => {
  it('上限常量为 256 KB', () => {
    expect(EJS_DIFF_SIZE_LIMIT).toBe(256 * 1024);
  });

  it('空差量体积很小', () => {
    const size = measureDiffSize(diffVars({}, {}));
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(EJS_DIFF_SIZE_LIMIT);
  });

  it('按 UTF-8 字节计（中文键占多字节）', () => {
    const diff = diffVars({}, { 计数: 1 });
    const json = JSON.stringify(diff);
    expect(measureDiffSize(diff)).toBe(new TextEncoder().encode(json).length);
    expect(measureDiffSize(diff)).toBeGreaterThan(json.length);
  });

  it('超大差量可被上限判定拒绝', () => {
    const draft: Record<string, unknown> = { 巨块: 'x'.repeat(300 * 1024) };
    const size = measureDiffSize(diffVars({}, draft));
    expect(size).toBeGreaterThan(EJS_DIFF_SIZE_LIMIT);
  });

  it('无法序列化（循环引用）→ Infinity（必然超限，整份拒绝）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const diff: EjsVarsDiff = { replace: [{ path: 'sys.a', value: cyclic }], remove: [] };
    expect(measureDiffSize(diff)).toBe(Number.POSITIVE_INFINITY);
    expect(measureDiffSize(diff)).toBeGreaterThan(EJS_DIFF_SIZE_LIMIT);
  });
});

describe('与现有写入入口的兼容性（var-resolver.applyPathOps）', () => {
  it('把差量喂给 applyPathOps 能把 base 还原成 draft', () => {
    const base = {
      计数: 1,
      事件: { 冰之歌: { 触发时间: 3, 次数: 1 }, 废弃: true },
      信号: [1, 2],
      形状: { x: 1 },
    };
    const draft = {
      计数: 2,
      事件: { 冰之歌: { 触发时间: 3, 次数: 2 }, 新事件: { 标记: 'a' } },
      信号: [1, 2, 3],
      形状: 'scalar',
      新键: { 深: { 层: 1 } },
    };

    const diff = diffVars(base, draft);
    const applied = applyPathOps({ sys: JSON.parse(JSON.stringify(base)) }, diff);
    expect(applied.sys).toEqual(draft);
  });

  it('纯删除差量也能正确应用', () => {
    const base = { a: 1, b: { c: 2, d: 3 } };
    const draft = { b: { c: 2 } };
    const diff = diffVars(base, draft);
    const applied = applyPathOps({ sys: JSON.parse(JSON.stringify(base)) }, diff);
    expect(applied.sys).toEqual(draft);
  });
});
