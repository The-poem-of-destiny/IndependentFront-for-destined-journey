<script setup lang="ts">
/**
 * 输出美化设置分区 — 管理正则替换规则
 *
 * Phase 10i: 三段式布局 — 自动管理 / 已启用 / 可用规则库(折叠)。
 * 预设规则从 beautifier-rules.json 加载，用户规则完全可控。
 */
import { ref, computed, onMounted } from 'vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useGameStore } from '../../stores/game-store';
import { useBeautifierStore } from '../../stores/beautifier-store';
import { loadPresetRules, mergeRules, collectActiveSignalsFromEntries } from '@engine/beautifier';
import type { BeautifierRule } from '@engine/types';
import AppButton from '../shared/AppButton.vue';
import AppCard from '../shared/AppCard.vue';
import RuleEditorModal from './RuleEditorModal.vue';

const cfg = useSettingsStore();
const s = cfg.settings;
const game = useGameStore();
// Phase 0b: 用户规则住在 Dexie（唯一入口 beautifier-store），预设规则是纯内存派生缓存。
// `beautifierBuiltinDisabled` 仍在 settings（几个 id，体积无关紧要）。
const beautifier = useBeautifierStore();

// ===== State =====

const expanded = ref<Record<string, boolean>>({});
const showEditor = ref(false);
const editingRule = ref<BeautifierRule | null>(null);
const libraryExpanded = ref(false);
const presetRules = ref<BeautifierRule[]>([]);
const sourcePresetRules = ref<BeautifierRule[]>([]);
const loading = ref(true);

// 历史字段名；实际语义是相对内置 defaultEnabled 的手动翻转列表。
const builtinDisabled = computed<string[]>(() => s.beautifierBuiltinDisabled ?? []);

// 用户规则（Dexie 真源的响应式投影）
const userRules = computed<BeautifierRule[]>(() => beautifier.userRules);

// ===== 加载预设规则 =====

/** 从当前存档的 enabledWorldBookEntries 提取激活信号（命定核心 + 启用角色）。
 *  命定核心选择走独立 uid（不改 worldBooks 条目 enabled），须以存档为准；
 *  worldBooks.enabled 是「是否注入 prompt」的开关，核心书里几乎全 enabled，不能作为 autoEnable 信号。
 *  autoEnable 绑定**启用的世界书条目 uid**，不按角色名。 */
function getActiveWorldBookState() {
  const entries: string[] = (game.activeSave?.metadata as any)?.enabledWorldBookEntries ?? [];
  return collectActiveSignalsFromEntries(entries);
}

onMounted(async () => {
  try {
    // 先确保 store 已 hydrate（迁移 + 读 Dexie），否则 userRules 还是空的
    await beautifier.init();
    const { activeWorldBookIds, activeEntryUids } = getActiveWorldBookState();
    sourcePresetRules.value = await loadPresetRules();
    const merged = mergeRules(
      sourcePresetRules.value,
      userRules.value,
      builtinDisabled.value,
      activeWorldBookIds,
      activeEntryUids,
      new Set(), // characterNames — 美化绑定世界书，不按角色名
    );
    presetRules.value = merged.filter((r) => r.isBuiltin);
    // 派生缓存只进 store 的内存 ref，**不再写 settings**（那是 ~378 KB 的白存）
    beautifier.presetRules = merged.filter((r) => r.isBuiltin);
  } catch {
    // 加载失败静默，UI 空态
  }
  loading.value = false;
});

// ===== Computed =====

const autoManagedRules = computed(() => presetRules.value.filter((r) => r.locked));

const manualEnabledRules = computed(() => presetRules.value.filter((r) => r.enabled && !r.locked));

const disabledRules = computed(() => presetRules.value.filter((r) => !r.enabled));

