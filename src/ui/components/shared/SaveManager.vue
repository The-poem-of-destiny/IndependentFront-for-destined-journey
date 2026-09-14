<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import type { FullBackup } from '@engine/database';
import type { SessionBackup } from '@engine/session-backup';
import { useGameStore } from '../../stores/game-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useUIStore } from '../../stores/ui-store';
import { buildSessionImportWarnings } from '../../lib/session-import-messages';
import { findLatestSave } from '../home/latest-save';
import AppButton from './AppButton.vue';
import AppModal from './AppModal.vue';

/**
 * 应用级存档管理窗口（2026-09-13）。
 *
 * 它常驻在 App.vue，不属于首页或游戏页。首页与游戏菜单只负责打开同一个 store 状态，
 * 因而从游戏菜单进入时不会先导航到首页，也不会卸载正在游玩的 GamePage。
 */
const game = useGameStore();
const ui = useUIStore();
const cfg = useSettingsStore();

const savesLoaded = ref(false);
const selectedSaveId = ref<string | null>(null);
const selectedSave = computed(
  () => game.saves.find((save) => save.id === selectedSaveId.value) ?? null,
);
const latestSave = computed(() => findLatestSave(game.saves));
const selectedSaveData = ref<any>(null);
const saveManagerIntent = ref<'browse' | 'export' | 'delete' | 'rename'>('browse');
const renamingSaveId = ref<string | null>(null);
const renameDraft = ref('');
const saveManagerHint = computed(() => {
  if (saveManagerIntent.value === 'export') return '请选择一个存档，然后使用右侧的“导出存档”。';
  if (saveManagerIntent.value === 'delete') return '请选择要删除的存档，然后使用右侧的“删除存档”。';
  if (saveManagerIntent.value === 'rename') return '为选中的存档输入新名称并保存。';
  return '选择一个存档查看详情，或继续游戏。';
});

watch(selectedSaveId, async (id) => {
  if (!id) {
    selectedSaveData.value = null;
    return;
  }
  try {
    const { getSave, getCharacters, getSaveProfile } = await import('@engine/database');
    const save = await getSave(id);
    const chars = await getCharacters(id);
    const profile = await getSaveProfile(id);
    const player = chars?.find((candidate: any) => candidate.type === 'player');
    if (player) {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || player.name,
        level: player.level,
        race: player.race,
        location: player.location,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        sp: player.sp,
        maxSp: player.maxSp,
        fp: profile?.fp || 0,
        attributes: player.attributes,
      };
    } else {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || '未知角色',
        level: '?',
        race: '?',
        location: '?',
        hp: 0,
        maxHp: 0,
        mp: 0,
        maxMp: 0,
        sp: 0,
        maxSp: 0,
        fp: profile?.fp || 0,
        attributes: {},
      };
    }
  } catch {
    selectedSaveData.value = {
      characterName: '加载失败',
      level: '?',
      race: '?',
      location: '?',
      hp: 0,
      maxHp: 0,
      mp: 0,
      maxMp: 0,
      sp: 0,
      maxSp: 0,
      fp: 0,
      attributes: {},
    };
  }
});

watch(
  () => ui.saveManagerOpen,
  async (open) => {
    if (!open) return;
    await ensureSavesLoaded();
    saveManagerIntent.value = 'browse';
    cancelRenameSave();
    const activeSave = game.saves.find((save) => save.id === ui.activeSaveId);
    selectedSaveId.value = activeSave?.id ?? selectedSave.value?.id ?? latestSave.value?.id ?? null;
  },
  { immediate: true },
);

async function ensureSavesLoaded() {
  if (savesLoaded.value) return;
  try {
    await game.loadSaves();
  } catch {
    /* IndexedDB 不可用时按无存档处理 */
  } finally {
    savesLoaded.value = true;
  }
}

function close() {
  saveManagerIntent.value = 'browse';
  cancelRenameSave();
  ui.closeSaveManager();
}

