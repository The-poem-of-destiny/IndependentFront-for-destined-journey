/**
 * audio-channels.ts — 音频引擎的两个声道类 (Phase Audio)
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §4.1 / §4.2 / §4.4 / §4.6
 *
 * 两个类刻意不共享基类 —— 一个是**序列器**(MusicChannel)，一个是**声部池**(SfxChannel)，
 * 它们只共享一个 gain 节点的概念，其余毫无共同点 (§13)。
 *
 * 关键约束:
 * - 音乐**流式播放**(MediaElementSource)，永不 decode 成 buffer (5 分钟立体声 float32 ≈ 105MB)
 * - SFX **每次播放都重新 decode，不做缓存** (§4.4)，这是刻意决定，不是疏漏
 * - 曲库住在 Manager 里，不在声道里 —— 声道只拿到 resolveTrack / loadBlob 两个回调
 * - 声道不持有 master gain —— 它把自己的 channel gain 接到构造时传入的 destination
 * - 所有浏览器 API 走注入 seam: vitest environment:'node' 下没有 AudioContext / Audio /
 *   URL.createObjectURL，注入是**测试套件存在的前提**，不是风格偏好 (§1)
 */

import type { AudioTrack, AudioRepeatMode } from './types';

// ═══════════════════════════════════════════════════════════
// 注入 seam 接口 (§4.6)
// 刻意做到最小 —— 只声明实际用到的成员。Manager 波次从本文件 import。
// ═══════════════════════════════════════════════════════════

/** Web Audio AudioParam 的最小面 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  cancelScheduledValues(startTime: number): void;
}

/** 任何可连接的音频节点 */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
  disconnect(): void;
}

/** GainNode 的最小面 */
export interface AudioGainLike extends AudioNodeLike {
  gain: AudioParamLike;
}

/** decodeAudioData 的产物；只有 duration 被引擎读取 */
export interface AudioBufferLike {
  duration: number;
}

/** AudioBufferSourceNode 的最小面 —— 一次性节点，播完即弃 */
export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

/** AudioContext 的最小面 */
export interface AudioContextLike {
  readonly currentTime: number;
  createGain(): AudioGainLike;
  createBufferSource(): AudioBufferSourceLike;
  createMediaElementSource(element: AudioElementLike): AudioNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

/** HTMLAudioElement 的最小面 */
export interface AudioElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: 'ended', listener: () => void): void;
  removeEventListener(type: 'ended', listener: () => void): void;
}

/** 曲目元数据解析回调 —— 曲库住在 Manager 里 */
export type ResolveTrackFn = (trackId: string) => AudioTrack | undefined;

/** 音频字节读取回调 —— 存储层住在 database.ts 里 */
export type LoadBlobFn = (trackId: string) => Promise<Blob | undefined>;

// ═══════════════════════════════════════════════════════════
// MusicChannel — 序列器
// ═══════════════════════════════════════════════════════════

/** MusicChannel 离散播放状态 (对齐 AudioPlaybackState['music'])，**不含 position** (§6.3) */
export interface MusicChannelState {
  status: 'idle' | 'playing' | 'paused';
  trackId: string | null;
  playlistId: string | null;
  index: number;
  queueLength: number;
  durationSec: number;
  volume: number;
  muted: boolean;
  repeat: AudioRepeatMode;
  shuffle: boolean;
}

