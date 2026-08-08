/**
 * preset-dialect-form.test.ts — 「散文方言下这条预设还有没有形象」的真值表（C15）
 *
 * 这条判据必须与装配层（`image-prompt.appearanceOf` + `composePrompt` 的
 * `missing-preset` 分支）给同一个答案。两边漂了不会有任何报错 —— 只是设置页说好好的、
 * 图里那个人不出现。所以这里逐格钉住，尤其那格 D62（全空槽等于没有槽）。
 */
import { describe, expect, it } from 'vitest';
import type { ImageDialect, ImagePreset } from '@engine/types-image';
import { EMPTY_APPEARANCE } from '@engine/character-appearance';
import { FALLBACK_IMAGE_DIALECT } from '@engine/image-dialect';
import { PRESET_NO_FORM_HINT, lacksFormUnderDialect } from './preset-dialect-form';

const PROSE: ImageDialect = { ...FALLBACK_IMAGE_DIALECT, id: 'natural-prose', appearance: 'prose' };
const DANBOORU: ImageDialect = FALLBACK_IMAGE_DIALECT;

function preset(over: Partial<ImagePreset> = {}): ImagePreset {
  return {
    key: 'character:苏婉',
    kind: 'character',
    name: '苏婉',
    dialects: {},
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('lacksFormUnderDialect（C15）', () => {
  it('danbooru 方言下**永远不标** —— 老预设在那边照常可用', () => {
    const onlyTags = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    expect(lacksFormUnderDialect(onlyTags, DANBOORU)).toBe(false);
    // 连什么都没写的空预设，在 danbooru 档也不是本提示要说的事
    expect(lacksFormUnderDialect(preset(), DANBOORU)).toBe(false);
  });

  it('散文方言 + 只有 danbooru 手写串 → 标出来（跨方言不降级透传）', () => {
    const onlyTags = preset({ dialects: { danbooru: { positive: 'silver hair', negative: '' } } });
    expect(lacksFormUnderDialect(onlyTags, PROSE)).toBe(true);
  });

  it('散文方言 + 有属性槽 → 不标（槽跨方言通用，渲染成句子即可）', () => {
    const slotted = preset({ appearance: { ...EMPTY_APPEARANCE, hairColor: 'silver hair' } });
    expect(lacksFormUnderDialect(slotted, PROSE)).toBe(false);
  });

  it('散文方言 + 写过 prose 手写串 → 不标', () => {
    const prose = preset({
      dialects: { prose: { positive: 'a silver-haired woman', negative: '' } },
    });
    expect(lacksFormUnderDialect(prose, PROSE)).toBe(false);
  });

  it('🔴 D62：`appearance` 存在但九个槽全空 = 没有槽，照样要标', () => {
    // 编辑器总是整份写回九个槽（D58 留空即空值），所以「只填过老标签框」的预设
    // 带着一个存在但全空的 appearance。按 `!== undefined` 判会把它当成有槽 ——
    // 恰好漏掉最需要这句提示的那一类。
    const allEmpty = preset({
      appearance: { ...EMPTY_APPEARANCE },
      dialects: { danbooru: { positive: 'silver hair', negative: '' } },
    });
    expect(allEmpty.appearance).toBeDefined();
    expect(lacksFormUnderDialect(allEmpty, PROSE)).toBe(true);
  });

  it('槽里只有空白字符同样算全空', () => {
    const blank = preset({ appearance: { ...EMPTY_APPEARANCE, outfit: '   ' } });
    expect(lacksFormUnderDialect(blank, PROSE)).toBe(true);
  });

  it('prose 手写串只有空白 → 仍然算没有形象（与装配层的 trim 判据同源）', () => {
    const blank = preset({ dialects: { prose: { positive: '   ', negative: 'x' } } });
    expect(lacksFormUnderDialect(blank, PROSE)).toBe(true);
  });

  it('提示文案是常量，界面与测试读同一份', () => {
    expect(PRESET_NO_FORM_HINT).toContain('当前方言下无可用形象');
  });
});
