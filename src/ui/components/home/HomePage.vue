<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { VERSION } from '@engine/index';
import AppButton from '../shared/AppButton.vue';
import ContentStatusBanner from '../shared/ContentStatusBanner.vue';
import AstralDriftBackdrop from './AstralDriftBackdrop.vue';
import { useBranding } from '../../branding-defaults';
import { findLatestSave } from './latest-save';

const game = useGameStore();
const ui = useUIStore();
const backdropReady = ref(false);

/**
 * 扩展管理入口已开放（2026-08-20）。这个开关从来不是安全边界：入口关着的时候，
 * 已安装项目照样能在游戏页启用 —— 它只挡首页那一个按钮。
 *
 * 当前执行边界：**用户装过的**正则 replacement 在 opaque `sandbox="allow-scripts"` iframe
 * 中运行，可加载远程资源并调用网络 API，但拿不到父页面 DOM、Dexie、应用存储或 API Key；
 * 每个富命中独占一个 frame，未命中正文留在宿主原生文本面。模型输出合成的
 * `<item_info>` / `<task_info>` 卡片走收紧的一档：nonce-only `script-src` +
 * `connect-src 'none'`，不注入共享 `regexStorage`。世界书 EJS 由 QuickJS 隔离并
 * fail-closed。网络开启意味着规则仍可发送该命中的 replacement/capture，
 * 详见 `docs/reviews/2026-08-02-workshop-regex-compatibility.md`。
 */
const EXTENSION_ENTRY_ENABLED = true;

const savesLoaded = ref(false);
const latestSave = computed(() => findLatestSave(game.saves));
// === 品牌面（D26）===
// 标题 / 副标题 / 风味文字 / 制作人员署名与世界速览全部由内容包供给，
// 未装包时是 branding-defaults 的中性值。这里**不留任何硬编码文案兜底** ——
// 留一份就是第二套默认值，两处漂移之后没人说得清屏幕上那句是从哪来的。
const { branding } = useBranding();

// === 风味文字循环 ===
const quotes = computed(() => branding.value.subtitles);
const currentQuote = ref(0);
let quoteTimer: ReturnType<typeof setInterval> | null = null;

const showDevButton = ref(false);
// 🔒 P1-14: 快速测试按钮仅 DEV 构建显示 —— 生产构建不应有可清库/建测试存档的入口
const isDev = import.meta.env.DEV;

onMounted(async () => {
  await nextTick();
  document.body.classList.add('home-entered');
  // 加载存档列表
  try {
    await game.loadSaves();
  } catch {
    /* IndexedDB 可能未初始化 */
  } finally {
    savesLoaded.value = true;
  }
  // 风味文字循环。
  // 🔴 取模前先挡住空数组：内容包可以显式给 `subtitles: []`（刻意关掉轮播），
  //    `x % 0` 是 NaN，索引成 NaN 之后这一行永远渲染空白且再也回不来。
  quoteTimer = setInterval(() => {
    const n = quotes.value.length;
    currentQuote.value = n > 0 ? (currentQuote.value + 1) % n : 0;
  }, 5000);
});

onUnmounted(() => {
  if (quoteTimer) clearInterval(quoteTimer);
  document.body.classList.remove('home-entered');
});

function newGame() {
  ui.navigate('create');
}

function exitApp() {
  window.close();
}

function loadGame(saveId: string) {
  ui.navigate('game', saveId);
}

async function ensureSavesLoaded() {
  if (savesLoaded.value) return;
  try {
    await game.loadSaves();
  } catch {
    /* IndexedDB 不可用时按无存档处理 */
  } finally {
    savesLoaded.value = true;
  }
}

async function startOrContinue() {
  // 首页刚挂载时存档列表仍可能在读取中；点击不能因此误入新建流程。
  await ensureSavesLoaded();

  const save = latestSave.value;
  if (save) loadGame(save.id);
  else newGame();
}

// 🧪 开发用快速测试 (正式版移除)
// ⚠️ 会先清空**整个数据库** —— 素材库与音频库不随存档隔离，会一并没
async function quickTest() {
  const { createTestSave } = await import('../../utils/test-save');
  const saveId = await createTestSave();
  ui.navigate('game', saveId);
}