export interface MusicChannelOptions {
  /** 共享 AudioContext */
  context: AudioContextLike;
  /** 本声道 gain 接入的目标节点 (通常是 master gain)；声道不持有 master */
  destination: AudioNodeLike;
  /** 唯一的流式播放元素 */
  element: AudioElementLike;
  /** 曲目元数据解析 */
  resolveTrack: ResolveTrackFn;
  /** 音频字节读取 (source==='blob' 时使用) */
  loadBlob: LoadBlobFn;
  /** Blob → URL；environment:'node' 下必须注入 */
  createObjectURL?: (blob: Blob) => string;
  /** URL 回收；换曲必须调用，否则泄漏 */
  revokeObjectURL?: (url: string) => void;
  /** shuffle 随机源，注入以求确定性 */
  random?: () => number;
  /** 换曲淡入淡出时长；**0 表示完全同步**(无 timer 无 await)，测试用 0，UI 用 300 */
  fadeMs?: number;
  /** 定时器 seam，仅在 fadeMs > 0 时被调用 */
  scheduleTimeout?: (fn: () => void, ms: number) => void;
  /** 离散状态变更广播；**positionSec 永不经由此回调** */
  onChange?: (state: MusicChannelState) => void;
  /** 初始音量 0..1 */
  volume?: number;
  /** 初始静音 */
  muted?: boolean;
  /** 初始循环模式 */
  repeat?: AudioRepeatMode;
  /** 初始随机模式 */
  shuffle?: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * MusicChannel —— 一个序列器。
 *
 * 持有 queue / index / repeat / shuffle 与唯一一个流式元素。音乐永远**不**被 decode。
 */
export class MusicChannel {
  private readonly ctx: AudioContextLike;
  private readonly element: AudioElementLike;
  private readonly gainNode: AudioGainLike;
  private readonly resolveTrack: ResolveTrackFn;
  private readonly loadBlob: LoadBlobFn;
  private readonly createObjectURL: (blob: Blob) => string;
  private readonly revokeObjectURL: (url: string) => void;
  private readonly random: () => number;
  private readonly fadeMs: number;
  private readonly scheduleTimeout: (fn: () => void, ms: number) => void;
  private readonly onChange?: (state: MusicChannelState) => void;

  private queue: string[] = [];
  private index = 0;
  private currentTrackId: string | null = null;
  private playlistId: string | null = null;
  private status: 'idle' | 'playing' | 'paused' = 'idle';
  private _volume: number;
  private _muted: boolean;
  private _repeat: AudioRepeatMode;
  private _shuffle: boolean;
  private objectUrl: string | null = null;
  private disposed = false;
  private readonly endedListener: () => void;

  constructor(opts: MusicChannelOptions) {
    this.ctx = opts.context;
    this.element = opts.element;
    this.resolveTrack = opts.resolveTrack;
    this.loadBlob = opts.loadBlob;
    this.createObjectURL = opts.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
    this.revokeObjectURL = opts.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u));
    this.random = opts.random ?? Math.random;
    this.fadeMs = Math.max(0, opts.fadeMs ?? 0);
    this.scheduleTimeout = opts.scheduleTimeout ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.onChange = opts.onChange;
    this._volume = clamp01(opts.volume ?? 1);
    this._muted = opts.muted ?? false;
    this._repeat = opts.repeat ?? 'off';
    this._shuffle = opts.shuffle ?? false;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this.targetGain();
    this.gainNode.connect(opts.destination);
    this.ctx.createMediaElementSource(this.element).connect(this.gainNode);

