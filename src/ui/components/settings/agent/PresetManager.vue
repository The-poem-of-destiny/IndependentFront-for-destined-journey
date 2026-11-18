<script setup lang="ts">
import { isDirectSettingsProfile } from '../../../lib/direct-settings';

/**
 * 预设内容面（预设型 Agent：story / direct_main / direct_cached）。
 *
 * 只管**生效预设的内容**：条目列表（增删改序、启用开关）、预填充开关、模板/解析预览，
 * 外加两个弹窗（条目编辑、删除条目确认）。选哪份预设、复制/导入/导出/重命名/删除
 * 预设都在上方的 `AgentPresetBar`（2026-11-14 拆出）。
 *
 * 🔴 **单根**：两个 AppModal 放在根 AppCard **内层**。多根 fragment 会让 Vue
 *    既不做属性透传、也不把父组件的 scope id 盖上来。AppModal 自己
 *    `<Teleport to="body">`，所以嵌进来不改变它实际渲染的位置。
 *
 * 🔴 `loadPresets()` 在**本组件挂载时**跑，只读不写：选择键为空即「跟随默认」，
 *    生效预设由 usePresets 的 `effectivePreset`（preset-resolution）解析。
 *
 * 🔴 **写时复制**：内容包 / 出厂 / 引擎内置的预设是只读的。对它们的任何编辑
 *    （条目增改删、移动、复制、启用开关、预填充开关）都先复制成「<原名>（我的修改）」、
 *    切换到副本、把改动落在副本上 —— 原预设一字不动。见 `persistPreset`。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import TemplatePreview from '../TemplatePreview.vue';
import { useUIStore } from '../../../stores/ui-store';
import { usePresets } from '../../../composables/usePresets';
import {
  canonicalPresetEntries,
  makeCustomPresetEntry,
  appendPresetEntry,
  updatePresetEntry,
  removePresetEntry,
  movePresetEntry,
  duplicatePresetEntry,
  isZonePlaceholderEntry,
} from '../../../lib/preset-entries';
import { preprocessPresetForPreview, findTailAssistantEntry } from '@engine/prompts/preset-loader';
import { buildDirectProtocol, DIRECT_TEMPLATE } from '@engine/prompts/direct-prompt';
import { isDirectStructuredCombatEnabled } from '@engine/combat/direct-combat';
import {
  copyScopeFor,
  presetProfileForAgent,
  presetScopeMatches,
} from '@engine/prompts/preset-resolution';
import type { ChatPreset } from '@engine/types/types';

const props = defineProps<{ agentId: string }>();

const ui = useUIStore();
const {
  catalog,
  effectivePreset,
  selectPreset: storeSelection,
  duplicateAsUser,
  loadPresets: loadPresetsFromDexie,
  upsertPreset,
} = usePresets();
const profile = computed(() => presetProfileForAgent(props.agentId) ?? 'story');
/** 生效预设 id（选择为空/失效时即默认）；写入经 usePresets，选默认那条存空串 */
const selectedPresetId = computed({
  get: () => effectivePreset(profile.value).presetId,
  set: (id: string) => storeSelection(profile.value, id),
});
/** 本生成方式可见的目录条目（内置直出预设不落盘，也在这里） */
const presets = computed(() =>
  catalog.value
    .filter((entry) => presetScopeMatches(entry.scope, profile.value))
    .map((entry) => entry.preset),
);

const showStoryPreview = ref(false);
const showStoryResolvedPreview = ref(false);

// Phase 10h: 预设解析预览 — setvar/getvar 展开，系统占位符/random/char/user 保留
const resolvedPresetTemplate = computed(() => {
  const preset = activePreset.value;
  if (!preset) return '';
  return preprocessPresetForPreview(preset as any);
});

