/**
 * audio-scene.test.ts — 场景选曲：多维度标签累计打分
 *
 * 覆盖:
 * 1. nameSimilarity 的三档语义（相等 / 包含 / 字形）与档间不重叠
 * 2. splitLocationPath 拆七段路径；buildLocationChain 的深度语义与断链/成环防御
 * 3. resolveSceneByTags 的多维度累计打分、深度衰减、跨维度权衡、稳定性
 */

import { describe, it, expect } from 'vitest';
import {
  nameSimilarity,
  splitLocationPath,
  buildLocationChain,
  resolveSceneByTags,
  SCENE_MATCH_THRESHOLD,
  SCENE_TAG_WEIGHTS,
  LOCATION_DEPTH_DECAY,
} from './audio-scene';
import type { AudioTrack, LocationNode } from './types';

// ═══ 夹具 ═══════════════════════════════════════════════

function track(
  id: string,
  name: string,
  tags: string[],
  over: Partial<AudioTrack> = {},
): AudioTrack {
  return {
    id,
    name,
    kind: 'music',
    source: 'builtin',
    url: `/audio/bgm/${id}.mp3`,
    tags,
    builtin: true,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

/** 微型地图: 大陆 → 帝国 → 铁炉堡；帝国旁挂一个无音乐的联邦 */
const NODES: LocationNode[] = [
  {
    id: 'c',
    name: '阿斯塔利亚大陆',
    type: 'continent',
    parentId: null,
    tier: 1,
    description: '',
    neighbors: [],
  },
  {
    id: 'r1',
    name: '奥古斯提姆帝国',
    type: 'region',
    parentId: 'c',
    tier: 2,
    description: '',
    neighbors: [],
  },
  {
    id: 'r2',
    name: '萨赫拉联邦',
    type: 'region',
    parentId: 'c',
    tier: 2,
    description: '',
    neighbors: [],
  },
  {
    id: 'city1',
    name: '铁炉堡',
    type: 'city',
    parentId: 'r1',
    tier: 3,
    description: '',
    neighbors: [],
  },
];

const EMPIRE_A = track('emp_a', '奥古斯提姆帝国（平静）', [
  '地点:奥古斯提姆帝国',
  '情绪:平静',
  '情境:探索',
]);
const EMPIRE_B = track('emp_b', '奥古斯提姆帝国（不安）', [
  '地点:奥古斯提姆帝国',
  '情绪:不安',
  '情境:活动',
]);
const DRAGON_A = track('drg_a', '龙脊山脉（平静）', ['地点:龙脊山脉', '情绪:平静', '情境:探索']);
const LIB: AudioTrack[] = [EMPIRE_A, EMPIRE_B, DRAGON_A];

// ═══ nameSimilarity ═════════════════════════════════════

describe('nameSimilarity', () => {
  it('归一化后相等给满分（大小写/空白/扩展名不影响）', () => {
    expect(nameSimilarity('龙脊山脉', '龙脊山脉')).toBe(1);
    expect(nameSimilarity(' Battle  Standard ', 'battle standard')).toBe(1);
    expect(nameSimilarity('战斗.mp3', '战斗')).toBe(1);
  });

  it('空串一律 0 —— 不让两个空名互相命中', () => {
    expect(nameSimilarity('', '龙脊山脉')).toBe(0);
    expect(nameSimilarity('   ', '')).toBe(0);
  });

  it('包含关系落在 (0.6, 1) 区间，且越接近整词越高', () => {
    const near = nameSimilarity('龙脊山脉北麓', '龙脊山脉'); // 4/6
    const far = nameSimilarity('龙脊山脉某个很长的地名后缀', '龙脊山脉');
    expect(near).toBeGreaterThan(0.6);
    expect(near).toBeLessThan(1);
    expect(near).toBeGreaterThan(far);
  });

  it('纯字形相似压在包含档之下 —— 共享字不该冒充包含', () => {
    // 样本必须**真的有共享二元组**，否则 Dice 恒为 0，这条断言就成了空转:
    // 「龙脊山脉北」与「龙脊之脉北」共享 {龙脊, 脉北}，落在字形档
    const shape = nameSimilarity('龙脊山脉北', '龙脊之脉北');
    expect(shape).toBeGreaterThan(0); // 确实走到了 Dice 分支
    expect(shape).toBeLessThan(0.6); // 且被压在包含档之下
    expect(shape).toBeLessThan(nameSimilarity('龙脊山脉北麓', '龙脊山脉'));
  });

  it('字形档整体不超过 0.55 —— 这条上限是"档间不重叠"的全部依据', () => {
    // 构造一个 Dice 尽可能高的样本: 只差一个字，共享绝大多数二元组
    const almost = nameSimilarity('碎星群岛外', '碎星群岛内');
    expect(almost).toBeGreaterThan(0.3); // 字形上已经很像了
    expect(almost).toBeLessThanOrEqual(0.55); // 仍然进不了包含档
  });

  it('毫无共享字形时归零', () => {
    expect(nameSimilarity('碎星群岛', '碎冕冰脊')).toBe(0); // 二元组零交集
  });

  it('毫不相干的名字达不到门槛', () => {
    expect(nameSimilarity('铁炉堡', '深海大漩涡')).toBeLessThan(SCENE_MATCH_THRESHOLD);
  });
});

// ═══ buildLocationChain ═════════════════════════════════

describe('buildLocationChain', () => {
  it('路径本身就是层级: 由细到粗每段一级', () => {
    expect(buildLocationChain('大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德', NODES)).toEqual([
      { name: '艾瑟嘉德', depth: 0 },
      { name: '奥古斯提姆帝国', depth: 1 },
      { name: '大陆中东部区域', depth: 2 },
      // 帝国段(depth 1)在 location-db 里定位得到，它的大陆父级接在**它**之后 → depth 2，
      // 与路径里同为大陆级的「大陆中东部区域」平级，而不是被压到更深一层
      { name: '阿斯塔利亚大陆', depth: 2 },
    ]);
  });

  it('路径覆盖 location-db 没有的段（方位段/地貌名照样成级）', () => {
    const chain = buildLocationChain('大陆南部-龙脊山脉-熔火裂谷', NODES);
    expect(chain.map((l) => l.name)).toEqual(['熔火裂谷', '龙脊山脉', '大陆南部']);
  });

  it('location-db 祖先接在路径段之后，且不与路径重复', () => {
    // 路径最细段「贵族区」在 location-db 里定位不到，逐段上试才接得上地图
    const chain = buildLocationChain('铁炉堡-贵族区', NODES);
    expect(chain).toEqual([
      { name: '贵族区', depth: 0 },
      { name: '铁炉堡', depth: 1 },
      { name: '奥古斯提姆帝国', depth: 2 },
      { name: '阿斯塔利亚大陆', depth: 3 },
    ]);
  });

  it('链按深度有序（规范名虽后加入也要归位到 depth 0）', () => {
    const chain = buildLocationChain('铁炉堡的锻炉区', NODES);
    expect(chain.map((l) => l.depth)).toEqual([...chain.map((l) => l.depth)].sort((a, b) => a - b));
  });

  it('城市 → 势力 → 大陆，深度依次递增', () => {
    expect(buildLocationChain('铁炉堡', NODES)).toEqual([
      { name: '铁炉堡', depth: 0 },
      { name: '奥古斯提姆帝国', depth: 1 },
      { name: '阿斯塔利亚大陆', depth: 2 },
    ]);
  });

  it('输入名与 location-db 规范名同属 depth 0（模糊定位不算回退）', () => {
    const chain = buildLocationChain('铁炉堡的锻炉区', NODES);
    expect(chain.slice(0, 2)).toEqual([
      { name: '铁炉堡的锻炉区', depth: 0 },
      { name: '铁炉堡', depth: 0 },
    ]);
    expect(chain[2]).toEqual({ name: '奥古斯提姆帝国', depth: 1 });
  });

  it('地图上没有的地名只有自己一环 —— 不是失败，曲库可能按地貌命名', () => {
    expect(buildLocationChain('龙脊山脉', NODES)).toEqual([{ name: '龙脊山脉', depth: 0 }]);
  });

  it('空地点返回空链', () => {
    expect(buildLocationChain('   ', NODES)).toEqual([]);
  });

  it('parentId 断链时就地停止，不抛异常', () => {
    const broken: LocationNode[] = [
      {
        id: 'x',
        name: '孤儿城',
        type: 'city',
        parentId: 'nowhere',
        tier: 3,
        description: '',
        neighbors: [],
      },
    ];
    expect(buildLocationChain('孤儿城', broken)).toEqual([{ name: '孤儿城', depth: 0 }]);
  });

  it('parentId 成环时靠深度上限收敛（数据错误不该死循环）', () => {
    const cyclic: LocationNode[] = [
      {
        id: 'a',
        name: '甲地',
        type: 'area',
        parentId: 'b',
        tier: 1,
        description: '',
        neighbors: [],
      },
      {
        id: 'b',
        name: '乙地',
        type: 'area',
        parentId: 'a',
        tier: 1,
        description: '',
        neighbors: [],
      },
    ];
    const chain = buildLocationChain('甲地', cyclic);
    expect(chain.map((l) => l.name)).toEqual(['甲地', '乙地']); // 去重后自然收敛
  });
});

// ═══ splitLocationPath ══════════════════════════════════

describe('splitLocationPath', () => {
  it('正典七段路径拆成「由细到粗」的段序列', () => {
    expect(
      splitLocationPath('大陆中东部-帝国平原-奥古斯提姆帝国-北境行省-艾瑟嘉德-贵族区-锻炉大厅'),
    ).toEqual([
      '锻炉大厅',
      '贵族区',
      '艾瑟嘉德',
      '北境行省',
      '奥古斯提姆帝国',
      '帝国平原',
      '大陆中东部',
    ]);
  });

  it('单段输入原样返回（叙事里直接写的地名）', () => {
    expect(splitLocationPath('白曜城中央广场')).toEqual(['白曜城中央广场']);
  });

  it('认 getLocationPath 的斜杠格式', () => {
    expect(splitLocationPath('阿斯塔利亚大陆/奥古斯提姆帝国/铁炉堡')).toEqual([
      '铁炉堡',
      '奥古斯提姆帝国',
      '阿斯塔利亚大陆',
    ]);
  });

  it('空段与首尾空白被清掉', () => {
    expect(splitLocationPath(' 帝国 -- 艾瑟嘉德 -')).toEqual(['艾瑟嘉德', '帝国']);
  });

  it('绝不拿间隔号分段 —— 地名自己就带（诺瓦·瓦伦蒂亚城）', () => {
    expect(splitLocationPath('瓦伦蒂亚-诺瓦·瓦伦蒂亚城')).toEqual(['诺瓦·瓦伦蒂亚城', '瓦伦蒂亚']);
  });

  it('空串返回空数组', () => {
    expect(splitLocationPath('   ')).toEqual([]);
  });
});

// ═══ resolveSceneByTags · 地点维 ════════════════════════

describe('resolveSceneByTags · 地点维', () => {
  it('本地点直接命中，深度 0 不衰减', () => {
    const r = resolveSceneByTags(LIB, { location: '龙脊山脉' }, { nodes: NODES });
    expect(r?.track.id).toBe('drg_a');
    expect(r?.fallbackDepth).toBe(0);
    expect(r?.score).toBeCloseTo(SCENE_TAG_WEIGHTS.location);
  });

  it('子地点无曲目 → 回退到父级势力，分数按深度衰减', () => {
    const r = resolveSceneByTags(LIB, { location: '铁炉堡' }, { nodes: NODES });
    expect(r?.track.id).toBe('emp_a');
    expect(r?.resolvedLocation).toBe('奥古斯提姆帝国');
    expect(r?.fallbackDepth).toBe(1);
    expect(r?.score).toBeCloseTo(SCENE_TAG_WEIGHTS.location * LOCATION_DEPTH_DECAY);
  });

  it('正典七段路径: 逐段回退到势力段', () => {
    const r = resolveSceneByTags(
      LIB,
      { location: '大陆中东部-帝国平原-奥古斯提姆帝国-北境行省-艾瑟嘉德-贵族区-锻炉大厅' },
      { nodes: NODES },
    );
    expect(r?.track.id).toBe('emp_a');
    expect(r?.resolvedLocation).toBe('奥古斯提姆帝国');
    expect(r?.fallbackDepth).toBe(4);
  });

  it('路径里的地貌段照样命中（location-db 没有它也不影响）', () => {
    const r = resolveSceneByTags(LIB, { location: '大陆南部-龙脊山脉-熔火裂谷' }, { nodes: NODES });
    expect(r?.track.id).toBe('drg_a');
    expect(r?.resolvedLocation).toBe('龙脊山脉');
    expect(r?.fallbackDepth).toBe(1);
  });

  it('曲名也是地点维的可比对值（没打标签的曲子不至于点不着）', () => {
    const byName = track('n1', '龙脊山脉', []);
    const r = resolveSceneByTags([byName], { location: '龙脊山脉' }, { nodes: NODES });
    expect(r?.track.id).toBe('n1');
  });

  it('整条链都没达标曲目 → null（由调用方决定保持还是停止）', () => {
    expect(resolveSceneByTags(LIB, { location: '阿兹哈尔' }, { nodes: NODES })).toBeNull();
  });
});

// ═══ resolveSceneByTags · 跨维度累计 ════════════════════

describe('resolveSceneByTags · 跨维度累计', () => {
  const AOXUE = track('aoxue', '傲雪·人物主题', ['人物:傲雪'], { createdAt: 2000 });
  const BATTLE = track('battle', '战斗·常规', ['情境:战斗', '情绪:激昂'], { createdAt: 2000 });
  const FULL: AudioTrack[] = [...LIB, AOXUE, BATTLE];

  it('地点很准时压过人物主题（depth 0 = 1.00 > 人物 0.55）', () => {
    const r = resolveSceneByTags(
      FULL,
      { location: '龙脊山脉', characters: ['傲雪'] },
      { nodes: NODES },
    );
    expect(r?.track.id).toBe('drg_a');
  });

  it('地点泛到第 3 级时人物主题接管（0.8³ = 0.512 < 0.55）', () => {
    const r = resolveSceneByTags(
      FULL,
      // 帝国段落在 depth 3: 锻炉大厅(0) 贵族区(1) 艾瑟嘉德(2) 帝国(3)
      { location: '大陆中东部-奥古斯提姆帝国-艾瑟嘉德-贵族区-锻炉大厅', characters: ['傲雪'] },
      { nodes: NODES },
    );
    expect(r?.track.id).toBe('aoxue');
    expect(r?.fallbackDepth).toBeNull(); // 人物主题不参与地点维
  });

  it('战斗情境从第 2 级起盖过地点曲（0.8² = 0.64 < 0.75）', () => {
    const r = resolveSceneByTags(
      FULL,
      { location: '奥古斯提姆帝国-艾瑟嘉德-贵族区', situations: ['战斗'] },
      { nodes: NODES },
    );
    expect(r?.track.id).toBe('battle');
    expect(r?.breakdown.situation).toBeCloseTo(SCENE_TAG_WEIGHTS.situation);
  });

  it('多维度同时命中时分数相加（地点 + 情绪）', () => {
    const r = resolveSceneByTags(LIB, { location: '龙脊山脉', moods: ['平静'] }, { nodes: NODES });
    expect(r?.track.id).toBe('drg_a');
    expect(r?.score).toBeCloseTo(SCENE_TAG_WEIGHTS.location + SCENE_TAG_WEIGHTS.mood);
    expect(r?.matchedTags).toContain('平静');
  });

  it('权重可按次覆盖 —— 把人物调高就能让人物主题反超', () => {
    const r = resolveSceneByTags(
      FULL,
      { location: '龙脊山脉', characters: ['傲雪'] },
      { nodes: NODES, weights: { character: 2 } },
    );
    expect(r?.track.id).toBe('aoxue');
  });

  it('每一维只跟自己那一维的标签比 —— 人物名不会去撞地点标签', () => {
    expect(resolveSceneByTags(FULL, { characters: ['龙脊山脉'] }, { nodes: NODES })).toBeNull();
  });

  it('无类型标签参与所有维度（用户手打的标签不该变成死标签）', () => {
    const loose = track('loose', '某某曲', ['雨夜']);
    expect(resolveSceneByTags([loose], { moods: ['雨夜'] }, { nodes: NODES })?.track.id).toBe(
      'loose',
    );
    expect(resolveSceneByTags([loose], { situations: ['雨夜'] }, { nodes: NODES })?.track.id).toBe(
      'loose',
    );
  });

  it('多个查询词取最佳单项，不累加 —— 免得标签打得多的曲子平白占便宜', () => {
    const many = track('many', '杂烩', ['情境:战斗', '情境:潜行'], { createdAt: 3000 });
    const one = track('one', '专一', ['情境:战斗'], { createdAt: 3000 });
    const r = resolveSceneByTags([many, one], { situations: ['战斗', '潜行'] }, { nodes: NODES });
    expect(r?.score).toBeCloseTo(SCENE_TAG_WEIGHTS.situation);
    expect(r?.track.id).toBe('many'); // 同分，按 id 升序稳定兜底
  });

  it('变体只是加分项，自己不足以让一首曲子入选', () => {
    const onlyMood = track('m', '夜曲', ['情绪:不安']);
    expect(resolveSceneByTags([onlyMood], { variant: 'B' }, { nodes: NODES })).toBeNull();
  });

  it('变体在同分时挑边', () => {
    const a = resolveSceneByTags(LIB, { location: '铁炉堡', variant: 'A' }, { nodes: NODES });
    const b = resolveSceneByTags(LIB, { location: '铁炉堡', variant: 'B' }, { nodes: NODES });
    expect(a?.track.id).toBe('emp_a');
    expect(b?.track.id).toBe('emp_b');
    expect(b?.breakdown.variant).toBeCloseTo(SCENE_TAG_WEIGHTS.variant);
  });
});

// ═══ resolveSceneByTags · 边界 ══════════════════════════

describe('resolveSceneByTags · 边界', () => {
  it('排除 missing 曲目 —— 选中它等于选了一次必然失败的播放', () => {
    const gone = track('drg_gone', '龙脊山脉（平静）', ['地点:龙脊山脉'], {
      missing: true,
      createdAt: 1,
      source: 'file',
    });
    const r = resolveSceneByTags([gone, DRAGON_A], { location: '龙脊山脉' }, { nodes: NODES });
    expect(r?.track.id).toBe('drg_a');
  });

  it('只在指定 kind 内选曲', () => {
    const sfx = track('sfx1', '龙脊山脉（音效）', ['地点:龙脊山脉'], { kind: 'sfx', createdAt: 1 });
    const pool = [sfx, DRAGON_A];
    expect(resolveSceneByTags(pool, { location: '龙脊山脉' }, { nodes: NODES })?.track.id).toBe(
      'drg_a',
    );
    expect(
      resolveSceneByTags(pool, { location: '龙脊山脉', kind: 'sfx' }, { nodes: NODES })?.track.id,
    ).toBe('sfx1');
  });

  it('全同分时答案与数组顺序无关（createdAt → id 稳定兜底）', () => {
    const a = track('zzz', 'X', ['地点:龙脊山脉'], { createdAt: 5 });
    const b = track('aaa', 'Y', ['地点:龙脊山脉'], { createdAt: 5 });
    const q = { location: '龙脊山脉' };
    expect(resolveSceneByTags([a, b], q, { nodes: NODES })?.track.id).toBe('aaa');
    expect(resolveSceneByTags([b, a], q, { nodes: NODES })?.track.id).toBe('aaa');
  });

  it('空曲库 / 空查询一律 null', () => {
    expect(resolveSceneByTags([], { location: '龙脊山脉' }, { nodes: NODES })).toBeNull();
    expect(resolveSceneByTags(LIB, {}, { nodes: NODES })).toBeNull();
    expect(resolveSceneByTags(LIB, { location: '' }, { nodes: NODES })).toBeNull();
  });

  it('默认使用真实 location-db（不传 nodes 也能沿帝国城市回退）', () => {
    const r = resolveSceneByTags(LIB, { location: '金谷城' });
    expect(r?.resolvedLocation).toBe('奥古斯提姆帝国');
    expect(r?.fallbackDepth).toBe(1);
  });
});

// ═══ 回归: 规范名深度（审查发现 ⑫）═══════════════════════

describe('buildLocationChain · 规范名深度', () => {
  const DEEP: LocationNode[] = [
    {
      id: 'r',
      name: '永夜盟约',
      type: 'region',
      parentId: null,
      tier: 2,
      description: '',
      neighbors: [],
    },
    {
      id: 'c',
      name: '诺克瓦罗斯',
      type: 'city',
      parentId: 'r',
      tier: 3,
      description: '',
      neighbors: [],
    },
  ];

  it('命中发生在较粗的段上时，规范名不得被提升到 depth 0', () => {
    // 最细段「地穴」地图上查不到，是「诺克瓦罗斯城」(depth 1) 才接上地图的
    const chain = buildLocationChain('永夜领-诺克瓦罗斯城-地穴', DEEP);
    const byName = new Map(chain.map((l) => [l.name, l.depth]));
    expect(byName.get('地穴')).toBe(0);
    expect(byName.get('诺克瓦罗斯')).toBe(1); // 规范名跟着命中段，不是 0
    expect(byName.get('诺克瓦罗斯')).toBeGreaterThan(byName.get('地穴')!);
  });

  it('最具体地点的专属曲不会输给城市级曲子', () => {
    const cave = track('cave', '地穴', ['地点:地穴'], { createdAt: 9 });
    const city = track('city', '诺克瓦罗斯', ['地点:诺克瓦罗斯'], { createdAt: 1 });
    const r = resolveSceneByTags(
      [city, cave],
      { location: '永夜领-诺克瓦罗斯城-地穴' },
      { nodes: DEEP },
    );
    // 修复前两者同为 1.00，靠 createdAt 兜底 → 城市曲赢；修复后地穴 depth 0 胜出
    expect(r?.track.id).toBe('cave');
    expect(r?.fallbackDepth).toBe(0);
  });
});
