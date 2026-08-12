<script setup lang="ts">
/**
 * CombatActionBar.vue — 战斗操作栏（M5 前端战斗面板 P4 子组件）
 *
 * 🎭 主持人/DM 模式（2026-08-12）：玩家输入**一律走意图文本 → 战斗主持人解析**。
 * 四步拼装（单位→行动类型→技能/道具→目标）把玩家的选择**格式化成一句自然语言**
 * 经 `submitCombatIntent` 交给 combat_v3 主持人会话；自由文本框原样提交。AI 理解
 * 玩家想做什么 → 调 declare_* 工具声明动作 → 内核校验执行。拼装与对话同一条链路。
 *
 * 数据来源：useGameStore（v3ActiveCombat / combatAwaitingInput / characters /
 * submitCombatIntent）。敌我单位从 v3ActiveCombat.units 字典按 initiativeOrder
 * + side 投影（决策 A2，见 combat-v3-projection.ts）。
 *
 * 设计规范遵循 docs/design.md：
 * - 间距用 --theme-spacing-* 变量（§3）
 * - 圆角 var(--theme-radius-sm)（§4）
 * - 过渡 var(--theme-transition-fast)（§6）
 * - selected 态 var(--theme-primary) 8% 染底（§4.2）
 * - 文本框 var(--theme-card-bg) 底 + var(--theme-card-border) 边
 * - 触摸目标 >= 36px（§7 可达性）
 * - disabled 用 .is-disabled 类（避开全局 .disabled 陷阱，CLAUDE.md 编码模式）
 * - prefers-reduced-motion 检查清单（§6.3）
 */

import { ref, computed, watch } from 'vue';
import { useGameStore } from '../../../stores/game-store';
import { useUIStore } from '../../../stores/ui-store';
import type { CharacterState, Skill, InventoryItem } from '@engine/types';
import { projectUnitsBySide, type V3Unit } from './combat-v3-projection';

const game = useGameStore();
const ui = useUIStore();

// ════════════════════════════════════════
//  派生状态
// ════════════════════════════════════════

/** 当前是否轮到我方输入（null = 敌方回合/非战斗） */
const awaiting = computed(() => game.combatAwaitingInput);

/** 整个操作栏是否禁用（敌方回合或非战斗态） */
const isLocked = computed(() => !awaiting.value);

/**
 * 当前行动单位（awaiting.unitId 对应的在场单位）——读攻击/动作槽剩余量，
 * 决定哪些行动按钮可用。v3 单位卡片数据源：v3ActiveCombat.units 字典。
 */
const currentUnit = computed<V3Unit | undefined>(() => {
  const id = awaiting.value?.unitId;
  if (!id || !game.v3ActiveCombat) return undefined;
  return game.v3ActiveCombat.units[id];
});

/**
 * 🆕 2026-08-12（Bug 2 UI 侧）：攻击槽是否已耗尽。
 * 原版规则每单位每回合 1[攻击]+1[动作]（世界书 uid 435）：攻击槽用完后**再点攻击**
 * 会被内核 SLOT_EXHAUSTED 拒绝（此前还因 coordinator 熔断 abandon 整场 → 页面闪退）。
 * 现在按钮层直接禁用「普攻 / 技能」（都是占攻击槽的行动），并给玩家文案提示。
 */
const attackSlotExhausted = computed(() => {
  const u = currentUnit.value;
  if (!u) return false;
  return u.attacksRemaining <= 0;
});

/** 动作槽是否已耗尽（防御/道具/移动/专注等占动作槽；耗尽时只留「结束回合」） */
const actionSlotExhausted = computed(() => {
  const u = currentUnit.value;
  if (!u) return false;
  return u.actionsRemaining <= 0;
});

/** 我方参战单位列表（v3：player 阵营 + 存活） */
const allyUnits = computed<V3Unit[]>(() =>
  projectUnitsBySide(game.v3ActiveCombat, 'player').filter((u) => u.hp > 0),
);

/** 敌方参战单位列表（选目标用，v3：enemy 阵营 + 存活） */
const enemyUnits = computed<V3Unit[]>(() =>
  projectUnitsBySide(game.v3ActiveCombat, 'enemy').filter((u) => u.hp > 0),
);

