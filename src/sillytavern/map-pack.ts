/**
 * map-pack.ts — 地图内容包的容错解析（纯函数，地图系统 v1 / 设计 §3.4·§4）
 *
 * 装什么: `coerceMapPack(unknown) → MapPack` —— 内容注册表第 8 面 `mapPack` 的收窄口，
 *         外加空包常量 `EMPTY_MAP_PACK` 与判据 `isEmptyMapPack`。
 * 不装什么: 任何 I/O、任何索引/寻路/天气/投影逻辑（各在自己的 `map-*.ts` 里）。
 *           也**不做编译期校验** —— 「每块地必有 terrain/owner」「water 与 impassable 互斥」
 *           「重名消歧」那类 error 由 sample-map 仓的编译脚本拒绝出包（§3.2）。
 *           本层是运行时的最后一道兜底，职责是**别崩**，不是替作者修数据。
 *
 * 🔴 **本模块永不抛**（先例 `image-dialect.ts` / `workshop-manifest.ts`）。map-pack.json 来自
 *    内容包 —— 第三方可编辑、可整份热替换的数据。一个手滑的字段让整个游戏页白屏是不可
 *    接受的。容错口径：
 *      · 认不出的**条目**整条跳过（地块/国家/中层/边/绑定各自独立）
 *      · 认不出的**旋钮**只有那一格回落（半懂的包比整个丢掉有用得多）
 *      · 整份认不出（null / 数字 / 串 / 数组）→ 空包
 *
 * 🔴 **空包是合同的一部分，不是异常**：下游五个模块都必须能吃 0 地块的包（落位永远返回
 *    null、寻路永远无路、天气回退、上下文块整段不出）。这正是 §3.4-2「投影自愈」的形状 ——
 *    位置路径是真源，地块只是投影，投影为空时游戏照常进行，只是棋子没在图上。
 *
 * 🔴 **本文件里不许出现任何中文字面量**（§3.4-1，结构闸门 `map-literals-gate.test.ts` 钉死）。
 *    这里一条中文兜底值（比如给缺名地块补个默认名）就是把内容焊回引擎 —— 换图时它不跟着变。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md`。
 */

import type {
  ClimateProfile,
  MapAdjacencyEdge,
  MapCountry,
  MapMidTier,
  MapPack,
  MapStrait,
  MapTile,
  MapTileInitialBuilding,
  MapTileMainBuilding,
  MapWaterKind,
  TravelRules,
  WeatherWeight,
} from './types-map';

// ═══════════════════════════════════════════════════════════
// 兜底值
// ═══════════════════════════════════════════════════════════

/**
 * 空包的版本戳。
 *
 * 🔴 **它不是 `isEmptyMapPack` 的判据**（判据是「零地块」，见那个函数）。一个真包完全可以
 *    忘了写 version，那时它的 version 是空串而不是这个值 —— 拿版本串当判据会让「忘写版本」
 *    和「整份没解析出来」变成同一件事，而这两者的处置完全不同。
 */
const EMPTY_PACK_VERSION = 'empty';

/**
 * 三档费率与比例尺的兜底 = **恒等值 1**。
 *
 * 🔴 刻意不填「像那么回事」的默认值（比如 30 km/日）。缺 `travelRules` 的包是坏包，
 *    此时算出来的天数必须**显眼地错**（一段路 300 天），而不是静默地像（10 天）——
 *    后者会被当成真答案喂给 dispatcher 当旅行时间的锚（§8.2 裁定 §12-5）。
 * 🔴 但**绝不能是 0**：`days = ceil(Σcost / rate)`，rate 为 0 得 Infinity，
 *    `kmPerPx` 为 0 则每段路都免费 —— 两个方向都是无声的错。
 */
const IDENTITY_RATE = 1;

/** 空的旅行规则（每次新建，理由同 `createEmptyMapPack`） */
function createIdentityTravelRules(): TravelRules {
  return {
    rates: { land: IDENTITY_RATE, nearSea: IDENTITY_RATE, farSea: IDENTITY_RATE },
    embarkCost: 0,
    terrainFactor: {},
    modes: [],
  };
}