// 🧪 同一个测试存档，但一个字节都不清 —— 手动导入的素材/音乐留着
// (调渲染面时要的是"能进去的存档"，不是"把刚导入的图全删了")
async function quickTestKeep() {
  const { createTestSavePreservingData } = await import('../../utils/test-save');
  const saveId = await createTestSavePreservingData();
  ui.navigate('game', saveId);
}
</script>

<template>
  <div
    class="home-page"
    :class="{ 'has-astral-backdrop': backdropReady }"
    @mouseenter="showDevButton = true"
    @mouseleave="showDevButton = false"
  >
    <AstralDriftBackdrop @ready="backdropReady = $event" />
    <!-- 内容态横幅（波 1 T2 / §5.8）：占位 / 检测到本地真实内容 / error -->
    <ContentStatusBanner class="home-content-banner" />
    <!-- 装饰性背景光晕 -->
    <div class="bg-glow bg-glow-1" aria-hidden="true" />
    <div class="bg-glow bg-glow-2" aria-hidden="true" />

    <!-- 装饰性星点 -->
    <div class="stars" aria-hidden="true">
      <i
        v-for="i in 20"
        :key="i"
        class="star"
        :style="{
          left: `${Math.random() * 100}%`,
          top: `${Math.random() * 100}%`,
          '--delay': `${Math.random() * 6}s`,
          '--size': `${Math.random() * 2 + 1}px`,
          opacity: Math.random() * 0.5 + 0.2,
        }"
      />
    </div>

    <main class="home-stage-ui">
      <!-- 标题区域 -->
      <div class="title-section">
        <div class="title-frame">
          <div class="title-corner title-corner-tl" aria-hidden="true" />
          <div class="title-corner title-corner-tr" aria-hidden="true" />
          <div class="title-corner title-corner-bl" aria-hidden="true" />
          <div class="title-corner title-corner-br" aria-hidden="true" />

          <!--
          标题分行由 branding 供给（1-2 行都合法）。第一行套主色、其余行套次色，
          与原来「主 + 副」两行的视觉一致；只有一行时自然退化成单行主色。
        -->
          <h1 class="main-title">
            <span
              v-for="(line, i) in branding.titleLines"
              :key="i"
              :class="i === 0 ? 'title-line-t main-line' : 'title-line-b alt-line'"
              >{{ line }}</span
            >
          </h1>
        </div>

        <div class="title-divider">
          <span class="divider-diamond" aria-hidden="true" />
        </div>

        <p v-if="branding.tagline" class="sub-title">{{ branding.tagline }}</p>

        <!-- 风味文字（branding.subtitles 为空 = 内容包刻意关掉轮播，整块不渲染） -->
        <div v-if="quotes.length > 0" class="quote-container">
          <transition name="quote-fade" mode="out-in">
            <p :key="currentQuote" class="flavor-quote">「{{ quotes[currentQuote] }}」</p>
          </transition>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="action-section">
        <div class="btn-column">
          <AppButton
            variant="primary"
            size="lg"
            block
            class="btn-new-game"
            @click="startOrContinue"
          >
            {{ latestSave ? '✦ 继 续' : '✦ 新 建 存 档' }}
          </AppButton>
          <AppButton
            variant="secondary"
            size="lg"
            block
            class="btn-load"
            @click="ui.openSaveManager()"
          >
            <i class="btn-icon fa-solid fa-folder-tree" aria-hidden="true"></i>存 档 管 理
          </AppButton>
          <!-- 入口开关：见 script 里的 EXTENSION_ENTRY_ENABLED -->
          <AppButton
            v-if="EXTENSION_ENTRY_ENABLED"
            variant="secondary"
            size="lg"
            block
            class="btn-extensions"
            @click="ui.navigate('extensions')"
          >
            <i class="btn-icon fa-solid fa-puzzle-piece" aria-hidden="true"></i>扩 展 管 理
          </AppButton>
          <AppButton
            variant="secondary"
            size="lg"
            block
            class="btn-settings"
            @click="ui.openSettings()"
          >
            <i class="btn-icon fa-solid fa-gear" aria-hidden="true"></i>设 置
          </AppButton>
          <div class="btn-row">
            <AppButton
              variant="ghost"
              size="md"
              class="btn-ghost btn-about"
              @click="ui.openSettings('about')"
            >
              <i class="btn-icon fa-solid fa-circle-info" aria-hidden="true"></i>关 于
            </AppButton>
            <AppButton variant="ghost" size="md" class="btn-ghost btn-exit" @click="exitApp">
              <i class="btn-icon fa-solid fa-right-from-bracket" aria-hidden="true"></i>退 出
            </AppButton>
          </div>
          <!-- 🧪 开发用 — 悬停显示 -->
          <transition name="fade">
            <div v-if="showDevButton && isDev" class="dev-test-row">
              <AppButton
                variant="ghost"
                size="sm"
                class="dev-test-btn"
                title="清空整个数据库后重建测试存档 —— 素材库与音频库会一并清掉"
                @click="quickTest"
              >
                🧪 快速测试
              </AppButton>
              <AppButton
                variant="ghost"
                size="sm"
                class="dev-test-btn"
                title="创建测试存档，但不清任何数据 —— 已导入的素材与音乐保留"
                @click="quickTestKeep"
              >
                🧪 快速测试（保留数据）
              </AppButton>
            </div>
          </transition>
        </div>
      </div>
    </main>

    <!-- 底部信息 -->
    <footer class="home-footer">
      <span class="footer-version">v{{ VERSION }}</span>
      <span class="footer-dot" aria-hidden="true">·</span>
      <span class="footer-era">复兴纪元</span>
    </footer>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════
   首页 — 标题画面
   优雅的暗色奇幻风格
   ═══════════════════════════════════════ */
