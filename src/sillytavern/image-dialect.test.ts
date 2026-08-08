/**
 * image-dialect.test.ts — 方言解析与取用的守卫测试（图像 v2 / C4·C6）
 *
 * 钉的都是「改坏了不会报错，只会静默画出不对的图」那一类:
 * - 方言 JSON 来自**内容包**（第三方可编辑），坏值必须回落而不是让出图链炸掉
 * - 空串在四个字符串旋钮上是**合法值**（prose 档就靠它），在覆盖袋里却是**不覆盖**
 * - 兜底方言必须等于图像 v1 的行为，否则「注册表这一面没加载上」会悄悄换一套画质词
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from './image-defaults';
import { FALLBACK_IMAGE_DIALECT, parseImageDialects, resolveImageDialect } from './image-dialect';
import type { ImageDialect } from './types-image';

/** 一条形状完整的散文方言（与 danbooru 兜底**每一格都不同**，好让回落被看见） */
const PROSE_RAW: ImageDialect = {
  id: 'natural-prose',
  label: '自然语',
  separator: '. ',
  normalize: 'none',
  appearance: 'prose',
  world: 'none',
  rating: 'none',
  count: 'none',
  supportsNegative: false,
  qualitySuffix: '',
  baseNegative: '',
  composition: 'wide shot, cinematic composition',
  systemPrompt: '写一段英文。',
};

describe('FALLBACK_IMAGE_DIALECT —— 就是图像 v1 的行为', () => {
  it('三个字符串旋钮逐字节等于 image-defaults 的常量（不是抄的一份）', () => {
    expect(FALLBACK_IMAGE_DIALECT.qualitySuffix).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(FALLBACK_IMAGE_DIALECT.baseNegative).toBe(DEFAULT_IMAGE_BASE_NEGATIVE);
    expect(FALLBACK_IMAGE_DIALECT.composition).toBe(DEFAULT_IMAGE_COMPOSITION_TAGS);
  });

  it('旋钮全是 danbooru 形，且 systemPrompt 是空串（表示「本方言没话说」，由装配层回落）', () => {
    expect(FALLBACK_IMAGE_DIALECT.id).toBe('danbooru-anime');
    expect(FALLBACK_IMAGE_DIALECT.separator).toBe(', ');
    expect(FALLBACK_IMAGE_DIALECT.normalize).toBe('danbooru');
    expect(FALLBACK_IMAGE_DIALECT.appearance).toBe('danbooru');
    expect(FALLBACK_IMAGE_DIALECT.world).toBe('tags');
    expect(FALLBACK_IMAGE_DIALECT.rating).toBe('tag');
    expect(FALLBACK_IMAGE_DIALECT.count).toBe('tag');
    expect(FALLBACK_IMAGE_DIALECT.supportsNegative).toBe(true);
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt).toBe('');
  });
});

describe('parseImageDialects —— 外层形状', () => {
  it('吃 { dialects: [...] }（落盘形状）', () => {
    expect(parseImageDialects({ dialects: [PROSE_RAW] }).map((d) => d.id)).toEqual([
      'natural-prose',
    ]);
  });

  it('也吃裸数组（pack 作者少写一层是常见形态）', () => {
    expect(parseImageDialects([PROSE_RAW]).map((d) => d.id)).toEqual(['natural-prose']);
  });

  it('认不出的外层一律返回空数组，绝不抛', () => {
    for (const raw of [undefined, null, 0, 'nope', {}, { dialects: 'nope' }, { list: [] }]) {
      expect(parseImageDialects(raw)).toEqual([]);
    }
  });

  it('完整条目原样收下（合法值一格都不许被"归一化"掉）', () => {
    expect(parseImageDialects([PROSE_RAW])[0]).toEqual(PROSE_RAW);
  });
});

