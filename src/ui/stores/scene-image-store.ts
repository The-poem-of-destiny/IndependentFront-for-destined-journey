/**
 * scene-image-store.ts — 情景插画的 Dexie 唯一读写口 + `generate()` 串行队列
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §7（存储层）/ §8（执行链路）。
 *
 * ---
 *
 * **本 store 拥有什么**
 *
 * 1. `sceneImages` / `sceneImageBlobs` 两表的全部读写（UI 不直接碰 Dexie）。
 * 2. 记录的**状态机**: `queued → generating → done | failed`，以及它的两条取消语义。
 * 3. **串行队列**: 一条消息可能有 2-3 个标记，NAI 有速率限制且并发同时扣费（§8.2），
 *    所以永远只有一个在飞。手动点击进同一个队列，不另开一条。
 *
 * **本 store 不拥有什么**（三条注入缝，见 {@link SceneImageSeams}）
 *
 * - **限额判定** —— 纯函数 `image-quota.checkQuota` 的活，这里只负责在**最前面**调它（D32）。
 * - **中文 → danbooru 侧链** —— `image-prompt-agent` 的活。
 * - **发请求** —— `image-client` 的活（唯一网络接触点）。
 *
 * 🔴 三条缝**都缺省不接**时，队列/状态机/取消照样完整可测 —— 那正是它们是缝的理由。
 * 缺 `send` 不会让记录悬在 `generating` 上，而是明确落到 `failed`：一个永远转圈的
 * 占位框比一条失败信息糟糕得多。
 *
 * ---
 *
 * **两条容易写错的地方**
 *
 * - 🔴 `startedAt` **不是** `createdAt`（D37）。前者在进入 `generating` 时写，用来算
 *   「已用 N 秒」；后者是入队时刻。用 createdAt 算，排在第三位的图会一上来就显示
 *   「已用 180 秒」。
 * - 🔴 「清理」= 删字节 + 打 `blobDropped`，`sceneImages` **行数一条都不变**（D47）。
 *   元数据是配方，清理之后图鉴目录还是完整的、随时能重画。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  ComposeWarning,
  ImageGenFailure,
  ImagePromptOutput,
  ImagePromptRequest,
  ImageProviderId,
  ImageRating,
  QuotaReason,
  QuotaVerdict,
  SceneImageAnchorKind,
  SceneImageRecord,
} from '@engine/types-image';
import {
  deleteSceneImage,
  getSceneImage,
  getSceneImageBlob,
  getSceneImages,
  saveSceneImage,
} from '@engine/database';
import { detach } from './db-write';

// ═══════════════════════════════════════════════════════════
// 注入缝
// ═══════════════════════════════════════════════════════════

/**
 * 限额判定的入参 —— 形状与 `image-quota.QuotaInput` 对齐，但**故意在这里各写一份**。
 *
 * 理由: 限额的**默认值**来自设置（`maxPerMessage` / `maxPerHour`），而 store 不读设置
 * （那会把一个 Dexie 层拽进 `settings-store` 的依赖里）。接线层闭包住设置再把
 * `checkQuota` 交进来，于是这里只需要说清「我能提供哪些事实」。
 */
export interface SceneImageQuotaInput {
  /** 本存档已有的全部记录，**含 queued/generating/failed** —— 在飞的和失败的都要计入，否则限额可以被连点绕过 */
  records: readonly SceneImageRecord[];
  target: { messageId: string; turn: number; source: 'auto' | 'manual' };
  /** 当前时刻，从参数进（判定是纯函数，不碰 Date.now） */
  now: number;
}

/** `send` 拿到的东西：记录本身 + 已经解析好的有效场景提示词 */
export interface SceneImageSendInput {
  record: SceneImageRecord;
  /** `editedScenePrompt ?? scenePrompt` —— 解析一次，免得每个实现再算一遍（D26） */
  scenePrompt: string;
  sceneNegative: string;
}

/**
 * `send` 成功时交回来的东西。
 *
 * 🔴 除了字节，还包含**真正发出去的**正/负向、模型、seed、参数 —— 装配（composePrompt /
 * buildNaiRequest）发生在客户端层，记录只是**账本**。让发请求的那一方回填这些字段，
 * 是「记的账与发出去的东西一致」在结构上唯一能被保证的写法（对齐 Q-21 的教训：
 * 预测值不能当记账依据）。
 */
export interface SceneImageSendResult {
  ok: true;
  blob: Blob;
  mime: string;
  bytes: number;
  hash?: string;
  positive: string;
  negative: string;
  model: string;
  seed?: number;
  params: Record<string, unknown>;
  /**
   * 装配这张图时攒下的告警（C15）。缺席 / 空数组 = 一切正常。
   *
   * 🔴 落库是为了让它**有人消费**：`ComposedPrompt.warnings` 在图像 v1 里产出后全仓无人读，
   * 于是「这个角色在当前方言下没有可用形象，已跳过」对玩家完全不可见 —— 他只看到画面里
   * 少了个人。装配在缝里发生，所以只有缝交得出这份告警，store 自己算不出来。
   */
  composeWarnings?: ComposeWarning[];
}

/**
 * 「现在这一张是谁画的、用哪条方言装配的」（C14）。
 *
 * store 拿它给**新记录盖章**，此外只在一处用到：重画时判断缓存的场景串还算不算数
 * （方言换了就不算，见 {@link resolveScenePrompt}）。
 *
 * 🔴 判定不在这里：store 不认识 provider 也不认识方言，它只是把缝给的答案抄进记录。
 */
