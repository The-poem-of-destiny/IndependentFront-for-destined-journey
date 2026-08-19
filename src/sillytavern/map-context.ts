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
 * 🔴 **v1.2 增补（ADR-33 §5 读侧）**：快照多了「地块动态」一层 —— 当前块全量
 *    （发展档 / 活跃状态 / 建筑槽 / 编年史尾 5 条）+ 邻块单行头条（档名 + 状态标题）。
 *    三条纪律没变，只是各自多了一句：
 *      · 仍然**只产数据**（编年史条目结构化原样透传，中文措辞归两个渲染器）；
 *      · 仍然**不读时钟**（「还剩几天」要的 `currentDay` 由调用方算好传进来）；
 *      · 有效视图一律走 `map-dynamics.effectiveTileFacts`，**不在这里重推一遍 pack 基线**
 *        （「有事实取事实、否则取 pack 基线」这句话只该存在一处）。
 *    外加一条新的：**缺席状态零 token** —— 没有事实条目的地块，投影出来与 v1.1 逐字节相同，
 *    所以那几格是**可选键**而不是「必填但可能为空」。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`
 * （§8.1 读侧载荷契约 / §5 `$map` 面 / §12-9·§12-10 裁定）+
 * `docs/planning/2026-08-18-map-tile-dynamics-v1.2-design.md`（§5 读侧 / §8-12·§8-16 裁定）。
 */

import type { EffectiveTileFacts } from './map-dynamics';
import { effectiveTileFacts, hasDevelopment } from './map-dynamics';
import type { MapCompass, MapIndex } from './map-index';
import { buildMapIndex, compassOf, countryOfTile, midTierOfTile } from './map-index';
import { findPath } from './map-path';
import type { LocationNode } from './types';
import type {
  BuildingRecord,
  MapFactsFlags,
  MapJourneyFlag,
  MapPack,
  MapTile,
  MapWaterKind,
  TileFactsEntry,
  TileHistoryEntry,
  TileStatus,
} from './types-map';

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

  // ── 地块动态（v1.2 / ADR-33 §5「本块全量」）────────────────────────────
  // 🔴 下面四格**全部可选，且缺席时键根本不存在**（不是 `undefined` 值）：
  //    v1.2 的读侧铁律是「缺席状态零 token」——没有事实条目的地块（绝大多数）
  //    渲染出来必须与 v1.1 逐字节相同。把它们改成必填、让渲染层去判空，
  //    等于让每一个没用过这套系统的存档都为四个空格子付 token。
  /** 发展档与进度；缺席 = 这块地没有发展度 / 包没声明过发展档 / 尚无事实条目 */
  development?: MapSnapshotDevelopment;
  /** 活跃状态（含海/不可通行块 —— 海上风暴合法，裁定 §8-1）；空表时整格不产 */
  statuses?: MapSnapshotStatus[];
  /**
   * **主建筑**（v1.2 / §F4b）—— 这块地的主聚落，不占编号槽、降档免疫。
   * 与 `development` **同进同出**（判据同 `buildings`：没有发展档就没有主建筑）。
   *
   * 🔴 名字已经在数据面解析完（作者名 / AI 钉住的名 / 按当前档派生的通名，见
   *    `map-dynamics.resolveMainBuilding`）—— 渲染层拿到的就是要印的那个串，
   *    绝不该自己再查一次通名表。
   */
  mainBuilding?: MapSnapshotBuilding;
  /** 建筑槽概览；与 `development` **同进同出**（槽数就是档数，无发展度即无建筑面） */
  buildings?: MapSnapshotBuildings;
  /**
   * 编年史**最近 5 条**（**新的在后**，与存储顺序一致）。
   *
   * 🔴 **结构化原样透传**（`TileHistoryEntry`）：中文措辞归两个渲染器（裁定 §8-14 末条），
   *    在这里拼成句子就等于把「换图/换语言零改码」那条闸门从数据面撕开一个口子。
   */
  history?: TileHistoryEntry[];
}

/**
 * 发展档（v1.2 / §F2）。
 *
 * `levelName` 由包的 `developmentLevels[level-1]` 查得，缺表/缺行时回退 **ASCII** 的
 * `Lv{n}`（见 `developmentLevelName`）—— 引擎不持有中文档名（§3.4-1 换图零改码）。
 */
export interface MapSnapshotDevelopment {
  /** 1..10 */
  level: number;
  /** 档名（包词汇原文）或 ASCII 兜底 */
  levelName: string;
  /** −50..100 */
  progress: number;
}

/**
 * 一条活跃状态的投影（v1.2 / §F1）。
 *
 * 🔴 `permanent` 与 `remainingDays` 是**两件事**：永久状态恒 `remainingDays: null`，
 *    而限时状态在**算不出今天是第几天**（调用方没供 `currentDay`）时同样是 `null`。
 *    合并成一个「−1 = 永久」的数字会让渲染层把「不知道还剩几天」讲成「永久」。
 */
export interface MapSnapshotStatus {
  title: string;
  /** AI 产的原文；空串 = 纯标题 */
  description: string;
  permanent: boolean;
  /** 还剩几天（已下钳到 0）；`null` = 永久 或 算不出 */
  remainingDays: number | null;
}

/** 一座建筑的投影（v1.2 / §F3·§F4）。`income` **刻意不投**：那是引擎的账，不是叙事事实 */
export interface MapSnapshotBuilding {
  name: string;
  /** 归属自由文本；空/缺席时整格不产 */
  ownerFlavor?: string;
  /** 玩家产业（v1.2 里唯一有机制的所有权位） */
  playerOwned: boolean;
}

/**
 * 建筑槽概览（v1.2 / §F3）。
 *
 * 🔴 **不投槽位号**：槽位身份是引擎内部的机制（降档摧毁最高号槽），对 AI 只是一串
 *    换图就会变的数字。它要知道的是「有哪些建筑、还空几格」。
 */
export interface MapSnapshotBuildings {
  /** 总槽数 = 当前发展档数 */
  slots: number;
  /** 已建成的建筑（按槽位升序，空槽不占位） */
  entries: MapSnapshotBuilding[];
  /** 空槽数 = `slots − entries.length`（下钳到 0） */
  freeSlots: number;
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

  // ── 地块动态的**头条行**（v1.2 / 裁定 §8-12「邻块单行头条」）─────────────
  // 🔴 邻块只有这两格：**没有**描述、没有建筑、没有编年史、没有进度数字。
  //    4~8 个邻块各带一份全量事实会把本地事实块撑成一页纸，而 AI 真正要决策的
  //    是「现在这块地」——邻块只需要一眼看出「那边正在闹洪水 / 那是座大城」。
  /** 发展档名；缺席 = 无发展度 / 包没声明 / 尚无事实条目 */
  devLevelName?: string;
  /** 活跃状态**标题**（无描述）；空表时整格不产 */
  statusTitles?: string[];
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
  /**
   * 发展档名表（包的 `developmentLevels` 副本，v1.2）；**只在供了事实态且包里有表时才产**。
   *
   * 为什么整张表也要进快照：编年史里的升/降档条目存的是**档位序数**（结构化，§F5 末条），
   * 而两个渲染器（占位符 / 内容仓世界书条目）都要把它渲染成「升为「繁荣城镇」」。
   * 不给表，渲染层要么印一个换图就会变的数字，要么各自去别处再找一遍同一张表。
   */
  developmentLevels?: string[];
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
  /**
   * 地块事实态（`worldFlags.mapFacts`，v1.2 / ADR-33 §3）；**缺席 = 一格动态都不产**。
   *
   * 🔴 缺席与「空事实袋」走同一条出口，而这正是「零 token」这条读侧铁律的落点：
   *    没装 v1.2 的存档、还没有任何叙事事实的存档，渲染出来与 v1.1 逐字节相同。
   */
  facts?: MapFactsFlags | null;
  /**
   * 当前游戏内日（`floor(toEpochMinutes(gameTime) / 1440)`）—— **状态剩余天数的唯一基准**。
   *
   * 🔴 由调用方算好传进来，本模块**不读时钟**（文件头那条纪律）。缺席不是异常：
   *    剩余天数一律 `null`（渲染层少一格括注），状态本身照常展示。
   */
  currentDay?: number | null;
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
  const facts = opts.facts ?? null;
  const currentDay = typeof opts.currentDay === 'number' ? opts.currentDay : null;
  const levelNames = Array.isArray(pack.developmentLevels) ? pack.developmentLevels : [];
  // v1.2 §F4b：主建筑通名表只在这里读一次，解析在 `map-dynamics`，渲染层只见解析后的名字
  const mainNames = Array.isArray(pack.mainBuildingNames) ? pack.mainBuildingNames : [];

  const snapshot: MapSnapshot = {
    current:
      currentTile === null
        ? null
        : describeTile(index, currentTile, facts, currentDay, levelNames, mainNames),
    neighbors: currentTile === null ? [] : describeNeighbors(index, currentTile, facts, levelNames),
    journey: describeJourney(index, opts.journey ?? null, currentTile),
    weatherLabel: opts.weatherLabel,
    discontinuity: opts.discontinuity ?? null,
  };
  // 表随事实态一起出现：没供事实的调用方（v1.1 口径）连这一格都不该看见
  if (facts !== null && levelNames.length > 0) snapshot.developmentLevels = levelNames.slice();
  return snapshot;
}

// ═══════════════════════════════════════════════════════════
// 地块动态的投影（v1.2 / ADR-33 §5）
// ═══════════════════════════════════════════════════════════

/** 快照里带的编年史条数（裁定 §8-16「MAP_CONTEXT 当前块最近 3–5 条」取上界） */
export const SNAPSHOT_HISTORY_LIMIT = 5;

/** 档名兜底前缀 —— **ASCII**（引擎不持有中文档名，§3.4-1） */
const DEV_LEVEL_FALLBACK_PREFIX = 'Lv';

/**
 * 档位序数 → 档名。表缺席 / 该行为空 → `Lv{n}`。
 *
 * 两个渲染器都要它（占位符渲染编年史里的升降档条目），所以导出而不是各写一份 ——
 * 兜底串一旦分叉，同一条编年史在两个面上会长得不一样。
 */
export function developmentLevelName(levelNames: readonly string[], level: number): string {
  const raw = levelNames[level - 1];
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  return `${DEV_LEVEL_FALLBACK_PREFIX}${level}`;
}

/** 事实条目按**地块名**取（v1.2 §3：事实以名字为键，换包后名字仍在就继续生效） */
function factsEntryOf(facts: MapFactsFlags | null, tile: MapTile): TileFactsEntry | undefined {
  if (facts === null) return undefined;
  const tiles = facts.tiles;
  if (tiles === null || typeof tiles !== 'object') return undefined;
  return tiles[tile.name];
}

/**
 * 这块地的发展档**值不值得说**。
 *
 * 三条缺一不可：地块本身有发展度（海/湖/不可通行块恒无，裁定 §8-1）、有事实条目、
 * 且档位是**被声明过的**（包里烘了起始档，或事实里已经有了发展记录）。
 *
 * 🔴 第三条是「零 token」那条铁律的落点：`hasDevelopment` 对**任何**可通行陆块都为真，
 *    照它渲染会让 v1.0/v1.1 旧包的每一块地都凭空多出一行「发展: Lv1（进度 0/100）」——
 *    那不是事实，是引擎的兜底值被当成了内容。
 */
function declaresDevelopment(tile: MapTile, entry: TileFactsEntry | undefined): boolean {
  if (!hasDevelopment(tile)) return false;
  if (entry === undefined) return false;
  return tile.development !== undefined || entry.development !== undefined;
}

/** 活跃状态 → 投影行（`currentDay` 缺席时剩余天数一律 null，见 `MapSnapshotStatus`） */
function describeStatuses(
  statuses: readonly TileStatus[],
  currentDay: number | null,
): MapSnapshotStatus[] {
  const rows: MapSnapshotStatus[] = [];
  for (const status of statuses) {
    if (status === null || typeof status !== 'object') continue;
    const title = typeof status.title === 'string' ? status.title.trim() : '';
    if (title === '') continue;

    const duration = status.durationDays;
    const permanent = !Number.isFinite(duration) || (duration as number) < 0;
    const anchored = Number.isFinite(status.appliedAtDay) && Number.isFinite(duration);
    rows.push({
      title,
      description: typeof status.description === 'string' ? status.description : '',
      permanent,
      remainingDays:
        permanent || currentDay === null || !anchored
          ? null
          : // 下钳到 0：到期的那一刻由时间账本移除，此前诚实地说「今天到期」
            Math.max(0, status.appliedAtDay + (duration as number) - currentDay),
    });
  }
  return rows;
}

/**
 * 一条建筑记录 → 投影行（名字空则 `null`，调用方据此整格不产）。
 * 主建筑与槽位建筑共用它 —— 两者的投影形状本来就一样（§F4b「除降档免疫外一切如常」）。
 */
function describeBuilding(row: BuildingRecord | null): MapSnapshotBuilding | null {
  if (row === null || typeof row !== 'object') return null;
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (name === '') return null;

  const out: MapSnapshotBuilding = { name, playerOwned: row.playerOwned === true };
  const owner = typeof row.ownerFlavor === 'string' ? row.ownerFlavor.trim() : '';
  if (owner !== '') out.ownerFlavor = owner;
  return out;
}

/** 有效槽数组 → 建筑概览（空槽不占位，槽位号不投给 AI） */
function describeBuildings(effective: EffectiveTileFacts): MapSnapshotBuildings {
  const entries: MapSnapshotBuilding[] = [];
  for (const slot of effective.buildings) {
    const row = describeBuilding(slot);
    if (row !== null) entries.push(row);
  }
  return {
    slots: effective.slots,
    entries,
    freeSlots: Math.max(0, effective.slots - entries.length),
  };
}

/**
 * 编年史尾 5 条（新的在后）。
 *
 * 逐条**浅拷贝**（`causeStatuses` 另换新数组）：快照会被送进 EJS 与渲染层，
 * 而 `entry.history` 是存档里那份事实的引用 —— 原样交出去等于把可写引用递出模块。
 */
function recentHistory(history: readonly TileHistoryEntry[]): TileHistoryEntry[] {
  const rows: TileHistoryEntry[] = [];
  for (const item of history.slice(-SNAPSHOT_HISTORY_LIMIT)) {
    if (item === null || typeof item !== 'object') continue;
    const row: TileHistoryEntry = { ...item };
    if (Array.isArray(item.causeStatuses)) row.causeStatuses = item.causeStatuses.slice();
    rows.push(row);
  }
  return rows;
}

/** id → 地块行；`null`（未落位）与查不到（包换了 / 悬空）走同一条出口 */
function resolveTile(index: MapIndex, tileId: number | null): MapTile | null {
  if (tileId === null || !Number.isFinite(tileId)) return null;
  return index.tileById.get(tileId) ?? null;
}

function describeTile(
  index: MapIndex,
  tile: MapTile,
  facts: MapFactsFlags | null,
  currentDay: number | null,
  levelNames: readonly string[],
  mainNames: readonly string[],
): MapSnapshotPlace {
  const place: MapSnapshotPlace = {
    name: tile.name,
    terrain: tile.terrain,
    water: tile.water,
    impassable: tile.impassable,
    midTierName: midTierOfTile(index, tile.id)?.name ?? null,
    countryName: countryOfTile(index, tile.id)?.name ?? null,
  };

  // v1.2 动态：没有事实条目 = 这块地还完全是 pack 基线，四格一个都不产（零 token）
  const entry = factsEntryOf(facts, tile);
  if (entry === undefined) return place;

  const effective = effectiveTileFacts(tile, entry, mainNames);
  if (declaresDevelopment(tile, entry) && effective.level !== null) {
    place.development = {
      level: effective.level,
      levelName: developmentLevelName(levelNames, effective.level),
      progress: effective.progress ?? 0,
    };
    // 主建筑与建筑面都与发展档同进同出：没有档就既没有槽、也没有主聚落
    const main = describeBuilding(effective.mainBuilding);
    if (main !== null) place.mainBuilding = main;
    place.buildings = describeBuildings(effective);
  }

  const statuses = describeStatuses(effective.statuses, currentDay);
  if (statuses.length > 0) place.statuses = statuses;

  const history = recentHistory(effective.history);
  if (history.length > 0) place.history = history;

  return place;
}

/**
 * 一跳邻接行。
 *
 * 异主判据比的是**链上的国家 id**（`countryIdByTileId`，地块自有所有者优先、中层补链），
 * 不是解析出来的国家行 —— 悬空 id 查不到行，但它仍然是一个能判「异主」的稳定键。
 * 反过来（先解析成行再比名字）会让两块分属不同悬空国的地看着同主。
 */
function describeNeighbors(
  index: MapIndex,
  tile: MapTile,
  facts: MapFactsFlags | null,
  levelNames: readonly string[],
): MapSnapshotNeighbor[] {
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

    const row: MapSnapshotNeighbor = {
      name: neighbor.name,
      terrain: neighbor.terrain,
      dir: compassOf(tile.centroid, neighbor.centroid),
      water: neighbor.water,
      impassable: neighbor.impassable,
      ownerName: sameOwner ? null : (countryOfTile(index, neighbor.id)?.name ?? null),
    };

    // v1.2 头条行（裁定 §8-12）：只有档名与状态标题，且同样是「没事实就不产」
    const entry = factsEntryOf(facts, neighbor);
    if (entry !== undefined) {
      const effective = effectiveTileFacts(neighbor, entry);
      if (declaresDevelopment(neighbor, entry) && effective.level !== null) {
        row.devLevelName = developmentLevelName(levelNames, effective.level);
      }
      const titles = describeStatuses(effective.statuses, null).map((s) => s.title);
      if (titles.length > 0) row.statusTitles = titles;
    }

    rows.push(row);
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
