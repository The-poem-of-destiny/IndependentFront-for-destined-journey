<script setup lang="ts">
/**
 * 🖼 图像生成分区（第 13 分区，设计 §11）—— 壳层，三张卡。
 *
 * **为什么是自己的分区，不是 Agent 分区里的一个类目**（D50，这条推翻过一次）：
 * 类目方案要往 Agent 子导航里塞两个**不是 LLM Agent** 的条目，而子导航的角标读的是
 * 每 Agent 的 LLM 设置袋（`agentModelOf`），那两条在里面永远没有 `model` → 永久挂红叉。
 * 为了让它「看起来像 agent」去改一个本来只服务 LLM Agent 的导航，而它本来就不是
 * 一个 agent —— 它是含**两次不同调用**的子系统（LLM 出标签、NAI 出图）。
 * 于是：分区归分区，agent 归 agent，`agent-list.ts` 一个字都不用动。
 *
 * 三张卡对应**三处不同的存储**（D51/D52）：
 *   · 提示词生成 → `agents` 袋子（`agent-settings.ts`）
 *   · 出图       → `UiSettings`
 *   · 视觉预设   → Dexie `imagePresets`
 * 前两张正好是**两个花钱的地方**（LLM token / Anlas）。
 *
 * 🔴 **单根** `<section class="section centered">`：`.centered`（780px 居中）是
 *    SettingsPage 的 scoped 规则，只够得到子组件的**根节点**。多根 fragment 会让它
 *    命不中，本分区在宽屏下摊满整行 —— ApiSection 在真机走查里正是栽在这条。
 */
import ImagePromptCard from './ImagePromptCard.vue';
import ImageRenderCard from './ImageRenderCard.vue';
import ImagePresetList from './ImagePresetList.vue';
</script>

<template>
  <section class="section centered">
    <h3>图像生成</h3>
    <p class="section-desc">
      给正文里值得记住的时刻配一张插画。两步：先让一个 LLM 把中文场景转成 danbooru
      标签，再把标签发给 NovelAI 出图 —— 下面三张卡正好对应这两步和它们共用的外观设定。
    </p>

    <div class="image-cards">
      <ImagePromptCard />
      <ImageRenderCard />
      <ImagePresetList />
    </div>
  </section>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-cards {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xl);
}
</style>
