/**
 * types-audio.ts — 音频子系统的**接口与类型**集中定义 (Phase Audio)
 *
 * 装什么:
 * - 浏览器 API 的注入 seam 接口 (AudioContextLike / AudioElementLike / ...) —— vitest
 *   environment:'node' 下没有 AudioContext / Audio，注入是测试套件存在的前提 (设计 §1/§4.6)
 * - 两个声道与 Manager 的 state / options 形状
 * - 声道对外索取的回调函数类型 (ResolveTrackFn / LoadBlobFn)
 *
 * 为什么与 types.ts 分开:
 * `types.ts` 是唯一类型来源，但它已逾 800 行；CLAUDE.md「设计约定」明确允许**大型联合类型
 * 拆分为 `types-*.ts`**。本文件即该拆分的音频分册，由 `types.ts` 统一 `export *` 再导出 ——
 * 「唯一类型来源」这条 import 路径依然成立。
 *
 * 边界:
 * - 音频的**数据模型类型** (AudioTrack / AudioPlaylist / AudioBlobRecord / AudioHandleRecord /
 *   AudioSourceKind / AudioTrackKind / AudioRepeatMode / AudioPlaybackState) 住在 `types.ts`，
 *   **不搬进来** —— 那会制造第二个真相来源。本文件按需从 types.ts 反向 import。
 * - 运行时常量 (SFX_DEFAULT_* / AUDIO_DEFAULT_FADE_MS) 与函数留在实现文件里 ——
 *   它们是实现细节，不是类型。
 */

import type { AudioTrack, AudioRepeatMode } from './types';

// ═══════════════════════════════════════════════════════════
// 注入 seam 接口 (§4.6)
// 刻意做到最小 —— 只声明实际用到的成员。
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

/**
 * MusicChannel 监听的元素事件。
 * `ended` 驱动队列推进；另两个刷新 `durationSec` —— 它是**离散状态镜像**，
 * 暂停态换曲后也必须重新广播，否则进度条要等恢复播放才正常 (§6.3)。
 */
export type AudioElementEvent = 'ended' | 'loadedmetadata' | 'durationchange';

/** HTMLAudioElement 的最小面 */
export interface AudioElementLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: AudioElementEvent, listener: () => void): void;
  removeEventListener(type: AudioElementEvent, listener: () => void): void;
}

/**
 * Manager 需要的 AudioContext 面比声道更宽一点:
 * 它要 `destination` 接 master gain，要 `resume()` 解锁，要 `close()` 释放。
 */
export interface ManagerAudioContextLike extends AudioContextLike {
  readonly destination: AudioNodeLike;
  resume(): Promise<void>;
  close?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════
// 回调 seam
// ═══════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════
// AudioManager — 门面
// ═══════════════════════════════════════════════════════════

export type ChannelName = 'music' | 'sfx';

/** playByTag 未命中时的处置 —— 默认 keep: 场景中途绝不切到静音 (§8) */
export type AudioTagFallback = 'keep' | 'stop';

export interface AudioManagerOptions {
  /** AudioContext 工厂；environment:'node' 下必须注入 */
  createContext?: () => ManagerAudioContextLike;
  /** 流式播放元素工厂；environment:'node' 下必须注入 */
  createElement?: () => AudioElementLike;
  /** Blob → URL */
  createObjectURL?: (blob: Blob) => string;
  /** URL 回收 */
  revokeObjectURL?: (url: string) => void;
  /** shuffle / playByTag 多命中的随机源，注入以求确定性 */
  random?: () => number;
  /** 换曲淡入淡出时长；测试用 0，UI 用 300 */
  fadeMs?: number;
  /** 存储 seam —— 音频字节读取 */
  loadBlob?: LoadBlobFn;
}
