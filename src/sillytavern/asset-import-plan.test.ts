/**
 * asset-import-plan.test.ts — 导入计划器的规则钉子 (Asset System v1)
 *
 * 这是全项目**测试密度最高**的模块（§9）: 计划器是一个纯同步函数，所以设计文档
 * 里每一条决策都能变成对普通数据的断言 —— 没有 IndexedDB、没有 fflate、没有
 * crypto。一条规则一个 it，表格的每一行都在这儿有钉子。
 */

import { describe, expect, it } from 'vitest';
import { allocateVariantSlot, planImport } from './asset-import-plan';
import type { DecodedEntry, ExistingRows, ImportManifest } from './asset-import-plan';
import type { AssetType } from './types';

// ═══════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════

/** 字节内容与断言无关（计划器不看字节），固定一个共享实例即可 */
const BYTES = new Uint8Array([1, 2, 3]);

function entry(path: string, hash?: string): DecodedEntry {
  return hash === undefined ? { path, bytes: BYTES } : { path, bytes: BYTES, hash };
}

function noRows(): ExistingRows {
  return { assets: [], audio: [] };
}

let idSeq = 0;
function assetRow(
  name: string,
  type: AssetType,
  variant?: string,
  hash?: string,
): ExistingRows['assets'][number] {
  idSeq += 1;
  const row: ExistingRows['assets'][number] = { id: `a${idSeq}`, name, type };
  if (variant !== undefined) row.variant = variant;
  if (hash !== undefined) row.hash = hash;
  return row;
}

function audioRow(name: string, hash?: string): ExistingRows['audio'][number] {
  idSeq += 1;
  const row: ExistingRows['audio'][number] = { id: `t${idSeq}`, name, source: 'blob' };
  if (hash !== undefined) row.hash = hash;
  return row;
}

/** 只取断言关心的三元组，读起来比整行 diff 清楚 */
function slots(plan: ReturnType<typeof planImport>): { name: string; type: string; variant?: string }[] {
  return plan.assets.map((a) => ({ name: a.name, type: a.type, variant: a.variant }));
}

// ═══════════════════════════════════════════════════════════
// §5.1 路由
// ═══════════════════════════════════════════════════════════

describe('路由 (§5.1)', () => {
  it('图片扩展名全部落素材，MIME 取自引擎唯一来源', () => {
    const exts = ['png', 'jpg', 'jpeg', 'jpe', 'webp', 'avif', 'gif'];
    const plan = planImport(
      exts.map((ext, i) => entry(`角色${i}_头像.${ext}`)),
      noRows(),
    );
    expect(plan.assets).toHaveLength(exts.length);
    expect(plan.audio).toHaveLength(0);
    expect(plan.assets.map((a) => a.mime)).toEqual([
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/jpeg',
      'image/webp',
      'image/avif',
      'image/gif',
    ]);
  });

  it('mp4 落素材（视频）', () => {
    const plan = planImport([entry('苏婉_头像.mp4')], noRows());
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0].mime).toBe('video/mp4');
  });

  it('音频扩展名全部落音频', () => {
    const exts = ['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac', 'flac', 'opus'];
    const plan = planImport(
      exts.map((ext, i) => entry(`曲${i}.${ext}`)),
      noRows(),
    );
    expect(plan.audio).toHaveLength(exts.length);
    expect(plan.assets).toHaveLength(0);
  });

  it('🔴 webm 是音频，不是素材（D8）—— 改判即回退', () => {
    const plan = planImport([entry('战斗主题.webm')], noRows());
    expect(plan.assets).toHaveLength(0);
    expect(plan.audio).toHaveLength(1);
    expect(plan.audio[0].mime).toBe('audio/webm');
    expect(plan.audio[0].name).toBe('战斗主题');
  });

  it('目录结构被拍平，与平铺的包表现一致', () => {
    const nested = planImport(
      [entry('assets/角色/苏婉_头像.png'), entry('audio\\bgm\\战斗.mp3')],
      noRows(),
    );
    const flat = planImport([entry('苏婉_头像.png'), entry('战斗.mp3')], noRows());
    expect(slots(nested)).toEqual(slots(flat));
    expect(nested.audio.map((a) => a.name)).toEqual(flat.audio.map((a) => a.name));
  });

  it('不认识的扩展名 → unknown-extension', () => {
    const plan = planImport(
      [entry('源文件.psd'), entry('说明.pdf'), entry('图标.svg'), entry('没有扩展名')],
      noRows(),
    );
    expect(plan.skips.map((s) => s.reason)).toEqual([
      'unknown-extension',
      'unknown-extension',
      'unknown-extension',
      'unknown-extension',
    ]);
    expect(plan.summary.assetsAdded).toBe(0);
  });

  it('svg 刻意被排除（§2.4：能带脚本的文档格式）', () => {
    const plan = planImport([entry('苏婉_头像.svg')], noRows());
    expect(plan.skips[0].reason).toBe('unknown-extension');
  });

  it('__MACOSX / dotfile / 目录条目 → noise', () => {
    const plan = planImport(
      [
        entry('__MACOSX/苏婉_头像.png'),
        entry('__MACOSX/._苏婉_头像.png'),
        entry('.DS_Store'),
        entry('assets/'),
      ],
      noRows(),
    );
    expect(plan.skips.map((s) => s.reason)).toEqual(['noise', 'noise', 'noise', 'noise']);
    expect(plan.summary.noise).toBe(4);
  });

  it('dotfile 只看 basename —— 隐藏目录下的正常媒体照样导入', () => {
    const plan = planImport([entry('.hidden/苏婉_头像.png')], noRows());
    expect(plan.assets).toHaveLength(1);
    expect(plan.skips).toHaveLength(0);
  });

  it('全是噪音的包 → 空计划 + 全部计入 noise', () => {
    const plan = planImport(
      [entry('__MACOSX/'), entry('.DS_Store'), entry('__MACOSX/._x.png')],
      noRows(),
    );
    expect(plan.assets).toHaveLength(0);
    expect(plan.audio).toHaveLength(0);
    expect(plan.summary).toEqual({
      assetsAdded: 0,
      audioAdded: 0,
      duplicatesSkipped: 0,
      renumbered: 0,
      namingConflicts: 0,
      noise: 3,
    });
  });

  it('空输入 → 空计划，不抛', () => {
    const plan = planImport([], noRows());
    expect(plan).toEqual({
      assets: [],
      audio: [],
      skips: [],
      warnings: [],
      summary: {
        assetsAdded: 0,
        audioAdded: 0,
        duplicatesSkipped: 0,
        renumbered: 0,
        namingConflicts: 0,
        noise: 0,
      },
    });
  });
});