    this.endedListener = () => { void this.handleEnded(); };
    this.element.addEventListener('ended', this.endedListener);
  }

  // ── 观察 ────────────────────────────────────────────────

  /** 离散状态快照。**不含 position** —— position 是按需采样的独立 getter (§6.3) */
  get state(): Readonly<MusicChannelState> {
    return {
      status: this.status,
      trackId: this.currentTrackId,
      playlistId: this.playlistId,
      index: this.index,
      queueLength: this.queue.length,
      durationSec: this.durationSec,
      volume: this._volume,
      muted: this._muted,
      repeat: this._repeat,
      shuffle: this._shuffle,
    };
  }

  /** 播放位置(秒)。按需采样，**永不经由 onChange 广播** */
  get positionSec(): number {
    const t = this.element.currentTime;
    return Number.isFinite(t) ? t : 0;
  }

  get durationSec(): number {
    const d = this.element.duration;
    if (Number.isFinite(d) && d > 0) return d;
    const track = this.currentTrackId ? this.resolveTrack(this.currentTrackId) : undefined;
    return track?.duration ?? 0;
  }

  /** 当前队列副本 —— 外部不可变更内部数组 */
  get currentQueue(): string[] {
    return this.queue.slice();
  }

  get gain(): AudioGainLike {
    return this.gainNode;
  }

  // ── 传输控制 ────────────────────────────────────────────

  /** 单曲播放 —— 队列长度 1，playlistId 置空 */
  async playTrack(trackId: string): Promise<void> {
    this.playlistId = null;
    this.queue = [trackId];
    this.index = 0;
    await this.loadCurrent(true);
  }

  /**
   * 播放列表播放。trackIds 由 Manager 解析后传入；
   * shuffle 作用在**副本**上，调用方持有的数组永不被改动。
   */
  async playPlaylist(playlistId: string, trackIds: string[], startIndex = 0): Promise<void> {
    this.playlistId = playlistId;
    this.queue = trackIds.slice();
    if (this._shuffle) this.shuffleQueue();
    if (this.queue.length === 0) {
      this.index = 0;
      this.clearCurrent();
      this.status = 'idle';
      this.emit();
      return;
    }
    this.index = Math.min(Math.max(0, Math.floor(startIndex) || 0), this.queue.length - 1);
    await this.loadCurrent(true);
  }

  async play(): Promise<void> {
    if (this.queue.length === 0) return;
    if (this.currentTrackId === null) {
      await this.loadCurrent(true);
      return;
    }
    await this.startElement();
    this.emit();
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.element.pause();
    this.status = 'paused';
    this.emit();
  }

  async toggle(): Promise<void> {
    if (this.status === 'playing') this.pause();
    else await this.play();
  }

  /** 停止 —— 暂停并回到 0，状态 idle。队列保留，play() 可重新开始 */
  stop(): void {
    this.element.pause();
    this.element.currentTime = 0;
    this.status = 'idle';
    this.emit();
  }

  /** 下一曲。用户显式操作 —— 到队尾时总是回绕到 0 (与 ended 的 repeat 矩阵无关) */
  async next(): Promise<void> {
    if (this.queue.length === 0) return;
    this.index = this.index + 1 >= this.queue.length ? 0 : this.index + 1;
    await this.loadCurrent(this.status === 'playing' || this.status === 'idle');
  }

  /** 上一曲。位于队首时重放当前曲 */
  async prev(): Promise<void> {
    if (this.queue.length === 0) return;
    this.index = this.index - 1 < 0 ? 0 : this.index - 1;
    await this.loadCurrent(this.status === 'playing' || this.status === 'idle');
  }

  seek(sec: number): void {
    if (!Number.isFinite(sec)) return;
    this.element.currentTime = Math.max(0, sec);
  }

  // ── 模式 ────────────────────────────────────────────────

  setRepeat(mode: AudioRepeatMode): void {
    if (this._repeat === mode) return;
    this._repeat = mode;
    this.emit();
  }

  /**
   * 开关随机。仅置位 —— 重排发生在 playPlaylist 与 `all`+shuffle 的回绕点 (§4.2 矩阵)，
   * 这样切换开关不会把正在播放的曲目从脚下抽走。
   */
  setShuffle(on: boolean): void {
    if (this._shuffle === on) return;
    this._shuffle = on;
    this.emit();
  }

  // ── 混音 ────────────────────────────────────────────────

  /** 设置音量，钳制到 0..1 */
  setVolume(v: number): void {
    this._volume = clamp01(v);
    this.applyGain();
    this.emit();
  }

  /** 静音开关 —— **不破坏 volume 数值** */
  setMuted(m: boolean): void {
    this._muted = m;
    this.applyGain();
    this.emit();
  }

  get volume(): number { return this._volume; }
  get muted(): boolean { return this._muted; }

  // ── 曲库同步 ────────────────────────────────────────────

  /** 曲库里已不存在的 id 从队列剔除；若**当前曲**被剔除则停止 */
  pruneTracks(existingIds: Set<string>): void {
    const kept = this.queue.filter((id) => existingIds.has(id));
    if (kept.length === this.queue.length) return;
    const currentId = this.currentTrackId;
    const currentDropped = currentId !== null && !existingIds.has(currentId);
    this.queue = kept;
    if (currentDropped || kept.length === 0) {
      this.element.pause();
      this.element.currentTime = 0;
      this.index = 0;
      this.clearCurrent();
      this.status = 'idle';
    } else if (currentId !== null) {
      this.index = Math.max(0, kept.indexOf(currentId));
    }
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.removeEventListener('ended', this.endedListener);
    this.element.pause();
    this.clearCurrent();
    this.gainNode.disconnect();
    this.queue = [];
    this.status = 'idle';
  }

  // ── 内部 ────────────────────────────────────────────────

  private targetGain(): number {
    return this._muted ? 0 : this._volume;
  }

  private applyGain(): void {
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this.targetGain(), now);
  }

  private emit(): void {
    this.onChange?.(this.state);
  }

  private shuffleQueue(): void {
    // Fisher–Yates on the channel's own copy
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const tmp = this.queue[i];
      this.queue[i] = this.queue[j];
      this.queue[j] = tmp;
    }
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl !== null) {
      this.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private clearCurrent(): void {
    this.releaseObjectUrl();
    this.currentTrackId = null;
    this.element.src = '';
  }

  private fadeOut(): void {
    const now = this.ctx.currentTime;
    const g = this.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (this.fadeMs === 0) g.setValueAtTime(0, now);
    else g.linearRampToValueAtTime(0, now + this.fadeMs / 1000);
  }

  private fadeIn(): void {
    const now = this.ctx.currentTime;
    const g = this.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    if (this.fadeMs === 0) g.setValueAtTime(this.targetGain(), now);
    else g.linearRampToValueAtTime(this.targetGain(), now + this.fadeMs / 1000);
  }

  /** fadeMs === 0 时**完全不排定时器** —— 测试保持确定性 */
  private waitFade(): Promise<void> | null {
    if (this.fadeMs === 0) return null;
    return new Promise<void>((resolve) => { this.scheduleTimeout(resolve, this.fadeMs); });
  }

  private async startElement(): Promise<void> {
    try {
      await this.element.play();
      this.status = 'playing';
    } catch {
      // autoplay 被拦截等 —— 不抛出，落到 paused 由上层 unlock 兑现
      this.status = 'paused';
    }
  }

  private async loadCurrent(autoplay: boolean): Promise<void> {
    if (this.disposed) return;
    const id = this.queue[this.index];
    if (id === undefined) {
      this.clearCurrent();
      this.status = 'idle';
      this.emit();
      return;
    }

    this.fadeOut();
    const wait = this.waitFade();
    if (wait) await wait;

    const track = this.resolveTrack(id);
    if (!track) {
      this.clearCurrent();
      this.status = 'idle';
      this.emit();
      return;
    }

    // 换曲即回收上一段 object URL —— 泄漏防线
    this.releaseObjectUrl();

    let src: string;
    if (track.source === 'builtin') {
      src = track.url ?? '';
    } else {
      const blob = await this.loadBlob(id);
      if (!blob) {
        this.currentTrackId = null;
        this.element.src = '';
        this.status = 'idle';
        this.emit();
        return;
      }
      this.objectUrl = this.createObjectURL(blob);
      src = this.objectUrl;
    }

    this.element.src = src;
    this.element.currentTime = 0;
    this.currentTrackId = id;
    this.fadeIn();

    if (autoplay) await this.startElement();
    else this.status = 'paused';
    this.emit();
  }

  /** §4.2 推进矩阵 */
  private async handleEnded(): Promise<void> {
    if (this.disposed) return;
    if (this.queue.length === 0) {
      this.status = 'idle';
      this.emit();
      return;
    }

    if (this._repeat === 'one') {
      this.element.currentTime = 0;
      await this.startElement();
      this.emit();
      return;
    }

    if (this.index + 1 < this.queue.length) {
      this.index += 1;
      await this.loadCurrent(true);
      return;
    }

    // 队尾
    if (this._repeat === 'all') {
      if (this._shuffle) this.shuffleQueue();
      this.index = 0;
      await this.loadCurrent(true);
      return;
    }

    this.element.pause();
    this.status = 'idle';
    this.emit();
  }
}

