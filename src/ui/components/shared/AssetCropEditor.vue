<script setup lang="ts">
/**
 * ②-B 裁剪编辑器 —— 一张源图，烘出「立绘 + 头像」两份真字节
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §2 / §5.3 / §7.3 / §7.4
 * 落库端: asset-store 的 `importPortraitPair`（真裁的理由见 lib/image-crop.ts 开头）
 *
 * 📌 住在 `shared/` 而不是 `settings/assets/`: 它有**两个**消费方（素材库的角色抽屉、
 * 游戏页右栏的玩家画像位），而它只认「一份源字节 + 一个名字」，跟设置页零耦合。
 * 放在 settings 下会让 game 页反向依赖设置页目录，是分层倒置。几何算术在
 * `lib/crop-rects.ts`（与 `lib/image-crop.ts` 同一个源图像素坐标系）。
 *
 * 🔴 **这里没有、也永远不该有名字输入框。** 名字是 `name` 这个 prop，由打开编辑器的
 * 那一方给定（角色槽位给角色名，素材库给这条素材已有的名字）。§7.3 明确否决过
 * "导入前的命名表单"，理由是它会成为**第二个命名入口**，必然要把 D16 命名不变式、
 * D19 zip 条目名闸门、§5.3 撞位分配器**再实现一遍** —— 而重复实现正是这套设计
 * 一直在防的漂移来路。**裁剪决定的是像素，从不决定名字。**
 *
 * 两个类型各有一个**三态**开关，与 store 的 {@link PortraitCropSpec} 一一对应，
 * 语义必须照实说:
 *   · 「裁剪」 → 把框（源图像素）交过去，那一半走画布真裁；
 *   · 「整图」 → 传 `'whole'`，那一半**原始字节原样存**，不过画布
 *      （过画布会把动态 WebP 拍成第一帧、把 JPEG 再有损编码一次）；
 *   · 「不生成」 → 传 `'skip'`，那个类型**一行都不写**，库里既有的同类型行原样不动。
 * 两个都选「不生成」= 这次点击什么也不做，store 判为调用方错误 `'no-crops'`；
 * 所以确认按钮在那种组合下直接禁用，不把一个必然失败的请求发出去。
 *
 * 🔴 「不生成」不是可有可无的第三档。这个编辑器同时是**重裁入口**（素材库里对着
 * 一条已有素材点「裁剪」），而重裁立绘时用户几乎从不想再铸一张头像 —— 少了这一档，
 * 每次重裁都会多留一张没人要的头像变体，库按点击次数膨胀。
 *
 * 部分成功如实报（与 store 每一条批量路径同一条纪律）: 立绘存下了、头像没存下时，
 * **绝不报成功**，也绝不把已经落地的那一半撤回来。
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { CropRect } from '../../lib/image-crop';
import {
  useAssetStore,
  type AssetMutationOutcome,
  type PortraitCropSpec,
} from '../../stores/asset-store';
import AppButton from './AppButton.vue';
import AppModal from './AppModal.vue';
import {
  clampRect,
  defaultAvatarRect,
  moveRect,
  previewBackground,
  resizeRect,
  wholeImageRect,
  type CropCorner,
} from '../../lib/crop-rects';

const props = defineProps<{
  open: boolean;
  /** 源图字节。视频到不了这里（调用点负责拦，见 AssetCharacterDrawer） */
  source: File | Blob | null;
  /** 🔴 名字由调用点给定，本组件只读不改 */
  name: string;
  /** 再次编辑时可以带回上次的框；不给就用默认框 */
  initialPortrait?: CropRect;
  initialAvatar?: CropRect;
  /**
   * 源图像素尺寸的**注入缝**，**只在打开那一刻读一次**。缺省时由 `<img>` 的 load
   * 事件量出来（刻意不调 `readImageSize` —— 那要解码整张图，而浏览器为了显示本来
   * 就要解一次）。调用方已经知道尺寸、或测试环境没有真的图片解码时传它。
   */
  sourceSize?: { w: number; h: number };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  /** 两半都落地了才发；带回两个 id 供调用点跳转/高亮 */
  (e: 'saved', ids: { portraitId?: string; avatarId?: string }): void;
  (e: 'announce', message: string): void;
}>();

