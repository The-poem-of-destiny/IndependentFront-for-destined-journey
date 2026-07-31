/**
 * audio-manager.ts — 音频引擎门面 (Phase Audio)
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §4.1 / §4.5 / §4.6 / §6.3 / §7 / §8
 *
 * 职责边界:
 * - **曲库注册表**: 曲目/播放列表住在这里，声道只拿到 resolveTrack / loadBlob 两个回调
 * - **master gain**: master → destination；两个声道的 gain 接到 master 上 (§4.1)
 * - **解锁**: AudioContext 出生即 suspended，首次用户手势 resume()；锁定期的播放请求
 *   记为 pending，解锁后自动兑现，**永不抛出** (§7)
 * - **AI 钩子**: playByTag —— v1 实现并测试，无调用方 (§8)
 *
 * 关键约束:
 * - Manager **永不碰数据库** —— CRUD 属于 database.ts，Manager 只消费内存数组 (§4.5)
 * - `positionSec` 是按需采样的 getter，**永不进入 AudioPlaybackState、永不广播** (§6.3)
 * - 浏览器 API 默认值**惰性引用** —— 仅 import 本模块不得触碰 AudioContext / Audio
 * - 本文件**不导出单例** —— 单例归 UI 层；模块级实例会在 import 期造 AudioContext，
 *   把整个引擎测试套件炸掉
 */

import { MusicChannel, SfxChannel, clamp01 } from './audio-channels';
import type {
  AudioElementLike,
  AudioGainLike,
  AudioManagerOptions,
  AudioTagFallback,
  ChannelName,
  LoadBlobFn,
  ManagerAudioContextLike,
} from './types-audio';
import type { AudioPlaybackState, AudioPlaylist, AudioRepeatMode, AudioTrack } from './types';

// ═══════════════════════════════════════════════════════════
// 类型再导出 (§4.6)
// 定义已收拢到 types-audio.ts；此处按原样 re-export，历史 import 路径保持不变。
// ═══════════════════════════════════════════════════════════

export type {
  ManagerAudioContextLike,
  ChannelName,
  AudioTagFallback,
  AudioManagerOptions,
} from './types-audio';

/** UI 用的默认淡入淡出时长 (§4.2) */
export const AUDIO_DEFAULT_FADE_MS = 300;

/** 惰性引用全局构造器 —— 顶层绝不触碰，否则 node 下 import 即崩 */
function defaultCreateContext(): ManagerAudioContextLike {
  const g = globalThis as unknown as Record<string, unknown>;
  const Ctor = (g.AudioContext ?? g.webkitAudioContext) as
    (new () => ManagerAudioContextLike) | undefined;
  if (!Ctor) throw new Error('AudioContext 不可用：请通过 createContext 注入');
  return new Ctor();
}

function defaultCreateElement(): AudioElementLike {
  const g = globalThis as unknown as Record<string, unknown>;
  const Ctor = g.Audio as (new () => AudioElementLike) | undefined;
  if (!Ctor) throw new Error('Audio 不可用：请通过 createElement 注入');
  return new Ctor();
}

/** 锁定期暂存的播放请求 (§7) */
interface PendingRequest {
  kind: 'track' | 'playlist' | 'resume';
  trackId?: string;
  playlistId?: string;
  startIndex?: number;
}

// ═══════════════════════════════════════════════════════════
// AudioManager
// ═══════════════════════════════════════════════════════════

export class AudioManager {
  private readonly ctx: ManagerAudioContextLike;
  private readonly masterGain: AudioGainLike;
  private readonly music: MusicChannel;
  private readonly sfx: SfxChannel;
  private readonly random: () => number;

  private tracks = new Map<string, AudioTrack>();
  private playlists = new Map<string, AudioPlaylist>();

  private _masterVolume = 1;
  private _masterMuted = false;
  private _unlocked = false;
  private pending: PendingRequest | null = null;
  private disposed = false;

  private readonly subscribers = new Set<(s: AudioPlaybackState) => void>();

