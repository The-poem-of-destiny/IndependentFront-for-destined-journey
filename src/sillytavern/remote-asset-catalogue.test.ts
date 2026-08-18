/**
 * remote-asset-catalogue.test.ts — 远程素材声明解析（远程素材 v1 / 波 1）
 *
 * 覆盖:
 * 1. 上游 `char-info-ejs-builder` 块的定位（前后全是 EJS 噪音 / 多块 / 版本号通配）
 * 2. 坏 JSON 只让那一块作废，永不抛
 * 3. gallery 拉平 + 变体编号方案（基图位 / 标题 / 标题+序数）
 * 4. 命名闸门（D2 空名 / D16 类型 token / D19 zip 条目名）—— 拒收，绝不修补
 * 5. 世界书扫描跳过 `enabled === false` 的条目
 * 6. 内容包分节的逐行容错
 * 7. 去重先来先得
 *
 * 🔴 **全部 fixture 都是合成的**: 上游那份真实 DLC 世界书只用来对格式，一个字的正文
 * 都没有抄进本仓。角色名一律用「测试角色甲」这类中性占位。
 */

import { describe, it, expect } from 'vitest';
import {
  collectWorldBookRemoteAssets,
  dedupeRemoteAssetDecls,
  extractRemoteAssetDecls,
  normalizePackRemoteAssets,
  type RemoteAssetDecl,
} from './remote-asset-catalogue';
import type { WorldBook, WorldBookEntry } from './types';

// ═══════════════════════════════════════════════════════════
// fixture 构造
// ═══════════════════════════════════════════════════════════

const URL_A = 'https://example.invalid/a.png';
const URL_B = 'https://example.invalid/b.png';
const URL_C = 'https://example.invalid/c.png';
const URL_D = 'https://example.invalid/d.png';

interface ProfileFixture {
  characterName?: unknown;
  avatarUrl?: unknown;
  raceColor?: string;
  gallery?: unknown;
}

/**
 * 造一个 builder 块。`profileLiteral` 直接落进块里 —— 传对象走 `JSON.stringify`
 * （保证 JSON 兼容），传字符串则原样注入（用来造坏字面量）。
 */
function builderBlock(profileLiteral: ProfileFixture | string, version = 'v2'): string {
  const literal =
    typeof profileLiteral === 'string' ? profileLiteral : JSON.stringify(profileLiteral, null, 2);
  return [
    `<%# char-info-ejs-builder:start:${version} %>`,
    '<%_',
    '{',
    `  const profile = ${literal};`,
    '',
    '  const npcName = profile.characterName;',
    '  setLocalVar(`char_info.profiles[${JSON.stringify(npcName)}]`, {',
    '    schema_version: 1,',
    '    gallery: profile.gallery.map(image => ({ title: image.title, sources: image.sources })),',
    '  });',
    '}',
    '_%>',
    `<%# char-info-ejs-builder:end:${version} %>`,
  ].join('\n');
}

/** 上游正文的典型样子：块前有 EJS 变量计算，块后是大段设定散文 */
function noisyEntry(...blocks: string[]): string {
  return [
    '<%_ { _%>',
    '<%_',
    "let _relationList = getMessageVar('stat_data.关系列表') || {};",
    "let _seen = _relationList['测试角色甲'] !== undefined;",
    '_%>',
    '',
    ...blocks,
    '',
    '---',
    '',
    '测试角色甲:',
    '  基本信息: 占位种族 | 占位职业',
    '<%_ if (!_seen) { _%>',
    '  备注: 这一段是给提示词看的占位文本，不含任何声明',
    '<%_ } _%>',
  ].join('\n');
}

function makeEntry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    uid: 1,
    name: '条目',
    content: '',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
    ...overrides,
  };
}

function makeBook(entries: WorldBookEntry[], id = 'book-1'): WorldBook {
  return { id, name: '测试书', partition: 'character', entries };
}

// ═══════════════════════════════════════════════════════════
// 块定位
// ═══════════════════════════════════════════════════════════

