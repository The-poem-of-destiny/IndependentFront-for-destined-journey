<template>
  <div class="worldbook-editor">
    <div class="editor-header">
      <button class="back-btn" type="button" @click.stop="$emit('back')" aria-label="返回世界书列表">
        <i class="fa-solid fa-arrow-left" aria-hidden="true"></i>
        <span>返回列表</span>
      </button>
      <h3>{{ book.name }} · 条目管理</h3>
      <button v-if="!readonly" class="add-btn" @click="addEntry">
        <i class="fa-solid fa-plus" aria-hidden="true"></i>
        <span>新建条目</span>
      </button>
      <span v-else class="builtin-notice"><i class="fa-solid fa-lock" aria-hidden="true"></i> 内置世界书 · 只读</span>
    </div>

    <!-- 空状态 -->
    <div v-if="sortedEntries.length === 0" class="empty-state">
      <i class="fa-solid fa-book-open empty-icon" aria-hidden="true"></i>
      <p class="empty-title">暂无条目</p>
      <p class="empty-desc">点击「新建条目」开始添加世界书内容</p>
      <button class="add-btn" @click="addEntry">新建条目</button>
    </div>

    <!-- 条目表格 -->
    <div v-else class="entry-table">
      <div class="entry-row entry-header">
        <span class="col-num">#</span>
        <span class="col-name">名称</span>
        <span class="col-toggle">启用</span>
        <span class="col-toggle">永久</span>
        <span class="col-order">排序</span>
        <span class="col-actions">操作</span>
      </div>

      <div
        v-for="(entry, idx) in sortedEntries"
        :key="entry.uid"
        class="entry-row"
        :class="{ disabled: !entry.enabled }"
        :tabindex="0"
        @keydown.enter="editEntry(idx)"
      >
        <span class="col-num">{{ idx + 1 }}</span>
        <span class="col-name" :title="entry.name" role="button" tabindex="0">
          {{ entry.name || '(未命名)' }}
        </span>
        <label class="col-toggle toggle-label-inline" :title="entry.enabled ? '已启用' : '已禁用'">
          <input type="checkbox" v-model="entry.enabled" @change="onToggleChange" :aria-label="`启用 ${entry.name}`" />
          <span class="toggle-slider-sm"></span>
        </label>
        <label class="col-toggle toggle-label-inline" :title="entry.constant ? '永久注入中' : '关键词触发'">
          <input type="checkbox" v-model="entry.constant" @change="onToggleChange" :aria-label="`${entry.name} 永久注入`" />
          <span class="toggle-slider-sm"></span>
        </label>
        <span class="col-order">
          <button class="order-btn" @click="moveUp(idx)" :disabled="readonly || idx === 0" aria-label="上移">
            <i class="fa-solid fa-chevron-up" aria-hidden="true"></i>
          </button>
          <input type="number" v-model.number="entry.order" :disabled="readonly" @change="markDirty" class="order-input" :aria-label="`${entry.name} 排序`" />
          <button class="order-btn" @click="moveDown(idx)" :disabled="readonly || idx === sortedEntries.length - 1" aria-label="下移">
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
          </button>
        </span>
        <span class="col-actions">
          <button class="icon-btn" @click="editEntry(idx)" :aria-label="`编辑 ${entry.name}`">
            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
          </button>
          <button v-if="!readonly" class="icon-btn danger" @click="deleteEntry(idx)" :aria-label="`删除 ${entry.name}`">
            <i class="fa-solid fa-trash" aria-hidden="true"></i>
          </button>
        </span>
      </div>
    </div>

    <!-- 条目编辑弹窗 -->
    <div v-if="editingIndex !== null" class="modal-overlay" @click.self="cancelEdit" @keydown.escape="cancelEdit">
      <div class="edit-modal" role="dialog" aria-modal="true" aria-label="编辑条目">
        <h4>{{ readonly ? '查看条目' : '编辑条目' }}</h4>

        <label class="form-label" for="edit-name">名称</label>
        <input id="edit-name" ref="editNameInput" v-model="editForm.name" class="form-input" placeholder="条目名称" :disabled="readonly" :readonly="readonly" />

        <label class="form-label" for="edit-keys">关键词（逗号分隔）</label>
        <input id="edit-keys" v-model="editForm.keys" class="form-input" placeholder="阿斯塔利亚, 虚海" :disabled="readonly" :readonly="readonly" />

        <label class="form-label" for="edit-keysecondary">辅助关键词</label>
        <input id="edit-keysecondary" v-model="editForm.keysecondary" class="form-input" placeholder="世界设定" :disabled="readonly" :readonly="readonly" />

        <div class="edit-row">
          <label class="form-label">逻辑
            <select v-model.number="editForm.selectiveLogic" class="form-input" aria-label="关键词匹配逻辑" :disabled="readonly">
              <option :value="0">AND_ANY — 命中任一辅助关键词</option>
              <option :value="1">NOT_ALL — 未命中所有辅助关键词</option>
              <option :value="2">NOT_ANY — 未命中任何辅助关键词</option>
              <option :value="3">AND_ALL — 命中所有辅助关键词</option>
            </select>
          </label>

          <label class="form-label checkbox-label">
            <input type="checkbox" v-model="editForm.constant" :disabled="readonly" />
            <span>永久注入</span>
          </label>

          <label class="form-label" for="edit-order">排序
            <input id="edit-order" type="number" v-model.number="editForm.order" class="form-input order-input-sm" :disabled="readonly" :readonly="readonly" />
          </label>
        </div>

        <label class="form-label" for="edit-content">内容 (Markdown)</label>
        <textarea id="edit-content" v-model="editForm.content" class="form-textarea" rows="12" :disabled="readonly" :readonly="readonly"></textarea>

        <div class="modal-actions">
          <button class="btn-secondary" @click="cancelEdit">{{ readonly ? '关闭' : '取消' }}</button>
          <button v-if="!readonly" class="btn-primary" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { WorldBook, WorldBookEntry } from '@engine/types'

