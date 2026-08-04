/**
 * image-prompt.test.ts — 承重模块的不变式测试（设计 §5.2 / §3.2b / §6.2）
 *
 * 这里每一条 `it` 对应设计里的一条**不变式**。它们守的都是「改坏了不报错、
 * 只会静默画出一张莫名其妙的图」那一类失败 —— 所以测试写得比别处细。
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from './image-defaults';
import { composePrompt, normalizeTagString, type ComposeOptions } from './image-prompt';
import type { ImagePreset, ImageRating, SceneImageMarker } from './types-image';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

function preset(
  kind: ImagePreset['kind'],
  name: string,
  positive: string,
  negative = '',
  pinnedSeed?: number,
): ImagePreset {
  return {
    key: `${kind}:${name}`,
    kind,
    name,
    dialects: { danbooru: { positive, negative } },
    ...(pinnedSeed === undefined ? {} : { pinnedSeed }),
    createdAt: 0,
    updatedAt: 0,
  };
}

function presetMap(...rows: ImagePreset[]): ReadonlyMap<string, ImagePreset> {
  return new Map(rows.map((row) => [row.key, row]));
}

function opts(patch: Partial<ComposeOptions> = {}): ComposeOptions {
  return {
    qualitySuffix: DEFAULT_IMAGE_QUALITY_SUFFIX,
    compositionTags: DEFAULT_IMAGE_COMPOSITION_TAGS,
    baseNegative: DEFAULT_IMAGE_BASE_NEGATIVE,
    extraNegative: '',
    maxRating: 'explicit',
    worldTags: '',
    ...patch,
  };
}

function marker(
  characters: string[] = [],
  rating?: ImageRating,
): Pick<SceneImageMarker, 'characters' | 'rating'> {
  return rating === undefined ? { characters } : { characters, rating };
}

/** 空到不能再空的一组选项 —— 专用来验「空段跳过」 */
const BARE = opts({
  qualitySuffix: '',
  compositionTags: '',
  baseNegative: '',
  extraNegative: '',
  worldTags: '',
});

/** 各段之间只允许出现单个 ", "，且首尾不许有逗号 */
function expectCleanJoin(value: string): void {
  expect(value).not.toMatch(/,\s*,/);
  expect(value).not.toMatch(/^\s*,/);
  expect(value).not.toMatch(/,\s*$/);
  expect(value).not.toMatch(/\s{2,}/);
}

// ═══════════════════════════════════════════════════════════
// normalizeTagString（§3.2b）
// ═══════════════════════════════════════════════════════════

describe('normalizeTagString —— 标点归一化', () => {
  it('🔴 全角逗号 → ASCII 逗号（不修就是整串变成一个巨型标签）', () => {
    expect(normalizeTagString('1girl，silver hair')).toBe('1girl, silver hair');
  });

  it('顿号与全角分号同样收敛成逗号', () => {
    expect(normalizeTagString('1girl、silver hair；smile')).toBe('1girl, silver hair, smile');
  });

  it('🔴 《》→ <>，于是 <lora:x:0.8> 得以复原', () => {
    expect(normalizeTagString('《lora:x:0.8》')).toBe('<lora:x:0.8>');
  });

  it('连续逗号折叠', () => {
    expect(normalizeTagString('a,,b')).toBe('a, b');
    expect(normalizeTagString('a , , , b')).toBe('a, b');
  });

  it('换行与 <br> 各写法都当分隔（AI 常按行分组标签）', () => {
    expect(normalizeTagString('a\nb')).toBe('a, b');
    expect(normalizeTagString('a\r\nb')).toBe('a, b');
    expect(normalizeTagString('a<br>b<br/>c<BR />d')).toBe('a, b, c, d');
  });

  it('折叠连续空白（含全角空格），去掉首尾逗号与空白', () => {
    expect(normalizeTagString('  a   b  ')).toBe('a b');
    expect(normalizeTagString('a　　b')).toBe('a b');
    expect(normalizeTagString(',,a, b,,')).toBe('a, b');
  });

  it('🔴 权重语法一个字符都不改', () => {
    for (const raw of [
      '{{masterpiece}}',
      '[[bad anatomy]]',
      '-0.8::feet::',
      '<lora:my_style:0.8>',
      '{{{1.05::detailed::}}}',
    ]) {
      expect(normalizeTagString(raw)).toBe(raw);
    }
  });

  it('权重语法混在需要修的串里也照样透传', () => {
    expect(normalizeTagString('{{masterpiece}}，-0.8::feet::、《lora:x:0.8》')).toBe(
      '{{masterpiece}}, -0.8::feet::, <lora:x:0.8>',
    );
  });

  it('空串进、空串出；纯标点串收敛成空串', () => {
    expect(normalizeTagString('')).toBe('');
    expect(normalizeTagString('  ,，、 ')).toBe('');
  });

  it('幂等 —— 已归一化的串再过一次不变（记录里缓存的 scenePrompt 会被反复装配）', () => {
    const once = normalizeTagString('a，，b\nc<br>《lora:x:0.8》');
    expect(normalizeTagString(once)).toBe(once);
  });
});

