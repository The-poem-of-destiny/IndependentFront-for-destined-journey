<script setup lang="ts">
/**
 * PresetKnobGroup.vue — 预设互斥组单选（纯呈现）
 *
 * 设置页的预设条目列表与游戏内「预设」抽屉共用：把一个互斥组
 * （如「叙事人称：第一 / 第二 / 第三人称」）画成一组原生 radio。
 *
 * - 用原生 radio + 同一 name：方向键切换、Tab 只停一处都由浏览器负责，不自己写键盘逻辑。
 * - status 为 none / conflict 时不选中任何项（conflict 下勾哪项都是在撒谎），
 *   并用 role="status" 给出提示；用户点任意一项即发 select，由调用方去修正。
 * - allowNone 时多一个「不使用」：status 为 ok 且 selected 为 null 时它是选中态，选它发 select(null)。
 *
 * 本组件不碰任何 store：选了什么、写到哪，由调用方决定。
 */
import { computed, useId } from 'vue';

interface PresetKnobOption {
  id: string;
  label: string;
  /** 该项的大致 token 数；有值时显示「≈N tokens」 */
  tokens?: number;
}

type PresetKnobStatus = 'ok' | 'none' | 'conflict';

const props = withDefaults(
  defineProps<{
    label: string;
    description?: string;
    options: readonly PresetKnobOption[];
    selected: string | null;
    status: PresetKnobStatus;
    disabled?: boolean;
    allowNone?: boolean;
  }>(),
  {
    description: undefined,
    disabled: false,
    allowNone: false,
  },
);

const emit = defineEmits<{ select: [id: string | null] }>();

const uid = useId();
const groupName = `preset-knob-${uid}`;
const labelId = `preset-knob-label-${uid}`;
const descId = `preset-knob-desc-${uid}`;

const statusText = computed(() => {
  if (props.status === 'none') return '未选择';
  if (props.status === 'conflict') return '同时启用了多项，选一项即可修正';
  return null;
});

function isChecked(id: string | null): boolean {
  if (props.status !== 'ok') return false;
  return props.selected === id;
}

function onSelect(id: string | null) {
  if (props.disabled) return;
  emit('select', id);
}
</script>

<template>
  <div class="preset-knob" :class="{ 'is-conflict': status === 'conflict', locked: disabled }">
    <div class="pk-head">
      <span :id="labelId" class="pk-label">{{ label }}</span>
      <span
        v-if="statusText"
        class="pk-status"
        :class="`pk-status-${status}`"
        role="status"
        data-testid="preset-knob-status"
        >{{ statusText }}</span
      >
    </div>
    <p v-if="description" :id="descId" class="pk-desc">{{ description }}</p>

    <div
      class="pk-options"
      role="radiogroup"
      :aria-labelledby="labelId"
      :aria-describedby="description ? descId : undefined"
      :aria-disabled="disabled || undefined"
    >
      <label
        v-for="option in options"
        :key="option.id"
        class="pk-option"
        :class="{ checked: isChecked(option.id) }"
      >
        <input
          type="radio"
          class="pk-radio"
          :name="groupName"
          :value="option.id"
          :checked="isChecked(option.id)"
          :disabled="disabled"
          @change="onSelect(option.id)"
        />
        <span class="pk-option-label">{{ option.label }}</span>
        <span v-if="option.tokens != null" class="pk-tokens">≈{{ option.tokens }} tokens</span>
      </label>

      <label
        v-if="allowNone"
        class="pk-option pk-option-none"
        :class="{ checked: isChecked(null) }"
      >
        <input
          type="radio"
          class="pk-radio"
          :name="groupName"
          value=""
          :checked="isChecked(null)"
          :disabled="disabled"
          @change="onSelect(null)"
        />
        <span class="pk-option-label">不使用</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.preset-knob {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-width: 0;
}

.pk-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  min-width: 0;
}
.pk-label {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}

/* 语义徽章配方 — design.md §1 */
.pk-status {
  padding: 0 var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  font-size: 0.6875rem;
  line-height: 1.6;
}
.pk-status-none {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}
.pk-status-conflict {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}

.pk-desc {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}

.pk-options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}

.pk-option {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  min-width: 0;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.5;
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.pk-option:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}
/* 激活态配方 — design.md §1 */
.pk-option.checked {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.pk-option:has(.pk-radio:focus-visible) {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.pk-option-none .pk-option-label {
  color: var(--theme-text-muted);
}

/* 冲突态：外框提示整组需要处理 */
.is-conflict .pk-option {
  border-color: color-mix(in srgb, var(--theme-warning) 30%, var(--theme-card-border));
}

/* 命名避开全局 .disabled（utilities.css 会加 pointer-events:none） */
.locked .pk-option {
  opacity: 0.55;
  cursor: not-allowed;
}
.locked .pk-option:hover {
  border-color: var(--theme-card-border);
}

.pk-radio {
  margin: 0;
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}

.pk-option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pk-tokens {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .pk-option {
    transition: none;
  }
}
</style>
