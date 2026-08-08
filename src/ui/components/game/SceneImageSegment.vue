<script setup lang="ts">
/**
 * SceneImageSegment.vue — 正文里一格插画的六种样子（设计 §10.2 状态真值表）
 *
 * 本组件**不判定**该显示什么 —— 那是 `scene-image-view.ts` 的纯函数
 * {@link resolveSceneImageView} 的事（尤其那格「无记录 + auto 出按钮而不是去生成」，
 * D15/D21）。这里只负责把判定结果画出来，并把点击转成 store 调用。
 *
 * 三条布局/文案纪律，每条都对应一个真实的糟糕体验:
 *
 * 1. 🔴 **按钮态 / 排队态 / 生成中态占同样高度**（`.si-frame` 的 `min-height`）——
 *    否则每张图落地时整个对话流会往下跳一截，正在读的那一行被推走。
 * 2. 🔴 **占位框里始终写着 title 与 intent**（D37）。5–60 秒的灰框是纯死时间，而
 *    「这张图画的是什么」本来就在记录里 —— 写上去，等待变成期待，成本为零。
 * 3. 🔴 **两种取消的措辞完全不同**（D36）：排队中取消一个字节都没花；在飞中止
 *    上游照样计费，按钮上必须说出来。
 *
 * object URL 走 `composables/useSceneImageUrls.ts`（它自己走 `lib/asset-url.ts` 的
 * 引用计数 LRU）—— **本组件不写第二套铸造/撤销**，也与 CG 图鉴共用同一份缓存。
 *
 * ---
 *
 * **`done` 那一格之内的四件交互**（§10.2 那一行的后半截），三条纪律:
 *
 * 1. 🔴 **打码是「揭开就不再糊回去」**（D46）。`imageBlurByDefault` 只决定**初值**;
 *    揭开之后这一张在本次渲染周期内一直是清晰的，哪怕记录因为改标题/收藏被刷新。
 *    揭开状态**不落库**（每张各自决定，也不跨消息记忆）。
 * 2. 🔴 **角标点击是浏览，不是钉住**。`pinned`（落库、以后每次都显示这张，D45）与
 *    「当前正在看第几张」是两件事，后者只活在本组件的一个 ref 里。
 * 3. 🔴 **悬停菜单必须有非悬停的触发方式** —— 常驻一个 `⋯` 按钮，触摸设备靠它。
 *    只绑 `:hover` 的话这四个动作在手机上根本不存在。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type {
  ImageGenMode,
  ImageRating,
  SceneImageAnchorKind,
  SceneImageMarker,
} from '@engine/types-image';
import { clampRating } from '@engine/image-prompt';
import { hasEffectiveAppearance } from '@engine/character-appearance-resolve';
import { useManualSceneImage } from '../../composables/useManualSceneImage';
import { useSceneImageUrls } from '../../composables/useSceneImageUrls';
import { useSceneImageStore } from '../../stores/scene-image-store';
import { useImagePresetStore } from '../../stores/image-preset-store';
import { useCharacterAppearanceStore } from '../../stores/character-appearance-store';
import { useUIStore } from '../../stores/ui-store';
import AppButton from '../shared/AppButton.vue';
import AppModal from '../shared/AppModal.vue';
import {
  REDRAW_DIALECT_MISMATCH_HINT,
  copyablePromptOf,
  isRedrawDialectMismatch,
  nextTakeId,
} from './scene-image-actions';
import { missingPresetHint, resolveSceneImageView } from './scene-image-view';

const props = withDefaults(
  defineProps<{
    /** 这一格挂在哪条消息上 */
    messageId: string;
    /** 同 anchorKind 内的序号（marker 段的编号来自 splitSceneImageSegments） */
    occurrence: number;
    anchorKind?: SceneImageAnchorKind;
    /** 三档开关。**只影响「无记录」那一行**；缺省 `off` = 这个子系统不存在 */
    mode?: ImageGenMode;
    /** 所属消息的 turn（限额 L3 的同回合去重键） */
    turn?: number;
    /** 标记那一格的元数据；`message-end` 的图带没有标记 */
    marker?: SceneImageMarker | undefined;
    /** 所属消息正文（已剥标记），喂侧链判断氛围/光线/时间 */
    narrative?: string;
    /**
     * rating **上限**（D38），来自 `settings.imageMaxRating`。
     *
     * 🔴 它钳住的是**标记写的** rating —— 玩家把上限设成 `general` 通常有现实原因
     * （在外面玩），而 story agent 写一句 `rating="explicit"` 不该穿透它。
     * 缺省 `general` 与设置默认值同档: 猜错了只是画得保守，反过来是把人推进麻烦里。
     */
    maxRating?: ImageRating;
    /**
     * 打码显示（D46），来自 `settings.imageBlurByDefault`。
     *
     * 🔴 它只是**初值** —— 玩家在某一张上点开之后，那一张在本次渲染周期内不再糊回去
     * （见文件头第 1 条）。缺省 `false` 与设置默认值同档。
     */
    blurByDefault?: boolean;
    /**
     * 当前生效的方言 id（C14），来自 `settings.imageDialectId`。
     *
     * 🔴 只用来决定**重画入口旁边那句提示**：这一格的记录带着手改提示词、而那份手改是
     * 为另一条方言写的时候，重画会逐字沿用它（D26 跳过侧链），产出一张谁也没要的图 ——
     * 而这件事不会报任何错。缺省空串读作内置 danbooru 方言（老记录同档，于是 v1 的图
     * 不会集体挂上这句提示）。
     */
    dialectId?: string;
  }>(),
  {
    anchorKind: 'marker',
    // 🔴 缺省 `off`: 设置项（§11）还没落地之前，渲染层绝不能自己假设功能是开的 ——
    // 「默认关」错了只是少画一张图，「默认开」错了是直接花钱。
    mode: 'off',
    turn: 0,
    marker: undefined,
    narrative: '',
    maxRating: 'general',
    blurByDefault: false,
    dialectId: '',
  },
);

