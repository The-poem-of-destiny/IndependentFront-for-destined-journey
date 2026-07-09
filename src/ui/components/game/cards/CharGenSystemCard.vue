<script setup lang="ts">
import type { CharGenSystemEvent } from '@engine/types'
defineProps<{ event: CharGenSystemEvent }>()
</script>

<template>
  <div class="chargen-card">
    <div class="card-top">
      <span class="char-name">{{ event.characterName }}</span>
      <span class="char-tier">T{{ event.tier }}</span>
      <span class="char-race">{{ event.race }}</span>
    </div>
    <div class="card-body">
      <div class="char-attrs">
        <span v-if="event.details.attributes" class="attr">💪{{ event.details.attributes.str }}</span>
        <span v-if="event.details.attributes" class="attr">🏃{{ event.details.attributes.dex }}</span>
        <span v-if="event.details.attributes" class="attr">🛡️{{ event.details.attributes.con }}</span>
        <span v-if="event.details.attributes" class="attr">🧠{{ event.details.attributes.int }}</span>
        <span v-if="event.details.attributes" class="attr">✨{{ event.details.attributes.spi }}</span>
      </div>
      <div v-if="event.details.identity?.length" class="char-tags">
        <span v-for="tag in event.details.identity" :key="tag" class="tag">{{ tag }}</span>
      </div>
      <div v-if="event.details.background" class="char-bg">
        {{ event.details.background.slice(0, 150) }}{{ event.details.background.length > 150 ? '...' : '' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.chargen-card { border-radius: 6px; overflow: hidden; }
.card-top { padding: 8px 12px; background: var(--theme-surface-muted); display: flex; align-items: center; gap: 8px; }
.char-name { font-weight: 700; font-size: 0.9375rem; color: var(--theme-text-primary); }
.char-tier { background: var(--theme-primary); color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 0.6875rem; font-weight: 600; }
.char-race { font-size: 0.75rem; opacity: 0.6; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.char-attrs { display: flex; gap: 12px; font-size: 0.8125rem; color: var(--theme-text-primary); }
.attr { font-weight: 600; }
.char-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag { background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.6875rem; }
.char-bg { font-size: 0.75rem; opacity: 0.7; line-height: 1.5; }
</style>