.home-page {
  --drift-column-center: 0.191;
  --drift-column-width: 0.242;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  min-height: 100vh;
  position: relative;
}
.home-content-banner {
  position: absolute;
  top: 0.75rem;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(90vw, 640px);
  z-index: 5;
}
.home-page {
  overflow-x: hidden;
  overflow-y: auto;
  background:
    radial-gradient(
      ellipse 80% 50% at 50% 25%,
      color-mix(in srgb, var(--theme-primary) 6%, transparent),
      transparent
    ),
    radial-gradient(
      ellipse 60% 40% at 30% 60%,
      color-mix(in srgb, var(--theme-quality-epic) 4%, transparent),
      transparent
    ),
    radial-gradient(
      ellipse 60% 40% at 70% 60%,
      color-mix(in srgb, var(--theme-quality-legendary) 3%, transparent),
      transparent
    ),
    var(--theme-window-bg);
}

.home-page.has-astral-backdrop .bg-glow,
.home-page.has-astral-backdrop .stars {
  display: none;
}

.home-stage-ui {
  position: relative;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: clamp(272px, 25vw, 348px);
  min-height: 100vh;
  margin-left: clamp(28px, 7vw, 108px);
  padding: var(--theme-spacing-2xl) 0 calc(var(--theme-spacing-2xl) * 2);
  text-align: center;
  user-select: none;
}

/* ═══ 装饰性光晕 ═══ */
.bg-glow {
  position: fixed;
  border-radius: 50%;
  pointer-events: none;
  z-index: 0;
  animation: glowDrift 12s ease-in-out infinite alternate;
}
.bg-glow-1 {
  width: 600px;
  height: 600px;
  top: -200px;
  left: 50%;
  transform: translateX(-50%);
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--theme-primary) 5%, transparent),
    transparent 70%
  );
}
.bg-glow-2 {
  width: 400px;
  height: 400px;
  bottom: -100px;
  right: -100px;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--theme-quality-epic) 4%, transparent),
    transparent 70%
  );
  animation-delay: -4s;
  animation-direction: alternate-reverse;
}
@keyframes glowDrift {
  0% {
    transform: translateX(-50%) translateY(0);
  }
  100% {
    transform: translateX(-50%) translateY(20px);
  }
}

/* ═══ 星点 ═══ */
.stars {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
}
.star {
  position: absolute;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  background: var(--theme-text-muted);
  animation: starPulse 4s ease-in-out var(--delay) infinite;
}
@keyframes starPulse {
  0%,
  100% {
    opacity: 0.2;
  }
  50% {
    opacity: 0.8;
  }
}

