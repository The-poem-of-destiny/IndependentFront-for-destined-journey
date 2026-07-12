<script setup lang="ts">
/**
 * 输出美化设置分区 — 管理正则替换规则
 *
 * 内置规则（对话卡片/杀增殖）仅可禁用，用户规则可自由增删改。
 * 规则数据存于 settings-store，自动持久化 localStorage。
 */
import { ref, computed } from 'vue'
import { useSettingsStore } from '../../stores/settings-store'
import { getBuiltinRules } from '@engine/beautifier'
import type { BeautifierRule } from '@engine/types'
import AppButton from '../shared/AppButton.vue'
import AppCard from '../shared/AppCard.vue'
import RuleEditorModal from './RuleEditorModal.vue'

const cfg = useSettingsStore()
const s = cfg.settings

// ===== State =====

const expanded = ref<Record<string, boolean>>({})
const showEditor = ref(false)
const editingRule = ref<BeautifierRule | null>(null)

// 内置规则禁用列表 — 存在 settings 里
const builtinDisabled = computed<string[]>(() => s.beautifierBuiltinDisabled ?? [])

// 内置规则 — 来自引擎 + 禁用状态覆盖
const builtinRules = computed(() =>
  getBuiltinRules().map(r => ({
    ...r,
    enabled: !builtinDisabled.value.includes(r.id),
  }))
)

// 用户规则
const userRules = computed<BeautifierRule[]>(() => s.beautifierRules ?? [])

// ===== Helpers =====

function scopeLabel(scope: string): string {
  const map: Record<string, string> = {
    maintext: '正文',
    options: '选项',
    summary: '摘要',
    thinking: '思维链',
    global: '全局',
  }
  return map[scope] ?? scope
}

function toggleExpand(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] }
}

// ===== Actions =====

function toggleBuiltinRule(ruleId: string) {
  const list = [...builtinDisabled.value]
  const idx = list.indexOf(ruleId)
  if (idx >= 0) {
    list.splice(idx, 1)
  } else {
    list.push(ruleId)
  }
  s.beautifierBuiltinDisabled = list
}

function toggleUserRule(rule: BeautifierRule) {
  rule.enabled = !rule.enabled
  s.beautifierRules = [...(s.beautifierRules as BeautifierRule[])]
}

function openAdd() {
  editingRule.value = null
  showEditor.value = true
}

function openEdit(rule: BeautifierRule) {
  editingRule.value = { ...rule }
  showEditor.value = true
}

function saveRule(rule: BeautifierRule) {
  const list = [...(s.beautifierRules as BeautifierRule[])]
  if (editingRule.value) {
    // 编辑已有规则
    const idx = list.findIndex(r => r.id === editingRule.value!.id)
    if (idx >= 0) list[idx] = rule
  } else {
    // 新建规则
    list.push(rule)
  }
  s.beautifierRules = list
  showEditor.value = false
}

function deleteRule(rule: BeautifierRule) {
  s.beautifierRules = (s.beautifierRules as BeautifierRule[]).filter(r => r.id !== rule.id)
}

