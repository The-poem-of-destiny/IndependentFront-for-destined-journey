/**
 * audio-singleton.ts — 应用级 AudioManager 单例 (Phase Audio, 计划决策 A1)
 *
 * 为什么单例住在 UI 层而不是引擎层:
 * 引擎的模块级实例会在 import 期构造 AudioContext，把 environment:'node' 的
 * 整个引擎测试套件炸掉。所以引擎只导出类，实例在这里**惰性**创建。
 *
 * 健壮性要求: node / jsdom 都没有 AudioContext 与 Audio。工厂在缺失时返回
 * **静默 no-op 桩**而不是抛错 —— 应用与每个组件测试都必须能在无 Web Audio 的
 * 环境里活下来，只是没有声音。
 */

import {
  AudioManager,
  AUDIO_DEFAULT_FADE_MS,
  type ManagerAudioContextLike,
} from '@engine/audio-manager';
import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioElementLike,
  AudioGainLike,
  AudioNodeLike,
  AudioParamLike,
} from '@engine/audio-channels';
import { getAudioBlob } from '@engine/database';

// ═══════════════════════════════════════════════════════════
// 静默桩 —— 无 Web Audio 环境下的兜底实现
// ═══════════════════════════════════════════════════════════

function stubParam(): AudioParamLike {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  };
}

function stubNode(): AudioNodeLike {
  return { connect() {}, disconnect() {} };
}

function stubGain(): AudioGainLike {
  return { gain: stubParam(), connect() {}, disconnect() {} };
}

function stubBufferSource(): AudioBufferSourceLike {
  return {
    buffer: null,
    onended: null,
    start() {},
    stop() {},
    connect() {},
    disconnect() {},
  };
}

/** 满足 ManagerAudioContextLike 的全静默上下文 —— 一切调用无副作用 */
function stubContext(): ManagerAudioContextLike {
  return {
    currentTime: 0,
    destination: stubNode(),
    createGain: stubGain,
    createBufferSource: stubBufferSource,
    createMediaElementSource: () => stubNode(),
    decodeAudioData: async (): Promise<AudioBufferLike> => ({ duration: 0 }),
    resume: async () => {},
    close: async () => {},
  };
}

/** 满足 AudioElementLike 的静默元素 —— src 可写可读，播放是空操作 */
function stubElement(): AudioElementLike {
  return {
    src: '',
    currentTime: 0,
    duration: 0,
    play: async () => {},
    pause() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

// ═══════════════════════════════════════════════════════════
// 真实浏览器工厂 (缺失时降级到桩)
// ═══════════════════════════════════════════════════════════

function createContext(): ManagerAudioContextLike {
  const g = globalThis as unknown as Record<string, unknown>;
  const Ctor = (g.AudioContext ?? g.webkitAudioContext) as
    (new () => ManagerAudioContextLike) | undefined;
  if (!Ctor) return stubContext();
  try {
    return new Ctor();
  } catch {
    return stubContext();
  }
}

function createElement(): AudioElementLike {
  const g = globalThis as unknown as Record<string, unknown>;
  const Ctor = g.Audio as (new () => AudioElementLike) | undefined;
  if (!Ctor) return stubElement();
  try {
    const el = new Ctor();
    // 跨源污染在 v1 不可能发生（只有 blob / 同源 builtin），但 crossOrigin
    // 让 MediaElementSource 在任何情况下都不会静默出声失败。
    (el as unknown as Record<string, unknown>).crossOrigin = 'anonymous';
    return el;
  } catch {
    return stubElement();
  }
}

function createObjectURL(blob: Blob): string {
  const u = (globalThis as unknown as { URL?: typeof URL }).URL;
  if (!u || typeof u.createObjectURL !== 'function') return '';
  try {
    return u.createObjectURL(blob);
  } catch {
    return '';
  }
}

function revokeObjectURL(url: string): void {
  const u = (globalThis as unknown as { URL?: typeof URL }).URL;
  if (!u || typeof u.revokeObjectURL !== 'function' || !url) return;
  try {
    u.revokeObjectURL(url);
  } catch {
    /* 静默 */
  }
}

// ═══════════════════════════════════════════════════════════
// 单例
// ═══════════════════════════════════════════════════════════

let instance: AudioManager | null = null;

/**
 * 字节读取 seam 的可替换实现。
 *
 * 默认直读 IndexedDB blob；audio-store 在 init() 里装入自己的按 source 分派版本
 * （'file' 走磁盘，'blob' 走 IndexedDB）。放在这里是因为 AudioManager 在构造期
 * 就捕获 loadBlob，单例又先于 store 创建 —— 用一层间接把两者解耦。
 */
export type BlobResolver = (trackId: string) => Promise<Blob | undefined>;

let blobResolver: BlobResolver | null = null;

/** 装入/卸下自定义字节读取实现；传 null 恢复默认的 IndexedDB 直读 */
export function setBlobResolver(fn: BlobResolver | null): void {
  blobResolver = fn;
}

/** 惰性构造并记忆化的应用级 AudioManager。仅 import 本模块不构造任何东西。 */
export function getAudioManager(): AudioManager {
  if (!instance) {
    instance = new AudioManager({
      createContext,
      createElement,
      createObjectURL,
      revokeObjectURL,
      fadeMs: AUDIO_DEFAULT_FADE_MS,
      loadBlob: (trackId) => (blobResolver ?? getAudioBlob)(trackId),
    });
  }
  return instance;
}

/** 测试/热重载用：丢弃现有实例（会 dispose） */
export function resetAudioManager(): void {
  if (instance) {
    try {
      instance.dispose();
    } catch {
      /* 静默 */
    }
  }
  instance = null;
  blobResolver = null;
  unlockInstalled = false;
}

// ═══════════════════════════════════════════════════════════
// 首次用户手势解锁 (§7)
// ═══════════════════════════════════════════════════════════

let unlockInstalled = false;

/**
 * 挂一次性的首次手势监听 (pointerdown / keydown) → manager.unlock()，随后自摘。
 * 幂等；document 不存在（node 环境）时安全空转。
 */
export function installUnlockListener(): void {
  if (unlockInstalled) return;
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  unlockInstalled = true;

  // 监听**只在真的解锁成功之后**才摘。
  //
  // 先摘再解锁的写法有个致命洞: AudioManager.unlock() 在 resume() 失败时静默
  // 保持锁定（Safari/iOS 上首次手势被判定已消耗是常事），而此时监听已经没了、
  // unlockInstalled 又挡着重装、全项目也没有任何 UI 调 unlock() —— 音频就永久
  // 锁死，只能刷新页面。文档写的是"下一次手势再试"，那就得真的留住下一次手势。
  const handler = (): void => {
    void getAudioManager()
      .unlock()
      .then(() => {
        if (!getAudioManager().state.unlocked) return; // 失败: 留着监听等下一次手势
        doc.removeEventListener('pointerdown', handler);
        doc.removeEventListener('keydown', handler);
      });
  };
  doc.addEventListener('pointerdown', handler);
  doc.addEventListener('keydown', handler);
}