const store = useSceneImageStore();
const presets = useImagePresetStore();
/** 会话副本（D56）—— 只读，用来判断「这个角色到底有没有一致的外貌」。载入归 GamePage */
const sessionAppearance = useCharacterAppearanceStore();
const ui = useUIStore();

// 幂等；放在 setup 而不是 onMounted —— init() 同步就把 loading 置 true，于是
// 「预设还没读完」与「这个角色真的没有预设」在**第一帧**就是可分辨的两件事。
void presets.init();

// ═══ 记录与派生 ═══

const takes = computed(() => store.takesAt(props.messageId, props.anchorKind, props.occurrence));

/**
 * 玩家点角标切到的那一张。**纯浏览态**: 只活在这个 ref 里，一个字节都不落库。
 *
 * 🔴 与 `pinned` 是两件事 —— 后者是 `store.pin()` 写库的结果，决定**以后每次**读到
 * 这条消息看到哪张（D45）。把浏览写成落库，"看一眼上一张"就成了不可见的破坏性操作。
 */
const viewingTakeId = ref<string | null>(null);

const record = computed(() => {
  // 切过之后那张要是没了（被删 / 换了消息），静默退回 displayedAt —— 不留空白格
  const id = viewingTakeId.value;
  if (id !== null) {
    const hit = takes.value.find((r) => r.id === id);
    if (hit) return hit;
  }
  return store.displayedAt(props.messageId, props.anchorKind, props.occurrence);
});

/** 角标 `2/3` 只数**真的画出来了**的那些 —— 失败/排队中的 take 不是一张图 */
const shownTakes = computed(() =>
  takes.value.filter((r) => r.status === 'done' && r.blobDropped !== true),
);

const queuePosition = computed(() => {
  const id = record.value?.id;
  if (id === undefined) return undefined;
  const i = store.queue.indexOf(id);
  return i < 0 ? undefined : i + 1;
});

