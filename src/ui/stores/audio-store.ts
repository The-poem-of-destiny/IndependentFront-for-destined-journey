/**
 * audio-store.ts — 音频系统 Pinia 薄壳 (Phase Audio, 波次 4)
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §4.1 / §5 / §6.3 / §7
 *
 * 职责:
 * - 镜像 AudioManager 的**离散**状态 (subscribe)；position 不进响应式状态 (§6.3)
 * - 曲库/播放列表的 Dexie 读写 + 内置 manifest 合并 (§5)
 * - 音量/循环/随机等全局偏好经 settings-store 持久化 (§4.1, 计划 A5)
 *
 * 边界: Store 不碰 AudioContext；单例与浏览器工厂住在 lib/audio-singleton.ts (计划 A1)
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type {
  AudioPlaybackState,
  AudioPlaylist,
  AudioRepeatMode,
  AudioTrack,
  AudioTrackKind,
} from '@engine/types';
import {
  getAudioTracks,
  saveAudioTrack,
  deleteAudioTrack as dbDeleteAudioTrack,
  getAudioPlaylists,
  saveAudioPlaylist,
  deleteAudioPlaylist as dbDeleteAudioPlaylist,
  getAudioBlob,
} from '@engine/database';
import { findByName, isNameTaken, uniqueAudioName } from '@engine/audio-names';
import { resolveSceneByTags } from '@engine/audio-scene';
import type { SceneTagQuery, SceneTagResult, SceneVariant } from '@engine/audio-scene';
import { getAudioManager, installUnlockListener, setBlobResolver } from '../lib/audio-singleton';
import {
  isFolderSupported,
  pickLibraryFolder,
  getStoredFolder,
  forgetFolder as forgetStoredFolder,
  checkPermission,
  requestPermission,
  scanFolder,
  resolveFile,
  type ScannedFile,
} from '../lib/audio-folder';
import { hashMediaBlob } from '../lib/media-hash';
import { useSettingsStore } from './settings-store';
import { useUIStore } from './ui-store';

// ===== 常量 =====

/** 进度轮询频率 ~4Hz (§6.3) */
const POSITION_POLL_MS = 250;

/** 内置曲库清单路径 (§5)；不存在时静默跳过 */
const MANIFEST_URL = '/audio/manifest.json';

/** manifest 条目格式: { id, name, kind, file, tags, credit, license } */
interface AudioManifestEntry {
  id: string;
  name: string;
  kind?: AudioTrackKind;
  file: string;
  tags?: string[];
  credit?: string;
  license?: string;
}

/**
 * 音乐文件夹的授权状态 (addendum §权限生命周期)
 * - unsupported: 浏览器没有 File System Access
 * - none: 支持，但用户还没选文件夹
 * - prompt: 有句柄但本次会话尚未授权（浏览器重启后的常态）
 * - granted / denied: 授权结果
 */
export type AudioFolderPermission = 'unsupported' | 'none' | 'prompt' | 'granted' | 'denied';

/**
 * 批量操作的如实回执（对齐 forgetFolder / rescanFolder / uploadFiles 的「尽力做完」模式）：
 * 单条失败不中断其余，结束后由 store 汇总提示一次，调用方拿到分项计数即可。
 *
 * - ok      成功处理的条数
 * - skipped 有意跳过的条数（已在列表中 / 内置曲目 / 曲目不存在）
 * - failed  尝试了但没成功的条数
 */
export interface AudioBatchResult {
  ok: number;
  skipped: number;
  failed: number;
}

function idleState(): AudioPlaybackState {
  return {
    music: {
      status: 'idle',
      trackId: null,
      playlistId: null,
      index: -1,
      durationSec: 0,
      volume: 1,
      muted: false,
      repeat: 'all',
      shuffle: false,
    },
    sfx: { volume: 1, muted: false, liveVoices: 0 },
    masterVolume: 1,
    masterMuted: false,
    unlocked: false,
  };
}

function newId(prefix: string): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 去掉文件扩展名 */
function stripExt(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(0, i) : filename;
}

/**
 * 导入路径（上传 / 文件夹扫描）撞名时自动编号后汇总播报一次。
 * 一个文件一条 toast 会把界面淹掉，所以只报总数。
 */
function notifyAutoRenamed(count: number): void {
  if (count <= 0) return;
  notify(`${count} 个文件重名，已自动编号`, 'info');
}

/**
 * 是否是「浏览器存储配额耗尽」。标准浏览器抛 DOMException('QuotaExceededError')，
 * 老 Firefox 用 NS_ERROR_DOM_QUOTA_REACHED；Dexie 会原样透传底层错误。
 */
