<!--
  PackInstallConfirmModal.vue — 内容包安装/升级的两阶段确认（波 1 T7 / D19 / §5.2）

  展示 planPackInstall 产出的安装计划，让用户在「覆盖前」看到逐节 added/updated/removed/
  conflicted + 存档 uid 迁移说明 + 三类处置记录。确认后由 DataSection 以
  `{ confirmConflicts: true }` 重入 installPack。

  纯展示组件：不碰 store，不判该显示什么（那由宿主 DataSection 决定传什么 plan），
  只把传进来的 PackInstallPlan 画出来。
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { PackInstallPlan } from '@engine/types-content';
import type { PackUpgradeDiff } from '@engine/content-pack-plan';
import type { WorldBook, ChatPreset } from '@engine/types';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';

const props = defineProps<{
  open: boolean;
  plan?: PackInstallPlan | null;
  /** 升级 diff（升级路径时展示「这一版会改什么」） */
  upgradeDiff?: PackUpgradeDiff | null;
  /** 安装失败（校验/执行 throw）时展示的消息 */
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();

/** 是否有需要确认的冲突（决定确认按钮语气） */
const hasConflicts = computed(() => {
  const p = props.plan;
  if (!p) return false;
  return Object.values(p.sections).some((s) => s && s.conflicted && s.conflicted.length > 0);
});

interface Row {
  key: string;
  name: string;
  kind: 'added' | 'updated' | 'removed' | 'conflicted';
}

/** 把单个分节计划抽成四态行 */
function sectionRows<T>(
  sec: NonNullable<PackInstallPlan['sections']['worldBooks']>,
  getKey: (row: T) => string,
  getName: (row: T) => string,
): Row[] {
  return [
    ...sec.added.map((r) => ({
      key: getKey(r as T),
      name: getName(r as T),
      kind: 'added' as const,
    })),
    ...sec.updated.map((r) => ({
      key: getKey(r as T),
      name: getName(r as T),
      kind: 'updated' as const,
    })),
    ...sec.removed.map((r) => ({
      key: getKey(r as T),
      name: getName(r as T),
      kind: 'removed' as const,
    })),
    ...sec.conflicted.map((c) => ({ key: c.key, name: c.name, kind: 'conflicted' as const })),
  ];
}

const KIND_LABEL: Record<Row['kind'], string> = {
  added: '新增',
  updated: '更新',
  removed: '移除',
  conflicted: '需确认覆盖',
};

const KIND_CLASS: Record<Row['kind'], string> = {
  added: 'pk-added',
  updated: 'pk-updated',
  removed: 'pk-removed',
  conflicted: 'pk-conflicted',
};

/** 汇总 diff 用到世界书/预设的 key/name 抽取 */
const wbSection = computed(() => props.plan?.sections.worldBooks);
const preSection = computed(() => props.plan?.sections.presets);

const wbRows = computed<Row[]>(() =>
  wbSection.value
    ? sectionRows<WorldBook>(
        wbSection.value,
        (b) => b.id,
        (b) => b.name,
      )
    : [],
);
const presetRows = computed<Row[]>(() =>
  preSection.value
    ? sectionRows<ChatPreset>(
        preSection.value as unknown as NonNullable<PackInstallPlan['sections']['worldBooks']>,
        (p) => p.id,
        (p) => p.name,
      )
    : [],
);

/** 存档 uid 迁移说明字符串（D43） */
const saveMigText = computed(() => {
  const mig = props.plan?.saveUidMigration;
  if (!mig) return '';
  const n = Object.keys(mig.rewrite ?? {}).length;
  const needsSel = mig.needsSelectionPartitions?.length ?? 0;
  const parts: string[] = [];
  if (n > 0) parts.push(`将把 ${n} 条已建档案的世界书条目按名配对到新内容`);
  if (needsSel > 0)
    parts.push(`有 ${needsSel} 个分区需要你在对应存档里重新选择（键已保留，不会自动删）`);
  return parts.join('；');
});

/** 三类处置记录分组标题 */
function noteTitle(kind: 'dropped' | 'degraded' | 'sideEffect'): string {
  return { dropped: '已丢弃的项', degraded: '受限制退化的项', sideEffect: '附带影响' }[kind] ?? '';
}
</script>

<template>
  <AppModal
    :open="open"
    title="内容包安装预览"
    size="lg"
    @update:open="emit('update:open', $event)"
    @close="emit('cancel')"
  >
    <!-- 升级 diff -->
    <template v-if="upgradeDiff && (upgradeDiff.worldBooks.length || upgradeDiff.presets.length)">
      <h4 class="pk-sec-title">这一版会改什么（升级 diff）</h4>
      <ul class="pk-diff-list">
        <li
          v-for="item in [...upgradeDiff.worldBooks, ...upgradeDiff.presets]"
          :key="item.kind + item.key"
        >
          <span class="pk-badge" :class="KIND_CLASS[item.kind]">{{ KIND_LABEL[item.kind] }}</span>
          <span class="pk-name">{{ item.name }}</span>
        </li>
      </ul>
    </template>

    <!-- 校验失败 -->
    <div v-if="errorMessage" class="pk-error">
      {{ errorMessage }}
    </div>

    <!-- 世界书变化 -->
    <div v-if="wbRows.length">
      <h4 class="pk-sec-title">世界书（{{ wbRows.length }} 项变化）</h4>
      <ul class="pk-change-list">
        <li v-for="row in wbRows" :key="row.kind + row.key">
          <span class="pk-badge" :class="KIND_CLASS[row.kind]">{{ KIND_LABEL[row.kind] }}</span>
          <span class="pk-name">{{ row.name }}</span>
        </li>
      </ul>
    </div>

    <!-- 预设变化 -->
    <div v-if="presetRows.length">
      <h4 class="pk-sec-title">预设（{{ presetRows.length }} 项变化）</h4>
      <ul class="pk-change-list">
        <li v-for="row in presetRows" :key="row.kind + row.key">
          <span class="pk-badge" :class="KIND_CLASS[row.kind]">{{ KIND_LABEL[row.kind] }}</span>
          <span class="pk-name">{{ row.name }}</span>
        </li>
      </ul>
    </div>

    <!-- 存档迁移 -->
    <p v-if="saveMigText" class="pk-note"><strong>存档迁移：</strong>{{ saveMigText }}</p>

    <!-- 处置记录 -->
    <template v-if="plan && plan.notes.length">
      <h4 class="pk-sec-title">处置记录</h4>
      <div v-for="kind in ['dropped', 'degraded', 'sideEffect'] as const" :key="kind">
        <p v-if="plan.notes.some((n: any) => n.kind === kind)" class="pk-note">
          <strong>{{ noteTitle(kind) }}：</strong>
          <span v-for="(n, i) in plan.notes.filter((x: any) => x.kind === kind)" :key="i">
            {{ n.text }}；</span
          >
        </p>
      </div>
    </template>

    <p v-if="hasConflicts" class="pk-warn">
      检测到
      {{
        plan?.sections ? countConflicted(plan) : 0
      }}
      项内容与本地现有数据不一致。覆盖这些项会<b>丢弃本地对这些内容的修改</b>。
    </p>

    <template #footer>
      <AppButton variant="ghost" size="sm" @click="emit('cancel')">取消</AppButton>
      <AppButton variant="primary" size="sm" @click="emit('confirm')"
        >确认{{ hasConflicts ? '覆盖' : '安装' }}</AppButton
      >
    </template>
  </AppModal>
</template>

<script lang="ts">
/** 数一下所有分节的 conflicted 总数（模板里不好写循环） */
function countConflicted(plan: PackInstallPlan): number {
  let n = 0;
  for (const s of Object.values(plan.sections)) {
    if (s && s.conflicted) n += s.conflicted.length;
  }
  return n;
}
</script>

<style scoped>
.pk-sec-title {
  margin: 14px 0 6px;
  font-size: 0.9rem;
  color: var(--theme-text-secondary);
}
.pk-change-list,
.pk-diff-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pk-change-list li,
.pk-diff-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: 0.85rem;
}
.pk-badge {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 0.72rem;
}
.pk-added {
  background: rgba(80, 180, 80, 0.15);
  color: var(--theme-quality-epic, #58c);
}
.pk-updated {
  background: rgba(80, 140, 200, 0.15);
  color: var(--theme-quality-rare, #48c);
}
.pk-removed {
  background: rgba(180, 60, 60, 0.15);
  color: var(--theme-error, #c44);
}
.pk-conflicted {
  background: rgba(230, 170, 40, 0.18);
  color: #caa030;
}
.pk-name {
  flex: 1;
}
.pk-note {
  margin: 8px 0;
  font-size: 0.82rem;
  color: var(--theme-text-muted);
}
.pk-warn {
  margin: 12px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(230, 170, 40, 0.1);
  border: 1px solid rgba(230, 170, 40, 0.3);
  font-size: 0.82rem;
  color: var(--theme-text, inherit);
}
.pk-error {
  margin: 10px 0;
  padding: 10px;
  border-radius: 6px;
  background: rgba(220, 60, 60, 0.1);
  border: 1px solid rgba(220, 60, 60, 0.3);
  color: var(--theme-error, #c44);
  font-size: 0.85rem;
}
</style>
