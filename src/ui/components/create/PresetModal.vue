<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useCreateStore, type CreatePreset } from '../../stores/create-store'
import { getCreatePresets, saveCreatePreset, deleteCreatePreset } from '@engine/database'
import type { CreatePresetRecord } from '@engine/database'
import AppModal from '../shared/AppModal.vue'
import AppButton from '../shared/AppButton.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: [] }>()

const store = useCreateStore()

const presetName = ref('')
const confirmName = ref<string | null>(null)
const presets = ref<CreatePresetRecord[]>([])
const deleteConfirmId = ref<string | null>(null)
const overwriteConfirmId = ref<string | null>(null)
const importConflict = ref<{ presets: CreatePreset[]; conflicts: number } | null>(null)
const expandedId = ref<string | null>(null)

async function loadPresets() {
  presets.value = await getCreatePresets()
}

onMounted(() => { if (props.visible) loadPresets() })
watch(() => props.visible, (v) => { if (v) loadPresets() })

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

// 保存
async function handleSave() {
  const name = presetName.value.trim()
  if (!name) return

  const existing = presets.value.find(p => p.name === name)
  if (existing && confirmName.value !== name) {
    confirmName.value = name
    return
  }

  try {
    const now = Date.now()
    // JSON 序列化去 Vue reactive proxy，否则 IndexedDB 放不进去 (DataCloneError)
    const cleanData = JSON.parse(JSON.stringify(store.getCurrentPresetData()))
    const record: CreatePresetRecord = {
      id: existing?.id ?? crypto.randomUUID(),
      name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      data: {
        id: existing?.id ?? '',
        name,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...cleanData,
      } as CreatePreset,
    }

    await saveCreatePreset(record)
    confirmName.value = null
    presetName.value = ''
    await loadPresets()
  } catch (err) {
    console.error('[PresetModal] 保存预设失败:', err)
    alert('保存预设失败，请检查浏览器存储空间。')
  }
}

async function handleLoad(preset: CreatePresetRecord) {
  store.applyPresetData(preset.data)
  emit('close')
}

async function handleDelete(id: string) {
  if (deleteConfirmId.value !== id) {
    overwriteConfirmId.value = null
    deleteConfirmId.value = id
    return
  }
  await deleteCreatePreset(id)
  deleteConfirmId.value = null
  await loadPresets()
}

/** 用当前捏人配置覆盖指定预设（二次确认，与删除确认互斥） */
async function handleOverwrite(preset: CreatePresetRecord) {
  if (overwriteConfirmId.value !== preset.id) {
    deleteConfirmId.value = null
    overwriteConfirmId.value = preset.id
    return
  }
  try {
    busy.value = true
    const now = Date.now()
    const cleanData = JSON.parse(JSON.stringify(store.getCurrentPresetData()))
    await saveCreatePreset({
      id: preset.id,
      name: preset.name,
      createdAt: preset.createdAt,
      updatedAt: now,
      data: {
        ...cleanData,
        id: preset.id,
        name: preset.name,
        createdAt: preset.createdAt,
        updatedAt: now,
      } as CreatePreset,
    })
    overwriteConfirmId.value = null
    await loadPresets()
  } catch (err) {
    console.error('[PresetModal] 覆盖预设失败:', err)
    alert('覆盖预设失败，请检查浏览器存储空间。')
  } finally {
    busy.value = false
  }
}

