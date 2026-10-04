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
  orderedUnits,
} from './combat-view';

const props = defineProps<{ state: CombatState }>();
const emit = defineEmits<{ submit: [text: string] }>();

// 规划区只在 `combatBusy=false`（主持人空闲）时由 CombatPanel 渲染。
const locked = ref(false);
const allyUnits = computed(() => orderedUnits(props.state, 'ally').filter((u) => u.alive));

type OrderValue = 'attack-action' | 'action-attack';

// 🔴 行动者锁定到「当前轮到的那位」(`meta.pendingPlayerUnit`)，无则退回第一个存活我方。
//    玩家不再自由选择行动者（此前那个下拉让人可全选，与回合交接对不上）。
const actorName = computed(() => {
  const pending = props.state.meta.pendingPlayerUnit;
  if (pending && props.state.units[pending]?.alive) return pending;
  return allyUnits.value[0]?.name ?? '';
});
const actor = computed(() => props.state.units[actorName.value] ?? null);
const skills = computed(() => actor.value?.skills ?? []);

const facing = ref<CombatFacing>('right');
const order = ref<OrderValue>('attack-action');
/** 本回合选定的攻击（技能卡）与动作（特殊动作卡）—— 可同时选，一起提交 */
const attackPick = ref('');
const actionPick = ref('');
/** 自由补充（无法用卡片表达时写这里） */
const inputText = ref('');

const FACE_OPTIONS: ReadonlyArray<{ value: CombatFacing; label: string }> = [
  { value: 'right', label: '正向' },
  { value: 'left', label: '负向' },
];

watch(
  actor,
  (unit) => {
    if (unit) facing.value = unit.facing;
  },
  { immediate: true },
);

function pickAttack(name: string) {
  attackPick.value = attackPick.value === name ? '' : name;
}
function pickAction(name: string) {
  actionPick.value = actionPick.value === name ? '' : name;
}
function clearPicks() {
  attackPick.value = '';
  actionPick.value = '';
  inputText.value = '';
}

/** 面向 / 顺序只在偏离默认时作为补充说明拼进意图 */
function suffix(): string {
  const defaults: string[] = [];
  if (actor.value && facing.value !== actor.value.facing) {
    defaults.push(`面向${FACE_OPTIONS.find((o) => o.value === facing.value)?.label ?? ''}`);
  }
  if (order.value === 'action-attack') defaults.push('先动作后攻击');
  return defaults.length ? `（${defaults.join('，')}）` : '';
}

/** 把「攻击 + 动作 + 自由补充」拼成一句完整意图 */
function compose(): string {
  const picks: string[] = [];
  if (attackPick.value) picks.push(`攻击用「${attackPick.value}」`);
  if (actionPick.value) picks.push(`动作用「${actionPick.value}」`);
  let text = `我方「${actorName.value}」`;
  if (picks.length) text += '：' + picks.join('，');
  const free = inputText.value.trim();
  if (free) text += (picks.length ? '。' : '：') + free;
  return text + suffix();
}

const canSubmit = computed(
  () =>
    !locked.value &&
    !!actorName.value &&
    (!!attackPick.value || !!actionPick.value || inputText.value.trim().length > 0),
);

function submit() {
  if (!canSubmit.value) return;
  emit('submit', compose());
  clearPicks();
}

function endTurn() {
  if (locked.value || !actorName.value) return;
  emit('submit', `我方「${actorName.value}」结束本回合`);
  clearPicks();
}

