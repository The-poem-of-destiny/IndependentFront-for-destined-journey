/**
 * map-index.ts — 运行时索引 + 落位解析（纯函数叶，地图系统 v1 / 设计 §5·§8.2）
 *
 * 装什么:
 *   · `buildMapIndex(pack)` —— 把不可变包折成查得动的形状：地块表 / **合并后的无向邻接表**
 *     （邻接 ∪ 海峡）/ 名字索引（绑定表 + 地块名）/ 中层与国家的双向查表 /
 *     地块→中层→国家链
 *   · `compassOf(from, to)` —— 形心差 → 8 方罗盘令牌（`MAP_CONTEXT` 的邻接行要它）
 *   · `resolveTileByLocation(index, locationPath, currentTileId)` —— **落位契约五条**（§8.2）
 * 不装什么: 任何 I/O、任何缓存层、任何寻路 / 天气 / 文本投影（各在自己的 `map-*.ts` 里）。
 *           也**不重做容错** —— 输入是 `map-pack.ts` 已收窄过的 `MapPack`；本模块只对
 *           「悬空引用 / 自环 / 非有穷数」留了第二道薄闸，理由各自写在原处。
 *
 * 🔴 **没有缓存，因为重建就该是便宜的**（§5 纯叶子 + §3.4 热替换）。包是内容注册表第 8 面，
 *    可整份换掉；任何按包实例/版本键控的记忆化都要回答「什么时候失效」，而那个问题答错时
 *    的症状是**沿着旧地图落位**（棋子落在换图前的块上，不报错）。索引持有 `pack` 的**引用**、
 *    不做防御性深拷贝：对抗 mutation 的手段是重建，不是复制。
 *
 * 🔴 **落位永不模糊匹配**（裁定 §12-2 第五条 / `CONTEXT.md`「落位」）。输入是 AI 写的自由文本
 *    位置路径，`audio-scene.buildLocationChain` 那套 bigram 相似度在选曲里是对的（猜错只是
 *    放了首不搭的曲子），在这里是**在地图上把队伍挪到别的地方**。所以只有三档：原文相等 →
 *    归一化相等 → **放弃**（返回 `null`，调用方保持 `lastTileId` 不动）。没有子串、没有编辑
 *    距离、没有打分。
 *
 * 🔴 **返回的是 tileId，而 tileId 永远不许出现在给 AI 的东西里**（§8.3）。本模块是引擎内侧，
 *    产出 id 是对的；把它渲染进提示词是投影层（`map-context.ts`）的红线。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（§3.4-1，结构闸门 `map-literals-gate.test.ts` 钉死）。
 *    地名 / 地形词 / 罗盘的中文说法全是内容：罗盘令牌因此是 ASCII（`'N'`/`'NE'`…），
 *    译成中文是渲染层的事。注释里写中文是对的。
 *
 * 与设计表的两处偏差（都是有意的，各自写在函数头）:
 *   ① `resolveTileByLocation` 收 `MapIndex` 而不是 `MapPack` —— 落位每回合至少跑一次，
 *      而它要查的四张表都在索引里；收包就等于每次调用重建一遍索引。
 *   ② `anchorTileId` 为空时按「域内最大可落脚块」兜底 —— §8.2-3「无首府的中层取最大块」，
 *      `types-map.ts` 的 `MapCountry.anchorTileId` 与 `map-pack.dropDanglingAnchors` 两处
 *      注释都把这条兜底许给了引擎。少了它，那两句注释就变成假话。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`（§5 模块表 / §8.2 落位契约
 * 五条 / §8.1 邻接行的形状）。领域词汇在根目录 `CONTEXT.md`「地图系统」节。
 */

import type { MapCountry, MapMidTier, MapPack, MapTile } from './types-map';

// ═══════════════════════════════════════════════════════════
// 形状
// ═══════════════════════════════════════════════════════════

/**
 * 8 方罗盘令牌。
 *
 * 🔴 **ASCII 是刻意的**（§3.4-1）：中文说法（北/东北…）属渲染层词汇，写进引擎就等于把
 *    显示语言焊进算法。渲染层拿它当查表键（`{ N: '北', … }`），换语言不动这里。
 */
