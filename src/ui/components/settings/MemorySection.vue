<script setup lang="ts">
/**
 * 记忆 & 缓存分区 —— 五个直接绑到 settings 的输入框（Q-25 从 SettingsPage.vue 抽出）
 *
 * 一行自有 CSS 都没有: 整段只用共用外壳（form-grid / form-label / form-input /
 * form-hint），见 settings-chrome.css。
 */
import { onMounted } from 'vue';
import AppCard from '../shared/AppCard.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useApiSourceStore } from '../../stores/api-source-store';

const s = useSettingsStore().settings;
const apiSources = useApiSourceStore();

onMounted(() => void apiSources.initialize());
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
          >召回模式
          <p class="form-hint">
            LLM 沿用 memory_recall Agent；Embedding 使用下方明确绑定的向量源。
          </p>
          <select v-model="s.memoryRecallMode" class="form-input">
            <option value="llm">LLM 召回（兼容模式）</option>
            <option value="embedding">Embedding 向量召回</option>
          </select></label
        >
        <label v-if="s.memoryRecallMode === 'embedding'" class="form-label"
          >Embedding 源
          <p class="form-hint">写入与查询共用同一来源；绑定失效时只做本地兜底，不会换到别家。</p>
          <select v-model="s.embeddingSourceId" class="form-input">
            <option value="">（未选择）</option>
            <option
              v-for="source in apiSources.embeddingSources"
              :key="source.id"
              :value="source.id"
            >
              {{ source.name }} · {{ source.defaultModel }}
            </option>
          </select></label
        >
        <label v-if="s.memoryRecallMode === 'embedding'" class="form-label"
          >Reranker 源（可选）
          <p class="form-hint">先取候选池再重排；上游失败时保留原候选顺序。</p>
          <select v-model="s.rerankerSourceId" class="form-input">
            <option value="">关闭重排</option>
            <option
              v-for="source in apiSources.rerankerSources"
              :key="source.id"
              :value="source.id"
            >
              {{ source.name }} · {{ source.defaultModel }}
            </option>
          </select></label
        >
        <label v-if="s.memoryRecallMode === 'embedding'" class="form-label"
          >候选记忆数
          <p class="form-hint">必须不小于最终召回数；默认取最终数量的三倍。</p>
          <input
            v-model.number="s.memoryCandidateCount"
            type="number"
            :min="s.memoryRecallCount"
            max="100"
            class="form-input"
        /></label>
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
