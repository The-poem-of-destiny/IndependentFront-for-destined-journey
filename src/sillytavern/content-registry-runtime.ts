/**
 * content-registry-runtime.ts — 现行内容注册表的**注入缝**（内容-引擎分离 D16 / §5.1）
 *
 * 装什么: 「当前生效的内容注册表是哪一份」这一个模块级事实。`installContentRegistry`
 *         由前端（`src/ui/stores/content-store.ts` 的 `setContentRegistry`）在首轮占位
 *         加载 / 装包 / 卸载重灌时调用，引擎侧（`agent-tools` 的品牌面、`random-tables`
 *         的名字池、`bloodlines` 的血脉集、`location-db` 的地点集）只读。
 * 不装什么: **任何 I/O**（不 fetch、不读 Dexie）、任何容错解析、任何策略。
 *           逐面的形状校验在各消费方自己那儿（它们本来就各有一套「坏行丢弃」的口径），
 *           三态解析（pack > 占位）在接线层（content-store 的 `resolveSection`）。
 *
 * 为什么要一条缝而不是让引擎自己去 import content-store:
 * 先例 `engine-settings.ts`（Q-06）与 `map-runtime.ts` / `random-event-runtime.ts`
 * （地图 v1 / 随机事件 v1）—— 引擎要的是「当前生效的内容」这个**能力**，不是
 * 「content-store 那个模块级变量」这个位置。这四个消费方各自 `import '../ui/stores/content-store'`
 * 就是把依赖方向反过来：引擎从此依赖 Vue + Pinia + Dexie 整条前端链，
 * headless 跑批与引擎单测都得把整个 store 拖起来。
 *
 * 🔴 **时序契约（本缝最承重的一条，原文承 `location-db.ts` / `bloodlines.ts` 的旧注释）**：
 *    读取一律**惰性、按调用时刻**发生 —— 引擎模块 import 的那一刻注册表多半还没灌注
 *    （content-store 的 `ensureContentRegistryLoaded()` 在 boot 链上、`app.mount` 之后）。
 *    所以：
 *      · 消费方**不许**在模块顶层把 `getContentRegistry()` 的读数缓存成常量；
 *        缓存一份就会让装完包的目录还是旧的，而那种漂移不报错，只是「怎么点都还是老地方」。
 *      · 没人装过时返回**空骨架**（十面全 `undefined`）而不是 `null`/抛异常 ——
 *        它与 content-store 此前 `createEmptyRegistry()` 的产物**逐字段相同**，
 *        于是四个消费方走的是它们本来就有的那条兜底路径（查不到 = undefined / [] / ''）。
 *
 * 🔴 **整份替换、不深合并**（同 content-store 的既有纪律）：装包重灌时整份盖，
 *    简单且不会留下「占位常量与 pack payload 半混」的半状态。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md` §5.1 / D16 / D20 / D24 / D25。
 */

/**
 * 内容注册表的各面（D16 / §5.1；第 7 面 imageDialects 由图像 v2 追加，
 * 第 8 面 mapPack 由地图系统 v1 追加，`randomEvents` 由随机事件系统 v1 追加、
 * `remoteAssets` 由远程素材 v1 追加 —— 后两者在 `ContentPack` 里分别是**第 13 / 第 14
 * 分节**，两套编号各数各的，别混着读）。
 *
 * 约定 URL: `/data/content/<name>.json`（灌注方在 content-store 的
 * `CONTENT_REGISTRY_SOURCES`；引擎侧不认识 URL，只认识值）。
 *
 * 每面的值都是 `unknown`：这里只立契约，真实形状由各消费方自己收窄。这与
 * `PackCatalogSection.data: unknown` / `PackNamePoolsSection.data: unknown`
 * （types-content.ts）同口径 —— pack 透传、planner 不解释结构。
 *
 * 🔴 类型住在**缝这一侧**（照 `engine-settings.ts` 的 `EngineSettings`）：它就是
 *    「引擎与 UI 之间的内容契约」本身。留在 content-store 里，引擎要用它就还得
 *    type-only import 回去 —— 那条边照样是反的，且 `verbatimModuleSyntax` 关掉时
 *    它还会变成真实运行时依赖。content-store 侧 re-export 同一个名字，UI 消费方不受影响。
 */
