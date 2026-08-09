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
import { FALLBACK_IMAGE_DIALECT } from './image-dialect';
import { composePrompt, normalizeTagString, type ComposeOptions } from './image-prompt';
import type { ImageDialect, ImagePreset, ImageRating, SceneImageMarker } from './types-image';
import { EMPTY_APPEARANCE, type CharacterAppearance } from './character-appearance';

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
  it('场景 → 世界状态 → 构图 → rating → 画质后缀（地点随 D59 出列）', () => {
    const out = composePrompt(
      'tavern interior, sitting',
      '',
      marker([], 'general'),
      presetMap(),
      opts({
        worldTags: 'night, rain',
        compositionTags: 'wide shot',
        qualitySuffix: 'masterpiece',
      }),
    );

    expect(out.base).toBe(
      'tavern interior, sitting, night, rain, wide shot, rating:general, masterpiece',
    );
  });

  it('🔴 画质后缀在末尾（V3 之后一律追加在末尾，顺序即权重）', () => {
    const out = composePrompt('scene', '', marker(), presetMap(), opts());
    expect(out.base.endsWith(DEFAULT_IMAGE_QUALITY_SUFFIX)).toBe(true);
    expect(out.base.startsWith('scene')).toBe(true);
  });

  it('rating tag 排在画质后缀之前、构图之后', () => {
    const out = composePrompt(
      'scene',
      '',
      marker([], 'sensitive'),
      presetMap(),
      opts({ compositionTags: 'wide shot', qualitySuffix: 'masterpiece' }),
    );
    expect(out.base.indexOf('wide shot')).toBeLessThan(out.base.indexOf('rating:sensitive'));
    expect(out.base.indexOf('rating:sensitive')).toBeLessThan(out.base.indexOf('masterpiece'));
  });

  it('🔴 worldTags 原样拼接 —— 本层不做任何时段/天气推导', () => {
    const out = composePrompt('scene', '', marker(), presetMap(), {
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
    const out = composePrompt('scene', '', marker(), presetMap(), BARE);
    expect(out.base).toBe('scene, rating:explicit');
    expectCleanJoin(out.base);
  });

  it('连场景都为空时 base 只有 rating tag，且不以逗号开头', () => {
    const out = composePrompt('', '', marker(), presetMap(), BARE);
    expect(out.base).toBe('rating:explicit');
    expectCleanJoin(out.base);
  });

  it('段自带首尾逗号/全角标点也连不脏（用户手打的预设就长这样）', () => {
    const out = composePrompt(
      ', tavern，,',
      '',
      marker(),
      presetMap(),
      opts({ worldTags: ' , ', compositionTags: 'wide shot', qualitySuffix: 'masterpiece' }),
    );
    expect(out.base).toBe('tavern, wide shot, rating:explicit, masterpiece');
    expectCleanJoin(out.base);
  });

  it('baseNegative 的四段里有空段时同样干净', () => {
    const out = composePrompt('scene', '', marker(), presetMap(), {
      ...BARE,
      baseNegative: 'lowres',
      extraNegative: '',
    });
    expect(out.baseNegative).toBe('lowres');
    expectCleanJoin(out.baseNegative);
  });

  it('四段负向全空时 baseNegative 是空串，不是 ", "', () => {
    const out = composePrompt('scene', '', marker(), presetMap(), BARE);
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
    const out = composePrompt('scene', '', marker(['苏婉']), presetMap(苏婉), BARE);
    expect(out.characters[0].negative).toBe('red hair');
    expect(out.baseNegative).not.toContain('red hair');
  });

  it('顺序 = 标记里的顺序，别排序别去重（V4 的 use_order 依赖它）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['雷恩', '苏婉', '雷恩']),
      presetMap(苏婉, 雷恩),
      opts(),
    );
    expect(out.characters.map((c) => c.name)).toEqual(['雷恩', '苏婉', '雷恩']);
  });

  it('角色预设里的全角标点同样被归一化', () => {
    const 脏 = preset('character', '苏婉', 'girl，silver hair', 'red hair，freckles');
    const out = composePrompt('scene', '', marker(['苏婉']), presetMap(脏), opts());
    expect(out.characters[0]).toEqual({
      name: '苏婉',
      positive: 'girl, silver hair',
      negative: 'red hair, freckles',
    });
  });

  it('🔴 查不到预设 → 跳过该角色 + missing-preset 告警，不报错', () => {
    const out = composePrompt('scene', '', marker(['苏婉', '路人甲']), presetMap(苏婉), opts());
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
    const out = composePrompt('scene', '', marker(['艾拉']), presetMap(只有prose), opts());
    expect(out.characters).toEqual([]);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '艾拉' }]);
  });

  it('🔴 超过 6 个角色 → 截断 + characters-truncated 告警，不静默丢', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), presetMap(...rows), opts());

    expect(out.characters.map((c) => c.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['g', 'h'] }]);
  });

  it('被截掉的名字不再查预设，因此不会同时产 missing-preset', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', '没人写过的家伙'];
    const rows = names.slice(0, 6).map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), presetMap(...rows), opts());
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['没人写过的家伙'] }]);
  });

  it('maxCharacters 可覆盖默认的 6', () => {
    const names = ['a', 'b', 'c'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt(
      'scene',
      '',
      marker(names),
      presetMap(...rows),
      opts({ maxCharacters: 2 }),
    );
    expect(out.characters.map((c) => c.name)).toEqual(['a', 'b']);
    expect(out.warnings).toEqual([{ kind: 'characters-truncated', dropped: ['c'] }]);
  });

  it('恰好 6 个不告警', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rows = names.map((n) => preset('character', n, `${n} hair`));
    const out = composePrompt('scene', '', marker(names), presetMap(...rows), opts());
    expect(out.warnings).toEqual([]);
  });

  it('0 角色是合法的（纯风景）', () => {
    const out = composePrompt('landscape', '', marker([]), presetMap(), opts());
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
      presetMap(preset('character', '甲', 'a'), preset('character', '乙', 'b', '', 777)),
      opts({ maxCharacters: 1 }),
    );
    expect(out.seed).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 地点：D59 已废除
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 地点（D59 已废除）', () => {
  /**
   * 🪦 原本这里有五条地点预设用例（进 base / negative 并入 / 查不到静默 /
   *    空地点名 / 人名地名撞车）。D59 把地点预设整个废除 —— 地点无法穷举
   *    （宫殿 → 宴会厅 → 盥洗室），穷举表永远写不完。地点现在由侧链写进
   *    `scenePrompt`，本函数连地点参数都不再收。
   *
   * 留一条守住这件事：地点长什么样必须来自**场景串**，且再没有第二个来源。
   */
  it('地点描述来自场景串本身，函数不再查任何地点预设', () => {
    const out = composePrompt(
      'tavern interior, wooden walls, candlelight',
      '',
      marker([]),
      // 就算库里塞一条 key 长得像地点的预设，也不该有人去查它
      presetMap({
        key: 'location:破晓旅店',
        kind: 'character',
        name: '破晓旅店',
        dialects: { danbooru: { positive: 'SHOULD_NOT_APPEAR', negative: 'ALSO_NOT' } },
        createdAt: 0,
        updatedAt: 0,
      }),
      BARE,
    );
    expect(out.base).toContain('wooden walls');
    expect(out.base).not.toContain('SHOULD_NOT_APPEAR');
    expect(out.baseNegative).not.toContain('ALSO_NOT');
    expect(out.characters).toEqual([]);
    expect(out.warnings).toEqual([]);
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
          presetMap(),
          opts({ maxRating: order[max] }),
        );
        expect(out.base).toContain(`rating:${order[Math.min(want, max)]}`);
      }
    }
  });

  it('base 里恒有且只有一个 rating tag', () => {
    const out = composePrompt('scene', '', marker([], 'explicit'), presetMap(), opts());
    expect(out.base.match(/rating:/g)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 透传与纯度
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 透传与纯度', () => {
  it('🔴 场景串里的权重语法一个字符都不改', () => {
    const scene = '{{masterpiece}}, [[bad]], -0.8::feet::, <lora:my_style:0.8>';
    const out = composePrompt('' + scene, '', marker(), presetMap(), BARE);
    expect(out.base).toBe(`${scene}, rating:explicit`);
  });

  it('角色预设里的权重语法同样透传', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      presetMap(preset('character', '甲', '{{silver hair}}, -0.8::feet::')),
      BARE,
    );
    expect(out.characters[0].positive).toBe('{{silver hair}}, -0.8::feet::');
  });

  it('sceneNegative 进 baseNegative（在全局与追加之后）', () => {
    const out = composePrompt('scene', 'modern clothing', marker(), presetMap(), {
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
        presetMap(preset('character', '甲', 'a', 'b', 42)),
        opts({ worldTags: 'night' }),
      );
    expect(args()).toEqual(args());
  });

  it('不改动传入的 marker.characters 数组', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const copy = [...names];
    composePrompt('scene', '', marker(names), presetMap(), opts());
    expect(names).toEqual(copy);
  });
});

