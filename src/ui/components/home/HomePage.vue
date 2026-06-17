<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '../../stores/game-store'
import { useUIStore } from '../../stores/ui-store'
import { VERSION } from '@engine/index'
import AppButton from '../shared/AppButton.vue'
import AppModal from '../shared/AppModal.vue'

const router = useRouter()
const game = useGameStore()
const ui = useUIStore()

// === 读取存档 ===
const showSaveModal = ref(false)
const showCreditsModal = ref(false)
const selectedSaveId = ref<string | null>(null)
const selectedSave = computed(() => game.saves.find(s => s.id === selectedSaveId.value) || null)
const selectedSaveData = ref<any>(null)

watch(selectedSaveId, async (id) => {
  if (!id) { selectedSaveData.value = null; return }
  try {
    const { getSave, getCharacters, getSaveProfile } = await import('@engine/database')
    const save = await getSave(id)
    const chars = await getCharacters(id)
    const profile = await getSaveProfile(id)
    const player = chars?.find((c: any) => c.type === 'player')
    if (player) {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || player.name,
        level: player.level,
        race: player.race,
        location: player.location,
        hp: player.hp, maxHp: player.maxHp,
        mp: player.mp, maxMp: player.maxMp,
        sp: player.sp, maxSp: player.maxSp,
        fp: profile?.fp || 0,
        attributes: player.attributes,
        lastMessages: save?.snapshots?.slice(-1)?.[0]
          ? null  // TODO: load actual messages
          : null,
      }
    } else {
      selectedSaveData.value = {
        characterName: save?.metadata?.characterName || '未知角色',
        level: '?', race: '?', location: '?',
        hp: 0, maxHp: 0, mp: 0, maxMp: 0, sp: 0, maxSp: 0,
        fp: profile?.fp || 0,
        attributes: {},
        lastMessages: null,
      }
    }
  } catch {
    selectedSaveData.value = { characterName: '加载失败', level:'?', race:'?', location:'?', hp:0,maxHp:0,mp:0,maxMp:0,sp:0,maxSp:0,fp:0,attributes:{},lastMessages:null }
  }
})

// === 风味文字循环 ===
const quotes = [
  '命运的交响，于此奏鸣',
  '在黄昏的余晖中，踏上命定之途',
  '每一次抉择，都是诗篇的一行',
]
const currentQuote = ref(0)
let quoteTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  // 加载存档列表
  try { await game.loadSaves() } catch { /* IndexedDB 可能未初始化 */ }
  // 风味文字循环
  quoteTimer = setInterval(() => {
    currentQuote.value = (currentQuote.value + 1) % quotes.length
  }, 5000)
})

onUnmounted(() => { if (quoteTimer) clearInterval(quoteTimer) })

function newGame() {
  router.push('/create')
}

function loadGame(saveId: string) {
  showSaveModal.value = false
  router.push(`/game/${saveId}`)
}

async function deleteSave(saveId: string) {
  if (!confirm('确定要删除这个存档吗？此操作不可撤销。')) return
  const { deleteSaveSlot } = await import('@engine/database')
  await deleteSaveSlot(saveId)
  await game.loadSaves()
}

