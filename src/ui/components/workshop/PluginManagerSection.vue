<script setup lang="ts">
/**
 * 插件管理（插件设计 §3.3 发现与安装、§3.4 风险确认、§4.8 启动自检、§6.4）——
 * 扩展管理页「插件」一节的全部内容。
 *
 * - 本地插件文件夹：路径 / 是否存在 / 被 BFF 关掉时的原因（`enabled:false`）。
 * - 插件列表：`pluginStore.entries`（名称、版本、作者、状态、错误、联网域名、能力摘要）。
 *   安装 / 更新一律先弹完整版 PluginRiskConfirmModal，🔴 **只在玩家点了确认后**才调
 *   `pluginStore.install(id, { confirmed: true })`；本组件没有别的安装路径。
 *   `networkAdded` 只在计划动作是 `update` 时传（有值即被弹窗读成「更新」）。
 * - 卸载先过应用内确认（各存档里的插件数据保留，§6.4）。
 * - 启动自检面板（PluginSelfCheckPanel）；打开管理页本身就是「首次需要」（决策 9）。
 * - 按存档启用：存档选择器 + PluginSaveEnableList（与社区扩展的启用面同一种版式）。
 * - 开发者区（仅开发者模式）：「跟随文件夹自动重载」开关（`settings.pluginDevAutoReload`）。
 */
import { computed, onMounted, ref } from 'vue';
import type { PluginManifest } from '@engine/types/types-plugin';
import AppButton from '../shared/AppButton.vue';
import PluginRiskConfirmModal from './PluginRiskConfirmModal.vue';
import PluginSelfCheckPanel from './PluginSelfCheckPanel.vue';
import PluginSaveEnableList from './PluginSaveEnableList.vue';
import { usePluginStore, type PluginEntryView } from '../../stores/plugin-store';
import { useGameStore } from '../../stores/game-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { confirmDialog } from '../../lib/confirm-dialog';
import { buildPluginRiskContent, formatPluginBytes } from '../../lib/plugin-risk-messages';

const plugins = usePluginStore();
const game = useGameStore();
const settings = useSettingsStore();
const ui = useUIStore();

const scanning = ref(false);
const scanError = ref('');
/** 正在等完整版风险确认的条目 */
const confirming = ref<PluginEntryView | null>(null);

const STATUS_LABELS: Record<PluginEntryView['status'], string> = {
  'not-installed': '未安装',
  'up-to-date': '已是最新',
  'update-available': '有更新',
  invalid: '无效',
  incompatible: '不兼容',
  'missing-source': '文件夹中已移除',
};

const listing = computed(() => plugins.listing);
const selfCheckFailed = computed(
  () => plugins.selfCheck !== null && plugins.selfCheck !== 'running' && !plugins.selfCheck.ok,
);

/** 列表里展示用的 manifest：本地版本优先，没有就用已装版本 */
function manifestOf(entry: PluginEntryView): PluginManifest | null {
  return entry.plan?.manifest ?? entry.record?.manifest ?? null;
}

function nameOf(entry: PluginEntryView): string {
  return manifestOf(entry)?.name ?? entry.id;
}

function capabilitiesOf(entry: PluginEntryView): string[] {
  const manifest = manifestOf(entry);
  return manifest ? buildPluginRiskContent('install', manifest).capabilitySummary : [];
}

/** 第一个带图标的贡献点的图标（宿主重编码过的 PNG data URL） */
function iconOf(entry: PluginEntryView): string | null {
  const manifest = entry.record?.manifest;
  if (!manifest) return null;
  for (const c of manifest.contributions) {
    const url = plugins.iconFor(entry.id, c.id);
    if (url) return url;
  }
  return null;
}

function canInstall(entry: PluginEntryView): boolean {
  return (
    (entry.status === 'not-installed' || entry.status === 'update-available') &&
    entry.plan?.status === 'ok' &&
    entry.plan.manifest !== null
  );
}

async function rescan() {
  if (scanning.value) return;
  scanning.value = true;
  scanError.value = '';
  try {
    // 开关在这里读了再交给 plugin-store：插件模块不许 import settings-store（§4.5）。
    // 自动重载是开发者功能：开发者模式关着时，即便设置里残留着开关也一律不生效
    await plugins.refresh({
      devAutoReload:
        settings.settings.pluginDevAutoReload === true && settings.settings.developerMode === true,
    });
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e);
  } finally {
    scanning.value = false;
  }
}

