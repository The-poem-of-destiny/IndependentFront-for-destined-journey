/**
 * bloodlines.test.ts — 血脉系统测试（内容-引擎分离 波 2 / D25②）
 *
 * 🔴 断言从「具体血脉名/描述」改成 **shape + 算法行为**：数据已抽到内容注册表的
 * `bloodlines` 面（`/data/content/bloodlines.json`），引擎里不再有任何血脉常量，
 * 逐字断言 IP 文案的测试也就没有对象了。
 *
 * 覆盖：
 * - 注册表未就绪 → 三个函数的确定性兜底（空集，不抛）
 * - 注册表就绪 → 查询 / 列表 / 修正累加走注册表值
 * - 坏行/坏字段的逐行丢弃（一行坏数据不该让整张表消失）
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  getBloodline,
  getBloodlineList,
  getBloodlineSet,
  calcBloodlineModifiers,
  type BloodlineSet,
} from './bloodlines';
import { getContentRegistry, installContentRegistry } from './content-registry-runtime';

/** 中性 fixture：只验形状与算法，不含任何世界观内容 */
const FIXTURE: BloodlineSet = {
  alpha: { name: '阿尔法', description: '测试血脉 A', statModifiers: { str: 2, con: 2 } },
  beta: { name: '贝塔', description: '测试血脉 B', statModifiers: { dex: 2, int: 1 } },
  gamma: { name: '伽玛', description: '测试血脉 C', statModifiers: { con: -1, spi: 2 } },
  plain: { name: '普通', description: '无修正', statModifiers: {} },
  bare: { name: '裸行', description: '连 statModifiers 字段都没有' },
};

/** 把 fixture 灌进注册表的 bloodlines 面（其余五面不动） */
function seedRegistry(value: unknown): void {
  installContentRegistry({ ...getContentRegistry(), bloodlines: value });
}

afterEach(() => {
  seedRegistry(undefined);
});

// ========== 注册表未就绪时的确定性兜底 ==========

describe('注册表未就绪', () => {
  it('getBloodlineSet 返回空集，不抛', () => {
    seedRegistry(undefined);
    expect(getBloodlineSet()).toEqual({});
  });

  it('getBloodline 返回 undefined、getBloodlineList 返回空数组', () => {
    seedRegistry(undefined);
    expect(getBloodline('alpha')).toBeUndefined();
    expect(getBloodlineList()).toEqual([]);
  });

  it('calcBloodlineModifiers 返回 {}', () => {
    seedRegistry(undefined);
    expect(calcBloodlineModifiers(['alpha', 'beta'])).toEqual({});
  });

  it('该面是数组/字符串等错误形状时同样兜底成空集', () => {
    seedRegistry([1, 2, 3]);
    expect(getBloodlineSet()).toEqual({});
    seedRegistry('not-an-object');
    expect(getBloodlineSet()).toEqual({});
  });
});

// ========== getBloodlineSet（注册表读取缝 + 逐行校验） ==========