// Get the context template for Story agent (from injected entries or default block)
function getStoryContextTemplate(): string {
  if (isDirectSettingsProfile(props.agentId))
    return buildDirectProtocol(isDirectStructuredCombatEnabled()) + '\n' + DIRECT_TEMPLATE;
  const preset = activePreset.value;
  if (!preset?.settings?.prompts) return '';
  const dynamicEntry = preset.settings.prompts.find(
    (p: any) => p.name === '动态注入' && p.enabled !== false,
  );
  if (dynamicEntry?.content) return dynamicEntry.content;
  // Fallback: the default block
  return [
    '{{AGENT.MEMORY_RECALL}}',
    '{{AGENT.PLOT_PRE_CHECK}}',
    '{{LORE_BOOK_STATIC}}',
    '{{CHARACTER_STATE}}',
    '{{LORE_BOOK_DYNAMIC}}',
    '{{GAME_TIME}}',
    '{{NARRATIVE}}',
    '{{USER_INPUT}}',
  ].join('\n');
}

// ============================================================
// 预设系统（正文 Agent 专用）
// ============================================================
/**
 * 当前选中的预设。
 *
 * 🔴 AgentConfigPanel 的 `saveAsDefault` 也要它，那边**各算一次**而不是穿成 prop ——
 *    它是对 store 的一行派生（与 `hasApi` 同类），穿 prop 只是为了少一次 store 读取，
 *    却换来一条真正的组件间契约。
 */
const activePreset = computed(
  () => presets.value.find((p) => p.id === selectedPresetId.value) || null,
);

/** 🔴 条目列表按**生效顺序**（injection_order）渲染 —— 引擎 `assemblePresetContent` 就是这么排的。
 *  模板里的 `idx` 一律是这个顺序下的下标，增删改序的 helper 也按同一口径取条目。 */
const activePrompts = computed(() =>
  activePreset.value ? canonicalPresetEntries(activePreset.value) : [],
);

function presetById(id: string): ChatPreset | null {
  return presets.value.find((p) => p.id === id) || null;
}

/**
 * 统一落库：写 Dexie + 刷新内存 ref；失败时静默（兼容 IndexedDB 不可用环境）。
 *
 * 🔴 写时复制：目标是只读预设（内容包 / 出厂 / 引擎内置）时，先复制成
 *    「<原名>（我的修改）」（scope 见 `copyScopeFor`：单一直出方式的来源保持原样，其余取当前生成方式）、切换到副本，再把改动落在副本上；
 *    原预设一个字节都不写。返回实际写入的 id。
 */
async function persistPreset(next: ChatPreset): Promise<string> {
  try {
    const entry = catalog.value.find((e) => e.preset.id === next.id);
    if (entry?.readonly) {
      const copy = await duplicateAsUser(
        next.id,
        copyScopeFor(entry, profile.value),
        `${entry.preset.name}（我的修改）`,
      );
      if (!copy) return next.id;
      const edited: ChatPreset = {
        ...next,
        id: copy.id,
        name: copy.name,
        createdAt: copy.createdAt,
        updatedAt: Date.now(),
      };
      if (copy.scope) edited.scope = copy.scope;
      else delete edited.scope;
      // `next` 由原（出厂）行派生，会带回播种指纹；副本是玩家预设，一律不带（2026-11-17）
      delete edited.factorySeedHash;
      await upsertPreset(edited);
      selectedPresetId.value = edited.id;
      ui.toast('已复制为我的预设并切换；原预设保持不变', 'info');
      return edited.id;
    }
    await upsertPreset(next);
  } catch {
    /* DB 写入失败：upsertPreset 先写 Dexie 再改 ref，失败则 ref 也不变 */
  }
  return next.id;
}

// 条目展开/折叠
const expandedEntries = ref(new Set<string>());
function toggleEntry(presetId: string, idx: number) {
  const key = `${presetId}:${idx}`;
  if (expandedEntries.value.has(key)) expandedEntries.value.delete(key);
  else expandedEntries.value.add(key);
}

// 条目启用/禁用开关 — 自动保存
async function togglePresetEntryEnabled(presetId: string, idx: number) {
  const p = presetById(presetId);
  if (!p) return;
  const entry = canonicalPresetEntries(p)[idx];
  if (!entry) return;
  await persistPreset(updatePresetEntry(p, idx, { enabled: !(entry.enabled !== false) }));
}

