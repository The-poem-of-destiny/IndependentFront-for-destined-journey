/**
 * asset-types.test.ts — 素材类型规则与扩展名表
 *
 * 覆盖:
 * 1. categoryForType 派生（v1 恒 character）
 * 2. isAssetTypeToken **整段相等**，绝不子串 —— `立绘bg` 含 `立绘` 是本文件
 *    最要紧的那条断言
 * 3. 扩展名路由表: 图片七种 / 视频只有 mp4 / 无 svg / 无 webm（webm 归音频）
 * 4. 媒体规则 (D7): 立绘 拒 mp4，头像 与 立绘bg 收
 */

import { describe, it, expect } from 'vitest';
import {
  categoryForType,
  isAssetTypeToken,
  ASSET_MIME_BY_EXTENSION,
  ASSET_FILE_EXTENSIONS,
  ASSET_IMAGE_EXTENSIONS,
  ASSET_VIDEO_EXTENSIONS,
  isAssetExtension,
  isImageExtension,
  isVideoExtension,
  mimeForAssetExtension,
  allowsVideo,
  isMediaAllowed,
} from './asset-types';
import { AUDIO_MIME_BY_EXTENSION } from './audio-names';
import { ASSET_TYPES } from './types';

describe('ASSET_TYPES', () => {
  it('v1 恰好三个类型', () => {
    expect(ASSET_TYPES).toEqual(['头像', '立绘', '立绘bg']);
  });
});

describe('categoryForType', () => {
  it('三个类型都是 character（v1 只有角色美术）', () => {
    for (const type of ASSET_TYPES) {
      expect(categoryForType(type)).toBe('character');
    }
  });
});

describe('isAssetTypeToken', () => {
  it('三个 token 整段命中', () => {
    expect(isAssetTypeToken('头像')).toBe(true);
    expect(isAssetTypeToken('立绘')).toBe(true);
    expect(isAssetTypeToken('立绘bg')).toBe(true);
  });

  it('🔴 绝不子串匹配 —— 含 token 的更长 segment 不算命中', () => {
    // 这条是整个解析器的地基: 若用 includes，`立绘bg` 会被当成 `立绘`+`bg`
    expect(isAssetTypeToken('立绘bg2')).toBe(false);
    expect(isAssetTypeToken('大头像')).toBe(false);
    expect(isAssetTypeToken('头像图')).toBe(false);
    expect(isAssetTypeToken('半身立绘')).toBe(false);
  });

  it('不 trim、不折叠大小写（D2 素材名不做归一化）', () => {
    expect(isAssetTypeToken(' 头像')).toBe(false);
    expect(isAssetTypeToken('头像 ')).toBe(false);
    expect(isAssetTypeToken('立绘BG')).toBe(false);
  });

  it('空串与任意噪音都不是 token', () => {
    expect(isAssetTypeToken('')).toBe(false);
    expect(isAssetTypeToken('微笑')).toBe(false);
    expect(isAssetTypeToken('IMG')).toBe(false);
  });
});

