<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { VERSION } from '@engine/index';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';

const game = useGameStore();
const ui = useUIStore();

/**
 * 创意工坊入口仍按产品发布节奏临时隐藏，等待完整安装/启用/游戏页真机走查。
 * 这不是安全边界：已安装项目仍可在游戏页启用。
 *
 * 当前执行边界：正则 replacement 只在 opaque `sandbox="allow-scripts"` iframe 中运行，
 * 可加载远程资源并调用网络 API，但拿不到父页面 DOM、Dexie、应用存储或 API Key；
 * 每个富命中独占一个 frame，未命中正文留在宿主原生文本面。世界书 EJS 由 QuickJS
 * 隔离并 fail-closed。网络开启意味着正则仍可发送该命中的 replacement/capture，
 * 详见 `docs/reviews/2026-08-02-workshop-regex-compatibility.md`。
 */
const WORKSHOP_ENTRY_ENABLED = false;

// === 读取存档 ===
const showSaveModal = ref(false);
const showCreditsModal = ref(false);
const selectedSaveId = ref<string | null>(null);
const selectedSave = computed(() => game.saves.find((s) => s.id === selectedSaveId.value) || null);
const selectedSaveData = ref<any>(null);

watch(selectedSaveId, async (id) => {
  if (!id) {
    selectedSaveData.value = null;
    return;
  }
  try {
    const { getSave, getCharacters, getSaveProfile } = await import('@engine/database');
    const save = await getSave(id);
    const chars = await getCharacters(id);
    const profile = await getSaveProfile(id);
    const player = chars?.find((c: any) => c.type === 'player');
    if (player) {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || player.name,
        level: player.level,
        race: player.race,
        location: player.location,
        hp: player.hp,
        maxHp: player.maxHp,
        mp: player.mp,
        maxMp: player.maxMp,
        sp: player.sp,
        maxSp: player.maxSp,
        fp: profile?.fp || 0,
        attributes: player.attributes,
        lastMessages: null,
      };
    } else {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || '未知角色',
        level: '?',
        race: '?',
        location: '?',
        hp: 0,
        maxHp: 0,
        mp: 0,
        maxMp: 0,
        sp: 0,
        maxSp: 0,
        fp: profile?.fp || 0,
        attributes: {},
        lastMessages: null,
      };
    }
  } catch {
    selectedSaveData.value = {
      characterName: '加载失败',
      level: '?',
      race: '?',
      location: '?',
      hp: 0,
      maxHp: 0,
      mp: 0,
      maxMp: 0,
      sp: 0,
      maxSp: 0,
      fp: 0,
      attributes: {},
      lastMessages: null,
    };
  }
});

// === 风味文字循环 ===
const quotes = [
  '命运的交响，于此奏鸣',
  '在黄昏的余晖中，踏上命定之途',
  '每一次抉择，都是诗篇的一行',
  '星辰为引，长夜作伴',
  '于灰烬中点亮前行的灯',
];
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
  }
  // 风味文字循环
  quoteTimer = setInterval(() => {
    currentQuote.value = (currentQuote.value + 1) % quotes.length;
  }, 5000);
});

onUnmounted(() => {
  if (quoteTimer) clearInterval(quoteTimer);
  document.body.classList.remove('home-entered');
});

function newGame() {
  ui.navigate('create');
}