// ═══════════════════════════════════════════════════════════
// 外貌属性槽（D58）：槽在则以槽为准
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 角色外貌属性槽（D58）', () => {
  const withSlots = (appearance: Partial<CharacterAppearance>): ImagePreset => ({
    key: 'character:艾莉丝',
    kind: 'character',
    name: '艾莉丝',
    appearance: { ...EMPTY_APPEARANCE, ...appearance },
    dialects: { danbooru: { positive: 'OLD_HANDWRITTEN', negative: 'blonde hair' } },
    createdAt: 0,
    updatedAt: 0,
  });

  it('🔴 有槽就用槽，**不与**老的手写串合并（合并会让同一特征出现两次且措辞不一）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['艾莉丝']),
      presetMap(withSlots({ count: '1girl', hairColor: 'silver hair', outfit: 'white robe' })),
      BARE,
    );
    expect(out.characters[0].positive).toBe('1girl, silver hair, white robe');
    expect(out.characters[0].positive).not.toContain('OLD_HANDWRITTEN');
  });

  it('负向仍从 dialects 取 —— 槽说的是「她长什么样」，负向说的是「别画成什么样」', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['艾莉丝']),
      presetMap(withSlots({ count: '1girl' })),
      BARE,
    );
    expect(out.characters[0].negative).toBe('blonde hair');
  });

  it('没有槽的老预设照常走 dialects（迁移期两种预设并存）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      presetMap(preset('character', '甲', 'a, b', 'c')),
      BARE,
    );
    expect(out.characters[0].positive).toBe('a, b');
  });

  it('🔴 槽全空 = 与「没有槽」同义：不产出一个空槽位', () => {
    // 一个全空的基线给不出任何一致性信息。产出空槽位比跳过更糟 —— NAI 会拿到一个
    // 什么都没说的角色条件，等于让它自由发挥，而调用方还以为钉住了。
    //
    // 🔴 「没有槽」之后走的是**退回手写串**那条路（D58 的原话就是「有属性槽就以槽为准，
    //    **没有才**退回 dialects.danbooru」）—— 见下面两条。
    const out = composePrompt('scene', '', marker(['艾莉丝']), presetMap(withSlots({})), BARE);
    expect(out.characters[0].positive).toBe('OLD_HANDWRITTEN');
  });

  /**
   * 🔴 这一条挡的是一个**静默**的真 bug：设置页编辑器**总是**整份写回九个槽
   * （D58 留空即空值），所以「只填了外观标签框、九个槽没动」的预设带着一个
   * **存在但全空**的 `appearance`。按 `preset.appearance !== undefined` 判，
   * 这条用户明明填过的预设会产出空串并被当成「没有预设」丢掉 —— 不报错、不告警，
   * 只是那个角色在每一张图里都不像。
   */
  it('🔴 槽全空但有手写串 → 用手写串，绝不当成「没有预设」丢掉', () => {
    const out = composePrompt('scene', '', marker(['艾莉丝']), presetMap(withSlots({})), BARE);
    expect(out.warnings).toEqual([]);
    expect(out.characters).toHaveLength(1);
    expect(out.characters[0].positive).toBe('OLD_HANDWRITTEN');
  });

  it('槽全空且没有手写串 → 这才是真的「没有预设」：跳过并告警', () => {
    const bare: ImagePreset = {
      key: 'character:艾莉丝',
      kind: 'character',
      name: '艾莉丝',
      appearance: { ...EMPTY_APPEARANCE },
      dialects: {},
      createdAt: 0,
      updatedAt: 0,
    };
    const out = composePrompt('scene', '', marker(['艾莉丝']), presetMap(bare), BARE);
    expect(out.characters).toHaveLength(0);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '艾莉丝' }]);
  });
});

