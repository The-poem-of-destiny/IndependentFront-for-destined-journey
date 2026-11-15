/**
 * 插件运行时 Store —— 插件系统设计 §4.7、§5.5、§5.7、§6.1–§6.5。
 *
 * 管「当前存档」上插件的一切活物：
 *
 * 1. **进出存档**（`enterSave` / `leaveSave`）：按存档申请跨标签页 Web Lock（§6.5，状态给横幅）、
 *    挂提示词输入 provider（管线同步取，故这里维护一份缓存）、按存档粘滞的美化帧加固、
 *    启动后台页面（manifest 写了 `background` 的插件，至多 8 个）。离开时全部拆掉。
 * 2. **界面**（surface）：打开 / 关闭 / 聚焦，同一时刻至多一个 overlay；
 *    `mountFrameFor(surfaceId)` 交给 `PluginSurface.vue` 挂帧 —— 读包文件、挂牢笼帧、建桥、建宿主会话。
 * 3. **事件**（§5.5）：管线回合信号 → `turn.*`；`isInCombat` → `combat.*`；
 *    `timelineRestoreSeq` → 重推视图 + `timeline.restored`；游戏状态变化 → 重推变了的视图 + `state.changed`。
 *
 * 几条硬约束：
 * - 越过端口的值一律是纯 JSON：视图经 `buildPluginView`（自带 JSON 往返），桥对推送值再做一次深拷贝。
 * - 回合号口径（D5 as-built）：投影 `run.turn` 与 AI 扩展的 `currentTurn()` 都是
 *   `activeSave.metadata.totalTurns`（最后一个已完成的回合），不是正在生成的那一回合。
 * - 后台页面挂在本店自建的**离屏**容器里，🔴 不能 `display:none`（帧内的 CSS / 字体加载会停摆）。
 * - 插件身份只认建帧时的 `pluginId`，桥与宿主会话都按构造参数绑定（§4.7）。
 */
import { defineStore } from 'pinia';
import { computed, ref, watch, type WatchStopHandle } from 'vue';
import { createDefaultSaveProfile, getCharacters } from '@engine/persistence/database';
import {
  getPluginFiles,
  pluginKvGet,
  pluginKvRemove,
  pluginKvSet,
} from '@engine/persistence/plugin-storage';
import { buildPluginView, type PluginProjectionInput } from '@engine/plugins/plugin-projection';
import { PLUGIN_FILE_TYPES, PLUGIN_LIMITS, PLUGIN_VIEWS } from '@engine/plugins/plugin-surface';
import {
  enqueuePluginNote,
  getPluginSaveBag,
  readPluginPromptInputs,
  setPluginContext,
  writePluginSaveKv,
} from '@engine/state/save-profile';
import { createStateManager } from '@engine/state/state-manager';
import type {
  PluginFileRecord,
  PluginManifest,
  PluginPromptInputs,
  PluginRecord,
  PluginRunGuard,
} from '@engine/types/types-plugin';
import { setBeautifierHardened } from '../lib/beautifier-hardening';
import { createPluginBridge } from '../lib/plugin-bridge';
import { mountPluginFrame, type PluginFrameFile } from '../lib/plugin-frame';
import { createPluginHost, type PluginHostSession } from '../lib/plugin-host';
import {
  createPluginAiExtension,
  createPluginExternalLinkExtension,
  createPluginStorageExtension,
} from '../lib/plugin-host-extensions';
import { onPluginTurnSignal, setPluginPromptInputProvider } from '../lib/plugin-run-signals';
import {
  acquirePluginSaveLock,
  type PluginSaveLockHandle,
  type PluginSaveLockState,
} from '../lib/plugin-save-lock';
import { resolveSceneWeather } from '../lib/scene-image-seams';
import { useGameStore } from './game-store';
import { usePluginStore } from './plugin-store';
import { useUIStore } from './ui-store';

// ──────────────────────────────────────────────────────────────────────────────
// 对外类型
// ──────────────────────────────────────────────────────────────────────────────