// ═══════════════════════════════════════════════════════════
// composePrompt —— 拼接顺序（§5.2 [1]-[6]）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 拼接顺序', () => {
  it('场景 → 地点 → 世界状态 → 构图 → rating → 画质后缀', () => {
    const out = composePrompt(
      'tavern interior, sitting',
      '',
      marker([], 'general'),
      '破晓旅店',
      presetMap(preset('location', '破晓旅店', 'wooden walls, candlelight')),
      opts({
        worldTags: 'night, rain',
        compositionTags: 'wide shot',
        qualitySuffix: 'masterpiece',
      }),
    );

    expect(out.base).toBe(
      'tavern interior, sitting, wooden walls, candlelight, night, rain, wide shot, rating:general, masterpiece',
    );
  });

  it('🔴 画质后缀在末尾（V3 之后一律追加在末尾，顺序即权重）', () => {
    const out = composePrompt('scene', '', marker(), undefined, presetMap(), opts());
    expect(out.base.endsWith(DEFAULT_IMAGE_QUALITY_SUFFIX)).toBe(true);
    expect(out.base.startsWith('scene')).toBe(true);
  });

  it('rating tag 排在画质后缀之前、构图之后', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([], 'sensitive'),
      undefined,
      presetMap(),
      opts({ compositionTags: 'wide shot', qualitySuffix: 'masterpiece' }),
    );
    expect(out.base.indexOf('wide shot')).toBeLessThan(out.base.indexOf('rating:sensitive'));
    expect(out.base.indexOf('rating:sensitive')).toBeLessThan(out.base.indexOf('masterpiece'));
  });

  it('🔴 worldTags 原样拼接 —— 本层不做任何时段/天气推导', () => {
    const out = composePrompt('scene', '', marker(), undefined, presetMap(), {
      ...BARE,
      worldTags: 'night, heavy rain',
    });
    expect(out.base).toBe('scene, night, heavy rain, rating:explicit');
  });
});

