/**
 * audio-fakes.ts — 音频引擎共享测试替身
 *
 * vitest 的 environment 是 `node`: 没有 AudioContext、没有 Audio、没有 URL.createObjectURL。
 * 本文件提供全部注入 seam 的假实现，供 audio-channels.test.ts 与后续 audio-manager.test.ts
 * 共用。风格对齐 src/ui/lib/test-fixtures.ts。
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §4.6 / §9
 */

import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioContextLike,
  AudioElementEvent,
  AudioElementLike,
  AudioGainLike,
  AudioNodeLike,
  AudioParamLike,
} from './audio-channels';
import type { AudioTrack, AudioTrackKind } from './types';

// ═══════════════════════════════════════════════════════════
// Gain / Param
// ═══════════════════════════════════════════════════════════

/** 一次 gain 参数操作的记录 —— 测试用它断言淡入淡出 */
export interface GainOp {
  type: 'set' | 'ramp' | 'cancel';
  value: number;
  time: number;
}

export class FakeAudioParam implements AudioParamLike {
  value = 1;
  readonly ops: GainOp[] = [];

  setValueAtTime(value: number, startTime: number): void {
    this.ops.push({ type: 'set', value, time: startTime });
    this.value = value;
  }

  linearRampToValueAtTime(value: number, endTime: number): void {
    this.ops.push({ type: 'ramp', value, time: endTime });
    // 假实现立即落到目标值 —— 测试关心的是"排了什么"，不是模拟音频时钟插值
    this.value = value;
  }

  cancelScheduledValues(startTime: number): void {
    this.ops.push({ type: 'cancel', value: this.value, time: startTime });
  }

  /** 只保留 set/ramp，过滤掉 cancel 噪音 */
  get valueOps(): GainOp[] {
    return this.ops.filter((o) => o.type !== 'cancel');
  }
}

export class FakeGainNode implements AudioGainLike {
  readonly gain = new FakeAudioParam();
  readonly connectedTo: AudioNodeLike[] = [];
  disconnectCount = 0;

  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination);
  }

  disconnect(): void {
    this.disconnectCount += 1;
  }
}

export class FakeAudioNode implements AudioNodeLike {
  readonly connectedTo: AudioNodeLike[] = [];
  disconnectCount = 0;
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination);
  }
  disconnect(): void {
    this.disconnectCount += 1;
  }
}

// ═══════════════════════════════════════════════════════════
// BufferSource
// ═══════════════════════════════════════════════════════════

export class FakeBufferSource implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  readonly connectedTo: AudioNodeLike[] = [];
  started = false;
  stopped = false;
  disconnectCount = 0;

  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination);
  }
  disconnect(): void {
    this.disconnectCount += 1;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }

  /** 测试手动触发自然播放结束 */
  fireEnded(): void {
    this.onended?.();
  }
}

// ═══════════════════════════════════════════════════════════
// AudioContext
// ═══════════════════════════════════════════════════════════

interface PendingDecode {
  byteLength: number;
  resolve: (buffer: AudioBufferLike) => void;
  reject: (err: unknown) => void;
}

export interface FakeAudioContextOptions {
  /** decode 结果的默认时长(秒) */
  decodedDuration?: number;
  /** true 时 decodeAudioData 挂起，由测试调用 resolveDecode/rejectDecode 决定完成顺序 */
  deferDecodes?: boolean;
}

/**
 * 假 AudioContext。
 * - `currentTime` 可写 —— 测试推进时钟以区分"运行最久"的声部
 * - `gains` 保存所有创建过的 gain 节点，ramp 记录可检视
 * - `deferDecodes` 让 decode **乱序完成**成为可测场景
 */