export type MapCompass = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/** 邻接表的一环：邻块 + 共享边像素长（海峡为 0，见 `STRAIT_SHARED_EDGE_PX`） */
export interface MapNeighborLink {
  tileId: number;
  sharedEdgePx: number;
}

/** 落位里「只圈域、不钉位」的两层（§8.2-1） */
export type MapDomainKind = 'midTier' | 'country';

/** 一个被圈住的域 —— 中层或国家 */
export interface MapDomainRef {
  kind: MapDomainKind;
  id: string;
}

/**
 * 名字 → 值的两层查表。
 *
 * 🔴 **两层是契约本身**（§8.2-4）：`exact` 是包里的原文键，`normalized` 是归一化键
 *    （见 `normalizeMapName`）。查的顺序永远是先 exact 后 normalized —— 反过来会让
 *    「两个只差空白的不同名字」互相顶替，而那正是模糊匹配的第一步。
 */
export interface MapNameLookup<T> {
  exact: ReadonlyMap<string, T>;
  normalized: ReadonlyMap<string, T>;
}

/**
 * 运行时索引 —— `buildMapIndex` 的产物，寻路/落位/投影三层共用。
 *
 * 全字段只读：索引是**派生结构**，改它等于让地图与包不一致却没人知道。要变就重建。
 */
export interface MapIndex {
  /** 建索引时用的那一份包（引用，不是拷贝）—— 寻路要 `travelRules`/`kmPerPx` */
  readonly pack: MapPack;
  /** tileId → 地块行 */
  readonly tileById: ReadonlyMap<number, MapTile>;
  /**
   * tileId → 邻块列表（**无向、已合并邻接与海峡、按 tileId 升序**）。
   *
   * 🔴 **含不可通行块与湖**（§8.1）：`MAP_CONTEXT` 的邻接行要照标「不可通行 / 需船」，
   *    所以拓扑事实必须完整。「剔掉不可通行块」是**寻路图**（`map-path.ts`）的事，
   *    在这里剔就等于让 AI 看不见挡在西边的那道冰脊。
   * 🔴 每个**已知**地块都有一条列表（孤块是空数组）；`get` 返回 `undefined` 只意味着
   *    「这个 id 不在包里」。两种情况分得开，调用方不必先查 `tileById`。
   */
  readonly neighbors: ReadonlyMap<number, readonly MapNeighborLink[]>;
  /** 地块名 + 绑定表 → tileId（= 落位的**绑定名字空间**，`CONTEXT.md`） */
  readonly tileIdByName: MapNameLookup<number>;
  readonly midTierById: ReadonlyMap<string, MapMidTier>;
  readonly countryById: ReadonlyMap<string, MapCountry>;
  /** 中层名 → 中层 id */
  readonly midTierIdByName: MapNameLookup<string>;
  /** 国家名 → 国家 id */
  readonly countryIdByName: MapNameLookup<string>;
  /** 链第一环：tileId → 中层 id（无中层的块缺席） */
  readonly midTierIdByTileId: ReadonlyMap<number, string>;
  /**
   * 链第二环：tileId → 国家 id（无主之地缺席）。
   *
   * 🔴 **地块自有 `countryId` 优先，中层的国家只是补链**：前者是编译期从 titles.txt 烘入的
   *    静态所有者，后者是「这块地在谁的省里」。两者不一致时（飞地/自治领）以地块为准。
   * 🔴 存的是**包声明的 id 原文**，不保证 `countryById` 里有对应行 —— 悬空 id 查不到行的
   *    表现是「不显示所有者」，而不是崩（解析成行归 `countryOfTile`）。
   */
  readonly countryIdByTileId: ReadonlyMap<number, string>;
}

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 海峡边的共享边像素长 = 0。
 *
 * 海峡是 `adjacencies.csv` 的**人工补边**：两块地在像素上根本不相邻，「共享边长」这个量
 * 对它不存在。0 是诚实的答案（先例 `map-pack.coerceAdjacency`：海峡表第三格缺席读作 0）。
 * 它只进 UI 与权重展示，**不影响连通性** —— 海峡照样是一条边。
 */
const STRAIT_SHARED_EDGE_PX = 0;

