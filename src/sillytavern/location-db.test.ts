import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LOCATIONS,
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

// ========== DEFAULT_LOCATIONS ==========

describe('DEFAULT_LOCATIONS', () => {
  it('应包含至少 30 个节点（10 势力 + 城市）', () => {
    expect(DEFAULT_LOCATIONS.length).toBeGreaterThanOrEqual(30);
  });

  it('所有节点应有唯一的 id', () => {
    const ids = DEFAULT_LOCATIONS.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('应包含所有层级类型的节点', () => {
    const types = new Set(DEFAULT_LOCATIONS.map(n => n.type));
    expect(types.has('continent')).toBe(true);
    expect(types.has('region')).toBe(true);
    expect(types.has('city')).toBe(true);
    expect(types.has('area')).toBe(true);
  });

  it('所有节点应包含有效的 tier (1-5)', () => {
    for (const node of DEFAULT_LOCATIONS) {
      expect(node.tier).toBeGreaterThanOrEqual(1);
      expect(node.tier).toBeLessThanOrEqual(5);
    }
  });

  it('所有边引用的 targetId 应为有效节点', () => {
    const ids = new Set(DEFAULT_LOCATIONS.map(n => n.id));
    for (const node of DEFAULT_LOCATIONS) {
      for (const edge of node.neighbors) {
        expect(ids.has(edge.targetId), `${node.id} → ${edge.targetId} 不存在`).toBe(true);
      }
    }
  });

  it('应恰好有一个 continent 节点且 parentId 为 null', () => {
    const continents = DEFAULT_LOCATIONS.filter(n => n.type === 'continent');
    expect(continents.length).toBe(1);
    expect(continents[0].parentId).toBeNull();
  });

  it('应包含 10 个势力 (region)', () => {
    const regions = DEFAULT_LOCATIONS.filter(n => n.type === 'region');
    expect(regions.length).toBe(10);
  });

  it('所有 region 应归属于 continent', () => {
    const regions = DEFAULT_LOCATIONS.filter(n => n.type === 'region');
    for (const r of regions) {
      expect(r.parentId).toBe('continent_astalia');
    }
  });

  it('应包含世界书中的真实城市名称', () => {
    const names = new Set(DEFAULT_LOCATIONS.map(n => n.name));
    // 奥古斯提姆帝国
    expect(names.has('艾瑟嘉德')).toBe(true);
    expect(names.has('金谷城')).toBe(true);
    expect(names.has('铁炉堡')).toBe(true);
    expect(names.has('时钟塔城')).toBe(true);
    // 诺斯加德联盟
    expect(names.has('白曜城')).toBe(true);
    expect(names.has('琥珀加德')).toBe(true);
    // 萨赫拉联邦
    expect(names.has('阿兹哈尔')).toBe(true);
    // 瓦伦蒂亚
    expect(names.has('诺瓦·瓦伦蒂亚城')).toBe(true);
    // 索伦蒂斯
    expect(names.has('潮汐王座')).toBe(true);
    expect(names.has('银帆城')).toBe(true);
    // 兽族联盟
    expect(names.has('巡天王庭')).toBe(true);
  });

  it('不应包含编造的地点（北方冰原/东部海域/霜语城/珍珠港）', () => {
    const names = new Set(DEFAULT_LOCATIONS.map(n => n.name));
    expect(names.has('北方冰原')).toBe(false);
    expect(names.has('东部海域')).toBe(false);
    expect(names.has('霜语城')).toBe(false);
    expect(names.has('珍珠港')).toBe(false);
    expect(names.has('帝都')).toBe(false);
  });
});

// ========== buildAdjacency ==========

describe('buildAdjacency', () => {
  it('应返回包含所有节点 ID 为键的 Map', () => {
    const adj = buildAdjacency(DEFAULT_LOCATIONS);
    for (const node of DEFAULT_LOCATIONS) {
      expect(adj.has(node.id)).toBe(true);
    }
  });

  it('空地列表应返回空 Map', () => {
    expect(buildAdjacency([]).size).toBe(0);
  });

  it('帝国区域应有与其他势力的边', () => {
    const adj = buildAdjacency(DEFAULT_LOCATIONS);
    const edges = adj.get('region_augustim');
    expect(edges).toBeDefined();
    expect(edges!.length).toBeGreaterThanOrEqual(4); // 诺斯加德/萨赫拉/兽族/索伦蒂斯/瓦伦蒂亚
  });

  it('不应有重复边', () => {
    const adj = buildAdjacency(DEFAULT_LOCATIONS);
    for (const [, edges] of adj) {
      const targets = edges.map(e => e.targetId);
      expect(new Set(targets).size).toBe(targets.length);
    }
  });
});

// ========== getLocationNode ==========

describe('getLocationNode', () => {
  it('有效 ID 应返回正确的节点', () => {
    const node = getLocationNode(DEFAULT_LOCATIONS, 'city_aesergard');
    expect(node).toBeDefined();
    expect(node?.name).toBe('艾瑟嘉德');
  });

  it('无效 ID 应返回 undefined', () => {
    expect(getLocationNode(DEFAULT_LOCATIONS, 'nonexistent')).toBeUndefined();
  });

  it('空字符串 ID 应返回 undefined', () => {
    expect(getLocationNode(DEFAULT_LOCATIONS, '')).toBeUndefined();
  });
});

// ========== getLocationTier ==========

describe('getLocationTier', () => {
  it('continent 的 tier 应为 1', () => {
    const continent = getLocationNode(DEFAULT_LOCATIONS, 'continent_astalia')!;
    expect(getLocationTier(continent)).toBe(1);
  });

  it('region 的 tier 应为 2', () => {
    const region = getLocationNode(DEFAULT_LOCATIONS, 'region_augustim')!;
    expect(getLocationTier(region)).toBe(2);
  });

  it('city 的 tier 应为 3', () => {
    const city = getLocationNode(DEFAULT_LOCATIONS, 'city_aesergard')!;
    expect(getLocationTier(city)).toBe(3);
  });
});

// ========== getChildren ==========

describe('getChildren', () => {
  it('continent 应有 10 个 region 子节点', () => {
    const children = getChildren(DEFAULT_LOCATIONS, 'continent_astalia');
    expect(children.length).toBe(10);
    expect(children.every(c => c.type === 'region')).toBe(true);
  });

  it('奥古斯提姆帝国应有至少 5 个城市子节点', () => {
    const children = getChildren(DEFAULT_LOCATIONS, 'region_augustim');
    expect(children.length).toBeGreaterThanOrEqual(5);
    expect(children.every(c => c.type === 'city')).toBe(true);
  });

  it('无子节点的节点应返回空数组', () => {
    expect(getChildren(DEFAULT_LOCATIONS, 'city_vania').length).toBe(0);
  });

  it('空 parentId 应返回空数组', () => {
    expect(getChildren(DEFAULT_LOCATIONS, '').length).toBe(0);
  });
});

// ========== getNeighbors ==========

describe('getNeighbors', () => {
  it('金谷城应有与艾瑟嘉德相邻的邻居', () => {
    const neighbors = getNeighbors(DEFAULT_LOCATIONS, 'city_goldenvalley');
    const names = neighbors.map(n => n.name);
    expect(names).toContain('艾瑟嘉德');
  });

  it('帝国势力应有相邻的其他势力', () => {
    const neighbors = getNeighbors(DEFAULT_LOCATIONS, 'region_augustim');
    const names = neighbors.map(n => n.name);
    expect(names).toContain('诺斯加德联盟');
    expect(names).toContain('萨赫拉联邦');
    expect(names).toContain('兽族联盟');
    expect(names).toContain('索伦蒂斯王国');
    expect(names).toContain('瓦伦蒂亚');
  });

  it('大陆节点应无邻居', () => {
    expect(getNeighbors(DEFAULT_LOCATIONS, 'continent_astalia').length).toBe(0);
  });

  it('无效 nodeId 应返回空数组', () => {
    expect(getNeighbors(DEFAULT_LOCATIONS, 'nonexistent').length).toBe(0);
  });
});

// ========== getContinent ==========

describe('getContinent', () => {
  it('任何势力下的城市应追溯到大陆', () => {
    const continent = getContinent(DEFAULT_LOCATIONS, 'city_aesergard');
    expect(continent?.id).toBe('continent_astalia');
  });

  it('诺斯加德的城市应追溯到大陆', () => {
    const continent = getContinent(DEFAULT_LOCATIONS, 'city_whitegleam');
    expect(continent?.id).toBe('continent_astalia');
  });

  it('萨赫拉的城市应追溯到大陆', () => {
    const continent = getContinent(DEFAULT_LOCATIONS, 'city_azhar');
    expect(continent?.id).toBe('continent_astalia');
  });

  it('continent 自身应返回自身', () => {
    const continent = getContinent(DEFAULT_LOCATIONS, 'continent_astalia');
    expect(continent?.id).toBe('continent_astalia');
  });

  it('无效 ID 应返回 undefined', () => {
    expect(getContinent(DEFAULT_LOCATIONS, 'nonexistent')).toBeUndefined();
  });
});

// ========== getLocationPath ==========

describe('getLocationPath', () => {
  it('艾瑟嘉德的完整路径', () => {
    expect(getLocationPath(DEFAULT_LOCATIONS, 'city_aesergard'))
      .toBe('阿斯塔利亚大陆/奥古斯提姆帝国/艾瑟嘉德');
  });

  it('白曜城的完整路径', () => {
    expect(getLocationPath(DEFAULT_LOCATIONS, 'city_whitegleam'))
      .toBe('阿斯塔利亚大陆/诺斯加德联盟/白曜城');
  });

  it('璀璨之心的完整路径', () => {
    expect(getLocationPath(DEFAULT_LOCATIONS, 'area_emerald_core'))
      .toBe('阿斯塔利亚大陆/翡翠之心/璀璨之心');
  });

  it('无效 ID 应返回空字符串', () => {
    expect(getLocationPath(DEFAULT_LOCATIONS, 'nonexistent')).toBe('');
  });
});

// ========== areAdjacent ==========

describe('areAdjacent', () => {
  it('帝国与诺斯加德应相邻', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'region_augustim', 'region_norsgard')).toBe(true);
  });

  it('帝国与萨赫拉应相邻', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'region_augustim', 'region_sagela')).toBe(true);
  });

  it('梵尼亚与帝国通过飞艇相连', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'region_vania', 'region_augustim')).toBe(true);
  });

  it('不相邻的势力应返回 false', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'region_norsgard', 'region_sagela')).toBe(false);
  });

  it('同一节点应返回 false', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'city_aesergard', 'city_aesergard')).toBe(false);
  });

  it('无效节点应返回 false', () => {
    expect(areAdjacent(DEFAULT_LOCATIONS, 'nonexistent', 'city_aesergard')).toBe(false);
  });
});

