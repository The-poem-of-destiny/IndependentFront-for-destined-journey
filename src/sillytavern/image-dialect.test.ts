/**
 * image-dialect.test.ts — 方言解析与取用的守卫测试（图像 v2 / C4·C6）
 *
 * 钉的都是「改坏了不会报错，只会静默画出不对的图」那一类:
 * - 方言 JSON 来自**内容包**（第三方可编辑），坏值必须回落而不是让出图链炸掉
 * - 空串在四个字符串旋钮上是**合法值**（prose 档就靠它），在覆盖袋里却是**不覆盖**
 * - 兜底方言必须等于图像 v1 的行为，否则「注册表这一面没加载上」会悄悄换一套画质词、
 *   甚至把侧链丢给 `agent-templates.ts` 那行连规则都没有的 stub
 * - 覆盖袋按**请求的 id** 取出，落到别的方言时必须整袋作废（散文调优骑上 danbooru 是花钱的）
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_PROMPT_SYSTEM,
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

/** 落盘形状（`{ dialects: [...] }`）—— 解析器只认这一种外层，测试也一律照它喂 */
function face(...rows: unknown[]): unknown {
  return { dialects: rows };
}

describe('FALLBACK_IMAGE_DIALECT —— 就是图像 v1 的行为', () => {
  it('四个字符串旋钮逐字节等于 image-defaults 的常量（不是抄的一份）', () => {
    expect(FALLBACK_IMAGE_DIALECT.qualitySuffix).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(FALLBACK_IMAGE_DIALECT.baseNegative).toBe(DEFAULT_IMAGE_BASE_NEGATIVE);
    expect(FALLBACK_IMAGE_DIALECT.composition).toBe(DEFAULT_IMAGE_COMPOSITION_TAGS);
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt).toBe(DEFAULT_IMAGE_PROMPT_SYSTEM);
  });

  it('旋钮全是 danbooru 形', () => {
    expect(FALLBACK_IMAGE_DIALECT.id).toBe('danbooru-anime');
    expect(FALLBACK_IMAGE_DIALECT.separator).toBe(', ');
    expect(FALLBACK_IMAGE_DIALECT.normalize).toBe('danbooru');
    expect(FALLBACK_IMAGE_DIALECT.appearance).toBe('danbooru');
    expect(FALLBACK_IMAGE_DIALECT.world).toBe('tags');
    expect(FALLBACK_IMAGE_DIALECT.rating).toBe('tag');
    expect(FALLBACK_IMAGE_DIALECT.count).toBe('tag');
    expect(FALLBACK_IMAGE_DIALECT.supportsNegative).toBe(true);
  });

  // 🔴 「兜底那段提示词 = `data/content/image-dialects.json` 里 danbooru-anime 那条的原文」
  //    这条**跨文件**双向断言在 `tests/placeholder-content.test.ts`（它读真 JSON；本文件在
  //    tsconfig 的 `src` 范围内，没有 node 类型，读不了盘）。改这里的常量前先看那条。

  it('🔴 systemPrompt **不是空串**，且带着 v1 那五条规则里最要命的三条', () => {
    // 空串的后果是静默的：装配层回落 agent-templates 的一行 stub，模型自己写人数/天气/画质，
    // 引擎再在上面追加一份自己的 —— 图照出、Anlas 照扣，只是内容不对。
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt.length).toBeGreaterThan(0);
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt).toContain('<image_prompt>');
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt).toContain('<image_negative>');
    expect(FALLBACK_IMAGE_DIALECT.systemPrompt).toContain('<image_desc>');
  });
});

describe('parseImageDialects —— 外层形状', () => {
  it('吃 { dialects: [...] }（落盘形状）', () => {
    expect(parseImageDialects(face(PROSE_RAW)).map((d) => d.id)).toEqual(['natural-prose']);
  });

  it('🔴 裸数组**不收** —— 校验器把这一面钉成对象，收了也永远走不到（假宽容）', () => {
    expect(parseImageDialects([PROSE_RAW])).toEqual([]);
  });

  it('认不出的外层一律返回空数组，绝不抛', () => {
    for (const raw of [undefined, null, 0, 'nope', {}, [], { dialects: 'nope' }, { list: [] }]) {
      expect(parseImageDialects(raw)).toEqual([]);
    }
  });

  it('完整条目原样收下（合法值一格都不许被"归一化"掉）', () => {
    expect(parseImageDialects(face(PROSE_RAW))[0]).toEqual(PROSE_RAW);
  });
});

