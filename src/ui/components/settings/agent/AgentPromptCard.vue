<script setup lang="ts">
/**
 * 非 story Agent 的提示词卡：System Prompt / 上下文模板 / 占位符面板 / 模板预览
 * （Q-25 第 9 步）。
 *
 * 两个草稿由 `AgentConfigPanel` 持有（动作栏的三个按钮都要读写它们），这里用
 * `defineModel` 双向绑回去 —— 组件只管编辑，不管保存。
 *
 * 🔴 插入占位符改用**模板 ref**，不再 `document.querySelectorAll('.prompt-editor')`
 *    取最后一个。旧写法能work全靠一个没人保证的巧合：另外两个同类 textarea 在
 *    预设弹窗里（AppModal teleport 到 body 的**末尾**），而那两个只在 story 分支
 *    存在、本卡只在非 story 分支渲染。任何人把预设弹窗改成常驻，插入就会写进
 *    弹窗的输入框。现在它只认自己那一个元素。
 */
import { computed, nextTick, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import TemplatePreview from '../TemplatePreview.vue';
import { getPlaceholdersForAgent, phLabel } from './placeholder-catalog';
import { getDefaultTemplateForAgent } from './agent-list';
import { useSettingsStore } from '../../../stores/settings-store';

const props = defineProps<{ agentId: string }>();

const promptDraft = defineModel<string>('prompt', { required: true });
const templateDraft = defineModel<string>('template', { required: true });

// 🔴 `agentPromptEdited` 全仓**只写不读**（Q-18 核查：9 写 0 读）——
//    本该驱动一个「未保存」角标，那个角标没有被实现。搬迁期原样保留写入，
//    不趁机删；要删就该连同 `agentDirty` 一起作为独立一刀。
const s = useSettingsStore().settings;

const showTemplatePreview = ref(false);

const availablePlaceholders = computed(() => getPlaceholdersForAgent(props.agentId));

/** 上下文模板那个 textarea —— 插入占位符只认它 */
const templateEditor = ref<HTMLTextAreaElement | null>(null);

/** 在光标处插入 `{{KEY}}`，插完把光标放到插入内容之后 */
async function insertPlaceholder(key: string) {
  const el = templateEditor.value;
  if (!el) return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  const text = templateDraft.value;
  const token = `{{${key}}}`;
  templateDraft.value = text.slice(0, start) + token + text.slice(end);
  // v-model 写回后 DOM 才更新，光标要等下一拍再放
  await nextTick();
  el.focus();
  el.setSelectionRange(start + token.length, start + token.length);
}
</script>

<template>
  <!-- 原本是与预设卡成对的 v-else 分支；分叉现在由 AgentConfigPanel 用
       v-if="agentId === 'story'" / v-else 在**组件层**做，所以这里是无条件根节点 -->
  <AppCard padding="md" class="detail-card">
    <!-- Section 1: System Prompt -->
    <h4>System Prompt</h4>
    <p class="form-hint">
      核心指令——正文 AI 的人格、叙事准则、输出格式等。"System Prompt" 里请不要写占位符。
    </p>
    <textarea
      v-model="promptDraft"
      class="form-textarea prompt-editor"
      rows="10"
      placeholder="编写核心指令，如叙事准则、输出格式、示例等..."
      @input="s.agentPromptEdited = true"
    />

    <hr style="margin: 18px 0; border-color: var(--theme-card-border)" />

    <!-- Section 2: Context Template -->
    <h4>上下文模板</h4>
    <p class="form-hint">
      使用
      <code v-pre>{{ PLACEHOLDER }}</code>
      占位符管理上下文注入。占位符运行时会被替换为实际内容。
    </p>
    <textarea
      ref="templateEditor"
      v-model="templateDraft"
      class="form-textarea prompt-editor"
      rows="8"
      placeholder="输入模板，使用 {{NARRATIVE}} 等占位符..."
      @input="s.agentPromptEdited = true"
    />

    <!-- Placeholder badges -->
    <div class="placeholder-badges" style="margin-top: 10px">
      <span class="text-xs text-muted">可用占位符 (点击插入):</span>
      <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px">
        <span
          v-for="ph in availablePlaceholders"
          :key="ph.key"
          class="placeholder-badge"
          :style="{
            background: ph.color + '22',
            color: ph.color,
            border: '1px solid ' + ph.color + '44',
          }"
          :title="ph.desc"
          @click="insertPlaceholder(ph.key)"
          >{{ phLabel(ph.key) }}</span
        >
      </div>
    </div>

    <!-- Section 3: Template Preview -->
    <div style="margin-top: 12px">
      <AppButton variant="ghost" size="sm" @click="showTemplatePreview = !showTemplatePreview">
        {{ showTemplatePreview ? '收起预览' : '模板预览' }}
      </AppButton>
    </div>
    <div
      v-if="showTemplatePreview"
      class="template-preview-panel"
      style="
        margin-top: 10px;
        padding: 12px;
        background: var(--color-surface);
        border-radius: 8px;
        border: 1px solid var(--color-border);
      "
    >
      <TemplatePreview
        :template="templateDraft || getDefaultTemplateForAgent(agentId)"
        :agent-id="agentId || undefined"
      />
    </div>
  </AppCard>
</template>

<!-- 🔴 顺序不可颠倒：共用外壳必须在自有块**之前**。`.toggle-sm` 与 chrome 里的
     `.toggle-slider` 特异性相同（0,1,0），全靠这个顺序才赢 —— 反过来写，
     预设条目的小开关会悄悄变回 40x22。 -->
<style scoped src="../settings-chrome.css"></style>
<style scoped src="./agent-chrome.css"></style>

<style scoped>
/* Phase 10e: Placeholder badges */
.placeholder-badge {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: var(--theme-radius-full, 999px);
  font-family: 'Monaco', 'Menlo', 'Cascadia Code', monospace;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  transition: all var(--theme-transition-fast);
  white-space: nowrap;
}
.placeholder-badge:hover {
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}
</style>
