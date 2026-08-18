/**
 * $location — 位置**拓扑查询**与注册表读取 (Geography Phase → 内容-引擎分离 D25①)
 *
 * 设计决策:
 * - 本模块只留 **schema + 纯函数 + 注册表读取**。具体地点（大陆/势力/城市/区位、
 *   它们的连通边与描述）是**内容**，住在 `data/content/locations.json`，由 content
 *   provider 灌进注册表的 `locations` 面（内容包安装时被 pack 分节顶替）。
 *   设计: `docs/planning/2026-08-05-content-engine-separation-design.md` D16 / D25①。
 * - LocationNode 同时承载树结构（parentId 层级）和图结构（neighbors 连通）。
 *   树用于层级浏览，图用于连通性查询。
 * - 本模块仅提供拓扑事实查询，不做路径规划/旅行时间计算——叙事 AI 的职责。
 * - 无效输入返回安全默认值，不抛异常。**注册表未就绪同样不抛**：`getLocationNodes()`
 *   返回空集合，所有查询在空集合上是良性的（查不到 = undefined / [] / ''）。
 *
 * 🔴 **9 个查询函数一概 `(nodes, …)` 参数式，本模块不缓存注册表读数**。
 * 注册表可在运行期被重灌（装包/卸载走 `setContentRegistry`），缓存一份就会让
 * 装完包的地图还是旧的——而那种漂移不报错，只是「怎么点都还是老地方」。
 */

import type { LocationNode, LocationEdge, TerrainType } from './types';
// 🔴 注册表**注入缝**（`content-registry-runtime.ts`），不是前端 store ——
// 这条边曾是「引擎 import 前端」的反向依赖，已于分层收口时翻正（缝由 content-store 的
// `setContentRegistry` 单点注入，先例 `map-runtime` / `random-event-runtime`）。
// 时序契约不变、也仍然是这里最要紧的一条：**惰性、按调用时刻读**，
// 引擎 import 的那一刻注册表多半还没灌注，所以下面 9 个查询函数一概 `(nodes, …)` 参数式，
// 本模块不把读数缓存成模块级常量。
// 全引擎只有本文件一处读它——audio-scene / MapPanel / $location 都经 `getLocationNodes()`。
import { getContentRegistry } from './content-registry-runtime';

// ========== 注册表读取（D16 / D25①） ==========

