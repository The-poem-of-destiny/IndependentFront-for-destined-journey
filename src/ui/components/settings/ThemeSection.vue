<script setup lang="ts">
/**
 * 外观主题分区 —— 10 套主题 + 字体 / 字号 / 悬停延迟 / 减少动态效果
 * （Q-25 从 SettingsPage.vue 抽出）
 */
import AppCard from '../shared/AppCard.vue';
import { useThemeStore } from '../../stores/theme-store';
import { useUIStore } from '../../stores/ui-store';
import { useSettingsStore } from '../../stores/settings-store';

const theme = useThemeStore();
const ui = useUIStore();
const s = useSettingsStore().settings;

function selectTheme(id: string) {
  theme.apply(id);
  ui.toast(`主题：${theme.currentTheme?.nameZh}`, 'success');
}
</script>

<template>
  <section class="section centered">
    <h3>外观主题</h3>
    <p class="section-desc">
      当前：<strong>{{ theme.currentTheme?.nameZh }}</strong
      >（{{
        theme.currentTheme?.type === 'dark'
          ? '深色'
          : theme.currentTheme?.type === 'warm'
            ? '暖色'
            : '浅色'
      }}系）
    </p>
    <div class="theme-grid">
      <button
        v-for="t in theme.THEME_LIST"
        :key="t.id"
        class="theme-option"
        :class="{ 'theme-selected': t.id === theme.current }"
        :style="{ background: t.preview }"
        @click="selectTheme(t.id)"
      >
        <span class="theme-name" :style="{ color: t.type === 'dark' ? '#fff' : '#1a1a1a' }">{{
          t.nameZh
        }}</span
        ><span v-if="t.id === theme.current" class="theme-check">✓</span>
      </button>
    </div>
    <AppCard padding="md" style="margin-top: 16px"
      ><div class="form-grid">
        <label class="form-label"
          >字体风格
          <p class="form-hint">衬线体更有古典文学感，无衬线体更适合长时间阅读</p>
          <select
            class="form-input"
            :value="theme.fonts"
            @change="theme.setFonts(($event.target as HTMLSelectElement).value as any)"
          >
            <option value="sans">无衬线 (Noto Sans SC)</option>
            <option value="serif">衬线 (Noto Serif SC)</option>
            <option value="mixed">混合</option>
          </select></label
        ><label class="form-label"
          >字体大小
          <p class="form-hint">调整所有界面文字大小</p>
          <select
            class="form-input"
            :value="theme.fontSize"
            @change="theme.setFontSize(($event.target as HTMLSelectElement).value)"
          >
            <option value="14">小 (14px)</option>
            <option value="16" selected>默认 (16px)</option>
            <option value="18">大 (18px)</option>
            <option value="20">特大 (20px)</option>
          </select></label
        ><label class="form-label"
          >悬停提示延迟
          <p class="form-hint">
            鼠标停留多久才弹出详情气泡（状态效果、在场角色心声等全站悬停浮层）。键盘聚焦不受此延迟影响，始终即时显示。
          </p>
          <select v-model.number="s.hoverDelayMs" class="form-input">
            <option :value="0">立即</option>
            <option :value="120">快 (120ms)</option>
            <option :value="200">默认 (200ms)</option>
            <option :value="350">慢 (350ms)</option>
            <option :value="500">很慢 (500ms)</option>
          </select></label
        >
        <div class="form-label">
          减少动态效果
          <p class="form-hint">
            关掉卡片入场、骨架屏脉动、折叠展开等过渡动画。若系统已开启「减少动态效果」，
            无需在此重复设置 —— 系统偏好始终独立生效，本开关只是额外强制开启。
          </p>
          <div class="toggle-row">
            <span>{{ s.reducedMotion ? '已开启' : '跟随系统' }}</span>
            <label class="toggle-label">
              <input v-model="s.reducedMotion" type="checkbox" class="toggle-input" />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div></div
    ></AppCard>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* Theme */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 14px;
}
.theme-option {
  position: relative;
  aspect-ratio: 16/10;
  border: 2px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  padding: 10px;
}
.theme-option:hover {
  transform: translateY(-3px);
  box-shadow: 0 6px 20px color-mix(in srgb, #000 25%, transparent);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.theme-selected {
  border-color: var(--theme-primary) !important;
  box-shadow: 0 0 16px color-mix(in srgb, var(--theme-primary) 25%, transparent);
}
.theme-name {
  font-size: 0.75rem;
  font-weight: 700;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  letter-spacing: 0.5px;
}
.theme-check {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  box-shadow: 0 0 8px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}
</style>
