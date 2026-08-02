<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { qualityVar } from '../../lib/quality-colors';
import { describeModifiers } from '@engine/describe-modifier';
import { describeAutomata } from '@engine/describe-automaton';

const game = useGameStore();

type Category = 'inventory' | 'equipment' | 'skills';
const activeCategory = ref<Category>('inventory');
const activeFilter = ref('全部');
const selectedIdx = ref(0);

const player = computed(() => game.player);

// ═══ 品质推断 ═══
function inferQuality(stats?: Record<string, number>): string {
  if (!stats) return '普通';
  const total = Object.values(stats).reduce((s, v) => s + Math.abs(v), 0);
  if (total >= 50) return '传说';
  if (total >= 30) return '史诗';
  if (total >= 20) return '稀有';
  if (total >= 10) return '优良';
  return '普通';
}

// ═══ 数据 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），最小适配 filter 惯用式
const inventoryItems = computed(() => player.value?.inventory || []);
const equipmentItems = computed(() =>
  (player.value?.inventory ?? []).filter((i) => i.equippedSlot),
);
const skillItems = computed(() => player.value?.skills || []);

const currentItems = computed<any[]>(() => {
  const inv = Array.isArray(player.value?.inventory) ? player.value.inventory : [];
  const equip = inv.filter((i) => i.equippedSlot);
  const skills = Array.isArray(player.value?.skills) ? player.value.skills : [];
  switch (activeCategory.value) {
    case 'inventory':
      return inv;
    case 'equipment':
      return equip;
    case 'skills':
      return skills;
  }
  return []; // ← 防御
});

const filterOptions = computed(() => {
  const types = new Set<string>();
  for (const item of currentItems.value) {
    const t =
      activeCategory.value === 'equipment'
        ? item.equippedSlot
        : activeCategory.value === 'skills'
          ? item.type === 'active'
            ? '主动'
            : '被动'
          : item.type;
    if (t) types.add(t);
  }
  return ['全部', ...Array.from(types)];
});

const filteredItems = computed(() => {
  if (activeFilter.value === '全部') return currentItems.value;
  return currentItems.value.filter((item) => {
    const t =
      activeCategory.value === 'equipment'
        ? item.equippedSlot
        : activeCategory.value === 'skills'
          ? item.type === 'active'
            ? '主动'
            : '被动'
          : item.type;
    return t === activeFilter.value;
  });
});

const sortedItems = computed(() => {
  const rank: Record<string, number> = {
    唯一: 7,
    神话: 6,
    传说: 5,
    史诗: 4,
    稀有: 3,
    优良: 2,
    普通: 1,
  };
  return [...filteredItems.value].sort((a: any, b: any) => {
    const qa = rank[a.rarity || inferQuality(a.stats)] || 0;
    const qb = rank[b.rarity || inferQuality(b.stats)] || 0;
    return qb - qa || (a.name || '').localeCompare(b.name || '');
  });
});

watch([activeCategory, activeFilter], () => {
  selectedIdx.value = 0;
  showRaw.value = false;
});

// ═══ 外部聚焦 — StatusOverview 点击持有物 → 切类目并选中该物品 ═══
function applyItemFocus() {
  const focus = game.pendingItemFocus;
  if (!focus) return;
  activeCategory.value = focus.category;
  activeFilter.value = '全部';
  nextTick(() => {
    const idx = sortedItems.value.findIndex((i: any) => i.name === focus.itemName);
    if (idx >= 0) selectedIdx.value = idx;
    game.clearItemFocus();
  });
}
watch(() => game.pendingItemFocus, applyItemFocus);
onMounted(applyItemFocus);

// ═══ 选中物品 ═══
const selected = computed(() => sortedItems.value[selectedIdx.value] || null);

const selQuality = computed(() => {
  const item: any = selected.value;
  if (!item) return '普通';
  // 所有分类优先使用存储的 rarity 字段，只有缺失时才回退到推断
  if (item.rarity) return item.rarity;
  if (activeCategory.value === 'skills') return '史诗';
  return inferQuality(item.stats);
});

const selTypeLabel = computed(() => {
  const item: any = selected.value;
  if (!item) return '';
  if (activeCategory.value === 'equipment') {
    // M6 完整重构: equippedSlot 已是中文槽位枚举，直接展示
    return item.equippedSlot || '装备';
  }
  if (activeCategory.value === 'skills') return item.type === 'active' ? '主动技能' : '被动技能';
  return item.type || '物品';
});

