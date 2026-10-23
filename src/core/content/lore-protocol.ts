/** Install-time validation for explicitly revisioned routing packs. Legacy-pack compatibility mapping was removed. */
import type { WorldBook } from '../types/types';
import { collectLoreRoutingIssues, loreEntryKey } from './lore-routing';
const AGENTS = [
  'story',
  'lore_select',
  'memory_recall',
  'plot_pre_check',
  'craft_gen',
  'char_gen',
  'item_gen',
  'memory_summary',
  'plot_post_check',
  'plot_outline',
  'request_dispatcher',
  'vars_update',
  'combat',
  'combat_enemy',
  'image_prompt',
];
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) =>
  Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim().length > 0);
export function validateLoreProtocol(books: unknown): string[] {
  if (!Array.isArray(books)) return ['worldBooks must be an array'];
  const errors: string[] = [];
  const meta = (value: unknown, scope: string, entry: boolean) => {
    if (value === undefined) return;
    if (!object(value)) {
      errors.push(`${scope}: lore must be an object`);
      return;
    }
    const fields = entry
      ? [
          'key',
          'audiences',
          'section',
          'summary',
          'aliases',
          'category',
          'activation',
          'dependsOn',
          'required',
          'source',
        ]
      : ['audiences', 'section', 'category', 'namespace'];
    for (const key of Object.keys(value))
      if (!fields.includes(key)) errors.push(`${scope}: unknown lore field ${key}`);
    // 读取范围与分区必须逐条目声明：书级（原「类」级）声明已取消（旧包兼容也已移除），
    // 新包在安装校验时直接拒绝，避免退回按整本分类书批量授权。
    if (!entry) {
      if (value.audiences !== undefined)
        errors.push(`${scope}: audiences must be declared per entry, not on the book`);
      if (value.section !== undefined)
        errors.push(`${scope}: section must be declared per entry, not on the book`);
    }
    if (value.audiences !== undefined && !strings(value.audiences))
      errors.push(`${scope}: invalid audiences`);
    if (value.section !== undefined && !['fixed', 'region', 'turn'].includes(String(value.section)))
      errors.push(`${scope}: invalid section`);
    for (const field of ['key', 'summary', 'namespace', 'category'])
      if (value[field] !== undefined && typeof value[field] !== 'string')
        errors.push(`${scope}: invalid ${field}`);
    if (value.aliases !== undefined && !strings(value.aliases))
      errors.push(`${scope}: invalid aliases`);
    if (value.dependsOn !== undefined && !strings(value.dependsOn))
      errors.push(`${scope}: invalid dependsOn`);
    if (value.required !== undefined && typeof value.required !== 'boolean')
      errors.push(`${scope}: invalid required`);
    if (value.activation !== undefined) {
      if (!object(value.activation)) errors.push(`${scope}: invalid activation`);
      else
        for (const [key, val] of Object.entries(value.activation)) {
          if (
            !['locations', 'characters', 'keywords', 'excludeKeywords'].includes(key) ||
            !strings(val)
          )
            errors.push(`${scope}: invalid activation.${key}`);
        }
    }
    if (value.source !== undefined) {
      const s = value.source;
      if (
        !object(s) ||
        typeof s.parentKey !== 'string' ||
        !s.parentKey.trim() ||
        !Number.isInteger(s.legacyUid) ||
        !Number.isInteger(s.part) ||
        Number(s.part) < 0
      )
        errors.push(`${scope}: invalid split source`);
    }
  };
  for (const b of books) {
    if (!object(b) || !Array.isArray(b.entries)) {
      errors.push('invalid worldBook');
      continue;
    }
    meta(b.lore, String(b.id), false);
    const uids = new Set<number>();
    for (const e of b.entries) {
      if (!object(e) || !Number.isInteger(e.uid)) {
        errors.push(`${b.id}: invalid entry uid`);
        continue;
      }
      if (uids.has(Number(e.uid))) errors.push(`${b.id}: duplicate uid ${e.uid}`);
      uids.add(Number(e.uid));
      meta(object(e.extra) ? e.extra.lore : undefined, `${b.id}#${e.uid}`, true);
    }
  }
  if (errors.length) return errors;
  const typed = books as WorldBook[];
  // Validate disabled records too: enabling one later must not reveal an invalid graph.
  const all = typed.map((b) => ({
    ...b,
    entries: b.entries.map((e) => ({ ...e, enabled: true })),
  }));
  errors.push(
    ...collectLoreRoutingIssues(all, AGENTS).map(
      (i) => `${i.key}: ${i.kind}${i.detail ? ` (${i.detail})` : ''}`,
    ),
  );
  const entries = new Map(
    all.flatMap((b) => b.entries.map((e) => [loreEntryKey(b, e), e] as const)),
  );
  const done = new Set<string>(),
    visiting = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) {
      errors.push(`${key}: dependency cycle`);
      return;
    }
    if (done.has(key)) return;
    visiting.add(key);
    for (const dep of entries.get(key)?.extra?.lore?.dependsOn ?? [])
      if (entries.has(dep)) visit(dep);
    visiting.delete(key);
    done.add(key);
  };
  for (const key of entries.keys()) visit(key);
  return errors;
}
