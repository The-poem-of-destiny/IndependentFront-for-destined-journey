/**
 * $location — 位置数据库与拓扑查询 (Geography Phase)
 *
 * 设计决策:
 * - 基于世界书真实地理数据（10 势力），静态嵌入，遵循 bloodlines.ts 模式。
 * - LocationNode 同时承载树结构（parentId 层级）和图结构（neighbors 连通）。
 *   树用于层级浏览，图用于连通性查询。
 * - 本模块仅提供拓扑事实查询，不做路径规划/旅行时间计算——叙事 AI 的职责。
 * - 势力间拓扑边来自世界书条目 #580370 [地理拓扑优化] + #626480 [长途移动与地理参考]。
 * - 无效输入返回安全默认值，不抛异常。
 */

import type { LocationNode, LocationEdge, TerrainType } from './types';

// ========== 默认世界地图 ==========

/**
 * 阿斯塔利亚大陆世界地图。
 *
 * 层级结构（树）:
 *   阿斯塔利亚大陆 (continent)
 *   ├── 奥古斯提姆帝国 (region)
 *   │   ├── 艾瑟嘉德 (city) — 首都
 *   │   ├── 金谷城 (city)
 *   │   ├── 铁炉堡 (city)
 *   │   ├── 时钟塔城 (city)
 *   │   ├── 暮林城 (city)
 *   │   └── 渡鸦港 (city)
 *   ├── 诺斯加德联盟 (region)
 *   │   ├── 白曜城 (city) — 首都
 *   │   ├── 琥珀加德 (city)
 *   │   ├── 林歌城 (city)
 *   │   └── 凛风渡 (city)
 *   ├── 萨赫拉联邦 (region)
 *   │   └── 阿兹哈尔 (city) — 首都
 *   ├── 赛瑞利亚 (region)
 *   │   └── 苍籁剧场 (area)
 *   ├── 翡翠之心 (region)
 *   │   └── 璀璨之心 (area)
 *   ├── 翼民圣都梵尼亚 (region)
 *   │   └── 圣都梵尼亚 (city)
 *   ├── 永夜盟约 (region)
 *   │   └── 诺克瓦罗斯 (city) — 异空间
 *   ├── 瓦伦蒂亚 (region)
 *   │   └── 诺瓦·瓦伦蒂亚城 (city)
 *   ├── 索伦蒂斯王国 (region)
 *   │   ├── 潮汐王座 (city) — 首都
 *   │   └── 银帆城 (city)
 *   └── 兽族联盟 (region)
 *       ├── 巡天王庭 (city) — 首都
 *       └── 恒风草原 (area)
 */