function askInstall(entry: PluginEntryView) {
  if (!canInstall(entry) || plugins.isBusy(entry.id)) return;
  confirming.value = entry;
}

const modalProps = computed(() => {
  const plan = confirming.value?.plan;
  if (!plan?.manifest) return null;
  return {
    manifest: plan.manifest,
    networkAdded: plan.action === 'update' ? plan.networkAdded : undefined,
    source: plan.source,
    fileCount: plan.fileCount,
    totalBytes: plan.totalBytes,
  };
});

async function onConfirmInstall() {
  const entry = confirming.value;
  confirming.value = null;
  if (!entry) return;
  const isUpdate = entry.status === 'update-available';
  const result = await plugins.install(entry.id, { confirmed: true });
  if (result.ok) ui.toast(`已${isUpdate ? '更新' : '安装'}插件「${nameOf(entry)}」`, 'success');
  else ui.toast(`${isUpdate ? '更新' : '安装'}失败：${result.message}`, 'error');
}

function onCancelInstall() {
  confirming.value = null;
}

async function uninstall(entry: PluginEntryView) {
  if (!entry.record || plugins.isBusy(entry.id)) return;
  const ok = await confirmDialog({
    title: '卸载插件',
    message: `卸载「${nameOf(entry)}」？插件文件与它的全局数据会被删除；各存档里它保存的数据保留，重装后可继续使用。`,
    confirmLabel: '卸载',
    danger: true,
  });
  if (!ok) return;
  const result = await plugins.uninstall(entry.id);
  if (result.ok) ui.toast(`已卸载插件「${nameOf(entry)}」`, 'success');
  else ui.toast(`卸载失败：${result.message}`, 'error');
}

// ─── 开发者区 ───

const devAutoReload = computed({
  get: () => settings.settings.pluginDevAutoReload === true,
  set: (v: boolean) => {
    settings.settings.pluginDevAutoReload = v;
  },
});

// ─── 按存档启用 ───

const selectedSaveId = ref('');
const savesByRecent = computed(() => [...game.saves].sort((a, b) => b.updatedAt - a.updatedAt));

function chooseDefaultSave() {
  if (selectedSaveId.value && game.saves.some((s) => s.id === selectedSaveId.value)) return;
  selectedSaveId.value =
    game.activeSaveId && game.saves.some((s) => s.id === game.activeSaveId)
      ? game.activeSaveId
      : (savesByRecent.value[0]?.id ?? '');
}

async function loadSaves() {
  try {
    await game.loadSaves();
  } catch {
    /* 存档读不到时存档选择器显示空态，不拦插件管理本身 */
  }
  chooseDefaultSave();
}

onMounted(() => {
  void rescan();
  // 打开管理页就是「首次需要」（决策 9）：没装插件也要让玩家看到这台机器过不过得了自检
  void plugins.ensureSelfCheck();
  void loadSaves();
});
</script>