describe('parseImageDialects —— 逐条容错（垃圾进，不炸）', () => {
  it('不是对象 / 没有 id / id 是空串 → 整条跳过（选不中的幽灵项不该进下拉）', () => {
    const parsed = parseImageDialects(
      face(
        null,
        'x',
        42,
        [],
        { label: '没有 id' },
        { id: '', label: '空 id' },
        { id: 123 },
        PROSE_RAW,
      ),
    );
    expect(parsed.map((d) => d.id)).toEqual(['natural-prose']);
  });

  it('id 重复 → 只留第一条', () => {
    const parsed = parseImageDialects(
      face({ id: 'dup', label: '先到' }, { id: 'dup', label: '后到' }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].label).toBe('先到');
  });

  it('枚举旋钮写坏 → 只有那一格回落 danbooru 默认值，其余格照收', () => {
    const parsed = parseImageDialects(
      face({
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
      }),
    )[0];
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
    // 完全没写的格同样回落（含 systemPrompt —— 没写话的方言拿的是 v1 那段，不是一句空话）
    expect(parsed.baseNegative).toBe(FALLBACK_IMAGE_DIALECT.baseNegative);
    expect(parsed.composition).toBe(FALLBACK_IMAGE_DIALECT.composition);
    expect(parsed.systemPrompt).toBe(DEFAULT_IMAGE_PROMPT_SYSTEM);
  });

  it('label / separator 为空串 → 回落（label 回落成 id，好让下拉里还认得出是谁）', () => {
    const parsed = parseImageDialects(face({ id: 'x', label: '', separator: '' }))[0];
    expect(parsed.label).toBe('x');
    expect(parsed.separator).toBe(FALLBACK_IMAGE_DIALECT.separator);
  });

  it('🔴 四个文本旋钮的空串是**合法值**，不许被当成「没填」回落', () => {
    const parsed = parseImageDialects(
      face({ id: 'x', qualitySuffix: '', baseNegative: '', composition: '', systemPrompt: '' }),
    )[0];
    expect(parsed.qualitySuffix).toBe('');
    expect(parsed.baseNegative).toBe('');
    expect(parsed.composition).toBe('');
    // 内容包作者写空串 = 「本方言没话说」，装配层据此回落 —— 这个语义只属于作者，不属于兜底
    expect(parsed.systemPrompt).toBe('');
  });
});

describe('resolveImageDialect —— 取哪一条', () => {
  const dialects = parseImageDialects(
    face(PROSE_RAW, { id: 'danbooru-anime', systemPrompt: '标签。' }),
  );

  it('id 精确命中', () => {
    expect(resolveImageDialect(dialects, 'natural-prose').appearance).toBe('prose');
  });

  it('id 认不出 → 落到清单里的内置 danbooru 条（它带着 pack 自己的提示词）', () => {
    expect(resolveImageDialect(dialects, '已被 pack 删掉的 id').systemPrompt).toBe('标签。');
  });

  it('没传 id（用户没选过）→ 同样落到内置 danbooru 条', () => {
    expect(resolveImageDialect(dialects, undefined).id).toBe('danbooru-anime');
  });

  it('🔴 清单为空（注册表这一面 404 / pack 清空）→ 兜底方言，不抛也不返回 undefined', () => {
    expect(resolveImageDialect([], 'whatever')).toEqual(FALLBACK_IMAGE_DIALECT);
    expect(resolveImageDialect([], undefined)).toEqual(FALLBACK_IMAGE_DIALECT);
  });

  it('🔴 兜底那条路拿到的 systemPrompt 是**非空**的 v1 原文（侧链不会跑在 stub 上）', () => {
    for (const id of [undefined, 'whatever']) {
      const picked = resolveImageDialect([], id);
      expect(picked.systemPrompt).toBe(DEFAULT_IMAGE_PROMPT_SYSTEM);
      expect(picked.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it('清单里只有散文档且 id 认不出 → 仍走兜底，不会误发一条散文方言给 NAI', () => {
    expect(resolveImageDialect(parseImageDialects(face(PROSE_RAW)), 'nope')).toEqual(
      FALLBACK_IMAGE_DIALECT,
    );
  });
});

describe('resolveImageDialect —— 覆盖合并（C6）', () => {
  const dialects = parseImageDialects(face(PROSE_RAW));

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

  it('🔴 id 认不出 + 带着覆盖袋 → 兜底方言，且覆盖**整袋作废**（pack 卸载后的那条路）', () => {
    // 用户给 pack 方言 krea-prose 调过散文提示词与构图；pack 卸载后 id 查不到了。
    // 覆盖袋是按**请求的 id** 取出来的，骑到 danbooru 上 = 拿散文提示词驱动 danbooru 装配，
    // 每张图都不对，付费后端上还每张都花钱。
    const merged = resolveImageDialect([], 'krea-prose', {
      systemPrompt: 'Write two sentences of natural English.',
      composition: 'cinematic composition',
      qualitySuffix: '',
      baseNegative: '',
    });
    expect(merged).toEqual(FALLBACK_IMAGE_DIALECT);
    expect(merged.systemPrompt).toBe(DEFAULT_IMAGE_PROMPT_SYSTEM);
    expect(merged.composition).toBe(DEFAULT_IMAGE_COMPOSITION_TAGS);
  });

  it('🔴 清单里有别的方言时同样丢：查不到 krea-prose → danbooru 条不带任何 krea 覆盖', () => {
    const list = parseImageDialects(face(PROSE_RAW, { id: 'danbooru-anime', label: '动漫标签' }));
    const merged = resolveImageDialect(list, 'krea-prose', {
      composition: 'cinematic composition',
    });
    expect(merged.id).toBe('danbooru-anime');
    expect(merged.composition).toBe(DEFAULT_IMAGE_COMPOSITION_TAGS);
  });

  it('没选过方言（id undefined）时覆盖袋无从键控 → 一律不生效', () => {
    expect(resolveImageDialect(dialects, undefined, { composition: 'close-up' }).composition).toBe(
      DEFAULT_IMAGE_COMPOSITION_TAGS,
    );
  });
});
