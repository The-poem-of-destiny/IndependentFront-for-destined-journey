/**
 * map-path.ts — 混合通行图上的路径规划（纯函数，地图系统 v1 / 设计 §6）
 *
 * 装什么: `findPath(pack, from, to, { via?, avoid? })` → `MapRoute | null`。
 * 不装什么: 任何 I/O、任何缓存、任何随机、任何时钟；也**不做落位**（自由文本 → 地块是
 *           `map-index.ts` 的活）—— 本层只吃 tileId，出 tileId 与天数。
 *
 * ── 混合通行图（§6.1，裁定 §12-7「一张图，不做双档」）──────────────────────────
 *   节点 = `!impassable && water !== 'lake'` 的地块（湖块 v1 一律不可入；不可通行块整块
 *          剔出图，照 sample 页语义**连邻接都没有**）
 *   边   = pack `adjacency` ∪ `straits`（无向、去重、去自环），两端都得是节点
 *   海块**也是节点**：内建假设是「任何海岸叙事上总有船可乘」（船由 AI 叙），
 *   所以不做 `(地点, 交通方式)` 状态展开 —— 那是前代设计最大的复杂度来源。
 *
 * ── 代价模型（§6.2，逐边累计「时间」而不是累计「公里」）────────────────────────
 *     distKm(a→b) = hypot(centroid_a − centroid_b) × pack.kmPerPx
 *     陆→陆       : time = distKm × terrainFactor[terrain_b] / rates.land
 *     海→海       : time = distKm × 1.0                      / (nearSea | farSea, 看**终点**)
 *     陆↔海       : time = 上面按终点那一档算 ＋ embarkCost / rates.land（登/离船）
 *     days        = ceil(Σ time)；含边的路径**至少 1 天**；`from === to` 时 0 天
 *
 * 🔴 累计的是**时间，不是距离**。设计 §6.2 那行 `days = ceil(Σcost / rate)` 只在全程同一档
 *    费率时成立 —— 一条陆海混合路线上「陆行 30km/日」与「远洋 120km/日」各占一段，先把公里
 *    加起来再除任意一个 rate 都会算错，而且错出来的是个**看着很合理的数**（没有任何断言会红）。
 * 🔴 `days` 只在全程时间加完之后取**一次** ceil。逐段各自 ceil 再相加，会把三段各 0.4 天的
 *    路线算成 3 天 —— 同样是个看着合理的假答案。
 * 🔴 地形系数取**终点**地块的地形（§6.2 的 `edgeFactor(边类型, terrain_b)`）：走进沼泽的
 *    代价属于沼泽，不属于你出发时脚下那块平原。
 *
 * ── 「海」的判据（§3.4-1 换图零改码 + 结构闸门 `map-literals-gate.test.ts`）─────
 * 🔴 判据是 `tile.water === 'sea'`，**绝不是地形串**。写 `terrain === '近海'` 有两层错：
 *    它是中文字面量（闸门直接红），而且把包数据焊进引擎 —— 换一版地图那种地形改了名字，
 *    这行代码静默失效，海路开始按陆行计价。
 * 🔴 近海/远洋同理不来自词汇而是**推导**出来的：一块海只要在通行图里挨着任何一块陆地就算
 *    近海，否则算远洋（工具链就是按这个意思分的）。分类跑在**建好的通行图**上（可通行节点 +
 *    adjacency ∪ straits），不是 pack 原始邻接表，两个理由：
 *      · impassable 陆块整块不在图里 —— 一块只挨着不可通行山脊的海不该按近海计价，
 *        那条岸线根本没人上得去
 *      · 海峡是人工补的边（像素邻接看不见的那种）—— 若一块海只经海峡连着港口，它在寻路上
 *        就是「可登船的岸」，计价却按公海，会分裂成「能从这里上船，但价钱按远洋算」
 * 🔴 分类**与本次查询的 `avoid` 无关**：近海/远洋是地图的地理属性，不是这次查询的属性。
 *    让 avoid 参与分类，同一段海路在两次查询里就会有两个价格。
 *
 * ── 决定性（§10 性质测试钉这条）────────────────────────────────────────────────
 * 🔴 取最小时的平局按**地块 id 升序**（`shortestSegment` 里那句 `id < bestId`）。少了它，
 *    平局就退化成「`dist` 这个 Map 里谁先进来」= pack 里边的书写顺序 —— 换一版 pack 只要
 *    重排了 adjacency 的行，同代价的两条路线就会互换。而它们**天数完全相同**，没有一个天数
 *    断言会红，只有玩家会发现「同样的两点，这次绕另一边走」。
 * 🔴 松弛用严格 `<`（代价相等时保留先发现的那条）。配上上面那条判据，整个遍历序是确定的，
 *    所以「先发现」也是确定的 —— 不必再给前驱编第二套平局规则。
 *
 * ── 返回 `null` 的全部情形（一条也不许静默兜底成假路线）───────────────────────
 *    端点/途经点不在包里 · 端点/途经点是 impassable 或 lake · 端点/途经点在 `avoid` 里 ·
 *    任一段不连通 · **空包**（0 地块时上面第一条就命中，故不必特判 `isEmptyMapPack`）
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md` §6。
 */