// ═══════════════════════════════════════════════════════════
// 空段跳过（§5.2 不变式）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 空段直接跳过，绝不产出 ", ," 或首尾逗号', () => {
  it('全部可选段为空时只剩场景与 rating', () => {
    const out = composePrompt('scene', '', marker(), undefined, presetMap(), BARE);
    expect(out.base).toBe('scene, rating:explicit');
    expectCleanJoin(out.base);
  });

  it('连场景都为空时 base 只有 rating tag，且不以逗号开头', () => {
    const out = composePrompt('', '', marker(), undefined, presetMap(), BARE);
    expect(out.base).toBe('rating:explicit');
    expectCleanJoin(out.base);
  });

  it('段自带首尾逗号/全角标点也连不脏（用户手打的预设就长这样）', () => {
    const out = composePrompt(
      ', tavern，,',
      '',
      marker(),
      '破晓旅店',
      presetMap(preset('location', '破晓旅店', '，wooden walls，')),
      opts({ worldTags: ' , ', compositionTags: 'wide shot', qualitySuffix: 'masterpiece' }),
    );
    expect(out.base).toBe('tavern, wooden walls, wide shot, rating:explicit, masterpiece');
    expectCleanJoin(out.base);
  });

  it('baseNegative 的四段里有空段时同样干净', () => {
    const out = composePrompt('scene', '', marker(), undefined, presetMap(), {
      ...BARE,
      baseNegative: 'lowres',
      extraNegative: '',
    });
    expect(out.baseNegative).toBe('lowres');
    expectCleanJoin(out.baseNegative);
  });

  it('四段负向全空时 baseNegative 是空串，不是 ", "', () => {
    const out = composePrompt('scene', '', marker(), undefined, presetMap(), BARE);
    expect(out.baseNegative).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// 角色（§6.2 多角色官方规则）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 角色', () => {
  const 苏婉 = preset('character', '苏婉', 'girl, silver hair, blue eyes', 'red hair');
  const 雷恩 = preset('character', '雷恩', 'boy, black hair', 'blonde hair');

  it('🔴 角色预设绝不拼进 base，分别进 characters[]', () => {
    const out = composePrompt(
      '2girls, tavern',
      '',
      marker(['苏婉', '雷恩']),
      undefined,
      presetMap(苏婉, 雷恩),
      opts(),
    );
    expect(out.base).not.toContain('silver hair');
    expect(out.base).not.toContain('black hair');
    expect(out.characters).toEqual([
      { name: '苏婉', positive: 'girl, silver hair, blue eyes', negative: 'red hair' },
      { name: '雷恩', positive: 'boy, black hair', negative: 'blonde hair' },
    ]);
  });

  it('🔴 角色的 negative 进该角色的槽，不并入 baseNegative（官方抗串味手段）', () => {
    const out = composePrompt('scene', '', marker(['苏婉']), undefined, presetMap(苏婉), BARE);
    expect(out.characters[0].negative).toBe('red hair');
    expect(out.baseNegative).not.toContain('red hair');
  });

  it('顺序 = 标记里的顺序，别排序别去重（V4 的 use_order 依赖它）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['雷恩', '苏婉', '雷恩']),
      undefined,
      presetMap(苏婉, 雷恩),
      opts(),
    );
    expect(out.characters.map((c) => c.name)).toEqual(['雷恩', '苏婉', '雷恩']);
  });

  it('角色预设里的全角标点同样被归一化', () => {
    const 脏 = preset('character', '苏婉', 'girl，silver hair', 'red hair，freckles');
    const out = composePrompt('scene', '', marker(['苏婉']), undefined, presetMap(脏), opts());
    expect(out.characters[0]).toEqual({
      name: '苏婉',
      positive: 'girl, silver hair',
      negative: 'red hair, freckles',
    });
  });

  it('🔴 查不到预设 → 跳过该角色 + missing-preset 告警，不报错', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['苏婉', '路人甲']),
      undefined,
      presetMap(苏婉),
      opts(),
    );
    expect(out.characters.map((c) => c.name)).toEqual(['苏婉']);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '路人甲' }]);
    expect(out.base).toContain('scene'); // 只画场景，仍然产出可用提示词
  });

  it('预设存在但没有 danbooru 方言（只写了 prose）也算 missing-preset', () => {
    const 只有prose: ImagePreset = {
      key: 'character:艾拉',
      kind: 'character',
      name: '艾拉',
      dialects: { prose: { positive: 'a tall elf', negative: '' } },
      createdAt: 0,
      updatedAt: 0,
    };
    const out = composePrompt(
      'scene',
      '',
      marker(['艾拉']),
      undefined,
      presetMap(只有prose),
      opts(),
    );
    expect(out.characters).toEqual([]);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '艾拉' }]);
  });

  it('🔴 超过 6 个角色 → 截断 + characters-truncated 告警，不静默丢', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), undefined, presetMap(...rows), opts());

    expect(out.characters.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['g', 'h'] }]);
  });

  it('被截掉的名字不再查预设，因此不会同时产 missing-preset', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', '没人写过的家伙'];
    const rows = names.slice(0, 6).map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), undefined, presetMap(...rows), opts());
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['没人写过的家伙'] }]);
  });

  it('maxCharacters 可覆盖默认的 6', () => {
    const names = ['a', 'b', 'c'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt(
      'scene',
      '',
      marker(names),
      undefined,
      presetMap(...rows),
      opts({ maxCharacters: 2 }),
    );
    expect(out.characters.map((c) => c.name)).toEqual(['a', 'b']);
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['c'] }]);
  });

  it('恰好 6 个不告警', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), undefined, presetMap(...rows), opts());
    expect(out.warnings).toEqual([]);
  });

  it('0 角色是合法的（纯风景）', () => {
    const out = composePrompt('landscape', '', marker([]), undefined, presetMap(), opts());
    expect(out.characters).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// seed（§5.2）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— seed', () => {
  it('取第一个带 pinnedSeed 的角色', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲', '乙', '丙']),
      undefined,
      presetMap(
        preset('character', '甲', 'a'),
        preset('character', '乙', 'b', '', 12345),
        preset('character', '丙', 'c', '', 999),
      ),
      opts(),
    );
    expect(out.seed).toBe(12345);
  });

  it('都没钉 seed → undefined（= 随机，由下游决定）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      undefined,
      presetMap(preset('character', '甲', 'a')),
      opts(),
    );
    expect(out.seed).toBeUndefined();
  });

  it('被截断掉的角色的 seed 不算数', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲', '乙']),
      undefined,
      presetMap(preset('character', '甲', 'a'), preset('character', '乙', 'b', '', 777)),
      opts({ maxCharacters: 1 }),
    );
    expect(out.seed).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 地点（D40）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 地点预设', () => {
  it('🔴 地点预设进 base，不进角色槽', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([]),
      '破晓旅店',
      presetMap(preset('location', '破晓旅店', 'wooden walls', 'modern furniture')),
      BARE,
    );
    expect(out.base).toContain('wooden walls');
    expect(out.characters).toEqual([]);
  });

  it('地点预设的 negative 并进 baseNegative（它描述的是场景不是人）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([]),
      '破晓旅店',
      presetMap(preset('location', '破晓旅店', 'wooden walls', 'modern furniture')),
      { ...BARE, baseNegative: 'lowres' },
    );
    expect(out.baseNegative).toBe('lowres, modern furniture');
  });

  it('🔴 查不到同名地点预设 → 静默跳过，不产 warning（那是常态不是异常）', () => {
    const out = composePrompt('scene', '', marker([]), '没人写过的地方', presetMap(), BARE);
    expect(out.warnings).toEqual([]);
    expect(out.base).toBe('scene, rating:explicit');
  });

  it('locationName 为 undefined / 空串时同样安静', () => {
    for (const name of [undefined, '']) {
      const out = composePrompt('scene', '', marker([]), name, presetMap(), BARE);
      expect(out.warnings).toEqual([]);
      expect(out.base).toBe('scene, rating:explicit');
    }
  });

  it('地名与人名撞车时按 kind 前缀取，不会拿错（主键 = `${kind}:${name}`）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['亚瑟']),
      '亚瑟',
      presetMap(
        preset('location', '亚瑟', 'ruined castle'),
        preset('character', '亚瑟', 'man, golden armor'),
      ),
      BARE,
    );
    expect(out.base).toContain('ruined castle');
    expect(out.base).not.toContain('golden armor');
    expect(out.characters).toEqual([{ name: '亚瑟', positive: 'man, golden armor', negative: '' }]);
  });
});