const assets = useAssetStore();

type Which = 'portrait' | 'avatar';
/** 与 store 的 {@link PortraitCropSpec} 三态一一对应，别在这里多发明一档 */
type Mode = 'crop' | 'whole' | 'skip';

const MODES: readonly Mode[] = ['crop', 'whole', 'skip'];
const MODE_LABEL: Readonly<Record<Mode, string>> = {
  crop: '裁剪',
  whole: '整图',
  skip: '不生成',
};

const CORNERS: readonly CropCorner[] = ['nw', 'ne', 'sw', 'se'];
const CORNER_LABEL: Readonly<Record<CropCorner, string>> = {
  nw: '左上',
  ne: '右上',
  sw: '左下',
  se: '右下',
};
const TYPE_LABEL: Readonly<Record<Which, string>> = { portrait: '立绘', avatar: '头像' };

// ═══ 源图 URL ═════════════════════════════════════════════
// 绝不持久化（§7.5）；换源 / 卸载都要撤销，否则一次次打开编辑器就是一次次泄漏。

const srcUrl = ref('');

function revokeSrc(): void {
  const u = srcUrl.value;
  srcUrl.value = '';
  if (!u) return;
  const URLCtor = (globalThis as { URL?: { revokeObjectURL?: (u: string) => void } }).URL;
  URLCtor?.revokeObjectURL?.(u);
}

function mintSrc(blob: Blob): void {
  const URLCtor = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string } }).URL;
  // 没有 createObjectURL 的环境（node 测试）不是错误 —— 预览缺席，几何照常可用
  srcUrl.value = URLCtor?.createObjectURL?.(blob) ?? '';
}

// ═══ 尺寸与框 ═════════════════════════════════════════════

const imgW = ref(0);
const imgH = ref(0);
const ready = computed(() => imgW.value > 0 && imgH.value > 0);

const portraitRect = ref<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
const avatarRect = ref<CropRect>({ x: 0, y: 0, w: 1, h: 1 });
const portraitMode = ref<Mode>('crop');
const avatarMode = ref<Mode>('crop');
const selected = ref<Which>('avatar');

const busy = ref(false);
/** 失败 / 部分成功的就地说明（不弹 toast：这是这个弹窗自己的事） */
const problem = ref('');

function setSize(w: number, h: number): void {
  if (!(w > 0) || !(h > 0)) return;
  imgW.value = Math.floor(w);
  imgH.value = Math.floor(h);
  resetRects();
}

function resetRects(): void {
  if (!ready.value) return;
  portraitRect.value = props.initialPortrait
    ? clampRect(props.initialPortrait, imgW.value, imgH.value)
    : wholeImageRect(imgW.value, imgH.value);
  avatarRect.value = props.initialAvatar
    ? clampRect(props.initialAvatar, imgW.value, imgH.value, true)
    : defaultAvatarRect(imgW.value, imgH.value);
}

/**
 * `<img>` 量出真实尺寸。
 *
 * 🔴 **只在尺寸真的变了时才重置框**。`sourceSize` 传进来时 `ready` 当场就是 true、
 * 框立刻可拖，而 `load` 事件要晚一拍才到 —— 若无条件 `setSize`，这一拍里用户拉好的
 * 框会被"确认了一遍原来就知道的尺寸"抹掉。尺寸相同 = 没有新信息 = 不该动任何状态。
 *
 * 尺寸**确实**变了（`sourceSize` 给错、或换了源图）时照旧重置: 旧框的坐标是按旧尺寸
 * 算的，留着它反而会给出一个越界的框。
 */
function onImgLoad(e: Event): void {
  const el = e.target as HTMLImageElement | null;
  if (!el) return;
  const w = Math.floor(el.naturalWidth);
  const h = Math.floor(el.naturalHeight);
  if (w === imgW.value && h === imgH.value) return;
  setSize(w, h);
}

