/**
 * image-defaults.test.ts — 图像生成常量默认值的守卫测试
 *
 * 这些不是「测常量等于常量」的空转断言。每一条钉住的都是设计里写明、
 * 且**改坏了不会报错只会静默变糟**的规则（§6.2 / §5.2 / §5.3）。
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_MAX_PER_HOUR,
  DEFAULT_IMAGE_MAX_PER_MESSAGE,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
  IMAGE_QUOTA_WINDOW_MS,
  NAI_QUALITY_SUFFIXES,
} from './image-defaults';

describe('画质后缀', () => {
  it('🔴 默认后缀绝不含 rating:general —— 那会跟我们自己的分级 tag 打架（§6.2）', () => {
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX).not.toContain('rating:general');
    // 更严的一条：任何 rating:* 都不该出现在画质后缀里，分级只由 composePrompt 显式拼
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX).not.toMatch(/rating:/);
  });

  it('默认取 V4.5 Full 那一行', () => {
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX).toBe(NAI_QUALITY_SUFFIXES['V4.5 Full']);
    expect(DEFAULT_IMAGE_QUALITY_SUFFIX).toBe('location, very aesthetic, masterpiece, no text');
  });

  it('两行 Curated 后缀确实带 rating:general —— 这正是不用它们的理由，别顺手换过去', () => {
    expect(NAI_QUALITY_SUFFIXES['V4.5 Curated']).toContain('rating:general');
    expect(NAI_QUALITY_SUFFIXES['V4 Curated']).toContain('rating:general');
  });

  it('默认模型不是 Curated', () => {
    expect(DEFAULT_IMAGE_MODEL).toBe('nai-diffusion-4-5-full');
    expect(DEFAULT_IMAGE_MODEL).not.toContain('curated');
  });

  it('表里每一行都不带前导/尾随逗号 —— composePrompt 自己用 ", " 连接，不许产出 ", ,"', () => {
    for (const [name, suffix] of Object.entries(NAI_QUALITY_SUFFIXES)) {
      expect(suffix, name).not.toMatch(/^\s*,/);
      expect(suffix, name).not.toMatch(/,\s*$/);
    }
  });
});

describe('构图词与基础负向', () => {
  it('构图词非空、无前导逗号', () => {
    expect(DEFAULT_IMAGE_COMPOSITION_TAGS.length).toBeGreaterThan(0);
    expect(DEFAULT_IMAGE_COMPOSITION_TAGS).not.toMatch(/^\s*,/);
    expect(DEFAULT_IMAGE_COMPOSITION_TAGS).not.toMatch(/,\s*$/);
  });

  it('🔴 基础负向不掺分级词 —— 分级归 rating:* tag 管，在负向里反着来等于绕过用户设的上限', () => {
    expect(DEFAULT_IMAGE_BASE_NEGATIVE).not.toMatch(/rating:/);
    expect(DEFAULT_IMAGE_BASE_NEGATIVE).not.toMatch(/\bnsfw\b/i);
  });

  it('🔴 常量里不许出现全角标点 —— normalizeTagString 修的是 AI 的输出，不该来修我们自己的常量', () => {
    for (const value of [
      DEFAULT_IMAGE_QUALITY_SUFFIX,
      DEFAULT_IMAGE_COMPOSITION_TAGS,
      DEFAULT_IMAGE_BASE_NEGATIVE,
    ]) {
      expect(value).not.toMatch(/[，、；《》]/);
    }
  });
});

describe('限额默认值（§5.3）', () => {
  it('每消息 2 / 每小时 20', () => {
    expect(DEFAULT_IMAGE_MAX_PER_MESSAGE).toBe(2);
    expect(DEFAULT_IMAGE_MAX_PER_HOUR).toBe(20);
  });

  it('滚动窗口是 1 小时', () => {
    expect(IMAGE_QUOTA_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it('每消息上限不得高于每小时上限 —— 否则 L1 形同虚设', () => {
    expect(DEFAULT_IMAGE_MAX_PER_MESSAGE).toBeLessThanOrEqual(DEFAULT_IMAGE_MAX_PER_HOUR);
  });
});
