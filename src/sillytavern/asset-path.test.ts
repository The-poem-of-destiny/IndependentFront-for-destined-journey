/**
 * asset-path 专项测试（Q-16）
 *
 * 两个真机案例直接来自被抽取那两份实现的注释：
 *   · Windows 工具写反斜杠分隔符
 *   · `"苏婉_头像.png "` —— 字面扩展名是 `"png "`，直接查表查不着，
 *     zip 侧曾因此把一张合法 png 整条当噪音丢掉
 */
import { describe, it, expect } from 'vitest';
import {
  basenameOf,
  extensionOf,
  normalizeExtension,
  normalizeSlashes,
  normalizedExtensionOf,
} from './asset-path';

describe('normalizeSlashes', () => {
  it('反斜杠分隔符归一化（部分 Windows 工具会这么写）', () => {
    expect(normalizeSlashes('assets\\portrait\\苏婉.png')).toBe('assets/portrait/苏婉.png');
  });

  it('混合分隔符与正斜杠原样都吃', () => {
    expect(normalizeSlashes('a/b\\c/d.png')).toBe('a/b/c/d.png');
    expect(normalizeSlashes('a/b.png')).toBe('a/b.png');
  });

  it('null / undefined 当空串（引擎侧的兜底，抽取时保留）', () => {
    expect(normalizeSlashes(undefined as unknown as string)).toBe('');
    expect(normalizeSlashes(null as unknown as string)).toBe('');
  });
});

describe('basenameOf', () => {
  it('拍平嵌套目录，两种分隔符都认', () => {
    expect(basenameOf('assets/portrait/苏婉.png')).toBe('苏婉.png');
    expect(basenameOf('assets\\portrait\\苏婉.png')).toBe('苏婉.png');
  });

  it('没有目录时原样返回；纯目录路径返回空串', () => {
    expect(basenameOf('苏婉.png')).toBe('苏婉.png');
    expect(basenameOf('assets/portrait/')).toBe('');
  });
});

describe('extensionOf —— 原样，不归一化', () => {
  it('保留大小写与尾部空白（归一化推迟给调用点显式表达）', () => {
    expect(extensionOf('苏婉_头像.PNG')).toBe('PNG');
    expect(extensionOf('苏婉_头像.png ')).toBe('png ');
  });

  it('取最后一个点之后的部分', () => {
    expect(extensionOf('a.tar.gz')).toBe('gz');
  });

  it('dotfile 不算有扩展名（dot > 0 而非 >= 0）', () => {
    expect(extensionOf('.png')).toBe('');
    expect(extensionOf('无扩展名')).toBe('');
  });
});

describe('normalizedExtensionOf —— 归一化，但名字本身绝不动', () => {
  it('🔴 真机案例：`"苏婉_头像.png "` 的尾部空白不许让它被当噪音丢掉', () => {
    expect(normalizedExtensionOf('苏婉_头像.png ')).toBe('png');
    // 名字那一半原样保留（D2：名字里的空白是用户的，不许替他 trim）
    expect(basenameOf('assets/苏婉_头像.png ')).toBe('苏婉_头像.png ');
  });

  it('大小写归一', () => {
    expect(normalizedExtensionOf('立绘.JPEG')).toBe('jpeg');
    expect(normalizedExtensionOf('立绘.Mp4')).toBe('mp4');
  });

  it('无扩展名返回空串', () => {
    expect(normalizedExtensionOf('无扩展名')).toBe('');
    expect(normalizedExtensionOf('.gitignore')).toBe('');
  });
});

describe('normalizeExtension —— 直接归一化一个扩展名字符串', () => {
  it('去前导点 + trim + 小写', () => {
    expect(normalizeExtension('.PNG')).toBe('png');
    expect(normalizeExtension('  webp  ')).toBe('webp');
    expect(normalizeExtension(' .JPG ')).toBe('jpg');
  });

  it('null / undefined 当空串', () => {
    expect(normalizeExtension(undefined as unknown as string)).toBe('');
  });
});