// ════════════════════════════════════════
//  四步拼装状态
// ════════════════════════════════════════

type ActionType = 'attack' | 'skill' | 'item' | 'defend' | 'flee';

/** 步骤 1：选中的我方单位 characterId */
const selectedUnitId = ref<string>('');
/** 步骤 2：选中的行动类型 */
const selectedAction = ref<ActionType | ''>('');
/** 步骤 3：选中的技能名 / 道具名 */
const selectedDetail = ref<string>('');
/** 步骤 4：选中的目标 characterId */
const selectedTargetId = ref<string>('');

/** 自由文本框内容 */
const inputText = ref('');

// ════════════════════════════════════════
//  单位 → CharacterState 查询（读技能/道具/武器）
// ════════════════════════════════════════

/** 按 characterId 从 game.characters 查 CharacterState */
function findCharacter(charId: string): CharacterState | undefined {
  return game.characters.find((c) => c.id === charId);
}

/** 当前选中单位的 CharacterState */
const selectedCharacter = computed<CharacterState | undefined>(() =>
  selectedUnitId.value ? findCharacter(selectedUnitId.value) : undefined,
);

// ── 技能列表（仅 active 类型可主动施放）──
const availableSkills = computed<Skill[]>(() => {
  const char = selectedCharacter.value;
  if (!char) return [];
  return (char.skills ?? []).filter((s) => s.type === 'active');
});

// ── 道具列表（消耗品/可用物品）──
const availableItems = computed<InventoryItem[]>(() => {
  const char = selectedCharacter.value;
  if (!char) return [];
  return (char.inventory ?? []).filter(
    (item) => (item.type === 'consumable' || item.type === 'material') && item.quantity > 0,
  );
});

// ════════════════════════════════════════
//  行动类型 Tab 定义
// ════════════════════════════════════════

interface ActionTab {
  type: ActionType;
  label: string;
  /** 该行动是否需要选目标 */
  needsTarget: boolean;
  /** 该行动是否需要选技能/道具 */
  needsDetail: boolean;
}

const ACTION_TABS: readonly ActionTab[] = [
  { type: 'attack', label: '普攻', needsTarget: true, needsDetail: false },
  // T14：技能也需要目标 —— v3 的 DeclareAttack 必须有 targetId（skill 是 payload 字段），
  // 否则四步拼装无法确定 Command，只能退回文本解析
  { type: 'skill', label: '技能', needsTarget: true, needsDetail: true },
  { type: 'item', label: '道具', needsTarget: false, needsDetail: true },
  { type: 'defend', label: '防御', needsTarget: false, needsDetail: false },
  { type: 'flee', label: '逃跑', needsTarget: false, needsDetail: false },
] as const;

/** 当前选中行动 Tab 的定义 */
const activeTab = computed<ActionTab | undefined>(() =>
  ACTION_TABS.find((t) => t.type === selectedAction.value),
);

// ════════════════════════════════════════
//  交互逻辑
// ════════════════════════════════════════

/** combatAwaitingInput 有值时，自动选中并锁定该单位 */
watch(
  () => awaiting.value,
  (awt) => {
    if (awt) {
      selectedUnitId.value = awt.unitId;
    } else {
      // 脱离我方回合时清空选择，下次重新来
      selectedAction.value = '';
      selectedDetail.value = '';
      selectedTargetId.value = '';
    }
  },
  { immediate: true },
);

/** 切换行动类型时清空子选择；攻击/技能（占攻击槽）在攻击槽耗尽时禁用 */
function selectAction(type: ActionType) {
  if (attackSlotExhausted.value && (type === 'attack' || type === 'skill')) {
    ui.toast('攻击槽已用完，请执行其他行动或点「结束回合」', 'warning');
    return;
  }
  if (actionSlotExhausted.value && type === 'item') {
    ui.toast('动作槽已用完，请点「结束回合」推进到下一位', 'warning');
    return;
  }
  if (selectedAction.value === type) return;
  selectedAction.value = type;
  selectedDetail.value = '';
  selectedTargetId.value = '';
}

// ════════════════════════════════════════
//  拼装 → 结构化 Command（T14）
// ════════════════════════════════════════