// ========== getEdge ==========

describe('getEdge', () => {
  it('相邻势力间的边应有地形和距离', () => {
    const edge = getEdge(DEFAULT_LOCATIONS, 'region_augustim', 'region_norsgard');
    expect(edge).toBeDefined();
    expect(edge?.terrain).toBe('平原');
    expect(edge?.distance).toBe(2);
  });

  it('飞艇路线应有飞艇地形', () => {
    const edge = getEdge(DEFAULT_LOCATIONS, 'region_vania', 'region_augustim');
    expect(edge?.terrain).toBe('飞艇');
  });

  it('不相邻节点应返回 undefined', () => {
    expect(getEdge(DEFAULT_LOCATIONS, 'region_norsgard', 'region_sagela')).toBeUndefined();
  });
});

// ========== $location namespace ==========

describe('$location namespace', () => {
  it('应包含所有预期属性', () => {
    expect($location.DEFAULT_LOCATIONS).toBe(DEFAULT_LOCATIONS);
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

  it('应可通过 $location API 正常调用', () => {
    const node = $location.getLocationNode(DEFAULT_LOCATIONS, 'city_azhar');
    expect(node?.name).toBe('阿兹哈尔');

    const path = $location.getLocationPath(DEFAULT_LOCATIONS, 'city_tidethrone');
    expect(path).toBe('阿斯塔利亚大陆/索伦蒂斯王国/潮汐王座');
  });
});
