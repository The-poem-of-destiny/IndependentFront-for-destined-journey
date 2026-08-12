# 地图系统 v1 集成设计（2026-08-11）

> 目标：把 `E:\Projects\independentfront-map-system-design\sample-map` 的实验性地块地图接进 app。
> 前代设计（同仓 `doc/01-16`，2026-08-05 ~ 08-10）被裁定为臃肿难测，本文是**从头写的 v1**，
> 只继承它验证过的少数合同（见 §2），其余一概不背。
>
> 状态：**已裁定，可动工**。2026-08-11 grilling 会话逐条走完设计树（12 问 + 数据集选择），
> 全部裁定记录在 §12；领域词汇已入根目录 `CONTEXT.md`「地图系统」节。

## 0. 一句话架构

地图 v1 是**纯状态 + 纯函数**：一份编译期烘好的不可变 map-pack（地块/地形/所有者/邻接/气候），
加五个无 I/O 的引擎纯函数模块（解析/索引/寻路/天气/上下文投影），**不新增 Dexie 表**，
每存档的可变状态只有 `SaveProfile.worldFlags.map` 里的三五个字段。
没有旅程状态机、没有政治裁决器、没有幂等账本 —— 前代设计的病根（把「过程」建模成状态机）一个不留。

### v1 功能清单 ↔ 落点

| 需求           | 落点                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| 地块系统       | map-pack `tiles[]`（316~575 块手绘地块，CK3 形制编译而来）                                  |
| 默认地块所有者 | `MapTile.countryId`（静态，编译期从 `titles.txt` 烘入；**不支持易手**，`history.txt` 不读） |
| 地块相邻关系   | map-pack `adjacency[]`（编译期从 provinces.png 像素推导 + 海峡表）                          |
| 不可通行地块   | `MapTile.impassable`（`default.map` 集合成员资格；建图时整块剔出邻接图）                    |
| 水上地块       | `MapTile.water: 'sea' \| 'lake' \| null`；海块进混合通行图按水路计价（湖块 v1 不可入）      |
| 地形           | `MapTile.terrain`（沿用 sample 的 19 值封闭枚举）                                           |
| 路径规划       | `map-path.ts` 的 `findPath()`（混合通行图 Dijkstra + via/avoid 途经点，输出天数估算）       |
| 天气           | `map-weather.ts` 确定性天气函数（气候区 × 季节 × 种子，无存储）                             |

## 1. 范围

### 铁则：位置路径为真源，地图只跟踪玩家

- **位置路径**（`CharacterState.location` 自由文本连字符路径）是位置的**唯一真源**，地图系统永不改写它的地位；
  地块永远是**落位**（解析投影）的产物，可以为 null / 滞后，绝不权威（裁定 §12-1）。
- **地图状态永远只跟踪玩家**（裁定 §12-3，"player only throughout"）：落位钩子对 NPC 的
  `set_location` 不做任何事。NPC 地块查询留作按需纯函数调用，不留历史。
- 闭环条件：AI 的上下文必须持续展示**真实地块名**（当前块 + 邻接块），使 AI 书写的位置路径
  天然落在绑定名字空间内 —— 读侧是落位成功率的前提，不是装饰（裁定 §12-1 附加条款）。

### 明确不做（v1 非目标）

- **易手 / 占领 / 政治模拟** —— `history.txt`（holder/occupied）整个不读。所有者是编译期常量。
- **旅程状态机** —— 无 leg/checkpoint/事件调度；在途状态只是 worldFlags 里的在途旗（目的地/计划路线/到达时刻，前代 ADR-102 形态）——数据，不是状态机。
- **成本向量 / 路线偏好 / k 条备选** —— 寻路只有一个标量代价，一条结果。
- **战争迷雾 / 知识系统** —— 不在主人给的功能单里，整个推迟（sample 页里的 玩家/全知 视角代码不搬）。
- **地图编辑器进 app** —— 创作留在 sample-map 仓（编辑器 + 校验 + 起名脚本都是创作工具链）。
- **AI 空间写工具** —— 不给任何 agent `map_*` 写工具（前代 ADR-026，继续有效）。
- **组织类覆盖层**（永夜盟约牧区 / 冒险者公会等跨境组织）—— 留在世界书 prose，不建模。
- **移动地块**（巡天王庭在巨兽背上）—— 当普通标记处理，不做活体地块。

## 2. 与前代设计的关系

前代 16 卷已由其 doc 16（SLIM 修订）自我瘦身过一轮。v1 只继承下面这些**验证过的合同**：

