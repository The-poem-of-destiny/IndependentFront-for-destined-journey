<script setup lang="ts">
/**
 * CombatMessageFlow — 战斗消息流（M5 前端战斗面板子组件 P3）
 *
 * 职责: 渲染战斗消息流（时间顺序），包含三种 entry：
 *   - round_divider: 居中装饰线 "── 第 N 回合 ──"
 *   - narrative:     叙事气泡（agent 每回合叙事），用 useBeautify.beautifyPlain 美化
 *   - action:        动作结果卡片，渲染 <CombatActionCard>
 *
 * 这是战斗面板的主区域（flex:1），自动滚到底。
 *
 * @see docs/planning/2026-07-29-combat-v2-m5-plan.md §2.3
 * @see src/ui/components/game/ChatFlow.vue 叙事气泡样式参考
 */
import { ref, watch, nextTick } from 'vue'
import type { CombatLogEntry } from '../../../stores/game-store'
import { useBeautify } from '../../../composables/useBeautify'
import CombatActionCard from './CombatActionCard.vue'

const props = defineProps<{
  entries: CombatLogEntry[]
}>()

const { beautifyPlain } = useBeautify()

/* ── 自动滚到底（参考 ChatFlow.vue watch 写法） ── */
const container = ref<HTMLDivElement>()

watch(
  () => props.entries.length,
  () => {
    nextTick(() => {
      if (container.value) {
        container.value.scrollTop = container.value.scrollHeight
      }
    })
  },
)
</script>

<template>
  <div class="combat-message-flow">
    <div ref="container" class="combat-messages">
      <!-- 空态（design.md §5.2） -->
      <div v-if="entries.length === 0" class="empty-tab">
        战斗即将开始…
      </div>

      <template v-for="entry in entries" :key="entry.id">
        <!-- 回合分隔线 -->
        <div
          v-if="entry.kind === 'round_divider'"
          class="round-divider"
          role="separator"
          :aria-label="`第 ${entry.round ?? '?'} 回合`"
        >
          <span class="round-divider-text">第 {{ entry.round ?? '?' }} 回合</span>
        </div>

        <!-- 叙事气泡 -->
        <div
          v-else-if="entry.kind === 'narrative'"
          class="bubble-row bubble-row-narrative"
        >
          <div class="bubble bubble-narrative-full">
            <div
              class="narrative-body"
              v-html="beautifyPlain(entry.text ?? '')"
            />
          </div>
        </div>

        <!-- 动作结果卡片 -->
        <div
          v-else-if="entry.kind === 'action'"
          class="bubble-row bubble-row-action"
        >
          <CombatActionCard
            :result="entry.result"
            :tool-name="entry.toolName"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.combat-message-flow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.combat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--theme-spacing-lg, 20px) 20px 28px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* ===== 空态（design.md §5.2） ===== */
.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  margin: auto 0;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}

/* ===== 回合分隔线 ===== */
.round-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 4px 0;
  font-size: 0.75rem;
  letter-spacing: 0.05em;
  color: var(--theme-text-muted);
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  position: relative;
}
/* 两侧渐变线（::before 左 / ::after 右） */
.round-divider::before,
.round-divider::after {
  content: '';
  flex: 1;
  max-width: 160px;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--theme-text-muted) 40%, transparent),
    transparent
  );
}
.round-divider::before {
  background: linear-gradient(
    to left,
    color-mix(in srgb, var(--theme-text-muted) 40%, transparent),
    transparent
  );
}
.round-divider-text {
  white-space: nowrap;
  opacity: 0.85;
}

/* ===== 消息行入场动画 ===== */
.bubble-row {
  display: flex;
  animation: combat-msg-enter 0.35s ease both;
}
@keyframes combat-msg-enter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bubble-row {
    animation: none;
  }
}

/* 叙事行 + 动作行均居中 */
.bubble-row-narrative,
.bubble-row-action {
  justify-content: center;
}

/* ===== 叙事气泡（参考 ChatFlow .bubble-narrative-full） ===== */
.bubble {
  width: 100%;
  max-width: 70ch;
  padding: 4px 8px;
  border-radius: var(--theme-radius-md, 8px);
  font-size: 0.9375rem;
  line-height: 1.8;
  text-align: left;
}
.bubble-narrative-full {
  /* 书页而非卡片: 无边框无底色，靠留白与衬线成页 */
  background: transparent;
  color: var(--theme-text-primary);
}

/* 叙事正文段落（design.md §2.5 首行缩进） */
.narrative-body {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  color: var(--theme-text-primary);
  line-height: 1.8;
  text-wrap: pretty;
}
.narrative-body :deep(p) {
  text-indent: 2em;
  margin: 0 0 0.6em;
}
.narrative-body :deep(p:last-child) {
  margin-bottom: 0;
}
/* 对话卡片内的段落不缩进 */
.narrative-body :deep(.dialogue-body p) {
  text-indent: 0;
}

/* ===== 动作卡片行 ===== */
.bubble-row-action {
  /* CombatActionCard 自身控制宽度（max-width 72ch 级别） */
}
</style>