function newGame() {
  close();
  ui.navigate('create');
}

function loadGame(saveId: string) {
  close();
  ui.navigate('game', saveId);
}

async function deleteSave(saveId: string) {
  if (!confirm('确定要删除这个存档吗？此操作不可撤销。')) return;
  try {
    const { deleteSaveSlot } = await import('@engine/database');
    await deleteSaveSlot(saveId);
    await game.loadSaves();
    if (selectedSaveId.value === saveId) selectedSaveId.value = game.saves[0]?.id ?? null;
    ui.toast('存档已删除', 'success');
    if (ui.currentView === 'game' && ui.activeSaveId === saveId) {
      close();
      ui.activeSaveId = null;
      ui.navigate('home');
    }
  } catch (err) {
    ui.toast(`删除失败：${errText(err)}`, 'error');
  }
}

function beginRenameSave(saveId: string) {
  const save = game.saves.find((candidate) => candidate.id === saveId);
  if (!save) return;
  selectedSaveId.value = saveId;
  renamingSaveId.value = saveId;
  renameDraft.value = save.name || '';
  saveManagerIntent.value = 'rename';
}

function cancelRenameSave() {
  renamingSaveId.value = null;
  renameDraft.value = '';
}

async function renameSave() {
  const saveId = renamingSaveId.value;
  const name = renameDraft.value.trim();
  if (!saveId) return;
  if (!name) {
    ui.toast('存档名称不能为空', 'warning');
    return;
  }

  const save = game.saves.find((candidate) => candidate.id === saveId);
  if (!save) {
    ui.toast('重命名失败：找不到这个存档', 'error');
    return;
  }

  try {
    const { saveSaveSlot } = await import('@engine/database');
    await saveSaveSlot({ ...save, name });
    await game.loadSaves();
    cancelRenameSave();
    saveManagerIntent.value = 'browse';
    ui.toast('存档已重命名', 'success');
  } catch (err) {
    ui.toast(`重命名失败：${errText(err)}`, 'error');
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, '').trim();
  return cleaned || '未命名存档';
}

async function exportSave(saveId: string) {
  try {
    const { exportSessionSave } = await import('@engine/session-backup');
    const opts: { storyPreset?: { id: string; name: string } } = {};
    const presetId = cfg.settings.activePresetId;
    if (presetId) {
      const { getPresets } = await import('@engine/database');
      const hit = (await getPresets()).find((preset) => preset.id === presetId);
      if (hit) opts.storyPreset = { id: hit.id, name: hit.name };
    }
    const backup = await exportSessionSave(saveId, opts);
    const name = safeFileName(game.saves.find((save) => save.id === saveId)?.name || '未命名存档');
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fated-poem-save-${name}-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    ui.toast('存档已导出', 'success');
  } catch (err) {
    console.error('[session-backup] 导出存档失败:', err);
    ui.toast(`导出失败：${errText(err)}`, 'error');
  }
}

// shallowRef 避免把解析出的备份深代理成 IndexedDB 无法结构化克隆的 Proxy。
const pendingSessionBackup = shallowRef<SessionBackup | null>(null);
const pendingFullBackup = shallowRef<FullBackup | null>(null);
const sessionWarnings = ref<string[]>([]);
const showSessionWarnModal = ref(false);
const showFullBackupModal = ref(false);

async function importSave() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      ui.toast('导入失败：文件不是有效的 JSON', 'error');
      return;
    }
    try {
      const { isSessionBackup, isFullBackupFile } = await import('@engine/session-backup');
      if (isSessionBackup(data)) {
        await beginSessionImport(data);
        return;
      }
      if (isFullBackupFile(data)) {
        pendingFullBackup.value = data as FullBackup;
        showFullBackupModal.value = true;
        return;
      }
      ui.toast('导入失败：无法识别的文件格式', 'error');
    } catch (err) {
      console.error('[session-backup] 导入存档失败:', err);
      ui.toast(`导入失败：${errText(err)}`, 'error');
    }
  };
  input.click();
}

