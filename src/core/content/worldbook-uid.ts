/** World-book identity is shared by routing, save selections and beautifier bindings. */
const UID_PATTERN = /^[a-z0-9_]+(?:\.[a-z0-9_-]+)*:[a-z0-9_]+\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)?$/;

export function isWorldBookUid(value: unknown): value is string {
  return typeof value === 'string' && UID_PATTERN.test(value);
}

export function uidPartition(value: unknown): string | undefined {
  if (!isWorldBookUid(value)) return undefined;
  return value.slice(value.indexOf(':') + 1, value.indexOf('/'));
}

/** Normalized titles are only stems; callers supply the uniqueness suffix. */
export function worldBookUidStem(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'entry'
  );
}

/** ST source IDs are provenance, never the identity of a newly imported local entry. */
export function createUserWorldBookUid(partition: string, name: string): string {
  const uid = `user:${partition}/${worldBookUidStem(name)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (!isWorldBookUid(uid)) throw new Error(`Invalid world-book partition: ${partition}`);
  return uid;
}
