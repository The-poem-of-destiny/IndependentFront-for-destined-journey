<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { qualityVar } from '../../lib/quality-colors'

const game = useGameStore()

type Category = 'inventory' | 'equipment' | 'skills'
const activeCategory = ref<Category>('inventory')
const activeFilter = ref('全部')
const selectedIdx = ref(0)
const showScripts = ref(false)

const player = computed(() => game.player)

// ═══ 品质推断 ═══
function inferQuality(stats?: Record<string, number>): string {
  if (!stats) return '普通'
  const total = Object.values(stats).reduce((s, v) => s + Math.abs(v), 0)
  if (total >= 50) return '传说'
  if (total >= 30) return '史诗'
  if (total >= 20) return '稀有'
  if (total >= 10) return '优良'
  return '普通'
}

// ═══ 数据 ═══
const inventoryItems = computed(() => player.value?.inventory || [])
const equipmentItems = computed(() => player.value?.equipment || [])
const skillItems = computed(() => player.value?.skills || [])

const currentItems = computed<any[]>(() => {
  switch (activeCategory.value) {
    case 'inventory': return inventoryItems.value
    case 'equipment': return equipmentItems.value
    case 'skills': return skillItems.value
  }
})

const filterOptions = computed(() => {
  const types = new Set<string>()
  for (const item of currentItems.value) {
    const t = activeCategory.value === 'equipment'
      ? item.slot
      : activeCategory.value === 'skills'
        ? (item.type === 'active' ? '主动' : '被动')
        : item.type
    if (t) types.add(t)
  }
  return ['全部', ...Array.from(types)]
})

const filteredItems = computed(() => {
  if (activeFilter.value === '全部') return currentItems.value
  return currentItems.value.filter(item => {
    const t = activeCategory.value === 'equipment'
      ? item.slot : activeCategory.value === 'skills'
        ? (item.type === 'active' ? '主动' : '被动') : item.type
    return t === activeFilter.value
  })
})

const sortedItems = computed(() => {
  const rank: Record<string, number> = { '唯一':7, '神话':6, '传说':5, '史诗':4, '稀有':3, '优良':2, '普通':1 }
  return [...filteredItems.value].sort((a: any, b: any) => {
    const qa = rank[a.rarity || inferQuality(a.stats)] || 0
    const qb = rank[b.rarity || inferQuality(b.stats)] || 0
    return qb - qa || (a.name || '').localeCompare(b.name || '')
  })
})

watch([activeCategory, activeFilter], () => { selectedIdx.value = 0; showScripts.value = false })

// ═══ 选中物品 ═══
const selected = computed(() => sortedItems.value[selectedIdx.value] || null)

const selQuality = computed(() => {
  const item: any = selected.value
  if (!item) return '普通'
  if (activeCategory.value === 'inventory') return item.rarity || '普通'
  if (activeCategory.value === 'skills') return '史诗'
  return inferQuality(item.stats)
})

const selTypeLabel = computed(() => {
  const item: any = selected.value
  if (!item) return ''
  if (activeCategory.value === 'equipment') {
    return item.slot === 'weapon' ? '武器' : item.slot === 'armor' ? '防具' : '饰品'
  }
  if (activeCategory.value === 'skills') return item.type === 'active' ? '主动技能' : '被动技能'
  return item.type || '物品'
})

const selExtra = computed(() => {
  const item: any = selected.value
  if (!item) return ''
  if (activeCategory.value === 'inventory') return `×${item.quantity || 1}`
  if (activeCategory.value === 'equipment') return `${item.durability || '?'}/${item.maxDurability || '?'} 耐久`
  return `Lv.${item.level || 1}${item.cost ? ` · ${item.cost.amount}${item.cost.type}` : ''}`
})

const selEffects = computed(() => (selected.value as any)?.effects as Record<string, string> | undefined)
const selScripts = computed(() => (selected.value as any)?.scripts as Record<string, string> | undefined)
const hasScripts = computed(() => selScripts.value && Object.keys(selScripts.value).length > 0)
</script>

