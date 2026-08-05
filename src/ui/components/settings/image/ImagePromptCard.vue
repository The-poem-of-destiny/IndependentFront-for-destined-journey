<script setup lang="ts">
/**
 * 第一张卡：**提示词生成** —— `image_prompt` 这个 LLM Agent 的完整配置面（D51/D52/D54）。
 *
 * 🔴 **本组件是个薄壳，一行状态都没有。** 真正的配置面是 `AgentConfigPanel`
 *    （草稿 + 三个动作 + 两张卡），它由 `AgentSection` 与本卡各渲染一次，只是
 *    `agentId` 不同。抽壳的理由与不抽壳的代价见 `AgentConfigPanel.vue` 的文件头
 *    —— 一句话：草稿载入的 `watch(..., { immediate: true })` 必须留在那一层。
 *
 * 🔴 **渲染位置 ≠ 存储位置**（D52）：这里渲染的是 `agents` 袋子里的**同一份存储**，
 *    不是复制一份。`image_prompt` 是个 LLM Agent，它的模型/温度/世界书/systemPrompt
 *    就该跟别的 agent 存一处（`agent-settings.ts` 是唯一读写口）。旁边那张「出图」卡
 *    的 NAI 参数才住 `UiSettings` —— `width`/`steps`/`ucPreset` 不是 LLM 参数。
 *
 * 🔴 **它不进 Agent 子导航**（D53）：同一份配置开两个入口，用户就要猜哪个是权威的。
 *    所以 `agent-list.ts` 一个字都不用动 —— 那张表是设置页的展示元数据，
 *    不是「有哪些 agent」的真源（`combat_v3` 是现成的先例）。
 *
 * 🔴 下面那句「作用范围」不是装饰：本分区里有**两处**都叫「提示词」的东西 ——
 *    这里的 systemPrompt 教模型**怎么把中文场景转成 danbooru 标签**，
 *    「出图」卡里的画质后缀/全局负向则**直接拼进每一张图**。写错框两边都不报错，
 *    只是画出来不对（§11.3，与 D27 同一类的静默失败）。
 */
import AgentConfigPanel from '../agent/AgentConfigPanel.vue';

/** 唯一常量：这张卡服务的 agent。写死是刻意的 —— 它不是一个可选项 */
const AGENT_ID = 'image_prompt';
</script>

<template>
  <div class="image-card-head">
    <h4>提示词生成</h4>
    <p class="image-card-scope">
      这里配的是<strong>把中文场景转成 danbooru 标签</strong>的那个 LLM
      Agent：模型、温度、世界书、以及教它怎么转的系统提示词。
      <br />
      想改「每张图都带上的画质词与负向词」请去下面那张「出图」卡 ——
      那是<strong>图</strong>的提示词，不是 Agent 的提示词。
    </p>
  </div>

  <AgentConfigPanel :agent-id="AGENT_ID" />
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-card-head {
  margin-bottom: var(--theme-spacing-lg);
}
.image-card-head h4 {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
/* Section 标题装饰线（design.md §5.1） */
.image-card-head h4::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.image-card-scope {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}
</style>
