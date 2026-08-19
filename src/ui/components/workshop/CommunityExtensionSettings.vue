<script setup lang="ts">
/**
 * 已安装社区扩展的启用设置 —— 扩展管理页独占的控制面。
 *
 * 启用状态仍按存档保存到 metadata.enabledWorldBookEntries；本组件只把“项目”展开成
 * creative_workshop:<uid>，不新增全局开关或第二份状态。
 */
import { computed, onMounted, ref } from 'vue';
import type { SaveSlot, WorldBook } from '@engine/types';
import { useGameStore } from '../../stores/game-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import {
  applyWorkshopSelection,
  buildWorkshopEnableOptions,
  selectedWorkshopProjectIds,
} from '../../lib/workshop-enable';
import WorkshopEnableList from '../shared/WorkshopEnableList.vue';

const game = useGameStore();
const workshop = useWorkshopStore();
const worldbooks = useWorldBookStore();

const selectedSaveId = ref('');
const loading = ref(true);
const saving = ref(false);
const errorMsg = ref('');

const savesByRecent = computed(() => [...game.saves].sort((a, b) => b.updatedAt - a.updatedAt));
const selectedSave = computed<SaveSlot | null>(
  () => game.saves.find((save) => save.id === selectedSaveId.value) ?? null,
);
const options = computed(() =>
  buildWorkshopEnableOptions(workshop.projects, worldbooks.books as unknown as WorldBook[]),
);
const tokens = computed<string[]>(
  () => selectedSave.value?.metadata?.enabledWorldBookEntries ?? ([] as string[]),
);
const selectedIds = computed(() => selectedWorkshopProjectIds(options.value, tokens.value));

function chooseDefaultSave() {
  if (selectedSaveId.value && game.saves.some((save) => save.id === selectedSaveId.value)) return;
  selectedSaveId.value =
    game.activeSaveId && game.saves.some((save) => save.id === game.activeSaveId)
      ? game.activeSaveId
      : (savesByRecent.value[0]?.id ?? '');
}

async function load() {
  loading.value = true;
  errorMsg.value = '';
  const outcomes = await Promise.allSettled([game.loadSaves(), workshop.init(), worldbooks.init()]);
  chooseDefaultSave();
  if (outcomes.some((outcome) => outcome.status === 'rejected')) {
    errorMsg.value = '部分扩展状态读取失败，请稍后重试';
  }
  loading.value = false;
}

async function onToggle(projectId: string) {
  const saveId = selectedSaveId.value;
  if (!saveId || saving.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);

  saving.value = true;
  errorMsg.value = '';
  const ok = await game.setSaveEnabledWorldBookEntries(
    saveId,
    applyWorkshopSelection(tokens.value, options.value, next),
  );
  saving.value = false;
  if (!ok) errorMsg.value = '保存失败，改动未写入存档';
}

onMounted(load);
</script>

<template>
  <div class="community-settings">
    <div class="community-settings-head">
      <div>
        <h4>已安装扩展启用</h4>
        <p>启用状态按存档分别保存，不影响其他存档。</p>
      </div>

      <label v-if="savesByRecent.length > 0" class="save-picker">
        <span>配置存档</span>
        <select v-model="selectedSaveId" :disabled="saving" aria-label="配置存档">
          <option v-for="save in savesByRecent" :key="save.id" :value="save.id">
            {{ save.name || save.metadata.characterName || `存档 ${save.slot + 1}` }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="errorMsg" class="settings-error" role="alert">{{ errorMsg }}</p>
    <div v-if="loading" class="settings-empty">正在读取扩展设置…</div>
    <div v-else-if="savesByRecent.length === 0" class="settings-empty">
      尚无可配置的存档，创建存档后即可设置社区扩展的启用状态。
    </div>
    <WorkshopEnableList
      v-else
      :options="options"
      :selected="selectedIds"
      :disabled="saving || !selectedSave"
      empty-text="尚未安装社区扩展 —— 可进入创意工坊浏览并安装"
      @toggle="onToggle"
    />
  </div>
</template>

<style scoped>
.community-settings {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
}

.community-settings-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  padding-bottom: var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
}

.community-settings-head h4 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
}

.community-settings-head p {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.save-picker {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.save-picker select {
  min-width: 12rem;
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font: inherit;
}

.save-picker select:focus-visible {
  border-color: var(--theme-primary);
  outline: 2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  outline-offset: 1px;
}

.settings-empty {
  padding: var(--theme-spacing-xl) 0;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  text-align: center;
}

.settings-empty::before {
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  content: '—';
  font-size: 1.25rem;
  opacity: 0.3;
}

.settings-error {
  margin: 0;
  color: var(--theme-error);
  font-size: 0.75rem;
}

@media (max-width: 640px) {
  .save-picker {
    width: 100%;
    align-items: stretch;
    flex-direction: column;
  }

  .save-picker select {
    width: 100%;
    min-width: 0;
  }
}
</style>
