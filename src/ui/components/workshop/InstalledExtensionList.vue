<script setup lang="ts">
/**
 * 已安装的社区扩展列表（W-01，2026-11-14）—— 扩展管理页上的**纯本地**维护面。
 *
 * 创意工坊入口锁定期间（见 `workshop-lock.ts`），更新/卸载只存在于进不去的工坊页，
 * 锁定前装过的项目因此删不掉。这里补一个不走网络的「卸载」，并把已装版本与
 * 条目/规则数量摆出来；查更新、更新这类要连上游的动作**刻意不放**。
 *
 * 卸载前用 `confirmDialog` 点名项目，并列出当前勾选启用了它的存档（W-08）——
 * 启用数据与 `CommunityExtensionSettings` 同源（`lib/workshop-enable.ts` 回读
 * 存档 `metadata.enabledWorldBookEntries`）。真正的删除走 `workshop-store.uninstall`
 * （执行器，不在这里加任何转换逻辑）。
 *
 * 文案口径复用 `format.ts`（版本 / 日期 / 处置记录摘要），与工坊页已装列表一致。
 */
import { computed, ref } from 'vue';
import type { SaveSlot, WorkshopProject, WorldBook } from '@engine/types/types';
import {
  groupWorkshopNotes,
  workshopBookId,
  workshopRuleId,
} from '@engine/workshop/workshop-types';
import AppButton from '../shared/AppButton.vue';
import { confirmDialog } from '../../lib/confirm-dialog';
import { buildWorkshopEnableOptions, selectedWorkshopProjectIds } from '../../lib/workshop-enable';
import { useBeautifierStore } from '../../stores/beautifier-store';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import { useWorldBookStore } from '../../stores/worldbook-store';
import { formatDate, formatVersion, summarizeNoteGroups } from './format';
import { WORKSHOP_LOCKED } from './workshop-lock';

const workshop = useWorkshopStore();
const worldbooks = useWorldBookStore();
const beautifier = useBeautifierStore();
const game = useGameStore();
const ui = useUIStore();

/** 正在卸载的项目 id —— 同一时间只处理一个，避免两次确认交错 */
const busyId = ref('');

interface InstalledRow {
  project: WorkshopProject;
  version: string;
  installedAt: string;
  entryCount: number;
  ruleCount: number;
  notes: string;
}

const rows = computed<InstalledRow[]>(() =>
  workshop.projects.map((project) => {
    const book = worldbooks.getBook(workshopBookId(project.id));
    const rulePrefix = workshopRuleId(project.id, '');
    return {
      project,
      version: formatVersion(project.installedVersion) || '未标注',
      installedAt: formatDate(project.installedAt),
      entryCount: book?.entries?.length ?? 0,
      ruleCount: beautifier.userRules.filter((rule) => rule.id.startsWith(rulePrefix)).length,
      notes: summarizeNoteGroups(groupWorkshopNotes(project.droppedNotes)),
    };
  }),
);

function saveLabel(save: SaveSlot): string {
  return save.name || save.metadata?.characterName || `存档 ${save.slot + 1}`;
}

/** 当前勾选启用了该项目的存档名（与启用面板同一套回读口径） */
function savesEnabling(projectId: string): string[] {
  const options = buildWorkshopEnableOptions(
    workshop.projects,
    worldbooks.books as unknown as WorldBook[],
  );
  return game.saves
    .filter((save) =>
      selectedWorkshopProjectIds(options, save.metadata?.enabledWorldBookEntries ?? []).includes(
        projectId,
      ),
    )
    .map(saveLabel);
}

async function onUninstall(project: WorkshopProject) {
  if (busyId.value) return;
  busyId.value = project.id;
  try {
    // 存档列表可能还没读（或已过时）；读不到时按「没有存档启用」继续，不拦卸载
    try {
      await game.loadSaves();
    } catch {
      /* IndexedDB 不可用时没有存档可列 */
    }
    const enabledIn = savesEnabling(project.id);
    const confirmed = await confirmDialog({
      title: `卸载「${project.name}」？`,
      message:
        enabledIn.length > 0
          ? `将删除它带来的世界书条目和美化规则，无法撤销。以下 ${enabledIn.length} 个存档勾选启用了它，卸载后这些存档里不再有它的内容：`
          : '将删除它带来的世界书条目和美化规则，无法撤销。目前没有存档勾选启用它。',
      details: enabledIn.length > 0 ? enabledIn : undefined,
      confirmLabel: '卸载',
      danger: true,
    });
    if (!confirmed) return;

    let ok = false;
    try {
      ok = await workshop.uninstall(project.id);
    } catch {
      ok = false;
    }
    if (ok) ui.toast(`已卸载「${project.name}」`, 'success');
    else ui.toast(`卸载「${project.name}」失败，请稍后重试`, 'error');
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <div class="installed-list" data-testid="installed-extensions">
    <div class="installed-head">
      <h4>已安装的社区扩展</h4>
      <p>
        <template v-if="WORKSHOP_LOCKED">创意工坊暂未开放，</template
        >这里可以查看已装版本并在本地卸载。卸载会影响所有存档。
      </p>
    </div>

    <ul class="installed-rows">
      <li v-for="row in rows" :key="row.project.id" class="installed-row">
        <div class="installed-main">
          <span class="installed-name">{{ row.project.name }}</span>
          <div class="installed-meta">
            <span>{{ row.project.authorName || '佚名' }}</span>
            <span class="installed-dot" aria-hidden="true">·</span>
            <span>已装 {{ row.version }}</span>
            <template v-if="row.installedAt">
              <span class="installed-dot" aria-hidden="true">·</span>
              <span>装于 {{ row.installedAt }}</span>
            </template>
            <span class="installed-dot" aria-hidden="true">·</span>
            <span>{{ row.entryCount }} 条世界书条目</span>
            <span class="installed-dot" aria-hidden="true">·</span>
            <span>{{ row.ruleCount }} 条美化规则</span>
          </div>
          <p v-if="row.notes" class="installed-notes">{{ row.notes }}</p>
        </div>
        <AppButton
          variant="ghost"
          size="sm"
          :disabled="busyId !== ''"
          :loading="busyId === row.project.id"
          @click="onUninstall(row.project)"
        >
          {{ busyId === row.project.id ? '卸载中…' : '卸载' }}
        </AppButton>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.installed-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
}

.installed-head {
  padding-bottom: var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
}

.installed-head h4 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
}

.installed-head p {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.installed-rows {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.installed-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}

.installed-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}

.installed-name {
  overflow: hidden;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.installed-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs);
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.installed-dot {
  opacity: 0.6;
}

.installed-notes {
  margin: 0;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  line-height: 1.5;
}
</style>
