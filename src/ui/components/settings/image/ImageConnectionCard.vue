<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import AppCard from '../../shared/AppCard.vue';
import { useApiSourceStore } from '../../../stores/api-source-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import { NAI_IMAGE_API_BASE } from '../../../lib/image-client';

const apiSources = useApiSourceStore();
const settings = useSettingsStore().settings;
const ui = useUIStore();
const editingId = ref<string | null>(null);
const draft = reactive({ name: '', apiKey: '' });

const novelaiConnections = computed(() =>
  apiSources.imageConnections.filter((connection) => connection.provider === 'novelai'),
);

onMounted(() => void apiSources.initialize());

function edit(id?: string) {
  const current = novelaiConnections.value.find((connection) => connection.id === id);
  editingId.value = current?.id ?? null;
  draft.name = current?.name ?? '';
  draft.apiKey = current?.apiKey ?? '';
}

async function save() {
  if (!draft.name.trim() || !draft.apiKey.trim()) {
    ui.toast('连接名称和 API Key 都不能为空', 'warning');
    return;
  }
  const current = novelaiConnections.value.find((connection) => connection.id === editingId.value);
  const saved = await apiSources.saveImageConnection({
    id: current?.id ?? crypto.randomUUID(),
    name: draft.name.trim(),
    provider: 'novelai',
    baseUrl: NAI_IMAGE_API_BASE,
    apiKey: draft.apiKey.trim(),
    timeoutMs: current?.timeoutMs ?? 120_000,
    revision: current?.revision,
  });
  if (!settings.imageNovelai.endpointId) settings.imageNovelai.endpointId = saved.id;
  edit();
  ui.toast('NovelAI 连接已保存', 'success');
}

async function remove(id: string) {
  await apiSources.removeImageConnection(id);
  if (settings.imageNovelai.endpointId === id) settings.imageNovelai.endpointId = null;
  ui.toast('图像连接已删除', 'info');
}
</script>

<template>
  <AppCard padding="md">
    <div class="connection-head">
      <div>
        <h4>API 接口设置</h4>
        <p class="form-hint">
          实际出图连接独立保存在本机，不会出现在 Agent 的 LLM 源列表或普通备份中。
        </p>
      </div>
      <AppButton variant="secondary" size="sm" @click="edit()">新增 NovelAI</AppButton>
    </div>

    <label class="form-label">
      当前 NovelAI 连接
      <select v-model="settings.imageNovelai.endpointId" class="form-input">
        <option :value="null">（未选择）</option>
        <option
          v-for="connection in novelaiConnections"
          :key="connection.id"
          :value="connection.id"
        >
          {{ connection.name }}
        </option>
      </select>
    </label>

    <div v-if="novelaiConnections.length" class="connection-list">
      <div v-for="connection in novelaiConnections" :key="connection.id" class="connection-row">
        <div>
          <strong>{{ connection.name }}</strong>
          <span>{{ connection.baseUrl }}</span>
        </div>
        <div class="connection-actions">
          <AppButton variant="ghost" size="sm" @click="edit(connection.id)">编辑</AppButton>
          <AppButton variant="ghost" size="sm" @click="remove(connection.id)">删除</AppButton>
        </div>
      </div>
    </div>

    <div class="connection-editor">
      <label class="form-label">连接名称<input v-model="draft.name" class="form-input" /></label>
      <label class="form-label"
        >API Key<input v-model="draft.apiKey" class="form-input" type="password"
      /></label>
      <AppButton variant="primary" size="sm" @click="save">{{
        editingId ? '保存修改' : '添加连接'
      }}</AppButton>
      <p class="form-hint">
        NovelAI 没有无费用的连通性测试；保存不会生成图片，密钥会在首次手动出图时验证。
      </p>
    </div>

    <label class="form-label comfy-address">
      ComfyUI 本地地址
      <input v-model="settings.imageComfy.baseUrl" class="form-input" spellcheck="false" />
      <span class="form-hint">本地连接不需要 API Key；工作流与超时仍在下方出图参数中设置。</span>
    </label>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.connection-head,
.connection-row,
.connection-actions {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.connection-head,
.connection-row {
  justify-content: space-between;
}
.connection-head h4 {
  margin: 0;
  font-family: var(--theme-font-title);
}
.connection-list,
.connection-editor {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-md);
}
.connection-row {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}
.connection-row > div:first-child {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}
.connection-row span {
  overflow: hidden;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.comfy-address {
  margin-top: var(--theme-spacing-lg);
}
@media (max-width: 520px) {
  .connection-head,
  .connection-row {
    align-items: stretch;
    flex-direction: column;
  }
  .connection-actions {
    justify-content: flex-end;
  }
}
</style>
