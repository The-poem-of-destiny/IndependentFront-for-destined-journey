/**
 * useAssetImage.ts — 按 (名字, 类型) 取素材的 object URL（Asset System v1 渲染缝）
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §3 / §7.5 / §11
 *
 * 为什么存在: 渲染面要问的是「给我苏婉的头像」，而不是「查索引 → 拿 id → 铸 URL →
 * 记得撤销上一张」。后三步每个组件抄一遍，就会抄出三种撤销时机 —— 而 object URL
 * 的失败形态（泄漏 / 死图）在界面上几乎看不出来。所以这条链只在这里实现一次。
 *
 * 三条纪律，每条都对应一个真实的失败形态:
 *
 * 1. 🔴 **名字严格 `===`，不做任何归一化**（D2 / §3）—— 不 trim、不折叠大小写、
 *    不 NFKC。`苏婉 `（尾随空格）匹配不到 `苏婉`，这是**刻意的**: 那是 prompt /
 *    世界书的缺陷，要在源头修。素材层宽容匹配 = 素材层认的角色与状态层
 *    （state-manager 的裸 `===`）认的角色可以是两个人。
 *    **不要在这里 import 或模仿 `normalizeAudioName`。**
 * 2. **先铸新的，再撤旧的**。反过来写会在「同一个组件换到又换回」时撤掉自己
 *    马上要用的那条 URL —— 该 id 的引用计数会先归零、URL 随即被撤销，
 *    再 get 回来拿到的是一条新 URL，`<img>` 中间会闪一下空白。
 *    （LRU 现在带引用计数，跨组件互撤已经不会了；这条讲的是**同一持有者**
 *    自己把计数踩到零，refcount 救不了顺序写反。见 lib/asset-url.ts）
 * 3. **世代号守卫**（同 audio-channels.ts 的 MusicChannel 与 assets/thumbs.ts）:
 *    `assetUrl()` 是异步的（Dexie 读 + 铸造），两次切换的兑现顺序**不保证**与
 *    发起顺序一致。过期的一轮若照样落笔，界面上就是**另一个角色的脸**。
 *
 * ⚠️ **不要持久化返回的 URL**（§7.5）: 存逻辑键（name/type），渲染时再来取。
 * object URL 只在当前会话有效。
 *
 * ⚠️ 索引由本模块**按数据源共享一份**（`effectScope(true)` 脱离组件作用域），
 * 不是每个组件建一棵: `buildAssetIndex` 要遍历全库，而一屏可能挂着几十个头像。
 * 之所以不放进 asset-store，是因为本次改动的范围栅栏不含那个文件；等它有主时
 * 整块搬过去即可，本模块只需把 `sharedIndexes` 换成读 store 的 getter。
 */