/**
 * 建一个**全新**的空包。
 *
 * 🔴 每次新建而不是共享一个冻结常量：`EMPTY_MAP_PACK` 是导出的引用，任何调用方往
 *    `pack.tiles` 里 push 一次，就会污染此后所有走兜底路径的调用 —— 而兜底路径恰恰是
 *    没人会手工验的那条（先例 `image-dialect.ts` 兜底常量那条注释）。
 *    `coerceMapPack` 因此返回**深相等但不同一**的空包，判据一律走 `isEmptyMapPack`。
 */
function createEmptyMapPack(): MapPack {
  return {
    version: EMPTY_PACK_VERSION,
    contentHash: '',
    resolution: { w: 0, h: 0 },
    kmPerPx: IDENTITY_RATE,
    terrains: [],
    developmentLevels: [],
    mainBuildingNames: [],
    travelRules: createIdentityTravelRules(),
    countries: [],
    midTiers: [],
    climates: {},
    tiles: [],
    adjacency: [],
    straits: [],
    placeBindings: {},
  };
}

/**
 * 空包 —— 整份输入认不出时 `coerceMapPack` 返回的形状（深相等，见 `createEmptyMapPack`）。
 * 下游模块**必须**能吃它：这是兜底合同，不是异常态。
 */
export const EMPTY_MAP_PACK: MapPack = createEmptyMapPack();

// ═══════════════════════════════════════════════════════════
// 取值原语（照 image-dialect / workshop-manifest：拿不到就给缺省，绝不抛）
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 数字收窄 —— 认不出返回 `null`（调用方据此跳过或回落）。
 *
 * 🔴 `Number()` 的三个陷阱在这里被显式堵住，因为它们全都产出**合法数字**：
 *      `Number('')` → 0、`Number('  ')` → 0、`Number([])` → 0、`Number(true)` → 1。
 *    「字段缺失/写成空串」于是会冒充**地块 0**（真实数据里恰好存在的保留 id，见 §3.1 那条
 *    已知数据缺陷），而 `true` 会冒充地块 1。所以只收「有穷数字」与「非空数字串」。
 *    数字串是刻意收的：pack 由 CSV 编译而来，`"12"` 这种形态很常见。
 */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 数字，认不出时回落给定值 */
function readNumberOr(value: unknown, fallback: number): number {
  return readNumber(value) ?? fallback;
}

