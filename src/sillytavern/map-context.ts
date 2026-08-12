/**
 * map-context.ts — 地图上下文的两个投影（纯函数，地图系统 v1 / 设计 §8.1）
 *
 * 装什么: 两个互不相干的投影，各自喂一个现成的消费者。
 *   · `buildMapSnapshot(pack, opts)` → `MapSnapshot`：当前地块 + 严格一跳邻接 + 在途摘要 +
 *     天气标签 + 不连通提示。这就是 `$map` 只读面的数据形状（§5），也是 `MAP_CONTEXT` 四类行
 *     的**唯一**事实来源。
 *   · `buildRuntimeGeoData(locations, currentLocationName)` → `RuntimeGeoData`：世界书
 *     `extra_setting` uid 446「长途移动与地理参考」那段 EJS 读的局部变量
 *     `runtime_geo_compact_data`。它从**旧语义图**（`LocationNode[]`，34 节点的城际尺度）投影，
 *     与上面那个地块尺度的快照**刻意并存**（§8.1-2：316 块地全塞进 Mermaid 会撑爆它的限流）。
 *
 * 不装什么: **一个字的中文散文**。这是本模块最容易被误解的一点 ——
 *   `MAP_CONTEXT` 那段「位置: … ｜地形: … / 邻接: 北→… / 旅行中: …」的中文文本**不在这里**，
 *   由两个各自被允许写中文的渲染器分别渲染（§8.1「送给谁」那张表 + 裁定 §12-9）：
 *     · app 仓的占位符注册表（`{{MAP_CONTEXT}}`，喂 request_dispatcher）
 *     · 内容仓的一条 constant EJS 世界书条目（喂 story —— story 有预设短路，占位符到不了它）
 *   同一份 `$map` 数据、两个渲染器：**数据不会漂，措辞可以漂**（措辞属创作层）。
 *   所以罗盘方位在这里是 ASCII 令牌（`MapCompass`，`'N'|'NE'|…`），渲染层拿它当查表键
 *   （`{ N: '北', … }`）。这条由结构闸门 `map-literals-gate.test.ts` 钉死（本文件禁 CJK 字面量），
 *   而闸门保护的正是「换图/换语言零改码」（§3.4-1）。
 *
 * 🔴 **纯函数、无 I/O、无时钟、无随机**（先例 `image-prompt.ts` / `craft-request.ts`）。
 *    尤其是**不读 `journey.arriveAtMinute`**：拿它算「还剩几天」需要当前时间，那是时钟。
 *    剩余天数一律由 `findPath(当前 → 目的地)` **按新位置重估** —— 这正是裁定 §12-7 附加那条
 *    「计划路线是 advisory，叙事偏离时按新位置重估，绝不 enforcement」的落点。
 *
 * 🔴 **严格本地一跳，只给名字**（裁定 §12-10 + §8.3 保护面）：快照里没有 tileId、没有像素
 *    坐标、没有两跳、没有国家清单、没有危险度。邻接的所有者**只在异主时**才出现
 *    （token 经济 —— 同国的邻块标一遍国名是纯浪费，而 4~8 邻接时那是一半的字）。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`
 * （§8.1 读侧载荷契约 / §5 `$map` 面 / §12-9·§12-10 裁定）。
 */

import type { MapCompass, MapIndex } from './map-index';
import { buildMapIndex, compassOf, countryOfTile, midTierOfTile } from './map-index';
import { findPath } from './map-path';
import type { LocationNode } from './types';
import type { MapJourneyFlag, MapPack, MapTile, MapWaterKind } from './types-map';

// ═══════════════════════════════════════════════════════════
// $map 快照（§5 / §8.1 载荷契约）
// ═══════════════════════════════════════════════════════════

/**
 * 当前地块的事实行。
 *
 * `midTierName` / `countryName` 为 `null` 的三种成因**刻意不区分**：这块地不属于任何中层 /
 * 无主之地 / 包里声明了一个查不到行的悬空 id。渲染层对三者的处置是同一个（那一格不写），
 * 而在这里区分开就得让渲染层也跟着分三支 —— 那是把「显示逻辑」变成「数据模型」。
 */
