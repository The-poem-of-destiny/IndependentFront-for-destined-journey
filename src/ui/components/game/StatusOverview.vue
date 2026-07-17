<script setup lang="ts">
import { ref, computed } from 'vue'
import { useGameStore } from '../../stores/game-store'
import ResourceBar from '../shared/ResourceBar.vue'
import AvatarPanel from '../shared/AvatarPanel.vue'
import BuffChip from '../shared/BuffChip.vue'

const game = useGameStore()

const player = computed(() => game.player)
const profile = computed(() => game.saveProfile)

// ═══ 折叠状态 ═══
const personalOpen = ref(true)
const daoOpen = ref(true)
const inventoryOpen = ref(true)
const inspectedBuff = ref<string | null>(null)

// ═══ 属性映射 ═══
const ATTR_LABELS: Record<string, string> = {
  str: '力量', dex: '敏捷', con: '体质', int: '智力', spi: '精神',
}
const attrEntries = computed(() =>
  Object.entries(player.value?.attributes ?? {}).map(([key, value]) => ({
    key,
    label: ATTR_LABELS[key] || key,
    value,
  }))
)

// ═══ 装备列表 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），槽位为中文枚举
const EQUIP_ICONS: Record<string, string> = {
  '武器': 'fa-solid fa-sword', '副手': 'fa-solid fa-shield-halved', '头部': 'fa-solid fa-helmet-safety',
  '身体': 'fa-solid fa-shirt', '手部': 'fa-solid fa-mitten', '脚部': 'fa-solid fa-shoe-prints',
  '腰带': 'fa-solid fa-ring', '饰品': 'fa-regular fa-gem',
}
const equipmentList = computed(() =>
  (player.value?.inventory ?? []).filter(i => i.equippedSlot).map(e => ({
    ...e,
    icon: EQUIP_ICONS[e.equippedSlot!] || 'fa-solid fa-circle',
  }))
)

// ═══ 背包预览 (前 5 件) ═══
const inventoryPreview = computed(() => {
  const inv = player.value?.inventory
  if (!Array.isArray(inv)) return []
  return inv.slice(0, 5)
})

// ═══ 焦点任务 ═══
const questEntries = computed(() => {
  const quests = profile.value?.quests
  if (!quests) return []
  const order: Record<string, number> = { '高': 0, '中': 1, '低': 2 }
  return Object.entries(quests).sort(
    ([, a], [, b]) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2)
  ).slice(0, 3)
})

function buffType(cat: string): 'buff' | 'debuff' | 'special' {
  if (cat === '增益') return 'buff'
  if (cat === '减益') return 'debuff'
  return 'special'
}
</script>

