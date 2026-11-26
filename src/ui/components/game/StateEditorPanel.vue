<script setup lang="ts">
/**
 * 变量修改器（状态树协议 T11，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §11）
 *
 * 左栏：可折叠的状态树（世界、主角、关系列表、任务列表、变量）+ 按名字或路径搜索；
 * 右栏：选中节点的编辑表单。编辑 → PlayerEditOp → 试算（将要发生的变更）→ 玩家确认 →
 * `stateEdit.commitStateEdit`（整批原子）→ 成功后回读，面板与游戏页状态面板一起刷新。
 *
 * 2026-11-25 审查 R6 拆分：本组件是壳（读快照、锁定、选中与展开、草稿、试算与提交、撤销），
 * 三块界面在 `state-editor/`：`StateEditorTree`（树导航）、`StateEditorFieldForm`（字段表单）、
 * `StateEditorPreview`（预览确认）。写入编排在 `stores/state-edit-store.ts`。
 *
 * 🔴 判定全在 `state-editor-view.ts`（只读键、控件、草稿 → op、试算清单、锁定原因），本组件只画。
 * 🔴 全程文本插值，不用 v-html（树上的名字与文本来自模型输出）。
 * 🔴 手改不告知模型（§9 #18）：这里不产、也不提示任何「修正提示」。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useStateEditStore } from '../../stores/state-edit-store';
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import { buildStateTree } from '@engine/variables/state-tree-projection';
import { previewPlayerEdit, type PlayerEditOp } from '@engine/variables/state-tree-edit';
import type { TreeTranslateSnapshot } from '@engine/variables/state-tree-translator';
import {
  buildEditorTree,
  collectDraftOps,
  describeOps,
  describePreview,
  findEditorNode,
  indexEditorFields,
  isFieldDirty,
  parentPointer,
  stateEditorLockReason,
  undoAvailability,
  type EditorNode,
  type FieldDraft,
  type PreviewView,
} from './state-editor-view';
import { resolveEditorFocus } from './state-update-view';
import StateEditorTree from './state-editor/StateEditorTree.vue';
import StateEditorFieldForm from './state-editor/StateEditorFieldForm.vue';
import StateEditorPreview from './state-editor/StateEditorPreview.vue';

const emit = defineEmits<{ close: [] }>();

const game = useGameStore();
const stateEdit = useStateEditStore();
const ui = useUIStore();

// ═══ 数据：每次打开从库里新读（§11.1） ═══
const snapshot = ref<TreeTranslateSnapshot | null>(null);
const loadState = ref<'loading' | 'ready' | 'error'>('loading');

async function reload() {
  try {
    const snap = await stateEdit.readStateEditorSnapshot();
    snapshot.value = snap;
    loadState.value = snap ? 'ready' : 'error';
  } catch (err) {
    console.error('[StateEditorPanel] 读取存档状态失败:', err);
    loadState.value = 'error';
  }
}
onMounted(async () => {
  await reload();
  applyFocus(stateEdit.consumeStateEditorFocus());
});

const latestTurn = computed(() => {
  for (let i = game.messages.length - 1; i >= 0; i--) {
    const m = game.messages[i];
    if (m.role === 'user') return m.turn ?? 0;
  }
  return 0;
});

const nodes = computed<EditorNode[]>(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const tree = buildStateTree(
    { characters: snap.characters, profile: snap.profile, turn: latestTurn.value },
    { visibility: { mode: 'all' } },
  );
  return buildEditorTree(tree);
});
const fieldIndex = computed(() => indexEditorFields(nodes.value));

// ═══ 锁定（§11.4） ═══
const lockReason = computed(() =>
  stateEditorLockReason({
    isGenerating: game.isGenerating,
    isRewriting: game.isRewriting,
    isInCombat: game.isInCombat,
  }),
);
const locked = computed(() => lockReason.value !== '');

// ═══ 左栏：选中与展开（树本身在 StateEditorTree） ═══
const selectedPath = ref('/主角');
const expanded = ref<Set<string>>(new Set(['/主角']));
const fieldForm = ref<InstanceType<typeof StateEditorFieldForm> | null>(null);

function toggle(path: string) {
  const next = new Set(expanded.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expanded.value = next;
}

function select(node: EditorNode) {
  selectedPath.value = node.path;
  focusedField.value = null;
  // 选中带下级的节点顺手展开（收起只走左侧小箭头 / ←）
  if (node.children.length > 0 && !expanded.value.has(node.path)) toggle(node.path);
  fieldForm.value?.cancelStructural();
}

const selected = computed(() => findEditorNode(nodes.value, selectedPath.value));

/**
 * 从更新块跳过来（「在变量修改器中打开此路径」）：选中持有该路径的节点、展开祖先，
 * 路径恰好是字段时滚到那一格并高亮。落点判定在 state-update-view 的 `resolveEditorFocus`。
 */