async function importSave() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text)
      const { importAllData } = await import('@engine/database')
      await importAllData(data)
      await game.loadSaves()
      ui.toast('存档导入成功', 'success')
    } catch {
      ui.toast('导入失败，文件格式不正确', 'error')
    }
  }
  input.click()
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="home-page">

    <!-- 标题区域 40vh -->
    <div class="title-section">
      <h1 class="main-title">命定之诗与黄昏之歌</h1>
      <div class="title-line"></div>
      <p class="sub-title">Destined Poetry & Twilight Song</p>
      <!-- 风味文字 -->
      <div class="quote-container">
        <transition name="quote-fade" mode="out-in">
          <p :key="currentQuote" class="flavor-quote">{{ quotes[currentQuote] }}</p>
        </transition>
      </div>
    </div>

    <!-- 操作按钮 -->
    <div class="action-section">
      <div class="btn-column">
        <AppButton variant="primary" size="lg" block class="btn-glow" @click="newGame">
          ✦ 新 建 存 档
        </AppButton>
        <AppButton variant="secondary" size="lg" block @click="showSaveModal = true">
          读 取 存 档
        </AppButton>
        <div class="btn-row">
          <AppButton variant="ghost" size="md" @click="router.push('/settings')">
            设 置
          </AppButton>
          <AppButton variant="ghost" size="md" @click="showCreditsModal = true">
            制作人员
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 底部信息 -->
    <footer class="home-footer">
      <span>v{{ VERSION }} · 复兴纪元</span>
    </footer>

    <!-- 读取存档 — 全屏界面 -->
    <Teleport to="body">
      <transition name="slide-up">
        <div v-if="showSaveModal" class="save-panel-overlay">
          <div class="save-panel">
            <!-- 顶部栏 -->
            <div class="save-panel-header">
              <h2 class="save-panel-title">读取存档</h2>
              <div class="save-panel-header-actions">
                <AppButton variant="ghost" size="sm" @click="importSave">导入存档</AppButton>
                <button class="save-panel-close" @click="showSaveModal = false" aria-label="关闭">×</button>
              </div>
            </div>
            <!-- 主体：左列表 + 右预览 -->
            <div class="save-panel-body">
              <!-- 左边存档列表 -->
              <div class="save-panel-left">
                <div v-if="game.saves.length === 0" class="empty-saves">
                  <p class="text-muted">还没有存档</p>
                  <AppButton variant="primary" size="sm" @click="newGame">创建第一个存档</AppButton>
                </div>
                <div v-else class="save-list">
                  <div v-for="save in game.saves" :key="save.id" class="save-item"
                    :class="{ 'save-item-active': selectedSaveId === save.id }"
                    @click="selectedSaveId = save.id">
                    <div class="save-info">
                      <span class="save-name">{{ save.name || '未命名存档' }}</span>
                      <span class="save-meta text-muted">
                        {{ save.metadata?.characterName || '未知角色' }} · Lv.{{ save.metadata?.totalTurns || '?' }}
                      </span>
                      <span class="save-meta text-muted text-xs">{{ formatTime(save.updatedAt) }}</span>
                    </div>
                    <button class="save-delete" @click.stop="deleteSave(save.id)" title="删除">×</button>
                  </div>
                </div>
              </div>
              <!-- 右边预览 -->
              <div class="save-panel-right">
                <template v-if="selectedSave && selectedSaveData">
                  <div class="save-preview-header">
                    <h3>{{ selectedSaveData.characterName || selectedSave.name }}</h3>
                    <p class="text-muted text-sm">
                      等级 {{ selectedSaveData.level || '?' }} · {{ selectedSaveData.race || '未知种族' }} · {{ selectedSaveData.location || '未知地点' }}
                    </p>
                  </div>
                  <div class="save-preview-stats">
                    <div class="preview-stat"><span class="text-muted">HP</span><span>{{ selectedSaveData.hp }}/{{ selectedSaveData.maxHp }}</span></div>
                    <div class="preview-stat"><span class="text-muted">MP</span><span>{{ selectedSaveData.mp }}/{{ selectedSaveData.maxMp }}</span></div>
                    <div class="preview-stat"><span class="text-muted">SP</span><span>{{ selectedSaveData.sp }}/{{ selectedSaveData.maxSp }}</span></div>
                    <div class="preview-stat"><span class="text-muted">FP</span><span>{{ selectedSaveData.fp || 0 }}</span></div>
                  </div>
                  <div class="save-preview-attrs">
                    <span v-for="(v,k) in (selectedSaveData.attributes||{})" :key="k" class="preview-attr">
                      <span class="text-muted">{{ {str:'力量',dex:'敏捷',con:'体质',int:'智力',spi:'精神'}[k]||k }}</span>
                      <strong>{{ v }}</strong>
                    </span>
                  </div>
                  <div v-if="selectedSaveData.lastMessages" class="save-preview-chat">
                    <h4 class="text-sm text-muted">最近对话</h4>
                    <div v-for="(msg, i) in selectedSaveData.lastMessages.slice(-4)" :key="i" class="preview-msg">
                      <span class="preview-msg-role text-xs text-muted">{{ msg.role === 'user' ? '玩家' : '叙事' }}</span>
                      <p class="text-sm">{{ (msg.content||'').slice(0, 120) }}{{ (msg.content||'').length > 120 ? '...' : '' }}</p>
                    </div>
                  </div>
                  <AppButton variant="primary" size="md" @click="loadGame(selectedSave.id)" style="margin-top:16px">
                    进入游戏
                  </AppButton>
                </template>
                <div v-else class="save-preview-empty">
                  <p class="text-muted">← 选择一个存档查看详情</p>
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
            复兴纪元 · 10大势力 · 23血脉 · 32节点地图<br/>
            普通 / 优良 / 稀有 / 史诗 / 传说 / 神话 / 唯一
          </p>
        </div>
      </div>
    </AppModal>

  </div>
</template>

<style scoped>
.home-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  min-height: 100vh;
  padding: 0 2rem;
  overflow-y: auto;
}

/* === 标题 === */
.title-section {
  margin-top: 38vh;
  text-align: center;
  animation: titleEnter 0.8s ease-out;
}
@keyframes titleEnter {
  from { opacity: 0; transform: translateY(-24px); }
  to { opacity: 1; transform: translateY(0); }
}

.main-title {
  font-family: var(--theme-font-title);
  font-size: clamp(1.8rem, 5vw, 2.8rem);
  font-weight: 700;
  color: var(--theme-text-primary);
  letter-spacing: 2px;
  text-shadow: 0 0 30px color-mix(in srgb, var(--theme-primary) 40%, transparent);
  margin: 0;
}

.title-line {
  width: 120px;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--theme-primary), transparent);
  margin: 16px auto;
}

.sub-title {
  font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
  font-size: 1.1rem;
  color: var(--theme-text-secondary);
  letter-spacing: 3px;
  margin: 0 0 8px;
}