/**
 * 当前可行动的 actor id。
 * 拼装选择锁定在 awaiting.unitId（watch），用户手动改 select 时以其选择为准；
 * 兜底退回 awaiting 的 unitId。
 */
function currentActorId(): string {
  return selectedUnitId.value || awaiting.value?.unitId || '';
}

/**
 * 四步拼装 → **自然语言意图文本**（主持人/DM 模式，2026-08-12）。
 *
 * 🎭 重大改造：拼装不再直接产结构化 Command 喂内核，而是把玩家的选择格式化成
 * 一句意图文本，经 `submitCombatIntent` 交给战斗主持人（combat_v3 会话）解析——
 * AI 理解玩家想做什么 → 调 declare_* 工具声明动作 → 内核校验执行。这样拼装和
 * 自由对话走同一条「玩家跟 AI 对话」链路，AI 统一理解意图。
 *
 * 字段不全（缺目标/缺技能）→ null，由 canAssemble 在按钮层拦掉，这里只做防御性返回。
 */
function assembleIntentText(): string | null {
  if (!selectedUnitId.value || !selectedAction.value) return null;
  const actorName =
    findCharacter(selectedUnitId.value)?.name ?? currentUnit.value?.name ?? selectedUnitId.value;
  if (!actorName) return null;

  switch (selectedAction.value) {
    case 'attack': {
      if (!selectedTargetId.value) return null;
      const targetName = currentUnitNameOf(selectedTargetId.value);
      return `我方「${actorName}」对「${targetName}」发动普通攻击`;
    }
    case 'skill': {
      if (!selectedDetail.value || !selectedTargetId.value) return null;
      const targetName = currentUnitNameOf(selectedTargetId.value);
      return `我方「${actorName}」使用技能「${selectedDetail.value}」攻击「${targetName}」`;
    }
    case 'item':
      if (!selectedDetail.value) return null;
      return `我方「${actorName}」使用道具「${selectedDetail.value}」`;
    case 'defend':
      return `我方「${actorName}」采取防御姿态`;
    case 'flee':
      return `我方「${actorName}」尝试逃跑`;
  }
}

/** 从 v3ActiveCombat.units 按 id 查展示名（拼装意图文本用） */
function currentUnitNameOf(unitId: string): string {
  const u = game.v3ActiveCombat?.units?.[unitId];
  return u?.name ?? unitId;
}

/** 执行拼装：产意图文本 → submitCombatIntent → 清空子选择（保留单位，可连续行动） */
function executeAssembled() {
  const text = assembleIntentText();
  if (!text) return;
  void game.submitCombatIntent(text);
  selectedAction.value = '';
  selectedDetail.value = '';
  selectedTargetId.value = '';
}

/** 拼装四步是否已完整（按钮可用性） */
const canAssemble = computed(() => {
  if (isLocked.value || !selectedUnitId.value || !selectedAction.value) return false;
  if (activeTab.value?.needsDetail && !selectedDetail.value) return false;
  if (activeTab.value?.needsTarget && !selectedTargetId.value) return false;
  return true;
});

/**
 * 结束回合：放弃当前单位**全部**剩余槽位（攻击+动作）。
 * 🎭 主持人/DM 模式（2026-08-12）：走意图文本 → 主持人理解「结束回合」→ 调 end_turn
 * （内核 consumeSlot 全量消费 → MoraleCheck → 下一位），与「跳过战斗」刻意区分。
 */
function handleEndTurn() {
  const actorId = currentActorId();
  if (!actorId || isLocked.value) return;
  void game.submitCombatIntent(`我方「${currentUnit.value?.name ?? actorId}」结束本回合`);
  // 本单位轮次结束，清空拼装选择（下次轮到该单位时由 watch 重新锁定）
  selectedAction.value = '';
  selectedDetail.value = '';
  selectedTargetId.value = '';
}

// ════════════════════════════════════════
//  发送（主持人/DM 模式，2026-08-12）
// ════════════════════════════════════════

const canSend = computed(() => inputText.value.trim().length > 0 && !isLocked.value);