| 继承                          | 出处                 | v1 形态                                                                                                                                                                 |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名字→键解析，禁止模糊自动采信 | doc 03 / 16 §3.1     | `resolveTileByLocation()`：精确→归一化→绑定表；不中就返回 null，**绝不 fuzzy 落位**                                                                                     |
| 不可变内容包 + 覆盖层分离     | ADR-004/005/020      | map-pack 走内容注册表（与 catalog/image-dialects 同机制）；每存档只存差量。**每存档钉版本不继承**（§3.4：位置路径为真源使投影可自愈；钉版本是「地块为真源」时代的保险） |
| 写边界保护                    | doc 10 §18 / ADR-026 | AI 只能经既有 `set_location` 改位置；owner/terrain/adjacency 无任何写 op                                                                                                |
| 回执先行叙事                  | ADR-014/101          | Code 先落位再把回执喂给下一回合（§8.2）                                                                                                                                 |
| 三字段在途旗                  | ADR-102              | `worldFlags.map.journey = {toTileId, plannedPath?, arriveAtMinute}`（可选）                                                                                             |
| Dexie 事务替代幂等账本        | ADR-104              | 一切写走 `commitChatState`（ADR-21），不加任何 revision/commandId                                                                                                       |
| fixture 世界测试法            | doc 12               | 引擎测试用 12 块合成 fixture pack，**零真实地名**（承 D25①）                                                                                                            |

**明确翻案的三条前代 ADR**（按 doc 16 的建议显式改判，不是装没看见）：

- **ADR-023**（推迟网格寻路）→ 地块图就是当年推迟的那个东西，现在是主特性。
- **ADR-024**（拒绝万能 ownerId）→ 收窄后允许：**静态、不可转移、单值**的 `countryId` 恰好去掉了当年反对的全部理由（易手/重叠/时限）。
- **ADR-025**（拒绝像素派生距离）→ 当年拒绝的理由是「手绘艺术图未标定」；地块中心距离 × 实测标定系数（§6.3）现在就是模型。

## 3. 数据源与编译管线

### 3.1 创作侧（不变，留在 sample-map 仓）

CK3 形制 `mapdata/` 六件套 + `provinces.png` 是创作真源；编辑器、校验、批量起名、
拆中层脚本全部留在 `E:\Projects\independentfront-map-system-design\sample-map`。
app **永远不解析 CK3 文本格式** —— 那是创作格式，不是运行格式。

已知数据缺陷（编译前要修）：`titles.txt:802` 的 `b_0 { province = 0 }` 绑到了保留 id 0
（现有 `validate()` 不查这条；编译脚本应把「绑定保留 id」升级为 error）。

### 3.2 编译步：`compile-map-pack.mjs`

新脚本，放 sample-map 仓（与 `name-blocks.mjs` 等并列）。输入 `mapdata/`，输出：

1. **`map-pack.json`** —— 语义包（§4 schema）。像素工作只发生在这里一次：
   用 `mapdata.js` 的环境无关半边（`indexPixels` 吃裸 `ImageData`）+ Node PNG 解码，
   推导邻接表 / 形心 / 面积 / 近海远洋分类，连同六件套的声明一起烘进 JSON。
2. **`provinces.png` 原样拷贝** —— UI 命中检测与政治层渲染用（§9），引擎不碰。
3. 校验：`validate()` 全绿 + 绑定保留 id 检查 + 每块地必有 terrain/owner 解析结果，任一 error 拒绝出包。

### 3.3 内容分离（承内容-引擎分离 v1.3 的既有格局）

- **真实数据包**（真实地名/势力）→ 私有内容仓 `fated_poem_independent_assets/data/content/map-pack.json`（+ `provinces.png`、底图 jpg），经 `POEM_CONTENT_DIR` 开发覆盖 / content pack 分发。
- **公开仓**只有中立占位小包（照 `locations.json` 7 节点占位的先例）：十几块合成地块，够跑通全部 UI/引擎路径。
- 注册表：`content-store.ts` 加第 8 面 `mapPack`（面/加载/包段映射三处，先例 `content-store.ts:305/396/467`）。
- 底图 jpg 走既有 `branding.mapSources` + Dexie v21 `mapBlobs` 缓存，不新发明存储。

### 3.4 地图更新契约（裁定 §12-14：换图零改码，存档不钉版本）

需求原文（2026-08-11 追加）：地图要能随手更新；**不承诺旧存档观感兼容，但换图绝不允许
动引擎代码**。三条支柱：

1. **随图而变的数据全在包里，引擎零地图字面量。** 地形词汇与系数、费率、气候/天气词汇表、
   国家/中层/颜色、绑定表、比例尺 —— 全部是 pack 字段（§4 `travelRules`/`climates`/…）。
   规则**默认表由编译脚本持有**（工具链的一部分，与地图同仓同步演化）；引擎只有类型、算法
   与兜底值（未知系数 1.0）。**结构闸门**钉死这条（§10）：`src/sillytavern/map-*.ts` 禁止
   出现任何中文字面量 —— 给新地形调系数，改的是 mapdata 侧的规则文件，重编译即可。
2. **存档不钉包版本，投影自愈。** 全装置只有一个现行包。`worldFlags.map` 记 `packVersion`
   戳；加载或提交时发现与现行包不符 → 清 `lastTileId`/`journey`/`weatherStamp`，按当前
   位置路径立即重落位。旧存档**永不崩**：最坏情况是棋子短暂未定位（下一次移动自动恢复）
   加上天气重掷一次。这是 §12-1「位置路径为真源」的直接红利 —— 一切地图派生态都可重建，
   前代按存档钉 `atlasId@version` + contentHash 的整套保险不再需要。
