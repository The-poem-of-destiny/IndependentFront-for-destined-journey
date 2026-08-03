import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  rows: new Map<string, { key: string; value: string; updatedAt: number }>(),
  failLoad: false,
  transactions: 0,
}));

vi.mock('@engine/database', () => {
  const table = {
    async toArray() {
      if (fake.failLoad) throw new Error('IndexedDB unavailable');
      return [...fake.rows.values()];
    },
    async put(row: { key: string; value: string; updatedAt: number }) {
      fake.rows.set(row.key, row);
    },
    async delete(key: string) {
      fake.rows.delete(key);
    },
    async clear() {
      fake.rows.clear();
    },
  };
  return {
    getDatabase: () => ({
      regexStorage: table,
      async transaction(_mode: string, _table: unknown, run: () => Promise<void>) {
        fake.transactions += 1;
        return run();
      },
    }),
  };
});

async function subject() {
  vi.resetModules();
  return import('./beautifier-storage');
}

describe('beautifier shared storage', () => {
  beforeEach(() => {
    fake.rows.clear();
    fake.failLoad = false;
    fake.transactions = 0;
  });

  it('hydrates synchronously after open, persists batches, and fans out to other sessions', async () => {
    fake.rows.set('theme', { key: 'theme', value: 'night', updatedAt: 1 });
    const { openBeautifierStorageSession } = await subject();
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    const first = await openBeautifierStorageSession((batch) => firstEvents.push(batch));
    const second = await openBeautifierStorageSession((batch) => secondEvents.push(batch));

    expect(first.snapshot()).toEqual([['theme', 'night']]);
    await first.commit([{ kind: 'set', key: 'font', value: 'large' }]);

    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([[{ kind: 'set', key: 'font', value: 'large' }]]);
    expect(second.snapshot()).toEqual([
      ['theme', 'night'],
      ['font', 'large'],
    ]);
    expect(fake.rows.get('font')?.value).toBe('large');

    second.close();
    await first.commit([{ kind: 'remove', key: 'theme' }]);
    expect(secondEvents).toHaveLength(1);
  });

  it('serializes concurrent batches and treats clear as an ordered barrier', async () => {
    const { openBeautifierStorageSession } = await subject();
    const session = await openBeautifierStorageSession(() => undefined);

    const beforeClear = session.commit([{ kind: 'set', key: 'old', value: '1' }]);
    const clearAndReplace = session.commit([
      { kind: 'clear' },
      { kind: 'set', key: 'new', value: '2' },
    ]);
    await Promise.all([beforeClear, clearAndReplace]);

    expect(session.snapshot()).toEqual([['new', '2']]);
    expect([...fake.rows.keys()]).toEqual(['new']);
    expect(fake.transactions).toBe(2);
  });

  it('enforces UTF-8 key, key-count, and total-byte limits before writing', async () => {
    const { openBeautifierStorageSession } = await subject();
    const session = await openBeautifierStorageSession(() => undefined);

    await expect(
      session.commit([{ kind: 'set', key: '界'.repeat(1366), value: '' }]),
    ).rejects.toHaveProperty('name', 'QuotaExceededError');

    const tooMany = Array.from({ length: 1025 }, (_, index) => ({
      kind: 'set' as const,
      key: `k${index}`,
      value: '',
    }));
    await expect(session.commit(tooMany)).rejects.toHaveProperty('name', 'QuotaExceededError');

    await expect(
      session.commit([{ kind: 'set', key: 'large', value: 'x'.repeat(5 * 1024 * 1024) }]),
    ).rejects.toHaveProperty('name', 'QuotaExceededError');
    expect(fake.transactions).toBe(0);
  });

  it('falls back to one shared empty in-memory namespace when initial loading fails', async () => {
    fake.failLoad = true;
    const { openBeautifierStorageSession } = await subject();
    const updates: unknown[] = [];
    const first = await openBeautifierStorageSession(() => undefined);
    const second = await openBeautifierStorageSession((batch) => updates.push(batch));

    expect(first.snapshot()).toEqual([]);
    await first.commit([{ kind: 'set', key: 'memory', value: 'ok' }]);

    expect(second.snapshot()).toEqual([['memory', 'ok']]);
    expect(updates).toEqual([[{ kind: 'set', key: 'memory', value: 'ok' }]]);
    expect(fake.transactions).toBe(0);
  });

  it('does not hydrate persisted rows that exceed the public namespace limits', async () => {
    fake.rows.set('large', {
      key: 'large',
      value: 'x'.repeat(5 * 1024 * 1024),
      updatedAt: 1,
    });
    const { openBeautifierStorageSession } = await subject();
    const session = await openBeautifierStorageSession(() => undefined);

    expect(session.snapshot()).toEqual([]);
    await session.commit([{ kind: 'set', key: 'memory', value: 'ok' }]);
    expect(session.snapshot()).toEqual([['memory', 'ok']]);
    expect(fake.transactions).toBe(0);
  });

  it('re-hydrates after the last session closes so backup imports become visible', async () => {
    fake.rows.set('before', { key: 'before', value: 'old', updatedAt: 1 });
    const { openBeautifierStorageSession } = await subject();
    const first = await openBeautifierStorageSession(() => undefined);
    expect(first.snapshot()).toEqual([['before', 'old']]);
    first.close();

    fake.rows.clear();
    fake.rows.set('after', { key: 'after', value: 'restored', updatedAt: 2 });

    const reopened = await openBeautifierStorageSession(() => undefined);
    expect(reopened.snapshot()).toEqual([['after', 'restored']]);
  });
});
