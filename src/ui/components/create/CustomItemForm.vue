<script setup lang="ts">
import { ref, computed } from 'vue'
import type { CatalogItem, Rarity } from '@engine/start-catalog'
import { RARITY_LABELS, RARITY_TO_QUALITY } from '@engine/start-catalog'
import AppModal from '../shared/AppModal.vue'
import AppButton from '../shared/AppButton.vue'
import FormInput from '../shared/form/FormInput.vue'
import FormSelect from '../shared/form/FormSelect.vue'
import FormStepper from '../shared/form/FormStepper.vue'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  save: [item: CatalogItem]
  close: []
}>()

const RARITY_OPTIONS = RARITY_LABELS.map(r => ({ label: RARITY_TO_QUALITY[r], value: r }))

// 分类
const category = ref<'equipment' | 'item' | 'skill'>('equipment')

const EQUIPMENT_TYPES = ['武器', '防具', '饰品']
const ITEM_TYPES = ['消耗品', '材料', '特殊']
const SKILL_TYPES = ['主动', '被动']

const subtypeOptions = computed(() => {
  switch (category.value) {
    case 'equipment': return EQUIPMENT_TYPES.map(t => ({ label: t, value: t }))
    case 'item': return ITEM_TYPES.map(t => ({ label: t, value: t }))
    case 'skill': return SKILL_TYPES.map(t => ({ label: t, value: t }))
  }
})

// 表单
const itemName = ref('')
const itemType = ref('武器')
const itemRarity = ref<Rarity>('common')
const itemTag = ref('')
const itemTagList = ref<string[]>([])
const effectKey = ref('')
const effectVal = ref('')
const effectMap = ref<Record<string, string>>({})
const itemConsume = ref('')
const itemDescription = ref('')
const itemQuantity = ref(1)
const itemCost = ref(50)

function addTag() {
  const t = itemTag.value.trim()
  if (t && !itemTagList.value.includes(t)) {
    itemTagList.value = [...itemTagList.value, t]
    itemTag.value = ''
  }
}
function removeTag(t: string) {
  itemTagList.value = itemTagList.value.filter(x => x !== t)
}
function addEffect() {
  const k = effectKey.value.trim()
  if (k && !effectMap.value[k]) {
    effectMap.value = { ...effectMap.value, [k]: effectVal.value.trim() || '-' }
    effectKey.value = ''; effectVal.value = ''
  }
}
function removeEffect(k: string) {
  const next = { ...effectMap.value }
  delete next[k]
  effectMap.value = next
}

function handleSave() {
  if (!itemName.value.trim()) return
  const id = `custom_${category.value}_${crypto.randomUUID().slice(0, 8)}`
  const item: CatalogItem = {
    id,
    name: itemName.value.trim(),
    category: category.value,
    type: itemType.value,
    rarity: itemRarity.value,
    tag: itemTagList.value,
    effect: { ...effectMap.value },
    consume: category.value === 'skill' ? itemConsume.value.trim() || undefined : undefined,
    description: itemDescription.value.trim() || itemName.value.trim(),
    cost: itemCost.value,
    quantity: category.value === 'item' ? itemQuantity.value : undefined,
  }
  emit('save', item)
  resetForm()
  emit('close')
}

function resetForm() {
  itemName.value = ''; itemType.value = '武器'; itemRarity.value = 'common'
  itemTag.value = ''; itemTagList.value = []
  effectKey.value = ''; effectVal.value = ''; effectMap.value = {}
  itemConsume.value = ''; itemDescription.value = ''; itemQuantity.value = 1; itemCost.value = 50
}

// 分类切换时重置类型
function onCategoryChange(cat: 'equipment' | 'item' | 'skill') {
  category.value = cat
  itemType.value = subtypeOptions.value[0]?.value ?? ''
}
</script>

<template>
  <AppModal :open="visible" @close="emit('close')">
    <template #header>自定义物品</template>

    <div class="custom-form">
      <!-- 分类 -->
      <div class="cat-row">
        <AppButton size="sm" :variant="category === 'equipment' ? 'primary' : 'ghost'" @click="onCategoryChange('equipment')">装备</AppButton>
        <AppButton size="sm" :variant="category === 'item' ? 'primary' : 'ghost'" @click="onCategoryChange('item')">道具</AppButton>
        <AppButton size="sm" :variant="category === 'skill' ? 'primary' : 'ghost'" @click="onCategoryChange('skill')">技能</AppButton>
      </div>

      <FormInput v-model="itemName" label="名称" placeholder="输入名称" />
      <FormSelect v-model="itemType" label="类型" :options="subtypeOptions" />
      <FormSelect v-model="itemRarity" label="品质" :options="RARITY_OPTIONS" />
      <FormStepper v-model="itemCost" label="消耗转生点" :min="1" :max="9999" />

      <!-- 标签 -->
      <div class="tag-section">
        <label class="field-label">标签</label>
        <div class="tag-row">
          <input v-model="itemTag" class="field-input" placeholder="输入标签" @keyup.enter="addTag" />
          <AppButton size="sm" @click="addTag">+</AppButton>
        </div>
        <div class="tag-chips">
          <span v-for="t in itemTagList" :key="t" class="chip" @click="removeTag(t)">{{ t }} ✕</span>
        </div>
      </div>

      <!-- 效果 -->
      <div class="effect-section">
        <label class="field-label">效果</label>
        <div class="effect-row">
          <input v-model="effectKey" class="field-input" placeholder="效果名" style="flex:1" />
          <input v-model="effectVal" class="field-input" placeholder="值" style="flex:2" />
          <AppButton size="sm" @click="addEffect">+</AppButton>
        </div>
        <div class="effect-list">
          <span v-for="(v, k) in effectMap" :key="k" class="chip" @click="removeEffect(k)">{{ k }}: {{ v }} ✕</span>
        </div>
      </div>

      <!-- 技能消耗 -->
      <FormInput v-if="category === 'skill'" v-model="itemConsume" label="消耗描述" placeholder="攻击: 400MP / 动作: 150MP" />

      <!-- 数量 (道具) -->
      <FormStepper v-if="category === 'item'" v-model="itemQuantity" label="数量" :min="1" :max="99" />

      <!-- 描述 -->
      <div class="desc-section">
        <label class="field-label">描述</label>
        <textarea v-model="itemDescription" class="field-textarea" rows="3" placeholder="风味描述…" />
      </div>

      <div class="form-footer">
        <AppButton variant="primary" @click="handleSave">确认添加</AppButton>
        <AppButton variant="ghost" @click="emit('close')">取消</AppButton>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.custom-form { display: flex; flex-direction: column; gap: var(--theme-spacing-sm); }
.cat-row { display: flex; gap: var(--theme-spacing-xs); }
.field-label { font-size: 0.75rem; font-weight: 600; color: var(--theme-text-secondary); display: block; margin-bottom: 2px; }
.field-input {
  padding: 4px var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.8rem;
}
.field-textarea {
  width: 100%;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.8rem;
  resize: vertical;
  font-family: inherit;
}
.tag-row, .effect-row { display: flex; gap: 4px; }
.tag-chips, .effect-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--theme-card-border);
  font-size: 0.65rem;
  color: var(--theme-text-secondary);
  cursor: pointer;
}
.chip:hover { background: var(--theme-quality-唯一); color: #fff; }
.form-footer { display: flex; justify-content: center; gap: var(--theme-spacing-sm); margin-top: var(--theme-spacing-sm); }
</style>