// 条目编辑弹窗（新增 / 编辑共用）
const showEntryEditor = ref(false);
const isNewEntry = ref(false);
const editingEntryIdx = ref(-1);
const editingEntryPresetId = ref('');
const entryEditForm = reactive({ name: '', content: '', enabled: true, role: 'system' });

function openEntryEditor(presetId: string, idx: number) {
  const p = presetById(presetId);
  if (!p) return;
  const sp = canonicalPresetEntries(p)[idx];
  if (!sp) return;
  editingEntryPresetId.value = presetId;
  editingEntryIdx.value = idx;
  isNewEntry.value = false;
  entryEditForm.name = sp.name || '';
  entryEditForm.content = sp.content || '';
  entryEditForm.enabled = sp.enabled !== false;
  entryEditForm.role = sp.role || 'system';
  showEntryEditor.value = true;
}

/** 新增条目（追加到生效顺序末尾）—— 复用编辑弹窗，落库走 append。 */
function openNewEntry() {
  const p = presetById(selectedPresetId.value);
  if (!p) return;
  editingEntryPresetId.value = p.id;
  editingEntryIdx.value = -1;
  isNewEntry.value = true;
  entryEditForm.name = '';
  entryEditForm.content = '';
  entryEditForm.enabled = true;
  entryEditForm.role = 'system';
  showEntryEditor.value = true;
}

async function saveEntry() {
  const p = presetById(editingEntryPresetId.value);
  if (!p) return;
  const patch = {
    name: entryEditForm.name,
    content: entryEditForm.content,
    enabled: entryEditForm.enabled,
    role: entryEditForm.role,
  };
  const next = isNewEntry.value
    ? appendPresetEntry(p, makeCustomPresetEntry(patch))
    : updatePresetEntry(p, editingEntryIdx.value, patch);
  const writtenId = await persistPreset(next);
  showEntryEditor.value = false;
  // 写时复制已经报过一条 toast，这里不再叠第二条
  if (writtenId === next.id) ui.toast(isNewEntry.value ? '条目已新增' : '条目已保存', 'success');
}

/** 上/下移一位（delta = ±1）；越界（顶部上移 / 底部下移）helper 返回原引用，不落库。 */
async function moveEntry(idx: number, delta: number) {
  const p = presetById(selectedPresetId.value);
  if (!p) return;
  const next = movePresetEntry(p, idx, delta);
  if (next === p) return;
  expandedEntries.value.clear();
  await persistPreset(next);
}

/** 复制一条到它的正下方 — 副本进数组后立刻落库。 */
async function duplicateEntry(idx: number) {
  const p = presetById(selectedPresetId.value);
  if (!p) return;
  const next = duplicatePresetEntry(p, idx);
  if (next === p) return;
  expandedEntries.value.clear();
  if ((await persistPreset(next)) === next.id) ui.toast('条目已复制', 'success');
}

// 删除条目 — 二次确认
const showDeleteEntry = ref(false);
const pendingDeleteIdx = ref(-1);
const pendingDeleteName = ref('');

function openDeleteEntry(idx: number) {
  const p = presetById(selectedPresetId.value);
  if (!p) return;
  const entry = canonicalPresetEntries(p)[idx];
  if (!entry) return;
  pendingDeleteIdx.value = idx;
  pendingDeleteName.value = entry.name || `条目 #${idx + 1}`;
  showDeleteEntry.value = true;
}

async function confirmDeleteEntry() {
  const p = presetById(selectedPresetId.value);
  if (!p) return;
  const next = removePresetEntry(p, pendingDeleteIdx.value);
  const writtenId = await persistPreset(next);
  expandedEntries.value.clear();
  showDeleteEntry.value = false;
  if (writtenId === next.id) ui.toast('条目已删除', 'info');
}

/**
 * 预设末尾那条「启用且 role=assistant」的条目 —— 它是**预填充素材**。
 * 没有它就不显示预填充开关（开关只在有意义时出现）。
 */
const tailAssistantEntry = computed(() =>
  activePreset.value ? findTailAssistantEntry(activePreset.value as any) : null,
);