describe('parseImageDialects —— 逐条容错（垃圾进，不炸）', () => {
  it('不是对象 / 没有 id / id 是空串 → 整条跳过（选不中的幽灵项不该进下拉）', () => {
    const parsed = parseImageDialects([
      null,
      'x',
      42,
      [],
      { label: '没有 id' },
      { id: '', label: '空 id' },
      { id: 123 },
      PROSE_RAW,
    ]);
    expect(parsed.map((d) => d.id)).toEqual(['natural-prose']);
  });

  it('id 重复 → 只留第一条', () => {
    const parsed = parseImageDialects([
      { id: 'dup', label: '先到' },
      { id: 'dup', label: '后到' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe('先到');
  });

  it('枚举旋钮写坏 → 只有那一格回落 danbooru 默认值，其余格照收', () => {
    const parsed = parseImageDialects([
      {
        id: 'broken',
        label: '半懂',
        separator: ' | ',
        normalize: 'NONE', // 大小写不对
        appearance: 'poetry', // 不存在的值
        world: 'phrase', // C4 预留但 v2 未实现
        rating: 42,
        count: null,
        supportsNegative: 'yes', // 不是布尔
        qualitySuffix: 7, // 不是字符串
      },
    ])[0];
    // 认得出的格保留
    expect(parsed.id).toBe('broken');
    expect(parsed.label).toBe('半懂');
    expect(parsed.separator).toBe(' | ');
    // 认不出的格逐格回落
    expect(parsed.normalize).toBe(FALLBACK_IMAGE_DIALECT.normalize);
    expect(parsed.appearance).toBe(FALLBACK_IMAGE_DIALECT.appearance);
    expect(parsed.world).toBe(FALLBACK_IMAGE_DIALECT.world);
    expect(parsed.rating).toBe(FALLBACK_IMAGE_DIALECT.rating);
    expect(parsed.count).toBe(FALLBACK_IMAGE_DIALECT.count);
    expect(parsed.supportsNegative).toBe(FALLBACK_IMAGE_DIALECT.supportsNegative);
    expect(parsed.qualitySuffix).toBe(FALLBACK_IMAGE_DIALECT.qualitySuffix);
    // 完全没写的格同样回落
    expect(parsed.baseNegative).toBe(FALLBACK_IMAGE_DIALECT.baseNegative);
    expect(parsed.composition).toBe(FALLBACK_IMAGE_DIALECT.composition);
    expect(parsed.systemPrompt).toBe('');
  });

  it('label / separator 为空串 → 回落（label 回落成 id，好让下拉里还认得出是谁）', () => {
    const parsed = parseImageDialects([{ id: 'x', label: '', separator: '' }])[0];
    expect(parsed.label).toBe('x');
    expect(parsed.separator).toBe(FALLBACK_IMAGE_DIALECT.separator);
  });

  it('🔴 四个文本旋钮的空串是**合法值**，不许被当成「没填」回落', () => {
    const parsed = parseImageDialects([
      { id: 'x', qualitySuffix: '', baseNegative: '', composition: '', systemPrompt: '' },
    ])[0];
    expect(parsed.qualitySuffix).toBe('');
    expect(parsed.baseNegative).toBe('');
    expect(parsed.composition).toBe('');
    expect(parsed.systemPrompt).toBe('');
  });
});

describe('resolveImageDialect —— 取哪一条', () => {
  const dialects = parseImageDialects([
    PROSE_RAW,
    { id: 'danbooru-anime', systemPrompt: '标签。' },
  ]);

  it('id 精确命中', () => {
    expect(resolveImageDialect(dialects, 'natural-prose').appearance).toBe('prose');
  });

  it('id 认不出 → 落到清单里的内置 danbooru 条（它带着真提示词，比空壳有用）', () => {
    expect(resolveImageDialect(dialects, '已被 pack 删掉的 id').systemPrompt).toBe('标签。');
  });

  it('没传 id（用户没选过）→ 同样落到内置 danbooru 条', () => {
    expect(resolveImageDialect(dialects, undefined).id).toBe('danbooru-anime');
  });

  it('🔴 清单为空（注册表这一面 404 / pack 清空）→ 兜底方言，不抛也不返回 undefined', () => {
    expect(resolveImageDialect([], 'whatever')).toEqual(FALLBACK_IMAGE_DIALECT);
    expect(resolveImageDialect([], undefined)).toEqual(FALLBACK_IMAGE_DIALECT);
  });

  it('清单里只有散文档且 id 认不出 → 仍走兜底，不会误发一条散文方言给 NAI', () => {
    expect(resolveImageDialect(parseImageDialects([PROSE_RAW]), 'nope')).toEqual(
      FALLBACK_IMAGE_DIALECT,
    );
  });
});

describe('resolveImageDialect —— 覆盖合并（C6）', () => {
  const dialects = parseImageDialects([PROSE_RAW]);

  it('四个字符串旋钮各自可被覆盖，其余旋钮一格不动', () => {
    const merged = resolveImageDialect(dialects, 'natural-prose', {
      systemPrompt: '我自己的提示词',
      qualitySuffix: 'my quality',
      baseNegative: 'my negative',
      composition: 'close-up',
    });
    expect(merged.systemPrompt).toBe('我自己的提示词');
    expect(merged.qualitySuffix).toBe('my quality');
    expect(merged.baseNegative).toBe('my negative');
    expect(merged.composition).toBe('close-up');
    // 非覆盖面原样
    expect(merged.id).toBe('natural-prose');
    expect(merged.separator).toBe('. ');
    expect(merged.supportsNegative).toBe(false);
  });

  it('只给一项 → 只覆盖那一项', () => {
    const merged = resolveImageDialect(dialects, 'natural-prose', { composition: 'close-up' });
    expect(merged.composition).toBe('close-up');
    expect(merged.systemPrompt).toBe(PROSE_RAW.systemPrompt);
    expect(merged.qualitySuffix).toBe('');
  });

  it('🔴 空串**不**算覆盖 —— 输入框清空是「用默认值」，不是「我要一个空后缀」', () => {
    const merged = resolveImageDialect(dialects, 'danbooru-anime', {
      systemPrompt: '',
      qualitySuffix: '',
      baseNegative: '',
      composition: '',
    });
    expect(merged).toEqual(FALLBACK_IMAGE_DIALECT);
    expect(merged.qualitySuffix).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
  });

  it('不传覆盖袋 / 传空袋 → 与方言默认值逐格相同', () => {
    expect(resolveImageDialect(dialects, 'natural-prose', {})).toEqual(
      resolveImageDialect(dialects, 'natural-prose'),
    );
  });

  it('覆盖不修改传进来的方言对象（下一次取用不该看见上一次的覆盖）', () => {
    const before = { ...dialects[0] };
    resolveImageDialect(dialects, 'natural-prose', { composition: 'close-up' });
    expect(dialects[0]).toEqual(before);
  });

  it('覆盖同样作用在兜底方言上（清单为空时用户的调优不该失效）', () => {
    const merged = resolveImageDialect([], 'danbooru-anime', { qualitySuffix: 'mine' });
    expect(merged.qualitySuffix).toBe('mine');
    expect(merged.baseNegative).toBe(DEFAULT_IMAGE_BASE_NEGATIVE);
    // 🔴 兜底常量本身不许被改写
    expect(FALLBACK_IMAGE_DIALECT.qualitySuffix).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
  });
});