const focusedField = ref<string | null>(null);
function applyFocus(path: string | null) {
  if (!path) return;
  const focus = resolveEditorFocus(nodes.value, path);
  if (!focus) return;
  selectedPath.value = focus.nodePath;
  expanded.value = new Set([...expanded.value, ...focus.expand]);
  focusedField.value = focus.fieldPath ?? null;
  if (!focus.fieldPath) return;
  void nextTick(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('.se-field[data-path]')).find(
      (e) => e.dataset.path === focus.fieldPath,
    );
    el?.scrollIntoView?.({ block: 'center' });
  });
}

// 提交后选中项可能已经没了（删除 / 改名）：退到最近的祖先
watch(nodes, (list) => {
  if (list.length === 0 || findEditorNode(list, selectedPath.value)) return;
  let p = selectedPath.value;
  while (p && !findEditorNode(list, p)) p = parentPointer(p);
  selectedPath.value = p || list[0].path;
});

// ═══ 右栏：草稿（跨节点保留；编辑在 StateEditorFieldForm） ═══
const drafts = ref<Record<string, FieldDraft>>({});
const tagInputs = ref<Record<string, string>>({});

const dirtyCount = computed(() => {
  let n = 0;
  for (const [path, d] of Object.entries(drafts.value)) {
    const f = fieldIndex.value.get(path);
    if (f && isFieldDirty(f, d)) n++;
  }
  return n;
});

function discardDrafts() {
  drafts.value = {};
  tagInputs.value = {};
}

// ═══ 试算 → 确认 → 提交（§11.2） ═══
const pending = ref<null | { ops: PlayerEditOp[]; view: PreviewView }>(null);
const draftErrors = ref<string[]>([]);
const committing = ref(false);
const commitReasons = ref<string[]>([]);

function openPreview(ops: PlayerEditOp[]) {
  const snap = snapshot.value;
  if (!snap || ops.length === 0) return;
  commitReasons.value = [];
  pending.value = { ops, view: describePreview(previewPlayerEdit(ops, snap)) };
}

function previewDrafts() {
  const { ops, errors } = collectDraftOps(fieldIndex.value, new Map(Object.entries(drafts.value)));
  draftErrors.value = errors;
  if (errors.length > 0) return;
  if (ops.length === 0) {
    ui.toast('没有改动', 'info');
    return;
  }
  openPreview(ops);
}

function closePreview() {
  pending.value = null;
  commitReasons.value = [];
}

async function confirmCommit() {
  const p = pending.value;
  if (!p || !p.view.ok || committing.value || locked.value) return;
  committing.value = true;
  try {
    const result = await stateEdit.commitStateEdit(p.ops, describeOps(p.ops));
    if (!result.ok) {
      commitReasons.value = result.reasons;
      return;
    }
    pending.value = null;
    discardDrafts();
    await reload();
    ui.toast('修改已提交', 'success');
  } finally {
    committing.value = false;
  }
}

// ═══ 撤销（§11.4） ═══
const undoState = computed(() => undoAvailability(stateEdit.stateEditUndoStack));
const undoLabel = computed(() => {
  const stack = stateEdit.stateEditUndoStack;
  return stack.length > 0 ? stack[stack.length - 1].label : '';
});
const undoing = ref(false);

async function undoLast() {
  if (!undoState.value.canUndo || undoing.value || locked.value) return;
  undoing.value = true;
  try {
    const result = await stateEdit.undoLastStateEdit();
    if (!result.ok) {
      ui.toast(`撤销失败：${result.reasons.join('；')}`, 'error');
      return;
    }
    discardDrafts();
    pending.value = null;
    await reload();
    ui.toast('已撤销上一次修改', 'success');
  } finally {
    undoing.value = false;
  }
}
</script>