// ═══════════════════════════════════════════════════════════
// SfxChannel — 声部池
// ═══════════════════════════════════════════════════════════

export interface SfxChannelState {
  volume: number;
  muted: boolean;
  liveVoices: number;
}

export interface SfxChannelOptions {
  context: AudioContextLike;
  destination: AudioNodeLike;
  resolveTrack: ResolveTrackFn;
  loadBlob: LoadBlobFn;
  /** 同时存活声部上限，超出则掐掉最久的那个 (默认 8) */
  maxVoices?: number;
  /** 同时在途 decode 上限，超出则**直接拒绝**并返回 false (默认 4) */
  maxConcurrentDecodes?: number;
  /** 时长护栏(秒)，与 kind 无关 —— kind 可能是错的 (默认 30) */
  maxDurationSec?: number;
  /** 体积护栏(字节)，与 kind 无关 (默认 5MB) */
  maxBytes?: number;
  onChange?: (state: SfxChannelState) => void;
  volume?: number;
  muted?: boolean;
}

interface Voice {
  id: number;
  source: AudioBufferSourceLike;
  /** 实际 start() 时刻 —— decode 可乱序完成，掐最久必须看这个而非调用序 */
  startedAt: number;
}

export const SFX_DEFAULT_MAX_VOICES = 8;
export const SFX_DEFAULT_MAX_DECODES = 4;
export const SFX_DEFAULT_MAX_DURATION_SEC = 30;
export const SFX_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * SfxChannel —— 一个声部池。
 *
 * 无队列、无 index、无 repeat。每一发: loadBlob → blob.arrayBuffer() → decodeAudioData →
 * AudioBufferSourceNode → start()。节点一次性，播完 GC，无池可复用。
 *
 * **不做 decode 缓存** (§4.4)。这是刻意决定 —— 日后加 LRU 是零接口变更的纯内部优化。
 * decodeAudioData 会 **detach** 它消费的 ArrayBuffer，所以每一发都必须重新
 * blob.arrayBuffer()，共享 buffer 会在第二次 decode 时炸掉。
 */
