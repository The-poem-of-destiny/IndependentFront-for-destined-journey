/**
 * workshop-cover.ts — 封面取图链测试（Phase 4）
 *
 * 守三件事:
 * 1. 候选**有序**且不含空串 —— 空 `src` 会让浏览器去请求当前页面地址再画一个碎图标。
 * 2. 没有封面时返回**空数组**，不是含空串的数组（调用方据此直接走兜底）。
 * 3. 版本参数挂得上，且挂不上时原样退回而不是吐出一个带假 base 的 URL。
 */
import { describe, it, expect } from 'vitest';
import { appendCacheVersion, coverCandidates, wsrvUrl } from './workshop-cover';

describe('appendCacheVersion', () => {
  it('挂上 v 参数', () => {
    expect(appendCacheVersion('https://cdn.invalid/a.png', '2026-08-01')).toBe(
      'https://cdn.invalid/a.png?v=2026-08-01',
    );
  });

  it('没有版本就原样返回 —— 挂一个恒定值等于没挂', () => {
    expect(appendCacheVersion('https://cdn.invalid/a.png', undefined)).toBe(
      'https://cdn.invalid/a.png',
    );
    expect(appendCacheVersion('https://cdn.invalid/a.png', '  ')).toBe('https://cdn.invalid/a.png');
  });

  it('已有查询串时不破坏它', () => {
    const out = appendCacheVersion('https://cdn.invalid/a.png?size=2', 'v9');
    expect(out).toContain('size=2');
    expect(out).toContain('v=v9');
  });

  it('★ 相对路径原样退回 —— 绝不吐出带假 base 的 URL', () => {
    expect(appendCacheVersion('/files/a.png', 'v1')).toBe('/files/a.png');
  });

  it('空串进空串出', () => {
    expect(appendCacheVersion('', 'v1')).toBe('');
  });
});

describe('wsrvUrl', () => {
  it('原图 URL 被整体编码进 url 参数', () => {
    const out = wsrvUrl('https://cdn.invalid/a.png?v=1');
    expect(out).toContain('wsrv.nl');
    expect(out).toContain(encodeURIComponent('https://cdn.invalid/a.png?v=1'));
    expect(out).toContain('output=webp');
  });

  it('空串进空串出', () => {
    expect(wsrvUrl('')).toBe('');
  });
});

describe('coverCandidates', () => {
  it('★ 代理在前、原图在后 —— 省流量的先试，一定出得来的兜底', () => {
    const [first, second] = coverCandidates('https://cdn.invalid/a.png');
    expect(first).toContain('wsrv.nl');
    expect(second).toBe('https://cdn.invalid/a.png');
  });

  it('版本参数进的是原图 URL，并被一起编码进代理 URL', () => {
    const [proxied, direct] = coverCandidates('https://cdn.invalid/a.png', 'v7');
    expect(direct).toBe('https://cdn.invalid/a.png?v=v7');
    expect(proxied).toContain(encodeURIComponent('https://cdn.invalid/a.png?v=v7'));
  });

  it('★ 没有封面返回空数组，不是 [""]', () => {
    expect(coverCandidates(undefined)).toEqual([]);
    expect(coverCandidates('')).toEqual([]);
    expect(coverCandidates('   ')).toEqual([]);
  });

  it('候选里永不含空串', () => {
    for (const url of ['https://cdn.invalid/a.png', '/rel/a.png']) {
      expect(coverCandidates(url).every((c) => c.length > 0)).toBe(true);
    }
  });
});