<template>
  <div class="items-panel" v-if="player">
    <!-- 货币 -->
    <div class="money-bar">
      <span class="money-label">持有金币</span>
      <span class="money-value"><i class="fa-solid fa-coins" /> {{ player.money }} G</span>
    </div>

    <!-- 类别切换 -->
    <div class="cat-tabs">
      <button :class="{ active: activeCategory === 'inventory' }" @click="activeCategory = 'inventory'">背包 <span class="badge">{{ inventoryItems.length }}</span></button>
      <button :class="{ active: activeCategory === 'equipment' }" @click="activeCategory = 'equipment'">装备 <span class="badge">{{ equipmentItems.length }}</span></button>
      <button :class="{ active: activeCategory === 'skills' }" @click="activeCategory = 'skills'">技能 <span class="badge">{{ skillItems.length }}</span></button>
    </div>

    <!-- 子分类筛选 -->
    <div class="filter-bar" v-if="filterOptions.length > 2">
      <button v-for="f in filterOptions" :key="f" :class="{ active: activeFilter === f }" @click="activeFilter = f">{{ f }}</button>
    </div>

    <!-- Master-Detail -->
    <div class="master-detail">
      <!-- 左: 列表 -->
      <div class="item-list">
        <div v-if="sortedItems.length === 0" class="empty-list">暂无物品</div>
        <div v-for="(item, i) in sortedItems" :key="(item as any).id || (item as any).itemId || i"
          class="item-row" :class="{ selected: i === selectedIdx }" @click="selectedIdx = i">
          <span class="dot" :style="{ background: qualityVar((item as any).rarity || inferQuality((item as any).stats)) }" />
          <span class="i-name" :style="{ color: qualityVar((item as any).rarity || inferQuality((item as any).stats)) }">{{ (item as any).name }}</span>
          <span class="i-tag">{{ activeCategory === 'equipment' ? ((item as any).slot) : activeCategory === 'skills' ? ((item as any).type === 'active' ? '主动' : '被动') : ((item as any).type) }}</span>
          <span class="i-extra" v-if="activeCategory === 'inventory'">×{{ (item as any).quantity }}</span>
          <span class="i-extra" v-else-if="activeCategory === 'equipment'">[{{ (item as any).slot }}]</span>
          <span class="i-extra" v-else>Lv.{{ (item as any).level }}</span>
        </div>
      </div>

      <!-- 右: 详情 -->
      <div class="detail" v-if="selected">
        <div class="d-header">
          <span class="d-name" :style="{ color: qualityVar(selQuality) }">{{ (selected as any).name }}</span>
          <span class="d-quality" :style="{ color: qualityVar(selQuality), borderColor: qualityVar(selQuality) }">{{ selQuality }}</span>
        </div>
        <div class="d-meta"><span>{{ selTypeLabel }}</span><span>{{ selExtra }}</span></div>

        <!-- 效果词条 -->
        <div class="fx-section" v-if="selEffects && Object.keys(selEffects).length > 0">
          <div class="d-label">效果</div>
          <div v-for="(desc, name) in selEffects" :key="name" class="fx-row">
            <span class="fx-name">{{ name }}</span><span class="fx-desc">{{ desc }}</span>
          </div>
        </div>

        <!-- 描述 -->
        <div class="desc-section" v-if="(selected as any).description">
          <div class="d-label">描述</div>
          <p class="d-desc">{{ (selected as any).description }}</p>
        </div>

        <!-- 脚本 -->
        <div class="script-section">
          <button class="script-toggle" @click="showScripts = !showScripts">📜 {{ showScripts ? '收起脚本' : '查看脚本' }}</button>
          <div class="script-body" v-if="showScripts">
            <template v-if="hasScripts">
              <div v-for="(code, name) in selScripts" :key="name" class="script-block">
                <div class="script-label">{{ name }}</div>
                <pre class="script-code">{{ code }}</pre>
              </div>
            </template>
            <div class="script-empty" v-else>(该物品无脚本效果)</div>
          </div>
        </div>
      </div>
      <div class="detail-empty" v-else>选择一件物品查看详情</div>
    </div>
  </div>
  <div class="empty" v-else>未加载角色数据</div>
</template>

<style scoped>
.items-panel { display: flex; flex-direction: column; gap: 12px; min-height: 37.5rem; }

