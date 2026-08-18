/**
 * content-store.ts — 内容-引擎分离（波 1）的 provider 执行层（D16 / §5.1）。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md` §5.1 / §5.5 / §5.8 / D16。
 * 纯函数半边在 `src/sillytavern/content-source.ts`（T1，已落地）。
 *
 * 本文件管三件事:
 *
 * 1. **模块级 ready promise**（时序契约，D16）。🔴 这是最承重的一条：
 *    `settings-store` 的构造器在 `main.ts`（`useSettingsStore()`）里、`app.mount` **之前**
 *    就 `setTimeout(0)` 触发 `loadAgentProjectDefaults()`，而那条链现在改调
 *    `loadProjectDefaults()`。App.vue 的 init 链根本拦不住这个时序。所以 ready promise
 *    **必须在模块加载时创建**（任何 `import` 都会触发），谁先到都等它。
 *    `loadProjectDefaults()` 先 `await readyPromise` 再读盘——这保证「装包」叠加层（T7）
 *    有机会在 fetch 落地之前就灌注进内存层。
 *
 * 2. **contentStatus**（D16 / §5.5）。三处 fetch 收口 + AgentConfigPanel raw 读 +
 *    audio manifest + beautifier + builtin-worldbooks 全部经 provider 上报内容态。
 *    行为兜底不变（失败不阻塞启动）；现在失败进 `contentStatus='error'` 而不是静默。
 *
 * 3. **内容注册表**（D16）。八面（catalog/locations/bloodlines/namePools/markers/branding/
 *    imageDialects/mapPack）的同步读取入口，约定 URL `/data/content/<name>.json`
 *    （markers 例外，见 `CONTENT_REGISTRY_SOURCES`）。消费方（agent-tools 同步路径 /
 *    random-tables / bloodlines / $location）**同步**读它，所以注册表必须在任何 agent 执行前灌注完成——
 *    两段保证：模块顶层同步 `seedPlaceholderRegistry()`（保证非 null 骨架），
 *    boot 链上 `loadProjectDefaults()` 里的 `ensureContentRegistryLoaded()`（灌真值，
 *    波 2 逐面接管的落点；pack 安装（T7）重灌走 `setContentRegistry`）。
 *
 * 本波（T2）交付范围:
 * - 模块级 ready promise（带时序断言测试）
 * - `loadProjectDefaults()` —— 三处 fetch 收口入口（await ready + 占位 fetch 路径，
 *   pack 叠加是 T7 的活，本波先不实现 pack 解析）
 * - `loadRawProjectDefaults()` —— 显式绕过 pack 叠加层，读原始盘上文件（AgentConfigPanel 的
 *   读-改-写回路径用，D16）
 * - `setContentRegistry()` / `getContentRegistry()` 骨架 + 占位灌注
 * - `contentStatus` + `reportContentFetch()` 上报口（供 §5.5 七处 fetch 调用）
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §5.1 / §5.5 / §5.8 / D16
 */

import { defineStore, getActivePinia } from 'pinia';
import { ref } from 'vue';
import { detach } from './db-write';
import type { ContentStatus } from '@engine/types-content';
// 占位基线清单：随引擎打包的静态资源（设计 §6），**不是**内容树的一部分。
import placeholderHashesRaw from '@engine/placeholder-hashes.json';
import type { ChatPreset, SaveSlot, WorkshopNote, WorldBook } from '@engine/types';
import type {
  ContentPack,
  PackBaseline,
  PackInstallPlan,
  PackSaveUidMigration,
  PackValidationNote,
} from '@engine/types-content';
import {
  setContentFetchReporter,
  validatePackOrThrow,
  planPackInstall,
  hashWorldBook,
  setPackRulesProvider,
  resolveSection,
  // 🔴 别名导入：store 内部另有一个同名 action（`reportContentFetch`），
  //    在 setup 作用域里会遮蔽这个模块级导入。模块级路径（注册表加载器）用别名，
  //    读代码时一眼能分清「引擎注入缝」与「store action」。
  reportContentFetch as reportEngineContentFetch,
} from '@engine/content-source';
// 第 8 面 mapPack 的收窄口（永不抛）+ 引擎侧地图缝（见 `setContentRegistry`）
import { coerceMapPack } from '@engine/map-pack';
import { installMapPack } from '@engine/map-runtime';
// 第 13 面 randomEvents 的收窄口（永不抛）+ 引擎侧随机事件缝（见 `setContentRegistry`）
import { coerceRandomEventPack } from '@engine/random-event-pack';
import { installRandomEventPack } from '@engine/random-event-runtime';
// 注册表本体的引擎侧注入缝（见 `setContentRegistry` / `getContentRegistry`）
import {
  createEmptyContentRegistry,
  installContentRegistry,
  getContentRegistry as getInstalledContentRegistry,
} from '@engine/content-registry-runtime';
import type { ContentRegistry } from '@engine/content-registry-runtime';
import {
  planPackUninstall,
  diffPackUpgrade,
  buildPackBaseline,
  type CurrentLibrary,
  type PackUninstallPlan,
  type PackUpgradeDiff,
} from '@engine/content-pack-plan';
import {
  getDatabase,
  exportAllData,
  importAllData,
  savePresets,
  deletePreset,
  deletePresets,
} from '@engine/database';
import type { ContentPackRecord } from '@engine/database';

// ═══════════════════════════════════════════════════════════
// 1. 模块级 ready promise（D16 时序契约）
// ═══════════════════════════════════════════════════════════

/**
 * provider 是否就绪（pack 叠加层已确定）。
 *
 * 🔴 **在模块加载时创建，而不是在 store 构造器里**。
 * 设计 D16 裁定：`settings-store` 构造器在 `main.ts`、`app.mount` 之前就 `setTimeout(0)`
 * 触发 `loadAgentProjectDefaults()`（它现在改调 `loadProjectDefaults()`），所以 ready
 * promise 不能依赖「App.vue init 链先跑」—— 那条链根本拦不住。
 * 模块级创建保证任何 `import './content-store'` 都会触发它，谁先到都等。
 *
 * 本波（T2）resolve 立即触发（无 pack 叠加需要等待）；T7 接 pack 装载后会改成本包解析
 * 完成才 resolve。**调用方一律 `await readyPromise`**，不要直接读 `isReady`。
 */
// resolveReady 在下面的 Promise 构造器里同步赋值（构造器立即执行），
// 所以在 markContentReady 调用它之前必定已绑定。用 `!` 抑制「未赋值」告警。
let resolveReady!: () => void;
export const contentReadyPromise: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

/** 是否已就绪（仅用于诊断断言，业务路径必须 await promise） */
export let isContentReady = false;

/**
 * 标记 provider 就绪。本波立即 resolve（占位 fetch 路径不需要等）。
 * T7 装包执行器在解析完 pack 后调此函数。
 */
export function markContentReady(): void {
  if (isContentReady) return;
  isContentReady = true;
  resolveReady();
}

// ═══════════════════════════════════════════════════════════
// 1b. 占位基线清单（D20 / D42，面 4）—— `placeholder-hashes.json` 加载接口
// ═══════════════════════════════════════════════════════════

/**
 * `placeholder-hashes.json` 的装载产出（D20 / D42）。
 *
 * 🔴 **占位基线来源 = 构建期生成、随引擎打包的占位 hash 清单**（`placeholder-hashes.json`），
 * **不许运行时 fetch `/data/*` 现算**（D20 裁定：POEM_CONTENT_DIR overlay 生效时那里是
 * 真实内容树）。它是 D20 四态基线、D42 重播种、卸载 re-seed 三处的共同输入。
 *
 * 清单由 T15 的 `scripts/build-placeholder-hashes.mjs` 生成到
 * `src/sillytavern/placeholder-hashes.json`，本模块**静态 import**（见 `loadPlaceholderHashes`）。
 * 「空清单」仍是合法态（四态规则的「无占位基线 → 首次安装回落 updated / conflicted」分支
 * 仍可用，卸载 re-seed 与 D42 重播种在该态是 no-op）—— 但**空清单不该再由取不到文件造成**，
 * 那正是它此前静默失效的方式。
 *
 * `version` 戳供 D42 重播种比对：戳前进时对「hash 仍等于占位基线」的书重播种。
 */
export interface PlaceholderHashManifest {
  /** 占位集版本戳（D42）：settings.placeholderVersion 与之比对，前进时才重播种 */
  version: string;
  /** 世界书 id → 正文确定性 hash */
  byBook?: Readonly<Record<string, string>>;
  /** 预设 id → 行 hash */
  byPreset?: Readonly<Record<string, string>>;
  /** 美化规则 id → 行 hash */
  byBeautifierRule?: Readonly<Record<string, string>>;
}

let placeholderHashesPromise: Promise<PlaceholderHashManifest> | null = null;
let placeholderHashesCache: PlaceholderHashManifest = { version: '' };

/**
 * 加载占位基线清单（幂等，结果缓存到模块级）。
 *
 * 🔴 **静态 import，不 fetch**（设计 §6）。T7 初版写的是
 * `fetch('/data/placeholder-hashes.json')`，那条路两头都不对：
 * ① 清单由 T15 产在 `src/sillytavern/placeholder-hashes.json`（随引擎打包），
 *    `/data/` 下**根本没有这个文件** —— 那次 fetch 永远 404、永远回落空清单，
 *    而空清单是**合法态**（四态回落 updated/conflicted），所以它不报错、不变红，
 *    只是让 D20 基线、D42 重播种、卸载 re-seed 三处一起静默失效。
 * ② 就算把文件放过去也是错的：`POEM_CONTENT_DIR` overlay 生效时 `/data/*` 是**真实内容**，
 *    拿真实内容当「占位基线」比对，等于把每一本都判成「用户没改过」。
 *
 * 保留 async 签名（三处调用方都 await），只是现在没有 I/O 了。
 */
