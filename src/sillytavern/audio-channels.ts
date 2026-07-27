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

import type { AudioRepeatMode } from './types';
import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
  AudioElementLike,
  AudioGainLike,
  AudioNodeLike,
  LoadBlobFn,
  MusicChannelOptions,
  MusicChannelState,
  ResolveTrackFn,
  SfxChannelOptions,
  SfxChannelState,
} from './types-audio';

// ═══════════════════════════════════════════════════════════
// 类型再导出 (§4.6)
// 注入 seam 接口与 state/options 形状已收拢到 types-audio.ts (唯一类型来源的音频分册)；
// 此处按原样 re-export，历史 import 路径保持不变 —— Manager 波次仍可从本文件 import。
// ═══════════════════════════════════════════════════════════

export type {
  AudioParamLike,
  AudioNodeLike,
  AudioGainLike,
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
  AudioElementEvent,
  AudioElementLike,
  ResolveTrackFn,
  LoadBlobFn,
  MusicChannelState,
  MusicChannelOptions,
  SfxChannelState,
  SfxChannelOptions,
} from './types-audio';

// ═══════════════════════════════════════════════════════════
// MusicChannel — 序列器
// ═══════════════════════════════════════════════════════════

/**
 * 音量归一化 —— 钳制到 0..1，NaN/Infinity 一律落到 0。
 * 音频子系统内唯一一份实现，AudioManager 的 master 音量也复用它
 * (`validate.ts` 的 `clamp` 不处理非有限值，不能替代)。
 */
