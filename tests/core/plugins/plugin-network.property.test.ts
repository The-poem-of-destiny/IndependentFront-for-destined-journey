import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildPluginFrameCsp,
  canonicalNetworkHash,
  validatePluginNetwork,
} from '../../../src/core/plugins/plugin-network';

/**
 * plugin-network 的**属性测试**（例子测试见 plugin-network.test.ts，两者互补）。
 *
 * 这个模块守的是红线 D：CSP 里多出一个 `http:`、一个 IP、一个端口，插件就能直连本机的
 * ComfyUI、Ollama 或 BFF。例子测试钉住设计文档列举的每一类拒绝；属性测试钉的是
 * 「无论 manifest 写了什么，生成器要么抛错，要么产出的每个来源都只是 443 上的公网域名」。
 */

/** CSP 里允许出现的关键字来源（模板原样） */
const KEYWORDS = new Set([
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'wasm-unsafe-eval'",
  'blob:',
  'data:',
]);

/** 主机来源：只能是 https 或 wss，后面跟（可带前导 *. 的）小写多段名，无端口无路径 */
const HOST_SOURCE_RE = /^(https|wss):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** 偏向「危险形状」的字符表：协议、端口、路径、通配、IP、方括号、分号注入 */
const hostChar = fc.constantFrom(...'abcxyz019-.*:/[]@;, _'.split(''), 'A', 'Z', 'а', '\t');

const dangerousFragment = fc.constantFrom(
  'localhost',
  '127.0.0.1',
  '0x7f.1',
  '2130706433',
  '::1',
  '[::1]',
  'nip.io',
  'local',
  'home.arpa',
  'example.com',
  'api.example.com',
  '*.',
  ':8188',
  ':443',
  'http:',
  'ws:',
  'https:',
  '//',
  '/path',
  '*',
  '; script-src *',
  'xn--fiqs8s',
  'io',
  'com',
  '.',
);

/** 由危险片段与随机字符拼出的「像主机名」的串 */
const hostish = fc
  .array(fc.oneof(dangerousFragment, fc.string({ unit: hostChar, maxLength: 8 })), {
    minLength: 1,
    maxLength: 5,
  })
  .map((parts) => parts.join(''));

/** 合法域名生成器：多段字母数字名 + 字母顶级域，可带前导 *. */
const label = fc
  .string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    minLength: 1,
    maxLength: 10,
  })
  .filter((l) => /^[a-z0-9]+$/.test(l));
const tld = fc.constantFrom('com', 'net', 'org', 'io', 'dev', 'xn--fiqz9s');
const validHost = fc
  .tuple(fc.boolean(), fc.array(label, { minLength: 1, maxLength: 3 }), tld)
  .map(([wild, labels, t]) => (wild ? '*.' : '') + [...labels, t].join('.'))
  // 名字恰好拼成重绑定服务（如 nip.io）时不算合法样本
  .filter((h) => !/(?:^|\.)(?:nip|xip|sslip)\.io$/.test(h.replace(/^\*\./, '')));

const anyEntry = fc.oneof(
  hostish,
  validHost,
  fc.string(),
  fc.constantFrom<unknown>(42, null, undefined, {}, ['a.com']),
);

function assertSafeCsp(csp: string): void {
  for (const directive of csp.split('; ')) {
    const [name, ...sources] = directive.split(' ');
    expect(name).toMatch(/^[a-z-]+$/);
    for (const src of sources) {
      expect(src).not.toBe('*');
      expect(src).not.toBe('http:');
      expect(src).not.toBe('ws:');
      expect(src).not.toBe('https:');
      expect(src).not.toBe('wss:');
      if (KEYWORDS.has(src)) continue;
      const m = HOST_SOURCE_RE.exec(src);
      expect(m, `出现了不合格的来源：${src}`).not.toBeNull();
      const host = m![3]!;
      const labels = host.split('.');
      // 不是 IP：至少有一段不是数字，且末段（顶级域）不是数字
      expect(labels.every((l) => /^\d+$/.test(l))).toBe(false);
      expect(labels[labels.length - 1]).toMatch(/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/);
      // 与校验器的保留后缀规则同口径：名字不等于 localhost、也不以 `.localhost` 结尾
      // （`localhost.io` 是合法公网名，校验器放行；`home.arpalocalhost` 也不算命中）
      expect(host).not.toBe('localhost');
      expect(host.endsWith('.localhost')).toBe(false);
    }
  }
  // 整份 CSP 里不出现端口、IPv6、明文协议
  expect(csp).not.toMatch(/https?:\/\/[^\s;]*:/);
  expect(csp).not.toMatch(/\bhttp:/);
  expect(csp).not.toMatch(/\bws:/);
  expect(csp).not.toContain('[');
}

describe('buildPluginFrameCsp 属性', () => {
  it('任意输入：要么抛错，要么产物只含模板关键字与 443 上的 https/wss 公网域名', () => {
    fc.assert(
      fc.property(fc.array(anyEntry, { maxLength: 20 }), fc.boolean(), (list, blob) => {
        let csp: string;
        try {
          csp = buildPluginFrameCsp(list as string[], { innerFrame: blob ? 'blob' : 'srcdoc' });
        } catch {
          // 抛错时校验器也必须判为不合格（两者口径一致）
          expect(validatePluginNetwork(list).ok).toBe(false);
          return;
        }
        expect(validatePluginNetwork(list).ok).toBe(true);
        assertSafeCsp(csp);
      }),
      { numRuns: 1000 },
    );
  });

  it('合法域名集合：校验通过，且每个域名都以 https 与 wss 两种形式出现', () => {
    fc.assert(
      fc.property(fc.array(validHost, { maxLength: 16 }), (list) => {
        const r = validatePluginNetwork(list);
        expect(r.ok).toBe(true);
        const csp = buildPluginFrameCsp(list);
        assertSafeCsp(csp);
        for (const h of list) {
          expect(csp).toContain(`https://${h}`);
          expect(csp).toContain(`wss://${h}`);
        }
      }),
    );
  });

  it('同一集合的任意排列与大小写变体得到同一份 CSP 与同一个哈希', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(validHost, { maxLength: 8 }),
        fc.integer({ min: 0, max: 1000 }),
        (list, seed) => {
          const shuffled = [...list].sort(
            (a, b) => ((a.length * 31 + seed) % 7) - ((b.length * 31 + seed) % 7),
          );
          const shouted = [...shuffled.map((h) => h.toUpperCase()), ...list];
          expect(buildPluginFrameCsp(shouted)).toBe(buildPluginFrameCsp(list));
          expect(canonicalNetworkHash(shouted)).toBe(canonicalNetworkHash(list));
        },
      ),
    );
  });
});
