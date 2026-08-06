<script setup lang="ts">
/**
 * 提示词更新中心（Agent 分区空态区）。
 *
 * 🔴 解决的问题：`loadAgentProjectDefaults()` 每次开应用都拉**最新**的
 *    `data/defaults/agent-config.json`，但 `fillMissingAgentSettings` 只填**空位**——
 *    用户只要存过提示词（哪怕是上一版默认），新默认永远进不来，而且用户完全不知道。
 *    本组件扫一遍非 story Agent，把「用户提示词 ≠ 当前默认」的那些列出来，给一个
 *    一键「恢复成最新」。检测是简单字符串对比——既覆盖"默认更新了"、也覆盖"你改过"，
 *    由用户自己决定要不要同步。
 *
 * story 不进本中心：它的提示词是预设（`prompts[]`），走 PresetManager 那条分叉，
 *    同步机制完全不同（预设是结构化数组，不是单串）。
 *
 * 「恢复成最新」与 AgentConfigPanel 里的同名按钮**同一套逻辑**（都调
 *    `applyProjectDefaultToAgent`）：只拉提示词/模板/世界书/旋钮，**保留 model**
 *    （用户自己选的 API 和模型不该被默认值覆盖）。
 */
import { computed } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import { useSettingsStore } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import { applyProjectDefaultToAgent, getAgentSettings } from '../../../stores/agent-settings';
import { AGENT_LIST, agentDisplayName } from './agent-list';

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();

interface OutdatedAgent {
  id: string;
  name: string;
}

/**
 * 列出提示词与当前默认不同的**非 story** Agent。
 *
 * `projectAgentDefaults` 是异步加载（app 启动时 fetch），加载完会 reactively
 * 触发本 computed 重算。没有项目默认条目的 agent 跳过（没有"最新"可同步）。
 */
const outdatedAgents = computed<OutdatedAgent[]>(() => {
  const defaults = cfg.projectAgentDefaults?.agents;
  if (!defaults) return [];
  const out: OutdatedAgent[] = [];
  for (const entry of AGENT_LIST) {
    if (entry.id === 'story') continue;
    const pd = defaults[entry.id];
    if (!pd) continue;
    const userPrompt = getAgentSettings(s, entry.id).systemPrompt;
    if (userPrompt !== (pd.systemPrompt ?? '')) {
      out.push({ id: entry.id, name: entry.name });
    }
  }
  return out;
});

function restoreOne(id: string) {
  const pd = cfg.projectAgentDefaults?.agents?.[id];
  if (!pd) return;
  applyProjectDefaultToAgent(s, id, pd);
}

function restoreOneWithToast(id: string) {
  restoreOne(id);
  ui.toast(`「${agentDisplayName(id)}」已恢复成最新`, 'success');
}

function restoreAll() {
  // 复制一份再遍历：restoreOne 会改 settings → outdatedAgents 即时缩空，
  // 边遍历边改 reactive 源会跳过部分条目
  const snapshot = [...outdatedAgents.value];
  for (const { id } of snapshot) restoreOne(id);
  if (snapshot.length > 0) {
    ui.toast(`已恢复 ${snapshot.length} 个 Agent 到最新默认`, 'success');
  }
}
</script>

<template>
  <div v-if="outdatedAgents.length > 0" class="update-center">
    <div class="update-center-head">
      <h3>提示词更新中心</h3>
      <p class="section-desc">
        以下 {{ outdatedAgents.length }} 个 Agent
        的提示词与你保存的版本不同（可能是项目默认更新了，或你曾自定义过）。点「恢复成最新」同步到当前默认——API
        与模型选择保留不动。
      </p>
    </div>
    <div class="update-list">
      <div v-for="a in outdatedAgents" :key="a.id" class="update-row">
        <span class="update-row-name">{{ a.name }}</span>
        <AppButton variant="secondary" size="sm" @click="restoreOneWithToast(a.id)"
          >恢复成最新</AppButton
        >
      </div>
    </div>
    <div v-if="outdatedAgents.length > 1" class="update-all">
      <AppButton variant="primary" size="sm" @click="restoreAll">全部恢复成最新</AppButton>
    </div>
  </div>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.update-center {
  margin-top: 8px;
  padding: 20px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
}
.update-center-head {
  margin-bottom: 16px;
}
.update-center-head h3 {
  font-family: var(--theme-font-title);
  font-size: 1.15rem;
  margin: 0 0 6px;
  color: var(--theme-text-primary);
}
.update-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.update-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
}
.update-row-name {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--theme-text-primary);
}
.update-all {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
}
</style>
