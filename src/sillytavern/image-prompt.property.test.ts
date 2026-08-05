import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clampRating, normalizeTagString } from './image-prompt';
import type { ImageRating } from './types-image';

/**
 * image-prompt 纯函数的**属性测试**。
 *
 * `normalizeTagString` 的失败模式是模块头点名的那一类：**都不报错，只静默产出
 * 一张莫名其妙的图**。这种错永远不会让别的测试变红，只能靠把不变式写死来防。
 */

const RATINGS: readonly ImageRating[] = ['general', 'sensitive', 'questionable', 'explicit'];
const ratingArb = fc.constantFrom(...RATINGS);

/** 标签串：混进全角标点、换行、<br>、权重语法与书名号 */
const tagChunk = fc.oneof(
  fc.constantFrom(
    '1girl',
    'long hair',
    'blue eyes',
    '{{masterpiece}}',
    '[[blurry]]',
    '-0.8::feet::',
    '<lora:foo:0.7>',
    '《lora:bar:0.5》',
  ),
  fc.stringMatching(/^[a-z ]{1,10}$/),
);
const separator = fc.constantFrom(
  ', ',
  ',',
  '，',
  '、',
  '；',
  '\n',
  '\r\n',
  '<br>',
  '<br/>',
  ' , ',
  ',,',
);
const tagString = fc
  .array(fc.tuple(tagChunk, separator), { maxLength: 8 })
  .map((pairs) => pairs.map(([t, s]) => t + s).join(''));

describe('normalizeTagString 不变式', () => {
  it('幂等：归一化过的串再归一化不变', () => {
    fc.assert(
      fc.property(tagString, (s) => {
        const once = normalizeTagString(s);
        expect(normalizeTagString(once)).toBe(once);
      }),
    );
  });

  it('产出里绝不残留全角分隔符（那会让整串变成一个巨型标签）', () => {
    fc.assert(
      fc.property(tagString, (s) => {
        const out = normalizeTagString(s);
        expect(out).not.toMatch(/[，、；]/);
        expect(out).not.toMatch(/《|》/);
      }),
    );
  });

  it('产出绝不出现空标签：无首尾逗号、无连续逗号', () => {
    fc.assert(
      fc.property(tagString, (s) => {
        const out = normalizeTagString(s);
        if (out.length === 0) return;
        expect(out).not.toMatch(/^[\s,]/);
        expect(out).not.toMatch(/[\s,]$/);
        expect(out).not.toMatch(/,\s*,/);
        // 拆开之后每一段都非空
        for (const part of out.split(', ')) expect(part.length).toBeGreaterThan(0);
      }),
    );
  });

  it('产出不含换行与 <br>', () => {
    fc.assert(
      fc.property(tagString, (s) => {
        const out = normalizeTagString(s);
        expect(out).not.toMatch(/[\r\n]/);
        expect(out).not.toMatch(/<br\s*\/?>/i);
      }),
    );
  });

  it('只动标点不动内容：权重语法的字符一个不少', () => {
    // 🔴 模块头的硬约束。归一化把 《》 换成 <>，但 {{}} / [[]] / :: / lora 名字
    // 都必须原样活下来 —— 少一个字符就是另一张图。
    fc.assert(
      fc.property(fc.array(tagChunk, { minLength: 1, maxLength: 6 }), (chunks) => {
        const out = normalizeTagString(chunks.join('，'));
        for (const chunk of chunks) {
          const expected = chunk
            .replace(/《/g, '<')
            .replace(/》/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
          if (expected.length > 0) expect(out).toContain(expected);
        }
      }),
    );
  });

  it('空白与分隔符组成的串归一化成空串', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(' ', ',', '，', '、', '；', '\n', '<br>'), { maxLength: 10 }),
        (bits) => {
          expect(normalizeTagString(bits.join(''))).toBe('');
        },
      ),
    );
  });
});

describe('clampRating 不变式', () => {
  it('结果永不超过上限', () => {
    fc.assert(
      fc.property(fc.option(ratingArb, { nil: undefined }), ratingArb, (want, max) => {
        const out = clampRating(want, max);
        expect(RATINGS.indexOf(out)).toBeLessThanOrEqual(RATINGS.indexOf(max));
      }),
    );
  });

  it('结果永远是合法的 rating', () => {
    fc.assert(
      fc.property(fc.option(ratingArb, { nil: undefined }), ratingArb, (want, max) => {
        expect(RATINGS).toContain(clampRating(want, max));
      }),
    );
  });

  it('未指定时取上限本身', () => {
    fc.assert(
      fc.property(ratingArb, (max) => {
        expect(clampRating(undefined, max)).toBe(max);
      }),
    );
  });

  it('幂等：钳过的值再钳一次不变', () => {
    fc.assert(
      fc.property(fc.option(ratingArb, { nil: undefined }), ratingArb, (want, max) => {
        const once = clampRating(want, max);
        expect(clampRating(once, max)).toBe(once);
      }),
    );
  });

  it('脏数据（类型外取值）退回上限，绝不越过', () => {
    // 模块注释明写了这条兜底。类型系统挡不住来自 JSON / 旧存档的脏值。
    fc.assert(
      fc.property(fc.string(), ratingArb, (dirty, max) => {
        const out = clampRating(dirty as ImageRating, max);
        expect(RATINGS.indexOf(out)).toBeLessThanOrEqual(RATINGS.indexOf(max));
      }),
    );
  });
});
