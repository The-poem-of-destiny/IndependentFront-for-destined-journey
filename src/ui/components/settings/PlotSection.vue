<script setup lang="ts">
/**
 * 剧情系统分区 —— 8 种偏向 / 模式 / 年份 / 难度 / 外部 NPC / 自定义偏好 + 大纲预览
 * （Q-25 从 SettingsPage.vue 抽出）
 */
import { ref } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import { useSettingsStore } from '../../stores/settings-store';

const s = useSettingsStore().settings;

const showPlotPreview = ref(false);
const genreOptions = [
  { value: 'combat', label: '战斗', desc: '侧重战斗冲突与力量成长' },
  { value: 'mystery', label: '解谜', desc: '侧重悬疑推理与真相揭露' },
  { value: 'social', label: '社交', desc: '侧重势力博弈与人际关系' },
  { value: 'romance', label: '恋爱', desc: '侧重情感发展与羁绊建立' },
  { value: 'exploration', label: '探索', desc: '侧重地图探索与未知发现' },
  { value: 'politics', label: '权谋', desc: '侧重政治斗争与权力更迭' },
  { value: 'survival', label: '生存', desc: '侧重资源管理与逆境求生' },
  { value: 'tragedy', label: '悲剧', desc: '侧重命运无常与英雄陨落' },
];
function toggleGenre(g: string) {
  const i = s.plotGenrePreference.indexOf(g);
  if (i >= 0) s.plotGenrePreference.splice(i, 1);
  else s.plotGenrePreference.push(g);
}
const plotDifficultyOptions = [
  { value: 'adaptive', label: '动态（根据玩家层级）' },
  { value: '1', label: 'T1 普通' },
  { value: '2', label: 'T2 中坚' },
  { value: '3', label: 'T3 精英' },
  { value: '4', label: 'T4 史诗' },
  { value: '5', label: 'T5 传说' },
  { value: '6', label: 'T6 神话' },
  { value: '7', label: 'T7 神祇' },
];
</script>