export function clamp01(v: number): number {
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
  /**
   * 加载世代号。每次 loadCurrent 入口自增并被本次加载捕获；加载链路上**每个 await 之后**
   * 都比对一次，对不上就立刻收手 —— 换曲/停止不能被在飞的旧加载在稍后覆盖或"补出声"。
   */
  private loadGeneration = 0;
  /** 上次广播出去的 durationSec —— 元素报同一个值时不重复扇出 */
  private lastDurationSec = -1;
  /** 在飞加载的目标曲目 id；null 表示当前没有加载在途 */
  private pendingLoadTrackId: string | null = null;
  /** 选中曲目尚未真正装进元素 —— pause 掐掉在飞加载后置位，下次 play() 必须重新加载 */
  private needsReload = false;
  private readonly endedListener: () => void;
  private readonly durationListener: () => void;

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

    // 监听器只在构造时绑一次、dispose 时解一次 —— 换曲不重绑，绝不累积
    this.durationListener = () => { this.handleDurationChange(); };
    this.element.addEventListener('loadedmetadata', this.durationListener);
    this.element.addEventListener('durationchange', this.durationListener);
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
    // needsReload: 选中曲目还没装进元素(pause 掐掉了它的加载)，必须重新走一遍加载
    if (this.currentTrackId === null || this.needsReload) {
      await this.loadCurrent(true);
      return;
    }
    // 捕获当前世代 —— element.play() 期间被 stop()/换曲打断时不得把 status 写回 playing
    const gen = this.loadGeneration;
    await this.startElement(gen);
    if (this.isStale(gen)) return;
    this.emit();
  }

  /**
   * 暂停。加载期间被调用时同样作废在飞加载 —— 否则加载完成后会自顾自地出声，
   * 从用户视角这和"停止后又响起来"是同一个 bug。
   *
   * 与 stop() 的语义差别: stop 丢弃当前曲目与播放位置，pause **保留选中曲目** ——
   * 落到"已选中这首、但未装进元素"的暂停态，随后 play() 会把它重新加载起来。
   */
  pause(): void {
    const loadingId = this.pendingLoadTrackId;
    if (this.status !== 'playing' && loadingId === null) return;
    if (loadingId !== null) {
      this.invalidateLoad();
      this.currentTrackId = loadingId;
      this.needsReload = true;
    }
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
    // 在飞的加载必须作废，否则它会在稍后自顾自地出声
    this.invalidateLoad();
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
      this.invalidateLoad();
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
    this.invalidateLoad();
    this.element.removeEventListener('ended', this.endedListener);
    this.element.removeEventListener('loadedmetadata', this.durationListener);
    this.element.removeEventListener('durationchange', this.durationListener);
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

  /**
   * 作废在飞的加载并返回新世代号。
   * 任何会更换当前曲目或停止播放的入口都要经过它: loadCurrent(即 playTrack /
   * playPlaylist / next / prev / handleEnded) / stop / pruneTracks 掉当前曲。
   */
  private invalidateLoad(): number {
    this.loadGeneration += 1;
    this.pendingLoadTrackId = null;
    return this.loadGeneration;
  }

  /** 本次加载是否已被后来者(或 dispose)作废 —— 每个 await 之后都要问一次 */
  private isStale(gen: number): boolean {
    return this.disposed || gen !== this.loadGeneration;
  }

  /**
   * 元素报出时长时刷新离散状态 (§6.3)。
   * 暂停态换曲**不会**自动播放，没有这条通路 durationSec 会一直停在旧值/0。
   * 注意只有 durationSec 走广播 —— positionSec 依旧是按需 getter，广播它等于把
   * 高频扇出请回来。
   */
  private handleDurationChange(): void {
    if (this.disposed) return;
    const d = this.durationSec;
    if (d === this.lastDurationSec) return;
    this.lastDurationSec = d;
    this.emit();
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
    this.lastDurationSec = -1;
    this.needsReload = false;
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

  /** gen 失效时收手 —— 加载/恢复期间被 stop() 打断的元素不得在稍后出声 */
  private async startElement(gen: number): Promise<void> {
    try {
      await this.element.play();
      if (this.isStale(gen)) {
        this.element.pause();
        return;
      }
      this.status = 'playing';
    } catch {
      // autoplay 被拦截等 —— 不抛出，落到 paused 由上层 unlock 兑现
      if (this.isStale(gen)) return;
      this.status = 'paused';
    }
  }

  /**
   * 加载并（可选）播放当前索引指向的曲目。
   *
   * 全程受世代号看护: 淡出等待、字节读取、element.play() 三处 await 之后各校验一次，
   * 失效即刻返回 —— **不写任何状态**，并回收本次自己造出来的 object URL。
   * 上一段 URL 的回收刻意推迟到提交那一刻: 中途作废时旧 URL 仍是元素正在用的那个。
   */
  private async loadCurrent(autoplay: boolean): Promise<void> {
    if (this.disposed) return;
    const gen = this.invalidateLoad();
    this.needsReload = false;
    const id = this.queue[this.index];
    if (id === undefined) {
      this.pendingLoadTrackId = null;
      this.clearCurrent();
      this.status = 'idle';
      this.emit();
      return;
    }
    // 在飞标记 —— pause() 靠它判断"有加载在途"，并据此保留选中曲目
    this.pendingLoadTrackId = id;

    this.fadeOut();
    const wait = this.waitFade();
    if (wait) {
      await wait;
      if (this.isStale(gen)) return; // 尚未造出任何资源，直接收手
    }

    const track = this.resolveTrack(id);
    if (!track) {
      this.pendingLoadTrackId = null;
      this.clearCurrent();
      this.status = 'idle';
      this.emit();
      return;
    }

    let createdUrl: string | null = null;
    let src: string;
    if (track.source === 'builtin') {
      src = track.url ?? '';
    } else {
      const blob = await this.loadBlob(id);
      if (this.isStale(gen)) return; // 已解析的 blob 引用直接丢弃
      if (!blob) {
        this.pendingLoadTrackId = null;
        this.clearCurrent();
        this.status = 'idle';
        this.emit();
        return;
      }
      createdUrl = this.createObjectURL(blob);
      if (this.isStale(gen)) {
        // 兜底: 作废发生在造 URL 的同一拍时也不留垃圾
        this.revokeObjectURL(createdUrl);
        return;
      }
      src = createdUrl;
    }

    // 提交点 —— 到这一步才回收上一段 object URL (泄漏防线)
    this.releaseObjectUrl();
    this.objectUrl = createdUrl;
    this.element.src = src;
    this.element.currentTime = 0;
    this.currentTrackId = id;
    this.lastDurationSec = this.durationSec;
    this.fadeIn();

    if (autoplay) {
      // 标记留到 startElement 之后才清 —— play() 期间按暂停同样要能掐住
      await this.startElement(gen);
      if (this.isStale(gen)) return;
    } else {
      this.status = 'paused';
    }
    this.pendingLoadTrackId = null;
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
      const gen = this.loadGeneration;
      await this.startElement(gen);
      if (this.isStale(gen)) return;
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

/** 内部声部记账结构 —— 不属于对外形状，故留在实现文件里 */
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
