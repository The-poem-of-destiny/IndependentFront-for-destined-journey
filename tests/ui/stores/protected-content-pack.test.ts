// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia';
import {
  getDatabase,
  exportAllData,
  importAllData,
  migrateLegacyContentPacks,
  purgeProtectedPackPlaintext,
  getPresets,
  saveDebugTurn,
  savePreset,
} from '../../../src/core/persistence/database';
import {
  getActivePackPayload,
  getRuntimePackPresets,
  installRuntimePack,
} from '../../../src/core/content/pack-runtime';
import { createDexiePromptSessionStore } from '../../../src/core/prompts/prompt-session-store';
import { getCombatSandbox, saveCombatSandbox } from '../../../src/core/combat/sandbox/persistence';
import { withSaveWriteLock } from '../../../src/core/state/state-write-queue';
import { useContentStore, setActivePackRecord } from '../../../src/ui/stores/content-store';
import { useWorldBookStore } from '../../../src/ui/stores/worldbook-store';
import { loadPresets, upsertPreset } from '../../../src/ui/composables/usePresets';
import {
  clearDiscordSession,
  saveDiscordSession,
  discordKeyLease,
  savePackKeyLease,
} from '../../../src/ui/lib/discord-auth-client';
import {
  encryptPrivatePack,
  makeDiscordSession,
  makePrivatePack,
  PRIVATE_TEXT,
  renewPrivatePack,
} from '../../helpers/pack-auth-fixture';
import type { DebugTurnRecord } from '../../../src/core/types/types';
import type { CombatSandboxRecord } from '../../../src/core/combat/sandbox/types';

vi.mock('../../../src/ui/stores/beautifier-store', () => ({
  useBeautifierStore: () => ({ refreshPresetRules: async () => {} }),
}));
vi.mock('../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: { activePresetId: '' },
    projectAgentDefaults: { version: 1, agents: {} },
    saveNow: () => {},
    loadAgentProjectDefaults: async () => {},
  }),
}));
let pinia: Pinia;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  clearDiscordSession();
  setActivePackRecord(null);
  pinia = createPinia();
  setActivePinia(pinia);
  const db = getDatabase();
  await Promise.all([
    db.contentPacks.clear(),
    db.worldBooks.clear(),
    db.presets.clear(),
    db.saves.clear(),
    db.promptSessions.clear(),
    db.debugTurns.clear(),
    db.combatSandboxes.clear(),
  ]);
  saveDiscordSession(makeDiscordSession());
});
afterEach(() => {
  vi.restoreAllMocks();
  disposePinia(pinia);
  clearDiscordSession();
  setActivePackRecord(null);
  vi.unstubAllGlobals();
});
async function install() {
  const store = useContentStore();
  await store.hydratePackState();
  const download = encryptPrivatePack();
  expect((await store.installProtectedPack(download)).ok).toBe(true);
  return { store, download };
}
function respondRenew(download: Awaited<ReturnType<typeof renewPrivatePack>>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/renew')
        ? Response.json({
            ok: true,
            serverTime: Date.now(),
            renewal: download.envelope,
            keyLease: download.keyLease,
          })
        : new Response('', { status: 404 }),
    ),
  );
}

