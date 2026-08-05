<script setup lang="ts">
import type { ItemGenSystemEvent } from '@engine/types';
import { qualityVar } from '../../../lib/quality-colors';

// 模板里直接用 `event`，无需在 script 里持有引用 —— defineProps 只是声明
defineProps<{ event: ItemGenSystemEvent }>();
const emit = defineEmits<{ collapse: [] }>();

function typeIcon(itemType: string): string {
  if (itemType === '装备') return 'fa-solid fa-shield-halved';
  if (itemType === '技能') return 'fa-solid fa-wand-magic-sparkles';
  return 'fa-solid fa-flask';
}
</script>

<template>
  <div class="sys-card" :style="{ '--sys-accent': qualityVar(event.quality) }">
    <div class="sys-card-header" @click="emit('collapse')">
      <span class="sys-card-dot" />
      <i :class="'sys-card-icon ' + typeIcon(event.itemType)" />
      <span class="sys-card-title">{{ event.itemName }}</span>
      <span class="sys-card-quality" :style="{ color: qualityVar(event.quality) }">{{
        event.quality
      }}</span>
      <i class="fa-solid fa-chevron-up sys-card-collapse" title="收起" />
    </div>

    <div class="sys-card-body">
      <!-- 装备列表 -->
      <div v-if="event.details.equipment?.length" class="section">
        <div v-for="eq in event.details.equipment" :key="eq.name" class="equip-line">
          <span class="equip-slot">{{ eq.slot }}</span>
          <span class="equip-name">{{ eq.name }}</span>
          <span v-if="eq.description" class="equip-desc"
            >{{ eq.description.slice(0, 120) }}{{ eq.description.length > 120 ? '...' : '' }}</span
          >
          <span v-if="eq.stats && Object.keys(eq.stats).length" class="equip-stats">
            <span v-for="(v, k) in eq.stats" :key="k" class="stat-kv">{{ k }}+{{ v }}</span>
          </span>
        </div>
      </div>

      <!-- 技能列表 -->
      <div
        v-if="event.details.skills?.length"
        :class="['section', { 'section-divider': event.details.equipment?.length }]"
      >
        <div v-for="sk in event.details.skills" :key="sk.name" class="skill-line">
          <span class="skill-name">{{ sk.name }}</span>
          <span v-if="sk.type" class="skill-type-badge">{{
            sk.type === 'active' ? '主动' : '被动'
          }}</span>
          <span v-if="sk.description" class="skill-desc"
            >{{ sk.description.slice(0, 120) }}{{ sk.description.length > 120 ? '...' : '' }}</span
          >
          <span v-if="sk.cost" class="skill-cost">{{ sk.cost.type }} {{ sk.cost.amount }}</span>
          <span v-if="sk.cooldown" class="skill-cd">CD {{ sk.cooldown }}回合</span>
        </div>
      </div>

      <!-- 背包物品列表 -->
      <div
        v-if="event.details.inventory?.length"
        :class="[
          'section',
          { 'section-divider': event.details.equipment?.length || event.details.skills?.length },
        ]"
      >
        <div v-for="inv in event.details.inventory" :key="inv.name" class="inv-line">
          <span class="inv-name">{{ inv.name }} &times;{{ inv.quantity }}</span>
          <span v-if="inv.description" class="inv-desc"
            >: {{ inv.description.slice(0, 100)
            }}{{ inv.description.length > 100 ? '...' : '' }}</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@import '../../../styles/cards-shared.css';
</style>

<style scoped>
/* Override: Item card has no box-shadow background */
.sys-card {
  box-shadow: none;
}

.sys-card-icon {
  font-size: 0.75rem;
  opacity: 0.6;
  width: 1rem;
  text-align: center;
}

.sys-card-title {
  flex: 1;
  font-weight: 700;
  font-size: 0.875rem;
  color: var(--theme-text-primary);
}

.sys-card-quality {
  font-size: 0.75rem;
  font-weight: 600;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-divider {
  border-top: 1px dashed var(--theme-border, rgba(255, 255, 255, 0.08));
  padding-top: 8px;
}

/* 装备行 */
.equip-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.equip-slot {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  font-weight: 600;
  flex-shrink: 0;
}

.equip-name {
  font-weight: 600;
}

.equip-desc {
  opacity: 0.65;
  font-size: 0.75rem;
  flex: 1 1 100%;
}

.equip-stats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.stat-kv {
  font-size: 0.6875rem;
  color: var(--theme-success);
  font-weight: 600;
}

/* 技能行 */
.skill-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
  flex-wrap: wrap;
}

.skill-name {
  color: var(--theme-quality-rare);
  font-weight: 600;
}

.skill-type-badge {
  background: var(--theme-surface-muted);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}

.skill-desc {
  opacity: 0.65;
  font-size: 0.75rem;
  flex: 1 1 100%;
}

.skill-cost {
  font-size: 0.6875rem;
  color: var(--theme-mp);
}

.skill-cd {
  font-size: 0.6875rem;
  opacity: 0.6;
}

/* 背包物品行 */
.inv-line {
  display: flex;
  gap: 6px;
  align-items: baseline;
  flex-wrap: wrap;
}

.inv-name {
  font-weight: 600;
}

.inv-desc {
  opacity: 0.6;
  font-size: 0.75rem;
}
</style>
