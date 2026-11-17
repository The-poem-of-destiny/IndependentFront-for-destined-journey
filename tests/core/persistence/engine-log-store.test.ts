/**
 * engine-log-store.ts — 引擎日志的 Dexie 落盘（v34 engineLogs）：
 * 层淘汰 / 层 0 分桶上限 / 层号续接 / 分页与 JSONL / 删档级联 / 清受保护明文路径 / 不进备份。
 *
 * Uses fake-indexeddb (injected via tests/setup.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  deleteSaveSlot,
  exportAllData,
  getDatabase,
  initializeDatabase,
  purgeProtectedPackPlaintext,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import {
  clearEngineLogs,
  countEngineLogs,
  createDexieEngineLogSink,
  formatEngineLogLine,
  getEngineLogLayerHead,
  readEngineLogPage,
} from '../../../src/core/persistence/engine-log-store';
import { exportSessionSave } from '../../../src/core/persistence/session-backup';
import {
  beginLogScope,
  configureEngineLogger,
  flushEngineLog,
  installEngineLogSink,
  logEngine,
  resetEngineLoggerForTest,
} from '../../../src/core/runtime/engine-logger';
import type { EngineLogEntry } from '../../../src/core/runtime/engine-logger';
import type { SaveSlot } from '../../../src/core/types/types';

function entry(overrides: Partial<EngineLogEntry> = {}): EngineLogEntry {
  return {
    ts: 1,
    level: 'info',
    cat: 'test',
    saveId: 's1',
    layer: 1,
    msg: 'm',
    payload: '{"a":1}',
    size: 7,
    ...overrides,
  };
}

function saveSlot(id: string): SaveSlot {
  return {
    id,
    name: '测试存档',
    slot: 1,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '测试角色',
      userName: '测试者',
      gameStartTime: '001-01-01',
      totalTurns: 0,
    },
  } as SaveSlot;
}

beforeEach(async () => {
  resetEngineLoggerForTest();
  try {
    await clearAllData();
  } catch {
    /* db may not exist yet */
  }
  await initializeDatabase();
});

afterEach(() => {
  resetEngineLoggerForTest();
});

describe('createDexieEngineLogSink', () => {
  it('写入分配自增 seq，忽略传入的 seq', async () => {
    const sink = createDexieEngineLogSink();
    await sink.write([entry({ seq: 999 }), entry({ msg: 'second' })]);
    const rows = await readEngineLogPage();
    expect(rows.map((row) => row.msg)).toEqual(['m', 'second']);
    expect(rows[0].seq).toBeLessThan(rows[1].seq!);
    expect(rows.some((row) => row.seq === 999)).toBe(false);
  });

  it('第 101 层写入时淘汰第 1 层，其他存档不受影响', async () => {
    const sink = createDexieEngineLogSink();
    for (let layer = 1; layer <= 100; layer++) {
      await sink.write([entry({ layer })]);
    }
    await sink.write([entry({ saveId: 'other', layer: 1 })]);
    expect(await countEngineLogs()).toBe(101);
    await sink.write([entry({ layer: 101 })]);
    const all = await getDatabase().engineLogs.toArray();
    const s1Layers = all.filter((row) => row.saveId === 's1').map((row) => row.layer);
    expect(s1Layers).not.toContain(1);
    expect(s1Layers).toContain(2);
    expect(s1Layers).toContain(101);
    expect(all.some((row) => row.saveId === 'other' && row.layer === 1)).toBe(true);
  });

  it('层 0 每个 (saveId, 0) 桶最多 2000 条，按 seq 删最旧', async () => {
    const sink = createDexieEngineLogSink();
    const batch = Array.from({ length: 2005 }, (_, i) =>
      entry({ saveId: '', layer: 0, msg: `app-${i}` }),
    );
    await sink.write(batch);
    await sink.write([entry({ saveId: 's1', layer: 0, msg: 'save-level' })]);
    const all = await getDatabase().engineLogs.toArray();
    const app = all.filter((row) => row.saveId === '');
    expect(app).toHaveLength(2000);
    expect(app[0].msg).toBe('app-5');
    expect(all.some((row) => row.msg === 'save-level')).toBe(true);
  });

  it('getLayerHead 给出最大回合层与其 layerKey；无回合层时为 0', async () => {
    const sink = createDexieEngineLogSink();
    expect(await getEngineLogLayerHead('s1')).toEqual({ layer: 0 });
    await sink.write([
      entry({ layer: 0 }),
      entry({ layer: 3, layerKey: 'msg-3' }),
      entry({ layer: 2, layerKey: 'msg-2' }),
    ]);
    expect(await sink.getLayerHead('s1')).toEqual({ layer: 3, layerKey: 'msg-3' });
    expect(await getEngineLogLayerHead('nobody')).toEqual({ layer: 0 });
  });
});