/** 每次打开都是全新一轮：模式、提示、忙碌位都归零 */
watch(
  () => [props.open, props.source] as const,
  ([open, source]) => {
    revokeSrc();
    imgW.value = 0;
    imgH.value = 0;
    problem.value = '';
    busy.value = false;
    portraitMode.value = 'crop';
    avatarMode.value = 'crop';
    selected.value = 'avatar';
    if (!open || !source) return;
    mintSrc(source);
    if (props.sourceSize) setSize(props.sourceSize.w, props.sourceSize.h);
  },
  { immediate: true },
);

onUnmounted(revokeSrc);

function rectOf(which: Which): CropRect {
  return which === 'portrait' ? portraitRect.value : avatarRect.value;
}

function setRect(which: Which, next: CropRect): void {
  if (which === 'portrait') portraitRect.value = next;
  else avatarRect.value = next;
}

function modeOf(which: Which): Mode {
  return which === 'portrait' ? portraitMode.value : avatarMode.value;
}

function setMode(which: Which, mode: Mode): void {
  if (which === 'portrait') portraitMode.value = mode;
  else avatarMode.value = mode;
  problem.value = '';
}

function select(which: Which): void {
  selected.value = which;
}

// ═══ 指针拖拽 ═════════════════════════════════════════════
// 位移一律先除以缩放比换回**源图像素**再进几何函数 —— 状态里永远不存屏幕坐标，
// 于是缩放变化（窗口 resize / 主题换字号）不会让已经拉好的框跟着漂。

const stage = ref<HTMLElement | null>(null);

interface DragState {
  which: Which;
  corner?: CropCorner;
  startX: number;
  startY: number;
  base: CropRect;
  scale: number;
}
let drag: DragState | null = null;

function scaleOf(): number {
  const el = stage.value;
  if (!el || imgW.value <= 0) return 1;
  const box = el.getBoundingClientRect();
  return box.width > 0 ? box.width / imgW.value : 1;
}

function onPointerDown(e: PointerEvent, which: Which, corner?: CropCorner): void {
  if (!ready.value || busy.value) return;
  select(which);
  drag = {
    which,
    ...(corner !== undefined ? { corner } : {}),
    startX: e.clientX,
    startY: e.clientY,
    base: rectOf(which),
    scale: scaleOf(),
  };
  const target = e.currentTarget as (Element & { setPointerCapture?: (id: number) => void }) | null;
  target?.setPointerCapture?.(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
}

function onPointerMove(e: PointerEvent): void {
  const d = drag;
  if (!d) return;
  const dx = (e.clientX - d.startX) / d.scale;
  const dy = (e.clientY - d.startY) / d.scale;
  const square = d.which === 'avatar';
  setRect(
    d.which,
    d.corner === undefined
      ? moveRect(d.base, dx, dy, imgW.value, imgH.value, square)
      : resizeRect(d.base, d.corner, dx, dy, imgW.value, imgH.value, square),
  );
}

function endDrag(): void {
  drag = null;
}

// ═══ 键盘 ═════════════════════════════════════════════════
// 框本体按方向键**平移**，角把手按方向键**改尺寸** —— 于是不需要发明
// Alt/Ctrl 组合键（那些在浏览器里多半已经有主人了），四个把手本来就是四个可聚焦元素。

function arrowDelta(key: string): { x: number; y: number } | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 };
    case 'ArrowRight':
      return { x: 1, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -1 };
    case 'ArrowDown':
      return { x: 0, y: 1 };
    default:
      return null;
  }
}

function onRectKey(e: KeyboardEvent, which: Which): void {
  const d = arrowDelta(e.key);
  if (!d || !ready.value) return;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  setRect(
    which,
    moveRect(rectOf(which), d.x * step, d.y * step, imgW.value, imgH.value, which === 'avatar'),
  );
}

