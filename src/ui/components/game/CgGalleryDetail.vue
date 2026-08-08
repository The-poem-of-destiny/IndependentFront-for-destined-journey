<script setup lang="ts">
/**
 * CgGalleryDetail — CG 图鉴的详情栏（§10.3）
 *
 * **纯呈现组件**: 不认识 store、不写库、不铸 URL。所有动作以事件交给
 * `CgGalleryPanel`，图的 object URL 由它传进来（那份引用计数 LRU 只该有一个持有者）。
 *
 * 两处刻意的写法:
 *
 * 1. **标题与说明是双击就地改** —— AI 写的是初值不是定论（D18）。不给「编辑」按钮
 *    是因为这两行绝大多数时候只是被读，常驻按钮会把陈列面变成表单。
 * 2. **场景提示词改完存进 `editedScenePrompt`**（D26）—— 落到那个字段的效果是
 *    「重画时优先用它、且跳过侧链 agent」。原 `scenePrompt` 一个字节都不动，
 *    所以「改回去」永远可行（清空输入框即可）。
 *
 * 3. **装配告警在这里被消费**（图像 v2 / C15）。`ComposedPrompt.warnings` 在 v1 里产出
 *    之后全仓无人读 —— 于是「某个角色在那条方言下没有可用形象，已跳过」这件事对玩家
 *    完全不可见，他只看到画面里少了个人。这一行是它唯一的出口（刻意**不做 toast**：
 *    每张图都会响）。文案与「缺席原因」的判定都在 `cg-gallery.ts`，本组件只渲染。
 */
import { computed, ref, watch } from 'vue';
import AppButton from '../shared/AppButton.vue';
import { composeWarningLines, dialectIdOf, providerLabelOf, soleCharacterOf } from './cg-gallery';
import type { SceneImageRecord } from '@engine/types-image';

const props = defineProps<{
  /** 当前正在看的那一 take */
  record: SceneImageRecord;
  /** 同锚点的全部 take，按 take 升序 */
  takes: SceneImageRecord[];
  /** 大图的 object URL；null = 还没装载好 / 字节已清理 */
  url: string | null;
  /** 有动作在飞（落库 / 入队），按钮转圈 */
  busy?: boolean;
}>();

const emit = defineEmits<{
  selectTake: [id: string];
  updateTitle: [value: string];
  updateDescription: [value: string];
  /** 只存提示词 */
  savePrompt: [value: string];
  /** 存提示词并重画 —— 合成一个事件，免得父组件把两次异步写排错序 */
  saveAndRedraw: [value: string];
  redraw: [];
  pin: [];
  pinSeed: [name: string, seed: number];
  toggleFavorite: [];
  exportImage: [];
  jump: [];
  remove: [];
  close: [];
}>();

// ═══ 就地编辑 ═══

const editingTitle = ref(false);
const editingDesc = ref(false);
const titleDraft = ref('');
const descDraft = ref('');
const promptDraft = ref('');

/** 有效提示词 —— 用户改过就是改过的那份（D26） */
const effectivePrompt = computed(
  () => props.record.editedScenePrompt ?? props.record.scenePrompt ?? '',
);

// 换 take 就把三份草稿重新对齐，编辑态一并收起：
// 上一张的草稿留在框里、又恰好点了保存，写的就是另一张图的说明。
watch(
  () => props.record.id,
  () => {
    editingTitle.value = false;
    editingDesc.value = false;
    promptDraft.value = effectivePrompt.value;
  },
  { immediate: true },
);

function beginTitle(): void {
  titleDraft.value = props.record.title;
  editingTitle.value = true;
}
function commitTitle(): void {
  if (!editingTitle.value) return;
  editingTitle.value = false;
  const next = titleDraft.value.trim();
  if (next !== props.record.title) emit('updateTitle', next);
}
function beginDesc(): void {
  descDraft.value = props.record.description;
  editingDesc.value = true;
}
function commitDesc(): void {
  if (!editingDesc.value) return;
  editingDesc.value = false;
  const next = descDraft.value.trim();
  if (next !== props.record.description) emit('updateDescription', next);
}

const promptDirty = computed(() => promptDraft.value !== effectivePrompt.value);

// ═══ 元数据 ═══

const soleCharacter = computed(() => soleCharacterOf(props.record));
/** 「把这次的 seed 钉给他」的出现条件: 恰好一个角色 **且** 这次真有 seed */
const pinnableSeed = computed<{ name: string; seed: number } | null>(() => {
  const name = soleCharacter.value;
  const seed = props.record.seed;
  if (name === null || typeof seed !== 'number') return null;
  return { name, seed };
});