// ═══════════════════════════════════════════════════════════
// 人数标签由 Code 推（2026-08-05 真机催生）
// ═══════════════════════════════════════════════════════════

describe('composePrompt —— 人数标签', () => {
  const withCount = (name: string, count: string): ImagePreset => ({
    key: `character:${name}`,
    kind: 'character',
    name,
    appearance: { ...EMPTY_APPEARANCE, count },
    dialects: {},
    createdAt: 0,
    updatedAt: 0,
  });

  it('🔴 从阵容推出人数，压在 base 最前', () => {
    const out = composePrompt(
      'standing, looking at each other',
      '',
      marker(['甲', '乙']),
      presetMap(withCount('甲', '1girl'), withCount('乙', '1boy')),
      BARE,
    );
    expect(out.base.startsWith('1girl, 1boy')).toBe(true);
  });

  it('同性别累加成复数（2girls，不是 1girl, 1girl）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲', '乙']),
      presetMap(withCount('甲', '1girl'), withCount('乙', '1girl')),
      BARE,
    );
    expect(out.base.startsWith('2girls')).toBe(true);
  });

  it('🔴 模型自己写的人数标签被剥掉 —— 两个人数标签同时在场会画出多余的人', () => {
    const out = composePrompt(
      '2girls, 1boy, sitting across a table',
      '',
      marker(['甲']),
      presetMap(withCount('甲', '1girl')),
      BARE,
    );
    expect(out.base.startsWith('1girl')).toBe(true);
    expect(out.base).not.toContain('2girls');
    expect(out.base).toContain('sitting across a table');
  });

  it('🔴 数不出来时什么都不加（老的手写预设没有 count 槽）', () => {
    const out = composePrompt('no humans, scenery', '', marker([]), presetMap(), BARE);
    // 推不出人数 → 场景串原样保留，绝不凭空造一个人数标签
    expect(out.base).toContain('no humans');
  });
});