/**
 * 出场角色里**没有任何可用外貌**的那些（D41）。预设库还在读时报空，不冤枉任何人。
 *
 * 🔴 判据不是「有没有预设行」，而是 `hasEffectiveAppearance`（v1.3）——
 *    AI 即兴出来的外貌住在**会话副本**里，那种角色一行预设都没有却**是**有一致外貌的。
 *    按预设行判会对着他说「这张图里的形象是随机的」，而那句话是假的。判据与装配层
 *    （`composePrompt` 产 `missing-preset` 告警）同源，两处必须给同一个答案。
 */
const missing = computed<string[]>(() => {
  const r = record.value;
  if (!r || presets.loading) return [];
  return r.characters.filter(
    (name) =>
      !hasEffectiveAppearance(presets.find('character', name), sessionAppearance.patchOf(name)),
  );
});

/** 「已用 N 秒」的时钟；只在真的有一张在飞时才走 */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(
  () => record.value?.status === 'generating',
  (on) => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!on) return;
    now.value = Date.now();
    ticker = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  },
  { immediate: true },
);

const view = computed(() =>
  resolveSceneImageView({
    mode: props.mode,
    record: record.value,
    marker: props.marker,
    queuePosition: queuePosition.value,
    now: now.value,
    missingPresets: missing.value,
    takeIndex: shownTakes.value.findIndex((r) => r.id === record.value?.id) + 1,
    takeCount: shownTakes.value.length,
  }),
);

const presetHint = computed(() =>
  view.value.kind === 'done' ? missingPresetHint(view.value.missingPresets) : '',
);

/**
 * 重画入口旁那句方言提示（C14）。**判定在 `scene-image-actions.ts`**，这里只问一次。
 * 非阻断 —— 按钮照常可点，它只是把一件不会报错的事说出来。
 */
const dialectMismatch = computed(() => {
  const r = record.value;
  return r !== undefined && isRedrawDialectMismatch(r, props.dialectId);
});

// ═══ object URL ═══

/**
 * 装载走 `useSceneImageUrls`（它自己走 `lib/asset-url.ts` 的引用计数 LRU）——
 * **本组件不碰第二套铸造/撤销**。图鉴与正文插图共用同一份缓存，同一张图不会
 * 被铸出两条各撤各的 URL。
 */
const urls = useSceneImageUrls({ source: store });

/** 有字节可显示的那一格才取 URL；`dropped` 刻意取不到（它没有字节，不是破图） */
const bytesId = computed(() => (view.value.kind === 'done' ? view.value.recordId : null));

watch(
  bytesId,
  (id) => {
    if (id !== null) urls.load(id);
  },
  { immediate: true },
);

const url = computed(() => (bytesId.value === null ? null : urls.urlFor(bytesId.value)));

onUnmounted(() => {
  if (ticker !== undefined) clearInterval(ticker);
  // URL 的归还由 useSceneImageUrls 的 onScopeDispose 负责，这里只收自己的定时器
});

// ═══ done 态之内的交互（打码 / 切 take / 放大 / 悬停菜单）═══

/**
 * 已经被揭开的那些（D46）。**按记录 id 记，不落库**:
 *
 * - 不落库 —— 打码是「现在这个场合别显示」，不是记录的一个属性。存进去等于把
 *   一次性的遮挡变成一条要维护的状态，而且换台设备就不对了。
 * - 🔴 揭开之后**不再糊回去**（哪怕记录因为改标题/收藏被刷新重画）。反复糊回去
 *   的遮挡不叫隐私保护，叫故障。
 */
const revealed = ref(new Set<string>());

const blurred = computed(() => {
  if (!props.blurByDefault) return false;
  const v = view.value;
  return v.kind === 'done' && !revealed.value.has(v.recordId);
});

const lightboxOpen = ref(false);
/** 悬停菜单的**非悬停**触发（触摸设备靠它；桌面照样能点） */
const menuOpen = ref(false);

/** 图上点一下：还糊着就先揭开，已经看得见才放大 —— 打码不会被一次点击直接跳过 */
function onShotClick(): void {
  const v = view.value;
  if (v.kind !== 'done') return;
  if (blurred.value) {
    // Set 是响应式的（ref 深包装），add 会触发依赖
    revealed.value.add(v.recordId);
    return;
  }
  lightboxOpen.value = true;
}

