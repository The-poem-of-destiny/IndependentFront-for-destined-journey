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
 *    整个 Agent 分区在 SettingsPage 里是 `v-if`，随 `activeSection` 挂载/卸载，
 *    所以每次进分区本组件都是**新挂载**的。普通 watch 在挂载时不触发，两个
 *    textarea 会空着渲染，接着「保存设置」把空串写进用户的提示词。抽壳之后这条
 *    watch 必须留在**本组件**（草稿在这里，宿主看不见它们）——
 *    回归测试见 `AgentConfigPanel.test.ts` 第一条。
 *
 *    （历史：这里原先写的理由是「主导航每次点击都把 activeAgent 置 null」。那个
 *    置 null 已经删掉了 —— 它让持久化的 Agent 选择永远读不回来。结论没变，
 *    是 `v-if` 在保证新挂载，不是那次置 null。）
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
import { usePresets } from '../../../composables/usePresets';
import {
  applyProjectDefaultToAgent,
  getAgentSettings,
  patchAgentSettings,
  resetAgentSettings,
  type AgentDefaultsLayer,
} from '../../../stores/agent-settings';
import { getAgentTemplate } from '@engine/agent-templates';

const props = defineProps<{
  agentId: string;
  /**
   * 不渲染提示词卡（systemPrompt + 上下文模板）。
   *
   * 🔴 **只给图像分区的「提示词生成」卡用**（图像 v2 / C6）：那个 agent 的 systemPrompt
   *    已经是**方言属性** —— 真源在 `imageDialects` 那一面，用户覆盖按方言 id 键控存
   *    `imageDialectOverrides[dialectId].systemPrompt`。再开一个写 `agents.image_prompt
   *    .systemPrompt` 的框，就是 C6 点名的那种「切方言不跟着换」的静默漂移：改完看着
   *    生效了，换条方言又变回去，而两个框长得一模一样。
   *
   * 默认 `false` —— Agent 分区一个字都不用改。旗子只藏**渲染**，草稿与
   * 「保存设置」的 diff 写入照旧（草稿等于解析默认 → 不写覆写层，见 saveAgentSettings）。
   */
  hidePrompt?: boolean;
}>();

const cfg = useSettingsStore();
const s = cfg.settings;
const ui = useUIStore();
const { presets: presetList, upsertPreset } = usePresets();

const agentPromptDraft = ref('');
const agentTemplateDraft = ref('');

// 内容-引擎分离波 4 / D14：真实内容 overlay 是否启用（vite define 注入）。
// 未启用（公开占位态）时隐藏「保存为默认」—— 否则一次点击就把提示词写进公开仓占位文件。
declare const __POEM_CONTENT_DIR__: boolean;
const canSaveAsDefault = __POEM_CONTENT_DIR__;

/**
 * 当前 Agent 的**默认层**（pack > 占位）—— D44 修正 1：getAgentSettings 合默认层、
 * saveAgentSettings 与之 diff 写覆写。
 *
 * 形如 `{ [agentId]: Partial<AgentSettingsEntry> }`。projectAgentDefaults 异步加载，
 * 加载完 reactive 触发本 computed 重算（saveAgentSettings 读最新值）。
 */
const defaultsLayer = computed<AgentDefaultsLayer>(() => {
  const agents = cfg.projectAgentDefaults?.agents;
  if (!agents) return {};
  // 形状对齐 AgentSettingsEntry 的 12 键子集（磁盘 AgentDefaultEntry 多了 presetId/preset，
  // 对 resolve 无害——getAgentSettings 只读它认得的键）
  const layer: AgentDefaultsLayer = {};
  for (const [id, entry] of Object.entries(agents)) {
    layer[id] = entry as Partial<import('../../../stores/agent-settings').AgentSettingsEntry>;
  }
  return layer;
});

/**
 * 当前选中的预设 —— 与 PresetManager 各算一次（对 store 的一行派生，不穿 prop）。
 *
 * 内容-引擎分离波 1 / D22：预设真源是 Dexie（经 usePresets composable 的共享 ref），
 * 不再读 `s.presets` localStorage 镜像。
 */
const activePreset = computed(
  () => presetList.value.find((p) => p.id === s.activePresetId) ?? null,
);