export interface MapSnapshotPlace {
  /** 地块名（AI 只见名字，§8.3） */
  name: string;
  /** 地形 —— 包词汇原文，本层不认识、不翻译、不校验 */
  terrain: string;
  water: MapWaterKind | null;
  impassable: boolean;
  midTierName: string | null;
  countryName: string | null;
}

/**
 * 一条邻接（严格一跳）。
 *
 * 🔴 `ownerName` **只在与当前地块异主时**才是非 null（§8.1 token 经济）。相等时给 null，
 *    渲染层因此不必自己比对 —— 「该不该标所有者」这个判断只存在一处。
 * 🔴 不可通行块与湖/海块**照样在列**（拓扑事实必须完整，见 `MapIndex.neighbors` 那条）：
 *    挡在西边的那道冰脊、东边那片要船才过得去的海，都是 AI 必须看见的事实。
 *    「剔掉不可通行块」是寻路图的事（`map-path.ts`），不是本层的事。
 */
export interface MapSnapshotNeighbor {
  name: string;
  terrain: string;
  /** 形心 → 形心的 8 方罗盘令牌（ASCII；中文说法归渲染层） */
  dir: MapCompass;
  water: MapWaterKind | null;
  impassable: boolean;
  /** 仅异主时非 null；同主、无主、悬空 id 一概 null */
  ownerName: string | null;
}

/**
 * 在途摘要（`worldFlags.map.journey` 的投影）。
 *
 * 🔴 三格里有两格可以是 `null`，而那**不是异常**：`nextName` 为 null = 玩家不在计划路线上
 *    （叙事偏离了，advisory 数据本就允许），`remainingDays` 为 null = 当前位置到目的地在
 *    混合通行图上无路（或者根本没落位）。两者都不该让在途摘要整段消失 —— 「在途，目的地 X」
 *    本身就是一条真事实。
 */
export interface MapSnapshotJourney {
  toName: string;
  nextName: string | null;
  remainingDays: number | null;
}

/**
 * `$map` 的只读快照 = `MAP_CONTEXT` 四类行的数据面。
 *
 * 空包 / 未落位时是 `{ current: null, neighbors: [] }` —— **合同不是异常**（`map-pack.ts`
 * 文件头那条「投影自愈」）：位置路径才是真源，地块只是投影，投影为空时游戏照常进行，
 * 渲染层显示「未定位」。
 */
export interface MapSnapshot {
  current: MapSnapshotPlace | null;
  /**
   * 一跳邻接，**顺序稳定**。
   *
   * 🔴 顺序权威在 `map-index.buildNeighbors`（按 tileId 升序，与包里边的书写顺序无关），
   *    本层原样承接、不重排。理由写在那个函数的注释里：这段文本要进提示词，顺序稳定 =
   *    静态前缀字节稳定（ADR-30）。在这里按方位或名字再排一次，就是把「唯一的排序权威」
   *    变成两个 —— 而两处不一致时症状是提示词前缀每回合抖动，没人会想到是排序。
   */
  neighbors: MapSnapshotNeighbor[];
  journey: MapSnapshotJourney | null;
  /** 天气标签（包词汇原文，来自 `map-weather.weatherAt`）；`null` = 这一格不写 */
  weatherLabel: string | null;
  /**
   * 提示行的判据：非空 = 上一次移动落在了**不相邻**的地块（接线层在跨越发生时置 `1`，
   * 相邻的正常移动为 `null`）——与 `types-map.ts` / `state-manager` 的语义一致。
   *
   * 🔴 **只校验不否决**（裁定 §12-4）：目的地与出发地不连通时照常落位（AI 赢 —— 传送 /
   *    剧情跳转是合法叙事），只在下一回合的上下文里附一条提示。数字由接线层（W2）算好传进来，
   *    本层原样搬运 —— 它需要「上一次落位在哪」这个历史，而快照是无状态的。
   */
  discontinuity: number | null;
}

/** `buildMapSnapshot` 的入参（模块本地形状，先例 `map-path.FindPathOptions`） */
export interface MapSnapshotOptions {
  /** 当前地块（`worldFlags.map.lastTileId`）；`null` = 从未成功落位 */
  currentTileId: number | null;
  /** `variables.sys` 里那个天气标签串；`null` = 没有 */
  weatherLabel: string | null;
  /** 在途旗（`worldFlags.map.journey`，可缺席） */
  journey?: MapJourneyFlag | null;
  /** 不连通跳数（W2 供值）；缺席读作 `null` */
  discontinuity?: number | null;
}