/**
 * 🎭 主持人/DM 模式：自由文本直接提交给主持人（submitCombatIntent），由 AI 理解玩家
 * 意图 → 调 declare_* 工具声明动作 → 内核执行。不再做本地正则解析（parsePlayerInput
 * 曾把自由文本转 Command —— 那些规则让位于主持人理解，表达力更自然）。
 */
function handleSend() {
  const text = inputText.value.trim();
  if (!text || isLocked.value) return;
  void game.submitCombatIntent(text);
  inputText.value = '';
  // 拼装状态保留（同单位可能多次行动），文本框清空
}

function handleKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + Enter 发送
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    handleSend();
  }
}
</script>

<template>
  <div class="combat-action-bar" :class="{ 'is-locked': isLocked }">
    <!-- ═══ 锁定遮罩提示（敌方回合 / 非战斗）═══ -->
    <div v-if="isLocked" class="lock-overlay">
      <span class="lock-hint">敌方行动中…</span>
    </div>

    <!-- ═══ 快捷拼装区 ═══ -->
    <div class="assemble-section">
      <div class="section-label">快捷拼装</div>

      <!-- 步骤 1：我方单位 -->
      <div class="step-row step-unit">
        <label class="step-label">单位</label>
        <select
          v-model="selectedUnitId"
          class="step-select"
          :disabled="isLocked"
          aria-label="选择我方单位"
        >
          <option value="" disabled>选择单位…</option>
          <option v-for="u in allyUnits" :key="u.id" :value="u.id">
            {{ u.name }}（HP {{ u.hp }}/{{ u.maxHp }}）
          </option>
        </select>
      </div>

      <!-- 步骤 2：行动类型 Tab -->
      <div class="step-row step-actions">
        <label class="step-label">行动</label>
        <div class="action-tabs">
          <button
            v-for="tab in ACTION_TABS"
            :key="tab.type"
            class="action-tab"
            :class="{
              selected: selectedAction === tab.type,
              'is-slot-exhausted':
                (tab.type === 'attack' || tab.type === 'skill') && attackSlotExhausted,
            }"
            :disabled="
              isLocked ||
              !selectedUnitId ||
              ((tab.type === 'attack' || tab.type === 'skill') && attackSlotExhausted)
            "
            :title="
              (tab.type === 'attack' || tab.type === 'skill') && attackSlotExhausted
                ? '攻击槽已用完，请执行其他行动或点「结束回合」'
                : tab.label
            "
            @click="selectAction(tab.type)"
          >
            {{ tab.label }}
          </button>
        </div>
        <div v-if="attackSlotExhausted" class="slot-hint attack-slot-hint">
          攻击槽已用完 · 可点「结束回合」
        </div>
      </div>

      <!-- 步骤 3：技能/道具选择（仅 skill/item 显示） -->
      <div v-if="activeTab?.needsDetail" class="step-row step-detail">
        <label class="step-label">{{ selectedAction === 'skill' ? '技能' : '道具' }}</label>
        <select
          v-model="selectedDetail"
          class="step-select"
          :disabled="isLocked"
          :aria-label="selectedAction === 'skill' ? '选择技能' : '选择道具'"
        >
          <option value="" disabled>选择{{ selectedAction === 'skill' ? '技能' : '道具' }}…</option>
          <template v-if="selectedAction === 'skill'">
            <option v-for="sk in availableSkills" :key="sk.name" :value="sk.name">
              {{ sk.name
              }}<template v-if="sk.cost"> ({{ sk.cost.type }} {{ sk.cost.amount }})</template>
            </option>
          </template>
          <template v-else>
            <option v-for="item in availableItems" :key="item.name" :value="item.name">
              {{ item.name }} ×{{ item.quantity }}
            </option>
          </template>
        </select>
      </div>

      <!-- 步骤 4：目标选择（普攻必选；攻击型技能可选） -->
      <div
        v-if="activeTab?.needsTarget"
        class="step-row step-target"
        :class="{ 'without-detail': !activeTab.needsDetail }"
      >
        <label class="step-label">目标</label>
        <select
          v-model="selectedTargetId"
          class="step-select"
          :disabled="isLocked"
          aria-label="选择目标"
        >
          <option value="" disabled>选择目标…</option>
          <option v-for="e in enemyUnits" :key="e.id" :value="e.id">
            {{ e.name }}（HP {{ e.hp }}/{{ e.maxHp }}）
          </option>
        </select>
      </div>

      <!-- 执行拼装按钮（T14：直接提交结构化 Command，不再注入文本框） -->
      <button class="inject-btn" :disabled="!canAssemble" @click="executeAssembled">
        执行行动
      </button>
    </div>

    <!-- ═══ 自由文本框 + 发送 + 结束回合 ═══ -->
    <div class="input-section">
      <div class="section-label input-section-label">
        行动指令 <span>可输入自定义指令 · Ctrl / ⌘ + Enter 发送</span>
      </div>
      <div class="input-controls">
        <textarea
          v-model="inputText"
          class="combat-textarea"
          :class="{ 'is-locked': isLocked }"
          :disabled="isLocked"
          placeholder="描述我方行动…（可点左侧拼装直接执行，也可手打如“攻击骷髅兵”）"
          rows="2"
          @keydown="handleKeydown"
        />
        <div class="input-actions">
          <button
            class="end-turn-btn"
            :class="{ 'is-disabled': isLocked }"
            :disabled="isLocked"
            @click="handleEndTurn"
          >
            结束回合
          </button>
          <button
            class="send-btn"
            :class="{ 'is-disabled': !canSend }"
            :disabled="!canSend"
            @click="handleSend"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.combat-action-bar {
  display: grid;
  grid-template-columns: minmax(34rem, 1.15fr) minmax(24rem, 0.85fr);
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--theme-primary) 4%, transparent),
      transparent 45%
    ),
    var(--theme-surface-muted);
  border-top: 1px solid var(--theme-card-border);
  position: relative;
}

