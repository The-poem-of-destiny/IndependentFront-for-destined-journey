import { describe, expect, it } from 'vitest';
import {
  buildCustomHeadersValue,
  HeaderOverridesError,
  normalizeHeaderOverrides,
  PROTECTED_REQUEST_HEADERS,
} from '../../../src/core/api/header-overrides';

describe('normalizeHeaderOverrides', () => {
  it('空值一律归成空对象（合法态 = 没有自定义头）', () => {
    expect(normalizeHeaderOverrides(undefined)).toEqual({});
    expect(normalizeHeaderOverrides(null)).toEqual({});
    expect(normalizeHeaderOverrides({})).toEqual({});
  });

  it('保留普通自定义头并 trim，不区分大小写地拒掉受保护头名', () => {
    expect(normalizeHeaderOverrides({ 'x-opencode-session': ' 790766510 ' })).toEqual({
      'x-opencode-session': '790766510',
    });
    expect(() => normalizeHeaderOverrides({ Authorization: 'Bearer evil' })).toThrow(
      HeaderOverridesError,
    );
    expect(() => normalizeHeaderOverrides({ 'X-Target-Base-URL': 'http://evil' })).toThrow(
      '受保护',
    );
  });

  it('每个受保护头名都真的被拒（清单不是摆设）', () => {
    for (const name of PROTECTED_REQUEST_HEADERS) {
      expect(() => normalizeHeaderOverrides({ [name]: 'x' }), name).toThrow(HeaderOverridesError);
    }
  });

  it('拒绝非法头名（空格 / 换行 / 非 token 字符）', () => {
    expect(() => normalizeHeaderOverrides({ 'bad name': 'x' })).toThrow(HeaderOverridesError);
    expect(() => normalizeHeaderOverrides({ 'bad\nname': 'x' })).toThrow(HeaderOverridesError);
  });

  it('拒绝含控制字符的头值（header injection）', () => {
    expect(() => normalizeHeaderOverrides({ 'x-a': 'v1\r\nX-Evil: 1' })).toThrow(
      HeaderOverridesError,
    );
  });

  it('拒绝非对象 / 非字符串值与超量头', () => {
    expect(() => normalizeHeaderOverrides('nope')).toThrow(HeaderOverridesError);
    expect(() => normalizeHeaderOverrides([])).toThrow(HeaderOverridesError);
    expect(() => normalizeHeaderOverrides({ 'x-a': 123 })).toThrow(HeaderOverridesError);
  });
});

describe('buildCustomHeadersValue', () => {
  it('编码成 percent-encoded JSON（保证 ASCII 头值）并可无损解回', () => {
    const value = buildCustomHeadersValue({ 'x-opencode-session': '790766510' });
    expect(value).toBeDefined();
    expect(decodeURIComponent(value as string)).toBe('{"x-opencode-session":"790766510"}');
  });

  it('空 / 全是非法项时不产生载荷头', () => {
    expect(buildCustomHeadersValue(undefined)).toBeUndefined();
    expect(buildCustomHeadersValue({})).toBeUndefined();
  });
});
