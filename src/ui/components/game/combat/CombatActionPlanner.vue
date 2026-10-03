<script setup lang="ts">
/**
 * CombatActionPlanner.vue — 行动规划区（C6 · 数据源 = 沙盒 `CombatState`）
 *
 * 主持人/DM 模式：玩家的选择**拼装成一句意图文本**，经 `submit` 事件交给主持人会话
 * 解析（AI 理解意图 → 工具声明 → 结算）。拼装与自由对话走同一条链路。
 *
 * 全部单位/技能从 `CombatState` 读取；特殊动作卡是协议常量（见 combat-view.ts）。
 */
import { computed, ref, watch } from 'vue';
import type { CombatFacing, CombatState } from '@engine/combat/sandbox/types';
import {
  COMBAT_FACING_LABELS,
  COMBAT_ORDER_OPTIONS,
  COMBAT_SPECIAL_ACTIONS,
  isAwaitingPlayer,
  orderedUnits,
} from './combat-view';

const props = defineProps<{ state: CombatState }>();
const emit = defineEmits<{ submit: [text: string] }>();

const locked = computed(() => !isAwaitingPlayer(props.state));
const allyUnits = computed(() => orderedUnits(props.state, 'ally').filter((u) => u.alive));

type OrderValue = 'attack-action' | 'action-attack';

const selectedUnitName = ref('');
const facing = ref<CombatFacing>('right');
const order = ref<OrderValue>('attack-action');
const inputText = ref('');

const FACE_OPTIONS: ReadonlyArray<{ value: CombatFacing; label: string }> = [
  { value: 'right', label: '正向' },
  { value: 'left', label: '负向' },
];

const selectedUnit = computed(() => props.state.units[selectedUnitName.value] ?? null);
const skills = computed(() => selectedUnit.value?.skills ?? []);

/** 等待玩家时把行动者锁定到 `pendingPlayerUnit`；否则退回第一个存活我方 */
watch(
  () => props.state.meta.pendingPlayerUnit,
  (pending) => {
    if (pending && props.state.units[pending]?.alive) selectedUnitName.value = pending;
  },
  { immediate: true },
);
watch(
  allyUnits,
  (units) => {
    if (!selectedUnitName.value || !props.state.units[selectedUnitName.value]) {
      selectedUnitName.value = units[0]?.name ?? '';
    }
  },
  { immediate: true },
);
watch(
  selectedUnit,
  (unit) => {
    if (unit) facing.value = unit.facing;
  },
  { immediate: true },
);

function pickSpecial(name: string) {
  inputText.value = `我方「${selectedUnitName.value}」${name}`;
}

function pickSkill(name: string) {
  inputText.value = `我方「${selectedUnitName.value}」使用技能「${name}」`;
}

/** 面向 / 顺序只在偏离默认时作为补充说明拼进意图 */
function suffix(): string {
  const defaults: string[] = [];
  if (selectedUnit.value && facing.value !== selectedUnit.value.facing) {
    defaults.push(`面向${FACE_OPTIONS.find((o) => o.value === facing.value)?.label ?? ''}`);
  }
  if (order.value === 'action-attack') defaults.push('先动作用攻击');
  return defaults.length ? `（${defaults.join('，')}）` : '';
}

const canSubmit = computed(() => !locked.value && inputText.value.trim().length > 0);

function submit() {
  if (!canSubmit.value) return;
  emit('submit', inputText.value.trim() + suffix());
  inputText.value = '';
}

function endTurn() {
  if (locked.value || !selectedUnitName.value) return;
  emit('submit', `我方「${selectedUnitName.value}」结束本回合`);
}

function onKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submit();
  }
}
</script>