export class SfxChannel {
  private readonly ctx: AudioContextLike;
  private readonly gainNode: AudioGainLike;
  private readonly resolveTrack: ResolveTrackFn;
  private readonly loadBlob: LoadBlobFn;
  private readonly maxVoices: number;
  private readonly maxConcurrentDecodes: number;
  private readonly maxDurationSec: number;
  private readonly maxBytes: number;
  private readonly onChange?: (state: SfxChannelState) => void;

  private _volume: number;
  private _muted: boolean;
  private voices: Voice[] = [];
  private inFlightDecodes = 0;
  private nextVoiceId = 1;
  private disposed = false;

  constructor(opts: SfxChannelOptions) {
    this.ctx = opts.context;
    this.resolveTrack = opts.resolveTrack;
    this.loadBlob = opts.loadBlob;
    this.maxVoices = opts.maxVoices ?? SFX_DEFAULT_MAX_VOICES;
    this.maxConcurrentDecodes = opts.maxConcurrentDecodes ?? SFX_DEFAULT_MAX_DECODES;
    this.maxDurationSec = opts.maxDurationSec ?? SFX_DEFAULT_MAX_DURATION_SEC;
    this.maxBytes = opts.maxBytes ?? SFX_DEFAULT_MAX_BYTES;
    this.onChange = opts.onChange;
    this._volume = clamp01(opts.volume ?? 1);
    this._muted = opts.muted ?? false;

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = this._muted ? 0 : this._volume;
    this.gainNode.connect(opts.destination);
  }

  get state(): Readonly<SfxChannelState> {
    return { volume: this._volume, muted: this._muted, liveVoices: this.voices.length };
  }