3. **更新回路一条命令。** 编辑器画完 → `node compile-map-pack.mjs --out <内容仓路径>` →
   dev 覆盖（`POEM_CONTENT_DIR`）刷新即生效；发布走 content pack 既有分发。UI 渲染缓存
   （idBuf / 边界线 / `mapBlobs` 底图）按包 `contentHash` 失效，不会拿旧图的像素配新图的数据。

## 4. Pack 格式与领域模型

```ts
// types-map.ts（分册，先例 types-audio.ts / types-image.ts）
interface MapPack {
  version: string; // pack 语义版本，独立于 app 版本
  contentHash: string; // 编译期算好；UI 渲染缓存的失效键（§3.4）
  resolution: { w: number; h: number }; // provinces.png 栅格（当前 3900×2226）
  kmPerPx: number; // §6.3 标定出的比例尺
  terrains: string[]; // 地形词汇由包定义（当前 = sample 19 值），引擎不硬编码（§3.4）
  travelRules: {
    // 随图出包的旅行规则（§3.4/§6.2）；默认表由编译脚本持有
    rates: { land: number; nearSea: number; farSea: number }; // km/日
    embarkCost: number; // 登/离船固定代价
    terrainFactor: Record<string, number>; // 键 = terrains 词汇；缺键引擎回退 1.0
  };
  countries: { id: string; name: string; color: [number, number, number]; unclaimed?: boolean }[];
  midTiers: { id: string; name: string; countryId: string; climateId: string }[];
  climates: Record<string, ClimateProfile>; // §7
  tiles: MapTile[];
  adjacency: [number, number, number][]; // [tileA, tileB, 共享边像素长]（无向，去重）
  straits: [number, number][]; // adjacencies.csv 海峡补边
  placeBindings: Record<string, number>; // 地名/别名 → tileId（编译期从标记绑定 + 城镇锚点产出）
}

interface MapTile {
  id: number; // definition.csv 的 id（pack 内稳定；AI 永远看不到它）
  name: string;
  terrain: string; // terrains 之一
  water: 'sea' | 'lake' | null; // default.map 集合成员资格
  impassable: boolean; // 同上；water 与 impassable 互斥（编译校验）
  countryId: string | null; // 静态所有者；null = 无主之地
  midTierId: string | null;
  centroid: [number, number];
  areaPx: number;
}
```

要点：

- **两套地形词汇并存，不强行统一**：地块地形用 sample 的 19 值（本 pack 的 `terrains`），
  既有 `TerrainType`（[types.ts:3624](../../src/sillytavern/types.ts)，12 值，含「城市/飞艇」这类非地形值）
  只属于旧语义图的**边**，两者语境不同。v1 只在旅行代价表里做一张单向映射，不动旧类型。
- **不新增 Dexie 表**。每存档可变状态全部进 `SaveProfile.worldFlags.map`
  （worldFlags 见 [types.ts:2757](../../src/sillytavern/types.ts)，已在 FullBackup 内）：

```ts
worldFlags.map = {
  packVersion?: string;             // 现行包戳；不符 → 清下面全部派生态并重落位（§3.4 自愈）
  lastTileId?: number;              // 最近一次成功落位的地块（仅玩家）
  journey?: {                       // 在途旗 = 数据不是状态机：新计划覆盖、到达即清
    toTileId: number;
    plannedPath?: number[];         // 计划路线（advisory：叙事偏离时按新位置重估，不 enforcement）
    arriveAtMinute: number;
  };
  weatherStamp?: { day: number; zoneId: string };  // §7 天气重断言判据
}
```

- `AGENTS.md` 声称存在的 `MapTopology` 类型实际不存在（grep 只中文档）——本次落地时顺手修正文档或用作新类型名。

## 5. 引擎模块（五个纯函数叶 + 接线点）

全部遵循仓规：**纯叶子、注入 I/O、参数拿数据不自己读注册表**（先例 `craft-request.ts` / `image-prompt.ts`）。