describe('ASSET_MIME_BY_EXTENSION', () => {
  it('图片七种，MIME 对得上', () => {
    expect(ASSET_MIME_BY_EXTENSION.png).toBe('image/png');
    expect(ASSET_MIME_BY_EXTENSION.jpg).toBe('image/jpeg');
    expect(ASSET_MIME_BY_EXTENSION.jpeg).toBe('image/jpeg');
    expect(ASSET_MIME_BY_EXTENSION.jpe).toBe('image/jpeg');
    expect(ASSET_MIME_BY_EXTENSION.webp).toBe('image/webp');
    expect(ASSET_MIME_BY_EXTENSION.avif).toBe('image/avif');
    expect(ASSET_MIME_BY_EXTENSION.gif).toBe('image/gif');
    expect(ASSET_IMAGE_EXTENSIONS).toHaveLength(7);
  });

  it('视频只有 mp4', () => {
    expect(ASSET_VIDEO_EXTENSIONS).toEqual(['mp4']);
    expect(ASSET_MIME_BY_EXTENSION.mp4).toBe('video/mp4');
  });

  it('不含 svg（能带脚本的文档格式，§2.4 排除）', () => {
    expect(ASSET_MIME_BY_EXTENSION.svg).toBeUndefined();
    expect(isAssetExtension('svg')).toBe(false);
  });

  it('不含 webm —— 它归音频，改判是回退 (D8)', () => {
    expect(ASSET_MIME_BY_EXTENSION.webm).toBeUndefined();
    expect(isAssetExtension('webm')).toBe(false);
    // 真的还在音频表里（这条断言在有人手滑搬走 webm 时会响）
    expect(AUDIO_MIME_BY_EXTENSION.webm).toBe('audio/webm');
  });

  it('与音频扩展名表**零交集** —— 否则 zip 按扩展名路由会二义 (§5.1)', () => {
    const audio = new Set(Object.keys(AUDIO_MIME_BY_EXTENSION));
    const overlap = ASSET_FILE_EXTENSIONS.filter((ext) => audio.has(ext));
    expect(overlap).toEqual([]);
  });

  it('ASSET_FILE_EXTENSIONS = 图片 + 视频', () => {
    expect([...ASSET_FILE_EXTENSIONS].sort()).toEqual(
      [...ASSET_IMAGE_EXTENSIONS, ...ASSET_VIDEO_EXTENSIONS].sort(),
    );
  });
});

describe('扩展名分类与查表', () => {
  it('大小写与前导点都认', () => {
    expect(isAssetExtension('PNG')).toBe(true);
    expect(isAssetExtension('.png')).toBe(true);
    expect(isAssetExtension(' .PNG ')).toBe(true);
    expect(mimeForAssetExtension('.MP4')).toBe('video/mp4');
  });

  it('图片 / 视频互斥', () => {
    expect(isImageExtension('png')).toBe(true);
    expect(isVideoExtension('png')).toBe(false);
    expect(isVideoExtension('mp4')).toBe(true);
    expect(isImageExtension('mp4')).toBe(false);
  });

  it('不认识的扩展名给 undefined，不给兜底 MIME', () => {
    expect(mimeForAssetExtension('txt')).toBeUndefined();
    expect(mimeForAssetExtension('')).toBeUndefined();
    expect(isAssetExtension('txt')).toBe(false);
    expect(isAssetExtension('')).toBe(false);
  });
});

describe('allowsVideo (D7)', () => {
  it('头像 允许 —— 圆形裁切，什么都不合成，不需要 alpha', () => {
    expect(allowsVideo('头像')).toBe(true);
  });

  it('立绘bg 允许 —— 整幅铺满', () => {
    expect(allowsVideo('立绘bg')).toBe(true);
  });

  it('立绘 拒绝 —— 抠像立牌需要合成 alpha，mp4 没有', () => {
    expect(allowsVideo('立绘')).toBe(false);
  });
});

describe('isMediaAllowed', () => {
  it('图片对三个类型都合法', () => {
    for (const type of ASSET_TYPES) {
      expect(isMediaAllowed(type, 'png')).toBe(true);
      expect(isMediaAllowed(type, 'webp')).toBe(true);
    }
  });

  it('mp4 只在 头像 / 立绘bg 上合法', () => {
    expect(isMediaAllowed('头像', 'mp4')).toBe(true);
    expect(isMediaAllowed('立绘bg', 'mp4')).toBe(true);
    expect(isMediaAllowed('立绘', 'mp4')).toBe(false);
  });

  it('未知扩展名一律不合法，与类型无关', () => {
    for (const type of ASSET_TYPES) {
      expect(isMediaAllowed(type, 'svg')).toBe(false);
      expect(isMediaAllowed(type, 'webm')).toBe(false);
    }
  });
});