<template>
  <section class="section centered">
    <h3>剧情系统</h3>
    <p class="section-desc">
      控制剧情生成模式、大纲和事件参数。对应 Agent：剧情预检 / 剧情修正 / 大纲生成
    </p>
    <p class="plot-defaults-note">
      此处为「新档默认值」——每个存档可在捏人页「剧情规划」步骤单独调整，互不影响。
    </p>
    <!-- 剧情偏向 — 最上面 -->
    <AppCard padding="md" class="detail-card"
      ><h4>剧情偏向</h4>
      <p class="form-hint">选择一个或多个你喜欢的剧情方向，AI 会优先往这些方向发展。</p>
      <div class="genre-grid">
        <label
          v-for="g in genreOptions"
          :key="g.value"
          class="genre-chip"
          :class="{ 'genre-active': s.plotGenrePreference.includes(g.value) }"
          @click="toggleGenre(g.value)"
          ><span class="genre-chip-label">{{ g.label }}</span
          ><span class="genre-chip-desc">{{ g.desc }}</span></label
        >
      </div></AppCard
    >
    <!-- 模式 & 参数 -->
    <AppCard padding="md" class="detail-card" style="margin-top: 16px"
      ><h4>剧情模式 & 参数</h4>
      <div class="form-grid">
        <label class="form-label"
          >剧情模式
          <p class="form-hint">选择剧情系统的运行模式</p>
          <select v-model="s.plotMode" class="form-input">
            <option value="off">完全关闭 — 不生成任何剧情事件</option>
            <option value="side">仅支线 — 每年自动生成地区冲突事件</option>
            <option value="main">主线模式 — 按大纲推进完整主线剧情</option>
          </select></label
        >
        <template v-if="s.plotMode === 'main'">
          <label class="form-label"
            >主线持续年份
            <p class="form-hint">主线剧情覆盖的游戏年份数</p>
            <input
              v-model.number="s.plotDurationYears"
              type="number"
              min="1"
              max="50"
              class="form-input"
          /></label>
          <label class="form-label"
            >事件难度层级
            <p class="form-hint">动态 = 根据玩家当前层级自动调整</p>
            <select v-model="s.plotDifficultyTier" class="form-input">
              <option v-for="o in plotDifficultyOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select></label
          >
          <label class="form-label"
            >引入外部 NPC
            <p class="form-hint">允许 AI 在世界书之外创造新角色</p>
            <select v-model="s.plotAllowNonWorldbookNpc" class="form-input">
              <option :value="true">允许 — 剧情更丰富但可能偏离设定</option>
              <option :value="false">禁止 — 仅使用世界书内角色</option>
            </select></label
          >
          <label class="form-label" style="grid-column: 1/-1"
            >自定义偏好
            <p class="form-hint">用自然语言描述你想要的剧情风格</p>
            <textarea
              v-model="s.plotCustomPreference"
              class="form-input form-textarea"
              rows="2"
              placeholder="例如：希望主角经历一场背叛后重新振作..."
            />
          </label>
          <label class="form-label"
            >章节数量
            <p class="form-hint">主线推荐 3~5 章，0 = AI 自行判断</p>
            <input
              v-model.number="s.plotChapterCount"
              type="number"
              min="0"
              max="20"
              class="form-input"
          /></label>
          <label class="form-label"
            >每章事件数
            <p class="form-hint">主线推荐 3~5 个，0 = AI 自行判断</p>
            <input
              v-model.number="s.plotEventsPerChapter"
              type="number"
              min="0"
              max="20"
              class="form-input"
          /></label>
        </template>
        <template v-if="s.plotMode === 'side'">
          <label class="form-label"
            >专注区域
            <p class="form-hint">支线剧情优先围绕此区域生成，留空 = 当前区域</p>
            <input v-model="s.plotFocusRegion" class="form-input" placeholder="留空=当前区域"
          /></label>
          <label class="form-label"
            >章节数量
            <p class="form-hint">支线推荐 1~3 章，0 = AI 自行判断</p>
            <input
              v-model.number="s.plotChapterCount"
              type="number"
              min="0"
              max="20"
              class="form-input"
          /></label>
          <label class="form-label"
            >每章事件数
            <p class="form-hint">支线推荐 2~4 个，0 = AI 自行判断</p>
            <input
              v-model.number="s.plotEventsPerChapter"
              type="number"
              min="0"
              max="20"
              class="form-input"
          /></label>
        </template>
        <label v-if="s.plotMode !== 'off'" class="form-label" style="grid-column: 1/-1"
          >雷点（绝对禁止生成的内容）
          <p class="form-hint">仅在生成剧情大纲时生效，优先级高于一切剧情偏好</p>
          <textarea
            v-model="s.plotTabooContent"
            class="form-input form-textarea"
            rows="2"
            placeholder="例如：不要出现重要角色永久死亡、不要虐待动物的情节..."
          />
        </label>
      </div>
    </AppCard>
    <!-- 大纲预览 -->
    <AppCard
      padding="md"
      class="detail-card plot-preview-card"
      :class="{ 'plot-revealed': showPlotPreview }"
      style="margin-top: 16px"
    >
      <div class="plot-preview-header">
        <h4>剧情大纲预览</h4>
        <AppButton variant="ghost" size="sm" @click="showPlotPreview = !showPlotPreview">{{
          showPlotPreview ? '隐藏' : '点击查看（防剧透）'
        }}</AppButton>
      </div>
      <div class="plot-preview-body" :class="{ 'plot-blur': !showPlotPreview }">
        <p class="text-muted text-sm"><strong>第一年 — 序章：命定之始</strong></p>
        <p class="text-muted text-sm">主角在起始地点觉醒命运之力，遭遇第一次重大抉择...</p>
        <p class="text-muted text-sm"><strong>第二年 — 崛起：风云际会</strong></p>
        <p class="text-muted text-sm">与各大势力接触，逐步揭开世界背后的真相...</p>
        <p class="text-muted text-sm"><strong>第三年 — 转折：命运分叉</strong></p>
        <p class="text-muted text-sm">关键盟友背叛/牺牲，主线走向出现重大分支...</p>
        <p class="text-muted text-sm"><strong>第四年 — 高潮：诸神黄昏</strong></p>
        <p class="text-muted text-sm">最终决战前夕，所有伏笔回收，各方势力集结...</p>
        <p class="text-muted text-sm"><strong>第五年 — 终章：命定之诗</strong></p>
        <p class="text-muted text-sm">完成主线任务，世界线尘埃落定，角色结局生成...</p>
      </div>
      <p class="text-xs text-muted" style="margin-top: 8px">
        以上为示例大纲。实际内容由 AI 在游戏开始时生成。点击可切换模糊/清晰。
      </p>
    </AppCard>
  </section>
</template>

<!-- 共用外壳（.section>h3 / .section-desc / .form-* / .toggle-*）：唯一一份在 settings-chrome.css -->
<style scoped src="./settings-chrome.css"></style>

<style scoped>
.plot-defaults-note {
  margin: -8px 0 16px;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
}
/* Plot */
.genre-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.genre-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
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
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
.genre-chip:hover {
  border-color: var(--theme-primary);
}
.genre-active {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
}
.genre-chip-label {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--theme-text-primary);
}
.genre-active .genre-chip-label {
  color: var(--theme-primary);
}
.genre-chip-desc {
  font-size: 0.72rem;
  color: var(--theme-text-muted);
}
.plot-preview-card {
  transition: all 0.3s ease;
}
.plot-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.plot-preview-header h4 {
  margin: 0;
  font-size: 0.95rem;
}
.plot-blur {
  filter: blur(6px);
  user-select: none;
  opacity: 0.5;
  transition: all 0.3s ease;
  cursor: pointer;
}
.plot-preview-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>