/**
 * 包 + 可变状态 → `$map` 快照。
 *
 * 索引**每次现建**（`buildMapIndex` 没有缓存，见它的注释）：一回合一次、316 块地的量级，
 * 换来的是「包被热替换后快照立刻是新的」。缓存一份的败法是装完内容包地图还是旧的，而那不报错。
 */
export function buildMapSnapshot(pack: MapPack, opts: MapSnapshotOptions): MapSnapshot {
  const index = buildMapIndex(pack);
  const currentTile = resolveTile(index, opts.currentTileId);

  return {
    current: currentTile === null ? null : describeTile(index, currentTile),
    neighbors: currentTile === null ? [] : describeNeighbors(index, currentTile),
    journey: describeJourney(index, opts.journey ?? null, currentTile),
    weatherLabel: opts.weatherLabel,
    discontinuity: opts.discontinuity ?? null,
  };
}

/** id → 地块行；`null`（未落位）与查不到（包换了 / 悬空）走同一条出口 */
function resolveTile(index: MapIndex, tileId: number | null): MapTile | null {
  if (tileId === null || !Number.isFinite(tileId)) return null;
  return index.tileById.get(tileId) ?? null;
}

function describeTile(index: MapIndex, tile: MapTile): MapSnapshotPlace {
  return {
    name: tile.name,
    terrain: tile.terrain,
    water: tile.water,
    impassable: tile.impassable,
    midTierName: midTierOfTile(index, tile.id)?.name ?? null,
    countryName: countryOfTile(index, tile.id)?.name ?? null,
  };
}

/**
 * 一跳邻接行。
 *
 * 异主判据比的是**链上的国家 id**（`countryIdByTileId`，地块自有所有者优先、中层补链），
 * 不是解析出来的国家行 —— 悬空 id 查不到行，但它仍然是一个能判「异主」的稳定键。
 * 反过来（先解析成行再比名字）会让两块分属不同悬空国的地看着同主。
 */
function describeNeighbors(index: MapIndex, tile: MapTile): MapSnapshotNeighbor[] {
  const links = index.neighbors.get(tile.id) ?? [];
  const currentCountryId = index.countryIdByTileId.get(tile.id) ?? null;
  const rows: MapSnapshotNeighbor[] = [];
  const seen = new Set<number>();

  for (const link of links) {
    // 索引已去重、已剔悬空端点；这里是第二道（手搓的包与测试夹具不经解析器）
    if (link.tileId === tile.id || seen.has(link.tileId)) continue;
    const neighbor = index.tileById.get(link.tileId);
    if (neighbor === undefined) continue;
    seen.add(link.tileId);

    const neighborCountryId = index.countryIdByTileId.get(neighbor.id) ?? null;
    const sameOwner = neighborCountryId === currentCountryId;

    rows.push({
      name: neighbor.name,
      terrain: neighbor.terrain,
      dir: compassOf(tile.centroid, neighbor.centroid),
      water: neighbor.water,
      impassable: neighbor.impassable,
      ownerName: sameOwner ? null : (countryOfTile(index, neighbor.id)?.name ?? null),
    });
  }

  return rows;
}

/**
 * 在途摘要。
 *
 * 目的地地块查不到（包换版了 / 旗是别的包留下的）→ 整段 `null`：那时连目的地叫什么都说不出，
 * 硬造一行「前往（未知）」是把 packStamp 自愈（§3.4-2）该清掉的旧派生态讲成了当前事实。
 */
function describeJourney(
  index: MapIndex,
  flag: MapJourneyFlag | null,
  currentTile: MapTile | null,
): MapSnapshotJourney | null {
  if (flag === null) return null;
  const destination = resolveTile(index, flag.toTileId);
  if (destination === null) return null;

  return {
    toName: destination.name,
    nextName: nextStopName(index, flag.plannedPath, currentTile),
    remainingDays:
      currentTile === null
        ? null
        : (findPath(index.pack, currentTile.id, destination.id)?.days ?? null),
  };
}