function loadGame(saveId: string) {
  showSaveModal.value = false;
  ui.navigate('game', saveId);
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

async function deleteSave(saveId: string) {
  if (!confirm('确定要删除这个存档吗？此操作不可撤销。')) return;
  const { deleteSaveSlot } = await import('@engine/database');
  await deleteSaveSlot(saveId);
  await game.loadSaves();
}

async function importSave() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const { importAllData } = await import('@engine/database');
      await importAllData(data);
      await game.loadSaves();
      ui.toast('存档导入成功', 'success');
    } catch {
      ui.toast('导入失败，文件格式不正确', 'error');
    }
  };
  input.click();
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <div class="home-page" @mouseenter="showDevButton = true" @mouseleave="showDevButton = false">
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

    <!-- 标题区域 -->
    <div class="title-section">
      <div class="title-frame">
        <div class="title-corner title-corner-tl" aria-hidden="true" />
        <div class="title-corner title-corner-tr" aria-hidden="true" />
        <div class="title-corner title-corner-bl" aria-hidden="true" />
        <div class="title-corner title-corner-br" aria-hidden="true" />

        <h1 class="main-title">
          <span class="title-line-t main-line">命定之诗</span>
          <span class="title-line-b alt-line">与黄昏之歌</span>
        </h1>
      </div>

      <div class="title-divider">
        <span class="divider-diamond" aria-hidden="true" />
      </div>

      <p class="sub-title">Destined Poetry &amp; Twilight Song</p>

      <!-- 风味文字 -->
      <div class="quote-container">
        <transition name="quote-fade" mode="out-in">
          <p :key="currentQuote" class="flavor-quote">「{{ quotes[currentQuote] }}」</p>
        </transition>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-section">
      <div class="btn-column">
        <AppButton variant="primary" size="lg" block class="btn-new-game" @click="newGame">
          ✦ 新 建 存 档
        </AppButton>
        <AppButton
          variant="secondary"
          size="lg"
          block
          class="btn-load"
          @click="showSaveModal = true"
        >
          <i class="btn-icon fa-solid fa-folder-open" aria-hidden="true"></i>读 取 存 档
        </AppButton>
        <!-- 🔒 临时下线：见 script 里的 WORKSHOP_ENTRY_ENABLED -->
        <AppButton
          v-if="WORKSHOP_ENTRY_ENABLED"
          variant="secondary"
          size="lg"
          block
          class="btn-workshop"
          @click="ui.navigate('workshop')"
        >
          <i class="btn-icon fa-solid fa-puzzle-piece" aria-hidden="true"></i>创 意 工 坊
        </AppButton>
        <div class="btn-row">
          <AppButton variant="ghost" size="md" class="btn-ghost" @click="ui.navigate('settings')">
            <i class="btn-icon fa-solid fa-gear" aria-hidden="true"></i>设 置
          </AppButton>
          <AppButton variant="ghost" size="md" class="btn-ghost" @click="showCreditsModal = true">
            <i class="btn-icon fa-solid fa-users" aria-hidden="true"></i>制 作 人 员
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

    <!-- 底部信息 -->
    <footer class="home-footer">
      <span class="footer-version">v{{ VERSION }}</span>
      <span class="footer-dot" aria-hidden="true">·</span>
      <span class="footer-era">复兴纪元</span>
    </footer>

    <!-- 读取存档 — 全屏界面 -->
    <Teleport to="body">
      <transition name="save-slide">
        <div v-if="showSaveModal" class="save-panel-overlay">
          <div class="save-panel">
            <!-- 顶部栏 -->
            <div class="save-panel-header">
              <h2 class="save-panel-title">读取存档</h2>
              <div class="save-panel-header-actions">
                <AppButton variant="ghost" size="sm" @click="importSave">导入存档</AppButton>
                <button class="save-panel-close" aria-label="关闭" @click="showSaveModal = false">
                  ✕
                </button>
              </div>
            </div>
            <!-- 主体：左列表 + 右预览 -->
            <div class="save-panel-body">
              <!-- 左边存档列表 -->
              <div class="save-panel-left">
                <div v-if="game.saves.length === 0" class="empty-saves">
                  <div class="empty-icon"></div>
                  <p class="text-muted">还没有存档</p>
                  <AppButton variant="primary" size="sm" @click="newGame">创建第一个存档</AppButton>
                </div>
                <div v-else class="save-list">
                  <div
                    v-for="save in game.saves"
                    :key="save.id"
                    class="save-item"
                    :class="{ 'save-item-active': selectedSaveId === save.id }"
                    @click="selectedSaveId = save.id"
                  >
                    <div class="save-avatar">{{ (save.metadata?.characterName || '?')[0] }}</div>
                    <div class="save-info">
                      <span class="save-name">{{ save.name || '未命名存档' }}</span>
                      <span class="save-meta text-muted">
                        <!-- M5 #27 语义修正: totalTurns 是对话回合数（每轮管线 +1），不是等级 -->
                        {{ save.metadata?.characterName || '未知角色' }} · 第
                        {{ save.metadata?.totalTurns ?? 0 }} 回合
                      </span>
                      <span class="save-meta text-muted text-xs">{{
                        formatTime(save.updatedAt)
                      }}</span>
                    </div>
                    <button class="save-delete" title="删除存档" @click.stop="deleteSave(save.id)">
                      ✕
                    </button>
                  </div>
                </div>
              </div>
              <!-- 右边预览 -->
              <div class="save-panel-right">
                <template v-if="selectedSave && selectedSaveData">
                  <div class="save-preview-header">
                    <div class="preview-avatar">
                      {{ (selectedSaveData.characterName || '?')[0] }}
                    </div>
                    <div class="preview-info">
                      <h3>{{ selectedSaveData.characterName || selectedSave.name }}</h3>
                      <p class="text-muted text-sm">
                        Lv.{{ selectedSaveData.level || '?' }} ·
                        {{ selectedSaveData.race || '未知种族' }}
                      </p>
                      <p class="text-muted text-xs">
                        {{ selectedSaveData.location || '未知地点' }}
                      </p>
                    </div>
                  </div>
                  <div class="save-preview-stats">
                    <div class="preview-stat">
                      <span class="stat-label hp-label">HP</span>
                      <span class="stat-value"
                        >{{ selectedSaveData.hp }}/{{ selectedSaveData.maxHp }}</span
                      >
                    </div>
                    <div class="preview-stat">
                      <span class="stat-label mp-label">MP</span>
                      <span class="stat-value"
                        >{{ selectedSaveData.mp }}/{{ selectedSaveData.maxMp }}</span
                      >
                    </div>
                    <div class="preview-stat">
                      <span class="stat-label sp-label">SP</span>
                      <span class="stat-value"
                        >{{ selectedSaveData.sp }}/{{ selectedSaveData.maxSp }}</span
                      >
                    </div>
                    <div class="preview-stat">
                      <span class="stat-label fp-label">FP</span>
                      <span class="stat-value">{{ selectedSaveData.fp || 0 }}</span>
                    </div>
                  </div>
                  <div
                    v-if="Object.keys(selectedSaveData.attributes || {}).length"
                    class="save-preview-attrs"
                  >
                    <span
                      v-for="(v, k) in selectedSaveData.attributes"
                      :key="k"
                      class="preview-attr"
                    >
                      <span class="attr-label">{{
                        { str: '力', dex: '敏', con: '体', int: '智', spi: '精' }[k] || k
                      }}</span>
                      <strong class="attr-value">{{ v }}</strong>
                    </span>
                  </div>
                  <AppButton
                    variant="primary"
                    size="md"
                    class="btn-enter-game"
                    @click="loadGame(selectedSave.id)"
                  >
                    进入游戏
                  </AppButton>
                </template>
                <div v-else class="save-preview-empty">
                  <div class="empty-icon"></div>
                  <p class="text-muted">选择一个存档查看详情</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </Teleport>

    <!-- 制作人员弹窗 -->
    <AppModal v-model:open="showCreditsModal" title="制作人员" size="sm">
      <div class="credits-content">
        <div class="credit-item"><strong>引擎开发</strong><span>Claude Code + Richard</span></div>
        <div class="credit-item"><strong>世界观设定</strong><span>命定之诗创作组</span></div>
        <div class="credit-item"><strong>前端 UI</strong><span>Vue 3 + Pinia + Vite</span></div>
        <div class="credit-item"><strong>数据引擎</strong><span>Dexie.js (IndexedDB)</span></div>
        <hr class="credit-divider" />
        <div class="world-lore">
          <h4>阿斯塔利亚世界</h4>
          <p class="text-muted text-sm">
            复兴纪元 · 10大势力 · 23血脉 · 32节点地图<br />
            普通 / 优良 / 稀有 / 史诗 / 传说 / 神话 / 唯一
          </p>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
