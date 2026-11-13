/**
 * 每存档日历的读写（Dexie `saveCalendars`，每存档一行）。
 *
 * - 缺行即默认值：旧存档无需迁移，首次修改时才写入。
 * - 不进快照：日历是玩家的笔记而不是世界状态，回退回合不应抹掉刚记下的日子。
 * - 写入一律进本存档写队列，锁内重读后只改要改的那部分（纪律同 `persistFocusQuest`）。
 */
import { getDatabase } from '../persistence/database';
import { withSaveWriteLock } from '../state/state-write-queue';
import type {
  CalendarAutoKind,
  CalendarMode,
  CalendarMonthDay,
  CalendarUserEntry,
  SaveCalendar,
} from '../types/types-calendar';

const AUTO_KINDS: readonly CalendarAutoKind[] = ['festival', 'birthday'];

export function defaultSaveCalendar(saveId: string): SaveCalendar {
  return {
    saveId,
    mode: 'normal',
    entries: [],
    hiddenKinds: [],
    hiddenRegions: [],
    hiddenKeys: [],
    localRegionOnly: false,
    updatedAt: 0,
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))]
    : [];

function coerceMonthDay(value: unknown): CalendarMonthDay | null {
  return isObject(value) && isInt(value.month, 1, 12) && isInt(value.day, 1, 30)
    ? { month: value.month, day: value.day }
    : null;
}

/** 玩家条目的容错读取；标题为空或日期不合法的返回 null。 */
function coerceCalendarUserEntry(value: unknown): CalendarUserEntry | null {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const start = coerceMonthDay(value.start);
  if (!title || !start) return null;
  const end = value.end === undefined ? undefined : coerceMonthDay(value.end);
  if (end === null) return null;
  // 给了年份却不是整数：整条判无效。悄悄丢掉会把「仅某一年」变成「每年重复」
  if (value.year !== undefined && !Number.isInteger(value.year)) return null;
  const note = typeof value.note === 'string' ? value.note.trim() : '';
  return {
    id: value.id,
    title,
    start,
    ...(end && (end.month !== start.month || end.day !== start.day) ? { end } : {}),
    ...(value.year !== undefined ? { year: value.year as number } : {}),
    ...(note ? { note } : {}),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
  };
}

/** 库里读出来的行不直接信任（可能来自旧备份或手改）：认不出的部分回落默认值，永不抛。 */
export function coerceSaveCalendar(saveId: string, value: unknown): SaveCalendar {
  const base = defaultSaveCalendar(saveId);
  if (!isObject(value)) return base;
  const ids = new Set<string>();
  const entries: CalendarUserEntry[] = [];
  for (const raw of Array.isArray(value.entries) ? value.entries : []) {
    const entry = coerceCalendarUserEntry(raw);
    if (!entry || ids.has(entry.id)) continue;
    ids.add(entry.id);
    entries.push(entry);
  }
  return {
    saveId,
    mode: value.mode === 'immersive' ? 'immersive' : 'normal',
    entries,
    hiddenKinds: AUTO_KINDS.filter(
      (kind) => Array.isArray(value.hiddenKinds) && value.hiddenKinds.includes(kind),
    ),
    hiddenRegions: textList(value.hiddenRegions),
    hiddenKeys: textList(value.hiddenKeys),
    localRegionOnly: value.localRegionOnly === true,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
  };
}

export async function getSaveCalendar(saveId: string): Promise<SaveCalendar> {
  return coerceSaveCalendar(saveId, await getDatabase().saveCalendars.get(saveId));
}

async function mutate(
  saveId: string,
  change: (calendar: SaveCalendar) => void,
): Promise<SaveCalendar> {
  return withSaveWriteLock(saveId, async () => {
    const calendar = await getSaveCalendar(saveId);
    change(calendar);
    calendar.updatedAt = Date.now();
    await getDatabase().saveCalendars.put(calendar);
    return calendar;
  });
}

/** 切换模式。不删除任何数据：玩家条目与隐藏选择原样保留。 */
export function persistCalendarMode(saveId: string, mode: CalendarMode): Promise<SaveCalendar> {
  return mutate(saveId, (calendar) => {
    calendar.mode = mode === 'immersive' ? 'immersive' : 'normal';
  });
}

/** 新增或更新一条玩家条目（按 id）。条目不合法时抛错，不写库。 */
export function persistCalendarEntry(
  saveId: string,
  entry: Omit<CalendarUserEntry, 'createdAt'> & { createdAt?: number },
): Promise<SaveCalendar> {
  const next = coerceCalendarUserEntry({ ...entry, createdAt: entry.createdAt ?? Date.now() });
  if (!next) throw new Error('invalid calendar entry');
  return mutate(saveId, (calendar) => {
    const index = calendar.entries.findIndex((e) => e.id === next.id);
    if (index < 0) calendar.entries.push(next);
    else calendar.entries[index] = { ...next, createdAt: calendar.entries[index].createdAt };
  });
}

export function removeCalendarEntry(saveId: string, entryId: string): Promise<SaveCalendar> {
  return mutate(saveId, (calendar) => {
    calendar.entries = calendar.entries.filter((e) => e.id !== entryId);
  });
}

export type CalendarHiddenTarget =
  { kind: CalendarAutoKind } | { region: string } | { key: string };

function withMember<T>(list: readonly T[], value: T, present: boolean): T[] {
  const rest = list.filter((v) => v !== value);
  return present ? [...rest, value] : rest;
}

/**
 * 隐藏或恢复**一项**（类别 / 地区 / 单项）。
 *
 * 刻意是增量而不是「整份列表替换」：界面手里那份列表可能是旧的，连点两下时
 * 第二次的整份替换会把第一次的改动盖掉。增量在锁内对着刚读出来的行应用，不会丢。
 */
export function persistCalendarHidden(
  saveId: string,
  target: CalendarHiddenTarget,
  hidden: boolean,
): Promise<SaveCalendar> {
  return mutate(saveId, (calendar) => {
    if ('kind' in target) {
      if (!AUTO_KINDS.includes(target.kind)) return;
      calendar.hiddenKinds = withMember(calendar.hiddenKinds, target.kind, hidden);
    } else if ('region' in target) {
      if (target.region)
        calendar.hiddenRegions = withMember(calendar.hiddenRegions, target.region, hidden);
    } else if (target.key) {
      calendar.hiddenKeys = withMember(calendar.hiddenKeys, target.key, hidden);
    }
  });
}

export function persistCalendarLocalRegionOnly(
  saveId: string,
  localRegionOnly: boolean,
): Promise<SaveCalendar> {
  return mutate(saveId, (calendar) => {
    calendar.localRegionOnly = localRegionOnly === true;
  });
}

/**
 * 单存档导入时重映射：换上新存档 id，并把 `birthday:<旧角色 id>` 换成新角色 id。
 * 映射不到的生日键丢弃（那个角色不在这份备份里）。
 */
export function remapSaveCalendar(
  value: unknown,
  newSaveId: string,
  mapCharacterId: (oldId: string) => string | undefined,
): SaveCalendar {
  const calendar = coerceSaveCalendar(newSaveId, value);
  calendar.hiddenKeys = calendar.hiddenKeys.flatMap((key) => {
    if (!key.startsWith('birthday:')) return [key];
    const mapped = mapCharacterId(key.slice('birthday:'.length));
    return mapped ? [`birthday:${mapped}`] : [];
  });
  return calendar;
}