function onHandleKey(e: KeyboardEvent, which: Which, corner: CropCorner): void {
  const d = arrowDelta(e.key);
  if (!d || !ready.value) return;
  e.preventDefault();
  e.stopPropagation();
  const step = e.shiftKey ? 10 : 1;
  setRect(
    which,
    resizeRect(
      rectOf(which),
      corner,
      d.x * step,
      d.y * step,
      imgW.value,
      imgH.value,
      which === 'avatar',
    ),
  );
}

// ═══ 样式计算 ═════════════════════════════════════════════

function rectStyle(which: Which): Record<string, string> {
  const r = rectOf(which);
  if (!ready.value) return { display: 'none' };
  return {
    left: `${(r.x / imgW.value) * 100}%`,
    top: `${(r.y / imgH.value) * 100}%`,
    width: `${(r.w / imgW.value) * 100}%`,
    height: `${(r.h / imgH.value) * 100}%`,
  };
}

/** 预览: 「整图」模式下看到的就是整张图，因为那一半存的正是整张图 */
function previewStyle(which: Which): Record<string, string> {
  if (!ready.value || !srcUrl.value) return {};
  const r = modeOf(which) === 'whole' ? wholeImageRect(imgW.value, imgH.value) : rectOf(which);
  const bg = previewBackground(r, imgW.value, imgH.value);
  return {
    backgroundImage: `url("${srcUrl.value}")`,
    backgroundSize: bg.size,
    backgroundPosition: bg.position,
    backgroundRepeat: 'no-repeat',
    aspectRatio: `${r.w} / ${r.h}`,
  };
}

// ═══ 确认 ═════════════════════════════════════════════════

/** 两个都选「不生成」= 这次点击什么也不做，store 判 `'no-crops'`。不发这一枪 */
const bothSkip = computed(() => portraitMode.value === 'skip' && avatarMode.value === 'skip');
const canConfirm = computed(
  () => props.source !== null && ready.value && !busy.value && !bothSkip.value,
);

/** 按钮文案照实说会存几张 —— 一张时写「保存两张」是在骗人 */
const confirmLabel = computed(() => {
  const n = (portraitMode.value === 'skip' ? 0 : 1) + (avatarMode.value === 'skip' ? 0 : 1);
  return n === 1 ? '保存这一张' : '保存两张素材';
});

/**
 * 🔴 **`'busy'` 刻意不在这张表里**（与 StatusOverview 的 `portraitMessage` 同一条纪律）:
 * 互斥闸 `rejectIfBusy()` 自己已经播报过「已有一个导入正在进行，请等它结束。」，
 * 这里再就地写一句就是同一件事说两遍 —— 一条 toast 加一行红字，而用户要做的
 * 只有"等一下"。共用那句对本路径完全成立（要等的确实是同一个闸），所以删的是
 * **本地这句**。`confirm` 拿到 `'busy'` 时直接返回，绝不会走进这个 switch。
 */
function explain(outcome: AssetMutationOutcome): string {
  switch (outcome) {
    case 'no-crops':
      return '两个类型都选了「不生成」，那这次点击什么也不会发生 —— 至少让其中一个生成。';
    case 'naming-invariant':
      return `名称「${props.name}」里不能出现「头像 / 立绘 / 立绘bg」这类类型词，也不能是空名 —— 否则导出再导入时会被解析成另一行。名称要在素材库里改，裁剪这里改不了。`;
    case 'unrepresentable-name':
      return `名称「${props.name}」带了 \`/\`、\`\\\` 或以 \`.\` 开头，进不了导出包的条目名。名称要在素材库里改。`;
    case 'media-rule':
      return '这份字节是视频：视频没法裁剪（画布只取得到某一帧），立绘也不接受 mp4。';
    case 'not-found':
      return '目标素材已经不在库里了。';
    default:
      return '保存失败，可以再试一次；已经存下的那部分不会重复写入。';
  }
}

/** 三态 → store 的三态。**没有"缺省"这条路**，所以这里不可能漏说一个类型 */
function specOf(which: Which): PortraitCropSpec {
  const mode = modeOf(which);
  if (mode === 'skip') return 'skip';
  if (mode === 'whole') return 'whole';
  return rectOf(which);
}

