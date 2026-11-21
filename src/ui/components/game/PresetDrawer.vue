<script setup lang="ts">
/**
 * PresetDrawer.vue — 游戏内「预设」抽屉（2026-11-21）
 *
 * 玩家不用进设置，就能看到本存档当前生效的正文预设、拨常用开关：
 *   预设名 + 来源角标 → 生效总览 → 各互斥组（PresetKnobGroup）→「全部条目」（默认折叠）
 *   →「已调整 N 项 · 恢复出厂开关」→ 页脚「在设置中打开完整编辑」。
 *
 * - profile 按存档的生成方式取：agent → story，direct → direct，direct_cached → direct_cached
 *   （与 `presetProfileForAgent` 同一张表的反向：设置里对应的 Agent 是 story / direct_main / direct_cached）。
 * - 读写全部经 `usePresetKnobs`：只读预设写覆写层，玩家预设直接改行；本组件不碰 Dexie / 设置袋。
 * - 生成进行中**不锁**开关：管线在回合开始时才读预设与覆写层（GamePipeline.loadPresets），
 *   正在跑的这一回合不受影响，改动从下一回合起生效 —— 提示文案照实说。
 *
 * 🔴 焦点 / Esc / 滚动锁走 `ownModalFocus`（与 AppModal 同一套栈）：Esc 只关最上层，
 *    关掉后焦点回到打开它的那颗侧栏按钮；GamePage 的 Esc 层级判据（activeModal / hasOpenDialog）不用改。
 * 🔴 去设置会卸载游戏页、中止在跑的回合 —— 先过 `confirmLeaveGame('设置')`（GAME-08）。
 */
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { ownModalFocus } from '../../lib/modal-focus';
import { confirmLeaveGame } from '../../lib/leave-game-guard';
import { isZonePlaceholderEntry, type PresetPromptEntry } from '../../lib/preset-entries';
import { usePresetKnobs } from '../../composables/usePresetKnobs';
import { usePresets } from '../../composables/usePresets';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useContentStore } from '../../stores/content-store';
import { contentSourceLabel } from '../settings/agent/preset-bar-labels';
import AppButton from '../shared/AppButton.vue';
import PresetKnobGroup from '../shared/PresetKnobGroup.vue';
import type { PresetProfile } from '@engine/prompts/preset-resolution';
import type { PresetEntryInsight } from '@engine/prompts/preset-insight';
import type { GenerationMode } from '@engine/story/generation-mode';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const game = useGameStore();
const ui = useUIStore();
const s = useSettingsStore().settings;
const content = useContentStore();
const { catalog, loadPresets } = usePresets();

/** 生成方式 → 预设 profile / 设置里对应的 Agent id */
const MODE_MAP: Readonly<Record<GenerationMode, { profile: PresetProfile; agentId: string }>> = {
  agent: { profile: 'story', agentId: 'story' },
  direct: { profile: 'direct', agentId: 'direct_main' },
  direct_cached: { profile: 'direct_cached', agentId: 'direct_cached' },
};
const mode = computed<GenerationMode>(() =>
  game.generationMode in MODE_MAP ? game.generationMode : 'agent',
);
const profile = computed(() => MODE_MAP[mode.value].profile);

const knobs = usePresetKnobs(profile);
const { preset, summary, groups, adjustedCount } = knobs;

// 开发叠加目录是否启用（vite define 注入，与 AgentPresetBar 同一个开关）
declare const __POEM_CONTENT_DIR__: boolean;
/** 来源角标：措辞与设置页「预设」状态条一致（内容预设按实际来源说） */
const originLabel = computed(() => {
  const origin = catalog.value.find((e) => e.preset.id === knobs.presetId.value)?.origin;
  if (!origin) return '';
  if (origin === 'content')
    return contentSourceLabel({
      packActive: content.contentStatus === 'pack' || !!content.activePackId,
      localContentDir: __POEM_CONTENT_DIR__,
    });
  return origin === 'builtin' ? '引擎内置' : '我的';
});

const insightById = computed(
  () => new Map<string, PresetEntryInsight>(summary.value.entries.map((e) => [e.identifier, e])),
);