/** 罗盘扇区（顺时针，从正北起），索引 = `round(angle / 45°)` */
const COMPASS_SECTORS: readonly MapCompass[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 一个扇区 45° */
const SECTOR_RADIANS = Math.PI / 4;

/**
 * 退化输入（零位移 / 非有穷坐标）的罗盘令牌。
 *
 * 返回类型是 8 个令牌的联合，没有 `null` 的位置 —— 所以退化时必须给一个**确定**的值：
 * `atan2(0, 0) === 0` 落在正北扇区，取 `'N'` 与非退化路径口径一致。
 * 「一个地块相对自己的方位」本身是调用方的问题，不是这里该发明的第九个令牌。
 */
const DEGENERATE_COMPASS: MapCompass = 'N';

/**
 * 位置路径分隔符 —— 与 `audio-scene.ts` 的 `PATH_SEPARATORS` **逐字符相同**。
 *
 * 正典格式来自 `agent-config.json` 的 `<tp_format>`（大陆方位-区域-势力-子级势力-聚落-区位-
 * 详细位置）；`/` 是 `getLocationPath()` 的产出形态，一并认。
 * **刻意不含 `·`**：地名里就带间隔号（诺瓦·瓦伦蒂亚城），拿它分段会把一个地名劈成两半。
 *
 * 🔴 为什么抄一份而不是 import `audio-scene.splitLocationPath`：那个模块 import 了
 *    `location-db`（进而是内容注册表），把它拉进来会让这个纯叶子长出内容依赖 —— 而地图层
 *    连一次注册表读取都不该有（§5「参数拿数据，不自己读注册表」）。两处共享的是**协议**
 *    （AI 怎么写路径），不是实现。
 */
const PATH_SEPARATORS = /[-－—–/／>＞]/;

/** 归一化用：全部空白（`\s` 含 NFKC 之后的普通空格与制表/换行） */
const WHITESPACE_ALL = /\s+/g;

// ═══════════════════════════════════════════════════════════
// 名字归一化与查表
// ═══════════════════════════════════════════════════════════

/**
 * 名字归一化 —— 落位第二档匹配的键。
 *
 * 三步，**一步都不多**（§8.2-4「只有精确与归一化两档」）：
 *   ① `NFKC` —— 全角/半角与兼容字形归一（`Ａ`→`A`、`　`→` `）。AI 与创作者的输入法差异
 *      是真实存在的，而这一步是**确定性的 Unicode 标准变换**，不是猜。
 *   ② 去掉**全部**空白（不是折叠成一个）—— `白 曜 城` 与 `白曜城` 指同一处。
 *   ③ 顺带吃掉首尾空白（被 ② 覆盖）。
 *
 * 🔴 **刻意不折叠大小写**。折了能多认几种写法，但两个只差大小写的名字会互相顶替，而
 *    「认不出」的代价是已经设计好的安全兜底（保持 `lastTileId` 不动，§8.2-5），
 *    「认成别的块」的代价是队伍无声地出现在另一个地方。两种错的量级不对等。
 * 🔴 **不做拼音/罗马化/同义词**（继承 `normalizeAudioName` 的边界）：别名要显式写进
 *    包的 `placeBindings`，那是它存在的理由。
 */
export function normalizeMapName(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw.normalize('NFKC').replace(WHITESPACE_ALL, '');
}

/** 建索引期间的可写查表 */
interface MutableNameLookup<T> {
  exact: Map<string, T>;
  normalized: Map<string, T>;
}

function createNameLookup<T>(): MutableNameLookup<T> {
  return { exact: new Map<string, T>(), normalized: new Map<string, T>() };
}

/**
 * 登记一个名字，**先到先得**（两层都是）。
 *
 * 🔴 先到先得而不是后者赢：撞名是编译期该拒的数据（§8.2-4「真正无法消歧的重名编译期报
 *    error」），运行时只能二选一 —— 而「后者赢」的结果取决于数组遍历顺序，包里换个行序
 *    落位结论就变了。先到先得至少是**稳定**的。
 * 🔴 `exact` 键是包里的**原文**（不 trim）：trim 属于归一化那一档。查询段本身已被
 *    `splitLocationSegments` 修过边，所以带空白的包名只会命中第二档 —— 层次分明。
 */
function registerName<T>(lookup: MutableNameLookup<T>, rawName: string, value: T): void {
  if (typeof rawName !== 'string' || rawName.length === 0) return;
  if (!lookup.exact.has(rawName)) lookup.exact.set(rawName, value);

  const key = normalizeMapName(rawName);
  // 空键绝不入表：它会让「空段」命中某个真名字（而空段在自由文本里到处都是）
  if (key.length > 0 && !lookup.normalized.has(key)) lookup.normalized.set(key, value);
}

/**
 * 两档查表：原文相等 → 归一化相等 → `undefined`。
 *
 * 🔴 一律与 `undefined` 比较，**绝不写真值判断**：`tileId` 里 **0 是真实存在的 id**
 *    （§3.1 那条已知数据缺陷里的保留块），`if (hit)` 会让地块 0 永远落不了位，
 *    而症状只是「有一块地怎么都走不进去」。
 */
function lookupName<T>(lookup: MapNameLookup<T>, query: string): T | undefined {
  const exactHit = lookup.exact.get(query);
  if (exactHit !== undefined) return exactHit;

  const key = normalizeMapName(query);
  if (key.length === 0) return undefined;
  return lookup.normalized.get(key);
}

// ═══════════════════════════════════════════════════════════
// 建索引
// ═══════════════════════════════════════════════════════════

/**
 * 包 → 运行时索引（纯函数，**每次现建**，见文件头那条「没有缓存」）。
 *
 * 空包（0 地块）照常返回一个形状完整的空索引 —— 那是合同不是异常（`map-pack.ts` 文件头）：
 * 落位永远 `null`、邻接永远查不到、投影整段不出。
 */
export function buildMapIndex(pack: MapPack): MapIndex {
  const tileById = new Map<number, MapTile>();
  for (const tile of pack.tiles) {
    // 重复 id 先到先得（口径同 `coerceTiles`：后者赢会依赖遍历顺序）
    if (!tileById.has(tile.id)) tileById.set(tile.id, tile);
  }

  const midTierById = new Map<string, MapMidTier>();
  const midTierIdByName = createNameLookup<string>();
  for (const midTier of pack.midTiers) {
    if (midTierById.has(midTier.id)) continue;
    midTierById.set(midTier.id, midTier);
    registerName(midTierIdByName, midTier.name, midTier.id);
  }

  const countryById = new Map<string, MapCountry>();
  const countryIdByName = createNameLookup<string>();
  for (const country of pack.countries) {
    if (countryById.has(country.id)) continue;
    countryById.set(country.id, country);
    registerName(countryIdByName, country.name, country.id);
  }

  return {
    pack,
    tileById,
    neighbors: buildNeighbors(pack, tileById),
    tileIdByName: buildTileNameIndex(pack, tileById),
    midTierById,
    countryById,
    midTierIdByName,
    countryIdByName,
    ...buildOwnershipChain(pack, tileById, midTierById),
  };
}

/**
 * 合并后的无向邻接表 = `adjacency ∪ straits`。
 *
 * 三条丢边判据（与 `coerceAdjacency` 同口径，这里是第二道 —— 手搓的包与测试夹具不经解析器）:
 *   · **自环**（`a === b`）：在 Dijkstra 里是纯噪声，在邻接行里是「北边是我自己」
 *   · **悬空端点**：会长出一个查不到行的邻块 —— 症状是路径从中间断掉、或者邻接行里一个空名字
 *   · **重复对**：无向去重按 `min-max` 规范键，共享边长以**第一条**为准（海峡与邻接重复
 *     声明时，先声明的那条说了算；合并本身是幂等的）
 *
 * 🔴 列表按 tileId **升序**排：这样邻接表与包里边的书写顺序无关。下游 `MAP_CONTEXT` 的邻接行
 *    由它派生，而那段文本要进提示词 —— 顺序稳定 = 静态前缀字节稳定（ADR-30）。
 */
function buildNeighbors(
  pack: MapPack,
  tileById: ReadonlyMap<number, MapTile>,
): Map<number, MapNeighborLink[]> {
  const out = new Map<number, MapNeighborLink[]>();
  // 先给每个已知块铺一条空列表：「孤块」与「不存在的 id」由此分得开
  for (const tileId of tileById.keys()) out.set(tileId, []);

  const seen = new Set<string>();
  const link = (a: number, b: number, sharedEdgePx: number): void => {
    if (a === b) return;
    const listA = out.get(a);
    const listB = out.get(b);
    if (listA === undefined || listB === undefined) return;

    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);

    // 非有穷/负数一律读作 0：NaN 权重会一路漂到 UI 与代价计算里，且沿途不报错
    const shared = Number.isFinite(sharedEdgePx) && sharedEdgePx > 0 ? sharedEdgePx : 0;
    listA.push({ tileId: b, sharedEdgePx: shared });
    listB.push({ tileId: a, sharedEdgePx: shared });
  };

  for (const [a, b, sharedEdgePx] of pack.adjacency) link(a, b, sharedEdgePx);
  for (const [a, b] of pack.straits) link(a, b, STRAIT_SHARED_EDGE_PX);

  for (const list of out.values()) list.sort((x, y) => x.tileId - y.tileId);
  return out;
}