import type { MapPack, MapRoute, MapTile, TravelRules } from './types-map';

// ═══════════════════════════════════════════════════════════
// 入参与兜底值
// ═══════════════════════════════════════════════════════════

/**
 * `findPath` 的可选旋钮（模块本地入参形状，先例 `image-quota.ts` 的 `QuotaInput`）。
 *
 * 🔴 两者都是**几行包装**，刻意不做成本向量 / 路线偏好 / k 条备选 —— 那是前代设计砍掉的
 *    东西（§1 非目标）。
 */
export interface FindPathOptions {
  /** 途经点：`from → via[0] → … → to` 逐段最短路串联，**顺序有意义** */
  via?: number[];
  /** 回避：这些地块当成不在图里（代价覆盖为 ∞ 的等价实现） */
  avoid?: number[];
}

/**
 * 未知地形的系数兜底 = **1.0**（§6.2「宁可漏不可猜」，先例 `image-world-tags`）。
 * 新地形忘了配系数，结果是「按平地算」而不是崩，也**不是 0** —— 0 会让穿越那种地形免费，
 * 且完全无声。
 */
const DEFAULT_TERRAIN_FACTOR = 1;

/** 费率/比例尺的兜底 = 恒等 1（口径同 `map-pack.ts` 的 `IDENTITY_RATE`） */
const IDENTITY_RATE = 1;

/** 海块档位 —— 由通行图推导，不是包字段（见文件头） */
type SeaKind = 'near' | 'far';

/** 建好的通行图（一次 `findPath` 用一份，纯函数不留缓存） */
interface TravelGraph {
  /** 节点 = 可通行且非湖的地块，按 id 索引 */
  nodes: Map<number, MapTile>;
  /** 邻接表，值按 id **升序**（决定性的一半） */
  neighbors: Map<number, number[]>;
  /** 只对海块有值 */
  seaKind: Map<number, SeaKind>;
}

/** 一段最短路的产物（天数还没取整 —— 取整只发生在全程加完之后） */
interface Segment {
  path: number[];
  timeDays: number;
}

// ═══════════════════════════════════════════════════════════
// 取值兜底（`coerceMapPack` 已经守住这些，但本层不假设包一定过了它）
// ═══════════════════════════════════════════════════════════

/**
 * 正数兜底。
 *
 * 🔴 为什么要在这里再守一遍：`findPath` 的入参是 `MapPack` 类型而不是「过了 coerce 的包」，
 *    测试夹具与将来的调用方都可以手搓一份。rate 为 0 时每条边都是 `Infinity`，
 *    `Math.ceil(Infinity)` 还是 `Infinity` —— 落到 UI 上是一段**没有天数**的路线；
 *    `kmPerPx` 为 0 则每段路免费，最短路退化成「边数最少」。两个方向都无声。
 */
function positiveOrIdentity(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : IDENTITY_RATE;
}

/** 非负兜底（`embarkCost` 用）：负的登船代价会造出负权边，Dijkstra 从此失去意义 */
function nonNegativeOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 地形系数：缺键 / 非有穷 / 负数 一律回退 1.0 */
function readTerrainFactor(rules: TravelRules, terrain: string): number {
  const raw = rules.terrainFactor[terrain];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TERRAIN_FACTOR;
}

// ═══════════════════════════════════════════════════════════
// 建图
// ═══════════════════════════════════════════════════════════

/** 是海（进图按水路计价） */
function isSeaTile(tile: MapTile): boolean {
  return tile.water === 'sea';
}

