<script setup lang="ts">
/**
 * 变量修改器（状态树协议 T11，设计 docs/planning/2026-11-22-mvu-projection-protocol-design.md §11）
 *
 * 左栏：可折叠的状态树（世界、主角、关系列表、任务列表、变量）+ 按名字或路径搜索；
 * 右栏：选中节点的编辑表单。编辑 → PlayerEditOp → 试算（将要发生的变更）→ 玩家确认 →
 * `game.commitStateEdit`（整批原子）→ 成功后回读，面板与游戏页状态面板一起刷新。
 *
 * 🔴 判定全在 `state-editor-view.ts`（只读键、控件、草稿 → op、试算清单、锁定原因），本组件只画。
 * 🔴 全程文本插值，不用 v-html（树上的名字与文本来自模型输出）。
 * 🔴 手改不告知模型（§9 #18）：这里不产、也不提示任何「修正提示」。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import { buildStateTree } from '@engine/variables/state-tree-projection';
import { previewPlayerEdit, type PlayerEditOp } from '@engine/variables/state-tree-edit';
import type { TreeTranslateSnapshot } from '@engine/variables/state-tree-translator';
import {
  addEntryOp,
  buildEditorTree,
  collectDraftOps,
  describeOps,
  describePreview,
  findEditorNode,
  formatEditorValue,
  indexEditorFields,
  initialDraft,
  isFieldDirty,
  parentPointer,
  removeEntryOp,
  renameEntryOp,
  searchEditorTree,
  stateEditorLockReason,
  undoAvailability,
  validateEntryName,
  type DictDraftRow,
  type EditorField,
  type EditorNode,
  type FieldDraft,
  type PreviewView,
} from './state-editor-view';
import { resolveEditorFocus } from './state-update-view';

const emit = defineEmits<{ close: [] }>();

const game = useGameStore();
const ui = useUIStore();

// ═══ 数据：每次打开从库里新读（§11.1） ═══
const snapshot = ref<TreeTranslateSnapshot | null>(null);
const loadState = ref<'loading' | 'ready' | 'error'>('loading');

async function reload() {
  try {
    const snap = await game.readStateEditorSnapshot();
    snapshot.value = snap;
    loadState.value = snap ? 'ready' : 'error';
  } catch (err) {
    console.error('[StateEditorPanel] 读取存档状态失败:', err);
    loadState.value = 'error';
  }
}
onMounted(async () => {
  await reload();
  applyFocus(game.consumeStateEditorFocus());
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

// ═══ 左栏：树、折叠、搜索 ═══
const selectedPath = ref('/主角');
const expanded = ref<Set<string>>(new Set(['/主角']));
const query = ref('');
const search = computed(() => searchEditorTree(nodes.value, query.value));

interface TreeRow {
  node: EditorNode;
  depth: number;
  open: boolean;
}

const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = [];
  const s = search.value;
  const walk = (list: readonly EditorNode[], depth: number) => {
    for (const node of list) {
      if (s && !s.visible.has(node.path)) continue;
      const open = s ? s.expanded.has(node.path) : expanded.value.has(node.path);
      out.push({ node, depth, open });
      if (open && node.children.length > 0) walk(node.children, depth + 1);
    }
  };
  walk(nodes.value, 1);
  return out;
});

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
  cancelStructural();
}

function onRowKey(e: KeyboardEvent, row: TreeRow) {
  if (row.node.children.length === 0) return;
  if (e.key === 'ArrowRight' && !row.open) toggle(row.node.path);
  else if (e.key === 'ArrowLeft' && row.open) toggle(row.node.path);
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

// ═══ 右栏：草稿 ═══
const drafts = ref<Record<string, FieldDraft>>({});
const tagInputs = ref<Record<string, string>>({});

function draftOf(field: EditorField): FieldDraft {
  return Object.prototype.hasOwnProperty.call(drafts.value, field.path)
    ? drafts.value[field.path]
    : initialDraft(field);
}
function setDraft(field: EditorField, value: FieldDraft) {
  drafts.value = { ...drafts.value, [field.path]: value };
}
function textDraft(field: EditorField): string {
  const d = draftOf(field);
  return typeof d === 'string' ? d : '';
}
function tagsDraft(field: EditorField): string[] {
  const d = draftOf(field);
  return Array.isArray(d) ? (d as string[]) : [];
}
function dictDraft(field: EditorField): DictDraftRow[] {
  const d = draftOf(field);
  return Array.isArray(d) ? (d as DictDraftRow[]) : [];
}
function onInput(field: EditorField, e: Event) {
  setDraft(field, (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value);
}
function addTag(field: EditorField) {
  const text = (tagInputs.value[field.path] ?? '').trim();
  if (!text) return;
  const list = tagsDraft(field);
  if (!list.includes(text)) setDraft(field, [...list, text]);
  tagInputs.value = { ...tagInputs.value, [field.path]: '' };
}
function removeTag(field: EditorField, index: number) {
  setDraft(
    field,
    tagsDraft(field).filter((_, i) => i !== index),
  );
}
function setDictRow(field: EditorField, index: number, part: 'key' | 'value', e: Event) {
  const rowsNow = dictDraft(field).map((r) => ({ ...r }));
  rowsNow[index][part] = (e.target as HTMLInputElement).value;
  setDraft(field, rowsNow);
}
function addDictRow(field: EditorField) {
  setDraft(field, [...dictDraft(field).map((r) => ({ ...r })), { key: '', value: '' }]);
}
function removeDictRow(field: EditorField, index: number) {
  setDraft(
    field,
    dictDraft(field).filter((_, i) => i !== index),
  );
}
function resetField(field: EditorField) {
  const next = { ...drafts.value };
  delete next[field.path];
  drafts.value = next;
}

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

// ═══ 结构编辑（字典增删改名） ═══
const structural = ref<null | { mode: 'add' | 'rename'; name: string }>(null);
const structuralError = computed(() => {
  const st = structural.value;
  const node = selected.value;
  if (!st || !node) return '';
  if (st.mode === 'add') return validateEntryName(node, st.name) ?? '';
  const parent = findEditorNode(nodes.value, parentPointer(node.path));
  return parent ? (validateEntryName(parent, st.name, node.path) ?? '') : '';
});
function startAdd() {
  structural.value = { mode: 'add', name: '' };
}
function startRename() {
  structural.value = { mode: 'rename', name: selected.value?.label ?? '' };
}
function cancelStructural() {
  structural.value = null;
}
function confirmStructural() {
  const st = structural.value;
  const node = selected.value;
  if (!st || !node || structuralError.value) return;
  const op = st.mode === 'add' ? addEntryOp(node, st.name) : renameEntryOp(node.path, st.name);
  structural.value = null;
  openPreview([op]);
}
function requestRemove(path: string) {
  openPreview([removeEntryOp(path)]);
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
    const result = await game.commitStateEdit(p.ops, describeOps(p.ops));
    if (!result.ok) {
      commitReasons.value = result.reasons;
      return;
    }
    pending.value = null;
    discardDrafts();
    await reload();
    ui.toast(
      result.undo.length > 0 ? '修改已提交' : '修改已提交（这次修改无法自动撤销）',
      'success',
    );
  } finally {
    committing.value = false;
  }
}

// ═══ 撤销（§11.4） ═══
const undoState = computed(() => undoAvailability(game.stateEditUndoStack));
const undoLabel = computed(() => {
  const stack = game.stateEditUndoStack;
  return stack.length > 0 ? stack[stack.length - 1].label : '';
});
const undoing = ref(false);

async function undoLast() {
  if (!undoState.value.canUndo || undoing.value || locked.value) return;
  undoing.value = true;
  try {
    const result = await game.undoLastStateEdit();
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

function statusClass(status: string): string {
  if (status === '已丢弃') return 'is-dropped';
  if (status === '已纠正') return 'is-corrected';
  return 'is-applied';
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
      <aside class="se-tree">
        <label class="se-search">
          <i class="fa-solid fa-magnifying-glass" aria-hidden="true" />
          <input
            v-model="query"
            type="search"
            placeholder="按名字或路径搜索"
            aria-label="按名字或路径搜索"
          />
        </label>
        <div class="se-tree-scroll" role="tree" aria-label="状态树">
          <div
            v-for="row in rows"
            :key="row.node.path"
            class="se-row"
            :class="{
              'is-selected': row.node.path === selectedPath,
              'is-match': search?.matched.has(row.node.path),
            }"
            :style="{ '--depth': row.depth }"
          >
            <button
              v-if="row.node.children.length > 0 && !search"
              class="se-caret"
              type="button"
              :aria-label="row.open ? `折叠 ${row.node.label}` : `展开 ${row.node.label}`"
              tabindex="-1"
              @click="toggle(row.node.path)"
            >
              <i class="fa-solid fa-chevron-right" :class="{ open: row.open }" aria-hidden="true" />
            </button>
            <span v-else class="se-caret-spacer" aria-hidden="true" />
            <button
              class="se-row-label"
              type="button"
              role="treeitem"
              :aria-level="row.depth"
              :aria-selected="row.node.path === selectedPath"
              :aria-expanded="row.node.children.length > 0 ? row.open : undefined"
              :data-path="row.node.path"
              @click="select(row.node)"
              @keydown="onRowKey($event, row)"
            >
              <span class="se-row-name">{{ row.node.label }}</span>
              <span v-if="row.node.kind === 'record'" class="se-row-count">{{
                row.node.children.length
              }}</span>
            </button>
          </div>
          <div v-if="rows.length === 0" class="empty-tab">没有匹配的条目</div>
        </div>
      </aside>

      <!-- ═══ 右栏：编辑表单 ═══ -->
      <section class="se-detail">
        <template v-if="selected">
          <div class="se-detail-head">
            <div>
              <h3 class="se-node-name">{{ selected.label }}</h3>
              <code class="se-node-path">{{ selected.path }}</code>
            </div>
            <div class="se-node-actions">
              <AppButton
                v-if="selected.canAdd"
                size="sm"
                variant="secondary"
                :disabled="locked"
                @click="startAdd()"
                >新增条目</AppButton
              >
              <AppButton
                v-if="selected.canRename"
                size="sm"
                variant="secondary"
                :disabled="locked"
                @click="startRename()"
                >改名</AppButton
              >
              <AppButton
                v-if="selected.canRemove"
                size="sm"
                variant="danger"
                :disabled="locked"
                data-testid="state-editor-remove"
                @click="requestRemove(selected.path)"
                >删除</AppButton
              >
            </div>
          </div>

          <form v-if="structural" class="se-structural" @submit.prevent="confirmStructural()">
            <label class="se-structural-label">
              {{ structural.mode === 'add' ? '新条目名' : '新名字' }}
              <input
                v-model="structural.name"
                type="text"
                :disabled="locked"
                :aria-invalid="structuralError !== '' || undefined"
              />
            </label>
            <span v-if="structuralError" class="se-inline-error">{{ structuralError }}</span>
            <div class="se-structural-actions">
              <AppButton
                size="sm"
                variant="primary"
                type="submit"
                :disabled="locked || structuralError !== ''"
                >预览</AppButton
              >
              <AppButton size="sm" variant="ghost" type="button" @click="cancelStructural()"
                >取消</AppButton
              >
            </div>
          </form>

          <div class="se-detail-scroll">
            <div v-if="selected.fields.length === 0" class="empty-tab">
              {{
                selected.children.length > 0
                  ? '在左侧选择下一级条目'
                  : selected.canAdd
                    ? '还没有条目'
                    : '这里没有可编辑的字段'
              }}
            </div>

            <div v-else class="se-fields">
              <div
                v-for="field in selected.fields"
                :key="field.path"
                class="se-field"
                :class="{
                  'is-readonly': field.readonly,
                  'is-dirty': isFieldDirty(field, draftOf(field)),
                  'is-focused': focusedField === field.path,
                }"
                :data-path="field.path"
              >
                <div class="se-field-label">
                  <i
                    v-if="field.readonly"
                    class="fa-solid fa-lock se-lock-icon"
                    aria-hidden="true"
                  />
                  <span>{{ field.label }}</span>
                  <button
                    v-if="!field.readonly && isFieldDirty(field, draftOf(field))"
                    class="se-link"
                    type="button"
                    @click="resetField(field)"
                  >
                    还原
                  </button>
                  <button
                    v-if="field.removable && !locked"
                    class="se-link se-link-danger"
                    type="button"
                    :aria-label="`删除变量 ${field.label}`"
                    @click="requestRemove(field.path)"
                  >
                    删除
                  </button>
                </div>

                <!-- 只读：可见、置灰、带锁与原因 -->
                <div v-if="field.readonly || field.control === 'display'" class="se-readonly">
                  <span class="se-readonly-value">{{ formatEditorValue(field.value) }}</span>
                  <span v-if="field.readonlyReason" class="se-readonly-reason">{{
                    field.readonlyReason
                  }}</span>
                </div>

                <input
                  v-else-if="field.control === 'number'"
                  type="number"
                  class="se-input"
                  :value="textDraft(field)"
                  :min="field.min"
                  :max="field.max"
                  step="1"
                  :disabled="locked"
                  :aria-label="field.label"
                  @input="onInput(field, $event)"
                />
                <input
                  v-else-if="field.control === 'text'"
                  type="text"
                  class="se-input"
                  :value="textDraft(field)"
                  :disabled="locked"
                  :aria-label="field.label"
                  @input="onInput(field, $event)"
                />
                <textarea
                  v-else-if="field.control === 'textarea'"
                  class="se-input se-textarea"
                  rows="3"
                  :value="textDraft(field)"
                  :disabled="locked"
                  :aria-label="field.label"
                  @input="onInput(field, $event)"
                />
                <select
                  v-else-if="field.control === 'select'"
                  class="se-input"
                  :value="textDraft(field)"
                  :disabled="locked"
                  :aria-label="field.label"
                  @change="onInput(field, $event)"
                >
                  <option value="" disabled>（未设置）</option>
                  <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <label v-else-if="field.control === 'toggle'" class="se-toggle">
                  <input
                    type="checkbox"
                    :checked="draftOf(field) === true"
                    :disabled="locked"
                    @change="setDraft(field, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ draftOf(field) === true ? '是' : '否' }}</span>
                </label>
                <div v-else-if="field.control === 'tags'" class="se-tags">
                  <span v-for="(tag, i) in tagsDraft(field)" :key="tag + i" class="se-tag">
                    {{ tag }}
                    <button
                      type="button"
                      class="se-tag-x"
                      :disabled="locked"
                      :aria-label="`移除 ${tag}`"
                      @click="removeTag(field, i)"
                    >
                      ×
                    </button>
                  </span>
                  <input
                    class="se-input se-tag-input"
                    type="text"
                    placeholder="输入后回车添加"
                    :value="tagInputs[field.path] ?? ''"
                    :disabled="locked"
                    :aria-label="`${field.label}：添加一项`"
                    @input="
                      tagInputs = {
                        ...tagInputs,
                        [field.path]: ($event.target as HTMLInputElement).value,
                      }
                    "
                    @keydown.enter.prevent="addTag(field)"
                  />
                </div>
                <div v-else-if="field.control === 'dict'" class="se-dict">
                  <div v-for="(row, i) in dictDraft(field)" :key="i" class="se-dict-row">
                    <input
                      class="se-input"
                      type="text"
                      placeholder="名称"
                      :value="row.key"
                      :disabled="locked"
                      :aria-label="`${field.label} 第 ${i + 1} 项名称`"
                      @input="setDictRow(field, i, 'key', $event)"
                    />
                    <input
                      class="se-input"
                      :type="field.dictValue === 'number' ? 'number' : 'text'"
                      placeholder="内容"
                      :value="row.value"
                      :disabled="locked"
                      :aria-label="`${field.label} 第 ${i + 1} 项内容`"
                      @input="setDictRow(field, i, 'value', $event)"
                    />
                    <button
                      type="button"
                      class="se-link se-link-danger"
                      :disabled="locked"
                      :aria-label="`删除 ${field.label} 第 ${i + 1} 项`"
                      @click="removeDictRow(field, i)"
                    >
                      删除
                    </button>
                  </div>
                  <button
                    type="button"
                    class="se-link"
                    :disabled="locked"
                    @click="addDictRow(field)"
                  >
                    + 添加一项
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="se-actions">
            <ul v-if="draftErrors.length > 0" class="se-errors" role="alert">
              <li v-for="e in draftErrors" :key="e">{{ e }}</li>
            </ul>
            <span class="se-dirty-count">{{
              dirtyCount > 0 ? `${dirtyCount} 项未提交的改动` : '没有未提交的改动'
            }}</span>
            <AppButton
              size="sm"
              variant="ghost"
              :disabled="dirtyCount === 0"
              @click="discardDrafts()"
              >放弃改动</AppButton
            >
            <AppButton
              size="sm"
              variant="primary"
              :disabled="locked || dirtyCount === 0"
              data-testid="state-editor-preview"
              @click="previewDrafts()"
              >预览修改</AppButton
            >
          </div>
        </template>
        <div v-else class="empty-tab">在左侧选择一个节点</div>

        <!-- ═══ 将要发生的变更（试算） ═══ -->
        <div
          v-if="pending"
          class="se-preview"
          role="region"
          aria-label="将要发生的变更"
          data-testid="state-editor-preview-panel"
        >
          <div class="se-sec-title">将要发生的变更</div>
          <ul class="se-preview-list">
            <li
              v-for="(row, i) in pending.view.rows"
              :key="row.path + i"
              class="se-preview-row"
              :class="statusClass(row.status)"
            >
              <div class="se-preview-top">
                <span class="se-preview-op">{{ row.op }}</span>
                <code class="se-preview-path">{{
                  row.from ? `${row.from} → ${row.path}` : row.path
                }}</code>
                <span class="se-preview-status">{{ row.status }}</span>
              </div>
              <div class="se-preview-values">
                <span class="se-before">{{ row.before }}</span>
                <span aria-hidden="true">→</span>
                <span class="se-after">{{ row.after }}</span>
              </div>
              <div v-if="row.note" class="se-preview-note">{{ row.note }}</div>
            </li>
          </ul>
          <ul
            v-if="!pending.view.ok || commitReasons.length > 0"
            class="se-errors"
            role="alert"
            data-testid="state-editor-reasons"
          >
            <li
              v-for="r in commitReasons.length > 0 ? commitReasons : pending.view.reasons"
              :key="r"
            >
              {{ r }}
            </li>
          </ul>
          <div class="se-preview-actions">
            <AppButton size="sm" variant="ghost" @click="closePreview()">返回修改</AppButton>
            <AppButton
              size="sm"
              variant="primary"
              :disabled="!pending.view.ok || locked"
              :loading="committing"
              data-testid="state-editor-confirm"
              @click="confirmCommit()"
              >确认提交</AppButton
            >
          </div>
        </div>
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

/* ═══ 两栏 ═══ */
.se-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--theme-spacing-lg);
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
}
.se-tree {
  width: 18rem;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.se-search {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-sm);
  min-height: 36px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-muted);
}
.se-search input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  outline: none;
}
.se-search:focus-within {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.se-tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.se-row {
  display: flex;
  align-items: center;
  padding-left: calc((var(--depth) - 1) * var(--theme-spacing-md));
  border-radius: var(--theme-radius-sm);
  transition: background var(--theme-transition-fast);
}
.se-row:hover {
  background: var(--theme-tab-hover-bg);
}
.se-row.is-selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.se-caret,
.se-caret-spacer {
  width: 24px;
  height: 32px;
  flex-shrink: 0;
}
.se-caret {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.6875rem;
}
.se-caret i {
  transition: transform var(--theme-transition-fast);
}
.se-caret i.open {
  transform: rotate(90deg);
}
.se-row-label {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-sm) 0 0;
  border: none;
  background: none;
  color: var(--theme-text-secondary);
  font: inherit;
  font-size: 0.8125rem;
  text-align: left;
  cursor: pointer;
}
.se-row.is-selected .se-row-label {
  color: var(--theme-text-primary);
  font-weight: 600;
}
.se-row.is-match .se-row-name {
  color: var(--theme-primary);
}
.se-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.5;
}
.se-row-count {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
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
.se-detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.se-node-name {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1rem;
  font-weight: 700;
}
.se-node-path,
.se-preview-path {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  word-break: break-all;
}
.se-node-actions {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}

.se-structural {
  display: flex;
  align-items: flex-end;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding: var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  border-radius: var(--theme-radius-md);
}
.se-structural-label {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.se-structural-label input {
  min-height: 36px;
  padding: 0 var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
}
.se-structural-actions {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.se-inline-error {
  font-size: 0.75rem;
  color: var(--theme-error);
}

.se-detail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.se-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: var(--theme-spacing-md) var(--theme-spacing-lg);
}
.se-field {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}
.se-field.is-focused {
  margin: calc(-1 * var(--theme-spacing-xs));
  padding: var(--theme-spacing-xs);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border));
}
.se-field-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.se-field.is-dirty .se-field-label > span {
  color: var(--theme-primary);
  font-weight: 600;
}
.se-lock-icon {
  font-size: 0.6875rem;
}
.se-input {
  width: 100%;
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font: inherit;
  font-size: 0.8125rem;
  box-sizing: border-box;
  transition: border-color var(--theme-transition-fast);
}
.se-input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
.se-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.se-textarea {
  resize: vertical;
  line-height: 1.55;
}
.se-readonly {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
}
.se-readonly-value {
  word-break: break-word;
}
.se-readonly-reason {
  font-size: 0.6875rem;
  font-style: italic;
}
.se-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  font-size: 0.8125rem;
  cursor: pointer;
}
.se-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  align-items: center;
}
.se-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px var(--theme-spacing-sm);
  font-size: 0.75rem;
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.se-tag-x {
  border: none;
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.875rem;
  line-height: 1;
}
.se-tag-input {
  flex: 1;
  min-width: 8rem;
}
.se-dict {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.se-dict-row {
  display: grid;
  grid-template-columns: 1fr 2fr auto;
  gap: var(--theme-spacing-xs);
  align-items: center;
}
.se-link {
  border: none;
  background: none;
  padding: 0 var(--theme-spacing-xs);
  font: inherit;
  font-size: 0.75rem;
  color: var(--theme-primary);
  cursor: pointer;
  align-self: flex-start;
  transition: color var(--theme-transition-fast);
}
.se-link:hover {
  color: var(--theme-text-primary);
}
.se-link-danger {
  color: var(--theme-error);
}
.se-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.se-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.se-dirty-count {
  margin-right: auto;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.se-errors {
  width: 100%;
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  list-style: none;
  font-size: 0.75rem;
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
  border-radius: var(--theme-radius-sm);
}

/* ═══ 试算清单 ═══ */
.se-preview {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  max-height: 45%;
  min-height: 0;
  padding: var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  border-radius: var(--theme-radius-md);
  animation: se-rise var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}
@keyframes se-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.se-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.se-sec-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.se-preview-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.se-preview-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  font-size: 0.8125rem;
}
.se-preview-row.is-corrected {
  border-color: color-mix(in srgb, var(--theme-warning) 40%, var(--theme-card-border));
}
.se-preview-row.is-dropped {
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
}
.se-preview-top {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.se-preview-op {
  font-weight: 600;
}
.se-preview-status {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.se-preview-row.is-dropped .se-preview-status {
  color: var(--theme-error);
}
.se-preview-row.is-corrected .se-preview-status {
  color: var(--theme-warning);
}
.se-preview-values {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  word-break: break-word;
}
.se-before {
  color: var(--theme-text-muted);
}
.se-preview-note {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-style: italic;
}
.se-preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
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

@media (prefers-reduced-motion: reduce) {
  .se-preview {
    animation: none;
  }
  .se-caret i,
  .se-row,
  .se-input,
  .se-close,
  .se-link {
    transition: none;
  }
}

/* 窄屏：两栏叠成一栏 */
@media (max-width: 900px) {
  .se-body {
    flex-direction: column;
    padding: var(--theme-spacing-md);
    overflow-y: auto;
  }
  .se-tree {
    width: auto;
    max-height: 40%;
  }
  .se-head,
  .se-foot {
    padding-left: var(--theme-spacing-lg);
    padding-right: var(--theme-spacing-lg);
  }
}
</style>
