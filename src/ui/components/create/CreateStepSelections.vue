<script setup lang="ts">
/**
 * CreateStepSelections — Step 3: 装备/道具/技能选择
 *
 * 布局: 选择区(固定高度,内部滚动) + 伙伴区(下方独立)
 */
import { computed, ref } from 'vue'
import { useCreateStore } from '../../stores/create-store'
import type { CatalogItem } from '@engine/start-catalog'
import CategorySelectionLayout from './CategorySelectionLayout.vue'
import CategoryTabs from './CategoryTabs.vue'
import QualityFilter from './QualityFilter.vue'
import SelectableCard from './SelectableCard.vue'
import SelectedPanel from './SelectedPanel.vue'
import PartnerWorldBookPanel from './PartnerWorldBookPanel.vue'
import CustomItemForm from './CustomItemForm.vue'
import AppButton from '../shared/AppButton.vue'

const store = useCreateStore()
const showCustomForm = ref(false)

function handleCustomSave(item: CatalogItem) {
  if (item.category === 'equipment') store.addEquipment(item)
  else if (item.category === 'item') store.addItem(item)
  else store.addSkill(item)
}
function handleSelect(item: CatalogItem) {
  if (item.category === 'equipment') store.addEquipment(item)
  else if (item.category === 'item') store.addItem(item)
  else store.addSkill(item)
}
function handleRemove(item: CatalogItem) {
  if (item.category === 'equipment') store.removeEquipment(item.id)
  else if (item.category === 'item') store.removeItem(item.id)
  else store.removeSkill(item.id)
}

const sidebarCategories = computed(() => [
  { key: 'equipment', label: '装备', count: store.selectedEquipments.length },
  { key: 'item',      label: '道具', count: store.selectedItems.length },
  { key: 'skill',     label: '技能', count: store.selectedSkills.length },
])

const subCategoryOptions = computed(() => [
  { key: 'all', label: '全部' },
  ...store.subCategories.map(tag => ({ key: tag, label: tag })),
])

const searchText = ref('')

const visiblePool = computed(() => {
  let pool = store.filteredPool
  if (store.subCategoryFilter !== 'all') {
    pool = pool.filter(item => item.tag?.[0] === store.subCategoryFilter)
  }
  if (searchText.value.trim()) {
    const q = searchText.value.trim().toLowerCase()
    pool = pool.filter(item =>
      item.name.toLowerCase().includes(q) ||
      item.tag.some(t => t.toLowerCase().includes(q)) ||
      item.description.toLowerCase().includes(q)
    )
  }
  return pool
})
</script>

<template>
  <section class="step-selections">
    <!-- ====== 上部: 选择区 (固定高度, 内部独立滚动) ====== -->
    <div class="selection-main">
      <CategorySelectionLayout sidebar-width="13em">
        <!-- 左侧: 大分类 + 子分类 -->
        <template #sidebar>
          <div class="sidebar-nav">
            <CategoryTabs
              :categories="sidebarCategories"
              v-model="store.activeCategory"
              variant="vertical"
            />
            <div v-if="subCategoryOptions.length > 1" class="sub-nav">
              <button
                v-for="sc in subCategoryOptions" :key="sc.key"
                class="sub-btn"
                :class="{ active: store.subCategoryFilter === sc.key }"
                @click="store.subCategoryFilter = sc.key"
              >
                {{ sc.label }}
              </button>
            </div>
          </div>
        </template>

        <!-- 工具栏 -->
        <template #toolbar>
          <QualityFilter v-model="store.rarityFilter" />
          <div class="search-box">
            <input v-model="searchText" type="text" placeholder="搜索..." class="search-input" />
            <span v-if="searchText" class="search-clear" @click="searchText = ''">✕</span>
          </div>
        </template>

        <!-- 卡片列表 (内部 overflow-y 滚动) -->
        <template #content>
          <div v-if="visiblePool.length === 0" class="empty">
            {{ searchText ? '无搜索结果' : '该分类暂无物品' }}
          </div>
          <SelectableCard
            v-for="item in visiblePool" :key="item.id"
            :item="item"
            :selected="store.isSelected(item)"
            :disabled="!store.canSelect(item)"
            @select="handleSelect"
            @remove="handleRemove"
          />
        </template>

        <!-- 自定义物品按钮 -->
        <template #extra>
          <AppButton size="sm" variant="ghost" @click="showCustomForm = true">
            ✦ 自定义物品
          </AppButton>
        </template>
      </CategorySelectionLayout>

      <!-- 右侧已选面板 (固定宽度, sticky 顶部) -->
      <div class="selected-sidebar">
        <SelectedPanel
          :equipments="store.selectedEquipments"
          :items="store.selectedItems"
          :skills="store.selectedSkills"
          :equipment-cost="store.equipmentCost"
          :item-cost="store.itemCost"
          :skill-cost="store.skillCost"
          @remove-equipment="(e) => store.removeEquipment(e.id)"
          @remove-item="(i) => store.removeItem(i.id)"
          @remove-skill="(s) => store.removeSkill(s.id)"
        />
      </div>
    </div>

    <!-- ====== 下部: 伙伴 (独立区域, 后面做自己的滚动) ====== -->
    <div class="partner-section">
      <PartnerWorldBookPanel />
    </div>

    <!-- 自定义 Modal -->
    <CustomItemForm :visible="showCustomForm" @save="handleCustomSave" @close="showCustomForm = false" />
  </section>
