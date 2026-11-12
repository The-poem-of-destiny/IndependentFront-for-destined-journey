<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { liveQuery } from 'dexie';
import type { CharacterState } from '@engine/types/types';
import type { CharacterChronicleEntry } from '@engine/types/types-character';
import { getDatabase } from '@engine/persistence/database';
import {
  CHRONICLE_IMPORTANCE_THRESHOLD,
  chronicleTimeLabel,
  compareChronicleEntries,
} from '@engine/character/character-chronicle';

const props = defineProps<{ character: CharacterState }>();
const entries = ref<CharacterChronicleEntry[]>([]);
const query = ref('');
const importantOnly = ref(false);
const newestFirst = ref(true);
const loading = ref(true);
const error = ref('');
let subscription: { unsubscribe(): void } | undefined;
watch(
  () => [props.character.saveId, props.character.id],
  ([saveId, characterId]) => {
    subscription?.unsubscribe();
    entries.value = [];
    query.value = '';
    importantOnly.value = false;
    newestFirst.value = true;
    loading.value = true;
    error.value = '';
    subscription = liveQuery(() =>
      getDatabase()
        .characterChronicle.where('[saveId+characterId]')
        .equals([saveId, characterId])
        .toArray(),
    ).subscribe({
      next: (rows) => {
        entries.value = rows;
        loading.value = false;
        error.value = '';
      },
      error: () => {
        error.value = '经历暂时读取失败，请关闭角色界面后重试。';
        loading.value = false;
      },
    });
  },
  { immediate: true },
);
onUnmounted(() => subscription?.unsubscribe());
const importantCount = computed(
  () => entries.value.filter((e) => e.importance >= CHRONICLE_IMPORTANCE_THRESHOLD).length,
);
const filtered = computed(() =>
  entries.value
    .filter((entry) => {
      if (importantOnly.value && entry.importance < CHRONICLE_IMPORTANCE_THRESHOLD) return false;
      const text = [
        entry.title,
        entry.summary,
        entry.impact,
        entry.location,
        ...(entry.people ?? []),
        chronicleTimeLabel(entry),
      ]
        .join('\n')
        .toLocaleLowerCase();
      return text.includes(query.value.trim().toLocaleLowerCase());
    })
    .sort((a, b) => compareChronicleEntries(a, b) * (newestFirst.value ? -1 : 1)),
);
const groups = computed(() => {
  const groups = [
    {
      key: 'journey',
      title: '本次旅程',
      entries: filtered.value.filter((e) => e.origin === 'experience'),
    },
    {
      key: 'past',
      title: '相遇之前',
      entries: filtered.value.filter((e) => e.origin !== 'experience'),
    },
  ];
  return (newestFirst.value ? groups : groups.reverse()).filter((g) => g.entries.length);
});
function clearFilters() {
  query.value = '';
  importantOnly.value = false;
}
</script>