/** 一个打开着的插件界面（F1 的 PluginSurfaceLayer 按它渲染 PluginSurface） */
export interface PluginOpenSurface {
  surfaceId: string;
  pluginId: string;
  pluginName: string;
  /** manifest 声明了联网域名 → 边框上带「联网」标记 */
  networked: boolean;
  contributionId: string;
  mode: 'window' | 'overlay' | 'panel';
  title: string;
  /** 贡献声明的初始尺寸（px） */
  width?: number;
  height?: number;
  /** 插件经 `ui.resize` 请求的尺寸；每次请求换一个新对象，PluginSurface 据此重新夹取 */
  requestedSize: { width: number; height: number } | null;
  /** 层级（按聚焦顺序递增） */
  zIndex: number;
}

/** 「复制链接」弹窗的内容（PluginExternalLinkModal） */
export interface PluginExternalLinkRequest {
  pluginName: string;
  url: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// 内部
// ──────────────────────────────────────────────────────────────────────────────

type PluginBridge = ReturnType<typeof createPluginBridge>;

/** 一对活着的帧（界面帧或后台帧）及其桥与宿主会话 */
interface LiveFrame {
  pluginId: string;
  manifest: PluginManifest;
  /** 后台帧为 null */
  surfaceId: string | null;
  frame: { dispose(): void } | null;
  bridge: PluginBridge | null;
  host: PluginHostSession | null;
  /** 上次推给这对帧的各视图 JSON（判定 `state.changed` 用） */
  lastViews: Map<string, string>;
  disposed: boolean;
}

/** 后台帧的记账：内容哈希变了就重启 */
interface BackgroundEntry {
  live: LiveFrame;
  contentHash: string;
  holder: HTMLElement;
}

/** 状态变化合批推送的延迟（毫秒）：一次回读会连改好几个 ref，合成一次推送 */
const STATE_PUSH_DELAY_MS = 50;
/** 界面层级起点 */
const SURFACE_Z_BASE = 1;

const EMPTY_PROMPT_INPUTS: PluginPromptInputs = { notes: [], contexts: [] };

function isPluginView(value: string): boolean {
  return (PLUGIN_VIEWS as readonly string[]).includes(value);
}

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  return PLUGIN_FILE_TYPES[ext] ?? 'application/octet-stream';
}

function toFrameFile(file: PluginFileRecord): PluginFrameFile {
  return { path: file.path, mime: mimeOf(file.path), bytes: file.bytes };
}

/** 读宿主当前的 `--theme-*` 变量；帧模块会再过滤一次 */
function readThemeValues(): Record<string, string> {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return {};
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const name = style.item(i);
    if (name.startsWith('--theme-')) out[name] = style.getPropertyValue(name).trim();
  }
  return out;
}

/** 后台帧的离屏容器：在视口外但仍参与布局，帧内资源照常加载 */
function createOffscreenHost(): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  const style = container.style;
  style.position = 'fixed';
  style.left = '-10000px';
  style.top = '0';
  style.width = '320px';
  style.overflow = 'hidden';
  style.pointerEvents = 'none';
  document.body.appendChild(container);
  return container;
}

// ──────────────────────────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────────────────────────

