<script setup lang="ts">
import { ref } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import FormSelect from '../shared/form/FormSelect.vue';
import FormStepper from '../shared/form/FormStepper.vue';
import AppButton from '../shared/AppButton.vue';
import PlotOutlinePreview from './PlotOutlinePreview.vue';

const store = useCreateStore();

const showReviseBox = ref(false);
const reviseText = ref('');
const importInput = ref<HTMLInputElement | null>(null);
const exportError = ref('');
const showClearConfirm = ref(false);

async function submitRevise() {
  const text = reviseText.value.trim();
  if (!text) return;
  const ok = await store.reviseOutline(text);
  if (ok) {
    reviseText.value = '';
    showReviseBox.value = false;
  }
}

function handleExportOutline() {
  try {
    const data = {
      title: store.plotOutline?.title ?? '',
      summary: store.plotOutline?.summary ?? '',
      content: store.plotOutline?.content ?? '',
      chapters: JSON.parse(JSON.stringify(store.plotOutlineChapters)),
      plotSettings: JSON.parse(JSON.stringify(store.plotSettings)),
      exportedAt: new Date().toISOString(),
      version: 1,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.title || '剧情大纲'}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    exportError.value = '导出失败';
    console.error('导出大纲失败:', err);
  }
}

function triggerImportOutline() {
  importInput.value?.click();
}

async function handleImportOutline(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!data.title && !data.content) {
      throw new Error('文件格式不正确：缺少 title 或 content');
    }
    if (!data.chapters || !Array.isArray(data.chapters) || data.chapters.length === 0) {
      throw new Error('文件格式不正确：缺少 chapters 或 chapters 为空');
    }

    store.plotOutline = {
      id: '',
      saveId: '',
      mode: data.plotSettings?.mode ?? store.plotSettings.mode,
      title: data.title,
      summary: data.summary ?? '',
      content: data.content ?? '',
      chapters: data.chapters,
      confirmed: false,
      version: 1,
      timeRange: { start: '', end: '' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any;

    store.plotOutlineChapters = data.chapters;

    input.value = '';
    exportError.value = '';
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : '导入失败';
    console.error('导入大纲失败:', err);
    input.value = '';
  }
}

function handleClearOutline() {
  store.clearOutline();
  showClearConfirm.value = false;
}

function handleExportDebug() {
  const ok = store.exportAIDebugDump();
  exportError.value = ok ? '' : 'AI 调试数据已失效（页面刷新后会丢失），请重新生成大纲后再导出';
}

const GENRE_OPTIONS = [
  { label: '战斗', value: 'combat', desc: '侧重战斗冲突与力量成长' },
  { label: '解谜', value: 'mystery', desc: '侧重悬疑推理与真相揭露' },
  { label: '社交', value: 'social', desc: '侧重势力博弈与人际关系' },
  { label: '恋爱', value: 'romance', desc: '侧重情感发展与羁绊建立' },
  { label: '探索', value: 'exploration', desc: '侧重地图探索与未知发现' },
  { label: '权谋', value: 'politics', desc: '侧重政治斗争与权力更迭' },
  { label: '生存', value: 'survival', desc: '侧重资源管理与逆境求生' },
  { label: '悲剧', value: 'tragedy', desc: '侧重命运无常与英雄陨落' },
];

const DIFFICULTY_OPTIONS = [
  { label: '自适应', value: 'adaptive' as const, desc: '根据玩家的生命层级自动适配' },
  { label: 'T2 中坚', value: 2 as const },
  { label: 'T3 精英', value: 3 as const },
  { label: 'T4 史诗', value: 4 as const },
  { label: 'T7 神祇', value: 7 as const },
];
</script>

