<script setup lang="ts">
/**
 * 扩展管理页 —— 首页与设置页的统一扩展入口。
 *
 * 插件（第三方插件系统，设计 §3.3）的发现、安装、自检与按存档启用归本页的「插件管理」一节
 * （PluginManagerSection，替换了原来的「原版扩展」占位卡）；社区扩展的按存档启用设置也归本页，
 * WorkshopPage 只承担浏览、安装、更新、卸载与投稿等社区生命周期能力。
 *
 * 📌 2026-11-14（W-01）：工坊锁定期间（`workshop-lock.ts`），已装项目的本地卸载
 * 由 InstalledExtensionList 承担；`workshop.init()` 失败时显示错误态与重试，
 * 不再永远停在「正在读取…」。
 */
import { computed, onMounted } from 'vue';
import AppButton from '../shared/AppButton.vue';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import CommunityExtensionSettings from './CommunityExtensionSettings.vue';
import InstalledExtensionList from './InstalledExtensionList.vue';
import PluginManagerSection from './PluginManagerSection.vue';
import { WORKSHOP_LOCKED } from './workshop-lock';

const ui = useUIStore();
const workshop = useWorkshopStore();

const installedSummary = computed(() => {
  if (workshop.ready) return `已安装 ${workshop.projects.length} 项`;
  if (workshop.initError) return '已安装项目读取失败';
  return '正在读取已安装项目…';
});

const showInstalledList = computed(() => workshop.ready && workshop.projects.length > 0);

function loadWorkshop() {
  workshop.init().catch(() => {
    /* 原因记在 workshop.initError，模板据此显示错误态 */
  });
}

onMounted(loadWorkshop);

function goBack() {
  ui.back('home');
}
</script>

<template>
  <div class="extension-page">
    <header class="extension-topbar">
      <AppButton variant="ghost" size="sm" @click="goBack">← 返回</AppButton>
      <h2 class="extension-title">扩展管理</h2>
    </header>

    <main class="extension-main">
      <p class="extension-intro">
        在这里统一管理扩展的启用状态与相关设置。创意工坊只负责发现、安装和维护社区项目。
      </p>

      <section class="extension-section" aria-labelledby="plugin-section-title">
        <h3 id="plugin-section-title" class="extension-section-title">插件管理</h3>
        <PluginManagerSection />
      </section>

      <section class="extension-section" aria-labelledby="community-extension-title">
        <h3 id="community-extension-title" class="extension-section-title">社区扩展管理</h3>
        <!--
          锁定状态读 workshop-lock.ts 的 WORKSHOP_LOCKED（与首页按钮同源）。
          锁定期间不绑定任何导航；解锁时在这里接回 ui.navigate('workshop')。
        -->
        <article
          v-if="WORKSHOP_LOCKED"
          class="extension-card extension-card-locked"
          aria-disabled="true"
          data-testid="workshop-entry"
        >
          <div class="extension-icon extension-icon-community" aria-hidden="true">
            <i class="fa-solid fa-puzzle-piece"></i>
          </div>
          <div class="extension-copy">
            <div class="extension-name-row">
              <h4>创意工坊</h4>
              <span class="extension-badge">暂未开放</span>
            </div>
            <p>前往创意工坊浏览、安装、更新、卸载与投稿社区项目。</p>
            <span class="extension-meta">{{ installedSummary }}</span>
          </div>
          <AppButton variant="secondary" size="sm" disabled>
            进入创意工坊
            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          </AppButton>
          <div class="extension-entry-mask" data-testid="workshop-entry-mask">
            <i class="fa-solid fa-lock" aria-hidden="true"></i>
            <span>创意工坊暂未开放</span>
          </div>
        </article>

        <div
          v-if="workshop.initError && !workshop.ready"
          class="extension-error"
          role="alert"
          data-testid="workshop-init-error"
        >
          <span>读取已安装的社区扩展失败：{{ workshop.initError }}</span>
          <AppButton variant="secondary" size="sm" @click="loadWorkshop">重试</AppButton>
        </div>

        <InstalledExtensionList v-if="showInstalledList" />

        <CommunityExtensionSettings />
      </section>
    </main>
  </div>
</template>

<style scoped>
.extension-page {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--theme-window-bg);
}

.extension-topbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-xl);
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
}

.extension-title {
  flex: 1;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.3rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--theme-text-primary);
}

.extension-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--theme-spacing-xl);
  width: min(100%, 900px);
  margin: 0 auto;
  padding: var(--theme-spacing-xl);
}

.extension-intro {
  margin: 0;
  padding-bottom: var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  line-height: 1.7;
}

.extension-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

.extension-section-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  font-weight: 600;
}

.extension-section-title::after {
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
  content: '';
}

.extension-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-lg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
}

.extension-card-locked {
  position: relative;
  overflow: hidden;
}

/*
 * 工坊入口暂停开放：蒙版覆盖整张卡片，既保留原入口的说明，也明确告诉玩家
 * 为什么点不进去。真正阻止键盘/鼠标操作的是底层按钮的 disabled 与已移除的导航绑定，
 * 蒙版只负责呈现；不要只靠 pointer-events 当权限边界。
 */
.extension-entry-mask {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  background: color-mix(in srgb, var(--theme-window-bg) 58%, transparent);
  backdrop-filter: blur(2px);
  color: var(--theme-text-secondary);
  cursor: not-allowed;
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  user-select: none;
}

.extension-entry-mask i {
  color: var(--theme-text-muted);
  font-size: 0.9375rem;
}

.extension-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 1rem;
}

.extension-icon-community {
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-primary);
}

.extension-copy {
  min-width: 0;
}

.extension-name-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-sm);
}

.extension-name-row h4 {
  margin: 0;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
}

.extension-copy p {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.extension-badge {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  font-size: 0.6875rem;
  font-weight: 600;
}

.extension-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-lg);
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  color: var(--theme-error);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.extension-meta {
  display: inline-block;
  margin-top: var(--theme-spacing-sm);
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

@media (max-width: 640px) {
  .extension-topbar,
  .extension-main {
    padding: var(--theme-spacing-md);
  }

  .extension-card {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .extension-card > :last-child {
    grid-column: 1 / -1;
    justify-self: stretch;
  }
}
</style>