  get liveVoices(): number { return this.voices.length; }
  get volume(): number { return this._volume; }
  get muted(): boolean { return this._muted; }
  get gain(): AudioGainLike { return this.gainNode; }
  /** 在途 decode 数 —— 供上层观测拥塞 */
  get pendingDecodes(): number { return this.inFlightDecodes; }

  /**
   * 打一发音效。
   *
   * 返回 false 的四种情形: 曲目不存在 / 护栏拒绝(超时长或超体积，**不会 decode**) /
   * decode 拥塞(在途已达上限，直接拒绝而非排队 —— 排队只会让爆发期越堆越深) /
   * 字节读不到或 decode 失败。
   */
  async play(trackId: string): Promise<boolean> {
    if (this.disposed) return false;

    const track = this.resolveTrack(trackId);
    if (!track) return false;

    // 护栏 1: 元数据层面就能拒的，连字节都不读
    if (track.duration !== undefined && track.duration > this.maxDurationSec) return false;
    if (track.size !== undefined && track.size > this.maxBytes) return false;

    if (this.inFlightDecodes >= this.maxConcurrentDecodes) return false;

    this.inFlightDecodes += 1;
    try {
      const blob = await this.loadBlob(trackId);
      if (!blob) return false;

      // 护栏 2: 真实字节体积 —— 元数据可能缺失或撒谎
      if (blob.size > this.maxBytes) return false;

      // decodeAudioData 会 detach 入参 ArrayBuffer，每发都必须重新读一份
      const bytes = await blob.arrayBuffer();
      const buffer = await this.ctx.decodeAudioData(bytes);

      // 护栏 3: decode 后才知道的真实时长
      if (buffer.duration > this.maxDurationSec) return false;

      if (this.disposed) return false;
      this.startVoice(buffer);
      return true;
    } catch {
      return false;
    } finally {
      this.inFlightDecodes -= 1;
    }
  }

  stopAll(): void {
    const live = this.voices;
    this.voices = [];
    for (const v of live) {
      v.source.onended = null;
      try { v.source.stop(); } catch { /* 已停止的节点重复 stop 会抛，忽略 */ }
      v.source.disconnect();
    }
    if (live.length > 0) this.emit();
  }

  setVolume(v: number): void {
    this._volume = clamp01(v);
    this.applyGain();
    this.emit();
  }

  /** 静音开关 —— **不破坏 volume 数值** */
  setMuted(m: boolean): void {
    this._muted = m;
    this.applyGain();
    this.emit();
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopAll();
    this.disposed = true;
    this.gainNode.disconnect();
  }

  // ── 内部 ────────────────────────────────────────────────

  private applyGain(): void {
    const now = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(now);
    this.gainNode.gain.setValueAtTime(this._muted ? 0 : this._volume, now);
  }

  private emit(): void {
    this.onChange?.(this.state);
  }

  /** 超上限时掐掉**运行最久**的那一发 —— 最新的声音才和刚发生的事最相关 */
  private evictIfNeeded(): void {
    while (this.voices.length >= this.maxVoices) {
      let oldest = 0;
      for (let i = 1; i < this.voices.length; i++) {
        const a = this.voices[i];
        const b = this.voices[oldest];
        if (a.startedAt < b.startedAt || (a.startedAt === b.startedAt && a.id < b.id)) oldest = i;
      }
      const victim = this.voices.splice(oldest, 1)[0];
      victim.source.onended = null;
      try { victim.source.stop(); } catch { /* ignore */ }
      victim.source.disconnect();
    }
  }

  private startVoice(buffer: AudioBufferLike): void {
    this.evictIfNeeded();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    const voice: Voice = { id: this.nextVoiceId++, source, startedAt: this.ctx.currentTime };
    source.onended = () => { this.retireVoice(voice.id); };
    this.voices.push(voice);
    source.start();
    this.emit();
  }

  private retireVoice(id: number): void {
    const i = this.voices.findIndex((v) => v.id === id);
    if (i < 0) return;
    const [voice] = this.voices.splice(i, 1);
    voice.source.disconnect();
    this.emit();
  }
}
