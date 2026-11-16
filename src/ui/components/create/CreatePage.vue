<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, ref, watch } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import { useUIStore } from '../../stores/ui-store';
import CreateSteps from './CreateSteps.vue';
import CreateFooter from './CreateFooter.vue';
import PointsBar from './PointsBar.vue';
import CreateReadiness from './CreateReadiness.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useContentStore } from '../../stores/content-store';
import { checkJourneyReadiness } from '../../lib/journey-readiness';
import PresetModal from './PresetModal.vue';
import { initializeCachedDirectSettings } from '../../lib/direct-settings';
import { MISSING_FIELDS_PREFIX, type BlockedHint } from '../../lib/create-options';
import { confirmDialog } from '../../lib/confirm-dialog';

const store = useCreateStore();
const ui = useUIStore();
const settings = useSettingsStore();
const content = useContentStore();
const checking = ref(true);
const checkError = ref('');
const creationError = ref('');
const accepted = ref(false);
const issues = computed(() =>
  checkJourneyReadiness(
    settings.settings,
    settings.projectAgentDefaults.agents,
    store.plotMode,
    store.generationMode,
  ),
);
const blocked = computed(
  () =>
    !store.generationMode ||
    checking.value ||
    !!checkError.value ||
    store.contentStatus !== 'ready' ||
    issues.value.some((issue) => issue.blocking),
);
const ready = computed(() => accepted.value && !blocked.value);

/** 步骤内容的滚动容器：切步骤后要回到顶部，否则新步骤的必填项可能落在视野外 */
const contentRef = ref<HTMLElement | null>(null);
function resetContentScroll() {
  if (contentRef.value) contentRef.value.scrollTop = 0;
}
// 准入页滚到底再点「开始创建角色」时，第 1 步会沿用准入页的滚动位置；进入后复位一次。
// 步骤之间的复位挂在 <Transition> 的 after-leave 上（旧内容淡出完再跳，不在淡出中途闪动）。
watch(ready, (isReady) => {
  if (isReady) void nextTick(resetContentScroll);
});

async function checkReadiness() {
  checking.value = true;
  checkError.value = '';
  try {
    const result = await settings.initApiSecrets();
    if (result.status === 'failed') throw new Error('API 配置未能加载，请到 API 设置重试。');
    await Promise.all([
      store.initContent(true),
      settings.loadAgentProjectDefaults(),
      store.loadWorldBookEntries(),
    ]);
    initializeCachedDirectSettings(settings.settings, settings.projectAgentDefaults.agents);
  } catch {
    checkError.value = '配置未能加载，请重新检查；若仍失败，请打开 API 设置。';
  } finally {
    checking.value = false;
  }
}

// 懒加载步骤组件
const Step0 = defineAsyncComponent(() => import('./CreateStepDifficulty.vue'));
const Step1 = defineAsyncComponent(() => import('./CreateStepBasic.vue'));
const Step2 = defineAsyncComponent(() => import('./CreateStepDestinyCore.vue'));
const Step3 = defineAsyncComponent(() => import('./CreateStepCharacters.vue'));
const Step4 = defineAsyncComponent(() => import('./CreateStepSelections.vue'));
const Step5 = defineAsyncComponent(() => import('./CreateStepBackground.vue'));
const Step6 = defineAsyncComponent(() => import('./CreateStepPlot.vue'));
const Step7 = defineAsyncComponent(() => import('./CreateStepConfirm.vue'));

const stepComponents = [Step0, Step1, Step2, Step3, Step4, Step5, Step6, Step7] as const;

const currentComponent = computed(() => stepComponents[store.currentStep]);

const nextLabel = computed(() =>
  store.isCreating ? '正在创建…' : store.currentStep === 7 ? '✦ 开始命运之旅 ✦' : '下一步 →',
);

// Step 7 特殊处理: 点击"下一步" → 执行 startJourney
async function handleNext() {
  if (store.isCreating || !ready.value) return;
  creationError.value = '';
  if (store.currentStep === 7) {
    try {
      const saveId = await store.startJourney();
      // 建档成功即清空草稿（含步骤、选择、大纲与生成模式）：否则回首页再点「新建存档」
      // 会直接落在第 8 步、上一个角色完整有效，一键就建出重复存档。
      // 只在成功后重置 —— 经「← 返回」离开而未建档时草稿保留是有意为之。
      store.resetAll();
      ui.navigate('game', saveId);
    } catch (err) {
      console.error('[CreatePage] 创建存档失败:', err);
      // 必填项缺失：store 已跳回第一个缺项的步骤，这里把缺什么原样告诉玩家
      creationError.value = isMissingFieldsError(err)
        ? `${err.message}。已跳转到需要补全的步骤。`
        : '创建未完成，未保存新旅程。你的填写仍在，请重试。';
    }
  } else {
    store.nextStep();
  }
}

/** persistJourney 的必填校验失败（消息以固定前缀开头），区别于落库等其他失败 */
function isMissingFieldsError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(MISSING_FIELDS_PREFIX);
}