/** 互斥组选项的 token 口径：假如只启用这一项时它的大小 */
function groupOptions(options: readonly { identifier: string; label: string }[]) {
  return options.map((o) => ({
    id: o.identifier,
    label: o.label,
    tokens: insightById.value.get(o.identifier)?.tokensIfEnabled,
  }));
}

interface EntryRow {
  key: string;
  identifier: string;
  name: string;
  enabled: boolean;
  /** 五区占位：恒启用、不可拨 */
  locked: boolean;
  /** 所属互斥组的名字：组成员的开关交给上方的组单选，这里不给独立开关 */
  groupLabel: string | null;
  /**
   * 老式无 identifier 条目：覆写层与 `toggleEntry` 都按 identifier 寻址、够不着它，
   * 抽屉里只读显示（不给开关），改它请去设置页（那边走整行写）
   */
  noIdentifier: boolean;
  insight: PresetEntryInsight | null;
}

/** identifier → 所属互斥组名（同一条目只认第一个组，与 PresetManager 分段同口径） */
const groupLabelById = computed(() => {
  const map = new Map<string, string>();
  for (const { group } of groups.value) {
    for (const o of group.options) if (!map.has(o.identifier)) map.set(o.identifier, group.label);
  }
  return map;
});

/**
 * 「全部条目」：按 `injection_order` 稳定排序（与生效总览同口径）；五区占位锁定显示，
 * 引擎不计的 assistant 条目（非预填充）不列。
 * 🔴 互斥组成员**不给独立开关**（与 PresetManager 同一思路）：单独关掉组里选中那项会让组变成
 *    none、再开一项又变成 conflict —— 组成员只标「由「组名」控制」，开关一律走上方的组单选。
 * 🔴 不用 `canonicalPresetEntries`：它会补齐预设里**没有**的五区占位，抽屉只照实列出这份预设里有的。
 */
const entryRows = computed<EntryRow[]>(() => {
  const raw = (preset.value?.settings as { prompts?: unknown } | undefined)?.prompts;
  if (!Array.isArray(raw)) return [];
  const entries = (raw as unknown[])
    .filter((p): p is PresetPromptEntry => p !== null && typeof p === 'object')
    .sort((a, b) => (a.injection_order ?? 0) - (b.injection_order ?? 0));
  const rows: EntryRow[] = [];
  entries.forEach((entry, index) => {
    const identifier = entry.identifier ?? '';
    const locked = isZonePlaceholderEntry(entry);
    const groupLabel =
      locked || !identifier ? null : (groupLabelById.value.get(identifier) ?? null);
    // 无 identifier 的老式条目没法按键对上逐条估算（多条会共用空串键、互相顶掉），
    // 所以不查 insight、不显示 token；引擎不装配的 assistant 条目也不列
    const insight = identifier ? (insightById.value.get(identifier) ?? null) : null;
    if (!identifier && !locked && entry.role === 'assistant') return;
    if (!locked && identifier && !insight) return;
    rows.push({
      key: identifier || `#${index}`,
      identifier,
      name: entry.name || identifier || '（未命名）',
      enabled: locked || entry.enabled !== false,
      locked,
      groupLabel,
      noIdentifier: !locked && !identifier,
      insight,
    });
  });
  return rows;
});

const entriesOpen = ref(false);
const uid = useId();
const titleId = `preset-drawer-title-${uid}`;
const entriesId = `preset-drawer-entries-${uid}`;

/**
 * 写入失败时的复位版本号：原生 checkbox / radio 在点击时已经自己翻了状态，
 * 写失败后绑定值没变、Vue 不会重渲染 —— 递增它让开关与组块按 key 重挂，回到真实状态。
 */
const failRev = ref(0);

/**
 * 重挂会销毁当前聚焦的开关 / 单选，焦点会掉到 body：失败前焦点在抽屉里、重挂后丢了的话，
 * 交给 `findTarget` 找到的新元素；找不到就落到对话框容器上（它有 tabindex="-1"）。
 */