export interface SceneImageRuntimeInfo {
  provider: ImageProviderId;
  dialectId: string;
}

export interface SceneImageSeams {
  /**
   * 限额判定。缺省 = 恒放行。
   *
   * 🔴 它在 `image_prompt` 侧链**之前**被调用（D32）—— 两处花钱（LLM token + Anlas），
   * 闸门要在最前面，否则自动档会为被限流器拦下的插画白烧一次侧链调用。
   */
  checkQuota?: (input: SceneImageQuotaInput) => QuotaVerdict;
  /** 中文 → danbooru 侧链。缺省 = 不调用（此时只能靠记录里已缓存的 scenePrompt） */
  runPromptAgent?: (
    req: ImagePromptRequest,
    signal: AbortSignal,
  ) => Promise<ImagePromptOutput | ImageGenFailure>;
  /**
   * 这些出场角色里，谁还没有外貌基线（D57）。缺省 = 都当作有（不提示）。
   *
   * 🔴 纯查询、同步：它在**每次**侧链调用前跑，不该引入一次 await。
   */
  charactersNeedingBaseline?: (names: readonly string[]) => string[];
  /** 发请求。缺省时记录直接落 `failed`，绝不悬在 `generating` 上 */
  send?: (
    input: SceneImageSendInput,
    signal: AbortSignal,
  ) => Promise<SceneImageSendResult | ImageGenFailure>;
  /**
   * 当前后端 + 方言（C14）。缺省 = 不盖章，记录里这两格缺席 ——
   * 按 `SceneImageRecord.provider` 的约定，缺席读作 novelai / danbooru 系，
   * 也就是**图像 v1 的记录长什么样**。
   */
  runtimeInfo?: () => SceneImageRuntimeInfo;
}

/**
 * 记录没盖方言章时按哪条读（C14）。
 *
 * 图像 v1 的记录全是 danbooru 系装配的 —— 缺席不是「不知道」，是一段确定的历史。
 * 把它读成「不知道」再去弹一个「无法重画」，等于给老记录凭空造一个残缺态。
 */
const LEGACY_DIALECT_ID = 'danbooru-anime';

// ═══════════════════════════════════════════════════════════
// 对外形状
// ═══════════════════════════════════════════════════════════

/** `generate()` 的入参 */
export interface SceneImageGenerateInput {
  saveId: string;
  messageId: string;
  /** 剧情顺序，取自所属消息的 turn —— 图鉴排序键 + D23 同回合去重键 */
  turn: number;
  anchorKind: SceneImageAnchorKind;
  /**
   * 该消息里第几个（**同 anchorKind 内**计数）。
   *
   * `'marker'` 必传（= `splitSceneImageSegments` 给出的分段编号）；
   * `'message-end'` 省略 → 由本 store 在同 anchorKind 内顺延。
   * 🔴 两种 anchorKind 的 occurrence **各自独立计数**，互不干扰（D34）。
   */
  occurrence?: number;
  source: 'auto' | 'manual';
  /** 标记正文那句中文；`message-end` 时是整条消息正文（D33） */
  intent: string;
  title: string;
  description?: string;
  characters: string[];
  rating: ImageRating;
  /** 所属消息正文（已剥掉全部标记），喂侧链判断氛围/光线/时间 */
  narrative?: string;
  location?: string;
  /**
   * 重画: 从这条记录继承 `scenePrompt` / `editedScenePrompt`，于是**不再重跑侧链**（D31）。
   * 新记录是**追加的一个 take**，源记录一个字节都不动（D17）。
   */
  redrawFrom?: string;
  /**
   * 玩家已经在确认框里点过「仍然生成」—— 本次**跳过限额判定**（D24 / §9.3）。
   *
   * 🔴 **只对 `source: 'manual'` 生效**。自动档是无人值守花钱，没有任何界面能替玩家
   * 按下那一下确认，所以 `source: 'auto'` 带上它也不算数 —— 判据写在 {@link generate}
   * 里而不是靠调用方自觉，否则将来「顺手给自动档也开一个」就是一行改动的事。
   *
   * 限额本身仍是同一个 `checkQuota`（§5.3 不变式：自动与手动共用一个判定），
   * 差别只在拿到 `ok:false` 之后做什么: 自动降级成按钮（D21），手动弹一次确认（D24）。
   */
  quotaConfirmed?: boolean;
}

export type SceneImageGenerateResult =
  | { ok: true; id: string }
  /** 被限额拦下 —— 调用方据此降级成手动按钮（自动，D21）或弹一次确认（手动，D24） */
  | { ok: false; reason: QuotaReason; message: string };

// 🪦 **用量统计与「清理」不在本 store**（2026-08-05 收口）。
//
// 这里曾经有一份 `SceneImageUsage` + `usage` computed + `cleanup()`，与
// `@engine/database` 的 `getSceneImageUsage` / `listCleanableSceneImageIds` /
// `dropSceneImageBlobs` 是**同一件事的第二份实现**，而且类型同名、字段不同 ——
// 一个 import 写错就拿到另一套语义。三条理由删掉本店那份而不是留着：
//
// 1. 生产里**没有任何调用方**：设置页「存档数据」分区直接调引擎那三个函数
//    （`DataSection.vue`），本店那份只被自己的测试用着。
// 2. `database.ts` 的 `hasStoredSceneImageBytes` 注释已明说「用量」与「可清理名单」
//    必须共用同一条判据，否则会长出「显示 12 张可清理、点下去只清了 8 张」那种裂缝 ——
//    本店那份正好是这条判据的第三个副本。
// 3. 清理是**每存档一次性**的维护动作，不是渲染热路径，没有理由再过一层内存投影。
//
// 需要清理后刷新本店投影时，调用方 `load(saveId)` 即可（切回游戏页本来就会调）。

