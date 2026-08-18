/**
 * asset-filename.test.ts — 文件名约定 <name>[_<type>][_<variant>].<ext>
 *
 * 覆盖:
 * 1. 设计 §2 的逐行样例（含每一条 null 的理由）
 * 2. 右锚定: 名字自己带下划线仍能正确切分
 * 3. 整段匹配: `立绘bg` 不被切成 `立绘` + `bg`
 * 4. 命名不变式 D16 —— `苏婉_头像_立绘.png` 必须拒
 * 5. 媒体规则 D7 —— mp4 落在 立绘 上必须拒
 * 6. ★ 往返性质: parse(format(row)) === row，跑遍生成的行空间。
 *    这是整条不变式存在的唯一目的，也是本文件最重要的一个 it。
 */

import { describe, it, expect } from 'vitest';
import {
  parseAssetFilename,
  explainAssetFilename,
  formatAssetFilename,
  violatesNamingInvariant,
  violatesZipEntryName,
  DEFAULT_ASSET_TYPE,
  type ParsedAssetName,
} from './asset-filename';
import { isMediaAllowed } from './asset-types';
import { ASSET_TYPES, type AssetType } from './types';

// ═══════════════════════════════════════════════════════════
// 设计 §2 的样例表 —— 每行一条断言
// ═══════════════════════════════════════════════════════════

describe('parseAssetFilename — 合法样例', () => {
  it('苏婉.png → 名字 苏婉, 类型缺省 头像, 无变体（零仪式路径）', () => {
    expect(parseAssetFilename('苏婉.png')).toEqual({ name: '苏婉', type: '头像', ext: 'png' });
  });

  it('苏婉_头像.png → 与上一行同一行，只是显式写了类型', () => {
    expect(parseAssetFilename('苏婉_头像.png')).toEqual({ name: '苏婉', type: '头像', ext: 'png' });
  });

  it('苏婉_立绘_微笑.png → 变体 微笑', () => {
    expect(parseAssetFilename('苏婉_立绘_微笑.png')).toEqual({
      name: '苏婉',
      type: '立绘',
      variant: '微笑',
      ext: 'png',
    });
  });

  it('圣殿_内庭_头像.png → 名字 圣殿_内庭（右锚定的价值就在这一行）', () => {
    expect(parseAssetFilename('圣殿_内庭_头像.png')).toEqual({
      name: '圣殿_内庭',
      type: '头像',
      ext: 'png',
    });
  });

  it('苏婉_微笑.png → 名字 苏婉_微笑（漏写类型的幽灵分组，合法，必须能解析）', () => {
    expect(parseAssetFilename('苏婉_微笑.png')).toEqual({
      name: '苏婉_微笑',
      type: '头像',
      ext: 'png',
    });
  });

  it('苏婉_头像.mp4 → 合法（圆形裁切，不需要 alpha）', () => {
    expect(parseAssetFilename('苏婉_头像.mp4')).toEqual({ name: '苏婉', type: '头像', ext: 'mp4' });
  });

  it('苏婉_立绘bg.mp4 → 合法（整幅铺满）', () => {
    expect(parseAssetFilename('苏婉_立绘bg.mp4')).toEqual({
      name: '苏婉',
      type: '立绘bg',
      ext: 'mp4',
    });
  });

  it('苏婉_立绘bg_微笑.png → 证明是整段匹配而非子串（否则会切成 立绘 + bg_微笑）', () => {
    expect(parseAssetFilename('苏婉_立绘bg_微笑.png')).toEqual({
      name: '苏婉',
      type: '立绘bg',
      variant: '微笑',
      ext: 'png',
    });
  });

  it('IMG_20240101.png → 名字 IMG_20240101（垃圾但合法，D1 接受的后果）', () => {
    expect(parseAssetFilename('IMG_20240101.png')).toEqual({
      name: 'IMG_20240101',
      type: '头像',
      ext: 'png',
    });
  });
});