export class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly bufferSources: FakeBufferSource[] = [];
  readonly mediaSources: FakeAudioNode[] = [];
  readonly pendingDecodes: PendingDecode[] = [];
  /** 每次 decodeAudioData 收到的 ArrayBuffer 字节长度，按调用序 */
  readonly decodeCalls: number[] = [];
  decodedDuration: number;
  deferDecodes: boolean;

  constructor(opts: FakeAudioContextOptions = {}) {
    this.decodedDuration = opts.decodedDuration ?? 1;
    this.deferDecodes = opts.deferDecodes ?? false;
  }

  createGain(): AudioGainLike {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g;
  }

  createBufferSource(): AudioBufferSourceLike {
    const s = new FakeBufferSource();
    this.bufferSources.push(s);
    return s;
  }

  createMediaElementSource(_element: AudioElementLike): AudioNodeLike {
    const n = new FakeAudioNode();
    this.mediaSources.push(n);
    return n;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    this.decodeCalls.push(data.byteLength);
    if (!this.deferDecodes) {
      return Promise.resolve({ duration: this.decodedDuration });
    }
    return new Promise<AudioBufferLike>((resolve, reject) => {
      this.pendingDecodes.push({ byteLength: data.byteLength, resolve, reject });
    });
  }

  /** 按索引完成某个挂起的 decode —— 用来制造乱序 */
  resolveDecode(index: number, duration?: number): void {
    const p = this.pendingDecodes[index];
    if (!p) throw new Error(`no pending decode at index ${index}`);
    p.resolve({ duration: duration ?? this.decodedDuration });
  }

  rejectDecode(index: number, err: unknown = new Error('decode failed')): void {
    const p = this.pendingDecodes[index];
    if (!p) throw new Error(`no pending decode at index ${index}`);
    p.reject(err);
  }

  /** 推进音频时钟 */
  advance(sec: number): void {
    this.currentTime += sec;
  }
}

// ═══════════════════════════════════════════════════════════
// HTMLAudioElement
// ═══════════════════════════════════════════════════════════

/**
 * 假 audio 元素。测试通过 `fireEnded()` 手动触发曲目播放完毕，
 * 通过 `emitMetadata(sec)` 模拟浏览器解析出时长。
 * 监听器**按事件类型分桶**，`listenerCountFor` 可断言解绑与绑定成对。
 * `playRejection` 用于模拟 autoplay 被浏览器拦截。
 */
export class FakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  playCount = 0;
  pauseCount = 0;
  /** 所有被赋过的 src，按序 */
  readonly srcHistory: string[] = [];
  playRejection: unknown = null;

  private readonly listeners = new Map<AudioElementEvent, Array<() => void>>();

  play(): Promise<void> {
    this.playCount += 1;
    if (this.playRejection !== null) return Promise.reject(this.playRejection);
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  addEventListener(type: AudioElementEvent, listener: () => void): void {
    const bucket = this.listeners.get(type);
    if (bucket) bucket.push(listener);
    else this.listeners.set(type, [listener]);
  }

  removeEventListener(type: AudioElementEvent, listener: () => void): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    this.listeners.set(
      type,
      bucket.filter((l) => l !== listener),
    );
  }

  /** 手动触发 ended 事件 */
  fireEnded(): void {
    this.fire('ended');
  }

  fireLoadedMetadata(): void {
    this.fire('loadedmetadata');
  }

  fireDurationChange(): void {
    this.fire('durationchange');
  }

  /** 设定时长并触发 loadedmetadata —— 模拟浏览器解析出元数据 */
  emitMetadata(durationSec: number): void {
    this.duration = durationSec;
    this.fire('loadedmetadata');
  }

  /** 全部事件类型的监听器总数 */
  get listenerCount(): number {
    let n = 0;
    for (const bucket of this.listeners.values()) n += bucket.length;
    return n;
  }

  /** 单一事件类型的监听器数 —— 断言"绑几个解几个" */
  listenerCountFor(type: AudioElementEvent): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  private fire(type: AudioElementEvent): void {
    for (const l of (this.listeners.get(type) ?? []).slice()) l();
  }
}

