<script setup lang="ts">
/**
 * 审核面板 —— 管理员专属（Phase 4 / B5，对齐上游 modals.ts 的审核/管理员/日志三个弹窗）
 *
 * 上游把这三样分成三个入口，我们合成一个带 Tab 的面板: 它们的使用者是同一个人、
 * 在同一件事（治理工坊）上下文里，分三个按钮只是让顶栏更挤。
 *
 * 🔴 **权限的唯一真相在服务端。** 本组件读 JWT 里的 `isAdmin` / `isSuperAdmin`
 * 只为决定「画不画这个入口 / 画哪几个 Tab」——省得普通用户对着一个必然 403 的按钮。
 * 真正的门禁是上游那几行 `if (!payload.isAdmin) return 403`，那是用户改不动的。
 * 谁把这里的判断当成安全边界，谁就把权限交给了一个 localStorage 值。
 *
 * 审核是**不可逆**的（通过即上架、驳回即打回），所以驳回必须填理由 —— 理由会落到
 * 项目行上，作者在「我的项目」里看得到（`describeReviewState` 旁边那一行）。
 * 不给理由的驳回等于让作者去猜。
 */
import { computed, ref, watch } from 'vue';
import {
  listAdminLogs,
  listAdmins,
  listPendingProjects,
  reviewProject,
  setAdmin,
} from '../../lib/workshop-client';
import type {
  WorkshopAdminLog,
  WorkshopAdminUser,
  WorkshopFailure,
} from '../../lib/workshop-client';
import type { WorkshopProjectMeta } from '@engine/workshop-types';
import { useWorkshopSocialStore } from '../../stores/workshop-social-store';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import { describeFailure } from './failure-text';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  notify: [message: string, kind: 'success' | 'error'];
}>();

const social = useWorkshopSocialStore();
/** 超管才有的两个 Tab（上游对这两个端点额外做了 isSuperAdmin 校验） */
const isSuperAdmin = computed(() => social.user?.isSuperAdmin === true);

type AdminTab = 'pending' | 'admins' | 'logs';
const tab = ref<AdminTab>('pending');
const TABS = computed<{ value: AdminTab; label: string }[]>(() => [
  { value: 'pending', label: '待审核' },
  ...(isSuperAdmin.value
    ? ([
        { value: 'admins' as const, label: '管理员' },
        { value: 'logs' as const, label: '操作日志' },
      ] satisfies { value: AdminTab; label: string }[])
    : []),
]);

const pending = ref<WorkshopProjectMeta[]>([]);
const admins = ref<WorkshopAdminUser[]>([]);
const logs = ref<WorkshopAdminLog[]>([]);
const loading = ref(false);
const failure = ref<WorkshopFailure | null>(null);
/** 正在处理的项目 id —— 审核期间禁掉那一行的两个按钮，防重复提交 */
const busyId = ref('');
/** 驳回理由，按项目 id 存 —— 同时展开两条时不会互相串词 */
const reasons = ref<Record<string, string>>({});
const newAdminId = ref('');

const failureText = computed(() => (failure.value ? describeFailure(failure.value) : ''));