/** 角标点击 —— 环形前进一张。**浏览，不落库**（见 viewingTakeId） */
function cycleTake(): void {
  const next = nextTakeId(
    shownTakes.value.map((r) => r.id),
    record.value?.id ?? null,
  );
  if (next !== null) viewingTakeId.value = next;
}

/** 悬停菜单里的动作在飞时按钮转圈；与生成用的 `busy` 分开，免得两边互相锁死 */
const actionBusy = ref(false);

async function withBusy(fn: () => Promise<unknown>): Promise<void> {
  if (actionBusy.value) return;
  actionBusy.value = true;
  try {
    await fn();
  } finally {
    actionBusy.value = false;
  }
}

/** 钉住这张（D45）—— 这一条**是**落库动作，与角标浏览相反 */
async function pinThis(): Promise<void> {
  const r = record.value;
  if (!r || r.pinned === true) return;
  await withBusy(async () => {
    await store.pin(r.id);
    ui.toast('正文以后就显示这一张', 'success');
  });
}

async function toggleFavorite(): Promise<void> {
  const r = record.value;
  if (!r) return;
  const next = r.favorite !== true;
  await withBusy(async () => {
    await store.update(r.id, { favorite: next });
    // 收藏顺带是「清理时豁免」的开关（D6），说出来才有人敢用清理
    ui.toast(next ? '已收藏 · 清理时会保留' : '已取消收藏', 'success');
  });
}

/** 复制**这一张实际发出去**的那份提示词（取值判定在 scene-image-actions.ts） */
async function copyPrompt(): Promise<void> {
  const r = record.value;
  if (!r) return;
  const text = copyablePromptOf(r);
  if (text === '') {
    ui.toast('这一张还没有提示词可复制', 'warning');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    ui.toast('提示词已复制', 'success');
  } catch {
    // 剪贴板要权限/要安全上下文，拿不到时说实话，别假装成功
    ui.toast('复制失败，浏览器没有给剪贴板权限', 'error');
  }
}

/** 删除 —— 不可逆，所以先确认（对齐 CgGalleryPanel 的措辞：说清楚会消失什么） */
async function removeThis(): Promise<void> {
  const r = record.value;
  if (!r) return;
  const ok = window.confirm(`删除这一张？\n「${r.title || '未命名插画'}」的图与记录都会消失。`);
  if (!ok) return;
  await withBusy(async () => {
    await store.remove(r.id);
    // 被删的可能正是浏览态钉着的那张，放手让它退回 displayedAt
    if (viewingTakeId.value === r.id) viewingTakeId.value = null;
    lightboxOpen.value = false;
    menuOpen.value = false;
  });
}

// ═══ 动作 ═══

const promptDraft = ref('');
const promptOpen = ref(false);

/**
 * 手动开火那一条路（D24）—— 被限额拦下时**立起确认框而不是弹个 toast 就结束**。
 *
 * 本组件里每一次生成都是手动的（自动档由编排器回调开火，不经过渲染层），所以
 * 三个动作（首次生成 / 重画 / 用自己写的提示词重画）共用同一个 composable。
 */
const {
  busy,
  pending: quotaPending,
  request: requestImage,
  confirm: confirmQuota,
  dismiss: dismissQuota,
} = useManualSceneImage({
  generate: (input) => store.generate(input),
  notify: (message) => ui.toast(message, 'warning'),
});

/** 手动开火 —— 无记录那一格的按钮。**只有这里会新建记录**（自动档由编排器回调开火） */
async function fire(): Promise<void> {
  const saveId = store.activeSaveId;
  if (saveId === null) {
    ui.toast('还没有载入存档，暂时画不了', 'warning');
    return;
  }
  await requestImage({
    saveId,
    messageId: props.messageId,
    turn: props.turn,
    anchorKind: props.anchorKind,
    occurrence: props.occurrence,
    intent: props.marker?.bodyText ?? '',
    title: props.marker?.title ?? '',
    characters: props.marker?.characters ?? [],
    // 🔴 标记写的 rating 在这里就被上限钳住（D38）—— 记录里那个值还会喂给侧链，
    //    只在 composePrompt 里钳的话，上限管得住图、管不住送去侧链的那句话
    rating: clampRating(props.marker?.rating, props.maxRating),
    narrative: props.narrative,
  });
}