/** src 被赋值时同步记入 srcHistory —— 用 Proxy 免去改写 setter 的样板 */
export function createFakeAudioElement(): FakeAudioElement {
  const el = new FakeAudioElement();
  return new Proxy(el, {
    set(target, prop, value) {
      if (prop === 'src') target.srcHistory.push(String(value));
      return Reflect.set(target, prop, value);
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Blob / objectURL / timers
// ═══════════════════════════════════════════════════════════

/** 假 Blob —— 记录 arrayBuffer() 读取次数，用来断言"每发一次新读取" */
export class FakeBlob {
  readonly type: string;
  arrayBufferCalls = 0;

  constructor(
    public readonly size: number,
    type = 'audio/mpeg',
  ) {
    this.type = type;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    this.arrayBufferCalls += 1;
    // 每次返回**全新**的 ArrayBuffer —— 真实 decodeAudioData 会 detach 入参
    return Promise.resolve(new ArrayBuffer(this.size));
  }
}

export function makeFakeBlob(size = 1024, type = 'audio/mpeg'): FakeBlob {
  return new FakeBlob(size, type);
}

/** FakeBlob 断言用的取回；引擎签名要 Blob，这里做一次受控转换 */
export function asBlob(b: FakeBlob): Blob {
  return b as unknown as Blob;
}

export interface FakeObjectUrls {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** 创建过的全部 URL，按序 */
  created: string[];
  /** 回收过的全部 URL，按序 */
  revoked: string[];
  /** 尚未回收的 URL —— 泄漏断言 */
  readonly live: string[];
}

export function createFakeObjectUrls(prefix = 'blob:fake/'): FakeObjectUrls {
  const created: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  return {
    created,
    revoked,
    get live() {
      return created.filter((u) => !revoked.includes(u));
    },
    createObjectURL: (_blob: Blob) => {
      const url = `${prefix}${n++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  };
}

export interface FakeTimers {
  schedule: (fn: () => void, ms: number) => void;
  /** 每次排定的延迟毫秒数 */
  readonly delays: number[];
  /** 立即执行全部排定的回调 */
  flush: () => void;
}

export function createFakeTimers(): FakeTimers {
  const queue: Array<() => void> = [];
  const delays: number[] = [];
  return {
    delays,
    schedule: (fn, ms) => {
      delays.push(ms);
      queue.push(fn);
    },
    flush: () => {
      while (queue.length > 0) {
        const fn = queue.shift();
        fn?.();
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════
// 曲库替身
// ═══════════════════════════════════════════════════════════

export function makeTrack(id: string, overrides: Partial<AudioTrack> = {}): AudioTrack {
  const kind: AudioTrackKind = overrides.kind ?? 'music';
  return {
    id,
    name: overrides.name ?? `曲目 ${id}`,
    kind,
    source: overrides.source ?? 'blob',
    url: overrides.url,
    mimeType: overrides.mimeType ?? 'audio/mpeg',
    size: overrides.size,
    duration: overrides.duration,
    tags: overrides.tags ?? [],
    builtin: overrides.builtin,
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
  };
}

/** 一次挂起中的 loadBlob —— `deferLoads` 打开后由测试决定完成顺序 */
export interface PendingLoad {
  trackId: string;
  resolve: () => void;
}

export interface FakeLibrary {
  tracks: Map<string, AudioTrack>;
  blobs: Map<string, FakeBlob>;
  resolveTrack: (id: string) => AudioTrack | undefined;
  loadBlob: (id: string) => Promise<Blob | undefined>;
  /** loadBlob 被调用的 trackId 序列 */
  loadCalls: string[];
  /**
   * true 时 loadBlob 挂起，由 resolveLoad 决定完成顺序 ——
   * 让"旧请求比新请求慢"这种竞态成为可测场景 (对齐 FakeAudioContext.deferDecodes)
   */
  deferLoads: boolean;
  /** 挂起中的 loadBlob，按调用序 */
  pendingLoads: PendingLoad[];
  /** 完成第 index 个挂起的 loadBlob */
  resolveLoad: (index: number) => void;
  add: (track: AudioTrack, blobSize?: number) => AudioTrack;
  remove: (id: string) => void;
  /** 让 loadBlob 对该 id 返回 undefined（模拟字节缺失） */
  breakBlob: (id: string) => void;
}

/** resolveTrack + loadBlob 两个回调的一站式替身 */
export function createFakeLibrary(initial: AudioTrack[] = []): FakeLibrary {
  const tracks = new Map<string, AudioTrack>();
  const blobs = new Map<string, FakeBlob>();
  const loadCalls: string[] = [];
  const pendingLoads: PendingLoad[] = [];

  const lib: FakeLibrary = {
    tracks,
    blobs,
    loadCalls,
    deferLoads: false,
    pendingLoads,
    resolveTrack: (id) => tracks.get(id),
    loadBlob: async (id) => {
      loadCalls.push(id);
      const b = blobs.get(id);
      const value = b ? asBlob(b) : undefined;
      if (!lib.deferLoads) return value;
      return new Promise<Blob | undefined>((resolve) => {
        pendingLoads.push({
          trackId: id,
          resolve: () => {
            resolve(value);
          },
        });
      });
    },
    resolveLoad: (index) => {
      const p = pendingLoads[index];
      if (!p) throw new Error(`no pending load at index ${index}`);
      p.resolve();
    },
    add: (track, blobSize = 1024) => {
      tracks.set(track.id, track);
      blobs.set(track.id, makeFakeBlob(blobSize, track.mimeType));
      return track;
    },
    remove: (id) => {
      tracks.delete(id);
      blobs.delete(id);
    },
    breakBlob: (id) => {
      blobs.delete(id);
    },
  };

  for (const t of initial) lib.add(t);
  return lib;
}