describe('parseAssetFilename — 拒收样例', () => {
  it('🔴 苏婉_头像_立绘.png → null（名字会含类型 token，D16；§2.3 就是为拦这一行存在的）', () => {
    expect(parseAssetFilename('苏婉_头像_立绘.png')).toBeNull();
    expect(explainAssetFilename('苏婉_头像_立绘.png')).toEqual({
      ok: false,
      reason: 'naming-invariant',
    });
  });

  it('头像.png → null（名字会是一个裸类型 token）', () => {
    expect(parseAssetFilename('头像.png')).toBeNull();
    expect(explainAssetFilename('头像.png')).toEqual({ ok: false, reason: 'naming-invariant' });
  });

  it('苏婉_立绘.mp4 → null（立绘 是抠像，需要 alpha，mp4 没有）', () => {
    expect(parseAssetFilename('苏婉_立绘.mp4')).toBeNull();
    expect(explainAssetFilename('苏婉_立绘.mp4')).toEqual({ ok: false, reason: 'mp4-on-立绘' });
  });

  it('.png → null（剥完扩展名就空了，那不是任何人的意思）', () => {
    expect(parseAssetFilename('.png')).toBeNull();
    expect(explainAssetFilename('.png')).toEqual({ ok: false, reason: 'unknown-extension' });
  });

  it('苏婉.txt → null（不在路由表里）', () => {
    expect(parseAssetFilename('苏婉.txt')).toBeNull();
    expect(explainAssetFilename('苏婉.txt')).toEqual({ ok: false, reason: 'unknown-extension' });
  });

  it('苏婉.svg → null（§2.4 刻意排除）', () => {
    expect(parseAssetFilename('苏婉.svg')).toBeNull();
  });

  it('苏婉.webm → null（webm 归音频，不该被素材路由抢走）', () => {
    expect(parseAssetFilename('苏婉.webm')).toBeNull();
    expect(explainAssetFilename('苏婉.webm')).toEqual({ ok: false, reason: 'unknown-extension' });
  });

  it('压根没有扩展名 → null', () => {
    expect(parseAssetFilename('苏婉')).toBeNull();
    expect(parseAssetFilename('')).toBeNull();
  });

  it('_头像.png → null（名字为空）', () => {
    expect(parseAssetFilename('_头像.png')).toBeNull();
  });

  it('变体位含类型 token 也拒 —— 苏婉_立绘_头像.png（右锚定后名字会含 立绘）', () => {
    expect(explainAssetFilename('苏婉_立绘_头像.png')).toEqual({
      ok: false,
      reason: 'naming-invariant',
    });
  });
});

describe('parseAssetFilename — 边角', () => {
  it('扩展名大小写归一到小写落库', () => {
    expect(parseAssetFilename('苏婉.PNG')?.ext).toBe('png');
    expect(parseAssetFilename('苏婉_头像.MP4')?.ext).toBe('mp4');
  });

  it('名字中间的点原样保留，只剥真正的尾缀', () => {
    expect(parseAssetFilename('苏婉 v1.2.png')).toEqual({
      name: '苏婉 v1.2',
      type: '头像',
      ext: 'png',
    });
  });

  it('空尾巴当作无变体（苏婉_头像_.png）', () => {
    expect(parseAssetFilename('苏婉_头像_.png')).toEqual({
      name: '苏婉',
      type: '头像',
      ext: 'png',
    });
  });

  it('缺省类型就是 头像', () => {
    expect(DEFAULT_ASSET_TYPE).toBe('头像');
    expect(parseAssetFilename('随便.png')?.type).toBe(DEFAULT_ASSET_TYPE);
  });
});

// ═══════════════════════════════════════════════════════════
// 不变式检查器
// ═══════════════════════════════════════════════════════════

