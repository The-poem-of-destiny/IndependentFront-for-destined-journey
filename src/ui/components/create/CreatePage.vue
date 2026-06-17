<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useCreateStore } from '../../stores/create-store'
import CreateSteps from './CreateSteps.vue'
import CreateFooter from './CreateFooter.vue'
import PointsBar from './PointsBar.vue'
import PresetModal from './PresetModal.vue'

const store = useCreateStore()

// 懒加载步骤组件
const Step0 = defineAsyncComponent(() => import('./CreateStepDifficulty.vue'))
const Step1 = defineAsyncComponent(() => import('./CreateStepBasic.vue'))
const Step2 = defineAsyncComponent(() => import('./CreateStepDestinyCore.vue'))
const Step3 = defineAsyncComponent(() => import('./CreateStepSelections.vue'))
const Step4 = defineAsyncComponent(() => import('./CreateStepBackground.vue'))
const Step5 = defineAsyncComponent(() => import('./CreateStepPlot.vue'))
const Step6 = defineAsyncComponent(() => import('./CreateStepConfirm.vue'))

const stepComponents = [Step0, Step1, Step2, Step3, Step4, Step5, Step6] as const

const currentComponent = computed(() => stepComponents[store.currentStep])

const nextLabel = computed(() =>
  store.currentStep === 6 ? '✦ 开始命运之旅 ✦' : '下一步 →'
)

// Step 6 特殊处理: 点击"下一步" → 执行 startJourney
async function handleNext() {
  if (store.currentStep === 6) {
    try {
      const saveId = await store.startJourney()
      const { router } = await import('../../router')
      router.push(`/game/${saveId}`)
    } catch (err) {
      console.error('[CreatePage] 创建存档失败:', err)
    }
  } else {
    store.nextStep()
  }
}
</script>

<template>
  <div class="create-page">
    <CreateSteps :current="store.currentStep" :total="7" />

    <PointsBar
      :total="store.reincarnationPoints"
      :used="store.totalCost"
      :difficulty-label="store.difficulty?.label"
    />

    <main class="create-content">
      <Suspense>
        <component :is="currentComponent" />
        <template #fallback>
          <div class="step-loading">加载中…</div>
        </template>
      </Suspense>
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
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--theme-bg-primary);
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
</style>