const dropped = computed(() => props.record.blobDropped === true);
const charactersText = computed(() =>
  props.record.characters.length > 0 ? props.record.characters.join('、') : '—',
);

/**
 * 后端 / 方言（C14）。两者都有「缺席即默认」的读法，判定在 `cg-gallery.ts` ——
 * 老记录没有这两个字段，而它们**全部**是 NAI + danbooru 画的，不是「不知道」。
 */
const providerText = computed(() => providerLabelOf(props.record));
const dialectText = computed(() => dialectIdOf(props.record));

/** 装配告警的中文行（C15）；空数组 = 这一张一切正常，整节不渲染 */
const warningLines = computed(() => composeWarningLines(props.record.composeWarnings));

function sizeText(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeText(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}
</script>

<template>
  <aside class="cg-detail">
    <div class="cg-detail-head">
      <div class="cg-title-line">
        <input
          v-if="editingTitle"
          v-model="titleDraft"
          class="cg-inline-input cg-inline-title"
          aria-label="标题"
          @keydown.enter.prevent="commitTitle"
          @keydown.esc.prevent="editingTitle = false"
          @blur="commitTitle"
        />
        <h4
          v-else
          class="cg-title"
          title="双击可改"
          tabindex="0"
          @dblclick="beginTitle"
          @keydown.enter="beginTitle"
        >
          {{ record.title || '未命名插画' }}
        </h4>
        <button class="cg-close" aria-label="收起详情" @click="emit('close')">×</button>
      </div>
      <textarea
        v-if="editingDesc"
        v-model="descDraft"
        class="cg-inline-input cg-inline-desc"
        rows="2"
        aria-label="说明"
        @keydown.esc.prevent="editingDesc = false"
        @blur="commitDesc"
      ></textarea>
      <p
        v-else
        class="cg-desc"
        title="双击可改"
        tabindex="0"
        @dblclick="beginDesc"
        @keydown.enter="beginDesc"
      >
        {{ record.description || '（双击写一句说明）' }}
      </p>
    </div>

    <!-- 大图 / 已清理占位 —— 🔴 已清理绝不渲染成破图（D47） -->
    <div class="cg-stage" :class="{ 'is-dropped': dropped }">
      <div v-if="dropped" class="cg-dropped">
        <span class="cg-dropped-mark" aria-hidden="true">▨</span>
        <span class="cg-dropped-text">字节已清理</span>
        <span class="cg-dropped-hint">配方（提示词 / seed / 模型）都还在，重画即可</span>
        <AppButton variant="secondary" size="sm" :loading="busy" @click="emit('redraw')">
          重画一张
        </AppButton>
      </div>
      <img v-else-if="url" class="cg-stage-img" :src="url" :alt="record.title || '插画'" />
      <div v-else class="cg-stage-loading">载入中…</div>
    </div>

    <!-- 同一处的多次重画 -->
    <div v-if="takes.length > 1" class="cg-takes" role="group" aria-label="同一处的多张">
      <button
        v-for="(t, i) in takes"
        :key="t.id"
        class="cg-take"
        :class="{ active: t.id === record.id }"
        :title="t.pinned ? '正文里显示的就是这张' : ''"
        @click="emit('selectTake', t.id)"
      >
        第 {{ i + 1 }} 张<span v-if="t.pinned" class="cg-take-pin" aria-label="已钉住">◆</span>
      </button>
    </div>

    <div class="cg-meta">
      <div class="cg-kv">
        <span>回合</span><b>第 {{ record.turn }} 回合</b>
      </div>
      <div class="cg-kv">
        <span>角色</span><b>{{ charactersText }}</b>
      </div>
      <div class="cg-kv">
        <span>模型</span><b>{{ record.model || '—' }}</b>
      </div>
      <!-- 出图后端 / 方言（C14）：缺席读作 novelai + danbooru，不渲染成「未知」 -->
      <div class="cg-kv">
        <span>后端</span><b>{{ providerText }}</b>
      </div>
      <div class="cg-kv">
        <span>方言</span><b :title="dialectText">{{ dialectText }}</b>
      </div>
      <div class="cg-kv">
        <span>seed</span><b>{{ record.seed ?? '随机' }}</b>
      </div>
      <div class="cg-kv">
        <span>大小</span><b>{{ dropped ? '已清理' : sizeText(record.bytes) }}</b>
      </div>
      <div class="cg-kv">
        <span>生成于</span><b>{{ timeText(record.createdAt) }}</b>
      </div>
    </div>

    <!--
      装配告警（C15）—— 画面里为什么少了个人，这里是唯一说得出口的地方。
      不阻断、不惊悚：它陈述一件已经发生的事，措辞按「出图时的方言」写。
    -->
    <p v-for="line in warningLines" :key="line" class="cg-warn">{{ line }}</p>

    <section class="cg-section">
      <h5 class="cg-label">场景提示词</h5>
      <textarea
        v-model="promptDraft"
        class="cg-prompt"
        rows="4"
        aria-label="场景提示词"
        placeholder="改完点「保存并重画」，这一张就按你写的来"
      ></textarea>
      <p class="cg-note">
        改过之后重画会直接用你写的这份，不再跑一次提示词生成。清空即回到原来那份。
      </p>
      <div class="cg-prompt-actions">
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="!promptDirty"
          :loading="busy"
          @click="emit('savePrompt', promptDraft)"
        >
          只保存
        </AppButton>
        <AppButton
          variant="primary"
          size="sm"
          :loading="busy"
          @click="emit('saveAndRedraw', promptDraft)"
        >
          保存并重画
        </AppButton>
      </div>
    </section>

    <section class="cg-section">
      <h5 class="cg-label">这一张</h5>
      <div class="cg-actions">
        <AppButton variant="secondary" size="sm" :loading="busy" @click="emit('redraw')">
          重画
        </AppButton>
        <AppButton
          variant="secondary"
          size="sm"
          :disabled="record.pinned === true"
          :loading="busy"
          @click="emit('pin')"
        >
          {{ record.pinned === true ? '正文显示中' : '钉成正文显示' }}
        </AppButton>
        <AppButton variant="secondary" size="sm" :loading="busy" @click="emit('toggleFavorite')">
          {{ record.favorite === true ? '取消收藏' : '收藏' }}
        </AppButton>
        <AppButton variant="secondary" size="sm" :disabled="!url" @click="emit('exportImage')">
          导出
        </AppButton>
        <AppButton variant="secondary" size="sm" @click="emit('jump')">跳回那条消息</AppButton>
        <AppButton variant="danger" size="sm" :loading="busy" @click="emit('remove')"
          >删除</AppButton
        >
      </div>
    </section>

    <section v-if="pinnableSeed" class="cg-section">
      <h5 class="cg-label">角色一致性</h5>
      <AppButton
        variant="secondary"
        size="sm"
        :loading="busy"
        @click="emit('pinSeed', pinnableSeed.name, pinnableSeed.seed)"
      >
        把这次的 seed 钉给{{ pinnableSeed.name }}
      </AppButton>
      <p class="cg-note">同一 seed 只让构图更接近，不保证同一张脸。</p>
    </section>
  </aside>
</template>

<style scoped>
.cg-detail {
  width: 22rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  overflow-y: auto;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.cg-detail-head {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.cg-title-line {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
}
.cg-title {
  flex: 1;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.4;
  color: var(--theme-text-primary);
  cursor: text;
}
.cg-close {
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 1rem;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  transition: color var(--theme-transition-fast, 0.15s ease);
}
.cg-close:hover {
  color: var(--theme-text-primary);
}
.cg-desc {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
  cursor: text;
}
.cg-inline-input {
  width: 100%;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.8125rem;
  padding: 6px 8px;
}
.cg-inline-title {
  font-family: var(--theme-font-title);
  font-size: 1rem;
}
.cg-inline-desc {
  resize: vertical;
  line-height: 1.6;
}
.cg-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 9rem;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  overflow: hidden;
}
.cg-stage-img {
  max-width: 100%;
  max-height: 20rem;
  display: block;
}
.cg-stage-loading {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
  padding: var(--theme-spacing-lg);
}
.cg-dropped {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-lg);
  text-align: center;
}
.cg-dropped-mark {
  font-size: 1.5rem;
  opacity: 0.35;
}
.cg-dropped-text {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.cg-dropped-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  margin-bottom: var(--theme-spacing-xs);
}
.cg-takes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
.cg-take {
  padding: 4px 10px;
  font-size: 0.6875rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.cg-take:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.cg-take.active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.cg-take-pin {
  margin-left: 4px;
  color: var(--theme-primary);
}
.cg-meta {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 14px;
}
.cg-kv {
  display: flex;
  justify-content: space-between;
  gap: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  line-height: 1.5;
}
.cg-kv span {
  color: var(--theme-text-muted);
}
.cg-kv b {
  color: var(--theme-text-primary);
  font-weight: 500;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 装配告警（C15）—— warning 语义的一句话，不是错误框（图已经画出来了） */
.cg-warn {
  margin: 0;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-warning) 8%, transparent);
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  line-height: 1.6;
}
.cg-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.cg-label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--theme-text-secondary);
}
.cg-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.cg-prompt {
  width: 100%;
  resize: vertical;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  line-height: 1.6;
  padding: 8px;
}
.cg-note {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
}
.cg-prompt-actions,
.cg-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}
</style>