<template>
  <div class="plugin-manager" data-testid="plugin-manager">
    <div class="plugin-manager-head">
      <div>
        <h4>插件</h4>
        <p>第三方插件在隔离的窗口里运行，安装与按存档启用都要先确认风险。</p>
      </div>
      <AppButton
        variant="secondary"
        size="sm"
        :loading="scanning"
        data-testid="plugin-rescan"
        @click="rescan"
      >
        重新扫描
      </AppButton>
    </div>

    <div class="plugin-folder" data-testid="plugin-folder">
      <template v-if="listing && listing.enabled">
        <span class="plugin-folder-label">本地插件文件夹</span>
        <code class="plugin-folder-path">{{ listing.dir }}</code>
        <span v-if="!listing.dirExists" class="plugin-folder-hint">
          文件夹尚不存在。创建它并放入插件后点「重新扫描」。
        </span>
      </template>
      <template v-else-if="listing && !listing.enabled">
        <span class="plugin-folder-label">本地插件文件夹不可用</span>
        <span class="plugin-folder-error" role="alert">{{ listing.message }}</span>
        <code class="plugin-folder-reason">{{ listing.reason }}</code>
      </template>
      <span v-else-if="plugins.listingError" class="plugin-folder-error" role="alert">
        读取本地插件文件夹失败：{{ plugins.listingError }}
      </span>
      <span v-else class="plugin-folder-hint">正在读取本地插件文件夹…</span>
    </div>

    <p v-if="scanError" class="plugin-error" role="alert">重新扫描失败：{{ scanError }}</p>

    <PluginSelfCheckPanel />

    <p v-if="selfCheckFailed" class="plugin-error" data-testid="plugin-disabled-notice">
      启动自检未通过，所有插件暂不运行；可以照常安装与配置，修好后点「重新检查」。
    </p>

    <div v-if="plugins.entries.length === 0" class="plugin-empty">
      还没有发现插件。把插件文件夹放进上面的本地插件文件夹后点「重新扫描」。
    </div>
    <ul v-else class="plugin-list">
      <li
        v-for="entry in plugins.entries"
        :key="entry.id"
        class="plugin-card"
        :data-plugin-id="entry.id"
        :aria-busy="plugins.isBusy(entry.id) || undefined"
      >
        <div class="plugin-icon" aria-hidden="true">
          <img v-if="iconOf(entry)" :src="iconOf(entry)!" alt="" />
          <i v-else class="fa-solid fa-puzzle-piece"></i>
        </div>
        <div class="plugin-copy">
          <div class="plugin-name-row">
            <h5>{{ nameOf(entry) }}</h5>
            <span class="plugin-badge" :data-status="entry.status" data-testid="plugin-status">
              {{ STATUS_LABELS[entry.status] }}
            </span>
            <span v-if="plugins.isBusy(entry.id)" class="plugin-busy">处理中…</span>
          </div>
          <p class="plugin-meta">
            <span v-if="manifestOf(entry)">v{{ manifestOf(entry)!.version }}</span>
            <span
              v-if="
                entry.status === 'update-available' &&
                entry.record &&
                entry.plan?.manifest &&
                entry.record.manifest.version !== entry.plan.manifest.version
              "
            >
              （已装 v{{ entry.record.manifest.version }}）
            </span>
            <span>作者：{{ manifestOf(entry)?.author?.trim() || '未署名' }}</span>
            <span v-if="entry.plan">
              {{ entry.plan.fileCount }} 个文件 · {{ formatPluginBytes(entry.plan.totalBytes) }}
            </span>
            <code class="plugin-id">{{ entry.id }}</code>
          </p>
          <p v-if="manifestOf(entry)?.description" class="plugin-desc">
            {{ manifestOf(entry)!.description }}
          </p>
          <ul v-if="entry.errors.length > 0" class="plugin-errors" role="alert">
            <li v-for="(err, i) in entry.errors" :key="i">{{ err }}</li>
          </ul>
          <dl v-if="manifestOf(entry)" class="plugin-facts">
            <div>
              <dt>联网</dt>
              <dd>
                <template v-if="manifestOf(entry)!.network.length > 0">
                  {{ manifestOf(entry)!.network.join('、') }}
                </template>
                <template v-else>未声明联网域名</template>
              </dd>
            </div>
            <div>
              <dt>能力</dt>
              <dd>{{ capabilitiesOf(entry).join('；') }}</dd>
            </div>
          </dl>
        </div>
        <div class="plugin-actions">
          <AppButton
            v-if="canInstall(entry)"
            variant="primary"
            size="sm"
            :loading="plugins.isBusy(entry.id)"
            data-testid="plugin-install"
            @click="askInstall(entry)"
          >
            {{ entry.status === 'update-available' ? '更新' : '安装' }}
          </AppButton>
          <AppButton
            v-if="entry.record"
            variant="ghost"
            size="sm"
            :disabled="plugins.isBusy(entry.id)"
            data-testid="plugin-uninstall"
            @click="uninstall(entry)"
          >
            卸载
          </AppButton>
        </div>
      </li>
    </ul>

    <div v-if="settings.settings.developerMode" class="plugin-dev" data-testid="plugin-dev">
      <label class="plugin-dev-toggle">
        <input v-model="devAutoReload" type="checkbox" data-testid="plugin-dev-autoreload" />
        <span>跟随文件夹自动重载（开发者）</span>
      </label>
      <p>开启后，重新扫描时本地文件夹里的插件更新会直接装上；联网域名变了的更新仍要确认。</p>
    </div>

    <div class="plugin-saves">
      <div class="plugin-saves-head">
        <div>
          <h5>按存档启用</h5>
          <p>启用状态按存档分别保存，不影响其他存档。</p>
        </div>
        <label v-if="savesByRecent.length > 0" class="save-picker">
          <span>配置存档</span>
          <select v-model="selectedSaveId" aria-label="插件配置存档">
            <option v-for="save in savesByRecent" :key="save.id" :value="save.id">
              {{ save.name || save.metadata.characterName || `存档 ${save.slot + 1}` }}
            </option>
          </select>
        </label>
      </div>
      <div v-if="savesByRecent.length === 0" class="plugin-empty">
        尚无可配置的存档，创建存档后即可为它启用插件。
      </div>
      <PluginSaveEnableList v-else-if="selectedSaveId" :save-id="selectedSaveId" />
    </div>

    <PluginRiskConfirmModal
      v-if="confirming && modalProps"
      variant="install"
      :manifest="modalProps.manifest"
      :network-added="modalProps.networkAdded"
      :source="modalProps.source"
      :file-count="modalProps.fileCount"
      :total-bytes="modalProps.totalBytes"
      @confirm="onConfirmInstall"
      @cancel="onCancelInstall"
    />
  </div>