// ═══════════════════════════════════════════════════════════
// rating 钳位（D38）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— rating 钳位', () => {
  it('🔴 标记要 explicit 但上限 general → 钳到 general，且静默（不产 warning）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([], 'explicit'),
      undefined,
      presetMap(),
      opts({ maxRating: 'general' }),
    );
    expect(out.base).toContain('rating:general');
    expect(out.base).not.toContain('rating:explicit');
    expect(out.warnings).toEqual([]);
  });

  it('低于上限时按标记走（上限不是默认值，是封顶）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([], 'sensitive'),
      undefined,
      presetMap(),
      opts({ maxRating: 'explicit' }),
    );
    expect(out.base).toContain('rating:sensitive');
  });

  it('标记没写 rating → 取 maxRating（"默认"的行为没变）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([]),
      undefined,
      presetMap(),
      opts({ maxRating: 'questionable' }),
    );
    expect(out.base).toContain('rating:questionable');
  });

  it('分级顺序 general < sensitive < questionable < explicit 逐档成立', () => {
    const order: ImageRating[] = ['general', 'sensitive', 'questionable', 'explicit'];
    for (let want = 0; want < order.length; want++) {
      for (let max = 0; max < order.length; max++) {
        const out = composePrompt(
          'scene',
          '',
          marker([], order[want]),
          undefined,
          presetMap(),
          opts({ maxRating: order[max] }),
        );
        expect(out.base).toContain(`rating:${order[Math.min(want, max)]}`);
      }
    }
  });

  it('base 里恒有且只有一个 rating tag', () => {
    const out = composePrompt('scene', '', marker([], 'explicit'), undefined, presetMap(), opts());
    expect(out.base.match(/rating:/g)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 透传与纯度
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 透传与纯度', () => {
  it('🔴 场景串里的权重语法一个字符都不改', () => {
    const scene = '{{masterpiece}}, [[bad]], -0.8::feet::, <lora:my_style:0.8>';
    const out = composePrompt('' + scene, '', marker(), undefined, presetMap(), BARE);
    expect(out.base).toBe(`${scene}, rating:explicit`);
  });

  it('角色预设里的权重语法同样透传', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      undefined,
      presetMap(preset('character', '甲', '{{silver hair}}, -0.8::feet::')),
      BARE,
    );
    expect(out.characters[0].positive).toBe('{{silver hair}}, -0.8::feet::');
  });

  it('sceneNegative 进 baseNegative（在全局与追加之后）', () => {
    const out = composePrompt('scene', 'modern clothing', marker(), undefined, presetMap(), {
      ...BARE,
      baseNegative: 'lowres',
      extraNegative: 'blurry',
    });
    expect(out.baseNegative).toBe('lowres, blurry, modern clothing');
  });

  it('🔴 纯函数：同样的入参两次调用结果逐字相同（不产随机、不读时钟）', () => {
    const args = () =>
      composePrompt(
        'scene',
        'neg',
        marker(['甲'], 'sensitive'),
        '破晓旅店',
        presetMap(preset('character', '甲', 'a', 'b', 42), preset('location', '破晓旅店', 'walls')),
        opts({ worldTags: 'night' }),
      );
    expect(args()).toEqual(args());
  });

  it('不改动传入的 marker.characters 数组', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const copy = [...names];
    composePrompt('scene', '', marker(names), undefined, presetMap(), opts());
    expect(names).toEqual(copy);
  });
});