// ═══════════════════════════════════════════════════════════
// §2.2 / D7 媒体规则
// ═══════════════════════════════════════════════════════════

describe('媒体规则 (D7)', () => {
  it('mp4 在 立绘 上被拒 —— 抠像立牌需要 alpha', () => {
    const plan = planImport([entry('苏婉_立绘.mp4')], noRows());
    expect(plan.assets).toHaveLength(0);
    expect(plan.skips).toEqual([{ kind: 'skip', path: '苏婉_立绘.mp4', reason: 'mp4-on-立绘' }]);
  });

  it('mp4 在 头像（圆形裁切）与 立绘bg（整幅铺满）上都允许', () => {
    const plan = planImport([entry('苏婉_头像.mp4'), entry('苏婉_立绘bg.mp4')], noRows());
    expect(plan.skips).toHaveLength(0);
    expect(plan.assets.map((a) => a.type)).toEqual(['头像', '立绘bg']);
  });

  it('立绘 上的图片（含 animated WebP 的扩展名）照常通过', () => {
    const plan = planImport([entry('苏婉_立绘.webp'), entry('苏婉_立绘_微笑.png')], noRows());
    expect(plan.assets).toHaveLength(2);
    expect(plan.skips).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// §2.3 / D16 命名不变式
// ═══════════════════════════════════════════════════════════

describe('命名不变式 (D16)', () => {
  it('name 里含类型 token → naming-invariant，计入 namingConflicts', () => {
    const plan = planImport([entry('苏婉_头像_立绘.png')], noRows());
    expect(plan.assets).toHaveLength(0);
    expect(plan.skips).toEqual([
      { kind: 'skip', path: '苏婉_头像_立绘.png', reason: 'naming-invariant' },
    ]);
    expect(plan.summary.namingConflicts).toBe(1);
  });

  it('名字为空（整串就是 token / 前导下划线）也归 naming-invariant', () => {
    const plan = planImport([entry('头像.png'), entry('_头像.png')], noRows());
    expect(plan.skips.map((s) => s.reason)).toEqual(['naming-invariant', 'naming-invariant']);
    expect(plan.summary.namingConflicts).toBe(2);
  });

  it('立绘bg 绝不被当成 立绘 + 变体 bg（整段相等，非子串）', () => {
    const plan = planImport([entry('苏婉_立绘bg.png')], noRows());
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '立绘bg', variant: undefined }]);
  });

  it('名字自己可以带下划线（右锚定保留）', () => {
    const plan = planImport([entry('圣殿_内庭_头像.png')], noRows());
    expect(slots(plan)).toEqual([{ name: '圣殿_内庭', type: '头像', variant: undefined }]);
  });

  it('类型 token 可省，缺省 头像（D1 零仪式路径）', () => {
    const plan = planImport([entry('苏婉.png')], noRows());
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '头像', variant: undefined }]);
  });
});

// ═══════════════════════════════════════════════════════════
// §5.3 / D11 碰撞编号 —— 分配表逐行
// ═══════════════════════════════════════════════════════════