/**
 * 绑定名字空间 = **地块名 + `placeBindings`**（§8.2-1）。
 *
 * 🔴 **地块名先登记**：它是主名字空间（编译期查重），绑定表是补充。两者撞名时地块名赢 ——
 *    一条把某个地块名指到**别的**块上的绑定，是编译期该报 error 的数据；运行时让它改写
 *    地块名的去处，等于用一行补充数据静默重定向一个地块。
 * 🔴 中层名/国家名**不进这张表**：它们只圈域（§8.2-1），钉位是另一回事，由
 *    `findDomainByName` 单独查。混进来就等于让「路径写到国家粗度」直接钉在某个块上。
 */
function buildTileNameIndex(
  pack: MapPack,
  tileById: ReadonlyMap<number, MapTile>,
): MapNameLookup<number> {
  const lookup = createNameLookup<number>();
  for (const tile of pack.tiles) registerName(lookup, tile.name, tile.id);
  for (const [name, tileId] of Object.entries(pack.placeBindings)) {
    // 悬空绑定丢掉：落位「成功」到一个查不到的块，比落位失败坏得多（`coercePlaceBindings` 同理）
    if (!tileById.has(tileId)) continue;
    registerName(lookup, name, tileId);
  }
  return lookup;
}

/** 地块 → 中层 → 国家链（两张表；判据见 `MapIndex.countryIdByTileId` 的注释） */
function buildOwnershipChain(
  pack: MapPack,
  tileById: ReadonlyMap<number, MapTile>,
  midTierById: ReadonlyMap<string, MapMidTier>,
): Pick<MapIndex, 'midTierIdByTileId' | 'countryIdByTileId'> {
  const midTierIdByTileId = new Map<number, string>();
  const countryIdByTileId = new Map<number, string>();

  for (const tile of pack.tiles) {
    if (tileById.get(tile.id) !== tile) continue; // 重复 id：只认先到的那一行

    const midTierId = tile.midTierId;
    const midTier = midTierId !== null ? midTierById.get(midTierId) : undefined;
    // 悬空 midTierId 不入链：链的作用是「查得到上一层」，指向空气的一环没有用处
    if (midTierId !== null && midTier !== undefined) midTierIdByTileId.set(tile.id, midTierId);

    if (tile.countryId !== null) countryIdByTileId.set(tile.id, tile.countryId);
    else if (midTier !== undefined && midTier.countryId.length > 0) {
      countryIdByTileId.set(tile.id, midTier.countryId);
    }
  }

  return { midTierIdByTileId, countryIdByTileId };
}

