<script setup lang="ts">
/**
 * 「预设」状态条 —— 每个 Agent 配置面的提示词区最上方都有一条（2026-11-14）。
 *
 * 目标是**不懂内部机制也看得懂**：现在生效的是哪一份、它从哪来、怎么回到默认。
 *
 * 两种形态：
 *   · 预设型 Agent（story / direct_main / direct_cached）：分组下拉
 *     「默认 / 内容包 / 引擎内置 / 我的预设」+ 来源角标 + 失效选择提示 + 一排动作。
 *     选「默认」那一项存空串（跟随默认），其余存 id —— 都经 usePresets.selectPreset。
 *   · 其余 Agent：只读状态行（默认 / 我的自定义，已改几处）+ 「恢复默认」。
 *     恢复只清 systemPrompt 与上下文模板两项覆写，由宿主执行（草稿在宿主手里），
 *     本组件只 emit `reset-prompt`。
 *
 * 🔴 内容包 / 引擎内置的预设是只读的：这里能做的只有「复制为我的预设」。
 *    重命名、删除只对玩家自己的预设出现。
 *
 * 🔴 单根：两个 AppModal 放在根卡内层（与 PresetManager 同一个理由）。
 */
import { computed, reactive, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import { useUIStore } from '../../../stores/ui-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useContentStore } from '../../../stores/content-store';
import { usePresets } from '../../../composables/usePresets';
import { contentSourceLabel } from './preset-bar-labels';
import {
  presetProfileForAgent,
  profileScope,
  type PresetCatalogEntry,
} from '@engine/prompts/preset-resolution';
import type { ChatPreset } from '@engine/types/types';

const props = defineProps<{ agentId: string }>();
const emit = defineEmits<{ 'reset-prompt': [] }>();

const ui = useUIStore();
const s = useSettingsStore().settings;
const content = useContentStore();
const {
  catalog,
  effectivePreset,
  defaultPreset,
  selectPreset,
  duplicateAsUser,
  upsertPreset,
  removePreset,
} = usePresets();

const profile = computed(() => presetProfileForAgent(props.agentId));

// ============================================================
// 非预设 Agent：只读状态行
// ============================================================
/** 覆写层里实际存在的提示词字段数（systemPrompt / 上下文模板，最多 2） */
const promptOverrideCount = computed(() => {
  const entry = s.agents?.[props.agentId];
  if (!entry) return 0;
  return (['systemPrompt', 'template'] as const).filter((k) => entry[k] !== undefined).length;
});
// 开发叠加目录是否启用（vite define 注入，与 AgentConfigPanel 的「保存为默认」同一个开关）
declare const __POEM_CONTENT_DIR__: boolean;
/** 默认内容的来源措辞：内容包 / 本地内容（开发叠加、没装包）/ 占位内容 */
const defaultSourceLabel = computed(() =>
  contentSourceLabel({
    packActive: content.contentStatus === 'pack' || !!content.activePackId,
    localContentDir: __POEM_CONTENT_DIR__,
  }),
);

// ============================================================
// 预设型 Agent
// ============================================================
const effective = computed(() => (profile.value ? effectivePreset(profile.value) : null));

/** 不看选择键时的默认那一份（与运行时同一个解析器） */
const defaultEntry = computed<PresetCatalogEntry | null>(() => {
  const p = profile.value;
  if (!p) return null;
  const id = defaultPreset(p).presetId;
  return catalog.value.find((e) => e.preset.id === id) ?? null;
});

function inScope(entry: PresetCatalogEntry): boolean {
  const p = profile.value;
  return !!p && (entry.scope === undefined || entry.scope === profileScope(p));
}

const defaultId = computed(() => defaultEntry.value?.preset.id ?? '');
const contentOptions = computed(() =>
  catalog.value.filter(
    (e) => e.origin === 'content' && inScope(e) && e.preset.id !== defaultId.value,
  ),
);
/** 只列本生成方式对应的那份内置预设，且它已经是默认时不重复列出 */
const builtinOptions = computed(() =>
  catalog.value.filter(
    (e) =>
      e.origin === 'builtin' && e.builtinFor === profile.value && e.preset.id !== defaultId.value,
  ),
);
const userOptions = computed(() => catalog.value.filter((e) => e.origin === 'user' && inScope(e)));

/** 下拉当前值：跟随默认时是空串，否则是选中的 id */
const selectValue = computed(() => {
  const eff = effective.value;
  if (!eff || eff.followsDefault) return '';
  return eff.presetId;
});

const effectiveEntry = computed(
  () => catalog.value.find((e) => e.preset.id === effective.value?.presetId) ?? null,
);
/** 来源角标：内容预设按实际来源说（没装包时不说「内容包」） */
const originLabel = computed(() => {
  const origin = effectiveEntry.value?.origin;
  if (!origin) return '';
  if (origin === 'content') return defaultSourceLabel.value;
  return origin === 'builtin' ? '引擎内置' : '我的';
});
const isUserPreset = computed(() => effectiveEntry.value?.origin === 'user');
const canRestore = computed(() => {
  const eff = effective.value;
  return !!eff && (!eff.followsDefault || eff.staleSelection);
});

function onSelect(e: Event): void {
  const p = profile.value;
  if (!p) return;
  const id = (e.target as HTMLSelectElement).value;
  selectPreset(p, id || defaultId.value);
}

function restoreDefault(): void {
  const p = profile.value;
  if (!p) {
    emit('reset-prompt');
    return;
  }
  selectPreset(p, defaultId.value);
  ui.toast('已恢复默认预设', 'info');
}

async function duplicateEffective(): Promise<void> {
  const p = profile.value;
  const id = effective.value?.presetId;
  if (!p || !id) return;
  try {
    const copy = await duplicateAsUser(id, profileScope(p));
    if (!copy) return;
    selectPreset(p, copy.id);
    ui.toast(`已复制为我的预设「${copy.name}」并切换`, 'success');
  } catch {
    ui.toast('复制失败，请稍后重试', 'error');
  }
}

function importPreset(): void {
  const p = profile.value;
  if (!p) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      const presetName = f.name.replace(/\.json$/i, '');
      const now = Date.now();
      const preset: ChatPreset = {
        id: crypto.randomUUID(),
        name: presetName,
        description: raw.description || '',
        settings: raw,
        // 导入的预设只属于当前这种生成方式
        scope: profileScope(p),
        createdAt: now,
        updatedAt: now,
      };
      await upsertPreset(preset);
      selectPreset(p, preset.id);
      ui.toast(`已导入预设「${presetName}」(${raw.prompts?.length || 0} 个子提示词)`, 'success');
    } catch {
      ui.toast('导入失败，请检查文件格式', 'error');
    }
  };
  input.click();
}

