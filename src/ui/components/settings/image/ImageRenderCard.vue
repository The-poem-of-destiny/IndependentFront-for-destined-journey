<script setup lang="ts">
/**
 * 第二张卡：**出图** —— NAI 参数与限额（D51），全部存 `UiSettings`。
 *
 * 三件在这张卡里必须做对的事：
 *
 * 1. 🔴 **三档开关不是三个光秃秃的单选**（D44）。`auto` 那一项底下带一行后果，
 *    并且**首次**从别的档切到 `auto` 时弹一次确认（`imageAutoConfirmed` 记住）。
 *    自动档是**无人值守花钱**，在决策点讲清楚比事后给一个计数器早一步。
 *    后果行里的两个数字取**当前设置值**而不是文案里写死的数 —— 用户调过限额之后
 *    还照着旧数字吓唬他，就成了一句假话。
 *
 * 2. 🔴 **免费额度指示只在 `consumes-anlas` 时报数**（D43 / §11.2）。
 *    `estimateAnlasCost` 的 `anlasPerSample` 在免费档内**也是正数** —— 那是这张图
 *    的牌价，不是这次要付多少。在免费分支渲染它会显示「免费，约 17 点」这种自相矛盾。
 *    输入框被清空 → `NaN` → 函数返回 `consumes-anlas` + `invalid-input`，那一支
 *    单独渲染成「算不出来」：把**不知道**显示成**免费**正是这个指示器最不该犯的错。
 *    措辞一律是「按当前订阅规则**估算**」—— NAI 的规则会变，我们给的是提示不是保证。
 *
 * 3. 🔴 画质后缀与全局负向是**图的提示词**，直接拼进每一张图；上面那张卡的
 *    systemPrompt 是**Agent 的提示词**。两者都叫「提示词」却完全不同层，写错框
 *    两边都不报错（§11.3）。所以两处各写明作用范围，别删。
 *
 * 画质后缀的默认值来自 `image-defaults.DEFAULT_IMAGE_QUALITY_SUFFIX`（`getDefaults()`
 * 里取的），**不带前导逗号** —— `composePrompt` 自己用 `', '` 连接各段。
 */
import { computed, ref } from 'vue';
import AppCard from '../../shared/AppCard.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';
import { useSettingsStore, type ApiEntry } from '../../../stores/settings-store';
import { estimateAnlasCost } from '@engine/image-anlas';
import type { ImageGenMode, ImageRating } from '@engine/types-image';

const cfg = useSettingsStore();
const s = cfg.settings;

// ═══ 三档开关（D14 / D44）═══

const MODES: { key: ImageGenMode; label: string; hint: string }[] = [
  { key: 'off', label: '关闭', hint: '完全不出图，正文里的插画标记直接忽略。' },
  {
    key: 'manual',
    label: '手动（推荐）',
    hint: '标记只变成一个按钮，点了才生成。多几个标记不花钱。',
  },
  // auto 的后果行由 autoConsequence 拼（要带上当前限额），这里留空
  { key: 'auto', label: '自动', hint: '' },
];

/** auto 那一行的后果说明 —— 数字取当前设置，不写死 */
const autoConsequence = computed(
  () =>
    `剧情里出现值得配图的时刻就自动生成。每条消息最多 ${s.imageMaxPerMessage} 张、` +
    `每小时最多 ${s.imageMaxPerHour} 张，超出的会降级成按钮等你点。`,
);

/** 首次切到 auto 的一次性确认（D44）。已确认过的档位切换不再打断 */
const confirmAutoOpen = ref(false);

function selectMode(mode: ImageGenMode) {
  if (mode === 'auto' && !s.imageAutoConfirmed) {
    confirmAutoOpen.value = true;
    return;
  }
  s.imageGenMode = mode;
}

function confirmAuto() {
  s.imageAutoConfirmed = true;
  s.imageGenMode = 'auto';
  confirmAutoOpen.value = false;
}

// ═══ 端点（apiType: 'image'）═══

const imageEndpoints = computed<ApiEntry[]>(() =>
  s.apiPool.filter((entry) => entry.apiType === 'image'),
);

// ═══ 免费额度指示（D43 / §11.2）═══

/** v1 的 `n_samples` 恒为 1（D9）；写成常量而不是字面量，是为了让这条依赖看得见 */
const N_SAMPLES = 1;

const anlas = computed(() =>
  estimateAnlasCost(s.imageWidth, s.imageHeight, s.imageSteps, N_SAMPLES),
);

