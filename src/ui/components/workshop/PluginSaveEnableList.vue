<script setup lang="ts">
/**
 * 某个存档的插件启用面（插件设计 §3.4 按存档启用、§6.4）。
 *
 * - 列出本机已装的插件，每个一个按存档的开关。启用 → 短版风险确认弹窗
 *   （PluginRiskConfirmModal variant='save'）→ 确认后才调 `pluginStore.enableForSave`；
 *   停用直接 `disableForSave`（撤销本机确认 + 从启用轴拿掉）。
 * - 「需要重新确认」：存档勾着、本机也装了，但本机确认缺失或作废（导入的存档 / network 变了）。
 * - 「已启用但未安装」：存档勾着、本机没装 —— 数据原样保留，这里只提示。
 * - 每个插件一个「清除此插件在本存档的数据」（save-profile `clearPluginSaveData`，先确认）。
 *
 * 启用 / 停用要求存档已在 `game.saves` 里（plugin-store 的约定），所以挂载时缺就先 `loadSaves()`。
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { PluginRecord } from '@engine/types/types-plugin';
import { clearPluginSaveData } from '@engine/state/save-profile';
import AppButton from '../shared/AppButton.vue';
import PluginRiskConfirmModal from './PluginRiskConfirmModal.vue';
import { useGameStore } from '../../stores/game-store';
import { usePluginStore } from '../../stores/plugin-store';
import { useUIStore } from '../../stores/ui-store';
import { confirmDialog } from '../../lib/confirm-dialog';

const props = defineProps<{ saveId: string }>();

const game = useGameStore();
const plugins = usePluginStore();
const ui = useUIStore();

const loading = ref(false);
const pendingIds = ref<string[]>([]);
/** 正在等短版确认的插件 */
const confirming = ref<PluginRecord | null>(null);

const save = computed(() => game.saves.find((s) => s.id === props.saveId) ?? null);
const enabledIds = computed<string[]>(() => save.value?.metadata?.enabledPluginIds ?? []);
const reconfirmIds = computed(() => new Set(plugins.needsReconfirm(props.saveId).map((r) => r.id)));
const reconfirmList = computed(() => plugins.needsReconfirm(props.saveId));
const missingIds = computed(() => plugins.enabledButNotInstalled(props.saveId));

async function ensureSaveLoaded() {
  if (!props.saveId || game.saves.some((s) => s.id === props.saveId)) return;
  loading.value = true;
  try {
    await game.loadSaves();
  } finally {
    loading.value = false;
  }
}

onMounted(ensureSaveLoaded);
watch(() => props.saveId, ensureSaveLoaded);

function isPending(id: string): boolean {
  return pendingIds.value.includes(id);
}

async function withPending(id: string, task: () => Promise<void>) {
  pendingIds.value = [...pendingIds.value, id];
  try {
    await task();
  } finally {
    pendingIds.value = pendingIds.value.filter((x) => x !== id);
  }
}

function stateOf(record: PluginRecord): { text: string; tone: 'on' | 'warn' | 'off' } {
  if (!enabledIds.value.includes(record.id)) return { text: '未启用', tone: 'off' };
  if (reconfirmIds.value.has(record.id)) return { text: '需要重新确认', tone: 'warn' };
  if (!plugins.isEffectivelyEnabled(props.saveId, record.id)) {
    return { text: '已启用，自检通过前不运行', tone: 'warn' };
  }
  return { text: '已启用', tone: 'on' };
}

function onToggle(record: PluginRecord) {
  if (isPending(record.id) || !save.value) return;
  if (enabledIds.value.includes(record.id) && !reconfirmIds.value.has(record.id)) {
    void withPending(record.id, async () => {
      const result = await plugins.disableForSave(props.saveId, record.id);
      if (!result.ok) ui.toast(`停用失败：${result.message}`, 'error');
    });
    return;
  }
  // 启用与重新确认都必须先过短版风险确认
  confirming.value = record;
}

function onConfirm() {
  const record = confirming.value;
  confirming.value = null;
  if (!record) return;
  void withPending(record.id, async () => {
    const result = await plugins.enableForSave(props.saveId, record.id, { confirmed: true });
    if (!result.ok) ui.toast(`启用失败：${result.message}`, 'error');
  });
}

function onCancel() {
  confirming.value = null;
}