/** 预填充开关是否打开（真源 `settings.prefill.enabled`；末尾必须是 assistant 条目）。 */
const prefillEnabled = computed(
  () =>
    tailAssistantEntry.value !== null &&
    (activePreset.value?.settings as { prefill?: { enabled?: unknown } } | undefined)?.prefill
      ?.enabled === true,
);

/** 填充位置：`content`（正文前缀）/ `reasoning_content`（思维链种子，content 留空）。 */
const prefillField = computed(() => {
  const st = activePreset.value?.settings as { prefill?: { field?: unknown } } | undefined;
  return st?.prefill?.field === 'reasoning_content' ? 'reasoning_content' : 'content';
});

/** 写 `settings.prefill`（只并这两个字段，其余 ST settings 原样保留）。 */
async function patchPrefill(patch: { enabled?: boolean; field?: string }): Promise<void> {
  const p = activePreset.value;
  if (!p) return;
  const st = (p.settings ?? {}) as Record<string, any>;
  const prev = (st.prefill ?? {}) as Record<string, unknown>;
  await persistPreset({
    ...p,
    settings: { ...st, prefill: { ...prev, ...patch } },
    updatedAt: Date.now(),
  });
}
async function togglePrefill() {
  await patchPrefill({ enabled: !prefillEnabled.value });
}
async function onPrefillFieldChange(e: Event) {
  const value = (e.target as HTMLSelectElement).value;
  await patchPrefill({
    enabled: true,
    field: value === 'reasoning_content' ? 'reasoning_content' : 'content',
  });
}

async function loadPresets() {
  try {
    // 只读：不再往库里补内置预设、也不再「自动选中」—— 空选择本身就是跟随默认
    await loadPresetsFromDexie();
  } catch {
    // 预设加载失败（存储损坏 / 格式不认）：保持当前选择，面板照常可用
  }
}
onMounted(() => {
  void loadPresets();
});
</script>

