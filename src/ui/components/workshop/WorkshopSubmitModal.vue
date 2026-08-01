<script setup lang="ts">
/**
 * 投稿 / 编辑项目 —— 上传到创意工坊（Phase 4 / B4，对齐上游 modals.ts 的上传与编辑弹窗）
 *
 * 这一屏是本应用**唯一**会把内容推到上游的地方，所以它承担三件别处没有的责任:
 *
 * 1. **说清楚这是公开投稿。** 上游有审核，但审核的是「能不能上架」，不是「你有没有
 *    想清楚要公开」。写在按钮上方而不是提交之后。
 *
 * 2. **多步操作要能看见走到哪一步了。** 一次投稿最多是四个请求（建元数据 → 传载荷 →
 *    传正则 → 传封面），中间任何一步都可能失败。只给一个转圈的话，用户在
 *    「传到一半失败」时完全不知道自己现在处于什么状态 —— 而这个状态很要紧:
 *    元数据已经建好了，重来一次会留下第二个空项目。所以每一步都亮出来，
 *    失败时明确告诉他「已经建好的那份在你的项目里，去编辑它继续传」。
 *
 * 3. 🔴 **编辑已发布项目会换 id。** 上游对已过审的项目不原地改，而是开一份草稿并
 *    返回**草稿的 id**（见 `WorkshopWriteAck`）。后续的文件必须传到新 id 上，
 *    传回旧 id 就是在改线上那一版。本组件拿回执里的 id 继续走，绝不复用入参。
 *
 * 网络一律经 `workshop-client`，本组件不碰 fetch。
 */
import { computed, ref, watch } from 'vue';
import {
  createProject,
  invalidateWorkshopProject,
  updateProject,
  uploadProjectCover,
  uploadProjectFile,
} from '../../lib/workshop-client';
import type { WorkshopFailure } from '../../lib/workshop-client';
import { WORKSHOP_BASE_TAGS } from '@engine/workshop-types';
import AppModal from '../shared/AppModal.vue';
import AppButton from '../shared/AppButton.vue';
import { describeFailure } from './failure-text';

const props = defineProps<{
  open: boolean;
  /** 传了就是「编辑」，不传是「新建投稿」 */
  editing?: { id: string; name: string; description: string; version: string; tags: string[] };
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  /** 投稿成功 —— 带上最终落地的 id（可能是草稿 id，见文件头第 3 条） */
  submitted: [projectId: string];
}>();

// ═══ 表单 ═══

const name = ref('');
const description = ref('');
const version = ref('1.0.0');
const tags = ref<string[]>([]);
const payloadFile = ref<File | null>(null);
const regexFile = ref<File | null>(null);
const coverFile = ref<File | null>(null);

const isEditing = computed(() => props.editing !== undefined);

/** 打开时重置 —— 上一次投稿的残留内容出现在新表单里是最糟的一种「贴心」 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const e = props.editing;
    name.value = e?.name ?? '';
    description.value = e?.description ?? '';
    version.value = e?.version ?? '1.0.0';
    tags.value = [...(e?.tags ?? [])];
    payloadFile.value = null;
    regexFile.value = null;
    coverFile.value = null;
    steps.value = [];
    failure.value = null;
    failedAt.value = '';
    landedId.value = '';
  },
);

function toggleTag(tag: string): void {
  tags.value = tags.value.includes(tag)
    ? tags.value.filter((t) => t !== tag)
    : [...tags.value, tag];
}

function pickFile(target: 'payload' | 'regex' | 'cover', event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  input.value = ''; // 不清的话选同一个文件第二次不触发 change
  if (target === 'payload') payloadFile.value = file;
  else if (target === 'regex') regexFile.value = file;
  else coverFile.value = file;
}

// ═══ 提交 ═══

/** 每一步的实时状态 —— 多步操作必须让用户看见走到哪儿了（文件头第 2 条） */
type StepState = 'doing' | 'done';
const steps = ref<{ label: string; state: StepState }[]>([]);
const busy = ref(false);
const failure = ref<WorkshopFailure | null>(null);
/** 失败在哪一步 —— 决定我们该给什么样的善后话 */
const failedAt = ref('');
/** 已经在上游落地的 id（元数据建好之后就有值），失败时要告诉用户去哪儿找它 */
const landedId = ref('');

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (!name.value.trim()) return false;
  // 新建必须带载荷 —— 只建元数据会在工坊里留下一个空项目
  if (!isEditing.value && !payloadFile.value) return false;
  return true;
});