<template>
  <div class="combat-planner" :class="{ 'is-locked': locked }">
    <div class="selectors">
      <label class="sel">
        <span>行动者</span>
        <select v-model="selectedUnitName" :disabled="locked">
          <option v-for="u in allyUnits" :key="u.name" :value="u.name">{{ u.name }}</option>
        </select>
      </label>
      <label class="sel">
        <span>面向</span>
        <select v-model="facing" :disabled="locked">
          <option v-for="opt in FACE_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <label class="sel">
        <span>执行顺序</span>
        <select v-model="order" :disabled="locked">
          <option v-for="opt in COMBAT_ORDER_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <span class="sel-line">
        当前行动：<b>{{ selectedUnit?.name ?? '—' }}</b>
        <template v-if="selectedUnit">
          （{{ COMBAT_FACING_LABELS[selectedUnit.facing] }}）</template
        >
      </span>
    </div>

    <div class="cardrow">
      <button
        v-for="action in COMBAT_SPECIAL_ACTIONS"
        :key="action.key"
        type="button"
        class="acard"
        :disabled="locked"
        @click="pickSpecial(action.name)"
      >
        <span class="ac-name">{{ action.name }}</span>
        <span class="ac-cost">消耗：{{ action.cost }}</span>
        <span class="ac-eff">{{ action.effect }}</span>
        <span class="ac-tags">
          <span v-for="tag in action.tags" :key="tag" class="tag">{{ tag }}</span>
        </span>
      </button>
    </div>

    <div v-if="skills.length" class="skillrow">
      <button
        v-for="skill in skills"
        :key="skill.name"
        type="button"
        class="acard"
        :disabled="locked"
        @click="pickSkill(skill.name)"
      >
        <span class="ac-name">{{ skill.name }}</span>
        <span v-if="skill.cost" class="ac-cost">消耗：{{ skill.cost }}</span>
        <span v-if="skill.description" class="ac-eff">{{ skill.description }}</span>
        <span v-if="skill.tags?.length" class="ac-tags">
          <span v-for="tag in skill.tags" :key="tag" class="tag">{{ tag }}</span>
        </span>
      </button>
    </div>

    <div class="input-row">
      <textarea
        v-model="inputText"
        class="planner-input"
        :disabled="locked"
        rows="2"
        placeholder="描述你的行动，或点击上方动作卡填入选定…（Ctrl / ⌘ + Enter 提交）"
        @keydown="onKeydown"
      />
      <button class="planner-end-turn" :disabled="locked" @click="endTurn">结束回合</button>
      <button class="planner-send" :disabled="!canSubmit" @click="submit">确定</button>
    </div>
  </div>
</template>

<style scoped>
.combat-planner {
  border-top: 1px solid var(--theme-card-border);
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  background: linear-gradient(
    0deg,
    color-mix(in srgb, var(--theme-primary) 5%, transparent),
    transparent
  );
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  flex-shrink: 0;
}
.combat-planner.is-locked {
  opacity: 0.55;
  pointer-events: none;
}

.selectors {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-lg);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.sel {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
}
.sel select {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  padding: 3px 8px;
  font-family: inherit;
  font-size: 0.75rem;
  min-height: 28px;
}
.sel-line b {
  color: var(--theme-primary);
}

.cardrow,
.skillrow {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--theme-spacing-sm);
}
.acard {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color var(--theme-transition-fast),
    background var(--theme-transition-fast);
}
.acard:hover:not(:disabled) {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
}
.acard:disabled {
  cursor: not-allowed;
}
.ac-name {
  font-family: var(--theme-font-title);
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.ac-cost {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.ac-eff {
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
}
.ac-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  margin-top: 2px;
}
.tag {
  font-size: 0.625rem;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  border-radius: var(--theme-radius-sm);
  padding: 0 5px;
}

.input-row {
  display: flex;
  align-items: stretch;
  gap: var(--theme-spacing-sm);
}
.planner-input {
  flex: 1;
  resize: vertical;
  min-height: 44px;
  max-height: 8rem;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body);
  font-size: 0.875rem;
  line-height: 1.5;
}
.planner-input:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
}
.planner-input::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.7;
}
.planner-end-turn,
.planner-send {
  flex: none;
  min-height: 44px;
  padding: 0 var(--theme-spacing-lg);
  border-radius: var(--theme-radius-sm);
  font-family: var(--theme-font-body);
  font-size: 0.875rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    filter var(--theme-transition-fast);
}
.planner-end-turn {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-primary);
}
.planner-end-turn:hover:not(:disabled) {
  border-color: var(--theme-primary);
}
.planner-send {
  background: var(--theme-primary);
  border: 1px solid var(--theme-primary);
  color: var(--theme-primary-text);
  font-weight: 600;
}
.planner-send:hover:not(:disabled) {
  filter: brightness(1.08);
}
.planner-end-turn:disabled,
.planner-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .cardrow,
  .skillrow {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .input-row {
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .acard,
  .planner-end-turn,
  .planner-send {
    transition: none;
  }
}
</style>
