/**
 * dev-content-source.test.ts — 开发期内容源解析器
 *
 * 纯函数层：偏好 × 本地目录是否配置 × 已安装包（无 / 受保护 / 非保护）全组合，
 * 以及注入假存储的读写（含非法值与抛错存储），不做任何全局打桩。
 */

import { describe, it, expect } from 'vitest';
import {
  DEV_CONTENT_SOURCE_KEY,
  describeDevContentNotices,
  readDevContentSourcePreference,
  resolveDevContentSource,
  writeDevContentSourcePreference,
  type DevContentNotice,
  type DevContentSourcePreference,
  type DevInstalledPackInfo,
} from '../../../src/ui/lib/dev-content-source';

const PROTECTED_PACK: DevInstalledPackInfo = {
  packId: 'official',
  packVersion: '1.2.0',
  protected: true,
};
const PLAIN_PACK: DevInstalledPackInfo = {
  packId: 'local-file',
  packVersion: '0.3.1',
  protected: false,
};

type PackCase = 'none' | 'protected' | 'plain';
const PACKS: Record<PackCase, DevInstalledPackInfo | null> = {
  none: null,
  protected: PROTECTED_PACK,
  plain: PLAIN_PACK,
};

interface Expectation {
  suppressPack: boolean;
  notices: DevContentNotice[];
}

const MATRIX: Array<[DevContentSourcePreference, boolean, PackCase, Expectation]> = [
  ['pack', true, 'none', { suppressPack: false, notices: ['pack-missing'] }],
  ['pack', true, 'protected', { suppressPack: false, notices: [] }],
  ['pack', true, 'plain', { suppressPack: false, notices: [] }],
  ['pack', false, 'none', { suppressPack: false, notices: ['pack-missing'] }],
  ['pack', false, 'protected', { suppressPack: false, notices: [] }],
  ['pack', false, 'plain', { suppressPack: false, notices: [] }],
  ['local', true, 'none', { suppressPack: false, notices: [] }],
  ['local', true, 'protected', { suppressPack: true, notices: [] }],
  ['local', true, 'plain', { suppressPack: true, notices: ['local-file-pack-materialized'] }],
  ['local', false, 'none', { suppressPack: false, notices: ['local-dir-missing'] }],
  ['local', false, 'protected', { suppressPack: true, notices: ['local-dir-missing'] }],
  [
    'local',
    false,
    'plain',
    { suppressPack: true, notices: ['local-dir-missing', 'local-file-pack-materialized'] },
  ],
];

describe('resolveDevContentSource 全组合', () => {
  it.each(MATRIX)(
    '偏好=%s 本地目录已配置=%s 已安装包=%s',
    (preference, localDirConfigured, packCase, expected) => {
      const installedPack = PACKS[packCase];
      const result = resolveDevContentSource({ preference, localDirConfigured, installedPack });

      expect(result.preference).toBe(preference);
      expect(result.suppressPack).toBe(expected.suppressPack);
      expect(result.notices).toEqual(expected.notices);
      expect(result.suppressedPack).toEqual(
        expected.suppressPack && installedPack
          ? { packId: installedPack.packId, packVersion: installedPack.packVersion }
          : null,
      );
    },
  );

  it('suppressedPack 只带身份字段，不泄漏 protected 标记', () => {
    const result = resolveDevContentSource({
      preference: 'local',
      localDirConfigured: true,
      installedPack: PROTECTED_PACK,
    });
    expect(result.suppressedPack).toStrictEqual({ packId: 'official', packVersion: '1.2.0' });
  });
});

describe('describeDevContentNotices', () => {
  it('每种提示都有非空的中文文案，且保持顺序', () => {
    const all: DevContentNotice[] = [
      'local-dir-missing',
      'pack-missing',
      'local-file-pack-materialized',
    ];
    const texts = describeDevContentNotices(all);
    expect(texts).toHaveLength(3);
    for (const text of texts) expect(text).toMatch(/[一-鿿]/);
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toContain('POEM_CONTENT_DIR');
  });

  it('空提示返回空数组', () => {
    expect(describeDevContentNotices([])).toEqual([]);
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

const throwingStorage = {
  getItem: (): string | null => {
    throw new Error('SecurityError');
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError');
  },
};

describe('偏好读写', () => {
  it('键名遵循 poem_*_v1 约定', () => {
    expect(DEV_CONTENT_SOURCE_KEY).toBe('poem_dev_content_source_v1');
  });

  it('缺失时回落 pack', () => {
    expect(readDevContentSourcePreference(fakeStorage())).toBe('pack');
  });

  it('非法值回落 pack', () => {
    expect(readDevContentSourcePreference(fakeStorage({ [DEV_CONTENT_SOURCE_KEY]: 'LOCAL' }))).toBe(
      'pack',
    );
    expect(readDevContentSourcePreference(fakeStorage({ [DEV_CONTENT_SOURCE_KEY]: '' }))).toBe(
      'pack',
    );
  });

  it('存储抛错时读回落 pack、写静默忽略', () => {
    expect(readDevContentSourcePreference(throwingStorage)).toBe('pack');
    expect(() => writeDevContentSourcePreference('local', throwingStorage)).not.toThrow();
  });

  it('写入后能读回', () => {
    const storage = fakeStorage();
    writeDevContentSourcePreference('local', storage);
    expect(storage.data.get(DEV_CONTENT_SOURCE_KEY)).toBe('local');
    expect(readDevContentSourcePreference(storage)).toBe('local');
    writeDevContentSourcePreference('pack', storage);
    expect(readDevContentSourcePreference(storage)).toBe('pack');
  });
});
