import { describe, expect, it, vi } from 'vitest';
import type { EngineLogEntry } from '@engine/runtime/engine-logger';
import { formatEngineLogLine } from '@engine/persistence/engine-log-store';
import {
  ENGINE_LOG_EXPORT_PAGE_SIZE,
  buildEngineLogFileName,
  exportEngineLogs,
  type EngineLogExportDeps,
} from '../../../src/ui/lib/engine-log-export';

function entry(seq: number): EngineLogEntry {
  return {
    seq,
    ts: 1_700_000_000_000 + seq,
    level: 'debug',
    cat: 'llm',
    saveId: seq % 2 === 0 ? 'save-a' : '',
    layer: seq % 2 === 0 ? 1 : 0,
    msg: `第 ${seq} 条`,
    payload: seq % 3 === 0 ? JSON.stringify({ text: '含"引号"与\n换行' }) : '',
    size: 0,
  };
}

/** 内存里的 seq 有序表，模拟 readEngineLogPage 的分页语义 */
function makeDeps(total: number, overrides: Partial<EngineLogExportDeps> = {}) {
  const rows = Array.from({ length: total }, (_, i) => entry(i + 1));
  const calls: Array<{ afterSeq: number; limit: number }> = [];
  const order: string[] = [];
  const deps: EngineLogExportDeps = {
    flush: vi.fn(async () => {
      order.push('flush');
    }),
    count: vi.fn(async () => rows.length),
    readPage: vi.fn(async (options) => {
      order.push('read');
      calls.push(options);
      return rows.filter((r) => (r.seq ?? 0) > options.afterSeq).slice(0, options.limit);
    }),
    formatLine: formatEngineLogLine,
    now: () => new Date(2026, 10, 16, 9, 5, 7),
    appVersion: '9.9.9',
    download: vi.fn(),
    ...overrides,
  };
  return { deps, calls, order };
}

function parseLines(text: string) {
  const lines = text.split('\n');
  expect(lines.pop()).toBe('');
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('engine-log-export', () => {
  it('文件名形如 engine-log-YYYYMMDD-HHmmss.jsonl', () => {
    expect(buildEngineLogFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'engine-log-20260102-030405.jsonl',
    );
  });

  it('Blob 回退：先 flush，再按 seq 分页拼行；首行是 header，每行都能 JSON.parse', async () => {
    const total = ENGINE_LOG_EXPORT_PAGE_SIZE * 2 + 17;
    const { deps, calls, order } = makeDeps(total);
    const progress: number[] = [];

    const result = await exportEngineLogs(
      { level: 'debug', onProgress: (n) => progress.push(n) },
      deps,
    );

    expect(result).toEqual({
      status: 'done',
      method: 'download',
      fileName: 'engine-log-20261116-090507.jsonl',
      lines: total,
    });
    expect(order[0]).toBe('flush');
    expect(calls.map((c) => c.afterSeq)).toEqual([
      0,
      ENGINE_LOG_EXPORT_PAGE_SIZE,
      ENGINE_LOG_EXPORT_PAGE_SIZE * 2,
    ]);
    expect(calls.every((c) => c.limit === ENGINE_LOG_EXPORT_PAGE_SIZE)).toBe(true);
    expect(progress).toEqual([ENGINE_LOG_EXPORT_PAGE_SIZE, ENGINE_LOG_EXPORT_PAGE_SIZE * 2, total]);

    const [blob, fileName] = (deps.download as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Blob,
      string,
    ];
    expect(fileName).toBe('engine-log-20261116-090507.jsonl');
    const rows = parseLines(await blob.text());
    expect(rows).toHaveLength(total + 1);
    expect(rows[0]).toMatchObject({
      type: 'header',
      appVersion: '9.9.9',
      count: total,
      level: 'debug',
      exportedAt: new Date(2026, 10, 16, 9, 5, 7).toISOString(),
    });
    expect(rows.slice(1).map((r) => r.seq)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    // 合法 JSON 的 payload 原样嵌入为对象
    expect(rows[3].payload).toEqual({ text: '含"引号"与\n换行' });
  });

  it('流式写入：支持 showSaveFilePicker 时逐页写入、不走下载', async () => {
    const writes: string[] = [];
    const writable = {
      write: vi.fn(async (data: string) => {
        writes.push(data);
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const savePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    const total = ENGINE_LOG_EXPORT_PAGE_SIZE + 3;
    const { deps } = makeDeps(total, { savePicker });

    const result = await exportEngineLogs({ level: 'trace' }, deps);

    expect(result).toMatchObject({ status: 'done', method: 'picker', lines: total });
    expect(savePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'engine-log-20261116-090507.jsonl' }),
    );
    expect(deps.download).not.toHaveBeenCalled();
    // header 一次 + 两页各一次，不是一次性写入整份内容
    expect(writes).toHaveLength(3);
    expect(writable.close).toHaveBeenCalledTimes(1);
    const rows = parseLines(writes.join(''));
    expect(rows[0]).toMatchObject({ type: 'header', count: total, level: 'trace' });
    expect(rows).toHaveLength(total + 1);
  });

  it('保存对话框里点取消 = cancelled，不读库也不下载', async () => {
    const savePicker = vi.fn(async () => {
      throw new DOMException('用户取消', 'AbortError');
    });
    const { deps } = makeDeps(5, { savePicker });

    expect(await exportEngineLogs({ level: 'trace' }, deps)).toEqual({ status: 'cancelled' });
    expect(deps.readPage).not.toHaveBeenCalled();
    expect(deps.download).not.toHaveBeenCalled();
  });

  it('写入中途失败时中止文件并把错误抛给调用方', async () => {
    const writable = {
      write: vi
        .fn<(data: string) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('磁盘已满')),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const { deps } = makeDeps(3, {
      savePicker: async () => ({ createWritable: async () => writable }),
    });

    await expect(exportEngineLogs({ level: 'trace' }, deps)).rejects.toThrow('磁盘已满');
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
  });

  it('空库只导出 header', async () => {
    const { deps } = makeDeps(0);
    const result = await exportEngineLogs({ level: 'info' }, deps);
    expect(result).toMatchObject({ status: 'done', lines: 0 });
    const [blob] = (deps.download as ReturnType<typeof vi.fn>).mock.calls[0] as [Blob];
    const rows = parseLines(await blob.text());
    expect(rows).toEqual([expect.objectContaining({ type: 'header', count: 0, level: 'info' })]);
  });
});
