<script setup lang="ts">
/**
 * 变量修改器右栏：选中节点的页头动作、结构编辑（字典增删改名）、字段表单与提交栏
 * （拆自 StateEditorPanel，2026-11-25 审查 R6）。
 *
 * 草稿（`drafts` / `tagInputs`）跨节点保留，由面板持有、经 v-model 双向绑定；本组件只改草稿、
 * 不碰 store。需要试算时把 op 交给面板（`preview`），整批草稿试算由面板做（`preview-drafts`）。
 * 结构编辑的输入只活在本组件；换选中节点时面板经 `cancelStructural` 收起它。
 *
 * 🔴 判定全在 `state-editor-view.ts`（只读键、控件、草稿 → op、名字校验），本组件只画。
 * 🔴 全程文本插值，不用 v-html（字段值来自模型输出）。
 * 多根片段：直接排进面板的 `.se-detail` 纵向布局。
 */
import { computed, ref } from 'vue';
import type { PlayerEditOp } from '@engine/variables/state-tree-edit';
import AppButton from '../../shared/AppButton.vue';
import {
  addEntryOp,
  findEditorNode,
  formatEditorValue,
  initialDraft,
  isFieldDirty,
  parentPointer,
  removeEntryOp,
  renameEntryOp,
  validateEntryName,
  type DictDraftRow,
  type EditorField,
  type EditorNode,
  type FieldDraft,
} from '../state-editor-view';

const props = defineProps<{
  node: EditorNode;
  nodes: readonly EditorNode[];
  locked: boolean;
  focusedField: string | null;
  draftErrors: readonly string[];
  dirtyCount: number;
}>();

const emit = defineEmits<{
  preview: [ops: PlayerEditOp[]];
  previewDrafts: [];
  discard: [];
}>();

const drafts = defineModel<Record<string, FieldDraft>>('drafts', { required: true });
const tagInputs = defineModel<Record<string, string>>('tagInputs', { required: true });

// ═══ 草稿 ═══
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

// ═══ 结构编辑（字典增删改名） ═══
const structural = ref<null | { mode: 'add' | 'rename'; name: string }>(null);
const structuralError = computed(() => {
  const st = structural.value;
  const node = props.node;
  if (!st) return '';
  if (st.mode === 'add') return validateEntryName(node, st.name) ?? '';
  const parent = findEditorNode(props.nodes, parentPointer(node.path));
  return parent ? (validateEntryName(parent, st.name, node.path) ?? '') : '';
});
function startAdd() {
  structural.value = { mode: 'add', name: '' };
}
function startRename() {
  structural.value = { mode: 'rename', name: props.node.label };
}
function cancelStructural() {
  structural.value = null;
}
function confirmStructural() {
  const st = structural.value;
  const node = props.node;
  if (!st || structuralError.value) return;
  const op = st.mode === 'add' ? addEntryOp(node, st.name) : renameEntryOp(node.path, st.name);
  structural.value = null;
  emit('preview', [op]);
}
function requestRemove(path: string) {
  emit('preview', [removeEntryOp(path)]);
}

defineExpose({ cancelStructural });
</script>

<template>
  <div class="se-detail-head">
    <div>
      <h3 class="se-node-name">{{ node.label }}</h3>
      <code class="se-node-path">{{ node.path }}</code>
    </div>
    <div class="se-node-actions">
      <AppButton
        v-if="node.canAdd"
        size="sm"
        variant="secondary"
        :disabled="locked"
        @click="startAdd()"
        >新增条目</AppButton
      >
      <AppButton
        v-if="node.canRename"
        size="sm"
        variant="secondary"
        :disabled="locked"
        @click="startRename()"
        >改名</AppButton
      >
      <AppButton
        v-if="node.canRemove"
        size="sm"
        variant="danger"
        :disabled="locked"
        data-testid="state-editor-remove"
        @click="requestRemove(node.path)"
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
    <div v-if="node.fields.length === 0" class="empty-tab">
      {{
        node.children.length > 0
          ? '在左侧选择下一级条目'
          : node.canAdd
            ? '还没有条目'
            : '这里没有可编辑的字段'
      }}
    </div>

    <div v-else class="se-fields">
      <div
        v-for="field in node.fields"
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
          <i v-if="field.readonly" class="fa-solid fa-lock se-lock-icon" aria-hidden="true" />
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
          <button type="button" class="se-link" :disabled="locked" @click="addDictRow(field)">
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
    <AppButton size="sm" variant="ghost" :disabled="dirtyCount === 0" @click="emit('discard')"
      >放弃改动</AppButton
    >
    <AppButton
      size="sm"
      variant="primary"
      :disabled="locked || dirtyCount === 0"
      data-testid="state-editor-preview"
      @click="emit('previewDrafts')"
      >预览修改</AppButton
    >
  </div>
</template>

<style scoped src="./state-editor-shared.css"></style>
<style scoped>
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
.se-node-path {
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

@media (prefers-reduced-motion: reduce) {
  .se-input,
  .se-link {
    transition: none;
  }
}
</style>