/** 纯发送「继续」——主持人莫名停下时，玩家用来推它一把，别无脑替玩家做决定 */
function emitContinue() {
  if (locked.value) return;
  emit('submit', '继续');
  clearPicks();
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
      <span class="sel-line">
        当前行动：<b>{{ actor?.name ?? '—' }}</b>
        <template v-if="actor">（{{ COMBAT_FACING_LABELS[actor.facing] }}）</template>
      </span>
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
    </div>

    <!-- 攻击（选一）：普攻 + 该行动者的技能。可与「动作」一起提交。 -->
    <div class="pickrow">
      <div class="pickrow-label">攻击（选一）</div>
      <div class="cardrow">
        <button
          type="button"
          class="acard"
          :class="{ 'is-picked': attackPick === '普通攻击' }"
          :disabled="locked"
          @click="pickAttack('普通攻击')"
        >
          <span class="ac-name">普通攻击</span>
          <span class="ac-eff">不消耗 MP 的基础攻击</span>
        </button>
        <button
          v-for="skill in skills"
          :key="skill.name"
          type="button"
          class="acard"
          :class="{ 'is-picked': attackPick === skill.name }"
          :disabled="locked"
          @click="pickAttack(skill.name)"
        >
          <span class="ac-name">{{ skill.name }}</span>
          <span v-if="skill.cost" class="ac-cost">消耗：{{ skill.cost }}</span>
          <span v-if="skill.description" class="ac-eff">{{ skill.description }}</span>
          <span v-if="skill.tags?.length" class="ac-tags">
            <span v-for="tag in skill.tags" :key="tag" class="tag">{{ tag }}</span>
          </span>
        </button>
      </div>
    </div>

    <!-- 动作（选一）：战术动作。可与「攻击」一起提交 —— 两者都选定后一次提交。 -->
    <div class="pickrow">
      <div class="pickrow-label">动作（选一）</div>
      <div class="cardrow">
        <button
          v-for="action in COMBAT_SPECIAL_ACTIONS"
          :key="action.key"
          type="button"
          class="acard"
          :class="{ 'is-picked': actionPick === action.name }"
          :disabled="locked"
          @click="pickAction(action.name)"
        >
          <span class="ac-name">{{ action.name }}</span>
          <span class="ac-cost">消耗：{{ action.cost }}</span>
          <span class="ac-eff">{{ action.effect }}</span>
          <span class="ac-tags">
            <span v-for="tag in action.tags" :key="tag" class="tag">{{ tag }}</span>
          </span>
        </button>
      </div>
    </div>

    <div class="input-row">
      <textarea
        v-model="inputText"
        class="planner-input"
        :disabled="locked"
        rows="2"
        placeholder="补充说明（可选），如指定目标/落点/与队友配合…（Ctrl / ⌘ + Enter 提交）"
        @keydown="onKeydown"
      />
      <button class="planner-clear" :disabled="locked" @click="clearPicks">清空</button>
      <button class="planner-continue" :disabled="locked" @click="emitContinue">继续</button>
      <button class="planner-end-turn" :disabled="locked" @click="endTurn">结束回合</button>
      <button class="planner-send" :disabled="!canSubmit" @click="submit">提交行动</button>
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
  /* 🔴 上限高度：规划区再花哨也不许把上面的战斗区挤没；超出自己滚 */
  max-height: 44vh;
  overflow-y: auto;
  scrollbar-width: thin;
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

.pickrow {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.pickrow-label {
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: var(--theme-text-muted);
}
.cardrow,
.skillrow {
  /* 🔴 单行横向滚动，不换行 —— 卡片多了也不把上面的战斗区挤扁 */
  display: flex;
  flex-wrap: nowrap;
  gap: var(--theme-spacing-sm);
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;
}
.acard.is-picked {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 16%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-primary) inset;
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
  /* 固定宽度卡片：一排横向滚动，高度受控 */
  flex: 0 0 13rem;
  max-width: 13rem;
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
  /* 最多两行，超出省略 —— 卡片高度别失控 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
.planner-clear,
.planner-continue,
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
.planner-clear,
.planner-continue,
.planner-end-turn {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-primary);
}
.planner-clear:hover:not(:disabled),
.planner-continue:hover:not(:disabled),
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
.planner-clear:disabled,
.planner-continue:disabled,
.planner-end-turn:disabled,
.planner-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 720px) {
  .input-row {
    flex-wrap: wrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .acard,
  .planner-clear,
  .planner-end-turn,
  .planner-send {
    transition: none;
  }
}
</style>