describe('extractRemoteAssetDecls — 块定位', () => {
  it('前后全是 EJS 噪音时照样抽得出头像与立绘', () => {
    const content = noisyEntry(
      builderBlock({
        characterName: '测试角色甲',
        avatarUrl: URL_A,
        raceColor: '#00FF00',
        gallery: [{ title: '主立绘', sources: [URL_A] }],
      }),
    );

    expect(extractRemoteAssetDecls(content)).toEqual<RemoteAssetDecl[]>([
      { name: '测试角色甲', type: '头像', url: URL_A },
      { name: '测试角色甲', type: '立绘', url: URL_A },
    ]);
  });

  it('一条正文里多个块 —— 每个块各自成一份 profile', () => {
    const content = noisyEntry(
      builderBlock({
        characterName: '测试角色甲',
        avatarUrl: URL_A,
        gallery: [{ title: '主立绘', sources: [URL_A] }],
      }),
      '<%_ /* 中间还能夹别的 EJS */ _%>',
      builderBlock({
        characterName: '测试角色乙',
        avatarUrl: URL_B,
        gallery: [{ title: '主立绘', sources: [URL_B] }],
      }),
    );

    expect(extractRemoteAssetDecls(content).map((d) => `${d.name}/${d.type}`)).toEqual([
      '测试角色甲/头像',
      '测试角色甲/立绘',
      '测试角色乙/头像',
      '测试角色乙/立绘',
    ]);
  });

  it('版本号通配：:v3 / 无版本号都认（钉死版本 = 上游一升版立绘全消失）', () => {
    for (const version of ['v3', 'v17']) {
      const decls = extractRemoteAssetDecls(
        builderBlock({ characterName: '测试角色甲', avatarUrl: URL_A }, version),
      );
      expect(decls, version).toEqual([{ name: '测试角色甲', type: '头像', url: URL_A }]);
    }
    // 完全没有 `:vN` 的写法
    const bare = [
      '<%# char-info-ejs-builder:start %>',
      `const profile = ${JSON.stringify({ characterName: '测试角色甲', avatarUrl: URL_A })};`,
      '<%# char-info-ejs-builder:end %>',
    ].join('\n');
    expect(extractRemoteAssetDecls(bare)).toHaveLength(1);
  });

  it('块外的 profile 一律不看（只有 builder 块里的声明才算数）', () => {
    const content = `const profile = ${JSON.stringify({
      characterName: '测试角色甲',
      avatarUrl: URL_A,
    })};`;
    expect(extractRemoteAssetDecls(content)).toEqual([]);
  });

  it('开着的块没等到 end → 整块丢弃，不猜边界', () => {
    const content = [
      '<%# char-info-ejs-builder:start:v2 %>',
      `const profile = ${JSON.stringify({ characterName: '测试角色甲', avatarUrl: URL_A })};`,
    ].join('\n');
    expect(extractRemoteAssetDecls(content)).toEqual([]);
  });

  it('空串 / 非串输入 → 空数组，永不抛', () => {
    expect(extractRemoteAssetDecls('')).toEqual([]);
    expect(extractRemoteAssetDecls(undefined as unknown as string)).toEqual([]);
    expect(extractRemoteAssetDecls('随便一段没有任何标记的正文')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 坏数据
// ═══════════════════════════════════════════════════════════

describe('extractRemoteAssetDecls — 坏数据只丢那一块', () => {
  it('坏 JSON 字面量（尾逗号）→ 跳过该块，其余块照常', () => {
    const broken = builderBlock('{ "characterName": "测试角色乙", "avatarUrl": "x", }');
    const good = builderBlock({ characterName: '测试角色甲', avatarUrl: URL_A });
    expect(extractRemoteAssetDecls(`${broken}\n${good}`)).toEqual([
      { name: '测试角色甲', type: '头像', url: URL_A },
    ]);
  });

  it('字面量里带表达式（模板串 / 变量引用）→ JSON.parse 失败，跳过', () => {
    const content = builderBlock('{ "characterName": npcName, "avatarUrl": `${base}/a.png` }');
    expect(extractRemoteAssetDecls(content)).toEqual([]);
  });

  it('花括号出现在字符串值里不会截断字面量（配平扫描认引号）', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      avatarUrl: URL_A,
      // 台词类字段里出现 `}` 完全合法 —— 只找下一个 `}` 的实现会在这里断掉
      raceColor: '#00FF00',
      gallery: [{ title: '含}花括号的标题', sources: [URL_B] }],
    });
    const decls = extractRemoteAssetDecls(content);
    expect(decls).toHaveLength(2);
    expect(decls[1]).toEqual({ name: '测试角色甲', type: '立绘', url: URL_B });
  });

  it('非 http(s) 地址一律不要（data: / 相对路径 / 空串 / 非串）', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      avatarUrl: 'data:image/png;base64,AAAA',
      gallery: [{ title: '主立绘', sources: ['./local.png', '', 42, 'ftp://x/y.png', URL_A] }],
    });
    // 只剩最后那个合法地址，而且它拿到的是**基图位**（前面几个根本没进过分配）
    expect(extractRemoteAssetDecls(content)).toEqual([
      { name: '测试角色甲', type: '立绘', url: URL_A },
    ]);
  });

  it('characterName 缺失 / 非串 → 整份 profile 作废', () => {
    for (const characterName of [undefined, 123, '']) {
      const content = builderBlock({
        characterName,
        avatarUrl: URL_A,
        gallery: [{ title: '主立绘', sources: [URL_B] }],
      });
      expect(extractRemoteAssetDecls(content), String(characterName)).toEqual([]);
    }
  });

  it('gallery 不是数组 / 项不是对象 / sources 不是数组 → 只丢立绘，头像照留', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      avatarUrl: URL_A,
      gallery: '不是数组',
    });
    expect(extractRemoteAssetDecls(content)).toEqual([
      { name: '测试角色甲', type: '头像', url: URL_A },
    ]);

    const content2 = builderBlock({
      characterName: '测试角色甲',
      avatarUrl: URL_A,
      gallery: ['不是对象', { title: '主立绘', sources: '不是数组' }],
    });
    expect(extractRemoteAssetDecls(content2)).toEqual([
      { name: '测试角色甲', type: '头像', url: URL_A },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// gallery 拉平 + 变体编号
// ═══════════════════════════════════════════════════════════

describe('extractRemoteAssetDecls — gallery 拉平与变体编号', () => {
  it('拉平后第一张占基图位，同项后续源按「标题+序数」', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [{ title: '主立绘', sources: [URL_A, URL_B, URL_C] }],
    });
    expect(extractRemoteAssetDecls(content)).toEqual<RemoteAssetDecl[]>([
      { name: '测试角色甲', type: '立绘', url: URL_A },
      { name: '测试角色甲', type: '立绘', variant: '主立绘2', url: URL_B },
      { name: '测试角色甲', type: '立绘', variant: '主立绘3', url: URL_C },
    ]);
  });

  it('第二个 gallery 项的第一张用裸标题，后续源继续加序数', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [
        { title: '主立绘', sources: [URL_A, URL_B] },
        { title: '战斗姿', sources: [URL_C, URL_D] },
      ],
    });
    expect(extractRemoteAssetDecls(content).map((d) => d.variant)).toEqual([
      undefined,
      '主立绘2',
      '战斗姿',
      '战斗姿2',
    ]);
  });

  it('标题重名 → 撞位让路而不是覆盖（编号继续往下走）', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [
        { title: '立姿', sources: [URL_A, URL_B] },
        { title: '立姿', sources: [URL_C, URL_D] },
      ],
    });
    // 第一项: 基图位 + 立姿2；第二项想要「立姿」（空着）→ 拿到；再想要「立姿2」（占了）→ 立姿3
    expect(extractRemoteAssetDecls(content).map((d) => d.variant)).toEqual([
      undefined,
      '立姿2',
      '立姿',
      '立姿3',
    ]);
  });

  it('跨块同名角色：第二块不再抢基图位', () => {
    const content = [
      builderBlock({ characterName: '测试角色甲', gallery: [{ title: '甲图', sources: [URL_A] }] }),
      builderBlock({ characterName: '测试角色甲', gallery: [{ title: '乙图', sources: [URL_B] }] }),
    ].join('\n');
    expect(extractRemoteAssetDecls(content)).toEqual<RemoteAssetDecl[]>([
      { name: '测试角色甲', type: '立绘', url: URL_A },
      { name: '测试角色甲', type: '立绘', variant: '乙图', url: URL_B },
    ]);
  });

  it('标题缺失/空串时退化成纯序数变体，且绝不占走基图位', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [{ sources: [URL_A, URL_B, URL_C] }],
    });
    expect(extractRemoteAssetDecls(content).map((d) => d.variant)).toEqual([undefined, '2', '3']);
  });
});