/**
 * 是陆（图里只剩海与陆两种节点 —— 湖已在建图时剔掉，所以 `water === null` 就是陆）。
 *
 * 🔴 刻意写成 `water === null` 而不是 `!isSeaTile(tile)`：将来包里多一种水域（河/内海/…）时，
 *    「不是海就是陆」会让它**静默变成一条岸线**，从而把邻接的公海升格成近海、整片海路降价。
 *    要求显式 `null` 则新水域两边都不算，近海判据保守地不认它 —— 少一条便宜的海路看得见，
 *    凭空便宜的海路看不见。
 */
function isLandTile(tile: MapTile): boolean {
  return tile.water === null;
}

/** 节点集：剔掉不可通行块与湖块；重复 id 保第一条（口径同 `coerceTiles`） */
function collectNodes(pack: MapPack): Map<number, MapTile> {
  const nodes = new Map<number, MapTile>();
  for (const tile of pack.tiles) {
    if (tile.impassable) continue;
    if (tile.water === 'lake') continue;
    if (nodes.has(tile.id)) continue;
    nodes.set(tile.id, tile);
  }
  return nodes;
}

/**
 * 邻接表 = `adjacency` ∪ `straits`。
 *
 * 用 Set 承接：两张表**刻意不交叉去重**（`coerceStraits` 那条注释），重复一条边在这里必须是
 * 幂等的。
 *
 * 排序是**第二道保险**，不是决定性的承力件 —— 变异测试实测：只把这个 `.sort()` 拆掉，全部
 * 用例照样绿（真正扛决定性的是 `shortestSegment` 里那条 `id < bestId` 平局判据 + 松弛用严格
 * `<`，两者各有专门用例逼出来）。留着它是因为它把图规范化了：邻接遍历序不再等于 pack 里边的
 * 书写顺序，将来谁改动了取最小或松弛的策略，也不会顺带把「换一版 pack 就换一条路线」带回来。
 */
function collectNeighbors(pack: MapPack, nodes: Map<number, MapTile>): Map<number, number[]> {
  const sets = new Map<number, Set<number>>();

  const link = (a: number, b: number): void => {
    if (a === b) return;
    if (!nodes.has(a) || !nodes.has(b)) return;
    let sa = sets.get(a);
    if (sa === undefined) {
      sa = new Set<number>();
      sets.set(a, sa);
    }
    sa.add(b);
    let sb = sets.get(b);
    if (sb === undefined) {
      sb = new Set<number>();
      sets.set(b, sb);
    }
    sb.add(a);
  };

  for (const [a, b] of pack.adjacency) link(a, b);
  for (const [a, b] of pack.straits) link(a, b);

  const neighbors = new Map<number, number[]>();
  for (const [id, set] of sets)
    neighbors.set(
      id,
      [...set].sort((x, y) => x - y),
    );
  return neighbors;
}

/** 近海 = 在通行图里挨着至少一块陆地；否则远洋（推导，不读包字段 —— 理由见文件头） */
function classifySeaKinds(
  nodes: Map<number, MapTile>,
  neighbors: Map<number, number[]>,
): Map<number, SeaKind> {
  const out = new Map<number, SeaKind>();
  for (const [id, tile] of nodes) {
    if (!isSeaTile(tile)) continue;
    const coastal = (neighbors.get(id) ?? []).some((other) => {
      const neighbor = nodes.get(other);
      return neighbor !== undefined && isLandTile(neighbor);
    });
    out.set(id, coastal ? 'near' : 'far');
  }
  return out;
}

function buildGraph(pack: MapPack): TravelGraph {
  const nodes = collectNodes(pack);
  const neighbors = collectNeighbors(pack, nodes);
  return { nodes, neighbors, seaKind: classifySeaKinds(nodes, neighbors) };
}

// ═══════════════════════════════════════════════════════════
// 边代价
// ═══════════════════════════════════════════════════════════

/** 两块地形心之间的公里数 */
function distanceKm(pack: MapPack, from: MapTile, to: MapTile): number {
  const dx = to.centroid[0] - from.centroid[0];
  const dy = to.centroid[1] - from.centroid[1];
  return Math.hypot(dx, dy) * positiveOrIdentity(pack.kmPerPx);
}