/* ═══════════════════════════════════════
   首页 — 命定之诗标题画面
   优雅的暗色奇幻风格
   ═══════════════════════════════════════ */
.home-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  min-height: 100vh;
  position: relative;
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
  margin-top: 32vh;
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
  font-size: clamp(2rem, 6vw, 3.2rem);
  font-weight: 700;
  color: var(--theme-text-primary);
  letter-spacing: 6px;
  text-shadow:
    0 0 40px color-mix(in srgb, var(--theme-primary) 35%, transparent),
    0 0 80px color-mix(in srgb, var(--theme-primary) 15%, transparent);
  line-height: 1.3;
}
.alt-line {
  font-size: clamp(1.2rem, 3.5vw, 2rem);
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
  margin-top: 2.5rem;
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
  width: min(320px, 80vw);
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

.btn-load {
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}
.btn-load:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 25%, transparent);
}

.btn-workshop {
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease;
}
.btn-workshop:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px color-mix(in srgb, #000 25%, transparent);
}

.btn-ghost {
  transition: transform 0.2s ease;
}
.btn-ghost:hover {
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
  margin-top: auto;
  padding: 2.5rem 0 1.5rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  opacity: 0.4;
  display: flex;
  gap: 8px;
  align-items: center;
  letter-spacing: 1px;
  position: relative;
  z-index: 1;
}
.footer-dot {
  opacity: 0.3;
}

