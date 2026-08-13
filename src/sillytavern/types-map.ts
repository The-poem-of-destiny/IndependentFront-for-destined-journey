/**
 * types-map.ts — 地图子系统的类型分册（地图系统 v1，设计 2026-08-11 §4）
 *
 * 装什么: 地图 v1 的**全部**类型 —— 不可变内容包（`MapPack` 及其成员）、寻路产物
 *         （`MapRoute`）、天气（`ClimateProfile` / `WeatherResult`）、以及每存档
 *         那一小袋可变状态（`MapSaveFlags` = `SaveProfile.worldFlags.map` 的形状）。
 * 不装什么: 任何函数、任何常量、任何 I/O。容错解析在 `map-pack.ts`，索引/寻路/天气/
 *           上下文投影各在自己的 `map-*.ts` 里。
 *
 * 为什么与 types.ts 分开:
 * 先例 `types-audio.ts` / `types-image.ts`。与音频分册不同、与图像分册相同的是：
 * 本子系统的**数据模型类型也全在这里** —— 地图 v1 不新增 Dexie 表、与 types.ts 的既有
 * 实体零交织（唯一的交界是 `worldFlags`，而它是 `Record<string, any>`，不需要类型握手）。
 * 🔴 **本分册不 import types.ts**（照两个先例的规矩），边不成环。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（设计 §3.4「换图零改码」）。
 *    地形词汇 / 天气词汇 / 国家名 / 中层名 —— 全是**包数据**，随图而变；引擎只有类型、
 *    算法与兜底值。这条由结构闸门 `map-literals-gate.test.ts` 钉死：它扫
 *    `map-*.ts` + `types-map.ts`，剥掉注释后断言零 CJK。**注释里写中文是对的**，
 *    闸门只管注释之外的代码。想给新地形调系数，改的是 mapdata 侧的规则文件后重编译，
 *    不是回来加一个 `case '苔原':`。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`（§3.4 更新契约 /
 * §4 pack 格式 / §6 寻路 / §7 天气 / §8.2 落位契约）。领域词汇在根目录 `CONTEXT.md`
 * 「地图系统」节（位置路径 / 地块 / 落位 / 绑定名字空间 / 锚地块）。
 */

// ═══════════════════════════════════════════════════════════
// 气候与天气（§7）
// ═══════════════════════════════════════════════════════════

/**
 * 加权天气表的一行 —— `[标签, 权重]`。
 *
 * 🔴 标签是**包定义的自由串**，引擎**不设枚举**（§3.4）。它最终原样写进
 * `variables.sys.天气`（只写标签串，不写结构体），下游消费方都是现成的：`<tp>` 栏 /
 * `resolveSceneWeather` / `image-world-tags`。后者是精确匹配表，包换了新词只是**不贡献
 * 出图标签**、不报错 —— 那是它「宁可漏不可猜」的既有契约，不是本类型该来兜的事。
 */
export type WeatherWeight = [label: string, weight: number];

/**
 * 一个气候区的天气画像（pack 内容，按气候区 = 中层，回退国家）。
 *
 * `table` 的键是**季节键**，同样由包定义 —— 引擎不认识「四季」这个概念，只做一次
 * `table[seasonKey]` 查表。历法是内容（12 具名月 / 四季），季节名换了不该动引擎。
 */
export interface ClimateProfile {
  /** 气候区显示名（如极地苔原 / 温带大陆）—— 包数据 */
  name: string;
  /** 季节键 → 加权天气表 */
  table: Record<string, WeatherWeight[]>;
}

/**
 * `weatherAt()` 的产物。
 *
 * 🔴 **刻意只有一个 `label`**（裁定 §12-6）：引擎往 `variables.sys.天气` 里写的就是这个
 * 标签串，同字段、同消费方、零迁移。往这里加温度/风力/湿度看着更完整，实际是给一个
 * 自由文本字段发明第二套结构 —— 而 AI 仍然可以经既有写路径覆盖它（**冲突 AI 赢**），
 * 结构化的那部分立刻失配。
 */
export interface WeatherResult {
  label: string;
}

// ═══════════════════════════════════════════════════════════
// 旅行规则（§3.4 / §6.2）
// ═══════════════════════════════════════════════════════════