/** 载入两个草稿：用户覆写 → 项目默认（agent-config.json）→ 引擎内置模板 */
function loadDrafts(id: string) {
  const layer = defaultsLayer.value;
  // D44 修正 1：经 getAgentSettings 合默认层 —— 「用户没覆写」时读到默认层 systemPrompt
  const resolved = getAgentSettings(s, id, layer);
  if (resolved.systemPrompt) {
    agentPromptDraft.value = resolved.systemPrompt;
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

  // Load template from resolved (user override ?? default), else engine default
  if (resolved.template) {
    agentTemplateDraft.value = resolved.template;
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
  // 非 story Agent：提交 System Prompt + Template 到覆写层
  // 🔴 D44 修正 4：diff 写入 —— 草稿与解析默认相等时**删键**（不是写进覆写层），
  //    让默认层接管。这样「保存设置」不会把展示中的默认值固化成覆写，pack 后续
  //    版本仍能透过覆写层够到这个 agent。
  if (props.agentId !== 'story') {
    const resolved = getAgentSettings(s, props.agentId, defaultsLayer.value);
    const promptPatch: { systemPrompt: string | undefined } = {
      systemPrompt:
        agentPromptDraft.value === resolved.systemPrompt ? undefined : agentPromptDraft.value,
    };
    const templatePatch: { template: string | undefined } = {
      template:
        agentTemplateDraft.value === resolved.template ? undefined : agentTemplateDraft.value,
    };
    // 🔴 两个字段都与默认相等时不调用 patch —— 否则 `patchAgentSettings` 的 ensure 会
    //    在覆写层留下一个空壳条目 `{ char_gen: {} }`（用户没改任何东西却冒出脏数据）。
    //    空壳无害（getAgentSettings 的 peek 返回 {} → 全走默认层；AgentUpdateCenter 的
    //    空对象键被过滤不列出），但违背 D44 修正 4「保存只写 diff」的意图。
    const hasChange =
      promptPatch.systemPrompt !== undefined || templatePatch.template !== undefined;
    if (hasChange) {
      patchAgentSettings(s, props.agentId, { ...promptPatch, ...templatePatch });
    }
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
    settings: getAgentSettings(s, agentId, defaultsLayer.value),
    promptDraft: agentPromptDraft.value,
    templateDraft: agentTemplateDraft.value,
    activePresetId: s.activePresetId || '',
    // ChatPreset 与 PresetItem 结构同形（id/name/description?/settings/createdAt/updatedAt）；
    // buildAgentDefaultEntry 内部用 JSON 深拷贝，此处对齐前端历史类型签名。
    activePreset: activePreset.value as unknown as PresetItem | null,
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
        const existing = presetList.value.find((p) => p.id === pd.preset!.id);
        if (!existing) {
          // 🔒 P2-04: await 写 IndexedDB —— 此前 fire-and-forget + 空 catch，
          // 刷新或页面销毁时 Promise 可能未完成，预设丢失且错误被吞。
          try {
            await upsertPreset(pd.preset as any);
          } catch (err) {
            console.error('[AgentConfigPanel] 恢复默认预设写 IndexedDB 失败:', err);
          }
        }
      }
      // 🔴 D44 修正 4：story「恢复默认」= 清覆写层（解析值自动回默认层 pack > 占位）。
      //    不动 model（用户选的 API 池）。applyProjectDefaultToAgent 保留 model、清其余。
      //    不写 systemPrompt/template —— story 的提示词是预设不是裸串。
      applyProjectDefaultToAgent(s, id);
    } else {
      // 非 story：一键清覆写层（解析值回默认层，保留 model）。
      // 与「覆写差异面板」（AgentUpdateCenter）用同一个 helper —— 两处行为天然一致。
      applyProjectDefaultToAgent(s, id);
      agentPromptDraft.value = pd.systemPrompt || '';
      agentTemplateDraft.value = pd.template || '';
    }
    s.agentPromptEdited = false;
    s.agentDirty[id] = false;
    ui.toast('已恢复成最新', 'info');
    return;
  }

  // 无项目默认 → 清覆写层（解析值落占位/兜底）。resetAgentSettings 连 model 一起清。
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

  <!-- story 走预设面板，其余 Agent 走 systemPrompt + 上下文模板（原 v-if/v-else 一对）；
       hidePrompt 时两者都不出（提示词的真源在别处，见 props 上的注释） -->
  <PresetManager v-if="agentId === 'story'" :agent-id="agentId" />
  <AgentPromptCard
    v-else-if="!hidePrompt"
    v-model:prompt="agentPromptDraft"
    v-model:template="agentTemplateDraft"
    :agent-id="agentId"
  />

  <!-- 操作按钮 -->
  <div class="detail-actions">
    <AppButton v-if="canSaveAsDefault" variant="ghost" size="sm" @click="saveAsDefault">
      保存为默认
    </AppButton>
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
