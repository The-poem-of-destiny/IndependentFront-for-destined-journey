/**
 * character-viewer.ts — 角色查看器展示层判定
 *
 * 这些用例钉的都是「界面上少一行字 / 多一行空行」那类缺陷 —— 它们不会让任何
 * 别的测试变红，也不会在控制台留下痕迹。
 */
import { describe, it, expect } from 'vitest';
import { createDefaultCharacterState } from '@engine/types';
import type { AssetMetaRecord, CharacterState } from '@engine/types';
import {
  buildAffectionView,
  buildAlbumGroups,
  buildAscensionTracks,
  buildProfileFields,
  buildSubtitleSegments,
  hasAnyAscension,
  itemQuality,
  splitInventory,
} from './character-viewer';

function char(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({ name: '维奥莱塔', ...overrides });
}

function row(over: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  return {
    id: 'a1',
    name: '维奥莱塔',
    type: '立绘',
    ext: 'png',
    mime: 'image/png',
    bytes: 10,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('buildSubtitleSegments', () => {
  const texts = (c: CharacterState) => buildSubtitleSegments(c).map((s) => s.text);

  it('按序拼 种族 · 身份 · 职业 · 层级 · Lv', () => {
    expect(
      texts(
        char({
          race: '人类',
          identity: ['帝王'],
          occupation: ['法则代行者'],
          tier: 6,
          level: 24,
        }),
      ),
    ).toEqual(['人类', '帝王', '法则代行者', '神话', 'Lv 24']);
  });

  it('★ 层级名由 tier 反查，不信 tierName —— 两者不一致是真机上实际发生的', () => {
    // 真机走查逮到的那一份数据: tier=5（传说）却带着默认的 tierName='普通'
    const segs = buildSubtitleSegments(char({ tier: 5, tierName: '普通', level: 18 }));
    const tierSeg = segs.find((s) => s.kind === 'tier');
    expect(tierSeg?.text).toBe('传说');
  });

  it('tier 越界（0 / 99）时退回 tierName —— 有话说总比空着好', () => {
    expect(texts(char({ tier: 99, tierName: '域外之物', level: 0 }))).toContain('域外之物');
  });

  it('★ 层级段靠 kind 标记，不靠字符串比对（种族恰好同名也不会被染色）', () => {
    const segs = buildSubtitleSegments(char({ race: '普通', tier: 1, level: 0 }));
    expect(segs.filter((s) => s.kind === 'tier')).toHaveLength(1);
    expect(segs[0]).toEqual({ text: '普通', kind: 'plain' });
  });

  it('★ 空段不占位（不补「未知」，也不留空段）—— 龙套多半只有种族', () => {
    expect(
      texts(char({ race: '兽人', identity: [], occupation: [], tier: 0, tierName: '', level: 0 })),
    ).toEqual(['兽人']);
  });

  it('多身份 / 多职业各自用 / 连起来', () => {
    expect(
      texts(
        char({
          race: '精灵',
          identity: ['公主', '祭司'],
          occupation: [],
          tier: 0,
          tierName: '',
          level: 0,
        }),
      ),
    ).toEqual(['精灵', '公主 / 祭司']);
  });
});

describe('buildAffectionView', () => {
  it('0 → 中立、比例 0', () => {
    expect(buildAffectionView(0)).toEqual({
      value: 0,
      ratio: 0,
      negative: false,
      label: '中立',
    });
  });

  it('缺省（这个角色还没有好感记录）当 0 处理，不炸', () => {
    expect(buildAffectionView(undefined).value).toBe(0);
  });

  it('正负各走各的方向，比例是**单边**的绝对值', () => {
    expect(buildAffectionView(50)).toMatchObject({ ratio: 0.5, negative: false });
    expect(buildAffectionView(-50)).toMatchObject({ ratio: 0.5, negative: true });
  });

  it('★ 越界值先夹逼 —— AI 写飞的 999 不该让条冲出轨道', () => {
    expect(buildAffectionView(999)).toMatchObject({ value: 100, ratio: 1 });
    expect(buildAffectionView(-999)).toMatchObject({ value: -100, ratio: 1 });
  });
});

describe('buildProfileFields', () => {
  it('四行按 性格 / 喜爱 / 外貌 / 着装 排', () => {
    const fields = buildProfileFields(
      char({
        personality: '深沉内敛',
        appearance: '暗金色长发',
        outfit: '皇室军礼服',
        customFields: { likes: '绝对的秩序' },
      }),
    );
    expect(fields.map((f) => f.label)).toEqual(['性格', '喜爱', '外貌', '着装']);
    expect(fields[1].text).toBe('绝对的秩序');
  });

  it('★ 空白行整行不出现（空串与纯空格都算空）', () => {
    const fields = buildProfileFields(char({ personality: '沉默', outfit: '   ' }));
    expect(fields.map((f) => f.label)).toEqual(['性格']);
  });

  it('★ customFields.likes 不是字符串时当没有 —— 扩展位躺着数组会渲染成 [object Object]', () => {
    const fields = buildProfileFields(char({ customFields: { likes: ['秩序', '矿石'] } }));
    expect(fields).toEqual([]);
  });
});

describe('buildAscensionTracks', () => {
  it('恒返回三条轨道，带上限与解锁级别', () => {
    const tracks = buildAscensionTracks(char());
    expect(tracks.map((t) => [t.label, t.cap])).toEqual([
      ['要素', 3],
      ['权能', 1],
      ['法则', 2],
    ]);
    expect(tracks.every((t) => t.entries.length === 0)).toBe(true);
    expect(hasAnyAscension(tracks)).toBe(false);
  });

  it('法则的 costDescription 进 cost，要素没有这一项', () => {
    const tracks = buildAscensionTracks(
      char({
        ascension: {
          enabled: true,
          elements: [{ name: '空间', description: '折叠', effects: ['位移'] }],
          authority: [],
          law: [
            {
              name: '镇压与秩序',
              description: '以法则镇压',
              effects: ['定身'],
              costDescription: '25% 最大MP',
            },
          ],
          deityPosition: '',
          divineKingdom: { name: '', description: '' },
        },
      }),
    );
    expect(tracks[0].entries[0]).toEqual({
      name: '空间',
      description: '折叠',
      effects: ['位移'],
      cost: '',
    });
    expect(tracks[2].entries[0].cost).toBe('25% 最大MP');
    expect(hasAnyAscension(tracks)).toBe(true);
  });

  /**
   * ★ Phase 9 把这三个字段从 Record 改成了 Array。存量存档里可能还是旧形状，
   * 而 `.map` 对 Record 不成立 —— 不摊平的话整个弹窗白屏，不是少一行。
   */
  it('★ 旧存档的 Record 形状照样摊得平', () => {
    const legacy = char();
    (legacy.ascension as unknown as Record<string, unknown>).law = {
      镇压与秩序: { name: '镇压与秩序', description: 'x', effects: [], costDescription: '' },
    };
    const tracks = buildAscensionTracks(legacy);
    expect(tracks[2].entries.map((e) => e.name)).toEqual(['镇压与秩序']);
  });

  it('整个 ascension 缺失（旧数据 / 怪物）也给三条空轨道', () => {
    const broken = char();
    delete (broken as unknown as Record<string, unknown>).ascension;
    expect(buildAscensionTracks(broken)).toHaveLength(3);
  });
});

describe('splitInventory', () => {
  it('按 equippedSlot 非空分家', () => {
    const { equipped, carried } = splitInventory([
      { name: '长剑', quantity: 1, equippedSlot: '主手' },
      { name: '面包', quantity: 3 },
      { name: '旧披风', quantity: 1, equippedSlot: null },
    ]);
    expect(equipped.map((i) => i.name)).toEqual(['长剑']);
    expect(carried.map((i) => i.name)).toEqual(['面包', '旧披风']);
  });

  it('没有背包（怪物）不炸', () => {
    expect(splitInventory(undefined)).toEqual({ equipped: [], carried: [] });
  });
});

describe('itemQuality', () => {
  it('★ 有 rarity 就用它 —— 推断封顶在传说，会把「唯一」安静降级', () => {
    expect(itemQuality({ name: '圣剑', quantity: 1, rarity: '唯一', stats: { str: 1 } })).toBe(
      '唯一',
    );
  });

  it('没有 rarity 时按属性总和推断', () => {
    expect(itemQuality({ name: '铁剑', quantity: 1, stats: { str: 12 } })).toBe('优良');
    expect(itemQuality({ name: '木棍', quantity: 1 })).toBe('普通');
  });
});

describe('buildAlbumGroups', () => {
  it('★ 名字严格 === （D2）：尾随空格的素材不算这个人的', () => {
    const groups = buildAlbumGroups([row({ name: '维奥莱塔 ' })], '维奥莱塔');
    expect(groups).toEqual([]);
  });

  it('按 ASSET_TYPES 展示序分组，空组不出现', () => {
    const groups = buildAlbumGroups(
      [
        row({ id: 'b', type: '立绘bg' }),
        row({ id: 'a', type: '头像' }),
        row({ id: 's', type: '立绘' }),
      ],
      '维奥莱塔',
    );
    expect(groups.map((g) => g.type)).toEqual(['头像', '立绘', '立绘bg']);
  });

  it('组内主图在前，变体按名字升序', () => {
    const groups = buildAlbumGroups(
      [row({ id: 'v2', variant: '微笑' }), row({ id: 'v1', variant: '大笑' }), row({ id: 'base' })],
      '维奥莱塔',
    );
    expect(groups[0].tiles.map((t) => t.id)).toEqual(['base', 'v1', 'v2']);
    expect(groups[0].tiles.map((t) => t.caption)).toEqual(['立绘', '立绘 · 大笑', '立绘 · 微笑']);
  });

  it('空串变体归一成「没有变体」—— 与 asset-index 的口径一致', () => {
    const groups = buildAlbumGroups([row({ variant: '' })], '维奥莱塔');
    expect(groups[0].tiles[0].variant).toBeUndefined();
  });

  it('同变体撞车时按 createdAt → id 稳定排序（刷新两次顺序不变）', () => {
    const groups = buildAlbumGroups(
      [
        row({ id: 'z', variant: '微笑', createdAt: 5 }),
        row({ id: 'a', variant: '微笑', createdAt: 5 }),
        row({ id: 'm', variant: '微笑', createdAt: 1 }),
      ],
      '维奥莱塔',
    );
    expect(groups[0].tiles.map((t) => t.id)).toEqual(['m', 'a', 'z']);
  });
});