async function beginSessionImport(backup: SessionBackup) {
  try {
    const { checkSessionSaveDependencies } = await import('@engine/session-backup');
    const check = await checkSessionSaveDependencies(backup);
    if (check.ok) {
      await runSessionImport(backup, false);
      return;
    }
    pendingSessionBackup.value = backup;
    sessionWarnings.value = buildSessionImportWarnings(check);
    showSessionWarnModal.value = true;
  } catch (err) {
    console.error('[session-backup] 导入前体检失败:', err);
    ui.toast(`导入失败：${errText(err)}`, 'error');
  }
}

async function runSessionImport(backup: SessionBackup, withWarnings: boolean) {
  try {
    const { importSessionSave } = await import('@engine/session-backup');
    await importSessionSave(backup);
    await game.loadSaves();
    if (withWarnings) ui.toast('存档已导入（部分依赖内容缺失）', 'warning');
    else ui.toast('存档导入成功', 'success');
  } catch (err) {
    console.error('[session-backup] 导入存档失败:', err);
    ui.toast(`导入失败：${errText(err)}`, 'error');
  }
}

async function confirmSessionImport() {
  const backup = pendingSessionBackup.value;
  closeSessionWarnModal();
  if (backup) await runSessionImport(backup, true);
}

function closeSessionWarnModal() {
  showSessionWarnModal.value = false;
  pendingSessionBackup.value = null;
  sessionWarnings.value = [];
}

async function confirmFullBackupImport() {
  const data = pendingFullBackup.value;
  closeFullBackupModal();
  if (!data) return;
  try {
    const { importAllData } = await import('@engine/database');
    await importAllData(data);
    await cfg.reloadApiEntries();
    await game.loadSaves();
    ui.toast('整库备份恢复成功', 'success');
  } catch (err) {
    console.error('[session-backup] 整库备份恢复失败:', err);
    ui.toast(`导入失败：${errText(err)}`, 'error');
  }
}