  constructor(opts: AudioManagerOptions = {}) {
    this.ctx = (opts.createContext ?? defaultCreateContext)();
    this.random = opts.random ?? Math.random;

    // master gain → destination (§4.1)
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this._masterVolume;
    this.masterGain.connect(this.ctx.destination);

    const resolveTrack = (id: string): AudioTrack | undefined => this.tracks.get(id);
    const loadBlob: LoadBlobFn = opts.loadBlob ?? (async () => undefined);
    const onChange = (): void => {
      this.emit();
    };

    this.music = new MusicChannel({
      context: this.ctx,
      destination: this.masterGain,
      element: (opts.createElement ?? defaultCreateElement)(),
      resolveTrack,
      loadBlob,
      createObjectURL: opts.createObjectURL,
      revokeObjectURL: opts.revokeObjectURL,
      random: this.random,
      fadeMs: opts.fadeMs ?? AUDIO_DEFAULT_FADE_MS,
      onChange,
    });

    this.sfx = new SfxChannel({
      context: this.ctx,
      destination: this.masterGain,
      resolveTrack,
      loadBlob,
      onChange,
    });
  }

  // ── 曲库注册表 (§4.5) ───────────────────────────────────

  /** 灌入曲目全集。被删掉的曲目会从音乐队列剔除；当前曲被删则停止 */
  setTracks(tracks: AudioTrack[]): void {
    this.tracks = new Map(tracks.map((t) => [t.id, t]));
    if (this.pending?.trackId !== undefined && !this.tracks.has(this.pending.trackId)) {
      this.pending = null;
    }
    this.music.pruneTracks(new Set(this.tracks.keys()));
    this.emit();
  }

  setPlaylists(lists: AudioPlaylist[]): void {
    this.playlists = new Map(lists.map((p) => [p.id, p]));
    this.emit();
  }

  getTrack(id: string): AudioTrack | undefined {
    return this.tracks.get(id);
  }

  getPlaylist(id: string): AudioPlaylist | undefined {
    return this.playlists.get(id);
  }

  // ── 音乐传输 (委派 MusicChannel) ────────────────────────

  async playTrack(trackId: string): Promise<void> {
    if (this.disposed) return;
    if (!this._unlocked) {
      this.pending = { kind: 'track', trackId };
      this.emit();
      return;
    }
    await this.music.playTrack(trackId);
  }

  async playPlaylist(playlistId: string, startIndex = 0): Promise<void> {
    if (this.disposed) return;
    if (!this._unlocked) {
      this.pending = { kind: 'playlist', playlistId, startIndex };
      this.emit();
      return;
    }
    const list = this.playlists.get(playlistId);
    // 曲库里已不存在的 id 直接滤掉 —— 播放列表可能残留悬挂引用
    const ids = (list?.trackIds ?? []).filter((id) => this.tracks.has(id));
    await this.music.playPlaylist(playlistId, ids, startIndex);
  }

  async play(): Promise<void> {
    if (this.disposed) return;
    if (!this._unlocked) {
      this.pending = { kind: 'resume' };
      this.emit();
      return;
    }
    await this.music.play();
  }