<template>
  <!-- 预设系统（正文 Agent 专用）— 仿酒馆 ST 左侧面板布局 -->
  <AppCard
    v-if="agentId === 'story' || isDirectSettingsProfile(agentId)"
    padding="md"
    class="detail-card"
  >
    <h4>预设内容</h4>
    <p class="form-hint">
      当前生效预设的条目（兼容 SillyTavern
      预设格式）。选择、复制、导入其他预设请用上方「预设」一栏。
    </p>

    <!-- 生效预设的完整预览卡片 — 仿 ST 面板布局 -->
    <div v-if="activePreset" class="preset-viewer">
      <div class="preset-viewer-header">
        <div class="preset-viewer-title">
          <h5>
            {{ activePreset.name }}
            <span
              v-if="prefillEnabled"
              class="prefill-badge"
              title="已启用前缀续写（预填充）：仅 DeepSeek beta 端点支持"
              >预填充</span
            >
          </h5>
          <span v-if="activePreset.description" class="text-xs text-muted">{{
            activePreset.description
          }}</span>
        </div>
      </div>

      <!-- 条目列表（子提示词） -->
      <div class="preset-prompts-list">
        <div class="preset-prompts-head">
          <h4 class="text-sm text-muted">条目列表（{{ activePrompts.length }} 个）</h4>
          <AppButton variant="ghost" size="sm" @click="openNewEntry">＋ 新增条目</AppButton>
        </div>
        <div
          v-for="(sp, idx) in activePrompts"
          :key="sp.identifier || idx"
          class="subprompt-item"
          :class="{
            'subprompt-disabled': sp.enabled === false,
            'subprompt-zone': isZonePlaceholderEntry(sp),
          }"
        >
          <div class="subprompt-header" @click="toggleEntry(selectedPresetId, Number(idx))">
            <div class="subprompt-info">
              <!-- 五区占位条目恒启用、不可停用：用锁标代替开关 -->
              <span
                v-if="isZonePlaceholderEntry(sp)"
                class="subprompt-zone-lock"
                title="上下文分区占位条目，不可删除或停用"
              >
                <i class="fa-solid fa-lock" aria-hidden="true"></i>
              </span>
              <label
                v-else
                class="subprompt-toggle"
                @click.stop.prevent="togglePresetEntryEnabled(selectedPresetId, Number(idx))"
              >
                <input type="checkbox" :checked="sp.enabled !== false" class="toggle-input" />
                <span class="toggle-slider toggle-sm"></span>
              </label>
              <span class="subprompt-name">{{ sp.name || `条目 #${Number(idx) + 1}` }}</span>
              <span v-if="isZonePlaceholderEntry(sp)" class="subprompt-zone-badge">分区占位</span>
              <span v-else class="subprompt-role text-xs text-muted">{{
                sp.role || 'system'
              }}</span>
            </div>
            <div class="subprompt-meta">
              <button
                class="subprompt-edit-btn"
                title="上移"
                :disabled="Number(idx) === 0"
                @click.stop="moveEntry(Number(idx), -1)"
              >
                ↑
              </button>
              <button
                class="subprompt-edit-btn"
                title="下移"
                :disabled="Number(idx) === activePrompts.length - 1"
                @click.stop="moveEntry(Number(idx), 1)"
              >
                ↓
              </button>
              <template v-if="!isZonePlaceholderEntry(sp)">
                <button
                  class="subprompt-edit-btn"
                  title="编辑此条目"
                  @click.stop="openEntryEditor(selectedPresetId, Number(idx))"
                >
                  ✎
                </button>
                <button
                  class="subprompt-edit-btn"
                  title="复制到下方"
                  @click.stop="duplicateEntry(Number(idx))"
                >
                  ⧉
                </button>
                <button
                  class="subprompt-edit-btn subprompt-delete-btn"
                  title="删除此条目"
                  @click.stop="openDeleteEntry(Number(idx))"
                >
                  🗑
                </button>
                <span class="subprompt-chars text-xs text-muted"
                  >{{ (sp.content || '').length }} 字</span
                >
              </template>
              <span
                class="subprompt-chevron"
                :class="{
                  'chevron-open': expandedEntries.has(`${selectedPresetId}:${idx}`),
                }"
                >▸</span
              >
            </div>
          </div>
          <div v-if="expandedEntries.has(`${selectedPresetId}:${idx}`)" class="subprompt-content">
            <template v-if="isZonePlaceholderEntry(sp)">
              开启「Story 上下文与记忆新模式」时，引擎在这个位置填入该分区组装好的消息；
              关闭时这一条为空，不产生任何内容。五个分区的先后顺序固定为 1→5，
              可以在它们之间插入普通条目。
            </template>
            <template v-else>
              {{ (sp.content || '(空)').slice(0, 300)
              }}{{ (sp.content || '').length > 300 ? '...' : '' }}
            </template>
          </div>
        </div>
        <p v-if="activePrompts.length === 0" class="text-muted text-sm" style="padding: 12px 16px">
          此预设没有条目
        </p>
      </div>

      <!-- 🆕 预填充（DeepSeek beta 前缀续写）：仅当**末尾启用条目是 assistant** 时出现。
           打开后那条条目不再并进 system，而是移到消息末尾作为 assistant 前缀（prefix 续写）。 -->
      <div v-if="!isDirectSettingsProfile(agentId) && tailAssistantEntry" class="prefill-block">
        <div class="prefill-head">
          <div class="prefill-heading">
            <span class="prefill-title">预填充（前缀续写）</span>
            <span class="prefill-subtitle">把末尾 assistant 条目移到消息末尾作为前缀</span>
          </div>
          <label class="prefill-switch" @click.stop.prevent="togglePrefill">
            <input type="checkbox" class="toggle-input" :checked="prefillEnabled" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <template v-if="prefillEnabled">
          <p class="prefill-warning">
            <i class="fa-solid fa-triangle-exclamation" aria-hidden="true" />
            <span>
              仅支持 DeepSeek Beta 端点：该 Agent 绑定的 API 源 base_url 需为
              <code>https://api.deepseek.com/beta</code>（并在源参数中自行开启 thinking）。
            </span>
          </p>
          <label class="prefill-field">
            <span class="prefill-field-label">填充位置</span>
            <select class="form-input" :value="prefillField" @change="onPrefillFieldChange">
              <option value="content">正文前缀（模型从条目文字后面接着写）</option>
              <option value="reasoning_content">思维链种子（content 留空）</option>
            </select>
          </label>
        </template>
      </div>
    </div>

    <!-- 未选择预设 -->
    <div v-else class="preset-empty">
      <p class="text-muted">没有可用的预设：请在上方「预设」一栏导入一份</p>
    </div>

    <!-- Phase 10e: Story Agent template preview -->
    <div class="preset-actions">
      <AppButton variant="ghost" size="sm" @click="showStoryPreview = !showStoryPreview">
        {{ showStoryPreview ? '收起模板预览' : '模板预览' }}
      </AppButton>
      <AppButton
        variant="ghost"
        size="sm"
        @click="showStoryResolvedPreview = !showStoryResolvedPreview"
      >
        {{ showStoryResolvedPreview ? '收起解析预览' : '解析预览' }}
      </AppButton>
    </div>

    <div
      v-if="showStoryPreview"
      class="template-preview-panel"
      style="
        margin-top: 10px;
        padding: 12px;
        background: var(--color-surface);
        border-radius: 8px;
        border: 1px solid var(--color-border);
      "
    >
      <p class="form-hint">
        以下为运行时
        <code>动态注入</code> 条目或默认上下文块的内容。占位符最终会被替换。
      </p>
      <TemplatePreview :template="getStoryContextTemplate()" :agent-id="agentId" />
    </div>

    <div
      v-if="showStoryResolvedPreview"
      class="template-preview-panel"
      style="
        margin-top: 10px;
        padding: 12px;
        background: var(--color-surface);
        border-radius: 8px;
        border: 1px solid var(--color-border);
      "
    >
      <p class="form-hint">
        以下为预设完整内容：<code>setvar/getvar</code> 已展开为实际值，<code>random/char/user</code>
        及系统占位符保留为彩色 badge。
      </p>
      <TemplatePreview :template="resolvedPresetTemplate" :agent-id="agentId" />
    </div>

    <AppModal
      :open="showEntryEditor"
      :title="isNewEntry ? '新增条目' : '编辑条目'"
      size="md"
      @update:open="showEntryEditor = $event"
    >
      <div class="api-form">
        <label class="form-label"
          >条目名称<input
            v-model="entryEditForm.name"
            class="form-input"
            placeholder="如: ROLE主提示"
        /></label>
        <div class="key-row">
          <label class="form-label" style="flex: 1"
            >角色
            <select v-model="entryEditForm.role" class="form-input">
              <option value="system">system</option>
              <option value="user">user</option>
              <option value="assistant">assistant</option>
            </select>
          </label>
          <label
            class="form-label toggle-label"
            style="flex-direction: row; align-items: center; gap: 8px"
          >
            <span>启用</span>
            <input v-model="entryEditForm.enabled" type="checkbox" class="toggle-input" />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <label class="form-label">
          内容
          <textarea
            v-model="entryEditForm.content"
            class="form-textarea prompt-editor"
            rows="14"
            placeholder="条目提示词内容..."
          />
        </label>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showEntryEditor = false">取消</AppButton>
        <AppButton variant="primary" size="sm" @click="saveEntry">{{
          isNewEntry ? '新增条目' : '保存条目'
        }}</AppButton>
      </template>
    </AppModal>

    <!-- 删除条目 — 二次确认（删掉携带输出契约的条目会破坏正文解析，必须显式确认） -->
    <AppModal
      :open="showDeleteEntry"
      title="删除条目"
      size="sm"
      @update:open="showDeleteEntry = $event"
    >
      <p>确定删除条目「{{ pendingDeleteName }}」吗？此操作不可撤销。</p>
      <p class="form-hint">
        若该条目携带正文输出格式（如 &lt;maintext&gt;）或必需的系统占位符，删除后正文解析可能异常。
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showDeleteEntry = false">取消</AppButton>
        <AppButton variant="danger" size="sm" @click="confirmDeleteEntry">删除</AppButton>
      </template>
    </AppModal>
  </AppCard>