/** 按 group 分组 */
const disabledGrouped = computed(() => {
  const groups: Record<string, BeautifierRule[]> = {};
  for (const r of disabledRules.value) {
    const g = r.group || '其他';
    if (!groups[g]) groups[g] = [];
    groups[g].push(r);
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
});

// ===== Helpers =====

function scopeLabel(scope: string): string {
  const map: Record<string, string> = {
    maintext: '正文',
    options: '选项',
    summary: '摘要',
    thinking: '思维链',
    global: '全局',
  };
  return map[scope] ?? scope;
}

function toggleExpand(id: string) {
  expanded.value = { ...expanded.value, [id]: !expanded.value[id] };
}

function toggleLibrary() {
  libraryExpanded.value = !libraryExpanded.value;
}

// ===== Actions =====

function toggleBuiltinRule(ruleId: string) {
  const list = [...builtinDisabled.value];
  const idx = list.indexOf(ruleId);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(ruleId);
  }
  s.beautifierBuiltinDisabled = list;
  refreshPresetRules();
}

function toggleUserRule(rule: BeautifierRule) {
  void beautifier.toggleRule(rule.id);
}

function openAdd() {
  editingRule.value = null;
  showEditor.value = true;
}

function openEdit(rule: BeautifierRule) {
  editingRule.value = { ...rule };
  showEditor.value = true;
}

async function saveRule(rule: BeautifierRule) {
  // 编辑时若改了 id，先删旧行再写新行（upsert 按 id，否则会留下孤儿）
  const prevId = editingRule.value?.id;
  if (prevId && prevId !== rule.id) await beautifier.deleteRule(prevId);
  await beautifier.upsertRule(rule);
  showEditor.value = false;
}

function deleteRule(rule: BeautifierRule) {
  void beautifier.deleteRule(rule.id);
}

function refreshPresetRules() {
  const { activeWorldBookIds, activeEntryUids } = getActiveWorldBookState();
  const merged = mergeRules(
    sourcePresetRules.value,
    userRules.value,
    builtinDisabled.value,
    activeWorldBookIds,
    activeEntryUids,
    new Set(),
  );
  presetRules.value = merged.filter((r) => r.isBuiltin);
  beautifier.presetRules = merged.filter((r) => r.isBuiltin);
}