describe('violatesNamingInvariant', () => {
  it('干净的名字与变体放行', () => {
    expect(violatesNamingInvariant('苏婉')).toBe(false);
    expect(violatesNamingInvariant('圣殿_内庭', '微笑')).toBe(false);
    expect(violatesNamingInvariant('苏婉', undefined)).toBe(false);
    expect(violatesNamingInvariant('苏婉', '')).toBe(false);
  });

  it('名字任一段等于类型 token → 违反', () => {
    expect(violatesNamingInvariant('头像')).toBe(true);
    expect(violatesNamingInvariant('苏婉_头像')).toBe(true);
    expect(violatesNamingInvariant('立绘bg_苏婉')).toBe(true);
    expect(violatesNamingInvariant('a_立绘_b')).toBe(true);
  });

  it('变体任一段等于类型 token → 违反（这是 D14 改名要拦的那半）', () => {
    expect(violatesNamingInvariant('苏婉', '立绘')).toBe(true);
    expect(violatesNamingInvariant('苏婉', '微笑_头像')).toBe(true);
    expect(violatesNamingInvariant('苏婉', '立绘bg')).toBe(true);
  });

  it('只是**含有** token 的更长段不算违反', () => {
    expect(violatesNamingInvariant('大头像')).toBe(false);
    expect(violatesNamingInvariant('苏婉', '立绘bg2')).toBe(false);
    expect(violatesNamingInvariant('半身立绘照')).toBe(false);
  });
});