function loadPlaceholderHashes(): Promise<PlaceholderHashManifest> {
  if (placeholderHashesPromise) return placeholderHashesPromise;
  placeholderHashesPromise = (async () => {
    const raw = placeholderHashesRaw as Record<string, unknown>;
    placeholderHashesCache = {
      version: typeof raw?.version === 'string' ? raw.version : '',
      byBook: raw?.byBook as PlaceholderHashManifest['byBook'],
      byPreset: raw?.byPreset as PlaceholderHashManifest['byPreset'],
      byBeautifierRule: raw?.byBeautifierRule as PlaceholderHashManifest['byBeautifierRule'],
    };
    return placeholderHashesCache;
  })();
  return placeholderHashesPromise;
}

/** 取已加载的占位基线（未加载返回空清单；内部同步读） */
function getPlaceholderHashes(): PlaceholderHashManifest {
  return placeholderHashesCache;
}

/** 重置占位基线缓存（仅供测试 afterEach 隔离；生产不调）。下次读取回落到打包清单。 */
export function resetPlaceholderHashesCache(): void {
  placeholderHashesPromise = null;
  placeholderHashesCache = { version: '' };
}

/**
 * 覆写占位基线清单（**仅供测试**；生产不调）。
 *
 * 清单改成静态 import 之后，测试再也不能靠 mock fetch 供给合成基线了 —— 而四态判定
 * （updated / conflicted / needs_selection / 重播种）全靠它，没有覆写口就只能拿打包的
 * 真占位集当夹具，那等于把测试钉死在占位内容的具体字节上。
 */
export function setPlaceholderHashesForTests(manifest: PlaceholderHashManifest): void {
  placeholderHashesCache = manifest;
  placeholderHashesPromise = Promise.resolve(manifest);
}

/** 占位清单 → PackBaseline（喂给 planner 的双基线之一；内部用） */
function placeholderHashesToBaseline(manifest: PlaceholderHashManifest): PackBaseline {
  return {
    byBook: manifest.byBook,
    byPreset: manifest.byPreset,
    byBeautifierRule: manifest.byBeautifierRule,
  };
}

// ═══════════════════════════════════════════════════════════
// 1c. 已装 pack 的模块级缓存（D18：整包入库，恢复默认/卸载/升级无须重读文件）
// ═══════════════════════════════════════════════════════════

/**
 * 模块级已装 pack 缓存（`contentPacks` 表最新一条/主 pack 的投影）。
 *
 * 🔴 **模块级而非 store 实例级**：beautifier-store 的 `refreshPresetRules`（§5.6 恢复默认）
 * 和 branding 等同步消费方在读它，不能等 Pinia store 构造。装包 / 卸载执行器 update 它，
 * boot 时序 `hydratePackState()` 从 Dexie 载入。
 */
let activePackRecord: ContentPackRecord | null = null;

/** 当前已装的 pack 记录（未装返回 null；同步读） */
function getActivePackRecord(): ContentPackRecord | null {
  return activePackRecord;
}

/** 当前已装的 pack payload（未装返回 undefined） */
function getActivePackPayload(): ContentPack | undefined {
  return activePackRecord?.payload;
}

/** 整份替换模块级 pack 缓存（装包/卸载执行器 + boot hydrate 用） */
export function setActivePackRecord(record: ContentPackRecord | null): void {
  activePackRecord = record;
  // 同步 pack 美化规则 provider（D20：pack 规则走 provider 内存层）。
  // 传 null = 占位态，beautifier-store 回落占位文件。
  // 🔴 不写 `?? []`：pack 未声明 beautifierRules 分节（absent）应回落占位文件
  //    （D20 三态：absent = 无话可说），只有显式 [] 才是刻意清空。
  setPackRulesProvider(record ? () => record.payload.beautifierRules?.rules : null);
  // 🔴 provider 挂载/替换后必须让 beautifier-store 重算 presetRules（2026-08-07 真机
  //    竞态：App.vue 的 beautifier.init() 先于 boot 的 hydratePackState，init 时 provider
  //    未挂 → 回落占位 5 条，之后没人再刷新 → 装包后美化一直是占位规则）。
  //    本函数刻意保持同步、不在这里刷新 —— 刷新动作放在调用方的 async 链
  //    （hydratePackState / uninstallPack），避免 fire-and-forget 污染测试时序。
}

// ═══════════════════════════════════════════════════════════
// 1d. 「恢复默认」的 provider 真源（D21 / §5.6）
// ═══════════════════════════════════════════════════════════

/**
 * 取一本书的「默认真源」—— 已装 pack payload > 占位文件（§5.6 恢复默认矩阵）。
 *
 * per-book `resetSingleWorldBook` 与全局 `resetToDefaults` 都用它：恢复这些书 = 拿
 * pack.payload 里这本书（装包后）或占位文件里的书（未装/没发这本书）。语义与 `resolveSection`
 * 一致：pack 声明了 worldBooks 分节就用它（含刻意 `[]`），否则占位。
 *
 * @param id 世界书 id
 * @returns pack payload 里的书；pack 未声明 worldBooks 分节时回落占位文件；都没有 → undefined
 */
export async function loadDefaultBook(id: string): Promise<WorldBook | undefined> {
  const pack = getActivePackPayload();
  if (pack?.worldBooks !== undefined) {
    const found = pack.worldBooks.find((b) => b.id === id);
    if (found) return { ...found, builtIn: true };
  }
  const { loadBuiltInWorldBooks } = await import('@engine/builtin-worldbooks');
  const books = await loadBuiltInWorldBooks();
  return books.find((b) => b.id === id);
}

/**
 * 取「整套默认世界书」—— 已装 pack payload > 占位文件（§5.6 全局恢复）。
 *
 * global `resetToDefaults` 用它：恢复全部默认书 = pack.payload.worldBooks（装包后）> 占位书。
 */
export async function loadAllDefaultBooks(): Promise<WorldBook[]> {
  const pack = getActivePackPayload();
  if (pack?.worldBooks !== undefined) {
    return pack.worldBooks.map((b) => ({ ...b, builtIn: true }));
  }
  const { loadBuiltInWorldBooks } = await import('@engine/builtin-worldbooks');
  return loadBuiltInWorldBooks();
}

// ═══════════════════════════════════════════════════════════
// 2. 内容注册表（D16，八面同步读取）
// ═══════════════════════════════════════════════════════════

/**
 * 内容注册表的各面（D16 / §5.1；第 7 面 imageDialects 由图像 v2 追加，
 * 第 8 面 mapPack 由地图系统 v1 追加，`randomEvents` 由随机事件系统 v1 追加、
 * `remoteAssets` 由远程素材 v1 追加 —— 后两者在 `ContentPack` 里分别是**第 13 / 第 14
 * 分节**，两套编号各数各的，别混着读）。
 *
 * 🔴 **定义已迁到引擎侧的注入缝** `@engine/content-registry-runtime`（分层收口）：
 * 四个**同步**消费方（agent-tools / random-tables / bloodlines / $location）全在引擎里，
 * 它们此前各自 `import '../ui/stores/content-store'` —— 依赖方向是反的。逐面的语义注释
 * （哪一面缺席不是错误、哪两面的消费方压根不读注册表）全部原文搬进那个文件的文件头与字段注释。
 *
 * 这里只 re-export 同一个名字，让既有 UI 消费方（`create-store` / 组件 / 测试）路径不变。
 */
export type { ContentRegistry } from '@engine/content-registry-runtime';

/**
 * 当前注册表（同步读取；agent-tools 等同步路径用）。
 *
 * 🔴 **注册表只有一份存储，就在引擎侧的注入缝里**（本函数只是转发）。曾经的写法是
 * store 与缝**各存一份**（照 `mapPack` / `randomEvents` 那两面的先例，它们装进缝的是
 * `coerce*` 之后的**派生值**，两份不是同一个东西所以无妨）。注册表本体不同：两处存着
 * 同一份事实，就能各说各话 —— 而症状不是报错，是「装完包了，可引擎那边的目录还是旧的」。
 * 故这里刻意**不留**模块级 `let registry`。
 */
export function getContentRegistry(): ContentRegistry {
  return getInstalledContentRegistry();
}

/**
 * 整份替换注册表。pack 安装执行器（T7）/ boot 占位灌注调用。
 *
 * 🔴 **整份替换**：不做深合并（避免占位常量与 pack payload 半混的半状态）。
 * 调用方应先用 `resolveSection`（content-source.ts，D20 三态）算出最终值再传进来。
 *
 * 🔴 **顺带把第 8 面装进引擎的地图缝**（地图系统 v1 / §3.3）。这个副作用是刻意的：
 * `mapPack` 与其余七面不同 —— 它的消费方全在引擎侧（`state-manager` 的落位与天气钩子、
 * `$map` 能力面），读的是 `map-runtime` 里「当前装着哪一份包」那**一个**模块级事实，
 * 不是本注册表。两者一旦能各说各话，症状是**沿着上一份地图落位**，而它不报错。
 * 所以「换地图」只有一个失效点，就是这一行：注册表被整份替换 = 地图被替换。四条重灌路径
 * （首轮占位加载 / 装包 `applyInstall` / 卸载重灌 / `POEM_CONTENT_DIR` 覆盖后重解析）
 * 全都经过本函数，因此没有一条需要谁记得另外去调 `installMapPack`。
 *
 * 反过来说：先 `installMapPack(fixture)` 再调本函数，包会被换成注册表那一面的值 ——
 * 那正是生产要的不变式，不是意外。单测引擎侧别经过本函数（照 `map-runtime.test.ts` 的样子）。
 *
 * 🔴 **仍然永不抛**：`coerceMapPack` 对任意坏输入都返回合法包（整份认不出 → 空包），
 * `installMapPack` 自己也不校验。坏地图包的代价是「棋子没在图上」，不是启动失败。
 */
