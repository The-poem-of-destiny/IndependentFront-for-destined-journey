<script setup lang="ts">
/**
 * 覆写差异面板（Agent 分区空态区）—— D44 修正 4 重定位。
 *
 * 🔴 v1.2 重定位（2026-08-06）：本组件原本是 PR #34 的「提示词更新中心」——为
 *    旧缺陷而生（fillMissingAgentSettings 只填空位 → 新默认进不来）。D44 大修后
 *    那个缺陷的根因（boot 播种 + 默认值抄进覆写层）已从源头解决：boot 播种删除、
 *    指纹迁移清理旧默认覆写、getAgentSettings 合默认层。本组件重定位为**覆写层 vs
 *    默认层差异面板** + 「清除覆写」动作。
 *
 * 现在它解决的真问题：
 *   · 覆写层有条目的 agent = 用户改过（或残留旧覆写）→ 列出来，per-agent
 *     「清除覆写」一键回到默认层（保留 model）。
 *   · 指纹迁移后，四位测试者的旧默认覆写被清掉 → 本面板对他们不再误报「全部与
 *     最新默认不同」（那是 v1.1 首版的窘境）。
 *
 * story 不进本面板：它的提示词是预设（`prompts[]`），走 PresetManager 那条分叉；
 *    但 story 的世界书/旋钮覆写仍可在这里清。
 */
import { computed } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import { useSettingsStore } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import {
  applyProjectDefaultToAgent,
  type AgentSettingsEntry,
} from '../../../stores/agent-settings';
import { AGENT_LIST, agentDisplayName } from './agent-list';

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();

/** 覆写层里存在的字段名 → 中文展示标签 */
const FIELD_LABELS: Partial<Record<keyof AgentSettingsEntry, string>> = {
  model: 'API 池',
  worldBookEnabled: '世界书开关',
  worldBookIds: '世界书清单',
  systemPrompt: '提示词',
  template: '上下文模板',
  temperature: 'Temperature',
  topP: 'Top P',
  freqPen: 'Freq Penalty',
  presPen: 'Pres Penalty',
  maxTokens: 'Max Tokens',
  historyLayers: '历史注入层数',
  historySlice: '历史截断字数',
};

interface OverrideEntry {
  id: string;
  name: string;
  fields: string[];
}

/**
 * 列出覆写层有条目的**非 story 提示词** Agent。
 *
 * 覆写层（s.agents）里任意键存在 = 这个 Agent 被用户改过（或残留旧覆写）。
 * model 单列：它是「用户选的 API 池」不是「默认值」，绝大多数 agent 都会有；
 * 其余字段才是真正值得「清除覆写」的内容。
 *
 * `projectAgentDefaults` 是异步加载（app 启动时 fetch），加载完会 reactively
 * 触发本 computed 重算。
 */
const overriddenAgents = computed<OverrideEntry[]>(() => {
  const agents = (s as Record<string, unknown>).agents;
  if (!agents || typeof agents !== 'object') return [];
  const out: OverrideEntry[] = [];
  for (const entry of AGENT_LIST) {
    const overrideRec = (agents as Record<string, Record<string, unknown>>)[entry.id];
    if (!overrideRec || typeof overrideRec !== 'object') continue;
    // 🔴 model 是「用户选的 API 池」、是预期的合法覆写，不算「需要清除的差异」——
    //    列表只列有**非 model 覆写键**的 agent。这样「全部清除覆写」后只剩 model 的
    //    agent 不再出现在列表里（applyProjectDefaultToAgent 保留 model、清其余）。
    const keys = Object.keys(overrideRec).filter((k) => k in FIELD_LABELS && k !== 'model');
    if (keys.length === 0) continue;
    out.push({
      id: entry.id,
      name: entry.name,
      fields: keys.map((k) => FIELD_LABELS[k as keyof AgentSettingsEntry] ?? k),
    });
  }
  return out;
});

function clearOne(id: string) {
  applyProjectDefaultToAgent(s, id);
}

function clearOneWithToast(id: string) {
  clearOne(id);
  ui.toast(`「${agentDisplayName(id)}」的覆写已清除，回到默认`, 'success');
}

function clearAll() {
  // 复制一份再遍历：clearOne 会改 settings → overriddenAgents 即时缩空，
  // 边遍历边改 reactive 源会跳过部分条目
  const snapshot = [...overriddenAgents.value];
  for (const { id } of snapshot) clearOne(id);
  if (snapshot.length > 0) {
    ui.toast(`已清除 ${snapshot.length} 个 Agent 的覆写`, 'success');
  }
}
</script>

<template>
  <div v-if="overriddenAgents.length > 0" class="update-center">
    <div class="update-center-head">
      <h3>覆写差异面板</h3>
      <p class="section-desc">
        以下 {{ overriddenAgents.length }} 个 Agent
        有用户覆写（你在设置页改过、或残留了旧版默认值）。覆写字段会盖住内容包默认——「清除覆写」让它们回到当前默认（内容包
        &gt; 占位），API 与模型选择保留不动。
      </p>
    </div>
    <div class="update-list">
      <div v-for="a in overriddenAgents" :key="a.id" class="update-row">
        <div class="update-row-info">
          <span class="update-row-name">{{ a.name }}</span>
          <span class="update-row-fields">{{ a.fields.join('、') }}</span>
        </div>
        <AppButton variant="secondary" size="sm" @click="clearOneWithToast(a.id)"
          >清除覆写</AppButton
        >
      </div>
    </div>
    <div v-if="overriddenAgents.length > 1" class="update-all">
      <AppButton variant="primary" size="sm" @click="clearAll">全部清除覆写</AppButton>
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
  gap: 12px;
}
.update-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.update-row-name {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--theme-text-primary);
}
.update-row-fields {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.update-all {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
}
@media (prefers-reduced-motion: reduce) {
  .update-center,
  .update-row {
    transition: none;
  }
}
</style>