describe('authenticated content lifecycle and plaintext boundary', () => {
  it('mounts books/presets only in memory and exports no protected text', async () => {
    const { store } = await install();
    expect(store.leaseState).toBe('ACTIVE_UNLOCKED');
    expect(useWorldBookStore().books[0].entries[0].content).toBe(PRIVATE_TEXT);
    expect(JSON.stringify(await getPresets())).toContain(PRIVATE_TEXT);
    const db = getDatabase(),
      record = await db.contentPacks.get('fixture');
    expect(record?.payload).toBeUndefined();
    expect(record?.source).toBe('discord');
    expect(await db.worldBooks.count()).toBe(0);
    expect(await db.presets.count()).toBe(0);
    expect(JSON.stringify(await exportAllData())).not.toContain(PRIVATE_TEXT);
    expect(localStorage.getItem('poem_discord_pack_lease_v1')).not.toContain(PRIVATE_TEXT);
    expect(await store.ensurePackLeaseActive()).toBe(true);
  });
  it('keeps edits in memory and drops them synchronously on logout/account switch', async () => {
    const { store } = await install();
    const wb = useWorldBookStore();
    await wb.upsertEntry('system_core', {
      ...wb.books[0].entries[0],
      content: 'edited-private-text',
    });
    await upsertPreset({ ...getRuntimePackPresets()[0], name: 'edited' });
    expect(wb.books[0].entries[0].content).toBe('edited-private-text');
    expect(await getDatabase().worldBooks.count()).toBe(0);
    expect(await getDatabase().presets.count()).toBe(0);
    clearDiscordSession();
    expect(getActivePackPayload()).toBeUndefined();
    expect(wb.books).toHaveLength(0);
    expect(store.leaseState).toBe('LOCKED_NOT_LOGGED_IN');
    expect(await store.ensurePackLeaseActive()).toBe(false);
    saveDiscordSession(makeDiscordSession('999'));
    expect(store.leaseState).toBe('LOCKED_ACCOUNT_MISMATCH');
    expect(getRuntimePackPresets()).toHaveLength(0);
  });
  it('rehydrates valid cached ciphertext offline without a network auth request', async () => {
    const { store, download } = await install();
    store.$dispose();
    setActivePackRecord(null);
    const next = useContentStore();
    await next.hydratePackState();
    expect(next.leaseState).toBe('ACTIVE_UNLOCKED');
    expect(getActivePackPayload()?.packId).toBe('fixture');
    expect(discordKeyLease.value).toEqual(download.keyLease);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/renew'))).toBe(false);
  });
  it('renewal changes only headers, preserves edited overlay, and retains valid content on 503', async () => {
    const { store, download } = await install();
    const renewed = await renewPrivatePack(download);
    const wb = useWorldBookStore();
    await wb.upsertEntry('system_core', { ...wb.books[0].entries[0], content: 'session-edit' });
    respondRenew(renewed);
    await store.renewPackLease();
    const row = await getDatabase().contentPacks.get('fixture');
    expect(row?.encryptedEnvelope?.ciphertextB64).toBe(download.envelope.ciphertextB64);
    expect(row?.expiresAt).toBe(renewed.envelope.expiresAt);
    expect(discordKeyLease.value).toEqual(renewed.keyLease);
    expect(wb.books[0].entries[0].content).toBe('session-edit');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: false, serverTime: Date.now(), code: 'DISCORD_UNAVAILABLE', error: 'offline' },
          { status: 503 },
        ),
      ),
    );
    await expect(store.renewPackLease()).rejects.toThrow('offline');
    expect(store.leaseState).toBe('ACTIVE_UNLOCKED');
    expect(getActivePackPayload()).toBeDefined();
  });
  it('definite revocation locks immediately and a late renewal cannot resurrect logout', async () => {
    const { store, download } = await install();
    const renewed = await renewPrivatePack(download);
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/renew')
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(new Response('', { status: 404 })),
      ),
    );
    const pending = store.renewPackLease();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    clearDiscordSession();
    finish(
      Response.json({
        ok: true,
        serverTime: Date.now(),
        renewal: renewed.envelope,
        keyLease: renewed.keyLease,
      }),
    );
    await rejected;
    expect(getActivePackPayload()).toBeUndefined();
    expect(discordKeyLease.value).toBeNull();
    expect((await getDatabase().contentPacks.get('fixture'))?.expiresAt).toBe(
      download.envelope.expiresAt,
    );
  });
  it('locks on confirmed 403 without deleting ciphertext or the player library', async () => {
    const { store } = await install();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { ok: false, serverTime: Date.now(), code: 'NOT_IN_GUILD', error: 'left guild' },
          { status: 403 },
        ),
      ),
    );
    await expect(store.renewPackLease()).rejects.toThrow();
    expect(store.leaseState).toBe('LOCKED_REVOKED');
    expect(getActivePackPayload()).toBeUndefined();
    expect(await getDatabase().contentPacks.count()).toBe(1);
  });
  it('scrubs old backup plaintext even while locked, keeping player/workshop books', async () => {
    const { store } = await install();
    clearDiscordSession();
    const pack = makePrivatePack(),
      db = getDatabase();
    const user = { ...pack.worldBooks![0], id: 'player', builtIn: false };
    const workshop = {
      ...pack.worldBooks![0],
      id: 'workshop',
      partition: 'creative_workshop' as const,
    };
    const backup = await exportAllData();
    backup.worldBooks = [...pack.worldBooks!, user, workshop];
    backup.presets = [...pack.presets!];
    await importAllData(backup);
    await loadPresets();
    await useWorldBookStore().hydrate();
    expect((await db.worldBooks.toArray()).map((book) => book.id).sort()).toEqual([
      'player',
      'workshop',
    ]);
    expect(await db.presets.count()).toBe(0);
    expect(store.leaseState).toBe('LOCKED_NOT_LOGGED_IN');
    await store.uninstallPack();
    expect(await db.contentPacks.count()).toBe(0);
    expect((await db.worldBooks.toArray()).map((book) => book.id).sort()).toEqual([
      'player',
      'workshop',
    ]);
  });
  it('retires protected ownership when importing a local file with a different pack id', async () => {
    const { store } = await install();
    const local = { ...makePrivatePack(), packId: 'offline-copy' };
    expect((await store.installPack(local, { confirmConflicts: true })).ok).toBe(true);
    expect((await getDatabase().contentPacks.toArray()).map((row) => row.packId)).toEqual([
      'offline-copy',
    ]);
    const backup = await exportAllData();
    expect(backup.worldBooks[0].entries[0].content).toBe(PRIVATE_TEXT);
    expect(backup.presets).toHaveLength(1);
    await useWorldBookStore().hydrate();
    clearDiscordSession();
    expect(store.leaseState).toBe('LOCAL');
    expect(useWorldBookStore().books[0].entries[0].content).toBe(PRIVATE_TEXT);
    expect(getActivePackPayload()?.packId).toBe('offline-copy');
  });
  it('restores ciphertext and the edited overlay when a local-file replacement fails', async () => {
    const { store, download } = await install();
    const wb = useWorldBookStore();
    await wb.upsertEntry('system_core', { ...wb.books[0].entries[0], content: 'before-failure' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(wb, 'upsertBooks').mockRejectedValueOnce(new Error('disk failed'));
    await expect(
      store.installPack(
        { ...makePrivatePack(), packId: 'offline-copy' },
        { confirmConflicts: true },
      ),
    ).rejects.toThrow('disk failed');
    expect(await getDatabase().contentPacks.count()).toBe(1);
    expect((await getDatabase().contentPacks.get('fixture'))?.encryptedEnvelope).toEqual(
      download.envelope,
    );
    expect(store.leaseState).toBe('ACTIVE_UNLOCKED');
    expect(wb.books[0].entries[0].content).toBe('before-failure');
    expect(JSON.stringify(await exportAllData())).not.toContain(PRIVATE_TEXT);
  });
  it('recovers a missing cached lease at boot through renewal', async () => {
    const { store, download } = await install();
    store.$dispose();
    setActivePackRecord(null);
    savePackKeyLease(null);
    respondRenew(await renewPrivatePack(download));
    const next = useContentStore();
    await next.hydratePackState();
    expect(next.leaseState).toBe('ACTIVE_UNLOCKED');
    expect(getActivePackPayload()?.packId).toBe('fixture');
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/renew')),
    ).toHaveLength(1);
  });
  it('keeps expired cached ciphertext locked while renewal is offline', async () => {
    const download = encryptPrivatePack(
      makePrivatePack(),
      '123',
      Date.now() - 8 * 86400000,
      Date.now() - 86400000,
    );
    await getDatabase().contentPacks.put({
      packId: 'fixture',
      packVersion: '1.0.0',
      installedAt: 1,
      source: 'discord',
      encryptedEnvelope: download.envelope,
      boundUserId: '123',
      expiresAt: download.envelope.expiresAt,
      ownedBookIds: ['system_core'],
      ownedPresetIds: ['fixture-preset'],
    });
    savePackKeyLease(download.keyLease);
    const store = useContentStore();
    await store.hydratePackState();
    expect(store.leaseState).toBe('LOCKED_EXPIRED');
    expect(getActivePackPayload()).toBeUndefined();
    expect(await store.ensurePackLeaseActive()).toBe(false);
    expect(await getDatabase().contentPacks.count()).toBe(1);
  });
  it('automatically restores the same account after login without restoring session edits', async () => {
    const { store, download } = await install();
    const wb = useWorldBookStore();
    await wb.upsertEntry('system_core', {
      ...wb.books[0].entries[0],
      content: 'discard-on-logout',
    });
    clearDiscordSession();
    respondRenew(await renewPrivatePack(download));
    saveDiscordSession(makeDiscordSession());
    await vi.waitFor(() => expect(store.leaseState).toBe('ACTIVE_UNLOCKED'));
    expect(wb.books[0].entries[0].content).toBe(PRIVATE_TEXT);
  });
  it('does not resurrect an uninstalled pack when a renewal arrives late', async () => {
    const { store, download } = await install();
    const renewed = await renewPrivatePack(download);
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/renew')
          ? new Promise<Response>((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(new Response('', { status: 404 })),
      ),
    );
    const pending = store.renewPackLease();
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect((await store.uninstallPack()).ok).toBe(true);
    finish(
      Response.json({
        ok: true,
        serverTime: Date.now(),
        renewal: renewed.envelope,
        keyLease: renewed.keyLease,
      }),
    );
    await rejected;
    expect(getActivePackPayload()).toBeUndefined();
    expect(discordKeyLease.value).toBeNull();
    expect(await getDatabase().contentPacks.count()).toBe(0);
    expect(store.leaseState).toBe('LOCAL');
  });
  it('rejects late edits to protected ids even after deletion or logout', async () => {
    await install();
    const wb = useWorldBookStore();
    const book = wb.books[0],
      preset = getRuntimePackPresets()[0];
    await wb.deleteBook(book.id);
    await wb.upsertBook(book);
    expect(await getDatabase().worldBooks.count()).toBe(0);
    clearDiscordSession();
    await expect(wb.upsertBook(book)).rejects.toThrow('已锁定');
    await expect(upsertPreset(preset)).rejects.toThrow('已锁定');
    await expect(savePreset(preset)).rejects.toThrow('受保护预设');
    expect(await getDatabase().worldBooks.count()).toBe(0);
    expect(await getDatabase().presets.count()).toBe(0);
    expect(getActivePackPayload()).toBeUndefined();
  });
  it('discards queued cache reads after any protected runtime transition', async () => {
    const db = getDatabase();
    await db.promptSessions.put({
      key: 'queued:story',
      saveId: 'queued',
      agentId: 'story',
      baseline: PRIVATE_TEXT,
    } as never);
    await db.combatSandboxes.put({
      saveId: 'queued',
      private: PRIVATE_TEXT,
    } as unknown as CombatSandboxRecord);
    let release!: () => void;
    const blocker = withSaveWriteLock(
      'queued',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const prompt = createDexiePromptSessionStore().load('queued', 'story');
    const combat = getCombatSandbox('queued');
    installRuntimePack(undefined, true);
    installRuntimePack(undefined, false);
    release();
    await blocker;
    expect(await prompt).toBeNull();
    expect(await combat).toBeUndefined();
  });
  it('cleans all unlabelled legacy packs but preserves explicitly local-file imports', async () => {
    const db = getDatabase(),
      pack = makePrivatePack();
    await db.contentPacks.put({
      packId: pack.packId,
      packVersion: pack.packVersion,
      installedAt: 1,
      payload: pack,
    });
    await db.worldBooks.bulkPut([
      ...pack.worldBooks!,
      { ...pack.worldBooks![0], id: 'user', builtIn: false },
    ]);
    await db.presets.bulkPut([...pack.presets!]);
    await migrateLegacyContentPacks();
    expect((await db.contentPacks.get(pack.packId))?.source).toBe('legacy-locked');
    expect((await db.contentPacks.get(pack.packId))?.payload).toBeUndefined();
    expect(await db.presets.count()).toBe(0);
    expect((await db.worldBooks.toArray()).map((book) => book.id)).toEqual(['user']);
    const store = useContentStore();
    await store.hydratePackState();
    expect(store.leaseState).toBe('LOCKED_LEGACY');
    await store.installPack(pack, { confirmConflicts: true });
    await migrateLegacyContentPacks();
    await purgeProtectedPackPlaintext();
    expect((await db.contentPacks.get(pack.packId))?.source).toBe('local-file');
    expect((await db.contentPacks.get(pack.packId))?.payload).toEqual(pack);
    expect(store.leaseState).toBe('LOCAL');
  });
  it('does not persist derived prompt/session/debug/combat transcripts', async () => {
    await install();
    const db = getDatabase();
    const promptStore = createDexiePromptSessionStore();
    await promptStore.save({
      saveId: 's',
      agentId: 'story',
      baseline: PRIVATE_TEXT,
    } as unknown as Parameters<typeof promptStore.save>[0]);
    await saveDebugTurn({
      id: 'debug',
      saveId: 's',
      private: PRIVATE_TEXT,
    } as unknown as DebugTurnRecord);
    await saveCombatSandbox({
      saveId: 's',
      private: PRIVATE_TEXT,
    } as unknown as CombatSandboxRecord);
    expect(await db.promptSessions.count()).toBe(0);
    expect(await db.debugTurns.count()).toBe(0);
    expect(await db.combatSandboxes.count()).toBe(0);
  });
});
