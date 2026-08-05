/**
 * character-appearance-resolve 测试（D56/D57 v1.3）
 *
 * 这个模块回答的是「这个角色现在到底长什么样」，而**四个消费方**依赖同一个答案：
 * 装配（`composePrompt`）、侧链点名（`charactersNeedingBaseline`）、正文缺预设提示
 * （`SceneImageSegment`）、写入路由（`applyAppearances`）。所以这里逐条钉的不是
 * 「函数返回了什么」，而是那四处**必须一致**的语义。
 *
 * 最要紧的两条（错了都是静默的）:
 * - 🔴 AI 一个字节都碰不到基线：没有基线时，即兴外貌落**会话层**，差量基准是全空
 * - 🔴 只有会话副本、没有预设行的角色**必须**出现在装配表里，否则那份外貌永远到不了提示词
 */
import { describe, it, expect } from 'vitest';
import { EMPTY_APPEARANCE, type CharacterAppearance } from './character-appearance';
import type { CharacterSessionAppearance, ImagePreset } from './types-image';
import {
  appearanceWriteTarget,
  baselineOf,
  buildEffectivePresets,
  characterPresetKey,
  effectiveAppearanceOf,
  hasAppearanceContent,
  hasEffectiveAppearance,
  hasHandwrittenDialect,
  needsBaselineReport,
} from './character-appearance-resolve';

function appearance(over: Partial<CharacterAppearance> = {}): CharacterAppearance {
  return { ...EMPTY_APPEARANCE, ...over };
}