/* 货币 */
.money-bar { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--theme-surface-muted); border-radius: 6px; }
.money-label { font-size: 0.75rem; color: var(--theme-text-muted); }
.money-value { font-size: 1rem; color: var(--theme-currency-gold, #f3c94f); font-weight: 700; display: flex; align-items: center; gap: 6px; }
.money-value i { font-size: 0.875rem; }

/* 类别 */
.cat-tabs { display: flex; gap: 4px; }
.cat-tabs button { flex: 1; padding: 10px 6px; border: none; background: var(--theme-surface-muted); color: var(--theme-text-secondary); font-size: 0.875rem; cursor: pointer; font-family: inherit; border-radius: 6px; display: flex; align-items: center; justify-content: center; gap: 6px; }
.cat-tabs button.active { background: var(--theme-primary-bg); color: var(--theme-primary-text); font-weight: 600; }
.cat-tabs .badge { font-size: 0.6875rem; background: rgba(255,255,255,0.12); padding: 1px 7px; border-radius: 10px; font-weight: 600; }

/* 筛选 */
.filter-bar { display: flex; gap: 4px; flex-wrap: wrap; }
.filter-bar button { padding: 5px 12px; border: 1px solid var(--theme-card-border); background: none; color: var(--theme-text-secondary); font-size: 0.75rem; cursor: pointer; font-family: inherit; border-radius: 4px; }
.filter-bar button.active { background: var(--theme-surface-muted); color: var(--theme-text-primary); border-color: var(--theme-primary); }

/* Master-Detail */
.master-detail { display: flex; gap: 14px; min-height: 31.25rem; }
.item-list { width: 20rem; flex-shrink: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 3px; max-height: 42.5rem; border-right: 1px solid var(--theme-card-border); padding-right: 10px; }
.item-row { display: flex; align-items: center; gap: 8px; padding: 7px 8px; border-radius: 4px; cursor: pointer; font-size: 0.8125rem; }
.item-row:hover { background: var(--theme-surface-muted); }
.item-row.selected { background: var(--theme-tab-hover-bg); }
.dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.i-name { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.i-tag { font-size: 0.6875rem; color: var(--theme-text-muted); flex-shrink: 0; }
.i-extra { font-size: 0.6875rem; color: var(--theme-text-secondary); flex-shrink: 0; }
.empty-list { padding: 30px; text-align: center; color: var(--theme-text-muted); font-size: 0.8125rem; }

/* 详情 */
.detail { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; max-height: 42.5rem; }
.d-header { display: flex; align-items: center; gap: 10px; }
.d-name { font-family: var(--theme-font-title, 'Cinzel', serif); font-size: 1.0625rem; font-weight: 700; }
.d-quality { font-size: 0.75rem; font-weight: 600; padding: 2px 10px; border-radius: 4px; border: 1px solid; }
.d-meta { font-size: 0.8125rem; color: var(--theme-text-secondary); display: flex; gap: 14px; padding-bottom: 8px; border-bottom: 1px solid var(--theme-card-border); }
.d-label { font-size: 0.6875rem; color: var(--theme-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; }

.fx-row { display: flex; gap: 10px; padding: 3px 0; font-size: 0.8125rem; }
.fx-name { color: var(--theme-text-secondary); font-weight: 500; min-width: 4.375rem; }
.fx-desc { color: var(--theme-text-primary); }

.d-desc { font-size: 0.8125rem; color: var(--theme-text-secondary); line-height: 1.6; margin: 0; }

/* 脚本 */
.script-section { margin-top: auto; border-top: 1px solid var(--theme-card-border); padding-top: 8px; }
.script-toggle { padding: 6px 12px; border: 1px solid var(--theme-card-border); background: var(--theme-surface-muted); color: var(--theme-text-muted); font-size: 0.75rem; cursor: pointer; font-family: inherit; border-radius: 4px; }
.script-toggle:hover { color: var(--theme-text-primary); }
.script-body { margin-top: 8px; }
.script-block { margin-bottom: 8px; }
.script-label { font-size: 0.75rem; color: var(--theme-accent, #f59e0b); font-weight: 600; margin-bottom: 3px; }
.script-code { background: #0d1117; color: #c9d1d9; font-family: 'Cascadia Code', 'JetBrains Mono', monospace; font-size: 0.6875rem; padding: 10px; border-radius: 4px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; margin: 0; max-height: 160px; overflow-y: auto; }
.script-empty { font-size: 0.75rem; color: var(--theme-text-muted); font-style: italic; }

.detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--theme-text-muted); font-size: 0.875rem; }
.empty { padding: 40px; text-align: center; color: var(--theme-text-muted); font-size: 0.875rem; }
</style>
