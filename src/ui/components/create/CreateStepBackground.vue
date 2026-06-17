<script setup lang="ts">
/**
 * CreateStepBackground — Step 4: 背景故事
 *
 * 对齐原版 custom_start_index.html 的四分类侧栏体系:
 * - 左侧: 通用开局/身份限定/种族限定/地区限定 四分类
 * - 右侧: 背景卡片列表 (带条件徽章+禁用态)
 * - 自定义背景文本框已内嵌在 BackgroundList 的"自定义开局"卡片中
 */
import { computed } from 'vue'
import { useCreateStore } from '../../stores/create-store'
import CategorySelectionLayout from './CategorySelectionLayout.vue'
import CategoryTabs from './CategoryTabs.vue'
import BackgroundList from './BackgroundList.vue'

const store = useCreateStore()

/** 侧栏四分类 (带已选计数) */
const sidebarCategories = computed(() =>
  store.backgroundCategories.map(c => ({
    key: c.key,
    label: c.label,
    count: c.count,
  }))
)

/** 当前选中背景 */
const currentBg = computed({
  get: () => store.selectedBackground,
  set: (bg) => store.selectBackground(bg),
})
</script>

<template>
  <section class="step-bg">
    <h2 class="step-title">背景故事</h2>
    <p class="step-desc">选择一个预设背景，或自定义你的角色故事。有限定条件的背景会自动分类到对应侧栏。</p>

    <CategorySelectionLayout sidebar-width="8em">
      <!-- 左侧: 四分类导航 -->
      <template #sidebar>
        <CategoryTabs
          :categories="sidebarCategories"
          :model-value="store.activeBackgroundCategory"
          @update:model-value="store.activeBackgroundCategory = $event"
          variant="vertical"
        />
      </template>

      <!-- 右侧: 背景卡片列表 -->
      <template #content>
        <BackgroundList
          :backgrounds="store.filteredBackgrounds"
          v-model="currentBg"
          :character-race="store.race"
          :character-identity="store.identity"
          :character-location="store.startLocation"
          :destiny-core-name="store.destinyCore?.name ?? ''"
        />
      </template>
    </CategorySelectionLayout>
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
</style>