// ═══════════════════════════════════════════════════════════
// 命名闸门
// ═══════════════════════════════════════════════════════════

describe('extractRemoteAssetDecls — 命名闸门（D2 / D16 / D19）', () => {
  it('变体整段等于类型 token（D16）→ 只丢那一条', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [
        { title: '主立绘', sources: [URL_A] },
        // 标题就是「立绘」：落库后文件名会变成 `测试角色甲_立绘_立绘.png`，
        // 再导入时解析回来就是另一行 —— D16 拦的正是这个
        { title: '立绘', sources: [URL_B] },
        { title: '头像', sources: [URL_C] },
      ],
    });
    expect(extractRemoteAssetDecls(content)).toEqual<RemoteAssetDecl[]>([
      { name: '测试角色甲', type: '立绘', url: URL_A },
    ]);
  });

  it('名字含类型 token 段（D16）或路径分隔符/前导点（D19）→ 整份 profile 作废', () => {
    for (const characterName of ['测试角色甲_立绘', '圣殿/内庭', '圣殿\\内庭', '.隐藏角色']) {
      const content = builderBlock({
        characterName,
        avatarUrl: URL_A,
        gallery: [{ title: '主立绘', sources: [URL_B] }],
      });
      expect(extractRemoteAssetDecls(content), characterName).toEqual([]);
    }
  });

  it('变体带路径分隔符（D19）→ 只丢那一条', () => {
    const content = builderBlock({
      characterName: '测试角色甲',
      gallery: [
        { title: '主立绘', sources: [URL_A] },
        { title: 'a/b', sources: [URL_B] },
      ],
    });
    expect(extractRemoteAssetDecls(content)).toHaveLength(1);
  });

  it('名字里的空白**不 trim**（D2）—— 那是名字的一部分', () => {
    const content = builderBlock({ characterName: ' 测试角色甲 ', avatarUrl: URL_A });
    expect(extractRemoteAssetDecls(content)[0].name).toBe(' 测试角色甲 ');
  });
});