async function confirm(): Promise<void> {
  if (!canConfirm.value || props.source === null) return;
  busy.value = true;
  problem.value = '';
  try {
    const res = await assets.importPortraitPair(props.source, props.name, {
      portrait: specOf('portrait'),
      avatar: specOf('avatar'),
    });

    const saved: string[] = [];
    if (res.portraitId !== undefined) saved.push('立绘');
    if (res.avatarId !== undefined) saved.push('头像');

    if (res.outcome === 'ok') {
      const msg = `已保存「${props.name}」的${saved.join(' 与 ')}。`;
      emit('announce', msg);
      emit('saved', {
        ...(res.portraitId !== undefined ? { portraitId: res.portraitId } : {}),
        ...(res.avatarId !== undefined ? { avatarId: res.avatarId } : {}),
      });
      emit('close');
      return;
    }

    // 互斥闸自己已经播报过了 —— 这里再写一行就是同一件事说两遍（见 `explain` 上方）。
    // 它在任何字节落地**之前**就返回，所以 `saved` 必空，不存在"漏报部分成功"。
    if (res.outcome === 'busy') return;

    // 部分成功**绝不报成功**，也不撤回已经落地的那一半
    problem.value =
      saved.length > 0
        ? `部分成功：${saved.join('、')}已经保存进库里，另一张没能保存 —— ${explain(res.outcome)}已保存的那张留着，不会撤回。`
        : explain(res.outcome);
    emit('announce', problem.value);
  } finally {
    busy.value = false;
  }
}

function close(): void {
  if (busy.value) return;
  emit('close');
}

defineExpose({ portraitRect, avatarRect, portraitMode, avatarMode, problem, canConfirm });
</script>