/** 三支互斥：算不出来 / 免费 / 收费。**不知道**永远不渲染成**免费** */
const anlasState = computed<'unknown' | 'free' | 'billed'>(() => {
  if (anlas.value.breaches.includes('invalid-input')) return 'unknown';
  return anlas.value.verdict === 'within-free-allowance' ? 'free' : 'billed';
});

// ═══ rating 上限（D38：**上限**而非默认）═══

const RATINGS: { key: ImageRating; label: string }[] = [
  { key: 'general', label: 'general — 全年龄' },
  { key: 'sensitive', label: 'sensitive — 轻度暴露' },
  { key: 'questionable', label: 'questionable — 明显性暗示' },
  { key: 'explicit', label: 'explicit — 露骨' },
];
</script>

<template>
  <AppCard padding="md">
    <div class="image-card-head">
      <h4>出图</h4>
      <p class="image-card-scope">
        这里配的是<strong>发给 NovelAI 的那次请求</strong>：什么时候出图、用哪个端点、
        画多大、以及每张图都带上的画质词与负向词。
      </p>
    </div>

    <!-- ════ 三档开关 ════ -->
    <div class="mode-list" role="radiogroup" aria-label="出图档位">
      <button
        v-for="m in MODES"
        :key="m.key"
        class="mode-item"
        :class="{ 'mode-active': s.imageGenMode === m.key }"
        role="radio"
        :aria-checked="s.imageGenMode === m.key"
        @click="selectMode(m.key)"
      >
        <span class="mode-label">{{ m.label }}</span>
        <span class="mode-hint">{{ m.key === 'auto' ? autoConsequence : m.hint }}</span>
      </button>
    </div>

    <!-- ════ 端点与模型 ════ -->
    <div class="form-grid image-grid">
      <label class="form-label"
        >图像端点
        <p class="form-hint">在「API 配置」里把类型设为「图像生成」的那些端点会出现在这里</p>
        <select v-model="s.imageEndpointId" class="form-input">
          <option :value="null">（未选择）</option>
          <option v-for="ep in imageEndpoints" :key="ep.id" :value="ep.id">{{ ep.name }}</option>
        </select></label
      >
      <label class="form-label"
        >NAI 模型
        <p class="form-hint">出图模型 id，不是 LLM 模型</p>
        <input v-model="s.imageModel" class="form-input" spellcheck="false"
      /></label>
      <label class="form-label"
        >宽（px）
        <input v-model.number="s.imageWidth" type="number" min="64" step="64" class="form-input"
      /></label>
      <label class="form-label"
        >高（px）
        <input v-model.number="s.imageHeight" type="number" min="64" step="64" class="form-input"
      /></label>
      <label class="form-label"
        >步数
        <input v-model.number="s.imageSteps" type="number" min="1" max="50" class="form-input"
      /></label>
      <label class="form-label"
        >CFG scale
        <input
          v-model.number="s.imageScale"
          type="number"
          min="1"
          max="10"
          step="0.1"
          class="form-input"
      /></label>
      <label class="form-label"
        >采样器 <input v-model="s.imageSampler" class="form-input" spellcheck="false"
      /></label>
      <label class="form-label"
        >噪声调度 <input v-model="s.imageNoiseSchedule" class="form-input" spellcheck="false"
      /></label>
      <label class="form-label"
        >UC 预设编号
        <p class="form-hint">按录制值原样发；负向文本由下面的全局负向拿着</p>
        <input v-model.number="s.imageUcPreset" type="number" min="0" class="form-input"
      /></label>
    </div>

    <!-- ════ 免费额度指示（§11.2）════ -->
    <p
      class="anlas-line"
      :class="{
        'anlas-free': anlasState === 'free',
        'anlas-billed': anlasState === 'billed',
        'anlas-unknown': anlasState === 'unknown',
      }"
    >
      <template v-if="anlasState === 'free'">
        按当前订阅规则估算，这组参数在免费额度内，不消耗 Anlas。
      </template>
      <template v-else-if="anlasState === 'billed'">
        按当前订阅规则估算，这组参数会消耗 Anlas（约 {{ anlas.anlasPerSample }} 点/张）。
      </template>
      <template v-else> 宽 / 高 / 步数需要是正整数，现在算不出这组参数会不会消耗 Anlas。 </template>
    </p>
    <p class="form-hint anlas-ruleset">{{ anlas.rulesetLabel }} · 估算值，不是账单承诺</p>

    <!-- ════ 图的提示词（≠ Agent 的提示词）════ -->
    <div class="prompt-block">
      <label class="form-label"
        >画质后缀
        <p class="form-hint">
          追加在每一张图的正向提示词<strong>末尾</strong>（顺序即权重）。不要写前导逗号 ——
          各段由引擎用「, 」连接。
        </p>
        <textarea
          v-model="s.imageQualitySuffix"
          class="form-input form-textarea"
          rows="2"
        ></textarea>
      </label>
      <label class="form-label"
        >全局负向（基础）
        <p class="form-hint">每一张图都带上。只写画质与解剖类缺陷，分级由下面的上限管</p>
        <textarea
          v-model="s.imageBaseNegative"
          class="form-input form-textarea"
          rows="3"
        ></textarea>
      </label>
      <label class="form-label"
        >全局负向（我的追加）
        <p class="form-hint">拼在基础负向之后，留空即不追加</p>
        <textarea
          v-model="s.imageExtraNegative"
          class="form-input form-textarea"
          rows="2"
        ></textarea>
      </label>
    </div>

    <!-- ════ 分级上限与显示 ════ -->
    <div class="form-grid image-grid">
      <label class="form-label"
        >内容分级上限
        <p class="form-hint">这是<strong>上限</strong>：正文标记里写得更高会被钳到这里</p>
        <select v-model="s.imageMaxRating" class="form-input">
          <option v-for="r in RATINGS" :key="r.key" :value="r.key">{{ r.label }}</option>
        </select></label
      >
      <label class="form-label"
        >每条消息最多几张
        <p class="form-hint">自动与手动都计入</p>
        <input
          v-model.number="s.imageMaxPerMessage"
          type="number"
          min="1"
          max="10"
          class="form-input"
      /></label>
      <label class="form-label"
        >每小时最多几张
        <p class="form-hint">失效保护：挡的是回退重发风暴与意外循环</p>
        <input
          v-model.number="s.imageMaxPerHour"
          type="number"
          min="1"
          max="200"
          class="form-input"
      /></label>
    </div>

    <label class="toggle-row">
      <span class="toggle-text">
        正文里的插画默认打码
        <span class="form-hint">点一下才揭示；不做硬屏蔽，随时可以自己看</span>
      </span>
      <span class="toggle-label">
        <input v-model="s.imageBlurByDefault" type="checkbox" class="toggle-input" />
        <span class="toggle-slider"></span>
      </span>
    </label>

    <!-- 首次切到自动档的一次性确认（D44）。留在卡内层，AppModal 自己 Teleport -->
    <AppModal
      :open="confirmAutoOpen"
      title="切换到自动出图？"
      size="sm"
      @update:open="confirmAutoOpen = $event"
    >
      <p class="confirm-text">
        自动档会在<strong>无人值守</strong>的情况下花钱：剧情推进时引擎自己决定要不要出图。
      </p>
      <p class="confirm-text">{{ autoConsequence }}</p>
      <p class="confirm-text text-muted">这条提示只出现这一次，之后可以随时切回手动。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="confirmAutoOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmAuto">我知道，开自动</AppButton>
      </template>
    </AppModal>
  </AppCard>