function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** 提示的唯一出口；无 Pinia 上下文（测试 / 早期启动）时不该因为一条提示炸掉调用方 */
function notify(message: string, type: 'info' | 'error'): void {
  try {
    useUIStore().toast(message, type);
  } catch {
    // 静默：提示失败不能影响主流程的结果
  }
}

// ===== Store =====

export const useAudioStore = defineStore('audio', () => {
  const manager = getAudioManager();

  // ── 状态镜像 (离散，不含 position) ─────────────────────
  const state = ref<AudioPlaybackState>(idleState());

  // ── 曲库 ────────────────────────────────────────────────
  /** 用户上传曲目 (Dexie) + 内置曲目 (manifest) 的并集 */
  const tracks = ref<AudioTrack[]>([]);
  const playlists = ref<AudioPlaylist[]>([]);
  /** manifest 曲目 —— 不落 Dexie，每次启动重新 fetch */
  const builtinTracks = ref<AudioTrack[]>([]);
  const loading = ref(false);

  /** 按需采样的播放位置(秒)，仅在有人轮询时更新 (§6.3) */
  const positionSec = ref(0);

  // ── 音乐文件夹 (addendum) ───────────────────────────────
  const folderPermission = ref<AudioFolderPermission>('unsupported');
  const folderName = ref('');
  const scanning = ref(false);

  /** 目录句柄不进响应式状态：它是不可克隆语义的宿主对象，只被动作读写 */
  let folderHandle: FileSystemDirectoryHandle | null = null;

  let initialized = false;
  let unsubscribe: (() => void) | null = null;

  // ═══ 库加载 ═══════════════════════════════════════════

  /** 拉取内置 manifest；缺文件/解析失败一律静默（对齐 loadBuiltInWorldBooks） */
  async function loadManifest(): Promise<void> {
    try {
      const res = await fetch(MANIFEST_URL);
      if (!res.ok) return;
      const raw = (await res.json()) as AudioManifestEntry[];
      if (!Array.isArray(raw)) return;
      const now = Date.now();
      builtinTracks.value = raw
        .filter((e) => e && typeof e.id === 'string' && typeof e.file === 'string')
        .map<AudioTrack>((e) => ({
          id: e.id,
          name: e.name || stripExt(e.file),
          kind: e.kind === 'sfx' ? 'sfx' : 'music',
          source: 'builtin',
          url: e.file.startsWith('/') ? e.file : `/audio/${e.file}`,
          tags: Array.isArray(e.tags) ? e.tags : [],
          builtin: true,
          createdAt: now,
          updatedAt: now,
        }));
    } catch {
      // manifest 尚未存在（波次 5c 交付）或 fetch 不可用 → 静默
    }
  }

  /** 从 Dexie 读曲目与播放列表，并与内置曲目合并后灌给 Manager */
  async function loadLibrary(): Promise<void> {
    loading.value = true;
    try {
      const [dbTracks, dbLists] = await Promise.all([getAudioTracks(), getAudioPlaylists()]);
      tracks.value = [...builtinTracks.value, ...dbTracks];
      playlists.value = dbLists;
    } catch {
      // IndexedDB 不可用 → 只留内置曲目
      tracks.value = [...builtinTracks.value];
      playlists.value = [];
    } finally {
      loading.value = false;
    }
    manager.setTracks(tracks.value);
    manager.setPlaylists(playlists.value);
  }

  /** 仅刷新曲目（写操作后调用） */
  async function refreshTracks(): Promise<void> {
    try {
      const dbTracks = await getAudioTracks();
      tracks.value = [...builtinTracks.value, ...dbTracks];
    } catch {
      tracks.value = [...builtinTracks.value];
    }
    manager.setTracks(tracks.value);
  }

  /** 仅刷新播放列表（写操作后调用） */
  async function refreshPlaylists(): Promise<void> {
    try {
      playlists.value = await getAudioPlaylists();
    } catch {
      playlists.value = [];
    }
    manager.setPlaylists(playlists.value);
  }

  // ═══ 字节读取 seam (addendum §Store changes) ═══════════

  /**
   * 已经就「标记失败」提示过的曲目 id。落库失败会在每次播放尝试时重现，
   * 而这条路径在播放中被反复触发 —— 不去重就是一屏 toast。
   */
  const missingWarned = new Set<string>();

  /**
   * 把某条曲目标记为「文件已移除」并落库；已是 missing 则空转。
   *
   * 落库失败 = 库里它仍写着「可播放」，用户下次打开照样点、照样失败。
   * 这里在播放路径上，不能弹打断性的错误刷屏，所以**同一曲目只提示一次**；
   * 等哪次真标上了就把记号清掉，之后再坏还会再提醒。
   */
  async function markMissing(track: AudioTrack): Promise<void> {
    if (track.missing) return;
    try {
      await saveAudioTrack({ ...track, missing: true });
      missingWarned.delete(track.id);
      await refreshTracks();
    } catch {
      // IndexedDB 不可用时不该连播放路径一起炸，但也不能装作没事发生
      if (missingWarned.has(track.id)) return;
      missingWarned.add(track.id);
      notify(
        `曲目「${track.name}」的文件读不到，且「文件已移除」标记没能写入曲库，` +
          '它在列表里仍会显示为可播放，播放会一直失败。' +
          '重新关联音乐文件夹或「重新扫描」可以修正；曲目行与磁盘文件都没有被删除。',
        'error',
      );
    }
  }

  /**
   * AudioManager 的唯一字节来源，按 source 分派:
   * - 'file'   → 从用户音乐文件夹取；文件没了就标 missing 并返回 undefined（不抛）
   * - 'blob'   → IndexedDB（原路径不变）
   * - 'builtin'→ 同上返回 undefined；音乐声道直接用 track.url，不会走到这里
   */
  async function loadBlob(trackId: string): Promise<Blob | undefined> {
    const track = findTrack(trackId);
    if (!track || track.source !== 'file') return getAudioBlob(trackId);

    if (!folderHandle || !track.relativePath) {
      await markMissing(track);
      return undefined;
    }

    // 没授权 ≠ 文件不见了。浏览器重启后权限退回 'prompt'（initFolder 刻意不主动
    // requestPermission，那需要用户手势），此时**每点一首就标一首 missing** 会把整个
    // 曲库逐首污染成"文件已移除"，而磁盘上的文件好好的。只提示、不写库。
    if (folderPermission.value !== 'granted') {
      notifyPermissionNeeded();
      return undefined;
    }

    let file: File | null = null;
    try {
      file = await resolveFile(folderHandle, track.relativePath);
    } catch {
      // resolveFile 只把"确实找不到"转成 null，抛出来的是权限被撤销之类的**临时**故障。
      // 拿临时故障去标 missing 同样是在写假信息。
      notifyPermissionNeeded();
      return undefined;
    }
    if (!file) {
      await markMissing(track);
      return undefined;
    }
    return file;
  }

  /** 「需要授权」整会话只提示一次；一旦真授权成功就把记号清掉，之后再断还会再提醒 */
  let permissionWarned = false;
  function notifyPermissionNeeded(): void {
    if (permissionWarned) return;
    permissionWarned = true;
    notify('音乐文件夹尚未授权访问，无法读取曲目。请在设置→音频里点「授权访问」。', 'error');
  }

  // ═══ 音乐文件夹 (addendum) ═════════════════════════════

  /**
   * 启动期恢复文件夹状态。**绝不调用 requestPermission** —— 它需要用户手势，
   * 无手势调用会静默失败，看起来就像 bug。授权按钮由 UI 提供。
   */
  async function initFolder(): Promise<void> {
    if (!isFolderSupported()) {
      folderPermission.value = 'unsupported';
      return;
    }
    let handle: FileSystemDirectoryHandle | null = null;
    try {
      handle = await getStoredFolder();
    } catch {
      handle = null;
    }
    if (!handle) {
      folderHandle = null;
      folderName.value = '';
      folderPermission.value = 'none';
      return;
    }
    folderHandle = handle;
    folderName.value = handle.name ?? '';
    folderPermission.value = await checkPermission(handle);
    if (folderPermission.value === 'granted') await rescanFolder();
  }

  /** 用户手势：弹目录选择器。成功即视为已授权并立即扫描。 */
  async function pickFolder(): Promise<boolean> {
    if (!isFolderSupported()) return false;
    const handle = await pickLibraryFolder();
    if (!handle) return false;
    folderHandle = handle;
    folderName.value = handle.name ?? '';
    folderPermission.value = 'granted';
    permissionWarned = false;
    await rescanFolder();
    return true;
  }

  /** 用户手势：对已存句柄重新申请读权限（浏览器重启后每会话一次） */
  async function grantFolderPermission(): Promise<boolean> {
    if (!folderHandle) return false;
    const ok = await requestPermission(folderHandle);
    folderPermission.value = ok ? 'granted' : 'denied';
    if (ok) permissionWarned = false;
    if (ok) await rescanFolder();
    return ok;
  }

  /**
   * 目录 ↔ 曲目目录的对账（按 relativePath 匹配）:
   * - 磁盘新增 → 建曲目
   * - 两边都有 → 清 missing，刷新 size/mimeType
   * - 目录里有但磁盘没了 → 标 missing
   *
   * **扫描期间绝不删行** —— 标签、kind、播放列表位次是用户的整理成果，
   * 文件被挪走或硬盘没插不该把它们毁掉。
   */
  async function rescanFolder(): Promise<void> {
    if (!folderHandle || scanning.value) return;
    scanning.value = true;
    try {
      let scanned: ScannedFile[] = [];
      try {
        scanned = await scanFolder(folderHandle);
      } catch {
        return;
      }
      const onDisk = new Map(scanned.map((f) => [f.name, f]));
      const seen = new Set<string>();

      // 尽力做完：单条落库失败不能中断对账，否则表现成「扫描完了，但一半文件没进来」。
      let failed = 0;

      for (const track of tracks.value.filter((t) => t.source === 'file')) {
        const path = track.relativePath ?? '';
        const hit = path ? onDisk.get(path) : undefined;
        try {
          if (hit) {
            seen.add(path);
            if (track.missing || track.size !== hit.size || track.mimeType !== hit.mimeType) {
              await saveAudioTrack({
                ...track,
                missing: false,
                size: hit.size,
                mimeType: hit.mimeType,
              });
            }
          } else if (!track.missing) {
            await saveAudioTrack({ ...track, missing: true });
          }
        } catch {
          failed += 1;
        }
      }

      // 名字唯一性: 扫描**永不因为重名跳过文件**，撞名自动编号后汇总提示一次。
      // 池子随建随长，同一次扫描里的两个同名文件也能各自拿到号。
      const namePool = tracks.value.map((t) => ({ id: t.id, name: t.name }));
      let renamed = 0;

      const now = Date.now();
      for (const f of scanned) {
        if (seen.has(f.name)) continue;
        const desired = stripExt(f.name);
        const name = uniqueAudioName(namePool, desired);
        if (name !== desired) renamed += 1;
        const id = newId('audio');
        namePool.push({ id, name });
        try {
          await saveAudioTrack({
            id,
            name,
            kind: 'music',
            source: 'file',
            mimeType: f.mimeType,
            size: f.size,
            relativePath: f.name,
            tags: [],
            missing: false,
            createdAt: now,
            updatedAt: now,
          });
        } catch {
          failed += 1;
          if (name !== desired) renamed -= 1; // 没建成的行不该算进「已自动编号」
        }
      }

      await refreshTracks();
      notifyAutoRenamed(renamed);
      if (failed > 0) {
        // 一条汇总，不是每条一个 —— 一屏 toast 等于没有 toast。
        notify(
          `扫描完成，但有 ${failed} 首曲目没能写入曲库，它们的状态可能不准确（缺失的没被标出，` +
            '或新文件没有收录）。其余曲目已完成对账；曲目行与磁盘文件都没有被删除，可以再扫描一次重试。',
          'error',
        );
      }
    } finally {
      scanning.value = false;
    }
  }

  /**
   * 取消关联：只删句柄，**不删任何曲目行**。曲目全部变成 missing（字节暂时够不着），
   * 重新选回同一个文件夹时按文件名原样恢复，标签与播放列表位次都还在。
   *
   * 铁律：**界面呈现的状态必须等于持久层的真实状态**。所以这里分两段，各自如实汇报：
   * 1. 句柄删不掉 → 关联其实还在，整个中止，内存态一个字都不改（改了就是撒谎）；
   * 2. 句柄删掉了但个别曲目标不上 missing → 部分成功，逐条尽力做完后汇总报一次。
   *
   * 返回是否完全成功；失败已通过 toast 说明爆炸半径，调用方无需再报。
   */
  async function forgetFolder(): Promise<boolean> {
    try {
      await forgetStoredFolder();
    } catch {
      // 句柄还躺在库里，重启浏览器后关联会「复活」。此时谎称已取消才是最坏结果。
      notify(
        '取消关联失败：文件夹的授权记录没能删除，音乐文件夹仍处于关联状态。' +
          '磁盘文件与曲库记录都没有改动，可以稍后重试。',
        'error',
      );
      return false;
    }

    folderHandle = null;
    folderName.value = '';
    folderPermission.value = isFolderSupported() ? 'none' : 'unsupported';

    // 尽力做完：单条落库失败不能连累后面的曲目，否则曲库会留下一半错的状态。
    let failed = 0;
    for (const track of tracks.value.filter((t) => t.source === 'file' && !t.missing)) {
      try {
        await saveAudioTrack({ ...track, missing: true });
      } catch {
        failed += 1;
      }
    }
    await refreshTracks();

    if (failed > 0) {
      // 一条汇总，不是每条一个 —— 一屏 toast 等于没有 toast。
      notify(
        `已取消关联音乐文件夹，但有 ${failed} 首曲目没能标记为「文件已移除」，` +
          '它们在曲库里仍显示为可播放，实际播放会失败。' +
          '重新关联该文件夹后再「重新扫描」即可修正。曲目行与磁盘文件都没有被删除。',
        'error',
      );
      return false;
    }
    return true;
  }

  // ═══ 初始化 ═══════════════════════════════════════════

  /** 幂等；组件在 onMounted 里调用 */
  async function init(): Promise<void> {
    if (initialized) return;
    initialized = true;

    unsubscribe = manager.subscribe((s) => {
      state.value = s;
    });
    setBlobResolver(loadBlob);
    installUnlockListener();

    restoreSettings();
    await loadManifest();
    await loadLibrary();
    await initFolder();

    state.value = manager.state as AudioPlaybackState;
  }

  /** 从 settings-store 恢复混音/循环偏好到 Manager (A5) */
  function restoreSettings(): void {
    const s = useSettingsStore().settings;
    manager.setMasterVolume(Number(s.audioMasterVolume ?? 0.7));
    manager.setMasterMuted(Boolean(s.audioMasterMuted));
    manager.setChannelVolume('music', Number(s.audioMusicVolume ?? 0.7));
    manager.setChannelMuted('music', Boolean(s.audioMusicMuted));
    manager.setChannelVolume('sfx', Number(s.audioSfxVolume ?? 0.7));
    manager.setChannelMuted('sfx', Boolean(s.audioSfxMuted));
    manager.setRepeat((s.audioRepeat ?? 'all') as AudioRepeatMode);
    manager.setShuffle(Boolean(s.audioShuffle));
    state.value = manager.state as AudioPlaybackState;
  }

  function dispose(): void {
    stopPositionPolling(true);
    setBlobResolver(null);
    unsubscribe?.();
    unsubscribe = null;
    initialized = false;
  }

  // ═══ 上传 ═════════════════════════════════════════════

  /**
   * 每个文件建一条曲目 + 一条 blob 记录；名字取文件名去扩展名。
   * 撞名自动编号（导入路径永不因重名失败），最后汇总提示一次。
   *
   * 逐条尽力做完：一批里某个文件写不进去，不能连累后面的文件 ——
   * 「选了 10 个只进来 3 个」而且毫无解释，是这条路径上最常见的糟糕体验。
   * 不做事务回滚：已建成的行如实留着，部分成功就如实呈现部分成功。
   *
   * 配额耗尽是唯一的例外：它不是个案，而是说明后面的文件基本也没戏，
   * 继续硬试只是让用户多等，所以就地停下并给出「改用音乐文件夹」的出路。
   */
  async function uploadFiles(files: File[], kind: AudioTrackKind = 'music'): Promise<AudioTrack[]> {
    const created: AudioTrack[] = [];
    const namePool = tracks.value.map((t) => ({ id: t.id, name: t.name }));
    let renamed = 0;
    let failed = 0;
    let quotaHit = false;
    for (const file of files) {
      const now = Date.now();
      const desired = stripExt(file.name);
      const name = uniqueAudioName(namePool, desired);
      if (name !== desired) renamed += 1;
      const id = newId('audio');
      namePool.push({ id, name });
      // 顺手补 hash: 上传进来的轨是 source:'blob'，会被打进素材导出包，
      // 没 hash 的话重新导入时计划器无从比对，会克隆出一条 ` (2)`（D12/§4.4）。
      // 非安全上下文算不出来就留空 —— 上传绝不因为哈希失败而失败。
      const hash = await hashMediaBlob(file);
      const track: AudioTrack = {
        id,
        name,
        kind,
        source: 'blob',
        mimeType: file.type || undefined,
        size: file.size,
        hash,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };
      try {
        await saveAudioTrack(track, file);
        created.push(track);
      } catch (e) {
        failed += 1;
        if (name !== desired) renamed -= 1; // 没建成的行不该算进「已自动编号」
        if (isQuotaError(e)) {
          quotaHit = true;
          break;
        }
      }
    }
    await refreshTracks();
    notifyAutoRenamed(renamed);

    if (quotaHit) {
      const missed = files.length - created.length;
      notify(
        `浏览器存储空间已满，${missed} 个文件没能导入（已导入 ${created.length} 个）。` +
          '上传会把音频字节存进浏览器配额，几百 MB 的曲库很容易撑满；' +
          '建议改用「音乐文件夹」直接读取本机文件，不占配额。已导入的曲目不受影响。',
        'error',
      );
    } else if (failed > 0) {
      // 一条汇总，不是每条一个 —— 一屏 toast 等于没有 toast。
      notify(
        `有 ${failed} 个文件没能导入（已导入 ${created.length} 个）。` +
          '已导入的曲目都已保留，重新上传失败的文件即可补齐。',
        'error',
      );
    }
    return created;
  }

  // ═══ 曲目 CRUD ════════════════════════════════════════

  function findTrack(id: string): AudioTrack | undefined {
    return tracks.value.find((t) => t.id === id);
  }

  /**
   * 按名字找曲目（归一化比较）。多命中取最早建立的那条 —— 历史重名行刻意保留，
   * 答案必须稳定 (@engine/audio-names)。
   */
  function findTrackByName(name: string): AudioTrack | undefined {
    return findByName(tracks.value, name);
  }

  /**
   * 手工改名: 重名**拒绝**而不是自动编号（用户是有意在起名，替他改反而是骗人）。
   * 改成自己现在的名字不算冲突（exceptId）。返回是否落库。
   */
  async function renameTrack(id: string, name: string): Promise<boolean> {
    const t = findTrack(id);
    if (!t || t.builtin) return false;
    if (isNameTaken(tracks.value, name, id)) return false;
    await saveAudioTrack({ ...t, name });
    await refreshTracks();
    return true;
  }

  async function setTrackTags(id: string, tags: string[]): Promise<void> {
    const t = findTrack(id);
    if (!t || t.builtin) return;
    await saveAudioTrack({ ...t, tags: [...tags] });
    await refreshTracks();
  }

  async function setTrackKind(id: string, kind: AudioTrackKind): Promise<void> {
    const t = findTrack(id);
    if (!t || t.builtin) return;
    await saveAudioTrack({ ...t, kind });
    await refreshTracks();
  }

  /** 内置曲目不可删（§2: builtin 只能隐藏） */
  async function deleteTrack(id: string): Promise<void> {
    const t = findTrack(id);
    if (t?.builtin) return;
    await dbDeleteAudioTrack(id);
    // 删除会顺带剪掉播放列表里的悬挂引用 → 两边都刷
    await refreshTracks();
    await refreshPlaylists();
  }

  /**
   * 批量删除（曲库多选）。**尽力做完**：单条删不掉不连累其余，
   * 否则表现成「选了 12 首，删了 3 首就不动了」而且毫无解释。
   *
   * 内置曲目不可删（§2: builtin 只能隐藏）与查无此曲一律算 skipped，不算失败 ——
   * 它们不是错误，只是不适用。结束后一条汇总，不是每条一个。
   */
  async function deleteTracks(ids: string[]): Promise<AudioBatchResult> {
    const res: AudioBatchResult = { ok: 0, skipped: 0, failed: 0 };
    for (const id of ids) {
      const t = findTrack(id);
      if (!t || t.builtin) {
        res.skipped += 1;
        continue;
      }
      try {
        await dbDeleteAudioTrack(id);
        res.ok += 1;
      } catch {
        res.failed += 1;
      }
    }
    // 删除会顺带剪掉播放列表里的悬挂引用 → 两边都刷
    await refreshTracks();
    await refreshPlaylists();

    if (res.failed > 0) {
      notify(
        `已删除 ${res.ok} 首曲目，但有 ${res.failed} 首没能删除，它们仍留在曲库里。` +
          '可以再删一次重试；磁盘上的文件不会被删除。',
        'error',
      );
    } else if (res.ok > 0) {
      notify(`已删除 ${res.ok} 首曲目。`, 'info');
    }
    return res;
  }

  // ═══ 播放列表 CRUD ════════════════════════════════════

  function findPlaylist(id: string): AudioPlaylist | undefined {
    return playlists.value.find((p) => p.id === id);
  }

  /** 播放列表与曲目是**两个命名空间**：同名的一首曲子和一个列表可以并存 */
  function findPlaylistByName(name: string): AudioPlaylist | undefined {
    return findByName(playlists.value, name);
  }

  /** 手工命名 → 重名拒绝，返回 null（不抛） */
  async function createPlaylist(name: string): Promise<AudioPlaylist | null> {
    if (isNameTaken(playlists.value, name)) return null;
    const now = Date.now();
    const list: AudioPlaylist = {
      id: newId('plist'),
      name,
      trackIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await saveAudioPlaylist(list);
    await refreshPlaylists();
    return list;
  }

  /** 手工改名 → 重名拒绝；改成自己现在的名字不算冲突 */
  async function renamePlaylist(id: string, name: string): Promise<boolean> {
    const p = findPlaylist(id);
    if (!p) return false;
    if (isNameTaken(playlists.value, name, id)) return false;
    await saveAudioPlaylist({ ...p, name });
    await refreshPlaylists();
    return true;
  }

  async function deletePlaylist(id: string): Promise<void> {
    await dbDeleteAudioPlaylist(id);
    if (useSettingsStore().settings.audioLastPlaylistId === id) {
      useSettingsStore().settings.audioLastPlaylistId = '';
    }
    await refreshPlaylists();
  }

  async function addTrackToPlaylist(playlistId: string, trackId: string): Promise<void> {
    const p = findPlaylist(playlistId);
    if (!p || p.trackIds.includes(trackId)) return;
    await saveAudioPlaylist({ ...p, trackIds: [...p.trackIds, trackId] });
    await refreshPlaylists();
  }

  /**
   * 批量加入播放列表（曲库多选）。已在列表中的曲目**静默跳过**（对齐单条
   * addTrackToPlaylist 的既有行为），但汇总提示要如实说出跳过了几首 ——
   * 报成「全部成功」等于骗人。
   *
   * 这里只落一次库（播放列表是一条记录的整序覆盖），所以写入失败就是整批没进去，
   * 如实计入 failed，不谎称部分成功。
   */
  async function addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<AudioBatchResult> {
    const p = findPlaylist(playlistId);
    if (!p) {
      notify('目标播放列表已不存在，没有任何曲目被加入。', 'error');
      return { ok: 0, skipped: 0, failed: trackIds.length };
    }
    const seen = new Set(p.trackIds);
    const toAdd: string[] = [];
    let skipped = 0;
    for (const id of trackIds) {
      if (seen.has(id)) {
        skipped += 1;
        continue;
      }
      seen.add(id);
      toAdd.push(id);
    }

    if (toAdd.length === 0) {
      if (skipped > 0) notify(`选中的 ${skipped} 首曲目都已在「${p.name}」中，已跳过。`, 'info');
      return { ok: 0, skipped, failed: 0 };
    }

    try {
      await saveAudioPlaylist({ ...p, trackIds: [...p.trackIds, ...toAdd] });
    } catch {
      notify(
        `有 ${toAdd.length} 首曲目没能加入「${p.name}」，播放列表未被改动，可以再试一次。`,
        'error',
      );
      return { ok: 0, skipped, failed: toAdd.length };
    }
    await refreshPlaylists();

    notify(
      skipped > 0
        ? `已加入 ${toAdd.length} 首到「${p.name}」，另有 ${skipped} 首已在列表中，已跳过。`
        : `已加入 ${toAdd.length} 首到「${p.name}」。`,
      'info',
    );
    return { ok: toAdd.length, skipped, failed: 0 };
  }

  async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
    const p = findPlaylist(playlistId);
    if (!p) return;
    await saveAudioPlaylist({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) });
    await refreshPlaylists();
  }

  /** 整序覆盖（拖拽排序后调用） */
  async function reorderPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const p = findPlaylist(playlistId);
    if (!p) return;
    await saveAudioPlaylist({ ...p, trackIds: [...trackIds] });
    await refreshPlaylists();
  }

  // ═══ 传输 (透传 Manager) ══════════════════════════════

  async function playTrack(trackId: string): Promise<void> {
    await manager.playTrack(trackId);
  }

  async function playPlaylist(playlistId: string, startIndex = 0): Promise<void> {
    useSettingsStore().settings.audioLastPlaylistId = playlistId;
    await manager.playPlaylist(playlistId, startIndex);
  }

  /** 按名字播放曲目；找不到返回 false，**不动当前播放** */
  async function playTrackByName(name: string): Promise<boolean> {
    const t = findTrackByName(name);
    if (!t) return false;
    await playTrack(t.id);
    return true;
  }

  /** 按名字播放播放列表；找不到返回 false，**不动当前播放** */
  async function playPlaylistByName(name: string, startIndex = 0): Promise<boolean> {
    const p = findPlaylistByName(name);
    if (!p) return false;
    await playPlaylist(p.id, startIndex);
    return true;
  }

  async function play(): Promise<void> {
    await manager.play();
  }
  function pause(): void {
    manager.pause();
  }
  async function toggle(): Promise<void> {
    await manager.toggle();
  }
  function stop(): void {
    manager.stop();
  }
  async function next(): Promise<void> {
    await manager.next();
  }
  async function prev(): Promise<void> {
    await manager.prev();
  }
  function seek(sec: number): void {
    manager.seek(sec);
    positionSec.value = manager.positionSec;
  }

  async function playSfx(trackId: string): Promise<boolean> {
    return manager.playSfx(trackId);
  }
  function stopAllSfx(): void {
    manager.stopAllSfx();
  }

  /** 🔮 AI 钩子透传 (§8)；v1 无调用方 */
  async function playByTag(tag: string, fallback: 'keep' | 'stop' = 'keep'): Promise<boolean> {
    return manager.playByTag(tag, { fallback });
  }

  /**
   * 按场景选曲并播放：地点 / 人物 / 情绪 / 情境四个维度**加权累计**，总分最高者胜出。
   *
   * 同一首曲子已在播时**不重来一遍** —— 场景里换个动作、翻个面板都会重复调到
   * 这里，每次都从头播会让 BGM 变成一段永远放不完的开头。
   *
   * 未命中返回 null 并**保持当前播放**（对齐 playByTag 的 keep 语义）:
   * 换场景时突然静音，比继续放着上一场的曲子更突兀。
   */
  async function playByScene(query: SceneTagQuery): Promise<SceneTagResult | null> {
    const hit = resolveSceneByTags(tracks.value, query);
    if (!hit) return null;
    const m = state.value.music;
    // status !== 'idle' 包含 paused: 用户手动暂停后，场景变化不该把音乐顶回来
    if (m.trackId === hit.track.id && m.status !== 'idle') return hit;
    await playTrack(hit.track.id);
    return hit;
  }

  /** 只给地点的便捷入口；与 playByScene 是同一套累计打分，不是另一种语义 */
  async function playByLocation(
    location: string,
    opts: { variant?: SceneVariant } = {},
  ): Promise<SceneTagResult | null> {
    return playByScene({ location, variant: opts.variant });
  }

  function setRepeat(mode: AudioRepeatMode): void {
    manager.setRepeat(mode);
    useSettingsStore().settings.audioRepeat = mode;
  }

  function setShuffle(on: boolean): void {
    manager.setShuffle(on);
    useSettingsStore().settings.audioShuffle = on;
  }

  async function unlock(): Promise<void> {
    await manager.unlock();
  }

  // ═══ 混音 (持久化到 settings, A5) ═════════════════════

  function setMasterVolume(v: number): void {
    manager.setMasterVolume(v);
    useSettingsStore().settings.audioMasterVolume = manager.masterVolume;
  }

  function setMasterMuted(m: boolean): void {
    manager.setMasterMuted(m);
    useSettingsStore().settings.audioMasterMuted = m;
  }

  function setChannelVolume(ch: 'music' | 'sfx', v: number): void {
    manager.setChannelVolume(ch, v);
    const s = useSettingsStore().settings;
    if (ch === 'music') s.audioMusicVolume = manager.state.music.volume;
    else s.audioSfxVolume = manager.state.sfx.volume;
  }

  function setChannelMuted(ch: 'music' | 'sfx', m: boolean): void {
    manager.setChannelMuted(ch, m);
    const s = useSettingsStore().settings;
    if (ch === 'music') s.audioMusicMuted = m;
    else s.audioSfxMuted = m;
  }

  // ═══ 位置轮询 (§6.3) ══════════════════════════════════
  // 引用计数：两个进度条同时挂载时不互相掐；没人看时不跑定时器。

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollRefs = 0;

  function startPositionPolling(): void {
    pollRefs += 1;
    if (pollTimer) return;
    positionSec.value = manager.positionSec;
    pollTimer = setInterval(() => {
      positionSec.value = manager.positionSec;
    }, POSITION_POLL_MS);
  }

  function stopPositionPolling(force = false): void {
    pollRefs = force ? 0 : Math.max(0, pollRefs - 1);
    if (pollRefs === 0 && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    // state
    state,
    tracks,
    playlists,
    builtinTracks,
    loading,
    positionSec,
    folderPermission,
    folderName,
    scanning,
    // lifecycle
    init,
    dispose,
    loadLibrary,
    loadManifest,
    refreshTracks,
    refreshPlaylists,
    restoreSettings,
    // library
    uploadFiles,
    findTrack,
    findTrackByName,
    findPlaylistByName,
    renameTrack,
    setTrackTags,
    setTrackKind,
    deleteTrack,
    deleteTracks,
    findPlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    addTracksToPlaylist,
    removeTrackFromPlaylist,
    reorderPlaylist,
    // folder
    loadBlob,
    pickFolder,
    grantFolderPermission,
    rescanFolder,
    forgetFolder,
    // transport
    playTrack,
    playPlaylist,
    playTrackByName,
    playPlaylistByName,
    play,
    pause,
    toggle,
    stop,
    next,
    prev,
    seek,
    playSfx,
    stopAllSfx,
    playByTag,
    playByScene,
    playByLocation,
    setRepeat,
    setShuffle,
    unlock,
    // mixing
    setMasterVolume,
    setMasterMuted,
    setChannelVolume,
    setChannelMuted,
    // position
    startPositionPolling,
    stopPositionPolling,
  };
});