/** 非空字符串，认不出（含空串）时回落给定值 */
function readNonEmpty(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** 允许为空串的字符串；非字符串回落空串 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 布尔；非布尔一律 false（`'true'` 这种串**不**当真 —— 那是包写错了，不是另一种写法） */
function readBoolean(value: unknown): boolean {
  return value === true;
}

/** 字符串或 null（空串读作 null —— 对 `countryId` 这类外键，空串与「无」同义） */
function readIdOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** RGB 三元组；认不出回落全 0（UI 会画成黑，看得见；引擎不读颜色） */
function readColor(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [0, 0, 0];
  const r = readNumber(value[0]);
  const g = readNumber(value[1]);
  const b = readNumber(value[2]);
  if (r === null || g === null || b === null) return [0, 0, 0];
  return [r, g, b];
}

/**
 * 地块块色 —— 认不出返回 `undefined`（**不是** `readColor` 的全 0 回落）。
 *
 * 🔴 与国家色刻意不同处：国家色坏了画成黑就行（看得见、且引擎不读）；地块色是 UI 把**像素
 *    反查成地块**的钥匙，一个凭空的 `[0, 0, 0]` 会声称自己是栅格里的「未绘制」保留色 ——
 *    要么整块地被查表丢掉，要么把整片没画的区域认成这块地。缺席才是诚实的答案：UI 据此
 *    回落「重算工具链哈希」那条旧路，那条路对不上时表现为「认不出颜色的像素数 > 0」，
 *    是看得见的（先例 `image-world-tags` 的「宁可漏不可猜」）。
 * 🔴 只收 0-255 的整数，**不做取模**：栅格反查用的键是 `(r << 16) | (g << 8) | b` 配 `& 255`，
 *    把 300 收成 44 就是**替包发明一个别的颜色**，而它会安静地命中另一块地。
 *    小数同理不收 —— 通道值不可能有小数，圆整它等于猜。
 */
function readTileColor(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const channels: number[] = [];
  for (let i = 0; i < 3; i++) {
    const channel = readNumber(value[i]);
    if (channel === null || !Number.isInteger(channel) || channel < 0 || channel > 255)
      return undefined;
    channels.push(channel);
  }
  return [channels[0]!, channels[1]!, channels[2]!];
}

/**
 * 发展档序数的上下界（v1.2 / §F2）：档 1..10 ↔ 建筑槽 1..10。
 *
 * 🔴 这**不是**中文词汇 —— 档名随包（`developmentLevels`），引擎只认序数。
 *    10 这个数字是机制（槽数上限），不是内容，所以它留在引擎里是对的。
 */
const MIN_DEVELOPMENT_LEVEL = 1;
const MAX_DEVELOPMENT_LEVEL = 10;

/** 正数费率：0 与负数一律回落（见 `IDENTITY_RATE` 那条注释） */
function readPositiveRate(value: unknown, fallback: number): number {
  const parsed = readNumber(value);
  return parsed !== null && parsed > 0 ? parsed : fallback;
}

// ═══════════════════════════════════════════════════════════
// 分节解析
// ═══════════════════════════════════════════════════════════

/** 地形词汇：只留非空字符串，去重保序 */
function coerceTerrains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * **按下标寻址的档位序数表**（pack v1.2.0）—— 两张表共用这一份实现：
 * `developmentLevels`（发展档名，§F2）与 `mainBuildingNames`（主建筑通名，§F4b·裁定 §8-18）。
 * 缺席/整节坏 → 空表（v1.0/v1.1 旧包的常态；UI 退化成序号、主建筑退化成 ASCII 兜底串，
 * 机制面一律不受影响）。
 *
 * 🔴 **不去重**（与 `coerceTerrains` 刻意不同）：丢掉一行会让它后面每一档的序号整体前移 ——
 *    于是「第 7 档」在 UI 上显示成第 8 档的名字，而机制面（槽数）仍按 7 算。
 *    地形表是集合，档位表是序列，两者的「重复」不是一回事。
 * 🔴 **只砍不补**：多于 10 档丢掉尾部（超出的档位引擎永远到不了），少于 10 档照收 ——
 *    「恰好 10 档」是内容仓 verify 门的判据，本层是最后一道兜底，不替作者补数据。
 * 🔴 两张表**共用一份实现是刻意的**：它们的规则逐字相同，各抄一份的代价是两张同构表
 *    某天行为不一样，而没有任何东西会变红。
 */
function coerceOrdinalNameTable(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue;
    out.push(item);
    if (out.length >= MAX_DEVELOPMENT_LEVEL) break;
  }
  return out;
}

/**
 * 地块起始档（pack v1.2.0；§F2）。认不出/缺席 → `undefined`。
 *
 * 🔴 **缺席不是档 1**（见 `MapTile.development` 那条注释）：`undefined` = 这块地没有
 *    发展度（海/湖/不可通行块的常态），档 1 = 处在最低档且有 1 个建筑槽。给缺席补个 1
 *    等于凭空给每一块海面发一个建筑槽。
 * 🔴 小数不收（**不圆整**）：档位是序数，圆整它等于替包猜一个别的档 —— 照 `readTileColor`
 *    对通道小数的同款口径。越界则**钳进合法带**：槽数由档数直接推导，一个 12 档的地块
 *    会长出 12 个槽，而降档摧毁按最高号槽走 —— 那是内容错误在机制面的放大。
 */
function coerceTileDevelopment(raw: unknown): number | undefined {
  const parsed = readNumber(raw);
  if (parsed === null || !Number.isInteger(parsed)) return undefined;
  return Math.min(MAX_DEVELOPMENT_LEVEL, Math.max(MIN_DEVELOPMENT_LEVEL, parsed));
}

