<script setup lang="ts">
/**
 * BackgroundList — 背景卡片列表
 *
 * 对齐原版 custom_start_index.html 的 BackgroundList:
 * - 每个卡片显示名称/描述/限定条件
 * - 不满足条件 → 灰显 + 警告 + 阻止点击
 * - 自定义开局 → 选中后展开 textarea
 */
import { computed } from 'vue'
import type { BackgroundTemplate } from '@engine/start-catalog'

const props = defineProps<{
  backgrounds: BackgroundTemplate[]
  modelValue: BackgroundTemplate | null
  /** 角色当前种族 (用于条件检查) */
  characterRace: string
  /** 角色当前身份 (用于条件检查) */
  characterIdentity: string
  /** 角色出生地 (用于条件检查, 前缀匹配) */
  characterLocation: string
  /** 命运核心名称 (用于条件检查, 前缀匹配) */
  destinyCoreName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [bg: BackgroundTemplate | null]
}>()

/** 判断单个背景是否满足条件 */
function checkConditions(bg: BackgroundTemplate): { valid: boolean; missing: string[] } {
  const missing: string[] = []
  if (bg.requiredRace && props.characterRace !== bg.requiredRace) {
    missing.push(`种族需为「${bg.requiredRace}」(当前: ${props.characterRace})`)
  }
  if (bg.requiredIdentity && props.characterIdentity !== bg.requiredIdentity) {
    missing.push(`身份需为「${bg.requiredIdentity}」(当前: ${props.characterIdentity})`)
  }
  if (bg.requiredLocation) {
    const loc = props.characterLocation
    if (loc !== bg.requiredLocation && !loc.includes(bg.requiredLocation)) {
      missing.push(`出生地需在「${bg.requiredLocation}」`)
    }
  }
  if (bg.requiredDestinyCore) {
    const dc = props.destinyCoreName
    if (!dc || !dc.includes(bg.requiredDestinyCore)) {
      missing.push(`命定核心需为「${bg.requiredDestinyCore}」(当前: ${dc || '未选择'})`)
    }
  }
  return { valid: missing.length === 0, missing }
}

/** 是否为自定义开局 */
const CUSTOM_BG_NAME = '【自定义开局】'

function isCustom(bg: BackgroundTemplate) {
  return bg.name === CUSTOM_BG_NAME
}

/** 获取背景的所有限定标签 (用于显示) */
function getRequirementTags(bg: BackgroundTemplate) {
  const tags: { label: string; value: string; met: boolean }[] = []
  if (bg.requiredRace) {
    tags.push({
      label: '种族',
      value: bg.requiredRace,
      met: props.characterRace === bg.requiredRace,
    })
  }
  if (bg.requiredIdentity) {
    tags.push({
      label: '身份',
      value: bg.requiredIdentity,
      met: props.characterIdentity === bg.requiredIdentity,
    })
  }
  if (bg.requiredLocation) {
    const met = props.characterLocation === bg.requiredLocation ||
      props.characterLocation.includes(bg.requiredLocation)
    tags.push({
      label: '出生地',
      value: bg.requiredLocation,
      met,
    })
  }
  if (bg.requiredDestinyCore) {
    const met = props.destinyCoreName.includes(bg.requiredDestinyCore)
    tags.push({
      label: '命运核心',
      value: bg.requiredDestinyCore,
      met,
    })
  }
  return tags
}

const selectedId = computed(() => props.modelValue?.id ?? null)
</script>

<template>
  <div class="bg-list">
    <div
      v-for="bg in backgrounds"
      :key="bg.id"
      class="bg-card"
      :class="{
        selected: selectedId === bg.id,
        disabled: !checkConditions(bg).valid,
      }"
      @click="checkConditions(bg).valid ? emit('update:modelValue', bg) : undefined"
    >
      <!-- 卡片头部 -->
      <div class="bg-header">
        <strong class="bg-name">{{ bg.name }}</strong>
        <span v-if="selectedId === bg.id" class="bg-check">✓</span>
      </div>

      <!-- 条件徽章 (仅有限定条件的背景显示) -->
      <div v-if="getRequirementTags(bg).length > 0" class="bg-requirements">
        <span
          v-for="req in getRequirementTags(bg)"
          :key="req.label"
          class="req-tag"
          :class="{ met: req.met, unmet: !req.met }"
        >
          {{ req.label }}: {{ req.value }}
        </span>
      </div>

      <!-- 描述预览 (截断) -->
      <p class="bg-desc">{{ bg.description }}</p>

      <!-- 不满足条件警告 -->
      <div v-if="!checkConditions(bg).valid" class="bg-warning">
        ⚠️ 不满足限定条件：
        <ul class="bg-missing">
          <li v-for="m in checkConditions(bg).missing" :key="m">{{ m }}</li>
        </ul>
      </div>

      <!-- 自定义开局: 选中后展开 textarea -->
      <div v-if="isCustom(bg) && selectedId === bg.id" class="bg-custom-textarea" @click.stop>
        <textarea
          :value="modelValue?.fullText ?? ''"
          @input="emit('update:modelValue', { ...bg, fullText: ($event.target as HTMLTextAreaElement).value })"
          placeholder="在此书写你的角色背景故事…"
          rows="5"
          class="custom-textarea"
        ></textarea>
      </div>
    </div>

    <div v-if="backgrounds.length === 0" class="empty">
      该分类暂无背景
    </div>
  </div>
