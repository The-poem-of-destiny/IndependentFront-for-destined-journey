import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  deleteSaveSlot,
  exportAllData,
  getDatabase,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { exportSessionSave, importSessionSave } from '../../../src/core/persistence/session-backup';
import { installRuntimePack } from '../../../src/core/content/pack-runtime';
import { createDirectCacheStore } from '../../../src/core/prompts/direct-context-store';
import {
  directCacheKey,
  type DirectCacheRecord,
} from '../../../src/core/prompts/direct-context-session';

const saveId = 'cached-store';
const record: DirectCacheRecord = {
  key: directCacheKey(saveId),
  saveId,
  agentId: 'direct_cached',
  protocol: 'direct-cache-v1',
  signature: 'config',
  transcript: [{ role: 'system', content: 'local lore' }],
  sections: { resources: { hp: 20 } },
  source: [],
  revision: 1,
};

beforeEach(async () => {
  installRuntimePack(undefined, false);
  await clearAllData();
  await saveSaveSlot({
    id: saveId,
    slot: 1,
    name: '缓存直出',
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '',
      userName: '',
      gameStartTime: '',
      totalTurns: 0,
      generationMode: 'direct_cached',
    },
  });
});
afterEach(() => installRuntimePack(undefined, false));

describe('direct cache persistence', () => {
  it('restores a disposable record and uses the existing save deletion lifecycle', async () => {
    await createDirectCacheStore().save(record);
    expect(await createDirectCacheStore().load(saveId)).toEqual(record);
    await deleteSaveSlot(saveId);
    expect(await createDirectCacheStore().load(saveId)).toBeUndefined();
  });

  it('keeps the save mode through backup while excluding the cache transcript', async () => {
    await createDirectCacheStore().save(record);
    const full = await exportAllData();
    const single = await exportSessionSave(saveId);
    expect(full.version).toBe(33);
    expect(single.version).toBe(33);
    expect(JSON.stringify(full)).not.toContain('local lore');
    expect(JSON.stringify(single)).not.toContain('local lore');
    await deleteSaveSlot(saveId);
    const imported = await importSessionSave(single);
    const slot = await getDatabase().saves.get(imported.saveId);
    expect(slot?.metadata.generationMode).toBe('direct_cached');
    expect(await getDatabase().promptSessions.count()).toBe(0);
  });

  it('does not read or persist prompts while a protected pack is installed', async () => {
    const store = createDirectCacheStore();
    await store.save(record);
    installRuntimePack(undefined, true);
    expect(await store.load(saveId)).toBeUndefined();
    await store.delete(saveId);
    await store.save(record);
    expect(await getDatabase().promptSessions.count()).toBe(0);
  });
});