  pause(): void {
    if (this.disposed) return;
    this.music.pause();
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.music.state.status === 'playing') this.music.pause();
    else await this.play();
  }

  stop(): void {
    if (this.disposed) return;
    this.pending = null;
    this.music.stop();
  }

  async next(): Promise<void> {
    if (this.disposed) return;
    await this.music.next();
  }

  async prev(): Promise<void> {
    if (this.disposed) return;
    await this.music.prev();
  }

  seek(sec: number): void {
    if (this.disposed) return;
    this.music.seek(sec);
  }

  setRepeat(mode: AudioRepeatMode): void {
    this.music.setRepeat(mode);
  }

  setShuffle(on: boolean): void {
    this.music.setShuffle(on);
  }

  // ── SFX (委派 SfxChannel) ───────────────────────────────

  /** 返回 false: 未解锁 / 曲目不存在 / 护栏拒绝 / decode 拥塞 */
  async playSfx(trackId: string): Promise<boolean> {
    if (this.disposed || !this._unlocked) return false;
    return this.sfx.play(trackId);
  }

  stopAllSfx(): void {
    this.sfx.stopAll();
  }

  // ── 混音 (§4.1) ─────────────────────────────────────────

  /** master 与 channel 音量互相独立；静音**不破坏** volume 数值 */
  setMasterVolume(v: number): void {
    this._masterVolume = clamp01(v);
    this.applyMasterGain();
    this.emit();
  }

  setMasterMuted(m: boolean): void {
    this._masterMuted = m;
    this.applyMasterGain();
    this.emit();
  }

  setChannelVolume(ch: ChannelName, v: number): void {
    if (ch === 'music') this.music.setVolume(v);
    else this.sfx.setVolume(v);
  }

  setChannelMuted(ch: ChannelName, m: boolean): void {
    if (ch === 'music') this.music.setMuted(m);
    else this.sfx.setMuted(m);
  }

  get masterVolume(): number {
    return this._masterVolume;
  }
  get masterMuted(): boolean {
    return this._masterMuted;
  }

  // ── 解锁 (§7) ───────────────────────────────────────────

  get unlocked(): boolean {
    return this._unlocked;
  }

  /** 锁定期被暂存的曲目 —— UI 用它显示"点击任意处开始播放" */
  get pendingTrackId(): string | null {
    return this.pending?.trackId ?? null;
  }

  /**
   * 用户手势解锁。resume() 成功后置位并**兑现**暂存的播放请求。
   * resume() 失败时保持锁定且不抛出 —— 下一次手势再试。
   */
  async unlock(): Promise<void> {
    if (this.disposed || this._unlocked) return;
    try {
      await this.ctx.resume();
    } catch {
      return;
    }
    this._unlocked = true;
    const pending = this.pending;
    this.pending = null;
    this.emit();
    if (!pending) return;
    if (pending.kind === 'track' && pending.trackId !== undefined) {
      await this.music.playTrack(pending.trackId);
    } else if (pending.kind === 'playlist' && pending.playlistId !== undefined) {
      await this.playPlaylist(pending.playlistId, pending.startIndex ?? 0);
    } else if (pending.kind === 'resume') {
      await this.music.play();
    }
  }

  // ── 🔮 AI 钩子 (§8) ─────────────────────────────────────

  /**
   * 按场景标签播放音乐。v1 实现并测试，**无调用方** —— 日后接 marker 只需加解析，不动 schema。
   *
   * 多命中用注入的 random 挑一首；未命中时按 fallback 处置:
   * `keep`(默认) 保持当前曲继续播放，`stop` 停止。返回是否命中并播放。
   */
  async playByTag(tag: string, opts: { fallback?: AudioTagFallback } = {}): Promise<boolean> {
    if (this.disposed) return false;
    const matches: AudioTrack[] = [];
    for (const t of this.tracks.values()) {
      if (t.kind === 'music' && t.tags.includes(tag)) matches.push(t);
    }
    if (matches.length === 0) {
      if ((opts.fallback ?? 'keep') === 'stop') this.stop();
      return false;
    }
    const pick =
      matches.length === 1
        ? matches[0]
        : matches[
            Math.min(matches.length - 1, Math.max(0, Math.floor(this.random() * matches.length)))
          ];
    await this.playTrack(pick.id);
    return true;
  }

  // ── 观察 (§6.3) ─────────────────────────────────────────

  /** 离散状态快照。**不含 position** —— position 是按需采样的独立 getter */
  get state(): Readonly<AudioPlaybackState> {
    const m = this.music.state;
    const s = this.sfx.state;
    return {
      music: {
        status: m.status,
        trackId: m.trackId,
        playlistId: m.playlistId,
        index: m.index,
        durationSec: m.durationSec,
        volume: m.volume,
        muted: m.muted,
        repeat: m.repeat,
        shuffle: m.shuffle,
      },
      sfx: { volume: s.volume, muted: s.muted, liveVoices: s.liveVoices },
      masterVolume: this._masterVolume,
      masterMuted: this._masterMuted,
      unlocked: this._unlocked,
    };
  }

  /** 播放位置(秒)。按需采样，**永不广播** —— 广播它就等于把 60fps 扇出请回来了 */
  get positionSec(): number {
    return this.music.positionSec;
  }

  subscribe(fn: (s: AudioPlaybackState) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.sfx.dispose();
    // MusicChannel.dispose 内部会回收尚未释放的 object URL
    this.music.dispose();
    this.masterGain.disconnect();
    this.pending = null;
    void this.ctx.close?.();
  }

  // ── 内部 ────────────────────────────────────────────────

  private applyMasterGain(): void {
    const now = this.ctx.currentTime;
    const g = this.masterGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this._masterMuted ? 0 : this._masterVolume, now);
  }

  private emit(): void {
    if (this.disposed || this.subscribers.size === 0) return;
    const snapshot = this.state;
    for (const fn of Array.from(this.subscribers)) fn(snapshot);
  }
}