const selExtra = computed(() => {
  const item: any = selected.value;
  if (!item) return '';
  if (activeCategory.value === 'inventory') return `×${item.quantity || 1}`;
  if (activeCategory.value === 'equipment')
    return `${item.durability || '?'}/${item.maxDurability || '?'} 耐久`;
  return `Lv.${item.level || 1}${item.cost ? ` · ${item.cost.amount}${item.cost.type}` : ''}`;
});

const selEffects = computed(
  () => (selected.value as any)?.effects as Record<string, string> | undefined,
);
const selScripts = computed(
  () => (selected.value as any)?.scripts as Record<string, string> | undefined,
);
const hasScripts = computed(() => selScripts.value && Object.keys(selScripts.value).length > 0);

// ═══ 战斗修正（modifiers + automata 中文摘要）═══
const modifierLines = computed(() => describeModifiers((selected.value as any)?.modifiers));
const automatonLines = computed(() => describeAutomata((selected.value as any)?.automata));
const combatLines = computed(() => [...modifierLines.value, ...automatonLines.value]);
const hasCombat = computed(() => combatLines.value.length > 0);

// ═══ 原始数据折叠（modifiers + automata JSON）═══
const showRaw = ref(false);
const rawCombatJson = computed(() => {
  const item = selected.value as any;
  if (!item) return '';
  const parts: string[] = [];
  if (item.modifiers?.length) parts.push(JSON.stringify(item.modifiers, null, 2));
  if (item.automata?.length) parts.push(JSON.stringify(item.automata, null, 2));
  return parts.join('\n\n');
});

// 切换选中物品时收起原始数据折叠
watch([selectedIdx, activeCategory], () => {
  showRaw.value = false;
});
</script>

<template>
  <div v-if="player" class="items-panel">
    <!-- 货币 -->
    <div class="money-bar">
      <span class="money-label">持有金币</span>
      <span class="money-value"><i class="fa-solid fa-coins" /> {{ player.money }} G</span>
    </div>

    <!-- 类别切换 -->
    <div class="cat-tabs">
      <button
        :class="{ active: activeCategory === 'inventory' }"
        @click="activeCategory = 'inventory'"
      >
        背包 <span class="badge">{{ inventoryItems.length }}</span>
      </button>
      <button
        :class="{ active: activeCategory === 'equipment' }"
        @click="activeCategory = 'equipment'"
      >
        装备 <span class="badge">{{ equipmentItems.length }}</span>
      </button>
      <button :class="{ active: activeCategory === 'skills' }" @click="activeCategory = 'skills'">
        技能 <span class="badge">{{ skillItems.length }}</span>
      </button>
    </div>

    <!-- 子分类筛选 -->
    <div v-if="filterOptions.length > 2" class="filter-bar">
      <button
        v-for="f in filterOptions"
        :key="f"
        :class="{ active: activeFilter === f }"
        @click="activeFilter = f"
      >
        {{ f }}
      </button>
    </div>

    <!-- Master-Detail -->
    <div class="master-detail">
      <!-- 左: 列表 -->
      <div class="item-list">
        <div v-if="sortedItems.length === 0" class="empty-list">暂无物品</div>
        <div
          v-for="(item, i) in sortedItems"
          :key="(item as any).name || i"
          class="item-row"
          :class="{ selected: i === selectedIdx }"
          @click="selectedIdx = i"
        >
          <span
            class="dot"
            :style="{
              background: qualityVar((item as any).rarity || inferQuality((item as any).stats)),
            }"
          />
          <span
            class="i-name"
            :style="{
              color: qualityVar((item as any).rarity || inferQuality((item as any).stats)),
            }"
            >{{ (item as any).name }}</span
          >
          <span class="i-tag">{{
            activeCategory === 'equipment'
              ? (item as any).equippedSlot
              : activeCategory === 'skills'
                ? (item as any).type === 'active'
                  ? '主动'
                  : '被动'
                : (item as any).type
          }}</span>
          <span v-if="activeCategory === 'inventory'" class="i-extra"
            >×{{ (item as any).quantity }}</span
          >
          <span v-else-if="activeCategory === 'equipment'" class="i-extra"
            >[{{ (item as any).equippedSlot }}]</span
          >
          <span v-else class="i-extra">Lv.{{ (item as any).level }}</span>
        </div>
      </div>

      <!-- 右: 详情 -->
      <div
        v-if="selected"
        class="detail"
        :style="{
          '--item-detail-border': qualityVar(selQuality),
          '--item-detail-glow': qualityVar(selQuality),
        }"
      >
        <div class="d-header">
          <span class="d-name" :style="{ color: qualityVar(selQuality) }">{{
            (selected as any).name
          }}</span>
          <span
            class="d-quality"
            :style="{ color: qualityVar(selQuality), borderColor: qualityVar(selQuality) }"
            >{{ selQuality }}</span
          >
        </div>
        <div class="d-meta">
          <span>{{ selTypeLabel }}</span
          ><span>{{ selExtra }}</span>
        </div>

        <!-- 效果词条 -->
        <div v-if="selEffects && Object.keys(selEffects).length > 0" class="fx-section">
          <div class="d-label">效果</div>
          <div v-for="(desc, name) in selEffects" :key="name" class="fx-row">
            <span class="fx-name">{{ name }}</span
            ><span class="fx-desc">{{ desc }}</span>
          </div>
        </div>

        <!-- 战斗修正（modifiers + automata 中文摘要） -->
        <div class="fx-section">
          <div class="d-label">战斗修正</div>
          <div v-if="hasCombat" class="combat-list">
            <div v-for="(line, i) in combatLines" :key="i" class="combat-row">
              <span class="combat-icon" aria-hidden="true">⚔</span>
              <span>{{ line }}</span>
            </div>
          </div>
          <div v-else class="fx-empty">该物品无战斗效果</div>
        </div>

        <!-- 描述 -->
        <div v-if="(selected as any).description" class="desc-section">
          <div class="d-label">描述</div>
          <p class="d-desc">{{ (selected as any).description }}</p>
        </div>

        <!-- 脚本 / 原始数据 -->
        <div class="script-section">
          <button class="script-toggle" @click="showRaw = !showRaw">
            {{ showRaw ? '收起原始数据' : '查看原始数据' }}
          </button>
          <div v-if="showRaw" class="script-body">
            <template v-if="rawCombatJson || hasScripts">
              <div v-if="rawCombatJson" class="script-block">
                <div class="script-label">modifiers / automata</div>
                <pre class="script-code">{{ rawCombatJson }}</pre>
              </div>
              <div v-if="hasScripts" class="script-block">
                <div v-for="(code, name) in selScripts" :key="name" class="script-block">
                  <div class="script-label">{{ name }}</div>
                  <pre class="script-code">{{ code }}</pre>
                </div>
              </div>
            </template>
            <div v-else class="script-empty">(该物品无原始数据)</div>
          </div>
        </div>
      </div>
      <div v-else class="detail-empty">选择一件物品查看详情</div>
    </div>
  </div>
  <div v-else class="empty">未加载角色数据</div>
