import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyNsfwMode,
  hasNsfwMarkup,
  isNsfwFlagged,
  lintNsfwMarkup,
} from '../../../src/core/content/nsfw-filter';

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../fixtures/nsfw-markup-vectors.json'), 'utf8'),
) as {
  apply: Array<{ name: string; input: string; on: string; off: string }>;
  lint: Array<{ name: string; input: string; codes: string[] }>;
};

describe('applyNsfwMode（跨仓测试向量）', () => {
  for (const v of vectors.apply) {
    it(`${v.name}：开`, () => expect(applyNsfwMode(v.input, true)).toBe(v.on));
    it(`${v.name}：关`, () => expect(applyNsfwMode(v.input, false)).toBe(v.off));
  }
});

describe('lintNsfwMarkup（跨仓测试向量）', () => {
  for (const v of vectors.lint)
    it(v.name, () => expect(lintNsfwMarkup(v.input).map((i) => i.code)).toEqual(v.codes));
});

describe('nsfw-filter 其余契约', () => {
  it('无标记时返回同一个字符串引用（零开销快速路径）', () => {
    const text = '没有任何标记的长文本';
    expect(applyNsfwMode(text, false)).toBe(text);
    expect(hasNsfwMarkup(text)).toBe(false);
  });

  it('关模式下输出永远不含任何规范标签（随机拼接性质测试）', () => {
    const parts = ['<nsfw>', '</nsfw>', '<sfw>', '</sfw>', '甲', '\n', '乙\n\n'];
    let seed = 7;
    for (let round = 0; round < 500; round++) {
      let text = '';
      for (let i = 0; i < 12; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        text += parts[seed % parts.length];
      }
      for (const mode of [true, false])
        expect(hasNsfwMarkup(applyNsfwMode(text, mode))).toBe(false);
    }
  });

  it('lint 给出原文偏移', () => {
    const [issue] = lintNsfwMarkup('0123<nsfw>');
    expect(issue).toMatchObject({ code: 'unclosed', offset: 4, level: 'error' });
  });

  it('isNsfwFlagged 只认严格的 true', () => {
    expect(isNsfwFlagged({ nsfw: true })).toBe(true);
    expect(isNsfwFlagged({ nsfw: 'true' })).toBe(false);
    expect(isNsfwFlagged(undefined)).toBe(false);
  });
});
