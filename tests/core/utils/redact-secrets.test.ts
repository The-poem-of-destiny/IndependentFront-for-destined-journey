/**
 * redact-secrets.ts —— 凭据脱敏（设计 §4.5 / §5.2；原住 `src/ui/lib/turn-failure.ts`）。
 */
import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../../src/core/utils/redact-secrets';

describe('redactSecrets', () => {
  it('抹掉 Bearer 头与 Authorization / x-api-key 头', () => {
    const out = redactSecrets(
      'Authorization: Bearer abc.def-123 x-api-key: hunter2-key api-key=plain',
    );
    expect(out).not.toContain('abc.def-123');
    expect(out).not.toContain('hunter2-key');
    expect(out).not.toContain('plain');
    expect(out).toContain('Bearer [已隐藏]');
  });

  it('抹掉 sk- 一类密钥', () => {
    const out = redactSecrets('Incorrect API key provided: sk-ab12cd34ef56');
    expect(out).toBe('Incorrect API key provided: [已隐藏的密钥]');
  });

  it('抹掉查询参数与 JSON 里的 key / token / secret', () => {
    const out = redactSecrets(
      'GET /v1?key=AIzaXYZ&x=1 {"api_key":"abc123","token":"t0k","secret":"s3c"}',
    );
    expect(out).not.toMatch(/AIzaXYZ|abc123|t0k|s3c/);
    expect(out).toContain('x=1');
  });

  it('抹掉 32 位以上的长令牌串', () => {
    const token = 'a'.repeat(40);
    expect(redactSecrets(`token-ish ${token} end`)).toBe('token-ish [已隐藏] end');
  });

  it('普通中文正文原样保留', () => {
    const text = '你走进集市，摊贩吆喝着新到的香料。';
    expect(redactSecrets(text)).toBe(text);
  });
});
