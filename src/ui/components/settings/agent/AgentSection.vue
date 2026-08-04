<script setup lang="ts">
/**
 * Agent 分区的壳（Q-25 第 9 步；配置面已抽进 `AgentConfigPanel`）。
 *
 * 本组件现在**只剩外框与页头**：`.section.centered` 那层框、以及"当前 Agent 叫什么"
 * 那一行。两个草稿与三个动作（保存设置 / 恢复默认 / 保存为项目默认）连同三张卡
 * 都在 `AgentConfigPanel` 里 —— 那样别的分区（例如图像生成分区）传一个不同的
 * `agentId` 就能复用整套配置面，页头则由各分区自己写。
 *
 * 🔴 **单根** `<section class="section centered">`：`.centered`（780px 居中）是
 *    SettingsPage 的 scoped 规则，只够得到子组件的**根节点**。多根 fragment 会让
 *    它命不中，本分区在宽屏下摊满整行 —— ApiSection 在真机走查里正是栽在这条。
 *    `AgentConfigPanel` 是多根的，它必须待在这层 `<section>` 里面才有外框。
 *
 * 🔴 草稿的 `watch(..., { immediate: true })` 在 `AgentConfigPanel` 里，别搬回来：
 *    主导航每次点击都把 `activeAgent` 置 null（SettingsPage 的 nav 里），
 *    所以这条链上的组件永远是**新挂载**的，普通 watch 在挂载时不触发，
 *    两个 textarea 会空着渲染，接着「保存设置」把空串写进用户的提示词。
 */
import { computed } from 'vue';
import AgentConfigPanel from './AgentConfigPanel.vue';
import { AGENT_LIST } from './agent-list';

const props = defineProps<{ agentId: string }>();

const agentMeta = computed(() => AGENT_LIST.find((a) => a.id === props.agentId));
</script>

<template>
  <section class="section centered">
    <div class="agent-detail-head">
      <h3>{{ agentMeta?.name }}</h3>
      <span class="text-sm text-muted">{{ agentMeta?.desc }}</span>
    </div>

    <AgentConfigPanel :agent-id="agentId" />
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
</style>