describe('读取 / 格式化 / 统计 / 清空', () => {
  it('按 seq 分页，可按存档过滤', async () => {
    const sink = createDexieEngineLogSink();
    await sink.write(
      Array.from({ length: 450 }, (_, i) => entry({ saveId: i % 2 ? 'a' : 'b', msg: `${i}` })),
    );
    const first = await readEngineLogPage();
    expect(first).toHaveLength(200);
    const second = await readEngineLogPage({ afterSeq: first[199].seq });
    expect(second[0].msg).toBe('200');
    const third = await readEngineLogPage({ afterSeq: second[second.length - 1].seq });
    expect(third).toHaveLength(50);
    const onlyA = await readEngineLogPage({ saveId: 'a', limit: 10 });
    expect(onlyA.every((row) => row.saveId === 'a')).toBe(true);
    expect(onlyA).toHaveLength(10);
  });

  it('JSONL 行：合法 JSON payload 原样嵌入，非法或空 payload 安全处理', () => {
    const line = formatEngineLogLine(entry({ seq: 7, payload: '{"prompt":"你好\\n"}' }));
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.seq).toBe(7);
    expect(parsed.payload).toEqual({ prompt: '你好\n' });

    const broken = JSON.parse(formatEngineLogLine(entry({ payload: '{坏' }))) as {
      payload: unknown;
    };
    expect(broken.payload).toBe('{坏');
    const empty = JSON.parse(formatEngineLogLine(entry({ payload: '', size: 0 }))) as object;
    expect('payload' in empty).toBe(false);
  });

  it('countEngineLogs / clearEngineLogs', async () => {
    await createDexieEngineLogSink().write([entry(), entry()]);
    expect(await countEngineLogs()).toBe(2);
    await clearEngineLogs();
    expect(await countEngineLogs()).toBe(0);
  });
});

describe('生命周期', () => {
  it('删档级联删除该存档全部日志（含层 0），其他存档保留', async () => {
    await saveSaveSlot(saveSlot('gone'));
    await createDexieEngineLogSink().write([
      entry({ saveId: 'gone', layer: 0 }),
      entry({ saveId: 'gone', layer: 5 }),
      entry({ saveId: 'kept', layer: 1 }),
      entry({ saveId: '', layer: 0 }),
    ]);
    await deleteSaveSlot('gone');
    const all = await getDatabase().engineLogs.toArray();
    expect(all.map((row) => row.saveId).sort()).toEqual(['', 'kept']);
  });

  it('装着受保护内容包时，每次启动都跑的 purge 也不清日志（开关打开即落盘）', async () => {
    await createDexieEngineLogSink().write([entry(), entry({ saveId: '', layer: 0 })]);
    await getDatabase().contentPacks.put({
      packId: 'protected',
      packVersion: '1.0.0',
      installedAt: 1,
      source: 'legacy-locked',
      ownedBookIds: [],
      ownedPresetIds: [],
    });
    await purgeProtectedPackPlaintext();
    expect(await countEngineLogs()).toBe(2);
  });

  it('没有受保护内容包时 purge 不动日志', async () => {
    await createDexieEngineLogSink().write([entry()]);
    await purgeProtectedPackPlaintext();
    expect(await countEngineLogs()).toBe(1);
  });

  it('不进 FullBackup，也不进单存档导出', async () => {
    await saveSaveSlot(saveSlot('exp'));
    await createDexieEngineLogSink().write([entry({ saveId: 'exp' })]);
    const full = await exportAllData();
    expect('engineLogs' in full).toBe(false);
    expect(JSON.stringify(full)).not.toContain('"cat":"test"');
    const session = await exportSessionSave('exp');
    expect('engineLogs' in session).toBe(false);
    expect(JSON.stringify(session)).not.toContain('"cat":"test"');
  });
});

describe('与日志器联动', () => {
  it('作用域条目带层号落库；刷新（重置日志器）后从库里续接层号', async () => {
    installEngineLogSink(createDexieEngineLogSink());
    configureEngineLogger({ enabled: true, level: 'trace' });
    const first = beginLogScope({ saveId: 's1', turnId: 't1', layerKey: 'msg-1' });
    logEngine('info', 'prompt', 'wire', { text: 'hello' });
    first.end('ok');
    await flushEngineLog();

    // 模拟刷新：模块状态清空，库还在
    resetEngineLoggerForTest();
    installEngineLogSink(createDexieEngineLogSink());
    configureEngineLogger({ enabled: true, level: 'trace' });
    const regen = beginLogScope({ saveId: 's1', turnId: 't2', layerKey: 'msg-1' });
    logEngine('info', 'prompt', 'regen');
    regen.end('ok');
    const next = beginLogScope({ saveId: 's1', turnId: 't3', layerKey: 'msg-2' });
    logEngine('info', 'prompt', 'next');
    next.end('ok');
    await flushEngineLog();

    const rows = await getDatabase().engineLogs.toArray();
    const layerOf = (msg: string) => rows.find((row) => row.msg === msg)?.layer;
    expect(layerOf('wire')).toBe(1);
    expect(layerOf('regen')).toBe(1);
    expect(layerOf('next')).toBe(2);
    expect(rows.find((row) => row.msg === 'next')?.layerKey).toBe('msg-2');
  });
});
