/**
 * 插件注册表 Store —— 插件系统设计 §3.3（发现与安装）、§3.4（风险确认）、§4.8（启动自检）、§6.4。
 *
 * 管四件事：
 *
 * 1. **已安装记录**（Dexie `plugins` 表的投影）与**本地文件夹清单**（BFF `GET /api/plugins`），
 *    逐个比对内容哈希，给出每个插件的状态：未安装 / 已是最新 / 有更新 / 无效 / 不兼容。
 * 2. **安装 / 更新 / 卸载**。🔴 安装与更新一律要调用方交来确认结果（界面弹
 *    PluginRiskConfirmModal，玩家确认后传 `{ confirmed: true }`），本店**从不静默安装或更新**。
 *    唯一例外是开发者的「跟随文件夹自动重载」：`network` 没变才免确认，变了照样要确认。
 * 3. **按存档启用**（决策 7）：确认只存在本机 `PluginRecord.saveConsents[saveId]`，
 *    存档元数据里只有 `enabledPluginIds`。实际生效 = 元数据里勾了 **且** 本机确认的
 *    `networkHash` 与当前安装一致 **且** 自检通过。所以导入的存档一律要在本机重新确认。
 * 4. **启动自检**（决策 9）：页面会话内首次需要时懒跑一次，结果只在内存里。
 *
 * 落库只经 `@engine/persistence/plugin-storage`；存档元数据只经 game-store 的
 * `setSaveEnabledPlugins`（它整行写回内存里的存档，绕开会被下一次整行写覆盖）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  deletePluginInstall,
  getPluginFiles,
  getPluginRecord,
  listPluginRecords,
  putPluginInstall,
  setPluginSaveConsent,
} from '@engine/persistence/plugin-storage';
import {
  computePluginContentHash,
  planPluginInstall,
  type PluginInstallPlan,
} from '@engine/plugins/plugin-install-plan';
import type { PluginConsent, PluginFileRecord, PluginRecord } from '@engine/types/types-plugin';
import {
  fetchLocalPluginFile,
  fetchLocalPlugins,
  type LocalPluginEntry,
  type LocalPluginListing,
} from '../lib/plugin-client';
import { mountPluginFrame } from '../lib/plugin-frame';
import { preparePluginIcon } from '../lib/plugin-icon';
import {
  runPluginSelfCheck,
  type PluginSelfCheckDeps,
  type PluginSelfCheckResult,
} from '../lib/plugin-selfcheck';
import { useGameStore } from './game-store';

// ──────────────────────────────────────────────────────────────────────────────
// 对外类型
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 本地文件夹里一个插件相对本机安装的状态；
 * `missing-source` = 已安装但文件夹里已经没有它（照常可用，只是无从更新）。
 */
type PluginEntryStatus =
  | 'not-installed'
  | 'up-to-date'
  | 'update-available'
  | 'invalid'
  | 'incompatible'
  | 'missing-source';

/** 管理页一行的视图 */
export interface PluginEntryView {
  id: string;
  status: PluginEntryStatus;
  /** 本地文件夹里的条目；`missing-source` 时为 null */
  local: LocalPluginEntry | null;
  /** 本机已安装记录；未安装时为 null */
  record: PluginRecord | null;
  /** 对本地条目出的安装计划；`missing-source` 时为 null */
  plan: PluginInstallPlan | null;
  /** 无效 / 不兼容的原因（简体中文，可直接展示） */
  errors: string[];
}

/** 风险确认弹窗的结果；只有玩家点了「确认」才是 `{ confirmed: true }` */
export interface PluginConfirmation {
  confirmed: boolean;
}

type PluginStoreFailureCode =
  | 'NEEDS_CONFIRMATION'
  | 'NOT_FOUND'
  | 'NOT_INSTALLABLE'
  | 'FETCH_FAILED'
  | 'CHANGED'
  | 'NO_SAVE'
  | 'FAILED';

export type PluginStoreResult =
  { ok: true } | { ok: false; code: PluginStoreFailureCode; message: string };

// ──────────────────────────────────────────────────────────────────────────────
// 内部工具
// ──────────────────────────────────────────────────────────────────────────────