<template>
  <AppModal :open="open" :title="`裁剪 · ${name}`" size="lg" :closable="!busy" @update:open="close">
    <p class="editor-note">
      从这一张源图切出<b>立绘</b>与<b>头像</b>两份素材，都记在名称「{{ name }}」下。
      名称由打开这个窗口的地方决定，这里只决定画面 —— 要改名请回素材库。
    </p>

    <div class="editor-grid">
      <!-- ═══ 取景台 ═══ -->
      <div class="stage-col">
        <div
          ref="stage"
          class="stage"
          @pointermove="onPointerMove"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <img
            v-if="srcUrl"
            class="stage-img"
            :src="srcUrl"
            :alt="`「${name}」的源图`"
            @load="onImgLoad"
          />
          <div v-else class="stage-blank" role="img" aria-label="源图预览不可用">—</div>

          <template v-if="ready">
            <div
              v-for="which in ['portrait', 'avatar'] as const"
              v-show="modeOf(which) === 'crop'"
              :key="which"
              class="crop-rect"
              :class="[`rect-${which}`, { 'rect-active': selected === which }]"
              :style="rectStyle(which)"
              :data-rect="which"
              tabindex="0"
              role="group"
              :aria-label="`${TYPE_LABEL[which]}裁剪框，方向键移动，Shift 加速；用四角把手改大小`"
              @pointerdown="onPointerDown($event, which)"
              @keydown="onRectKey($event, which)"
              @focus="select(which)"
            >
              <span class="rect-tag">{{ TYPE_LABEL[which] }}</span>
              <button
                v-for="c in CORNERS"
                :key="c"
                type="button"
                class="handle"
                :class="`h-${c}`"
                :data-handle="`${which}-${c}`"
                :aria-label="`${TYPE_LABEL[which]}裁剪框 ${CORNER_LABEL[c]}角，方向键改大小`"
                @pointerdown="onPointerDown($event, which, c)"
                @keydown="onHandleKey($event, which, c)"
                @focus="select(which)"
              />
            </div>
          </template>
        </div>
      </div>

      <!-- ═══ 两个类型各一张卡 ═══ -->
      <div class="side-col">
        <section
          v-for="which in ['portrait', 'avatar'] as const"
          :key="which"
          class="type-card"
          :class="{ 'card-active': selected === which }"
        >
          <h5 class="type-label">{{ TYPE_LABEL[which] }}</h5>

          <div class="mode-switch" role="group" :aria-label="`${TYPE_LABEL[which]}的取材方式`">
            <button
              v-for="m in MODES"
              :key="m"
              type="button"
              class="mode-btn"
              :class="{ 'mode-on': modeOf(which) === m }"
              :aria-pressed="modeOf(which) === m"
              :data-mode="`${which}-${m}`"
              @click="setMode(which, m)"
            >
              {{ MODE_LABEL[m] }}
            </button>
          </div>

          <div
            v-if="modeOf(which) === 'skip'"
            class="preview preview-skip"
            :class="which === 'avatar' ? 'preview-round' : 'preview-box'"
            role="img"
            :aria-label="`不生成${TYPE_LABEL[which]}`"
          >
            —
          </div>
          <div
            v-else
            class="preview"
            :class="which === 'avatar' ? 'preview-round' : 'preview-box'"
            :style="previewStyle(which)"
            role="img"
            :aria-label="`${TYPE_LABEL[which]}效果预览`"
          />

          <p class="type-meta">
            <template v-if="modeOf(which) === 'skip'">
              不生成这个类型；库里已有的{{ TYPE_LABEL[which] }}原样不动。
            </template>
            <template v-else-if="modeOf(which) === 'whole'">
              用整张源图，原始字节原样存（不重新编码）。
            </template>
            <template v-else-if="ready">
              {{ rectOf(which).w }} × {{ rectOf(which).h }} px （自 {{ rectOf(which).x }},
              {{ rectOf(which).y }}）
            </template>
            <template v-else>尚未读到源图尺寸。</template>
          </p>
        </section>
      </div>
    </div>

    <!--
      提示与报错刻意住在两栏**外面**: 它们是整句整段的中文，塞进 14rem 宽的预览栏会被
      挤成一条细长的字带；而两栏本身要贴在一起比对，宽度已经吃紧。
    -->
    <p class="hint">
      拖动框可移动，拖四角改大小；键盘操作时先 Tab 到框上，方向键移动、Shift+方向键快移， Tab
      到角把手上则用方向键改大小。头像框恒定 1:1。
    </p>
    <p v-if="bothSkip" class="field-warn">
      两个都选「不生成」等于这次点击什么也不做 —— 至少让其中一个生成。
    </p>
    <p v-if="problem" class="field-error">{{ problem }}</p>

    <template #footer>
      <AppButton variant="ghost" :disabled="busy" @click="close">取消</AppButton>
      <AppButton variant="primary" class="confirm-btn" :disabled="!canConfirm" @click="confirm">{{
        busy ? '保存中…' : confirmLabel
      }}</AppButton>
    </template>
  </AppModal>
</template>

<style scoped>
.editor-note {
  margin: 0 0 var(--theme-spacing-lg);
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}

/*
 * 取景台与预览栏必须**挨着**: 用户拉一下框、扫一眼旁边那张预览，视线不该横穿一段空白。
 * 之前是 `flex: 1 1 22rem` 的取景栏 + 右侧预览栏，在 modal-xl（1080px）里被拉满整行 ——
 * 而 `.stage` 是 inline-block、图又被 `max-height: 46vh` 卡住高度，于是一张竖构图立绘
 * 只占 ~280px，剩下 ~500px 全是取景栏内部的死区，图贴最左、预览贴最右。
 *
 * 修法两步: ①两栏都**按内容定宽**（不再抢占剩余空间）②整组 `justify-content: center`
 * —— 富余宽度于是被赶到两侧外沿，栏间距恒等于这里写的那一个 token。
 */
.editor-grid {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
/* 按内容定宽（basis:auto）而不是抢剩余空间；宽图时照常被压回栏内 */
.stage-col {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
}
/* 次要角色: 恒定 14rem，绝不跟着取景台一起长 */
.side-col {
  flex: 0 0 14rem;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}

/* ═══ 取景台 ═══ */
.stage {
  position: relative;
  display: inline-block;
  max-width: 100%;
  line-height: 0;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  overflow: hidden;
  touch-action: none;
}
.stage-img {
  display: block;
  max-width: 100%;
  max-height: 46vh;
}
.stage-blank {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 12rem;
  height: 12rem;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--theme-text-muted);
  opacity: 0.5;
}