/* ── 锁定态（敌方回合）── */
.combat-action-bar.is-locked {
  opacity: 0.5;
  pointer-events: none;
}

.lock-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
  pointer-events: none;
  background: color-mix(in srgb, var(--theme-content-bg) 48%, transparent);
}

.lock-hint {
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
  color: var(--theme-text-muted);
  background: var(--theme-card-bg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  border-radius: var(--theme-radius-sm);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
  letter-spacing: 0.05em;
}

/* ═══ 快捷拼装区 ═══ */
.assemble-section {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(8rem, 0.8fr) minmax(16rem, 1.35fr) minmax(10rem, 1fr) auto;
  grid-template-rows: auto auto auto;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-card-bg) 82%, var(--theme-content-bg));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--theme-text-primary) 4%, transparent);
}

.section-label {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-weight: 600;
  letter-spacing: 0.06em;
}

.section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.step-row {
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--theme-spacing-xs);
  min-height: 36px; /* 触摸目标 ≥ 36px */
}

.step-unit {
  grid-column: 1;
  grid-row: 2;
}

.step-actions {
  grid-column: 2;
  grid-row: 2;
}

.step-detail {
  grid-column: 3;
  grid-row: 2;
}

.step-target {
  grid-column: 3;
  grid-row: 3;
}

.step-target.without-detail {
  grid-row: 2;
}

.step-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  text-align: left;
  letter-spacing: 0.04em;
}

.step-select {
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-size: 0.88rem;
  font-family: var(--theme-font-body);
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}

.step-select:hover:not(:disabled) {
  border-color: var(--theme-primary);
}

.step-select:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 18%, transparent);
}

.step-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 行动 Tab ── */
.step-actions {
  align-items: stretch;
}

.action-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(3.5rem, 1fr));
  gap: var(--theme-spacing-xs);
}

.action-tab {
  min-height: 36px;
  min-width: 56px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  font-family: var(--theme-font-body);
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}

.action-tab:hover:not(:disabled) {
  border-color: var(--theme-primary);
  color: var(--theme-primary);
}

.action-tab:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

/* selected 态：primary 8% 染底（design §4.2） */
.action-tab.selected {
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  border-color: var(--theme-primary);
  color: var(--theme-primary);
  font-weight: 600;
}

.action-tab:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── 攻击槽耗尽（Bug 2 UI 侧，2026-08-12）── */
.action-tab.is-slot-exhausted:not(.selected) {
  opacity: 0.35;
  cursor: not-allowed;
}

