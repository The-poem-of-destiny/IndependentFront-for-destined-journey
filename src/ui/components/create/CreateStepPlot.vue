<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import FormSelect from '../shared/form/FormSelect.vue'
import FormStepper from '../shared/form/FormStepper.vue'
import AppButton from '../shared/AppButton.vue'
import PlotOutlinePreview from './PlotOutlinePreview.vue'

const store = useCreateStore()

const GENRE_OPTIONS = [
  { label: '战斗', value: 'combat', desc: '侧重战斗冲突与力量成长' },
  { label: '解谜', value: 'mystery', desc: '侧重悬疑推理与真相揭露' },
  { label: '社交', value: 'social', desc: '侧重势力博弈与人际关系' },
  { label: '恋爱', value: 'romance', desc: '侧重情感发展与羁绊建立' },
  { label: '探索', value: 'exploration', desc: '侧重地图探索与未知发现' },
  { label: '权谋', value: 'politics', desc: '侧重政治斗争与权力更迭' },
  { label: '生存', value: 'survival', desc: '侧重资源管理与逆境求生' },
  { label: '悲剧', value: 'tragedy', desc: '侧重命运无常与英雄陨落' },
]

const DIFFICULTY_OPTIONS = [
  { label: '自适应', value: 'adaptive' as const, desc: '根据玩家的生命层级自动适配' },
  { label: 'T2 中坚', value: 2 as const },
  { label: 'T3 精英', value: 3 as const },
  { label: 'T4 史诗', value: 4 as const },
  { label: 'T5 传说', value: 5 as const },
  { label: 'T6 神话', value: 6 as const },
  { label: 'T7 神祇', value: 7 as const },
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
        <div class="field-group">
          <label class="field-label">持续年份</label>
          <FormStepper v-model="store.plotDurationYears" :min="1" :max="20" />
          <p class="field-hint">AI 会往后规划多少年的剧情</p>
        </div>

        <div class="field-group">
          <label class="field-label">难度层级</label>
          <p class="field-hint">主线的最高难度，生成的 NPC 和敌人不会大于此层级</p>
          <div class="difficulty-options">
            <button
              v-for="o in DIFFICULTY_OPTIONS" :key="o.value"
              class="difficulty-btn"
              :class="{ active: store.plotDifficultyTier === o.value }"
              @click="store.plotDifficultyTier = o.value"
            >
              {{ o.label }}
              <span v-if="o.desc" class="difficulty-desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>

        <FormSelect v-model="store.plotAllowNonWorldbookNpc" label="外部NPC参与" :options="[
          { label: '允许', value: true }, { label: '禁止', value: false },
        ]" />
        <div class="genre-section">
          <label class="field-label">剧情偏向</label>
          <p class="field-hint">选择一个或多个你喜欢的剧情方向，AI 会优先往这些方向发展。</p>
          <div class="genre-grid">
            <label
              v-for="g in GENRE_OPTIONS" :key="g.value"
              class="genre-chip"
              :class="{ active: store.plotGenrePreference.includes(g.value as any) }"
              @click="() => {
                const arr = [...store.plotGenrePreference]
                const i = arr.indexOf(g.value as any)
                i >= 0 ? arr.splice(i, 1) : arr.push(g.value as any)
                store.plotGenrePreference = arr
              }"
            >
              <span class="genre-chip-label">{{ g.label }}</span>
              <span class="genre-chip-desc">{{ g.desc }}</span>
            </label>
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

/* ===== 字段提示文字 ===== */
.field-group { margin-bottom: var(--theme-spacing-xs); }
.field-label { display: block; font-size: 0.75rem; font-weight: 600; color: var(--theme-text-secondary); margin-bottom: 2px; }
.field-hint { font-size: 0.68rem; color: var(--theme-text-muted); margin: 2px 0 6px; line-height: 1.4; }

/* ===== 难度层级单选按钮 ===== */
.difficulty-options { display: flex; flex-wrap: wrap; gap: 4px; }
.difficulty-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 14px;
  border: 1.5px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  min-width: 72px;
  font-family: inherit;
}
.difficulty-btn:hover {
  border-color: var(--theme-primary);
  transform: translateY(-1px);
}
.difficulty-btn.active {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  border-color: var(--theme-primary);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--theme-primary) 25%, transparent);
}
.difficulty-desc {
  font-size: 0.6rem;
  font-weight: 400;
  opacity: 0.8;
  margin-top: 1px;
}

/* ===== 剧情偏向 ===== */
.genre-section { margin-bottom: var(--theme-spacing-xs); }
.genre-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
.genre-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1.5px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  user-select: none;
  background: var(--theme-card-bg);
}
.genre-chip:hover {
  border-color: var(--theme-primary);
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0,0,0,0.08);
}
.genre-chip.active {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 20%, transparent);
}
.genre-chip-label { font-weight: 600; font-size: 0.85rem; color: var(--theme-text-primary); }
.genre-chip.active .genre-chip-label { color: var(--theme-primary); }
.genre-chip-desc { font-size: 0.68rem; color: var(--theme-text-muted); line-height: 1.3; }

/* ===== 其他 ===== */
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
  transition: border-color 0.15s;
  box-sizing: border-box;
}
.field-group textarea:focus,
.field-group input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.outline-section { margin-top: var(--theme-spacing-lg); padding-top: var(--theme-spacing-md); border-top: 1px solid var(--theme-card-border); }
.outline-section h3 { font-size: 0.85rem; color: var(--theme-text-secondary); margin-bottom: var(--theme-spacing-xs); }
.generate-row { margin-top: var(--theme-spacing-md); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.warning { margin: 0; font-size: 0.7rem; color: var(--theme-quality-legendary); }
</style>