// ═══════════════════════════════════════════════════════════
// 方言参数化（图像 v2 / C3·C4·C6·C7·C15）
// ═══════════════════════════════════════════════════════════

/**
 * 一条散文方言。
 *
 * 🔴 四个**字符串**旋钮（qualitySuffix / baseNegative / composition / systemPrompt）在这里
 *    写什么都不影响装配 —— `composePrompt` **不读它们**（C6：解析「方言默认值 + 用户覆盖」
 *    是调用方的事，四个最终值照旧从 `ComposeOptions` 的同名字段进来）。故意都留空，
 *    免得日后有人照着这份夹具以为它们生效。
 */
function prose(patch: Partial<ImageDialect> = {}): ImageDialect {
  return {
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
    composition: '',
    systemPrompt: '',
    ...patch,
  };
}

/** 带九槽的角色预设；`handwritten` 是老形态的 danbooru 串 */
function slotted(
  name: string,
  appearance: Partial<CharacterAppearance>,
  dialects: ImagePreset['dialects'] = {},
): ImagePreset {
  return {
    key: `character:${name}`,
    kind: 'character',
    name,
    appearance: { ...EMPTY_APPEARANCE, ...appearance },
    dialects,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('composePrompt —— 方言缺省 = v1 逐字节不变（金测试）', () => {
  /**
   * 🔴 这一条是整个 C3 重构的安全网：**不传 dialect** 与 **传 FALLBACK_IMAGE_DIALECT**
   *    必须给出完全一样的产物。全仓有若干调用点不传方言（seams 之外还有测试与将来的
   *    新入口），缺省值一旦与 v1 差一个字节，那些路径就在无人察觉的情况下换了吃法 ——
   *    不报错，只是画出来的图不一样了。
   */
  const fixture = (dialect?: ImageDialect) =>
    composePrompt(
      '2girls, tavern interior, sitting across a table，candlelight',
      'modern clothing',
      marker(['苏婉', '雷恩', '路人甲'], 'questionable'),
      presetMap(
        slotted(
          '苏婉',
          { count: '1girl', hairColor: 'silver hair', outfit: 'white robe' },
          { danbooru: { positive: 'OLD', negative: 'red hair' } },
        ),
        preset('character', '雷恩', 'boy, black hair', 'blonde hair', 4242),
      ),
      {
        ...opts({
          worldTags: 'night, rain',
          compositionTags: 'wide shot',
          qualitySuffix: 'masterpiece, best quality',
          baseNegative: 'lowres',
          extraNegative: 'blurry',
          maxRating: 'explicit',
        }),
        ...(dialect === undefined ? {} : { dialect }),
      },
    );

  it('🔴 传 FALLBACK_IMAGE_DIALECT 与不传，产物逐字段相等', () => {
    expect(fixture(FALLBACK_IMAGE_DIALECT)).toEqual(fixture());
  });

  it('且那份产物确实是 v1 的样子（夹具不是空的，否则上一条恒真）', () => {
    const out = fixture();
    expect(out.base).toBe(
      '1girl, tavern interior, sitting across a table, candlelight, night, rain, wide shot, rating:questionable, masterpiece, best quality',
    );
    expect(out.baseNegative).toBe('lowres, blurry, modern clothing');
    expect(out.characters).toEqual([
      { name: '苏婉', positive: '1girl, silver hair, white robe', negative: 'red hair' },
      { name: '雷恩', positive: 'boy, black hair', negative: 'blonde hair' },
    ]);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '路人甲' }]);
    expect(out.seed).toBe(4242);
  });
});