/**
 * 一条边花几天（模型全文见文件头）。
 *
 * 三档合成一个函数、按**终点**分档，是为了让陆↔海那条混合边不必单列一套公式：
 * 它的移动部分就是「照终点那一档走这段距离」，登/离船只是在上面加一笔固定代价。
 * 分开写的败法是两处各改一半（比如给海路调了费率，忘了改混合边里抄的那一份）。
 */
function edgeTimeDays(pack: MapPack, graph: TravelGraph, from: MapTile, to: MapTile): number {
  const rates = pack.travelRules.rates;
  const distKm = distanceKm(pack, from, to);

  let time: number;
  if (isSeaTile(to)) {
    // 水路系数恒 1.0：海面没有地形（terrain 那格是包给海块起的名字，不参与计价）
    const seaRate = graph.seaKind.get(to.id) === 'far' ? rates.farSea : rates.nearSea;
    time = distKm / positiveOrIdentity(seaRate);
  } else {
    const factor = readTerrainFactor(pack.travelRules, to.terrain);
    time = (distKm * factor) / positiveOrIdentity(rates.land);
  }

  // 跨越水陆界 = 登船或离船。固定代价是**公里**，按陆行费率折成天数
  if (isSeaTile(from) !== isSeaTile(to)) {
    time += nonNegativeOrZero(pack.travelRules.embarkCost) / positiveOrIdentity(rates.land);
  }
  return time;
}

// ═══════════════════════════════════════════════════════════
// 单段 Dijkstra
// ═══════════════════════════════════════════════════════════

/**
 * `from → to` 的最短（时间）路径。不连通返回 `null`。
 *
 * 🔴 用 O(V²) 的线性取最小而不是二叉堆：地图是几百块的量级（首发包 316 块），而堆的**平局
 *    顺序取决于实现细节**（siftDown 的左右选择），那正是文件头说的「换一版 pack 路线就变脸、
 *    且没有断言会红」。线性扫描可以把平局判据写成一行看得见的 `id < bestId`。
 * 🔴 松弛用严格 `<`：代价相等时保留**先发现**的那条。配上「按 id 升序取最小 + 邻接按 id
 *    升序遍历」，整个遍历序是完全确定的，所以「先发现」也是确定的 —— 不需要再给前驱额外
 *    编一套平局规则（多一套规则就多一处会漂移的地方）。
 */
function shortestSegment(
  pack: MapPack,
  graph: TravelGraph,
  fromId: number,
  toId: number,
  avoid: ReadonlySet<number>,
): Segment | null {
  if (fromId === toId) return { path: [fromId], timeDays: 0 };

  const dist = new Map<number, number>([[fromId, 0]]);
  const prev = new Map<number, number>();
  const settled = new Set<number>();

  for (;;) {
    let bestId: number | null = null;
    let bestDist = Infinity;
    for (const [id, d] of dist) {
      if (settled.has(id)) continue;
      if (bestId === null || d < bestDist || (d === bestDist && id < bestId)) {
        bestId = id;
        bestDist = d;
      }
    }
    if (bestId === null) return null; // 可达集合走完了，终点不在里面
    if (bestId === toId) break;

    settled.add(bestId);
    const current = graph.nodes.get(bestId);
    if (current === undefined) continue; // 理论不可达（dist 只装节点），保守跳过

    for (const nextId of graph.neighbors.get(bestId) ?? []) {
      if (settled.has(nextId) || avoid.has(nextId)) continue;
      const next = graph.nodes.get(nextId);
      if (next === undefined) continue;
      const candidate = bestDist + edgeTimeDays(pack, graph, current, next);
      const known = dist.get(nextId);
      if (known === undefined || candidate < known) {
        dist.set(nextId, candidate);
        prev.set(nextId, bestId);
      }
    }
  }

  // 回溯（prev 链一定终止于 fromId —— 它是唯一没有前驱的已达节点）
  const path: number[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    const parent = prev.get(cursor);
    if (parent === undefined) return null;
    path.push(parent);
    cursor = parent;
  }
  path.reverse();
  return { path, timeDays: dist.get(toId) ?? 0 };
}

// ═══════════════════════════════════════════════════════════
// 途经名（`MapRoute.crossings`）
// ═══════════════════════════════════════════════════════════