function closeFullBackupModal() {
  showFullBackupModal.value = false;
  pendingFullBackup.value = null;
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <AppModal
    :open="ui.saveManagerOpen"
    title="存档管理"
    size="xl"
    bare
    @update:open="!$event && close()"
  >
    <section class="save-panel">
      <header class="save-panel-header">
        <div class="save-panel-heading">
          <h2 class="save-panel-title">存档管理</h2>
          <p class="save-panel-hint" role="status">{{ saveManagerHint }}</p>
        </div>
        <div class="save-panel-header-actions">
          <AppButton variant="ghost" size="sm" @click="newGame">新建存档</AppButton>
          <AppButton variant="ghost" size="sm" @click="importSave">导入存档</AppButton>
          <button class="save-panel-close" aria-label="关闭" @click="close">✕</button>
        </div>
      </header>

      <div class="save-panel-body">
        <div class="save-panel-left">
          <div v-if="game.saves.length === 0" class="empty-saves">
            <div class="empty-icon" aria-hidden="true"></div>
            <p class="text-muted">还没有存档</p>
            <AppButton variant="primary" size="sm" @click="newGame">创建第一个存档</AppButton>
          </div>
          <div v-else class="save-list">
            <div
              v-for="save in game.saves"
              :key="save.id"
              class="save-item"
              :class="{ 'save-item-active': selectedSaveId === save.id }"
              @click="selectedSaveId = save.id"
            >
              <button
                type="button"
                class="save-select"
                :aria-pressed="selectedSaveId === save.id"
                :aria-label="`选择存档：${save.name || '未命名存档'}`"
                @click.stop="selectedSaveId = save.id"
              >
                <span class="save-avatar">{{ (save.metadata?.characterName || '?')[0] }}</span>
                <span class="save-info">
                  <span class="save-name">{{ save.name || '未命名存档' }}</span>
                  <span class="save-meta text-muted">
                    {{ save.metadata?.characterName || '未知角色' }} · 第
                    {{ save.metadata?.totalTurns ?? 0 }} 回合
                  </span>
                  <span class="save-meta text-muted text-xs">{{ formatTime(save.updatedAt) }}</span>
                </span>
              </button>
              <div class="save-row-actions">
                <button
                  class="save-row-action"
                  :aria-label="`重命名存档：${save.name || '未命名存档'}`"
                  title="重命名存档"
                  @click.stop="beginRenameSave(save.id)"
                >
                  <i class="fa-solid fa-pen" aria-hidden="true"></i>
                </button>
                <button
                  class="save-row-action"
                  :aria-label="`导出存档：${save.name || '未命名存档'}`"
                  title="导出这个存档为可分享的 JSON 文件"
                  @click.stop="exportSave(save.id)"
                >
                  <i class="fa-solid fa-download" aria-hidden="true"></i>
                </button>
                <button
                  class="save-row-action save-row-action-danger"
                  :aria-label="`删除存档：${save.name || '未命名存档'}`"
                  title="删除存档"
                  @click.stop="deleteSave(save.id)"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="save-panel-right">
          <template v-if="selectedSave && selectedSaveData">
            <div class="save-preview-header">
              <div class="preview-avatar">{{ (selectedSaveData.characterName || '?')[0] }}</div>
              <div class="preview-info">
                <h3>{{ selectedSaveData.characterName || selectedSave.name }}</h3>
                <p class="text-muted text-sm">
                  Lv.{{ selectedSaveData.level || '?' }} ·
                  {{ selectedSaveData.race || '未知种族' }}
                </p>
                <p class="text-muted text-xs">{{ selectedSaveData.location || '未知地点' }}</p>
              </div>
            </div>
            <div class="save-preview-stats">
              <div class="preview-stat">
                <span class="stat-label hp-label">HP</span>
                <span class="stat-value"
                  >{{ selectedSaveData.hp }}/{{ selectedSaveData.maxHp }}</span
                >
              </div>
              <div class="preview-stat">
                <span class="stat-label mp-label">MP</span>
                <span class="stat-value"
                  >{{ selectedSaveData.mp }}/{{ selectedSaveData.maxMp }}</span
                >
              </div>
              <div class="preview-stat">
                <span class="stat-label sp-label">SP</span>
                <span class="stat-value"
                  >{{ selectedSaveData.sp }}/{{ selectedSaveData.maxSp }}</span
                >
              </div>
              <div class="preview-stat">
                <span class="stat-label fp-label">FP</span>
                <span class="stat-value">{{ selectedSaveData.fp || 0 }}</span>
              </div>
            </div>
            <div
              v-if="Object.keys(selectedSaveData.attributes || {}).length"
              class="save-preview-attrs"
            >
              <span
                v-for="(value, key) in selectedSaveData.attributes"
                :key="key"
                class="preview-attr"
              >
                <span class="attr-label">{{
                  { str: '力', dex: '敏', con: '体', int: '智', spi: '精' }[key] || key
                }}</span>
                <strong class="attr-value">{{ value }}</strong>
              </span>
            </div>
            <form
              v-if="renamingSaveId === selectedSave.id"
              class="save-rename-form"
              @submit.prevent="renameSave"
            >
              <label for="save-rename-input">存档名称</label>
              <div class="save-rename-controls">
                <input
                  id="save-rename-input"
                  v-model="renameDraft"
                  class="save-rename-input"
                  maxlength="40"
                  autocomplete="off"
                  autofocus
                />
                <AppButton variant="primary" size="sm" type="submit">保存名称</AppButton>
                <AppButton variant="ghost" size="sm" type="button" @click="cancelRenameSave">
                  取消
                </AppButton>
              </div>
            </form>
            <div v-else class="save-preview-actions">
              <AppButton variant="primary" size="md" @click="loadGame(selectedSave.id)">
                进入游戏
              </AppButton>
              <AppButton variant="ghost" size="md" @click="beginRenameSave(selectedSave.id)">
                重命名存档
              </AppButton>
              <AppButton variant="ghost" size="md" @click="exportSave(selectedSave.id)">
                导出存档
              </AppButton>
              <AppButton variant="danger" size="md" @click="deleteSave(selectedSave.id)">
                删除存档
              </AppButton>
            </div>
          </template>
          <div v-else class="save-preview-empty">
            <div class="empty-icon" aria-hidden="true"></div>
            <p class="text-muted">选择一个存档查看详情</p>
          </div>
        </div>
      </div>
    </section>
  </AppModal>

  <AppModal
    :open="showSessionWarnModal"
    title="导入前请确认"
    size="md"
    @update:open="!$event && closeSessionWarnModal()"
  >
    <p>这份存档依赖的部分内容在本机缺失或版本不同：</p>
    <ul class="import-warn-list">
      <li v-for="(line, index) in sessionWarnings" :key="index">{{ line }}</li>
    </ul>
    <p class="text-muted text-sm">
      缺失内容<strong>不影响导入本身</strong>，但相关世界书条目在游玩时不会注入。
    </p>
    <template #footer>
      <AppButton variant="ghost" size="sm" @click="closeSessionWarnModal">取消</AppButton>
      <AppButton variant="primary" size="sm" @click="confirmSessionImport">仍要导入</AppButton>
    </template>
  </AppModal>

  <AppModal
    :open="showFullBackupModal"
    title="整库备份恢复"
    size="sm"
    @update:open="!$event && closeFullBackupModal()"
  >
    <p>
      这个文件是一份<strong>整库备份</strong>，不是单个存档。导入会用它<strong
        style="color: var(--theme-error)"
        >替换备份范围内的现有数据</strong
      >。
    </p>
    <p class="text-muted text-sm">
      包括所有存档、角色、记忆、剧情与世界书等。API 端点与 API 密钥不会从备份恢复，本机已保存的 API
      凭据不会被覆盖；换到新设备后需要重新配置 API。备份范围内的现有数据将被覆盖，此操作不可撤销。
    </p>
    <template #footer>
      <AppButton variant="ghost" size="sm" @click="closeFullBackupModal">取消</AppButton>
      <AppButton variant="danger" size="sm" @click="confirmFullBackupImport">
        替换备份数据并导入
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.save-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: min(600px, 80vh);
  overflow: hidden;
  background: var(--theme-window-bg);
  border-radius: inherit;
}
.save-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
}
.save-panel-heading {
  min-width: 0;
}
.save-panel-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.2rem;
  color: var(--theme-text-primary);
  letter-spacing: 1px;
}
.save-panel-hint {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--theme-text-muted);
}
.save-panel-header-actions {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.save-panel-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 1.1rem;
  color: var(--theme-text-muted);
  cursor: pointer;
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  transition:
    color var(--theme-transition-fast),
    background var(--theme-transition-fast);
}
.save-panel-close:hover,
.save-panel-close:focus-visible {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}
.save-panel-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.save-panel-left {
  width: 300px;
  flex-shrink: 0;
  padding: var(--theme-spacing-lg) var(--theme-spacing-md);
  overflow-y: auto;
  border-right: 1px solid var(--theme-card-border);
}
.save-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.save-item {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-md);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.save-item:hover {
  background: var(--theme-tab-hover-bg);
  border-color: var(--theme-card-border);
}
.save-item-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: var(--theme-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 20%, transparent);
}
.save-select {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  min-width: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.save-select:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 3px;
}
.save-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  font-family: var(--theme-font-title);
  font-size: 14px;
  font-weight: 700;
  color: var(--theme-primary-text, var(--theme-primary));
  background: var(--theme-primary-bg, color-mix(in srgb, var(--theme-primary) 20%, transparent));
  border-radius: 50%;
}
.save-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.save-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.save-meta {
  font-size: 0.72rem;
}
.save-row-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--theme-transition-fast);
}
.save-item:hover .save-row-actions,
.save-item:focus-within .save-row-actions {
  opacity: 1;
}
.save-row-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 0.78rem;
  color: var(--theme-text-muted);
  cursor: pointer;
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  transition:
    color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.save-row-action:hover,