| 模块             | 职责                                                                                                                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map-pack.ts`    | 类型 + `coerceMapPack()` 容错解析（**永不抛**，先例 `image-dialect.ts`：坏条目跳过、坏包回退占位包）                                                                                                                                                                                                          |
| `map-index.ts`   | 运行时索引（邻接 Map / 名字索引 / tile→中层→国家链）+ `resolveTileByLocation(pack, locationPath, currentTileId)`：落位契约见 §8.2（最深钉位段 / 中层只圈域 / 锚地块 / **没有 fuzzy**；`audio-scene.buildLocationChain` 的教训是输入是自由文本，本模块的回应是解析失败就保持 `lastTileId` 不动，绝不瞎猜落位） |
| `map-path.ts`    | `findPath(pack, fromTile, toTile, { via?, avoid? })` → `MapRoute`（§6；混合通行图 + 途经点链接 + 回避代价覆盖）                                                                                                                                                                                               |
| `map-weather.ts` | `weatherAt(pack, zoneId, gameDay, seed)` → `WeatherState`（§7，确定性，无存储）                                                                                                                                                                                                                               |
| `map-context.ts` | `buildMapContext(...)` → AI 上下文块文本 + `runtime_geo_compact_data` 投影（§8.1）                                                                                                                                                                                                                            |

接线点（全部是既有缝，不开新写路径）：

| 缝                                                                                                      | 动作                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [state-manager.ts:1142](../../src/sillytavern/state-manager.ts) `applySetLocation`                      | 落位后同一事务内解析 tile、更新 `worldFlags.map.lastTileId`（解析失败保持原值）                                                                                                               |
| [state-manager.ts:1539](../../src/sillytavern/state-manager.ts) `applyTimeAdvance`                      | 跨天时按 `weatherStamp` 判断是否重断言天气（§7）                                                                                                                                              |
| [game-pipeline.ts:801](../../src/ui/lib/game-pipeline.ts) `buildStatData`                               | 补传 `weather`（**既有漂移修复**：`stat-projection.ts:193` 早就会写 `stats.世界.天气`，只是没人供值）                                                                                         |
| [agent-templates.ts:180](../../src/sillytavern/agent-templates.ts) `buildCapabilityInput`               | 补传 `weather`（同上第二处漂移：`ejs-capabilities.ts:304` 的 `world.天气` 永远空串）                                                                                                          |
| [placeholder-registry.ts:209](../../src/sillytavern/placeholder-registry.ts) + `placeholder-catalog.ts` | 新增 `{{MAP_CONTEXT}}`（**两处都要动**，目录文件头有红字）                                                                                                                                    |
| EJS 能力面                                                                                              | `$map` 只读 namespace（currentTile / neighbors(含方位·地形·通行性·异主标注) / ownerOf / weatherNow / journey 摘要），供世界书 EJS 与脚本沙盒查询 —— story 的 MAP_CONTEXT 世界书条目就从它渲染 |
| 提交后胶水（`agent-orchestrator` 提交流程内）                                                           | 读 `variables.sys.旅行目的地`：有值且落位成功 → 设/更新 `worldFlags.map.journey`（含 `findPath` 计划路线与到达估算）；清空或到达 → 清旗。落位失败 = 不设旗，无害（§8.2）                      |

## 6. 路径规划

### 6.1 混合通行图（裁定 §12-7：一张图，不做双档）

陆块与海块进**同一张** Dijkstra 图，按**边的类型**计价，不做「陆行/航行」双档、
更不做前代那种 `(地点, 交通方式)` 状态展开（那是旧设计最大的复杂度来源）：

- 节点 = 非 impassable 且非 lake 的地块（湖块 v1 一律不可入；impassable 建图整块剔除，照 sample 页语义连邻接都没有）。
- 边 = pack `adjacency` ∪ `straits`，按端点类型计价：
  - 陆→陆：步行费率 × 地形系数；
  - 陆↔海：**登/离船固定代价**（像素邻接天然保证只在海岸线存在）；
  - 海→海：航行费率（远洋快于近海）。
- 内建假设（接受的失真）：**任何海岸叙事上总有船可乘**（世界书里商船/魔导客船/破冰船遍布沿岸，
  船由 AI 叙）。不建模「持有船」状态。
- 旋涡级危险水域不是代码问题是数据问题：在 `default.map` 标 `impassable_seas`（格式已支持）。

### 6.2 算法、途经点与代价

```
cost(a→b) = dist(centroid_a, centroid_b) × kmPerPx × edgeFactor(边类型, terrain_b)
days      = ceil(Σcost / rate)
```

- `findPath(pack, from, to, { via?: tileId[], avoid?: tileId[] })`（裁定 §12-7 附加）：
  `via` = 逐段 Dijkstra 链接（玩家在 UI 上点途经点自选路线）；`avoid` = 代价覆盖为 ∞。
  各自都是纯函数上的几行包装 —— **不做**偏好向量 / k 条备选（那是旧设计砍掉的东西）。
- 地形系数与费率在 **pack `travelRules`**（裁定 §12-14 修订 §12-11：规则默认表由编译脚本
  持有、随图出包 —— 换图加地形零改码；前代 ADR-105「规则在一个存档内稳定」的诉求由包版本
  承担）；未知地形系数引擎回退 1.0（宁可漏不可猜，先例 `image-world-tags`）。
- 既有 `TravelResult`（[types.ts:3638](../../src/sillytavern/types.ts)，声明至今零使用）退役，
  新类型 `MapRoute = { tilePath: number[]; days: number; crossings: string[] }`
  （crossings = 途经的中层/国家名与水段，给回执与 UI 用），不再双轨。

### 6.3 标定

世界书 `locations.json` 有 8+ 组城际天数（艾瑟嘉德→金谷城 3 天 / →铁炉堡 7 天 / 白曜城→琥珀加德 2 天…）。
标定法：把这些城市经 `placeBindings` 落到地块，跑 `findPath`，最小二乘拟合一个全局 `kmPerPx`，
写死进 pack。**校准断言放内容仓测试**（引擎测试禁真实地名，D25①）：8 组已知城际天数误差 ≤±30%。
若拟合残差证明手绘比例与世界书天数根本对不上：城际权威天数继续留在 uid 446（它们本来就是
lore 编纂的知识），地块估算降级为粗略「约 N 天」——诚实的粗，不硬调（裁定 §12-11）。

## 7. 天气

原型没有天气；世界书有的是**气候**（诺斯加德每地块带柯本代码与温度区间、其余势力一句话）+
**历法**（12 具名月 / 四季 / 季节现象）。v1 把两者接成一个确定性函数：

```ts
interface ClimateProfile {              // pack 内容，按气候区（默认 = 中层，fallback 国家）
  name: string;                         // 如 '极地苔原' / '温带大陆'
  table: Record<Season, [string, number][]>; // 季节 → 加权天气表；标签词汇由包定义，引擎不设枚举（§3.4）
}