function handleExport(preset: CreatePresetRecord) {
  // 导出扁平的 CreatePreset 数据（不包 DB 外壳），与导入格式对齐
  const blob = new Blob([JSON.stringify(preset.data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `destiny_${preset.name}.preset.json`
  a.click(); URL.revokeObjectURL(url)
}

function handleExportAll() {
  if (presets.value.length === 0) return
  // 导出扁平的 CreatePreset[] 数组（不包 DB 外壳），与导入格式对齐
  const exportData = presets.value.map(p => p.data)
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `destiny_all_${new Date().toISOString().slice(0, 10)}.presets.json`
  a.click(); URL.revokeObjectURL(url)
}

async function handleImport() {
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const text = await file.text()
    try {
      const raw = JSON.parse(text)
      const rawArray = Array.isArray(raw) ? raw : [raw]
      // 兼容两种格式:
      //   旧: CreatePresetRecord[] (有顶层 id/name/data 壳，数据在 .data 里)
      //   新: CreatePreset[]     (直接就是预设数据，有 .difficulty/.character 等)
      const imported: CreatePreset[] = rawArray.map(r =>
        r.data ? { ...r.data, name: r.name || r.data.name, id: r.id || r.data.id } : r
      )
      const conflicts = imported.filter(p => presets.value.some(ep => ep.name === p.name)).length
      if (conflicts > 0) {
        importConflict.value = { presets: imported, conflicts }
      } else {
        await batchImport(imported, false)
      }
    } catch { /* ignore invalid JSON */ }
  }
  input.click()
}

async function batchImport(imports: CreatePreset[], overwrite: boolean) {
  let count = 0
  for (const p of imports) {
    if (!p.name) continue
    const existing = presets.value.find(ep => ep.name === p.name)
    if (existing && !overwrite) continue
    const now = Date.now()
    await saveCreatePreset({
      id: existing?.id ?? crypto.randomUUID(),
      name: p.name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      data: p,
    })
    count++
  }
  importConflict.value = null
  await loadPresets()
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 构建预设摘要文本 */
function getPresetSummary(p: CreatePresetRecord): string {
  const d = p.data
  const parts: string[] = []
  if (d.character?.name) parts.push(d.character.name)
  if (d.character?.race) parts.push(d.character.race)
  if (d.difficulty) parts.push(d.difficulty)
  if (d.character?.level) parts.push(`Lv.${d.character.level}`)
  if (d.personality) parts.push(d.personality.slice(0, 20))
  return parts.join(' · ') || '空白预设'
}

const busy = ref(false)
</script>

<template>
  <AppModal :open="visible" @close="emit('close')">
    <template #header>角色预设</template>

    <!-- 保存 -->
    <div class="save-row">
      <input
        v-model="presetName"
        class="preset-input"
        placeholder="输入预设名称…"
        :disabled="busy"
        @keyup.enter="handleSave"
      />
      <AppButton size="sm" :disabled="busy" @click="handleSave">
        {{ confirmName === presetName.trim() ? '确认覆盖' : '保存当前配置' }}
      </AppButton>
    </div>

    <!-- 冲突提示 -->
    <div v-if="importConflict" class="conflict-banner">
      共 {{ importConflict.presets.length }} 个预设，其中 {{ importConflict.conflicts }} 个同名。
      <AppButton size="sm" @click="batchImport(importConflict.presets, true)">覆盖冲突</AppButton>
      <AppButton size="sm" variant="ghost" @click="batchImport(importConflict.presets, false)">跳过冲突</AppButton>
      <AppButton size="sm" variant="ghost" @click="importConflict = null">取消</AppButton>
    </div>

    <!-- 列表 -->
    <div class="preset-list">
      <div v-if="presets.length === 0" class="empty">暂无保存的预设</div>
      <div
        v-for="p in presets" :key="p.id"
        class="preset-card"
        :class="{
          'delete-pending': deleteConfirmId === p.id,
          'expanded': expandedId === p.id,
        }"
      >
        <!-- 卡片头部（可点击展开） -->
        <div class="preset-header" @click="toggleExpand(p.id)" role="button" tabindex="0" @keydown.enter="toggleExpand(p.id)" @keydown.space.prevent="toggleExpand(p.id)">
          <div class="preset-header-main">
            <div class="preset-header-top">
              <span class="preset-name">{{ p.name }}</span>
              <span class="preset-expand-icon">{{ expandedId === p.id ? '▾' : '▸' }}</span>
            </div>
            <span class="preset-summary">{{ getPresetSummary(p) }}</span>
          </div>
          <span class="preset-time">{{ formatTime(p.updatedAt) }}</span>
        </div>

        <!-- 展开详情 -->
        <div v-if="expandedId === p.id" class="preset-detail">
          <div class="detail-grid">
            <div class="detail-col">
              <div class="detail-row"><span class="detail-label">角色</span><span>{{ p.data.character?.name || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">性别</span><span>{{ p.data.character?.gender || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">种族</span><span>{{ p.data.character?.race || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">身份</span><span>{{ p.data.character?.identity || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">等级</span><span>Lv.{{ p.data.character?.level || 1 }}</span></div>
              <div class="detail-row"><span class="detail-label">起始地点</span><span class="truncate">{{ p.data.character?.startLocation || '-' }}</span></div>
            </div>
            <div class="detail-col">
              <div class="detail-row"><span class="detail-label">性格</span><span>{{ p.data.personality || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">身材</span><span>{{ p.data.physics || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">身世</span><span>{{ p.data.backstory || '-' }}</span></div>
              <div class="detail-row"><span class="detail-label">装备</span><span>{{ p.data.equipments?.length || 0 }} 件</span></div>
              <div class="detail-row"><span class="detail-label">技能</span><span>{{ p.data.skills?.length || 0 }} 个</span></div>
              <div class="detail-row"><span class="detail-label">道具</span><span>{{ p.data.items?.length || 0 }} 个</span></div>
            </div>
          </div>
        </div>

        <!-- 操作栏 -->
        <div class="preset-actions">
          <template v-if="deleteConfirmId === p.id">
            <AppButton size="sm" variant="danger" @click="handleDelete(p.id)" :disabled="busy">确认删除</AppButton>
            <AppButton size="sm" variant="ghost" @click="deleteConfirmId = null">取消</AppButton>
          </template>
          <template v-else-if="overwriteConfirmId === p.id">
            <AppButton size="sm" variant="danger" @click="handleOverwrite(p)" :disabled="busy">确认覆盖</AppButton>
            <AppButton size="sm" variant="ghost" @click="overwriteConfirmId = null">取消</AppButton>
          </template>
          <template v-else>
            <AppButton size="sm" @click="handleLoad(p)" :disabled="busy">加载</AppButton>
            <AppButton size="sm" variant="ghost" @click="handleOverwrite(p)" :disabled="busy" title="用当前配置覆盖此预设">覆盖</AppButton>
            <AppButton size="sm" variant="ghost" @click="handleExport(p)">导出</AppButton>
            <AppButton size="sm" variant="ghost" @click="deleteConfirmId = p.id">删除</AppButton>
          </template>
        </div>
      </div>
    </div>

    <!-- 底部 -->
    <div class="modal-footer">
      <AppButton size="sm" variant="ghost" @click="handleImport">导入</AppButton>
      <AppButton size="sm" variant="ghost" @click="handleExportAll">全部导出</AppButton>
      <AppButton size="sm" variant="ghost" @click="emit('close')">关闭</AppButton>
    </div>
  </AppModal>
</template>

<style scoped>
/* ── 保存栏 ── */
.save-row { display: flex; gap: var(--theme-spacing-sm); margin-bottom: var(--theme-spacing-md); }
.preset-input {
  flex: 1;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.85rem;
}
.preset-input::placeholder { color: var(--theme-text-muted); }
.preset-input:focus { outline: none; border-color: var(--theme-primary); }

/* ── 冲突提示 ── */
.conflict-banner {
  padding: var(--theme-spacing-sm);
  background: var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8rem;
  color: var(--theme-quality-mythic, #e67e22);
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-md);
}

/* ── 列表容器 ── */
.preset-list {
  max-height: 440px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.empty {
  text-align: center;
  color: var(--theme-text-muted);
  padding: var(--theme-spacing-xl);
  font-size: 0.85rem;
}

/* ── 预设卡片 ── */
.preset-card {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  overflow: hidden;
  transition: border-color var(--theme-transition-fast);
  /* 父级 .preset-list 是 flex column + max-height，必须禁止收缩，
     否则预设多了会被等比压扁（只剩标题、操作栏被挤出），滚动条永不触发 */
  flex-shrink: 0;
}
.preset-card:hover { border-color: var(--theme-primary); }
.preset-card.delete-pending {
  border-color: var(--theme-quality-mythic, #e67e22);
  background: color-mix(in srgb, var(--theme-quality-mythic, #e67e22) 5%, var(--theme-card-bg));
}
.preset-card.expanded { border-color: var(--theme-primary); }

/* ── 卡片头部 ── */
.preset-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  cursor: pointer;
  user-select: none;
  transition: background var(--theme-transition-fast);
}
.preset-header:hover { background: var(--theme-surface-muted); }
.preset-header-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.preset-header-top { display: flex; align-items: center; gap: var(--theme-spacing-xs); }
.preset-name { font-weight: 600; font-size: 0.9rem; color: var(--theme-text-primary); }
.preset-expand-icon { font-size: 0.7rem; color: var(--theme-text-muted); flex-shrink: 0; transition: transform var(--theme-transition-fast); }
.preset-summary { font-size: 0.7rem; color: var(--theme-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.preset-time { font-size: 0.65rem; color: var(--theme-text-muted); flex-shrink: 0; }

/* ── 展开详情 ── */
.preset-detail {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md) var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
  animation: slideDown 0.2s ease;
}
@keyframes slideDown {
  from { opacity: 0; max-height: 0; }
  to { opacity: 1; max-height: 20rem; }
}
.detail-grid {
  display: grid;
  /* minmax(0,1fr) 让两列允许收缩，避免某一列 nowrap 长文本撑爆另一列、把 label 挤剩一个字 */
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--theme-spacing-sm);
}
.detail-col { display: flex; flex-direction: column; gap: var(--theme-spacing-xs); min-width: 0; }
.detail-row { display: flex; gap: var(--theme-spacing-xs); font-size: 0.75rem; }
.detail-label { color: var(--theme-text-muted); flex-shrink: 0; min-width: 3.5em; font-weight: 500; }
.detail-row span:last-child {
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* flex 子项默认 min-width:auto 会等于整段 nowrap 文本宽度从而撑爆列；
     min-width:0 + flex:1 让它收缩并占满剩余空间，省略号才真正生效 */
  min-width: 0;
  flex: 1;
}

/* ── 操作栏 ── */
.preset-actions {
  display: flex;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-xs) var(--theme-spacing-md) var(--theme-spacing-sm);
  justify-content: flex-end;
}

/* ── 底部 ── */
.modal-footer {
  display: flex;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
</style>