describe('getBloodlineSet', () => {
  it('注册表就绪时逐行读出 name / description / statModifiers', () => {
    seedRegistry(FIXTURE);
    const set = getBloodlineSet();
    expect(Object.keys(set).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(set.alpha.name).toBe('阿尔法');
    expect(set.alpha.statModifiers).toEqual({ str: 2, con: 2 });
  });

  it('缺 name / description 的行被丢弃，其余行照常可用', () => {
    seedRegistry({
      ok: { name: '好行', description: '完整' },
      noName: { description: '缺 name' },
      noDesc: { name: '缺 description' },
      notObject: 42,
    });
    const set = getBloodlineSet();
    expect(Object.keys(set)).toEqual(['ok']);
  });

  it('statModifiers 里的非数值被丢弃，数值保留', () => {
    seedRegistry({
      mixed: { name: 'M', description: 'M', statModifiers: { str: 3, dex: 'two', con: null } },
    });
    expect(getBloodlineSet().mixed.statModifiers).toEqual({ str: 3 });
  });

  it('没有 statModifiers 字段的行不会被补出一个空对象', () => {
    seedRegistry(FIXTURE);
    expect(getBloodlineSet().bare.statModifiers).toBeUndefined();
  });
});

// ========== getBloodline ==========

describe('getBloodline', () => {
  it('已知 id 返回完整信息', () => {
    seedRegistry(FIXTURE);
    const result = getBloodline('alpha');
    expect(result).toBeDefined();
    expect(result!.name).toBeTypeOf('string');
    expect(result!.description).toBeTypeOf('string');
    expect(result!.statModifiers).toEqual({ str: 2, con: 2 });
  });

  it('未知 id / 空串返回 undefined', () => {
    seedRegistry(FIXTURE);
    expect(getBloodline('unknown_bloodline')).toBeUndefined();
    expect(getBloodline('')).toBeUndefined();
  });

  it('显式传入的血脉集优先于注册表（参数式缝）', () => {
    seedRegistry(FIXTURE);
    const injected: BloodlineSet = { only: { name: '独苗', description: '注入集' } };
    expect(getBloodline('alpha', injected)).toBeUndefined();
    expect(getBloodline('only', injected)!.name).toBe('独苗');
  });
});

// ========== getBloodlineList ==========

describe('getBloodlineList', () => {
  it('条目数与血脉集键数一致，且 id 完全对应', () => {
    seedRegistry(FIXTURE);
    const list = getBloodlineList();
    expect(list).toHaveLength(Object.keys(FIXTURE).length);
    expect(list.map((it) => it.id).sort()).toEqual(Object.keys(FIXTURE).sort());
  });

  it('每个条目含 id / name / description', () => {
    seedRegistry(FIXTURE);
    for (const item of getBloodlineList()) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.description.length).toBeGreaterThan(0);
    }
  });
});

// ========== calcBloodlineModifiers ==========

describe('calcBloodlineModifiers', () => {
  it('单血脉直接返回它的修正', () => {
    expect(calcBloodlineModifiers(['alpha'], FIXTURE)).toEqual({ str: 2, con: 2 });
  });

  it('空数组返回 {}', () => {
    expect(calcBloodlineModifiers([], FIXTURE)).toEqual({});
  });

  it('空修正血脉返回 {}', () => {
    expect(calcBloodlineModifiers(['plain'], FIXTURE)).toEqual({});
  });

  it('没有 statModifiers 字段的血脉不影响结果', () => {
    expect(calcBloodlineModifiers(['bare', 'alpha'], FIXTURE)).toEqual({ str: 2, con: 2 });
  });

  it('复合血脉按属性合并', () => {
    expect(calcBloodlineModifiers(['alpha', 'beta'], FIXTURE)).toEqual({
      str: 2,
      con: 2,
      dex: 2,
      int: 1,
    });
  });

  it('未知 id 被忽略，不影响结果', () => {
    expect(calcBloodlineModifiers(['alpha', 'unknown', 'also_unknown'], FIXTURE)).toEqual({
      str: 2,
      con: 2,
    });
  });

  it('全部为未知 id 时返回 {}', () => {
    expect(calcBloodlineModifiers(['unknown', 'nope'], FIXTURE)).toEqual({});
  });

  it('同属性多来源累加', () => {
    // alpha: str:2, con:2；beta: dex:2, int:1；再加一个自造的 str 源
    const set: BloodlineSet = {
      ...FIXTURE,
      delta: { name: '德尔塔', description: 'D', statModifiers: { str: 1, con: 2 } },
    };
    expect(calcBloodlineModifiers(['alpha', 'delta'], set)).toEqual({ str: 3, con: 4 });
  });

  it('正负修正相互抵消', () => {
    // alpha: { str: 2, con: 2 }; gamma: { con: -1, spi: 2 }
    expect(calcBloodlineModifiers(['alpha', 'gamma'], FIXTURE)).toEqual({
      str: 2,
      con: 1,
      spi: 2,
    });
  });

  it('三血脉含多个共同属性时逐项累加', () => {
    expect(calcBloodlineModifiers(['alpha', 'beta', 'gamma'], FIXTURE)).toEqual({
      str: 2,
      con: 1,
      dex: 2,
      int: 1,
      spi: 2,
    });
  });
});