</template>

<style scoped>
/* ═══ 根 — 书页面板 ═══ */
.items-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 37.5rem;
  /* 纸叠质感：多层 box-shadow 模拟羊皮纸叠层 */
  --paper-stack:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
}

/* ═══ 货币栏 — 书页卷首 ═══ */
.money-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: color-mix(in srgb, var(--theme-card-bg) 92%, var(--theme-surface-muted) 8%);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
  border-bottom: 2px solid var(--theme-currency-gold, #f3c94f);
}
.money-label {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.money-value {
  font-size: 1.125rem;
  color: var(--theme-currency-gold, #f3c94f);
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.money-value i {
  font-size: 0.875rem;
}

/* ═══ 类别 Tab — 书签风格 ═══ */
.cat-tabs {
  display: flex;
  gap: 0;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md, 6px);
  padding: 4px;
}
.cat-tabs button {
  flex: 1;
  padding: 8px 6px;
  border: none;
  border-radius: var(--theme-radius-sm, 4px);
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  font-family: var(--theme-font-title, 'Cinzel', serif);
  letter-spacing: 0.03em;
  transition:
    background 0.15s,
    color 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.cat-tabs button:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.cat-tabs button.active {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-weight: 600;
  box-shadow: var(--theme-shadow-sm);
}
.cat-tabs .badge {
  font-size: 0.625rem;
  background: var(--theme-surface-muted);
  padding: 1px 7px;
  border-radius: 10px;
  font-weight: 600;
  font-family: system-ui, sans-serif;
}

/* ═══ 筛选 Bar ═══ */
.filter-bar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.filter-bar button {
  padding: 4px 10px;
  border: 1px solid var(--theme-card-border);
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: var(--theme-radius-sm, 4px);
  transition:
    border-color 0.15s,
    color 0.15s;
}
.filter-bar button:hover {
  color: var(--theme-text-secondary);
  border-color: var(--theme-text-muted);
}
.filter-bar button.active {
  background: var(--theme-surface-muted);
  color: var(--theme-text-primary);
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 30%, transparent);
}

/* ═══ Master-Detail ═══ */
.master-detail {
  display: flex;
  gap: 16px;
  min-height: 31.25rem;
}

/* ═══ 左: 物品列表 ═══ */
.item-list {
  width: 18rem;
  flex-shrink: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 42.5rem;
  padding: 10px;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}
.item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  font-size: 0.8125rem;
  border: 1px solid transparent;
  transition:
    background 0.12s,
    border-color 0.12s;
}
.item-row:hover {
  background: var(--theme-surface-muted);
}
.item-row.selected {
  background: color-mix(
    in srgb,
    var(--item-quality, var(--theme-primary)) 8%,
    var(--theme-card-bg)
  );
  border-color: color-mix(
    in srgb,
    var(--item-quality, var(--theme-text-muted)) 45%,
    var(--theme-card-border)
  );
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 6px color-mix(in srgb, currentColor 40%, transparent);
}
.i-name {
  flex: 1;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 0.8125rem;
}
.i-tag {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  flex-shrink: 0;
}
.i-extra {
  font-size: 0.625rem;
  color: var(--theme-text-secondary);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.empty-list {
  padding: 48px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.empty-list::before {
  content: '';
  display: block;
  width: 32px;
  height: 2px;
  background: linear-gradient(to right, transparent, var(--theme-text-muted), transparent);
  opacity: 0.3;
}

/* ═══ 右: 物品详情 — 书卷内页 ═══ */
.detail {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 42.5rem;
  padding: 16px;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}
.d-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--item-detail-border, var(--theme-card-border));
  /* 品质光晕 */
  --glow: color-mix(in srgb, var(--item-detail-glow, var(--theme-text-muted)) 20%, transparent);
  box-shadow: 0 1px 0 0 var(--glow);
}
.d-name {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 1.125rem;
  font-weight: 700;
}
.d-quality {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid;
  letter-spacing: 0.03em;
}
.d-meta {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  display: flex;
  gap: 16px;
}
.d-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.d-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.fx-section {
}
.fx-row {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: 0.8125rem;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 40%, transparent);
}
.fx-row:last-child {
  border-bottom: none;
}
.fx-name {
  color: var(--theme-text-secondary);
  font-weight: 500;
  min-width: 4.375rem;
}
.fx-desc {
  color: var(--theme-text-primary);
}