</template>

<style scoped src="../settings-chrome.css"></style>

<style scoped>
.image-card-head {
  margin-bottom: var(--theme-spacing-lg);
}
.image-card-head h4 {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.05rem;
  color: var(--theme-text-primary);
  margin: 0 0 var(--theme-spacing-xs);
}
.image-card-head h4::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.image-card-scope {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--theme-text-muted);
}

/* 三档开关 —— 每一项都带自己的后果行，所以是块级按钮而不是一排 radio */
.mode-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-lg);
}
.mode-item {
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
.mode-item:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.mode-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.mode-label {
  font-size: 0.9rem;
  font-weight: 600;
}
.mode-active .mode-label {
  color: var(--theme-primary);
}
.mode-hint {
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}

.image-grid {
  margin-bottom: var(--theme-spacing-md);
}

/* 免费额度指示 */
.anlas-line {
  margin: 0 0 var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-size: 0.82rem;
  line-height: 1.5;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.anlas-free {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border-color: color-mix(in srgb, var(--theme-success) 30%, transparent);
}
.anlas-billed {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border-color: color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.anlas-unknown {
  background: color-mix(in srgb, var(--theme-text-muted) 8%, transparent);
  color: var(--theme-text-muted);
}
.anlas-ruleset {
  margin: 0 0 var(--theme-spacing-lg);
}

.prompt-block {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  margin-bottom: var(--theme-spacing-lg);
}
.toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.85rem;
  color: var(--theme-text-secondary);
}
.confirm-text {
  margin: 0 0 var(--theme-spacing-md);
  font-size: 0.85rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}
</style>