<template>
  <div class="se">
    <!-- ═══ 页头 ═══ -->
    <div class="se-head">
      <div class="se-head-text">
        <h2 class="se-title">变量</h2>
        <p class="se-subtitle">查看并手动纠正存档状态。带锁的键由代码维护，不能在这里改。</p>
      </div>
      <button class="se-close" type="button" aria-label="关闭" @click="emit('close')">×</button>
    </div>

    <div v-if="locked" class="se-lock" role="status" data-testid="state-editor-lock">
      <i class="fa-solid fa-lock" aria-hidden="true" />
      <span>{{ lockReason }}，当前只能查看。</span>
    </div>

    <div v-if="loadState === 'loading'" class="se-empty" role="status">正在读取存档状态…</div>
    <div v-else-if="loadState === 'error'" class="se-empty">
      读取存档状态失败
      <AppButton size="sm" variant="secondary" @click="reload()">重试</AppButton>
    </div>

    <div v-else class="se-body">
      <!-- ═══ 左栏：状态树 ═══ -->
      <StateEditorTree
        :nodes="nodes"
        :selected-path="selectedPath"
        :expanded="expanded"
        @select="select"
        @toggle="toggle"
      />

      <!-- ═══ 右栏：编辑表单 ═══ -->
      <section class="se-detail">
        <StateEditorFieldForm
          v-if="selected"
          ref="fieldForm"
          v-model:drafts="drafts"
          v-model:tag-inputs="tagInputs"
          :node="selected"
          :nodes="nodes"
          :locked="locked"
          :focused-field="focusedField"
          :draft-errors="draftErrors"
          :dirty-count="dirtyCount"
          @preview="openPreview"
          @preview-drafts="previewDrafts"
          @discard="discardDrafts"
        />
        <div v-else class="empty-tab">在左侧选择一个节点</div>

        <!-- ═══ 将要发生的变更（试算） ═══ -->
        <StateEditorPreview
          v-if="pending"
          :view="pending.view"
          :commit-reasons="commitReasons"
          :locked="locked"
          :committing="committing"
          @close="closePreview"
          @confirm="confirmCommit"
        />
      </section>
    </div>

    <!-- ═══ 页脚：撤销 + 回退说明（§11.4） ═══ -->
    <div class="se-foot">
      <AppButton
        size="sm"
        variant="secondary"
        :disabled="locked || !undoState.canUndo"
        :loading="undoing"
        data-testid="state-editor-undo"
        @click="undoLast()"
        >撤销上一次修改</AppButton
      >
      <span class="se-foot-hint">{{
        undoState.canUndo ? `上一次：${undoLabel}` : undoState.reason
      }}</span>
      <span class="se-foot-note">撤销只保留到本回合结束。回退本轮会连同本轮之后的手改一起丢。</span>
    </div>
  </div>
</template>

<style scoped src="./state-editor/state-editor-shared.css"></style>
<style scoped>
.se {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--theme-text-primary);
}

/* ═══ 页头 ═══ */
.se-head {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl) var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
}
.se-head-text {
  flex: 1;
  min-width: 0;
}
.se-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
}
.se-subtitle {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.se-close {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.35rem;
  line-height: 1;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    color var(--theme-transition-fast),
    background var(--theme-transition-fast);
}
.se-close:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}

.se-lock {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: var(--theme-spacing-md) var(--theme-spacing-xl) 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-size: 0.8125rem;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-md);
}

/* ═══ 两栏（左栏外壳样式在 StateEditorTree） ═══ */
.se-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--theme-spacing-lg);
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
}

.se-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}

/* ═══ 页脚 ═══ */
.se-foot {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
  padding: var(--theme-spacing-md) var(--theme-spacing-xl);
  border-top: 1px solid var(--theme-card-border);
  font-size: 0.75rem;
}
.se-foot-hint {
  color: var(--theme-text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 24rem;
}
.se-foot-note {
  margin-left: auto;
  color: var(--theme-text-muted);
}

.se-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-md);
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
}

@media (prefers-reduced-motion: reduce) {
  .se-close {
    transition: none;
  }
}

/* 窄屏：两栏叠成一栏（左栏宽度在 StateEditorTree） */
@media (max-width: 900px) {
  .se-body {
    flex-direction: column;
    padding: var(--theme-spacing-md);
    overflow-y: auto;
  }
  .se-head,
  .se-foot {
    padding-left: var(--theme-spacing-lg);
    padding-right: var(--theme-spacing-lg);
  }
}
</style>
