<script setup lang="ts">
import { ref, computed } from 'vue'
import { useGameStore } from '../../stores/game-store'
import { useHoverPopup } from '../../composables/useHoverPopup'
import { normalizeItemType } from '@engine/field-enums'
import ResourceBar from '../shared/ResourceBar.vue'
import AvatarPanel from '../shared/AvatarPanel.vue'
import AppTabs from '../shared/AppTabs.vue'
import BuffChip from '../shared/BuffChip.vue'

const game = useGameStore()

const player = computed(() => game.player)

// ═══ 折叠状态 ═══
const daoOpen = ref(true)
const inventoryOpen = ref(true)

// ═══ 状态效果：悬停弹出详情（延迟走全局设置 settings.hoverDelayMs） ═══
// 气泡 Teleport 到 body，拿不到状态栏的 zoom:1.1，自己缩放；
// 传给夹紧计算的是**渲染后**尺寸：240×1.1=264 / 132×1.1=145
const buffPop = useHoverPopup({ width: 264, estHeight: 145, zoom: 1.1, placement: 'below' })
const popBuff = computed(() =>
  player.value?.statusEffects?.find(f => f.name === buffPop.key.value) ?? null
)

// ═══ 身份元信息 —— 顶部一行（取代原「玩家概要」标题 + 整个「个人信息」区块） ═══
const identityFields = computed(() => {
  const p = player.value
  if (!p) return []
  return [
    { label: '种族', value: p.race || '—', cls: '' },
    { label: '身份', value: p.identity?.[0] || '—', cls: '' },
    { label: '职业', value: p.occupation?.[0] || '—', cls: '' },
    { label: '生命层级', value: p.tierName || '—', cls: 'tier-text' },
    { label: '冒险者等级', value: p.adventurerRank ? `${p.adventurerRank}级` : '—', cls: '' },
  ]
})
/** 一行放不下时会被省略号截断，完整带标签的版本挂在 title 上，信息不丢 */
const identityTitle = computed(() =>
  identityFields.value.map(f => `${f.label}：${f.value}`).join('　')
)

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

// ═══ 持有物页签：装备 / 背包 / 消耗品 / 技能 ═══
type HoldTab = 'equipment' | 'bag' | 'consumable' | 'skills'
const holdTab = ref<HoldTab>('equipment')
const holdTabs: { key: HoldTab; label: string }[] = [
  { key: 'equipment', label: '装备' },
  { key: 'bag', label: '背包' },
  { key: 'consumable', label: '消耗品' },
  { key: 'skills', label: '技能' },
]

/** 未穿戴的物品（穿戴中的归「装备」页签，规范 §3：装备是物品的状态而非独立实体） */
const unequipped = computed(() =>
  (player.value?.inventory ?? []).filter(i => !i.equippedSlot)
)
const consumableList = computed(() =>
  unequipped.value.filter(i => normalizeItemType(i.type ?? '') === '消耗品')
)
/** 背包 = 未穿戴且非消耗品（材料/任务物品/特殊/未穿戴的装备都在这） */
const bagList = computed(() =>
  unequipped.value.filter(i => normalizeItemType(i.type ?? '') !== '消耗品')
)
const skillList = computed(() => player.value?.skills ?? [])

/** 统一行模型 —— 四个页签共用一套渲染，避免四份几乎一样的模板 */
interface HoldRow {
  name: string
  icon: string
  tag?: string
  trail?: string
  description?: string
  meta: { label: string; value: string }[]
  effects?: Record<string, string>
}

/** 装备加成 Record<词条, 数值> → meta 行，正数补 + 号 */
function statsMeta(stats?: Record<string, number>): { label: string; value: string }[] {
  if (!stats) return []
  return Object.entries(stats).map(([label, v]) => ({
    label,
    value: v > 0 ? `+${v}` : String(v),
  }))
}

