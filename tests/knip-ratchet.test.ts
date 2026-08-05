import { describe, expect, it } from 'vitest';
import { collectFindings, compareToBaseline } from '../scripts/knip-ratchet.mjs';

/**
 * 棘轮的比对逻辑测试。
 *
 * 这里**不跑 knip**（那是几十秒的进程），只测两个纯函数：报告摊平 + 基线比对。
 * 真正「棘轮能不能拦住新死导出」的端到端验证在 CI 之外做过一次（故意加一个未引用导出，
 * 确认退出码 1），那种验证不适合每次跑。
 */

describe('collectFindings', () => {
  it('把 knip 报告摊平成 类型|文件|名字 的身份', () => {
    const report = {
      issues: [
        {
          file: 'src/a.ts',
          exports: [{ name: 'foo' }, { name: 'bar' }],
          types: [{ name: 'Baz' }],
        },
        { file: 'src/b.vue', files: [{ name: 'src/b.vue' }] },
      ],
    };

    expect(collectFindings(report)).toEqual([
      'exports|src/a.ts|bar',
      'exports|src/a.ts|foo',
      'files|src/b.vue|src/b.vue',
      'types|src/a.ts|Baz',
    ]);
  });

  it('duplicates 是数组套数组 —— 摊平成组合名字，别塌成同一个身份', () => {
    // 🔴 这条形状差异是真踩过的：duplicates 的元素本身是一组同义导出。
    // 按 `row.name` 取会得到 undefined，于是**所有**重复导出挤成同一个身份，
    // 基线里只剩一条，新增的重复导出再也拦不住。
    const report = {
      issues: [
        {
          file: 'src/x.ts',
          duplicates: [
            [{ name: 'parseJson' }, { name: 'parseAgentOutput' }],
            [{ name: 'toA' }, { name: 'toB' }],
          ],
        },
      ],
    };

    expect(collectFindings(report)).toEqual([
      'duplicates|src/x.ts|parseJson+parseAgentOutput',
      'duplicates|src/x.ts|toA+toB',
    ]);
  });

  it('忽略未纳入棘轮的字段，且空报告不炸', () => {
    expect(
      collectFindings({ issues: [{ file: 'src/a.ts', owners: [{ name: '@someone' }] }] }),
    ).toEqual([]);
    expect(collectFindings({})).toEqual([]);
    expect(collectFindings({ issues: [] })).toEqual([]);
  });

  it('同一条问题重复出现只算一次', () => {
    const report = {
      issues: [
        { file: 'src/a.ts', exports: [{ name: 'foo' }] },
        { file: 'src/a.ts', exports: [{ name: 'foo' }] },
      ],
    };
    expect(collectFindings(report)).toEqual(['exports|src/a.ts|foo']);
  });
});

describe('compareToBaseline', () => {
  it('基线里没有的算新增', () => {
    const result = compareToBaseline(
      ['exports|src/a.ts|foo', 'exports|src/b.ts|bar'],
      ['exports|src/a.ts|foo'],
    );
    expect(result.added).toEqual(['exports|src/b.ts|bar']);
    expect(result.resolved).toEqual([]);
  });

  it('基线里有、现在没了算已清理', () => {
    const result = compareToBaseline([], ['exports|src/a.ts|foo']);
    expect(result.added).toEqual([]);
    expect(result.resolved).toEqual(['exports|src/a.ts|foo']);
  });

  it('修好一条又新增一条 —— 净零也要报出新增', () => {
    // 用身份而不是计数的全部理由就在这条：计数比对会把这种情况判成「没变化」。
    const result = compareToBaseline(['exports|src/b.ts|bar'], ['exports|src/a.ts|foo']);
    expect(result.added).toEqual(['exports|src/b.ts|bar']);
    expect(result.resolved).toEqual(['exports|src/a.ts|foo']);
  });

  it('完全一致时两边都空', () => {
    const items = ['exports|src/a.ts|foo', 'types|src/a.ts|Bar'];
    expect(compareToBaseline(items, items)).toEqual({ added: [], resolved: [] });
  });
});