async function load(): Promise<void> {
  loading.value = true;
  failure.value = null;
  try {
    if (tab.value === 'pending') {
      const res = await listPendingProjects();
      if (!res.ok) {
        failure.value = res.error;
        return;
      }
      pending.value = res.data.projects;
    } else if (tab.value === 'admins') {
      const res = await listAdmins();
      if (!res.ok) {
        failure.value = res.error;
        return;
      }
      admins.value = res.data;
    } else {
      const res = await listAdminLogs();
      if (!res.ok) {
        failure.value = res.error;
        return;
      }
      logs.value = res.data;
    }
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);
watch(tab, () => {
  if (props.open) void load();
});

async function review(projectId: string, action: 'approve' | 'reject'): Promise<void> {
  const reason = (reasons.value[projectId] ?? '').trim();
  // 驳回必须给理由 —— 不给的话作者只能看到一个「已被拒绝」，无从改起
  if (action === 'reject' && !reason) {
    emit('notify', '驳回要填理由，作者才知道该改什么。', 'error');
    return;
  }

  busyId.value = projectId;
  try {
    const res = await reviewProject(projectId, action, reason);
    if (!res.ok) {
      emit('notify', `操作失败：${describeFailure(res.error)}`, 'error');
      return;
    }
    emit('notify', action === 'approve' ? '已通过' : '已驳回', 'success');
    // 处理完的从队列里去掉，不等一次整体重拉 —— 队列长时那一下重拉很慢
    pending.value = pending.value.filter((p) => p.id !== projectId);
  } finally {
    busyId.value = '';
  }
}

async function changeAdmin(userId: string, makeAdmin: boolean): Promise<void> {
  busyId.value = userId;
  try {
    const res = await setAdmin(userId, makeAdmin);
    if (!res.ok) {
      emit('notify', `操作失败：${describeFailure(res.error)}`, 'error');
      return;
    }
    emit('notify', makeAdmin ? '已授予管理员' : '已撤销管理员', 'success');
    newAdminId.value = '';
    await load();
  } finally {
    busyId.value = '';
  }
}
</script>

<template>
  <AppModal :open="open" title="工坊审核" size="lg" @update:open="emit('update:open', $event)">
    <div class="wk-admin">
      <div class="wk-admin-tabs" role="group" aria-label="审核面板分区">
        <button
          v-for="t in TABS"
          :key="t.value"
          type="button"
          class="wk-admin-tab"
          :class="{ 'tab-active': tab === t.value }"
          :aria-pressed="tab === t.value"
          @click="tab = t.value"
        >
          {{ t.label }}
        </button>
      </div>

      <p v-if="loading" class="wk-admin-hint">正在取…</p>

      <p v-else-if="failure" class="wk-admin-failure" role="alert">
        {{ failureText }}
      </p>

      <!-- ═══ 待审核 ═══ -->
      <template v-else-if="tab === 'pending'">
        <p v-if="pending.length === 0" class="wk-admin-hint">队列是空的，没有待审核的项目。</p>
        <ul v-else class="wk-admin-list">
          <li v-for="p in pending" :key="p.id" class="wk-admin-row">
            <div class="wk-admin-main">
              <span class="wk-admin-name">{{ p.name }}</span>
              <span class="wk-admin-sub">{{ p.authorName || '佚名' }} · v{{ p.version }}</span>
              <p v-if="p.description" class="wk-admin-desc">{{ p.description }}</p>
              <ul v-if="p.tags.length > 0" class="wk-admin-tags">
                <li v-for="tg in p.tags" :key="tg" class="wk-admin-tag">{{ tg }}</li>
              </ul>
            </div>
            <div class="wk-admin-actions">
              <input
                v-model="reasons[p.id]"
                type="text"
                class="wk-admin-reason"
                placeholder="驳回理由（驳回必填）"
                :disabled="busyId === p.id"
              />
              <AppButton
                variant="primary"
                size="sm"
                :disabled="busyId === p.id"
                @click="review(p.id, 'approve')"
              >
                通过
              </AppButton>
              <AppButton
                variant="danger"
                size="sm"
                :disabled="busyId === p.id"
                @click="review(p.id, 'reject')"
              >
                驳回
              </AppButton>
            </div>
          </li>
        </ul>
      </template>

      <!-- ═══ 管理员 ═══ -->
      <template v-else-if="tab === 'admins'">
        <div class="wk-admin-add">
          <input
            v-model="newAdminId"
            type="text"
            class="wk-admin-reason"
            placeholder="Discord 用户 id"
          />
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!newAdminId.trim() || busyId !== ''"
            @click="changeAdmin(newAdminId.trim(), true)"
          >
            授予管理员
          </AppButton>
        </div>
        <p v-if="admins.length === 0" class="wk-admin-hint">还没有其他管理员。</p>
        <ul v-else class="wk-admin-list">
          <li v-for="a in admins" :key="a.id" class="wk-admin-row">
            <div class="wk-admin-main">
              <span class="wk-admin-name">{{ a.globalName || a.username }}</span>
              <span class="wk-admin-sub">{{ a.id }}</span>
            </div>
            <div class="wk-admin-actions">
              <AppButton
                variant="danger"
                size="sm"
                :disabled="busyId === a.id"
                @click="changeAdmin(a.id, false)"
              >
                撤销
              </AppButton>
            </div>
          </li>
        </ul>
      </template>

      <!-- ═══ 操作日志 ═══ -->
      <template v-else>
        <p v-if="logs.length === 0" class="wk-admin-hint">还没有操作记录。</p>
        <ul v-else class="wk-admin-list">
          <li v-for="l in logs" :key="l.id" class="wk-admin-logrow">
            <span class="wk-admin-time">{{ l.createdAt }}</span>
            <span class="wk-admin-name">{{ l.actorName }}</span>
            <span class="wk-admin-sub">{{ l.action }} · {{ l.targetType }}</span>
            <span v-if="l.detail" class="wk-admin-desc">{{ l.detail }}</span>
          </li>
        </ul>
      </template>
    </div>

    <template #footer>
      <AppButton variant="ghost" size="sm" @click="emit('update:open', false)">关闭</AppButton>
      <AppButton variant="secondary" size="sm" :disabled="loading" @click="load">刷新</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.wk-admin {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

.wk-admin-tabs {
  display: flex;
  gap: var(--theme-spacing-xs);
}
.wk-admin-tab {
  padding: 5px 12px;
  min-height: 28px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.tab-active {
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  color: var(--theme-text-primary);
  font-weight: 600;
}

.wk-admin-hint {
  margin: 0;
  padding: var(--theme-spacing-xl) 0;
  text-align: center;
  font-size: 0.8125rem;
  font-style: italic;
  color: var(--theme-text-muted);
}
.wk-admin-failure {
  margin: 0;
  padding: var(--theme-spacing-lg);
  text-align: center;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}

.wk-admin-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 440px;
  overflow-y: auto;
}
.wk-admin-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.wk-admin-logrow {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  font-size: 0.75rem;
}
.wk-admin-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.wk-admin-name {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.wk-admin-sub,
.wk-admin-time {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.wk-admin-desc {
  margin: 2px 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.wk-admin-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: var(--theme-spacing-xs) 0 0;
  padding: 0;
  list-style: none;
}
.wk-admin-tag {
  padding: 1px 7px;
  border-radius: var(--theme-radius-full);
  background: var(--theme-surface-muted);
  font-size: 0.625rem;
  color: var(--theme-text-secondary);
}

.wk-admin-actions,
.wk-admin-add {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}
.wk-admin-reason {
  min-height: 30px;
  min-width: 180px;
  padding: 4px var(--theme-spacing-sm);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.75rem;
}
.wk-admin-reason:focus {
  outline: none;
  border-color: var(--theme-primary);
}

@media (prefers-reduced-motion: reduce) {
  .wk-admin-tab {
    transition: none;
  }
}
</style>