weatherAt(pack, zoneId, gameDay, seed) → { label: string }  // 纯采样，词汇随包走
// 内容仓当前词汇建议：晴/多云/阴/小雨/大雨/雷暴/小雪/暴雪/雾/沙暴/极光（编译脚本默认表）
```

- **纯函数、零存储**：种子 = `(saveId, zoneId, gameDay)`，同日同区永远同结果（快照回退天然一致；随机走 `ejs-rng` 同款种子实现，引擎无 `Math.random`）。
- **权威模型 = Code 兜底 + AI 覆盖**（裁定 §12-6，照效果系统「纯函数兜底 + AI 覆盖」的既有模式）：
  - 引擎在「跨天 或 换气候区」时（`weatherStamp` 判断）把 `weatherAt` 结果写入 `variables.sys.天气` ——
    **只写标签串**（如「小雪」），不写结构体：同字段、同消费方、零迁移；
  - AI 仍可经既有 `sys.天气` 写路径覆盖（叙事性天气：血月、法术风暴）——**冲突 AI 赢**（承 ADR-30 精神）；
  - 下一次跨天引擎重断言，覆盖自然过期。
- 消费方全是现成的：`<tp>` 时间地点天气栏（世界书 system_core 已强制每回合输出）、
  `resolveSceneWeather`（[scene-image-seams.ts:248](../../src/ui/lib/scene-image-seams.ts)）、
  `image-world-tags`（精确匹配表 —— 包词汇保持在映射集内时命中率远高于 AI 自由文本；
  包换新词只是不贡献出图标签，不报错，符合它「宁可漏不可猜」的既有契约）。
- §5 的两处天气供值漂移（buildStatData / buildCapabilityInput）随本项一并修复。

## 8. AI 集成（讨论核心）

### 8.1 读侧：地图 → AI 送什么、何时送、什么格式

**送什么** —— 三层，从细到粗：

1. **`MAP_CONTEXT` 块**（新，每回合，~150-250 token）：当前地块 + 一跳邻接 + 天气 + 在途状态。

```
<map_context>
位置: 白曜城（云息盆地 · 诺斯加德联盟领）｜地形: 平原｜天气: 小雪（寒冬 · 长夜月）
邻接: 北→雾凇海岸(苔原) · 东→内苍白海(近海·需船) · 南→鎏金沃土(草原) · 西→碎冕冰脊-东段(不可通行)
旅行中: 前往铁炉堡，沿计划路线，下一站 驰原省边墙，约还需 3 天
提示: 上回合移动跨越了不相邻地块（如为传送/剧情跳转可忽略）
</map_context>
```

内容边界（裁定 §12-10）：**严格本地一跳**。固定四类行——当前行（地块名·中层·国家 + 地形 +
天气含季节/具名月）、邻接行（形心算罗盘方位 + 地形 + 仅在异主时标所有者 + 不可通行/需船照标）、
在途行（旗存在时）、提示行（至多一条）。**不进**：两跳、tileId、坐标、国家清单、危险度。
预算 4~8 邻接时约 120-250 token。只给**名字**，永不给 tileId/坐标（前代铁则）。

2. **`<runtime_geo>` Mermaid 区域图**（现成消费者，接上就活）：世界书 `extra_setting` uid 446
   「长途移动与地理参考」是一段 `constant: true` 的 EJS 程序，读局部变量 `runtime_geo_compact_data`
   渲染玩家周边的 Mermaid 图（当前地 + 层级 + 1 跳 + 2 跳 + 区域，自带 ≤30 边限流）。
   **引擎今天从未供过这个变量**（全仓 grep 零命中）——条目一直在走空数据回退。
   v1 由 `map-context.ts` 按它的契约（`places[]/edges[]/segments{transport,days,terrain[],direction}`）
   从旧语义图（`locations.json` 34 节点）+ 当前地块投影生成，经 EJS local 命名空间供给。
   **两个尺度并存**：uid 446 管区域级寻路认知（城际、天数），`MAP_CONTEXT` 管本地一跳事实——
   316 块地全塞进 Mermaid 会撑爆它的限流，也没必要。

3. **世界书地理条目**（不动）：faction/adventure_area 的 keyed 条目照旧由关键词命中注入。

**何时送** —— 每回合装配期重算（全是纯函数，无缓存问题）。含 EJS 的条目按 ADR-30 自然沉到
LORE_BOOK 动态尾部，静态前缀字节稳定性不受影响。

**送给谁（通道，这里有个坑）**：

| Agent              | 通道                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| story              | 🔴 **不能走模板占位符** —— story 有预设短路（`assemblePresetContent` 直接顶掉模板）。走**世界书**：内容仓一条 `constant: true` 的小 EJS 条目（读 `$map`），预设用户照样收到 |
| request_dispatcher | 模板在 agent-config.json 里是权威（无短路），直接在模板加 `{{MAP_CONTEXT}}` —— dispatcher 要写 位置/天气/delta_time/旅行目的地，必须看到同一份事实                          |
| vars_update        | **不注入**（裁定 §12-9）：它只执行 dispatcher 的请求清单，不发起空间决策，喂它是纯 token 浪费                                                                               |
| 其余 agent         | v1 不注入（char_gen/craft_gen/memory 用不上地块级事实）                                                                                                                     |

接受的一个后果（裁定 §12-9）：story 的措辞由**内容仓**（世界书 EJS）持有、dispatcher 的措辞由
**app 仓**（模板占位符）持有——同一份 `$map` 数据、两个渲染器。数据不会漂，措辞可能漂；
措辞属创作层 vs 机械层本就该分治，视为特性。

### 8.2 写侧：AI → 地图

**v1 不加新标记、不加新 op**（裁定 §12-4）。沿用既有链路，地图层只做「解析 + 回执」：

```
story 叙事移动
  → request_dispatcher 产 <char_update_request>（既有）
  → vars_update 产 characters.replace[path=location]（既有）
  → set_location（既有 op，applySetLocation；仅玩家触发落位）
  → [新] 同事务解析 location → tileId，更新 worldFlags.map.lastTileId
  → [新] 下一回合 MAP_CONTEXT 反映新位置 = 回执