/**
 * 地块初始建筑（pack v1.2.0；§F3）。缺席/非数组 → `undefined`（那一格不长出来，
 * 照 `color` 的写法）；坏条目整条跳过；同名首见胜（`name` 是地块内逻辑键）。
 *
 * 🔴 这里**不收** `playerOwned` / `income`：所有权翻转只经叙事 op（裁定 §8-9），
 *    包里写了也当没写 —— 收下它就是给编译期开一条绕过那条通道的后门。
 * 🔴 条数不裁（不按起始档数截断）：那是内容仓 verify 门的判据，且运行时截断会**静默**
 *    丢掉作者写的建筑。播种时按最小空槽落位，装不下的自然落不进去，看得见。
 */
function coerceTileBuildings(raw: unknown): MapTileInitialBuilding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MapTileInitialBuilding[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const name = readNonEmpty(item.name, '');
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);

    const row: MapTileInitialBuilding = { name };
    const description = readNonEmpty(item.description, '');
    if (description.length > 0) row.description = description;
    const ownerFlavor = readNonEmpty(item.ownerFlavor, '');
    if (ownerFlavor.length > 0) row.ownerFlavor = ownerFlavor;
    out.push(row);
  }
  return out;
}

/**
 * 地块主建筑的**作者命名**（pack v1.2.0；§F4b）。缺席/非对象/无名 → `undefined`
 * （那一格不长出来，照 `color` 与 `buildings` 的写法）。
 *
 * 🔴 缺席**不是「这块地没有主建筑」**：每个可通行陆块恒有一座（裁定 §8-17），缺的只是
 *    名字 —— 引擎按当前档从 `mainBuildingNames` 派生通名。所以这里绝不替作者兜一个名字：
 *    兜出来的会**钉住**（作者名不随档变），于是那块地永远叫兜底串。
 * 🔴 同 `buildings`：**不收** `playerOwned` / `income`（裁定 §8-9·§8-19 所有权只经叙事 op）。
 */
function coerceTileMainBuilding(raw: unknown): MapTileMainBuilding | undefined {
  if (!isRecord(raw)) return undefined;
  const name = readNonEmpty(raw.name, '');
  if (name.length === 0) return undefined;

  const row: MapTileMainBuilding = { name };
  const description = readNonEmpty(raw.description, '');
  if (description.length > 0) row.description = description;
  const ownerFlavor = readNonEmpty(raw.ownerFlavor, '');
  if (ownerFlavor.length > 0) row.ownerFlavor = ownerFlavor;
  return row;
}

/**
 * 旅行规则。整节缺席 → 恒等规则；单格认不出 → 只回落那一格。
 * `terrainFactor` 只收有穷数字，负数一并丢（负系数会让 Dijkstra 失去意义）。
 */
function coerceTravelRules(raw: unknown): TravelRules {
  const out = createIdentityTravelRules();
  if (!isRecord(raw)) return out;

  const rates = raw.rates;
  if (isRecord(rates)) {
    out.rates.land = readPositiveRate(rates.land, IDENTITY_RATE);
    out.rates.nearSea = readPositiveRate(rates.nearSea, IDENTITY_RATE);
    out.rates.farSea = readPositiveRate(rates.farSea, IDENTITY_RATE);
  }

  const embark = readNumber(raw.embarkCost);
  if (embark !== null && embark >= 0) out.embarkCost = embark;

  if (isRecord(raw.terrainFactor)) {
    for (const [key, value] of Object.entries(raw.terrainFactor)) {
      if (key.length === 0) continue;
      const factor = readNumber(value);
      if (factor === null || factor < 0) continue;
      out.terrainFactor[key] = factor;
    }
  }

  // 出行方式：坏条目整条跳过（半条方式没有意义），id 重复首见胜；缺席/全坏 → 空数组
  if (Array.isArray(raw.modes)) {
    const seen = new Set<string>();
    for (const item of raw.modes) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const factor = readNumber(item.factor);
      if (id.length === 0 || label.length === 0) continue;
      if (factor === null || factor <= 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.modes.push({ id, label, factor });
    }
  }
  return out;
}

