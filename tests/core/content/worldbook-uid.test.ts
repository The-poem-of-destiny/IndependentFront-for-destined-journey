import { describe, expect, it } from 'vitest';
import type { WorldBook, WorldBookEntry, WorldBookPartition } from '../../../src/core/types/types';
import type { WorkshopInstallInput } from '../../../src/core/workshop/workshop-types';
import {
  createUserWorldBookUid,
  isWorldBookUid,
  uidPartition,
} from '../../../src/core/content/worldbook-uid';
import { importUserWorldBookEntries } from '../../../src/core/content/worldbook-import';
import { validateLoreProtocol } from '../../../src/core/content/lore-protocol';
import { loreEntryKey } from '../../../src/core/content/lore-routing';
import { hashWorldBook, validatePackOrThrow } from '../../../src/core/content/content-source';
import {
  deriveSplitEntryTokenRewrites,
  expandSplitEntryTokens,
  planSaveUidMigration,
} from '../../../src/core/content/content-pack-plan';
import { filterBooksByEnabledEntries } from '../../../src/core/content/worldbook-loader';
import {
  collectActiveSignalsFromEntries,
  resolveAutoEnable,
} from '../../../src/core/story/beautifier';
import { planInstall } from '../../../src/core/workshop/workshop-install-plan';

function entry(uid: string, name = 'Entry'): WorldBookEntry {
  return {
    uid,
    name,
    content: 'body',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 0,
    position: 0,
    extra: { lore: { audiences: ['story'], section: 'fixed' } },
  };
}
function book(
  partition: WorldBookPartition,
  entries: WorldBookEntry[],
  id: string = partition,
): WorldBook {
  return { id, name: id, partition, entries, builtIn: true };
}
const pack = (books: WorldBook[]) => ({
  formatVersion: 1,
  packId: 'uid-test',
  packVersion: '1.0.0',
  loreRoutingVersion: 1,
  worldBooks: books,
});
function workshop(names: string[], id = 'project-a'): WorkshopInstallInput {
  return {
    project: {
      id,
      rootProjectId: id,
      name: id,
      description: '',
      version: '1',
      authorName: 'author',
      tags: [],
      downloadUrl: 'https://example.invalid/book.json',
      fileSize: 1,
    },
    worldbookEntries: names.map((name, order) => ({
      sourceUid: order,
      name,
      content: name,
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order,
      position: 0,
    })),
    regexEntries: [],
  };
}

describe('namespaced world-book identities: clean cut', () => {
  it.each([
    'fated:race/human',
    'placeholder:system_core/default',
    'user:character/custom_a1b2',
    'workshop.a1b2-c3:creative_workshop/custom_rule',
    'fated:character/profile/history',
  ])('accepts %s', (uid) => expect(isWorldBookUid(uid)).toBe(true));
  it.each([
    1,
    '1',
    'character:42',
    'character#42',
    'fated:Character/name',
    'fated:character/名字',
    'fated:character/a/b/c',
    'fated:character/a.js',
    'fated:character/',
    'fated:character/a\n',
  ])('rejects %s', (uid) => {
    expect(isWorldBookUid(uid)).toBe(false);
    expect(uidPartition(uid)).toBeUndefined();
  });
  it('uses entry.uid without book-derived aliases', () => {
    const e = entry('fated:race/human');
    expect(loreEntryKey({ id: 'another-book', lore: { namespace: 'ignored' } }, e)).toBe(e.uid);
  });
  it('rejects numeric, mismatched, duplicate IDs and retired lore.key', () => {
    const b = book('race', [entry('fated:race/human')]);
    expect(validateLoreProtocol([b])).toEqual([]);
    expect(validateLoreProtocol([{ ...b, entries: [{ ...b.entries[0], uid: 1 }] }])).toContain(
      'race: invalid entry uid',
    );
    expect(validateLoreProtocol([book('faction', b.entries)])).toContain(
      'faction: invalid entry uid',
    );
    expect(validateLoreProtocol([b, { ...b, id: 'other' }])).toContain(
      'other: duplicate uid fated:race/human',
    );
    expect(
      validateLoreProtocol([
        {
          ...b,
          entries: [{ ...b.entries[0], extra: { lore: { audiences: ['story'], key: 'old' } } }],
        },
      ]).some((s) => s.includes('unknown lore field key')),
    ).toBe(true);
  });
  it('accepts finite priority and exact parentUid/part provenance, not legacy split shapes', () => {
    const e = entry('fated:character/profile/history');
    e.extra!.lore = {
      audiences: ['story'],
      priority: 1,
      source: { parentUid: 'fated:character/profile', part: 0 },
    };
    expect(validateLoreProtocol([book('character', [e])])).toEqual([]);
    const invalid = structuredClone(e) as any;
    invalid.extra.lore.source = { parentKey: 'character#42', legacyUid: 42, part: 0 };
    expect(
      validateLoreProtocol([book('character', [invalid])]).some((s) =>
        s.includes('invalid split source'),
      ),
    ).toBe(true);
  });
  it('hashes by lexical UID order independent of input order', () => {
    const a = entry('fated:race/z', 'Z'),
      b = entry('fated:race/a', 'A');
    expect(hashWorldBook(book('race', [a, b]))).toBe(hashWorldBook(book('race', [b, a])));
  });
  it('validates IDs and beautifier bindings at the pack boundary', () => {
    const b = book('race', [entry('fated:race/human')]);
    expect(validatePackOrThrow(pack([b])).filter((n) => n.level === 'error')).toEqual([]);
    const placeholder = book('race', [entry('placeholder:race/human')]);
    expect(validatePackOrThrow(pack([placeholder])).map((n) => n.code)).toContain(
      'placeholder-uid-range',
    );
    const malformed = {
      ...pack([b]),
      worldBooks: [{ ...b, entries: [{ ...b.entries[0], uid: 901501 }] }],
    };
    expect(validatePackOrThrow(malformed).map((n) => n.code)).toContain('bad-worldbook-entry');
    expect(
      validatePackOrThrow({
        ...pack([b]),
        beautifierRules: {
          version: 1,
          rules: [{ id: 'rule', autoEnable: { worldBookEntryUids: [42] } }],
        },
      }).map((n) => n.code),
    ).toContain('bad-beautifier-section');
    const noRevision = {
      ...pack([b]),
      loreRoutingVersion: undefined,
      worldBooks: [{ ...b, entries: [{ ...b.entries[0], extra: { lore: { key: 'retired' } } }] }],
    };
    expect(validatePackOrThrow(noRevision).some((n) => n.level === 'error')).toBe(true);
  });
});

