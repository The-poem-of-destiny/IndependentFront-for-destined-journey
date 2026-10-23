import { it, expect } from 'vitest';
import { validateLoreProtocol } from '../../../src/core/content/lore-protocol';
import { validatePackOrThrow } from '../../../src/core/content/content-source';
const books = () => [
  {
    id: 'sample',
    name: 'sample',
    partition: 'world_setting',
    entries: [
      {
        uid: 1,
        name: 'a',
        content: 'synthetic',
        enabled: true,
        extra: { lore: { key: 'a', section: 'turn', audiences: ['story'] } },
      },
    ],
  },
];
it('revisioned install validates disabled entries, malformed declarations and cycles without executing bodies', () => {
  const b = books();
  b[0].entries[0].content = '<% throw new Error("never run"); %>';
  expect(validateLoreProtocol(b)).toEqual([]);
  const malformed = structuredClone(b) as unknown as Array<{ lore: unknown }>;
  malformed[0].lore = { audiences: 'story' };
  expect(validateLoreProtocol(malformed)).toContain('sample: invalid audiences');
  const bookScoped = books() as unknown as Array<{ lore: unknown }>;
  bookScoped[0].lore = { audiences: ['story'] };
  expect(validateLoreProtocol(bookScoped)).toContain(
    'sample: audiences must be declared per entry, not on the book',
  );
  b[0].entries[0].enabled = false;
  Object.assign(b[0].entries[0].extra.lore, { dependsOn: ['a'] });
  expect(validateLoreProtocol(b)).toContain('a: dependency cycle');
  const errors = validatePackOrThrow({
    formatVersion: 1,
    packId: 'sample',
    packVersion: '1.0.0',
    loreRoutingVersion: 1,
    worldBooks: b,
  });
  expect(errors.some((n) => n.code === 'bad-lore-routing')).toBe(true);
  expect(
    validatePackOrThrow({
      formatVersion: 1,
      packId: 'sample',
      packVersion: '1.0.0',
      loreRoutingVersion: 2,
    }).some((n) => n.code === 'bad-lore-routing-version'),
  ).toBe(true);
});
