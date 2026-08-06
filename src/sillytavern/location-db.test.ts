import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  coerceLocationNodes,
  getLocationNodes,
  buildAdjacency,
  getLocationNode,
  getLocationTier,
  getChildren,
  getNeighbors,
  getContinent,
  getLocationPath,
  areAdjacent,
  getEdge,
  $location,
} from './location-db';
import { getContentRegistry, setContentRegistry } from '@ui/stores/content-store';
import type { LocationNode } from './types';

/**
 * 🔴 本文件**不断言任何真实地名/势力名**（D25①）。
 *
 * 地点数据已抽进 `data/content/locations.json`，由内容注册表灌进来——内容包一装，
 * 整张地图就换了。断言真实地名等于把「哪份内容装着」写进引擎测试：今天绿、装完包红，
 * 而红的那一条什么 bug 都没抓到。这里断言的是**查询与图算法的行为**，
 * 数据一律来自下面这张 fixture 图。
 */

// ═══════════════════════════════════════════════════════════
// fixture 图（形状覆盖：四层树 / 双向边 / 单向边 / 悬空边 / 孤立节点）
// ═══════════════════════════════════════════════════════════

/**
 * ```
 * cont_a (continent, tier 1)
 * ├── reg_n (region, tier 2)  ──平原/2──> reg_s        （单向声明，反向靠镜像成立）
 * │   ├── city_hub  (city, tier 3) ──平原/3──> city_port
 * │   │                            ──海洋/7──> city_ghost（悬空：目标不存在）
 * │   ├── city_port (city, tier 3) 无声明边（只被 hub 指向）
 * │   └── city_idle (city, tier 3) 完全孤立
 * └── reg_s (region, tier 2)
 *     └── city_far (city, tier 3)
 *         └── area_deep (area, tier 4)
 * ```
 */
function makeFixture(): LocationNode[] {
  return [
    {
      id: 'cont_a',
      name: '测试大陆',
      type: 'continent',
      parentId: null,
      tier: 1,
      description: '拓扑 fixture 的根',
      neighbors: [],
    },
    {
      id: 'reg_n',
      name: '北方区域',
      type: 'region',
      parentId: 'cont_a',
      tier: 2,
      description: '',
      neighbors: [
        { targetId: 'reg_s', terrain: '平原', distance: 2, fromDirection: '北', toDirection: '南' },
      ],
    },
    {
      id: 'reg_s',
      name: '南方区域',
      type: 'region',
      parentId: 'cont_a',
      tier: 2,
      description: '',
      neighbors: [],
    },
    {
      id: 'city_hub',
      name: '枢纽城',
      type: 'city',
      parentId: 'reg_n',
      tier: 3,
      description: '',
      neighbors: [
        {
          targetId: 'city_port',
          terrain: '平原',
          distance: 3,
          fromDirection: '东',
          toDirection: '西',
        },
        { targetId: 'city_ghost', terrain: '海洋', distance: 7 },
      ],
    },
    {
      id: 'city_port',
      name: '港口城',
      type: 'city',
      parentId: 'reg_n',
      tier: 3,
      description: '',
      neighbors: [],
    },
    {
      id: 'city_idle',
      name: '孤立城',
      type: 'city',
      parentId: 'reg_n',
      tier: 3,
      description: '',
      neighbors: [],
    },
    {
      id: 'city_far',
      name: '远方城',
      type: 'city',
      parentId: 'reg_s',
      tier: 3,
      description: '',
      neighbors: [],
    },
    {
      id: 'area_deep',
      name: '深处区位',
      type: 'area',
      parentId: 'city_far',
      tier: 4,
      description: '',
      neighbors: [],
    },
  ];
}

const NODES = makeFixture();

// ═══════════════════════════════════════════════════════════
// 注册表读取（D25①：数据来自注册表，不是模块常量）
// ═══════════════════════════════════════════════════════════

