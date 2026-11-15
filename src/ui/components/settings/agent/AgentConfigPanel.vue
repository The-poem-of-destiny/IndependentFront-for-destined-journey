<script setup lang="ts">
import { isDirectSettingsProfile } from '../../../lib/direct-settings';

/**
 * 一个 Agent 的完整配置面（参数卡 + 提示词卡 + 动作栏）。
 *
 * 从 `AgentSection` 抽出来的**可复用壳**：分区壳只管页头与 `.section.centered`
 * 外框，本组件管「这个 agentId 的设置怎么读、怎么改、怎么存」。所以别的分区
 * （例如图像生成分区）只要传一个不同的 `agentId` 就能复用整套配置面，不必再抄
 * 一遍两个草稿与三个动作。
 *
 * 持有**两个草稿**与几个动作，因为动作栏（保存提示词 / 全部恢复默认 / 保存为项目默认）
 * 与预设条的「恢复默认」全都要读写草稿 —— 把草稿推到 AgentPromptCard 里，就得几条
 * 向上 emit 抬着提示词正文走，接口反而更宽。
 *
 * 📌 2026-11-14：提示词区最上方是 `AgentPresetBar`（每个 Agent 都有）；预设型 Agent
 *    不再有「保存」按钮（预设改动当场落库），「恢复成最新」改名「全部恢复默认」且只有
 *    一个意思：清覆写层（保留 model）+ 预设选择回到默认。
 *
 * 🔴 **多根 fragment 是刻意的**：三张卡与动作栏原本就是 `.section` 的直接子节点，
 *    包一层 div 会平白改掉 DOM 层级。本组件不接受任何透传属性（只有一个声明过的
 *    prop），所以多根不会引发 attrs 落空。外框那条 `.centered`（780px 居中）
 *    仍由 `AgentSection` 的**单根** `<section>` 负责，见那边的文件头。
 *
 * 🔴 草稿载入必须是 `watch(..., { immediate: true })`，**immediate 不是可选项**：
 *    整个 Agent 分区在 SettingsPage 里是 `v-if`，随 `activeSection` 挂载/卸载，
 *    所以每次进分区本组件都是**新挂载**的。普通 watch 在挂载时不触发，两个
 *    textarea 会空着渲染，接着「保存提示词」把空串写进用户的提示词。抽壳之后这条
 *    watch 必须留在**本组件**（草稿在这里，宿主看不见它们）——
 *    回归测试见 `AgentConfigPanel.test.ts` 第一条。
 *
 *    （历史：这里原先写的理由是「主导航每次点击都把 activeAgent 置 null」。那个
 *    置 null 已经删掉了 —— 它让持久化的 Agent 选择永远读不回来。结论没变，
 *    是 `v-if` 在保证新挂载，不是那次置 null。）
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppButton from '../../shared/AppButton.vue';
import { setPromptDraftDirty } from './prompt-dirty-guard';
import AgentParamsCard from './AgentParamsCard.vue';
import AgentPromptCard from './AgentPromptCard.vue';
import AgentPresetBar from './AgentPresetBar.vue';
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
  type AgentDefaultsLayer,
} from '../../../stores/agent-settings';
import { initializeCachedDirectSettings } from '../../../lib/direct-settings';
import { presetProfileForAgent } from '@engine/prompts/preset-resolution';
import { useGameStore } from '../../../stores/game-store';
import { GENERATION_MODE_LABELS } from '@engine/story/generation-mode';
import { getAgentTemplate } from '@engine/prompts/agent-templates';

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
   * 默认 `false` —— Agent 分区一个字都不用改。旗子藏掉提示词卡、预设条与「保存提示词」
   * （没有可保存的提示词），「全部恢复默认」照旧。
   */
  hidePrompt?: boolean;
}>();

const cfg = useSettingsStore();
const s = cfg.settings;
const game = useGameStore();
const ui = useUIStore();
const { effectivePreset } = usePresets();

const agentPromptDraft = ref('');
const agentTemplateDraft = ref('');

/**
 * S-15：两个草稿的「干净基线」—— 载入 / 保存 / 恢复之后各记一次，草稿与之不同即「未保存」。
 * 结果经模块级 `promptDraftDirty` 交给 SettingsPage，换 Agent / 换分区 / 返回前据此拦一下。
 */