const holdRows = computed<HoldRow[]>(() => {
  switch (holdTab.value) {
    case 'equipment':
      return equipmentList.value.map(e => ({
        name: e.name,
        icon: e.icon,
        tag: e.equippedSlot ?? undefined,
        description: e.description,
        meta: [
          ...(e.rarity ? [{ label: '品质', value: e.rarity }] : []),
          ...statsMeta(e.stats),
          ...(e.maxDurability ? [{ label: '耐久', value: `${e.durability ?? e.maxDurability}/${e.maxDurability}` }] : []),
        ],
        effects: e.effects,
      }))
    case 'bag':
    case 'consumable': {
      const list = holdTab.value === 'bag' ? bagList.value : consumableList.value
      const icon = holdTab.value === 'bag' ? 'fa-solid fa-cube' : 'fa-solid fa-flask'
      return list.map(i => ({
        name: i.name,
        icon,
        tag: holdTab.value === 'bag' ? i.type : undefined,
        trail: `×${i.quantity}`,
        description: i.description,
        meta: [
          ...(i.rarity ? [{ label: '品质', value: i.rarity }] : []),
          ...(i.type ? [{ label: '类型', value: i.type }] : []),
          { label: '数量', value: String(i.quantity) },
          ...statsMeta(i.stats),
        ],
        effects: i.effects,
      }))
    }
    case 'skills':
      return skillList.value.map(s => ({
        name: s.name,
        icon: s.type === 'active' ? 'fa-solid fa-wand-sparkles' : 'fa-solid fa-shield-heart',
        tag: s.type === 'active' ? '主动' : '被动',
        trail: s.level ? `Lv.${s.level}` : undefined,
        description: s.description,
        meta: [
          ...(s.cost ? [{ label: '消耗', value: `${s.cost.amount} ${s.cost.type}` }] : []),
          ...(s.maxCooldown ? [{ label: '冷却', value: `${s.cooldown ?? 0}/${s.maxCooldown}` }] : []),
        ],
        effects: s.effects,
      }))
  }
})

/** 每个页签最多预览 6 条，超出走「查看全部」进背包面板 */
const HOLD_PREVIEW = 6
const holdOverflow = computed(() => Math.max(0, holdRows.value.length - HOLD_PREVIEW))

/** 就地展开详情（原先点条目会弹全屏 Modal —— 触发已摘掉，store.focusItem 保留未删） */
const expandedHold = ref<string | null>(null)
function toggleHold(name: string) {
  const key = `${holdTab.value}:${name}`
  expandedHold.value = expandedHold.value === key ? null : key
}
function isHoldOpen(name: string): boolean {
  return expandedHold.value === `${holdTab.value}:${name}`
}

function buffType(cat: string): 'buff' | 'debuff' | 'special' {
  if (cat === '增益') return 'buff'
  if (cat === '减益') return 'debuff'
  return 'special'
}
</script>

