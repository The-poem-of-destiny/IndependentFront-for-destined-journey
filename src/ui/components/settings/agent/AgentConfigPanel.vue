<script setup lang="ts">
/**
 * 一个 Agent 的完整配置面（参数卡 + 提示词卡 + 动作栏）。
 *
 * 从 `AgentSection` 抽出来的**可复用壳**：分区壳只管页头与 `.section.centered`
 * 外框，本组件管「这个 agentId 的设置怎么读、怎么改、怎么存」。所以别的分区
 * （例如图像生成分区）只要传一个不同的 `agentId` 就能复用整套配置面，不必再抄
 * 一遍两个草稿与三个动作。
 *
 * 持有**两个草稿**与**三个动作**，因为动作栏（保存设置 / 恢复默认 / 保存为项目默认）
 * 三个按钮全都要读写草稿 —— 把草稿推到 AgentPromptCard 里，就得三条向上 emit
 * 抬着提示词正文走，接口反而更宽。
 *
 * 🔴 **多根 fragment 是刻意的**：三张卡与动作栏原本就是 `.section` 的直接子节点，
 *    包一层 div 会平白改掉 DOM 层级。本组件不接受任何透传属性（只有一个声明过的
 *    prop），所以多根不会引发 attrs 落空。外框那条 `.centered`（780px 居中）
 *    仍由 `AgentSection` 的**单根** `<section>` 负责，见那边的文件头。
 *
 * 🔴 草稿载入必须是 `watch(..., { immediate: true })`，**immediate 不是可选项**：
 *    主导航每次点击都把 `activeAgent` 置 null（SettingsPage 的 nav 里），
 *    所以本组件永远是**新挂载**的。普通 watch 在挂载时不触发，两个 textarea 会
 *    空着渲染，接着「保存设置」把空串写进用户的提示词。抽壳之后这条 watch 必须
 *    留在**本组件**（草稿在这里，宿主看不见它们）——
 *    回归测试见 `AgentConfigPanel.test.ts` 第一条。
 */
import { computed, ref, watch } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import AgentParamsCard from './AgentParamsCard.vue';
import AgentPromptCard from './AgentPromptCard.vue';
import PresetManager from './PresetManager.vue';
import { agentDisplayName, getDefaultTemplateForAgent } from './agent-list';
import { buildAgentDefaultEntry } from './agent-defaults';
import { useSettingsStore, type PresetItem } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import {
  AGENT_SETTINGS_DEFAULTS,
  applyProjectDefaultToAgent,
  getAgentSettings,
  patchAgentSettings,
  resetAgentSettings,
} from '../../../stores/agent-settings';
import { getAgentTemplate } from '@engine/agent-templates';

const props = defineProps<{ agentId: string }>();

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();

const agentPromptDraft = ref('');
const agentTemplateDraft = ref('');

/** 当前选中的预设 —— 与 PresetManager 各算一次（对 store 的一行派生，不穿 prop） */
const activePreset = computed(
  () => (s.presets as PresetItem[]).find((p) => p.id === s.activePresetId) ?? null,
);

/** 载入两个草稿：用户自定义 → 项目默认（agent-config.json）→ 引擎内置模板 */
function loadDrafts(id: string) {
  // 优先加载用户自定义的 system prompt，否则加载引擎内置模板
  const custom = getAgentSettings(s, id).systemPrompt;
  if (custom) {
    agentPromptDraft.value = custom;
  } else {
    // Phase 9: 优先从 agent-config.json 读 systemPrompt，否则回退到 agent-templates.ts 的 fixedSystem+fixedExamples
    const pd = cfg.projectAgentDefaults?.agents?.[id];
    if (pd?.systemPrompt) {
      agentPromptDraft.value = pd.systemPrompt;
    } else {
      const tpl = getAgentTemplate(id);
      agentPromptDraft.value = tpl
        ? (tpl.fixedSystem + '\n\n' + (tpl.fixedExamples || '')).trim()
        : '';
    }
  }
  s.agentPromptEdited = false;

  // Load template from user custom, agent-config, or default
  const customTemplate = getAgentSettings(s, id).template;
  if (customTemplate) {
    agentTemplateDraft.value = customTemplate;
  } else {
    const pd2 = cfg.projectAgentDefaults?.agents?.[id];
    if (pd2?.template) {
      agentTemplateDraft.value = pd2.template;
    } else {
      agentTemplateDraft.value = getDefaultTemplateForAgent(id);
    }
  }
}

// immediate 必须留着 —— 理由见文件头
watch(() => props.agentId, loadDrafts, { immediate: true });

function saveAgentSettings() {
  // 非 story Agent：提交 System Prompt + Template 到持久化
  if (props.agentId !== 'story') {
    patchAgentSettings(s, props.agentId, {
      systemPrompt: agentPromptDraft.value,
      template: agentTemplateDraft.value,
    });
  }
  s.agentDirty[props.agentId] = true;
  ui.toast('Agent 设置已保存', 'success');
}