const failureText = computed(() => (failure.value ? describeFailure(failure.value) : ''));

function beginStep(label: string): void {
  steps.value = [...steps.value, { label, state: 'doing' }];
}

function endStep(): void {
  const last = steps.value[steps.value.length - 1];
  if (last) last.state = 'done';
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  busy.value = true;
  failure.value = null;
  failedAt.value = '';
  steps.value = [];

  try {
    // ── 1. 元数据 ──
    beginStep(isEditing.value ? '提交修改' : '创建项目');
    const draft = {
      name: name.value.trim(),
      description: description.value.trim(),
      version: version.value.trim() || '1.0.0',
      tags: tags.value,
    };
    const meta = isEditing.value
      ? await updateProject(props.editing!.id, draft)
      : await createProject(draft);
    if (!meta.ok) {
      failure.value = meta.error;
      failedAt.value = 'meta';
      return;
    }
    endStep();

    // 🔴 后续一律打回执里的 id，不是入参的 id（编辑已发布项目会换成草稿 id）
    const targetId = meta.data.projectId;
    landedId.value = targetId;

    // ── 2. 载荷 ──
    if (payloadFile.value) {
      beginStep('上传世界书文件');
      const res = await uploadProjectFile(targetId, 'payload', payloadFile.value);
      if (!res.ok) {
        failure.value = res.error;
        failedAt.value = 'payload';
        return;
      }
      endStep();
    }

    // ── 3. 正则 ──
    if (regexFile.value) {
      beginStep('上传正则文件');
      const res = await uploadProjectFile(targetId, 'regex', regexFile.value);
      if (!res.ok) {
        failure.value = res.error;
        failedAt.value = 'regex';
        return;
      }
      endStep();
    }

    // ── 4. 封面 ──
    if (coverFile.value) {
      beginStep('上传封面');
      const res = await uploadProjectCover(targetId, coverFile.value, coverFile.value.name);
      if (!res.ok) {
        failure.value = res.error;
        failedAt.value = 'cover';
        return;
      }
      endStep();
    }

    /*
     * ★ 丢掉这个项目的本地缓存再收工。
     *
     * 不丢的话，作者改完标题点进自己的项目，看到的是我们**详情缓存**里那份 5 分钟
     * 前的旧副本 —— 他会以为编辑没生效，然后再改一遍。真机反馈过这一条（2026-08-01）。
     *
     * 编辑走草稿时两个 id 都要丢: 原项目的详情里带着 `hasPendingDraft`，草稿的
     * 详情是刚生出来的。
     */
    invalidateWorkshopProject(targetId);
    if (isEditing.value && props.editing && props.editing.id !== targetId) {
      invalidateWorkshopProject(props.editing.id);
    }

    emit('submitted', targetId);
    emit('update:open', false);
  } finally {
    busy.value = false;
  }
}

/**
 * 失败后的善后话。
 *
 * 元数据那一步失败最简单 —— 什么都没发生，重来即可。**之后**的任何一步失败都不是
 * 「重来一次」能解决的: 项目已经在上游建好了，再走一遍新建流程会留下第二个空项目。
 * 正确的出路是去「我的项目」编辑它、把没传完的文件补上。
 */
const recovery = computed(() => {
  if (!failure.value) return '';
  if (failedAt.value === 'meta') return '什么都还没提交，改完可以直接重试。';
  return `项目已经建在工坊里了（${landedId.value}），但文件没传完。别再走一遍新建 —— 到「我的项目」里编辑它、把文件补传上去。`;
});
</script>

