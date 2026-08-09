<script setup lang="ts">
/**
 * CgGalleryPanel — CG 图鉴（§10.3）
 *
 * 同一批 `SceneImageRecord` 的**第二个视图**，零新数据模型: 折叠 / 排序在
 * `cg-gallery.ts`（纯函数），字节 → URL 在 `useSceneImageUrls`（复用那份引用计数
 * LRU），本组件只负责把两者接起来 + 把详情栏的事件翻译成 store 调用。
 *
 * 🔴 **懒加载是双保险**（§10.3）: `IntersectionObserver` **加上**一个 500ms 的定时
 * 兜底扫描（`getBoundingClientRect()` 对视口 ±1500px 复查）。单靠观察器在低带宽 /
 * 弱设备上会不触发 —— 首帧还没排版好、回调被长任务推迟，都会让一屏格子停在空白框上，
 * 而且是那种「我这边好好的」的 bug。两道保险各自独立，都只调幂等的 `load()`。
 *
 * 🔴 **图鉴只列已经画出来的**: 未生成的标记与失败的记录都不进（判据在 `cg-gallery.ts`
 * 的 `isGalleryVisible`）。塞灰格子会让它从战利品陈列变成待办清单，补画 / 重试的入口
 * 都在正文里。已清理（`blobDropped`）的**要列**，但显示成「字节已清理」而不是破图。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useImagePresetStore } from '../../stores/image-preset-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useSceneImageUrls } from '../../composables/useSceneImageUrls';
import { buildGalleryCells, isNearViewport, GALLERY_PRELOAD_MARGIN } from './cg-gallery';
import CgGalleryDetail from './CgGalleryDetail.vue';
import type { SceneImageRecord } from '@engine/types-image';

const game = useGameStore();
const ui = useUIStore();
const store = useSceneImageStore();
const presets = useImagePresetStore();
// 只为了把当前方言 id 递给详情栏那句重画提醒（C14）——
// 详情栏是纯呈现组件（不认识 store），供值的人只能是这里
const settings = useSettingsStore();

const urls = useSceneImageUrls({ source: { blobOf: (id) => store.blobOf(id) } });

const busy = ref(false);

const cells = computed(() => buildGalleryCells(store.records));

// ═══ 选中 ═══

const selectedKey = ref<string | null>(null);
const selectedTakeId = ref<string | null>(null);

const selectedCell = computed(() => cells.value.find((c) => c.key === selectedKey.value) ?? null);
/** 选中的那一 take；指定的那条没了（被删 / 换存档）就退回该格当前显示的那张 */
const selectedRecord = computed<SceneImageRecord | null>(() => {
  const cell = selectedCell.value;
  if (!cell) return null;
  return cell.takes.find((t) => t.id === selectedTakeId.value) ?? cell.displayed;
});

watch(selectedRecord, (r) => {
  if (r) urls.load(r.id);
});

function select(key: string, takeId: string): void {
  selectedKey.value = key;
  selectedTakeId.value = takeId;
}

// ═══ 懒加载（观察器 + 定时兜底）═══

/** 格子 key → DOM 节点。**不在 ref 回调里删** —— 重渲染时的置空/置新顺序会误删刚挂上的那个 */
const cellEls = new Map<string, HTMLElement>();
let observer: IntersectionObserver | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * `:ref` 回调。参数是 `Element | ComponentPublicInstance | null`，这里只认真正的
 * DOM 节点 —— 收窄用行为判定（有没有 `getBoundingClientRect`）而不是 `instanceof`，
 * 于是本组件在没有 `HTMLElement` 全局的环境里也不会当场炸掉。
 */
function bindCell(el: unknown, key: string): void {
  if (el === null || typeof el !== 'object') return;
  const node = el as HTMLElement;
  if (typeof node.getBoundingClientRect !== 'function') return;
  node.dataset.cellKey = key;
  cellEls.set(key, node);
  observer?.observe(node);
}

/**
 * key → 该格要**装字节**的那张图的 id（懒加载只装这一张，其余 take 进详情时再装）。
 *
 * 已清理的返回 null: 字节确定不存在，去要一次只是白读一次 Dexie，然后照样渲染占位。
 */
function loadableIdOf(key: string): string | null {
  const displayed = cells.value.find((c) => c.key === key)?.displayed;
  if (!displayed || displayed.blobDropped === true) return null;
  return displayed.id;
}

/**
 * 定时兜底: 对**已挂载且还没装好**的格子按 `getBoundingClientRect()` 复查一遍。
 * 顺手剪掉已经离开 DOM 的节点（ref 回调不删，剪枝就得在这里做）。
 */
