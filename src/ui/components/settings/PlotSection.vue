<script setup lang="ts">
/**
 * 剧情系统分区 —— 8 种偏向 / 模式 / 年份 / 难度 / 外部 NPC / 自定义偏好 + 大纲预览
 * （Q-25 从 SettingsPage.vue 抽出）
 */
import { ref } from 'vue';
import AppCard from '../shared/AppCard.vue';
import AppButton from '../shared/AppButton.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useBranding } from '../../branding-defaults';

const s = useSettingsStore().settings;

// 大纲示例是**内容**不是引擎（D26）：随内容包走，未装包时为空 → 整张预览卡不渲染
const { branding } = useBranding();

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
/**
 * 随机事件频率三档（随机事件系统 v1 / 裁定 §13-6）。
 *
 * 系数乘进每次 MTTH 掷骰的权重：×0.5 = 有效 MTTH 翻倍（更稀），×2 = 减半（更密）。
 * 🔴 说明文字里**不写具体天数** —— MTTH 是每条事件定义自带的（内容包给），
 *    在设置页写死「约 30 天一次」会随内容包一起变成假话。
 */
const randomEventFrequencyOptions = [
  { value: 0.5, label: '低', hint: '事件更稀疏，约为标准频率的一半。' },
  { value: 1, label: '标准', hint: '按事件定义自带的平均间隔触发。' },
  { value: 2, label: '高', hint: '事件更密集，约为标准频率的两倍。' },
];
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
    <AppCard padding="md" class="detail-card"
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
    <!--
      随机事件（随机事件系统 v1 / 设计 §6）。

      放在剧情分区里是**语义归属**（支线/遭遇属剧情家族），不是开关耦合：
      这两格是全局设置（localStorage，不进存档），而上面那批 plot* 是「新档默认值」。
      剧情模式设成「完全关闭」时随机事件照常工作 —— 措辞必须把这件事说清楚，
      否则玩家会以为关掉剧情系统就等于关掉了这里。
    -->
    <AppCard padding="md" class="detail-card"
      ><h4>随机事件</h4>
      <p class="card-desc">
        旅途中的支线遭遇：引擎按事件定义掷骰产出候选，AI 在叙事自然的时机把其中一条编织进正文。
        本项为<strong>全局设置</strong>，立即对所有存档生效（与上方「新档默认值」不同），
        且与「剧情模式」开关相互独立 —— 剧情系统完全关闭时随机事件照常触发。
      </p>
      <div class="toggle-row">
        <label class="toggle-label"
          ><input v-model="s.randomEventsEnabled" type="checkbox" class="toggle-input" /><span
            class="toggle-slider"
          /><span>启用随机事件</span></label
        >
      </div>
      <p class="form-hint random-event-note">
        关闭后不再掷骰、不再注入提示词，AI
        的触发回执也会被忽略；<strong>已产生的候选与已触发记录保留不清</strong>，重新打开即接着用。
      </p>
      <template v-if="s.randomEventsEnabled">
        <p class="freq-title">触发频率</p>
        <div class="freq-list" role="radiogroup" aria-label="随机事件触发频率">
          <button
            v-for="f in randomEventFrequencyOptions"
            :key="f.value"
            class="freq-item"
            :class="{ 'freq-active': s.randomEventsFrequency === f.value }"
            role="radio"
            :aria-checked="s.randomEventsFrequency === f.value"
            @click="s.randomEventsFrequency = f.value"
          >
            <span class="freq-label">{{ f.label }}</span>
            <span class="freq-hint">{{ f.hint }}</span>
          </button>
        </div>
      </template>
    </AppCard>
    <!-- 大纲预览（示例来自内容包；没有示例就不出这张卡） -->
    <AppCard
      v-if="branding.plotTemplate.length > 0"
      padding="md"
      class="detail-card plot-preview-card"
      :class="{ 'plot-revealed': showPlotPreview }"
    >
      <div class="plot-preview-header">
        <h4>剧情大纲预览</h4>
        <AppButton variant="ghost" size="sm" @click="showPlotPreview = !showPlotPreview">{{
          showPlotPreview ? '隐藏' : '点击查看（防剧透）'
        }}</AppButton>
      </div>
      <!--
        示例大纲由 branding.plotTemplate 供给（D26）—— 它讲的是**某个具体世界**的
        五年主线，属于内容不属于引擎。未装内容包时这一段是空的，整张预览卡不渲染
        （给一份编出来的通用大纲当示例，只会让人以为那就是将要生成的东西）。
      -->
      <div class="plot-preview-body" :class="{ 'plot-blur': !showPlotPreview }">
        <template v-for="(beat, i) in branding.plotTemplate" :key="i">
          <p v-if="beat.title" class="text-muted text-sm">
            <strong>{{ beat.title }}</strong>
          </p>
          <p v-if="beat.body" class="text-muted text-sm">{{ beat.body }}</p>
        </template>
      </div>
      <p class="text-xs text-muted plot-note">
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
/* 大纲预览下方的补充说明 */
.plot-note {
  margin-top: var(--theme-spacing-sm);
}

/* ═══ 随机事件子块 ═══ */
.random-event-note {
  margin: var(--theme-spacing-sm) 0 0;
}
.freq-title {
  margin: var(--theme-spacing-md) 0 var(--theme-spacing-xs);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.freq-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.freq-item {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  min-height: 36px;
  padding: 10px var(--theme-spacing-md);
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.freq-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
/* 激活态照 design.md §2「激活态配方」：染底 + 混合边框，不用侧边强调条 */
.freq-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.freq-label {
  font-size: 0.9rem;
  font-weight: 600;
}
.freq-active .freq-label {
  color: var(--theme-primary);
}
.freq-hint {
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}
</style>