/**
 * 地块。**跳过**的三种条目（各自都是「留下来只会更坏」）：
 *   ① 不是对象 / `id` 认不出 —— 没有 id 的地块无法被邻接表与绑定表引用，是个孤儿
 *   ② `name` 空 —— 既进不了绑定名字空间（永远落不了位）、也没法在上下文块里露面；
 *      而唯一不含中文字面量的兜底名是 `String(id)`，那等于把 tileId 泄进 AI 看得见的
 *      名字空间（§8.3 明令禁止）
 *   ③ `centroid` 认不出 —— 形心参与代价计算，`[0, 0]` 兜底会让这块地静默地贴在原点上，
 *      对靠近原点的一切都显得又近又便宜。宁可整块不在图上（它的邻接边随后会被清掉）
 *
 * id 重复只留**第一条**（先到先得是稳定的；数组里的「后者赢」依赖遍历顺序）。
 *
 * 可选的 `color` 是**逐格宽容**的：坏值只丢那一格（见 `readTileColor`），地块照留 ——
 * 它是 UI 的着色/命中钥匙，不是地块存在与否的判据。
 */
function coerceTiles(raw: unknown): MapTile[] {
  if (!Array.isArray(raw)) return [];
  const out: MapTile[] = [];
  const seen = new Set<number>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readNumber(item.id);
    if (id === null || seen.has(id)) continue;

    const name = readNonEmpty(item.name, '');
    if (name.length === 0) continue;

    const centroid = item.centroid;
    if (!Array.isArray(centroid) || centroid.length < 2) continue;
    const x = readNumber(centroid[0]);
    const y = readNumber(centroid[1]);
    if (x === null || y === null) continue;

    const impassable = readBoolean(item.impassable);
    const water = coerceWater(item.water, impassable);
    const areaPx = readNumberOr(item.areaPx, 0);

    seen.add(id);
    const tile: MapTile = {
      id,
      name,
      terrain: readText(item.terrain),
      water,
      impassable,
      countryId: readIdOrNull(item.countryId),
      midTierId: readIdOrNull(item.midTierId),
      centroid: [x, y],
      areaPx: areaPx >= 0 ? areaPx : 0,
    };
    // 坏色**只丢这一格**（照 `unclaimed` 的写法只在有值时挂上，不写 `color: undefined`）
    const color = readTileColor(item.color);
    if (color !== undefined) tile.color = color;
    // v1.2 两格同口径：认不出就是缺席（旧包因此逐字节等于从前）
    const development = coerceTileDevelopment(item.development);
    if (development !== undefined) tile.development = development;
    const buildings = coerceTileBuildings(item.buildings);
    if (buildings !== undefined) tile.buildings = buildings;
    const mainBuilding = coerceTileMainBuilding(item.mainBuilding);
    if (mainBuilding !== undefined) tile.mainBuilding = mainBuilding;
    out.push(tile);
  }
  return out;
}

/**
 * 水域成员资格。
 *
 * 🔴 **`impassable` 赢**（`MapTile.impassable` 那条注释的落点）：两者同真是编译期该拒的包，
 *    运行时只能二选一，而通行性是安全侧 —— 少一条水路只是路线绕远，放行一块声明为不可通行
 *    的水域则是让队伍走进设计上不许进的地方（旋涡级危险水域正是用 impassable 标的，§6.1）。
 */
function coerceWater(raw: unknown, impassable: boolean): MapWaterKind | null {
  if (impassable) return null;
  return raw === 'sea' || raw === 'lake' ? raw : null;
}

/** 国家。`id` 认不出整条跳过；`name` 回落 id（照 `parseImageDialects` 的 label 回落） */
function coerceCountries(raw: unknown): MapCountry[] {
  if (!Array.isArray(raw)) return [];
  const out: MapCountry[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readNonEmpty(item.id, '');
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);

    const row: MapCountry = {
      id,
      name: readNonEmpty(item.name, id),
      color: readColor(item.color),
      anchorTileId: readNumber(item.anchorTileId),
    };
    if (readBoolean(item.unclaimed)) row.unclaimed = true;
    out.push(row);
  }
  return out;
}

