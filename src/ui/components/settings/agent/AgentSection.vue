<script setup lang="ts">
/**
 * Agent 分区的壳（Q-25 第 9 步）。
 *
 * 持有**两个草稿**与**三个动作**，因为动作栏（保存设置 / 恢复默认 / 保存为项目默认）
 * 三个按钮全都要读写草稿 —— 把草稿推到 AgentPromptCard 里，就得三条向上 emit
 * 抬着提示词正文走，接口反而更宽。
 *
 * 🔴 **单根** `<section class="section centered">`：`.centered`（780px 居中）是
 *    SettingsPage 的 scoped 规则，只够得到子组件的**根节点**。多根 fragment 会让
 *    它命不中，本分区在宽屏下摊满整行 —— ApiSection 在真机走查里正是栽在这条。
 *
 * 🔴 草稿载入改成 `watch(..., { immediate: true })`，**immediate 不是可选项**：
 *    主导航每次点击都把 `activeAgent` 置 null（SettingsPage 的 nav 里），
 *    所以本组件永远是**新挂载**的。普通 watch 在挂载时不触发，两个 textarea 会
 *    空着渲染，接着「保存设置」把空串写进用户的提示词。
 *
 * 📌 顺带删掉的死码：SettingsPage 里那段"挂载时用 systemPrompt 给草稿打底"
 *    （旧 139-144）从来跑不到 —— `activeSection` 起始是 'api'，而进 Agent 分区
 *    必然先把 `activeAgent` 置 null，详情面只能由子导航点击唤出。它的逻辑还是
 *    下面这条载入链的真子集（只读 systemPrompt，从不载模板）。
 */
import { computed, ref, watch } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import AgentParamsCard from './AgentParamsCard.vue';
import AgentPromptCard from './AgentPromptCard.vue';
import PresetManager from './PresetManager.vue';
import { agentDisplayName, AGENT_LIST, getDefaultTemplateForAgent } from './agent-list';
import { buildAgentDefaultEntry } from './agent-defaults';
import { useSettingsStore, type PresetItem } from '../../../stores/settings-store';
import { useUIStore } from '../../../stores/ui-store';
import {
  AGENT_SETTINGS_DEFAULTS,
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

const agentMeta = computed(() => AGENT_LIST.find((a) => a.id === props.agentId));

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
    // 不恢复模型选择 — 用户自己选的 API 和模型不应该被默认值覆盖
    patchAgentSettings(s, id, {
      worldBookEnabled: pd.worldBookEnabled ?? false,
      worldBookIds: [...(pd.worldBookIds || [])],
    });
    if (id === 'story') {
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
            console.error('[SettingsPage] 恢复默认预设写 IndexedDB 失败:', err);
          }
        }
      }
    } else {
      patchAgentSettings(s, id, { systemPrompt: pd.systemPrompt || '' });
      agentPromptDraft.value = pd.systemPrompt || '';
      // Restore template from project default（没给就删键，不是写空串）
      patchAgentSettings(s, id, { template: pd.template || undefined });
      agentTemplateDraft.value = pd.template || '';
    }
    // Q-18: 五个数值旋钮 + 两项历史注入配置一次写完，默认值只在
    // AGENT_SETTINGS_DEFAULTS 出现一次（此前这里各写一遍 `?? 0.7 / ?? 16384`，
    // 与下面的兜底分支、game-pipeline、create-store 共六份拷贝）。
    //
    // `historyLayers` / `historySlice` 传 undefined 即**删键** —— 项目默认没设时要把
    // 「走引擎按 agent 类别的默认」那条语义还回去，不是写个 0 进去。
    //
    // 🔴 这里刻意**只碰数值项**：model 不动（用户自己选的 API 与模型不该被默认值覆盖，
    // 这是本分支既有行为，与下面的出厂兜底分支不同）；worldBook / systemPrompt /
    // template 上面已按 story 分支各自处理过，重写一遍会把刚 delete 掉的 template 键
    // 又补成空串。
    patchAgentSettings(s, id, {
      temperature: pd.temperature ?? AGENT_SETTINGS_DEFAULTS.temperature,
      topP: pd.topP ?? AGENT_SETTINGS_DEFAULTS.topP,
      freqPen: pd.freqPen ?? AGENT_SETTINGS_DEFAULTS.freqPen,
      presPen: pd.presPen ?? AGENT_SETTINGS_DEFAULTS.presPen,
      maxTokens: pd.maxTokens ?? AGENT_SETTINGS_DEFAULTS.maxTokens,
      historyLayers: pd.historyLayers,
      historySlice: pd.historySlice,
    });
    s.agentPromptEdited = false;
    s.agentDirty[id] = false;
    ui.toast('已恢复项目默认设置', 'info');
    return;
  }

  // 无项目默认 → 恢复出厂（不传来源即全部落 AGENT_SETTINGS_DEFAULTS）。
  // 与上面的分支此前是两段只差取值来源的手抄，各写一遍 `?? 0.7 / ?? 16384`。
  resetAgentSettings(s, id);
  s.activePresetId = '';
  agentPromptDraft.value = '';
  agentTemplateDraft.value = '';
  s.agentPromptEdited = false;
  s.agentDirty[id] = false;
  ui.toast('已恢复默认设置', 'info');
}
</script>

<template>
  <section class="section centered">
    <div class="agent-detail-head">
      <h3>{{ agentMeta?.name }}</h3>
      <span class="text-sm text-muted">{{ agentMeta?.desc }}</span>
    </div>

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
      <AppButton variant="ghost" size="sm" @click="restoreAgentDefaults">恢复默认</AppButton>
      <AppButton variant="primary" size="sm" @click="saveAgentSettings">保存设置</AppButton>
    </div>
  </section>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
/* Agent */
.agent-detail-head {
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--theme-card-border);
}
.agent-detail-head h3 {
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  margin: 0 0 6px;
}
.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--theme-card-border);
}
</style>