const cleanPrompt = ref('');
const cleanTemplate = ref('');
function markDraftsClean() {
  cleanPrompt.value = agentPromptDraft.value;
  cleanTemplate.value = agentTemplateDraft.value;
}
const draftsDirty = computed(
  () =>
    agentPromptDraft.value !== cleanPrompt.value ||
    agentTemplateDraft.value !== cleanTemplate.value,
);
watch(draftsDirty, (dirty) => setPromptDraftDirty(dirty), { immediate: true });
// 卸载即离开（导航前已确认过），别把「未保存」带到下一次挂载
onBeforeUnmount(() => setPromptDraftDirty(false));

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
 * 当前**生效**的预设（选择为空/失效时即默认）—— 与运行时同一个解析器。
 * 不对应预设的 Agent 为 null。
 */
const activePreset = computed(() => {
  const profile = presetProfileForAgent(props.agentId);
  return profile ? effectivePreset(profile).preset : null;
});

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
  markDraftsClean();
}

// immediate 必须留着 —— 理由见文件头
watch(() => props.agentId, loadDrafts, { immediate: true });
watch(
  () => [props.agentId, defaultsLayer.value, s.apiPool],
  () => {
    if (isDirectSettingsProfile(props.agentId) && Object.keys(defaultsLayer.value).length)
      initializeCachedDirectSettings(s, defaultsLayer.value);
  },
  { immediate: true, deep: true },
);

/** 预设型 Agent（story / direct_main / direct_cached）：提示词是预设，不是裸串 */
const isPresetAgent = computed(() => presetProfileForAgent(props.agentId) !== null);