</template>

<style scoped>
/* ===== 列表容器 ===== */
.bg-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

/* ===== 卡片 ===== */
.bg-card {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.bg-card:hover:not(.disabled) {
  border-color: var(--theme-color-primary);
  background: color-mix(in srgb, var(--theme-color-primary) 5%, var(--theme-card-bg));
  box-shadow: 0 1px 4px rgba(0,0,0,.08);
  transform: translateY(-1px);
}
.bg-card.selected {
  border-color: var(--theme-color-primary);
  background: color-mix(in srgb, var(--theme-color-primary) 8%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px var(--theme-color-primary);
}

/* 禁用态 */
.bg-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  filter: grayscale(30%);
}
.bg-card.disabled:hover {
  border-color: var(--theme-card-border);
  background: var(--theme-card-bg);
  transform: none;
  box-shadow: none;
}

/* ===== 头部 ===== */
.bg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-xs);
}
.bg-name {
  color: var(--theme-text-primary);
  font-size: 0.92em;
  font-weight: 700;
}
.bg-check {
  flex-shrink: 0;
  width: 1.5em;
  height: 1.5em;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--theme-color-primary);
  color: #fff;
  font-size: 0.75em;
  font-weight: 700;
}

/* ===== 条件徽章 ===== */
.bg-requirements {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35em;
  margin-top: 0.4em;
}
.req-tag {
  display: inline-block;
  padding: 0.15em 0.55em;
  border-radius: var(--theme-radius-sm);
  font-size: 0.7em;
  border: 1px solid transparent;
  line-height: 1.4;
}
.req-tag.met {
  background: rgba(76, 175, 80, 0.12);
  color: #4caf50;
  border-color: rgba(76, 175, 80, 0.3);
}
.req-tag.unmet {
  background: rgba(244, 67, 54, 0.1);
  color: #f44336;
  border-color: rgba(244, 67, 54, 0.25);
}

/* ===== 描述 ===== */
.bg-desc {
  margin: 0.35em 0 0;
  font-size: 0.75em;
  color: var(--theme-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bg-card.selected .bg-desc {
  -webkit-line-clamp: unset;
  overflow: visible;
}

/* ===== 不满足条件警告 ===== */
.bg-warning {
  margin-top: 0.5em;
  padding: 0.4em 0.6em;
  border-left: 3px solid #f44336;
  background: rgba(244, 67, 54, 0.06);
  border-radius: 0 var(--theme-radius-sm) var(--theme-radius-sm) 0;
  color: #e57373;
  font-size: 0.72em;
  font-weight: 600;
}
.bg-missing {
  margin: 0.2em 0 0 1.2em;
  padding: 0;
  list-style: disc;
  color: var(--theme-text-muted);
  font-weight: 400;
}

/* ===== 自定义开局 textarea ===== */
.bg-custom-textarea {
  margin-top: var(--theme-spacing-sm);
  padding-top: var(--theme-spacing-sm);
  border-top: 1px solid var(--theme-card-border);
}
.custom-textarea {
  width: 100%;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-bg-primary);
  color: var(--theme-text-primary);
  font-size: 0.82em;
  line-height: 1.6;
  resize: vertical;
  font-family: inherit;
}
.custom-textarea:focus {
  outline: none;
  border-color: var(--theme-color-primary);
}

/* ===== 空状态 ===== */
.empty {
  text-align: center;
  color: var(--theme-text-muted);
  padding: var(--theme-spacing-lg) 0;
  font-size: 0.85em;
}
</style>