describe('composePrompt —— prose 方言（C3/C15）', () => {
  it('段与段之间用方言的分隔符，不是 ", "', () => {
    const out = composePrompt('a young woman sits alone by the hearth', '', marker(), presetMap(), {
      ...opts({
        worldTags: 'night, rain',
        compositionTags: 'a wide, cinematic view',
        qualitySuffix: 'photorealistic, sharp focus',
      }),
      dialect: prose(),
    });
    // world:'none' → worldTags 整段不出；rating:'none' → 没有 rating 段
    expect(out.base).toBe(
      'a young woman sits alone by the hearth. a wide, cinematic view. photorealistic, sharp focus',
    );
  });

  it('🔴 rating:none → 不出 rating 标签（钳位照算，只是不拼进去）', () => {
    const out = composePrompt('a quiet room', '', marker([], 'explicit'), presetMap(), {
      ...BARE,
      dialect: prose(),
    });
    expect(out.base).toBe('a quiet room');
    expect(out.base).not.toContain('rating:');
  });

  it('🔴 count:none → 不推人数段，也**不拿正则去咬**模型写的句子', () => {
    // 同一份输入在 danbooru 档下会被剥成 "1girl, a scene where … talking"；
    // 散文档下 COUNT_TAG_RE 一次都不许运行 —— 它只认 tag 形态，咬进句子里不报错，
    // 只是把一段英文咬掉一块。
    const scene = 'a scene where 2girls and 1boy are talking';
    const map = presetMap(slotted('甲', { count: '1girl', build: 'slender' }));

    const out = composePrompt(scene, '', marker(['甲']), map, {
      ...BARE,
      dialect: prose(),
    });
    expect(out.base).toBe(scene);

    // 对照：danbooru 档确实会推人数并剥掉模型写的那个
    const danbooru = composePrompt(scene, '', marker(['甲']), map, BARE);
    expect(danbooru.base.startsWith('1girl')).toBe(true);
    expect(danbooru.base).not.toContain('2girls');
  });

  it('🔴 有槽的预设走 renderAppearanceProse（count 槽不进散文）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['艾莉丝']),
      presetMap(
        slotted('艾莉丝', {
          count: '1girl',
          hairColor: 'silver hair',
          build: 'slender',
          outfit: 'a white mage robe',
        }),
      ),
      { ...BARE, dialect: prose() },
    );
    expect(out.characters).toEqual([
      { name: '艾莉丝', positive: 'slender; silver hair; a white mage robe', negative: '' },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('🔴 只有手写 danbooru 串的老预设 → missing-preset 跳过 + 告警（C15，不降级透传）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      presetMap(preset('character', '甲', '1girl, silver hair, blue eyes', 'red hair')),
      { ...BARE, dialect: prose() },
    );
    expect(out.characters).toEqual([]);
    expect(out.warnings).toEqual([{ kind: 'missing-preset', name: '甲' }]);
    expect(out.base).not.toContain('silver hair'); // 透传是**没有**的那条路
  });

  it('预设自己写了 dialects.prose 时用它（那个预留字段终于有了消费方）', () => {
    const out = composePrompt(
      'scene',
      '',
      marker(['甲']),
      presetMap({
        key: 'character:甲',
        kind: 'character',
        name: '甲',
        dialects: {
          danbooru: { positive: 'SHOULD_NOT_APPEAR', negative: 'NOR_THIS' },
          prose: { positive: 'a tall elf with silver hair', negative: 'no armor' },
        },
        createdAt: 0,
        updatedAt: 0,
      }),
      { ...BARE, dialect: prose({ supportsNegative: true }) },
    );
    expect(out.characters).toEqual([
      { name: '甲', positive: 'a tall elf with silver hair', negative: 'no armor' },
    ]);
  });

  it('🔴 supportsNegative:false → baseNegative 与每个角色的 negative 全部清空', () => {
    const map = presetMap(
      slotted('甲', { build: 'slender' }, { prose: { positive: '', negative: 'no armor' } }),
    );
    const args = (dialect: ImageDialect) =>
      composePrompt('scene', 'modern clothing', marker(['甲']), map, {
        ...opts({ baseNegative: 'low quality', extraNegative: 'watermark', qualitySuffix: '' }),
        dialect,
      });

    const off = args(prose());
    expect(off.baseNegative).toBe('');
    expect(off.characters[0].negative).toBe('');

    // 对照：同一份输入在 supportsNegative:true 下四段都在 —— 上面那条不是恒真
    const on = args(prose({ supportsNegative: true }));
    expect(on.baseNegative).toBe('low quality. watermark. modern clothing');
    expect(on.characters[0].negative).toBe('no armor');
  });

  it('normalize:none 是**真恒等**：全角标点与空白一个字符都不动', () => {
    const scene = 'She turns，slowly，and  smiles';
    const out = composePrompt(scene, '', marker(), presetMap(), { ...BARE, dialect: prose() });
    expect(out.base).toBe(scene);
  });
});