```

**落位契约**（裁定 §12-2）：

1. 可解析名 = 地块名（编译期查重）+ 绑定到地块的聚落/标记名 + 中层/国家名（后两者只**圈域**）。
2. **取最深的钉位段**；子地块段（城主府/贵族区）忽略——地块比场景粗，这是对的。
3. 路径只写到中层/国家粗度时：当前块已在域内 → **原地不动**（AI 在说模糊话，不动是对的）；
   域外 → 落到该域的**锚地块**（首府所在块，编译期预算；无首府的中层取最大块）。
4. 跨层同名（银帆城-城 在 银帆城-中层 内）取更具体的层；真正无法消歧的重名编译期报 error。
5. 解析失败 → `lastTileId` 保持原值，位置路径原文保留，console 诊断。**永不模糊匹配。**

三条已裁定的行为线：

- **合法性：只校验不否决**（裁定 §12-4）。目的地块与出发块不连通时照常落位（AI 赢——
  传送/剧情跳转是合法叙事），下一回合 `MAP_CONTEXT` 附提示行 + console 诊断。
  硬否决（或升级 `<travel>` 标记）留给真机数据说话后再议——标记是 v1.1 的自然升级，不排斥。
- **旅行时间：AI 权威 + Code 事前锚定，不 clamp**（裁定 §12-5）。`delta_time` 维持 AI 写；
  Code 的贡献是把路线天数估算放进 `MAP_CONTEXT` 给 dispatcher 当锚。clamp 需要区分
  「AI 草率」与「AI 在叙传送」，patch 本身无从判断，clamp 错了就是当面打脸叙事
  （前代 doc 16 的核心教训）。若真机显示锚被无视：先紧 dispatcher 模板，clamp 是最后手段。
- **叙事发起的旅程也进旗**（裁定 §12-8）：dispatcher 模板教它在队伍立志启程/放弃/到达时写
  `sys.旅行目的地`（一个普通变量路径，无新 op 无标记）；提交后胶水（§5 接线表）落位该名字，
  成功则设 `journey` 旗（含 `findPath` 计划路线），到达/清空则清旗。落位失败 = 不设旗，无害。
  由此「剩余约 N 天」的锚对**叙事发起**的旅程同样存在，不只 UI 发起的。

**玩家选路与 NPC 荐路**（裁定 §12-7 附加）：

- 玩家在 UI 上点目的地 → 默认路线预览；点中途地块加 `via` 途经点（或标 `avoid`）→
  「出发」把**按名字**写的路线并入下一条用户消息（「【地图】玩家决定启程前往铁炉堡，
  取道隐风关，避开悲鸣沼泽，约 7 天」），story 照常叙事，落位走同一条链。**不开第二条写路径。**
- NPC 荐路**零协议**：AI 从 MAP_CONTEXT/runtime_geo 看得到邻接与地形，向导自然能说
  「走隘口比穿沼泽快」；队伍走哪条，落位逐站跟踪。计划路线是 advisory 数据——
  叙事偏离 `plannedPath` 时按新位置重估剩余天数，绝不 enforcement。

### 8.3 保护面

- AI 永远看不到 tileId / 像素坐标 / 邻接原始表 —— 只有名字与关系描述。
- owner/terrain/adjacency/impassable **不存在任何写 op** —— 无需守卫，路径本身不存在。
- 天气：story 的 `<tp>` 栏由预设要求"照抄状态栏天气"；引擎断言值就是状态栏值（§7）。

## 9. UI（MapPanel 新「势力地图」页签）

现有 `MapPanel.vue`（OSD 底图 + 手放图钉）保留为「标记地图」页签；新增「势力地图」页签，
**自包含移植 sample 页的渲染栈，不做 OSD 叠加集成**（裁定 §12-12）：sample 栈对着这份数据
实测调通过（构建 280ms / hover 缓存后 0.2ms / RDP 边界简化），改写成 OSD overlay 等于把
坐标映射、重绘时机、命中检测对着 OSD 缩放模型重推一遍——纯集成风险，v1 零收益。
代价是一个 Modal 里两套平移缩放实现（每页签一套），接受；统一是 v2 的审美问题
（91 个标记的 `nx/ny` 与政治层同底图归一化，将来要画到同一面上没有障碍）。

- **渲染**：底图 jpg（既有 mapBlobs 缓存）+ 政治着色层 + 边界线。直接移植 sample 页
  `buildFromMapData` 的已验证路径：运行时 canvas 解码 `provinces.png` → `idBuf`（Int32Array）
  → 整幅 ImageData 半透明着色（alpha≈100，透出底图）→ RDP 简化 SVG 边界线。
  实测预算：575 块 / 8.7M 像素约 280ms、一次性内存峰值 ~200MB、常驻 idBuf 35MB ——
  只在页签首次打开时构建，关 Modal 释放。引擎侧零像素依赖（邻接在 pack JSON 里）。
- **交互**：hover 提示（地块名/所有者/地形）；点击 → 信息卡（名字/国家/中层/地形/天气/通行性）
  - 「查看路线」（从当前位置跑 `findPath`，高亮 tilePath + 显示天数）+ 途经点自选
    （点中途地块加 via / 标 avoid，路线实时重算）+ 「出发」（§8.2 注入旅行指令）。
- **玩家位置**：`worldFlags.map.lastTileId` 高亮；解析失败时显示"位置未在地图上定位"而不是瞎指。
- 顺手修已知 bug：`MapPanel.schedulePersist()` 是无操作空壳，标记编辑从不落库
  （`setMapMarker`/`removeMapMarker` 只有测试调用方）—— 与本设计无耦合，可拆单独任务。

## 10. 测试

- **引擎**：12 块合成 fixture pack（两国 + 无主 + 水带 + 湖 + 不可通行山脊 + 一条海峡），零真实地名。
  - 性质测试（先例 `image-quota.property.test.ts`）：路径永不穿 impassable / lake；水段两端必是
    海岸邻接（登离船只发生在有邻接的岸线）；`via` 顺序保持、`avoid` 生效；路径对称；
    `weatherAt` 同参幂等；`coerceMapPack` 对任意坏输入不抛。
  - 表测试：边类型系数表、天气加权表、`resolveTileByLocation` 的落位契约五条（§8.2）逐条三态。
  - **结构闸门**（§3.4）：`src/sillytavern/map-*.ts` 禁止中文字面量（先例
    `start-catalog-mechanics.test.ts` 的导出名黑名单闸门）—— 地图词汇只许活在 pack 里。
  - **换包自愈**：同一存档热换 fixture pack（`packVersion` 变）→ 派生态清空、按位置路径
    重落位、不抛不崩（§3.4）。
- **内容仓**：§6.3 标定断言（8 组城际天数 ±30%）+ pack 编译校验全绿 + 编码三判据
  （中文 JSON，`encoding-invariants.test.ts` 已自动覆盖 `data/`）。
- **接线**：从 `commitChatState(set_location)` 到 `worldFlags.map.lastTileId` 的链路测试
  （教训是 `blurByDefault`——单组件测试证明逻辑对、证明不了有人供值；两处天气漂移同因）。

## 11. 实施切片（lean-delegation 波次草案）

| 波  | 内容                                                                                                          | 出口                         |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| W0  | 编译脚本（sample-map 仓）+ pack schema + 修 titles.txt 数据缺陷 + 占位 fixture pack（公开仓）                 | pack 编译全绿                |
| W1  | 引擎五模块 + fixture 测试 + 性质测试                                                                          | `npm run typecheck` + 测试绿 |
| W2  | 接线：set_location 钩子 / 天气断言 / 两处天气漂移修复 / `{{MAP_CONTEXT}}` / uid 446 供数据 / `$map` namespace | 链路测试绿                   |
| W3  | UI 势力地图页签（渲染/交互/路线预览/出发）                                                                    | 组件测试 + 真机走查          |
| W4  | 真实 pack 编译进内容仓 + 标定 + 真机 debug loop                                                               | 校准断言绿                   |

## 12. 裁定记录（2026-08-11 grilling 会话，主人逐条拍板）

| #   | 议题         | 裁定                                                                                                                                                                                                                                                         |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 位置身份     | **位置路径为真源，地块为落位投影**；附加条款：AI 上下文必须持续展示真实地块名（读侧是落位成功率的前提）                                                                                                                                                      |
| 2   | 落位契约     | 最深钉位段 / 中层国家只圈域 / 域内模糊话原地不动、域外落**锚地块** / 跨层同名取具体层 / 永不模糊匹配（五条全文见 §8.2）                                                                                                                                      |
| 3   | 跟踪范围     | **永远只跟踪玩家**（"player only throughout"），NPC 落位留作按需纯函数                                                                                                                                                                                       |
| 4   | 写侧协议     | **被动解析 + 软回执**，只校验不否决；`<travel>` 标记留作 v1.1 升级路径                                                                                                                                                                                       |
| 5   | 旅行时间权威 | **AI 写 delta_time + Code 事前锚定**，不 clamp；锚被无视先紧模板                                                                                                                                                                                             |
| 6   | 天气权威     | **Code 兜底 + AI 覆盖 + 跨天重断言**；引擎只写标签串不写结构体                                                                                                                                                                                               |
| 7   | 水域通行     | **混合通行图**（一张图按边类型计价，登离船固定代价，船叙事上总可得）；附加：`via`/`avoid` 途经点支持玩家自选路线，NPC 荐路零协议                                                                                                                             |
| 8   | 叙事发起旅程 | **允许**：dispatcher 写 `sys.旅行目的地` 普通变量，提交后胶水落位设旗；失败不设旗                                                                                                                                                                            |
| 9   | 注入通道     | story=世界书 constant EJS 条目（免疫预设短路）/ dispatcher=`{{MAP_CONTEXT}}` 模板占位符 / vars_update 与其余 agent 不注入；同一 `$map` 真源、两个渲染器                                                                                                      |
| 10  | 载荷边界     | MAP_CONTEXT **严格本地一跳**（四类行，120-250 token）；uid 446 `<runtime_geo>` 保持区域尺度契约不变，v1 终于给它供数据                                                                                                                                       |
| 11  | 规则归属     | ~~地形系数/费率 = 引擎常量~~（**已被 #14 修订**：迁入 pack `travelRules`，默认表归编译脚本）；`kmPerPx` = pack 数据（编译期最小二乘拟合，拟合失败诚实降级为粗估）                                                                                            |
| 12  | UI 渲染      | **自包含移植 sample 渲染栈**为新页签，不做 OSD 叠加集成；两套平移缩放并存可接受，统一留给 v2                                                                                                                                                                 |
| 13  | 首发数据集   | **316 块手绘 WIP 现状直接出第一版 pack**，链路先通，数据后补（pack 是内容，热替换）                                                                                                                                                                          |
| 14  | 地图更新契约 | **换图零改码**（2026-08-11 追加需求）：随图数据全进 pack（含地形系数/费率/天气词汇），引擎地图模块零中文字面量（结构闸门）；**存档不钉包版本**，投影按位置路径自愈（清派生态重落位，旧存档永不崩）；更新回路一条编译命令 + `contentHash` 缓存失效。§3.4 全文 |

领域词汇（位置路径/地块/落位/绑定名字空间/锚地块）已入根目录 `CONTEXT.md`「地图系统」节。

---

### 附：本设计吸收的关键侦察结论（防遗忘）

- 引擎已有 `location-db.ts`（34 节点语义图 + `$location`），但**零 agent 消费方**；玩家位置是
  `CharacterState.location` 自由文本连字符路径，`set_location` op 零校验。
- 时间系统完备（`applyTimeAdvance` 唯一入口，`delta_time` 走带外通道）；天气 = `variables.sys.天气`
  自由文本，AI 写、两处引擎供值漂移使 EJS/stats 永远看不到它。
- story 预设短路：改 story 模板/systemPrompt 对预设用户无效，**世界书条目是 story 的可靠注入面**。
- 世界书 uid 446 是现成的 AI 地理接口（EJS→Mermaid），引擎从未供数——接上即活。
- sample-map：创作数据 CK3 形制；邻接/近海远洋由代码推导；`mapdata.js` 有环境无关半边可复用；
  水域与不可通行是集合成员资格而非地形；原型无天气。
