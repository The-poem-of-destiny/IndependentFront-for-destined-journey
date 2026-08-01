<script setup lang="ts">
/**
 * WorkshopEnablePanel.vue — 每存档的工坊启用面板（P1-5，D12）
 *
 * 为什么建档后还要有一个: 工坊项目多半是玩到一半装的，捏人页那次勾选够不着它们。
 *
 * 写入走 `game.setEnabledWorldBookEntries()` —— ADR-21 的 P1-09 受控例外（纯 UI
 * 辅助字段经统一写入函数），不是裸 db.put，也不新增 SaveSlot 字段: 勾选结果就是
 * `metadata.enabledWorldBookEntries` 里的 `creative_workshop:<uid>` 串，与
 * `system_core:413` 同一条机制。展开/回读语义与捏人页共用 `lib/workshop-enable`。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import {
  applyWorkshopSelection,
  buildWorkshopEnableOptions,
  selectedWorkshopProjectIds,
} from '../../lib/workshop-enable';
import type { WorkshopEnableOption } from '../../lib/workshop-enable';
import type { WorldBook } from '@engine/types';
import WorkshopEnableList from '../shared/WorkshopEnableList.vue';

const game = useGameStore();
const workshop = useWorkshopStore();
const worldbook = useWorldBookStore();

const options = ref<WorkshopEnableOption[]>([]);
const loading = ref(true);
const saving = ref(false);
const errorMsg = ref('');

/** 存档里现有的 token（唯一真源，不另存一份勾选状态） */
const tokens = computed<string[]>(
  () => game.activeSave?.metadata?.enabledWorldBookEntries ?? ([] as string[]),
);

const selectedIds = computed(() => selectedWorkshopProjectIds(options.value, tokens.value));

async function reload() {
  loading.value = true;
  errorMsg.value = '';
  try {
    await workshop.init();
    options.value = buildWorkshopEnableOptions(
      workshop.projects,
      worldbook.books as unknown as WorldBook[],
    );
  } catch (err) {
    console.error('[WorkshopEnablePanel] 加载工坊项目失败:', err);
    options.value = [];
    errorMsg.value = '工坊项目列表加载失败';
  } finally {
    loading.value = false;
  }
}

async function onToggle(projectId: string) {
  if (saving.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  saving.value = true;
  errorMsg.value = '';
  const ok = await game.setEnabledWorldBookEntries(
    applyWorkshopSelection(tokens.value, options.value, next),
  );
  saving.value = false;
  if (!ok) errorMsg.value = '保存失败，改动未写入存档';
}

onMounted(reload);
// 打开面板时刷新 —— 会话中途可能刚装了新项目
watch(
  () => game.activeModal,
  (m) => {
    if (m === 'workshop') void reload();
  },
);
</script>

<template>
  <div class="workshop-enable-panel">
    <div class="panel-header">
      <span class="panel-title">工坊内容 ({{ selectedIds.length }} / {{ options.length }})</span>
      <span class="panel-hint">勾选后随本存档启用，可随时改</span>
    </div>

    <p v-if="errorMsg" class="panel-error">{{ errorMsg }}</p>

    <div v-if="loading" class="panel-loading">正在加载工坊项目…</div>
    <WorkshopEnableList
      v-else
      :options="options"
      :selected="selectedIds"
      :disabled="saving || !game.activeSave"
      empty-text="尚未安装工坊项目 —— 可在首页「创意工坊」中安装"
      @toggle="onToggle"
    />
  </div>
</template>

<style scoped>
.workshop-enable-panel {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  padding-bottom: var(--theme-spacing-sm);
  border-bottom: 1px solid var(--theme-card-border);
}
.panel-title {
  font-family: var(--theme-font-title, serif);
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.panel-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

.panel-loading {
  padding: var(--theme-spacing-xl);
  text-align: center;
  font-size: 0.8125rem;
  color: var(--theme-text-muted);
}

.panel-error {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-error);
}
</style>