function saveAgentSettings() {
  // 非预设 Agent：提交 System Prompt + Template 到覆写层
  // 🔴 D44 修正 4：diff 写入 —— 草稿与解析默认相等时**删键**（不是写进覆写层），
  //    让默认层接管。这样「保存提示词」不会把展示中的默认值固化成覆写，pack 后续
  //    版本仍能透过覆写层够到这个 agent。
  if (!isPresetAgent.value) {
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
  markDraftsClean();
  ui.toast('提示词已保存', 'success');
}

/**
 * 预设条上的「恢复默认」（非预设 Agent）：**只**清 systemPrompt 与上下文模板两项覆写，
 * 其余覆写（模型、数值旋钮、历史层数…）原样保留，然后按默认层重载草稿。
 */
function restorePromptDefaults() {
  const id = props.agentId;
  const entry = s.agents?.[id];
  if (entry) {
    patchAgentSettings(s, id, { systemPrompt: undefined, template: undefined });
    // 只剩空壳时整条删掉 —— 不在覆写层留下「用户什么都没改」的脏条目
    if (Object.keys(entry).length === 0) delete s.agents[id];
  }
  loadDrafts(id);
  ui.toast('提示词已恢复默认', 'info');
}

async function saveAsDefault() {
  const agentId = props.agentId;

  // 🔴 非 story 分支的这次 patch **不能省**：「保存为项目默认」除了写
  //    agent-config.json，也把草稿落进本地设置。只搬装配、漏掉这行，
  //    刷新之后用户的编辑就没了。装配那半是纯的，见 agent-defaults.ts。
  if (agentId !== 'story' && !isDirectSettingsProfile(agentId)) {
    patchAgentSettings(s, agentId, {
      systemPrompt: agentPromptDraft.value,
      template: agentTemplateDraft.value,
    });
    // 草稿已经落进本地设置 —— 无论下面写文件成不成功，都不再算「未保存」
    markDraftsClean();
  }

  // 预设型 Agent 存的是生效预设；连默认都解析不到就不写（否则会把空 presetId 写进默认文件）
  if (presetProfileForAgent(agentId) && !activePreset.value) {
    ui.toast('没有可用的预设，无法保存为项目默认', 'error');
    return;
  }
  const entry = buildAgentDefaultEntry({
    agentId,
    settings: getAgentSettings(s, agentId, defaultsLayer.value),
    promptDraft: agentPromptDraft.value,
    templateDraft: agentTemplateDraft.value,
    // ChatPreset 与 PresetItem 结构同形（id/name/description?/settings/createdAt/updatedAt）；
    // buildAgentDefaultEntry 内部用 JSON 深拷贝，此处对齐前端历史类型签名。
    effectivePreset: activePreset.value as unknown as PresetItem | null,
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

/**
 * 「全部恢复默认」—— 对每个 Agent、每种内容包状态只有**一个**意思（2026-11-14）：
 *   · 清掉这个 Agent 的整条覆写层，**永远保留 `model`**（用户选的 API 池不是「默认」能给的）；
 *   · 预设型 Agent 的选择键清空（跟随默认，默认预设由读取侧解析，无需写库）；
 *   · 按默认层重载两个草稿。
 * 此前「无项目默认」那一支用 `resetAgentSettings` 连 model 一起清 —— 已删。
 */
function restoreAgentDefaults() {
  const id = props.agentId;
  // 与「覆写差异面板」（AgentUpdateCenter）用同一个 helper —— 两处行为天然一致
  applyProjectDefaultToAgent(s, id);
  const profile = presetProfileForAgent(id);
  if (profile === 'story') s.activePresetId = '';
  else if (profile === 'direct') delete s.directPresetId;
  else if (profile === 'direct_cached') {
    delete s.directCachedPresetId;
    // 渠道策略也属缓存直出配置：清掉后由初始化与读取侧的 ?? 'prefix' 回到默认
    delete s.directCacheProvider;
    // 重建时机同理：删键 = 回到引擎默认
    delete s.directCacheRebuildTurns;
    delete s.directCacheGrowthLimit;
    s.directCachedInitialized = false;
    initializeCachedDirectSettings(s, defaultsLayer.value);
  }
  loadDrafts(id);
  s.agentPromptEdited = false;
  s.agentDirty[id] = false;
  ui.toast('已全部恢复默认', 'info');
}
</script>

<template>
  <p v-if="game.activeSave" class="form-hint">
    本存档：{{
      GENERATION_MODE_LABELS[game.generationMode]
    }}，创建后不可更改。这里调整模型和提示词，不改变存档模式。
  </p>
  <AgentParamsCard :agent-id="agentId" />

  <!-- 「预设」状态条：每个 Agent 都有，说明现在用的是什么、从哪来、怎么回到默认。
       hidePrompt 时不出（提示词的真源在别处，见 props 上的注释） -->
  <AgentPresetBar v-if="!hidePrompt" :agent-id="agentId" @reset-prompt="restorePromptDefaults" />

  <!-- 预设型 Agent 走预设内容面，其余 Agent 走 systemPrompt + 上下文模板；
       hidePrompt 时两者都不出 -->
  <PresetManager v-if="isPresetAgent" :agent-id="agentId" />
  <AgentPromptCard
    v-else-if="!hidePrompt"
    v-model:prompt="agentPromptDraft"
    v-model:template="agentTemplateDraft"
    :agent-id="agentId"
  />

  <!-- 操作按钮 -->
  <div class="detail-actions">
    <AppButton
      v-if="canSaveAsDefault"
      variant="ghost"
      size="sm"
      data-testid="save-as-default"
      @click="saveAsDefault"
    >
      保存为默认
    </AppButton>
    <AppButton
      variant="ghost"
      size="sm"
      data-testid="restore-all-defaults"
      @click="restoreAgentDefaults"
      >全部恢复默认</AppButton
    >
    <!-- 预设型 Agent 没有「保存」：预设的改动当场落库，这颗按钮以前只弹一条 toast -->
    <!-- S-15：提示词 / 模板有未保存修改时贴在「保存提示词」左边 -->
    <span v-if="draftsDirty" class="unsaved-marker" role="status">未保存</span>
    <AppButton
      v-if="!isPresetAgent && !hidePrompt"
      variant="primary"
      size="sm"
      data-testid="save-prompt"
      @click="saveAgentSettings"
      >保存提示词</AppButton
    >
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
  align-items: center;
}
/* S-15：提示词 / 模板有未保存修改时贴在「保存设置」左边 */
.unsaved-marker {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-warning);
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 40%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-warning) 12%, var(--theme-card-bg));
}
</style>
