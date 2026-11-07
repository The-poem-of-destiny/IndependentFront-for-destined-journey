import type { WorldBookEntry, WorldBookPartition } from '../types/types';
import { createUserWorldBookUid } from './worldbook-uid';

/** Import boundary for native ST arrays/records. Source IDs never become runtime IDs. */
export function importUserWorldBookEntries(
  value: Record<string, any> | any[],
  partition: WorldBookPartition,
  defaultAudiences: readonly string[],
): WorldBookEntry[] {
  const rows = Object.entries(value).map(([key, source]) => ({
    source,
    sourceId: String(source.uid ?? key),
    uid: createUserWorldBookUid(partition, source.name || source.comment || ''),
  }));
  const uids = new Map(rows.map((row) => [row.sourceId, row.uid]));
  return rows.map(({ source, uid }) => {
    const { key: _retiredKey, ...lore } = source.extra?.lore ?? {};
    if (Array.isArray(lore.dependsOn))
      lore.dependsOn = lore.dependsOn.map((id: string) => uids.get(id) ?? id);
    if (lore.source?.parentUid)
      lore.source = {
        ...lore.source,
        parentUid: uids.get(lore.source.parentUid) ?? lore.source.parentUid,
      };
    return {
      ...source,
      uid,
      name: source.name || source.comment || '',
      content: source.content || '',
      enabled: source.enabled !== false && source.disable !== true,
      key: source.key || [],
      keysecondary: source.keysecondary || [],
      selectiveLogic: source.selectiveLogic ?? 0,
      order: source.order ?? 100,
      position: source.position ?? 0,
      extra: {
        ...source.extra,
        lore: {
          ...lore,
          audiences: Array.isArray(lore.audiences)
            ? lore.audiences.filter((id: unknown): id is string => typeof id === 'string')
            : [...defaultAudiences],
        },
      },
    };
  });
}