/* 战斗修正（modifiers + automata 摘要行） */
.combat-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.combat-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 40%, transparent);
}
.combat-row:last-child {
  border-bottom: none;
}
.combat-icon {
  color: var(--theme-primary, #c9a24b);
  font-size: 0.75rem;
  flex-shrink: 0;
}
.fx-empty {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
  padding: 3px 0;
}

.d-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-style: italic;
}

/* 脚本 */
.script-section {
  margin-top: auto;
  border-top: 1px solid var(--theme-card-border);
  padding-top: 8px;
}
.script-toggle {
  padding: 5px 10px;
  border: 1px solid var(--theme-card-border);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: var(--theme-radius-sm, 4px);
  transition: color 0.15s;
}
.script-toggle:hover {
  color: var(--theme-text-primary);
}
.script-body {
  margin-top: 8px;
}
.script-block {
  margin-bottom: 8px;
}
.script-label {
  font-size: 0.6875rem;
  color: var(--theme-accent, #f59e0b);
  font-weight: 600;
  margin-bottom: 2px;
}
.script-code {
  background: #0d1117;
  color: #c9d1d9;
  font-family: 'Cascadia Code', 'JetBrains Mono', monospace;
  font-size: 0.625rem;
  padding: 10px;
  border-radius: var(--theme-radius-sm, 4px);
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 0;
  max-height: 160px;
  overflow-y: auto;
}
.script-empty {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-style: italic;
}

/* 未选择 */
.detail-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  font-style: italic;
  background: var(--theme-card-bg);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
}
.detail-empty::before {
  content: '';
  display: block;
  width: 48px;
  height: 1px;
  background: linear-gradient(to right, transparent, var(--theme-text-muted), transparent);
  opacity: 0.3;
}

.empty {
  padding: 48px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  font-style: italic;
}
</style>
