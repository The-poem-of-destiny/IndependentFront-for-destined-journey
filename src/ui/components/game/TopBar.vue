<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../../stores/game-store';

const game = useGameStore();

/**
 * 游戏页**唯一**的常驻入口按钮（2026-09-13）：原来的「← 首页」「设置」「全屏」三颗
 * 一并搬进 `GameMenu` 二级菜单 —— 顶栏只留这颗按钮，点它或按 Esc 呼出菜单。
 * 把入口收敛成一颗的理由：退出/设置是**离开当前叙事**的操作，和全屏一样不属于
 * 常用动线，常驻在顶栏上既占位又容易被误触。
 */
const emit = defineEmits<{ openMenu: [] }>();

const turnCount = computed(() => {
  const last = [...game.messages]
    .reverse()
    .find((m) => m.role === 'user' || m.role === 'assistant');
  return last?.turn ?? 0;
});
</script>

<template>
  <div class="top-bar">
    <!-- 左: 存档名 -->
    <div class="top-left">
      <span class="top-save-name" :title="game.activeSave?.name ?? '冒险之途'">
        {{ game.activeSave?.name ?? '冒险之途' }}
      </span>
    </div>

    <!-- 中: 轮数 -->
    <span class="top-title">
      <span class="top-title-rule" aria-hidden="true" />
      <span class="top-title-text">第 {{ turnCount }} 轮对话</span>
      <span class="top-title-rule" aria-hidden="true" />
    </span>

    <!-- 右: 统一入口（菜单入口；内部条目见 GameMenu） -->
    <div class="top-right">
      <button
        class="top-btn menu-btn"
        title="游戏菜单（Esc）"
        aria-haspopup="dialog"
        @click="emit('openMenu')"
      >
        <i class="fa-solid fa-bars" aria-hidden="true" />
        菜单
      </button>
    </div>
  </div>
</template>

<style scoped>
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 2.75rem;
  padding: 0 12px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.top-left,
.top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.top-btn {
  background: none;
  border: none;
  color: var(--theme-title-bar-icon);
  font-size: 0.8125rem;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  transition: background 150ms;
  font-family: inherit;
  flex-shrink: 0;
}
.top-btn:hover {
  background: var(--theme-title-bar-btn-hover);
}
.menu-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.top-save-name {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  letter-spacing: 0.08em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 14rem;
}
.top-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.top-title-text {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.12em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.top-title-rule {
  width: 2.5rem;
  height: 1px;
  flex-shrink: 0;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--theme-primary) 45%, transparent),
    transparent
  );
}

@media (max-width: 720px) {
  .top-title {
    display: none;
  }
  .top-save-name {
    max-width: 8rem;
  }
}
</style>
