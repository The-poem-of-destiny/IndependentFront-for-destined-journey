<script setup lang="ts">
/**
 * 日历（`game.activeModal === 'calendar'`）。按存档隔离、完全本地：这里的任何内容都不进提示词。
 *
 * 本组件只负责把引擎算好的结果画出来 + 收集玩家输入：
 *   · 来源与视图计算在 `@engine/calendar/*`（沉浸模式下自动来源根本不参与计算）
 *   · 展示层措辞与草稿转换在 `calendar-panel.ts`
 *   · 读写经 `stores/calendar-store.ts`，真源是 Dexie `saveCalendars`
 */
import { computed, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import { useCalendarStore } from '../../stores/calendar-store';
import AppButton from '../shared/AppButton.vue';
import { defaultSaveCalendar, type CalendarHiddenTarget } from '@engine/calendar/calendar-store';
import { deriveBirthdayItems, deriveFestivalItems } from '@engine/calendar/calendar-sources';
import {
  buildCalendarItems,
  buildMonthView,
  listUndatedItems,
  listUpcoming,
} from '@engine/calendar/calendar-view';
import { collectLoreKeyDates } from '@engine/content/lore-key-dates';
import { filterBooksByEnabledEntries } from '@engine/content/worldbook-loader';
import { splitLocationSegments } from '@engine/map/map-index';
import { WEEKDAY_NAMES, getSeason } from '@engine/time/time-system';
import type { CalendarAutoKind, CalendarItem, CalendarMode } from '@engine/types/types-calendar';
import {
  KIND_LABELS,
  draftFromEntry,
  entryFromDraft,
  formatItemDate,
  formatItemRepeat,
  groupFestivalsByRegion,
  hiddenByRegions,
  itemTitle,
  newEntryDraft,
  type EntryDraft,
} from './calendar-panel';

const game = useGameStore();
const ui = useUIStore();
const worldbooks = useWorldBookStore();
const store = useCalendarStore();

const UPCOMING_DAYS = 30;
/** 月格里每天最多直接列出的项数，其余折成「+N」 */
const CELL_ITEM_LIMIT = 2;

const saveId = computed(() => game.activeSaveId);
const today = computed(() => {
  const t = game.gameTime;
  return t ? { year: t.year, month: t.month, day: t.day } : null;
});
/** 本存档的日历行是否已经读到。没读到之前不知道是哪种模式，一律不显示任何自动来源。 */
const ready = computed(() => !!store.calendar && store.calendar.saveId === saveId.value);
const loadFailed = computed(() => !ready.value && store.failedSaveId === saveId.value);
const calendar = computed(() =>
  ready.value && store.calendar ? store.calendar : defaultSaveCalendar(saveId.value ?? ''),
);
// 🔴 未就绪时按沉浸处理：默认行是普通模式，直接用它会在读取完成前（或读取失败后）
//    把沉浸模式存档的节庆与生日露出来。
const immersive = computed(() => !ready.value || calendar.value.mode === 'immersive');

function reload() {
  const id = saveId.value;
  if (id) void store.load(id).catch(() => ui.toast('日历读取失败', 'error'));
}
watch(saveId, reload, { immediate: true });

// ── 来源 ──
/** 本存档启用的世界书条目上的关键日期。沉浸模式下不计算（界面本身也不该透露它们存在）。 */
const festivalSource = computed<CalendarItem[]>(() => {
  if (immersive.value) return [];
  const enabled = game.activeSave?.metadata?.enabledWorldBookEntries ?? [];
  return deriveFestivalItems(
    collectLoreKeyDates(filterBooksByEnabledEntries(worldbooks.books, enabled)),
  );
});
const birthdaySource = computed<CalendarItem[]>(() =>
  immersive.value ? [] : deriveBirthdayItems(game.characters),
);
const items = computed(() =>
  buildCalendarItems({
    calendar: calendar.value,
    festivals: festivalSource.value,
    birthdays: birthdaySource.value,
    locationPath: splitLocationSegments(game.player?.location ?? ''),
  }),
);

// ── 视图 ──
const viewYear = ref(today.value?.year ?? 1);
const viewMonth = ref(today.value?.month ?? 1);
const selectedDay = ref<number | null>(today.value?.day ?? null);

const monthView = computed(() =>
  buildMonthView(viewYear.value, viewMonth.value, items.value, today.value),
);
/** 7 列网格里 1 日之前要空出的格数（weekday 1=周日） */
const leadingBlanks = computed(() => (monthView.value.days[0]?.weekday ?? 1) - 1);
const selectedCell = computed(() =>
  selectedDay.value === null ? null : (monthView.value.days[selectedDay.value - 1] ?? null),
);
const upcoming = computed(() =>
  today.value ? listUpcoming(items.value, today.value, UPCOMING_DAYS) : [],
);
const undated = computed(() => listUndatedItems(items.value, viewYear.value));
const monthTitle = computed(
  () => `${game.gameTime?.era ?? ''}${viewYear.value}年 · ${viewMonth.value}月`,
);
const isViewingToday = computed(
  () =>
    !!today.value &&
    today.value.year === viewYear.value &&
    today.value.month === viewMonth.value &&
    today.value.day === selectedDay.value,
);

function shiftMonth(delta: number) {
  const index = viewYear.value * 12 + (viewMonth.value - 1) + delta;
  viewYear.value = Math.floor(index / 12);
  viewMonth.value = (((index % 12) + 12) % 12) + 1;
  selectedDay.value = null;
}
function goToday() {
  if (!today.value) return;
  viewYear.value = today.value.year;
  viewMonth.value = today.value.month;
  selectedDay.value = today.value.day;
}
function jumpTo(date: { year: number; month: number; day: number }) {
  viewYear.value = date.year;
  viewMonth.value = date.month;
  selectedDay.value = date.day;
}
function dayLabel(day: number, count: number) {
  return `${viewMonth.value}月${day}日${count > 0 ? `，${count} 项` : ''}`;
}
function daysAwayLabel(days: number) {
  return days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`;
}

// ── 写入 ──
/** @returns 是否成功。未就绪时不写：那时界面上的状态不是这份存档的真实状态。 */
async function run(action: (id: string) => Promise<void>, failure: string): Promise<boolean> {
  const id = saveId.value;
  if (!id || !ready.value) return false;
  try {
    await action(id);
    return true;
  } catch {
    ui.toast(failure, 'error');
    return false;
  }
}

function setMode(mode: CalendarMode) {
  if (mode === calendar.value.mode) return;
  showFilters.value = false;
  void run((id) => store.setMode(id, mode), '模式切换失败');
}

// 玩家条目的编辑
const draft = ref<EntryDraft | null>(null);
const draftEntry = computed(() =>
  draft.value ? entryFromDraft(draft.value, () => crypto.randomUUID()) : null,
);
function startAdd() {
  const base = today.value ?? { year: viewYear.value, month: viewMonth.value, day: 1 };
  draft.value = newEntryDraft({
    year: viewYear.value,
    month: viewMonth.value,
    day: selectedDay.value ?? (base.month === viewMonth.value ? base.day : 1),
  });
}
function startEdit(item: CalendarItem) {
  const entry = calendar.value.entries.find((e) => `user:${e.id}` === item.key);
  if (entry) draft.value = draftFromEntry(entry, viewYear.value);
}
async function saveDraft() {
  const entry = draftEntry.value;
  if (!entry) return;
  // 只有真的存进去了才收起编辑器：失败时保留草稿，别让玩家重打一遍
  if (await run((id) => store.saveEntry(id, entry), '保存失败')) draft.value = null;
}
function removeEntry(item: CalendarItem) {
  if (!window.confirm(`删除「${item.title}」？`)) return;
  void run((id) => store.deleteEntry(id, item.key.slice('user:'.length)), '删除失败');
}

// 显示选择
const showFilters = ref(false);
const festivalGroups = computed(() => groupFestivalsByRegion(festivalSource.value));
const hiddenKeys = computed(() => new Set(calendar.value.hiddenKeys));
const hiddenRegions = computed(() => new Set(calendar.value.hiddenRegions));
const kindHidden = (kind: CalendarAutoKind) => calendar.value.hiddenKinds.includes(kind);

/** 隐藏或恢复一项。只发增量，由引擎在写锁内对着最新的行应用 —— 连点两下不会互相覆盖。 */
function setHidden(target: CalendarHiddenTarget, hidden: boolean) {
  void run((id) => store.setHidden(id, target, hidden), '保存失败');
}
const toggleKind = (kind: CalendarAutoKind) => setHidden({ kind }, !kindHidden(kind));
const toggleRegion = (region: string) => setHidden({ region }, !hiddenRegions.value.has(region));
const toggleKey = (key: string) => setHidden({ key }, !hiddenKeys.value.has(key));
function toggleLocalOnly() {
  const next = !calendar.value.localRegionOnly;
  void run((id) => store.setLocalRegionOnly(id, next), '保存失败');
}
</script>

<template>
  <div class="cal-panel">
    <!-- ═══ 页头：月份导航 + 模式 + 操作 ═══ -->
    <header class="cal-head">
      <div class="cal-nav">
        <button class="cal-icon-btn" aria-label="上一月" @click="shiftMonth(-1)">‹</button>
        <h3 class="cal-title" aria-live="polite">
          {{ monthTitle }}
          <span class="cal-season">{{ getSeason(viewMonth) }}</span>
        </h3>
        <button class="cal-icon-btn" aria-label="下一月" @click="shiftMonth(1)">›</button>
        <AppButton variant="ghost" size="sm" :disabled="!today || isViewingToday" @click="goToday">
          回到今天
        </AppButton>
      </div>
      <div class="cal-tools">
        <div class="cal-mode" role="group" aria-label="日历模式">
          <button
            class="cal-mode-btn"
            :class="{ active: ready && !immersive }"
            :aria-pressed="ready && !immersive"
            :disabled="!ready"
            data-mode="normal"
            @click="setMode('normal')"
          >
            普通
          </button>
          <button
            class="cal-mode-btn"
            :class="{ active: ready && immersive }"
            :aria-pressed="ready && immersive"
            :disabled="!ready"
            data-mode="immersive"
            @click="setMode('immersive')"
          >
            沉浸
          </button>
        </div>
        <AppButton
          v-if="!immersive"
          variant="secondary"
          size="sm"
          :aria-expanded="showFilters"
          data-action="filters"
          @click="showFilters = !showFilters"
        >
          显示选择
        </AppButton>
        <AppButton
          variant="primary"
          size="sm"
          :disabled="!ready"
          data-action="add"
          @click="startAdd"
        >
          记一个日子
        </AppButton>
      </div>
    </header>
    <p v-if="ready" class="cal-mode-hint">
      {{
        immersive
          ? '沉浸模式：日历上只有你自己记下的日子。切换模式不会删除任何内容。'
          : '普通模式：自动显示世界中的节庆与已结识角色的生日，可在「显示选择」里隐藏。'
      }}
    </p>

    <div v-if="!ready" class="cal-empty" data-section="loading" role="status">
      <template v-if="loadFailed">
        日历读取失败
        <div class="cal-actions center">
          <AppButton variant="secondary" size="sm" data-action="retry" @click="reload">
            重试
          </AppButton>
        </div>
      </template>
      <template v-else>正在读取日历…</template>
    </div>

    <div v-else class="cal-body">
      <!-- ═══ 左：月视图 ═══ -->
      <section class="cal-month" aria-label="月视图">
        <div class="cal-weekdays" aria-hidden="true">
          <span v-for="name in WEEKDAY_NAMES" :key="name">{{ name }}</span>
        </div>
        <div class="cal-grid">
          <span v-for="n in leadingBlanks" :key="`blank-${n}`" class="cal-blank" />
          <button
            v-for="cell in monthView.days"
            :key="cell.day"
            class="cal-cell"
            :class="{
              today: cell.isToday,
              selected: cell.day === selectedDay,
              filled: cell.items.length > 0,
            }"
            :data-day="cell.day"
            :aria-label="dayLabel(cell.day, cell.items.length)"
            :aria-pressed="cell.day === selectedDay"
            :aria-current="cell.isToday ? 'date' : undefined"
            @click="selectedDay = cell.day"
          >
            <span class="cal-day-num">{{ cell.day }}</span>
            <span class="cal-chips">
              <span
                v-for="entry in cell.items.slice(0, CELL_ITEM_LIMIT)"
                :key="entry.item.key"
                class="cal-chip"
                :class="[`kind-${entry.item.kind}`, { major: entry.item.major }]"
              >
                {{ entry.item.title }}
              </span>
              <span v-if="cell.items.length > CELL_ITEM_LIMIT" class="cal-chip more">
                +{{ cell.items.length - CELL_ITEM_LIMIT }}
              </span>
            </span>
          </button>
        </div>
        <div v-if="monthView.undated.length > 0" class="cal-undated">
          <div class="cal-label">本月（日期未定）</div>
          <ul class="cal-list">
            <li v-for="item in monthView.undated" :key="item.key" class="cal-row">
              <span class="cal-dot" :class="`kind-${item.kind}`" />
              <span class="cal-row-title">{{ item.title }}</span>
              <span v-if="item.regions?.length" class="cal-meta">{{
                item.regions.join('、')
              }}</span>
            </li>
          </ul>
        </div>
      </section>

      <!-- ═══ 右：详情 / 编辑 / 显示选择 / 近期 ═══ -->
      <aside class="cal-side">
        <!-- 编辑器 -->
        <section v-if="draft" class="cal-card" data-section="editor">
          <div class="cal-label">{{ draft.id ? '修改日子' : '记一个日子' }}</div>
          <label class="cal-field">
            <span>标题</span>
            <input
              v-model="draft.title"
              class="cal-input"
              maxlength="40"
              placeholder="例如：约定之日"
            />
          </label>
          <label class="cal-field">
            <span>备注</span>
            <textarea v-model="draft.note" class="cal-input" rows="2" maxlength="200" />
          </label>
          <div class="cal-field">
            <span>日期</span>
            <div class="cal-date-inputs">
              <input
                v-model.number="draft.startMonth"
                class="cal-input num"
                type="number"
                min="1"
                max="12"
                aria-label="开始月"
              />
              <span>月</span>
              <input
                v-model.number="draft.startDay"
                class="cal-input num"
                type="number"
                min="1"
                max="30"
                aria-label="开始日"
              />
              <span>日</span>
            </div>
          </div>
          <label class="cal-check">
            <input v-model="draft.multiDay" type="checkbox" />
            <span>持续多天</span>
          </label>
          <div v-if="draft.multiDay" class="cal-field">
            <span>结束</span>
            <div class="cal-date-inputs">
              <input
                v-model.number="draft.endMonth"
                class="cal-input num"
                type="number"
                min="1"
                max="12"
                aria-label="结束月"
              />
              <span>月</span>
              <input
                v-model.number="draft.endDay"
                class="cal-input num"
                type="number"
                min="1"
                max="30"
                aria-label="结束日"
              />
              <span>日</span>
            </div>
          </div>
          <label class="cal-check">
            <input v-model="draft.yearly" type="checkbox" />
            <span>每年重复</span>
          </label>
          <div v-if="!draft.yearly" class="cal-field">
            <span>年份</span>
            <input
              v-model.number="draft.year"
              class="cal-input num wide"
              type="number"
              aria-label="年份"
            />
          </div>
          <p class="cal-hint">每月固定 30 天。</p>
          <div class="cal-actions">
            <AppButton variant="ghost" size="sm" @click="draft = null">取消</AppButton>
            <AppButton
              variant="primary"
              size="sm"
              :disabled="!draftEntry"
              data-action="save"
              @click="saveDraft"
            >
              保存
            </AppButton>
          </div>
        </section>

        <!-- 显示选择 -->
        <section v-else-if="showFilters && !immersive" class="cal-card" data-section="filters">
          <div class="cal-label">显示选择</div>
          <label class="cal-check">
            <input type="checkbox" :checked="calendar.localRegionOnly" @change="toggleLocalOnly" />
            <span>只看所在地区的节庆</span>
          </label>

          <label class="cal-check strong">
            <input
              type="checkbox"
              :checked="!kindHidden('festival')"
              data-kind="festival"
              @change="toggleKind('festival')"
            />
            <span>节庆</span>
          </label>
          <div v-if="festivalGroups.length === 0" class="cal-empty small">
            当前启用的世界书里没有标注日期的节庆
          </div>
          <div
            v-for="group in festivalGroups"
            :key="group.region"
            class="cal-filter-group"
            :class="{ off: kindHidden('festival') }"
          >
            <label v-if="group.region" class="cal-check">
              <input
                type="checkbox"
                :checked="!hiddenRegions.has(group.region)"
                :disabled="kindHidden('festival')"
                @change="toggleRegion(group.region)"
              />
              <span class="cal-region">{{ group.region }}</span>
            </label>
            <div v-else class="cal-region plain">通行各地</div>
            <label v-for="item in group.items" :key="item.key" class="cal-check sub">
              <input
                type="checkbox"
                :checked="!hiddenKeys.has(item.key)"
                :disabled="kindHidden('festival') || hiddenByRegions(item, hiddenRegions)"
                :data-key="item.key"
                @change="toggleKey(item.key)"
              />
              <span>{{ item.title }}</span>
              <span class="cal-meta">{{ formatItemDate(item) }}</span>
            </label>
          </div>

          <label class="cal-check strong">
            <input
              type="checkbox"
              :checked="!kindHidden('birthday')"
              data-kind="birthday"
              @change="toggleKind('birthday')"
            />
            <span>角色生日</span>
          </label>
          <div v-if="birthdaySource.length === 0" class="cal-empty small">还没有已知生日的角色</div>
          <div class="cal-filter-group" :class="{ off: kindHidden('birthday') }">
            <label v-for="item in birthdaySource" :key="item.key" class="cal-check sub">
              <input
                type="checkbox"
                :checked="!hiddenKeys.has(item.key)"
                :disabled="kindHidden('birthday')"
                :data-key="item.key"
                @change="toggleKey(item.key)"
              />
              <span>{{ item.title }}</span>
              <span class="cal-meta">{{ formatItemDate(item) }}</span>
            </label>
          </div>
        </section>

        <!-- 当日详情 -->
        <section v-else class="cal-card" data-section="day">
          <div class="cal-label">
            {{ selectedCell ? `${viewMonth}月${selectedCell.day}日` : '选择一天' }}
            <span v-if="selectedCell" class="cal-meta">{{
              WEEKDAY_NAMES[selectedCell.weekday - 1]
            }}</span>
          </div>
          <div v-if="!selectedCell" class="cal-empty">点选左侧的日期查看当天</div>
          <div v-else-if="selectedCell.items.length === 0" class="cal-empty">这一天没有记事</div>
          <ul v-else class="cal-list">
            <li
              v-for="entry in selectedCell.items"
              :key="entry.item.key"
              class="cal-item"
              :data-key="entry.item.key"
            >
              <div class="cal-item-head">
                <span class="cal-dot" :class="`kind-${entry.item.kind}`" />
                <span class="cal-item-title" :class="{ major: entry.item.major }">
                  {{ itemTitle(entry.item, entry.age) }}
                </span>
                <span class="cal-tag" :class="`kind-${entry.item.kind}`">{{
                  KIND_LABELS[entry.item.kind]
                }}</span>
              </div>
              <div class="cal-item-meta">
                <span
                  >{{ entry.item.approximate ? '约 ' : '' }}{{ formatItemDate(entry.item) }}</span
                >
                <span v-if="formatItemRepeat(entry.item)">{{ formatItemRepeat(entry.item) }}</span>
                <span v-if="entry.item.timeNote">{{ entry.item.timeNote }}</span>
                <span v-if="entry.item.regions?.length">{{ entry.item.regions.join('、') }}</span>
              </div>
              <p v-if="entry.item.note" class="cal-item-note">{{ entry.item.note }}</p>
              <ul v-if="entry.item.highlights?.length" class="cal-highlights">
                <li v-for="h in entry.item.highlights" :key="`${h.day}-${h.title}`">
                  第 {{ h.day }} 天 · {{ h.title }}
                </li>
              </ul>
              <div class="cal-actions">
                <template v-if="entry.item.kind === 'user'">
                  <AppButton
                    variant="ghost"
                    size="sm"
                    data-action="edit"
                    @click="startEdit(entry.item)"
                    >修改</AppButton
                  >
                  <AppButton
                    variant="ghost"
                    size="sm"
                    data-action="delete"
                    @click="removeEntry(entry.item)"
                    >删除</AppButton
                  >
                </template>
                <AppButton
                  v-else
                  variant="ghost"
                  size="sm"
                  data-action="hide"
                  @click="toggleKey(entry.item.key)"
                >
                  不再显示
                </AppButton>
              </div>
            </li>
          </ul>
        </section>

        <!-- 近期 -->
        <section class="cal-card" data-section="upcoming">
          <div class="cal-label">未来 {{ UPCOMING_DAYS }} 天</div>
          <div v-if="!today" class="cal-empty">时间未同步</div>
          <div v-else-if="upcoming.length === 0" class="cal-empty">近期没有记事</div>
          <ul v-else class="cal-list">
            <li v-for="entry in upcoming" :key="entry.item.key">
              <button class="cal-row as-button" @click="jumpTo(entry.date)">
                <span class="cal-dot" :class="`kind-${entry.item.kind}`" />
                <span class="cal-row-title">{{ itemTitle(entry.item, entry.age) }}</span>
                <span class="cal-meta">
                  {{ entry.date.month }}月{{ entry.date.day }}日 ·
                  {{ daysAwayLabel(entry.daysAway) }}
                </span>
              </button>
            </li>
          </ul>
        </section>

        <!-- 日期未定 -->
        <section v-if="undated.length > 0" class="cal-card" data-section="undated">
          <div class="cal-label">日期未定</div>
          <ul class="cal-list">
            <li v-for="item in undated" :key="item.key" class="cal-row">
              <span class="cal-dot" :class="`kind-${item.kind}`" />
              <span class="cal-row-title">{{ item.title }}</span>
              <span class="cal-meta">{{ formatItemDate(item) }}</span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.cal-panel {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  --paper-stack:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
  --cal-festival: var(--theme-primary);
  --cal-birthday: var(--theme-affection);
  --cal-user: var(--theme-success);
}

/* ═══ 页头 ═══ */
.cal-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm) var(--theme-spacing-lg);
}
.cal-nav,
.cal-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.cal-title {
  margin: 0;
  min-width: 11rem;
  text-align: center;
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  letter-spacing: 0.03em;
}
.cal-season {
  margin-left: var(--theme-spacing-sm);
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--theme-text-muted);
}
.cal-icon-btn {
  width: 36px;
  height: 36px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 1.125rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.cal-icon-btn:hover {
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
}
.cal-mode {
  display: flex;
  padding: 4px;
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
}
.cal-mode-btn {
  min-height: 36px;
  white-space: nowrap;
  padding: 0 var(--theme-spacing-md);
  border: none;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.cal-mode-btn:disabled {
  cursor: default;
  opacity: 0.6;
}
.cal-mode-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.cal-mode-btn.active {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-weight: 600;
  box-shadow: var(--theme-shadow-sm);
}
.cal-mode-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

/* ═══ 两栏 ═══ */
.cal-body {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(16rem, 1fr);
  gap: var(--theme-spacing-lg);
  align-items: start;
}
.cal-month,
.cal-card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  padding: var(--theme-spacing-md);
}
.cal-side {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  min-width: 0;
}

/* ═══ 月格 ═══ */
.cal-weekdays,
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--theme-spacing-xs);
}
.cal-weekdays {
  margin-bottom: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  text-align: center;
}
.cal-cell {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-height: 4.5rem;
  padding: var(--theme-spacing-xs);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.cal-cell:hover {
  background: var(--theme-surface-muted);
}
.cal-cell.today .cal-day-num {
  color: var(--theme-primary);
  font-weight: 700;
}
.cal-cell.today {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.cal-cell.selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-color-primary, var(--theme-primary));
}
.cal-day-num {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.cal-chips {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cal-chip {
  --chip-color: var(--theme-text-muted);
  padding: 0 4px;
  border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--chip-color) 12%, transparent);
  color: var(--theme-text-primary);
  font-size: 0.6875rem;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cal-chip.major {
  font-weight: 600;
}
.cal-chip.more {
  border-color: transparent;
  background: transparent;
  color: var(--theme-text-muted);
}
.kind-festival {
  --chip-color: var(--cal-festival);
}
.kind-birthday {
  --chip-color: var(--cal-birthday);
}
.kind-user {
  --chip-color: var(--cal-user);
}
.cal-undated {
  margin-top: var(--theme-spacing-md);
}

/* ═══ 右栏通用 ═══ */
.cal-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.cal-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.cal-list,
.cal-highlights {
  margin: 0;
  padding: 0;
  list-style: none;
}
.cal-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.cal-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-width: 0;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.cal-row.as-button {
  width: 100%;
  min-height: 36px;
  padding: 0 var(--theme-spacing-xs);
  border: none;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--theme-transition-fast);
}
.cal-row.as-button:hover {
  background: var(--theme-surface-muted);
}
.cal-row-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cal-meta {
  flex-shrink: 0;
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--theme-text-muted);
}
.cal-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--theme-radius-full);
  background: var(--chip-color, var(--theme-text-muted));
}
.cal-item + .cal-item {
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
.cal-item-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.cal-item-title {
  flex: 1;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.cal-item-title.major {
  font-family: var(--theme-font-title);
}
.cal-tag {
  flex-shrink: 0;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--chip-color) 12%, transparent);
  color: var(--chip-color);
  font-size: 0.6875rem;
  line-height: 1.6;
}
.cal-item-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--theme-spacing-md);
  margin-top: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.cal-item-note,
.cal-highlights {
  margin-top: var(--theme-spacing-xs);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.cal-actions.center {
  justify-content: center;
  margin-top: var(--theme-spacing-sm);
}
.cal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-xs);
  margin-top: var(--theme-spacing-xs);
}
.cal-empty {
  padding: var(--theme-spacing-xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.cal-empty::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}
.cal-empty.small {
  padding: var(--theme-spacing-sm) 0;
  text-align: left;
}
.cal-empty.small::before {
  content: none;
}

/* ═══ 表单 / 显示选择 ═══ */
.cal-field {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin-bottom: var(--theme-spacing-sm);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.cal-input {
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
}
.cal-input:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.cal-input.num {
  width: 4rem;
}
.cal-input.num.wide {
  width: 6rem;
}
textarea.cal-input {
  resize: vertical;
}
.cal-date-inputs {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.8125rem;
}
.cal-check {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  cursor: pointer;
}
.cal-check.strong {
  margin-top: var(--theme-spacing-sm);
  font-weight: 600;
}
.cal-check.sub {
  padding-left: var(--theme-spacing-xl);
}
.cal-check.sub > span:first-of-type {
  flex: 1;
  min-width: 0;
}
.cal-filter-group.off {
  opacity: 0.5;
}
.cal-region {
  color: var(--theme-text-secondary);
}
.cal-region.plain {
  min-height: 28px;
  display: flex;
  align-items: center;
  font-size: 0.8125rem;
}
.cal-hint {
  margin: 0 0 var(--theme-spacing-sm);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

/* ═══ 窄屏：叠成一栏，日期格只留色点 ═══ */
@media (max-width: 760px) {
  .cal-body {
    grid-template-columns: minmax(0, 1fr);
  }
  .cal-title {
    min-width: 0;
  }
  .cal-cell {
    min-height: 3rem;
    align-items: center;
  }
  .cal-chips {
    flex-direction: row;
    justify-content: center;
  }
  .cal-chip {
    width: 8px;
    height: 8px;
    padding: 0;
    border: none;
    border-radius: var(--theme-radius-full);
    background: var(--chip-color);
    font-size: 0;
  }
  .cal-chip.more {
    display: none;
  }
}
</style>
