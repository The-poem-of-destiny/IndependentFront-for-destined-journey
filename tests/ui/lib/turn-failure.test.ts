/**
 * 回合失败归类（审查 GAME-05）：状态码 / 措辞 → 分类；原文脱敏截断。
 */
import { describe, expect, it } from 'vitest';
import {
  buildTurnFailure,
  classifyTurnFailure,
  redactSecrets,
  sanitizeFailureDetail,
  TURN_FAILURE_DETAIL_MAX,
  turnFailureCopy,
} from '../../../src/ui/lib/turn-failure';

describe('classifyTurnFailure', () => {
  it.each([
    ['HTTP 401: {"error":"invalid"}', 'auth'],
    ['HTTP 403: forbidden', 'auth'],
    ['HTTP 400: Incorrect API key provided', 'auth'],
    ['HTTP 402: payment required', 'quota'],
    ['HTTP 429: {"error":{"code":"insufficient_quota"}}', 'quota'],
    ['HTTP 403: 账户余额不足', 'quota'],
    ['HTTP 429: Too Many Requests', 'rate_limit'],
    ['HTTP 429: RESOURCE_EXHAUSTED Quota exceeded for metric', 'rate_limit'],
    ['HTTP 500: internal', 'server'],
    ['HTTP 503: overloaded', 'server'],
    ['HTTP 504: gateway timeout', 'network'],
    ['HTTP 502: {"error":"upstream unreachable: fetch failed: bad port"}', 'network'],
    ['HTTP 502: {"error":"upstream unreachable: fetch failed: ECONNREFUSED"}', 'network'],
    ['HTTP 502: {"error":"upstream unreachable: fetch failed: ENOTFOUND"}', 'network'],
    ['HTTP 502: {"error":"upstream redirect (3xx) rejected by proxy redirect policy"}', 'network'],
    ['HTTP 503: connect ECONNREFUSED 127.0.0.1:8080', 'network'],
    ['HTTP 502: Bad Gateway', 'server'],
    // 服务端措辞里的「reconnect」不是连接错误码
    [
      'HTTP 503: {"error":{"message":"Service temporarily unavailable, please reconnect later"}}',
      'server',
    ],
    // 中转站自报的 fetch failed 是它自己的上游问题，玩家改设置无济于事
    ['HTTP 500: {"error":{"message":"fetch failed"}}', 'server'],
    // 只认代理的错误体形状：服务商正文里顺带的字样不抢先于额度判断
    ['HTTP 500: Insufficient credit balance; upstream unreachable', 'quota'],
    ['HTTP 400: invalid model', 'rejected'],
    ['response blocked by content_filter', 'rejected'],
    ['TypeError: Failed to fetch', 'network'],
    ['Request timed out after 120000ms', 'network'],
    ['Endpoint "" not found', 'config'],
    [
      'Agent「story」绑定的 API 池已失效（原 id: x）。本轮已停止发送请求（fail-closed，不会换用别的 provider）',
      'config',
    ],
    ['something odd', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (message, category) => {
    expect(classifyTurnFailure(new Error(message))).toBe(category);
  });

  it('EndpointBindingError 按类型直接归配置', () => {
    const err = new Error('whatever');
    err.name = 'EndpointBindingError';
    expect(classifyTurnFailure(err)).toBe('config');
  });

  it('字符串与非 Error 对象也能归类，不抛', () => {
    expect(classifyTurnFailure('HTTP 429: slow down')).toBe('rate_limit');
    expect(classifyTurnFailure({ message: 'HTTP 401' })).toBe('auth');
    expect(classifyTurnFailure(undefined)).toBe('unknown');
    expect(classifyTurnFailure(null)).toBe('unknown');
  });
});

describe('redactSecrets / sanitizeFailureDetail', () => {
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

  it('截断到上限并加省略号；空错误返回 undefined', () => {
    const detail = sanitizeFailureDetail(new Error('上游返回了很长的错误说明 '.repeat(40)));
    expect(detail!.length).toBe(TURN_FAILURE_DETAIL_MAX + 1);
    expect(detail!.endsWith('…')).toBe(true);
    expect(sanitizeFailureDetail(new Error(''))).toBeUndefined();
  });
});

describe('buildTurnFailure / turnFailureCopy', () => {
  it('带上步骤名与脱敏原文', () => {
    expect(buildTurnFailure(new Error('HTTP 401: sk-abcdefghijk'), '书写此刻')).toEqual({
      category: 'auth',
      stepLabel: '书写此刻',
      detail: 'HTTP 401: [已隐藏的密钥]',
    });
  });

  it('密钥 / 额度 / 配置 / 网络（地址可能填错）给「去设置」，其余不给；每类都有一句话与下一步', () => {
    expect(turnFailureCopy('auth').needsSettings).toBe(true);
    expect(turnFailureCopy('network').needsSettings).toBe(true);
    expect(turnFailureCopy('server').needsSettings).toBe(false);
    expect(turnFailureCopy('config').needsSettings).toBe(true);
    expect(turnFailureCopy('quota').needsSettings).toBe(true);
    expect(turnFailureCopy('rate_limit').needsSettings).toBe(false);
    for (const category of [
      'auth',
      'quota',
      'rate_limit',
      'network',
      'server',
      'rejected',
      'config',
      'unknown',
    ] as const) {
      expect(turnFailureCopy(category).summary.length).toBeGreaterThan(0);
      expect(turnFailureCopy(category).hint.length).toBeGreaterThan(0);
    }
  });
});
