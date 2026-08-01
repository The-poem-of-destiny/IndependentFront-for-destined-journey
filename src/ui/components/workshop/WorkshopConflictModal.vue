<script setup lang="ts">
/**
 * 覆盖警告 —— D15 的最后一道闸（Phase 1 / P1-4）
 *
 * 更新是**覆盖式**的，且**不提供逐条保留**（D15 明文）: 逐条保留会让本地内容与上游
 * 版本永久分叉，之后每次更新都 diff 不上，比"改动被覆盖"难查得多。
 *
 * 所以这一屏能给的只有一件事: **在写任何一行之前**，把「你亲手改过的这 N 条会被
 * 上游版本盖掉」说清楚，并留一条真的能退出去的路。
 *
 * ⚠️ 时序不可颠倒: store 的 `install()` 在 `plan.conflicts` 非空时**不写任何一行**，
 * 只回 `needs_confirmation`；本模态确认后才走 `commitInstall`。谁把这两步合成一步，
 * 谁就把 D15 变成了一句注释。
 */
import type { InstallConflict } from '@engine/workshop-types';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';

defineProps<{
  open: boolean;
  projectName: string;
  conflicts: InstallConflict[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <AppModal :open="open" title="确认覆盖你修改过的条目" size="md" @update:open="emit('cancel')">
    <div class="wk-conflict">
      <p class="wk-lead">
        更新「<strong>{{ projectName }}</strong
        >」会用上游的新版本覆盖下面
        <strong class="wk-count">{{ conflicts.length }}</strong> 条你编辑过的条目。
      </p>

      <ul class="wk-conflict-list">
        <li v-for="c in conflicts" :key="c.uid" class="wk-conflict-item">
          <span class="wk-conflict-name">{{ c.name }}</span>
          <span class="wk-conflict-uid">#{{ c.uid }}</span>
        </li>
      </ul>

      <p class="wk-warn">
        你对这些条目的修改将丢失，且无法逐条保留。如果想留住改动，请先取消并把内容另存一份。
      </p>
    </div>

    <template #footer>
      <!-- 覆盖跑起来之后「取消」已经无效（写入不可中断），禁掉比留个假出口诚实 -->
      <AppButton variant="ghost" size="sm" :disabled="busy" @click="emit('cancel')">取消</AppButton>
      <AppButton variant="danger" size="sm" :loading="busy" @click="emit('confirm')">
        {{ busy ? '正在覆盖…' : `覆盖并更新（${conflicts.length} 条）` }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.wk-conflict {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}
.wk-lead {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-primary);
}
.wk-count {
  color: var(--theme-error);
}

.wk-conflict-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: var(--theme-spacing-md);
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
  background: color-mix(in srgb, var(--theme-error) 5%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 28%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.wk-conflict-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  font-size: 0.8125rem;
  line-height: 1.6;
}
.wk-conflict-name {
  font-family: var(--theme-font-title);
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk-conflict-uid {
  flex-shrink: 0;
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

.wk-warn {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}
</style>
