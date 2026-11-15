/**
 * plugin-storage.ts —— 插件三张表（Dexie v34）的读写入口测试。
 *
 * Uses fake-indexeddb (injected via tests/setup.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import {
  clearAllData,
  exportAllData,
  getDatabase,
  importAllData,
  initializeDatabase,
  DB_VERSION,
} from '../../../src/core/persistence/database';
import {
  deletePluginInstall,
  getPluginFiles,
  getPluginRecord,
  listPluginRecords,
  pluginKvGet,
  pluginKvRemove,
  pluginKvSet,
  putPluginInstall,
  setPluginSaveConsent,
} from '../../../src/core/persistence/plugin-storage';
import { PLUGIN_LIMITS } from '../../../src/core/plugins/plugin-surface';
import type {
  PluginConsent,
  PluginFileRecord,
  PluginManifest,
  PluginRecord,
} from '../../../src/core/types/types-plugin';
import type { SaveSlot } from '../../../src/core/types/types';

const CONSENT: PluginConsent = { version: '1.0.0', contentHash: 'c1', networkHash: 'n1', at: 1 };

function makeManifest(id: string): PluginManifest {
  return {
    manifestVersion: 1,
    id,
    name: '测试插件',
    version: '1.0.0',
    pluginApi: '^1.0',
    contributions: [
      {
        slot: 'game.toolbar',
        id: 'main',
        label: '商店',
        surface: 'window',
        entry: 'index.html',
      },
    ],
    network: [],
    capabilities: { read: ['player'], commands: [], events: [], ai: [], storage: ['global'] },
  };
}

function makeRecord(id: string, overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id,
    manifest: makeManifest(id),
    source: 'local',
    contentHash: 'c1',
    networkHash: 'n1',
    fileCount: 1,
    totalBytes: 3,
    installedAt: 1,
    updatedAt: 1,
    installConsent: CONSENT,
    saveConsents: {},
    ...overrides,
  };
}

function makeFile(pluginId: string, path: string, text = 'abc'): PluginFileRecord {
  const bytes = new TextEncoder().encode(text);
  return { pluginId, path, bytes, size: bytes.length, sha256: `sha-${path}` };
}

function makeSave(id: string): SaveSlot {
  return {
    id,
    name: id,
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '甲',
      userName: '玩家',
      gameStartTime: '',
      totalTurns: 0,
      enabledPluginIds: ['shop'],
      pluginHardened: true,
    },
  };
}

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
});

describe('安装记录与包文件', () => {
  it('putPluginInstall 写入记录与文件，按 id / 路径读回', async () => {
    await putPluginInstall(makeRecord('shop'), [
      makeFile('shop', 'index.html'),
      makeFile('shop', 'app/main.js'),
    ]);
    expect((await getPluginRecord('shop'))?.manifest.name).toBe('测试插件');
    expect((await listPluginRecords()).map((r) => r.id)).toEqual(['shop']);
    expect((await getPluginFiles('shop')).map((f) => f.path)).toEqual([
      'app/main.js',
      'index.html',
    ]);
  });

  it('更新时整体替换文件集：旧文件不残留，其他插件的文件不受影响', async () => {
    await putPluginInstall(makeRecord('shop'), [
      makeFile('shop', 'index.html'),
      makeFile('shop', 'old.js'),
    ]);
    await putPluginInstall(makeRecord('other'), [makeFile('other', 'index.html')]);
    await putPluginInstall(makeRecord('shop', { contentHash: 'c2' }), [
      makeFile('shop', 'index.html', 'new'),
      makeFile('shop', 'new.js'),
    ]);
    const files = await getPluginFiles('shop');
    expect(files.map((f) => f.path)).toEqual(['index.html', 'new.js']);
    expect(new TextDecoder().decode(files[0].bytes)).toBe('new');
    expect((await getPluginRecord('shop'))?.contentHash).toBe('c2');
    expect(await getPluginFiles('other')).toHaveLength(1);
  });

  it('putPluginInstall 在一个事务里完成：中途失败时旧文件集与旧记录原样保留', async () => {
    await putPluginInstall(makeRecord('shop'), [makeFile('shop', 'index.html', 'old')]);
    const db = getDatabase();
    const spy = vi.spyOn(db.plugins, 'put').mockRejectedValueOnce(new Error('写入失败'));
    await expect(
      putPluginInstall(makeRecord('shop', { contentHash: 'c2' }), [makeFile('shop', 'x.js')]),
    ).rejects.toThrow('写入失败');
    spy.mockRestore();
    const files = await getPluginFiles('shop');
    expect(files.map((f) => f.path)).toEqual(['index.html']);
    expect(new TextDecoder().decode(files[0].bytes)).toBe('old');
    expect((await getPluginRecord('shop'))?.contentHash).toBe('c1');
  });

  it('文件归属与记录 id 不一致时直接抛，什么也不写', async () => {
    await expect(
      putPluginInstall(makeRecord('shop'), [makeFile('other', 'index.html')]),
    ).rejects.toThrow('归属不一致');
    expect(await getPluginRecord('shop')).toBeUndefined();
  });

  it('deletePluginInstall 删记录、文件与全局数据，不碰其他插件', async () => {
    await putPluginInstall(makeRecord('shop'), [makeFile('shop', 'index.html')]);
    await putPluginInstall(makeRecord('other'), [makeFile('other', 'index.html')]);
    await pluginKvSet('shop', 'k', 1);
    await pluginKvSet('other', 'k', 2);
    await deletePluginInstall('shop');
    expect(await getPluginRecord('shop')).toBeUndefined();
    expect(await getPluginFiles('shop')).toHaveLength(0);
    expect(await pluginKvGet('shop', 'k')).toEqual({ ok: true, value: undefined });
    expect(await getPluginFiles('other')).toHaveLength(1);
    expect(await pluginKvGet('other', 'k')).toEqual({ ok: true, value: 2 });
  });

  it('setPluginSaveConsent 写入与撤销按存档确认；插件未安装返回 false', async () => {
    await putPluginInstall(makeRecord('shop'), []);
    expect(await setPluginSaveConsent('shop', 'save_a', CONSENT)).toBe(true);
    expect((await getPluginRecord('shop'))?.saveConsents).toEqual({ save_a: CONSENT });
    expect(await setPluginSaveConsent('shop', 'save_a', null)).toBe(true);
    expect((await getPluginRecord('shop'))?.saveConsents).toEqual({});
    expect(await setPluginSaveConsent('missing', 'save_a', CONSENT)).toBe(false);
  });
});

describe('全局 KV', () => {
  it('写入、读取、删除；不存在的键读出 undefined', async () => {
    expect(await pluginKvSet('shop', 'gold', { n: 3 })).toEqual({ ok: true });
    expect(await pluginKvGet('shop', 'gold')).toEqual({ ok: true, value: { n: 3 } });
    expect(await pluginKvRemove('shop', 'gold')).toEqual({ ok: true });
    expect(await pluginKvGet('shop', 'gold')).toEqual({ ok: true, value: undefined });
    expect(await pluginKvRemove('shop', 'gold')).toEqual({ ok: true });
  });

  it('不同插件的同名键互不可见', async () => {
    await pluginKvSet('a', 'k', 1);
    await pluginKvSet('b', 'k', 2);
    expect(await pluginKvGet('a', 'k')).toEqual({ ok: true, value: 1 });
    expect(await pluginKvGet('b', 'k')).toEqual({ ok: true, value: 2 });
  });

  it('空键与不能 JSON 序列化的值返回 INVALID', async () => {
    expect((await pluginKvSet('a', '', 1)).ok).toBe(false);
    expect(await pluginKvGet('a', '')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await pluginKvRemove('a', '')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await pluginKvSet('a', 'k', undefined)).toMatchObject({ ok: false, code: 'INVALID' });
    expect(await pluginKvSet('a', 'k', 10n)).toMatchObject({ ok: false, code: 'INVALID' });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(await pluginKvSet('a', 'k', loop)).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('超出每插件 1MB 配额返回 QUOTA，且不写入', async () => {
    const half = 'x'.repeat(PLUGIN_LIMITS.globalBytes / 2);
    expect((await pluginKvSet('a', 'k1', half)).ok).toBe(true);
    expect(await pluginKvSet('a', 'k2', half)).toMatchObject({ ok: false, code: 'QUOTA' });
    expect(await pluginKvGet('a', 'k2')).toEqual({ ok: true, value: undefined });
    // 别的插件有自己的配额
    expect((await pluginKvSet('b', 'k2', half)).ok).toBe(true);
    // 覆盖同键按新值重算，不把旧值算两次
    expect((await pluginKvSet('a', 'k1', half)).ok).toBe(true);
  });

  it('落库的是 JSON 往返后的规整值，bytes 记键与值的 UTF-8 字节', async () => {
    await pluginKvSet('a', '键', { x: undefined, y: '金' });
    const row = await getDatabase().pluginKv.get(['a', '键']);
    expect(row?.value).toEqual({ y: '金' });
    expect(row?.bytes).toBe(3 + new TextEncoder().encode('{"y":"金"}').length);
  });
});

describe('FullBackup', () => {
  it('pluginKv 随备份往返；插件记录与包字节不进备份、导入也不动它们', async () => {
    await putPluginInstall(makeRecord('shop'), [makeFile('shop', 'index.html', 'PKGBYTES')]);
    await pluginKvSet('shop', 'k', { v: 1 });
    const backup = await exportAllData();
    expect(backup.pluginKv).toHaveLength(1);
    expect('plugins' in backup).toBe(false);
    expect('pluginFiles' in backup).toBe(false);
    expect(JSON.stringify(backup)).not.toContain('index.html');

    await pluginKvSet('shop', 'k', { v: 2 });
    await pluginKvSet('shop', 'extra', 1);
    await importAllData(backup);
    expect(await pluginKvGet('shop', 'k')).toEqual({ ok: true, value: { v: 1 } });
    expect(await pluginKvGet('shop', 'extra')).toEqual({ ok: true, value: undefined });
    expect(await getPluginFiles('shop')).toHaveLength(1);
    expect(await getPluginRecord('shop')).toBeDefined();
  });

  it('旧备份缺 pluginKv 字段：保留本机的行', async () => {
    await pluginKvSet('shop', 'k', 1);
    const backup = await exportAllData();
    delete backup.pluginKv;
    await importAllData(backup);
    expect(await pluginKvGet('shop', 'k')).toEqual({ ok: true, value: 1 });
  });

  it('pluginKv 不是数组时拒绝导入', async () => {
    const backup = await exportAllData();
    (backup as unknown as Record<string, unknown>).pluginKv = 'bad';
    await expect(importAllData(backup)).rejects.toThrow('pluginKv');
  });

  it('存档元数据的 enabledPluginIds / pluginHardened 随备份往返', async () => {
    await getDatabase().saves.put(makeSave('save_a'));
    const backup = await exportAllData();
    await clearAllData();
    await initializeDatabase();
    await importAllData(backup);
    const slot = await getDatabase().saves.get('save_a');
    expect(slot?.metadata.enabledPluginIds).toEqual(['shop']);
    expect(slot?.metadata.pluginHardened).toBe(true);
  });
});

describe('Dexie v34 升版', () => {
  it('v33 升到 v34 不丢既有数据，三张新表就位且为空', async () => {
    const db = getDatabase();
    const NEW_TABLES = new Set(['plugins', 'pluginFiles', 'pluginKv']);
    // 从当前 schema 去掉三张新表，还原出 v33 的表册
    const v33Stores: Record<string, string> = {};
    for (const table of db.tables) {
      if (NEW_TABLES.has(table.name)) continue;
      const { primKey, indexes } = table.schema;
      v33Stores[table.name] = [primKey.src, ...indexes.map((i) => i.src)].join(', ');
    }
    const dbName = db.name;
    await clearAllData();

    const legacy = new Dexie(dbName);
    legacy.version(33).stores(v33Stores);
    await legacy.open();
    await legacy.table('saves').put(makeSave('save_a'));
    await legacy.table('saveCalendars').put({ saveId: 'save_a', mode: 'normal' });
    legacy.close();

    await initializeDatabase();
    const upgraded = getDatabase();
    expect(upgraded.verno).toBe(DB_VERSION);
    expect(DB_VERSION).toBe(34);
    expect((await upgraded.saves.get('save_a'))?.metadata.enabledPluginIds).toEqual(['shop']);
    expect(await upgraded.saveCalendars.count()).toBe(1);
    expect(await upgraded.plugins.count()).toBe(0);
    expect(await upgraded.pluginFiles.count()).toBe(0);
    expect(await upgraded.pluginKv.count()).toBe(0);
  });

  it('clearAllData 清空三张插件表', async () => {
    await putPluginInstall(makeRecord('shop'), [makeFile('shop', 'index.html')]);
    await pluginKvSet('shop', 'k', 1);
    await clearAllData();
    await initializeDatabase();
    expect(await listPluginRecords()).toHaveLength(0);
    expect(await getDatabase().pluginFiles.count()).toBe(0);
    expect(await getDatabase().pluginKv.count()).toBe(0);
  });
});
