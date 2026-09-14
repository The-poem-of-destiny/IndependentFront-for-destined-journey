<script setup lang="ts">
import { ref, watch } from 'vue';
import { useUIStore } from '../../stores/ui-store';
import AppModal from '../shared/AppModal.vue';

/**
 * 游戏页的二级菜单（2026-09-13）。
 *
 * 顶栏此前直接摆着「← 首页」「设置」「全屏」三颗常驻按钮，侧栏底部还另有一颗「设置」，
 * 侧栏中间另有一颗「扩展」—— 现在全部搬进这里，顶栏只留一颗统一入口（点它或按 Esc 呼出）。
 *
 * 「存档管理」打开 App.vue 常驻的应用级窗口，不触发页面导航，也不卸载 GamePage。
 *
 * 📌 2026-09-13 第二版：**全屏项已移除**，原位置换成「扩展」（侧栏那颗一并删掉）。
 * 全屏那项点下去只翻 `game.fullscreenStatus`，而那个布尔值全应用没有第二个读点 ——
 * 摆在这里既骗玩家也占位置。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const ui = useUIStore();

/** 菜单内的两级：主菜单 / 帮助说明。每次重新打开都回到主菜单。 */
const panel = ref<'menu' | 'help'>('menu');
watch(
  () => props.open,
  (open) => {
    if (open) panel.value = 'menu';
  },
);

type MenuAction = 'settings' | 'saves' | 'home' | 'extensions' | 'help';

/**
 * 顺序即**屏上顺序**。
 *
 * 🔴 「扩展」和设置一样是**跨页面导航**，会卸载 GamePage（在飞的生成由 COR-02 那道
 *    abort 收掉）；存档管理则是唯一留在当前页面上方的应用级窗口。
 */
const items: { id: MenuAction; label: string; icon: string; hint: string }[] = [
  { id: 'settings', label: '设置', icon: 'fa-solid fa-gear', hint: 'API / Agent / 主题 / 音频…' },
  {
    id: 'extensions',
    label: '扩展',
    icon: 'fa-solid fa-puzzle-piece',
    hint: '扩展管理 / 创意工坊',
  },
  {
    id: 'saves',
    label: '存档管理',
    icon: 'fa-solid fa-floppy-disk',
    hint: '读取 / 导出 / 删除 / 改名',
  },
  { id: 'home', label: '返回首页', icon: 'fa-solid fa-house', hint: '回到标题画面' },
  {
    id: 'help',
    label: '帮助说明',
    icon: 'fa-solid fa-circle-question',
    hint: '游戏操作与快捷键',
  },
];

function close() {
  emit('close');
}

function run(id: MenuAction) {
  switch (id) {
    case 'settings':
      close();
      ui.navigate('settings');
      return;
    case 'saves':
      close();
      ui.openSaveManager();
      return;
    case 'home':
      close();
      ui.navigate('home');
      return;
    case 'extensions':
      close();
      ui.navigate('extensions');
      return;
    case 'help':
      panel.value = 'help';
  }
}

/** 帮助内容与代码逐条对齐（改键位/交互时两处一起改）。 */
const helpGroups = [
  {
    title: '操作',
    rows: [
      { keys: ['右键消息'], text: '回退本轮 / 回退到这条输入 / 为这一段配图' },
      {
        keys: ['点击侧栏图标'],
        text: '打开背包 / 角色 / 任务 / 地图 / 记忆 / 剧情 / 快照 / 图鉴等面板',
      },
      { keys: ['点击侧栏 ◀ ▶'], text: '折叠或展开左侧工具侧栏' },
      { keys: ['点击轮次上的选项'], text: '把待选行动填进输入框' },
    ],
  },
  {
    title: '快捷键',
    rows: [
      { keys: ['Enter'], text: '发送输入的行动' },
      { keys: ['Shift', 'Enter'], text: '输入框内换行' },
      { keys: ['Esc'], text: '呼出 / 关闭本菜单（有弹窗或浮动卡片时先关掉它们）' },
      { keys: ['Ctrl / ⌘', 'Enter'], text: '战斗中提交行动指令' },
      { keys: ['←', '→'], text: '迷你播放器聚焦进度条或音量条时：快退快进 / 调节音量' },
      { keys: ['Alt', 'Shift', 'D'], text: '调试面板（需开启开发者模式）' },
    ],
  },
];
</script>

<template>
  <AppModal
    :open="props.open"
    :title="panel === 'menu' ? '游戏菜单' : '帮助说明'"
    size="sm"
    closable
    @close="close"
    @update:open="(v: boolean) => !v && close()"
  >
    <div v-if="panel === 'menu'" class="menu-list">
      <button
        v-for="item in items"
        :key="item.id"
        class="menu-item"
        :data-menu="item.id"
        @click="run(item.id)"
      >
        <i :class="item.icon" aria-hidden="true" />
        <span class="menu-item-main">
          <span class="menu-item-label">{{ item.label }}</span>
          <span class="menu-item-hint">{{ item.hint }}</span>
        </span>
      </button>
    </div>

    <div v-else class="help-panel">
      <section v-for="group in helpGroups" :key="group.title" class="help-group">
        <h4 class="help-title">{{ group.title }}</h4>
        <div v-for="row in group.rows" :key="row.text" class="help-row">
          <span class="help-keys">
            <kbd v-for="key in row.keys" :key="key">{{ key }}</kbd>
          </span>
          <span class="help-text">{{ row.text }}</span>
        </div>
      </section>
      <button class="help-back" @click="panel = 'menu'">← 返回菜单</button>
    </div>
  </AppModal>
</template>

<style scoped>
.menu-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  width: 100%;
  padding: var(--theme-spacing-md);
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.menu-item:hover,
.menu-item:focus-visible {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.menu-item i {
  width: 1rem;
  flex-shrink: 0;
  text-align: center;
  font-size: 0.9rem;
  color: var(--theme-primary);
}
.menu-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.menu-item-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.menu-item-hint {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}

.help-panel {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
}
.help-group {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
/* Section 装饰线（design.md §5.1） */
.help-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.help-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.help-row {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-md);
}
.help-keys {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
  min-width: 8.5rem;
  flex-wrap: wrap;
}
kbd {
  padding: 2px 6px;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  white-space: nowrap;
}
.help-text {
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--theme-text-secondary);
}
.help-back {
  align-self: flex-start;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--theme-text-muted);
  background: none;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    color var(--theme-transition-fast),
    background var(--theme-transition-fast);
}
.help-back:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}
</style>
