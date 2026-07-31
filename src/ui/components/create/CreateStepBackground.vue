<script setup lang="ts">
/**
 * CreateStepBackground — Step 4: 背景故事
 *
 * 对齐原版 custom_start_index.html 的四分类侧栏体系:
 * - 左侧: 通用开局/身份限定/种族限定/地区限定 四分类
 * - 右侧: 背景卡片列表 (带条件徽章+禁用态)
 * - 自定义背景独立面板在列表下方，点击即选中（取消预设）
 */
import { computed } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import CategorySelectionLayout from './CategorySelectionLayout.vue';
import CategoryTabs from './CategoryTabs.vue';
import BackgroundList from './BackgroundList.vue';

const store = useCreateStore();

/** 侧栏四分类 (带已选计数) */
const sidebarCategories = computed(() =>
  store.backgroundCategories.map((c) => ({
    key: c.key,
    label: c.label,
    count: c.count,
  })),
);

/** 当前选中背景 */
const currentBg = computed({
  get: () => store.selectedBackground,
  set: (bg) => store.selectBackground(bg),
});

/** 自定义背景是否处于激活态（无预设选中） */
const isCustomActive = computed(() => store.selectedBackground === null);

/** 点击或聚焦自定义面板 → 取消预设选中 */
function activateCustom() {
  store.selectBackground(null);
}
</script>

<template>
  <section class="step-bg">
    <h2 class="step-title">背景故事</h2>
    <p class="step-desc">
      选择一个预设背景，或自定义你的角色故事。有限定条件的背景会自动分类到对应侧栏。
    </p>

    <CategorySelectionLayout sidebar-width="8em">
      <!-- 左侧: 四分类导航 -->
      <template #sidebar>
        <CategoryTabs
          :categories="sidebarCategories"
          :model-value="store.activeBackgroundCategory"
          variant="vertical"
          @update:model-value="
            store.activeBackgroundCategory = $event as
              'race' | 'identity' | 'location' | 'universal'
          "
        />
      </template>

      <!-- 右侧: 背景卡片列表 -->
      <template #content>
        <BackgroundList
          v-model="currentBg"
          :backgrounds="store.filteredBackgrounds"
          :character-race="store.race"
          :character-identity="store.identity"
          :character-location="store.startLocation"
          :destiny-core-name="store.destinyCore?.name ?? ''"
        />
      </template>
    </CategorySelectionLayout>

    <!-- 自定义背景 — 独立面板，点击即选中（取消预设） -->
    <div class="custom-bg-section" :class="{ active: isCustomActive }" @click="activateCustom">
      <div class="custom-bg-header">
        <h3 class="custom-bg-title">✎ 自定义背景故事</h3>
        <span v-if="isCustomActive" class="custom-bg-badge">使用中</span>
        <span v-else class="custom-bg-hint-text">点击此处即可切换为自定义背景</span>
      </div>
      <textarea
        :value="store.customBackgroundText"
        placeholder="在此自由书写你的角色背景故事…"
        rows="6"
        class="custom-bg-textarea"
        @input="store.customBackgroundText = ($event.target as HTMLTextAreaElement).value"
        @focus="activateCustom"
      ></textarea>
    </div>
  </section>
</template>

<style scoped>
.step-bg {
  max-width: 100%;
}
.step-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  margin-bottom: var(--theme-spacing-xs);
}
.step-desc {
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  margin-bottom: var(--theme-spacing-lg);
}
/* ===== 自定义背景独立面板 ===== */
.custom-bg-section {
  margin-top: var(--theme-spacing-lg);
  padding: var(--theme-spacing-md);
  border: 2px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}
.custom-bg-section:hover {
  border-color: color-mix(in srgb, var(--theme-color-primary) 40%, var(--theme-card-border));
}
/* 活跃态 — 对齐预设卡片的选中样式 */
.custom-bg-section.active {
  border-color: var(--theme-color-primary);
  box-shadow: 0 0 0 1px var(--theme-color-primary);
  background: color-mix(in srgb, var(--theme-color-primary) 5%, var(--theme-card-bg));
}
.custom-bg-header {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-sm);
}
.custom-bg-title {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  margin: 0;
}
.custom-bg-badge {
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--theme-color-primary);
  padding: 1px 8px;
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-color-primary) 15%, transparent);
}
.custom-bg-hint-text {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
}
.custom-bg-textarea {
  width: 100%;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.85em;
  line-height: 1.7;
  resize: vertical;
  font-family: inherit;
}
.custom-bg-textarea:focus {
  outline: none;
  border-color: var(--theme-color-primary);
}
</style>