/**
 * 计划路线上「当前之后的下一站」。
 *
 * 🔴 当前地块**不在** `plannedPath` 上时给 `null`，不去找「最近的那一段」—— 那就是在替叙事
 *    猜它走到哪了。计划路线是 advisory（裁定 §12-7 附加）：偏离时只失去「下一站」这一格，
 *    剩余天数照旧按新位置重估，这正是设计要的降级方式。
 */
function nextStopName(
  index: MapIndex,
  plannedPath: number[] | undefined,
  currentTile: MapTile | null,
): string | null {
  if (currentTile === null || plannedPath === undefined) return null;
  const at = plannedPath.indexOf(currentTile.id);
  if (at < 0 || at + 1 >= plannedPath.length) return null;
  const next = resolveTile(index, plannedPath[at + 1]);
  return next?.name ?? null;
}

// ═══════════════════════════════════════════════════════════
// runtime_geo_compact_data（uid 446 契约）
// ═══════════════════════════════════════════════════════════

/**
 * 地点的一句话说明。uid 446 的读法是 `description.brief || description.detail`，
 * 而 `LocationNode.description` 只有一格自由文本 —— 所以只填 `brief`，**不发明 `detail`**。
 */
export interface RuntimeGeoDescription {
  brief: string;
}

/**
 * 一个地点（uid 446 的 `places[]` 成员）。
 *
 * 🔴 契约里还有一个 `keywords?: string[]`（别名，参与它的名字匹配打分）——**刻意不产**：
 *    `LocationNode` 没有别名字段，凭空造一个空数组只是让消费方多跑一圈循环。
 *    「有源就传，无源就省」是本投影的通则（发明出来的别名会让它匹配到错的地方）。
 */
export interface RuntimeGeoPlace {
  id: string;
  name: string;
  /** 父地点 id；`null` = 根（大陆） */
  parent: string | null;
  /** 显著度，**越大越显著**（见 `importanceOfTier`——与 `tier` 的方向相反） */
  importance: number;
  description?: RuntimeGeoDescription;
}

/**
 * 一条路线的一段（uid 446 的 `segments[]` 成员）。
 *
 * 契约里还有 `transport?: string`（交通方式，进标签第一格）——**不产**：旧语义图里没有这个
 * 维度。唯一能拿来当它的是 `TerrainType` 里混进去的两个非地形值（城市 / 飞艇），而认出它们
 * 需要在本文件写下中文字面量 —— 那正是结构闸门禁止的事（§3.4-1）。于是地形原样进 `terrain[]`，
 * 标签少一格，消费方不受影响。
 */
export interface RuntimeGeoSegment {
  /**
   * 天数。`null` 由消费方渲染成 `?d`（未知），**这是契约里的合法值**；
   * 非整数会被它整格丢掉，所以这里只出整数或 null（见 `daysOfDistance`）。
   */
  days: number | null;
  /** 地形词（旧语义图是单值，这里是单元素数组）；空串不产 */
  terrain?: string[];
  /** `'左端方位-右端方位'`，两端齐备才产（见 `pairDirection`） */
  direction?: string;
}

/**
 * 一条路线（uid 446 的 `edges[]` 成员）。
 *
 * 契约里还有 `edge.importance?`（排序权重，缺席读作 0）——**不产**：`LocationEdge` 没有这个
 * 维度，拿端点显著度顶替就是发明一个「这条路多重要」的判断。全边并列 0 时消费方自然回落到
 * 「已知天数优先 → 天数小优先 → 名字」，那是确定性排序，不是退化。
 */
export interface RuntimeGeoEdge {
  from: string;
  to: string;
  segments: RuntimeGeoSegment[];
}

/** uid 446 读的那个局部变量的整体形状 */
export interface RuntimeGeoData {
  places: RuntimeGeoPlace[];
  edges: RuntimeGeoEdge[];
  /**
   * 当前地点名，**advisory**：uid 446 自己从 `stat_data.世界.地点` 做匹配打分，从不读这一格。
   * 留着它是为了让「供了什么数」在诊断/测试里看得见（供数侧与消费侧各有一套匹配，
   * 而这一格是两套之间唯一的对照物）。空串读作 `null`。
   */
  current: string | null;
}