/* ═══ 读取存档 — 全屏面板 ═══ */
.save-panel-overlay {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: color-mix(in srgb, var(--theme-window-bg) 75%, transparent);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.save-panel {
  width: min(900px, 92vw);
  height: min(600px, 80vh);
  background: var(--theme-window-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl, 16px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow:
    0 0 40px color-mix(in srgb, #000 50%, transparent),
    0 0 80px color-mix(in srgb, var(--theme-primary) 6%, transparent);
}
.save-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.save-panel-title {
  font-family: var(--theme-font-title);
  font-size: 1.2rem;
  margin: 0;
  color: var(--theme-text-primary);
  letter-spacing: 1px;
}
.save-panel-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.save-panel-close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.save-panel-close:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}

.save-panel-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左列表 */
.save-panel-left {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--theme-card-border);
  overflow-y: auto;
  padding: 16px 12px;
}
.save-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.save-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--theme-radius-md, 8px);
  cursor: pointer;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}
.save-item:hover {
  background: var(--theme-tab-hover-bg);
  border-color: var(--theme-card-border);
}
.save-item-active {
  border-color: var(--theme-primary) !important;
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-primary) 20%, transparent);
}
.save-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--theme-primary-bg, color-mix(in srgb, var(--theme-primary) 20%, transparent));
  color: var(--theme-primary-text, var(--theme-primary));
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
  font-family: var(--theme-font-title);
  flex-shrink: 0;
}
.save-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.save-name {
  font-weight: 600;
  color: var(--theme-text-primary);
  font-size: 0.9rem;
}
.save-meta {
  font-size: 0.72rem;
}
.save-delete {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: var(--theme-text-muted);
  font-size: 0.85rem;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
}
.save-item:hover .save-delete {
  opacity: 1;
}
.save-delete:hover {
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 10%, transparent);
}

/* 右预览 */
.save-panel-right {
  flex: 1;
  overflow-y: auto;
  padding: 28px 32px;
  display: flex;
  flex-direction: column;
}
.save-preview-header {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 20px;
}
.preview-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--theme-primary) 40%, transparent),
    color-mix(in srgb, var(--theme-quality-epic) 40%, transparent)
  );
  color: var(--theme-text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--theme-font-title);
  font-size: 22px;
  font-weight: 700;
  flex-shrink: 0;
  box-shadow: 0 0 20px color-mix(in srgb, var(--theme-primary) 15%, transparent);
}
.preview-info h3 {
  margin: 0 0 4px;
  font-size: 1.3rem;
  font-family: var(--theme-font-title);
  color: var(--theme-text-primary);
}
.save-preview-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  margin-bottom: 20px;
}
.preview-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 8px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md, 8px);
}
.stat-label {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.hp-label {
  color: var(--theme-hp);
}
.mp-label {
  color: var(--theme-mp);
}
.sp-label {
  color: var(--theme-sp);
}
.fp-label {
  color: var(--theme-quality-epic);
}
.stat-value {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}

.save-preview-attrs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.preview-attr {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 14px;
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border-radius: var(--theme-radius-md, 8px);
  gap: 2px;
}
.attr-label {
  font-size: 0.68rem;
  color: var(--theme-text-muted);
}
.attr-value {
  font-size: 1.1rem;
  color: var(--theme-text-primary);
}

.btn-enter-game {
  margin-top: auto;
  align-self: flex-start;
  letter-spacing: 1px;
}

.save-preview-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--theme-text-muted);
}
.save-preview-empty .empty-icon {
  font-size: 2rem;
}

/* 空状态 */
.empty-saves {
  text-align: center;
  padding: 2rem 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.empty-icon {
  font-size: 2rem;
  opacity: 0.4;
}

/* ═══ 存档面板动画 ═══ */
.save-slide-enter-active {
  transition: all 0.3s ease-out;
}
.save-slide-leave-active {
  transition: all 0.2s ease-in;
}
.save-slide-enter-from {
  opacity: 0;
}
.save-slide-enter-from .save-panel {
  transform: translateY(20px) scale(0.98);
  opacity: 0;
}
.save-slide-leave-to {
  opacity: 0;
}

/* ═══ 制作人员 ═══ */
.credits-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.credit-item {
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
  color: var(--theme-text-primary);
  padding: 4px 0;
}
.credit-divider {
  border-color: var(--theme-card-border);
}
.world-lore h4 {
  font-family: var(--theme-font-title);
  margin: 0 0 4px;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
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
  .fade-leave-active,
  .save-slide-enter-active,
  .save-slide-leave-active {
    transition: none;
  }
  .save-slide-enter-from .save-panel {
    transform: none;
  }
  .btn-new-game,
  .btn-load,
  .btn-workshop,
  .btn-ghost {
    transition: none;
  }
  .btn-new-game:hover,
  .btn-load:hover,
  .btn-workshop:hover,
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