describe('coerceLocationNodes', () => {
  it('数组以外的一切都收成空集合（未就绪 / 坏 JSON / pack 给错形状）', () => {
    expect(coerceLocationNodes(undefined)).toEqual([]);
    expect(coerceLocationNodes(null)).toEqual([]);
    expect(coerceLocationNodes('nodes')).toEqual([]);
    expect(coerceLocationNodes({ nodes: NODES })).toEqual([]);
  });

  it('原样收下合法节点', () => {
    expect(coerceLocationNodes(NODES)).toEqual(NODES);
  });

  it('🔴 逐项丢弃形状不符的节点，其余照常可用（一个坏节点不该让整张地图消失）', () => {
    const out = coerceLocationNodes([
      NODES[0],
      null,
      { id: '', name: '空 id', type: 'city', parentId: null, tier: 1, neighbors: [] },
      { id: 'x', name: '', type: 'city', parentId: null, tier: 1, neighbors: [] },
      { id: 'y', name: '坏类型', type: 'planet', parentId: null, tier: 1, neighbors: [] },
      { id: 'z', name: '坏 tier', type: 'city', parentId: null, tier: 'high', neighbors: [] },
      NODES[1],
    ]);
    expect(out.map((n) => n.id)).toEqual(['cont_a', 'reg_n']);
  });

  it('缺省字段补安全默认值：description → 空串，parentId 非字符串 → null，neighbors 缺省 → []', () => {
    const [node] = coerceLocationNodes([{ id: 'a', name: 'A', type: 'city', tier: 3 }]);
    expect(node).toEqual({
      id: 'a',
      name: 'A',
      type: 'city',
      parentId: null,
      tier: 3,
      description: '',
      neighbors: [],
    });
  });

  it('丢弃结构不符的边，节点本身保留', () => {
    const [node] = coerceLocationNodes([
      {
        id: 'a',
        name: 'A',
        type: 'city',
        parentId: null,
        tier: 3,
        description: '',
        neighbors: [
          { targetId: 'b', terrain: '平原', distance: 1 },
          { targetId: '', terrain: '平原', distance: 1 },
          { targetId: 'c', terrain: '平原', distance: 'far' },
          { targetId: 'd', distance: 1 },
          'nope',
        ],
      },
    ]);
    expect(node.neighbors).toEqual([{ targetId: 'b', terrain: '平原', distance: 1 }]);
  });

  it('🔴 没见过的地貌词照收 —— TerrainType 无人穷举，丢边只赔连通性', () => {
    const [node] = coerceLocationNodes([
      {
        id: 'a',
        name: 'A',
        type: 'city',
        parentId: null,
        tier: 3,
        description: '',
        neighbors: [{ targetId: 'b', terrain: '苔原', distance: 1 }],
      },
    ]);
    expect(node.neighbors[0].terrain).toBe('苔原');
  });
});

describe('getLocationNodes', () => {
  let saved: unknown;

  beforeEach(() => {
    saved = getContentRegistry().locations;
  });

  afterEach(() => {
    setContentRegistry({ ...getContentRegistry(), locations: saved });
  });

  it('🔴 注册表该面未就绪 → 空集合，不抛（所有查询在空集合上良性）', () => {
    setContentRegistry({ ...getContentRegistry(), locations: undefined });
    expect(getLocationNodes()).toEqual([]);
    expect(getLocationNode(getLocationNodes(), 'cont_a')).toBeUndefined();
    expect(getLocationPath(getLocationNodes(), 'cont_a')).toBe('');
  });

  it('灌注后即读得到', () => {
    setContentRegistry({ ...getContentRegistry(), locations: NODES });
    expect(getLocationNodes().map((n) => n.id)).toEqual(NODES.map((n) => n.id));
  });

  it('🔴 不缓存：重灌（装包/卸载）即时生效', () => {
    setContentRegistry({ ...getContentRegistry(), locations: NODES });
    expect(getLocationNodes()).toHaveLength(NODES.length);
    setContentRegistry({ ...getContentRegistry(), locations: [NODES[0]] });
    expect(getLocationNodes().map((n) => n.id)).toEqual(['cont_a']);
  });

  it('坏形状同样只回落空集合', () => {
    setContentRegistry({ ...getContentRegistry(), locations: { oops: true } });
    expect(getLocationNodes()).toEqual([]);
  });
});

// ========== buildAdjacency ==========