function exportRules() {
  const data = {
    version: 1,
    builtinDisabled: s.beautifierBuiltinDisabled,
    rules: s.beautifierRules,
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `beautifier-rules-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function importRules() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0]
    if (!f) return
    try {
      const data = JSON.parse(await f.text())
      if (Array.isArray(data.rules)) {
        const existing = [...(s.beautifierRules as BeautifierRule[])]
        for (const rule of data.rules) {
          const idx = existing.findIndex(r => r.id === rule.id)
          if (idx >= 0) existing[idx] = rule
          else existing.push(rule)
        }
        s.beautifierRules = existing
      } else if (Array.isArray(data)) {
        s.beautifierRules = data as BeautifierRule[]
      }
      if (data.builtinDisabled && Array.isArray(data.builtinDisabled)) {
        s.beautifierBuiltinDisabled = data.builtinDisabled
      }
    } catch {
      // 导入失败静默
    }
  }
  input.click()
}
</script>

<template>
  <section class="section centered">
    <h3>输出美化</h3>
    <p class="section-desc">
      用正则表达式美化 AI 输出内容。内置规则可禁用但保留原始逻辑，自定义规则完全可控。
    </p>

    <!-- 全局开关 -->
    <AppCard padding="md" style="margin-top: 16px">
      <h4>全局开关</h4>
      <div class="toggle-row">
        <span>启用输出美化</span>
        <label class="toggle-label">
          <input type="checkbox" v-model="s.beautifierEnabled" class="toggle-input" />
          <span class="toggle-slider" />
        </label>
      </div>
    </AppCard>

    <!-- 内置规则 -->
    <AppCard padding="md" style="margin-top: 12px">
      <h4>内置规则</h4>
      <p class="text-muted text-sm" style="margin-bottom: 12px">
        系统预设规则，仅可启用/禁用，不能编辑或删除。
      </p>
      <div v-if="builtinRules.length === 0" class="text-muted text-sm" style="text-align:center;padding:16px">
        暂无内置规则
      </div>
      <div v-for="rule in builtinRules" :key="rule.id" class="rule-item">
        <div class="rule-header">
          <label class="toggle-label">
            <input type="checkbox" :checked="rule.enabled" @change="toggleBuiltinRule(rule.id)" class="toggle-input" />
            <span class="toggle-slider" />
          </label>
          <span class="rule-name">{{ rule.name }}</span>
          <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
          <span v-if="!rule.enabled" class="rule-disabled-tag">已禁用</span>
          <button class="rule-expand-btn" @click="toggleExpand(rule.id)">
            {{ expanded[rule.id] ? '收起' : '查看' }}
          </button>
        </div>
        <div v-if="expanded[rule.id]" class="rule-detail">
          <div class="rule-field"><span>正则:</span><code>{{ rule.pattern }}</code></div>
          <div class="rule-field"><span>替换:</span><code>{{ rule.replacement.slice(0, 200) }}{{ rule.replacement.length > 200 ? '...' : '' }}</code></div>
        </div>
      </div>
    </AppCard>

    <!-- 用户规则 -->
    <AppCard padding="md" style="margin-top: 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h4 style="margin:0">自定义规则</h4>
        <AppButton variant="primary" size="sm" @click="openAdd">＋ 添加规则</AppButton>
      </div>
      <p v-if="userRules.length === 0" class="text-muted text-sm" style="text-align:center;padding:24px">
        暂无自定义规则<br />
        <span style="font-size:0.75rem">点击右上角添加，用正则表达式自定义输出美化</span>
      </p>
      <div v-for="rule in userRules" :key="rule.id" class="rule-item">
        <div class="rule-header">
          <label class="toggle-label">
            <input type="checkbox" :checked="rule.enabled" @change="toggleUserRule(rule)" class="toggle-input" />
            <span class="toggle-slider" />
          </label>
          <span class="rule-name">{{ rule.name }}</span>
          <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
          <button class="rule-action-btn" @click="openEdit(rule)" title="编辑">✎</button>
          <button class="rule-action-btn rule-delete-btn" @click="deleteRule(rule)" title="删除">🗑</button>
        </div>
        <div v-if="expanded[rule.id]" class="rule-detail">
          <div class="rule-field"><span>正则:</span><code>{{ rule.pattern }}</code></div>
          <div class="rule-field"><span>替换:</span><code>{{ rule.replacement.slice(0, 200) }}{{ rule.replacement.length > 200 ? '...' : '' }}</code></div>
        </div>
      </div>
    </AppCard>

    <!-- 导入/导出 -->
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
      <AppButton variant="secondary" size="sm" @click="exportRules">📤 导出规则</AppButton>
      <AppButton variant="secondary" size="sm" @click="importRules">📥 导入规则</AppButton>
    </div>
  </section>

  <!-- 规则编辑弹窗 -->
  <RuleEditorModal
    v-if="showEditor"
    :rule="editingRule"
    @save="saveRule"
    @cancel="showEditor = false"
  />
</template>

<style scoped>
.rule-item {
  border-bottom: 1px solid var(--theme-border, rgba(255,255,255,0.04));
  padding: 8px 0;
}
.rule-item:last-child {
  border-bottom: none;
}
.rule-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  flex: 1;
}
.rule-scope {
  opacity: 0.7;
  white-space: nowrap;
}
.rule-disabled-tag {
  font-size: 0.65rem;
  padding: 2px 6px;
  border-radius: 3px;
  background: rgba(255,0,0,0.15);
  color: var(--theme-error);
}
.rule-expand-btn,
.rule-action-btn {
  background: none;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  font-size: 0.7rem;
  padding: 3px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  font-family: inherit;
  transition: all var(--theme-transition-fast);
}
.rule-expand-btn:hover,
.rule-action-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.rule-delete-btn:hover {
  color: var(--theme-error) !important;
  border-color: var(--theme-error);
}
.rule-detail {
  margin-top: 8px;
  padding: 8px 12px;
  background: var(--theme-content-bg);
  border-radius: var(--theme-radius-sm, 6px);
  border: 1px solid var(--theme-card-border);
}
.rule-field {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 0.75rem;
  align-items: flex-start;
}
.rule-field span {
  color: var(--theme-text-muted);
  white-space: nowrap;
  min-width: 36px;
}
.rule-field code {
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  word-break: break-all;
}
</style>
