<script setup lang="ts">
/**
 * 关于分区 —— 零状态，纯展示（Q-25 从 SettingsPage.vue 抽出）
 *
 * 这里的三张表是**手写常量**，不是从构建期喂进来的：改版本号/测试数还是要来改这个
 * 文件。之所以没顺手接上真实来源，是因为那是新功能而不是这次搬迁的一部分。
 */
import AppCard from '../shared/AppCard.vue';
import { VERSION } from '@engine/index';
</script>

<template>
  <section class="section centered">
    <h3>关于命定之诗</h3>
    <div class="about-grid">
      <AppCard padding="md"
        ><h4>引擎信息</h4>
        <div class="about-table">
          <div class="about-row">
            <span>引擎版本</span><span>{{ VERSION }}</span>
          </div>
          <div class="about-row"><span>UI 版本</span><span>1.0.0</span></div>
          <div class="about-row"><span>构建时间</span><span>2026-06-15</span></div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>技术栈</h4>
        <div class="about-table">
          <div class="about-row"><span>框架</span><span>Vue 3.5 + Pinia 2</span></div>
          <div class="about-row"><span>构建</span><span>Vite 6</span></div>
          <div class="about-row"><span>数据库</span><span>Dexie.js (IndexedDB)</span></div>
          <div class="about-row"><span>语言</span><span>TypeScript 5.4</span></div>
        </div></AppCard
      ><AppCard padding="md"
        ><h4>引擎统计</h4>
        <div class="about-table">
          <div class="about-row"><span>引擎模块</span><span>41 模块</span></div>
          <div class="about-row"><span>单元测试</span><span>1978 tests</span></div>
          <div class="about-row"><span>主题</span><span>10 套</span></div>
          <div class="about-row"><span>纪元</span><span>复兴纪元</span></div>
        </div></AppCard
      >
    </div>
    <p class="text-muted text-sm text-center" style="margin-top: 16px">
      《命定之诗》Fated Poem — 多 Agent 协作文字 RPG 引擎<br />© 2026 命定之诗创作组
    </p>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
/* About */
.about-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.about-grid h4 {
  margin: 0 0 10px;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--theme-card-border);
}
.about-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.about-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.85rem;
  color: var(--theme-text-primary);
}
.about-row span:first-child {
  color: var(--theme-text-muted);
}
</style>