describe('violatesZipEntryName（D19 —— 名字能不能活在 zip 条目名里）', () => {
  it('正常名字/变体放行；空白照原样留着（D2）', () => {
    expect(violatesZipEntryName('苏婉')).toBe(false);
    expect(violatesZipEntryName('圣殿_内庭', '微笑')).toBe(false);
    expect(violatesZipEntryName(' 苏婉 ')).toBe(false);
    expect(violatesZipEntryName('苏婉', '')).toBe(false);
    expect(violatesZipEntryName('苏婉.png')).toBe(false); // 点不在开头，无害
  });

  it('分隔符会在包里变成目录 → 名字与变体都要拦', () => {
    expect(violatesZipEntryName('圣殿/内庭')).toBe(true);
    expect(violatesZipEntryName('圣殿\\内庭')).toBe(true);
    expect(violatesZipEntryName('苏婉', 'a/b')).toBe(true);
    expect(violatesZipEntryName('苏婉', 'a\\b')).toBe(true);
  });

  it('名字开头的点会被导入侧当 dotfile 丢掉；变体开头的点无害', () => {
    expect(violatesZipEntryName('.隐藏')).toBe(true);
    expect(violatesZipEntryName('苏婉', '.微笑')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 格式化
// ═══════════════════════════════════════════════════════════

describe('formatAssetFilename', () => {
  it('类型总是显式写出，即便是缺省的 头像（往返的前提）', () => {
    expect(formatAssetFilename({ name: '苏婉', type: '头像', ext: 'png' })).toBe('苏婉_头像.png');
  });

  it('带变体', () => {
    expect(formatAssetFilename({ name: '苏婉', type: '立绘', variant: '微笑', ext: 'png' })).toBe(
      '苏婉_立绘_微笑.png',
    );
  });

  it('名字带下划线原样拼回', () => {
    expect(formatAssetFilename({ name: '圣殿_内庭', type: '头像', ext: 'png' })).toBe(
      '圣殿_内庭_头像.png',
    );
  });

  it('空串变体视为缺省', () => {
    expect(formatAssetFilename({ name: '苏婉', type: '头像', variant: '', ext: 'png' })).toBe(
      '苏婉_头像.png',
    );
  });

  it('扩展名归一到小写', () => {
    expect(formatAssetFilename({ name: '苏婉', type: '头像', ext: 'PNG' })).toBe('苏婉_头像.png');
  });
});

// ═══════════════════════════════════════════════════════════
// ★ 往返性质: parse(format(row)) === row
// ═══════════════════════════════════════════════════════════

/**
 * 行空间: 名字（带/不带下划线、带空格、含 token 子串的近似词）
 *       × 三个类型
 *       × 变体（无/普通/带下划线/带空格/首尾下划线/纯数字，即 D11 的编号）
 *       × 扩展名（图片 + 视频）
 *
 * 所有名字与变体都**满足不变式** —— 违反不变式的行本来就进不了库
 * （导入与改名两处都拦），拿它们测往返是测错了对象。
 */
const NAMES = [
  '苏婉',
  '圣殿_内庭',
  'IMG_20240101',
  'a',
  '苏 婉',
  '苏婉_微笑',
  '大头像',
  '立绘bg2',
  '苏婉 v1.2',
  '苏婉_',
];

const VARIANTS: (string | undefined)[] = [
  undefined,
  '微笑',
  '2',
  'a_b',
  '含 空格',
  '_lead',
  'trail_',
  '立绘bg2',
];

const EXTS = ['png', 'jpg', 'jpeg', 'jpe', 'webp', 'avif', 'gif', 'mp4'];

function buildRows(): ParsedAssetName[] {
  const rows: ParsedAssetName[] = [];
  for (const name of NAMES) {
    for (const type of ASSET_TYPES) {
      for (const variant of VARIANTS) {
        for (const ext of EXTS) {
          rows.push(variant === undefined ? { name, type, ext } : { name, type, variant, ext });
        }
      }
    }
  }
  return rows;
}

describe('★ 往返: parse(format(row)) === row', () => {
  const rows = buildRows();

  it('行空间足够大（生成没有被意外掐断）', () => {
    expect(rows.length).toBe(NAMES.length * ASSET_TYPES.length * VARIANTS.length * EXTS.length);
    expect(rows.length).toBeGreaterThan(500);
  });

  it('每一行 format 再 parse 都回到自己（媒体规则合法的行）', () => {
    const legal = rows.filter((row) => isMediaAllowed(row.type, row.ext));
    // 空集会让下面的循环变成恒真断言 —— 先钉住样本非空
    expect(legal.length).toBeGreaterThan(500);

    for (const row of legal) {
      const filename = formatAssetFilename(row);
      const parsed = parseAssetFilename(filename);
      expect(parsed, `往返失败: ${JSON.stringify(row)} → ${filename}`).toEqual(row);
    }
  });

  it('mp4 落在 立绘 上的行 format 后一定解析失败（不是往返漏洞，是媒体规则）', () => {
    const illegal = rows.filter((row) => !isMediaAllowed(row.type, row.ext));
    expect(illegal.length).toBeGreaterThan(0);
    // 这批行全是 (立绘, mp4)
    expect(illegal.every((row) => row.type === '立绘' && row.ext === 'mp4')).toBe(true);

    for (const row of illegal) {
      expect(explainAssetFilename(formatAssetFilename(row))).toEqual({
        ok: false,
        reason: 'mp4-on-立绘',
      });
    }
  });

  it('格式化出来的文件名里**恰好一个**类型 token —— 往返成立的那一行证明', () => {
    for (const row of buildRows()) {
      const stem = formatAssetFilename(row).replace(/\.[^.]+$/, '');
      const hits = stem
        .split('_')
        .filter((seg) => (ASSET_TYPES as readonly string[]).includes(seg));
      expect(hits, `token 数不为 1: ${stem}`).toHaveLength(1);
    }
  });

  it('反向往返: 合法文件名 parse 再 format 得到等价文件名（类型显式化后稳定）', () => {
    const filenames = ['苏婉.png', '苏婉_头像.png', '苏婉_立绘_微笑.png', '圣殿_内庭_头像.png'];
    for (const filename of filenames) {
      const parsed = parseAssetFilename(filename) as ParsedAssetName;
      expect(parsed).not.toBeNull();
      const once = formatAssetFilename(parsed);
      // 第一次 format 可能改写文件名（补上缺省类型），第二次起必须稳定
      expect(formatAssetFilename(parseAssetFilename(once) as ParsedAssetName)).toBe(once);
    }
  });
});

describe('★ 往返: 每个类型都被真正走到（防止类型维度空转）', () => {
  it('三个类型各有至少一条合法往返样本', () => {
    const seen = new Set<AssetType>();
    for (const row of buildRows()) {
      if (!isMediaAllowed(row.type, row.ext)) continue;
      const parsed = parseAssetFilename(formatAssetFilename(row));
      if (parsed && parsed.type === row.type) seen.add(row.type);
    }
    expect([...seen].sort()).toEqual([...ASSET_TYPES].sort());
  });
});
