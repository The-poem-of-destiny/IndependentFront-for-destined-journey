import type {
  CharacterChronicleDraft,
  CharacterProfile,
  CharacterUpdatesParseResult,
} from '../types/types-character';
import type { JsonObject, JsonValue, NativeLlmContent } from '../types/types-api';

const TEXT_FIELDS = [
  'race',
  'appearance',
  'background',
  'personality',
  'gender',
  'outfit',
  'goals',
] as const;
const LIST_FIELDS = ['aliases', 'identity', 'occupation'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reject the character update if its declared profile is invalid; never copy arbitrary keys. */
export function parseCharacterProfile(value: unknown): CharacterProfile | null {
  if (!isRecord(value)) return null;
  const profile: CharacterProfile = {};
  for (const key of Object.keys(value)) {
    if (
      !(TEXT_FIELDS as readonly string[]).includes(key) &&
      !(LIST_FIELDS as readonly string[]).includes(key)
    )
      return null;
  }
  for (const key of TEXT_FIELDS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || !value[key].trim()) return null;
    profile[key] = value[key].trim();
  }
  for (const key of LIST_FIELDS) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !list.every((v) => typeof v === 'string' && v.trim())) return null;
    profile[key] = [...new Set(list.map((v: string) => v.trim()))];
  }
  return profile;
}

export function parseChronicleDraft(value: unknown): CharacterChronicleDraft | null {
  if (!isRecord(value) || !isRecord(value.time)) return null;
  if (
    typeof value.title !== 'string' ||
    !value.title.trim() ||
    typeof value.summary !== 'string' ||
    !value.summary.trim()
  )
    return null;
  if (
    typeof value.importance !== 'number' ||
    !Number.isInteger(value.importance) ||
    value.importance < 0 ||
    value.importance > 10
  )
    return null;
  const time =
    value.time.kind === 'this_turn'
      ? { kind: 'this_turn' as const }
      : value.time.kind === 'past' &&
          typeof value.time.label === 'string' &&
          value.time.label.trim()
        ? { kind: 'past' as const, label: value.time.label.trim() }
        : null;
  if (!time) return null;
  for (const key of ['impact', 'location'])
    if (value[key] !== undefined && typeof value[key] !== 'string') return null;
  if (
    value.people !== undefined &&
    (!Array.isArray(value.people) || !value.people.every((v) => typeof v === 'string'))
  )
    return null;
  return {
    title: value.title.trim(),
    summary: value.summary.trim(),
    importance: value.importance,
    time,
    ...(typeof value.impact === 'string' ? { impact: value.impact.trim() } : {}),
    ...(typeof value.location === 'string' ? { location: value.location.trim() } : {}),
    ...(Array.isArray(value.people)
      ? { people: value.people.map((v: string) => v.trim()).filter(Boolean) }
      : {}),
  };
}

export function parseCharacterUpdates(raw: string): CharacterUpdatesParseResult {
  const present = /<character_updates\b/i.test(raw);
  const result: CharacterUpdatesParseResult = { present, updates: [], warnings: [] };
  if (!present) return result;
  const blocks = [
    ...raw.matchAll(/<character_updates\b[^>]*>([\s\S]*?)<\/character_updates\s*>/gi),
  ];
  if (blocks.length !== 1 || [...raw.matchAll(/<character_updates\b/gi)].length !== 1) {
    result.warnings.push('角色更新未保存：需要一个完整的 character_updates 区块。');
    return result;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0][1]);
  } catch {
    result.warnings.push('角色更新未保存：JSON 格式无效。');
    return result;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.characters)) {
    result.warnings.push('角色更新未保存：缺少 characters 数组。');
    return result;
  }
  const names = new Set<string>();
  for (const row of parsed.characters) {
    if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim()) {
      result.warnings.push('跳过无有效名字的角色更新。');
      continue;
    }
    const name = row.name.trim();
    const profile = parseCharacterProfile(row.profile_changes ?? {});
    if (!profile || !Array.isArray(row.chronicle) || names.has(name)) {
      result.warnings.push(`角色「${name}」更新未保存：档案字段、经历列表或重复名字无效。`);
      continue;
    }
    names.add(name);
    const chronicle: CharacterChronicleDraft[] = [];
    for (const entry of row.chronicle) {
      const draft = parseChronicleDraft(entry);
      if (draft) chronicle.push(draft);
      else result.warnings.push(`角色「${name}」有一条无效经历，已跳过。`);
    }
    result.updates.push({ name, profile_changes: profile, chronicle });
  }
  return result;
}

export function stripCharacterUpdates(raw: string): string {
  return raw
    .replace(/<character_updates\b[^>]*>[\s\S]*?(?:<\/character_updates\s*>|$)/gi, '')
    .trim();
}

/** Provider-native text is also replayed by Delta; keep reasoning/tool blocks untouched. */
export function stripNativeCharacterUpdates(
  native: NativeLlmContent | undefined,
): NativeLlmContent | undefined {
  if (!native) return undefined;
  const next = structuredClone(native);
  if (next.protocol === 'openai-chat') {
    if (typeof next.value.content === 'string')
      next.value.content = stripCharacterUpdates(next.value.content);
    return next;
  }
  const key = next.protocol === 'gemini' ? 'parts' : 'content';
  const blocks = next.value[key];
  if (!Array.isArray(blocks)) return next;
  const visible = (block: JsonValue): block is JsonObject & { text: string } =>
    isRecord(block) &&
    typeof block.text === 'string' &&
    (next.protocol === 'gemini' ? block.thought !== true : block.type === 'text');
  const joined = blocks
    .filter(visible)
    .map((block) => block.text)
    .join('');
  const ranges = [
    ...joined.matchAll(/<character_updates\b[^>]*>[\s\S]*?(?:<\/character_updates\s*>|$)/gi),
  ].map((match) => [match.index!, match.index! + match[0].length]);
  let offset = 0;
  next.value[key] = blocks.flatMap((block) => {
    if (!visible(block)) return [block];
    const start = offset;
    offset += block.text.length;
    let cursor = start;
    let text = '';
    for (const [from, to] of ranges) {
      if (to <= start || from >= offset) continue;
      text += block.text.slice(cursor - start, Math.max(cursor, from) - start);
      cursor = Math.min(offset, to);
    }
    text += block.text.slice(cursor - start);
    return text ? [{ ...block, text }] : [];
  });
  return next;
}
