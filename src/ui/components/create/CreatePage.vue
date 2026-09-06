<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useCreateStore } from '../../stores/create-store';
import { useUIStore } from '../../stores/ui-store';
import CreateSteps from './CreateSteps.vue';
import CreateFooter from './CreateFooter.vue';
import PointsBar from './PointsBar.vue';
import AppButton from '../shared/AppButton.vue';
import ContentStatusBanner from '../shared/ContentStatusBanner.vue';
import { useSettingsStore } from '../../stores/settings-store';
import { useContentStore } from '../../stores/content-store';
import { checkJourneyReadiness } from '../../lib/journey-readiness';
import PresetModal from './PresetModal.vue';

const store = useCreateStore();
const ui = useUIStore();
const settings = useSettingsStore();
const content = useContentStore();
const checking = ref(true);
const checkError = ref('');
const creationError = ref('');
const accepted = ref(false);
const issues = computed(() =>
  checkJourneyReadiness(settings.settings, settings.projectAgentDefaults.agents, store.plotMode),
);
const blocked = computed(
  () =>
    checking.value ||
    !!checkError.value ||
    store.contentStatus !== 'ready' ||
    issues.value.some((issue) => issue.blocking),
);
const ready = computed(() => accepted.value && !blocked.value);

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
      ui.navigate('game', saveId);
    } catch (err) {
      console.error('[CreatePage] 创建存档失败:', err);
      creationError.value = '创建未完成，未保存新旅程。你的填写仍在，请重试。';
    }
  } else {
    store.nextStep();
  }
}

onMounted(() => {
  void checkReadiness();
});
</script>

<template>
  <div class="create-page">
    <button
      class="back-btn"
      title="返回首页"
      :disabled="store.isCreating"
      @click="ui.navigate('home')"
    >
      ← 首页
    </button>

    <CreateSteps v-if="ready" :current="store.currentStep" :total="8" />

    <PointsBar
      v-if="ready"
      :total="store.reincarnationPoints"
      :used="store.totalCost"
      :difficulty-label="store.difficulty?.label"
    />

    <main class="create-content" :aria-busy="checking || store.isCreating">
      <section v-if="!ready" class="readiness" aria-labelledby="readiness-title">
        <h1 id="readiness-title">启程前的准备</h1>
        <p>先确认内容与对话模型，再开始创建角色。</p>
        <ContentStatusBanner />
        <p v-if="checking" role="status">正在检查本机配置…</p>
        <template v-else>
          <p v-if="checkError" role="alert">{{ checkError }}</p>
          <p v-if="store.contentStatus !== 'ready'" role="alert">
            没有可用的角色内容目录，请先导入内容包。
          </p>
          <ul v-if="issues.length" class="readiness-issues">
            <li v-for="issue in issues" :key="issue.message">
              <span>{{ issue.blocking ? '需要处理：' : '可选配置：' }}{{ issue.message }}</span>
              <AppButton variant="secondary" size="sm" @click="ui.openSettings(issue.section)">
                {{ issue.section === 'api' ? '配置 API' : '配置 Agent' }}
              </AppButton>
            </li>
          </ul>
          <p v-else>对话配置已齐备。</p>
          <p class="readiness-note">
            此处只检查本机配置，不发送模型请求。密钥权限与连接可在 API
            设置中测试；实际生成可能产生费用。图像生成和额外的 Embedding 服务均为可选。
          </p>
        </template>
        <div class="readiness-actions">
          <AppButton :disabled="blocked" @click="accepted = true">{{
            content.contentStatus === 'placeholder' ? '使用演示内容创建角色' : '开始创建角色'
          }}</AppButton>
          <AppButton variant="secondary" :disabled="checking" @click="checkReadiness"
            >重新检查</AppButton
          >
          <AppButton variant="ghost" @click="ui.openSettings('api')">打开 API 设置</AppButton>
        </div>
      </section>
      <p v-if="creationError" class="creation-error" role="alert">{{ creationError }}</p>
      <!-- 内容加载门（D24）：三态。加载失败与「内容确实为空」在这里不可区分，
           也不必区分 —— 两者都是「没有可选内容」，画同一个空态。**不崩**。 -->
      <div
        v-if="ready && (store.contentStatus === 'loading' || store.contentStatus === 'idle')"
        class="content-gate"
      >
        正在加载内容目录…
      </div>
      <div
        v-else-if="ready && store.contentStatus === 'empty'"
        class="content-gate content-gate-empty"
      >
        <p class="gate-title">没有可用的内容目录</p>
        <p class="gate-desc">
          未能读取到起始装备、背景与出生地等内容。可在「创意工坊」安装内容包后重试。
        </p>
      </div>
      <Transition v-else-if="ready" name="step-fade" mode="out-in">
        <component :is="currentComponent" :key="store.currentStep" />
      </Transition>
    </main>

    <CreateFooter
      v-if="ready"
      :busy="store.isCreating"
      :can-prev="!store.isCreating && store.currentStep > 0"
      :can-next="!store.isCreating && (store.stepValid[store.currentStep] ?? true)"
      :next-label="nextLabel"
      @prev="store.prevStep"
      @next="handleNext"
      @open-preset="store.showPresetModal = true"
    />

    <PresetModal :visible="store.showPresetModal" @close="store.showPresetModal = false" />
  </div>
</template>

<style scoped>
.readiness {
  max-width: 44rem;
  margin: var(--theme-spacing-2xl) auto;
  padding: var(--theme-spacing-xl);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-primary);
  line-height: 1.6;
}
.readiness h1 {
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  margin-top: 0;
}
.readiness-issues {
  padding-left: var(--theme-spacing-xl);
}
.readiness-issues li {
  margin-block: var(--theme-spacing-lg);
}
.readiness-issues span {
  display: block;
  margin-bottom: var(--theme-spacing-sm);
}
.readiness-note {
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
}
.readiness-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
  margin-top: var(--theme-spacing-xl);
}
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