function exportRules() {
  const data = {
    version: 1,
    builtinDisabled: s.beautifierBuiltinDisabled,
    rules: beautifier.userRules,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `beautifier-rules-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importRules() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (Array.isArray(data.rules)) {
        // 同 id 覆盖、否则追加 —— upsertRules 就是这个语义
        await beautifier.upsertRules(data.rules as BeautifierRule[]);
      } else if (Array.isArray(data)) {
        await beautifier.replaceAllRules(data as BeautifierRule[]);
      }
      if (data.builtinDisabled && Array.isArray(data.builtinDisabled)) {
        s.beautifierBuiltinDisabled = data.builtinDisabled;
      }
    } catch {
      // 导入失败静默
    }
  };
  input.click();
}
</script>

<template>
  <section class="section centered">
    <h3>输出美化</h3>
    <p class="section-desc">
      用正则表达式美化 AI 输出内容。自动管理规则由世界书/角色自动激活，自定义规则完全可控。
    </p>

    <!-- 加载态 -->
    <div v-if="loading" class="loading-placeholder">加载规则库中…</div>

    <template v-else>
      <!-- 全局开关 -->
      <AppCard padding="md" style="margin-top: 16px">
        <h4>全局开关</h4>
        <div class="toggle-row">
          <span>启用输出美化</span>
          <label class="toggle-label">
            <input v-model="s.beautifierEnabled" type="checkbox" class="toggle-input" />
            <span class="toggle-slider" />
          </label>
        </div>
      </AppCard>

      <!-- 自动管理 -->
      <AppCard v-if="autoManagedRules.length > 0" padding="md" style="margin-top: 12px">
        <h4>自动管理</h4>
        <p class="text-muted text-sm" style="margin-bottom: 12px">
          由世界书或角色自动激活，不可手动操作。
        </p>
        <div v-for="rule in autoManagedRules" :key="rule.id" class="rule-item rule-locked">
          <div class="rule-header">
            <span class="rule-lock-icon">—</span>
            <span class="rule-name">{{ rule.name }}</span>
            <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
            <span class="rule-source-tag">{{ rule.group }}</span>
          </div>
        </div>
      </AppCard>

      <!-- 已启用 -->
      <AppCard v-if="manualEnabledRules.length > 0" padding="md" style="margin-top: 12px">
        <h4>已启用</h4>
        <p class="text-muted text-sm" style="margin-bottom: 12px">
          当前生效的规则，可手动启用/禁用。
        </p>
        <div v-for="rule in manualEnabledRules" :key="rule.id" class="rule-item">
          <div class="rule-header">
            <label class="toggle-label">
              <input
                type="checkbox"
                :checked="rule.enabled"
                class="toggle-input"
                @change="toggleBuiltinRule(rule.id)"
              />
              <span class="toggle-slider" />
            </label>
            <span class="rule-name">{{ rule.name }}</span>
            <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
            <button class="rule-expand-btn" @click="toggleExpand(rule.id)">
              {{ expanded[rule.id] ? '收起' : '查看' }}
            </button>
          </div>
          <div v-if="expanded[rule.id]" class="rule-detail">
            <div class="rule-field">
              <span>正则:</span><code>{{ rule.pattern }}</code>
            </div>
            <div class="rule-field">
              <span>替换:</span
              ><code
                >{{ rule.replacement.slice(0, 200)
                }}{{ rule.replacement.length > 200 ? '...' : '' }}</code
              >
            </div>
          </div>
        </div>
      </AppCard>

      <!-- 可用规则库 -->
      <AppCard padding="md" style="margin-top: 12px">
        <div class="library-header" @click="toggleLibrary">
          <h4 style="margin: 0; cursor: pointer">
            可用规则库 · {{ disabledRules.length }} 条未启用
          </h4>
          <span class="library-arrow">{{ libraryExpanded ? '▼' : '▸' }}</span>
        </div>
        <p v-if="!libraryExpanded" class="text-muted text-sm" style="margin-top: 6px">
          <template v-for="([group, rules], i) in disabledGrouped" :key="group">
            {{ group }} ({{ rules.length }}){{ i < disabledGrouped.length - 1 ? ' · ' : '' }}
          </template>
        </p>
        <template v-if="libraryExpanded && disabledGrouped.length > 0">
          <div v-for="[group, rules] in disabledGrouped" :key="group" class="group-section">
            <div class="group-label">{{ group }} · {{ rules.length }} 条</div>
            <div v-for="rule in rules" :key="rule.id" class="rule-item rule-disabled-item">
              <div class="rule-header">
                <label class="toggle-label">
                  <input
                    type="checkbox"
                    :checked="false"
                    class="toggle-input"
                    @change="toggleBuiltinRule(rule.id)"
                  />
                  <span class="toggle-slider" />
                </label>
                <span class="rule-name rule-name-dim">{{ rule.name }}</span>
                <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
                <button class="rule-expand-btn" @click="toggleExpand(rule.id)">
                  {{ expanded[rule.id] ? '收起' : '查看' }}
                </button>
              </div>
              <div v-if="expanded[rule.id]" class="rule-detail">
                <div class="rule-field">
                  <span>正则:</span><code>{{ rule.pattern }}</code>
                </div>
                <div class="rule-field">
                  <span>替换:</span
                  ><code
                    >{{ rule.replacement.slice(0, 200)
                    }}{{ rule.replacement.length > 200 ? '...' : '' }}</code
                  >
                </div>
              </div>
            </div>
          </div>
        </template>
        <div
          v-if="libraryExpanded && disabledGrouped.length === 0"
          class="text-muted text-sm"
          style="text-align: center; padding: 16px"
        >
          暂无可用规则
        </div>
      </AppCard>

      <!-- 自定义规则 -->
      <AppCard padding="md" style="margin-top: 12px">
        <div
          style="
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
          "
        >
          <h4 style="margin: 0">自定义规则</h4>
          <AppButton variant="primary" size="sm" @click="openAdd">＋ 添加规则</AppButton>
        </div>
        <p
          v-if="userRules.length === 0"
          class="text-muted text-sm"
          style="text-align: center; padding: 24px"
        >
          暂无自定义规则<br />
          <span style="font-size: 0.75rem">点击右上角添加，用正则表达式自定义输出美化</span>
        </p>
        <div v-for="rule in userRules" :key="rule.id" class="rule-item">
          <div class="rule-header">
            <label class="toggle-label">
              <input
                type="checkbox"
                :checked="rule.enabled"
                class="toggle-input"
                @change="toggleUserRule(rule)"
              />
              <span class="toggle-slider" />
            </label>
            <span class="rule-name">{{ rule.name }}</span>
            <span class="rule-scope text-xs text-muted">{{ scopeLabel(rule.scope) }}</span>
            <button class="rule-action-btn" title="编辑" @click="openEdit(rule)">✎</button>
            <button
              class="rule-action-btn rule-delete-btn"
              title="删除"
              @click="deleteRule(rule)"
            ></button>
          </div>
          <div v-if="expanded[rule.id]" class="rule-detail">
            <div class="rule-field">
              <span>正则:</span><code>{{ rule.pattern }}</code>
            </div>
            <div class="rule-field">
              <span>替换:</span
              ><code
                >{{ rule.replacement.slice(0, 200)
                }}{{ rule.replacement.length > 200 ? '...' : '' }}</code
              >
            </div>
          </div>
        </div>
      </AppCard>

      <!-- 导入/导出 -->
      <div style="display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end">
        <AppButton variant="secondary" size="sm" @click="exportRules">导出规则</AppButton>
        <AppButton variant="secondary" size="sm" @click="importRules">导入规则</AppButton>
      </div>
    </template>
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
.loading-placeholder {
  text-align: center;
  padding: 32px;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}

/* ═══ 规则行 ═══ */
.rule-item {
  border-bottom: 1px solid var(--theme-card-border);
  padding: 8px 0;
}
.rule-item:last-child {
  border-bottom: none;
}
.rule-locked {
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 8px;
  margin-bottom: 4px;
  border-bottom: none;
  opacity: 0.85;
}
.rule-disabled-item {
  opacity: 0.6;
}
.rule-header {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-lock-icon {
  font-size: 0.8rem;
  flex-shrink: 0;
}
.rule-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  flex: 1;
}
.rule-name-dim {
  color: var(--theme-text-muted);
}
.rule-scope {
  opacity: 0.7;
  white-space: nowrap;
}
.rule-source-tag {
  font-size: 0.625rem;
  padding: 1px 7px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--theme-primary) 15%, transparent);
  color: var(--theme-primary);
  font-weight: 500;
  white-space: nowrap;
}

/* ═══ 规则库折叠 ═══ */
.library-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
  transition: color var(--theme-transition-fast, 0.15s);
}
.library-header:hover {
  color: var(--theme-text-primary);
}
.library-arrow {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  transition: transform var(--theme-transition-fast, 0.15s);
}

/* ═══ 分组 ═══ */
.group-section {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--theme-card-border);
}
.group-section:first-child {
  margin-top: 16px;
}
.group-label {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 6px;
  padding-left: 2px;
}

/* ═══ 详情折叠 ═══ */
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
  transition: all var(--theme-transition-fast, 0.15s);
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

/* ═══ 全局开关 ═══ */
.toggle-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
}
.toggle-row span {
  font-size: 0.85rem;
}
.toggle-label {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  cursor: pointer;
}
.toggle-input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--theme-surface-muted);
  border-radius: 22px;
  transition: background var(--theme-transition-fast, 0.15s);
}
.toggle-slider::before {
  content: '';
  position: absolute;
  height: 16px;
  width: 16px;
  left: 3px;
  bottom: 3px;
  background: var(--theme-text-muted);
  border-radius: 50%;
  transition: transform var(--theme-transition-fast, 0.15s);
}
.toggle-input:checked + .toggle-slider {
  background: var(--theme-primary);
}
.toggle-input:checked + .toggle-slider::before {
  transform: translateX(18px);
  background: var(--theme-primary-text);
}
</style>