async function onWriteFailed(findTarget: (root: HTMLElement) => HTMLElement | null) {
  const root = panel.value;
  const active = document.activeElement;
  const hadFocus = !!root && active instanceof HTMLElement && root.contains(active);
  failRev.value += 1;
  ui.toast('开关保存失败，请稍后重试', 'error');
  await nextTick();
  const el = panel.value;
  if (!hadFocus || !el) return;
  const now = document.activeElement;
  if (now instanceof HTMLElement && now !== document.body && el.contains(now)) return;
  (findTarget(el) ?? el).focus();
}

/** 条目行的开关（按 data-entry 找；不拼选择器，identifier 里可能有引号等字符） */
function entrySwitch(root: HTMLElement, identifier: string): HTMLElement | null {
  for (const li of root.querySelectorAll<HTMLElement>('li[data-entry]')) {
    if (li.dataset.entry === identifier) return li.querySelector<HTMLElement>('input');
  }
  return null;
}

/** 组块里对应的单选（「不使用」的 value 是空串） */
function groupRadio(root: HTMLElement, groupId: string, id: string | null): HTMLElement | null {
  for (const block of root.querySelectorAll<HTMLElement>('[data-group-id]')) {
    if (block.dataset.groupId !== groupId) continue;
    const radios = [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    return radios.find((r) => r.value === (id ?? '')) ?? radios[0] ?? null;
  }
  return null;
}

async function onToggle(row: EntryRow) {
  if (row.locked || row.groupLabel || row.noIdentifier) return;
  try {
    await knobs.toggleEntry(row.identifier);
  } catch {
    await onWriteFailed((root) => entrySwitch(root, row.identifier));
  }
}

async function onSelect(groupId: string, id: string | null) {
  try {
    await knobs.selectOption(groupId, id);
  } catch {
    await onWriteFailed((root) => groupRadio(root, groupId, id));
  }
}

function close() {
  emit('close');
}

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) close();
}

async function openFullEditor() {
  if (!(await confirmLeaveGame('设置'))) return;
  s.activeAgent = MODE_MAP[mode.value].agentId;
  // activeModal 存在 game store 里，不清的话回到游戏页抽屉会自己再弹出来
  close();
  ui.openSettings('agent');
}

// ===== 焦点归属（与 AppModal 同一套）=====
const panel = ref<HTMLElement | null>(null);
let releaseFocus: (() => void) | undefined;
watch(
  [() => props.open, panel],
  ([open, el]) => {
    if (open && el && !releaseFocus) releaseFocus = ownModalFocus(el, close);
    if (!open) {
      releaseFocus?.();
      releaseFocus = undefined;
    }
  },
  { flush: 'post', immediate: true },
);
onUnmounted(() => releaseFocus?.());