describe('buildAdjacency', () => {
  it('应返回包含所有节点 ID 为键的 Map', () => {
    const adj = buildAdjacency(NODES);
    for (const node of NODES) {
      expect(adj.has(node.id)).toBe(true);
    }
  });

  it('空地列表应返回空 Map', () => {
    expect(buildAdjacency([]).size).toBe(0);
  });

  it('单向声明的边会被对称化，方位随之互换', () => {
    const adj = buildAdjacency(NODES);
    const back = adj.get('reg_s')?.find((e) => e.targetId === 'reg_n');
    expect(back).toBeDefined();
    expect(back?.terrain).toBe('平原');
    expect(back?.distance).toBe(2);
    // 反向边的 from/to 是正向边的镜像
    expect(back?.fromDirection).toBe('南');
    expect(back?.toDirection).toBe('北');
  });

  it('悬空边（目标节点不存在）只留正向，不凭空造键', () => {
    const adj = buildAdjacency(NODES);
    expect(adj.get('city_hub')?.some((e) => e.targetId === 'city_ghost')).toBe(true);
    expect(adj.has('city_ghost')).toBe(false);
  });

  it('不应有重复边', () => {
    const adj = buildAdjacency(NODES);
    for (const [, edges] of adj) {
      const targets = edges.map((e) => e.targetId);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

// ========== getLocationNode ==========

describe('getLocationNode', () => {
  it('有效 ID 应返回正确的节点', () => {
    const node = getLocationNode(NODES, 'city_hub');
    expect(node).toBeDefined();
    expect(node?.name).toBe('枢纽城');
    expect(node?.type).toBe('city');
  });

  it('无效 ID 应返回 undefined', () => {
    expect(getLocationNode(NODES, 'nonexistent')).toBeUndefined();
  });

  it('空字符串应返回 undefined', () => {
    expect(getLocationNode(NODES, '')).toBeUndefined();
  });
});

// ========== getLocationTier ==========

describe('getLocationTier', () => {
  it('逐层返回节点自身的 tier', () => {
    expect(getLocationTier(getLocationNode(NODES, 'cont_a')!)).toBe(1);
    expect(getLocationTier(getLocationNode(NODES, 'reg_n')!)).toBe(2);
    expect(getLocationTier(getLocationNode(NODES, 'city_hub')!)).toBe(3);
    expect(getLocationTier(getLocationNode(NODES, 'area_deep')!)).toBe(4);
  });
});

// ========== getChildren ==========

describe('getChildren', () => {
  it('大陆的子节点是全部区域', () => {
    const children = getChildren(NODES, 'cont_a');
    expect(children.map((c) => c.id).sort()).toEqual(['reg_n', 'reg_s']);
  });

  it('区域的子节点是其下城市（不含孙辈）', () => {
    const children = getChildren(NODES, 'reg_n');
    expect(children.map((c) => c.id).sort()).toEqual(['city_hub', 'city_idle', 'city_port']);
  });

  it('叶子节点应无子节点', () => {
    expect(getChildren(NODES, 'area_deep').length).toBe(0);
  });

  it('空 parentId 应返回空数组', () => {
    expect(getChildren(NODES, '').length).toBe(0);
  });
});

// ========== getNeighbors ==========

describe('getNeighbors', () => {
  it('自己声明的邻居算数', () => {
    expect(getNeighbors(NODES, 'city_hub').map((n) => n.id)).toEqual(['city_port']);
  });

  it('🔴 「声明了通往我」的也算 —— 否则 areAdjacent 两个方向会不一致', () => {
    expect(getNeighbors(NODES, 'city_port').map((n) => n.id)).toEqual(['city_hub']);
    expect(getNeighbors(NODES, 'reg_s').map((n) => n.id)).toEqual(['reg_n']);
  });

  it('孤立节点应无邻居', () => {
    expect(getNeighbors(NODES, 'city_idle').length).toBe(0);
  });

  it('无效 nodeId 应返回空数组', () => {
    expect(getNeighbors(NODES, 'nonexistent').length).toBe(0);
  });
});

// ========== getContinent ==========

describe('getContinent', () => {
  it('城市应沿 parentId 追溯到大陆', () => {
    expect(getContinent(NODES, 'city_hub')?.id).toBe('cont_a');
  });

  it('更深的层级同样追溯得到', () => {
    expect(getContinent(NODES, 'area_deep')?.id).toBe('cont_a');
  });

  it('continent 自身应返回自身', () => {
    expect(getContinent(NODES, 'cont_a')?.id).toBe('cont_a');
  });

  it('无效 ID 应返回 undefined', () => {
    expect(getContinent(NODES, 'nonexistent')).toBeUndefined();
  });

  it('上溯不到 continent（父级断链）应返回 undefined', () => {
    const orphan: LocationNode[] = [
      {
        id: 'lost',
        name: '断链城',
        type: 'city',
        parentId: 'missing_parent',
        tier: 3,
        description: '',
        neighbors: [],
      },
    ];
    expect(getContinent(orphan, 'lost')).toBeUndefined();
  });
});

// ========== getLocationPath ==========

describe('getLocationPath', () => {
  it('逐级上溯拼出完整路径', () => {
    expect(getLocationPath(NODES, 'city_hub')).toBe('测试大陆/北方区域/枢纽城');
  });

  it('四层节点拼出四段', () => {
    expect(getLocationPath(NODES, 'area_deep')).toBe('测试大陆/南方区域/远方城/深处区位');
  });

  it('根节点只有自己一段', () => {
    expect(getLocationPath(NODES, 'cont_a')).toBe('测试大陆');
  });

  it('无效 ID 应返回空字符串', () => {
    expect(getLocationPath(NODES, 'nonexistent')).toBe('');
  });
});

// ========== areAdjacent ==========

describe('areAdjacent', () => {
  it('声明方向应相邻', () => {
    expect(areAdjacent(NODES, 'reg_n', 'reg_s')).toBe(true);
  });

  it('反方向同样相邻（镜像判据）', () => {
    expect(areAdjacent(NODES, 'reg_s', 'reg_n')).toBe(true);
  });

  it('无边相连应返回 false', () => {
    expect(areAdjacent(NODES, 'city_hub', 'city_idle')).toBe(false);
  });

  it('同一节点应返回 false', () => {
    expect(areAdjacent(NODES, 'city_hub', 'city_hub')).toBe(false);
  });

  it('无效节点应返回 false', () => {
    expect(areAdjacent(NODES, 'nonexistent', 'city_hub')).toBe(false);
  });
});

// ========== getEdge ==========

describe('getEdge', () => {
  it('相邻节点间的边应带地形和距离', () => {
    const edge = getEdge(NODES, 'reg_n', 'reg_s');
    expect(edge).toBeDefined();
    expect(edge?.terrain).toBe('平原');
    expect(edge?.distance).toBe(2);
  });

  it('非声明方向取到的是镜像边（targetId 换成 to，其余沿用）', () => {
    const edge = getEdge(NODES, 'city_port', 'city_hub');
    expect(edge?.targetId).toBe('city_hub');
    expect(edge?.distance).toBe(3);
  });

  it('不相邻节点应返回 undefined', () => {
    expect(getEdge(NODES, 'city_hub', 'city_idle')).toBeUndefined();
  });
});

// ========== $location namespace ==========

describe('$location namespace', () => {
  it('应包含所有预期属性', () => {
    expect($location.getLocationNodes).toBe(getLocationNodes);
    expect($location.buildAdjacency).toBe(buildAdjacency);
    expect($location.getLocationNode).toBe(getLocationNode);
    expect($location.getLocationTier).toBe(getLocationTier);
    expect($location.getChildren).toBe(getChildren);
    expect($location.getNeighbors).toBe(getNeighbors);
    expect($location.getContinent).toBe(getContinent);
    expect($location.getLocationPath).toBe(getLocationPath);
    expect($location.areAdjacent).toBe(areAdjacent);
    expect($location.getEdge).toBe(getEdge);
  });

  it('🔴 命名空间里不再烤死数据常量（D25①）', () => {
    expect('DEFAULT_LOCATIONS' in $location).toBe(false);
  });

  it('应可通过 $location API 正常调用', () => {
    expect($location.getLocationNode(NODES, 'city_far')?.name).toBe('远方城');
    expect($location.getLocationPath(NODES, 'city_far')).toBe('测试大陆/南方区域/远方城');
  });
});

// ═══════════════════════════════════════════════════════════
// 邻接对称性闸门（Q-31）
// ═══════════════════════════════════════════════════════════

describe('邻接关系只有一套语义', () => {
  it('🔴 areAdjacent 对全表对称 —— a↔b 问哪个方向都得同一个答案', () => {
    // 起因：buildAdjacency 双向对称化，而 areAdjacent/getEdge/getNeighbors 只看单向。
    // 数据里只要有一行非对称，同一个「两地相邻吗」就有两个答案。
    for (const a of NODES) {
      for (const b of NODES) {
        expect(areAdjacent(NODES, a.id, b.id), `areAdjacent(${a.id}, ${b.id}) 与反向不一致`).toBe(
          areAdjacent(NODES, b.id, a.id),
        );
      }
    }
  });

  it('areAdjacent 与 buildAdjacency 的表同口径', () => {
    const adj = buildAdjacency(NODES);
    for (const node of NODES) {
      for (const edge of adj.get(node.id) ?? []) {
        expect(
          areAdjacent(NODES, node.id, edge.targetId),
          `邻接表说 ${node.id}→${edge.targetId} 相邻，areAdjacent 说不`,
        ).toBe(true);
      }
    }
  });

  it('getEdge 反向也取得到（镜像成从 from 出发的形状）', () => {
    const withEdge = NODES.find((n) => n.neighbors.length > 0);
    expect(withEdge).toBeDefined();
    const target = withEdge!.neighbors[0].targetId;
    const back = getEdge(NODES, target, withEdge!.id);
    expect(back).toBeDefined();
    expect(back!.targetId).toBe(withEdge!.id);
  });

  it('getNeighbors 与 areAdjacent 互不矛盾', () => {
    for (const node of NODES) {
      for (const n of getNeighbors(NODES, node.id)) {
        expect(areAdjacent(NODES, node.id, n.id)).toBe(true);
      }
    }
  });
});