</template>

<style scoped>
.plugin-manager {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
}

.plugin-manager-head,
.plugin-saves-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
}

.plugin-manager-head {
  padding-bottom: var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
}

.plugin-manager-head h4,
.plugin-saves-head h5 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
}

.plugin-saves-head h5 {
  font-size: 0.875rem;
}

.plugin-manager-head p,
.plugin-saves-head p {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}

.plugin-folder {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--theme-spacing-xs) var(--theme-spacing-sm);
  font-size: 0.75rem;
  line-height: 1.6;
}

.plugin-folder-label {
  color: var(--theme-text-secondary);
  font-weight: 600;
}

.plugin-folder-path,
.plugin-folder-reason,
.plugin-id {
  color: var(--theme-text-primary);
  font-family: 'Cascadia Code', monospace;
  overflow-wrap: anywhere;
}

.plugin-folder-reason,
.plugin-id {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

.plugin-folder-hint {
  color: var(--theme-text-muted);
}

.plugin-folder-error,
.plugin-error {
  color: var(--theme-error);
}

.plugin-error {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
}

.plugin-empty {
  padding: var(--theme-spacing-lg) 0;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  text-align: center;
}

.plugin-empty::before {
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  content: '—';
  font-size: 1.25rem;
  opacity: 0.3;
}

.plugin-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  box-shadow:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
}

.plugin-icon {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
}

.plugin-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.plugin-copy {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}

.plugin-name-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-sm);
}

.plugin-name-row h5 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
}

.plugin-badge {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-text-muted) 30%, transparent);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-text-muted) 10%, transparent);
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  font-weight: 600;
}

.plugin-badge[data-status='up-to-date'] {
  border-color: color-mix(in srgb, var(--theme-success) 30%, transparent);
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
}

.plugin-badge[data-status='update-available'] {
  border-color: color-mix(in srgb, var(--theme-primary) 30%, transparent);
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  color: var(--theme-primary);
}

.plugin-badge[data-status='invalid'],
.plugin-badge[data-status='incompatible'] {
  border-color: color-mix(in srgb, var(--theme-error) 30%, transparent);
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
}

.plugin-badge[data-status='missing-source'] {
  border-color: color-mix(in srgb, var(--theme-warning) 30%, transparent);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
}

.plugin-busy {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.plugin-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs) var(--theme-spacing-md);
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.plugin-desc {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.plugin-errors {
  margin: 0;
  padding-left: var(--theme-spacing-lg);
  color: var(--theme-error);
  font-size: 0.75rem;
  line-height: 1.6;
}

.plugin-facts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
}

.plugin-facts div {
  display: flex;
  gap: var(--theme-spacing-sm);
}

.plugin-facts dt {
  flex-shrink: 0;
  color: var(--theme-text-muted);
}

.plugin-facts dd {
  margin: 0;
  color: var(--theme-text-secondary);
  overflow-wrap: anywhere;
}

.plugin-actions {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--theme-spacing-xs);
}

.plugin-dev {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}

.plugin-dev p {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  line-height: 1.6;
}

.plugin-dev-toggle {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  color: var(--theme-text-primary);
  cursor: pointer;
}

.plugin-dev-toggle input {
  margin: 0;
  accent-color: var(--theme-primary);
}

.plugin-saves {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
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

@media (max-width: 640px) {
  .plugin-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .plugin-actions {
    grid-column: 1 / -1;
    flex-direction: row;
  }

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