function sweep(): void {
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight;
  for (const [key, el] of [...cellEls]) {
    if (!el.isConnected) {
      cellEls.delete(key);
      continue;
    }
    const id = loadableIdOf(key);
    if (id === null || urls.urlFor(id) !== null) continue;
    if (isNearViewport(el.getBoundingClientRect(), viewportHeight)) urls.load(id);
  }
}

function startObserver(): void {
  if (typeof IntersectionObserver === 'undefined') return; // 兜底扫描独自顶上
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = (entry.target as HTMLElement).dataset.cellKey;
        if (key === undefined) continue;
        const id = loadableIdOf(key);
        if (id !== null) urls.load(id);
      }
    },
    { rootMargin: `${GALLERY_PRELOAD_MARGIN}px` },
  );
  for (const el of cellEls.values()) observer.observe(el);
}

onMounted(async () => {
  const saveId = game.activeSaveId;
  if (saveId && store.activeSaveId !== saveId) await store.load(saveId);
  await presets.init();
  await nextTick();
  startObserver();
  sweep();
  sweepTimer = setInterval(sweep, 500);
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
  if (sweepTimer !== null) clearInterval(sweepTimer);
  sweepTimer = null;
  cellEls.clear();
});

// 新格子进来（重画落地 / 换存档）后立刻复查一次，不必等下一个 500ms
watch(
  () => cells.value.length,
  () => void nextTick(sweep),
);

// ═══ 动作（详情栏只发事件，落库都在这儿）═══

async function withBusy(fn: () => Promise<unknown>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await fn();
  } catch (err) {
    console.error('[CgGalleryPanel] 操作失败:', err);
    ui.toast('操作失败，请重试', 'error');
  } finally {
    busy.value = false;
  }
}

function onUpdateTitle(value: string): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => store.update(r.id, { title: value }));
}

function onUpdateDescription(value: string): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => store.update(r.id, { description: value }));
}

/**
 * 存自定义提示词。**清空即回到 agent 那份** —— 存一个空串会让重画走
 * `editedScenePrompt` 的空值分支（store 只认非空），语义上含糊；直接删掉这个字段更干净。
 */
async function savePrompt(record: SceneImageRecord, value: string): Promise<void> {
  const trimmed = value.trim();
  const same = trimmed === (record.editedScenePrompt ?? record.scenePrompt ?? '').trim();
  if (same) return;
  await store.update(record.id, { editedScenePrompt: trimmed === '' ? undefined : trimmed });
}

async function redraw(record: SceneImageRecord): Promise<void> {
  const result = await store.generate({
    saveId: record.saveId,
    messageId: record.messageId,
    turn: record.turn,
    anchorKind: record.anchorKind,
    occurrence: record.occurrence,
    source: 'manual',
    intent: record.intent,
    title: record.title,
    description: record.description,
    characters: record.characters,
    rating: record.rating,
    redrawFrom: record.id,
  });
  if (result.ok) ui.toast('已排进生成队列', 'info');
  else ui.toast(result.message, 'warning');
}

function onSavePrompt(value: string): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => savePrompt(r, value));
}

function onSaveAndRedraw(value: string): void {
  const r = selectedRecord.value;
  if (!r) return;
  void withBusy(async () => {
    await savePrompt(r, value);
    // 🔴 必须**读回**落库后的那一行再重画: `redrawFrom` 继承的是库里的
    // `editedScenePrompt`，拿改之前的那份去继承等于用户白改一次（D26 那类挫败）。
    await redraw(store.find(r.id) ?? r);
  });
}

function onRedraw(): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => redraw(r));
}

function onPin(): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => store.pin(r.id));
}

function onToggleFavorite(): void {
  const r = selectedRecord.value;
  if (r) void withBusy(() => store.update(r.id, { favorite: r.favorite !== true }));
}

function onPinSeed(name: string, seed: number): void {
  void withBusy(async () => {
    const result = await presets.setPinnedSeed(name, seed);
    if (result.ok) ui.toast(`已把 seed ${seed} 钉给${name}`, 'success');
    else ui.toast(result.message, 'error');
  });
}

function onRemove(): void {
  const r = selectedRecord.value;
  if (!r) return;
  const ok = window.confirm(`删除这一张？\n「${r.title || '未命名插画'}」的图与记录都会消失。`);
  if (!ok) return;
  void withBusy(async () => {
    await store.remove(r.id);
    selectedTakeId.value = null;
    if (selectedCell.value === null) selectedKey.value = null;
  });
}

/** 扩展名从记录的 mime 派生 —— 记的是真正收到的那种类型（Q-21 的教训：别用预测值） */
function extOf(mime: string | undefined): string {
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  return 'png';
}