// 打开时从库里重读一次预设：没进过设置页的会话里，玩家自己的预设行还没载入
watch(
  () => props.open,
  (open) => {
    if (open) void loadPresets().catch(() => undefined);
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <Transition name="preset-drawer">
      <div
        v-if="open"
        class="pd-overlay"
        data-testid="preset-drawer-overlay"
        @click="onOverlayClick"
      >
        <aside
          ref="panel"
          class="pd-panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <header class="pd-header">
            <h2 :id="titleId" class="pd-title">预设</h2>
            <button class="pd-close" aria-label="关闭" @click="close">×</button>
          </header>

          <div class="pd-body">
            <template v-if="preset">
              <section class="pd-identity">
                <div class="pd-name-row">
                  <span class="pd-name" data-testid="preset-drawer-name">{{ preset.name }}</span>
                  <span v-if="originLabel" class="pd-badge" data-testid="preset-drawer-origin">{{
                    originLabel
                  }}</span>
                </div>
                <p class="pd-summary" data-testid="preset-drawer-summary">
                  已启用 {{ summary.activeCount }}/{{ summary.totalCount }} · 约
                  {{ summary.totalTokens }} tokens
                </p>
              </section>

              <section v-if="groups.length" class="pd-groups">
                <PresetKnobGroup
                  v-for="g in groups"
                  :key="`${g.group.id}:${failRev}`"
                  :data-group-id="g.group.id"
                  :label="g.group.label"
                  :description="g.group.description"
                  :options="groupOptions(g.group.options)"
                  :selected="g.state.status === 'ok' ? g.state.selected : null"
                  :status="g.state.status"
                  :allow-none="g.group.allowNone"
                  @select="(id) => onSelect(g.group.id, id)"
                />
              </section>

              <section class="pd-entries">
                <button
                  class="pd-entries-toggle"
                  :aria-expanded="entriesOpen"
                  :aria-controls="entriesId"
                  data-testid="preset-drawer-entries-toggle"
                  @click="entriesOpen = !entriesOpen"
                >
                  <span class="pd-caret" aria-hidden="true">{{ entriesOpen ? '▼' : '▶' }}</span>
                  全部条目
                  <span class="pd-muted">（{{ entryRows.length }}）</span>
                </button>
                <ul v-if="entriesOpen" :id="entriesId" class="pd-entry-list">
                  <li
                    v-for="row in entryRows"
                    :key="`${row.key}:${failRev}`"
                    class="pd-entry"
                    :class="{
                      off: !row.enabled,
                      locked: row.locked,
                      grouped: !!row.groupLabel || row.noIdentifier,
                    }"
                    :data-entry="row.identifier"
                  >
                    <span v-if="row.groupLabel || row.noIdentifier" class="pd-entry-label">
                      <span class="pd-entry-name">{{ row.name }}</span>
                    </span>
                    <label v-else class="pd-entry-label">
                      <input
                        type="checkbox"
                        role="switch"
                        class="pd-switch"
                        :checked="row.enabled"
                        :disabled="row.locked"
                        :aria-describedby="row.locked ? `${entriesId}-lock` : undefined"
                        @change="onToggle(row)"
                      />
                      <span class="pd-entry-name">{{ row.name }}</span>
                    </label>
                    <span v-if="row.locked" class="pd-entry-meta">固定</span>
                    <span
                      v-else-if="row.groupLabel"
                      class="pd-entry-meta pd-entry-group"
                      data-testid="preset-drawer-entry-group"
                      :title="`在上方「${row.groupLabel}」里切换`"
                      >由「{{ row.groupLabel }}」控制</span
                    >
                    <span
                      v-else-if="row.noIdentifier"
                      class="pd-entry-meta"
                      data-testid="preset-drawer-entry-readonly"
                      title="这条旧式条目没有标识，只能在设置中编辑"
                      >{{ row.enabled ? '已启用' : '已停用' }} · 请在设置中编辑</span
                    >
                    <span
                      v-else-if="row.insight?.inactiveReason === 'nsfw'"
                      class="pd-entry-meta"
                      title="露骨内容开关关闭时不发送"
                      >露骨内容已关</span
                    >
                    <span v-if="row.insight" class="pd-entry-tokens"
                      >≈{{
                        row.insight.active ? row.insight.tokens : row.insight.tokensIfEnabled
                      }}</span
                    >
                  </li>
                </ul>
                <p v-if="entriesOpen" :id="`${entriesId}-lock`" class="pd-note pd-muted">
                  标「固定」的是五区占位，恒启用，不能关闭。
                </p>
              </section>

              <p v-if="adjustedCount > 0" class="pd-adjusted" data-testid="preset-drawer-adjusted">
                已调整 {{ adjustedCount }} 项 ·
                <button class="pd-link" @click="knobs.resetToggles()">恢复出厂开关</button>
              </p>

              <p class="pd-note" role="note" data-testid="preset-drawer-hint">
                改动下一回合生效<template v-if="mode === 'direct_cached'"
                  >；缓存优化模式下会重建一次缓存</template
                >。
              </p>
            </template>
            <p v-else class="pd-empty">当前没有可用的正文预设。</p>
          </div>

          <footer class="pd-footer">
            <AppButton
              variant="secondary"
              size="sm"
              block
              data-testid="preset-drawer-open-settings"
              @click="openFullEditor"
            >
              在设置中打开完整编辑
            </AppButton>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pd-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(4px);
}
.pd-panel {
  display: flex;
  flex-direction: column;
  width: min(92vw, 420px);
  height: 100%;
  background: var(--theme-card-bg);
  border-left: 1px solid var(--theme-card-border);
  box-shadow: var(--theme-shadow-lg);
  outline: none;
}

