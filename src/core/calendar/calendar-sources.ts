/**
 * 日历的三类来源 → 统一的 `CalendarItem`。纯函数：不读时钟、不做 I/O。
 *
 * 🔴 本目录的任何模块都不得被 `prompts/` `agents/` `memory/` 引用 —— 日历 v1 不向模型发送
 *    任何内容（`tests/calendar-isolation-gate.test.ts` 钉着这条）。
 */
import type { CharacterState } from '../types/types';
import type { CalendarItem, CalendarUserEntry } from '../types/types-calendar';
import type { CollectedLoreKeyDate } from '../content/lore-key-dates';
import { hasGivenBirthday } from '../character/character-age';

/** 世界书关键日期 → 节庆项。`public: false` 的不自动出现在日历上。 */
export function deriveFestivalItems(collected: readonly CollectedLoreKeyDate[]): CalendarItem[] {
  return collected
    .filter(({ date }) => date.public !== false)
    .map(({ key, date }) => ({
      key,
      kind: 'festival' as const,
      title: date.name,
      when: date.when,
      ...(date.repeat ? { repeat: date.repeat } : {}),
      ...(date.summary ? { note: date.summary } : {}),
      ...(date.regions?.length ? { regions: [...date.regions] } : {}),
      ...(date.approximate ? { approximate: true } : {}),
      ...(date.major ? { major: true } : {}),
      ...(date.category ? { category: date.category } : {}),
      ...(date.timeNote ? { timeNote: date.timeNote } : {}),
      ...(date.tags?.length ? { tags: [...date.tags] } : {}),
      ...(date.highlights?.length ? { highlights: date.highlights } : {}),
    }));
}

/**
 * 已登场的主角与 NPC 的生日。只收「生日是给定的」角色：没给生日的角色锚点里是兜底的
 * 1 月 1 日，全收进来会让那一天堆满路人。
 */
export function deriveBirthdayItems(characters: readonly CharacterState[]): CalendarItem[] {
  const items: CalendarItem[] = [];
  for (const character of characters) {
    if (character.type !== 'player' && character.type !== 'npc') continue;
    const anchor = character.ageAnchor;
    if (!anchor || !hasGivenBirthday(character)) continue;
    items.push({
      key: `birthday:${character.id}`,
      kind: 'birthday',
      title: character.name,
      when: { precision: 'day', start: { month: anchor.month, day: anchor.day } },
      ageAnchor: { ...anchor },
    });
  }
  return items;
}

/** 玩家条目 → 日历项。给了 `year` 的只在那一年出现，否则每年重复。 */
export function userEntryItems(entries: readonly CalendarUserEntry[]): CalendarItem[] {
  return entries.map((entry) => ({
    key: `user:${entry.id}`,
    kind: 'user' as const,
    title: entry.title,
    when: {
      precision: 'day' as const,
      start: { ...entry.start },
      ...(entry.end ? { end: { ...entry.end } } : {}),
    },
    ...(entry.year !== undefined ? { repeat: { unit: 'once' as const, year: entry.year } } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  }));
}
