/**
 * endpoint-resolver.test.ts — F10 fail-closed 端点解析器的回归测试
 *
 * 覆盖简报 §5 要求的全部场景：空池 / 未设置 / 显式默认 / 有效绑定 / 失效绑定 /
 * 畸形绑定 / 重复 id。核心断言：「显式绑定失效」与「未设置」永不相混。
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentEndpoint } from './endpoint-resolver';
import type { ApiEndpoint } from '@engine/types';

function endpoint(id: string): ApiEndpoint {
  return {
    id,
    name: id,
    provider: 'custom',
    baseUrl: 'https://example.test/v1',
    apiKey: '',
    defaultModel: `model-${id}`,
    models: [`model-${id}`],
    timeout: 60000,
  };
}

const poolAB: ApiEndpoint[] = [endpoint('A'), endpoint('B')];

describe('resolveAgentEndpoint — 未设置（可走默认，首次配置体验不回归）', () => {
  it('未设置 + 非空池 → 池首项', () => {
    expect(resolveAgentEndpoint({ boundPoolId: undefined, apiPool: poolAB })).toEqual({
      status: 'resolved',
      endpoint: poolAB[0],
    });
  });

  it('未设置 + 空池 → missing-pool', () => {
    expect(resolveAgentEndpoint({ boundPoolId: undefined, apiPool: [] })).toEqual({
      status: 'missing-pool',
    });
  });

  it('空串与 null 与 undefined 一律按未设置解析', () => {
    for (const bound of ['', null, undefined]) {
      expect(resolveAgentEndpoint({ boundPoolId: bound, apiPool: poolAB }).status).toBe('resolved');
      expect(resolveAgentEndpoint({ boundPoolId: bound, apiPool: [] }).status).toBe('missing-pool');
    }
  });

  it('未设置 + 显式默认命中 → 用默认端点而非池首项', () => {
    expect(
      resolveAgentEndpoint({ boundPoolId: undefined, apiPool: poolAB, declaredDefaultId: 'B' }),
    ).toEqual({ status: 'resolved', endpoint: poolAB[1] });
  });

  it('未设置 + 声明的默认已失效 → 回落池首项（未设置前提下的默认策略，不是 stale）', () => {
    expect(
      resolveAgentEndpoint({
        boundPoolId: undefined,
        apiPool: poolAB,
        declaredDefaultId: 'MISSING',
      }),
    ).toEqual({ status: 'resolved', endpoint: poolAB[0] });
  });
});

describe('resolveAgentEndpoint — 有效绑定', () => {
  it('精确命中 → 返回该端点（与池顺序无关）', () => {
    expect(resolveAgentEndpoint({ boundPoolId: 'B', apiPool: poolAB })).toEqual({
      status: 'resolved',
      endpoint: poolAB[1],
    });
  });

  it('重排池后绑定语义不漂移（幂等）', () => {
    const reordered = [endpoint('B'), endpoint('A')];
    expect(resolveAgentEndpoint({ boundPoolId: 'A', apiPool: reordered }).status).toBe('resolved');
    expect(
      (
        resolveAgentEndpoint({ boundPoolId: 'A', apiPool: reordered }) as {
          status: 'resolved';
          endpoint: ApiEndpoint;
        }
      ).endpoint.id,
    ).toBe('A');
  });
});

describe('resolveAgentEndpoint — 失效绑定（fail-closed，绝不 reroute）', () => {
  it('显式绑定的 id 在池里不存在 → stale-binding（带 requestedId），不是默认端点', () => {
    expect(resolveAgentEndpoint({ boundPoolId: 'DELETED', apiPool: poolAB })).toEqual({
      status: 'stale-binding',
      requestedId: 'DELETED',
    });
  });

  it('🔴 核心回归：选中 A 删掉 A → 解析结果绝不会指向 B', () => {
    const poolOnlyB = [endpoint('B')];
    const resolution = resolveAgentEndpoint({ boundPoolId: 'A', apiPool: poolOnlyB });
    expect(resolution.status).toBe('stale-binding');
    if (resolution.status === 'stale-binding') {
      expect(resolution.requestedId).toBe('A');
    }
  });

  it('显式绑定 + 空池 → stale-binding（显式选择优先于池状态判定）', () => {
    expect(resolveAgentEndpoint({ boundPoolId: 'A', apiPool: [] })).toEqual({
      status: 'stale-binding',
      requestedId: 'A',
    });
  });
});

describe('resolveAgentEndpoint — 畸形绑定（不塌成未设置）', () => {
  it('纯空白串按显式绑定处理 → stale（不会静默走默认）', () => {
    expect(resolveAgentEndpoint({ boundPoolId: '   ', apiPool: poolAB })).toEqual({
      status: 'stale-binding',
      requestedId: '   ',
    });
  });

  it('非字符串类型按显式绑定处理 → stale（fail-closed 偏向）', () => {
    const dirty = 12345 as unknown as string;
    expect(resolveAgentEndpoint({ boundPoolId: dirty, apiPool: poolAB })).toEqual({
      status: 'stale-binding',
      requestedId: 12345 as unknown as string,
    });
  });
});

describe('resolveAgentEndpoint — 重复 id（防御性可预期）', () => {
  it('同 id 两条 → find 取首个并 resolved（id 本应唯一，本层不做去重）', () => {
    const dupFirst = endpoint('A');
    const dupSecond = endpoint('A');
    const resolution = resolveAgentEndpoint({ boundPoolId: 'A', apiPool: [dupFirst, dupSecond] });
    expect(resolution).toEqual({ status: 'resolved', endpoint: dupFirst });
  });
});
