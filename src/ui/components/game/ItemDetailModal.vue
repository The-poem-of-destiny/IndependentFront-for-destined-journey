<script setup lang="ts">
/**
 * ItemDetailModal.vue —— 物品/技能/装备详情弹窗（轻量摘要 + 原始数据折叠）
 *
 * 设计：docs/superpowers/specs/2026-08-02-item-detail-summary-design.md §3.3
 *
 * 分层：默认只展示人读的摘要（effects 词条 + 战斗修正 + 描述）；
 *      点「查看原始数据」才暴露 modifiers/automata/scripts 的原始 JSON/代码。
 */
import { computed, ref, watch } from 'vue';
import AppModal from '../shared/AppModal.vue';
import { describeModifiers } from '@engine/describe-modifier';
import { describeAutomata } from '@engine/describe-automaton';
import { qualityVar } from '../../lib/quality-colors';

const props = defineProps<{
  open: boolean;
  item: any;
  category: string;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const showRaw = ref(false);

const selQuality = computed(() => {
  const item = props.item;
  if (!item) return '普通';
  if (item.rarity) return item.rarity;
  if (props.category === 'skills') return '史诗';
  return '普通';
});

const selTypeLabel = computed(() => {
  const item = props.item;
  if (!item) return '';
  if (props.category === 'equipment') return item.equippedSlot || '装备';
  if (props.category === 'skills') return item.type === 'active' ? '主动技能' : '被动技能';
  return item.type || '物品';
});

const selExtra = computed(() => {
  const item = props.item;
  if (!item) return '';
  if (props.category === 'inventory') return `×${item.quantity || 1}`;
  if (props.category === 'equipment')
    return `${item.durability || '?'}/${item.maxDurability || '?'} 耐久`;
  return `Lv.${item.level || 1}`;
});

const effects = computed(() => props.item?.effects as Record<string, string> | undefined);
const hasEffects = computed(() => !!effects.value && Object.keys(effects.value).length > 0);

const modifierLines = computed(() => describeModifiers(props.item?.modifiers));
const automatonLines = computed(() => describeAutomata(props.item?.automata));
const combatLines = computed(() => [...modifierLines.value, ...automatonLines.value]);
const hasCombat = computed(() => combatLines.value.length > 0);

const hasScripts = computed(
  () => !!props.item?.scripts && Object.keys(props.item.scripts).length > 0,
);

/** 原始数据 JSON（modifiers + automata） */
const rawCombatJson = computed(() => {
  const parts: string[] = [];
  if (props.item?.modifiers?.length) parts.push(JSON.stringify(props.item.modifiers, null, 2));
  if (props.item?.automata?.length) parts.push(JSON.stringify(props.item.automata, null, 2));
  return parts.join('\n\n');
});

watch(
  () => props.open,
  (val) => {
    if (val) showRaw.value = false;
  },
);
</script>

<template>
  <AppModal
    :open="open"
    :title="item?.name || '详情'"
    size="md"
    @update:open="emit('update:open', $event)"
  >
    <div v-if="item" class="idm">
      <!-- 元信息行 -->
      <div class="idm-meta">
        <span>{{ selTypeLabel }}</span>
        <span class="idm-quality" :style="{ color: qualityVar(selQuality) }">{{
          selQuality
        }}</span>
        <span>{{ selExtra }}</span>
      </div>

      <!-- 效果词条 -->
      <div v-if="hasEffects" class="idm-section">
        <div class="idm-label">效果</div>
        <div v-for="(desc, name) in effects" :key="name" class="idm-row">
          <span class="idm-k">{{ name }}</span><span>{{ desc }}</span>
        </div>
      </div>

      <!-- 战斗修正（modifiers + automata 摘要） -->
      <div class="idm-section">
        <div class="idm-label">战斗修正</div>
        <div v-if="hasCombat" class="idm-combat">
          <div v-for="(line, i) in combatLines" :key="i" class="idm-combat-row">
            <span class="idm-combat-icon">⚔</span>{{ line }}
          </div>
        </div>
        <div v-else class="idm-empty">该物品无战斗效果</div>
      </div>

      <!-- 描述 -->
      <div v-if="item.description" class="idm-section">
        <div class="idm-label">描述</div>
        <p class="idm-desc">{{ item.description }}</p>
      </div>

      <!-- 原始数据折叠 -->
      <div class="idm-raw">
        <button class="idm-raw-toggle" @click="showRaw = !showRaw">
          {{ showRaw ? '收起原始数据' : '查看原始数据' }}
        </button>
        <div v-if="showRaw" class="idm-raw-body">
          <template v-if="rawCombatJson || hasScripts">
            <div v-if="rawCombatJson" class="idm-raw-block">
              <div class="idm-raw-label">modifiers / automata</div>
              <pre class="idm-raw-code">{{ rawCombatJson }}</pre>
            </div>
            <div v-if="hasScripts" class="idm-raw-block">
              <div class="idm-raw-label">scripts</div>
              <div v-for="(code, name) in item.scripts" :key="name" class="idm-raw-script">
                <div class="idm-raw-name">{{ name }}</div>
                <pre class="idm-raw-code">{{ code }}</pre>
              </div>
            </div>
          </template>
          <div v-else class="idm-empty">该物品无原始数据</div>
        </div>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.idm {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.idm-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--theme-card-border);
}
.idm-quality {
  font-weight: 600;
  font-size: 0.6875rem;
  padding: 1px 8px;
  border-radius: var(--theme-radius-sm);
  border: 1px solid currentColor;
}
.idm-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.idm-label {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.idm-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.idm-row {
  display: flex;
  gap: 10px;
  padding: 2px 0;
  font-size: 0.8125rem;
}
.idm-k {
  color: var(--theme-text-secondary);
  min-width: 4.375rem;
  font-weight: 500;
}
.idm-combat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.idm-combat-row {
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}
.idm-combat-icon {
  color: var(--theme-primary, #c9a24b);
  font-size: 0.75rem;
}
.idm-empty {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
}
.idm-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  margin: 0;
  font-style: italic;
}
.idm-raw {
  margin-top: auto;
  border-top: 1px solid var(--theme-card-border);
  padding-top: 8px;
}
.idm-raw-toggle {
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
.idm-raw-toggle:hover {
  color: var(--theme-text-primary);
}
.idm-raw-body {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.idm-raw-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.idm-raw-label {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  font-weight: 600;
}
.idm-raw-name {
  font-size: 0.6875rem;
  color: var(--theme-accent, #f59e0b);
  font-weight: 600;
}
.idm-raw-code {
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
  max-height: 200px;
  overflow-y: auto;
}
.idm-raw-script {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