.crop-rect {
  position: absolute;
  box-sizing: border-box;
  cursor: move;
  /* 全边细线，不用彩色侧边条（design.md §1 禁令） */
  border: 1px solid color-mix(in srgb, var(--theme-primary) 55%, transparent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.rect-portrait {
  border-style: dashed;
}
.rect-avatar {
  border-radius: var(--theme-radius-sm);
}
.rect-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  border-color: var(--theme-primary);
}
.crop-rect:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 55%, transparent);
}
.rect-tag {
  position: absolute;
  top: 2px;
  left: 4px;
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-window-bg) 70%, transparent);
  border-radius: var(--theme-radius-sm);
  padding: 0 4px;
  pointer-events: none;
}

/* 把手是真按钮 —— 于是四个角天生可聚焦、可用方向键改尺寸 */
.handle {
  position: absolute;
  width: 14px;
  height: 14px;
  padding: 0;
  background: var(--theme-primary);
  border: 1px solid var(--theme-primary-text);
  border-radius: var(--theme-radius-sm);
  cursor: nwse-resize;
  transition: filter var(--theme-transition-fast);
}
.handle:hover {
  filter: brightness(1.15);
}
.handle:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 60%, transparent);
}
.h-nw {
  top: -7px;
  left: -7px;
}
.h-ne {
  top: -7px;
  right: -7px;
  cursor: nesw-resize;
}
.h-sw {
  bottom: -7px;
  left: -7px;
  cursor: nesw-resize;
}
.h-se {
  bottom: -7px;
  right: -7px;
}

.hint {
  margin: var(--theme-spacing-lg) 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}

/* ═══ 类型卡 ═══ */
.type-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.card-active {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.type-label {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.type-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.mode-switch {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
.mode-btn {
  flex: 1;
  min-height: 36px;
  background: transparent;
  border: none;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.mode-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.mode-on {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-weight: 600;
  box-shadow: var(--theme-shadow-sm);
}
.mode-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 40%, transparent);
}

.preview {
  align-self: center;
  background-color: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
}
/* 头像**就是**按圆形显示的，预览必须照实圆着看 */
.preview-round {
  width: 5.5rem;
  aspect-ratio: 1 / 1 !important;
  border-radius: var(--theme-radius-full);
}
.preview-box {
  max-width: 100%;
  max-height: 9rem;
  width: auto;
  height: 9rem;
  border-radius: var(--theme-radius-sm);
}
/* 「不生成」保留同样的占位尺寸（版面不跳），但明确画成一个空位而不是一张图 */
.preview-skip {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 5.5rem;
  border-style: dashed;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--theme-text-muted);
  opacity: 0.6;
}

.type-meta {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}

.field-warn,
.field-error {
  margin: var(--theme-spacing-sm) 0 0;
  font-size: 0.75rem;
  line-height: 1.55;
}
.field-warn {
  color: var(--theme-warning);
}
.field-error {
  color: var(--theme-error);
}

/*
 * 窄屏改上下堆叠（768px 是本项目已有的断点，design.md 未另立）。并排到这个宽度以下时，
 * 取景台会被压到只剩一百多像素 —— 那时"挨着比对"已经不成立，不如把整幅宽度还给取景台，
 * 预览整组落到它正下方。两个预览仍然同屏可见，只是改成上下相邻。
 */
@media (max-width: 768px) {
  .editor-grid {
    flex-direction: column;
    align-items: center;
  }
  .side-col {
    flex: 0 0 auto;
    width: min(100%, 18rem);
  }
}

@media (prefers-reduced-motion: reduce) {
  .crop-rect,
  .handle,
  .type-card,
  .mode-btn {
    transition: none;
  }
}
</style>
