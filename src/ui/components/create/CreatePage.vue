<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import { useUIStore } from '../../stores/ui-store';
import CreateSteps from './CreateSteps.vue';
import CreateFooter from './CreateFooter.vue';
import PointsBar from './PointsBar.vue';
import PresetModal from './PresetModal.vue';

const store = useCreateStore();
const ui = useUIStore();

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

const nextLabel = computed(() => (store.currentStep === 7 ? '✦ 开始命运之旅 ✦' : '下一步 →'));

// Step 7 特殊处理: 点击"下一步" → 执行 startJourney
async function handleNext() {
  if (store.currentStep === 7) {
    try {
      const saveId = await store.startJourney();
      ui.navigate('game', saveId);
    } catch (err) {
      console.error('[CreatePage] 创建存档失败:', err);
    }
  } else {
    store.nextStep();
  }
}

onMounted(() => {
  // 🔴 整页内容加载门（D16/D24）：七个池住在内容注册表里，不再编译进 bundle。
  //    先 await 它再让步骤组件渲染，否则第一帧的下拉/列表全是空的，
  //    用户会以为「这台机器上没有内容」。`initContent` 幂等且永不抛。
  void store.initContent();
  store.loadWorldBookEntries();
});
</script>

<template>
  <div class="create-page">
    <button class="back-btn" title="返回首页" @click="ui.navigate('home')">← 首页</button>

    <CreateSteps :current="store.currentStep" :total="8" />

    <PointsBar
      :total="store.reincarnationPoints"
      :used="store.totalCost"
      :difficulty-label="store.difficulty?.label"
    />

    <main class="create-content">
      <!-- 内容加载门（D24）：三态。加载失败与「内容确实为空」在这里不可区分，
           也不必区分 —— 两者都是「没有可选内容」，画同一个空态。**不崩**。 -->
      <div
        v-if="store.contentStatus === 'loading' || store.contentStatus === 'idle'"
        class="content-gate"
      >
        正在加载内容目录…
      </div>
      <div v-else-if="store.contentStatus === 'empty'" class="content-gate content-gate-empty">
        <p class="gate-title">没有可用的内容目录</p>
        <p class="gate-desc">
          未能读取到起始装备、背景与出生地等内容。可在「创意工坊」安装内容包后重试。
        </p>
      </div>
      <Transition v-else name="step-fade" mode="out-in">
        <component :is="currentComponent" :key="store.currentStep" />
      </Transition>
    </main>

    <CreateFooter
      :can-prev="store.currentStep > 0"
      :can-next="store.stepValid[store.currentStep] ?? true"
      :next-label="nextLabel"
      @prev="store.prevStep"
      @next="handleNext"
      @open-preset="store.showPresetModal = true"
    />

    <PresetModal :visible="store.showPresetModal" @close="store.showPresetModal = false" />
  </div>
</template>

<style scoped>
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

/* 内容加载门（D24）—— 空态照 design.md §5.2：居中、克制、给下一步动作 */
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
.content-gate .gate-title {
  margin: 0;
  font-family: var(--theme-font-title, serif);
  font-size: 1rem;
  color: var(--theme-text-secondary);
}
.content-gate .gate-desc {
  margin: 0;
  max-width: 30rem;
  line-height: 1.6;
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
