<script setup lang="ts">
/**
 * 行动面板右上角的样式切换：一颗 24px 齿轮 + 一个 `role="menu"` 小浮层（五个单选项）。
 *
 * 🔴 它是 `<details>` 的**兄弟**，不在 `<summary>` 里 —— 点齿轮不会开合面板。
 *    ChatFlow 的点击推进让路清单里有 `button` 与 `.action-panel-card`，点它也不会推进正文。
 * 打开时经 `ownModalFocus` 接管焦点：Esc 关闭、Tab 环绕、关后焦点回到齿轮；
 * 它在对话框栈里，所以 GamePage 的 Esc 菜单与逐节演出都会让路。
 * 每一条关闭路径（选中 / Esc / 点外面 / 卸载）都要调释放函数，否则 body 的 overflow 回不来；
 * 点外面那条把释放推迟到这次点击派发之后（见 `close`），免得同一下点击又推进了正文。
 */
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { ACTION_PANEL_STYLES, type ActionPanelStyleId } from '../../../lib/action-panel-styles';
import { ownModalFocus } from '../../../lib/modal-focus';

const props = defineProps<{ current: ActionPanelStyleId }>();
const emit = defineEmits<{ select: [id: ActionPanelStyleId] }>();

const open = ref(false);
const rootEl = ref<HTMLElement>();
const menuEl = ref<HTMLElement>();
let release: (() => void) | null = null;

function items(): HTMLButtonElement[] {
  return menuEl.value ? [...menuEl.value.querySelectorAll<HTMLButtonElement>('button')] : [];
}

/** 点外面关闭后、尚未释放的对话框栈；有值时立即调用它就是「马上释放」 */
let pendingRelease: (() => void) | null = null;
/** 兜底：等不到 pointerup / pointercancel 时，过这么久也要释放（body 的 overflow 不能一直锁着） */
const DEFERRED_RELEASE_FALLBACK_MS = 2000;

function onOutsidePointer(event: Event): void {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) close(true);
}

async function openMenu(): Promise<void> {
  if (open.value) return;
  flushPendingRelease();
  open.value = true;
  await nextTick();
  if (!open.value || !menuEl.value) return;
  release = ownModalFocus(menuEl.value, () => close());
  document.addEventListener('pointerdown', onOutsidePointer, true);
  const checked = items().find((b) => b.getAttribute('aria-checked') === 'true');
  checked?.focus();
}

/**
 * 关菜单。`deferRelease` 只给「点外面」用：菜单立刻收起，但对话框栈撑到这次点击派发完才释放。
 *
 * 🔴 ChatFlow 的逐节演出在 **click** 上问 `hasOpenDialog()`，而点外面是在 **pointerdown** 捕获阶段认出来的；
 *    此时就释放，点正文关菜单的那一下会同时把正文推进一节。所以等 pointerup / pointercancel 之后的
 *    下一个任务（click 紧跟 pointerup 派发）再释放；焦点留在用户点中的地方，不拽回齿轮。
 */
function close(deferRelease = false): void {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  const done = release;
  release = null;
  if (!done) return;
  if (deferRelease) scheduleRelease(done);
  else done();
}

function scheduleRelease(done: () => void): void {
  flushPendingRelease();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = setTimeout(() => finish(), DEFERRED_RELEASE_FALLBACK_MS);
  const onUp = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => finish(), 0);
  };
  const finish = (): void => {
    if (pendingRelease !== finish) return;
    pendingRelease = null;
    clearTimeout(timer);
    clearTimeout(fallback);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    const kept = document.activeElement;
    done();
    // 释放会把焦点还给齿轮；用户点外面时焦点该留在他点中的地方（没点中可聚焦的东西就落回 body）
    if (kept instanceof HTMLElement && kept !== document.body && kept.isConnected) kept.focus();
    else if (rootEl.value?.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
  };
  pendingRelease = finish;
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
}

function flushPendingRelease(): void {
  pendingRelease?.();
}

function toggle(): void {
  if (open.value) close();
  else void openMenu();
}

function choose(id: ActionPanelStyleId): void {
  if (id !== props.current) emit('select', id);
  close();
}

/** 菜单内上下键 / Home / End 移动焦点（Esc 与 Tab 归 ownModalFocus） */
function onMenuKeydown(event: KeyboardEvent): void {
  const list = items();
  if (list.length === 0) return;
  const at = list.indexOf(document.activeElement as HTMLButtonElement);
  let next = -1;
  if (event.key === 'ArrowDown') next = (at + 1) % list.length;
  else if (event.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = list.length - 1;
  if (next < 0) return;
  event.preventDefault();
  list[next]?.focus();
}

onBeforeUnmount(() => {
  close();
  flushPendingRelease();
});
</script>

<template>
  <div ref="rootEl" class="ap-style">
    <button
      type="button"
      class="ap-style-btn"
      aria-haspopup="menu"
      :aria-expanded="open"
      aria-label="切换面板样式"
      title="切换面板样式"
      @click="toggle"
      @keydown.down.prevent="openMenu"
    >
      <i class="fa-solid fa-gear" aria-hidden="true" />
    </button>
    <div
      v-if="open"
      ref="menuEl"
      class="ap-style-menu"
      role="menu"
      aria-label="面板样式"
      tabindex="-1"
      @keydown="onMenuKeydown"
    >
      <button
        v-for="s in ACTION_PANEL_STYLES"
        :key="s.id"
        type="button"
        role="menuitemradio"
        class="ap-style-item"
        :aria-checked="s.id === current"
        :data-style-id="s.id"
        :title="s.description"
        @click="choose(s.id)"
      >
        <span class="ap-style-mark" aria-hidden="true" />{{ s.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.ap-style {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
}

.ap-style-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  opacity: 0.7;
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    opacity var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard);
}

.ap-style-btn:hover,
.ap-style-btn[aria-expanded='true'] {
  color: var(--theme-primary);
  opacity: 1;
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}

.ap-style-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
  opacity: 1;
}

.ap-style-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  display: grid;
  min-width: 8.5rem;
  padding: 4px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-md);
}

.ap-style-menu:focus {
  outline: none;
}

.ap-style-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--motion-duration-fast) var(--motion-ease-standard);
}

.ap-style-item:hover,
.ap-style-item:focus-visible {
  outline: none;
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  color: var(--theme-text-primary);
}

.ap-style-item[aria-checked='true'] {
  color: var(--theme-primary);
  font-weight: 600;
}

.ap-style-mark {
  flex: none;
  width: 6px;
  height: 6px;
  border: 1px solid currentColor;
  border-radius: 50%;
}

.ap-style-item[aria-checked='true'] .ap-style-mark {
  background: currentColor;
}
</style>