/**
 * 途经的**名字**（不是 id —— §8.3：tileId 永不出现在 AI/UI 面前）。
 *
 * 每块地贡献一个名字，优先级 **中层 → 国家 → 地块自己的名字**：
 *   · 中层最贴近玩家说话的粒度（§8.1 本地一跳）
 *   · 两者都没有的块（公海、无主之地）就报自己的名字 —— 真实包里海也有中层
 *     （形如「某某海」），没有的那些至少还有块名。**不发明兜底文案**：一个中文占位串既是
 *     字面量（闸门红）、又是换图不跟着变的内容
 * 全局按首次出现去重：一条路线上「A→B→A」报 `[A, B]`，读起来才像人话。
 */
function buildCrossings(pack: MapPack, tilePath: number[], nodes: Map<number, MapTile>): string[] {
  const midTierNames = new Map(pack.midTiers.map((row) => [row.id, row.name]));
  const countryNames = new Map(pack.countries.map((row) => [row.id, row.name]));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const tileId of tilePath) {
    const tile = nodes.get(tileId);
    if (tile === undefined) continue;
    const midTierName = tile.midTierId === null ? undefined : midTierNames.get(tile.midTierId);
    const countryName = tile.countryId === null ? undefined : countryNames.get(tile.countryId);
    const name = midTierName ?? countryName ?? tile.name;
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

/**
 * 混合通行图上的路径规划（§6）。
 *
 * `via` 逐段串联、顺序保持；`avoid` 里的地块当成不在图里。任一段不连通、或任一端点/途经点
 * 不可用（不在包里 / impassable / lake / 在 `avoid` 里）→ 整个查询返回 `null`。
 *
 * 🔴 端点校验必须**先**做：不校验的话，`from` 是一块湖时 Dijkstra 会诚实地报「不连通」，
 *    与「这条路真的走不通」混成同一个 `null` —— 而调用方对两者的处置不同（前者是输入错，
 *    后者是地图事实）。这里合并成 `null` 是**刻意**的（§6 只有一条结果形状），但至少
 *    保证不可用端点永远不会因为「恰好连通」而蒙出一条路线来。
 */
export function findPath(
  pack: MapPack,
  fromTileId: number,
  toTileId: number,
  opts: FindPathOptions = {},
): MapRoute | null {
  const graph = buildGraph(pack);
  const avoid = new Set(opts.avoid ?? []);

  const waypoints = [fromTileId, ...(opts.via ?? []), toTileId];
  for (const id of waypoints) {
    if (!graph.nodes.has(id)) return null;
    if (avoid.has(id)) return null;
  }

  const tilePath: number[] = [];
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const segment = shortestSegment(pack, graph, waypoints[i], waypoints[i + 1], avoid);
    if (segment === null) return null;
    // 接点去重：上一段的终点就是这一段的起点
    tilePath.push(...(tilePath.length === 0 ? segment.path : segment.path.slice(1)));
  }

  // 🔴 timeDays 沿**最终路径逐边重算**，不把各段 Dijkstra 总时按段相加：浮点加法
  //   不结合，(e1+e2)+(e3+e4) 与 ((e1+e2)+e3)+e4 会差出一个 ε，恰跨整数边界时
  //   ceil 会差 1 天（2026-08-15 CI 属性测试真机撞上：expected 115 / received 114）。
  //   逐边重算让 timeDays 与「沿 tilePath 顺序把每条边加一遍」逐字节同源——段内
  //   Dijkstra 的累积序本就是路径序，无 via 时两种算法本来就相同，有 via 时分组
  //   差异被这次重算抹掉。
  let totalTimeDays = 0;
  for (let i = 0; i + 1 < tilePath.length; i++) {
    const from = graph.nodes.get(tilePath[i]);
    const to = graph.nodes.get(tilePath[i + 1]);
    if (from !== undefined && to !== undefined) {
      totalTimeDays += edgeTimeDays(pack, graph, from, to);
    }
  }

  // 含边的路径至少 1 天（形心极近的两块地不该显示成「0 天到」）；原地不动是 0 天
  const days = tilePath.length <= 1 ? 0 : Math.max(1, Math.ceil(totalTimeDays));

  // timeDays 原样带出（原地不动归零，别把浮点噪声当时间）——出行方式预览在它上面乘倍率再取整
  return {
    tilePath,
    days,
    timeDays: tilePath.length <= 1 ? 0 : totalTimeDays,
    crossings: buildCrossings(pack, tilePath, graph.nodes),
  };
}
