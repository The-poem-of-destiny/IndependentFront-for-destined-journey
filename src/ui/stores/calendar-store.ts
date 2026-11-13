/**
 * 日历 store —— 当前存档那一行 `saveCalendars` 的响应式投影。
 *
 * 真源在 Dexie（`@engine/calendar/calendar-store`）；这里只缓存「正在看的那个存档」的一份，
 * 每次写入都以引擎返回的最新行替换，不在前端另算一份状态。
 * 日历完全本地：这里的任何数据都不进入提示词。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  defaultSaveCalendar,
  getSaveCalendar,
  persistCalendarEntry,
  persistCalendarMode,
  persistCalendarVisibility,
  removeCalendarEntry,
} from '@engine/calendar/calendar-store';
import type { CalendarMode, CalendarUserEntry, SaveCalendar } from '@engine/types/types-calendar';

export const useCalendarStore = defineStore('calendar', () => {
  const calendar = ref<SaveCalendar | null>(null);

  /** 切档 / 打开日历时调用。读到的行属于别的存档（切档竞态）就丢弃。 */
  async function load(saveId: string): Promise<void> {
    if (calendar.value?.saveId !== saveId) calendar.value = defaultSaveCalendar(saveId);
    const row = await getSaveCalendar(saveId);
    if (calendar.value?.saveId === saveId) calendar.value = row;
  }

  function accept(row: SaveCalendar): void {
    if (calendar.value?.saveId === row.saveId) calendar.value = row;
  }

  async function setMode(saveId: string, mode: CalendarMode): Promise<void> {
    accept(await persistCalendarMode(saveId, mode));
  }

  async function saveEntry(
    saveId: string,
    entry: Omit<CalendarUserEntry, 'createdAt'>,
  ): Promise<void> {
    accept(await persistCalendarEntry(saveId, entry));
  }

  async function deleteEntry(saveId: string, entryId: string): Promise<void> {
    accept(await removeCalendarEntry(saveId, entryId));
  }

  async function setVisibility(
    saveId: string,
    patch: Parameters<typeof persistCalendarVisibility>[1],
  ): Promise<void> {
    accept(await persistCalendarVisibility(saveId, patch));
  }

  return { calendar, load, setMode, saveEntry, deleteEntry, setVisibility };
});