/**
 * 重画 / 重试 —— 追加一个 take，源记录一个字节都不动（D17）。
 *
 * `redrawFrom` 让新记录继承 `scenePrompt` / `editedScenePrompt`，于是**不重跑侧链**
 * （D31）：重试一次失败的出图不该再烧一次 LLM token。
 */
async function redraw(): Promise<void> {
  const r = record.value;
  if (!r) return;
  // 🔴 松开浏览态: 不然新 take 排队/生成的那 5–60 秒里，这一格还钉在旧图上，
  //    点了「重画」却什么都没发生 —— 那是最容易让人连点第二次（再花一次钱）的画面
  viewingTakeId.value = null;
  await requestImage({
    saveId: r.saveId,
    messageId: r.messageId,
    turn: r.turn,
    anchorKind: r.anchorKind,
    occurrence: r.occurrence,
    intent: r.intent,
    title: r.title,
    description: r.description,
    characters: r.characters,
    // 重画沿用这一条记录的 rating，但上限可能在这期间被调低了 —— 照样钳一次
    rating: clampRating(r.rating, props.maxRating),
    narrative: props.narrative,
    redrawFrom: r.id,
  });
}

/** 自己写提示词（D42）—— 就地写，不是"去图鉴里填"（失败的记录根本不进图鉴） */
function openPrompt(): void {
  promptDraft.value = record.value?.editedScenePrompt ?? record.value?.scenePrompt ?? '';
  promptOpen.value = true;
}

async function submitPrompt(): Promise<void> {
  const r = record.value;
  const text = promptDraft.value.trim();
  if (!r || text === '') return;
  // 先存进这一条，再以它为源重画 —— 新 take 继承 editedScenePrompt 并跳过侧链
  await store.update(r.id, { editedScenePrompt: text });
  promptOpen.value = false;
  await redraw();
}

async function cancel(): Promise<void> {
  const r = record.value;
  if (!r) return;
  await store.cancel(r.id);
}

/** 缺预设那一行的「去设置」（D41）。角色名预填要等 §11 的图像分区落地 */
function goPresets(): void {
  ui.navigate('settings');
}
</script>