<template>
  <section class="step-plot">
    <h2 class="step-title">剧情规划</h2>

    <div class="plot-form">
      <FormSelect
        v-model="store.plotMode"
        label="模式"
        :options="[
          { label: '关闭', value: 'off' },
          { label: '主线模式', value: 'main' },
          { label: '支线模式', value: 'side' },
        ]"
      />

      <template v-if="store.plotMode === 'main'">
        <div class="field-row field-row-triple">
          <div class="field-group">
            <label class="field-label">持续年份</label>
            <FormStepper v-model="store.plotDurationYears" :min="1" :max="20" />
            <p class="field-hint">推荐 1~20</p>
          </div>
          <div class="field-group">
            <label class="field-label">章节数量</label>
            <FormStepper v-model="store.plotChapterCount" :min="1" :max="20" />
            <p class="field-hint">推荐 3~5 章</p>
          </div>
          <div class="field-group">
            <label class="field-label">每章事件数</label>
            <FormStepper v-model="store.plotEventsPerChapter" :min="1" :max="20" />
            <p class="field-hint">推荐 3~5 个</p>
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">难度层级</label>
          <p class="field-hint">主线的最高难度，生成的 NPC 和敌人不会大于此层级</p>
          <div class="difficulty-options">
            <button
              v-for="o in DIFFICULTY_OPTIONS"
              :key="o.value"
              class="difficulty-btn"
              :class="{ active: store.plotDifficultyTier === o.value }"
              @click="store.plotDifficultyTier = o.value"
            >
              {{ o.label }}
              <span v-if="o.desc" class="difficulty-desc">{{ o.desc }}</span>
            </button>
          </div>
        </div>

        <FormSelect
          v-model="store.plotAllowNonWorldbookNpc"
          label="外部NPC参与"
          :options="[
            { label: '允许', value: true },
            { label: '禁止', value: false },
          ]"
        />
        <div class="genre-section">
          <label class="field-label">剧情偏向</label>
          <p class="field-hint">选择一个或多个你喜欢的剧情方向，AI 会优先往这些方向发展。</p>
          <div class="genre-grid">
            <label
              v-for="g in GENRE_OPTIONS"
              :key="g.value"
              class="genre-chip"
              :class="{ active: store.plotGenrePreference.includes(g.value as any) }"
              @click="
                () => {
                  const arr = [...store.plotGenrePreference];
                  const i = arr.indexOf(g.value as any);
                  i >= 0 ? arr.splice(i, 1) : arr.push(g.value as any);
                  store.plotGenrePreference = arr;
                }
              "
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
        <div class="field-row field-row-triple">
          <div class="field-group">
            <label class="field-label">章节数量</label>
            <FormStepper v-model="store.plotChapterCount" :min="1" :max="20" />
            <p class="field-hint">推荐 1~3 章</p>
          </div>
          <div class="field-group">
            <label class="field-label">每章事件数</label>
            <FormStepper v-model="store.plotEventsPerChapter" :min="1" :max="20" />
            <p class="field-hint">推荐 2~4 个</p>
          </div>
        </div>
      </template>

      <div v-if="store.plotMode !== 'off'" class="field-group">
        <label class="field-label">雷点（绝对禁止生成的内容）</label>
        <p class="field-hint">仅在生成剧情大纲时生效，优先级高于一切剧情偏好</p>
        <textarea
          v-model="store.plotTabooContent"
          rows="2"
          placeholder="例如：不要出现重要角色永久死亡、不要虐待动物的情节..."
        />
      </div>
    </div>

    <section class="outline-section">
      <h3>大纲预览</h3>
      <PlotOutlinePreview
        :outline="store.plotOutline"
        :chapters="store.plotOutlineChapters"
        :is-generating="store.isPlotGenerating"
        :revealed="store.plotOutlineRevealed"
        @reveal="store.plotOutlineRevealed = true"
      />
    </section>

    <div class="generate-row">
      <template v-if="!store.plotOutline">
        <AppButton
          variant="secondary"
          :disabled="store.isPlotGenerating"
          @click="store.generatePlotOutline()"
        >
          生成剧情大纲
        </AppButton>
      </template>
      <template v-else>
        <div class="reroll-btns">
          <AppButton
            variant="secondary"
            :disabled="store.isPlotGenerating"
            @click="store.generatePlotOutline()"
          >
            重新生成
          </AppButton>
          <AppButton
            variant="secondary"
            :disabled="store.isPlotGenerating"
            @click="showReviseBox = !showReviseBox"
          >
            按要求修改
          </AppButton>
          <AppButton
            v-if="store.outlineHistory.length > 0"
            variant="ghost"
            :disabled="store.isPlotGenerating"
            @click="store.rollbackOutline()"
          >
            回退上一版
          </AppButton>
        </div>
        <div class="revise-box" :class="{ open: showReviseBox }">
          <div class="revise-inner">
            <textarea
              v-model="reviseText"
              rows="3"
              placeholder="你希望怎么改这份大纲？如：第二章反派动机太俗套，改成和主角命定核心有关联"
              :disabled="store.isPlotGenerating"
            />
            <AppButton
              variant="primary"
              size="sm"
              :disabled="store.isPlotGenerating || !reviseText.trim()"
              @click="submitRevise()"
            >
              提交修改
            </AppButton>
          </div>
        </div>
        <div class="outline-io-btns">
          <button
            class="io-btn"
            :disabled="store.isPlotGenerating"
            title="导出大纲为 JSON 文件"
            @click="handleExportOutline"
          >
            导出大纲
          </button>
          <button
            class="io-btn"
            :disabled="store.isPlotGenerating"
            title="从 JSON 文件导入大纲"
            @click="triggerImportOutline"
          >
            导入大纲
          </button>
          <button
            class="io-btn io-btn-danger"
            :disabled="store.isPlotGenerating"
            title="清除当前大纲，回到未生成状态"
            @click="showClearConfirm = !showClearConfirm"
          >
            清除大纲
          </button>
          <button
            class="io-btn"
            :disabled="store.isPlotGenerating"
            title="导出本次生成的 AI 调试数据（提示词/思维链/正文/参数）为 JSON"
            @click="handleExportDebug"
          >
            导出AI调试
          </button>
        </div>
        <div class="clear-confirm" :class="{ open: showClearConfirm }">
          <div class="clear-confirm-inner">
            <p class="clear-confirm-text">
              确定清除大纲吗？大纲与修改历史将被删除（角色捏人数据不受影响），操作不可撤销。
            </p>
            <div class="clear-confirm-btns">
              <button class="io-btn io-btn-danger" @click="handleClearOutline">确认清除</button>
              <button class="io-btn" @click="showClearConfirm = false">取消</button>
            </div>
          </div>
        </div>
        <input
          ref="importInput"
          type="file"
          accept=".json"
          style="display: none"
          @change="handleImportOutline"
        />
        <p v-if="exportError" class="error-msg">{{ exportError }}</p>
      </template>
      <p v-if="store.plotGenerationError" class="error-msg">{{ store.plotGenerationError }}</p>
      <p class="warning">此操作将调用 AI，可能需要等待较长时间</p>
    </div>
  </section>