/* ═══ 标题区 ═══ */
.title-section {
  width: 100%;
  margin-top: 0;
  text-align: center;
  position: relative;
  z-index: 1;
}

/* 装饰性四角框架 */
.title-frame {
  position: relative;
  display: inline-block;
  padding: 1.2rem 2.4rem;
}
.title-corner {
  position: absolute;
  width: 24px;
  height: 24px;
  border-color: color-mix(in srgb, var(--theme-primary) 50%, transparent);
  border-style: solid;
  transition: border-color 0.8s ease;
}
.title-corner-tl {
  top: 0;
  left: 0;
  border-width: 2px 0 0 2px;
}
.title-corner-tr {
  top: 0;
  right: 0;
  border-width: 2px 2px 0 0;
}
.title-corner-bl {
  bottom: 0;
  left: 0;
  border-width: 0 0 2px 2px;
}
.title-corner-br {
  bottom: 0;
  right: 0;
  border-width: 0 2px 2px 0;
}

.main-title {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  margin: 0;
  animation: titleEnter 1s ease-out;
}
.main-line {
  font-family: var(--theme-font-title);
  font-size: clamp(1.9rem, 3.1vw, 2.7rem);
  font-weight: 700;
  color: var(--theme-text-primary);
  letter-spacing: 6px;
  text-shadow:
    0 0 40px color-mix(in srgb, var(--theme-primary) 35%, transparent),
    0 0 80px color-mix(in srgb, var(--theme-primary) 15%, transparent);
  line-height: 1.3;
}
.alt-line {
  font-family: var(--theme-font-display);
  font-size: clamp(0.85rem, 1.2vw, 1.05rem);
  font-weight: 400;
  letter-spacing: 8px;
  color: var(--theme-text-secondary);
  text-shadow: 0 0 30px color-mix(in srgb, var(--theme-quality-legendary) 25%, transparent);
}

@keyframes titleEnter {
  from {
    opacity: 0;
    transform: translateY(-30px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

/* ═══ 标题分割线 ═══ */
.title-divider {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 20px auto;
  width: 200px;
  position: relative;
}
.title-divider::before,
.title-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--theme-primary) 40%, transparent)
  );
}
.title-divider::after {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--theme-primary) 40%, transparent),
    transparent
  );
}
.divider-diamond {
  width: 8px;
  height: 8px;
  margin: 0 16px;
  background: var(--theme-primary);
  transform: rotate(45deg);
  opacity: 0.6;
  flex-shrink: 0;
}