<template>
  <div v-if="view.kind !== 'hidden'" class="scene-image">
    <!-- 无记录 + manual/auto：按钮。🔴 auto 也在这里，绝不自动开火 -->
    <button
      v-if="view.kind === 'offer'"
      type="button"
      class="si-frame si-offer"
      :disabled="busy"
      @click="fire"
    >
      <span class="si-glyph" aria-hidden="true">❖</span>
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-action-label">{{ busy ? '正在排队…' : '生成插画' }}</span>
    </button>

    <!-- 排队中：一个字节都没花，取消是免费的 -->
    <div v-else-if="view.kind === 'queued'" class="si-frame">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-status">队列中 · 第 {{ view.position }} 位</span>
      <AppButton variant="ghost" size="sm" @click="cancel">取消（不消耗）</AppButton>
    </div>

    <!-- 生成中：转圈 + 已用秒数；中止照样计费，按钮上要说出来 -->
    <div v-else-if="view.kind === 'generating'" class="si-frame" aria-busy="true">
      <span class="si-spinner" aria-hidden="true"></span>
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.intent }}</span>
      <span class="si-status">正在生成 · 已用 {{ view.elapsedSec }} 秒</span>
      <AppButton variant="ghost" size="sm" @click="cancel">{{
        view.billsOnAbort ? '中止（本次仍会计费）' : '中止'
      }}</AppButton>
    </div>

    <!-- 画好了 -->
    <figure v-else-if="view.kind === 'done'" class="si-figure">
      <div class="si-canvas">
        <!-- 点击：还糊着 → 揭开；已看得见 → 放大（D46 + §10.2「点击放大」） -->
        <button
          v-if="url"
          type="button"
          class="si-shot"
          :class="{ 'is-blurred': blurred }"
          :aria-label="blurred ? `显示「${view.title}」` : `放大查看「${view.title}」`"
          @click="onShotClick"
        >
          <img :src="url" :alt="view.title" :title="view.description" class="si-img" />
          <span v-if="blurred" class="si-veil">
            <span class="si-veil-glyph" aria-hidden="true">◍</span>
            <span class="si-veil-text">已打码 · 点击显示</span>
          </span>
        </button>
        <div v-else class="si-frame si-loading-bytes">
          <span class="si-title">{{ view.title }}</span>
          <span class="si-status">正在载入图片…</span>
        </div>

        <!-- 多 take 的角标可点 —— 🔴 浏览，不是钉住（D17 / D45） -->
        <button
          v-if="view.takeCount > 1"
          type="button"
          class="si-take"
          :aria-label="`第 ${view.takeIndex} 张，共 ${view.takeCount} 张；点击看下一张`"
          @click="cycleTake"
        >
          {{ view.takeIndex }}/{{ view.takeCount }}
        </button>

        <!-- 悬停菜单。🔴 常驻的 `⋯` 是触摸设备唯一的入口，别删 -->
        <template v-if="url">
          <button
            type="button"
            class="si-more"
            :aria-expanded="menuOpen"
            aria-label="这一张的操作"
            @click="menuOpen = !menuOpen"
          >
            ⋯
          </button>
          <div class="si-menu" :class="{ 'is-open': menuOpen }">
            <button
              type="button"
              class="si-menu-item"
              :disabled="actionBusy || record?.pinned === true"
              @click="pinThis"
            >
              {{ record?.pinned === true ? '正文显示中' : '钉住这张' }}
            </button>
            <button
              type="button"
              class="si-menu-item"
              :disabled="actionBusy"
              @click="toggleFavorite"
            >
              {{ record?.favorite === true ? '取消收藏' : '收藏' }}
            </button>
            <button type="button" class="si-menu-item" @click="copyPrompt">复制提示词</button>
            <button
              type="button"
              class="si-menu-item si-menu-danger"
              :disabled="actionBusy"
              @click="removeThis"
            >
              删除
            </button>
          </div>
        </template>
      </div>
      <figcaption class="si-caption">
        <span class="si-cap-title">{{ view.title }}</span>
        <span v-if="view.description" class="si-cap-desc">{{ view.description }}</span>
      </figcaption>
      <p v-if="presetHint" class="si-hint">
        {{ presetHint }}
        <button type="button" class="si-link" @click="goPresets">去设置</button>
      </p>
    </figure>

    <!-- 字节被清理过（D47）：配方还在，随时能重画。绝不渲染成一张破图 -->
    <div v-else-if="view.kind === 'dropped'" class="si-frame">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-intent">{{ view.description }}</span>
      <span class="si-status">字节已清理</span>
      <!-- C14：手改提示词是为另一方言写的 —— 提示，不阻断（重画照样点得动） -->
      <span v-if="dialectMismatch" class="si-dialect-hint">{{ REDRAW_DIALECT_MISMATCH_HINT }}</span>
      <AppButton variant="secondary" size="sm" :loading="busy" @click="redraw">重画</AppButton>
    </div>

    <!-- 失败：一行可读原因，绝不静默留白 -->
    <div v-else class="si-frame si-failed">
      <span class="si-title">{{ view.title }}</span>
      <span class="si-status si-error">{{ view.message }}</span>
      <!-- C14：同上 —— 重试会逐字沿用那份手改提示词（D26 跳过侧链），说一声 -->
      <span v-if="dialectMismatch" class="si-dialect-hint">{{ REDRAW_DIALECT_MISMATCH_HINT }}</span>
      <div class="si-actions">
        <AppButton
          v-if="view.retryable"
          variant="secondary"
          size="sm"
          :loading="busy"
          @click="redraw"
        >
          重试
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="openPrompt">自己写提示词</AppButton>
      </div>
      <div v-if="promptOpen" class="si-prompt">
        <textarea
          v-model="promptDraft"
          class="si-textarea"
          rows="3"
          placeholder="用 danbooru 标签描述这个画面，例如 tavern interior, warm candlelight, sitting"
        ></textarea>
        <div class="si-actions">
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!promptDraft.trim()"
            @click="submitPrompt"
          >
            用这份提示词重画
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="promptOpen = false">取消</AppButton>
        </div>
      </div>
    </div>

    <!--
      放大查看。🔴 用仓库既有的 `AppModal`（Esc 关闭 / 滚动锁 / 遮罩点击都在里面），
      不另写一个 lightbox —— 那种自研遮罩最后总会漏掉其中一样。
    -->
    <AppModal v-model:open="lightboxOpen" size="xxl" :title="record?.title || '插画'">
      <div class="si-lightbox">
        <img v-if="url" :src="url" :alt="record?.title || '插画'" class="si-lightbox-img" />
        <p v-if="record?.description" class="si-lightbox-desc">{{ record.description }}</p>
      </div>
    </AppModal>

    <!--
      限额确认（D24）—— 手动**永不被拦死**，最多是要确认一下。
      🔴 显示的是 checkQuota 原样给的那句中文: 它已经按「还能继续、只是要确认」的
         口吻写好了，在这里改写会让一个照样点得动的按钮看起来像坏了。
    -->
    <div v-if="quotaPending" class="si-quota" role="alertdialog">
      <span class="si-quota-msg">{{ quotaPending.message }}</span>
      <div class="si-actions">
        <AppButton variant="primary" size="sm" :loading="busy" @click="confirmQuota">
          仍然生成
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="dismissQuota">算了</AppButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene-image {
  margin: var(--theme-spacing-md) 0;
}

