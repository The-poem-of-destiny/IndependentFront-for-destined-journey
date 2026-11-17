/**
 * redact-secrets.ts — 错误原文凭据脱敏（2026-11-16 自 ui/lib/turn-failure 下沉，行为不变）。
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../src/core/utils/redact-secrets';

describe('redactSecrets', () => {
  it('抹掉密钥、Bearer 头、查询参数里的 key 与长令牌', () => {
    const raw =
      'HTTP 401: Incorrect API key provided: sk-proj-AbCdEf123456. Authorization: Bearer abc.def.ghi ' +
      'url=https://x.test/v1?key=SECRET123&x=1 "api_key":"zzz" token 0123456789abcdef0123456789abcdef99';
    const out = redactSecrets(raw);
    expect(out).not.toContain('sk-proj-AbCdEf123456');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('0123456789abcdef0123456789abcdef99');
    expect(out).toContain('HTTP 401');
  });

  it('无凭据的普通文本原样返回', () => {
    expect(redactSecrets('HTTP 500: 上游暂时不可用')).toBe('HTTP 500: 上游暂时不可用');
  });
});