function preset(over: Partial<ImagePreset> = {}): ImagePreset {
  return {
    key: characterPresetKey('苏婉'),
    kind: 'character',
    name: '苏婉',
    dialects: {},
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function sessionRow(
  name: string,
  patch: CharacterSessionAppearance['patch'],
): CharacterSessionAppearance {
  return { key: `save_1:${name}`, saveId: 'save_1', name, patch, updatedAt: 42 };
}

// ═══ 全空 appearance 的陷阱 ═══

describe('hasAppearanceContent / baselineOf', () => {
  it('🔴 全空的 appearance 等于没有 appearance', () => {
    // 设置页编辑器**总是**整份写回九个槽（D58 留空即空值），所以「只填了正向标签框」
    // 的预设带着一个存在但全空的对象。按存在性判会让它在装配时产出空串并被当成
    // 「没有预设」丢掉，而用户明明填过东西 —— 不报错，只是那个角色永远不像。
    expect(hasAppearanceContent(appearance())).toBe(false);
    expect(baselineOf(preset({ appearance: appearance() }))).toBeUndefined();
  });

  it('只要有一个槽有内容就算有基线；纯空白也不算', () => {
    expect(hasAppearanceContent(appearance({ hairColor: 'silver hair' }))).toBe(true);
    expect(hasAppearanceContent(appearance({ hairColor: '   ' }))).toBe(false);
  });

  it('没有 appearance 字段的老预设 → 没有基线', () => {
    expect(baselineOf(preset())).toBeUndefined();
    expect(baselineOf(undefined)).toBeUndefined();
  });
});

describe('hasHandwrittenDialect', () => {
  it('认得槽模型之前的手写正向串', () => {
    const legacy = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    expect(hasHandwrittenDialect(legacy)).toBe(true);
    expect(
      hasHandwrittenDialect(preset({ dialects: { danbooru: { positive: '', negative: 'x' } } })),
    ).toBe(false);
  });
});

// ═══ 写入路由（v1.3 的核心）═══

describe('appearanceWriteTarget', () => {
  it('🔴 没有基线时也写会话层，差量基准是全空 —— AI 永远碰不到基线', () => {
    const target = appearanceWriteTarget(undefined);
    expect(target).toEqual({ kind: 'session', base: EMPTY_APPEARANCE });
  });

  it('有基线时写会话层，差量基准是基线', () => {
    const base = appearance({ hairColor: 'silver hair', eyes: 'golden eyes' });
    expect(appearanceWriteTarget(preset({ appearance: base }))).toEqual({ kind: 'session', base });
  });

  it('🔴 手写老形态预设 → skip：会话层只能表达槽，落下去等于 AI 改写了用户的原文', () => {
    const legacy = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    expect(appearanceWriteTarget(legacy)).toEqual({ kind: 'skip' });
  });

  it('全空 appearance + 手写串 → 仍是 skip（全空槽不算基线，手写串才是用户写的东西）', () => {
    const legacy = preset({
      appearance: appearance(),
      dialects: { danbooru: { positive: 'silver hair', negative: '' } },
    });
    expect(appearanceWriteTarget(legacy)).toEqual({ kind: 'skip' });
  });
});

// ═══ 合并 ═══

describe('effectiveAppearanceOf', () => {
  it('基线 + 覆盖，逐槽合并', () => {
    const base = appearance({ hairColor: 'silver hair', outfit: 'white robe' });
    const merged = effectiveAppearanceOf(preset({ appearance: base }), { outfit: 'dark cloak' });
    expect(merged?.hairColor).toBe('silver hair');
    expect(merged?.outfit).toBe('dark cloak');
  });

  it('空串覆盖是「明确清空」，不退回基线（D58）', () => {
    const base = appearance({ outfit: 'white robe' });
    expect(effectiveAppearanceOf(preset({ appearance: base }), { outfit: '' })?.outfit).toBe('');
  });

  it('没有基线时，会话副本自己就是那份外貌（即兴，v1.3）', () => {
    const merged = effectiveAppearanceOf(undefined, { hairColor: 'red hair', count: '1girl' });
    expect(merged?.hairColor).toBe('red hair');
    expect(merged?.count).toBe('1girl');
  });

  it('既没有基线也没有会话副本 → undefined（= 这个角色的形象确实是随机的）', () => {
    expect(effectiveAppearanceOf(undefined, undefined)).toBeUndefined();
    expect(effectiveAppearanceOf(preset(), {})).toBeUndefined();
  });

  it('手写老形态 → undefined（它的外貌由 dialects 表达，这里没有槽可给）', () => {
    const legacy = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    expect(effectiveAppearanceOf(legacy, undefined)).toBeUndefined();
    // 但它**有**可用外貌 —— 两个问题不是一个问题
    expect(hasEffectiveAppearance(legacy, undefined)).toBe(true);
  });
});

// ═══ 点名（D57）═══

describe('needsBaselineReport', () => {
  it('什么都没有 → 点名，让侧链把九个槽写全', () => {
    expect(needsBaselineReport(undefined, undefined)).toBe(true);
  });

  it('🔴 有了会话副本就**不再**点名 —— 否则每张图都会让模型把九个槽重新即兴一遍', () => {
    expect(needsBaselineReport(undefined, { hairColor: 'red hair' })).toBe(false);
  });

  it('有基线或有手写串都不点名', () => {
    expect(
      needsBaselineReport(preset({ appearance: appearance({ eyes: 'blue eyes' }) }), undefined),
    ).toBe(false);
    expect(
      needsBaselineReport(
        preset({ dialects: { danbooru: { positive: 'blue eyes', negative: '' } } }),
        undefined,
      ),
    ).toBe(false);
  });
});

// ═══ 装配表 ═══

describe('buildEffectivePresets', () => {
  it('把本档覆盖就地叠进预设的 appearance', () => {
    const rows = buildEffectivePresets(
      [preset({ appearance: appearance({ hairColor: 'silver hair', outfit: 'white robe' }) })],
      [sessionRow('苏婉', { outfit: 'dark cloak' })],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].appearance?.hairColor).toBe('silver hair');
    expect(rows[0].appearance?.outfit).toBe('dark cloak');
  });

  it('🔴 只有会话副本、没有预设行的角色也必须出现（v1.3 的要害）', () => {
    // 漏掉他们 = AI 明明报了外貌，画出来还是每张一个样
    const rows = buildEffectivePresets([], [sessionRow('艾莉丝', { hairColor: 'red hair' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(characterPresetKey('艾莉丝'));
    expect(rows[0].name).toBe('艾莉丝');
    expect(rows[0].appearance?.hairColor).toBe('red hair');
    // 合成行不带手写方言，也不带 seed
    expect(rows[0].dialects).toEqual({});
    expect(rows[0].pinnedSeed).toBeUndefined();
  });

  it('合成行的 key 与装配层查表用的键一致（否则查不中，且不报错）', () => {
    const rows = buildEffectivePresets([], [sessionRow('艾莉丝', { count: '1girl' })]);
    const map = new Map(rows.map((r) => [r.key, r]));
    expect(map.get(characterPresetKey('艾莉丝'))).toBeDefined();
  });

  it('全空 patch 不合成预设行（造不出外貌就没有理由造一行）', () => {
    expect(buildEffectivePresets([], [sessionRow('无名', {})])).toEqual([]);
  });

  it('手写老形态原样透传，会话覆盖不叠上去（不改写用户的原文）', () => {
    const legacy = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    const rows = buildEffectivePresets([legacy], [sessionRow('苏婉', { outfit: 'dark cloak' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(legacy);
  });

  it('没有会话副本时原样返回，不复制也不改字段', () => {
    const p = preset({ appearance: appearance({ eyes: 'golden eyes' }) });
    const rows = buildEffectivePresets([p], []);
    expect(rows[0]).toBe(p);
  });

  it('名字按原样匹配，不 trim 不折大小写（铁律 1）', () => {
    const p = preset({ name: '苏婉', appearance: appearance({ hairColor: 'silver hair' }) });
    const rows = buildEffectivePresets([p], [sessionRow('苏婉 ', { hairColor: 'red hair' })]);
    // 「苏婉 」与「苏婉」是两个人：预设不受影响，另外合成一行
    expect(rows).toHaveLength(2);
    expect(rows[0].appearance?.hairColor).toBe('silver hair');
    expect(rows[1].name).toBe('苏婉 ');
  });
});