/**
 * 随图出包的旅行规则。**默认表由编译脚本持有**（工具链的一部分，与地图同仓同步演化），
 * 引擎只有算法与兜底值。
 *
 * 🔴 `terrainFactor` 缺键时引擎回退 **1.0**（§6.2，先例 `image-world-tags` 的
 *    「宁可漏不可猜」）—— 新地形忘了配系数，结果是「按平地算」而不是崩，也不是 0
 *    （0 会让穿越那种地形变成免费，而且完全无声）。
 * 🔴 `rates` 三档必须是**正数**：`days = ceil(Σcost / rate)`，rate 为 0 时是 Infinity，
 *    落到 UI 上就是一段没有天数的路线。容错解析（`map-pack.ts`）为此拒收 0 与负数。
 */
export interface TravelRules {
  /** 三档费率（km/日）：陆行 / 近海 / 远洋 */
  rates: { land: number; nearSea: number; farSea: number };
  /** 登船/离船的固定代价（像素邻接天然保证它只发生在海岸线上，§6.1） */
  embarkCost: number;
  /** 键 = pack `terrains` 词汇；缺键引擎回退 1.0 */
  terrainFactor: Record<string, number>;
  /**
   * 出行方式预览表（pack v1.1.0 起；旧包缺席 → 空数组，UI 不显示方式选择）。
   * `factor` 乘在整段路线的估算时间上 —— 粗但诚实：天数是给 AI 的锚不是判决，
   * 分段计价留给 v2。数组顺序 = UI 显示顺序，第一项为默认。
   */
  modes: TravelMode[];
}

/**
 * 一种出行方式。`id` 是包内稳定键（ASCII），`label` 是显示文本 —— 引擎把两者都当
 * 不透明数据（结构闸门禁止引擎持有中文词汇，方式词汇随包走，§3.4）。
 */
export interface TravelMode {
  id: string;
  label: string;
  /** 相对基线（factor = 1 的方式，即校准所依据的城际天数速率）的时间倍率，正数 */
  factor: number;
}

// ═══════════════════════════════════════════════════════════
// 地块与行政层（§4）
// ═══════════════════════════════════════════════════════════

/**
 * 水域种类 —— `default.map` 的**集合成员资格**，不是地形（sample 的既有语义）。
 * v1 里 `'sea'` 进混合通行图按水路计价，`'lake'` 一律不可入（§6.1）。
 */
export type MapWaterKind = 'sea' | 'lake';

/**
 * 一个地块 = 地图的最小地理单元（手绘省份）。比场景粗：同城换街区不换地块。
 *
 * 🔴 `id` 是 pack 内的稳定键，**AI 永远看不到它**（§8.3）—— 给 AI 的只有名字与关系
 *    描述。任何把 tileId 写进提示词的投影都是在教 AI 用一个换图就会变的数字说话。
 */
export interface MapTile {
  /** `definition.csv` 的 id（pack 内稳定；AI 永远看不到） */
  id: number;
  /** 地块名 —— 落位的**绑定名字空间**成员（编译期查重） */
  name: string;
  /** 地形，取值 = pack `terrains` 之一；认不出时引擎按系数 1.0 处理 */
  terrain: string;
  /** 水域成员资格；`null` = 陆块 */
  water: MapWaterKind | null;
  /**
   * 不可通行（建图时整块剔出邻接图，照 sample 页语义连邻接都没有）。
   * 🔴 与 `water` **互斥**（编译校验）；容错解析遇到两者同真时**保 impassable**、
   *    把 `water` 打回 null —— 通行性是安全侧，宁可少一条水路，不可放行一块不该进的地。
   */
  impassable: boolean;
  /** 静态所有者（编译期从 titles.txt 烘入，**不支持易手**）；`null` = 无主之地 */
  countryId: string | null;
  /** 所属中层；`null` = 不属于任何中层 */
  midTierId: string | null;
  /**
   * `provinces.png` 里这块地的**权威**块色（RGB 0-255）—— 编译期直接取自 `definition.csv`
   * 那一行，与栅格像素同源。UI 的政治层拿它把像素反查成地块（`buildTileColorLookup`）。
   *
   * 🔴 **可选，缺席合法**：这一格是后加的，早期包与手写占位包没有它。缺席时 UI 回落到
   *    「重算工具链 `colorForId(id)` 哈希」那条旧路，而那条路只在工具链的 `allocColor`
   *    从没为撞色加过盐时才等于真实颜色 —— 加过盐的那一块会被算到**另一块地**的颜色上，
   *    表现是「画错、点错一整块地」且完全无声。所以**有这一格时永远优先用它**。
   * 🔴 引擎不读颜色（同 `MapCountry.color`）：它只服务 UI 的命中检测与着色。
   */
  color?: [r: number, g: number, b: number];
  /** 形心像素坐标（× `kmPerPx` 得距离，§6.2） */
  centroid: [x: number, y: number];
  /** 像素面积 —— 只用于「无首府的中层取最大块」那条锚地块兜底（§8.2-3） */
  areaPx: number;
}