const MANIFEST_PATH = 'manifest.json';
const SELFCHECK_API = '/api/plugins/__selfcheck/';

function fail(code: PluginStoreFailureCode, message: string): PluginStoreResult {
  return { ok: false, code, message };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 对一个本地条目出安装计划（内容哈希由清单里逐文件的 sha256 算出） */
function planLocalEntry(entry: LocalPluginEntry, existing: PluginRecord | undefined) {
  return planPluginInstall({
    manifestRaw: entry.manifestText,
    files: entry.files.map((f) => ({ path: f.path, size: f.size })),
    contentHash: computePluginContentHash(entry.files),
    source: 'local',
    existing,
    folderId: entry.id,
  });
}

function statusOf(plan: PluginInstallPlan, record: PluginRecord | undefined): PluginEntryStatus {
  if (plan.status === 'invalid') return 'invalid';
  if (plan.status === 'incompatible') return 'incompatible';
  if (!record) return 'not-installed';
  return plan.action === 'unchanged' ? 'up-to-date' : 'update-available';
}

/** 本机确认是否仍对得上当前安装（只看 `networkHash`，决策 7） */
function consentMatches(record: PluginRecord, saveId: string): boolean {
  const consent = record.saveConsents[saveId];
  return consent !== undefined && consent.networkHash === record.networkHash;
}

/** 第二回环主机名探活的超时 */
const SECOND_HOST_PROBE_TIMEOUT_MS = 1500;

/**
 * S5（第二回环主机名）只在那个主机名真的连得上时才测。
 * 开发服务器绑在 `localhost` 上时可能只听 ::1，此时 127.0.0.1 会被拒绝 ——
 * 不探活就会把「连不上」误判成「被拦住了」或拖慢自检。
 * 从主页面发一个 `no-cors` 请求：任何已兑现的响应（不透明响应也算）= 可达，网络错误 / 超时 = 不可达，
 * 不可达时返回 undefined（S5 记为跳过）。
 */
async function probeSecondLoopbackHost(): Promise<string | undefined> {
  const hostname = location.hostname;
  const host =
    hostname === 'localhost' ? '127.0.0.1' : hostname === '127.0.0.1' ? 'localhost' : null;
  if (host === null) return undefined;
  const loopbackOrigin = `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SECOND_HOST_PROBE_TIMEOUT_MS);
  try {
    await fetch(`${loopbackOrigin}${SELFCHECK_API}hits?n=`, {
      mode: 'no-cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    return host;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 自检用的生产依赖。探针帧挂在**离屏**容器里：🔴 不能 `display:none`，
 * 否则 CSS `url()`、字体这些手段根本不发请求，对照组恒不命中、插件被恒禁用。
 */
function createBrowserSelfCheckDeps(
  container: HTMLElement,
  secondLoopbackHost: string | undefined,
): PluginSelfCheckDeps {
  const query = (nonces: string[]) => `n=${encodeURIComponent(nonces.join(','))}`;
  return {
    origin: location.origin,
    mount: {
      plugin: (options) => mountPluginFrame(container, options),
      document: ({ html, sandbox }) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', sandbox);
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.style.width = '100%';
        frame.style.height = '100%';
        frame.style.border = '0';
        frame.setAttribute('srcdoc', html);
        container.appendChild(frame);
        return { dispose: () => frame.remove() };
      },
    },
    register: async (nonces) => {
      try {
        const res = await fetch(`${SELFCHECK_API}register?${query(nonces)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    hits: async (nonces) => {
      try {
        const res = await fetch(`${SELFCHECK_API}hits?${query(nonces)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) return {};
        const body = (await res.json()) as { hits?: unknown };
        return body.hits && typeof body.hits === 'object'
          ? (body.hits as Record<string, boolean>)
          : {};
      } catch {
        return {};
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    userAgent: navigator.userAgent,
    secondLoopbackHost,
  };
}

/** 建离屏容器跑一轮自检，跑完拆掉容器 */
async function runBrowserSelfCheck(): Promise<PluginSelfCheckResult> {
  const container = document.createElement('div');
  container.setAttribute('aria-hidden', 'true');
  const style = container.style;
  style.position = 'fixed';
  style.left = '-10000px';
  style.top = '0';
  style.width = '64px';
  style.height = '64px';
  style.overflow = 'hidden';
  style.pointerEvents = 'none';
  document.body.appendChild(container);
  try {
    const secondLoopbackHost = await probeSecondLoopbackHost();
    return await runPluginSelfCheck(createBrowserSelfCheckDeps(container, secondLoopbackHost));
  } finally {
    container.remove();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Store
// ──────────────────────────────────────────────────────────────────────────────

export const usePluginStore = defineStore('plugin', () => {
  /** 已安装记录（Dexie 投影，按 id 排序） */
  const records = ref<PluginRecord[]>([]);
  /** 最近一次本地文件夹清单；读取失败时为 null，原因见 `listingError` */
  const listing = ref<LocalPluginListing | null>(null);
  const listingError = ref<string | null>(null);
  /** 正在安装 / 更新 / 卸载的插件 id */
  const busyIds = ref<string[]>([]);
  /** 自检：未跑为 null，跑着为 'running'，跑完为结果（只在内存里） */
  const selfCheck = ref<PluginSelfCheckResult | null | 'running'>(null);
  /** 工具栏图标：插件 id → 贡献 id → 宿主重编码的 PNG data URL */
  const icons = ref<Record<string, Record<string, string>>>({});
  /** 图标是按哪份内容哈希洗出来的（内容变了才重洗） */
  const iconHashes = new Map<string, string>();

  let selfCheckPromise: Promise<PluginSelfCheckResult> | null = null;

  const recordById = computed(() => new Map(records.value.map((r) => [r.id, r])));

  const selfCheckPassed = computed(
    () => selfCheck.value !== null && selfCheck.value !== 'running' && selfCheck.value.ok,
  );

  /** 管理页的行：本地文件夹里的每个插件 + 已装但文件夹里已没有的 */
  const entries = computed<PluginEntryView[]>(() => {
    const out: PluginEntryView[] = [];
    const seen = new Set<string>();
    const local = listing.value?.enabled ? listing.value.plugins : [];
    for (const entry of local) {
      seen.add(entry.id);
      const record = recordById.value.get(entry.id);
      if (entry.error !== undefined) {
        out.push({
          id: entry.id,
          status: 'invalid',
          local: entry,
          record: record ?? null,
          plan: null,
          errors: [entry.error],
        });
        continue;
      }
      const plan = planLocalEntry(entry, record);
      const errors = [...plan.errors];
      if (plan.incompatible !== undefined) errors.push(plan.incompatible);
      out.push({
        id: entry.id,
        status: statusOf(plan, record),
        local: entry,
        record: record ?? null,
        plan,
        errors,
      });
    }
    for (const record of records.value) {
      if (seen.has(record.id)) continue;
      out.push({
        id: record.id,
        status: 'missing-source',
        local: null,
        record,
        plan: null,
        errors: [],
      });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });

  function isBusy(id: string): boolean {
    return busyIds.value.includes(id);
  }

  async function withBusy<T>(id: string, task: () => Promise<T>): Promise<T> {
    busyIds.value = [...busyIds.value, id];
    try {
      return await task();
    } finally {
      busyIds.value = busyIds.value.filter((x) => x !== id);
    }
  }

  async function reloadRecords(): Promise<void> {
    records.value = await listPluginRecords();
    await refreshIcons();
  }

  /** 已装插件的图标按内容哈希缓存；内容变了或新装才重洗 */
  async function refreshIcons(): Promise<void> {
    const next: Record<string, Record<string, string>> = {};
    for (const record of records.value) {
      const cached = icons.value[record.id];
      if (cached && iconHashes.get(record.id) === record.contentHash) {
        next[record.id] = cached;
        continue;
      }
      const iconPaths = record.manifest.contributions.filter((c) => c.icon !== undefined);
      if (iconPaths.length === 0) {
        iconHashes.set(record.id, record.contentHash);
        continue;
      }
      const files = await getPluginFiles(record.id);
      next[record.id] = await prepareIcons(record, files);
      iconHashes.set(record.id, record.contentHash);
    }
    for (const id of [...iconHashes.keys()]) {
      if (!recordById.value.has(id)) iconHashes.delete(id);
    }
    icons.value = next;
  }

  async function prepareIcons(
    record: PluginRecord,
    files: readonly { path: string; bytes: Uint8Array }[],
  ): Promise<Record<string, string>> {
    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    const out: Record<string, string> = {};
    for (const c of record.manifest.contributions) {
      if (c.icon === undefined) continue;
      const bytes = byPath.get(c.icon);
      if (!bytes) continue;
      const url = await preparePluginIcon(bytes);
      if (url !== null) out[c.id] = url;
    }
    return out;
  }

  /** 某个贡献的工具栏图标；没有或洗不出来时为 null（界面退回文字） */
  function iconFor(pluginId: string, contributionId: string): string | null {
    return icons.value[pluginId]?.[contributionId] ?? null;
  }

  /**
   * 重新读已安装记录与本地文件夹清单。
   * `devAutoReload`（「跟随文件夹自动重载」，默认关）开着时，`network` 没变的更新在这里
   * 直接装上；变了的仍等确认。开关由调用方从设置里读了传进来 —— 🔴 本店不许 import
   * settings-store（§4.5：那里住着 API 配置，插件模块一律够不着它，隔离闸门钉着）。
   * 本机装有插件时顺手踢一脚自检（决策 9：首次需要时懒跑）。
   */
  async function refresh(options: { devAutoReload?: boolean } = {}): Promise<void> {
    records.value = await listPluginRecords();
    const fetched = await fetchLocalPlugins();
    if (fetched.ok) {
      listing.value = fetched.value;
      listingError.value = fetched.value.enabled ? null : fetched.value.message;
    } else {
      listing.value = null;
      listingError.value = fetched.message;
    }

    if (options.devAutoReload === true) {
      for (const view of entries.value) {
        if (view.status !== 'update-available' || !view.plan || !view.record || !view.local) {
          continue;
        }
        if (view.plan.networkHash !== view.record.networkHash) continue;
        const result = await withBusy(view.id, () => applyInstall(view.local!));
        if (!result.ok) console.warn(`[plugin-store] 自动重载 ${view.id} 失败：${result.message}`);
      }
      records.value = await listPluginRecords();
    }

    await refreshIcons();
    if (records.value.length > 0) void ensureSelfCheck();
  }

  /**
   * 真正的安装：逐个取文件（sha256 已由客户端核对）、按取到的 manifest 重出计划、
   * 一个事务写入。调用前确认已经由调用方把关。
   */
  async function applyInstall(entry: LocalPluginEntry): Promise<PluginStoreResult> {
    const fetchedFiles: PluginFileRecord[] = [];
    for (const file of entry.files) {
      const got = await fetchLocalPluginFile(entry.id, file.path, file.sha256);
      if (!got.ok) {
        return fail(
          got.code === 'HASH_MISMATCH' ? 'CHANGED' : 'FETCH_FAILED',
          `读取 ${file.path} 失败：${got.message}`,
        );
      }
      fetchedFiles.push({
        pluginId: entry.id,
        path: file.path,
        bytes: got.value,
        size: got.value.byteLength,
        sha256: file.sha256.toLowerCase(),
      });
    }
    const manifestFile = fetchedFiles.find((f) => f.path === MANIFEST_PATH);
    if (!manifestFile) return fail('NOT_INSTALLABLE', '包内缺少 manifest.json');
    let manifestText: string;
    try {
      manifestText = new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.bytes);
    } catch {
      return fail('NOT_INSTALLABLE', 'manifest.json 不是合法的 UTF-8 文本');
    }

    const existing = await getPluginRecord(entry.id);
    const contentHash = computePluginContentHash(entry.files);
    const plan = planPluginInstall({
      manifestRaw: manifestText,
      files: fetchedFiles.map((f) => ({ path: f.path, size: f.size })),
      contentHash,
      source: 'local',
      existing,
      folderId: entry.id,
    });
    if (plan.status !== 'ok' || plan.manifest === null || plan.networkHash === null) {
      const reasons = [...plan.errors, ...(plan.incompatible ? [plan.incompatible] : [])];
      return fail('NOT_INSTALLABLE', reasons.join('；') || '插件无法安装');
    }

    const now = Date.now();
    const consent: PluginConsent = {
      version: plan.manifest.version,
      contentHash,
      networkHash: plan.networkHash,
      at: now,
    };
    const record: PluginRecord = {
      id: plan.manifest.id,
      manifest: plan.manifest,
      source: 'local',
      contentHash,
      networkHash: plan.networkHash,
      fileCount: plan.fileCount,
      totalBytes: plan.totalBytes,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      installConsent: consent,
      // network 变了：本机所有按存档的确认作废，各存档要重新确认（决策 7）
      saveConsents: plan.invalidatesSaveConsents ? {} : { ...(existing?.saveConsents ?? {}) },
    };
    try {
      await putPluginInstall(record, fetchedFiles);
    } catch (e) {
      return fail('FAILED', `写入插件失败：${errorText(e)}`);
    }
    icons.value = { ...icons.value, [record.id]: await prepareIcons(record, fetchedFiles) };
    iconHashes.set(record.id, record.contentHash);
    return { ok: true };
  }

  /**
   * 安装或更新本地文件夹里的插件。🔴 `confirmation` 必须是风险确认弹窗的结果，
   * 没确认一律拒绝 —— 本店没有静默安装 / 更新的路径。
   */
  async function install(id: string, confirmation: PluginConfirmation): Promise<PluginStoreResult> {
    if (confirmation.confirmed !== true) {
      return fail('NEEDS_CONFIRMATION', '安装与更新必须先确认风险');
    }
    const view = entries.value.find((e) => e.id === id);
    if (!view?.local) return fail('NOT_FOUND', '本地插件文件夹里找不到这个插件');
    if (view.status === 'invalid' || view.status === 'incompatible') {
      return fail('NOT_INSTALLABLE', view.errors.join('；') || '插件无法安装');
    }
    if (isBusy(id)) return fail('FAILED', '这个插件正在处理中');
    const local = view.local;
    const result = await withBusy(id, () => applyInstall(local));
    await reloadRecords();
    if (result.ok && records.value.length > 0) void ensureSelfCheck();
    return result;
  }

  /** 卸载：删安装记录、包文件与全局数据；各存档里的插件数据保留（§6.4） */
  async function uninstall(id: string): Promise<PluginStoreResult> {
    if (!recordById.value.has(id)) return fail('NOT_FOUND', '这个插件没有安装');
    try {
      await withBusy(id, () => deletePluginInstall(id));
    } catch (e) {
      return fail('FAILED', `卸载失败：${errorText(e)}`);
    }
    iconHashes.delete(id);
    await reloadRecords();
    return { ok: true };
  }

  // ─── 按存档启用 ───

  function enabledIdsOf(saveId: string): string[] {
    const save = useGameStore().saves.find((s) => s.id === saveId);
    return save?.metadata?.enabledPluginIds ?? [];
  }

  /**
   * 为某存档启用插件。🔴 `confirmation` 必须是短版风险确认弹窗的结果。
   * 先记本机确认（带当前 `networkHash`），再改存档的启用轴。
   */
  async function enableForSave(
    saveId: string,
    id: string,
    confirmation: PluginConfirmation,
  ): Promise<PluginStoreResult> {
    if (confirmation.confirmed !== true) {
      return fail('NEEDS_CONFIRMATION', '为存档启用插件必须先确认风险');
    }
    const record = recordById.value.get(id);
    if (!record) return fail('NOT_FOUND', '这个插件没有安装');
    const game = useGameStore();
    if (!game.saves.some((s) => s.id === saveId)) return fail('NO_SAVE', '找不到这个存档');

    const consent: PluginConsent = {
      version: record.manifest.version,
      contentHash: record.contentHash,
      networkHash: record.networkHash,
      at: Date.now(),
    };
    if (!(await setPluginSaveConsent(id, saveId, consent))) {
      return fail('NOT_FOUND', '这个插件没有安装');
    }
    const ids = enabledIdsOf(saveId);
    // 已在启用轴里（导入 / 手改的存档）也要补齐粘滞加固：这类存档可能缺 pluginHardened（决策 8）
    const ok = ids.includes(id)
      ? await game.ensureSaveHardened(saveId)
      : await game.setSaveEnabledPlugins(saveId, [...ids, id]);
    await reloadRecords();
    // 游玩中途启用的插件要等自检通过才生效：踢一脚但不等它（不拖住确认的落库）
    void ensureSelfCheck();
    return ok ? { ok: true } : fail('FAILED', '写入存档的插件启用设置失败');
  }

  /** 为某存档停用插件：撤销本机确认，并从启用轴里拿掉 */
  async function disableForSave(saveId: string, id: string): Promise<PluginStoreResult> {
    const game = useGameStore();
    if (!game.saves.some((s) => s.id === saveId)) return fail('NO_SAVE', '找不到这个存档');
    const ids = enabledIdsOf(saveId);
    const ok = ids.includes(id)
      ? await game.setSaveEnabledPlugins(
          saveId,
          ids.filter((x) => x !== id),
        )
      : true;
    if (recordById.value.has(id)) await setPluginSaveConsent(id, saveId, null);
    await reloadRecords();
    return ok ? { ok: true } : fail('FAILED', '写入存档的插件启用设置失败');
  }

  /**
   * 实际生效（决策 7 + Q5）：存档启用轴里有它、本机确认的 `networkHash` 与当前安装一致、
   * 且本页面会话的自检已全部通过。
   */
  function isEffectivelyEnabled(saveId: string, id: string): boolean {
    if (!selfCheckPassed.value) return false;
    if (!enabledIdsOf(saveId).includes(id)) return false;
    const record = recordById.value.get(id);
    return record !== undefined && consentMatches(record, saveId);
  }

  /** 某存档实际生效的插件 */
  function effectivePluginsForSave(saveId: string): PluginRecord[] {
    return enabledIdsOf(saveId)
      .map((id) => recordById.value.get(id))
      .filter((r): r is PluginRecord => r !== undefined && isEffectivelyEnabled(saveId, r.id));
  }

  /** 存档启用了、但本机没装的插件 id（数据原样保留，扩展管理页提示，§6.4） */
  function enabledButNotInstalled(saveId: string): string[] {
    return enabledIdsOf(saveId).filter((id) => !recordById.value.has(id));
  }

  /** 存档启用了、本机也装了，但本机确认缺失或已作废（导入的存档 / network 变了）的插件 */
  function needsReconfirm(saveId: string): PluginRecord[] {
    return enabledIdsOf(saveId)
      .map((id) => recordById.value.get(id))
      .filter((r): r is PluginRecord => r !== undefined && !consentMatches(r, saveId));
  }

  /** 存档被删后清掉各插件里对它的本机确认 */
  async function forgetSave(saveId: string): Promise<void> {
    const holders = (await listPluginRecords()).filter((r) => r.saveConsents[saveId]);
    for (const record of holders) await setPluginSaveConsent(record.id, saveId, null);
    if (holders.length > 0) await reloadRecords();
  }

  // ─── 自检 ───

  /** 页面会话内只跑一次；并发调用共用同一轮 */
  function ensureSelfCheck(): Promise<PluginSelfCheckResult> {
    if (!selfCheckPromise) {
      selfCheck.value = 'running';
      selfCheckPromise = runBrowserSelfCheck().then((result) => {
        selfCheck.value = result;
        return result;
      });
    }
    return selfCheckPromise;
  }

  /**
   * 「重新检查」：丢掉本页面会话里缓存的结果再跑一轮（管理页按钮用）。
   * 正在跑的那一轮不打断，直接共用它 —— 并发两轮会让金丝雀命中互相串味。
   */
  function rerunSelfCheck(): Promise<PluginSelfCheckResult> {
    if (selfCheck.value === 'running' && selfCheckPromise) return selfCheckPromise;
    selfCheckPromise = null;
    selfCheck.value = null;
    return ensureSelfCheck();
  }

  return {
    records,
    listing,
    listingError,
    busyIds,
    selfCheck,
    selfCheckPassed,
    entries,
    isBusy,
    iconFor,
    refresh,
    install,
    uninstall,
    enableForSave,
    disableForSave,
    isEffectivelyEnabled,
    effectivePluginsForSave,
    enabledButNotInstalled,
    needsReconfirm,
    forgetSave,
    ensureSelfCheck,
    rerunSelfCheck,
  };
});