.slot-hint {
  grid-column: 1 / -1;
  font-size: 0.6875rem;
  color: var(--theme-warning, var(--theme-text-muted));
  letter-spacing: 0.03em;
}

.attack-slot-hint {
  color: color-mix(in srgb, var(--theme-primary) 78%, var(--theme-text-muted));
}

/* ── 注入按钮 ── */
.inject-btn {
  grid-column: 4;
  grid-row: 2;
  align-self: end;
  min-height: 44px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-lg);
  background: var(--theme-primary);
  border: 1px solid var(--theme-primary);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-primary-text);
  font-size: 0.85rem;
  font-family: var(--theme-font-body);
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: 0 0 12px color-mix(in srgb, var(--theme-primary) 12%, transparent);
  transition:
    filter var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}

.inject-btn:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 0 16px color-mix(in srgb, var(--theme-primary) 22%, transparent);
}

.inject-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

.inject-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ═══ 文本框 + 发送 ═══ */
.input-section {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-card-bg) 82%, var(--theme-content-bg));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--theme-text-primary) 4%, transparent);
}

.input-section-label span {
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body);
  font-size: 0.6875rem;
  font-weight: 400;
  letter-spacing: 0;
  opacity: 0.75;
}

.input-controls {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--theme-spacing-sm);
  align-items: stretch;
}

.combat-textarea {
  width: 100%;
  min-height: 5rem;
  max-height: 8rem;
  resize: vertical;
  padding: var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-size: 0.9rem;
  font-family: var(--theme-font-body);
  line-height: 1.5;
  transition: border-color var(--theme-transition-fast);
}

.combat-textarea:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 18%, transparent);
}

.combat-textarea::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.7;
}

.input-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(5.5rem, 1fr));
  gap: var(--theme-spacing-sm);
}

/* ── 结束回合按钮（secondary 变体：design §4.1）──
   与「发送」（primary 实心）区分主次：结束回合是放弃语义，用描边次级样式 */
.end-turn-btn {
  flex-shrink: 0;
  min-height: 44px;
  min-width: 64px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-primary);
  font-size: 0.9rem;
  font-family: var(--theme-font-body);
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}

.end-turn-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

.end-turn-btn:hover:not(:disabled) {
  background: var(--theme-surface-muted);
  border-color: var(--theme-primary);
}

.end-turn-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.send-btn {
  flex-shrink: 0;
  min-height: 44px;
  min-width: 64px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  background: var(--theme-primary);
  border: 1px solid var(--theme-primary);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-primary-text);
  font-size: 0.9rem;
  font-family: var(--theme-font-body);
  font-weight: 600;
  cursor: pointer;
  transition: filter var(--theme-transition-fast);
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.send-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

/* 用 .is-disabled 类避开全局 .disabled 陷阱（CLAUDE.md 编码模式） */
.send-btn.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (prefers-reduced-transparency: reduce) {
  .lock-overlay {
    background: var(--theme-content-bg);
  }
}

@media (max-width: 1200px) {
  .combat-action-bar {
    grid-template-columns: minmax(0, 1fr);
  }

  .combat-textarea {
    min-height: 4.5rem;
  }
}

@media (max-width: 720px) {
  .combat-action-bar {
    padding: var(--theme-spacing-sm);
  }

  .assemble-section {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto;
  }

  .step-unit,
  .step-actions,
  .step-detail,
  .step-target,
  .step-target.without-detail,
  .inject-btn {
    grid-column: 1;
    grid-row: auto;
  }

  .action-tabs {
    grid-template-columns: repeat(3, minmax(4rem, 1fr));
  }

  .input-controls {
    grid-template-columns: minmax(0, 1fr);
  }

  .input-actions {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .input-section-label span {
    display: none;
  }
}

@media (max-height: 720px) and (min-width: 1201px) {
  .combat-action-bar {
    padding-block: var(--theme-spacing-sm);
  }

  .combat-textarea {
    min-height: 4rem;
  }
}

/* ── prefers-reduced-motion（design §6.3）── */
@media (prefers-reduced-motion: reduce) {
  .step-select,
  .action-tab,
  .inject-btn,
  .combat-textarea,
  .end-turn-btn,
  .send-btn {
    transition: none;
  }
}
</style>