</template>

<!-- 🔴 顺序不可颠倒：共用外壳必须在自有块**之前**。`.toggle-sm` 与 chrome 里的
     `.toggle-slider` 特异性相同（0,1,0），全靠这个顺序才赢 —— 反过来写，
     预设条目的小开关会悄悄变回 40x22。 -->
<style scoped src="../settings-chrome.css"></style>
<style scoped src="./agent-chrome.css"></style>

<style scoped>
/* Preset 预设系统 — 仿 ST 面板 */
.preset-viewer {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  overflow: hidden;
}
.preset-viewer-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--theme-surface-muted);
  gap: 12px;
}
.preset-viewer-title h5 {
  margin: 0 0 2px;
  font-size: 1rem;
}
/* 子 Prompt 列表 */
.preset-prompts-list {
  display: flex;
  flex-direction: column;
}
.preset-prompts-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
}
.preset-prompts-head h4 {
  margin: 0;
}
.subprompt-item {
  padding: 8px 16px;
  border-bottom: 1px solid var(--theme-card-border);
  transition: background var(--theme-transition-fast);
}
.subprompt-item:last-child {
  border-bottom: none;
}
.subprompt-disabled {
  opacity: 0.45;
}
/* 五区占位条目：强调徽章配方（design.md §1），与普通条目一眼可分 */
.subprompt-zone {
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-card-bg));
}
.subprompt-zone-lock {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  color: var(--theme-primary);
  font-size: 0.6875rem;
}
.subprompt-zone-badge {
  flex-shrink: 0;
  padding: 0 var(--theme-spacing-xs);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  font-size: 0.6875rem;
  line-height: 1.5;
}
.subprompt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.subprompt-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.subprompt-toggle {
  display: flex;
  align-items: center;
  cursor: default;
}
.subprompt-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.subprompt-role {
  font-size: 0.65rem;
  opacity: 0.7;
  flex-shrink: 0;
  text-transform: uppercase;
}
.subprompt-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.subprompt-chars {
  flex-shrink: 0;
}
.subprompt-chevron {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
  transition: transform var(--theme-transition-fast);
  user-select: none;
}
.chevron-open {
  transform: rotate(90deg);
}
.subprompt-edit-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.subprompt-edit-btn:hover {
  color: var(--theme-primary);
  background: var(--theme-tab-hover-bg);
}
.subprompt-edit-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.subprompt-edit-btn:disabled:hover {
  color: var(--theme-text-muted);
  background: none;
}
.subprompt-delete-btn:hover {
  color: var(--theme-error);
}
.subprompt-content {
  padding: 6px 8px 6px 44px;
  font-family: monospace;
  font-size: 0.72rem;
  color: var(--theme-text-secondary);
  white-space: pre-wrap;
  max-height: 80px;
  overflow-y: auto;
  line-height: 1.4;
  background: var(--theme-content-bg);
  border-radius: var(--theme-radius-sm);
  margin-top: 4px;
}
.toggle-sm {
  width: 28px;
  height: 16px;
  border-radius: 8px;
}
.toggle-sm::after {
  width: 12px;
  height: 12px;
}
.preset-empty {
  padding: 24px;
  text-align: center;
}
/* 预设卡底部的一排动作按钮 */
.preset-actions {
  margin-top: var(--theme-spacing-md);
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
/* 🆕 预填充（DeepSeek beta 前缀续写）展示与编辑 */
.prefill-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 0.65rem;
  font-weight: 600;
  vertical-align: middle;
  color: var(--theme-primary);
  border: 1px solid var(--theme-primary);
  border-radius: var(--theme-radius-sm);
}
.prefill-block {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.prefill-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
}
.prefill-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.prefill-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.prefill-subtitle {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
/* 🔴 开关的隐藏 checkbox 用 position:relative 关在本容器里；配合 label 的
   @click.stop.prevent（不让 checkbox 被聚焦），避免浏览器把页面滚到别处。 */
.prefill-switch {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}
.prefill-warning {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-sm);
}
.prefill-warning > i {
  margin-top: 2px;
}
.prefill-warning code {
  color: inherit;
}
.prefill-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prefill-field-label {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
</style>