<template>
  <!-- ═══ 已加载 ═══ -->
  <div class="status-overview" v-if="player">

    <!-- ═══════ 玩家概要 —— 身份一行 + 方形画像 ═══════ -->
    <div class="section">
      <div class="section-header">
        <div class="identity-line" :title="identityTitle">
          <template v-for="(f, i) in identityFields" :key="f.label"
            ><span v-if="i" class="identity-sep" aria-hidden="true"> · </span
            ><span class="identity-field" :class="f.cls">{{ f.value }}</span
          ></template>
        </div>
      </div>
      <div class="player-summary">
        <AvatarPanel :name="player.name" size="xl" shape="square" />
        <div class="summary-name">{{ player.name }}</div>
      </div>
    </div>

    <!-- ═══════ 属性 ═══════ -->
    <div class="section attribute-section">
      <div class="section-header clickable" @click="daoOpen = !daoOpen" role="button" tabindex="0" :aria-expanded="daoOpen" @keydown.enter="daoOpen = !daoOpen" @keydown.space.prevent="daoOpen = !daoOpen">
        <span class="section-title">属性</span>
        <span class="attr-level">Lv.{{ player.level }}</span>
        <i class="fa-solid" :class="daoOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="section-body" v-if="daoOpen">
        <ResourceBar label="HP" :current="player.hp" :max="player.maxHp" color="color-mix(in srgb, var(--theme-hp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="MP" :current="player.mp" :max="player.maxMp" color="color-mix(in srgb, var(--theme-mp) 65%, #000)" :height="20" :showValues="true" />
        <ResourceBar label="SP" :current="player.sp" :max="player.maxSp" color="color-mix(in srgb, var(--theme-sp) 65%, #000)" :height="20" :showValues="true" />

        <!-- 经验条 —— 与 HP/MP/SP 同宽同形
             totalExp = 本层级已积累，expToNext = 距上限还差多少，两者之和 = 该层级 EXP 上限
             （实测 8500 + 1500 = 10000，正是核心数值表 T4 的 expCap；创角时 0 + expCap 亦自洽） -->
        <ResourceBar label="EXP" :current="player.totalExp" :max="player.totalExp + player.expToNext" color="color-mix(in srgb, var(--theme-exp) 65%, #000)" :height="20" :showValues="true" />

        <!-- 五维属性保持单行 -->
        <div class="attr-grid">
          <div v-for="attr in attrEntries" :key="attr.key" class="kv-item">
            <span class="kv-label">{{ attr.label }}</span>
            <span class="kv-value">{{ attr.value }}</span>
          </div>
        </div>

      </div>
      </Transition>
    </div>

    <!-- ═══════ 状态效果 ═══════ -->
    <!-- 徽章与标题同处一行：flex-wrap 让前几个自然排在标题右侧，放不下的往下折 -->
    <div class="section" v-if="player.statusEffects?.length">
      <div class="section-header buff-header">
        <span class="section-title">状态效果</span>
        <div class="buff-scroll">
        <button
          v-for="fx in player.statusEffects"
          :key="fx.name"
          class="buff-row"
          :aria-describedby="buffPop.key.value === fx.name ? 'buff-pop' : undefined"
          @mouseenter="buffPop.onEnter($event, fx.name)"
          @mouseleave="buffPop.hide"
          @focus="buffPop.onFocus($event, fx.name)"
          @blur="buffPop.hide"
        >
          <BuffChip :name="fx.name" :type="buffType(fx.category)" :stacks="fx.stacks" />
          <span class="buff-time" v-if="fx.remainingTime === null">永久</span>
          <span class="buff-time" v-else-if="fx.remainingTime !== null && fx.remainingTime < 999">{{ fx.remainingTime }}{{ fx.timeUnit }}</span>
        </button>
        </div>
      </div>
    </div>

    <!-- ═══════ 储物袋预览 ═══════ -->
    <div class="section">
      <div class="section-header clickable" @click="inventoryOpen = !inventoryOpen" role="button" tabindex="0" :aria-expanded="inventoryOpen" @keydown.enter="inventoryOpen = !inventoryOpen" @keydown.space.prevent="inventoryOpen = !inventoryOpen">
        <span class="section-title">持有物</span>
        <!-- 钱袋 / 命运点常驻标题行 —— 在 Transition 之外，折叠时依然可见 -->
        <span class="hold-meta">
          <span class="hold-money"><i class="fa-solid fa-coins" />{{ player.money }} G</span>
          <span class="hold-fp"><i class="fa-solid fa-star" />{{ game.fp }} FP</span>
        </span>
        <i class="fa-solid" :class="inventoryOpen ? 'fa-chevron-up' : 'fa-chevron-down'" />
      </div>
      <Transition name="collapse">
        <div class="hold-body" v-if="inventoryOpen">
          <AppTabs :tabs="holdTabs" :active="holdTab" @select="holdTab = $event" />

          <div class="item-list">
            <div
              v-for="row in holdRows.slice(0, HOLD_PREVIEW)"
              :key="row.name"
              class="item-entry"
              :class="{ open: isHoldOpen(row.name) }"
            >
              <button
                class="item-row"
                :class="{ open: isHoldOpen(row.name) }"
                :aria-expanded="isHoldOpen(row.name)"
                @click="toggleHold(row.name)"
              >
                <i :class="row.icon" class="item-icon" />
                <span class="item-name">{{ row.name }}</span>
                <span class="item-tag" v-if="row.tag">{{ row.tag }}</span>
                <span class="item-count" v-if="row.trail">{{ row.trail }}</span>
                <i class="fa-solid item-chevron" :class="isHoldOpen(row.name) ? 'fa-chevron-up' : 'fa-chevron-down'" />
              </button>

              <div class="item-detail" v-if="isHoldOpen(row.name)">
                <div class="det-desc" v-if="row.description">{{ row.description }}</div>
                <div class="det-meta" v-if="row.meta.length">
                  <span v-for="m in row.meta" :key="m.label" class="det-chip">
                    <span class="det-chip-label">{{ m.label }}</span>{{ m.value }}
                  </span>
                </div>
                <div class="det-effects" v-if="row.effects && Object.keys(row.effects).length">
                  <div v-for="(text, name) in row.effects" :key="name" class="det-effect">
                    <span class="det-effect-name">{{ name }}</span>{{ text }}
                  </div>
                </div>
                <div class="det-empty" v-if="!row.description && !row.meta.length && !(row.effects && Object.keys(row.effects).length)">
                  暂无更多记载
                </div>
              </div>
            </div>

            <div class="empty-tab" v-if="!holdRows.length">囊中空空…</div>
          </div>

          <div class="item-footer" v-if="holdOverflow" role="button" tabindex="0" @click="game.showModal('items')" @keydown.enter="game.showModal('items')">
            查看全部 · 另有 {{ holdOverflow }} 项
            <i class="fa-solid fa-chevron-right" />
          </div>
        </div>
      </Transition>
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

  <!-- ═══ 状态效果悬停气泡（Teleport 出滚动容器，否则会被 overflow 裁掉） ═══ -->
  <Teleport to="body">
    <Transition name="buff-pop">
      <div
        v-if="popBuff && buffPop.style.value"
        id="buff-pop"
        class="buff-pop"
        role="tooltip"
        :style="buffPop.style.value"
      >
        <div class="bd-name">{{ popBuff.name }}</div>
        <div class="bd-desc">{{ popBuff.description }}</div>
        <div class="bd-meta">
          <span>层数: {{ popBuff.stacks }}</span>
          <span>剩余: {{ popBuff.remainingTime === null ? '永久' : popBuff.remainingTime + popBuff.timeUnit }}</span>
          <span>来源: {{ popBuff.source }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
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
/* 身份一行：种族 · 身份 · 职业 · 生命层级 · 冒险者等级
   inline 子元素 + block 容器，才能让 text-overflow 生效（flex 容器上不生效） */
.identity-line {
  flex: 1;
  min-width: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.identity-sep {
  color: var(--theme-text-muted);
  opacity: 0.6;
}
.identity-field {
  font-weight: 500;
}
.player-summary {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 4px 12px 12px;
  gap: 8px;
}
.summary-name {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}

/* ═══ KV 行 ═══ */

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
.tier-text { color: var(--theme-quality-epic); }

/* ═══ 五维属性 —— 紧凑单行 ═══ */
.attr-level {
  margin-left: auto;
  margin-right: 10px;
  color: var(--theme-primary);
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.attr-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  margin-top: 4px;
}
.attr-grid .kv-item {
  align-items: center;
  text-align: center;
  min-width: 0;
  padding: 5px 2px;
}
.attr-grid .kv-label {
  font-size: 0.5625rem;
  line-height: 1.2;
}
.attr-grid .kv-value {
  font-size: 0.75rem;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

/* ═══ 状态效果 ═══ */
/* 标题行改为可换行：标题在左，徽章紧随其后；一行放不下的自动折到下一行 */
.buff-header {
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 8px;
  padding-bottom: 10px;
}
.buff-header .section-title { flex-shrink: 0; }
.buff-scroll { max-height: 7.5rem; overflow-y: auto; display: flex; flex-wrap: wrap; gap: 4px 8px; flex: 1; min-width: 0; }
/* cursor: help —— 点击不再有行为，指针不该继续骗人说"可点" */
.buff-row { display: flex; align-items: center; gap: 4px; cursor: help; border: none; background: none; padding: 0; font-family: inherit; font-size: inherit; color: inherit; width: auto; }
.buff-time { font-size: 0.625rem; color: var(--theme-text-muted); }

/* 悬停气泡 —— fixed 定位，走语义 z 阶而非魔法数字 */
.buff-pop {
  position: fixed;
  z-index: var(--z-tooltip, 500);
  zoom: 1.1;              /* 与状态栏同步放大 —— 它在面板外，继承不到 */
  width: 240px;
  padding: 9px 11px;
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--theme-shadow-lg);
  pointer-events: none;   /* 气泡不吃鼠标，避免盖住徽章造成进出闪烁 */
}
.bd-name { font-size: 0.8125rem; font-weight: 700; color: var(--theme-text-primary); }
.bd-desc { font-size: 0.75rem; line-height: 1.55; color: var(--theme-text-secondary); margin-top: 3px; }
.bd-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 7px; font-size: 0.6875rem; color: var(--theme-text-muted); }

.buff-pop-enter-active { transition: opacity 0.12s ease-out; }
.buff-pop-leave-active { transition: opacity 0.1s ease-in; }
.buff-pop-enter-from, .buff-pop-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .buff-pop-enter-active, .buff-pop-leave-active { transition: none; }
}

/* ═══ 持有物 —— 页签体（AppTabs 全宽出血，列表自带内边距） ═══ */
.hold-body {
  display: flex;
  flex-direction: column;
}
/* 钱袋 / 命运点 —— 挂在「持有物」标题行右侧，靠 margin-left:auto 顶到 chevron 前 */
.hold-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
  margin-right: 10px;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.hold-money, .hold-fp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
}
.hold-money { color: var(--theme-currency-gold); }
.hold-fp { color: var(--theme-primary); }
.hold-meta i { font-size: 0.6875rem; opacity: 0.85; }
.hold-body .item-list {
  padding: 8px 12px 4px;
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
  border: none;
  background: none;
  font-family: inherit;
  color: inherit;
  width: 100%;
  text-align: left;
  cursor: pointer;
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

/* ═══ 条目就地展开详情 ═══ */
.item-chevron {
  flex-shrink: 0;
  font-size: 0.5rem;
  color: var(--theme-text-muted);
  opacity: 0.55;
}
.item-row.open {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
.item-row.open .item-chevron { opacity: 0.9; }
.item-detail {
  /* 与上方条目等宽 —— 原先左缩进 22px 让它比条目窄一截、右侧还空着 */
  margin: 2px 0 6px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--theme-primary) 5%, var(--theme-surface-muted));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.det-desc {
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}
.det-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}
.det-chip {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  padding: 1px 6px;
  font-variant-numeric: tabular-nums;
}
.det-chip-label {
  color: var(--theme-text-muted);
  font-weight: 400;
  margin-right: 4px;
}
.det-effects {
  display: flex;
  flex-direction: column;
  gap: 3px;
  border-top: 1px dashed var(--theme-card-border);
  padding-top: 6px;
}
.det-effect {
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-text-secondary);
}
.det-effect-name {
  color: var(--theme-primary);
  font-weight: 600;
  margin-right: 5px;
}
.det-empty {
  font-size: 0.6875rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

/* ═══ 空态 —— design.md §5.2 统一配方 ═══ */
.empty-tab {
  padding: 20px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 6px;
  font-size: 1.25rem;
  opacity: 0.3;
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

/* ═══ 折叠动画 — 只动 opacity/transform，不动布局属性 ═══ */
.collapse-enter-active {
  transition: opacity 0.2s ease-out, transform 0.2s ease-out;
}
.collapse-leave-active {
  transition: opacity 0.12s ease-in;
}
.collapse-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}
.collapse-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .collapse-enter-active,
  .collapse-leave-active {
    transition: none;
  }
}
</style>
