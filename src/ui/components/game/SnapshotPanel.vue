<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { getSnapshots } from '@engine/database';
import AppButton from '../shared/AppButton.vue';
import type { SnapshotMeta } from '@engine/types';

const game = useGameStore();
const ui = useUIStore();

// 🔴 拿的是**元数据**：列表要的只有 turn / reason / createdAt 与那一行缩略。
//    整档载荷（characters / 对话历史）在 snapshotPayloads 表里，恢复时才 join ——
//    为了列 30 行字去读 30 份对话历史，正是 v22 拆表要消灭的开销。
const snapshots = ref<SnapshotMeta[]>([]);
const restoring = ref(false);
const errorMsg = ref('');

const reasonLabel: Record<string, string> = {
  turn: '回合档',
  manual: '手动',
  'pre-combat': '战斗前',
};

const currentSnapshotId = computed(() => game.activeSave?.activeSnapshotId ?? null);

async function fetchSnapshots() {
  if (!game.activeSaveId) {
    snapshots.value = [];
    return;
  }
  try {
    const all = await getSnapshots(game.activeSaveId);
    // 按回合数倒序：最新（回合数大）在前
    snapshots.value = all.sort((a, b) => b.turn - a.turn);
  } catch (err) {
    console.error('[SnapshotPanel] 加载快照失败:', err);
    snapshots.value = [];
  }
}

/** 主角那一行的文字；没有缩略（v22 之前的旧快照）就不显示这一行 */
function playerText(snap: SnapshotMeta): string {
  const p = snap.preview;
  if (!p?.playerName) return '';
  if (p.hp === undefined || p.maxHp === undefined) return p.playerName;
  return `${p.playerName} · HP ${p.hp}/${p.maxHp}`;
}

function gameTimeText(snap: SnapshotMeta): string {
  const t = snap.preview?.gameTime;
  if (!t) return '';
  return `${t.era ?? ''}${t.year ?? '?'}年${t.month ?? '?'}月${t.day ?? '?'}日`;
}

function timeText(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

async function restore(snap: SnapshotMeta) {
  if (game.isInCombat) {
    errorMsg.value = '战斗进行中，无法恢复';
    return;
  }
  if (currentSnapshotId.value === snap.id) return;
  const ok = window.confirm(
    `恢复到「第 ${snap.turn} 回合」？\n该回合之后的所有进度（对话 / 状态 / 记忆）都会被丢弃。`,
  );
  if (!ok) return;
  restoring.value = true;
  errorMsg.value = '';
  try {
    const result = await game.restoreToSnapshot(snap.id);
    if (result.status === 'restored') {
      if (result.continuation === 'save-switched') {
        ui.toast(result.warning ?? '时间线已恢复；当前已切换到其他存档', 'warning');
      } else game.closeModal();
    } else if (result.status === 'projection-failed') {
      ui.toast(result.error, 'error');
      ui.navigate('home');
    } else {
      errorMsg.value = result.error;
    }
  } catch (err) {
    console.error('[SnapshotPanel] 恢复快照失败:', err);
    errorMsg.value = '恢复失败';
  } finally {
    restoring.value = false;
  }
}

onMounted(fetchSnapshots);
// 每次打开面板时刷新（游戏进行中新快照会不断产生）
watch(
  () => game.activeModal,
  (m) => {
    if (m === 'snapshots') fetchSnapshots();
  },
);
</script>

<template>
  <div class="snapshot-panel">
    <div class="panel-header">
      <span class="panel-title">快照列表 ({{ snapshots.length }})</span>
      <span class="panel-hint">最近 5 回合每轮留档，更早的按阶梯稀疏保留</span>
    </div>
    <div v-if="game.isInCombat" class="combat-warn">⚠ 战斗进行中，恢复已禁用</div>

    <div v-if="snapshots.length > 0" class="snapshot-list">
      <div v-for="snap in snapshots" :key="snap.id" class="snap-row">
        <div class="snap-gutter" aria-hidden="true">
          <span class="snap-node" :class="{ active: currentSnapshotId === snap.id }"></span>
        </div>
        <div class="snapshot-card" :class="{ current: currentSnapshotId === snap.id }">
          <div class="snap-header">
            <span class="snap-turn">第 {{ snap.turn }} 回合</span>
            <span class="snap-reason">{{ reasonLabel[snap.reason] ?? snap.reason }}</span>
            <span v-if="currentSnapshotId === snap.id" class="snap-current">当前</span>
          </div>
          <div class="snap-meta">
            <span v-if="playerText(snap)" class="snap-player">{{ playerText(snap) }}</span>
            <span class="snap-game-time">{{ gameTimeText(snap) }}</span>
          </div>
          <div class="snap-realtime">存档于 {{ timeText(snap.createdAt) }}</div>
          <div class="snap-actions">
            <AppButton
              variant="secondary"
              size="sm"
              :disabled="game.isInCombat || currentSnapshotId === snap.id || restoring"
              @click="restore(snap)"
            >
              恢复到此
            </AppButton>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="empty">暂无快照（对话几轮后会自动产生）</div>
    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.snapshot-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: var(--theme-spacing-sm);
  gap: var(--theme-spacing-sm);
}
.panel-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.panel-title {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--theme-text-primary);
}
.panel-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.combat-warn {
  font-size: 0.75rem;
  padding: 6px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}

/* ===== 回合时间轴 ===== */
.snapshot-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.snap-row {
  display: grid;
  grid-template-columns: 20px 1fr;
  column-gap: var(--theme-spacing-sm);
}
/* 卡片外边距计入网格轨道高度，连接线因而跨行连续 */
.snap-row:not(:last-child) .snapshot-card {
  margin-bottom: var(--theme-spacing-sm);
}
.snap-gutter {
  position: relative;
}
/* 竖向连接线：首行自节点起、末行至节点止，不留悬空端 */
.snap-gutter::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  margin-left: -0.5px;
  background: var(--theme-card-border);
}
.snap-row:first-child .snap-gutter::before {
  top: 15px;
}
.snap-row:last-child .snap-gutter::before {
  bottom: calc(100% - 15px);
}
.snap-node {
  position: absolute;
  top: 10px;
  left: 50%;
  margin-left: -5px;
  width: 10px;
  height: 10px;
  border-radius: var(--theme-radius-full);
  border: 1px solid var(--theme-card-border);
  background: var(--theme-surface-muted);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.snap-node.active {
  background: var(--theme-primary);
  border-color: var(--theme-primary);
}

/* ===== 快照卡片 ===== */
.snapshot-card {
  background: var(--theme-card-bg);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border-radius: var(--theme-radius-md);
  border: 1px solid var(--theme-card-border);
  box-shadow: var(--paper-stack);
  transition:
    background var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast);
}
.snapshot-card.current {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow:
    0 0 0 1px var(--theme-primary),
    var(--paper-stack);
}
.snap-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xs);
}
.snap-turn {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--theme-text-primary);
}
.snap-reason {
  font-size: 0.625rem;
  padding: 1px 6px;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border-radius: var(--theme-radius-sm);
}
.snap-current {
  font-size: 0.625rem;
  padding: 1px 6px;
  border-radius: var(--theme-radius-sm);
  margin-left: auto;
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
}
.snap-meta {
  display: flex;
  gap: var(--theme-spacing-md);
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  margin-bottom: 2px;
}
.snap-realtime {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
}
.snap-actions {
  margin-top: 6px;
}
.empty {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}
.error {
  font-size: 0.75rem;
  padding: 6px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
}
</style>