/* ═══ 副标题 ═══ */
.sub-title {
  font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
  font-size: 1rem;
  color: var(--theme-text-muted);
  letter-spacing: 4px;
  margin: 0 0 6px;
  font-weight: 400;
  animation: subEnter 0.8s ease-out 0.2s both;
}
@keyframes subEnter {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* ═══ 风味文字 ═══ */
.quote-container {
  min-height: 2rem;
  margin-top: 16px;
  animation: quoteEnter 0.8s ease-out 0.4s both;
}
@keyframes quoteEnter {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.flavor-quote {
  font-family: 'KaiTi', 'STKaiti', '楷体', var(--theme-font-body);
  font-size: 0.95rem;
  color: var(--theme-text-muted);
  font-style: italic;
  margin: 0;
  letter-spacing: 1px;
}
.quote-fade-enter-active,
.quote-fade-leave-active {
  transition: opacity 0.8s ease;
}
.quote-fade-enter-from,
.quote-fade-leave-to {
  opacity: 0;
}

/* ═══ 按钮区 ═══ */
.action-section {
  width: 100%;
  margin-top: 2.2rem;
  position: relative;
  z-index: 1;
  animation: btnsEnter 0.8s ease-out 0.5s both;
}
@keyframes btnsEnter {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.btn-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.btn-new-game {
  box-shadow: 0 0 24px color-mix(in srgb, var(--theme-primary) 30%, transparent);
  transition:
    transform 0.2s ease,
    box-shadow 0.3s ease;
  letter-spacing: 3px;
}
.btn-new-game:hover {
  transform: translateY(-2px);
  box-shadow:
    0 0 40px color-mix(in srgb, var(--theme-primary) 50%, transparent),
    0 6px 20px color-mix(in srgb, #000 30%, transparent);
}
.btn-new-game:active {
  transform: translateY(0);
}

.btn-load,
.btn-extensions,
.btn-settings {
  background: color-mix(in srgb, var(--theme-card-bg) 82%, transparent);
  border-color: var(--theme-card-border);
  color: var(--theme-text-primary);
  backdrop-filter: blur(6px);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}
.btn-load:hover,
.btn-extensions:hover,
.btn-settings:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 25%, transparent);
}

.btn-ghost {
  background: color-mix(in srgb, var(--theme-card-bg) 55%, transparent);
  border-color: transparent;
  color: var(--theme-text-primary);
  backdrop-filter: blur(7px);
  transition: transform 0.2s ease;
}
.btn-ghost:hover {
  background: color-mix(in srgb, var(--theme-card-bg) 78%, transparent);
  border-color: color-mix(in srgb, var(--theme-primary) 34%, transparent);
  transform: translateY(-1px);
}

.btn-icon {
  font-size: 1.1em;
  margin-right: 4px;
}

.btn-row {
  display: flex;
  gap: 12px;
  width: 100%;
}
.btn-row > * {
  flex: 1;
}

/* Dev 按钮 */
/* 两个开发按钮并排；窄屏换行，不挤出容器 */
.dev-test-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--theme-spacing-xs, 4px);
}
.dev-test-btn {
  opacity: 0.5;
  font-size: 0.75rem;
  transition: opacity 0.2s;
  margin-top: 4px;
}
@media (prefers-reduced-motion: reduce) {
  .dev-test-btn {
    transition: none;
  }
}
.dev-test-btn:hover {
  opacity: 1;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ═══ 底部 ═══ */
.home-footer {
  position: fixed;
  bottom: var(--theme-spacing-lg);
  left: clamp(28px, 7vw, 108px);
  z-index: 2;
  justify-content: center;
  width: clamp(272px, 25vw, 348px);
  margin: 0;
  padding: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  opacity: 0.4;
  display: flex;
  gap: 8px;
  align-items: center;
  letter-spacing: 1px;
}
.footer-dot {
  opacity: 0.3;
}

@media (max-aspect-ratio: 23/20) {
  .home-page {
    --drift-column-center: 0.5;
    --drift-column-width: 0.88;
  }

  .home-stage-ui {
    justify-content: flex-start;
    width: min(88vw, 380px);
    min-height: 100vh;
    margin: 0 auto;
    padding-top: 6vh;
  }

  .title-frame {
    padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
  }

  .action-section {
    margin-top: var(--theme-spacing-xl);
  }

  .home-footer {
    left: 50%;
    width: min(88vw, 380px);
    transform: translateX(-50%);
  }
}

@media (max-height: 760px) and (min-aspect-ratio: 23/20) {
  .home-stage-ui {
    justify-content: flex-start;
    padding-top: calc(var(--theme-spacing-2xl) * 2);
  }

  .title-frame {
    padding-top: var(--theme-spacing-md);
    padding-bottom: var(--theme-spacing-md);
  }

  .title-divider {
    margin-top: var(--theme-spacing-md);
    margin-bottom: var(--theme-spacing-md);
  }

  .action-section {
    margin-top: var(--theme-spacing-lg);
  }
}

/* ═══ 无障碍：减弱动效 ═══ */
@media (prefers-reduced-motion: reduce) {
  .bg-glow,
  .star,
  .main-title,
  .sub-title,
  .quote-container,
  .action-section {
    animation: none;
  }
  .quote-fade-enter-active,
  .quote-fade-leave-active,
  .fade-enter-active,
  .fade-leave-active {
    transition: none;
  }
  .btn-new-game,
  .btn-load,
  .btn-extensions,
  .btn-settings,
  .btn-ghost {
    transition: none;
  }
  .btn-new-game:hover,
  .btn-load:hover,
  .btn-extensions:hover,
  .btn-settings:hover,
  .btn-ghost:hover {
    transform: none;
  }
}

/* ═══ 滚动条美化 ═══ */
.home-page::-webkit-scrollbar {
  width: 6px;
}
.home-page::-webkit-scrollbar-track {
  background: transparent;
}
.home-page::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--theme-text-muted) 15%, transparent);
  border-radius: 3px;
}
</style>