const LOCATION_TYPES: ReadonlySet<string> = new Set([
  'continent',
  'region',
  'city',
  'area',
  'point',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 一条边的结构校验。
 *
 * 🔴 `terrain` **只验类型不验取值**：`TerrainType` 是引擎侧的封闭中文枚举，而全仓
 * 没有任何一处对它做穷举分支（只在 `buildAdjacency` 里被原样搬运）。把没见过的
 * 地貌词当非法丢掉，代价是**整条连通边消失**、收益是零。
 */
function toLocationEdge(value: unknown): LocationEdge | null {
  if (!isRecord(value)) return null;
  if (typeof value.targetId !== 'string' || value.targetId.length === 0) return null;
  if (typeof value.terrain !== 'string' || value.terrain.length === 0) return null;
  if (typeof value.distance !== 'number' || !Number.isFinite(value.distance)) return null;
  const edge: LocationEdge = {
    targetId: value.targetId,
    terrain: value.terrain as TerrainType,
    distance: value.distance,
  };
  if (typeof value.fromDirection === 'string') edge.fromDirection = value.fromDirection;
  if (typeof value.toDirection === 'string') edge.toDirection = value.toDirection;
  return edge;
}

/** 一个节点的结构校验；形状不符返回 null（整个节点丢弃，不半信半疑地补默认值） */
function toLocationNode(value: unknown): LocationNode | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;
  if (typeof value.type !== 'string' || !LOCATION_TYPES.has(value.type)) return null;
  if (typeof value.tier !== 'number' || !Number.isFinite(value.tier)) return null;

  const parentId = typeof value.parentId === 'string' ? value.parentId : null;
  const description = typeof value.description === 'string' ? value.description : '';
  const rawNeighbors = Array.isArray(value.neighbors) ? value.neighbors : [];
  const neighbors: LocationEdge[] = [];
  for (const raw of rawNeighbors) {
    const edge = toLocationEdge(raw);
    if (edge) neighbors.push(edge);
  }

  return {
    id: value.id,
    name: value.name,
    type: value.type as LocationNode['type'],
    parentId,
    tier: value.tier,
    description,
    neighbors,
  };
}

/**
 * 把注册表 `locations` 面的任意值收成 `LocationNode[]`。
 *
 * 数组以外的一切（`undefined` = 该面未就绪 / 坏 JSON / pack 给错形状）→ 空数组；
 * 数组里形状不符的**逐项**丢弃，其余照常可用（一个坏节点不该让整张地图消失）。
 */
export function coerceLocationNodes(value: unknown): LocationNode[] {
  if (!Array.isArray(value)) return [];
  const out: LocationNode[] = [];
  for (const raw of value) {
    const node = toLocationNode(raw);
    if (node) out.push(node);
  }
  return out;
}

/**
 * 当前生效的地点集合（注册表 `locations` 面）。
 *
 * 🔴 **同步、永不抛、未就绪返回 `[]`**。这是「本模块 + audio-scene + MapPanel + $location」
 * 取地点数据的**唯一**入口；别在别处重新读一次注册表，那会让「装包后该看到新地图」
 * 这件事在一半的地方成立。
 */
export function getLocationNodes(): LocationNode[] {
  try {
    return coerceLocationNodes(getContentRegistry().locations);
  } catch {
    // 注册表读取自身永不抛（与 content-source 的注入缝同口径）
    return [];
  }
}

// ========== 邻接表构建 ==========

export function buildAdjacency(nodes: readonly LocationNode[]): Map<string, LocationEdge[]> {
  const adj = new Map<string, LocationEdge[]>();

  for (const node of nodes) {
    adj.set(node.id, []);
  }

  for (const node of nodes) {
    for (const edge of node.neighbors) {
      const list = adj.get(node.id);
      if (list && !list.some((e) => e.targetId === edge.targetId)) {
        list.push(edge);
      }

      const revList = adj.get(edge.targetId);
      if (revList && !revList.some((e) => e.targetId === node.id)) {
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

export function getLocationNode(
  nodes: readonly LocationNode[],
  id: string,
): LocationNode | undefined {
  if (!id) return undefined;
  return nodes.find((n) => n.id === id);
}

export function getLocationTier(node: LocationNode): number {
  return node.tier;
}

export function getChildren(nodes: readonly LocationNode[], parentId: string): LocationNode[] {
  if (!parentId) return [];
  return nodes.filter((n) => n.parentId === parentId);
}

export function getNeighbors(nodes: readonly LocationNode[], nodeId: string): LocationNode[] {
  const node = getLocationNode(nodes, nodeId);
  if (!node) return [];

  // Q-31: 与 areAdjacent / getEdge / buildAdjacency 同口径 —— 自己声明的邻居，
  // 加上「声明了通往我」的那些。只看单向会让 areAdjacent(a,b) 与 (b,a) 不一致。
  const seen = new Set<string>();
  const result: LocationNode[] = [];
  for (const edge of node.neighbors) {
    const neighbor = getLocationNode(nodes, edge.targetId);
    if (neighbor && !seen.has(neighbor.id)) {
      seen.add(neighbor.id);
      result.push(neighbor);
    }
  }
  for (const other of nodes) {
    if (other.id === nodeId || seen.has(other.id)) continue;
    if (other.neighbors.some((e) => e.targetId === nodeId)) {
      seen.add(other.id);
      result.push(other);
    }
  }
  return result;
}

export function getContinent(
  nodes: readonly LocationNode[],
  nodeId: string,
): LocationNode | undefined {
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

export function getLocationPath(nodes: readonly LocationNode[], nodeId: string): string {
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

/**
 * 找 from→to 的边 —— **邻接的唯一判据**（Q-31）。
 *
 * 起因：`buildAdjacency` 把 `neighbors` 双向对称化（A 声明了通往 B，B 也会拿到通往 A
 * 的反向边），而同一命名空间下的 `areAdjacent` / `getEdge` / `getNeighbors` 只看
 * 单向的 `node.neighbors`。同一个「两地相邻吗」的问题，问 `buildAdjacency` 出来的表
 * 和问这三个函数，答案可以不一样 —— 数据里只要有一行非对称就现形。
 *
 * 这里按**对称**收口（与 `buildAdjacency` 同口径）：先查正向，没有再查反向并镜像。
 * 不选「修数据 + 加断言」那条路是因为它把不变式压在数据上 —— 下一份地图数据、
 * 下一个工坊扩展包都得记得对称，而忘了的代价是路径查询静默单向。
 */
function findEdge(
  nodes: readonly LocationNode[],
  from: string,
  to: string,
): LocationEdge | undefined {
  const nodeFrom = getLocationNode(nodes, from);
  const forward = nodeFrom?.neighbors.find((e) => e.targetId === to);
  if (forward) return forward;

  // 反向边：镜像成「从 from 出发」的形状（targetId 换成 to，其余属性沿用）
  const nodeTo = getLocationNode(nodes, to);
  const backward = nodeTo?.neighbors.find((e) => e.targetId === from);
  return backward ? { ...backward, targetId: to } : undefined;
}

export function areAdjacent(nodes: readonly LocationNode[], a: string, b: string): boolean {
  return findEdge(nodes, a, b) !== undefined;
}

export function getEdge(
  nodes: readonly LocationNode[],
  from: string,
  to: string,
): LocationEdge | undefined {
  return findEdge(nodes, from, to);
}

// ========== $location Namespace ==========

/**
 * 🔴 命名空间里**不再有 `DEFAULT_LOCATIONS`**（D25①）：那是一份烤死在引擎里的内容常量。
 * 取而代之的是 `getLocationNodes`——每次调用现读注册表，装包/卸载即时生效。
 */
export const $location = {
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
} as const;
