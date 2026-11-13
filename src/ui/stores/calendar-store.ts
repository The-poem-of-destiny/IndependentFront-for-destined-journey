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
  getSaveCalendar,
  persistCalendarEntry,
  persistCalendarHidden,
  persistCalendarLocalRegionOnly,
  persistCalendarMode,
  removeCalendarEntry,
  type CalendarHiddenTarget,
} from '@engine/calendar/calendar-store';
import type { CalendarMode, CalendarUserEntry, SaveCalendar } from '@engine/types/types-calendar';

export const useCalendarStore = defineStore('calendar', () => {
  /**
   * 🔴 读到之前是 `null`，**不放默认值顶替**：默认值是普通模式，而沉浸模式的存档在读取完成前
   *    （或读取失败后）若被当成普通模式，界面就会把本不该出现的节庆与生日露出来。
   */
  const calendar = ref<SaveCalendar | null>(null);
  /** 最近一次读取是否失败（针对 `failedSaveId` 那个存档） */
  const failedSaveId = ref<string | null>(null);

  /** 最近一次请求读取的存档：先发出的读取后返回时，据此丢弃过期结果 */
  let requested: string | null = null;

  /** 切档 / 打开日历时调用。只有最近一次请求的结果会被接纳。 */
  async function load(saveId: string): Promise<void> {
    requested = saveId;
    if (calendar.value?.saveId !== saveId) calendar.value = null;
    failedSaveId.value = null;
    try {
      const row = await getSaveCalendar(saveId);
      if (requested === saveId) calendar.value = row;
    } catch (error) {
      if (requested === saveId && calendar.value?.saveId !== saveId) failedSaveId.value = saveId;
      throw error;
    }
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

  async function setHidden(
    saveId: string,
    target: CalendarHiddenTarget,
    hidden: boolean,
  ): Promise<void> {
    accept(await persistCalendarHidden(saveId, target, hidden));
  }

  async function setLocalRegionOnly(saveId: string, on: boolean): Promise<void> {
    accept(await persistCalendarLocalRegionOnly(saveId, on));
  }

  return {
    calendar,
    failedSaveId,
    load,
    setMode,
    saveEntry,
    deleteEntry,
    setHidden,
    setLocalRegionOnly,
  };
});
