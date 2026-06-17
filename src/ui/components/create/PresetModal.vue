<script setup lang="ts">
import { ref, onMounted } from 'vue'
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
const importConflict = ref<{ presets: CreatePreset[]; conflicts: number } | null>(null)

async function loadPresets() {
  presets.value = await getCreatePresets()
}

onMounted(() => { if (props.visible) loadPresets() })

// 保存
async function handleSave() {
  const name = presetName.value.trim()
  if (!name) return

  const existing = presets.value.find(p => p.name === name)
  if (existing && confirmName.value !== name) {
    confirmName.value = name
    return  // 第一次点击: 提示已存在
  }

  const now = Date.now()
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
      ...store.getCurrentPresetData(),
    } as CreatePreset,
  }

  await saveCreatePreset(record)
  confirmName.value = null
  presetName.value = ''
  await loadPresets()
}

// 加载
async function handleLoad(preset: CreatePresetRecord) {
  store.applyPresetData(preset.data)
  emit('close')
}

// 删除
async function handleDelete(id: string) {
  if (deleteConfirmId.value !== id) {
    deleteConfirmId.value = id
    return
  }
  await deleteCreatePreset(id)
  deleteConfirmId.value = null
  await loadPresets()
}

// 导出
function handleExport(preset: CreatePresetRecord) {
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `destiny_${preset.name}.preset.json`
  a.click(); URL.revokeObjectURL(url)
}

function handleExportAll() {
  if (presets.value.length === 0) return
  const blob = new Blob([JSON.stringify(presets.value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `destiny_all_${new Date().toISOString().slice(0, 10)}.presets.json`
  a.click(); URL.revokeObjectURL(url)
}

// 导入
async function handleImport() {
  const input = document.createElement('input')
  input.type = 'file'; input.accept = '.json'
  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    const text = await file.text()
    try {
      const data = JSON.parse(text)
      const imported: CreatePreset[] = Array.isArray(data) ? data : [data]
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
        @keyup.enter="handleSave"
      />
      <AppButton
        size="sm"
        @click="handleSave"
      >
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
        class="preset-item"
        :class="{ 'delete-pending': deleteConfirmId === p.id }"
      >
        <div class="preset-main">
          <span class="preset-name">{{ p.name }}</span>
          <span class="preset-meta">
            {{ p.data.character?.name || '未命名' }} · Lv.{{ p.data.character?.level || 1 }}
            · 装{{ p.data.equipments?.length || 0 }} 技{{ p.data.skills?.length || 0 }}
          </span>
          <span class="preset-time">{{ formatTime(p.updatedAt) }}</span>
        </div>
        <div class="preset-actions">
          <template v-if="deleteConfirmId === p.id">
            <AppButton size="sm" variant="danger" @click="handleDelete(p.id)">确认删除</AppButton>
            <AppButton size="sm" variant="ghost" @click="deleteConfirmId = null">取消</AppButton>
          </template>
          <template v-else>
            <AppButton size="sm" @click="handleLoad(p)">加载</AppButton>
            <AppButton size="sm" variant="ghost" @click="handleExport(p)">导出</AppButton>
            <AppButton size="sm" variant="ghost" @click="deleteConfirmId = p.id">删除</AppButton>
          </template>
        </div>
      </div>
    </div>

    <!-- 底部 -->
    <div class="modal-footer">
      <AppButton size="sm" variant="ghost" @click="handleImport">导入预设文件</AppButton>
      <AppButton size="sm" variant="ghost" @click="handleExportAll">全部导出</AppButton>
      <AppButton size="sm" variant="ghost" @click="emit('close')">关闭</AppButton>
    </div>
  </AppModal>
</template>

<style scoped>
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
.conflict-banner {
  padding: var(--theme-spacing-sm);
  background: var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8rem;
  color: var(--theme-quality-传说);
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  margin-bottom: var(--theme-spacing-md);
}
.preset-list { max-height: 320px; overflow-y: auto; }
.empty { text-align: center; color: var(--theme-text-muted); padding: var(--theme-spacing-lg); font-size: 0.85rem; }
.preset-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--theme-spacing-sm);
  border-bottom: 1px solid var(--theme-card-border);
  transition: background var(--theme-transition-fast);
}
.preset-item.delete-pending { background: var(--theme-card-border); }
.preset-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.preset-name { font-weight: 600; font-size: 0.85rem; color: var(--theme-text-primary); }
.preset-meta { font-size: 0.7rem; color: var(--theme-text-muted); }
.preset-time { font-size: 0.65rem; color: var(--theme-text-muted); }
.preset-actions { display: flex; gap: 2px; flex-shrink: 0; }
.modal-footer {
  display: flex;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
</style>