describe('direct enabled UIDs and split expansion', () => {
  it('keeps namespaces distinct within one partition and ignores old numeric tokens', () => {
    const a = book('creative_workshop', [entry('workshop.a:creative_workshop/rule')], 'workshop:a');
    const b = book('creative_workshop', [entry('workshop.b:creative_workshop/rule')], 'workshop:b');
    expect(
      filterBooksByEnabledEntries([a, b], [a.entries[0].uid]).map((v) => v.entries.length),
    ).toEqual([1, 0]);
    expect(filterBooksByEnabledEntries([a], ['creative_workshop:1'])[0]).toBe(a);
  });
  it('preserves explicit built-in core and character save-selection behavior', () => {
    const core = entry('fated:system_core/default');
    core.enabled = false;
    const npc = entry('fated:character/guide');
    npc.enabled = false;
    const books = [book('system_core', [core]), book('character', [npc])];
    expect(
      filterBooksByEnabledEntries(books, [core.uid, npc.uid]).map((v) => v.entries[0].enabled),
    ).toEqual([true, true]);
    expect(filterBooksByEnabledEntries(books, [core.uid])[1].entries).toEqual([]);
    expect(core.enabled).toBe(false);
  });
  it('expands explicit parents in part order, deduplicates, and preserves an existing parent', () => {
    const parent = 'fated:character/profile';
    const part = (slug: string, index: number) => {
      const e = entry(`${parent}/${slug}`);
      e.extra!.lore!.source = { parentUid: parent, part: index };
      return e;
    };
    const b = book('character', [part('history', 1), part('basic', 0)]);
    const expected = [`${parent}/basic`, `${parent}/history`];
    expect(deriveSplitEntryTokenRewrites([b])).toEqual({ [parent]: expected });
    expect(expandSplitEntryTokens([b], [parent, expected[0], 'user:race/custom'])).toEqual([
      ...expected,
      'user:race/custom',
    ]);
    expect(expandSplitEntryTokens([b], expected)).toEqual(expected);
    expect(
      deriveSplitEntryTokenRewrites([{ ...b, entries: [...b.entries, entry(parent)] }]),
    ).toEqual({});
  });
  it('pairs placeholders by partition and name without touching user, workshop or numeric history', () => {
    const old = book('system_core', [entry('placeholder:system_core/guide', 'Guide')]);
    const actual = book('system_core', [entry('fated:system_core/guide', 'Guide')]);
    const result = planSaveUidMigration(
      [actual],
      [old],
      [old.entries[0].uid, 'user:system_core/custom', 'system_core:900001'],
      [],
    );
    expect(result.rewrite).toEqual({ [old.entries[0].uid]: actual.entries[0].uid });
    expect(result.needsSelectionPartitions).toEqual([]);
    expect(
      planSaveUidMigration([actual], [], [old.entries[0].uid], []).needsSelectionPartitions,
    ).toEqual(['system_core']);
    const notes: any[] = [];
    planSaveUidMigration([], [], ['placeholder:race/missing'], notes);
    expect(notes[0].kind).toBe('sideEffect');
  });
  it('builds beautifier signals from full UIDs, not numeric or namespace-stripped aliases', () => {
    const uid = 'fated:system_core/guide';
    const signals = collectActiveSignalsFromEntries([
      uid,
      'user:character/custom',
      'fated:character/profile/history',
      'character:1',
    ]);
    expect([...signals.activeWorldBookIds]).toEqual(['system_core', 'character']);
    expect([...signals.activeEntryUids]).toEqual([
      uid,
      'user:character/custom',
      'fated:character/profile/history',
    ]);
    const rule = { id: 'bound', enabled: false, autoEnable: { worldBookEntryUids: [uid] } } as any;
    expect(
      resolveAutoEnable([rule], new Set(), signals.activeEntryUids, new Set())[0].enabled,
    ).toBe(true);
    expect(
      resolveAutoEnable([rule], new Set(), new Set(['user:system_core/guide']), new Set())[0]
        .enabled,
    ).toBe(false);
  });
});