function onExport(): void {
  const r = selectedRecord.value;
  if (!r) return;
  const url = urls.urlFor(r.id);
  if (url === null) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(r.title || r.id).replace(/[\\/:*?"<>|]/g, '_')}.${extOf(r.mime)}`;
  a.click();
}

function onJump(): void {
  const r = selectedRecord.value;
  if (!r) return;
  const messageId = r.messageId;
  game.closeModal();
  // 弹窗要先卸载，正文那条消息才在 DOM 里
  requestAnimationFrame(() => {
    const escape =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape : null;
    const selector = `[data-message-id="${escape ? escape(messageId) : messageId}"]`;
    const el = document.querySelector(selector);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else ui.toast('那条消息已经不在当前对话里了', 'warning');
  });
}
</script>

<template>
  <div class="cg-gallery">
    <div class="panel-header">
      <span class="panel-title">CG 图鉴（{{ cells.length }}）</span>
      <span class="panel-hint">按剧情顺序排列；同一处的多次重画折在一格里</span>
    </div>

    <div v-if="cells.length > 0" class="gallery-body">
      <div class="cg-grid">
        <button
          v-for="cell in cells"
          :key="cell.key"
          :ref="(el) => bindCell(el, cell.key)"
          class="cg-cell"
          :class="{ selected: cell.key === selectedKey }"
          :aria-label="cell.displayed.title || '未命名插画'"
          @click="select(cell.key, cell.displayed.id)"
        >
          <span class="cg-thumb">
            <span v-if="cell.displayed.blobDropped === true" class="cg-thumb-dropped">
              字节已清理
            </span>
            <img
              v-else-if="urls.urlFor(cell.displayed.id)"
              class="cg-thumb-img"
              :src="urls.urlFor(cell.displayed.id) ?? ''"
              :alt="cell.displayed.title || '插画'"
            />
            <span v-else class="cg-thumb-skeleton" aria-hidden="true"></span>
            <span v-if="cell.takes.length > 1" class="cg-badge">×{{ cell.takes.length }}</span>
            <span v-if="cell.displayed.favorite === true" class="cg-fav" aria-label="已收藏"
              >★</span
            >
          </span>
          <span class="cg-cell-title">{{ cell.displayed.title || '未命名插画' }}</span>
          <span class="cg-cell-turn">第 {{ cell.turn }} 回合</span>
        </button>
      </div>

      <CgGalleryDetail
        v-if="selectedCell && selectedRecord"
        :record="selectedRecord"
        :takes="selectedCell.takes"
        :url="urls.urlFor(selectedRecord.id)"
        :busy="busy"
        :dialect-id="settings.settings.imageDialectId"
        @select-take="selectedTakeId = $event"
        @update-title="onUpdateTitle"
        @update-description="onUpdateDescription"
        @save-prompt="onSavePrompt"
        @save-and-redraw="onSaveAndRedraw"
        @redraw="onRedraw"
        @pin="onPin"
        @pin-seed="onPinSeed"
        @toggle-favorite="onToggleFavorite"
        @export-image="onExport"
        @jump="onJump"
        @remove="onRemove"
        @close="selectedKey = null"
      />
    </div>

    <div v-else class="empty-tab">画卷尚空 —— 故事里出现值得配图的时刻，画好的插画会收在这里</div>
  </div>
</template>

<style scoped>
.cg-gallery {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm);
}
.panel-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.panel-title {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.panel-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.gallery-body {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-lg);
}
.cg-grid {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
  gap: var(--theme-spacing-md);
}
.cg-cell {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm);
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-primary);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    border-color var(--theme-transition-fast, 0.15s ease);
}
.cg-cell:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.cg-cell.selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-primary);
}
.cg-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 3 / 2;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm);
}
.cg-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cg-thumb-dropped,
.cg-thumb-skeleton {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.cg-thumb-skeleton {
  background: linear-gradient(
    90deg,
    var(--theme-surface-muted),
    color-mix(in srgb, var(--theme-card-border) 40%, var(--theme-surface-muted)),
    var(--theme-surface-muted)
  );
  animation: cg-shimmer 1.6s ease-in-out infinite;
}
@keyframes cg-shimmer {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cg-thumb-skeleton {
    animation: none;
    opacity: 0.7;
  }
}
.cg-badge,
.cg-fav {
  position: absolute;
  top: 4px;
  font-size: 0.625rem;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--theme-window-bg) 70%, transparent);
  color: var(--theme-text-secondary);
}
.cg-badge {
  right: 4px;
}
.cg-fav {
  left: 4px;
  color: var(--theme-primary);
}
.cg-cell-title {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cg-cell-turn {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}
</style>