<template>
  <section class="chronicle" aria-label="角色编年史">
    <div class="chronicle-toolbar">
      <div class="chronicle-filters" role="group" aria-label="经历范围">
        <button type="button" :aria-pressed="!importantOnly" @click="importantOnly = false">
          全部经历
        </button>
        <button type="button" :aria-pressed="importantOnly" @click="importantOnly = true">
          重要经历 {{ importantCount }}
        </button>
      </div>
      <button type="button" @click="newestFirst = !newestFirst">
        {{ newestFirst ? '最近在前' : '最早在前' }}
      </button>
    </div>
    <label class="chronicle-search">
      <span>搜索经历</span>
      <input v-model="query" type="search" placeholder="搜索经历、地点或人物" />
    </label>
    <p v-if="loading" class="chronicle-empty" role="status">正在读取经历…</p>
    <p v-else-if="error" class="chronicle-empty" role="alert">{{ error }}</p>
    <p v-else-if="!entries.length" class="chronicle-empty">
      尚无经历记录。后续旅程中的经历会记在这里。
    </p>
    <div v-else-if="!filtered.length" class="chronicle-empty" role="status">
      <p>没有符合条件的经历</p>
      <button type="button" @click="clearFilters">清除筛选</button>
    </div>
    <template v-else>
      <p class="chronicle-count" aria-live="polite">
        显示 {{ filtered.length }} / {{ entries.length }} 条经历
      </p>
      <section
        v-for="group in groups"
        :key="group.key"
        class="chronicle-group"
        :aria-label="group.title"
      >
        <h3>{{ group.title }}</h3>
        <ol class="chronicle-list">
          <li
            v-for="entry in group.entries"
            :key="entry.id"
            :class="{ important: entry.importance >= CHRONICLE_IMPORTANCE_THRESHOLD }"
          >
            <div class="entry-time">{{ chronicleTimeLabel(entry) }}</div>
            <div class="entry-heading">
              <h4>{{ entry.title }}</h4>
              <span class="entry-importance">重要度 {{ entry.importance }}</span>
            </div>
            <p class="entry-summary">{{ entry.summary }}</p>
            <div v-if="entry.location || entry.people?.length" class="entry-meta">
              <span v-if="entry.location">{{ entry.location }}</span>
              <span v-if="entry.people?.length">{{ entry.people.join('、') }}</span>
            </div>
            <details>
              <summary>经历详情</summary>
              <dl>
                <template v-if="entry.impact"
                  ><dt>持续影响</dt>
                  <dd>{{ entry.impact }}</dd></template
                >
                <dt>记录来源</dt>
                <dd>
                  {{
                    entry.origin === 'author'
                      ? '作者初始设定'
                      : entry.origin === 'generated'
                        ? '初登场时生成的过去'
                        : '游玩回合'
                  }}
                </dd>
                <dt>来源片段</dt>
                <dd class="entry-source">{{ entry.sourceText || '来源片段暂不可用' }}</dd>
              </dl>
            </details>
          </li>
        </ol>
      </section>
      <p class="chronicle-note">
        过去的时间保留原有精度。“重要经历”仅筛选当前列表；叙事会在预算内读取相关的重要记录。
      </p>
    </template>
  </section>
</template>

<style scoped>
.chronicle {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-lg);
  color: var(--theme-text-primary);
}
.chronicle-toolbar,
.chronicle-filters,
.entry-heading,
.entry-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.chronicle-toolbar {
  justify-content: space-between;
}
button,
input {
  font: inherit;
  color: inherit;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
button,
summary {
  cursor: pointer;
}
button[aria-pressed='true'] {
  color: var(--theme-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
button:hover {
  background: var(--theme-surface-muted);
}
button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.chronicle-search {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.chronicle-search input {
  width: 100%;
  box-sizing: border-box;
  font-size: 0.8125rem;
}
.chronicle-empty {
  padding: var(--theme-spacing-xl);
  text-align: center;
  color: var(--theme-text-secondary);
}
.chronicle-count,
.chronicle-note {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.6;
}
.chronicle-group h3 {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  margin: 0 0 var(--theme-spacing-md);
}
.chronicle-list {
  list-style: none;
  margin: 0;
  padding: 0 0 0 var(--theme-spacing-lg);
  border-left: 1px solid var(--theme-card-border);
}
.chronicle-list li {
  position: relative;
  padding: 0 0 var(--theme-spacing-xl) var(--theme-spacing-sm);
}
.chronicle-list li::before {
  content: '';
  position: absolute;
  left: calc(-1 * var(--theme-spacing-lg) - 4px);
  top: 0.35em;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--theme-text-secondary);
}
.chronicle-list li.important::before {
  background: var(--theme-primary);
}
.entry-time,
.entry-meta,
.entry-importance {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.entry-heading {
  justify-content: space-between;
  margin-top: var(--theme-spacing-xs);
}
.entry-heading h4 {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  margin: 0;
}
.important .entry-importance {
  color: var(--theme-primary);
}
.entry-summary {
  font-size: 0.8125rem;
  line-height: 1.7;
  margin: var(--theme-spacing-sm) 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.entry-meta {
  margin-bottom: var(--theme-spacing-sm);
}
details {
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
summary {
  padding: var(--theme-spacing-xs) 0;
  width: fit-content;
}
dl {
  margin: var(--theme-spacing-sm) 0 0;
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
}
dt {
  font-weight: 600;
  margin-top: var(--theme-spacing-sm);
}
dt:first-child {
  margin-top: 0;
}
dd {
  margin: var(--theme-spacing-xs) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.entry-source {
  max-height: 16rem;
  overflow-y: auto;
}
</style>
