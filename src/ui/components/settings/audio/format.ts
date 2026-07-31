/**
 * 音频分区共用的纯展示助手。
 *
 * 全是无状态纯函数：拆分后混音台要 fmtDuration、曲库两个都要、
 * 隐藏判定则被壳层与曲库共用 —— 与其各抄一份，不如上提到这里。
 * 这里刻意不 import 任何 store，保持可单测、可随处引用。
 */
import type { AudioTrack } from '@engine/types';

export function fmtBytes(n?: number): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(sec?: number): string {
  if (!sec || sec <= 0 || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const rest = Math.floor(sec % 60);
  return `${m}:${String(rest).padStart(2, '0')}`;
}

/** 曲目字节来源的低调标注（不是徽章，只是一行 meta 文字） */
export function sourceLabel(t: AudioTrack): string {
  if (t.source === 'file') return '磁盘';
  if (t.source === 'builtin') return '内置';
  return '浏览器';
}

export function sourceHint(t: AudioTrack): string {
  if (t.source === 'file') return '从音乐文件夹读取';
  if (t.source === 'builtin') return '随应用附带';
  return '存放在浏览器存储中';
}

/** 内置曲目隐藏名单判定（内置不可删，只能隐藏 —— 设计稿 §2） */
export function isHiddenBuiltin(t: AudioTrack, hiddenIds: readonly string[]): boolean {
  return !!t.builtin && hiddenIds.includes(t.id);
}