/** 当前步骤下一步按钮被禁用的原因（仅必填步骤有）；缺项带所属步骤供页脚跳转 */
const blockedHint = computed<BlockedHint | null>(() => {
  if (store.isCreating) return null;
  const step = store.currentStep;
  // 最后一步用 store 的聚合清单（含「转生点数超支」，C-06），与 persistJourney 同一道闸门
  const items: BlockedHint['items'] =
    step === 7
      ? store.missingItems
      : (store.stepMissing[step] ?? []).map((label: string) => ({ label, step }));
  if (items.length === 0) return null;
  return {
    prefix: step === 7 ? '开始旅程前还需补全：' : '还需完成：',
    currentStep: step,
    items,
  };
});

/**
 * 「重新开始」（H-04 / C-12）：草稿现在会跨刷新保留，放弃的角色必须有一个明确的丢弃入口。
 * 清空后回到准备页（生成模式也一并清掉），命定核心名单随 resetAll 清空，这里重新加载。
 */
async function handleRestart() {
  if (store.isCreating) return;
  const confirmed = await confirmDialog({
    title: '重新开始创建角色？',
    message: '当前填写的角色草稿会被清空，且无法恢复。',
    details: [
      '难度、生成模式、角色信息与属性分配',
      '已选装备、道具、技能与背景',
      '命定核心与剧情设置、已生成的大纲',
    ],
    confirmLabel: '清空并重新开始',
    danger: true,
  });
  if (!confirmed) return;
  creationError.value = '';
  store.resetAll();
  void store.loadWorldBookEntries();
}

function handleStepSelect(step: number) {
  if (store.isCreating || step < 0 || step >= stepComponents.length) return;
  store.currentStep = step;
}

onMounted(() => {
  void checkReadiness();
});
</script>

<template>
  <div class="create-page">
    <!-- 原路返回：从游戏内开新档时取消应回到游戏页，而不是首页（UIL-05） -->
    <button
      class="back-btn"
      title="返回上一页"
      :disabled="store.isCreating"
      @click="ui.back('home')"
    >
      ← 返回
    </button>

    <CreateSteps
      v-if="ready"
      :current="store.currentStep"
      :total="8"
      :disabled="store.isCreating"
      @select="handleStepSelect"
    />

    <PointsBar
      v-if="ready"
      :total="store.reincarnationPoints"
      :used="store.totalCost"
      :difficulty-label="store.difficulty?.label"
    />

    <main ref="contentRef" class="create-content" :aria-busy="checking || store.isCreating">
      <CreateReadiness
        v-if="!ready"
        v-model:generation-mode="store.generationMode"
        :issues="issues"
        :checking="checking"
        :check-error="checkError"
        :catalog-status="store.contentStatus"
        :content-source="content.contentStatus"
        :blocked="blocked"
        @accept="accepted = true"
        @recheck="checkReadiness"
        @open-settings="ui.openSettings"
      />
      <p v-if="creationError" class="creation-error" role="alert">{{ creationError }}</p>
      <!-- 内容加载门（D24）：三态。加载失败与「内容确实为空」在这里不可区分，
           也不必区分 —— 两者都是「没有可选内容」，画同一个空态。**不崩**。 -->
      <div
        v-if="ready && (store.contentStatus === 'loading' || store.contentStatus === 'idle')"
        class="content-gate"
      >
        正在加载内容目录…
      </div>
      <Transition
        v-else-if="ready"
        name="step-fade"
        mode="out-in"
        @after-leave="resetContentScroll"
      >
        <component :is="currentComponent" :key="store.currentStep" />
      </Transition>
    </main>

    <CreateFooter
      v-if="ready"
      :busy="store.isCreating"
      :can-prev="!store.isCreating && store.currentStep > 0"
      :can-next="!store.isCreating && (store.stepValid[store.currentStep] ?? true)"
      :next-label="nextLabel"
      :blocked="blockedHint"
      @prev="store.prevStep"
      @jump="handleStepSelect"
      @next="handleNext"
      @open-preset="store.showPresetModal = true"
      @restart="handleRestart"
    />

    <PresetModal :visible="store.showPresetModal" @close="store.showPresetModal = false" />
  </div>
</template>

<style scoped>
.creation-error {
  color: var(--theme-error);
}

.create-page {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--theme-window-bg);
}
.back-btn {
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 10;
  padding: 4px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.back-btn:hover {
  border-color: var(--theme-primary);
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
.create-content {
  flex: 1;
  overflow-y: auto;
  max-width: 70rem;
  margin: 0 auto;
  width: 100%;
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
  padding-bottom: calc(var(--theme-spacing-lg) + env(safe-area-inset-bottom, 20px));
}
.step-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--theme-text-muted);
  font-size: 1rem;
}

/* 内容加载门（D24）—— 加载态居中、克制 */
.content-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-xs);
  height: 100%;
  min-height: 12rem;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  text-align: center;
}
/* 步骤切换动画 */
.step-fade-enter-active,
.step-fade-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.step-fade-enter-from {
  opacity: 0;
  transform: translateY(12px);
}
.step-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