/**
 * 国家（顶层势力）。
 *
 * `anchorTileId` = **锚地块**（首府所在块，编译期预算）：位置路径只写到国家粗度、
 * 且当前块在域外时落到它（§8.2-3）。`null` = 没算出锚，引擎按「域内最大块」兜底。
 */
export interface MapCountry {
  id: string;
  name: string;
  /** 政治层着色（RGB 0-255），UI 用；引擎不读 */
  color: [r: number, g: number, b: number];
  /** 无主之地的占位国（真值时 UI 用中性色，不画势力色） */
  unclaimed?: boolean;
  /** 锚地块；`null` = 编译期没算出来 */
  anchorTileId: number | null;
}

/** 中层（省/区域）—— 气候区的默认粒度（§7），也是落位「只圈域」的一层（§8.2-1） */
export interface MapMidTier {
  id: string;
  name: string;
  /** 所属国家 id；空串 = 未归属（引擎查表未命中时自有兜底） */
  countryId: string;
  /** 气候区 id（查 `MapPack.climates`）；空串 = 未指定，天气回退国家级 */
  climateId: string;
  /** 锚地块；`null` = 编译期没算出来 */
  anchorTileId: number | null;
}

/** 邻接边：`[地块 A, 地块 B, 共享边像素长]`（无向、去重） */
export type MapAdjacencyEdge = [tileA: number, tileB: number, sharedEdgePx: number];

/** 海峡补边：`[地块 A, 地块 B]`（`adjacencies.csv` 的人工补边，像素推导不出来） */
export type MapStrait = [tileA: number, tileB: number];

/**
 * 编译期烘好的**不可变**地图内容包（内容注册表第 8 面 `mapPack`）。
 *
 * 🔴 全装置只有**一个现行包**，存档**不钉包版本**（§3.4-2）：`worldFlags.map.packStamp`
 *    只是个戳（= 本包的 `contentHash`），不符就清掉全部派生态按位置路径重落位。
 *    这是「位置路径为真源」（裁定 §12-1）
 *    的直接红利 —— 一切地图派生态都可重建，所以旧存档永不崩，最坏是棋子短暂未定位。
 */
export interface MapPack {
  /** pack 语义版本，独立于 app 版本 */
  version: string;
  /** 编译期算好；UI 渲染缓存（idBuf / 边界线 / 底图）的失效键（§3.4-3） */
  contentHash: string;
  /** `provinces.png` 栅格尺寸 —— UI 命中检测用，引擎不碰像素 */
  resolution: { w: number; h: number };
  /** 比例尺（§6.3 最小二乘标定；拟合不上时诚实降级为粗估，不硬调） */
  kmPerPx: number;
  /** 地形词汇表 —— 由包定义，引擎不硬编码（§3.4-1） */
  terrains: string[];
  /** 旅行规则（随图出包） */
  travelRules: TravelRules;
  countries: MapCountry[];
  midTiers: MapMidTier[];
  /** 气候区 id → 画像 */
  climates: Record<string, ClimateProfile>;
  tiles: MapTile[];
  adjacency: MapAdjacencyEdge[];
  straits: MapStrait[];
  /** 地名/别名 → tileId（编译期从标记绑定 + 城镇锚点产出）= 落位的**绑定名字空间** */
  placeBindings: Record<string, number>;
}

// ═══════════════════════════════════════════════════════════
// 寻路产物（§6.2）
// ═══════════════════════════════════════════════════════════

