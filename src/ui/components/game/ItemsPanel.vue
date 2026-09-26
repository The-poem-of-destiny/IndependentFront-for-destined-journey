<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { qualityVar } from '../../lib/quality-colors';
// 条目展示逻辑（品质/分类/详情字段/效果/战斗修正）收敛到 item-view —— 与 NPC 查看器共用同一份
import { qualityOf, qualityRank, facetOf, listExtra, type PanelEntry } from '../../lib/item-view';
import ItemDetailBody from './ItemDetailBody.vue';
// 🆕 重铸（2026-08-24）：单条目重铸 —— 把当前条目的完整数据喂给 item_gen 重写
import type { RewriteTarget } from '@engine/item-gen-chain';

const game = useGameStore();
const ui = useUIStore();

type Category = 'inventory' | 'equipment' | 'skills';
const activeCategory = ref<Category>('inventory');
const activeFilter = ref('全部');
const selectedIdx = ref(0);

const player = computed(() => game.player);

// ═══ 数据 ═══
// M6 完整重构: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3），最小适配 filter 惯用式
const inventoryItems = computed(() => player.value?.inventory || []);
const equipmentItems = computed(() =>
  (player.value?.inventory ?? []).filter((i) => i.equippedSlot),
);
const skillItems = computed(() => player.value?.skills || []);

// 面板里的一行 = item-view 的 PanelEntry（判别联合；Q-11 起沿用，与 NPC 查看器共用）

const currentItems = computed<PanelEntry[]>(() => {
  const inv = Array.isArray(player.value?.inventory) ? player.value.inventory : [];
  const skills = Array.isArray(player.value?.skills) ? player.value.skills : [];
  switch (activeCategory.value) {
    case 'inventory':
      return inv.map((row) => ({ kind: 'item' as const, row }));
    case 'equipment':
      return inv.filter((i) => i.equippedSlot).map((row) => ({ kind: 'item' as const, row }));
    case 'skills':
      return skills.map((row) => ({ kind: 'skill' as const, row }));
  }
  return []; // ← 防御
});

const filterOptions = computed(() => {
  const types = new Set<string>();
  for (const entry of currentItems.value) {
    const t = facetOf(entry, activeCategory.value);
    if (t) types.add(t);
  }
  return ['全部', ...Array.from(types)];
});

const filteredItems = computed(() => {
  if (activeFilter.value === '全部') return currentItems.value;
  return currentItems.value.filter(
    (entry) => facetOf(entry, activeCategory.value) === activeFilter.value,
  );
});

const sortedItems = computed(() => {
  // 品质序号走 item-view 的 qualityRank（引擎 QUALITY_RANK 唯一真源）
  return [...filteredItems.value].sort(
    (a, b) => qualityRank(b) - qualityRank(a) || a.row.name.localeCompare(b.row.name),
  );
});

watch([activeCategory, activeFilter], () => {
  selectedIdx.value = 0;
});

// ═══ 外部聚焦 — StatusOverview 点击持有物 → 切类目并选中该物品 ═══
function applyItemFocus() {
  const focus = game.pendingItemFocus;
  if (!focus) return;
  activeCategory.value = focus.category;
  activeFilter.value = '全部';
  nextTick(() => {
    const idx = sortedItems.value.findIndex((e) => e.row.name === focus.itemName);
    if (idx >= 0) selectedIdx.value = idx;
    game.clearItemFocus();
  });
}
watch(() => game.pendingItemFocus, applyItemFocus);
onMounted(applyItemFocus);

// ═══ 选中物品 ═══
const selected = computed(() => sortedItems.value[selectedIdx.value] || null);

// ═══ 玩家主动丢弃/删除（清理持有物）═══

const removing = ref(false);

/** 丢弃背包物品（含装备）：整叠丢弃，确认后走 remove_item op。 */
async function discardSelectedItem() {
  const entry = selected.value;
  if (!entry || entry.kind !== 'item') return;
  const row = entry.row;
  const name = row.name;
  const label = row.equippedSlot ? `装备「${name}」` : `物品「${name}」`;
  const ok = window.confirm(`丢弃${label}？丢弃后不可恢复。`);
  if (!ok) return;
  removing.value = true;
  const result = await game.removeItem(name, row.quantity ?? 1);
  removing.value = false;
  if (result.ok) {
    ui.toast(`已丢弃「${name}」`, 'info');
  } else {
    ui.toast(result.error || '丢弃失败', 'error');
  }
}