export function setContentRegistry(next: ContentRegistry): void {
  // 🔴 注册表本体也是装进引擎缝的（`content-registry-runtime`），本函数是它**唯一**的
  //    生产灌注点 —— 与下面两面同一条纪律，只是它装的是原值而不是 coerce 后的派生值。
  installContentRegistry(next);
  installMapPack(coerceMapPack(next.mapPack));
  // 🔴 第 13 面同理（随机事件系统 v1 / §3.3）：引擎侧读的是 `random-event-runtime` 里
  //    「当前装着哪一份事件包」那一个模块级事实，不是本注册表。漏掉这一行的症状同样不是
  //    报错，而是**沿着上一份事件包掷骰**（换包后旧事件继续入池、新事件永不出现）。
  installRandomEventPack(coerceRandomEventPack(next.randomEvents));
}

/**
 * 同步重置注册表为空骨架（D16 / §6）。
 *
 * 🔴 在**模块加载时同步跑**（见文件尾）。它是「模块加载后 `getContentRegistry()`
 * 永远返回非 null 骨架」的那一环——agent-tools 同步工具执行路径在任何 agent 真正跑起来
 * 之前读它，不能拿到 `undefined` 的对象。
 *
 * 🔴 这里**不**同步 `import` random-tables / bloodlines / location-db 的真实常量——
 * 那会把 334 KB 的 start-catalog-data 等内容编译进 bundle（§1.2 硬耦合 #2/#3）。
 * **异步占位加载见 `ensureContentRegistryLoaded()`**（八面各自 fetch
 * `/data/content/<name>.json`）；pack 分节由装包执行器经 `setContentRegistry` 重灌。
 *
 * 🔴 **经 `setContentRegistry` 走，别直接调 `installContentRegistry`**：清空注册表必须连带
 * 把引擎侧的地图缝/事件缝也清回空包（地图系统 v1 / §3.3）。卸载流先 seed 再重拉占位，
 * 中间那一段若还装着刚卸掉的地图包，落位就仍沿着它走 —— 而那既不报错也没人会去看。
 */
export function seedPlaceholderRegistry(): void {
  setContentRegistry(createEmptyContentRegistry());
}

// ═══════════════════════════════════════════════════════════
// 2b. 八面占位内容的异步加载（D16 / §5.1，波 2 七个抽取任务的共同落点）
// ═══════════════════════════════════════════════════════════

/**
 * 八面占位内容的来源 URL（与私有内容仓 `data/` 树同形——设计 §3.1）。
 *
 * 🔴 `markers` 不在 `content/` 下：地图标记预设今天就住在 `data/defaults/`
 * （`map-marker-presets.json`，MapPanel 的既有文件），抽取时不搬家。
 */
export const CONTENT_REGISTRY_SOURCES: ReadonlyArray<{
  readonly face: keyof ContentRegistry;
  readonly url: string;
}> = [
  { face: 'catalog', url: '/data/content/catalog.json' },
  { face: 'locations', url: '/data/content/locations.json' },
  { face: 'bloodlines', url: '/data/content/bloodlines.json' },
  { face: 'namePools', url: '/data/content/name-pools.json' },
  { face: 'branding', url: '/data/content/branding.json' },
  { face: 'imageDialects', url: '/data/content/image-dialects.json' },
  { face: 'mapPack', url: '/data/content/map-pack.json' },
  { face: 'randomEvents', url: '/data/content/random-events.json' },
  { face: 'remoteAssets', url: '/data/content/remote-assets.json' },
  { face: 'markers', url: '/data/defaults/map-marker-presets.json' },
];

/**
 * `provinces.png` 的约定 URL（地图系统 v1 / §3.3·§9）—— 政治层渲染与命中检测的像素源。
 *
 * 🔴 **它不是注册表的一面**，所以不在 `CONTENT_REGISTRY_SOURCES` 里：注册表灌的是同步可读的
 * JSON 值，而这里是几 MB 字节，只有 UI 打开「势力地图」页签时才解码成 `idBuf`；
 * 引擎一个像素都不碰（邻接关系早在 `map-pack.json` 的 `adjacency` 里）。
 *
 * 🔴 **content pack 替换不了它**：pack 是一份 JSON，装不下 PNG 字节。真实地图的
 * `provinces.png` 与 `map-pack.json` 同住内容树 `data/content/`（私有内容仓，经
 * `POEM_CONTENT_DIR` 开发覆盖 / 部署时铺进 `public/`），所以路径是**常量**而不是从包里
 * 读出的 —— 换图时它的内容变、路径不变。由此有两层失效纪律（2026-08-13 补第二层）：
 * ① 渲染缓存（内存）的失效键必须取包的 `contentHash`（§3.4-3），拿路径当键会让新图配着
 *   旧像素画；② **请求 URL 必须经 `provincesRasterUrl(pack.contentHash)` 挂上 `?v=` 参数**，
 *   否则换包后的重建可能拿浏览器 HTTP 缓存里的旧像素配新 pack —— 同一个坑在 HTTP 层的分身
 *   （dev 中间件发 no-cache 不受影响，生产/静态托管会中）。
 *
 * 🔴 公开仓的占位包**没有**这张图（占位是十几块合成地块，没有像素面）：取它会 404。
 * 调用方按「取不到 → 不画政治层」处置，与 `resolveMapSources` 没图源时返回空数组同一口径。
 */
export const MAP_PROVINCES_URL = '/data/content/provinces.png';

/**
 * `provinces.png` 的**唯一**取图 URL 出口：包变 → 地址变 → 必然回源；包没变照旧命中缓存。
 *
 * 空串 / `'placeholder'`（占位包 `map-pack.json` 里的字面哨兵）不挂参：占位包根本没有
 * 这张图（404 是常态），两份坏包共用一个键在这里无害。裸常量 `MAP_PROVINCES_URL` 只用于
 * 文档与测试 —— 生产取图一律走本函数，绕开它就等于把 HTTP 缓存那半个坑挖回来。
 */
export function provincesRasterUrl(contentHash: string): string {
  return contentHash !== '' && contentHash !== 'placeholder'
    ? `${MAP_PROVINCES_URL}?v=${encodeURIComponent(contentHash)}`
    : MAP_PROVINCES_URL;
}

/** 首轮占位加载的 memo（幂等闸；`ensureContentRegistryLoaded` 的全部状态） */
let registryLoadPromise: Promise<void> | null = null;

/** 一面 fetch 的结果：`ok=false` 时调用方保留该面**原值**（不覆写成 undefined） */
interface RegistryFaceFetch {
  ok: boolean;
  value?: unknown;
}

/**
 * 取一面占位内容。**永不抛**：404 / 网络错 / JSON 解析错都记 `ok:false` 并上报。
 *
 * 上报走引擎注入缝（`content-source.reportContentFetch`），caller 标识
 * `content-registry:<face>` —— 模块级路径拿不到 store 实例，注入缝内部自己找 Pinia，
 * 找不到就静默 no-op（§5.5 兜底语义）。
 */