/* === 风味文字 === */
.quote-container {
  min-height: 2rem;
  margin-top: 12px;
}
.flavor-quote {
  font-family: 'KaiTi', 'STKaiti', '楷体', var(--theme-font-body);
  font-size: 1rem;
  color: var(--theme-text-muted);
  font-style: italic;
  margin: 0;
}
.quote-fade-enter-active, .quote-fade-leave-active { transition: opacity 0.6s ease; }
.quote-fade-enter-from, .quote-fade-leave-to { opacity: 0; }

/* === 按钮 === */
.action-section {
  margin-top: 3rem;
  animation: btnsEnter 0.6s ease-out 0.3s both;
}
@keyframes btnsEnter {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.btn-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(320px, 80vw);
}

.btn-glow {
  box-shadow: 0 0 20px color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.btn-glow:hover {
  box-shadow: 0 0 32px color-mix(in srgb, var(--theme-primary) 50%, transparent);
}

.btn-row {
  display: flex;
  gap: 12px;
}
.btn-row > * { flex: 1; }

/* === 底部 === */
.home-footer {
  margin-top: auto;
  padding: 2rem 0 1.5rem;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  opacity: 0.6;
}

/* === 读取存档 — 全屏面板 === */
.save-panel-overlay {
  position: fixed; inset: 0; z-index: 500;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(6px);
  display: flex; align-items: stretch;
}
.save-panel {
  margin: 40px;
  flex: 1;
  background: var(--theme-window-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl);
  display: flex; flex-direction: column;
  overflow: hidden;
  box-shadow: var(--theme-shadow-lg);
}
.save-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
}
.save-panel-title {
  font-family: var(--theme-font-title);
  font-size: 1.3rem; margin: 0;
  color: var(--theme-text-primary);
}
.save-panel-header-actions { display: flex; align-items: center; gap: 8px; }
.save-panel-close {
  width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
  font-size: 1.4rem; color: var(--theme-text-muted);
  background: none; border: none; border-radius: var(--theme-radius-sm); cursor: pointer;
}
.save-panel-close:hover { color: var(--theme-text-primary); background: var(--theme-tab-hover-bg); }

.save-panel-body { display: flex; flex: 1; overflow: hidden; }

.save-panel-left {
  width: 320px; flex-shrink: 0;
  border-right: 1px solid var(--theme-card-border);
  overflow-y: auto; padding: 16px;
}
.save-panel-right {
  flex: 1; overflow-y: auto; padding: 24px 32px;
  display: flex; flex-direction: column;
}

/* 存档列表项 */
.save-item {
  display: flex; align-items: center;
  padding: 12px 14px;
  border-radius: var(--theme-radius-md);
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  border: 1px solid transparent;
  margin-bottom: 6px;
}
.save-item:hover { background: var(--theme-tab-hover-bg); }
.save-item-active {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
}
.save-info { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.save-name { font-weight: 600; color: var(--theme-text-primary); font-size: 0.9rem; }
.save-meta { font-size: 0.75rem; }
.save-delete {
  background: none; border: none; color: var(--theme-text-muted); font-size: 1.2rem;
  cursor: pointer; padding: 4px 8px; border-radius: var(--theme-radius-sm); flex-shrink: 0;
}
.save-delete:hover { color: var(--theme-error); }

/* 预览 */
.save-preview-header h3 { margin: 0 0 4px; font-size: 1.4rem; }
.save-preview-stats { display: flex; gap: 16px; margin: 16px 0; }
.preview-stat { display: flex; flex-direction: column; align-items: center; font-size: 0.85rem; font-weight: 600; }
.preview-stat span:first-child { font-size: 0.7rem; text-transform: uppercase; }
.save-preview-attrs { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.preview-attr { display: flex; flex-direction: column; align-items: center; padding: 6px 14px; background: var(--theme-surface-muted); border-radius: var(--theme-radius-md); font-size: 0.8rem; }
.preview-attr strong { font-size: 1rem; }
.save-preview-chat { margin-bottom: 8px; }
.preview-msg { padding: 8px 12px; background: var(--theme-surface-muted); border-radius: var(--theme-radius-sm); margin-bottom: 6px; }
.preview-msg-role { display: block; margin-bottom: 2px; }
.save-preview-empty { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 1rem; }

/* 进入动画 */
.slide-up-enter-active { transition: all 0.3s ease-out; }
.slide-up-leave-active { transition: all 0.2s ease-in; }
.slide-up-enter-from { opacity: 0; }
.slide-up-enter-from .save-panel { transform: translateY(30px); opacity: 0; }
.slide-up-leave-to { opacity: 0; }

/* 空状态 */
.empty-saves { text-align: center; padding: 2rem 0; display: flex; flex-direction: column; align-items: center; gap: 12px; }

/* === 制作人员 === */
.credits-content { display: flex; flex-direction: column; gap: 12px; }
.credit-item { display: flex; justify-content: space-between; font-size: 0.9rem; color: var(--theme-text-primary); }
.credit-divider { border-color: var(--theme-card-border); }
.world-lore h4 { font-family: var(--theme-font-title); margin: 0 0 4px; font-size: 0.95rem; }
</style>