describe('composePrompt —— flattenCharacters（C7 无槽后端）', () => {
  const 苏婉 = preset('character', '苏婉', 'girl, silver hair', 'red hair');
  const 雷恩 = preset('character', '雷恩', 'boy, black hair', 'blonde hair');

  it('🔴 角色 positive 按标记顺序插在场景段之后，characters[] 清空', () => {
    const out = composePrompt(
      'tavern interior',
      '',
      marker(['苏婉', '雷恩']),
      presetMap(苏婉, 雷恩),
      {
        ...opts({
          worldTags: 'night',
          compositionTags: 'wide shot',
          qualitySuffix: 'masterpiece',
        }),
        flattenCharacters: true,
      },
    );
    expect(out.base).toBe(
      'tavern interior, girl, silver hair, boy, black hair, night, wide shot, rating:explicit, masterpiece',
    );
    expect(out.characters).toEqual([]);
  });

  it('🔴 角色 negative 并进 baseNegative（排在 sceneNegative 之后）', () => {
    const out = composePrompt(
      'scene',
      'modern clothing',
      marker(['苏婉', '雷恩']),
      presetMap(苏婉, 雷恩),
      {
        ...BARE,
        baseNegative: 'lowres',
        extraNegative: 'blurry',
        flattenCharacters: true,
      },
    );
    expect(out.baseNegative).toBe('lowres, blurry, modern clothing, red hair, blonde hair');
  });

  it('告警与 seed 与有槽模式**逐字相同** —— 压平只改载体，不改判定', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', '没人写过的家伙', 'h'];
    const rows = [
      ...names.slice(0, 5).map((n) => preset('character', n, `${n} hair`)),
      preset('character', 'f', 'f hair', '', 777),
    ];
    const args = (flattenCharacters: boolean) =>
      composePrompt('scene', '', marker(names), presetMap(...rows), {
        ...opts({ maxCharacters: 7 }),
        flattenCharacters,
      });

    const slottedOut = args(false);
    const flatOut = args(true);
    expect(flatOut.warnings).toEqual(slottedOut.warnings);
    expect(flatOut.warnings).toEqual([
      { kind: 'missing-preset', name: '没人写过的家伙' },
      { kind: 'characters-truncated', dropped: ['h'] },
    ]);
    expect(flatOut.seed).toBe(777);
    expect(flatOut.seed).toBe(slottedOut.seed);
    // 被跳过的角色同样不进 base（压平不是「顺便把没预设的也塞进去」）
    expect(flatOut.base).not.toContain('没人写过的家伙');
  });

  it('0 角色时压平模式与有槽模式的 base 完全一致（纯风景）', () => {
    const bare = (flattenCharacters: boolean) =>
      composePrompt('landscape', '', marker([]), presetMap(), { ...BARE, flattenCharacters });
    expect(bare(true)).toEqual(bare(false));
  });

  it('压平 + prose：角色句子用方言分隔符接在场景之后', () => {
    const out = composePrompt(
      'two travellers rest by a fire',
      '',
      marker(['甲']),
      presetMap(slotted('甲', { build: 'slender', hairColor: 'silver hair' })),
      { ...BARE, dialect: prose(), flattenCharacters: true },
    );
    expect(out.base).toBe('two travellers rest by a fire. slender; silver hair');
    expect(out.characters).toEqual([]);
  });
});