const editNameInput = ref<HTMLInputElement | null>(null)

const props = defineProps<{
  book: WorldBook
  readonly?: boolean
}>()

const emit = defineEmits<{
  back: []
  update: [book: WorldBook]
}>()

// ===== State =====

const entries = ref<WorldBookEntry[]>(
  JSON.parse(JSON.stringify(props.book.entries))
)

const editingIndex = ref<number | null>(null)
const editForm = ref({
  name: '',
  keys: '',
  keysecondary: '',
  selectiveLogic: 0 as number,
  constant: false,
  order: 100,
  content: '',
})

// ===== Computed =====

const sortedEntries = computed(() => {
  return [...entries.value].sort((a, b) => a.order - b.order)
})

// ===== Methods =====

function markDirty() {
  // automatic save via watch
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function onToggleChange() {
  if (!props.book.builtIn) return

  // 内置书：直接写回本地 JSON 文件
  const updatedBook = { ...props.book, entries: entries.value }
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    fetch(`/api/worldbooks/${props.book.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedBook),
    }).catch(() => {})
  }, 600)
}

function addEntry() {
  const newEntry: WorldBookEntry = {
    uid: Date.now(),
    name: '新条目',
    content: '',
    enabled: true,
    constant: false,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: entries.value.length > 0
      ? Math.max(...entries.value.map(e => e.order)) + 10
      : 100,
    position: 0,
  }
  entries.value.push(newEntry)
  saveBook()
}

async function editEntry(idx: number) {
  const entry = sortedEntries.value[idx]
  editingIndex.value = idx
  editForm.value = {
    name: entry.name,
    keys: entry.key.join(', '),
    keysecondary: entry.keysecondary.join(', '),
    selectiveLogic: entry.selectiveLogic,
    constant: entry.constant,
    order: entry.order,
    content: entry.content,
  }
  await nextTick()
  editNameInput.value?.focus()
}

function saveEdit() {
  if (editingIndex.value !== null) {
    const entry = sortedEntries.value[editingIndex.value]
    entry.name = editForm.value.name
    entry.key = editForm.value.keys.split(',').map(k => k.trim()).filter(Boolean)
    entry.keysecondary = editForm.value.keysecondary.split(',').map(k => k.trim()).filter(Boolean)
    entry.selectiveLogic = editForm.value.selectiveLogic
    entry.constant = editForm.value.constant
    entry.order = editForm.value.order
    entry.content = editForm.value.content
    saveBook()
  }
  editingIndex.value = null
}

function cancelEdit() {
  editingIndex.value = null
}

function deleteEntry(idx: number) {
  if (!confirm('确定删除此条目？')) return
  const entry = sortedEntries.value[idx]
  const realIdx = entries.value.findIndex(e => e.uid === entry.uid)
  if (realIdx >= 0) {
    entries.value.splice(realIdx, 1)
    saveBook()
  }
}

function moveUp(idx: number) {
  if (idx === 0) return
  const a = sortedEntries.value[idx - 1]
  const b = sortedEntries.value[idx]
  const tmp = a.order
  a.order = b.order
  b.order = tmp
  saveBook()
}

function moveDown(idx: number) {
  if (idx >= sortedEntries.value.length - 1) return
  const a = sortedEntries.value[idx]
  const b = sortedEntries.value[idx + 1]
  const tmp = a.order
  a.order = b.order
  b.order = tmp
  saveBook()
}

function saveBook() {
  emit('update', {
    ...props.book,
    entries: entries.value,
  })
}

// Sync with external book changes
watch(() => props.book, (newBook) => {
  entries.value = JSON.parse(JSON.stringify(newBook.entries))
}, { deep: true })
</script>

<style scoped>
/* ═══════════════════════════════════════
   世界书条目编辑器
   使用主题变量，支持所有主题
   ═══════════════════════════════════════ */

.worldbook-editor {
  max-width: 900px;
  width: 100%;
}

/* ===== 容器卡片 ===== */
.worldbook-editor {
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl, 16px);
  padding: 24px;
}

/* ===== 顶栏 ===== */
.editor-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--theme-card-border);
}

.editor-header h3 {
  flex: 1;
  margin: 0;
  font-size: 1rem;
  font-family: var(--theme-font-title);
  color: var(--theme-text-primary);
}

.back-btn, .add-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85rem;
  min-height: 36px;
  transition: all 0.15s;
}
.back-btn:hover, .add-btn:hover {
  filter: brightness(1.1);
}
.back-btn:active, .add-btn:active {
  transform: scale(0.97);
}

.add-btn {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  border-color: transparent;
  font-weight: 600;
}

/* ===== 内置只读标识 ===== */
.builtin-notice {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

/* ===== 空状态 ===== */
.empty-state {
  text-align: center;
  padding: 48px 16px;
  border: 2px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
}

.empty-icon {
  font-size: 2.5rem;
  color: var(--theme-text-muted);
  margin-bottom: 12px;
  opacity: 0.5;
}

.empty-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  margin: 0 0 4px;
}

.empty-desc {
  font-size: 0.85rem;
  color: var(--theme-text-muted);
  margin: 0 0 16px;
}

/* ===== 条目表格 ===== */
.entry-table {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
  overflow: hidden;
}

.entry-row {
  display: flex;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--theme-card-border);
  gap: 8px;
  font-size: 0.85rem;
  transition: background 0.12s;
  color: var(--theme-text-primary);
}

.entry-row:last-child {
  border-bottom: none;
}

.entry-row:nth-child(even):not(.entry-header) {
  background: var(--theme-surface-muted);
}

.entry-row:hover {
  background: var(--theme-tab-hover-bg) !important;
}

/* 表头 */
.entry-row.entry-header {
  background: var(--theme-surface-muted);
  font-weight: 600;
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  border-bottom: 2px solid var(--theme-card-border);
}

/* 禁用行 */
.entry-row.disabled {
  opacity: 0.4;
  text-decoration: line-through;
}

/* ===== 列宽 ===== */
.col-num {
  width: 32px;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.col-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  color: var(--theme-primary);
  font-weight: 500;
}

.col-toggle {
  width: 56px;
  text-align: center;
}

.col-order {
  width: 138px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.col-actions {
  width: 80px;
  text-align: center;
  display: flex;
  justify-content: center;
  gap: 4px;
}

/* ===== Toggle 开关 (小号) ===== */
.toggle-label-inline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  min-width: 44px;
  min-height: 44px;
  position: relative;
}

.toggle-label-inline input[type="checkbox"] {
  position: absolute;
  width: 36px;
  height: 22px;
  opacity: 0;
  cursor: pointer;
}

.toggle-slider-sm {
  display: inline-block;
  width: 36px;
  height: 22px;
  background: var(--theme-card-border);
  border-radius: 11px;
  position: relative;
  transition: background 0.2s;
}

.toggle-slider-sm::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  background: var(--theme-text-primary);
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-label-inline input:checked + .toggle-slider-sm {
  background: var(--theme-success);
}

.toggle-label-inline input:checked + .toggle-slider-sm::after {
  transform: translateX(14px);
}

.toggle-label-inline input:focus-visible + .toggle-slider-sm {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

/* ===== 排序控件 ===== */
.order-input {
  width: 54px;
  text-align: center;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  padding: 4px 6px;
  font-size: 0.85rem;
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  min-height: 32px;
}

.order-input:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}

.order-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-content-bg);
  cursor: pointer;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  transition: all 0.15s;
}

.order-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.order-btn:disabled {
  opacity: 0.25;
  cursor: default;
}

/* ===== 操作图标按钮 ===== */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--theme-radius-sm, 6px);
  background: transparent;
  cursor: pointer;
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  transition: all 0.15s;
}

.icon-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.icon-btn:active {
  transform: scale(0.9);
}

.icon-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

.icon-btn.danger:hover {
  background: color-mix(in srgb, var(--theme-error) 15%, transparent);
  color: var(--theme-error);
}

/* ===== 编辑弹窗 ===== */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: wbFadeIn 0.15s ease;
}

@keyframes wbFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.edit-modal {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl, 16px);
  padding: 28px;
  width: min(640px, calc(100vw - 32px));
  max-height: 85vh;
  max-height: 85dvh;
  overflow-y: auto;
  animation: wbSlideUp 0.2s ease;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}

@keyframes wbSlideUp {
  from { transform: translateY(16px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.edit-modal h4 {
  margin: 0 0 20px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--theme-card-border);
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}

.edit-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  margin-bottom: 0;
}

/* ===== 表单 ===== */
.edit-modal .form-label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  margin-bottom: 4px;
  margin-top: 14px;
  flex: 1;
}

.edit-modal .form-input {
  width: 100%;
  padding: 10px 14px;
  font-size: 0.85rem;
  line-height: 1.5;
  color: var(--theme-text-primary);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.edit-modal .form-input:focus {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}

.edit-modal .form-input::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.5;
}

.edit-modal select.form-input {
  cursor: pointer;
  padding-right: 30px;
}

/* ===== 复选框标签 ===== */
.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  min-height: 44px;
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
  padding-top: 18px !important;
}

.checkbox-label input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: var(--theme-primary);
}

.order-input-sm {
  width: 72px;
  text-align: center;
}

/* ===== 文本域 ===== */
.form-textarea {
  width: 100%;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 8px);
  padding: 12px 14px;
  font-size: 0.82rem;
  line-height: 1.6;
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  resize: vertical;
  min-height: 200px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.form-textarea:focus {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}

.form-textarea::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.5;
}

/* ===== 弹窗按钮 ===== */
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--theme-card-border);
}

.btn-primary, .btn-secondary {
  display: inline-flex;
  align-items: center;
  padding: 10px 24px;
  border-radius: var(--theme-radius-md, 8px);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: inherit;
  min-height: 40px;
  transition: all 0.15s;
}

.btn-primary {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  border: none;
}

.btn-primary:hover {
  filter: brightness(1.1);
}

.btn-secondary {
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  border: 1px solid var(--theme-card-border);
}

.btn-secondary:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

/* ===== 禁用态 ===== */
input:disabled, select:disabled, textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ===== Focus visible ===== */
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
</style>