/**
 * 中层。`countryId` / `climateId` 认不出时留**空串**而不是整条跳过 —— 两者都是查表用的
 * 外键，未命中时引擎自有兜底（气候回退国家级、无国家就是无主）；地块 id 才必须严格，
 * 因为它会被直接当图节点用。
 */
function coerceMidTiers(raw: unknown): MapMidTier[] {
  if (!Array.isArray(raw)) return [];
  const out: MapMidTier[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = readNonEmpty(item.id, '');
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      name: readNonEmpty(item.name, id),
      countryId: readText(item.countryId),
      climateId: readText(item.climateId),
      anchorTileId: readNumber(item.anchorTileId),
    });
  }
  return out;
}

/**
 * 气候画像表。
 *
 * 逐条规则：
 * - 值不是对象 → 整个气候区跳过
 * - `name` 认不出 → 回落**气候区 id**（不是中文默认名，§3.4-1）
 * - 加权表里权重 ≤ 0 或认不出的行 → 丢掉那一行（0 权重永远采样不到，负权重会把加权
 *   采样算法整个弄坏 —— 而它坏的方式是安静地偏向某一个标签）
 * - 某季节键剩下 0 行 → **连键一起丢**（空表与缺席在 `weatherAt` 里必须走同一条兜底，
 *   留个空数组只会让下游多一种要考虑的形状）
 */
function coerceClimates(raw: unknown): Record<string, ClimateProfile> {
  if (!isRecord(raw)) return {};
  const out: Record<string, ClimateProfile> = {};

  for (const [zoneId, value] of Object.entries(raw)) {
    if (zoneId.length === 0 || !isRecord(value)) continue;
    const table: Record<string, WeatherWeight[]> = {};

    if (isRecord(value.table)) {
      for (const [seasonKey, rows] of Object.entries(value.table)) {
        if (seasonKey.length === 0 || !Array.isArray(rows)) continue;
        const weights: WeatherWeight[] = [];
        for (const row of rows) {
          if (!Array.isArray(row) || row.length < 2) continue;
          const label = readNonEmpty(row[0], '');
          const weight = readNumber(row[1]);
          if (label.length === 0 || weight === null || weight <= 0) continue;
          weights.push([label, weight]);
        }
        if (weights.length > 0) table[seasonKey] = weights;
      }
    }

    out[zoneId] = { name: readNonEmpty(value.name, zoneId), table };
  }
  return out;
}

/**
 * 邻接边收窄（海峡表复用它，只是把第三格去掉）。
 *
 * 丢边的四种情形：非数组、端点认不出、**自环**（`a === b`，Dijkstra 里是纯噪声）、
 * 端点指向**不存在的地块**（悬空引用 —— 建图时会变成一个查不到的节点，
 * 而症状是路径从中间断掉，不是报错）。
 * 无向去重按 `min-max` 规范键，只留第一条（共享边长以第一条为准）。
 */
function coerceAdjacency(raw: unknown, tileIds: ReadonlySet<number>): MapAdjacencyEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: MapAdjacencyEdge[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const a = readNumber(item[0]);
    const b = readNumber(item[1]);
    if (a === null || b === null || a === b) continue;
    if (!tileIds.has(a) || !tileIds.has(b)) continue;

    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 海峡表只有两格，第三格缺席读作 0（它只是 UI/权重用的共享边长，不影响连通性）
    const shared = readNumberOr(item[2], 0);
    out.push([a, b, shared >= 0 ? shared : 0]);
  }
  return out;
}

/**
 * 海峡补边 —— 与邻接同一套判据，只是不带共享边长。
 *
 * 🔴 **不与 `adjacency` 交叉去重**：重复一条边在建图时是幂等的（union 后仍是一条），
 *    而为了「整洁」去掉它需要两节之间的顺序耦合 —— 那种耦合是后来加节时静默出错的来路。
 */