async function fetchRegistryFace(
  face: keyof ContentRegistry,
  url: string,
): Promise<RegistryFaceFetch> {
  const source = `content-registry:${face}`;
  try {
    // 🔴 no-cache（= 必回源验新，命中 304 时零流量）：这些面全是「常量 URL、内容随包换」，
    //    其中 map-pack.json 还供给 provinces.png 取图的 `?v=` —— 这一面被缓存住，挂出去的
    //    就是**旧** hash，下游的防缓存等于没做。八面 JSON 都很小，验新成本可忽略。
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
      reportEngineContentFetch({
        source,
        status: res.status,
        ok: false,
        error: `HTTP ${res.status}`,
      });
      return { ok: false };
    }
    // 🔴 解析失败与 404 同档：JSON 坏了 = 这一面没有内容，不是「有个坏值」。
    const value: unknown = await res.json();
    reportEngineContentFetch({ source, status: res.status, ok: true });
    return { ok: true, value };
  } catch (err) {
    reportEngineContentFetch({
      source,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/**
 * 已装 pack 各面的取值（D20 三态的 pack 半边）。
 *
 * 取法与装包执行器一致：`catalog` / `namePools` 取 `.data` 子字段，
 * `locations` / `mapMarkers` / `branding` / `bloodlines` / `imageDialects` / `mapPack` 是整节
 * （方言分节按整节走，因为它落盘就是 `{ dialects: [...] }` —— 与 `bloodlines` 同形；
 * 地图包同理，它落盘就是 `MapPack` 本身，再包一层 `data` 只是多一层壳）。
 * 键**只在该面有值时才出现**——于是下游一律 `resolveSection(packFace, placeholder)`，
 * 不必在两处各写一遍三元。
 *
 * 📌 边界：pack 声明了分节但其 `data` 为 `undefined`（类型上不允许，只可能是构建器 bug）
 * 时，该面回落占位而非被抹成 undefined —— 「装了个空壳把内容清掉」不是任何人想要的。
 */
function packRegistryFaces(
  pack: ContentPack | undefined,
): Partial<Record<keyof ContentRegistry, unknown>> {
  if (!pack) return {};
  const out: Partial<Record<keyof ContentRegistry, unknown>> = {};
  if (pack.catalog?.data !== undefined) out.catalog = pack.catalog.data;
  if (pack.locations !== undefined) out.locations = pack.locations;
  if (pack.bloodlines !== undefined) out.bloodlines = pack.bloodlines;
  if (pack.namePools?.data !== undefined) out.namePools = pack.namePools.data;
  if (pack.mapMarkers !== undefined) out.markers = pack.mapMarkers;
  if (pack.branding !== undefined) out.branding = pack.branding;
  if (pack.imageDialects !== undefined) out.imageDialects = pack.imageDialects;
  if (pack.mapPack !== undefined) out.mapPack = pack.mapPack;
  if (pack.randomEvents !== undefined) out.randomEvents = pack.randomEvents;
  // 远程素材分节是**裸数组**（没有 `.data` / `{ dialects }` 那层壳），故整节走
  if (pack.remoteAssets !== undefined) out.remoteAssets = pack.remoteAssets;
  return out;
}

/**
 * 若 Pinia 已挂载，先把已装 pack 从 Dexie 载进模块缓存（幂等）。
 *
 * 🔴 为什么在这里：注册表的 pack 优先级（D20）读的是模块级 `activePackRecord`。
 * boot 链上 `loadProjectDefaults()` 已先 `hydratePackState()`，但 UI 页面（捏人页/地图页
 * 的加载门）可能**直接** await 本加载器——那时若没 hydrate 过，pack 会被占位盖掉。
 * 无 Pinia（模块级早期调用 / 单测）时静默跳过：那种环境下也没有 Dexie 可读。
 */
async function hydratePackStateIfPossible(): Promise<void> {
  try {
    const pinia = getActivePinia?.();
    if (!pinia) return;
    await useContentStore().hydratePackState();
  } catch {
    /* hydrate 失败 → 按未装 pack 处理（与 hydratePackState 自身兜底同口径） */
  }
}

/** 首轮加载的实现体。**永不抛**（外层 memo 拿到的 promise 一定 resolve）。 */
async function loadContentRegistryOnce(): Promise<void> {
  try {
    await hydratePackStateIfPossible();
    const results = await Promise.all(
      CONTENT_REGISTRY_SOURCES.map((s) => fetchRegistryFace(s.face, s.url)),
    );
    // 🔴 pack 在 fetch 落地**之后**读：装包与首轮加载交错时，pack 必须仍然赢
    //    （规则 2 / D20 三态）。
    const packFaces = packRegistryFaces(getActivePackPayload());
    const current = getContentRegistry();
    const next: ContentRegistry = { ...current };
    for (let i = 0; i < CONTENT_REGISTRY_SOURCES.length; i++) {
      const face = CONTENT_REGISTRY_SOURCES[i].face;
      // 失败面保持原值（通常是 undefined 的占位骨架；已装 pack 时是 pack 值）
      const placeholder = results[i].ok ? results[i].value : current[face];
      next[face] = resolveSection(packFaces[face], placeholder);
    }
    // 整份替换（不深合并）——与 setContentRegistry 的既有纪律一致
    setContentRegistry(next);
  } catch {
    /* 注册表加载永不阻塞启动：失败面已各自上报，这里只兜最外层意外 */
  }
}

/**
 * 确保注册表八面已完成首轮占位加载（D16）。
 *
 * - **幂等**：memoize 同一个 promise，八面只 fetch 一轮；重复 await 零 I/O。
 * - **永不抛、永不阻塞启动**：逐面独立，一面失败不影响其余五面；失败面保持原值。
 * - **pack 优先**（D20 三态）：已装 pack 提供的分节赢过占位 fetch 结果。
 *
 * 两个调用位置：boot 链（`loadProjectDefaults()` 内部，见那里的注释）与需要「加载门」
 * 的 UI 页面（捏人页 / 地图页可直接 `await` 它）。
 */
export function ensureContentRegistryLoaded(): Promise<void> {
  if (!registryLoadPromise) {
    registryLoadPromise = loadContentRegistryOnce();
  }
  return registryLoadPromise;
}

/** 清掉 memo，让下次 `ensureContentRegistryLoaded()` 重新 fetch（测试隔离用；生产只有卸载路径调） */
export function resetContentRegistryLoadedForTests(): void {
  registryLoadPromise = null;
}

/**
 * 卸载 pack 后重新拉一轮占位内容（§5.2 卸载流的注册表重灌）。
 *
 * 🔴 光调 `seedPlaceholderRegistry()` 只把注册表清成空骨架——那会让卸载后的捏人页/地图页
 * 拿到八个 `undefined`（连地图也退成空包）。这里重置 memo 再跑一轮，把占位 JSON 灌回去。
 */
async function reloadContentRegistryPlaceholders(): Promise<void> {
  resetContentRegistryLoadedForTests();
  await ensureContentRegistryLoaded();
}

// ═══════════════════════════════════════════════════════════
// 3. 内容态上报（D16 / §5.5）
// ═══════════════════════════════════════════════════════════

/**
 * 一次内容 fetch 的上报事件（§5.5 census）。
 *
 * 七处活跃 fetch（`beautifier.ts`、`builtin-worldbooks.ts`、`AgentConfigPanel.vue`、
 * `game-pipeline.ts`、`create-store.ts`、`settings-store.ts` + `audio-store.ts`）
 * 改造后全部经 provider 上报 `contentStatus`。**行为兜底不变**：失败不阻塞启动，
 * 只进状态。本波先收集最近一次的失败原因进 `lastFetchError`，UI 消费 `contentStatus`。
 */
export interface ContentFetchReport {
  /** 调用方标识（如 'settings-store' / 'game-pipeline'） */
  source: string;
  /** HTTP 状态码（fetch 完成时）；网络层失败为 undefined */
  status?: number;
  /** 是否成功 */
  ok: boolean;
  /** 失败原因（ok=false 时） */
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// 4. Pinia store（contentStatus + load* 入口）
// ═══════════════════════════════════════════════════════════

/**
 * 写存档 metadata（D43 needs_selection 标记 + enabledWorldBookEntries 重写）。
 *
 * 🔴 `SaveSlot.metadata` 的 TS 类型没声明 `needsPackWorldBookSelection`（不常驻 schema，
 * 只在装/卸包后有意义的运行时键）。在写回 Dexie 前用它把这两类合并进 `Record<string, unknown>`
 * 透传，避免拿严格类型撞墙（与 `*-migration.ts` 用 `Record<string, unknown>` 参数同一口径）。
 */
function writePackSelectionMetadata(
  meta: SaveSlot['metadata'],
  patch: { enabledWorldBookEntries?: string[] },
  needsSelection: boolean,
): SaveSlot['metadata'] {
  const out: Record<string, unknown> = { ...(meta ?? {}) };
  if (patch.enabledWorldBookEntries) out.enabledWorldBookEntries = patch.enabledWorldBookEntries;
  if (needsSelection) out.needsPackWorldBookSelection = true;
  return out as SaveSlot['metadata'];
}

export const useContentStore = defineStore('content', () => {
  /** 应用级内容态（D16）。占位态起步；七处 fetch 上报后可能切到 error。 */
  const contentStatus = ref<ContentStatus>('placeholder');
  /** 已装内容包的 id（contentStatus === 'pack' 时有意义；T7 落地） */
  const activePackId = ref<string | null>(null);
  /** 已装内容包的版本（T7 落地） */
  const activePackVersion = ref<string | null>(null);
  /** 最近一次 fetch 失败原因（诊断用；contentStatus==='error' 时有意义） */
  const lastFetchError = ref<string | null>(null);
  /**
   * 最近一次内容态上报（§5.5 census）。UI / 测试用它确认「provider 被经过」。
   * 用数组收集，保留来源与顺序，便于横幅文案分支。
   */
  const fetchReports = ref<ContentFetchReport[]>([]);

  /**
   * 上报一次内容 fetch 的结果（§5.5）。
   *
   * 🔴 **行为兜底不变**：失败只进状态，不抛、不阻塞。调用方照旧走自己的兜底
   * （game-pipeline / beautifier 的 warn 保留）。本函数只负责「让失败可见」。
   */
  function reportContentFetch(report: ContentFetchReport): void {
    fetchReports.value.push(report);
    if (!report.ok) {
      // 第一个失败就把内容态切到 error；后续失败不覆盖已确认的 needs_attention/pack
      if (contentStatus.value === 'placeholder') {
        contentStatus.value = 'error';
        lastFetchError.value = `${report.source}: ${report.error ?? 'HTTP ' + (report.status ?? '?')}`;
      }
    } else if (contentStatus.value === 'error') {
      // 后续成功把 error 清回 placeholder（占位 fetch 成功 = 占位态成立）
      contentStatus.value = 'placeholder';
      lastFetchError.value = null;
    }
  }

  /**
   * 收口入口：加载项目默认 Agent 配置（D16 三处 fetch 收口之一）。
   *
   * 🔴 先 `await contentReadyPromise`——保证 T7 的 pack 叠加层有机会在 fetch 落地前
   * 灌注（本波 ready 立即 resolve，所以等价于直接 fetch；但调用方代码不变，
   * T7 接 pack 时这条 await 就承重了）。
   *
   * 本波返回「占位 fetch」路径的解析值（pack payload > 占位 fetch 的优先级在 T7 落地）。
   * 失败上报 `contentStatus`，不抛。
   *
   * @returns 解析后的默认值（pack payload > 占位 fetch > 空骨架）
   */
  async function loadProjectDefaults(): Promise<unknown> {
    await contentReadyPromise;
    // 先确保已装 pack 从 Dexie 载入模块缓存（boot 时序；idempotent）
    await hydratePackState();
    const defaults = await resolveProjectDefaults();
    // 🔴 八面注册表接进 boot 链（D16 时序契约）：本函数是三处装载面的收口入口，
    //    boot 必经，所以注册表的首轮占位加载挂在这里（幂等，只跑一轮）。
    //    **放在默认层解析之后**且**不影响返回值**——它永不抛，失败只进 contentStatus。
    //    UI 页面（捏人页/地图页的加载门）可以单独 `await ensureContentRegistryLoaded()`。
    //
    // 🔴 先记下「默认层这一趟失败了吗」：reportContentFetch 的既有语义是**后一次成功清 error**
    //    （见上面那个函数），于是八面占位加载成功会把 agent-config 的失败悄悄擦掉——
    //    本函数「失败 → contentStatus=error」的既有行为不许因为多挂了一条加载链而变。
    const defaultsError = contentStatus.value === 'error' ? lastFetchError.value : null;
    await ensureContentRegistryLoaded();
    if (defaultsError !== null && contentStatus.value === 'placeholder') {
      contentStatus.value = 'error';
      lastFetchError.value = defaultsError;
    }
    return defaults;
  }

  /** 默认层解析（pack agentDefaults > 占位 fetch > 空骨架）。loadProjectDefaults 的原体。 */
  async function resolveProjectDefaults(): Promise<unknown> {
    // 🔴 D44 / §5.4：pack 已装 → 默认层 = pack agentDefaults > 占位 fetch。
    const pack = getActivePackPayload();
    if (pack?.agentDefaults?.agents) {
      // D20 三态：pack 有 agentDefaults 分节 → 用它（不再是占位 fetch）。
      reportContentFetch({
        source: 'content-store.loadProjectDefaults',
        ok: true,
      });
      return pack.agentDefaults;
    }
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) {
        reportContentFetch({
          source: 'content-store.loadProjectDefaults',
          status: res.status,
          ok: true,
        });
        return await res.json();
      }
      reportContentFetch({
        source: 'content-store.loadProjectDefaults',
        status: res.status,
        ok: false,
        error: `HTTP ${res.status}`,
      });
      return { version: 1, agents: {} };
    } catch (err) {
      reportContentFetch({
        source: 'content-store.loadProjectDefaults',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return { version: 1, agents: {} };
    }
  }

  /**
   * 显式绕过 pack 叠加层，读原始盘上文件（D16）。
   *
   * 🔴 **AgentConfigPanel.vue 的读-改-写回路径专用**（`saveAsDefault` 流程）。
   * 那条路径若走 pack 叠加层，一次「保存为默认」就把真实提示词写进公开仓占位文件，
   * 方向整个反了（D16 裁定）。所以它保持读原始盘上文件。
   *
   * 本函数**不上报 contentStatus**——它是写回路径的读半边，不是内容装载 census 的一员。
   * 失败返回空骨架（与原 fetch 直读行为一致）。
   */
  async function loadRawProjectDefaults(): Promise<unknown> {
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) return await res.json();
      return { version: 1, agents: {} };
    } catch {
      return { version: 1, agents: {} };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 5. 安装 / 升级 / 卸载执行器（D19 / §5.2）—— T7 交付
  // ═══════════════════════════════════════════════════════════

  let hydratePromise: Promise<void> | null = null;

  /**
   * 从 Dexie 把已装 pack 载入模块缓存 + store 内容态（幂等，boot 时序）。
   *
   * 🔴 不重置 ready（ready 只 resolve 一次，幂等闸）。装包/卸载则直接由执行器
   * update 模块缓存，不需要再走这里（但重复调也无害——它读的是最新 Dexie 行）。
   *
   * 内容态规则：有已装 pack → `'pack'`；没有 → `'placeholder'`（若之前是 error
   * 由 reportContentFetch 管，这里不越权清 error，除非显式占位态成立）。
   */
  async function hydratePackState(): Promise<void> {
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      try {
        const records = await getDatabase().contentPacks.toArray();
        const active = records.find((r) => r.packId === r.payload?.packId && r.packId) ?? null;
        // 💡 单 pack 场景：取最后一条（主 pack）。多 pack 共存留待后续波次扩展。
        const activeRecord = records.length > 0 ? records[records.length - 1] : active;
        setActivePackRecord(activeRecord);
        if (activeRecord) {
          activePackId.value = activeRecord.packId;
          activePackVersion.value = activeRecord.packVersion;
          if (contentStatus.value === 'placeholder') contentStatus.value = 'pack';
        } else {
          activePackId.value = null;
          activePackVersion.value = null;
          if (contentStatus.value === 'pack') contentStatus.value = 'placeholder';
        }
        // 🔴 竞态修复（2026-08-07 真机）：provider 此刻才挂载，而 App.vue 的
        //    beautifier.init() 已先跑过（回落占位 5 条）——这里重算 presetRules，
        //    pack 规则才能生效。无 pack 时（provider=null）重算是无害空转。
        try {
          const { useBeautifierStore } = await import('./beautifier-store');
          await useBeautifierStore().refreshPresetRules();
        } catch (err) {
          // Pinia 未就绪时静默；消费端各自兜底。但留痕便于诊断 ——
          // beautifier-store 侧另有 watch contentStatus 收敛保险（2026-08-08）。
          console.warn('[content-store] hydratePackState 重算 presetRules 失败:', err);
        }
      } catch {
        // Dexie 不可用 → 缓存保持现状，不阻断（boot 兜底）
      }
    })();
    return hydratePromise;
  }

  /** 收集当前库状态喂给 planner（D43：含存档级 uid 允许清单联合） */
  async function buildCurrentLibrary(): Promise<CurrentLibrary> {
    const db = getDatabase();
    const [worldBooks, presets, beautifierRules, saves] = await Promise.all([
      db.worldBooks.toArray(),
      db.presets.toArray(),
      db.beautifierRules.toArray(),
      db.saves.toArray(),
    ]);
    const enabled: string[] = [];
    for (const s of saves) {
      const entries = s.metadata?.enabledWorldBookEntries;
      if (entries) enabled.push(...entries);
    }
    return { worldBooks, presets, beautifierRules, enabledWorldBookEntries: enabled };
  }

  /**
   * 备份快照 → 任一步 throw 回滚。
   *
   * ✅ 只要 `contentPacks.put` 放在执行序列**最后**（§5.2 顺序），且分节写失败时
   * 新 pack 行未落库，`importAllData(snapshot)` 就能把 worldBooks / presets 等
   * 全部还原到装前状态（reconcilePackState 读到无 pack → 无对账）。
   */
  async function rollbackTo(snapshot: Awaited<ReturnType<typeof exportAllData>>): Promise<void> {
    await importAllData(snapshot);
  }

  /** 有没有任何分节 planner 标了 conflicted（两阶段提交第一段判定） */
  function hasAnyConflict(plan: PackInstallPlan): boolean {
    const sections = plan.sections;
    return Object.values(sections).some((s) => s && s.conflicted && s.conflicted.length > 0);
  }

  /**
   * 收集装包各分节的 WorkshopNote（三类处置）—— 与 reportContentFetch 不同，这是
   * **安装后**的处置记录（D19），UI 两阶段确认 Modal + 安装结果分组渲染。
   */
  function collectNotes(plan: PackInstallPlan): WorkshopNote[] {
    const notes: WorkshopNote[] = [];
    // planner 已经产出的侧链 note（D43 多选分区清除）直接透传
    notes.push(...plan.notes.filter((n) => !!n && typeof n === 'object' && 'kind' in n));
    return notes;
  }

  /**
   * 解析「pack 的 story 预设 id」—— 用于装包后 activePresetId 切换（D20/D22）。
   *
   * pack presets 里名称为「占位 story 预设名」的那条，或第一条。占位 story 预设名
   * 取自当前默认层（装包前是占位文件）的 projectAgentDefaults.agents.story.preset 名。
   */
  function resolvePackStoryPresetId(pack: ContentPack): string | undefined {
    const packs = pack.presets;
    if (!packs || packs.length === 0) return undefined;
    return packs[0].id;
  }

  /** 执行一次安装的写入序列（§5.2 第 5 步）。装入前**必须**已 exportAllData() 快照。 */
  async function applyInstall(
    pack: ContentPack,
    plan: PackInstallPlan,
    existing: ContentPackRecord | undefined,
    confirmConflicts: boolean,
    _packBaseline: PackBaseline,
  ): Promise<WorkshopNote[]> {
    const notes = collectNotes(plan);
    const wb = await useWbStore();
    const beaut = await useBeautStore();
    const settings = await useSettingsStoreLazy();

    // a. worldBooks 分节（upsertBooks / 删 id / 冲突确认覆盖）
    const wbPlan = plan.sections.worldBooks;
    if (wbPlan) {
      const toUpsert: WorldBook[] = [];
      const toDelete: string[] = [];
      for (const b of wbPlan.added) toUpsert.push(ensureBookBuiltIn(b));
      for (const b of wbPlan.updated) toUpsert.push(ensureBookBuiltIn(b));
      for (const b of wbPlan.removed) toDelete.push(b.id);
      for (const c of wbPlan.conflicted) {
        if (confirmConflicts) {
          // 冲突确认后覆盖 = 用 pack 行整体覆盖当前行（含删除用户编辑）
          const packBook = (pack.worldBooks ?? []).find((b) => b.id === c.key);
          if (packBook) toUpsert.push(ensureBookBuiltIn(packBook));
          else toDelete.push(c.key);
        }
      }
      if (toDelete.length > 0) {
        for (const id of toDelete) await wb.deleteBook(id);
      }
      if (toUpsert.length > 0) await wb.upsertBooks(toUpsert);
    }

    // b. presets 分节（savePresets 按 pack id upsert / deletePresets）
    //    收集后一次 bulk 落库 —— 口径与上面的 worldBooks 分节一致（先删后写，
    //    同 id 同时出现在两边时以 upsert 为准），逐条 await 是 N 次 IDB 往返
    const prePlan = plan.sections.presets;
    if (prePlan) {
      const toUpsert: ChatPreset[] = [];
      const toDelete: string[] = [];
      for (const p of prePlan.added) toUpsert.push(p);
      for (const p of prePlan.updated) toUpsert.push(p);
      for (const p of prePlan.removed) toDelete.push(p.id);
      for (const c of prePlan.conflicted) {
        if (confirmConflicts) {
          const packPreset = (pack.presets ?? []).find((p) => p.id === c.key);
          if (packPreset) toUpsert.push(packPreset);
          else toDelete.push(c.key);
        }
      }
      await deletePresets(toDelete);
      await savePresets(toUpsert);
    }

    // c. beautifierRules（provider 内存层，不写用户表）—— 装包后重算 presetRules
    if (plan.sections.beautifierRules || pack.beautifierRules !== undefined) {
      await beaut.refreshPresetRules(new Set(), new Set(), new Set(), pack.beautifierRules?.rules);
    }

    // d. agents / catalog / locations / bloodlines / namePools / markers / branding：
    //    provider-owned。agentDefaults 只进 contentPacks（下面 put），**永不写 settings.agents**
    //    （D44）。同步注册表在装包成功后由 setActivePackRecord 重灌（各面交给后续波次
    //    逐面接管，本波至少把各面标记成 pack payload 的 resolveSection）。

    // 注册表重灌：八面 = pack payload > 当前值（占位 fetch 的结果，或未加载时的 undefined）。
    // 🔴 pack 取值与 `packRegistryFaces` 同一处定义（catalog/namePools 取 .data，其余整节），
    //    三态判定统一走 `resolveSection` —— 装包路径与占位加载路径不许各写一套。
    // 🔴 `mapPack` 这一面漏了不会报错，只会让装了地图的包**沿旧地图落位**：引擎侧的地图缝
    //    由 `setContentRegistry` 供值，供不到就还是上一份（多半是占位包）。
    const reg = getContentRegistry();
    const packFaces = packRegistryFaces(pack);
    setContentRegistry({
      catalog: resolveSection(packFaces.catalog, reg.catalog),
      locations: resolveSection(packFaces.locations, reg.locations),
      bloodlines: resolveSection(packFaces.bloodlines, reg.bloodlines),
      namePools: resolveSection(packFaces.namePools, reg.namePools),
      markers: resolveSection(packFaces.markers, reg.markers),
      branding: resolveSection(packFaces.branding, reg.branding),
      imageDialects: resolveSection(packFaces.imageDialects, reg.imageDialects),
      mapPack: resolveSection(packFaces.mapPack, reg.mapPack),
      randomEvents: resolveSection(packFaces.randomEvents, reg.randomEvents),
      remoteAssets: resolveSection(packFaces.remoteAssets, reg.remoteAssets),
    });

    // e. 存档 uid 迁移（D43）：rewrite 应用 + needsSelectionPartitions 标记
    await applySaveUidMigration(plan.saveUidMigration);

    // f. activePresetId 切换（D20/D22）：原来指向占位预设/未设 → 切到 pack 预设
    await switchActivePresetToPack(pack, settings);

    // g. contentPacks.put（**最后**，失败回滚时不残留新 pack 行）
    await getDatabase().contentPacks.put({
      packId: pack.packId,
      packVersion: pack.packVersion,
      installedAt: Date.now(),
      payload: pack,
      sectionHashes: pack.sectionHashes,
      notes,
    } satisfies ContentPackRecord);

    // h. 缓存 + 内容态
    await finalizePackState(pack);

    return notes;
  }

  /** 装包/卸载末尾统一重灌缓存与内容态 */
  async function finalizePackState(pack: ContentPack): Promise<void> {
    // 🔴 从 Dexie 读回**完整行**（含 sectionHashes/notes）再进缓存——否则模块级
    // activePackRecord 只有 4 个字段，与落库行不一致。眼下消费方只读 payload，
    // 但保持一致是防御性的：未来任何读 record.notes/sectionHashes 的路径不会拿到
    // 一个「看着装了、其实少了字段」的缓存。
    const row = await getDatabase().contentPacks.get(pack.packId);
    setActivePackRecord(row ?? null);
    activePackId.value = pack.packId;
    activePackVersion.value = pack.packVersion;
    contentStatus.value = 'pack';
  }

  /** worldBook 书行保证 `builtIn: true`（缺了被 loadBuiltInWorldBooks 真值门静默丢弃） */
  function ensureBookBuiltIn(b: WorldBook): WorldBook {
    if (b.builtIn) return b;
    return { ...b, builtIn: true };
  }

  /** 惰性取 settings-store（避免与 content-store 的静态循环依赖） */
  async function useSettingsStoreLazy() {
    const { useSettingsStore } = await import('./settings-store');
    return useSettingsStore();
  }

  /** 惰性取 worldbook-store（避免 content-store ⟷ worldbook-store 静态循环） */
  async function useWbStore() {
    const { useWorldBookStore } = await import('./worldbook-store');
    return useWorldBookStore();
  }

  /** 惰性取 beautifier-store（避免 content-store ⟷ beautifier-store 静态循环） */
  async function useBeautStore() {
    const { useBeautifierStore } = await import('./beautifier-store');
    return useBeautifierStore();
  }

  /** 装包后 activePresetId 切到 pack 预设（D20/D22） */
  async function switchActivePresetToPack(
    pack: ContentPack,
    settings: SettingsStoreType,
  ): Promise<void> {
    const packPresetId = resolvePackStoryPresetId(pack);
    if (!packPresetId) return;
    const prev = settings.settings.activePresetId;
    // 指向占位预设（当前默认层的 story presetId）或未设 → 切到 pack 预设；
    // 指向用户第三方预设 → 不动
    const placeholderStoryId = settings.projectAgentDefaults?.agents?.story?.presetId || '';
    if (!prev || prev === placeholderStoryId) {
      settings.settings.activePresetId = packPresetId;
      settings.saveNow();
    }
  }

  /** 卸载后 activePresetId 从 pack 预设切回占位 story 预设 */
  async function switchActivePresetToPlaceholder(
    placeholderStoryId: string,
    packPresetIds: string[],
  ): Promise<void> {
    const settings = await useSettingsStoreLazy();
    const prev = settings.settings.activePresetId;
    if (prev && packPresetIds.includes(prev)) {
      settings.settings.activePresetId = placeholderStoryId;
      settings.saveNow();
    }
  }

  /**
   * 全局卸载后 world-book 恢复占位：清空 pack 拥有 id → upsert 占位书。
   * 🔴 **禁用 mergeBuiltIns**（id-presence-only，对仍占着 15 个 id 的 pack 内容是 no-op）——
   * 卸载要显式「删 pack 行 → 灌占位书」（§5.2 v1.2 修订）。
   */
  async function restorePlaceholderBooks(ownedIds: string[]): Promise<void> {
    const wb = await useWbStore();
    // 1) 删 pack 拥有的 id
    for (const id of ownedIds) {
      await wb.deleteBook(id);
    }
    // 2) 从占位文件灌回同 id 的占位书（builtIn:true，uid 保留段）
    const { loadBuiltInWorldBooks } = await import('@engine/builtin-worldbooks');
    const placeholders = await loadBuiltInWorldBooks();
    const toReload = placeholders.filter((b) => ownedIds.includes(b.id));
    if (toReload.length > 0) {
      await wb.upsertBooks(toReload);
    }
  }

  /** 存档 uid 迁移执行（D43）—— 装包正向：rewrite 重写 + needsSelectionPartitions 标记 */
  async function applySaveUidMigration(migration: PackSaveUidMigration | undefined): Promise<void> {
    if (!migration) return;
    const db = getDatabase();
    const saves = await db.saves.toArray();
    const { rewrite, needsSelectionPartitions } = migration;
    let changed = false;
    for (const save of saves) {
      const entries = save.metadata?.enabledWorldBookEntries;
      if (!entries || entries.length === 0) continue;
      let mutated = false;
      const next = [...entries];
      for (let i = 0; i < next.length; i++) {
        const oldKey = next[i];
        const newUid = rewrite[oldKey];
        if (newUid !== undefined) {
          const partition = oldKey.slice(0, oldKey.indexOf(':'));
          next[i] = `${partition}:${newUid}`;
          mutated = true;
        }
      }
      // needs_selection（D43）：单选钉选分区的**失配键**（不在 rewrite 里的）触发。
      // rewrite 只含配对成功者；某分区在 needsSelectionPartitions 里且该存档含该分区
      // 的键但没被 rewrite → 需重选。裸删这些键 = 分区「整本原样通过」= 内容通胀。
      const needsSelection = (needsSelectionPartitions ?? []).some((p) =>
        entries.some((e) => e.startsWith(`${p}:`) && rewrite[e] === undefined),
      );
      if (needsSelection) {
        mutated = true;
      }
      if (mutated) {
        save.metadata = writePackSelectionMetadata(
          save.metadata,
          { enabledWorldBookEntries: next },
          needsSelection,
        );
        await db.saves.put(save);
        changed = true;
      }
    }
    if (changed) {
      // 触发存档 UI 重读（loadSaves）；失败静默（装包路径的存档刷新不是硬依赖）
      try {
        const { useGameStore } = await import('./game-store');
        const g = useGameStore();
        if (g.loadSaves) await g.loadSaves();
      } catch {
        /* no-op */
      }
    }
  }

  // 一次性装包守卫：仅同一时刻允许一个装/卸进行（执行器自身可控；并发由调用方串行）
  let execBusy = false;

  /**
   * 安装内容包（D19 / §5.2 安装流）。
   *
   * 两阶段提交：
   * 1. 无 `opts.confirmConflicts` 且计划有 conflicted → 返回 `ok:false, status:'needs_confirmation'`
   *    带着 plan，UI 逐节展示后以 `{ confirmConflicts: true }` 重入。
   * 2. 确认（或无冲突）→ exportAllData 快照 → 分节写入 → 存档迁移 → contentPacks.put
   *    → 注册表重灌 + 缓存 + 内容态 pack；任一步 throw → 快照回滚。
   *
   * `validatePackOrThrow` 出 error 级 note → 直接返回 `ok:false, status:'invalid'`，**零写入**。
   */
  async function installPack(
    rawPack: unknown,
    opts: { confirmConflicts?: boolean } = {},
  ): Promise<PackInstallOutcome> {
    const validationErrors = validatePackOrThrow(rawPack);
    if (validationErrors.some((n) => n.level === 'error')) {
      return {
        ok: false,
        status: 'invalid',
        packId: String((rawPack as ContentPack).packId ?? ''),
        packVersion: String((rawPack as ContentPack).packVersion ?? ''),
        validationErrors,
      };
    }
    if (execBusy)
      return {
        ok: false,
        status: 'busy',
        packId: String((rawPack as ContentPack).packId ?? ''),
        packVersion: String((rawPack as ContentPack).packVersion ?? ''),
        validationErrors: [],
      };

    // 🔴 COR-07（2026-08-09 审查）：互斥必须**同步**置位 —— 就在读到 `execBusy` 之后、
    // 第一个 await 之前。此前它设在 `:1138`，与上面那次读之间隔着三次真实 await
    // （contentPacks.get / loadPlaceholderHashes / buildCurrentLibrary 的四次 toArray），
    // 两次调用可以双双读到 false 双双放行。而两条路径失败时都走
    // `rollbackTo(snapshot)` → `importAllData(snapshot)`，那是**整库还原**不是范围化撤销
    // —— 一次失败的安装回滚能把另一次已经提交的卸载连同存档一起退回去。
    execBusy = true;
    try {
      const pack = detach(rawPack) as ContentPack;
      // 已装同 id → 用旧包 payload 现算基线（D18 hash 分工：冲突判定从 payload 现算）。
      // 升级的 diff 展示由 upgradePack 单独提供（UI 层按 packId 分流）；installPack 本身
      // 只负责「装这一版」—— 旧基线用于四态规则判「现 hash = 基线 → updated 静默覆盖」。
      const existing = await getDatabase().contentPacks.get(pack.packId);
      const packBaseline = existing ? buildPackBaseline(existing.payload) : {};
      // 🔴 先装载占位基线（D20：占位 hash 清单是四态规则的操作数；T15 产出前文件 404 → 空基线，
      //    首安装覆盖占位书会退化为 conflicted —— D42 面占位清单落地后自动补上。）
      await loadPlaceholderHashes();
      const placeholderBaseline = placeholderHashesToBaseline(getPlaceholderHashes());
      const current = await buildCurrentLibrary();
      const plan = planPackInstall(pack, current, packBaseline, placeholderBaseline);

      const hasConflicts = hasAnyConflict(plan);
      if (hasConflicts && !opts.confirmConflicts) {
        return {
          ok: false,
          status: 'needs_confirmation',
          packId: pack.packId,
          packVersion: pack.packVersion,
          plan,
          validationErrors: plan.validationErrors,
        };
      }

      const snapshot = await exportAllData();
      try {
        const notes = await applyInstall(
          pack,
          plan,
          existing,
          opts.confirmConflicts ?? false,
          packBaseline,
        );
        return {
          ok: true,
          status: 'installed',
          packId: pack.packId,
          packVersion: pack.packVersion,
          plan,
          notes,
          validationErrors: plan.validationErrors,
        };
      } catch (err) {
        // 🔴 回滚前先留痕：快照回滚可能掩盖原始异常（2026-08-07 真机教训——此前
        //    catch 无任何日志，装包失败只弹 toast）。
        console.error(
          '[content-pack] 安装写入失败，回滚中（packId=%s, version=%s）:',
          pack.packId,
          pack.packVersion,
          err,
        );
        await rollbackTo(snapshot);
        throw err;
      }
    } finally {
      // 每一条出口都要放锁：needs_confirmation 早退（UI 稍后带确认重入）、
      // 计划阶段抛错、写入失败回滚后抛出 —— 少放一条就是把工坊永久锁死。
      execBusy = false;
    }
  }

  /**
   * 升级内容包（D40 / §5.2）：产升级 diff（两个已算好的安装计划派生）供 UI 展示，
   * 确认后走 installPack。返回 outcome，其中 `upgradeDiff` 字段携带「这一版会改什么」。
   *
   * diff 语义：`oldPlan` = 用旧 payload 对当前状态（= 旧包已装）重算出的计划，
   * `newPlan` = 用新 payload 对同一状态算出的计划；`diffPackUpgrade(oldPlan, newPlan)`
   * 即新旧两版安装间 added/removed/updated/conflicted 的变化。
   */
  async function upgradePack(
    rawPack: unknown,
    opts: { confirmConflicts?: boolean } = {},
  ): Promise<PackInstallOutcome> {
    const validationErrors = validatePackOrThrow(rawPack);
    if (validationErrors.some((n) => n.level === 'error')) {
      return {
        ok: false,
        status: 'invalid',
        packId: String((rawPack as ContentPack).packId ?? ''),
        packVersion: String((rawPack as ContentPack).packVersion ?? ''),
        validationErrors,
      };
    }
    const pack = detach(rawPack) as ContentPack;
    const existing = await getDatabase().contentPacks.get(pack.packId);
    if (!existing) {
      // 没装过同 id → 不是升级，走安装
      return installPack(pack, opts);
    }
    try {
      const packBaseline = buildPackBaseline(existing.payload);
      await loadPlaceholderHashes();
      const placeholderBaseline = placeholderHashesToBaseline(getPlaceholderHashes());
      const current = await buildCurrentLibrary();
      const oldPlan = planPackInstall(existing.payload, current, packBaseline, placeholderBaseline);
      const newPlan = planPackInstall(pack, current, packBaseline, placeholderBaseline);
      const upgradeDiff = diffPackUpgrade(oldPlan, newPlan);

      const hasConflicts = hasAnyConflict(newPlan);
      if (hasConflicts && !opts.confirmConflicts) {
        return {
          ok: false,
          status: 'needs_confirmation',
          packId: pack.packId,
          packVersion: pack.packVersion,
          plan: newPlan,
          upgradeDiff,
          validationErrors: newPlan.validationErrors,
        };
      }

      // 确认后落盘 —— 复用安装序列（同一执行路径，含快照回滚）
      const outcome = await installPack(pack, { confirmConflicts: opts.confirmConflicts ?? false });
      return { ...outcome, upgradeDiff };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 卸载内容包（§5.2 卸载流）。
   *
   * 预检（planPackUninstall）→ 编辑确认 → exportAllData 快照 → 删 pack 拥有 id →
   * upsert 占位书 → 删 pack 预设 → activePresetId 切回占位 → contentPacks.delete →
   * 注册表重灌 → 内容态回 placeholder；任一步 throw → 快照回滚。
   */
  async function uninstallPack(
    opts: { confirmEdits?: boolean } = {},
  ): Promise<PackUninstallOutcome> {
    const active = getActivePackRecord();
    if (!active) {
      return { ok: false, status: 'no_pack' };
    }
    // 🔴 COR-07：此前这里**只写不读** —— 卸载会径直跑在一次进行中的安装旁边，
    // 而两者失败时都用 exportAllData 快照做整库还原。两个 UI 入口
    // （DataSection / ContentStatusBanner）各有各的本地 busy ref，互相看不见，
    // 所以这道锁是唯一拦得住跨入口并发的地方。
    if (execBusy) {
      return { ok: false, status: 'busy' };
    }
    const installedPack = active.payload;
    execBusy = true;
    try {
      const packBaseline = buildPackBaseline(installedPack);
      const current = await buildCurrentLibrary();
      const plan = planPackUninstall(installedPack, current, packBaseline);
      const hasEdits = plan.confirmations.length > 0;
      if (hasEdits && !opts.confirmEdits) {
        return {
          ok: false,
          status: 'needs_confirmation',
          plan,
        };
      }

      const snapshot = await exportAllData();
      try {
        // 世界书：删 pack 拥有 id → 灌占位书（显式删后播，禁用 mergeBuiltIns）
        await restorePlaceholderBooks(plan.ownedBookIds);

        // 存档 uid 迁移（D43 反向：真实 uid 消失 → 按名配对回占位/needs_selection）
        // 反向语义用 planPackInstall 重新规划一次当前状态（占位基线命中 → 回占位书）
        await applySaveMigrationReverse();

        // presets：删 pack 预设行；activePresetId 指向它时切回占位
        const packPresetIds = (installedPack.presets ?? []).map((p) => p.id);
        if (packPresetIds.length > 0) {
          for (const id of packPresetIds) {
            try {
              await deletePreset(id);
            } catch {
              /* 行可能已经被用户改过/不存在 */
            }
          }
        }
        const settings = await useSettingsStoreLazy();
        const placeholderStoryId = settings.projectAgentDefaults?.agents?.story?.presetId || '';
        await switchActivePresetToPlaceholder(placeholderStoryId, packPresetIds);

        // agents/beautifier/catalog/sync registry：provider-owned，删 pack 行即回落
        // 注册表先清成空骨架（pack 各面立刻失效），占位 JSON 在下面 pack 缓存清掉之后重拉
        seedPlaceholderRegistry();

        // contentPacks.delete（**最后**）
        await getDatabase().contentPacks.delete(installedPack.packId);

        // 缓存 + 内容态回 placeholder
        setActivePackRecord(null);
        activePackId.value = null;
        activePackVersion.value = null;
        // 🔴 provider 已切回 null → 重算 presetRules 回落占位文件（D20：卸载天然免费；
        //    不刷新则美化停在 pack 的 22 条，与卸载后世界书回落占位不一致）
        try {
          const { useBeautifierStore } = await import('./beautifier-store');
          await useBeautifierStore().refreshPresetRules();
        } catch {
          /* 同上：静默兜底 */
        }

        // 🔴 pack 缓存清掉**之后**再重拉占位八面（否则 pack 优先级会把刚卸的包灌回来）；
        //    又必须在下面那句 `contentStatus = 'placeholder'` **之前** —— 卸载的终态是确定的
        //    （包没了 = 占位态），不该被这一轮占位 fetch 的成败改写。失败仍进 fetchReports。
        await reloadContentRegistryPlaceholders();

        contentStatus.value = 'placeholder';

        return {
          ok: true,
          status: 'uninstalled',
          plan,
          notes:
            plan.confirmations.length > 0
              ? [
                  {
                    kind: 'sideEffect',
                    text: `卸载丢弃了 ${plan.confirmations.length} 本被编辑过的内容包世界书`,
                  } as WorkshopNote,
                ]
              : [],
        };
      } catch (err) {
        console.error(
          '[content-pack] 卸载写入失败，回滚中（packId=%s）:',
          installedPack.packId,
          err,
        );
        await rollbackTo(snapshot);
        throw err;
      }
    } catch (err) {
      throw err;
    } finally {
      execBusy = false;
    }
  }

  /** 卸载的反向存档迁移（D43 反向语义）：把真实 uid 键按名配对回占位 uid / needs_selection */
  async function applySaveMigrationReverse(): Promise<void> {
    // 占位书（装包后仍存在）是反向配对的对照物；占位书 uid 在 900001+ 保留段。
    // 卸载把 pack 书换成占位书后，真实 uid 键失配 → planner 的迁移逻辑在 re-install
    // 一次占位时产生 rewrite。这里用 planSaveUidMigration 的镜像：把 pack 书当「旧」、
    // 当前（占位）书当「新」。由于占位书不可枚举（placeholder-hashes 未产出），
    // 本波对反向往迁做保守处理：命中去重条目配对已由 planPackUninstall 覆盖，
    // 这里只重跑一次占位 installedPack 的 buildCurrentLibrary 并标记 needs_selection 兜底。
    // —— 完整反向 uid 配对留待占位 hash 清单（T15）落地后补真值。
    const db = getDatabase();
    const saves = await db.saves.toArray();
    for (const save of saves) {
      const entries = save.metadata?.enabledWorldBookEntries;
      if (!entries) continue;
      // 检查是否仍含 pack 拥有的真实 uid（< 900001）——有则这些键在卸载后失配
      const stillHasPackUid = entries.some((e) => {
        const uid = parseInt(e.slice(e.indexOf(':') + 1), 10);
        return Number.isFinite(uid) && uid < 900001;
      });
      if (stillHasPackUid) {
        save.metadata = writePackSelectionMetadata(save.metadata, {}, true);
        await db.saves.put(save);
      }
    }
  }

  /**
   * D42 重播种（面 4）：占位内容升级后，对「hash 仍等于占位基线」的书重播种。
   *
   * settings.placeholderVersion（见 settings-types）与内置占位 hash 清单的 version 比对；
   * 戳前进时对 `byBook` 基线命中（用户没动过）的书从占位文件重播，动过的不覆盖。
   *
   * 本波（T7）占位 hash 清单由 T15 产出；文件不存在 → manifest.version 为空 → **无操作**。
   */
  async function reseedPlaceholder(): Promise<{ reseeded: string[] }> {
    const manifest = await loadPlaceholderHashes();
    const settings = await useSettingsStoreLazy();
    const prev = settings.settings.placeholderVersion;
    if (!prev || prev === manifest.version || !manifest.byBook) {
      settings.settings.placeholderVersion = manifest.version || prev;
      settings.saveNow();
      return { reseeded: [] };
    }
    const reseeded: string[] = [];
    const db = getDatabase();
    const books = await db.worldBooks.toArray();
    const { loadBuiltInWorldBooks } = await import('@engine/builtin-worldbooks');
    const placeholderBooks = await loadBuiltInWorldBooks();
    const wbPlan = new Map(placeholderBooks.map((b) => [b.id, b]));
    for (const book of books) {
      const base = manifest.byBook[book.id];
      if (base === undefined) continue;
      if (hashWorldBook(book) === base) {
        const fresh = wbPlan.get(book.id);
        if (fresh) {
          await db.worldBooks.put(ensureBookBuiltIn(fresh));
          reseeded.push(book.id);
        }
      }
    }
    settings.settings.placeholderVersion = manifest.version;
    settings.saveNow();
    return { reseeded };
  }

  return {
    contentStatus,
    activePackId,
    activePackVersion,
    lastFetchError,
    fetchReports,
    reportContentFetch,
    loadProjectDefaults,
    loadRawProjectDefaults,
    hydratePackState,
    installPack,
    upgradePack,
    uninstallPack,
    reseedPlaceholder,
  };
});

/** settings-store 返回实例类型（避免在 content-store 内引入静态循环依赖） */
type SettingsStoreType = {
  settings: { activePresetId: string; placeholderVersion?: string };
  projectAgentDefaults?: { agents?: Record<string, { presetId?: string }> };
  saveNow: () => void;
};

/** 安装/升级结果（两阶段提交各段共用） */
export interface PackInstallOutcome {
  ok: boolean;
  status: 'invalid' | 'needs_confirmation' | 'busy' | 'installed';
  packId: string;
  packVersion: string;
  plan?: PackInstallPlan;
  /** 升级 diff（upgradePack 产；installPack 走升级路径时也可能带） */
  upgradeDiff?: PackUpgradeDiff;
  notes?: WorkshopNote[];
  validationErrors?: PackValidationNote[];
}

/** 卸载结果 */
export interface PackUninstallOutcome {
  ok: boolean;
  /** `busy`：另一次装/卸正在进行（COR-07；与 PackInstallOutcome 的同名状态同义） */
  status: 'no_pack' | 'needs_confirmation' | 'uninstalled' | 'busy';
  plan?: PackUninstallPlan;
  notes?: WorkshopNote[];
}

// ═══════════════════════════════════════════════════════════
// 模块加载时同步初始化（D16 时序契约的执行点）
// ═══════════════════════════════════════════════════════════

// 🔴 这两行是 D16 时序契约的全部承重点。它们在 `import` 本模块时同步执行：
//   - 占位注册表先灌好（同步消费方立刻可读）
//   - ready 立即 resolve（本波无 pack 叠加；T7 装包执行器会改这条）
//
// 顺序不可调：先 seed（让同步消费方有值），再 markReady（让 await 方放行）。
// markReady 内部有幂等闸，T7 重调不会重复 resolve。
seedPlaceholderRegistry();
markContentReady();

// ═══════════════════════════════════════════════════════════
// 引擎层 fetch 上报钩子注册（§5.5 census）
// ═══════════════════════════════════════════════════════════

// 引擎层（beautifier / builtin-worldbooks）不能 import UI store（依赖边方向），
// 所以 provider 暴露注入式钩子（setContentFetchReporter）。本模块 import 时注册：
// 引擎 fetch 完成后回调到 content-store.reportContentFetch。
//
// 🔴 用 getActivePinia() 惰性取 store：引擎 fetch 可能在 Pinia 挂载前就触发
//    （boot 期 beautifier.init()），那时没有 active pinia → 静默 no-op。
//    单测环境不挂 Pinia 时同理静默——兜底行为不变（§5.5）。
setContentFetchReporter((report) => {
  try {
    const pinia = getActivePinia?.();
    if (!pinia) return; // 单测 / 未挂载 → 静默
    const state = pinia.state.value as Record<string, unknown>;
    if (!('content' in state)) return; // content store 未构造
    // 直接写 state：reportContentFetch 是 store action，需要 store 实例；
    // 这里用裸 state 写入避开「取 store 实例」的时序耦合。
    const s = state['content'] as {
      fetchReports: ContentFetchReport[];
      contentStatus: ContentStatus;
      lastFetchError: string | null;
    };
    s.fetchReports = [...s.fetchReports, report];
    if (!report.ok) {
      if (s.contentStatus === 'placeholder') {
        s.contentStatus = 'error';
        s.lastFetchError = `${report.source}: ${report.error ?? 'HTTP ' + (report.status ?? '?')}`;
      }
    } else if (s.contentStatus === 'error') {
      s.contentStatus = 'placeholder';
      s.lastFetchError = null;
    }
  } catch {
    /* 上报自身永不抛（与引擎层 reportContentFetch 的兜底语义一致） */
  }
});