export const DEFAULT_LOCATIONS: LocationNode[] = [
  // ===== 大陆层 =====
  {
    id: 'continent_astalia',
    name: '阿斯塔利亚大陆',
    type: 'continent',
    parentId: null,
    tier: 1,
    description: '虚海中物理稳定的主位面，诸神间接干涉之地。中部为帝国平原，北接诺斯加德冰境，南临赤金沙海，西连兽族草原，东望索伦蒂斯海域',
    neighbors: [],
  },

  // ===== 势力层 (region) =====
  {
    id: 'region_augustim',
    name: '奥古斯提姆帝国',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '大陆最强盛的人类帝国，横跨东部大平原，温带大陆性气候。双头狮鹫纹章，中央集权行省制',
    neighbors: [
      { targetId: 'region_norsgard', terrain: '平原' as TerrainType, distance: 2, fromDirection: '北', toDirection: '南' },
      { targetId: 'region_sagela', terrain: '平原' as TerrainType, distance: 10, fromDirection: '南', toDirection: '北' },
      { targetId: 'region_beast', terrain: '平原' as TerrainType, distance: 14, fromDirection: '西', toDirection: '东' },
      { targetId: 'region_solenthis', terrain: '海洋' as TerrainType, distance: 1, fromDirection: '东', toDirection: '西' },
      { targetId: 'region_valentia', terrain: '河流' as TerrainType, distance: 1, fromDirection: '南', toDirection: '北' },
    ],
  },
  {
    id: 'region_norsgard',
    name: '诺斯加德联盟',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '北方 U 型大陆的贵族共和联盟。碎冕冰脊天险、苍白海内海、极寒至温润的气候梯度。霜狼契约宪法，5 公国 + 首都直辖区',
    neighbors: [
      { targetId: 'region_augustim', terrain: '平原' as TerrainType, distance: 2, fromDirection: '南', toDirection: '北' },
    ],
  },
  {
    id: 'region_sagela',
    name: '萨赫拉联邦',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '大陆南方赤金沙海的波斯阿拉伯文明。绿洲城邦 + 无垠沙海 + 鹰之山脉。工程学与炼金术高度发达，奴隶制商业城邦',
    neighbors: [
      { targetId: 'region_augustim', terrain: '平原' as TerrainType, distance: 10, fromDirection: '北', toDirection: '南' },
      { targetId: 'region_solenthis', terrain: '沙漠' as TerrainType, distance: 14, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'region_serilia',
    name: '赛瑞利亚',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '高空中珊瑚礁群——深蓝云海。妖精与人鱼混居的自治区，以音乐与情报交易闻名',
    neighbors: [
      { targetId: 'region_solenthis', terrain: '海洋' as TerrainType, distance: 2, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'region_emerald',
    name: '翡翠之心',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '大陆西南角的古老魔法森林。与世界树"翠梦乡之树"共生的巨大魔法生态系统。精灵文明艾尔文海姆的家园',
    neighbors: [
      { targetId: 'region_beast', terrain: '平原' as TerrainType, distance: 14, fromDirection: '北', toDirection: '南' },
      { targetId: 'region_valentia', terrain: '森林' as TerrainType, distance: 30, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'region_vania',
    name: '翼民圣都梵尼亚',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '神迹山脉主峰峰顶的翼民神权国。荣光女神崇拜，垂直礼制与空域秩序。92% 翼民人口',
    neighbors: [
      { targetId: 'region_augustim', terrain: '飞艇' as TerrainType, distance: 1, fromDirection: '下', toDirection: '上' },
    ],
  },
  {
    id: 'region_night',
    name: '永夜盟约',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '13 血族氏族的隐政府。首都诺克瓦罗斯位于悲鸣沼泽上空的独立空间折叠点，红月永悬。奉行同态复仇法与恩惠体系',
    neighbors: [
      { targetId: 'region_valentia', terrain: '沼泽' as TerrainType, distance: 2, fromDirection: '上', toDirection: '下' },
    ],
  },
  {
    id: 'region_valentia',
    name: '瓦伦蒂亚',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '雨林地区的冒险者公国。多国共管，议会决策，冒险经济繁荣。诺瓦尔河水运，监视"无尽地城"的桥头堡',
    neighbors: [
      { targetId: 'region_augustim', terrain: '河流' as TerrainType, distance: 1, fromDirection: '北', toDirection: '南' },
      { targetId: 'region_emerald', terrain: '森林' as TerrainType, distance: 30, fromDirection: '东', toDirection: '西' },
      { targetId: 'region_night', terrain: '沼泽' as TerrainType, distance: 2, fromDirection: '下', toDirection: '上' },
    ],
  },
  {
    id: 'region_solenthis',
    name: '索伦蒂斯王国',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '热带海洋性气候的人鱼双王制王国。潮汐王座为半潜式首都，金狮商会总部所在。大陆最大自由贸易区与洗钱中心',
    neighbors: [
      { targetId: 'region_augustim', terrain: '海洋' as TerrainType, distance: 1, fromDirection: '西', toDirection: '东' },
      { targetId: 'region_sagela', terrain: '沙漠' as TerrainType, distance: 14, fromDirection: '东', toDirection: '西' },
      { targetId: 'region_serilia', terrain: '海洋' as TerrainType, distance: 2, fromDirection: '东', toDirection: '西' },
    ],
  },
  {
    id: 'region_beast',
    name: '兽族联盟',
    type: 'region',
    parentId: 'continent_astalia',
    tier: 2,
    description: '大陆中西部的草原帝国。游牧部落联邦，巡天巨兽背上的移动首都。8 大区域，多样兽族部族',
    neighbors: [
      { targetId: 'region_augustim', terrain: '平原' as TerrainType, distance: 14, fromDirection: '东', toDirection: '西' },
      { targetId: 'region_emerald', terrain: '平原' as TerrainType, distance: 14, fromDirection: '南', toDirection: '北' },
    ],
  },

  // ===== 城市层 (city) — 奥古斯提姆帝国 =====
  {
    id: 'city_aesergard',
    name: '艾瑟嘉德',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '帝国首都"永恒辉光之城"。白金拱桥横跨天穹，浮空符文，皇宫与贵族区所在',
    neighbors: [
      { targetId: 'city_goldenvalley', terrain: '平原' as TerrainType, distance: 3, fromDirection: '东', toDirection: '西' },
      { targetId: 'city_ironforge', terrain: '平原' as TerrainType, distance: 7, fromDirection: '西', toDirection: '东' },
      { targetId: 'city_clocktower', terrain: '平原' as TerrainType, distance: 10, fromDirection: '南', toDirection: '北' },
      { targetId: 'city_ravenport', terrain: '平原' as TerrainType, distance: 14, fromDirection: '东', toDirection: '西' },
    ],
  },
  {
    id: 'city_goldenvalley',
    name: '金谷城',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '维里迪斯省省会，帝国最大粮食集散地与商贸城。金穗大粮仓与运河贸易繁荣',
    neighbors: [
      { targetId: 'city_aesergard', terrain: '平原' as TerrainType, distance: 3, fromDirection: '西', toDirection: '东' },
      { targetId: 'city_windmill', terrain: '平原' as TerrainType, distance: 2, fromDirection: '东', toDirection: '西' },
    ],
  },
  {
    id: 'city_ironforge',
    name: '铁炉堡',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '驰原省省会，帝国最大军事堡垒与冶炼中心。城如战争机器，对抗兽族联盟的最前线',
    neighbors: [
      { targetId: 'city_aesergard', terrain: '平原' as TerrainType, distance: 7, fromDirection: '东', toDirection: '西' },
      { targetId: 'city_redleaf', terrain: '平原' as TerrainType, distance: 7, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'city_clocktower',
    name: '时钟塔城',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '辰钟省省会，魔法之都与魔导研究中心。97m 魔法钟楼，法师公会总部所在',
    neighbors: [
      { targetId: 'city_aesergard', terrain: '平原' as TerrainType, distance: 10, fromDirection: '北', toDirection: '南' },
      { targetId: 'city_nova_valentia', terrain: '河流' as TerrainType, distance: 1, fromDirection: '北', toDirection: '南' },
    ],
  },
  {
    id: 'city_duskwood',
    name: '暮林城',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '红丘省省会，红松林资源丰富的林业城市。雾绕木建筑，畜牧农业发达',
    neighbors: [],
  },
  {
    id: 'city_ravenport',
    name: '渡鸦港',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '索莱尔省沿海商贸港口，帝国东大门。通往索伦蒂斯的海上枢纽',
    neighbors: [
      { targetId: 'city_aesergard', terrain: '平原' as TerrainType, distance: 14, fromDirection: '西', toDirection: '东' },
      { targetId: 'city_silverSail', terrain: '海洋' as TerrainType, distance: 1, fromDirection: '北', toDirection: '南' },
    ],
  },
  {
    id: 'city_windmill',
    name: '风车镇',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '金色麦海之中的酿酒中心，数十座风车林立。帝国最大的麦酒产地',
    neighbors: [
      { targetId: 'city_goldenvalley', terrain: '平原' as TerrainType, distance: 2, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'city_redleaf',
    name: '红叶镇',
    type: 'city',
    parentId: 'region_augustim',
    tier: 3,
    description: '驰原省军事前哨镇。梦境神爱梅斯教堂所在地，活藤缠绕的无人净化池',
    neighbors: [
      { targetId: 'city_ironforge', terrain: '平原' as TerrainType, distance: 7, fromDirection: '东', toDirection: '西' },
    ],
  },

  // ===== 城市层 — 诺斯加德联盟 =====
  {
    id: 'city_whitegleam',
    name: '白曜城',
    type: 'city',
    parentId: 'region_norsgard',
    tier: 3,
    description: '联盟首都，议会城堡坐落于王冠石台。凛冬大学所在地，文官考试制度',
    neighbors: [
      { targetId: 'city_ambergaard', terrain: '平原' as TerrainType, distance: 2, fromDirection: '东', toDirection: '西' },
      { targetId: 'city_linsong', terrain: '平原' as TerrainType, distance: 2, fromDirection: '西', toDirection: '东' },
      { targetId: 'city_windferry', terrain: '平原' as TerrainType, distance: 3, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'city_ambergaard',
    name: '琥珀加德',
    type: 'city',
    parentId: 'region_norsgard',
    tier: 3,
    description: '鎏金沃土的中心城市。金谷河麦带，帝国南部边境贸易枢纽',
    neighbors: [
      { targetId: 'city_whitegleam', terrain: '平原' as TerrainType, distance: 2, fromDirection: '西', toDirection: '东' },
    ],
  },
  {
    id: 'city_linsong',
    name: '林歌城',
    type: 'city',
    parentId: 'region_norsgard',
    tier: 3,
    description: '乌尔芬公国首都，铁木树冠之城。永恒暮光之下，铁木河岸建筑的奇观',
    neighbors: [
      { targetId: 'city_whitegleam', terrain: '平原' as TerrainType, distance: 2, fromDirection: '东', toDirection: '西' },
    ],
  },
  {
    id: 'city_windferry',
    name: '凛风渡',
    type: 'city',
    parentId: 'region_norsgard',
    tier: 3,
    description: '雾凇海岸的核心港口城市。狼喉海峡咽喉，盐雾航运要道',
    neighbors: [
      { targetId: 'city_whitegleam', terrain: '平原' as TerrainType, distance: 3, fromDirection: '东', toDirection: '西' },
    ],
  },

  // ===== 城市层 — 萨赫拉联邦 =====
  {
    id: 'city_azhar',
    name: '阿兹哈尔',
    type: 'city',
    parentId: 'region_sagela',
    tier: 3,
    description: '萨赫拉联邦政治首都，娱乐与艺术之都。烈阳大角斗场与千纱广场闻名大陆',
    neighbors: [
      { targetId: 'city_beitnar', terrain: '沙漠' as TerrainType, distance: 3, fromDirection: '南', toDirection: '北' },
      { targetId: 'city_darsuk', terrain: '沙漠' as TerrainType, distance: 3, fromDirection: '东', toDirection: '西' },
    ],
  },
  {
    id: 'city_beitnar',
    name: '拜特·纳尔',
    type: 'city',
    parentId: 'region_sagela',
    tier: 3,
    description: '金辉学府所在地，大陆顶级工程学院。沙漠中的科技中心',
    neighbors: [
      { targetId: 'city_azhar', terrain: '沙漠' as TerrainType, distance: 3, fromDirection: '北', toDirection: '南' },
    ],
  },
  {
    id: 'city_darsuk',
    name: '达尔·苏克',
    type: 'city',
    parentId: 'region_sagela',
    tier: 3,
    description: '军事要塞与奴隶贸易中心。砂岩堡垒，所有沙漠战士的摇篮',
    neighbors: [
      { targetId: 'city_azhar', terrain: '沙漠' as TerrainType, distance: 3, fromDirection: '西', toDirection: '东' },
    ],
  },

  // ===== 城市/区域层 — 赛瑞利亚 =====
  {
    id: 'area_serilia_hall',
    name: '苍籁剧场',
    type: 'area',
    parentId: 'region_serilia',
    tier: 4,
    description: '赛瑞利亚的中心——巨大螺旋海螺。人鱼与妖精展示才华、分享快乐的舞台。每年星见之月举办全大陆最盛大的演奏会',
    neighbors: [],
  },

  // ===== 城市/区域层 — 翡翠之心 =====
  {
    id: 'area_emerald_core',
    name: '璀璨之心',
    type: 'area',
    parentId: 'region_emerald',
    tier: 4,
    description: '翡翠之心最深处，世界树翠梦乡之树的所在地。翠梦白圣林环绕，艾尔文海姆倡议的精神核心',
    neighbors: [],
  },

  // ===== 城市层 — 翼民圣都梵尼亚 =====
  {
    id: 'city_vania',
    name: '圣都梵尼亚',
    type: 'city',
    parentId: 'region_vania',
    tier: 3,
    description: '神迹山脉主峰峰顶的云海巨都。白色石材垂直礼制建筑，荣光女神神殿、教皇座所在的浮岛圣域区悬浮于城市上空',
    neighbors: [],
  },

  // ===== 城市层 — 永夜盟约 =====
  {
    id: 'city_nokvaros',
    name: '诺克瓦罗斯',
    type: 'city',
    parentId: 'region_night',
    tier: 3,
    description: '红月永悬的哥特式宏伟都城。位于悲鸣沼泽上空的独立空间折叠点，需血匙方可进入。血之大圣堂与静默囚窟所在',
    neighbors: [],
  },

  // ===== 城市层 — 瓦伦蒂亚 =====
  {
    id: 'city_nova_valentia',
    name: '诺瓦·瓦伦蒂亚城',
    type: 'city',
    parentId: 'region_valentia',
    tier: 3,
    description: '冒险者之城——超大型要塞都市。运河水道纵横，冒险者公会总部所在。监视"无尽地城"的桥头堡',
    neighbors: [
      { targetId: 'city_clocktower', terrain: '河流' as TerrainType, distance: 1, fromDirection: '南', toDirection: '北' },
    ],
  },

  // ===== 城市层 — 索伦蒂斯王国 =====
  {
    id: 'city_tidethrone',
    name: '潮汐王座',
    type: 'city',
    parentId: 'region_solenthis',
    tier: 3,
    description: '索伦蒂斯首都——利用超巨型上古海龙遗骸与魔法力场构建的半潜式都市。人鱼双王共治的权力中心',
    neighbors: [
      { targetId: 'city_silverSail', terrain: '平原' as TerrainType, distance: 1, fromDirection: '南', toDirection: '北' },
    ],
  },
  {
    id: 'city_silverSail',
    name: '银帆城',
    type: 'city',
    parentId: 'region_solenthis',
    tier: 3,
    description: '巨大的深水良港，金狮商会总部所在地。大陆最大的自由贸易区',
    neighbors: [
      { targetId: 'city_tidethrone', terrain: '平原' as TerrainType, distance: 1, fromDirection: '北', toDirection: '南' },
      { targetId: 'city_ravenport', terrain: '海洋' as TerrainType, distance: 1, fromDirection: '南', toDirection: '北' },
    ],
  },

  // ===== 城市层 — 兽族联盟 =====
  {
    id: 'city_skyTitan',
    name: '巡天王庭',
    type: 'city',
    parentId: 'region_beast',
    tier: 3,
    description: '兽族联盟的移动首都——建于巡天巨兽背部。120km² 的活体城市，联盟贸易与政治中心',
    neighbors: [],
  },
];

// ========== 邻接表构建 ==========

export function buildAdjacency(nodes: LocationNode[]): Map<string, LocationEdge[]> {
  const adj = new Map<string, LocationEdge[]>();

  for (const node of nodes) {
    adj.set(node.id, []);
  }

  for (const node of nodes) {
    for (const edge of node.neighbors) {
      const list = adj.get(node.id);
      if (list && !list.some(e => e.targetId === edge.targetId)) {
        list.push(edge);
      }

      const revList = adj.get(edge.targetId);
      if (revList && !revList.some(e => e.targetId === node.id)) {
        revList.push({
          targetId: node.id,
          terrain: edge.terrain,
          distance: edge.distance,
          fromDirection: edge.toDirection,
          toDirection: edge.fromDirection,
        });
      }
    }
  }

  return adj;
}

// ========== 查询函数 ==========

export function getLocationNode(nodes: LocationNode[], id: string): LocationNode | undefined {
  if (!id) return undefined;
  return nodes.find(n => n.id === id);
}

export function getLocationTier(node: LocationNode): number {
  return node.tier;
}

export function getChildren(nodes: LocationNode[], parentId: string): LocationNode[] {
  if (!parentId) return [];
  return nodes.filter(n => n.parentId === parentId);
}

export function getNeighbors(nodes: LocationNode[], nodeId: string): LocationNode[] {
  const node = getLocationNode(nodes, nodeId);
  if (!node) return [];

  const result: LocationNode[] = [];
  for (const edge of node.neighbors) {
    const neighbor = getLocationNode(nodes, edge.targetId);
    if (neighbor) result.push(neighbor);
  }
  return result;
}

export function getContinent(nodes: LocationNode[], nodeId: string): LocationNode | undefined {
  let current = getLocationNode(nodes, nodeId);
  if (!current) return undefined;

  let depth = 0;
  const maxDepth = 10;
  while (current && current.type !== 'continent' && depth < maxDepth) {
    if (!current.parentId) break;
    current = getLocationNode(nodes, current.parentId);
    depth++;
  }

  return current?.type === 'continent' ? current : undefined;
}

export function getLocationPath(nodes: LocationNode[], nodeId: string): string {
  const node = getLocationNode(nodes, nodeId);
  if (!node) return '';

  const parts: string[] = [node.name];
  let current: LocationNode | undefined = node;
  let depth = 0;
  const maxDepth = 10;

  while (current?.parentId && depth < maxDepth) {
    current = getLocationNode(nodes, current.parentId);
    if (current) parts.unshift(current.name);
    depth++;
  }

  return parts.join('/');
}

export function areAdjacent(nodes: LocationNode[], a: string, b: string): boolean {
  const nodeA = getLocationNode(nodes, a);
  if (!nodeA) return false;
  return nodeA.neighbors.some(e => e.targetId === b);
}

export function getEdge(nodes: LocationNode[], from: string, to: string): LocationEdge | undefined {
  const nodeFrom = getLocationNode(nodes, from);
  if (!nodeFrom) return undefined;
  return nodeFrom.neighbors.find(e => e.targetId === to);
}

// ========== $location Namespace ==========

export const $location = {
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
} as const;
