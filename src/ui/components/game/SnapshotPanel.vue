<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { getSnapshots } from '@engine/database';
import AppButton from '../shared/AppButton.vue';
import type { Snapshot, CharacterState } from '@engine/types';

const game = useGameStore();

const snapshots = ref<Snapshot[]>([]);
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

function playerOf(snap: Snapshot): CharacterState | undefined {
  return snap.characters?.find((c) => c.type === 'player');
}

function gameTimeText(snap: Snapshot): string {
  const t = snap.saveProfile?.gameTime;
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

async function restore(snap: Snapshot) {
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
  const result = await game.restoreToSnapshot(snap.id);
  restoring.value = false;
  if (result.ok) {
    game.closeModal();
  } else {
    errorMsg.value = result.error || '恢复失败';
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
      <div
        v-for="snap in snapshots"
        :key="snap.id"
        class="snapshot-card"
        :class="{ current: currentSnapshotId === snap.id }"
      >
        <div class="snap-header">
          <span class="snap-turn">第 {{ snap.turn }} 回合</span>
          <span class="snap-reason">{{ reasonLabel[snap.reason] ?? snap.reason }}</span>
          <span v-if="currentSnapshotId === snap.id" class="snap-current">当前</span>
        </div>
        <div class="snap-meta">
          <span v-if="playerOf(snap)" class="snap-player">
            {{ playerOf(snap)!.name }} · HP {{ playerOf(snap)!.hp }}/{{ playerOf(snap)!.maxHp }}
          </span>
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
    <div v-else class="empty">暂无快照（对话几轮后会自动产生）</div>
    <div v-if="errorMsg" class="error">{{ errorMsg }}</div>
  </div>
</template>

<style scoped>
.snapshot-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px;
  gap: 8px;
}
.panel-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.panel-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.panel-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.combat-warn {
  font-size: 0.75rem;
  color: var(--theme-danger, #e5484d);
  padding: 6px 8px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
}
.snapshot-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.snapshot-card {
  background: var(--theme-card-bg);
  padding: 8px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  border: 1px solid var(--theme-card-border);
}
.snapshot-card.current {
  border-color: var(--theme-primary);
}
.snap-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.snap-turn {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.snap-reason {
  font-size: 0.625rem;
  padding: 1px 6px;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border-radius: 3px;
}
.snap-current {
  font-size: 0.625rem;
  padding: 1px 6px;
  background: var(--theme-primary);
  color: var(--theme-on-primary, #fff);
  border-radius: 3px;
  margin-left: auto;
}
.snap-meta {
  display: flex;
  gap: 10px;
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
  padding: 24px;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
}
.error {
  font-size: 0.75rem;
  color: var(--theme-danger, #e5484d);
}
</style>
