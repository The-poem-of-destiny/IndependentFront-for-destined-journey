<script setup lang="ts">
/**
 * CombatActionBar.vue — 战斗操作栏（M5 前端战斗面板 P4 子组件，B+C 混合操作）
 *
 * 快捷拼装助手 + 自由文本框。玩家通过四步选择（单位→行动类型→技能/道具→目标）
 * 拼装出自然语言指令注入文本框，可在发送前自由编辑。也可跳过拼装直接手打。
 *
 * 数据来源：useGameStore（activeCombat / combatAwaitingInput / characters / submitCombatInput）
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
import type { CharacterState, CombatParticipant, Skill, InventoryItem } from '@engine/types';

const game = useGameStore();

// ════════════════════════════════════════
//  派生状态
// ════════════════════════════════════════

/** 当前是否轮到我方输入（null = 敌方回合/非战斗） */
const awaiting = computed(() => game.combatAwaitingInput);

/** 整个操作栏是否禁用（敌方回合或非战斗态） */
const isLocked = computed(() => !awaiting.value);

/** 我方参战单位列表 */
const allyUnits = computed<CombatParticipant[]>(() => {
  const combat = game.activeCombat;
  if (!combat) return [];
  return combat.participants.filter((p) => p.side === 'ally' && p.hp > 0);
});

/** 敌方参战单位列表（选目标用） */
const enemyUnits = computed<CombatParticipant[]>(() => {
  const combat = game.activeCombat;
  if (!combat) return [];
  return combat.participants.filter((p) => p.side === 'enemy' && p.hp > 0);
});

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

/** 当前选中单位的 CombatParticipant（取名字用） */
const selectedParticipant = computed<CombatParticipant | undefined>(() => {
  const combat = game.activeCombat;
  if (!combat || !selectedUnitId.value) return undefined;
  return combat.participants.find((p) => p.characterId === selectedUnitId.value);
});

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

// ── 武器名（从 inventory 中找 equippedSlot 为武器槽的物品）──
const WEAPON_SLOTS = ['weapon', '武器'] as const;