async function clearData(id: string, name: string) {
  if (isPending(id)) return;
  const ok = await confirmDialog({
    title: '清除插件数据',
    message: `清除「${name}」在本存档里保存的全部数据？此操作不可撤销，其他存档不受影响。`,
    confirmLabel: '清除',
    danger: true,
  });
  if (!ok) return;
  await withPending(id, async () => {
    try {
      await clearPluginSaveData(props.saveId, id);
      await game.refreshFromDb(props.saveId);
      ui.toast(`已清除「${name}」在本存档的数据`, 'success');
    } catch (e) {
      ui.toast(`清除失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  });
}
</script>

<template>
  <div class="save-plugins" data-testid="plugin-save-list">
    <div v-if="loading" class="save-plugins-empty">正在读取存档…</div>
    <div v-else-if="!save" class="save-plugins-empty">找不到这个存档。</div>
    <template v-else>
      <div
        v-if="reconfirmList.length > 0"
        class="save-plugins-notice"
        data-tone="warn"
        data-testid="plugin-reconfirm"
      >
        <p>
          以下插件在本存档里是启用的，但本机还没有确认（导入的存档或插件联网域名变了），确认前不会运行：
        </p>
        <ul>
          <li v-for="r in reconfirmList" :key="r.id">
            <span>{{ r.manifest.name }}</span>
            <AppButton
              variant="secondary"
              size="sm"
              :loading="isPending(r.id)"
              :data-reconfirm-id="r.id"
              @click="onToggle(r)"
            >
              重新确认
            </AppButton>
          </li>
        </ul>
      </div>

      <div
        v-if="missingIds.length > 0"
        class="save-plugins-notice"
        data-tone="muted"
        data-testid="plugin-missing"
      >
        <p>本存档启用了以下插件，但本机没有安装。它们的数据原样保留，安装后可继续使用：</p>
        <ul>
          <li v-for="id in missingIds" :key="id">
            <code>{{ id }}</code>
            <AppButton
              variant="ghost"
              size="sm"
              :disabled="isPending(id)"
              :data-clear-id="id"
              @click="clearData(id, id)"
            >
              清除此插件在本存档的数据
            </AppButton>
          </li>
        </ul>
      </div>

      <div v-if="plugins.records.length === 0" class="save-plugins-empty">本机还没有安装插件。</div>
      <ul v-else class="save-plugins-list">
        <li
          v-for="record in plugins.records"
          :key="record.id"
          class="save-plugin-row"
          :data-plugin-id="record.id"
        >
          <button
            type="button"
            role="switch"
            class="save-plugin-switch"
            :aria-checked="enabledIds.includes(record.id) && !reconfirmIds.has(record.id)"
            :aria-label="`在本存档启用插件：${record.manifest.name}`"
            :disabled="isPending(record.id)"
            data-testid="plugin-save-toggle"
            @click="onToggle(record)"
          >
            <span class="save-plugin-knob" aria-hidden="true"></span>
          </button>
          <div class="save-plugin-copy">
            <span class="save-plugin-name">{{ record.manifest.name }}</span>
            <span class="save-plugin-meta">v{{ record.manifest.version }}</span>
            <span class="save-plugin-state" :data-tone="stateOf(record).tone">
              {{ stateOf(record).text }}
            </span>
          </div>
          <AppButton
            variant="ghost"
            size="sm"
            :disabled="isPending(record.id)"
            :data-clear-id="record.id"
            @click="clearData(record.id, record.manifest.name)"
          >
            清除此插件在本存档的数据
          </AppButton>
        </li>
      </ul>
    </template>

    <PluginRiskConfirmModal
      v-if="confirming"
      variant="save"
      :manifest="confirming.manifest"
      @confirm="onConfirm"
      @cancel="onCancel"
    />
  </div>
</template>

<style scoped>
.save-plugins {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

.save-plugins-empty {
  padding: var(--theme-spacing-lg) 0;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  text-align: center;
}

.save-plugins-empty::before {
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  content: '—';
  font-size: 1.25rem;
  opacity: 0.3;
}

.save-plugins-notice {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.6;
}

.save-plugins-notice[data-tone='warn'] {
  border-color: color-mix(in srgb, var(--theme-warning) 35%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-warning) 8%, var(--theme-card-bg));
}

.save-plugins-notice p {
  margin: 0 0 var(--theme-spacing-xs);
}

.save-plugins-notice ul,
.save-plugins-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}

.save-plugins-notice li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}

.save-plugins-notice code {
  color: var(--theme-text-primary);
  font-family: 'Cascadia Code', monospace;
  overflow-wrap: anywhere;
}

.save-plugin-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
}

.save-plugin-switch {
  position: relative;
  width: 40px;
  height: 22px;
  margin: 7px 0;
  padding: 0;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  background: var(--theme-surface-muted);
  cursor: pointer;
  transition:
    background-color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}

.save-plugin-switch[aria-checked='true'] {
  border-color: var(--theme-primary);
  background: var(--theme-primary);
}

.save-plugin-switch:disabled {
  cursor: progress;
  opacity: 0.6;
}

.save-plugin-switch:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--theme-primary) 40%, transparent);
  outline-offset: 2px;
}

.save-plugin-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  transition: transform var(--theme-transition-fast);
}

.save-plugin-switch[aria-checked='true'] .save-plugin-knob {
  transform: translateX(18px);
}

.save-plugin-copy {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--theme-spacing-xs) var(--theme-spacing-sm);
  min-width: 0;
}

.save-plugin-name {
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.save-plugin-meta {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

.save-plugin-state {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.save-plugin-state[data-tone='on'] {
  color: var(--theme-success);
}

.save-plugin-state[data-tone='warn'] {
  color: var(--theme-warning);
}

@media (prefers-reduced-motion: reduce) {
  .save-plugin-switch,
  .save-plugin-knob {
    transition: none;
  }
}

@media (max-width: 640px) {
  .save-plugin-row {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .save-plugin-row > :last-child {
    grid-column: 1 / -1;
    justify-self: start;
  }
}
</style>