function exportEffective(): void {
  const preset = effective.value?.preset;
  if (!preset) return;
  const data = { ...preset.settings, name: preset.name, description: preset.description };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${preset.name}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- 重命名（只对我的预设） ----
const showRename = ref(false);
const renameForm = reactive({ name: '', description: '' });

function openRename(): void {
  const preset = effective.value?.preset;
  if (!preset || !isUserPreset.value) return;
  renameForm.name = preset.name || '';
  renameForm.description = preset.description || '';
  showRename.value = true;
}

async function saveRename(): Promise<void> {
  const preset = effective.value?.preset;
  const name = renameForm.name.trim();
  if (!preset || !name) return;
  try {
    await upsertPreset({
      ...preset,
      name,
      description: renameForm.description,
      updatedAt: Date.now(),
    });
    showRename.value = false;
    ui.toast('预设已重命名', 'success');
  } catch {
    ui.toast('保存失败，请稍后重试', 'error');
  }
}

// ---- 删除（只对我的预设，必须确认） ----
const showDelete = ref(false);
const pendingDelete = ref<{ id: string; name: string } | null>(null);

function openDelete(): void {
  const preset = effective.value?.preset;
  if (!preset || !isUserPreset.value) return;
  pendingDelete.value = { id: preset.id, name: preset.name };
  showDelete.value = true;
}

async function confirmDelete(): Promise<void> {
  const p = profile.value;
  const target = pendingDelete.value;
  if (!p || !target) return;
  try {
    // 删之前判：删完之后它已不在目录里，生效结果早就退回默认了
    const wasSelected = effective.value?.presetId === target.id;
    await removePreset(target.id);
    // 选择键清回「跟随默认」，不留一个指向已删预设的失效选择
    if (wasSelected) selectPreset(p, defaultId.value);
    showDelete.value = false;
    // S-16：删掉的是正在用的那条时，说清楚现在改用了哪条
    const fallbackName = wasSelected ? defaultEntry.value?.preset.name : undefined;
    ui.toast(
      fallbackName
        ? `预设已删除，已改用默认预设「${fallbackName}」`
        : wasSelected
          ? '预设已删除，当前没有可用的默认预设，请导入或复制一个'
          : '预设已删除',
      wasSelected && !fallbackName ? 'warning' : 'info',
    );
  } catch (error) {
    ui.toast(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}
</script>

<template>
  <AppCard padding="md" class="detail-card preset-bar" data-testid="agent-preset-bar">
    <div class="preset-bar-head">
      <h4>预设</h4>
    </div>

    <!-- 预设型 Agent -->
    <template v-if="profile">
      <div class="preset-bar-row">
        <select
          class="form-input preset-bar-select"
          aria-label="选择预设"
          data-testid="preset-select"
          :value="selectValue"
          @change="onSelect"
        >
          <optgroup label="默认">
            <option value="">
              默认 · {{ defaultEntry ? defaultEntry.preset.name : '（没有可用的预设）' }}
            </option>
          </optgroup>
          <optgroup v-if="contentOptions.length" label="内容包">
            <option v-for="e in contentOptions" :key="e.preset.id" :value="e.preset.id">
              {{ e.preset.name }}
            </option>
          </optgroup>
          <optgroup v-if="builtinOptions.length" label="引擎内置">
            <option v-for="e in builtinOptions" :key="e.preset.id" :value="e.preset.id">
              {{ e.preset.name }}
            </option>
          </optgroup>
          <optgroup v-if="userOptions.length" label="我的预设">
            <option v-for="e in userOptions" :key="e.preset.id" :value="e.preset.id">
              {{ e.preset.name }}
            </option>
          </optgroup>
        </select>
        <span v-if="originLabel" class="origin-chip" data-testid="preset-origin">{{
          originLabel
        }}</span>
      </div>

      <p v-if="effective?.staleSelection" class="stale-notice" data-testid="preset-stale">
        原先选择的预设已不存在，现使用默认预设
      </p>

      <div class="preset-bar-actions">
        <AppButton
          variant="ghost"
          size="sm"
          data-testid="preset-duplicate"
          :disabled="!effective?.preset"
          @click="duplicateEffective"
          >复制为我的预设</AppButton
        >
        <AppButton variant="ghost" size="sm" data-testid="preset-import" @click="importPreset"
          >导入</AppButton
        >
        <AppButton
          variant="ghost"
          size="sm"
          data-testid="preset-export"
          :disabled="!effective?.preset"
          @click="exportEffective"
          >导出</AppButton
        >
        <template v-if="isUserPreset">
          <AppButton variant="ghost" size="sm" data-testid="preset-rename" @click="openRename"
            >重命名</AppButton
          >
          <AppButton variant="ghost" size="sm" data-testid="preset-delete" @click="openDelete"
            >删除</AppButton
          >
        </template>
        <AppButton
          variant="secondary"
          size="sm"
          data-testid="preset-restore"
          :disabled="!canRestore"
          @click="restoreDefault"
          >恢复默认</AppButton
        >
      </div>
      <p class="form-hint">
        内容包与引擎内置的预设是只读的；改动它们时会自动复制一份到「我的预设」。
      </p>
    </template>

    <!-- 其余 Agent：只读状态行 -->
    <div v-else class="preset-bar-row">
      <span class="prompt-state" data-testid="prompt-state">{{
        promptOverrideCount === 0
          ? `默认（${defaultSourceLabel}）`
          : `我的自定义（已改 ${promptOverrideCount} 处）`
      }}</span>
      <AppButton
        variant="secondary"
        size="sm"
        data-testid="preset-restore"
        :disabled="promptOverrideCount === 0"
        @click="restoreDefault"
        >恢复默认</AppButton
      >
    </div>

    <AppModal :open="showRename" title="重命名预设" size="md" @update:open="showRename = $event">
      <div class="api-form">
        <label class="form-label"
          >预设名称<input v-model="renameForm.name" class="form-input" data-testid="rename-name"
        /></label>
        <label class="form-label"
          >描述<input
            v-model="renameForm.description"
            class="form-input"
            placeholder="简短描述此预设的风格"
        /></label>
      </div>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showRename = false">取消</AppButton>
        <AppButton
          variant="primary"
          size="sm"
          data-testid="rename-save"
          :disabled="!renameForm.name.trim()"
          @click="saveRename"
          >保存</AppButton
        >
      </template>
    </AppModal>

    <AppModal :open="showDelete" title="删除预设" size="sm" @update:open="showDelete = $event">
      <p>确定删除预设「{{ pendingDelete?.name }}」吗？此操作不可撤销。</p>
      <p class="form-hint">删除后这一项会回到默认预设。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="showDelete = false">取消</AppButton>
        <AppButton variant="danger" size="sm" data-testid="delete-confirm" @click="confirmDelete"
          >删除</AppButton
        >
      </template>
    </AppModal>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.preset-bar-head h4 {
  margin: 0 0 var(--theme-spacing-sm);
}
.preset-bar-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.preset-bar-select {
  flex: 1;
  min-width: 0;
}
.origin-chip {
  flex-shrink: 0;
  padding: 0 var(--theme-spacing-sm);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  font-size: 0.6875rem;
  line-height: 1.8;
}
.stale-notice {
  margin: var(--theme-spacing-sm) 0 0;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  font-size: 0.75rem;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-sm);
}
.preset-bar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  margin-top: var(--theme-spacing-sm);
}
.prompt-state {
  flex: 1;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
</style>