</template>

<style scoped>
.step-plot {
  max-width: 800px;
  margin: 0 auto;
}
.step-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  margin-bottom: var(--theme-spacing-md);
}
.plot-form {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

/* ===== 字段提示文字 ===== */
.field-group {
  margin-bottom: var(--theme-spacing-xs);
}
.field-label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  margin-bottom: 2px;
}
.field-hint {
  font-size: 0.68rem;
  color: var(--theme-text-muted);
  margin: 2px 0 6px;
  line-height: 1.4;
}

/* ===== 行内多控件 ===== */
.field-row {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.field-row .field-group {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}
.field-row-triple {
  flex-wrap: wrap;
}

/* ===== 难度层级单选按钮 ===== */
.difficulty-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
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
.genre-section {
  margin-bottom: var(--theme-spacing-xs);
}
.genre-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 6px;
}
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
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.08);
}
.genre-chip.active {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--theme-primary) 20%, transparent);
}
.genre-chip-label {
  font-weight: 600;
  font-size: 0.85rem;
  color: var(--theme-text-primary);
}
.genre-chip.active .genre-chip-label {
  color: var(--theme-primary);
}
.genre-chip-desc {
  font-size: 0.68rem;
  color: var(--theme-text-muted);
  line-height: 1.3;
}

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
.outline-section {
  margin-top: var(--theme-spacing-lg);
  padding-top: var(--theme-spacing-md);
  border-top: 1px solid var(--theme-card-border);
}
.outline-section h3 {
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
  margin-bottom: var(--theme-spacing-xs);
}
.generate-row {
  margin-top: var(--theme-spacing-md);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.warning {
  margin: 0;
  font-size: 0.7rem;
  color: var(--theme-quality-legendary);
}
.error-msg {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-error);
}
.reroll-btns {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--theme-spacing-sm);
}
.revise-box {
  width: 100%;
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.revise-box.open {
  grid-template-rows: 1fr;
}
.revise-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--theme-spacing-sm);
}
.revise-box.open .revise-inner {
  padding-top: var(--theme-spacing-xs);
}
.revise-inner textarea {
  width: 100%;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 0.8rem;
  font-family: inherit;
  transition: border-color 0.15s;
  box-sizing: border-box;
  resize: vertical;
}
.revise-inner textarea:focus {
  outline: none;
  border-color: var(--theme-primary);
}
@media (prefers-reduced-motion: reduce) {
  .revise-box {
    transition: none;
  }
}

/* ===== 导入/导出/清除 ===== */
.outline-io-btns {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm, 8px);
  margin-top: var(--theme-spacing-sm, 8px);
  justify-content: center;
}
.io-btn {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-secondary);
  padding: 4px 12px;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  font-size: 0.8rem;
  font-family: inherit;
  transition:
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.io-btn:hover:not(:disabled) {
  border-color: var(--theme-primary);
  color: var(--theme-primary);
}
.io-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.io-btn-danger {
  color: var(--theme-error);
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
}
.io-btn-danger:hover:not(:disabled) {
  border-color: var(--theme-error);
  color: var(--theme-error);
}

/* ===== 清除确认折叠（同 revise-box 模式） ===== */
.clear-confirm {
  width: 100%;
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.clear-confirm.open {
  grid-template-rows: 1fr;
}
.clear-confirm-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding-top: 0;
}
.clear-confirm.open .clear-confirm-inner {
  padding-top: var(--theme-spacing-xs);
}
.clear-confirm-text {
  margin: 0;
  font-size: 0.72rem;
  color: var(--theme-text-muted);
  text-align: center;
  line-height: 1.5;
}
.clear-confirm-btns {
  display: flex;
  gap: var(--theme-spacing-sm, 8px);
}
@media (prefers-reduced-motion: reduce) {
  .clear-confirm {
    transition: none;
  }
}
</style>
