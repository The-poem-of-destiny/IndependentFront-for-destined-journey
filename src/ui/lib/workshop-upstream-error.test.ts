/**
 * workshop-upstream-error.ts — 上游错误体读法测试（Phase 4）
 *
 * 最要紧的一条: **平台错误必须能压过业务错误**。Cloudflare 的额度/资源失败有时
 * 也是带 `message` 的 JSON，那句 message 是给运维看的英文栈信息 —— 认不出错误码，
 * 用户就会看到一句他完全无法处置的话。
 */
import { describe, it, expect } from 'vitest';
import { describePlatformFailure, describeRawBody } from './workshop-upstream-error';

describe('describePlatformFailure', () => {
  it('1027 = 日额度耗尽', () => {
    expect(describePlatformFailure(500, 'error code: 1027')).toContain('额度用尽');
  });

  it('1102 与英文原话都算资源超限', () => {
    expect(describePlatformFailure(500, 'error code: 1102')).toContain('资源超限');
    expect(describePlatformFailure(500, 'Worker exceeded resource limits')).toContain('资源超限');
  });

  it('429 或限流字样 = 频率限制', () => {
    expect(describePlatformFailure(429, '')).toContain('频繁');
    expect(describePlatformFailure(500, 'Rate limit exceeded')).toContain('频繁');
  });

  it('★ 错误码藏在 JSON 的 message 里也认得出来 —— 这条压过结构化读法才有意义', () => {
    const body = JSON.stringify({ message: 'Internal error, code: 1027' });
    expect(describePlatformFailure(500, body)).toContain('额度用尽');
  });

  it('普通业务错误不归它管', () => {
    expect(describePlatformFailure(400, JSON.stringify({ error: '标签不合法' }))).toBeUndefined();
    expect(describePlatformFailure(404, '')).toBeUndefined();
  });

  it('数字要成词才算 —— 41027 不是 1027', () => {
    expect(describePlatformFailure(500, 'trace 41027893')).toBeUndefined();
  });
});

describe('describeRawBody', () => {
  it('★ HTML 拦截页给一句人话，不把标签糊到用户脸上', () => {
    expect(describeRawBody('<!DOCTYPE html><html><body>502</body></html>')).toBe(
      '创意工坊暂时不可用，稍后再试。',
    );
    expect(describeRawBody('<html lang="en">…</html>')).toBe('创意工坊暂时不可用，稍后再试。');
  });

  it('纯文本原样交出（截 300 字）—— 上游偶尔把唯一能自救的那句话放在这里', () => {
    expect(describeRawBody('database is locked')).toBe('database is locked');
    expect(describeRawBody('x'.repeat(500))).toHaveLength(300);
  });

  it('空体没有可说的', () => {
    expect(describeRawBody('')).toBeUndefined();
    expect(describeRawBody('   ')).toBeUndefined();
  });
});