import {
  computed,
  effectScope,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue';
import { buildAssetIndex, type AssetIndex } from '@engine/asset-index';
import { resolveAsset, ASSET_TYPE_AVATAR_CHAIN } from '@engine/asset-resolve';
import { isVideoExtension } from '@engine/asset-types';
import type { AssetMetaRecord, AssetType } from '@engine/types';
import { useAssetStore } from '../stores/asset-store';

/**
 * 未指定类型时走哪条链 —— **脸位链** `头像 → 立绘 → 立绘bg`。
 *
 * 本 composable 的调用方绝大多数是头像位，所以缺省首选 `头像`；但**必须是链
 * 而不是单个类型**: 曾经这里兜的是裸 `'头像'`，于是 asset-resolve 的回退链
 * （只在 type 省略时才走）从这一层根本走不到，只有立绘的角色在头像位显示首字母、
 * 只有头像的角色在立牌位也显示首字母 —— 恰恰是回退链存在要防的那个洞。
 *
 * 立牌形状的槽位显式传 `ASSET_TYPE_FALLBACK_CHAIN`（顺序相反）；
 * 只要某一格确定的类型（导入、设为主图）就传单个 `AssetType`，那仍是精确匹配。
 */
const DEFAULT_ASSET_TYPE: readonly AssetType[] = ASSET_TYPE_AVATAR_CHAIN;

/**
 * URL 与库行的来源 —— asset-store 的最小切面。
 *
 * 抽成接口纯粹是**注入缝**（对齐 assets/thumbs.ts 的 `AssetThumbSource`，
 * 刻意不用模块级全局钩子）: 生产路径恒是 asset-store 单例，测试塞一份假件，
 * 于是「恰好撤销一次」「过期的一轮不落笔」这两条会计恒等式能在不碰 Pinia、
 * 不碰真 object URL 的情况下钉住。
 */
export interface AssetImageSource {
  /** 全库行；索引由它派生 */
  readonly assets: readonly AssetMetaRecord[];
  assetUrl(id: string): Promise<string | null>;
  releaseAssetUrl(id: string): void;
}

export interface UseAssetImageOptions {
  /** 注入缝；缺省即 asset-store 单例（只在缺省时才会去碰 Pinia） */
  source?: AssetImageSource;
}

export interface UseAssetImage {
  /** 已装载则是 object URL；名字为空 / 查无此素材 / 字节缺失时是 null */
  url: Ref<string | null>;
  /**
   * 命中的行是 mp4 吗（D7 允许 `头像` / `立绘bg` 用视频）—— 由**行**判定，不嗅 URL。
   * 走链时说的是**最终命中的那一档**: 头像位退到 `立绘` 时，这里跟着 `立绘` 那行走。
   */
  isVideo: Ref<boolean>;
  /**
   * 链上**最终命中的那一行**（查不到 / 名字为空 → null）。
   *
   * 为什么要把整行交出去而不是只交一个 `type`: 调用方问「命中的是哪一档」时，
   * 紧接着要问的恒是 `id`（写取景、设为主图）与 `framing`（怎么摆）—— 三者
   * 出自同一行，分三个 ref 交只会多出三处可能不同步的状态。
   *
   * 🔴 典型用法是**按类型分叉呈现**: 走立牌链 `立绘 → 立绘bg → 头像` 时，
   * 命中前两档才铺成大画像；只有头像的角色必须留在 1:1 小框里 ——
   * 把一张证件照拉满整栏看起来像 bug，而不像功能。
   *
   * ⚠️ 与 `url` 的时序**刻意不同步**: 本 ref 是同步的（纯索引查找），`url` 要等
   * 一次异步铸造。所以判分叉用它，判「有没有图」仍要看 `url`。
   */
  row: Ref<AssetMetaRecord | null>;
}

// ═══════════════════════════════════════════════════════════
// 共享索引
// ═══════════════════════════════════════════════════════════

/**
 * 数据源 → 索引。`WeakMap` 而不是模块级单例: 测试里每个用例一份假源，
 * 用例之间不必互相清场，源被回收时索引跟着走。
 */
const INDEX_BY_SOURCE = new WeakMap<AssetImageSource, ComputedRef<readonly AssetIndex[]>>();

/**
 * 取（或建）某个数据源的共享索引。
 *
 * 🔴 必须在 **detached `effectScope`** 里建: 直接在 `useAssetImage` 里 `computed()`
 * 会把这个 computed 的 effect 挂到**当前组件**的作用域上，于是第一个卸载的组件
 * 会把它 stop 掉 —— 后来的组件拿到的是一棵**不再随库更新**的僵尸索引，表现为
 * 「刚导入的头像要刷新页面才出现」。
 *
 * 数组是给 `resolveAsset` 的**优先级序**（v1 恒只有一个来源）；日后加内置库 /
 * 文件夹库，就是往这个数组前面塞一项。
 */
function sharedIndexes(source: AssetImageSource): ComputedRef<readonly AssetIndex[]> {
  const hit = INDEX_BY_SOURCE.get(source);
  if (hit) return hit;

  const build = (): readonly AssetIndex[] => [buildAssetIndex(source.assets)];
  const scope = effectScope(true);
  // 新建的 detached scope 不可能已停止，`run` 必定返回；`??` 只是为了不写非空断言
  const built = scope.run(() => computed(build)) ?? computed(build);
  INDEX_BY_SOURCE.set(source, built);
  return built;
}

// ═══════════════════════════════════════════════════════════
// Composable
// ═══════════════════════════════════════════════════════════

/**
 * 跟着名字/类型解析素材，产出可直接绑到 `<img>` / `<video>` 的 URL。
 *
 * @param name 角色名，**原样比较**（D2）。空串 / null / undefined → `url` 恒 null
 * @param type 单个类型（精确匹配）或类型链（按序降级）；缺省走脸位链
 *   `头像 → 立绘 → 立绘bg`（{@link DEFAULT_ASSET_TYPE}）
 * @param options 注入缝，生产不传
 */
export function useAssetImage(
  name: MaybeRefOrGetter<string | null | undefined>,
  type?: MaybeRefOrGetter<AssetType | readonly AssetType[] | undefined>,
  options: UseAssetImageOptions = {},
): UseAssetImage {
  // `??` 短路 —— 注入了 source 就绝不会去调 useAssetStore()，于是本模块在
  // 没有 Pinia 的环境里也能单测（同 thumbs.ts）
  const source: AssetImageSource = options.source ?? useAssetStore();
  const indexes = sharedIndexes(source);

  /** 命中的 asset id；查不到 null。**同步**，不含任何 I/O */
  const resolvedId = computed<string | null>(() => {
    const raw = toValue(name);
    // 空名字不是错误，是「这个位没人」—— 静默给 null，不抛也不打日志（§3 的静默口径）
    if (raw === null || raw === undefined || raw === '') return null;
    return resolveAsset(indexes.value, raw, toValue(type) ?? DEFAULT_ASSET_TYPE);
  });

  /**
   * 命中的那一行。**唯一一次** id → 行的回查 —— `isVideo` 与调用方要的
   * `type` / `framing` 都从这里派生，不各查各的（各查各的就有各自过期的可能）。
   */
  const row = computed<AssetMetaRecord | null>(() => {
    const id = resolvedId.value;
    if (id === null) return null;
    return source.assets.find((a) => a.id === id) ?? null;
  });

  /**
   * 由**命中的行**判定是不是视频，不去嗅 URL —— object URL 里没有扩展名，
   * blob 的 MIME 也可能在导出/再导入之间被路由表改写；行才是真源。
   */
  const isVideo = computed<boolean>(() => {
    const hit = row.value;
    if (hit === null) return false;
    return isVideoExtension(hit.ext) || hit.mime.startsWith('video/');
  });

  const url = ref<string | null>(null);

  /**
   * id → **我们还欠这个 id 几次 release**。
   *
   * 🔴 为什么这里必须是「每个 id 一个计数」而不是单个 `heldId`: 一次成功的
   * `assetUrl(id)` 就是一份引用计数（lib/asset-url.ts 的契约「每一次成功取用
   * 都 +1，调用方欠一次对应的 release」），而**同一个 id 完全可能被取两次** ——
   * 名字在一次 Dexie 读之内 A→B→A 地抖一下，第一轮与第三轮各自领了一份，
   * 第一轮的续体走过期分支**刻意不还**（新一轮要接手），可新一轮领的是它自己
   * 铸的那一份，从没认领过第一轮那一份。单个 `heldId` 表达不出「欠 2 次」，
   * 卸载时只还 1 次 —— 剩下那一份把这条 URL 永久钉住（容量逐出跳过被持有的
   * 条目，只有 `revokeAll()` 收得回）。
   *
   * **不变式（本模块的会计恒等式）**: 本 composable 一生的 release 总次数
   * === 成功取到 URL 的总次数；且**正在显示的那条永远留着至少一份**，不会被
   * 我们自己踩到零。
   */
  const owed = new Map<string, number>();
  /** 当前正在显示的那条的 id（`owed` 里为它保留最后一份） */
  let heldId: string | null = null;
  /** 加载世代号；每次目标变化 +1，await 回来先验号再落笔 */
  let generation = 0;
  /** 最新一轮想要的 id —— 过期分支据此判断「这条 URL 还有没有人要」 */
  let latestId: string | null = null;
  /** 作用域已拆；此后一律不再写状态 */
  let disposed = false;

  /** 记一笔欠账（**只在成功取到 URL 之后调**） */
  function owe(id: string): void {
    owed.set(id, (owed.get(id) ?? 0) + 1);
  }

  /**
   * 把某个 id 的欠账还到只剩 `keep` 份。`keep` 恒是 0 或 1:
   * - `0` = 没人在显示它了，全还清；
   * - `1` = 正在显示它，**留最后一份压住它别被撤销**。多出来的那些还掉是安全的:
   *   我们自己还攥着 1 份，缓存计数不可能因这几次 release 归零。
   */
  function payDown(id: string, keep: number): void {
    let n = owed.get(id) ?? 0;
    while (n > keep) {
      n -= 1;
      source.releaseAssetUrl(id);
    }
    if (n <= 0) owed.delete(id);
    else owed.set(id, n);
  }

  /**
   * 落笔之后收拢欠账: 正在显示的那条留一份，其余全部还清 —— 既包括刚被换下的
   * 那个 id，也包括**同一个 id 上过期轮次留下的多余份额**（就是上面说的那份）。
   */
  function settleDebts(keepId: string | null): void {
    for (const id of [...owed.keys()]) payDown(id, id === keepId ? 1 : 0);
  }

  async function load(id: string | null): Promise<void> {
    const gen = ++generation;
    latestId = id;

    if (id === null) {
      url.value = null;
      heldId = null;
      settleDebts(null);
      return;
    }
    // 已经就是它且已装载 —— 不重复铸造，也不撤销后重铸（那会闪一下）
    if (id === heldId && url.value !== null) return;

    const next = await source.assetUrl(id);
    // 🔴 记账要做的第一件事: 成功取到就是欠了一份，此后**每条分支都从这张表出账**。
    // （拿到 null 不欠 —— 见 lib/asset-url.ts 的 `get` 契约）
    if (next !== null) owe(id);

    if (disposed || gen !== generation) {
      // 过期的一轮**绝不落笔**（否则界面上是另一个角色的脸）。
      // 刚领的这一份欠账要不要当场还，取决于还有没有人要这条 URL:
      // - 新一轮要的正是同一个 id → **留着**。当场还会走进这条分支本来要防的那个
      //   窄窗口: 新一轮可能还没领到自己那一份计数，先还就把计数踩到零、URL 当场
      //   撤销，新一轮兑现时拿到的是死链。这一份由接手的那一轮在 `settleDebts` 里
      //   收拢（它自己也会领一份，所以还得起）。
      // - 我们正持有它 → 留着，撤了就是把正在显示的图撤掉。
      if (id !== latestId && id !== heldId) payDown(id, 0);
      return;
    }

    // 字节缺失（元数据在、blob 没了）→ 什么都不持有，渲染占位；重试仍可成功
    heldId = next === null ? null : id;
    url.value = next;
    // 🔴 顺序是**先落笔、后收拢**。反过来（先把旧的还干净再取新的）会在
    // 「换走又换回同一个 id」那条路上，把自己马上要用的那条 URL 踩到零。
    settleDebts(heldId);
  }

  watch(resolvedId, (id) => void load(id), { immediate: true });

  onScopeDispose(() => {
    disposed = true;
    // 🔴 这几行不是清理洁癖，是**堵一个真实的泄漏**: 拆除时若还有 `assetUrl(id)`
    // 在飞，它回来时会走过期分支，而那里的 `id !== latestId` 本意是「新一轮要接手
    // 这条 URL」—— 拆除之后根本没有新一轮，`latestId` 却还停在它身上，于是刚铸出来
    // 的那条 URL 谁都不撤。清成 null 之后，过期分支才会当场把它撤掉。
    latestId = null;
    generation += 1;
    url.value = null;
    heldId = null;
    // 走人了，一份都不留 —— 同一个 id 欠几份就还几份
    settleDebts(null);
  });

  return { url, isVideo, row };
}
