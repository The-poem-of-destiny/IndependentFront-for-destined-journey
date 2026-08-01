<script setup lang="ts">
/**
 * 更新确认 —— D15 的最后一道闸 + 改动预告（Phase 1 / P1-4，B3 扩）
 *
 * 这一屏回答两个问题，缺一不可:
 *
 * 1. **上游改了什么**（B3 新增）—— 加了几条、删了几条、哪几条正文变了。没有它，
 *    用户按「更新」是闭着眼点。数据来自 `workshopStore.previewUpdate(prepared)`，
 *    也就是**即将提交的那份计划**本身，不是另拉一次详情重算的（见 workshop-diff.ts）。
 * 2. **你改过的东西会被盖掉吗**（D15 原有）—— 更新是覆盖式的，且**不提供逐条保留**
 *    （D15 明文）: 逐条保留会让本地内容与上游版本永久分叉，之后每次更新都 diff 不上，
 *    比「改动被覆盖」难查得多。
 *
 * 所以有冲突时标题是「确认覆盖你修改过的条目」，没有冲突时只是「确认更新」——
 * 同一句惊悚标题用在两种场合就是狼来了，几次之后用户会闭着眼睛点过去，
 * 而那正是这道闸要防的事。
 *
 * ⚠️ 时序不可颠倒: store 的 `install()` 在需要确认时**不写任何一行**，只回
 * `needs_confirmation`；本模态确认后才走 `commitInstall`。谁把这两步合成一步，
 * 谁就把 D15 变成了一句注释。
 */
import { computed } from 'vue';
import type { InstallConflict } from '@engine/workshop-types';
import type { WorkshopUpdateDiff } from '@engine/workshop-diff';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import { truncate } from './format';

const props = defineProps<{
  open: boolean;
  projectName: string;
  conflicts: InstallConflict[];
  /** 改动预告（B3）。缺省 → 整块不渲染（首装没有可比的对象） */
  diff?: WorkshopUpdateDiff | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const hasConflicts = computed(() => props.conflicts.length > 0);
const title = computed(() => (hasConflicts.value ? '确认覆盖你修改过的条目' : '确认更新'));

/** 三组改动的合计 —— 先给总数，再往下才是逐条 */
const changeCount = computed(() => {
  const d = props.diff;
  if (!d) return 0;
  const g = [d.entries, d.rules];
  return g.reduce((sum, x) => sum + x.added.length + x.modified.length + x.removed.length, 0);
});

/** 条目与正则两块共用同一套渲染 —— 分组的形状一模一样，没必要写两遍模板 */
const entryGroups = computed(() => {
  const d = props.diff;
  if (!d) return [];
  return [
    { key: 'e-add', label: '世界书 · 新增', rows: d.entries.added, mark: '+', kind: 'add' },
    { key: 'e-mod', label: '世界书 · 内容变更', rows: d.entries.modified, mark: '~', kind: 'mod' },
    { key: 'e-del', label: '世界书 · 删除', rows: d.entries.removed, mark: '−', kind: 'del' },
    { key: 'r-add', label: '正则 · 新增', rows: d.rules.added, mark: '+', kind: 'add' },
    { key: 'r-mod', label: '正则 · 变更', rows: d.rules.modified, mark: '~', kind: 'mod' },
    { key: 'r-del', label: '正则 · 删除', rows: d.rules.removed, mark: '−', kind: 'del' },
  ].filter((g) => g.rows.length > 0);
});
</script>

<template>
  <AppModal :open="open" :title="title" size="md" @update:open="emit('cancel')">
    <div class="wk-conflict">
      <!-- ═══ 这一版会改什么（B3） ═══ -->
      <section v-if="diff" class="wk-diff">
        <p v-if="!diff.hasChanges" class="wk-diff-lead">
          这一版的世界书条目与正则内容一字未动，只有版本号变了。
        </p>
        <template v-else>
          <p class="wk-diff-lead">
            这一版共 <strong>{{ changeCount }}</strong> 处改动<template
              v-if="diff.unchangedEntryCount > 0"
              >，另有 {{ diff.unchangedEntryCount }} 条条目原样保留</template
            >。
          </p>

          <template v-for="group in entryGroups" :key="group.key">
            <h4 class="wk-diff-title">{{ group.label }}（{{ group.rows.length }}）</h4>
            <ul class="wk-diff-list">
              <li v-for="row in group.rows" :key="row.name" class="wk-diff-row">
                <span class="wk-diff-mark" :class="`mark-${group.kind}`" aria-hidden="true">
                  {{ group.mark }}
                </span>
                <span class="wk-diff-name">{{ row.name }}</span>
                <span v-if="group.kind === 'mod'" class="wk-diff-peek">
                  {{ truncate(row.before, 36) }} → {{ truncate(row.after, 36) }}
                </span>
              </li>
            </ul>
          </template>
        </template>
      </section>

      <!-- ═══ 覆盖警告（D15，仅在真有冲突时） ═══ -->
      <template v-if="hasConflicts">
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
      </template>
    </div>

    <template #footer>
      <!-- 写入跑起来之后「取消」已经无效（写入不可中断），禁掉比留个假出口诚实 -->
      <AppButton variant="ghost" size="sm" :disabled="busy" @click="emit('cancel')">取消</AppButton>
      <AppButton
        :variant="hasConflicts ? 'danger' : 'primary'"
        size="sm"
        :loading="busy"
        @click="emit('confirm')"
      >
        <template v-if="hasConflicts">
          {{ busy ? '正在覆盖…' : `覆盖并更新（${conflicts.length} 条）` }}
        </template>
        <template v-else>{{ busy ? '正在更新…' : '确认更新' }}</template>
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

/* ── 改动预告（B3） ── */
.wk-diff {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 300px;
  overflow-y: auto;
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.wk-diff-lead {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  color: var(--theme-text-primary);
}
.wk-diff-title {
  margin: var(--theme-spacing-sm) 0 var(--theme-spacing-xs);
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
.wk-diff-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wk-diff-row {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  line-height: 1.6;
}
/*
 * 记号用符号而不只靠颜色: 增/改/删三态若只有绿/黄/红之分，色觉障碍用户就分不清
 * 「这一版加了什么」和「删了什么」—— 而这恰恰是这个面板唯一要传达的信息。
 */
.wk-diff-mark {
  flex: 0 0 auto;
  width: 1em;
  font-family: 'Cascadia Code', monospace;
  text-align: center;
}
.mark-add {
  color: var(--theme-success);
}
.mark-mod {
  color: var(--theme-warning);
}
.mark-del {
  color: var(--theme-error);
}
.wk-diff-name {
  flex: 0 1 auto;
  color: var(--theme-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk-diff-peek {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--theme-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