const weaponName = computed<string>(() => {
  const char = selectedCharacter.value;
  if (!char) return '武器';
  const weapon = (char.inventory ?? []).find(
    (item) => item.equippedSlot && WEAPON_SLOTS.includes(item.equippedSlot as any),
  );
  return weapon?.name ?? '武器';
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
  { type: 'skill', label: '技能', needsTarget: false, needsDetail: true },
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

/** 切换行动类型时清空子选择 */
function selectAction(type: ActionType) {
  if (selectedAction.value === type) return;
  selectedAction.value = type;
  selectedDetail.value = '';
  selectedTargetId.value = '';
}

// ════════════════════════════════════════
//  拼装模板
// ════════════════════════════════════════

/** 获取单位显示名（优先用 CombatParticipant.name） */
function unitName(charId: string): string {
  const combat = game.activeCombat;
  const p = combat?.participants.find((pt) => pt.characterId === charId);
  return p?.name ?? findCharacter(charId)?.name ?? '未知单位';
}

/** 获取目标显示名 */
function targetName(): string {
  if (!selectedTargetId.value) return '敌人';
  const p = enemyUnits.value.find((e) => e.characterId === selectedTargetId.value);
  return p?.name ?? '敌人';
}

/** 拼装自然语言指令，注入文本框 */
function assembleAndInject() {
  if (!selectedUnitId.value || !selectedAction.value) return;

  const me = unitName(selectedUnitId.value);
  let text = '';

  switch (selectedAction.value) {
    case 'attack':
      text = `${me}挥舞${weaponName.value}攻击${targetName()}`;
      break;

    case 'skill': {
      if (!selectedDetail.value) return;
      // 判断技能是否攻击型：技能名含"攻击/斩/击/刺/射/轰/术"等关键字启发式判断
      const isAttackSkill = /攻|斩|击|刺|射|轰|术|爆|裂|波/.test(selectedDetail.value);
      if (isAttackSkill && activeTab.value?.needsTarget) {
        // 攻击型技能 — 需要目标就带目标
        text = `${me}施展${selectedDetail.value}，攻向${targetName()}`;
      } else {
        text = `${me}施展${selectedDetail.value}`;
      }
      break;
    }

    case 'item': {
      if (!selectedDetail.value) return;
      text = `${me}使用${selectedDetail.value}`;
      break;
    }

    case 'defend':
      text = `${me}举盾防御`;
      break;

    case 'flee':
      text = `${me}尝试撤退`;
      break;
  }

  if (text) {
    // 追加而非覆盖（允许玩家连续拼装多句）
    inputText.value = inputText.value ? `${inputText.value}；${text}` : text;
  }
}

// ════════════════════════════════════════
//  发送
// ════════════════════════════════════════

const canSend = computed(() => inputText.value.trim().length > 0 && !isLocked.value);

function handleSend() {
  const text = inputText.value.trim();
  if (!text || isLocked.value) return;
  game.submitCombatInput(text);
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
      <div class="step-row">
        <label class="step-label">单位</label>
        <select
          v-model="selectedUnitId"
          class="step-select"
          :disabled="isLocked"
          aria-label="选择我方单位"
        >
          <option value="" disabled>选择单位…</option>
          <option v-for="u in allyUnits" :key="u.characterId" :value="u.characterId">
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
            :class="{ selected: selectedAction === tab.type }"
            :disabled="isLocked || !selectedUnitId"
            @click="selectAction(tab.type)"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>

      <!-- 步骤 3：技能/道具选择（仅 skill/item 显示） -->
      <div v-if="activeTab?.needsDetail" class="step-row">
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
      <div v-if="activeTab?.needsTarget" class="step-row">
        <label class="step-label">目标</label>
        <select
          v-model="selectedTargetId"
          class="step-select"
          :disabled="isLocked"
          aria-label="选择目标"
        >
          <option value="" disabled>选择目标…</option>
          <option v-for="e in enemyUnits" :key="e.characterId" :value="e.characterId">
            {{ e.name }}（HP {{ e.hp }}/{{ e.maxHp }}）
          </option>
        </select>
      </div>

      <!-- 注入按钮 -->
      <button
        class="inject-btn"
        :disabled="isLocked || !selectedAction || !selectedUnitId"
        @click="assembleAndInject"
      >
        注入文本框
      </button>
    </div>

    <!-- ═══ 自由文本框 + 发送 ═══ -->
    <div class="input-section">
      <textarea
        v-model="inputText"
        class="combat-textarea"
        :class="{ 'is-locked': isLocked }"
        :disabled="isLocked"
        placeholder="描述我方行动…（可点上方拼装，也可直接手打）"
        rows="2"
        @keydown="handleKeydown"
      />
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
</template>

<style scoped>
.combat-action-bar {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  background: var(--theme-bg-secondary, var(--theme-card-bg));
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
}

.lock-hint {
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
  color: var(--theme-text-muted);
  background: var(--theme-card-bg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  border-radius: var(--theme-radius-sm);
  border: 1px solid var(--theme-card-border);
  letter-spacing: 0.05em;
}

/* ═══ 快捷拼装区 ═══ */
.assemble-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

.section-label {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  font-weight: 500;
  margin-bottom: var(--theme-spacing-xs);
}

.step-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px; /* 触摸目标 ≥ 36px */
}

.step-label {
  flex-shrink: 0;
  width: 3em;
  font-size: 0.85rem;
  color: var(--theme-text-secondary, var(--theme-text-muted));
  text-align: right;
}

.step-select {
  flex: 1;
  min-width: 0;
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text);
  font-size: 0.88rem;
  font-family: var(--theme-font-body);
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}

.step-select:hover:not(:disabled) {
  border-color: var(--theme-primary);
}

.step-select:focus {
  outline: none;
  border-color: var(--theme-primary);
}

.step-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── 行动 Tab ── */
.step-actions {
  align-items: flex-start;
}

.action-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}

.action-tab {
  min-height: 36px;
  min-width: 56px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary, var(--theme-text));
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

/* ── 注入按钮 ── */
.inject-btn {
  align-self: flex-end;
  min-height: 36px;
  padding: var(--theme-spacing-xs) var(--theme-spacing-lg);
  background: var(--theme-primary);
  border: none;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-btn-text, #fff);
  font-size: 0.85rem;
  font-family: var(--theme-font-body);
  cursor: pointer;
  transition: opacity var(--theme-transition-fast);
}

.inject-btn:hover:not(:disabled) {
  opacity: 0.85;
}

.inject-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ═══ 文本框 + 发送 ═══ */
.input-section {
  display: flex;
  gap: var(--theme-spacing-sm);
  align-items: flex-end;
}

.combat-textarea {
  flex: 1;
  min-height: 56px;
  resize: vertical;
  padding: var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text);
  font-size: 0.9rem;
  font-family: var(--theme-font-body);
  line-height: 1.5;
  transition: border-color var(--theme-transition-fast);
}

.combat-textarea:focus {
  outline: none;
  border-color: var(--theme-primary);
}

.combat-textarea::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.7;
}

.send-btn {
  flex-shrink: 0;
  min-height: 36px;
  min-width: 64px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  background: var(--theme-primary);
  border: none;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-btn-text, #fff);
  font-size: 0.9rem;
  font-family: var(--theme-font-body);
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--theme-transition-fast);
}

.send-btn:hover:not(:disabled) {
  opacity: 0.85;
}

/* 用 .is-disabled 类避开全局 .disabled 陷阱（CLAUDE.md 编码模式） */
.send-btn.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ── prefers-reduced-motion（design §6.3）── */
@media (prefers-reduced-motion: reduce) {
  .step-select,
  .action-tab,
  .inject-btn,
  .combat-textarea,
  .send-btn {
    transition: none;
  }
}
</style>
