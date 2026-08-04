<script setup lang="ts">
/**
 * 记忆 & 缓存分区 —— 五个直接绑到 settings 的输入框（Q-25 从 SettingsPage.vue 抽出）
 *
 * 一行自有 CSS 都没有: 整段只用共用外壳（form-grid / form-label / form-input /
 * form-hint），见 settings-chrome.css。
 */
import AppCard from '../shared/AppCard.vue';
import { useSettingsStore } from '../../stores/settings-store';

const s = useSettingsStore().settings;
</script>

<template>
  <section class="section centered">
    <h3>记忆 & 缓存设置</h3>
    <p class="section-desc">
      控制 Embedding 召回、记忆压缩和缓存策略。Embedding 端点请在「API
      配置」中添加（推荐硅基流动）。
    </p>
    <AppCard padding="md"
      ><div class="form-grid">
        <label class="form-label"
          >每轮最大召回记忆数
          <p class="form-hint">每次对话时从记忆库中召回的最多条目数</p>
          <input
            v-model.number="s.memoryRecallCount"
            type="number"
            min="5"
            max="50"
            class="form-input"
        /></label>
        <label class="form-label"
          >压缩阈值（轮）
          <p class="form-hint">超过此轮数后，早期记忆会被压缩为摘要</p>
          <input
            v-model.number="s.memoryCompressionThreshold"
            type="number"
            min="50"
            max="500"
            class="form-input"
        /></label>
        <label class="form-label"
          >每存档最大快照数
          <p class="form-hint">超过上限后最旧的快照会被自动删除</p>
          <input
            v-model.number="s.memorySnapshotLimit"
            type="number"
            min="10"
            max="50"
            class="form-input"
        /></label>
        <label class="form-label"
          >快照保留模式
          <p class="form-hint">
            阶梯式=最近5回合每轮留档 + 更早的按 4/8/10
            回合稀疏保留（推荐）；密集=每轮都留，更早的优先淘汰
          </p>
          <select v-model="s.snapshotRetentionMode" class="form-input">
            <option value="tiered">阶梯式（推荐）</option>
            <option value="dense">密集（每轮都留）</option>
          </select></label
        >
        <label class="form-label"
          >缓存策略
          <p class="form-hint">影响 API 调用的 Prompt 缓存利用率</p>
          <select v-model="s.memoryCacheStrategy" class="form-input">
            <option value="aggressive">激进 — 尽可能缓存，高命中率</option>
            <option value="balanced">平衡 — 兼顾缓存命中与资源消耗</option>
            <option value="conservative">保守 — 最小缓存，适合低内存设备</option>
          </select></label
        >
      </div></AppCard
    >
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>
