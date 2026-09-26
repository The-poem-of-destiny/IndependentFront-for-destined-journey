<script setup lang="ts">
/**
 * ItemDetailBody.vue — 物品 / 技能详情正文（玩家背包与 NPC 查看器**共用**）
 *
 * 2026-09-12：从 `ItemsPanel.vue` 抽出。两边数据结构等价（InventoryItem / Skill），
 * 共用这一份「品质 + 效果 + 战斗修正 + 描述 + 原始数据」，避免再分叉
 * （此前 NPC 侧缺品质/战斗修正、且 effects 未归一化，显示与主角不一致）。
 *
 * 纯展示：不碰 store、不含删除/重铸等动作（那些由宿主用插槽/外部按钮提供）。
 */
import { computed, ref, watch } from 'vue';
import { qualityVar } from '../../lib/quality-colors';
import {
  qualityOf,
  typeLabel,
  detailExtra,
  entryEffects,
  entryCombatLines,
  entryRawCombatJson,
  type ItemCategory,
  type PanelEntry,
} from '../../lib/item-view';

const props = defineProps<{
  entry: PanelEntry;
  category: ItemCategory;
  /** 无战斗效果时的占位文案（默认按物品措辞） */
  emptyCombatText?: string;
}>();

const quality = computed(() => qualityOf(props.entry));
const effects = computed(() => entryEffects(props.entry));
const combatLines = computed(() => entryCombatLines(props.entry));
const rawCombatJson = computed(() => entryRawCombatJson(props.entry));
const scripts = computed(() => props.entry.row.scripts);
const hasScripts = computed(() => !!scripts.value && Object.keys(scripts.value).length > 0);

const showRaw = ref(false);
watch(
  () => props.entry,
  () => {
    showRaw.value = false;
  },
);
</script>

<template>
  <div
    class="item-detail-body"
    :style="{
      '--item-detail-border': qualityVar(quality),
      '--item-detail-glow': qualityVar(quality),
    }"
  >
    <div class="d-header">
      <span class="d-name" :style="{ color: qualityVar(quality) }">{{ entry.row.name }}</span>
      <span
        class="d-quality"
        :style="{ color: qualityVar(quality), borderColor: qualityVar(quality) }"
        >{{ quality }}</span
      >
    </div>
    <div class="d-meta">
      <span>{{ typeLabel(entry, category) }}</span
      ><span>{{ detailExtra(entry, category) }}</span>
    </div>

    <!-- 效果词条 -->
    <div v-if="effects && Object.keys(effects).length > 0" class="fx-section">
      <div class="d-label">效果</div>
      <div v-for="(desc, name) in effects" :key="name" class="fx-row">
        <span class="fx-name">{{ name }}</span
        ><span class="fx-desc">{{ desc }}</span>
      </div>
    </div>

    <!-- 战斗修正（modifiers + automata 中文摘要） -->
    <div class="fx-section">
      <div class="d-label">战斗修正</div>
      <div v-if="combatLines.length" class="combat-list">
        <div v-for="(line, i) in combatLines" :key="i" class="combat-row">
          <span class="combat-icon" aria-hidden="true">⚔</span>
          <span>{{ line }}</span>
        </div>
      </div>
      <div v-else class="fx-empty">{{ emptyCombatText || '该物品无战斗效果' }}</div>
    </div>

    <!-- 描述 -->
    <div v-if="entry.row.description" class="desc-section">
      <div class="d-label">描述</div>
      <p class="d-desc">{{ entry.row.description }}</p>
    </div>

    <!-- 原始数据 -->
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
            <div v-for="(code, name) in scripts" :key="name" class="script-block">
              <div class="script-label">{{ name }}</div>
              <pre class="script-code">{{ code }}</pre>
            </div>
          </div>
        </template>
        <div v-else class="script-empty">(该物品无原始数据)</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.item-detail-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ═══ 头部：名称 + 品质 ═══ */
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

/* ═══ 效果词条 ═══ */
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

/* ═══ 战斗修正 ═══ */
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

/* ═══ 描述 ═══ */
.d-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-style: italic;
}

/* ═══ 原始数据 ═══ */
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
</style>