/**
 * 消费方约定的**大陆哨兵 id**。
 *
 * uid 446 有两处把它当已知常量用：`topScope()`（父 id 等于它时，返回当前节点 = 顶层区域）与
 * 区域层筛选（`parent === 'continent' && importance >= 3`）。也就是说它期待根大陆那个地点的
 * **id 字面就是 `'continent'`**。旧语义图里那个根叫 `continent_astalia`（随 IP 而变的内容 id），
 * 于是两处判断永远不成立，REGIONS 那一层整段空转 —— 而空转不报错，只是图里少了区域。
 *
 * 处置：单根大陆时把它的 id 改写成哨兵（连带改写子节点的 `parent` 与边的端点）。
 * 见 `buildIdRemap` 里那三条适用条件 —— 不适用时 id 一律原样透传。
 */
const CONTINENT_SENTINEL_ID = 'continent';

/** `LocationNode.type` 的大陆值（ASCII 枚举成员，非内容词汇） */
const CONTINENT_TYPE = 'continent';

/** 方位对的连接符 —— 消费方 `reverseDirection()` 就按它 split 反读 */
const DIRECTION_JOINER = '-';

/** 无向对的规范键分隔符（用 NUL：任何 id 里都不会有它，照 uid 446 自己的写法） */
const PAIR_KEY_SEPARATOR = '\u0000';

/**
 * `tier` → `importance` 是**反向**的，这是本投影里最容易写反的一格。
 *
 * `LocationNode.tier` 是深度（大陆 1 / 区域 2 / 城市 3 / 区位 4，越大越细）；
 * uid 446 的 `importance` 是显著度（**越大越显著**：REGIONS 层降序排、且要求 `>= 3`）。
 * 直接透传 `tier` 有两个后果，且都无声：区域（tier 2）过不了 `>= 3` 的门 → 区域层永远空；
 * 排序反向 → 该在前面的粗粒度地点排到最后。所以取 `5 - tier` 并夹到 `[1, 4]`：
 * 大陆 4 / 区域 3 / 城市 2 / 区位 1。
 *
 * 非有穷 tier → 最低显著度（宁可漏不可猜：来路不明的节点不该被提拔成「区域」）。
 */
const IMPORTANCE_BASE = 5;
const IMPORTANCE_MIN = 1;
const IMPORTANCE_MAX = 4;

function importanceOfTier(tier: number): number {
  if (!Number.isFinite(tier)) return IMPORTANCE_MIN;
  const inverted = IMPORTANCE_BASE - Math.round(tier);
  return Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, inverted));
}

/**
 * 距离 → 天数。旧语义图的 `distance` 就是天数（现行数据 1~30），uid 446 只渲染**整数**
 * （`Number.isInteger` 才进标签，`null` 渲染成 `?d`，其余整格丢掉）。
 *
 * 于是：非有穷 / 负数 → `null`（诚实的「未知」，而不是一个读起来像真话的负天数）；
 * 小数四舍五入 —— 不取整就等于把这一格静默丢掉，而丢掉时没人知道原来有值。
 */
function daysOfDistance(distance: number): number | null {
  if (!Number.isFinite(distance) || distance < 0) return null;
  return Math.round(distance);
}

/**
 * 两端方位 → `'A-B'`。
 *
 * 🔴 **两端齐备才产**：消费方反向读这条边时会 split('-') 交换两半，只有一端时它原样返回 ——
 *    于是反方向也会印出同一个方位，那是一句错话。少一格标签好过一句错话。
 * 🔴 任一端自身含连接符时同样不产：那会让反读切错位置（`'东-南'` 反成 `'南-东'` 之外的东西）。
 */
function pairDirection(from: string | undefined, to: string | undefined): string | null {
  const head = (from ?? '').trim();
  const tail = (to ?? '').trim();
  if (head.length === 0 || tail.length === 0) return null;
  if (head.includes(DIRECTION_JOINER) || tail.includes(DIRECTION_JOINER)) return null;
  return `${head}${DIRECTION_JOINER}${tail}`;
}

