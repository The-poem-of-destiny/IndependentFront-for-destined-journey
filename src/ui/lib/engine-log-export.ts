/**
 * engine-log-export.ts — 完整运行日志（引擎日志器）的导出（2026-11-16）。
 *
 * 用途：设置页「开发者模式」卡片的「导出日志」。先 flush 把缓冲交付进库，再按 seq 分页
 * 读全部存档的条目，逐行格式化成 JSONL 写出；首行是一条 header（应用版本 / 导出时间 /
 * 条数 / 粒度）。
 *
 * 关键约定：
 * - 🔴 **不许把全部内容拼成一个巨型字符串**：日志可达几十到几百 MB。优先走
 *   `window.showSaveFilePicker` 逐页流式写入；不支持时每页拼成一个 Blob 分片，
 *   最后 `new Blob(parts)` 下载 —— 浏览器可以把分片落到磁盘，不必全进 JS 堆。
 * - 用户在保存对话框里点取消 = `cancelled`，不算失败。
 * - I/O 全部经 deps 注入，单测不碰 Dexie 与 DOM 下载。
 */

import { flushEngineLog } from '@engine/runtime/engine-logger';
import type { EngineLogEntry } from '@engine/runtime/engine-logger';
import {
  countEngineLogs,
  formatEngineLogLine,
  readEngineLogPage,
} from '@engine/persistence/engine-log-store';

/** 每页读取的条数 */
export const ENGINE_LOG_EXPORT_PAGE_SIZE = 200;

const JSONL_MIME = 'application/x-ndjson';

/** 文件句柄里本模块用到的那一小部分（File System Access API） */
interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
}
type SaveFilePicker = (options: {
  suggestedName: string;
  types?: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<FileHandleLike>;

export interface EngineLogExportDeps {
  flush(): Promise<void>;
  count(): Promise<number>;
  readPage(options: { afterSeq: number; limit: number }): Promise<EngineLogEntry[]>;
  formatLine(entry: EngineLogEntry): string;
  now(): Date;
  appVersion: string;
  /** 缺省 = 不支持流式写入，走 Blob 分片下载 */
  savePicker?: SaveFilePicker;
  download(blob: Blob, fileName: string): void;
}

export interface EngineLogExportOptions {
  /** 当前粒度设置，写进 header */
  level: string;
  /** 每写完一页回调一次，参数 = 已导出的日志行数（不含 header） */
  onProgress?: (exportedLines: number) => void;
}

export type EngineLogExportResult =
  | { status: 'done'; method: 'picker' | 'download'; fileName: string; lines: number }
  | { status: 'cancelled' };

/** `engine-log-YYYYMMDD-HHmmss.jsonl`（本地时间） */
export function buildEngineLogFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `engine-log-${day}-${time}.jsonl`;
}

/** header 行（不含换行） */
function buildEngineLogHeader(input: {
  appVersion: string;
  exportedAt: Date;
  count: number;
  level: string;
}): string {
  return JSON.stringify({
    type: 'header',
    format: 'engine-log-jsonl',
    appVersion: input.appVersion,
    exportedAt: input.exportedAt.toISOString(),
    count: input.count,
    level: input.level,
  });
}

/**
 * 按 seq 升序逐页产出 JSONL 文本块（每块以换行结尾）。
 * 只持有一页的文本；seq 缺失时停止，免得在坏数据上死循环。
 */
async function* iterateLogPages(
  deps: Pick<EngineLogExportDeps, 'readPage' | 'formatLine'>,
): AsyncGenerator<{ text: string; lines: number }> {
  let afterSeq = 0;
  for (;;) {
    const page = await deps.readPage({ afterSeq, limit: ENGINE_LOG_EXPORT_PAGE_SIZE });
    if (page.length === 0) return;
    let text = '';
    for (const entry of page) text += `${deps.formatLine(entry)}\n`;
    yield { text, lines: page.length };
    const last = page[page.length - 1].seq;
    if (typeof last !== 'number' || last <= afterSeq) return;
    afterSeq = last;
    if (page.length < ENGINE_LOG_EXPORT_PAGE_SIZE) return;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** 导出全部存档的引擎日志 */
export async function exportEngineLogs(
  options: EngineLogExportOptions,
  deps: EngineLogExportDeps = defaultEngineLogExportDeps(),
): Promise<EngineLogExportResult> {
  const exportedAt = deps.now();
  const fileName = buildEngineLogFileName(exportedAt);

  // 先问保存位置：对话框必须挨着用户那一下点击弹出（用户激活会随 await 过期）
  let writable: WritableLike | null = null;
  if (deps.savePicker) {
    try {
      const handle = await deps.savePicker({
        suggestedName: fileName,
        types: [{ description: 'JSONL 日志', accept: { [JSONL_MIME]: ['.jsonl'] } }],
      });
      writable = await handle.createWritable();
    } catch (error) {
      if (isAbortError(error)) return { status: 'cancelled' };
      throw error;
    }
  }

  await deps.flush();
  const header = buildEngineLogHeader({
    appVersion: deps.appVersion,
    exportedAt,
    count: await deps.count(),
    level: options.level,
  });

  let exported = 0;
  if (writable) {
    try {
      await writable.write(`${header}\n`);
      for await (const chunk of iterateLogPages(deps)) {
        await writable.write(chunk.text);
        exported += chunk.lines;
        options.onProgress?.(exported);
      }
      await writable.close();
    } catch (error) {
      await writable.abort?.(error).catch(() => undefined);
      throw error;
    }
    return { status: 'done', method: 'picker', fileName, lines: exported };
  }

  const parts: BlobPart[] = [new Blob([`${header}\n`])];
  for await (const chunk of iterateLogPages(deps)) {
    parts.push(new Blob([chunk.text]));
    exported += chunk.lines;
    options.onProgress?.(exported);
  }
  deps.download(new Blob(parts, { type: JSONL_MIME }), fileName);
  return { status: 'done', method: 'download', fileName, lines: exported };
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立即回收会让部分浏览器的下载拿不到数据
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 生产依赖：Dexie 存储 + 浏览器下载 */
function defaultEngineLogExportDeps(): EngineLogExportDeps {
  const picker =
    typeof window !== 'undefined'
      ? (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
      : undefined;
  return {
    flush: flushEngineLog,
    count: countEngineLogs,
    readPage: (options) => readEngineLogPage(options),
    formatLine: formatEngineLogLine,
    now: () => new Date(),
    appVersion: typeof __ENGINE_VERSION__ !== 'undefined' ? (__ENGINE_VERSION__ ?? '未知') : '未知',
    ...(typeof picker === 'function' ? { savePicker: picker.bind(window) } : {}),
    download: triggerDownload,
  };
}