export interface ContentRegistry {
  /** 捏人目录池（D24） */
  catalog: unknown;
  /** 地点节点（D25①） */
  locations: unknown;
  /** 血脉集（D25②） */
  bloodlines: unknown;
  /** 名字池 / 发色 / 瞳色 / 性格池（D25③） */
  namePools: unknown;
  /** 地图标记预设（D23，MapPanel 用） */
  markers: unknown;
  /** 品牌面（D26：应用名/副标题/era/credits 等） */
  branding: unknown;
  /** 提示词方言（图像 v2 / C4）：`{ dialects: [...] }`。缺席 → 内置兜底方言 */
  imageDialects: unknown;
  /**
   * 地图内容包（地图系统 v1 / §3.3）：`map-pack.json` 的原始 JSON。
   *
   * 🔴 **引擎侧的消费方一个都不读这一面** —— 落位/寻路/天气/`$map` 读的是
   * `map-runtime.getMapPack()`。本面只是那个事实的**来源**（content-store 的
   * `setContentRegistry` 经 `coerceMapPack` 装进去）。
   */
  mapPack: unknown;
  /**
   * 随机事件包（随机事件系统 v1 / §3.3）：`random-events.json` 的原始 JSON。
   *
   * 🔴 与 `mapPack` 逐字同款：消费方读的是 `random-event-runtime.getRandomEventPack()`，
   * 不是这一面。
   */
  randomEvents: unknown;
  /**
   * 远程素材声明（远程素材 v1）：`remote-assets.json` 的原始 JSON（裸数组）。
   *
   * 🔴 与 `mapPack` / `randomEvents` **不同：没有为它派生的第二条缝**。那两面装进
   * `map-runtime` / `random-event-runtime` 的是 `coerce*` 之后的**派生包**，所以
   * `setContentRegistry` 里各有一行对应的 `install*` 副作用；这一面没有，读它的人
   * 直接 `getContentRegistry().remoteAssets` 拿原值。它的唯一消费方还在 UI
   * （`ui/lib/remote-asset-sync.ts` 的同步服务）—— 引擎侧一个字节都不读它，
   * 这一面住在本文件只是因为**注册表的形状是一整个**，不是因为引擎需要它。
   *
   * 🔴 缺席不是错误：波 1 的 `normalizePackRemoteAssets` 吃到 `undefined` 返回空数组，
   * 于是「声明清单」里只剩世界书那一半，同步照跑。
   */
  remoteAssets: unknown;
}

/**
 * 造一份空注册表骨架。
 *
 * 🔴 **每次返回新对象**，不导出一个共享常量（照 `random-event-runtime.createEmptyPack`
 *    的同一个理由）：导出的引用被下游改一格，此后所有走兜底路径的调用都被污染 ——
 *    而兜底恰恰是没人手工验的那条。
 */
export function createEmptyContentRegistry(): ContentRegistry {
  return {
    catalog: undefined,
    locations: undefined,
    bloodlines: undefined,
    namePools: undefined,
    markers: undefined,
    branding: undefined,
    imageDialects: undefined,
    mapPack: undefined,
    randomEvents: undefined,
    remoteAssets: undefined,
  };
}

/** 现行注册表。没人装过时是空骨架（兜底合同，见文件头时序契约） */
let installed: ContentRegistry = createEmptyContentRegistry();

/**
 * 整份装上一份注册表。**刻意不做容错**（keep dumb）：三态解析（pack > 占位）与逐面
 * 收窄都是调用方（content-store）的事 —— 在这里再来一遍就等于有两处口径，
 * 而两处不一致时先出错的那一处永远没人手工验。
 *
 * 唯一的运行时闸是「不是对象」：调用方是前端 store，那一面缺席时交过来的可能是
 * `undefined`，而 TS 类型在跨模块边界上拦不住它。落成空骨架（= 没装）比让
 * `getContentRegistry().branding` 当场抛穿好 —— 四个消费方都有空值兜底路径。
 */
export function installContentRegistry(next: ContentRegistry): void {
  installed = next !== null && typeof next === 'object' ? next : createEmptyContentRegistry();
}

/**
 * 当前注册表（**同步**读取）。
 *
 * 同步是硬要求：`agent-tools` 的工具执行路径、`random-tables` 的抽样、`$location`
 * 的拓扑查询都在同步函数里读它，不能为读一个常量再等一次 IO。
 *
 * 🔴 **每次调用现取**，别把返回值存进模块级常量（文件头时序契约那条）。
 */
export function getContentRegistry(): ContentRegistry {
  return installed;
}

/**
 * 回到「没装过」（测试用）。
 *
 * 模块级状态在 vitest 里跨用例存活，装过真夹具的用例不还原就会让后面每一个
 * 「注册表未就绪应当兜底成空」的断言悄悄测在一份真内容上 —— 那种失败方向是**变绿**，
 * 不是变红。
 */
export function resetContentRegistryRuntime(): void {
  installed = createEmptyContentRegistry();
}