/** 删除技能：确认后走 remove_skill op。 */
async function removeSelectedSkill() {
  const entry = selected.value;
  if (!entry || entry.kind !== 'skill') return;
  const name = entry.row.name;
  const ok = window.confirm(`删除技能「${name}」？删除后不可恢复。`);
  if (!ok) return;
  removing.value = true;
  const result = await game.removeSkill(name);
  removing.value = false;
  if (result.ok) {
    ui.toast(`已删除技能「${name}」`, 'info');
  } else {
    ui.toast(result.error || '删除失败', 'error');
  }
}

// ═══ 重铸（单条目，2026-08-24）═══

const rewriteOpen = ref(false);
const rewriteDesc = ref('');
const rewriting = ref(false);

// 切换条目 / 类目时收起重铸面板
watch([selectedIdx, activeCategory], () => {
  rewriteOpen.value = false;
  rewriteDesc.value = '';
});

/**
 * 把当前选中的条目转成引擎的 RewriteTarget（喂给 item_gen 当 <重铸目标> 的「当前完整数据」）。
 * 关键字段（effects/scripts/modifiers/buffs/divinity/automata/skillPower…）逐项透传，
 * 让 AI 能看到这条现状 —— 否则它无从知道「哪里不对」。
 */
function buildRewriteTarget(entry: PanelEntry): RewriteTarget {
  const row = entry.row as any;
  if (entry.kind === 'skill') {
    return {
      kind: 'skill',
      entry: {
        name: row.name,
        description: row.description ?? '',
        type: row.type === 'passive' ? 'passive' : 'active',
        ...(row.cost ? { cost: row.cost } : {}),
        ...(row.cooldown !== undefined ? { cooldown: row.cooldown } : {}),
        ...(row.effects ? { effects: row.effects } : {}),
        ...(row.scripts ? { scripts: row.scripts } : {}),
        ...(row.modifiers?.length ? { modifiers: row.modifiers } : {}),
        ...(row.buffs?.length ? { buffs: row.buffs } : {}),
        ...(row.divinity !== undefined ? { divinity: row.divinity } : {}),
        ...(row.automata?.length ? { automata: row.automata } : {}),
        ...(row.skillPower !== undefined ? { skillPower: row.skillPower } : {}),
        ...(row.relevantAttribute ? { relevantAttribute: row.relevantAttribute } : {}),
        ...(row.damageType ? { damageType: row.damageType } : {}),
      },
    };
  }
  if (row.equippedSlot) {
    return {
      kind: 'equipment',
      entry: {
        slot: row.equippedSlot,
        name: row.name,
        description: row.description ?? '',
        stats: row.stats ?? {},
        ...(row.durability !== undefined ? { durability: row.durability } : {}),
        ...(row.rarity ? { quality: row.rarity } : {}),
        ...(row.effects ? { effects: row.effects } : {}),
        ...(row.scripts ? { scripts: row.scripts } : {}),
        ...(row.modifiers?.length ? { modifiers: row.modifiers } : {}),
        ...(row.buffs?.length ? { buffs: row.buffs } : {}),
        ...(row.divinity !== undefined ? { divinity: row.divinity } : {}),
        ...(row.automata?.length ? { automata: row.automata } : {}),
      },
    };
  }
  return {
    kind: 'inventory',
    entry: {
      name: row.name,
      description: row.description ?? '',
      quantity: row.quantity ?? 1,
      type: row.type ?? '物品',
      ...(row.rarity ? { rarity: row.rarity } : {}),
      ...(row.effects ? { effects: row.effects } : {}),
      ...(row.scripts ? { scripts: row.scripts } : {}),
      ...(row.modifiers?.length ? { modifiers: row.modifiers } : {}),
      ...(row.buffs?.length ? { buffs: row.buffs } : {}),
      ...(row.divinity !== undefined ? { divinity: row.divinity } : {}),
      ...(row.automata?.length ? { automata: row.automata } : {}),
    },
  };
}

