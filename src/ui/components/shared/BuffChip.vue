<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  type: 'buff' | 'debuff' | 'special'
  name: string
  stacks?: number
}>()

const chipColor = computed(() => {
  switch (props.type) {
    case 'buff': return 'var(--theme-success)'
    case 'debuff': return 'var(--theme-error)'
    case 'special': return 'var(--theme-warning)'
  }
})
</script>

<template>
  <span
    class="buff-chip"
    :class="[`chip-${type}`]"
    :style="{ borderColor: chipColor, color: chipColor }"
  >
    {{ name }}
    <span v-if="stacks && stacks > 1" class="chip-stacks">×{{ stacks }}</span>
  </span>
</template>

<style scoped>
.buff-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border: 1px solid;
  border-radius: var(--theme-radius-full);
  font-size: 0.72rem;
  font-weight: 500;
  white-space: nowrap;
}
.chip-buff {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
}
.chip-debuff {
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
}
.chip-special {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
}
.chip-stacks {
  font-weight: 700;
  font-size: 0.65rem;
}
</style>