</template>

<style scoped>
/* ===== 页面整体: 两个独立卡片纵向排列 ===== */
.step-selections {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  max-width: 100%;
}

/* ================================================
   卡片框 ①: 装备选择区
   ================================================ */
.selection-main {
  display: flex;
  gap: var(--theme-spacing-md);
  align-items: stretch;
}

/* ===== 侧栏导航 ===== */
.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 50vh;  /* 和 cat-content 一致, 超出由 sub-nav 滚动 */
  overflow: hidden;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-sm);
}

/* 子分类 (自身可滚动) */
.sub-nav {
  margin-top: var(--theme-spacing-xs);
  padding-top: var(--theme-spacing-xs);
  border-top: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.sub-btn {
  width: 100%;
  min-height: 2em;
  padding: 0.5em 0.8em;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.85em;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 0 var(--theme-radius-sm) var(--theme-radius-sm) 0;
  transition: all var(--theme-transition-fast);
}
.sub-btn:hover {
  color: var(--theme-text-primary);
  background: var(--theme-card-border);
}
.sub-btn.active {
  color: var(--theme-color-primary);
  background: var(--theme-card-border);
  border-left-color: var(--theme-color-primary);
  font-weight: 700;
}

/* ===== 搜索 ===== */
.search-box { position: relative; margin-left: auto; }
.search-input {
  width: 10em;
  padding: 0.35em 1.6em 0.35em 0.6em;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.82em;
  outline: none;
  transition: border-color var(--theme-transition-fast);
}
.search-input::placeholder { color: var(--theme-text-muted); }
.search-input:focus { border-color: var(--theme-color-primary); }
.search-clear {
  position: absolute;
  right: 0.35em;
  top: 50%;
  transform: translateY(-50%);
  cursor: pointer;
  font-size: 0.8em;
  color: var(--theme-text-muted);
}
.search-clear:hover { color: var(--theme-text-primary); }

/* ===== 右侧已选面板 ===== */
.selected-sidebar {
  width: 16em;
  flex-shrink: 0;
  overflow-y: auto;
}

/* ================================================
   卡片框 ②: 伙伴区 (完全独立, 互不干扰)
   ================================================ */
.partner-section {
  flex-shrink: 0;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  padding: var(--theme-spacing-md);
}

/* ===== 空状态 ===== */
.empty {
  text-align: center;
  color: var(--theme-text-muted);
  padding: var(--theme-spacing-xl) 0;
  font-size: 0.85em;
}

/* ===== 响应式 ===== */
@media (max-width: 768px) {
  .selection-main { flex-direction: column; }
  .selected-sidebar { width: 100%; overflow: visible; }
  .sidebar-nav { max-height: none; overflow: visible; }
  .sub-nav { flex-direction: row; flex-wrap: wrap; overflow-y: visible; flex: none; }
  .sub-btn { width: auto; font-size: 0.82em; padding: 0.4em 0.7em; min-height: 1.8em; border-left: none; border-bottom: 2px solid transparent; border-radius: 0; }
  .sub-btn.active { border-left: none; border-bottom-color: var(--theme-color-primary); }
}
</style>