/** 执行重铸：remove 旧 + add 新同一事务（引擎侧），成功回读刷新。 */
async function doRewrite() {
  const entry = selected.value;
  if (!entry || !game.player?.name) return;
  rewriting.value = true;
  const result = await game.rewriteLoadoutItem(
    game.player.name,
    buildRewriteTarget(entry),
    rewriteDesc.value.trim(),
  );
  rewriting.value = false;
  rewriteOpen.value = false;
  if (result.ok) {
    ui.toast(`已重铸「${entry.row.name}」`, 'success');
  } else {
    ui.toast(result.reason || '重铸失败', 'error');
  }
}
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
          v-for="(entry, i) in sortedItems"
          :key="entry.row.name || i"
          class="item-row"
          :class="{ selected: i === selectedIdx }"
          @click="selectedIdx = i"
        >
          <span class="dot" :style="{ background: qualityVar(qualityOf(entry)) }" />
          <span class="i-name" :style="{ color: qualityVar(qualityOf(entry)) }">{{
            entry.row.name
          }}</span>
          <span class="i-tag">{{ facetOf(entry, activeCategory) }}</span>
          <span class="i-extra">{{ listExtra(entry, activeCategory) }}</span>
        </div>
      </div>

      <!-- 右: 详情（正文与 NPC 查看器共用 ItemDetailBody） -->
      <div v-if="selected" class="detail">
        <ItemDetailBody :entry="selected" :category="activeCategory" />

        <!-- 删除/丢弃 -->
        <div class="detail-remove">
          <button
            v-if="selected.kind === 'item'"
            class="remove-btn"
            :disabled="removing"
            @click="discardSelectedItem"
          >
            丢弃{{ selected.row.equippedSlot ? '装备' : '' }}
          </button>
          <button
            v-else-if="selected.kind === 'skill'"
            class="remove-btn"
            :disabled="removing"
            @click="removeSelectedSkill"
          >
            删除技能
          </button>
          <button class="rewrite-btn" :disabled="rewriting" @click="rewriteOpen = !rewriteOpen">
            {{ rewriteOpen ? '收起重铸' : '重铸' }}
          </button>
        </div>

        <!-- 重铸描述（可选：玩家说哪里不对，AI 据此修正） -->
        <div v-if="rewriteOpen" class="rewrite-body">
          <p class="rewrite-hint">
            描述这条现状的问题（可留空）。例：火球术伤害不对，应该 400 能量伤害却只有 200 物理伤害。
          </p>
          <textarea
            v-model="rewriteDesc"
            rows="3"
            class="rewrite-desc"
            placeholder="可选：哪里不对…"
          />
          <button class="rewrite-confirm" :disabled="rewriting" @click="doRewrite">
            {{ rewriting ? '重铸中…' : '确认重铸' }}
          </button>
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

.detail-remove {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--theme-card-border);
}
.remove-btn {
  padding: 5px 12px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-danger, #e5484d);
  background: color-mix(in srgb, var(--theme-danger, #e5484d) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-danger, #e5484d) 40%, transparent);
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.remove-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-danger, #e5484d) 18%, transparent);
}
.remove-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ═══ 重铸（单条目，2026-08-24）═══ */
.rewrite-btn {
  margin-left: 8px;
  padding: 5px 12px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-primary, #c9a24b);
  background: color-mix(in srgb, var(--theme-primary, #c9a24b) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary, #c9a24b) 40%, transparent);
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.rewrite-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-primary, #c9a24b) 18%, transparent);
}
.rewrite-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.rewrite-body {
  margin-top: 10px;
  padding: 10px 12px;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rewrite-hint {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  line-height: 1.5;
}
.rewrite-desc {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-text-primary);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  resize: vertical;
}
.rewrite-desc:focus {
  outline: none;
  border-color: var(--theme-primary, #c9a24b);
}
.rewrite-confirm {
  align-self: flex-end;
  padding: 5px 14px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-primary-text, #fff);
  background: var(--theme-primary, #c9a24b);
  border: none;
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  transition: opacity var(--theme-transition-fast);
}
.rewrite-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.empty {
  padding: 48px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  font-style: italic;
}
</style>
