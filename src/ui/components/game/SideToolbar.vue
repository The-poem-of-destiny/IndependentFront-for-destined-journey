<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useAudioStore } from '../../stores/audio-store';

const game = useGameStore();
const audio = useAudioStore();

/** 播放中给音乐图标一点低幅呼吸（仅 opacity，不碰布局属性） */
const musicPlaying = computed(() => audio.state.music.status === 'playing');

const emit = defineEmits<{
  toolClick: [id: string];
}>();

const allTools = [
  { id: 'items', label: '背包', icon: 'fa-solid fa-box' },
  { id: 'characters', label: '角色', icon: 'fa-solid fa-users' },
  { id: 'quests', label: '任务', icon: 'fa-solid fa-scroll' },
  { id: 'map', label: '地图', icon: 'fa-solid fa-map' },
  { id: 'memory', label: '记忆', icon: 'fa-solid fa-brain' },
  { id: 'plot', label: '剧情', icon: 'fa-solid fa-book-open' },
  { id: 'snapshots', label: '快照', icon: 'fa-solid fa-clock-rotate-left' },
  { id: 'audio', label: '音乐', icon: 'fa-solid fa-music' },
  { id: 'debug', label: '调试', icon: 'fa-solid fa-bug' },
  { id: 'settings', label: '设置', icon: 'fa-solid fa-gear' },
];
// 🔒 P1-14: 调试按钮仅 DEV 构建显示 —— 生产构建不暴露调试面板入口
const tools = computed(() =>
  import.meta.env.DEV ? allTools : allTools.filter((t) => t.id !== 'debug'),
);

function handleClick(id: string) {
  emit('toolClick', id);
}
</script>

<template>
  <nav class="side-toolbar" :class="{ collapsed: game.sidebarCollapsed }">
    <button
      v-for="tool in tools"
      :key="tool.id"
      class="tool-btn"
      :data-tool="tool.id"
      :title="tool.label"
      :aria-label="tool.label"
      @click="handleClick(tool.id)"
    >
      <i :class="[tool.icon, { breathing: tool.id === 'audio' && musicPlaying }]" />
      <span v-show="!game.sidebarCollapsed" class="tool-label">{{ tool.label }}</span>
    </button>
    <button
      class="collapse-toggle"
      :title="game.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
      :aria-expanded="!game.sidebarCollapsed"
      :aria-label="game.sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
      @click="game.toggleSidebar()"
    >
      {{ game.sidebarCollapsed ? '▶' : '◀' }}
    </button>
  </nav>
</template>

<style scoped>
/* 宽度由 GamePage 的 --rail-w 统一供给（展开 4.2rem / 折叠 1.925rem，较原先各收窄 30%），
   ScenePanel 读同一个变量补足左侧 25%，两边不会算岔。
   刻意不做 width 过渡 —— design.md §1 禁止布局属性过渡，且渐变宽度会与
   ScenePanel 的 calc 瞬时值脱节，折叠瞬间出现缝。 */
.side-toolbar {
  display: flex;
  flex-direction: column;
  width: var(--rail-w, 4.2rem);
  flex-shrink: 0;
  background: var(--theme-tab-bar-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 24px 0 8px;
  gap: 4px;
  overflow-y: auto;
}
/* 收窄后横排放不下「图标 + 两字标签」，改为图标在上标签在下 */
.tool-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 7px 2px;
  border: none;
  background: none;
  color: var(--theme-tab-text);
  font-size: 0.875rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: 6px;
  margin: 0 4px;
  transition:
    background 100ms,
    color 100ms;
}
.side-toolbar.collapsed .tool-btn {
  padding: 8px 2px;
  margin: 0 2px;
}
.tool-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-tab-active-text);
}
.tool-btn i {
  width: 1rem;
  text-align: center;
  font-size: 0.9rem;
  flex-shrink: 0;
}
/* 播放中的低幅呼吸 — 只动 opacity，不动布局 */
.tool-btn i.breathing {
  color: var(--theme-primary);
  animation: mini-breathe 2.4s ease-in-out infinite;
}
@keyframes mini-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
@media (prefers-reduced-motion: reduce) {
  .tool-btn i.breathing {
    animation: none;
    opacity: 1;
  }
}
.tool-label {
  white-space: nowrap;
  overflow: hidden;
}
.collapse-toggle {
  margin: auto 4px 0;
  padding: 8px 2px;
  border: none;
  border-top: 1px solid var(--theme-card-border);
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  font-family: inherit;
}
.collapse-toggle:hover {
  color: var(--theme-text-secondary);
}
</style>