function coerceStraits(raw: unknown, tileIds: ReadonlySet<number>): MapStrait[] {
  return coerceAdjacency(raw, tileIds).map(([a, b]): MapStrait => [a, b]);
}

/**
 * 绑定名字空间。空键、认不出的 tileId、**悬空** tileId 一律丢 ——
 * 一条指向不存在地块的绑定会让落位「成功」到一个查不到的块上，比落位失败更坏
 * （失败时 `lastTileId` 保持原值，是安全的；成功到虚空则整条链都在错的前提上跑）。
 */
function coercePlaceBindings(raw: unknown, tileIds: ReadonlySet<number>): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name.length === 0) continue;
    const tileId = readNumber(value);
    if (tileId === null || !tileIds.has(tileId)) continue;
    out[name] = tileId;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════

/**
 * 内容注册表 `mapPack` 面 → `MapPack`（容错，**永不抛**）。
 *
 * 外层只认对象。`null` / 数字 / 字符串 / **数组** → 空包
 * （数组刻意不收：外层形状由注册表的 `Pack*Section` 类型声明并由校验器守，
 *  解析器只对**内容**宽容，不替作者猜他把整节写成了什么别的形状 ——
 *  这是 `parseImageDialects` 那条「两处各说一套就是一句读代码的人会信的假话」的同款收口）。
 *
 * 解析顺序是承重的：**先地块、后引用**。邻接/海峡/绑定/锚地块四处都要拿地块 id 集合
 * 过滤悬空引用，所以它们必须在 `tiles` 之后。
 */
export function coerceMapPack(input: unknown): MapPack {
  if (!isRecord(input)) return createEmptyMapPack();

  const tiles = coerceTiles(input.tiles);
  const tileIds = new Set(tiles.map((tile) => tile.id));

  const resolution: Record<string, unknown> = isRecord(input.resolution) ? input.resolution : {};

  return {
    version: readText(input.version),
    contentHash: readText(input.contentHash),
    resolution: {
      w: Math.max(0, readNumberOr(resolution.w, 0)),
      h: Math.max(0, readNumberOr(resolution.h, 0)),
    },
    kmPerPx: readPositiveRate(input.kmPerPx, IDENTITY_RATE),
    terrains: coerceTerrains(input.terrains),
    developmentLevels: coerceOrdinalNameTable(input.developmentLevels),
    mainBuildingNames: coerceOrdinalNameTable(input.mainBuildingNames),
    travelRules: coerceTravelRules(input.travelRules),
    countries: dropDanglingAnchors(coerceCountries(input.countries), tileIds),
    midTiers: dropDanglingAnchors(coerceMidTiers(input.midTiers), tileIds),
    climates: coerceClimates(input.climates),
    tiles,
    adjacency: coerceAdjacency(input.adjacency, tileIds),
    straits: coerceStraits(input.straits, tileIds),
    placeBindings: coercePlaceBindings(input.placeBindings, tileIds),
  };
}

/**
 * 悬空锚地块 → `null`（不是丢掉整个国家/中层：名字仍要用于「圈域」，只是没有落脚点）。
 * 引擎随后按「域内最大块」兜底（§8.2-3）。
 */
function dropDanglingAnchors<T extends { anchorTileId: number | null }>(
  rows: T[],
  tileIds: ReadonlySet<number>,
): T[] {
  for (const row of rows) {
    if (row.anchorTileId !== null && !tileIds.has(row.anchorTileId)) row.anchorTileId = null;
  }
  return rows;
}

/**
 * 这个包能不能定位任何东西。
 *
 * 🔴 判据是**零地块**，不是 `version === 'empty'`：一个真包完全可能忘了写 version
 *    （那时它是空串），而一个 0 地块的包无论版本戳写什么都同样不可用。
 *    调用方拿它决定「要不要整段跳过地图投影」，问的正是这件事。
 */
export function isEmptyMapPack(pack: MapPack): boolean {
  return pack.tiles.length === 0;
}