.pd-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--theme-spacing-lg) var(--theme-spacing-lg) var(--theme-spacing-sm);
}
.pd-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.pd-close {
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 1.25rem;
  line-height: 1;
  cursor: pointer;
  padding: var(--theme-spacing-xs);
  transition: color var(--theme-transition-fast);
}
.pd-close:hover {
  color: var(--theme-text-primary);
}

.pd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg) var(--theme-spacing-lg);
}

.pd-name-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.pd-name {
  font-family: var(--theme-font-title);
  font-size: 1rem;
  color: var(--theme-text-primary);
}
/* 激活态徽章配方 — design.md §1 */
.pd-badge {
  padding: 0 var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  line-height: 1.6;
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-secondary);
}
.pd-summary {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}

.pd-groups {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

.pd-entries-toggle {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  width: 100%;
  padding: var(--theme-spacing-xs) 0;
  border: none;
  background: none;
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
}
.pd-caret {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.pd-entry-list {
  list-style: none;
  margin: var(--theme-spacing-xs) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pd-entry {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8125rem;
}
.pd-entry:hover {
  background: var(--theme-surface-muted);
}
.pd-entry-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  min-width: 0;
  cursor: pointer;
  color: var(--theme-text-primary);
}
.pd-entry.off .pd-entry-label {
  color: var(--theme-text-muted);
}
.pd-entry.locked .pd-entry-label {
  cursor: not-allowed;
}
.pd-switch {
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}
.pd-entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pd-entry.grouped .pd-entry-label {
  cursor: default;
}
.pd-entry-meta {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.pd-entry-group {
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pd-entry-tokens {
  flex-shrink: 0;
  min-width: 3.5em;
  text-align: right;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--theme-text-muted);
}

.pd-adjusted,
.pd-note,
.pd-empty {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-text-secondary);
}
.pd-muted {
  color: var(--theme-text-muted);
  font-weight: 400;
}
.pd-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--theme-primary);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.pd-footer {
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  border-top: 1px solid var(--theme-card-border);
}

/* ===== 右侧滑入（只动 opacity / transform；根的时长不短于面板，design.md §6.0 第 4 条）===== */
.preset-drawer-enter-active {
  transition: opacity var(--motion-duration-slow) var(--motion-ease-enter);
}
.preset-drawer-enter-active .pd-panel {
  transition: transform var(--motion-duration-slow) var(--motion-ease-enter);
}
.preset-drawer-leave-active {
  transition: opacity var(--motion-duration-fast) var(--motion-ease-exit);
}
.preset-drawer-leave-active .pd-panel {
  transition: transform var(--motion-duration-fast) var(--motion-ease-exit);
}
.preset-drawer-enter-from,
.preset-drawer-leave-to {
  opacity: 0;
}
.preset-drawer-enter-from .pd-panel,
.preset-drawer-leave-to .pd-panel {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .preset-drawer-enter-active,
  .preset-drawer-leave-active,
  .preset-drawer-enter-active .pd-panel,
  .preset-drawer-leave-active .pd-panel {
    transition: none;
  }
  .preset-drawer-enter-from .pd-panel,
  .preset-drawer-leave-to .pd-panel {
    transform: none;
  }
}
:root[data-reduced-motion='true'] .preset-drawer-enter-active,
:root[data-reduced-motion='true'] .preset-drawer-leave-active,
:root[data-reduced-motion='true'] .preset-drawer-enter-active .pd-panel,
:root[data-reduced-motion='true'] .preset-drawer-leave-active .pd-panel {
  transition: none;
}
:root[data-reduced-motion='true'] .preset-drawer-enter-from .pd-panel,
:root[data-reduced-motion='true'] .preset-drawer-leave-to .pd-panel {
  transform: none;
}
</style>