/**
 * 一条路线 —— `findPath()` 的唯一产物形状。
 *
 * 🔴 **只有一个标量代价、一条结果**（§1 非目标）：没有成本向量、没有路线偏好、
 *    没有 k 条备选 —— 那是前代设计砍掉的东西。`timeDays` 不是第二个代价维度，
 *    它就是 `days` 取整前的那个数 —— 露出来只为出行方式预览能在乘倍率**之后**再取整
 *    （对取整后的 `days` 乘倍率会放大取整误差）。
 * 🔴 既有 `TravelResult`（types.ts，声明至今零使用）由后续任务退役，**不双轨**。
 */
export interface MapRoute {
  /** 逐块路径（含起点与终点） */
  tilePath: number[];
  /** 天数估算 = `ceil(Σcost / rate)` */
  days: number;
  /** 取整前的总时间（天，基线方式）；`days = tilePath 含边 ? max(1, ceil(timeDays)) : 0` */
  timeDays: number;
  /** 途经的中层/国家名与水段 —— 给回执与 UI 用（名字，不是 id） */
  crossings: string[];
}

// ═══════════════════════════════════════════════════════════
// 每存档可变状态（§4）—— `SaveProfile.worldFlags.map` 的形状
// ═══════════════════════════════════════════════════════════

/**
 * 在途旗。
 *
 * 🔴 **是数据，不是状态机**（§1 非目标）：新计划整份覆盖、到达即清，没有 leg /
 *    checkpoint / 事件调度。前代设计的病根就是把「过程」建模成状态机。
 */
export interface MapJourneyFlag {
  toTileId: number;
  /**
   * 计划路线 —— **advisory**（裁定 §12-7 附加）：叙事偏离时按新位置重估剩余天数，
   * **绝不 enforcement**。把它当权威就等于让代码否决叙事。
   */
  plannedPath?: number[];
  arriveAtMinute: number;
}

/** 天气重断言判据（§7）：跨天 或 换气候区 才重掷，同日同区永远同结果 */
export interface MapWeatherStamp {
  day: number;
  zoneId: string;
}

/**
 * `worldFlags.map` 的形状（**不新增 Dexie 表**，worldFlags 已在 FullBackup 内）。
 *
 * 🔴 全字段可选、且**全部是派生态**：`packStamp` 与现行包不符时，下面各格一律清掉
 *    并按位置路径立即重落位（§3.4-2 自愈）。所以这里永远不该出现「只有这里才有的事实」——
 *    真源是 `CharacterState.location` 那条自由文本路径。
 * 🔴 **只跟踪玩家**（裁定 §12-3，player only throughout）：NPC 的 `set_location` 不写这里，
 *    NPC 地块查询留作按需纯函数调用，不留历史。
 */
export interface MapSaveFlags {
  /**
   * 现行包戳；不符 → 清下面全部派生态并重落位（§3.4-2 自愈）。
   *
   * 🔴 存的是 **`MapPack.contentHash`**，不是 `version`。语义版本是**手写字段**：作者改完地图
   *    重编译时它常常一个字节都不变（正是「随手更新」这条需求的常态），于是自愈判据永远相等、
   *    整条自愈静默失效 —— 而症状是棋子沿着**旧地图**落位，不报错。`contentHash` 是编译期从
   *    内容算出来的，改了地图它必变；UI 的渲染缓存（idBuf / 边界线 / 底图）用的也是它（§3.4-3），
   *    两侧同一个失效键。
   */
  packStamp?: string;
  /** 最近一次成功落位的地块（仅玩家）；落位失败时**保持原值不动** */
  lastTileId?: number;
  journey?: MapJourneyFlag;
  weatherStamp?: MapWeatherStamp;
  /**
   * 上一次落位跨越了几跳（`1` = 不相邻，v1 只区分「相邻」与「不相邻」两态）；
   * 缺席 = 上一次移动是正常的相邻移动（或还没移动过）。
   *
   * 🔴 **只校验不否决**（裁定 §12-4）：不连通照常落位（传送 / 剧情跳转是合法叙事），
   *    这一格只是让下一回合的 `MAP_CONTEXT` 附一条提示行（`MapSnapshot.discontinuity`）。
   *    把它升级成拒绝落位就是让代码否决叙事。
   * 🔴 派生态，随 `packStamp` 不符一起清 —— 换图后「上一跳」这个说法本身就不成立了。
   */
  lastMoveDiscontinuity?: number;
}
