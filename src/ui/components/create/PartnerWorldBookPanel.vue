<script setup lang="ts">
/**
 * PartnerWorldBookPanel — 伙伴 & 背景预览面板 (Step 3 底部)
 *
 * 紧凑显示当前已选的背景故事，未选时提示用户到 Step 4 选择。
 */
import { computed } from 'vue'
import { useCreateStore } from '../../stores/create-store'

const store = useCreateStore()

/** 是否有已选背景 */
const hasBackground = computed(() => store.selectedBackground !== null)

/** 背景描述截断 (最多显示前 120 字) */
const bgSnippet = computed(() => {
  const text = store.selectedBackground?.description ?? ''
  return text.length > 120 ? text.slice(0, 120) + '…' : text
})
</script>

<template>
  <div class="partner-panel">
    <h3 class="pp-title">✦ 开局 & 背景</h3>

    <!-- 已选背景 -->
    <div v-if="hasBackground" class="pp-bg-info">
      <div class="pp-bg-name">{{ store.selectedBackground?.name }}</div>
      <p class="pp-bg-desc">{{ bgSnippet }}</p>
      <div class="pp-bg-meta">
        <span v-if="store.selectedBackground?.requiredRace" class="pp-meta-tag met">
          🧬 {{ store.selectedBackground?.requiredRace }}
        </span>
        <span v-if="store.selectedBackground?.requiredIdentity" class="pp-meta-tag met">
          🎭 {{ store.selectedBackground?.requiredIdentity }}
        </span>
        <span v-if="store.selectedBackground?.requiredLocation" class="pp-meta-tag met">
          📍 {{ store.selectedBackground?.requiredLocation }}
        </span>
        <span v-if="store.selectedBackground?.requiredDestinyCore" class="pp-meta-tag met">
          ⭐ {{ store.selectedBackground?.requiredDestinyCore }}
        </span>
        <span v-if="!store.selectedBackground?.requiredRace && !store.selectedBackground?.requiredIdentity && !store.selectedBackground?.requiredLocation && !store.selectedBackground?.requiredDestinyCore" class="pp-meta-tag universal">
          通用开局
        </span>
      </div>
    </div>

    <!-- 未选 -->
    <div v-else class="pp-empty">
      <p>尚未选择角色背景故事。</p>
      <p class="pp-hint">你可以在 <strong>第 4 步 · 背景故事</strong> 中从 50+ 个预设开局中选择，或自定义你的故事。</p>
    </div>

    <!-- 伙伴占位 (预留) -->
    <div class="pp-partner-placeholder">
      <div class="pp-divider"></div>
      <p class="pp-placeholder-text">✦ 伙伴角色将在游戏开始后随剧情引入 ✦</p>
    </div>
  </div>
</template>

<style scoped>
.partner-panel {
  font-size: 0.85em;
}

.pp-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.05em;
  margin: 0 0 var(--theme-spacing-sm);
}

/* ===== 已选背景 ===== */
.pp-bg-info {
  padding: var(--theme-spacing-sm);
  border-left: 3px solid var(--theme-color-primary);
  background: color-mix(in srgb, var(--theme-color-primary) 5%, transparent);
  border-radius: 0 var(--theme-radius-sm) var(--theme-radius-sm) 0;
}
.pp-bg-name {
  color: var(--theme-text-primary);
  font-weight: 700;
  font-size: 0.95em;
}
.pp-bg-desc {
  color: var(--theme-text-secondary);
  font-size: 0.8em;
  line-height: 1.5;
  margin: 0.3em 0;
}
.pp-bg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3em;
  margin-top: 0.4em;
}
.pp-meta-tag {
  display: inline-block;
  padding: 0.1em 0.5em;
  border-radius: var(--theme-radius-sm);
  font-size: 0.75em;
  border: 1px solid;
}
.pp-meta-tag.met {
  background: rgba(76, 175, 80, 0.08);
  color: #4caf50;
  border-color: rgba(76, 175, 80, 0.25);
}
.pp-meta-tag.universal {
  background: rgba(158, 158, 158, 0.08);
  color: var(--theme-text-muted);
  border-color: var(--theme-card-border);
}

/* ===== 未选 ===== */
.pp-empty {
  text-align: center;
  padding: var(--theme-spacing-sm) 0;
  color: var(--theme-text-muted);
}
.pp-hint {
  font-size: 0.8em;
  margin-top: 0.3em;
}

/* ===== 伙伴占位 ===== */
.pp-partner-placeholder {
  margin-top: var(--theme-spacing-sm);
}
.pp-divider {
  border-top: 1px solid var(--theme-card-border);
  margin-bottom: var(--theme-spacing-sm);
}
.pp-placeholder-text {
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.75em;
  font-style: italic;
}
</style>