// ═══════════════════════════════════════════════════════════
// 查询（链 / 名字 / 域）
// ═══════════════════════════════════════════════════════════

/** 地块所属中层行；无中层或悬空 → `null` */
export function midTierOfTile(index: MapIndex, tileId: number): MapMidTier | null {
  const midTierId = index.midTierIdByTileId.get(tileId);
  if (midTierId === undefined) return null;
  return index.midTierById.get(midTierId) ?? null;
}

/** 地块所属国家行（走链：地块自有所有者优先，其次中层的国家）；无主或悬空 → `null` */
export function countryOfTile(index: MapIndex, tileId: number): MapCountry | null {
  const countryId = index.countryIdByTileId.get(tileId);
  if (countryId === undefined) return null;
  return index.countryById.get(countryId) ?? null;
}

/** 名字 → tileId（绑定名字空间；两档匹配）；认不出 → `null` */
export function findTileByName(index: MapIndex, name: string): number | null {
  return lookupName(index.tileIdByName, name) ?? null;
}

/**
 * 名字 → 域（**中层优先于国家**）；认不出 → `null`。
 *
 * 🔴 中层优先 = §8.2-4「跨层同名取更具体的层」。一个既是中层名又是国家名的串（银帆城
 *    既是城又是省那一类），取具体层才是作者的意思；反过来会把「银帆城」永远解释成整个省。
 */