/**
 * 🔴 按钮态 / 排队态 / 生成中态共用这一个外壳，于是它们**占同样高度** ——
 * 每张图落地时对话流不会跳。失败/已清理态也走这里，同理。
 */
.si-frame {
  display: flex;
  min-height: 132px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  background: var(--theme-surface-muted);
  gap: var(--theme-spacing-xs);
  text-align: center;
}

.si-offer {
  width: 100%;
  border-color: color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  color: inherit;
  cursor: pointer;
  font: inherit;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}

.si-offer:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 12%, var(--theme-surface-muted));
}

.si-glyph {
  color: var(--theme-primary);
  font-size: 1.25rem;
  opacity: 0.7;
}

.si-title {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  text-indent: 0;
}

.si-intent {
  max-width: 32em;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
  text-indent: 0;
}

.si-status {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}

.si-error {
  color: var(--theme-error);
}

/* C14 方言提示 —— warning 语义（不是 error：图能画，只是可能不是你要的那张） */
.si-dialect-hint {
  max-width: 32em;
  color: var(--theme-warning);
  font-size: 0.6875rem;
  line-height: 1.55;
  text-indent: 0;
}

.si-action-label {
  margin-top: var(--theme-spacing-xs);
  color: var(--theme-primary);
  font-size: 0.75rem;
  font-weight: 600;
}

.si-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--theme-spacing-sm);
}

/* 转圈 —— 减少动态效果时停在原地（全局媒体查询也会兜一层，这里显式写出来） */
.si-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  border-radius: 50%;
  border-top-color: var(--theme-primary);
  animation: si-spin 0.9s linear infinite;
}

@keyframes si-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .si-spinner {
    animation: none;
  }
  .si-offer,
  .si-img,
  .si-take,
  .si-more,
  .si-menu,
  .si-menu-item {
    transition: none;
  }
}

.si-figure {
  margin: 0;
}

.si-canvas {
  position: relative;
}

/* 图本身是个按钮（点击 = 揭开 / 放大），所以要把按钮的默认外观全部抹平 */
.si-shot {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: zoom-in;
  font: inherit;
}

.si-img {
  display: block;
  width: 100%;
  max-height: 60vh;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack, 0 2px 8px rgba(0, 0, 0, 0.15));
  object-fit: contain;
  transition: filter var(--theme-transition-fast, 0.15s ease);
}

/* 打码（D46）—— 缩放一点点是为了不让模糊在边缘露出原图（filter 不是布局属性） */
.si-shot.is-blurred {
  cursor: pointer;
}