<template>
  <AppModal
    :open="open"
    :title="isEditing ? '编辑项目' : '投稿到创意工坊'"
    size="md"
    @update:open="busy ? undefined : emit('update:open', $event)"
  >
    <div class="wk-submit">
      <label class="wk-field">
        <span class="wk-label">项目名<span class="wk-req">*</span></span>
        <input v-model="name" type="text" class="wk-input" maxlength="100" :disabled="busy" />
      </label>

      <label class="wk-field">
        <span class="wk-label">简介</span>
        <textarea v-model="description" class="wk-input wk-textarea" :disabled="busy"></textarea>
      </label>

      <label class="wk-field">
        <span class="wk-label">版本</span>
        <input v-model="version" type="text" class="wk-input" :disabled="busy" />
      </label>

      <div class="wk-field">
        <span class="wk-label">标签</span>
        <div class="wk-tagpick">
          <button
            v-for="tag in WORKSHOP_BASE_TAGS"
            :key="tag"
            type="button"
            class="wk-tagchip"
            :class="{ 'chip-active': tags.includes(tag) }"
            :aria-pressed="tags.includes(tag)"
            :disabled="busy"
            @click="toggleTag(tag)"
          >
            {{ tag }}
          </button>
        </div>
      </div>

      <label class="wk-field">
        <span class="wk-label">
          世界书文件<span v-if="!isEditing" class="wk-req">*</span>
          <span v-if="isEditing" class="wk-hint">（不选就沿用现有内容）</span>
        </span>
        <input
          type="file"
          accept=".json,application/json"
          class="wk-file"
          :disabled="busy"
          @change="pickFile('payload', $event)"
        />
        <span v-if="payloadFile" class="wk-picked">{{ payloadFile.name }}</span>
      </label>

      <label class="wk-field">
        <span class="wk-label">正则文件<span class="wk-hint">（可选）</span></span>
        <input
          type="file"
          accept=".json,application/json"
          class="wk-file"
          :disabled="busy"
          @change="pickFile('regex', $event)"
        />
        <span v-if="regexFile" class="wk-picked">{{ regexFile.name }}</span>
      </label>

      <label class="wk-field">
        <span class="wk-label">封面图<span class="wk-hint">（可选）</span></span>
        <input
          type="file"
          accept="image/*"
          class="wk-file"
          :disabled="busy"
          @change="pickFile('cover', $event)"
        />
        <span v-if="coverFile" class="wk-picked">{{ coverFile.name }}</span>
      </label>

      <!-- ═══ 进度：每一步都亮出来（文件头第 2 条） ═══ -->
      <ul v-if="steps.length > 0" class="wk-steps">
        <li v-for="(step, i) in steps" :key="i" class="wk-step" :class="`step-${step.state}`">
          <span class="wk-step-mark" aria-hidden="true">{{
            step.state === 'done' ? '✓' : '…'
          }}</span>
          {{ step.label }}
        </li>
      </ul>

      <div v-if="failure" class="wk-submit-failure" role="alert">
        <p class="wk-failure-text">{{ failureText }}</p>
        <p class="wk-failure-recovery">{{ recovery }}</p>
      </div>

      <p class="wk-notice">
        提交即<strong>公开投稿</strong>到创意工坊，经审核后所有人可见。请确认内容不含私人信息，
        且你有权分发其中的素材。
      </p>
    </div>

    <template #footer>
      <AppButton variant="ghost" size="sm" :disabled="busy" @click="emit('update:open', false)">
        取消
      </AppButton>
      <AppButton variant="primary" size="sm" :disabled="!canSubmit" :loading="busy" @click="submit">
        {{ busy ? '提交中…' : isEditing ? '提交修改' : '投稿' }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.wk-submit {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}
.wk-field {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.wk-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
.wk-req {
  margin-left: 2px;
  color: var(--theme-error);
}
.wk-hint {
  margin-left: 4px;
  font-weight: 400;
  color: var(--theme-text-muted);
}
.wk-input {
  min-height: 36px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
  transition: border-color var(--theme-transition-fast);
}
.wk-input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.wk-textarea {
  min-height: 80px;
  resize: vertical;
  line-height: 1.7;
}
.wk-file {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.wk-picked {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

.wk-tagpick {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.wk-tagchip {
  padding: 4px 10px;
  min-height: 26px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.chip-active {
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  color: var(--theme-text-primary);
  font-weight: 600;
}

.wk-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: var(--theme-spacing-md);
  list-style: none;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.wk-step {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}
.step-done {
  color: var(--theme-success);
}
.wk-step-mark {
  width: 1em;
  font-family: 'Cascadia Code', monospace;
}

.wk-submit-failure {
  padding: var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
}
.wk-failure-text {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}
.wk-failure-recovery {
  margin: var(--theme-spacing-xs) 0 0;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--theme-text-secondary);
}

.wk-notice {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.7;
  color: var(--theme-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .wk-input,
  .wk-tagchip {
    transition: none;
  }
}
</style>