/**
 * id 改写表（只为大陆哨兵而存在，见 `CONTINENT_SENTINEL_ID`）。
 *
 * 三条适用条件缺一不可，缺任何一条都返回**恒等**改写（id 原样透传）：
 *   1. 恰好一个 `type === 'continent'` 且 `parentId === null` 的根 —— 两个大陆时改写谁都是任意的；
 *   2. 没有任何节点的 id 已经是哨兵 —— 否则改写会撞成两个同 id 的地点（消费方 `_.keyBy` 会
 *      让其中一个凭空消失）；
 *   3. 那个根的 id 与哨兵不同（相同时本来就满足契约，无事可做）。
 */
function buildIdRemap(nodes: readonly LocationNode[]): (id: string) => string {
  const identity = (id: string): string => id;

  const roots = nodes.filter((node) => node.type === CONTINENT_TYPE && node.parentId === null);
  if (roots.length !== 1) return identity;
  if (nodes.some((node) => node.id === CONTINENT_SENTINEL_ID)) return identity;

  const rootId = roots[0].id;
  return (id: string): string => (id === rootId ? CONTINENT_SENTINEL_ID : id);
}

/**
 * 旧语义图 + 当前地点名 → uid 446 的 `runtime_geo_compact_data`。
 *
 * 🔴 **纯函数，不读注册表**：节点由调用方从 `getLocationNodes()` 取来传进（口径同
 *    `location-db.ts` 那 9 个查询函数 —— 注册表可在运行期被重灌，缓存一份就会让装完包的
 *    地图还是旧的）。
 * 🔴 空输入 → `{ places: [], edges: [], current: null }`：uid 446 对空数据自有区域级回退
 *    （它自己那条 `buildRegionFallback`），本层不必也不该替它兜。
 */
export function buildRuntimeGeoData(
  locations: readonly LocationNode[],
  currentLocationName: string | null,
): RuntimeGeoData {
  const remapId = buildIdRemap(locations);

  const places: RuntimeGeoPlace[] = [];
  const nodeById = new Map<string, LocationNode>();
  for (const node of locations) {
    // 重复 id 先到先得（口径同 `map-index.buildMapIndex`：后者赢会依赖遍历顺序）
    if (nodeById.has(node.id)) continue;
    nodeById.set(node.id, node);

    const place: RuntimeGeoPlace = {
      id: remapId(node.id),
      name: node.name,
      parent: node.parentId === null ? null : remapId(node.parentId),
      importance: importanceOfTier(node.tier),
    };
    const brief = (node.description ?? '').trim();
    if (brief.length > 0) place.description = { brief };
    places.push(place);
  }

  const current = (currentLocationName ?? '').trim();
  return {
    places,
    edges: buildRuntimeGeoEdges(nodeById, remapId),
    current: current.length > 0 ? current : null,
  };
}

/**
 * 边投影：**A↔B 合成一条**。
 *
 * 旧语义图两侧各自声明同一条通路（`locations.json` 常见），照搬会让消费方给同一对地点画两条
 * 平行边 —— 一次纯粹的 token 浪费。规范键取 `min-max`，**先到的那条说了算**（与
 * `map-index.buildNeighbors` 的去重口径一致：合并本身幂等，不去合并两条声明里不一致的天数 ——
 * 那是数据问题，猜哪条对才是真的越界）。
 *
 * 连带丢掉的两类边（消费方本来也会跳过，早丢省字节）：**自环**、**悬空端点**。
 */
function buildRuntimeGeoEdges(
  nodeById: ReadonlyMap<string, LocationNode>,
  remapId: (id: string) => string,
): RuntimeGeoEdge[] {
  const edges: RuntimeGeoEdge[] = [];
  const seen = new Set<string>();

  for (const node of nodeById.values()) {
    const from = remapId(node.id);
    for (const edge of node.neighbors) {
      if (!nodeById.has(edge.targetId)) continue;
      const to = remapId(edge.targetId);
      if (to === from) continue;

      const key =
        from < to ? `${from}${PAIR_KEY_SEPARATOR}${to}` : `${to}${PAIR_KEY_SEPARATOR}${from}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const segment: RuntimeGeoSegment = { days: daysOfDistance(edge.distance) };
      const terrain = (edge.terrain ?? '').trim();
      if (terrain.length > 0) segment.terrain = [terrain];
      const direction = pairDirection(edge.fromDirection, edge.toDirection);
      if (direction !== null) segment.direction = direction;

      edges.push({ from, to, segments: [segment] });
    }
  }

  return edges;
}