<template>
  <!-- ═══ 已加载 ═══ -->
  <div class="status-overview" v-if="player">

    <!-- ═══════ 玩家概要 ═══════ -->
    <div class="section">
      <div class="section-header">
        <span class="section-title">玩家概要</span>
      </div>
      <div class="player-summary">
        <AvatarPanel :name="player.name" size="lg" />
        <div class="summary-name">{{ player.name }}</div>
        <div class="summary-location">
          <i class="fa-solid fa-location-dot" />
          {{ player.location?.split('-').pop() || '未知' }}
        </div>
      </div>
    </div>

    <!-- ═══════ 个人信息 ═══════ -->
    <div class="section">
      <div class="section-header clickable" @click="personalOpen = !personalOpen" role="button" tabindex="0" :aria-expanded="personalOpen" @keydown.enter="personalOpen = !personalOpen" @keydown.space.prevent="personalOpen = !personalOpen">
        <span class="section-title">个人信息</span>
        <i class="fa-solid" :class="personalOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="section-body" v-if="personalOpen">
        <div class="kv-row kv-3col">
          <div class="kv-item"><span class="kv-label">种族</span><span class="kv-value">{{ player.race }}</span></div>
          <div class="kv-item"><span class="kv-label">职业</span><span class="kv-value">{{ player.occupation?.[0] || '冒险者' }}</span></div>
          <div class="kv-item"><span class="kv-label">身份</span><span class="kv-value">{{ player.identity?.[0] || '—' }}</span></div>
        </div>
        <div class="kv-row kv-2col">
          <div class="kv-item">
            <span class="kv-label">生命层级</span>
            <span class="kv-value tier-text">{{ player.tierName }}</span>
          </div>
          <div class="kv-item">
            <span class="kv-label">冒险者等级</span>
            <span class="kv-value">{{ player.adventurerRank }}级</span>
          </div>
        </div>
        <div class="kv-row kv-full">
          <div class="kv-item">
            <span class="kv-label">所在地</span>
            <span class="kv-value kv-long">{{ player.location || '未知' }}</span>
          </div>
        </div>
        <div class="kv-row kv-2col">
          <div class="kv-item"><span class="kv-label">等级</span><span class="kv-value">Lv.{{ player.level }}</span></div>
          <div class="kv-item"><span class="kv-label">金钱</span><span class="kv-value">{{ player.money }} G</span></div>
        </div>
      </div>
      </Transition>
    </div>

    <!-- ═══════ 属性 ═══════ -->
    <div class="section">
      <div class="section-header clickable" @click="daoOpen = !daoOpen" role="button" tabindex="0" :aria-expanded="daoOpen" @keydown.enter="daoOpen = !daoOpen" @keydown.space.prevent="daoOpen = !daoOpen">
        <span class="section-title">属性</span>
        <i class="fa-solid" :class="daoOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="section-body" v-if="daoOpen">
        <ResourceBar label="HP" :current="player.hp" :max="player.maxHp" color="color-mix(in srgb, var(--theme-hp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="MP" :current="player.mp" :max="player.maxMp" color="color-mix(in srgb, var(--theme-mp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="SP" :current="player.sp" :max="player.maxSp" color="color-mix(in srgb, var(--theme-sp) 65%, #000)" :height="20" :showValues="true" />

        <div class="attr-section">
          <div class="kv-row kv-3col">
            <div v-for="attr in attrEntries" :key="attr.key" class="kv-item">
              <span class="kv-label">{{ attr.label }}</span>
              <span class="kv-value">{{ attr.value }}</span>
            </div>
          </div>
        </div>

      </div>
      </Transition>
    </div>

    <!-- ═══════ 状态效果 ═══════ -->
    <div class="section" v-if="player.statusEffects?.length">
      <div class="section-header">
        <span class="section-title">状态效果</span>
      </div>
      <div class="buff-scroll">
        <button v-for="fx in player.statusEffects" :key="fx.name" class="buff-row" :aria-expanded="inspectedBuff === fx.name" @click="inspectedBuff = (inspectedBuff === fx.name ? null : fx.name)">
          <BuffChip :name="fx.name" :type="buffType(fx.category)" :stacks="fx.stacks" />
          <span class="buff-time" v-if="fx.remainingTime === null">永久</span>
          <span class="buff-time" v-else-if="fx.remainingTime !== null && fx.remainingTime < 999">{{ fx.remainingTime }}{{ fx.timeUnit }}</span>
        </button>
      </div>
      <!-- Buff 详情 -->
      <div class="buff-detail" v-if="inspectedBuff && player.statusEffects.find(f => f.name === inspectedBuff)">
        <div class="bd-name">{{ player.statusEffects.find(f => f.name === inspectedBuff)!.name }}</div>
        <div class="bd-desc">{{ player.statusEffects.find(f => f.name === inspectedBuff)!.description }}</div>
        <div class="bd-meta">
          <span>层数: {{ player.statusEffects.find(f => f.name === inspectedBuff)!.stacks }}</span>
          <span>剩余: {{ player.statusEffects.find(f => f.name === inspectedBuff)!.remainingTime === null ? '永久' : player.statusEffects.find(f => f.name === inspectedBuff)!.remainingTime + player.statusEffects.find(f => f.name === inspectedBuff)!.timeUnit }}</span>
          <span>来源: {{ player.statusEffects.find(f => f.name === inspectedBuff)!.source }}</span>
        </div>
      </div>
    </div>

    <!-- ═══════ 储物袋预览 ═══════ -->
    <div class="section">
      <div class="section-header clickable" @click="inventoryOpen = !inventoryOpen" role="button" tabindex="0" :aria-expanded="inventoryOpen" @keydown.enter="inventoryOpen = !inventoryOpen" @keydown.space.prevent="inventoryOpen = !inventoryOpen">
        <span class="section-title">持有物</span>
        <i class="fa-solid" :class="inventoryOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="section-body" v-if="inventoryOpen">

        <!-- 装备列表 -->
        <div class="equip-sub" v-if="equipmentList.length">
          <div class="sub-label">装备</div>
          <div class="item-list">
            <div v-for="eq in equipmentList" :key="eq.name" class="item-row">
              <i :class="eq.icon" class="item-icon" />
              <span class="item-name">{{ eq.name }}</span>
              <span class="item-tag">{{ eq.equippedSlot }}</span>
            </div>
          </div>
        </div>

        <!-- 背包物品预览 -->
        <div class="equip-sub" v-if="inventoryPreview.length">
          <div class="sub-label">背包</div>
          <div class="item-list">
            <div v-for="inv in inventoryPreview" :key="inv.name" class="item-row">
              <i class="fa-solid fa-cube item-icon" />
              <span class="item-name">{{ inv.name }}</span>
              <span class="item-tag">{{ inv.type }}</span>
              <span class="item-count">×{{ inv.quantity }}</span>
            </div>
          </div>
          <div class="item-footer" v-if="(player.inventory?.length || 0) > 5">
            查看全部持有物 · 共 {{ player.inventory?.length }} 件
            <i class="fa-solid fa-chevron-right" />
          </div>
        </div>
      </div>
      </Transition>
    </div>

    <!-- ═══════ 任务追踪 ═══════ -->
    <div class="section" v-if="questEntries.length">
      <div class="section-header">
        <span class="section-title">任务追踪</span>
      </div>
      <div class="section-body">
        <div v-for="[name, q] in questEntries" :key="name" class="quest-item">
          <div class="quest-top">
            <span class="quest-name">{{ name }}</span>
            <span class="quest-prio" :class="'pri-' + q.priority">{{ q.priority }}</span>
          </div>
          <div class="quest-obj" v-if="q.objective">{{ q.objective }}</div>
          <div class="quest-prog" v-if="q.progress">{{ q.progress }}</div>
        </div>
      </div>
    </div>

  </div>

  <!-- ═══ 骨架屏 ═══ -->
  <div class="status-skeleton" v-else-if="game.isGenerating || !game.player">
    <div class="sk-block" v-for="i in 4" :key="i">
      <div class="sk-hdr" />
      <div class="sk-lines"><div class="sk-l" /><div class="sk-l sk-short" /></div>
    </div>
  </div>

  <!-- ═══ 错误态 ═══ -->
  <div class="status-error" v-else>
    <i class="fa-solid fa-triangle-exclamation error-icon" />
    <p>角色数据加载失败</p>
    <button class="retry-btn" @click="game.loadSave(game.activeSaveId!)">重试</button>
  </div>
</template>

<style scoped>
/* ═══ 根容器 ═══ */
.status-overview {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
  height: 100%;
}

/* ═══ Section 区块 ═══ */
.section {
  border-bottom: 1px solid var(--theme-card-border);
}
.section:last-child { border-bottom: none; }

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 6px;
  user-select: none;
}
.section-header.clickable {
  cursor: pointer;
}
.section-header.clickable:hover {
  color: var(--theme-text-primary);
}
.section-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.section-header i {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  transition: transform 0.2s;
}

.section-body {
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ═══ 玩家概要 ═══ */
.player-summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 12px 12px;
  gap: 6px;
}
.summary-name {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.summary-location {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ═══ KV 行 ═══ */
.kv-row {
  display: grid;
  gap: 8px;
}
.kv-3col { grid-template-columns: repeat(3, 1fr); }
.kv-2col { grid-template-columns: repeat(2, 1fr); }
.kv-full { grid-template-columns: 1fr; }

.kv-item {
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 7px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
}
.kv-value {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.kv-long {
  font-size: 0.6875rem;
  word-break: break-all;
}
.tier-text { color: var(--theme-quality-epic, #9A79CC); }

/* ═══ 属性区 ═══ */
.attr-section { margin-top: 4px; }

/* ═══ 状态效果 ═══ */
.buff-scroll { max-height: 7.5rem; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 6px; }
.buff-row { display: flex; align-items: center; gap: 4px; cursor: pointer; border: none; background: none; padding: 0; font-family: inherit; font-size: inherit; color: inherit; width: auto; }
.buff-time { font-size: 0.625rem; color: var(--theme-text-muted); }
.buff-detail { margin: 0 12px 8px; padding: 8px 10px; background: var(--theme-surface-muted); border-radius: 6px; border-left: 3px solid var(--theme-primary); }
.bd-name { font-size: 0.8125rem; font-weight: 700; color: var(--theme-text-primary); }
.bd-desc { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 2px; }
.bd-meta { display: flex; gap: 12px; margin-top: 6px; font-size: 0.6875rem; color: var(--theme-text-muted); }

/* ═══ 持有物 ═══ */
.equip-sub { margin-bottom: 4px; }
.sub-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  margin-bottom: 4px;
  padding-left: 2px;
}
.item-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.item-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 0.75rem;
}
.item-row:hover {
  background: var(--theme-surface-muted);
}
.item-icon {
  width: 1rem;
  text-align: center;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.item-name {
  flex: 1;
  color: var(--theme-text-primary);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-tag {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  background: var(--theme-surface-muted);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.item-count {
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  flex-shrink: 0;
}
.item-footer {
  text-align: center;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  padding: 6px 0 2px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.item-footer:hover { color: var(--theme-text-secondary); }
.item-footer i { font-size: 0.5625rem; }

/* ═══ 任务追踪 ═══ */
.quest-item {
  padding: 6px 8px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
  border-left: 3px solid var(--theme-primary);
}
.quest-item + .quest-item { margin-top: 4px; }
.quest-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.quest-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  flex: 1;
}
.quest-prio {
  font-size: 0.625rem;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}
.pri-高 { background: rgba(220,38,38,0.18); color: #ef4444; }
.pri-中 { background: rgba(217,119,6,0.18); color: #f59e0b; }
.pri-低 { background: rgba(107,114,128,0.18); color: #9ca3af; }
.quest-obj {
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  margin-top: 3px;
}
.quest-prog {
  font-size: 0.6875rem;
  color: var(--theme-success);
  margin-top: 2px;
}

/* ═══ 骨架屏 ═══ */
.status-skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 10px;
}
.sk-block { display: flex; flex-direction: column; gap: 6px; }
.sk-hdr {
  height: 10px; width: 40%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-lines { display: flex; flex-direction: column; gap: 4px; padding-left: 4px; }
.sk-l {
  height: 14px; width: 90%;
  border-radius: 3px;
  background: var(--theme-surface-muted);
  animation: sk-pulse 1.5s infinite;
}
.sk-short { width: 50%; }
@keyframes sk-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 0.7; }
}

/* ═══ 错误态 ═══ */
.status-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--theme-text-muted);
  padding: 16px;
  text-align: center;
}
.error-icon { font-size: 1.75rem; color: var(--theme-error); }
.retry-btn {
  padding: 6px 16px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
  font-family: inherit;
}
.retry-btn:hover { background: var(--theme-tab-hover-bg); }

/* ═══ 折叠动画 ═══ */
.collapse-enter-active,
.collapse-leave-active {
  transition: max-height 0.25s ease, opacity 0.2s ease;
  overflow: hidden;
}
.collapse-enter-from,
.collapse-leave-to {
  max-height: 0;
  opacity: 0;
}
.collapse-enter-to,
.collapse-leave-from {
  max-height: 800px;
  opacity: 1;
}
</style>