export function findDomainByName(index: MapIndex, name: string): MapDomainRef | null {
  const midTierId = lookupName(index.midTierIdByName, name);
  if (midTierId !== undefined) return { kind: 'midTier', id: midTierId };

  const countryId = lookupName(index.countryIdByName, name);
  if (countryId !== undefined) return { kind: 'country', id: countryId };

  return null;
}

/** 这个地块在不在这个域里（国家走链，见 `MapIndex.countryIdByTileId`） */
export function isTileInDomain(index: MapIndex, tileId: number, domain: MapDomainRef): boolean {
  if (!index.tileById.has(tileId)) return false;
  if (domain.kind === 'midTier') return index.midTierIdByTileId.get(tileId) === domain.id;
  return index.countryIdByTileId.get(tileId) === domain.id;
}

/**
 * 域的**锚地块** —— 位置路径只写到这一层粗度、且当前块在域外时的落脚点（§8.2-3）。
 *
 * 两档:
 *   ① 包里预算的 `anchorTileId`（首府所在块）。**必须回查 `tileById`**：悬空锚会让落位
 *      「成功」到一个查不到的块上（`coerceMapPack` 已清过一轮，手搓的包没有）。
 *   ② 没有锚 → **域内最大可落脚块**（§8.2-3「无首府的中层取最大块」）。
 *
 * 🔴 「可落脚」排除 `impassable` 与 `lake`：不可通行块整块被寻路图剔出（`MapTile.impassable`），
 *    湖一律不可入（§6.1）。落在这两种块上的表现是「队伍到了一个走不出去的地方」，
 *    而下一次 `findPath` 会诚实地报无路 —— 那时问题看起来在寻路，其实在这里。
 *    海块仍**保留**（它在混合通行图里是可走的；一个只有海的域，落在海上至少路走得通）。
 * 🔴 面积相同时取**较小 id**：稳定即可复现，别让 `tiles` 的行序决定结论。
 */
export function resolveDomainAnchor(index: MapIndex, domain: MapDomainRef): number | null {
  const row =
    domain.kind === 'midTier' ? index.midTierById.get(domain.id) : index.countryById.get(domain.id);
  if (row === undefined) return null;

  if (row.anchorTileId !== null && index.tileById.has(row.anchorTileId)) return row.anchorTileId;

  let bestId: number | null = null;
  let bestArea = -1;
  for (const tile of index.pack.tiles) {
    if (tile.impassable || tile.water === 'lake') continue;
    if (!isTileInDomain(index, tile.id, domain)) continue;
    if (
      tile.areaPx > bestArea ||
      (tile.areaPx === bestArea && bestId !== null && tile.id < bestId)
    ) {
      bestArea = tile.areaPx;
      bestId = tile.id;
    }
  }
  return bestId;
}

// ═══════════════════════════════════════════════════════════
// 罗盘
// ═══════════════════════════════════════════════════════════

/**
 * 形心差 → 8 方罗盘令牌（`MAP_CONTEXT` 邻接行的方位就是它，§8.1）。
 *
 * 🔴 **屏幕坐标：y 向下增长，所以北 = 负 Δy**。`provinces.png` 的像素原点在左上角，
 *    数学直觉（y 向上）在这里是**上下颠倒**的 —— 而颠倒了不会报错，只会让每一条邻接行
 *    的南北写反，且真机上要有人恰好核对地图才发现。`atan2(dx, -dy)` 把这条钉在一处：
 *    结果 0 = 正北，顺时针增大。
 * 🔴 扇区用 `round`：22.5° 的边界按 JS 的「.5 向上取整」归给顺时针那一侧（正北偏东一点点
 *    算 NE）。确定性比「哪边更直觉」重要 —— 两个相邻块的方位不该随浮点末位跳变。
 */