// ═══════════════════════════════════════════════════════════
// 世界书扫描
// ═══════════════════════════════════════════════════════════

describe('collectWorldBookRemoteAssets', () => {
  const content甲 = builderBlock({ characterName: '测试角色甲', avatarUrl: URL_A });
  const content乙 = builderBlock({ characterName: '测试角色乙', avatarUrl: URL_B });

  it('多本书 flatMap，按书序 → 条目序', () => {
    const books = [
      makeBook([makeEntry({ uid: 1, content: content甲 })], 'b1'),
      makeBook([makeEntry({ uid: 2, content: content乙 })], 'b2'),
    ];
    expect(collectWorldBookRemoteAssets(books).map((d) => d.name)).toEqual([
      '测试角色甲',
      '测试角色乙',
    ]);
  });

  it('🔴 enabled === false 的条目一条都不扫（关掉的条目凭什么替它下图）', () => {
    const books = [
      makeBook([
        makeEntry({ uid: 1, content: content甲, enabled: false }),
        makeEntry({ uid: 2, content: content乙, enabled: true }),
      ]),
    ];
    expect(collectWorldBookRemoteAssets(books).map((d) => d.name)).toEqual(['测试角色乙']);
  });

  it('缺 enabled 字段的历史行按「开着」处理（判据是 !== false，不是 === true）', () => {
    const entry = makeEntry({ uid: 1, content: content甲 });
    delete (entry as Partial<WorldBookEntry>).enabled;
    expect(collectWorldBookRemoteAssets([makeBook([entry])])).toHaveLength(1);
  });

  it('空书 / 空数组 / 条目正文为空 → 空结果，不抛', () => {
    expect(collectWorldBookRemoteAssets([])).toEqual([]);
    expect(collectWorldBookRemoteAssets([makeBook([])])).toEqual([]);
    expect(collectWorldBookRemoteAssets([makeBook([makeEntry()])])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 内容包分节
// ═══════════════════════════════════════════════════════════

describe('normalizePackRemoteAssets', () => {
  it('最小行：type 缺省成头像，variant 缺省成基图位', () => {
    expect(normalizePackRemoteAssets([{ name: '测试角色甲', url: URL_A }])).toEqual<
      RemoteAssetDecl[]
    >([{ name: '测试角色甲', type: '头像', url: URL_A }]);
  });

  it('显式 type / variant 原样保留', () => {
    expect(
      normalizePackRemoteAssets([
        { name: '测试角色甲', url: URL_A, type: '立绘', variant: '雨天' },
        { name: '测试角色甲', url: URL_B, type: '立绘bg' },
      ]),
    ).toEqual<RemoteAssetDecl[]>([
      { name: '测试角色甲', type: '立绘', variant: '雨天', url: URL_A },
      { name: '测试角色甲', type: '立绘bg', url: URL_B },
    ]);
  });

  it('🔴 认不出的 type 跳过该行，绝不回落成头像（那会把图放错位置且没人发现）', () => {
    expect(
      normalizePackRemoteAssets([
        { name: '测试角色甲', url: URL_A, type: '立绘bg2' },
        { name: '测试角色甲', url: URL_B, type: 123 },
      ]),
    ).toEqual([]);
  });

  it('非数组 / 坏行一律跳过，返回值永远是合法数组', () => {
    expect(normalizePackRemoteAssets(undefined)).toEqual([]);
    expect(normalizePackRemoteAssets({ rows: [] })).toEqual([]);
    expect(normalizePackRemoteAssets('[]')).toEqual([]);
    expect(
      normalizePackRemoteAssets([
        null,
        '不是对象',
        { url: URL_A }, // 缺 name
        { name: '甲' }, // 缺 url
        { name: '甲', url: 'ftp://x/y.png' }, // 非 http(s)
        { name: '', url: URL_A }, // 空名（D2）
        { name: '甲_头像', url: URL_A }, // D16
        { name: '甲', url: URL_A, variant: '立绘' }, // D16
        { name: 'a/b', url: URL_A }, // D19
        { name: '甲', url: URL_A, variant: 42 }, // variant 非串
        { name: '甲', url: URL_A }, // ← 唯一活下来的
      ]),
    ).toEqual<RemoteAssetDecl[]>([{ name: '甲', type: '头像', url: URL_A }]);
  });

  it('variant 空串归一成缺省（基图位只有一种形状）', () => {
    expect(normalizePackRemoteAssets([{ name: '甲', url: URL_A, variant: '' }])).toEqual([
      { name: '甲', type: '头像', url: URL_A },
    ]);
  });

  it('[] = 刻意清空（三态语义里的「空」，与 absent 不是一回事）', () => {
    expect(normalizePackRemoteAssets([])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 去重
// ═══════════════════════════════════════════════════════════

describe('dedupeRemoteAssetDecls', () => {
  it('(name, type, variant) 相同 → 先来的赢', () => {
    const decls: RemoteAssetDecl[] = [
      { name: '甲', type: '头像', url: URL_A },
      { name: '甲', type: '头像', url: URL_B },
      { name: '甲', type: '立绘', url: URL_C },
      { name: '甲', type: '立绘', variant: '雨天', url: URL_D },
      { name: '甲', type: '立绘', variant: '雨天', url: URL_A },
      { name: '乙', type: '头像', url: URL_A },
    ];
    expect(dedupeRemoteAssetDecls(decls)).toEqual<RemoteAssetDecl[]>([
      { name: '甲', type: '头像', url: URL_A },
      { name: '甲', type: '立绘', url: URL_C },
      { name: '甲', type: '立绘', variant: '雨天', url: URL_D },
      { name: '乙', type: '头像', url: URL_A },
    ]);
  });

  it('缺省 variant 与空串 variant 是同一个位', () => {
    expect(
      dedupeRemoteAssetDecls([
        { name: '甲', type: '立绘', url: URL_A },
        { name: '甲', type: '立绘', variant: '', url: URL_B },
      ]),
    ).toHaveLength(1);
  });

  it('名字里带分隔符也不会串位（键走 JSON.stringify，不是拼接）', () => {
    expect(
      dedupeRemoteAssetDecls([
        { name: '甲', type: '立绘', variant: '乙', url: URL_A },
        { name: '甲,立绘', type: '立绘', variant: '乙', url: URL_B },
      ]),
    ).toHaveLength(2);
  });

  it('空输入 → 空数组', () => {
    expect(dedupeRemoteAssetDecls([])).toEqual([]);
  });
});