.si-shot.is-blurred .si-img {
  filter: blur(22px) saturate(0.7);
  transform: scale(1.03);
}

.si-veil {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: var(--theme-radius-md, 6px);
  background: color-mix(in srgb, var(--theme-window-bg) 45%, transparent);
  gap: var(--theme-spacing-xs);
  pointer-events: none;
}

.si-veil-glyph {
  color: var(--theme-text-secondary);
  font-size: 1.5rem;
  opacity: 0.6;
}

.si-veil-text {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  letter-spacing: 0.04em;
}

.si-loading-bytes {
  width: 100%;
}

.si-take {
  position: absolute;
  right: var(--theme-spacing-sm);
  bottom: var(--theme-spacing-sm);
  min-height: 36px;
  padding: 2px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 60%, transparent);
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-window-bg) 70%, transparent);
  color: var(--theme-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.6875rem;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}

.si-take:hover {
  background: color-mix(in srgb, var(--theme-window-bg) 92%, transparent);
  color: var(--theme-text-primary);
}

/*
 * 🔴 `⋯` 常驻（半透明），这是触摸设备上打开菜单的**唯一**方式 ——
 *    菜单本身既跟 :hover / :focus-within 走，也跟这个按钮的 is-open 走。
 */
.si-more {
  position: absolute;
  top: var(--theme-spacing-sm);
  right: var(--theme-spacing-sm);
  width: 36px;
  height: 36px;
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 60%, transparent);
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-window-bg) 70%, transparent);
  color: var(--theme-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 1rem;
  line-height: 1;
  opacity: 0.65;
  transition:
    opacity var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}

.si-more:hover,
.si-more:focus-visible {
  color: var(--theme-text-primary);
  opacity: 1;
}

.si-menu {
  position: absolute;
  top: calc(var(--theme-spacing-sm) + 40px);
  right: var(--theme-spacing-sm);
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-lg, 0 6px 20px rgba(0, 0, 0, 0.22));
  gap: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--theme-transition-fast, 0.15s ease);
}

.si-canvas:hover .si-menu,
.si-canvas:focus-within .si-menu,
.si-menu.is-open {
  opacity: 1;
  pointer-events: auto;
}

.si-menu-item {
  min-height: 36px;
  padding: 0 var(--theme-spacing-md);
  border: 0;
  border-radius: var(--theme-radius-sm, 4px);
  background: none;
  color: var(--theme-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  white-space: nowrap;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}

.si-menu-item:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.si-menu-item:disabled {
  color: var(--theme-text-muted);
  cursor: default;
}

.si-menu-danger {
  color: var(--theme-error);
}

.si-menu-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
}

.si-lightbox {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-sm);
}

.si-lightbox-img {
  display: block;
  max-width: 100%;
  max-height: 72vh;
  border-radius: var(--theme-radius-md, 6px);
  object-fit: contain;
}

.si-lightbox-desc {
  margin: 0;
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
  line-height: 1.6;
  text-align: center;
  text-indent: 0;
}

.si-caption {
  display: flex;
  flex-direction: column;
  padding: var(--theme-spacing-xs) 0 0;
  gap: 2px;
  text-align: center;
}

.si-cap-title {
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
}

.si-cap-desc {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}

.si-hint {
  margin: var(--theme-spacing-xs) 0 0;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  text-align: center;
  text-indent: 0;
}

.si-link {
  padding: 0 2px;
  border: 0;
  background: none;
  color: var(--theme-primary);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.si-prompt {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

/* 限额确认（D24）—— 一条提醒，不是一堵墙。用 warning 色而非 error */
.si-quota {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 40%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  background: color-mix(in srgb, var(--theme-warning) 8%, var(--theme-surface-muted));
  gap: var(--theme-spacing-sm);
  text-align: center;
}

.si-quota-msg {
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  line-height: 1.55;
  text-indent: 0;
}

.si-textarea {
  width: 100%;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-family: 'Cascadia Code', monospace;
  font-size: 0.75rem;
  resize: vertical;
}
</style>
