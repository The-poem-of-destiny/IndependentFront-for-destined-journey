<script setup lang="ts">
/**
 * 扩展管理页 —— 首页与设置页的统一扩展入口。
 *
 * 原版扩展尚无运行时注册表，当前只展示诚实占位；社区扩展的按存档启用设置归本页，
 * WorkshopPage 只承担浏览、安装、更新、卸载与投稿等社区生命周期能力。
 */
import { computed, onMounted } from 'vue';
import AppButton from '../shared/AppButton.vue';
import { useUIStore } from '../../stores/ui-store';
import { useWorkshopStore } from '../../stores/workshop-store';
import CommunityExtensionSettings from './CommunityExtensionSettings.vue';

const ui = useUIStore();
const workshop = useWorkshopStore();

const installedSummary = computed(() =>
  workshop.ready ? `已安装 ${workshop.projects.length} 项` : '正在读取已安装项目…',
);

onMounted(() => {
  void workshop.init();
});

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

      <section class="extension-section" aria-labelledby="builtin-extension-title">
        <h3 id="builtin-extension-title" class="extension-section-title">原版扩展管理</h3>
        <article class="extension-card extension-card-placeholder">
          <div class="extension-icon" aria-hidden="true">
            <i class="fa-solid fa-box-archive"></i>
          </div>
          <div class="extension-copy">
            <div class="extension-name-row">
              <h4>原版扩展</h4>
              <span class="extension-badge">规划中</span>
            </div>
            <p>原版扩展的识别、状态展示与管理功能尚未实现，当前暂留此入口。</p>
          </div>
          <AppButton variant="secondary" size="sm" disabled>暂未开放</AppButton>
        </article>
      </section>

      <section class="extension-section" aria-labelledby="community-extension-title">
        <h3 id="community-extension-title" class="extension-section-title">社区扩展管理</h3>
        <article class="extension-card">
          <div class="extension-icon extension-icon-community" aria-hidden="true">
            <i class="fa-solid fa-puzzle-piece"></i>
          </div>
          <div class="extension-copy">
            <div class="extension-name-row">
              <h4>创意工坊</h4>
              <span class="extension-badge extension-badge-ready">可用</span>
            </div>
            <p>前往创意工坊浏览、安装、更新、卸载与投稿社区项目。</p>
            <span class="extension-meta">{{ installedSummary }}</span>
          </div>
          <AppButton variant="primary" size="sm" @click="ui.navigate('workshop')">
            进入创意工坊
            <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>
          </AppButton>
        </article>

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

.extension-card-placeholder {
  background: color-mix(in srgb, var(--theme-card-bg) 92%, var(--theme-text-muted));
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

.extension-badge-ready {
  border-color: color-mix(in srgb, var(--theme-success) 30%, transparent);
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
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