describe('workshop and user UID creation', () => {
  it('is deterministic across machines and installation order, including non-ASCII names and stem collisions', () => {
    const input = workshop(['Custom Rule', 'custom-rule', '规则', '规则二']);
    const first = planInstall(input, {});
    expect(
      first.entries.every(
        (e) => isWorldBookUid(e.uid) && e.uid.startsWith('workshop.project-a:creative_workshop/'),
      ),
    ).toBe(true);
    expect(new Set(first.entries.map((e) => e.uid)).size).toBe(4);
    expect(
      planInstall({ ...input, worldbookEntries: [...input.worldbookEntries].reverse() }, {})
        .entries.map((e) => e.uid)
        .sort(),
    ).toEqual(first.entries.map((e) => e.uid).sort());
    expect(planInstall(workshop(['Custom Rule'], 'project-b'), {}).entries[0].uid).not.toBe(
      first.entries[0].uid,
    );
    expect(first).not.toHaveProperty('nextUid');
    expect(first).not.toHaveProperty('uidRange');
    expect(first).not.toHaveProperty('allocatedUidRange');
  });
  it('keeps survivor identities on update and detects local body edits', () => {
    const input = workshop(['Rule']);
    const first = planInstall(input, {});
    const edited = { ...first.entries[0], content: 'locally edited' };
    const next = planInstall(
      { ...input, worldbookEntries: [{ ...input.worldbookEntries[0], content: 'new upstream' }] },
      { existingEntries: [edited] },
    );
    expect(next.entries[0].uid).toBe(first.entries[0].uid);
    expect(next.conflicts[0].uid).toBe(first.entries[0].uid);
    expect(planInstall(workshop([]), { existingEntries: first.entries }).retiredUids).toEqual([
      first.entries[0].uid,
    ]);
  });
  it('separates duplicate names and rejects unsafe project namespaces', () => {
    const result = planInstall(workshop(['Rule', 'Rule']), {});
    expect(new Set(result.entries.map((e) => e.uid)).size).toBe(2);
    expect(() => planInstall(workshop(['Rule'], 'invalid/id'), {})).toThrow(
      'Invalid workshop project ID',
    );
  });
  it('creates unique user UIDs with safe ASCII stems', () => {
    const a = createUserWorldBookUid('race', 'Custom Name');
    const b = createUserWorldBookUid('race', 'Custom Name');
    expect(a).toMatch(/^user:race\/custom_name_[a-f0-9]{12}$/);
    expect(b).not.toBe(a);
    expect(isWorldBookUid(createUserWorldBookUid('character', '中文条目'))).toBe(true);
  });
  it('imports ST object or array entries into user namespace without changing content or unknown metadata', () => {
    const source = {
      uid: 1,
      comment: '规则',
      content: '中文\r\n正文',
      disable: true,
      constant: true,
      custom: { keep: 1 },
      extra: { custom: { keep: 2 }, lore: { audiences: [], key: 'retired' } },
    };
    const original = JSON.stringify(source);
    const result = importUserWorldBookEntries({ '1': source }, 'world_setting', ['story']);
    expect(result[0].uid).toMatch(/^user:world_setting\/entry_/);
    expect(result[0]).toMatchObject({
      content: source.content,
      enabled: false,
      constant: true,
      custom: { keep: 1 },
      extra: { custom: { keep: 2 }, lore: { audiences: [] } },
    });
    expect(result[0].extra!.lore).not.toHaveProperty('key');
    expect(JSON.stringify(source)).toBe(original);
    expect(importUserWorldBookEntries([source], 'world_setting', ['story'])[0].uid).not.toBe(
      result[0].uid,
    );
  });
  it('rewrites internal namespaced dependencies at the ST import boundary while keeping external references', () => {
    const a = entry('user:race/a', 'A'),
      b = entry('user:race/b', 'B');
    b.extra!.lore!.dependsOn = [a.uid, 'fated:race/human'];
    const imported = importUserWorldBookEntries([a, b], 'race', ['story']);
    expect(imported[1].extra!.lore!.dependsOn).toEqual([imported[0].uid, 'fated:race/human']);
    expect(b.extra!.lore!.dependsOn).toEqual([a.uid, 'fated:race/human']);
  });
});