describe('碰撞编号 (§5.3 分配表)', () => {
  it('base 位被占 → 号进变体位，名字一个字不动', () => {
    const plan = planImport([entry('苏婉_头像.png')], {
      assets: [assetRow('苏婉', '头像')],
      audio: [],
    });
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '头像', variant: '2' }]);
    expect(plan.assets[0].renumberedFrom).toBe('');
    expect(plan.summary.renumbered).toBe(1);
  });

  it('🔴 max+1 而不是首个空位 —— 中间行被删也不回收旧号', () => {
    // base、2、5 在库里；3 与 4 曾存在过又被删了
    const plan = planImport([entry('苏婉_头像.png')], {
      assets: [assetRow('苏婉', '头像'), assetRow('苏婉', '头像', '2'), assetRow('苏婉', '头像', '5')],
      audio: [],
    });
    expect(plan.assets[0].variant).toBe('6');
  });

  it('变体 微笑 被占 → 微笑 2', () => {
    const plan = planImport([entry('苏婉_头像_微笑.png')], {
      assets: [assetRow('苏婉', '头像', '微笑')],
      audio: [],
    });
    expect(plan.assets[0].variant).toBe('微笑 2');
    expect(plan.assets[0].renumberedFrom).toBe('微笑');
  });

  it('微笑 2 也被占 → 微笑 3（换号，绝不嵌套成 微笑 2 2）', () => {
    const plan = planImport([entry('苏婉_头像_微笑 2.png')], {
      assets: [assetRow('苏婉', '头像', '微笑'), assetRow('苏婉', '头像', '微笑 2')],
      audio: [],
    });
    expect(plan.assets[0].variant).toBe('微笑 3');
    expect(plan.assets[0].variant).not.toContain('2 2');
  });

  it('尾缀格式是单个空格 + 整数；base 行拿裸整数', () => {
    const plan = planImport([entry('苏婉_头像.png'), entry('苏婉_头像_微笑.png')], {
      assets: [assetRow('苏婉', '头像'), assetRow('苏婉', '头像', '微笑')],
      audio: [],
    });
    expect(plan.assets.map((a) => a.variant)).toEqual(['2', '微笑 2']);
  });

  it('用户手写的数字变体与自动分配的不可区分，max+1 照样对', () => {
    // 用户自己写了 `苏婉_头像_3.png`，库里只有它 —— 再来一张 base
    const plan = planImport([entry('苏婉_头像.png')], {
      assets: [assetRow('苏婉', '头像', '3')],
      audio: [],
    });
    // base 位空着 → 直接落 base，不编号
    expect(plan.assets[0].variant).toBeUndefined();
    const plan2 = planImport([entry('苏婉_头像_3.png')], {
      assets: [assetRow('苏婉', '头像'), assetRow('苏婉', '头像', '3')],
      audio: [],
    });
    expect(plan2.assets[0].variant).toBe('4');
  });

  it('编号作用域是 (name, type) —— 不同类型互不干扰', () => {
    const plan = planImport([entry('苏婉_立绘.png')], {
      assets: [assetRow('苏婉', '头像'), assetRow('苏婉', '头像', '2')],
      audio: [],
    });
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '立绘', variant: undefined }]);
  });

  it('永不覆盖: 库里已有的行不出现在计划里，计划只描述新增', () => {
    const plan = planImport([entry('苏婉_头像.png')], {
      assets: [assetRow('苏婉', '头像')],
      audio: [],
    });
    expect(plan.assets).toHaveLength(1);
    expect(plan.skips).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// §6.1 整批分配（不是逐条）
// ═══════════════════════════════════════════════════════════

describe('整批分配 (§6.1)', () => {
  it('两条撞车的条目拿 2 和 3，绝不都拿 2', () => {
    const plan = planImport([entry('苏婉_头像.png', 'h1'), entry('苏婉_头像.png', 'h2')], {
      assets: [assetRow('苏婉', '头像', undefined, 'h0')],
      audio: [],
    });
    expect(plan.assets.map((a) => a.variant)).toEqual(['2', '3']);
    expect(plan.summary.renumbered).toBe(2);
  });

  it('三条撞车拿 2 / 3 / 4', () => {
    const plan = planImport(
      [entry('苏婉_头像.png', 'h1'), entry('苏婉_头像.png', 'h2'), entry('苏婉_头像.png', 'h3')],
      { assets: [assetRow('苏婉', '头像', undefined, 'h0')], audio: [] },
    );
    expect(plan.assets.map((a) => a.variant)).toEqual(['2', '3', '4']);
  });

  it('空库里三条同名条目 → base / 2 / 3', () => {
    const plan = planImport(
      [entry('苏婉_头像.png', 'h1'), entry('苏婉_头像.png', 'h2'), entry('苏婉_头像.png', 'h3')],
      noRows(),
    );
    expect(plan.assets.map((a) => a.variant)).toEqual([undefined, '2', '3']);
  });

  it('同批内具名变体撞车也逐级换号', () => {
    const plan = planImport(
      [
        entry('苏婉_头像_微笑.png', 'h1'),
        entry('苏婉_头像_微笑.png', 'h2'),
        entry('苏婉_头像_微笑.png', 'h3'),
      ],
      noRows(),
    );
    expect(plan.assets.map((a) => a.variant)).toEqual(['微笑', '微笑 2', '微笑 3']);
  });

  it('音频同批撞名也逐个拿号（名字池随计划增长）', () => {
    const plan = planImport(
      [entry('战斗.mp3', 'h1'), entry('战斗.mp3', 'h2'), entry('战斗.mp3', 'h3')],
      noRows(),
    );
    expect(plan.audio.map((a) => a.name)).toEqual(['战斗', '战斗 (2)', '战斗 (3)']);
    expect(plan.audio.map((a) => a.renamedFrom)).toEqual([undefined, '战斗', '战斗']);
  });
});

// ═══════════════════════════════════════════════════════════
// §4.4 / D12 去重
// ═══════════════════════════════════════════════════════════

describe('去重 (§4.4 / D12)', () => {
  it('素材: 同 (name,type) 下哈希命中 → duplicate', () => {
    const plan = planImport([entry('苏婉_头像.png', 'HASH')], {
      assets: [assetRow('苏婉', '头像', undefined, 'HASH')],
      audio: [],
    });
    expect(plan.assets).toHaveLength(0);
    expect(plan.skips).toEqual([{ kind: 'skip', path: '苏婉_头像.png', reason: 'duplicate' }]);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('🔴 去重不是全局的 —— 同一张占位图给 30 个角色必须 30 次都成功', () => {
    const names = Array.from({ length: 30 }, (_, i) => `角色${i}`);
    const plan = planImport(
      names.map((n) => entry(`${n}_头像.png`, 'SAME')),
      noRows(),
    );
    expect(plan.assets).toHaveLength(30);
    expect(plan.summary.duplicatesSkipped).toBe(0);
  });

  it('同名不同类型也不算重复（作用域含 type）', () => {
    const plan = planImport([entry('苏婉_立绘.png', 'HASH')], {
      assets: [assetRow('苏婉', '头像', undefined, 'HASH')],
      audio: [],
    });
    expect(plan.assets).toHaveLength(1);
  });

  it('哈希不同则不算重复，走编号路径', () => {
    const plan = planImport([entry('苏婉_头像.png', 'OTHER')], {
      assets: [assetRow('苏婉', '头像', undefined, 'HASH')],
      audio: [],
    });
    expect(plan.assets[0].variant).toBe('2');
    expect(plan.summary.duplicatesSkipped).toBe(0);
  });

  it('同一包里两份字节相同的拷贝，第二份被去重', () => {
    const plan = planImport(
      [entry('a/苏婉_头像.png', 'SAME'), entry('b/苏婉_头像.png', 'SAME')],
      noRows(),
    );
    expect(plan.assets).toHaveLength(1);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('音频: 同规范名下哈希命中 → duplicate（不是可选项）', () => {
    const plan = planImport([entry('战斗主题.mp3', 'HASH')], {
      assets: [],
      audio: [audioRow('战斗主题', 'HASH')],
    });
    expect(plan.audio).toHaveLength(0);
    expect(plan.skips).toEqual([{ kind: 'skip', path: '战斗主题.mp3', reason: 'duplicate' }]);
  });

  it('音频去重用 normalizeAudioName 的口径（大小写/空白折叠）', () => {
    const plan = planImport([entry('Battle  Theme.mp3', 'HASH')], {
      assets: [],
      audio: [audioRow('battle theme', 'HASH')],
    });
    expect(plan.audio).toHaveLength(0);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('音频规范名不同 → 不去重，即便字节相同', () => {
    const plan = planImport([entry('别的曲子.mp3', 'HASH')], {
      assets: [],
      audio: [audioRow('战斗主题', 'HASH')],
    });
    expect(plan.audio).toHaveLength(1);
  });

  it('音频同名不同字节 → uniqueAudioName 出厂设置编号', () => {
    const plan = planImport([entry('战斗主题.mp3', 'OTHER')], {
      assets: [],
      audio: [audioRow('战斗主题', 'HASH')],
    });
    expect(plan.audio[0].name).toBe('战斗主题 (2)');
    expect(plan.audio[0].renamedFrom).toBe('战斗主题');
  });

  it('🔴 批内音频去重按 desired 名查 —— 先来者被改名不该让后来者漏网', () => {
    // 库里有一条**无哈希**的 song（老行从不回写哈希），本批两个字节相同的 song.mp3
    const plan = planImport([entry('song.mp3', 'SAME'), entry('song.mp3', 'SAME')], {
      assets: [],
      audio: [audioRow('song')],
    });
    expect(plan.audio.map((a) => a.name)).toEqual(['song (2)']);
    expect(plan.summary.audioAdded).toBe(1);
    expect(plan.summary.duplicatesSkipped).toBe(1);
    // 回归钉子: 曾经会落成 song (2) + song (3) 两行一模一样的字节
    expect(plan.audio.map((a) => a.name)).not.toContain('song (3)');
  });

  it('干净库里两个字节相同的同名音频，第二个也被去重', () => {
    const plan = planImport([entry('song.mp3', 'SAME'), entry('song.mp3', 'SAME')], noRows());
    expect(plan.audio.map((a) => a.name)).toEqual(['song']);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('批内音频去重也按终名查 —— 改名后的那一行同样占位', () => {
    // 第一个 song.mp3 落成 song (2)；随后来的 song (2).mp3 字节相同 → 就是它自己
    const plan = planImport([entry('song.mp3', 'SAME'), entry('song (2).mp3', 'SAME')], {
      assets: [],
      audio: [audioRow('song')],
    });
    expect(plan.audio.map((a) => a.name)).toEqual(['song (2)']);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('批内同名但字节不同 → 照常各拿各的号，不误杀', () => {
    const plan = planImport([entry('song.mp3', 'A'), entry('song.mp3', 'B')], {
      assets: [],
      audio: [audioRow('song')],
    });
    expect(plan.audio.map((a) => a.name)).toEqual(['song (2)', 'song (3)']);
    expect(plan.summary.duplicatesSkipped).toBe(0);
  });

  it('✅ 素材侧无同型缺陷: 去重键是 (name,type)，编号只动 variant', () => {
    // 与音频那个场景同构 —— 库里一条无哈希的 base 行，本批两张字节相同的图
    const plan = planImport([entry('苏婉_头像.png', 'SAME'), entry('苏婉_头像.png', 'SAME')], {
      assets: [assetRow('苏婉', '头像')],
      audio: [],
    });
    expect(plan.assets.map((a) => a.variant)).toEqual(['2']);
    expect(plan.summary.assetsAdded).toBe(1);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('✅ 素材: 带变体的行被改号后，同字节的后来者照样命中', () => {
    const plan = planImport(
      [entry('苏婉_头像_微笑.png', 'SAME'), entry('苏婉_头像_微笑.png', 'SAME')],
      { assets: [assetRow('苏婉', '头像', '微笑')], audio: [] },
    );
    expect(plan.assets.map((a) => a.variant)).toEqual(['微笑 2']);
    expect(plan.summary.duplicatesSkipped).toBe(1);
  });

  it('音频已带 (n) 的名字换号而不嵌套', () => {
    const plan = planImport([entry('战斗 (2).mp3', 'X')], {
      assets: [],
      audio: [audioRow('战斗'), audioRow('战斗 (2)')],
    });
    expect(plan.audio[0].name).toBe('战斗 (3)');
  });
});

// ═══════════════════════════════════════════════════════════
// §4.4 无哈希降级
// ═══════════════════════════════════════════════════════════

describe('无哈希降级 (hash-unavailable)', () => {
  it('条目没带哈希 → 完全跳过去重，落编号路径 + 告警', () => {
    const plan = planImport([entry('苏婉_头像.png')], {
      assets: [assetRow('苏婉', '头像', undefined, 'HASH')],
      audio: [],
    });
    expect(plan.summary.duplicatesSkipped).toBe(0);
    expect(plan.assets[0].variant).toBe('2');
    expect(plan.warnings).toContain('hash-unavailable');
  });

  it('音频无哈希同样跳过去重，走 uniqueAudioName', () => {
    const plan = planImport([entry('战斗主题.mp3')], {
      assets: [],
      audio: [audioRow('战斗主题', 'HASH')],
    });
    expect(plan.audio[0].name).toBe('战斗主题 (2)');
    expect(plan.warnings).toContain('hash-unavailable');
  });

  it('全部带哈希时不告警', () => {
    const plan = planImport([entry('苏婉_头像.png', 'h1'), entry('战斗.mp3', 'h2')], noRows());
    expect(plan.warnings).not.toContain('hash-unavailable');
  });

  it('被跳过的噪音/未知扩展名不触发哈希告警（它们从不参与去重）', () => {
    const plan = planImport([entry('源文件.psd'), entry('.DS_Store')], noRows());
    expect(plan.warnings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// §5.2 / D10 清单
// ═══════════════════════════════════════════════════════════

describe('清单 (§5.2 / D10)', () => {
  it('只能追加 credit / license / tags', () => {
    const manifest: ImportManifest = {
      assets: { '苏婉_头像.png': { credit: '画师A', license: 'CC-BY' } },
      audio: { '战斗.mp3': { tags: ['情境:战斗', '情绪:紧张'], credit: 'Aoo', license: 'X' } },
    };
    const plan = planImport([entry('苏婉_头像.png'), entry('战斗.mp3')], noRows(), manifest);
    expect(plan.assets[0].credit).toBe('画师A');
    expect(plan.assets[0].license).toBe('CC-BY');
    expect(plan.audio[0].tags).toEqual(['情境:战斗', '情绪:紧张']);
    expect(plan.audio[0].credit).toBe('Aoo');
  });

  it('🔴 清单改不了名字，也改不了类型 —— 身份只认文件名', () => {
    const hostile = {
      assets: {
        '苏婉_头像.png': {
          name: '林月',
          type: '立绘',
          variant: '微笑',
          ext: 'mp4',
          credit: '画师A',
        },
      },
    } as unknown as ImportManifest;
    const plan = planImport([entry('苏婉_头像.png')], noRows(), hostile);
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '头像', variant: undefined }]);
    expect(plan.assets[0].ext).toBe('png');
    // 允许的字段照样生效 —— 证明清单确实被读了，不是整份被忽略
    expect(plan.assets[0].credit).toBe('画师A');
  });

  it('清单缺席 → 全部以空元数据导入', () => {
    const plan = planImport([entry('苏婉_头像.png'), entry('战斗.mp3')], noRows());
    expect(plan.assets[0].credit).toBeUndefined();
    expect(plan.audio[0].tags).toEqual([]);
  });

  it('畸形清单降级成"没有元数据"，绝不抛', () => {
    const broken = [
      { assets: null, audio: 42 },
      { assets: [1, 2, 3] },
      { assets: { '苏婉_头像.png': 'not-an-object' } },
      { assets: { '苏婉_头像.png': { credit: 123, license: [], tags: 'x' } } },
    ] as unknown as ImportManifest[];
    for (const manifest of broken) {
      const plan = planImport([entry('苏婉_头像.png')], noRows(), manifest);
      expect(plan.assets).toHaveLength(1);
      expect(plan.assets[0].credit).toBeUndefined();
      expect(plan.assets[0].license).toBeUndefined();
    }
  });

  it('清单里有、包里没有的键静默容忍；包里有、清单里没有的条目照常导入', () => {
    const manifest: ImportManifest = {
      assets: { '不存在的文件_头像.png': { credit: 'X' } },
    };
    const plan = planImport([entry('苏婉_头像.png')], noRows(), manifest);
    expect(plan.assets).toHaveLength(1);
    expect(plan.assets[0].credit).toBeUndefined();
  });

  it('分区不串: 音频分区的元数据不会落到素材上', () => {
    const manifest: ImportManifest = { audio: { '苏婉_头像.png': { credit: 'X' } } };
    const plan = planImport([entry('苏婉_头像.png')], noRows(), manifest);
    expect(plan.assets[0].credit).toBeUndefined();
  });

  it('清单键按 basename 匹配（与拍平口径一致）', () => {
    const manifest: ImportManifest = { assets: { '苏婉_头像.png': { credit: '画师A' } } };
    const plan = planImport([entry('assets/角色/苏婉_头像.png')], noRows(), manifest);
    expect(plan.assets[0].credit).toBe('画师A');
  });

  // ── 取景（2026-07-29 追加）: 显示元数据可以进清单，身份仍然不行 ──

  it('取景随清单进计划', () => {
    const manifest: ImportManifest = {
      assets: { '苏婉_头像.png': { framing: { x: 20, y: 80, scale: 1.75 } } },
    };
    const plan = planImport([entry('苏婉_头像.png')], noRows(), manifest);
    expect(plan.assets[0].framing).toEqual({ x: 20, y: 80, scale: 1.75 });
  });

  it('🔴 敌意取景当场夹逼: NaN / 越界都进不了计划', () => {
    const manifest = {
      assets: {
        'A_头像.png': { framing: { x: Number.NaN, y: 0, scale: 1 } },
        'B_头像.png': { framing: { x: 1e9, y: -50, scale: 999 } },
      },
    } as unknown as ImportManifest;
    const plan = planImport([entry('A_头像.png'), entry('B_头像.png')], noRows(), manifest);
    expect(plan.assets[0].framing).toEqual({ x: 50, y: 0, scale: 1 });
    const b = plan.assets[1].framing!;
    expect(b.x).toBeLessThanOrEqual(100);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.scale).toBeLessThanOrEqual(3);
  });

  it('🔴 非对象的取景一律丢掉 —— 不悄悄翻译成一个默认取景', () => {
    for (const bad of ['居中', 42, [1, 2, 3], null, true]) {
      const manifest = {
        assets: { '苏婉_头像.png': { framing: bad } },
      } as unknown as ImportManifest;
      const plan = planImport([entry('苏婉_头像.png')], noRows(), manifest);
      expect(plan.assets[0].framing, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('🔴 加了 framing 之后，清单**依然**改不了名字与类型', () => {
    const hostile = {
      assets: {
        '苏婉_头像.png': {
          name: '林月',
          type: '立绘',
          variant: '微笑',
          framing: { x: 10, y: 10, scale: 2 },
        },
      },
    } as unknown as ImportManifest;
    const plan = planImport([entry('苏婉_头像.png')], noRows(), hostile);
    expect(slots(plan)).toEqual([{ name: '苏婉', type: '头像', variant: undefined }]);
    expect(plan.assets[0].framing).toEqual({ x: 10, y: 10, scale: 2 });
  });

  it('🔴 被判成重复的条目根本不进计划 → 清单的取景碰不到既有行', () => {
    const existing = {
      assets: [{ id: 'x', name: '苏婉', type: '头像' as const, hash: 'h1' }],
      audio: [],
    };
    const manifest: ImportManifest = {
      assets: { '苏婉_头像.png': { framing: { x: 99, y: 1, scale: 2 } } },
    };
    const plan = planImport([entry('苏婉_头像.png', 'h1')], existing, manifest);
    expect(plan.assets).toHaveLength(0);
    expect(plan.skips.map((s) => s.reason)).toEqual(['duplicate']);
  });

  it('音频分区的取景无处可落，静默忽略（PlannedAudio 里没有这个字段）', () => {
    const manifest: ImportManifest = {
      audio: { '战斗.mp3': { framing: { x: 1, y: 2, scale: 2 } } },
    };
    const plan = planImport([entry('战斗.mp3')], noRows(), manifest);
    expect(plan.audio).toHaveLength(1);
    expect(plan.audio[0]).not.toHaveProperty('framing');
  });
});

// ═══════════════════════════════════════════════════════════
// §2 / §12 漏写类型 token 的启发式
// ═══════════════════════════════════════════════════════════

describe('疑似漏写类型 (§2 / §12)', () => {
  it('苏婉_微笑.png 与已有的 苏婉 并存 → 告警（不阻塞、不纠正）', () => {
    const plan = planImport([entry('苏婉_微笑.png')], {
      assets: [assetRow('苏婉', '头像')],
      audio: [],
    });
    expect(plan.assets).toHaveLength(1);
    expect(slots(plan)).toEqual([{ name: '苏婉_微笑', type: '头像', variant: undefined }]);
    expect(plan.warnings).toContain('suspect-missing-type');
  });

  it('结论与包内顺序无关（复查在全批规划之后）', () => {
    const forward = planImport([entry('苏婉_头像.png'), entry('苏婉_微笑.png')], noRows());
    const backward = planImport([entry('苏婉_微笑.png'), entry('苏婉_头像.png')], noRows());
    expect(forward.warnings).toContain('suspect-missing-type');
    expect(backward.warnings).toContain('suspect-missing-type');
  });

  it('合法的下划线名字（圣殿_内庭）不误报', () => {
    const plan = planImport([entry('圣殿_内庭_头像.png')], noRows());
    expect(plan.warnings).not.toContain('suspect-missing-type');
  });
});

// ═══════════════════════════════════════════════════════════
// 摘要 & 告警
// ═══════════════════════════════════════════════════════════

describe('摘要与告警', () => {
  it('六个计数各自对上', () => {
    const plan = planImport(
      [
        entry('苏婉_头像.png', 'h1'), //           新增（编号 2）
        entry('林月_头像.png', 'h2'), //           新增
        entry('战斗.mp3', 'h3'), //                新增音频
        entry('战斗主题.mp3', 'DUP'), //           音频重复
        entry('苏婉_头像_立绘.png', 'h4'), //      命名冲突
        entry('.DS_Store'), //                     噪音
        entry('源文件.psd'), //                    未知扩展名
        entry('苏婉_立绘.mp4'), //                 mp4-on-立绘
      ],
      { assets: [assetRow('苏婉', '头像', undefined, 'x')], audio: [audioRow('战斗主题', 'DUP')] },
    );
    expect(plan.summary).toEqual({
      assetsAdded: 2,
      audioAdded: 1,
      duplicatesSkipped: 1,
      renumbered: 1,
      namingConflicts: 1,
      noise: 1,
    });
    expect(plan.skips).toHaveLength(5);
  });

  it('renumbered 覆盖两半边（素材改号 + 音频改名）', () => {
    const plan = planImport([entry('苏婉_头像.png', 'h1'), entry('战斗.mp3', 'h2')], {
      assets: [assetRow('苏婉', '头像', undefined, 'x')],
      audio: [audioRow('战斗', 'y')],
    });
    expect(plan.summary.renumbered).toBe(2);
  });

  it('本模块永不产出 oversize / suspect-filename-encoding（分层在 asset-zip）', () => {
    const plan = planImport(
      [entry('苏婉_头像.png', 'h1'), entry('Ã¦ÂÂ˜Ã¦ÂÂ—.mp3', 'h2')],
      noRows(),
    );
    expect(plan.skips.some((s) => s.reason === 'oversize')).toBe(false);
    expect(plan.warnings).not.toContain('suspect-filename-encoding');
  });

  it('告警数组顺序固定（不漏 Set 的插入序）', () => {
    const plan = planImport([entry('苏婉_微笑.png'), entry('苏婉_头像.png')], noRows());
    expect(plan.warnings).toEqual(['hash-unavailable', 'suspect-missing-type']);
  });
});

// ═══════════════════════════════════════════════════════════
// 确定性 & 幂等
// ═══════════════════════════════════════════════════════════

describe('确定性 (§6.1)', () => {
  const mixed: DecodedEntry[] = [
    entry('__MACOSX/._x.png'),
    entry('assets/苏婉_头像.png', 'h1'),
    entry('assets/苏婉_头像.png', 'h2'),
    entry('苏婉_头像_微笑.png', 'h3'),
    entry('苏婉_立绘.mp4', 'h4'),
    entry('audio/战斗.mp3', 'h5'),
    entry('audio/战斗.mp3', 'h6'),
    entry('说明.txt'),
  ];
  const existing: ExistingRows = {
    assets: [assetRow('苏婉', '头像', undefined, 'h0'), assetRow('苏婉', '头像', '微笑', 'h9')],
    audio: [audioRow('战斗', 'hz')],
  };

  it('同一输入跑两次得到深度相等的计划', () => {
    const a = planImport(mixed, existing);
    const b = planImport(mixed, existing);
    expect(a).toEqual(b);
  });

  it('计划的每一段都按输入顺序排列', () => {
    const plan = planImport(mixed, existing);
    expect(plan.assets.map((x) => x.entry.hash)).toEqual(['h1', 'h2', 'h3']);
    expect(plan.audio.map((x) => x.entry.hash)).toEqual(['h5', 'h6']);
    expect(plan.skips.map((s) => s.reason)).toEqual(['noise', 'mp4-on-立绘', 'unknown-extension']);
  });
});

describe('幂等 (§9 round-trip 的一半)', () => {
  /** 把一份计划变成"库里已有的行"，模拟 store 照单写完之后的状态 */
  function commit(plan: ReturnType<typeof planImport>, into: ExistingRows): ExistingRows {
    const assets = [...into.assets];
    const audio = [...into.audio];
    for (const a of plan.assets) {
      const row = assetRow(a.name, a.type, a.variant, a.entry.hash);
      assets.push(row);
    }
    for (const t of plan.audio) {
      audio.push(audioRow(t.name, t.entry.hash));
    }
    return { assets, audio };
  }

  const pack: DecodedEntry[] = [
    entry('苏婉_头像.png', 'a1'),
    entry('苏婉_头像_微笑.png', 'a2'),
    entry('苏婉_立绘.webp', 'a3'),
    entry('林月_头像.jpg', 'a4'),
    entry('战斗主题.mp3', 't1'),
    entry('宁静.ogg', 't2'),
  ];

  it('第二次导入同一个包 → 零新增，全部按重复跳过（两半边都幂等）', () => {
    const first = planImport(pack, noRows());
    expect(first.summary.assetsAdded).toBe(4);
    expect(first.summary.audioAdded).toBe(2);

    const after = commit(first, noRows());
    const second = planImport(pack, after);

    expect(second.summary.assetsAdded).toBe(0);
    expect(second.summary.audioAdded).toBe(0);
    expect(second.summary.duplicatesSkipped).toBe(6);
    expect(second.summary.renumbered).toBe(0);
    // 关键: 音频既没被 (2) 克隆，素材也没被编号 —— 半幂等比两个极端都糟
    expect(second.audio).toHaveLength(0);
    expect(second.assets).toHaveLength(0);
  });

  it('第三次仍然零新增（幂等是稳态，不是一次性巧合）', () => {
    const after1 = commit(planImport(pack, noRows()), noRows());
    const after2 = commit(planImport(pack, after1), after1);
    const third = planImport(pack, after2);
    expect(third.summary.assetsAdded).toBe(0);
    expect(third.summary.audioAdded).toBe(0);
    expect(after2.assets).toHaveLength(4);
    expect(after2.audio).toHaveLength(2);
  });

  it('没有哈希时幂等不成立（诚实降级的代价，写下来防止有人以为它坏了）', () => {
    const noHash = pack.map((e) => entry(e.path));
    const after = commit(planImport(noHash, noRows()), noRows());
    const second = planImport(noHash, after);
    expect(second.summary.assetsAdded).toBe(4);
    expect(second.warnings).toContain('hash-unavailable');
  });
});

// ═══════════════════════════════════════════════════════════
// allocateVariantSlot —— 分配器的非文件名入口（改名 / 设为主图共用同一套政策）
// ═══════════════════════════════════════════════════════════

describe('allocateVariantSlot', () => {
  const row = (name: string, type: AssetType, variant?: string) =>
    variant === undefined ? { name, type } : { name, type, variant };

  it('base 位空着就占 base；被占则 max+1（base 隐含算 1 号）', () => {
    expect(allocateVariantSlot('苏婉', '头像', undefined, [])).toEqual({});
    expect(
      allocateVariantSlot('苏婉', '头像', undefined, [row('苏婉', '头像')]),
    ).toEqual({ variant: '2', renumberedFrom: '' });
    expect(
      allocateVariantSlot('苏婉', '头像', undefined, [
        row('苏婉', '头像'),
        row('苏婉', '头像', '2'),
        row('苏婉', '头像', '5'),
      ]),
    ).toEqual({ variant: '6', renumberedFrom: '' });
  });

  it('具名变体撞车换号、绝不嵌套', () => {
    const existing = [row('苏婉', '头像', '微笑'), row('苏婉', '头像', '微笑 2')];
    expect(allocateVariantSlot('苏婉', '头像', '微笑', existing)).toEqual({
      variant: '微笑 3',
      renumberedFrom: '微笑',
    });
  });

  it('只看同一个 (name, type)：别的名字/类型不占位', () => {
    const existing = [row('苏婉', '立绘'), row('林清', '头像')];
    expect(allocateVariantSlot('苏婉', '头像', undefined, existing)).toEqual({});
  });

  it('名字里的分隔符不再改变归属 —— 文件名那条路会在这里拍平成另一个组', () => {
    // 这正是 store 侧曾经的缺陷: `圣殿/内庭_头像.png` 经 basenameOf 变成 `内庭_头像.png`，
    // 于是与真正的 `圣殿/内庭` 组对不上，两行都以为 base 位空着。
    const existing = [row('圣殿/内庭', '头像')];
    expect(allocateVariantSlot('圣殿/内庭', '头像', undefined, existing)).toEqual({
      variant: '2',
      renumberedFrom: '',
    });
    // 而 `内庭` 是另一个组，互不影响
    expect(allocateVariantSlot('内庭', '头像', undefined, existing)).toEqual({});
  });
});
