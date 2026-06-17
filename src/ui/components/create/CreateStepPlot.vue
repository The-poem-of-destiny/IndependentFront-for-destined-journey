<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import FormSelect from '../shared/form/FormSelect.vue'
import FormStepper from '../shared/form/FormStepper.vue'
import AppButton from '../shared/AppButton.vue'
import PlotOutlinePreview from './PlotOutlinePreview.vue'

const store = useCreateStore()

const GENRE_OPTIONS = [
  { label: '战斗 (combat)', value: 'combat' },
  { label: '悬疑 (mystery)', value: 'mystery' },
  { label: '社交 (social)', value: 'social' },
  { label: '恋爱 (romance)', value: 'romance' },
]
</script>

<template>
  <section class="step-plot">
    <h2 class="step-title">剧情规划</h2>

    <div class="plot-form">
      <FormSelect v-model="store.plotMode" label="模式" :options="[
        { label: '关闭', value: 'off' },
        { label: '主线模式', value: 'main' },
        { label: '支线模式', value: 'side' },
      ]" />

      <template v-if="store.plotMode === 'main'">
        <FormStepper v-model="store.plotDurationYears" label="持续年份" :min="1" :max="20" />
        <FormStepper v-model="store.plotDifficultyTier" label="难度层级" :min="1" :max="7" />
        <FormSelect v-model="store.plotAllowNonWorldbookNpc" label="外部NPC参与" :options="[
          { label: '允许', value: true }, { label: '禁止', value: false },
        ]" />
        <div class="genre-section">
          <label class="field-label">剧情偏向</label>
          <div class="genre-tags">
            <button
              v-for="g in GENRE_OPTIONS" :key="g.value"
              class="genre-btn"
              :class="{ active: store.plotGenrePreference.includes(g.value as any) }"
              @click="() => {
                const arr = [...store.plotGenrePreference]
                const i = arr.indexOf(g.value as any)
                i >= 0 ? arr.splice(i, 1) : arr.push(g.value as any)
                store.plotGenrePreference = arr
              }"
            >{{ g.label }}</button>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">自定义偏好</label>
          <textarea v-model="store.plotCustomPreference" rows="2" placeholder="其他偏好描述..." />
        </div>
      </template>

      <template v-if="store.plotMode === 'side'">
        <div class="field-group">
          <label class="field-label">专注区域</label>
          <input v-model="store.plotFocusRegion" placeholder="留空=当前区域" />
        </div>
        <FormSelect v-model="store.plotYearlyGeneration" label="每年自动生成" :options="[
          { label: '是', value: true }, { label: '否', value: false },
        ]" />
      </template>
    </div>

    <section class="outline-section">
      <h3>大纲预览</h3>
      <PlotOutlinePreview
        :outline="store.plotOutline"
        :is-generating="store.isPlotGenerating"
        :revealed="store.plotOutlineRevealed"
        @reveal="store.plotOutlineRevealed = true"
      />
    </section>

    <div class="generate-row">
      <AppButton
        variant="secondary"
        :disabled="store.isPlotGenerating"
        @click="store.generatePlotOutline()"
      >
        🤖 生成剧情大纲
      </AppButton>
      <p class="warning">⚠ 此操作将调用 AI，可能需要等待较长时间</p>
    </div>
  </section>
</template>

<style scoped>
.step-plot { max-width: 560px; margin: 0 auto; }
.step-title { font-family: var(--theme-font-title, serif); color: var(--theme-text-primary); font-size: 1.3rem; margin-bottom: var(--theme-spacing-md); }
.plot-form { display: flex; flex-direction: column; gap: var(--theme-spacing-sm); }
.genre-section { margin-bottom: var(--theme-spacing-xs); }
.field-label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--theme-text-secondary); margin-bottom: 4px; }
.genre-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.genre-btn {
  padding: 3px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.genre-btn.active { background: var(--theme-color-primary); color: #fff; border-color: var(--theme-color-primary); }
.field-group textarea,
.field-group input {
  width: 100%;
  padding: var(--theme-spacing-xs);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.8rem;
  font-family: inherit;
}
.outline-section { margin-top: var(--theme-spacing-lg); }
.outline-section h3 { font-size: 0.85rem; color: var(--theme-text-secondary); margin-bottom: var(--theme-spacing-xs); }
.generate-row { margin-top: var(--theme-spacing-md); text-align: center; }
.warning { margin-top: var(--theme-spacing-xs); font-size: 0.7rem; color: var(--theme-quality-传说); }
</style>