async function saveAsDefault() {
  const agentId = props.agentId;

  // 🔴 非 story 分支的这次 patch **不能省**：「保存为项目默认」除了写
  //    agent-config.json，也把草稿落进本地设置。只搬装配、漏掉这行，
  //    刷新之后用户的编辑就没了。装配那半是纯的，见 agent-defaults.ts。
  if (agentId !== 'story') {
    patchAgentSettings(s, agentId, {
      systemPrompt: agentPromptDraft.value,
      template: agentTemplateDraft.value,
    });
  }

  const entry = buildAgentDefaultEntry({
    agentId,
    settings: getAgentSettings(s, agentId),
    promptDraft: agentPromptDraft.value,
    templateDraft: agentTemplateDraft.value,
    activePresetId: s.activePresetId || '',
    activePreset: activePreset.value,
  });

  // 读取现有文件，更新当前 Agent，写回
  let current: { version: number; agents: Record<string, any> } = { version: 1, agents: {} };
  try {
    const res = await fetch('/data/defaults/agent-config.json');
    if (res.ok) current = await res.json();
  } catch {
    /* 首次保存 — 用空骨架 */
  }

  current.agents[agentId] = entry as any;

  const ok = await cfg.saveAgentProjectDefaults(current as any);
  if (ok) {
    ui.toast(`已将「${agentDisplayName(agentId)}」的配置保存为项目默认`, 'success');
  } else {
    ui.toast('保存项目默认失败，请确认开发服务器正在运行', 'error');
  }
}

async function restoreAgentDefaults() {
  const id = props.agentId;

  // 优先查项目默认
  const pd = cfg.projectAgentDefaults?.agents?.[id];
  if (pd) {
    if (id === 'story') {
      // story 走预设子系统：systemPrompt/template 由预设提供，这里只拉预设 + 世界书 + 旋钮
      s.activePresetId = pd.presetId || '';
      if (pd.preset) {
        const existing = s.presets.find((p) => p.id === pd.preset!.id);
        if (!existing) {
          s.presets.push(pd.preset);
          // 🔒 P2-04: await 写 IndexedDB —— 此前 fire-and-forget + 空 catch，
          // 刷新或页面销毁时 Promise 可能未完成，预设丢失且错误被吞。
          try {
            const { savePreset } = await import('@engine/database');
            await savePreset(pd.preset as any);
          } catch (err) {
            console.error('[AgentConfigPanel] 恢复默认预设写 IndexedDB 失败:', err);
          }
        }
      }
      // 不动 model / systemPrompt / template —— story 的提示词是预设，不是裸串。
      // `applyProjectDefaultToAgent` 会写 systemPrompt，story 不用它。
      patchAgentSettings(s, id, {
        worldBookEnabled: pd.worldBookEnabled ?? false,
        worldBookIds: [...(pd.worldBookIds || [])],
        temperature: pd.temperature ?? AGENT_SETTINGS_DEFAULTS.temperature,
        topP: pd.topP ?? AGENT_SETTINGS_DEFAULTS.topP,
        freqPen: pd.freqPen ?? AGENT_SETTINGS_DEFAULTS.freqPen,
        presPen: pd.presPen ?? AGENT_SETTINGS_DEFAULTS.presPen,
        maxTokens: pd.maxTokens ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
        historyLayers: pd.historyLayers,
        historySlice: pd.historySlice,
      });
    } else {
      // 非 story：一键拉提示词/模板/世界书/旋钮（保留 model）。
      // 与空态区「提示词更新中心」用同一个 helper —— 两处行为天然一致，改一个就够。
      applyProjectDefaultToAgent(s, id, pd);
      agentPromptDraft.value = pd.systemPrompt || '';
      agentTemplateDraft.value = pd.template || '';
    }
    s.agentPromptEdited = false;
    s.agentDirty[id] = false;
    ui.toast('已恢复成最新', 'info');
    return;
  }

  // 无项目默认 → 恢复出厂（不传来源即全部落 AGENT_SETTINGS_DEFAULTS）。
  resetAgentSettings(s, id);
  s.activePresetId = '';
  agentPromptDraft.value = '';
  agentTemplateDraft.value = '';
  s.agentPromptEdited = false;
  s.agentDirty[id] = false;
  ui.toast('已恢复出厂默认', 'info');
}
</script>

<template>
  <AgentParamsCard :agent-id="agentId" />

  <!-- story 走预设面板，其余 Agent 走 systemPrompt + 上下文模板（原 v-if/v-else 一对） -->
  <PresetManager v-if="agentId === 'story'" :agent-id="agentId" />
  <AgentPromptCard
    v-else
    v-model:prompt="agentPromptDraft"
    v-model:template="agentTemplateDraft"
    :agent-id="agentId"
  />

  <!-- 操作按钮 -->
  <div class="detail-actions">
    <AppButton variant="ghost" size="sm" @click="saveAsDefault">保存为默认</AppButton>
    <AppButton variant="ghost" size="sm" @click="restoreAgentDefaults">恢复成最新</AppButton>
    <AppButton variant="primary" size="sm" @click="saveAgentSettings">保存设置</AppButton>
  </div>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--theme-card-border);
}
</style>