.save-row-action:focus-visible {
  color: var(--theme-text-primary);
  background-color: var(--theme-tab-hover-bg);
  outline: none;
}
.save-row-action-danger:hover,
.save-row-action-danger:focus-visible {
  color: var(--theme-error);
  background-color: color-mix(in srgb, var(--theme-error) 10%, transparent);
}
.save-panel-right {
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: var(--theme-spacing-xl) var(--theme-spacing-2xl);
  overflow-y: auto;
}
.save-preview-header {
  display: flex;
  gap: var(--theme-spacing-lg);
  align-items: center;
  margin-bottom: var(--theme-spacing-xl);
}
.preview-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  font-family: var(--theme-font-title);
  font-size: 22px;
  font-weight: 700;
  color: var(--theme-text-primary);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--theme-primary) 40%, transparent),
    color-mix(in srgb, var(--theme-quality-epic) 40%, transparent)
  );
  border-radius: 50%;
  box-shadow: 0 0 20px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}
.preview-info h3 {
  margin: 0 0 var(--theme-spacing-xs);
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  color: var(--theme-text-primary);
}
.save-preview-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xl);
}
.preview-stat {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  align-items: center;
  padding: var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
.stat-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 1px;
}
.hp-label {
  color: var(--theme-hp);
}
.mp-label {
  color: var(--theme-mp);
}
.sp-label {
  color: var(--theme-sp);
}
.fp-label {
  color: var(--theme-quality-epic);
}
.stat-value {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.save-preview-attrs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xl);
}
.preview-attr {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border-radius: var(--theme-radius-md);
}
.attr-label {
  font-size: 0.68rem;
  color: var(--theme-text-muted);
}
.attr-value {
  font-size: 1.1rem;
  color: var(--theme-text-primary);
}
.save-preview-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  align-items: center;
  margin-top: auto;
}
.save-rename-form {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-top: auto;
  padding: var(--theme-spacing-lg);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.save-rename-form label {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
.save-rename-controls {
  display: flex;
  gap: var(--theme-spacing-sm);
  align-items: center;
}
.save-rename-input {
  min-width: 0;
  min-height: 36px;
  flex: 1;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font: inherit;
  color: var(--theme-text-primary);
  background-color: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.save-rename-input:focus-visible {
  border-color: var(--theme-primary);
  outline: 2px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  outline-offset: 1px;
}
.save-preview-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  align-items: center;
  justify-content: center;
  color: var(--theme-text-muted);
}
.empty-saves {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  align-items: center;
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
}
.empty-icon {
  font-size: 2rem;
  opacity: 0.4;
}
.import-warn-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: var(--theme-spacing-sm) 0 var(--theme-spacing-md);
  padding-left: 1.2em;
  font-size: 0.875rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}

@media (max-width: 700px) {
  .save-panel {
    height: min(86vh, 680px);
  }
  .save-panel-header {
    align-items: flex-start;
    padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  }
  .save-panel-header-actions {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .save-panel-body {
    flex-direction: column;
  }
  .save-panel-left {
    width: 100%;
    max-height: 42%;
    border-right: none;
    border-bottom: 1px solid var(--theme-card-border);
  }
  .save-panel-right {
    padding: var(--theme-spacing-lg);
  }
  .save-preview-stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .save-row-actions {
    opacity: 1;
  }
  .save-rename-controls {
    flex-wrap: wrap;
  }
  .save-rename-input {
    flex-basis: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .save-item,
  .save-row-actions,
  .save-row-action,
  .save-panel-close {
    transition: none;
  }
}
</style>