export function compassOf(
  from: readonly [x: number, y: number],
  to: readonly [x: number, y: number],
): MapCompass {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  // 非有穷坐标会让 round 产 NaN，索引出 undefined —— 而返回类型里没有 undefined，
  // 那就是一个类型系统当成合法令牌的无声谎言。挡在这里。
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return DEGENERATE_COMPASS;
  if (dx === 0 && dy === 0) return DEGENERATE_COMPASS;

  const sector = Math.round(Math.atan2(dx, -dy) / SECTOR_RADIANS);
  return COMPASS_SECTORS[((sector % 8) + 8) % 8];
}

// ═══════════════════════════════════════════════════════════
// 落位（§8.2 契约五条）
// ═══════════════════════════════════════════════════════════

/**
 * 位置路径拆段，**由细到粗**（deepest first）。
 *
 * `大陆中东部区域-北岭邦-港镇-码头区`
 *   → `['码头区', '港镇', '北岭邦', '大陆中东部区域']`
 *
 * 与 `audio-scene.splitLocationPath` 同分隔符、同语义（trim + 丢空段 + 倒序）；
 * 不 import 的理由见 `PATH_SEPARATORS` 那条注释。非路径的单段输入原样返回单元素数组。
 */
export function splitLocationSegments(locationPath: string): string[] {
  return (locationPath ?? '')
    .split(PATH_SEPARATORS)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .reverse();
}

/**
 * 位置路径 → 地块（**落位**）。契约五条（§8.2 / 裁定 §12-2）逐条落在下面:
 *
 * 1. **可钉位的名字** = 地块名 + `placeBindings`（`index.tileIdByName` 两者都收）。
 *    中层名与国家名**永不直接钉位**，只圈域。
 * 2. **取最深的钉位段**。比地块更细的段（码头区/城主府）自然匹配不上，于是被忽略 ——
 *    地块比场景粗，这是对的，不是缺陷。钉位**优先于圈域**：路径里同时有中层段和更深的
 *    地块段时地块赢；那个中层段属于**另一个**域时也一样 —— 深度是唯一的排序键。
 * 3. 一个钉位段都没有、但有段圈住了中层/国家:
 *    · 当前块已在域内 → **原地不动**（AI 在说模糊话，`return currentTileId`）
 *    · 域外（或当前块不明/已不在包里）→ 落该域的**锚地块**（`resolveDomainAnchor`，可能 `null`）
 *    多个域段时取**最深**的那个（路径由粗到细书写，所以最深的域最具体）。
 * 4. 匹配只有**原文相等 → 归一化相等**两档（`lookupName`）。段内 exact 先于 normalized，
 *    但**深度是主键**：更深的段哪怕只归一化命中，也赢过更浅的段的原文命中 —— 契约说的是
 *    「最深的钉位段」，exact 只是同一段内部的取舍。
 * 5. 全落空 → `null`。调用方（`applySetLocation`）据此**保持 `lastTileId` 原值**，位置路径
 *    原文照常保留（§8.2-5）。**永不模糊匹配**（文件头那条红线）。
 *
 * `currentTileId` 收 `null`/`undefined`（首次落位、或换包后派生态已清）；它若已不在包里
 * （旧存档 + 新包）一律当作「域外」，于是走锚地块 —— 这正是 §3.4-2 的投影自愈。
 */
export function resolveTileByLocation(
  index: MapIndex,
  locationPath: string,
  currentTileId: number | null | undefined,
): number | null {
  // 空包：什么都定位不了（合同，不是异常）。提前退出只是省事，下面的逐段查表结论相同。
  if (index.tileById.size === 0) return null;

  let domain: MapDomainRef | null = null;

  for (const segment of splitLocationSegments(locationPath)) {
    const pinned = findTileByName(index, segment);
    if (pinned !== null) return pinned; // 契约 2：最深的钉位段直接赢
    if (domain === null) domain = findDomainByName(index, segment); // 最深的域段（先到先得）
  }

  if (domain === null) return null; // 契约 5

  // 契约 3：域内模糊话 → 原地不动
  if (
    currentTileId !== null &&
    currentTileId !== undefined &&
    isTileInDomain(index, currentTileId, domain)
  ) {
    return currentTileId;
  }
  return resolveDomainAnchor(index, domain);
}