// ═══════════════════════════════════════════════════════════
// 无状态小工具
// ═══════════════════════════════════════════════════════════

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `simg_${c.randomUUID()}`;
  return `simg_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * `whenIdle()` 最多等几轮。
 *
 * 一轮 = 等当前这一趟泵跑完；泵在两次 await 之间可能又被 kick，所以要循环。
 * 100 是「正常情况下永远到不了」的数量级 —— 到了就是有东西没收尾，该抛不该装作跑空了。
 */
const WHEN_IDLE_MAX_ROUNDS = 100;

/** 同一处的第几次重画 / 同类锚点的第几个 —— 都是「已有最大值 + 1」 */
function nextIndex(values: readonly number[]): number {
  let max = -1;
  for (const v of values) if (Number.isFinite(v) && v > max) max = v;
  return max + 1;
}

/** 这个失败该不该在 UI 上显示「重试」；`ImageGenFailure` 自己带答案，这里只兜个底 */
function failureOf(
  kind: ImageGenFailure['kind'],
  message: string,
  retryable: boolean,
): ImageGenFailure {
  return { ok: false, kind, message, retryable };
}

// ═══════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════

export const useSceneImageStore = defineStore('sceneImage', () => {
  /** 当前存档的全部记录 —— Dexie 的投影，写库后同步刷新 */
  const records = ref<SceneImageRecord[]>([]);
  const activeSaveId = ref<string | null>(null);
  const loading = ref(false);

  /** 排队中的记录 id，先进先出。**队列长度就是 UI 上的「第 N 位」** */
  const queue = ref<string[]>([]);
  /** 正在发的那一条；没有则 null */
  const generatingId = ref<string | null>(null);

  /**
   * 侧链上下文（所属消息正文 / 地点）—— **不落库，跑完即弃**。
   *
   * 它们是「这一次生成的输入」，不是配方的一部分: 正文可能被回退重发改写，
   * 而记录要能在半年后照原样重画。把它们写进记录只会让配方越长越像一份聊天日志。
   */
  const context = new Map<string, { narrative: string; location?: string }>();

  /**
   * 本次会话「有人认领」的记录 id —— 经 {@link enqueue} 排进队列、还没跑完的那些。
   *
   * 唯一用途是给 {@link reconcileStale} 一条明确判据：不在这个集合里的 `queued` /
   * `generating` 记录，就是**上一次会话**留下的（没有任何本进程的队列位置或
   * AbortController 认领它）。刻意不落库 —— 它描述的是「这个 JS 进程正在做什么」，
   * 页面一关就该整个消失，那正是对账要利用的事实。
   */
  const sessionLive = new Set<string>();

  let seams: SceneImageSeams = {};
  let currentAbort: AbortController | null = null;
  let running = false;
  /** 当前这一轮泵的完成 promise —— `whenIdle()` 等的就是它 */
  let pump: Promise<void> = Promise.resolve();

  /**
   * `generate()` 的**准入临界区**闸门（读记录 → 判限额 → 落库，一次只许一个进）。
   *
   * 🔴 为什么必须串行：那三步中间有两次 `await`，而限额是拿**落库前**读到的记录集算的。
   *    两次 `generate()` 交错时，两边都会读到「还没有对方那条」的旧快照、都判通过、
   *    然后各落一条 —— 限额被整整绕过一次，而绕过的代价是真金白银。
   *
   *    自动档那条路本身是顺序 await 的（`handleSceneImages` 逐个标记跑），所以撞不上；
   *    但手动开火有**两个入口**（正文按钮 / 消息右键），各自的 `busy` 只锁自己那个组件
   *    实例，两个入口同时点、或同一个按钮连点两下，就是这个窗口。
   *
   * 🔴 闸门只包**准入**，不包生成本身 —— 生成早就是串行的（一条队列），把它一起锁进来
   *    会让第二次点击一直等到第一张图画完（几十秒）才收到「已排队」的回执。
   */
  let admission: Promise<unknown> = Promise.resolve();

  function serializeAdmission<T>(task: () => Promise<T>): Promise<T> {
    // 前一位失败也要放行下一位（`then` 的两个分支都跑 task）
    const run = admission.then(task, task);
    // 闸门本身永远是「已解决」的，否则一次失败会把后面所有人卡死，
    // 且会留下一个没人接的 rejection
    admission = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 接线口。生产在应用启动/存档加载时调一次；测试逐条替身。
   *
   * 传 `{}` 即清空（回到「三条缝都不接」的可测状态）。
   */
  function setSeams(next: SceneImageSeams): void {
    seams = next;
  }

  // ═══ 读 ═══════════════════════════════════════════════

  /** 载入某个存档的全部记录。切存档时**先取消在飞的**，否则上一个存档的图会落到新库上 */
  async function load(saveId: string): Promise<void> {
    if (activeSaveId.value !== null && activeSaveId.value !== saveId) abortAll();
    activeSaveId.value = saveId;
    loading.value = true;
    try {
      records.value = await getSceneImages(saveId);
      await reconcileStale();
    } catch {
      // IndexedDB 不可用 → 空库，正文照样渲染（对齐 asset-store 的降级）
      records.value = [];
    } finally {
      loading.value = false;
    }
  }

  /**
   * 把**上一次会话**遗留的 `queued` / `generating` 记录对账成 `failed`。
   *
   * 页面一关，串行队列和 AbortController 都随进程没了，库里那一行却还写着在飞。
   * 不对账的话，§10.2 真值表会照 `generating` 那一格画一个**永远转下去的圈**，
   * 还配一个从上辈子开始算的「已用 N 秒」；`queued` 那一格更糟 —— 队列已经不存在，
   * 它永远排不到第 0 位。
   *
   * 🔴 **落 `failed`，绝不自动重发**（D25）。页面关掉之前那一次请求可能已经扣过费了，
   *    替玩家重发一次是拿他的钱做决定。落成 failed 之后 UI 出「重试」按钮，他自己按。
   *    这也是本函数**一个网络调用都不产生**的理由 —— 它只改状态，不碰任何缝。
   *
   * 🔴 **只动上一次会话的记录**。判据是 {@link sessionLive}：本次会话排过队、还没跑完的
   *    id 都在里面，对账一律跳过。两条让这条判据成立的细节：
   *    - 对账**只在 `load()` 那一刻做一次**，没有任何周期性扫描，所以不存在「扫到一半
   *      有人入队」这种要加锁的窗口。
   *    - `generate()` 里 `await put(...)` 与 `enqueue(...)` 之间没有 await 出让点，于是
   *      「已落库 `queued` 但还没进 `sessionLive`」这个瞬间对别的任务不可见。
   */
  async function reconcileStale(): Promise<void> {
    const stale = records.value.filter(
      (r) => (r.status === 'queued' || r.status === 'generating') && !sessionLive.has(r.id),
    );
    for (const r of stale) {
      await patch(r.id, {
        status: 'failed',
        errorKind: 'aborted',
        // 措辞要指向真正发生的事 —— 说成「网络错误」会让人以为是 NAI 那边出了问题
        error:
          r.status === 'generating'
            ? '上次生成被页面关闭打断，未自动重试（这一张可能已经计费）。'
            : '上次排队时页面被关闭，这一张没有发出去。',
      });
    }
  }

  /** 图鉴视图：按 `turn` 升序（剧情顺序），同回合按 createdAt */
  const gallery = computed<SceneImageRecord[]>(() =>
    [...records.value].sort((a, b) => a.turn - b.turn || a.createdAt - b.createdAt),
  );

  /** 一条消息上的全部记录（正文渲染那条路径） */
  function byMessage(messageId: string): SceneImageRecord[] {
    return records.value.filter((r) => r.messageId === messageId);
  }

  /**
   * 某一个锚点上的全部 take，按 `take` 升序。
   *
   * 🔴 三段一起筛: `anchorKind` 漏掉的话，`marker#0` 与 `message-end#0` 会被当成同一处。
   */
  function takesAt(
    messageId: string,
    anchorKind: SceneImageAnchorKind,
    occurrence: number,
  ): SceneImageRecord[] {
    return records.value
      .filter(
        (r) =>
          r.messageId === messageId && r.anchorKind === anchorKind && r.occurrence === occurrence,
      )
      .sort((a, b) => a.take - b.take);
  }

  /**
   * 正文里该显示哪一张（D45）: 有 `pinned` 就是它，否则 `take` 最大者。
   *
   * 没有这条规则，重画就是事实上的破坏性操作 —— 新的更差时，之后每次读到这条消息
   * 都看到更差的那张。
   */
  function displayedAt(
    messageId: string,
    anchorKind: SceneImageAnchorKind,
    occurrence: number,
  ): SceneImageRecord | undefined {
    const takes = takesAt(messageId, anchorKind, occurrence);
    return takes.find((r) => r.pinned === true) ?? takes[takes.length - 1];
  }

  function find(id: string): SceneImageRecord | undefined {
    return records.value.find((r) => r.id === id);
  }

  /** 字节；已清理（`blobDropped`）或从未成功的返回 undefined */
  async function blobOf(id: string): Promise<Blob | undefined> {
    return getSceneImageBlob(id);
  }

  // ═══ 写（唯一落库口）═══════════════════════════════════

  /**
   * 落一行 + 同步投影。
   *
   * `detach` 不是可选的: `records` 是深响应式 ref，里面的对象都是 Vue Proxy，
   * 直接喂给 Dexie 会在 structured clone 时抛 `DataCloneError`（见 db-write.ts）。
   */
  async function put(record: SceneImageRecord, blob?: Blob): Promise<SceneImageRecord> {
    const row = detach(record);
    await saveSceneImage(row, blob);
    syncLocal(row);
    return row;
  }

  function syncLocal(row: SceneImageRecord): void {
    if (activeSaveId.value !== null && row.saveId !== activeSaveId.value) return;
    const i = records.value.findIndex((r) => r.id === row.id);
    if (i >= 0) records.value.splice(i, 1, row);
    else records.value.push(row);
  }

  function forgetLocal(id: string): void {
    const i = records.value.findIndex((r) => r.id === id);
    if (i >= 0) records.value.splice(i, 1);
  }

  /**
   * 打补丁 —— 从**库里**读当前行再合并，而不是拿 ref 里那份。
   *
   * 队列跑在后台，UI 可能同时在改标题；以库为准能让两边的改动都落地。
   */
  async function patch(
    id: string,
    changes: Partial<SceneImageRecord>,
  ): Promise<SceneImageRecord | undefined> {
    const current = (await getSceneImage(id)) ?? find(id);
    if (!current) return undefined;
    return put({ ...detach(current), ...changes });
  }

  /** 图鉴里改标题/说明/收藏/自定义提示词，走同一个补丁口 */
  async function update(
    id: string,
    changes: Pick<
      Partial<SceneImageRecord>,
      'title' | 'description' | 'favorite' | 'editedScenePrompt'
    >,
  ): Promise<SceneImageRecord | undefined> {
    return patch(id, changes);
  }

  /**
   * 把某一 take 钉成正文里显示的那张（D45）。
   *
   * 🔴 同一 `(messageId, anchorKind, occurrence)` 下**至多一条** —— 所以先把同锚点的
   * 兄弟全部清掉再钉。少了这一步，"钉住"会在多次点击后留下两条 true，而
   * {@link displayedAt} 取到哪一条就变成了数组顺序的偶然。
   */
  async function pin(id: string): Promise<SceneImageRecord | undefined> {
    const target = (await getSceneImage(id)) ?? find(id);
    if (!target) return undefined;
    const siblings = records.value.filter(
      (r) =>
        r.id !== id &&
        r.messageId === target.messageId &&
        r.anchorKind === target.anchorKind &&
        r.occurrence === target.occurrence &&
        r.pinned === true,
    );
    for (const s of siblings) await patch(s.id, { pinned: false });
    return patch(id, { pinned: true });
  }

  /** 删一条（元数据 + 字节）。在队列里的先摘出来，免得泵去跑一条已经不存在的记录 */
  async function remove(id: string): Promise<void> {
    dequeue(id);
    await deleteSceneImage(id);
    forgetLocal(id);
  }

  // 🪦 「清理」（删字节留记录，D47 / §7.5）走 `@engine/database` 的
  //    `listCleanableSceneImageIds` + `dropSceneImageBlobs`，不在本店重写一遍判据
  //    （见文件上方那块墓志铭）。清理完想刷新本店投影就调 `load(saveId)`。
  //
  //    把回忆一起删掉的那种「清理」是另一回事，走 {@link remove}，措辞必须是「删除」。

  // ═══ 队列 ═════════════════════════════════════════════

  function dequeue(id: string): boolean {
    sessionLive.delete(id);
    // 🔴 侧链上下文跟着一起丢掉。它只有 `runOne` 的 `finally` 会清，而**排队中被取消
    //    或删掉的记录永远轮不到 `runOne`** —— 那一条的正文（可能上千字）就会在这个
    //    Map 里挂到页面关闭。纯内存泄漏，没有任何症状，所以只能靠这里记得删。
    context.delete(id);
    const i = queue.value.indexOf(id);
    if (i < 0) return false;
    queue.value.splice(i, 1);
    return true;
  }

  function enqueue(id: string): void {
    sessionLive.add(id);
    queue.value.push(id);
    kick();
  }

  function kick(): void {
    if (running) return;
    running = true;
    pump = drain()
      // 🔴 泵**永不以 rejection 收场**。`runOne` 已经把缝里抛的东西兜住了，但兜底本身
      //    （落 failed 那一次写库）也可能失败 —— 典型是切存档/关页面时 Dexie 已经关掉，
      //    那次写会抛 `DatabaseClosedError`，从 catch 里逃出来一路冒到这里。没有这个
      //    catch，它就是一条**没人接的 Promise rejection**：在生产里是控制台里一句
      //    追不到源头的报错，在 vitest 里会让**整轮测试以非零码退出**（哪怕每个用例都绿）。
      //    CI 2026-08-05 正是这么红的。
      .catch((err: unknown) => {
        console.warn('[sceneImage] 出图队列异常收场（已吞掉，不影响后续入队）:', err);
      })
      .finally(() => {
        running = false;
      });
  }

  async function drain(): Promise<void> {
    for (;;) {
      const id = queue.value.shift();
      if (id === undefined) return;
      await runOne(id);
    }
  }

  /**
   * 等队列跑空 —— 测试用；UI 只看记录状态，不等这个。
   *
   * 🔴 轮数用完就**抛**，不静默返回。它此前跑满 100 轮后直接 `return`，于是调用方
   *    （全是测试）拿到一个「已经空了」的假承诺，接下来的断言在一个还在跑的队列上执行 ——
   *    表现是随机失败的用例，且报错指向断言而不是这里。等不到就说等不到。
   *
   * ⚠️ 「轮」不是时间：一轮 = 等当前这趟泵跑完。所以它挡的是**泵反复被 kick、
   *    永远追不上**那种情况，**挡不住**一个永不兑现的 `send`（那时第一轮的 `await pump`
   *    自己就不会返回，交给测试框架的超时去报更合适 —— 它至少会指出卡在哪一行）。
   *
   * @param maxRounds 轮数预算，仅测试用（压低它才够得着上面那条超时分支）
   */
  async function whenIdle(maxRounds: number = WHEN_IDLE_MAX_ROUNDS): Promise<void> {
    for (let i = 0; i < maxRounds; i += 1) {
      // 泵可能在 await 之间又被 kick 过一次，所以循环等到真的没人跑
      await pump;
      if (!running && queue.value.length === 0) return;
    }
    throw new Error(
      `whenIdle: 队列在 ${maxRounds} 轮之后仍未跑空` +
        `（还剩 ${queue.value.length} 条，running=${running}）`,
    );
  }

  /**
   * 取消。**两种取消语义完全不同**（D36）：
   *
   * - `queued` —— 还没发出去，一个字节都没花。整条记录**删掉**，于是正文那一格回到
   *   「无记录」，按真值表重新渲染成「生成插画」按钮，限额也如实退回来。
   *   🔴 这条路径**不产生任何网络调用**。
   * - `generating` —— 在飞中止，上游照样计费。记录**留着**并落 `failed` / `aborted`，
   *   限额继续把它计在内（花过的钱不能装作没花）。
   *
   * 其它状态（done/failed）无事可做。
   */
  async function cancel(id: string): Promise<'cancelled' | 'aborted' | 'noop'> {
    const record = find(id) ?? (await getSceneImage(id));
    if (!record) return 'noop';
    if (record.status === 'queued') {
      dequeue(id);
      await deleteSceneImage(id);
      forgetLocal(id);
      return 'cancelled';
    }
    if (record.status === 'generating') {
      if (generatingId.value === id) currentAbort?.abort();
      await patch(id, {
        status: 'failed',
        errorKind: 'aborted',
        error: '已中止（本次仍可能计费）',
      });
      return 'aborted';
    }
    return 'noop';
  }

  /** 切存档 / 离开页面：中止在飞的，清空排队的 */
  function abortAll(): void {
    currentAbort?.abort();
    const pending = [...queue.value];
    queue.value = [];
    for (const id of pending) {
      sessionLive.delete(id);
      // 与 dequeue 同一条理由：这些记录永远轮不到 runOne 的 finally 去清上下文
      context.delete(id);
      void deleteSceneImage(id).catch(() => {});
      forgetLocal(id);
    }
  }

  // ═══ generate（唯一入口，自动/手动两档共用）═══════════

  /**
   * 建记录 → 入队 → 串行生成。**自动与手动共用这一个函数**（§8）。
   *
   * 顺序是有讲究的:
   * 1. **先过限额**（D32）—— 两处花钱（LLM token + Anlas），闸门要在最前面，
   *    否则自动档会为被限流器拦下的插画白烧一次侧链调用。
   * 2. **再落库**（D5）—— 记录先落 `queued` 再发请求，于是刷新页面后在飞的图还在，
   *    而不是变成一次没人认领的扣费。
   * 3. 轮到它时才 `generating` + `startedAt`（D35/D37）。
   *
   * 🔴 **日后千万别为了「补全历史插画」加一条扫描全部消息的路径**（D15/§8.1）。
   * 自动档只对**编排器刚产出的那条消息**开火，这件事今天是靠「`onSceneImage` 回调
   * 只在新消息时触发一次」白拿的 —— 加一条历史扫描会把这条安全性一次性拆掉，
   * 表现为「把开关从手动拨到自动，追溯烧掉几十张图的钱」。补画的入口在正文里，
   * 一张一张点。
   */
  function generate(input: SceneImageGenerateInput): Promise<SceneImageGenerateResult> {
    // 🔴 读-判-写整段进闸（见 `serializeAdmission`）：限额是拿落库前读到的记录集算的，
    //    两次调用交错就会各自读到旧快照、双双放行。这是唯一一条会**多花钱**的竞态。
    return serializeAdmission(() => admitAndEnqueue(input));
  }

  async function admitAndEnqueue(
    input: SceneImageGenerateInput,
  ): Promise<SceneImageGenerateResult> {
    const now = Date.now();
    const existing = await getSceneImages(input.saveId);

    // ── 1. 限额（在侧链之前，D32）──
    // 🔴 手动档被拦下时是「弹一次确认后照发」而不是拦死（D24）—— 玩家点确认之后
    //    重发会带上 `quotaConfirmed`，这一次就绕过判定。**绕过口只对 manual 开**：
    //    自动档没有确认者，传了也当没传。
    const bypassQuota = input.quotaConfirmed === true && input.source === 'manual';
    if (seams.checkQuota && !bypassQuota) {
      const verdict = seams.checkQuota({
        records: existing,
        target: { messageId: input.messageId, turn: input.turn, source: input.source },
        now,
      });
      if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };
    }

    // ── 2. 锚点编号 ──
    const sameMessage = existing.filter(
      (r) => r.messageId === input.messageId && r.anchorKind === input.anchorKind,
    );
    // 🔴 两种 anchorKind 各自独立计数（上面已按 anchorKind 筛过）
    const occurrence = input.occurrence ?? nextIndex(sameMessage.map((r) => r.occurrence));
    // 🔴 take 用「已有最大值 + 1」而不是「已有条数」: 删掉中间某个 take 之后，
    //    按条数发号会与仍然活着的记录撞号，两条记录抢同一格。没有删除时两者等价。
    const take = nextIndex(
      sameMessage.filter((r) => r.occurrence === occurrence).map((r) => r.take),
    );

    // ── 3. 重画继承（D31：不重跑侧链）──
    const source = input.redrawFrom ? existing.find((r) => r.id === input.redrawFrom) : undefined;

    // 现在这一张归谁画、用哪条方言（C14）。缝没接 = 不盖章（老记录的样子）
    const runtime = seams.runtimeInfo?.();

    // 🔴 **缓存的场景串只在方言内有效**（C14/D31）：源记录是用另一条方言装配的时候，
    //    那串 danbooru 标签喂给吃句子的模型，产出的是一张谁也没要的图 —— 而调用方
    //    还以为「重画 = 用我现在的配置再来一次」。所以这里**不继承**，让侧链重跑一遍。
    //    `editedScenePrompt` 不在此列：用户亲手写的那份永远逐字优先（D26），
    //    方言对不对由界面去提示，不由我们替他丢掉。
    const sourceDialectId = source ? (source.dialectId ?? LEGACY_DIALECT_ID) : undefined;
    const dialectMatches =
      runtime === undefined ||
      sourceDialectId === undefined ||
      sourceDialectId === runtime.dialectId;
    const inherited = dialectMatches ? source : undefined;

    const record: SceneImageRecord = {
      id: newId(),
      saveId: input.saveId,
      messageId: input.messageId,
      anchorKind: input.anchorKind,
      occurrence,
      take,
      turn: input.turn,
      status: 'queued',
      source: input.source,
      title: input.title,
      description: input.description ?? source?.description ?? '',
      intent: input.intent,
      scenePrompt: inherited?.scenePrompt ?? '',
      sceneNegative: inherited?.sceneNegative ?? '',
      characters: [...input.characters],
      rating: input.rating,
      positive: '',
      negative: '',
      model: '',
      params: {},
      createdAt: now,
    };
    // 用户改过的那份**不看方言**（D26）：他亲手写的东西不该被我们悄悄丢掉
    if (source?.editedScenePrompt !== undefined) {
      record.editedScenePrompt = source.editedScenePrompt;
    }
    if (runtime) {
      record.provider = runtime.provider;
      record.dialectId = runtime.dialectId;
    }

    // 侧链要用的上下文不进记录（它们是**这一次**的输入，不是配方的一部分）
    context.set(record.id, { narrative: input.narrative ?? '', location: input.location });

    await put(record);
    enqueue(record.id);
    return { ok: true, id: record.id };
  }

  async function runOne(id: string): Promise<void> {
    const start = (await getSceneImage(id)) ?? find(id);
    // 记录可能已经被 cancel/remove 掉了 —— 那就什么都不做（尤其**不发请求**）
    if (!start || start.status !== 'queued') {
      context.delete(id);
      sessionLive.delete(id);
      return;
    }

    const abort = new AbortController();
    currentAbort = abort;
    generatingId.value = id;
    try {
      // 🔴 startedAt 而不是 createdAt（D37）—— 后者是入队时刻
      let current = await patch(id, { status: 'generating', startedAt: Date.now() });
      if (!current) return;

      // ── 中文 → danbooru（§8.5）──
      const resolved = await resolveScenePrompt(current, abort.signal);
      if (!resolved.ok) {
        await fail(id, resolved.failure);
        return;
      }
      current = resolved.record;

      if (abort.signal.aborted) {
        await fail(id, failureOf('aborted', '已中止（本次仍可能计费）', true));
        return;
      }

      // ── 发请求 ──
      if (!seams.send) {
        await fail(id, failureOf('network', '图像客户端尚未接入，这一张没有发出去。', false));
        return;
      }
      const sent = await seams.send(
        {
          record: current,
          scenePrompt: resolved.scenePrompt,
          sceneNegative: current.sceneNegative,
        },
        abort.signal,
      );
      if (!sent.ok) {
        await fail(id, sent);
        return;
      }

      const done: SceneImageRecord = {
        ...detach(current),
        status: 'done',
        mime: sent.mime,
        bytes: sent.bytes,
        positive: sent.positive,
        negative: sent.negative,
        model: sent.model,
        params: sent.params,
      };
      if (sent.hash !== undefined) done.hash = sent.hash;
      if (sent.seed !== undefined) done.seed = sent.seed;
      // 🔴 装配告警落库才有人消费（C15）—— CG 详情页据此写明某角色为何缺席。
      //    空数组不写：`composeWarnings` 缺席就是「一切正常」，存一个空壳只会让
      //    「有没有告警」多出一种要判的形态
      if (sent.composeWarnings && sent.composeWarnings.length > 0) {
        done.composeWarnings = sent.composeWarnings;
      } else {
        // 上一次失败/上一 take 留下的告警不该跟着这一次成功的图走
        delete done.composeWarnings;
      }
      // 上一次失败留下的话不该跟着成功的图走
      delete done.error;
      delete done.errorKind;
      await put(done, sent.blob);
    } catch (e) {
      // 缝里抛出来的任何东西都不该让泵停摆 —— 记成失败，继续下一条
      const detail = e instanceof Error ? e.message : String(e);
      await fail(id, { ...failureOf('network', '生成时出错，请稍后重试。', true), detail });
    } finally {
      context.delete(id);
      // 跑完（成功/失败/抛异常都算）就不再是「本次会话认领中」的记录
      sessionLive.delete(id);
      if (generatingId.value === id) generatingId.value = null;
      if (currentAbort === abort) currentAbort = null;
    }
  }

  /**
   * 拿到这一次要用的场景提示词。三条路，**前两条都不调侧链**（省钱，D31）:
   *
   * 1. `editedScenePrompt` —— 用户在图鉴里改过。**优先用它、且跳过侧链**（D26）：
   *    改完提示词点重画、结果却按 agent 的原话生成，是这类界面最挫败的一种失败。
   * 2. `scenePrompt` 已缓存（重画继承自上一 take）**且方言没换**（C14）—— 复用。
   * 3. 都没有 → 调侧链，抽不到 `<image_prompt>` 就是 `prompt-agent` 失败，**到此为止，
   *    不发上游**。
   *
   * 🔴 第 2 条的方言判据是 C14 的一半（另一半在 `admitAndEnqueue` 的继承处）：这里守的是
   *    **排队期间**用户切了方言那一刻 —— 记录盖的是入队时的章，装配却用当下的配置，
   *    两者不一致时那串缓存已经不算数了。判据放在两处不是重复：一处管「要不要抄过来」，
   *    一处管「抄过来之后还算不算数」。
   */
  async function resolveScenePrompt(
    record: SceneImageRecord,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; record: SceneImageRecord; scenePrompt: string }
    | { ok: false; failure: ImageGenFailure }
  > {
    const edited = record.editedScenePrompt;
    if (edited !== undefined && edited.trim() !== '') {
      return { ok: true, record, scenePrompt: edited };
    }

    const cached = record.scenePrompt;
    if (cached.trim() !== '' && cachedPromptStillValid(record)) {
      return { ok: true, record, scenePrompt: cached };
    }

    if (!seams.runPromptAgent) {
      return {
        ok: false,
        failure: failureOf('prompt-agent', '提示词生成尚未接入，这一张没有发出去。', false),
      };
    }

    const ctx = context.get(record.id);
    const req: ImagePromptRequest = {
      intent: record.intent,
      characters: [...record.characters],
      narrative: ctx?.narrative ?? '',
      rating: record.rating,
    };
    if (ctx?.location !== undefined) req.location = ctx.location;
    // D57：模型看不到库，「谁是第一次出场」只能由引擎告诉它。
    // 判定归缝（store 不认识预设库），这里只负责把它挂进请求。
    const needBaseline = seams.charactersNeedingBaseline?.(record.characters) ?? [];
    if (needBaseline.length > 0) req.charactersNeedingBaseline = needBaseline;

    // `ImagePromptOutput` 没有 `ok` 字段，`ImageGenFailure` 一定有 —— 用它判别
    const out = await seams.runPromptAgent(req, signal);
    if ('ok' in out) return { ok: false, failure: out };

    const produced: ImagePromptOutput = out;
    const next = await patch(record.id, {
      scenePrompt: produced.scenePrompt,
      sceneNegative: produced.sceneNegative,
      // agent 写的说明是**初值不是定论**（D18）：用户已经写过的不覆盖
      description: record.description !== '' ? record.description : produced.desc,
    });
    if (!next) {
      return { ok: false, failure: failureOf('prompt-agent', '记录已不存在。', false) };
    }
    return { ok: true, record: next, scenePrompt: produced.scenePrompt };
  }

  /**
   * 这条记录里缓存的场景串，在**当下的方言**里还算不算数（C14）。
   *
   * 缝没接 `runtimeInfo`（测试 / 老接线）→ 一律算数，也就是图像 v1 的行为：
   * 不认识方言的时候不该假装认识，凭空重跑一次侧链是在白花钱。
   */
  function cachedPromptStillValid(record: SceneImageRecord): boolean {
    const runtime = seams.runtimeInfo?.();
    if (!runtime) return true;
    return (record.dialectId ?? LEGACY_DIALECT_ID) === runtime.dialectId;
  }

  /**
   * 记成失败。
   *
   * 🔴 **已经落成 `aborted` 的失败不再被覆盖**（D36）。玩家点「中止」时 {@link cancel}
   *    已经写下「已中止（本次仍可能计费）」；紧接着在飞的那次请求会以客户端的
   *    `aborted`（文案「已取消」）回来，原样写下去就会把**可能已经计费**这件最要紧的事
   *    抹掉 —— 而中止恰恰只在请求已经发出去之后才可能发生，也就是**每次**都会被抹掉。
   *
   *    两种取消的措辞必须不同，这是 D36 的全部要点：排队中取消一个字节都没花，
   *    在飞中止上游照样收钱。
   */
  async function fail(id: string, failure: ImageGenFailure): Promise<void> {
    // 🔴 **本函数自己绝不抛**。它是 `runOne` 的 catch 里那一步兜底：兜底再抛出去，
    //    异常就从 catch 里逃出来一路冒成没人接的 rejection（见 `kick` 的 catch）。
    //    典型场景是切存档/关页面时 Dexie 已经关掉，这两次读写都会抛 `DatabaseClosedError`
    //    —— 而那时「把状态记成 failed」本来也已经没有意义了。
    try {
      const current = (await getSceneImage(id)) ?? find(id);
      if (current?.status === 'failed' && current.errorKind === 'aborted') return;
      await patch(id, {
        status: 'failed',
        error: failure.message,
        errorKind: failure.kind,
      });
    } catch (err) {
      console.warn('[sceneImage] 记录失败状态时出错（已忽略）:', err);
    }
  }

  return {
    // 状态
    records: computed(() => records.value),
    activeSaveId: computed(() => activeSaveId.value),
    loading: computed(() => loading.value),
    queue: computed(() => [...queue.value]),
    generatingId: computed(() => generatingId.value),
    gallery,
    // 读
    load,
    byMessage,
    takesAt,
    displayedAt,
    find,
    blobOf,
    // 写
    update,
    pin,
    remove,
    // 生成
    setSeams,
    generate,
    cancel,
    abortAll,
    whenIdle,
  };
});