export const usePluginRuntimeStore = defineStore('plugin-runtime', () => {
  /** 本运行时绑定的存档；不在游戏页时为 null */
  const saveId = ref<string | null>(null);
  /** 跨标签页锁的状态（§6.5）；`waiting` / `unsupported` 时 F1 显示横幅 */
  const lockState = ref<PluginSaveLockState>('released');
  const openSurfaces = ref<PluginOpenSurface[]>([]);
  /** 最近获得焦点的界面（GamePage 的 Esc 分层据此让路） */
  const focusedSurfaceId = ref<string | null>(null);
  /** 插件请求的外链；非 null 时 F1 弹 PluginExternalLinkModal */
  const externalLink = ref<PluginExternalLinkRequest | null>(null);
  /** 插件请求回填输入框的文本；GamePage 消费后置回 null（只填不发） */
  const pendingInputFill = ref<string | null>(null);

  // 非响应式的运行时簿记
  const frames = new Set<LiveFrame>();
  const background = new Map<string, BackgroundEntry>();
  let backgroundHost: HTMLElement | null = null;
  let lockHandle: PluginSaveLockHandle | null = null;
  let lockPending = false;
  let promptInputs: PluginPromptInputs = EMPTY_PROMPT_INPUTS;
  let stops: Array<WatchStopHandle | (() => void)> = [];
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 每次进出存档 +1；异步回来时对不上就作废 */
  let session = 0;
  let surfaceSeq = 0;
  let topZ = SURFACE_Z_BASE;

  const game = useGameStore();
  const plugins = usePluginStore();

  const hasOverlay = computed(() => openSurfaces.value.some((s) => s.mode === 'overlay'));

  // ─── 读环境 ───

  /** 宿主眼里的当前存档：运行时绑定的存档且仍是游戏页的活跃存档 */
  function currentSaveId(): string | null {
    const id = saveId.value;
    return id !== null && game.activeSaveId === id ? id : null;
  }

  function effectiveRecords(): PluginRecord[] {
    const id = saveId.value;
    return id === null ? [] : plugins.effectivePluginsForSave(id);
  }

  function recordOf(pluginId: string): PluginRecord | undefined {
    return effectiveRecords().find((r) => r.id === pluginId);
  }

  function enabledIdsOfCurrent(): string[] {
    const id = saveId.value;
    if (id === null) return [];
    const save = game.saves.find((s) => s.id === id) ?? game.activeSave;
    return save?.metadata?.enabledPluginIds ?? [];
  }

  /**
   * 美化帧是否该加固（粘滞）：存档已带 `pluginHardened`、存档列了插件、或本机有生效插件，
   * 任一成立即加固。enterSave 与 syncRuntime 共用这一处判定。
   */
  function shouldHarden(records: PluginRecord[] = effectiveRecords()): boolean {
    return (
      game.activeSave?.metadata?.pluginHardened === true ||
      enabledIdsOfCurrent().length > 0 ||
      records.length > 0
    );
  }

  /** 最后一个已完成的回合（D5：与管线的 N = totalTurns + 1 对齐） */
  function completedTurn(): number {
    return game.activeSave?.metadata?.totalTurns ?? 0;
  }

  /** 运行态守卫（§6.1、§6.2）：生成 / 润色中 `BUSY`，战斗中 `IN_COMBAT` */
  const runGuard: PluginRunGuard = () => {
    if (game.isGenerating || game.isRewriting) return 'BUSY';
    if (game.isInCombat) return 'IN_COMBAT';
    return 'ok';
  };

  function projectionInput(): PluginProjectionInput {
    const id = saveId.value ?? '';
    const profile = game.saveProfile ?? createDefaultSaveProfile(id);
    const input: PluginProjectionInput = {
      characters: game.characters,
      profile,
      messages: game.messages,
      plotEvents: game.activePlotEvents,
      run: {
        generating: game.isGenerating,
        inCombat: game.isInCombat,
        turn: completedTurn(),
        mode: game.generationMode,
      },
    };
    const weather = resolveSceneWeather(profile);
    if (weather !== undefined) input.weather = weather;
    return input;
  }

  // ─── 推送 ───

  function liveBridges(): LiveFrame[] {
    return [...frames].filter((f) => !f.disposed && f.bridge !== null);
  }

  function pushEventAll(name: string, payload: unknown): void {
    for (const live of liveBridges()) live.bridge!.pushEvent(name, payload);
  }

  /** 这对帧能读的视图 */
  function declaredViews(live: LiveFrame): string[] {
    return live.manifest.capabilities.read.filter(isPluginView);
  }

  function buildView(view: string, input: PluginProjectionInput): { value: unknown; json: string } {
    try {
      const value = buildPluginView(view as (typeof PLUGIN_VIEWS)[number], input);
      return { value, json: JSON.stringify(value) ?? '' };
    } catch (err) {
      console.warn(`[plugin-runtime] 构建视图 ${view} 失败:`, err);
      return { value: null, json: '' };
    }
  }

  /** 记下这对帧各视图的当前值，作为 `state.changed` 的比较基线 */
  function seedViews(live: LiveFrame): void {
    if (currentSaveId() === null) return;
    const input = projectionInput();
    for (const view of declaredViews(live)) live.lastViews.set(view, buildView(view, input).json);
  }

  /**
   * 把变了的视图推给所有活帧（桥按订阅过滤），并对有变化的帧发 `state.changed`。
   * `force`：不比较、全部重推（时间线恢复后用），也不发 `state.changed`。
   */
  function pushViews(force: boolean): void {
    if (currentSaveId() === null) return;
    const bridges = liveBridges();
    if (bridges.length === 0) return;
    const input = projectionInput();
    const built = new Map<string, { value: unknown; json: string }>();
    for (const live of bridges) {
      const changed: string[] = [];
      for (const view of declaredViews(live)) {
        let entry = built.get(view);
        if (!entry) {
          entry = buildView(view, input);
          built.set(view, entry);
        }
        if (!force && live.lastViews.get(view) === entry.json) continue;
        live.lastViews.set(view, entry.json);
        live.bridge!.pushView(view, entry.value);
        changed.push(view);
      }
      if (!force && changed.length > 0) live.bridge!.pushEvent('state.changed', { views: changed });
    }
  }

  function schedulePush(): void {
    if (pushTimer !== null) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushViews(false);
    }, STATE_PUSH_DELAY_MS);
  }

  // ─── 提示词输入缓存（§5.8；管线同步读） ───

  async function refreshPromptCache(): Promise<void> {
    const id = saveId.value;
    const mine = session;
    if (id === null) return;
    const records = effectiveRecords();
    const names = new Map(records.map((r) => [r.id, r.manifest.name]));
    try {
      const next = await readPluginPromptInputs(
        id,
        records.map((r) => r.id),
        (pluginId) => names.get(pluginId) ?? pluginId,
      );
      if (mine === session && saveId.value === id) promptInputs = next;
    } catch (err) {
      console.warn('[plugin-runtime] 读取插件提示词输入失败:', err);
    }
  }

  // ─── 帧与宿主会话 ───

  /**
   * 写入落库后回读游戏状态。
   * 🔴 `refreshFromDb` 对角色是合并语义（只覆盖 / 追加，从不删），插件 `character.remove`
   *    删掉的角色会一直留在内存、界面与下一回合上下文里。所以回读后再按库里的角色集合
   *    收一遍：库里没有的一律丢掉（与 game-store `removeCharacter` 的整表替换同一口径）。
   */
  async function refreshAfterWrite(): Promise<void> {
    const id = currentSaveId();
    if (id === null) return;
    await game.refreshFromDb(id);
    const dbChars = await getCharacters(id);
    if (currentSaveId() === id) {
      const dbIds = new Set(dbChars.map((c) => c.id));
      if (game.characters.some((c) => !dbIds.has(c.id))) {
        game.characters = game.characters.filter((c) => dbIds.has(c.id));
      }
    }
    await refreshPromptCache();
  }

  /** 一对帧一份宿主会话；surfaceId 由桥按构造参数填进每次调用（ui.close / ui.resize 据此路由） */
  function createHostFor(record: PluginRecord): PluginHostSession {
    const { manifest } = record;
    return createPluginHost({
      pluginId: record.id,
      manifest,
      getSaveId: currentSaveId,
      getProjectionInput: projectionInput,
      guard: runGuard,
      lockState: () => lockState.value,
      playerName: () => game.player?.name ?? '',
      stateManagerFor: (id) => createStateManager(id),
      refreshAfterWrite,
      pushViews: () => pushViews(false),
      ui: {
        close: (id) => closeSurface(id),
        resize: (id, width, height) => resizeSurface(id, width, height),
        toast: (text) => useUIStore().toast(`${manifest.name}：${text}`, 'info'),
        fillInput: (text) => {
          pendingInputFill.value = text;
        },
      },
      extensions: [
        createPluginStorageExtension({
          getSaveBag: getPluginSaveBag,
          writeSaveKv: writePluginSaveKv,
          kvGet: pluginKvGet,
          kvSet: pluginKvSet,
          kvRemove: pluginKvRemove,
        }),
        createPluginAiExtension({
          enqueueNote: enqueuePluginNote,
          setContext: setPluginContext,
          currentTurn: completedTurn,
          addSystemNotice: (event) => game.addSystemMessage(event),
        }),
        createPluginExternalLinkExtension({
          showExternalLink: (pluginName, url) => {
            externalLink.value = { pluginName, url };
          },
        }),
      ],
    });
  }

  function disposeFrame(live: LiveFrame): void {
    if (live.disposed) return;
    live.disposed = true;
    frames.delete(live);
    live.bridge?.dispose();
    live.host?.dispose();
    live.frame?.dispose();
  }

  /** 读包文件 → 挂牢笼帧 → 建宿主会话与桥。文件是异步读的，返回的记账对象立即可用来拆除 */
  function launchFrame(
    record: PluginRecord,
    entry: string,
    surfaceId: string | null,
    container: HTMLElement,
  ): LiveFrame {
    const live: LiveFrame = {
      pluginId: record.id,
      manifest: record.manifest,
      surfaceId,
      frame: null,
      bridge: null,
      host: null,
      lastViews: new Map(),
      disposed: false,
    };
    frames.add(live);
    void (async () => {
      let files: PluginFileRecord[];
      try {
        files = await getPluginFiles(record.id);
      } catch (err) {
        console.warn(`[plugin-runtime] 读取插件 ${record.id} 的文件失败:`, err);
        disposeFrame(live);
        return;
      }
      if (live.disposed) return;
      const check = plugins.selfCheck;
      const innerMode =
        check !== null && check !== 'running' ? (check.innerMode ?? undefined) : undefined;
      const handle = mountPluginFrame(container, {
        pluginId: record.id,
        network: [...record.manifest.network],
        entry,
        files: files.map(toFrameFile),
        theme: readThemeValues(),
        innerMode,
        // 插件在加载期间就 `on('save.enter')`，那些请求先于 ready 到达桥，所以 ready 时再发
        onReady: () => live.bridge?.pushEvent('save.enter', {}),
        onLoadError: (error) =>
          useUIStore().toast(
            `插件「${live.manifest.name}」的页面加载失败：${String(error)}`,
            'warning',
          ),
        onViolation: () => onFrameViolation(live),
      });
      live.frame = handle;
      if (live.disposed) {
        handle.dispose();
        return;
      }
      const host = createHostFor(record);
      live.host = host;
      live.bridge = createPluginBridge(
        surfaceId === null
          ? { pluginId: record.id, manifest: record.manifest, port: handle.port, host }
          : { pluginId: record.id, manifest: record.manifest, port: handle.port, host, surfaceId },
      );
      seedViews(live);
    })();
    return live;
  }

  /** 牢笼报内层帧二次导航：帧已被帧模块拆掉，这里收尾界面与提示 */
  function onFrameViolation(live: LiveFrame): void {
    disposeFrame(live);
    if (live.surfaceId !== null) closeSurface(live.surfaceId);
    else background.delete(live.pluginId);
    useUIStore().toast(`插件「${live.manifest.name}」的页面试图自行跳转，已被关闭`, 'warning');
  }

  // ─── 后台页面 ───

  function stopBackground(pluginId: string): void {
    const entry = background.get(pluginId);
    if (!entry) return;
    background.delete(pluginId);
    disposeFrame(entry.live);
    entry.holder.remove();
  }

  function syncBackground(records: PluginRecord[]): void {
    const wanted = records
      .filter((r) => typeof r.manifest.background === 'string' && r.manifest.background !== '')
      .slice(0, PLUGIN_LIMITS.backgroundPlugins);
    const wantedIds = new Set(wanted.map((r) => r.id));
    for (const [pluginId, entry] of [...background.entries()]) {
      const record = wanted.find((r) => r.id === pluginId);
      if (!wantedIds.has(pluginId) || record?.contentHash !== entry.contentHash) {
        stopBackground(pluginId);
      }
    }
    for (const record of wanted) {
      if (background.has(record.id)) continue;
      backgroundHost ??= createOffscreenHost();
      const holder = document.createElement('div');
      holder.style.width = '320px';
      holder.style.height = '240px';
      backgroundHost.appendChild(holder);
      const live = launchFrame(record, record.manifest.background!, null, holder);
      background.set(record.id, { live, contentHash: record.contentHash, holder });
    }
  }

  // ─── 锁（§6.5） ───

  async function ensureLock(): Promise<void> {
    const id = saveId.value;
    if (id === null || lockHandle !== null || lockPending) return;
    lockPending = true;
    const mine = session;
    try {
      const handle = await acquirePluginSaveLock(id, {
        onChange: (state) => {
          if (mine === session) lockState.value = state;
        },
      });
      if (mine !== session) {
        handle.release();
        return;
      }
      lockHandle = handle;
      lockState.value = handle.state;
    } finally {
      if (mine === session) lockPending = false;
    }
  }

  /** 横幅上的「重试」 */
  async function retryLock(): Promise<void> {
    if (lockHandle === null) {
      await ensureLock();
      return;
    }
    lockState.value = await lockHandle.retry();
  }

  // ─── 生效集合变化时重排运行时 ───

  function syncRuntime(): void {
    const id = saveId.value;
    if (id === null) return;
    const records = effectiveRecords();
    setBeautifierHardened(shouldHarden(records));
    if (records.length > 0 || enabledIdsOfCurrent().length > 0) void ensureLock();
    syncBackground(records);
    const effective = new Set(records.map((r) => r.id));
    for (const surface of [...openSurfaces.value]) {
      if (!effective.has(surface.pluginId)) closeSurface(surface.surfaceId);
    }
    void refreshPromptCache();
  }

  // ─── 进出存档 ───

  /**
   * 进入存档（GamePage 挂载、活跃存档就绪后调用）。重复进入同一存档是空操作；
   * 换存档会先离开旧的。
   */
  async function enterSave(id: string): Promise<void> {
    if (saveId.value === id) return;
    if (saveId.value !== null) leaveSave();
    session += 1;
    const mine = session;
    saveId.value = id;
    promptInputs = EMPTY_PROMPT_INPUTS;
    setPluginPromptInputProvider(() => promptInputs);
    // 粘滞加固：存档里列了插件就立刻加固美化帧，并把缺失的 pluginHardened 补写回存档
    const listsPlugins = enabledIdsOfCurrent().length > 0;
    setBeautifierHardened(shouldHarden());
    if (listsPlugins) void game.ensureSaveHardened(id);

    if (enabledIdsOfCurrent().length > 0) {
      void ensureLock();
      try {
        if (plugins.records.length === 0) await plugins.refresh();
        await plugins.ensureSelfCheck();
      } catch (err) {
        console.warn('[plugin-runtime] 读取插件注册表失败:', err);
      }
      if (mine !== session) return;
    }

    stops = [
      watch(
        () =>
          effectiveRecords()
            .map((r) => `${r.id}:${r.contentHash}`)
            .join('|'),
        () => syncRuntime(),
      ),
      onPluginTurnSignal((signal) => {
        if (signal.saveId !== saveId.value) return;
        pushEventAll(signal.type, { turn: completedTurn() });
        if (signal.type !== 'turn.start') {
          void refreshPromptCache();
          schedulePush();
        }
      }),
      watch(
        () => game.isInCombat,
        (inCombat, was) => {
          if (inCombat !== was) pushEventAll(inCombat ? 'combat.start' : 'combat.end', {});
        },
      ),
      watch(
        () => game.timelineRestoreSeq,
        () => {
          void refreshPromptCache();
          pushViews(true);
          pushEventAll('timeline.restored', {});
        },
      ),
      watch(
        [
          () => game.characters,
          () => game.saveProfile,
          () => game.messages.length,
          () => game.activePlotEvents,
          () => game.isGenerating,
          () => game.isInCombat,
          () => completedTurn(),
        ],
        () => schedulePush(),
      ),
    ];
    syncRuntime();
  }

  /** 离开存档（GamePage 卸载或切档）：发 `save.leave`，拆掉一切 */
  function leaveSave(): void {
    if (saveId.value === null) return;
    pushEventAll('save.leave', {});
    session += 1;
    for (const stop of stops) stop();
    stops = [];
    if (pushTimer !== null) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    for (const pluginId of [...background.keys()]) stopBackground(pluginId);
    for (const live of [...frames]) disposeFrame(live);
    backgroundHost?.remove();
    backgroundHost = null;
    openSurfaces.value = [];
    focusedSurfaceId.value = null;
    externalLink.value = null;
    pendingInputFill.value = null;
    setPluginPromptInputProvider(null);
    promptInputs = EMPTY_PROMPT_INPUTS;
    setBeautifierHardened(false);
    lockHandle?.release();
    lockHandle = null;
    lockPending = false;
    lockState.value = 'released';
    saveId.value = null;
  }

  // ─── 界面（§5.7） ───

  /**
   * 打开某插件的一个贡献界面；返回 surfaceId，插件未生效 / 贡献不存在时返回 null。
   * 同一贡献已开着就只聚焦它；overlay 同一时刻只留一个（开新的关旧的）。
   */
  function openSurface(pluginId: string, contributionId: string): string | null {
    if (currentSaveId() === null) return null;
    const record = recordOf(pluginId);
    const contribution = record?.manifest.contributions.find((c) => c.id === contributionId);
    if (!record || !contribution) return null;
    const existing = openSurfaces.value.find(
      (s) => s.pluginId === pluginId && s.contributionId === contributionId,
    );
    if (existing) {
      focusSurface(existing.surfaceId);
      return existing.surfaceId;
    }
    if (contribution.surface === 'overlay') {
      for (const s of openSurfaces.value.filter((x) => x.mode === 'overlay')) {
        closeSurface(s.surfaceId);
      }
    }
    surfaceSeq += 1;
    const surfaceId = `plugin-surface-${surfaceSeq}`;
    topZ += 1;
    const surface: PluginOpenSurface = {
      surfaceId,
      pluginId,
      pluginName: record.manifest.name,
      networked: record.manifest.network.length > 0,
      contributionId,
      mode: contribution.surface,
      title: contribution.label,
      requestedSize: null,
      zIndex: topZ,
    };
    if (contribution.width !== undefined) surface.width = contribution.width;
    if (contribution.height !== undefined) surface.height = contribution.height;
    openSurfaces.value = [...openSurfaces.value, surface];
    focusedSurfaceId.value = surfaceId;
    return surfaceId;
  }

  /** 关闭界面；帧由 PluginSurface 卸载时经 `mountFrameFor` 返回的 dispose 拆，这里兜底再拆一次 */
  function closeSurface(surfaceId: string): void {
    const remaining = openSurfaces.value.filter((s) => s.surfaceId !== surfaceId);
    if (remaining.length === openSurfaces.value.length) return;
    openSurfaces.value = remaining;
    for (const live of [...frames]) if (live.surfaceId === surfaceId) disposeFrame(live);
    if (focusedSurfaceId.value === surfaceId) {
      const top = [...remaining].sort((a, b) => b.zIndex - a.zIndex)[0];
      focusedSurfaceId.value = top?.surfaceId ?? null;
    }
  }

  /** 聚焦界面：提到最上层 */
  function focusSurface(surfaceId: string): void {
    const surface = openSurfaces.value.find((s) => s.surfaceId === surfaceId);
    if (!surface) return;
    focusedSurfaceId.value = surfaceId;
    if (surface.zIndex === topZ) return;
    topZ += 1;
    surface.zIndex = topZ;
  }

  function resizeSurface(surfaceId: string, width: number, height: number): void {
    const surface = openSurfaces.value.find((s) => s.surfaceId === surfaceId);
    if (surface) surface.requestedSize = { width, height };
  }

  /**
   * 给 PluginSurface 的 `mountFrame`：在它的容器里挂这个界面的帧，返回拆除函数。
   * 界面已关或插件已不生效时返回空拆除。
   */
  function mountFrameFor(surfaceId: string): (container: HTMLElement) => { dispose(): void } {
    return (container) => {
      const surface = openSurfaces.value.find((s) => s.surfaceId === surfaceId);
      const record = surface ? recordOf(surface.pluginId) : undefined;
      const contribution = record?.manifest.contributions.find(
        (c) => c.id === surface?.contributionId,
      );
      if (!surface || !record || !contribution || currentSaveId() === null) {
        return { dispose() {} };
      }
      const live = launchFrame(record, contribution.entry, surfaceId, container);
      return { dispose: () => disposeFrame(live) };
    };
  }

  function closeExternalLink(): void {
    externalLink.value = null;
  }

  return {
    saveId,
    lockState,
    openSurfaces,
    focusedSurfaceId,
    externalLink,
    pendingInputFill,
    hasOverlay,
    enterSave,
    leaveSave,
    retryLock,
    openSurface,
    closeSurface,
    focusSurface,
    mountFrameFor,
    closeExternalLink,
  };
});
