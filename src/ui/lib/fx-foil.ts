/**
 * fx-foil.ts — 顶级品质卡片的「箔光」（界面特效 T5 / 第 10 项）
 *
 * `v-foil="{ quality, tilt? }"` 挂在卡片根元素上：
 * - 只有顶级品质（`RARITY_LEVELS` 下标 ≥ 4：传说 / 神话 / 唯一）且特效闸门打开时，
 *   才往宿主里追加**一个**箔光子元素 `.fx-foil`；更低品质**一个节点都不加**。
 * - 箔光是一层低透明度的虹彩渐变，位置跟随指针；指针坐标只写在**箔光元素自己**的
 *   CSS 变量上（`--foil-x` / `--foil-y`），不往宿主或根节点写任何变量。
 * - 只在悬停时亮起，离开即复位。`tilt`（度，上限 2.5）给宿主一点随指针的倾斜，
 *   详情面（ItemDetailBody）不传 —— 只有箔光、不倾斜。
 *
 * 🔴 品质判定**不另建表**：直接按 `RARITY_LEVELS` 的顺序取下标（与 quality-colors 同源）。
 * 🔴 样式表由本模块按需注入一次，规则一律挂在 `:root[data-fx='on']` 下 ——
 *    闸门关着时即使节点残留也零命中。
 * 🔴 每个绑定元素各自盯住闸门（`useFxEnabled()` 共享 ref）：运行中闸门翻转（如系统减动效
 *    偏好切换）时不等宿主重渲染，立刻挂上或摘掉节点、监听并还原内联样式。
 * 🔴 指针坐标只从 `fx-pointer` 的全应用唯一 `pointermove` 拿，帧经 `fx-ticker` 合并
 *    （docs/design.md §6.4 第 3 条）：宿主自己只挂 `pointerenter` / `pointerleave` 两个
 *    边沿监听，悬停期间才订阅指针，离开即退订；不直接调 rAF。
 */
import { watch, type Directive, type DirectiveBinding, type WatchStopHandle } from 'vue';
import { RARITY_LEVELS, normalizeRarity } from '@engine/content/field-enums';
import { isFxEnabled, useFxEnabled } from './fx-gate';
import { subscribePointer } from './fx-pointer';
import { requestFrame } from './fx-ticker';

/** 顶级品质的起点下标：传说 */
const TOP_QUALITY_INDEX = 4;
/** 倾斜上限（度）—— 再大就廉价了 */
export const MAX_FOIL_TILT_DEG = 2.5;

const FOIL_CLASS = 'fx-foil';
const STYLE_ATTR = 'data-fx-foil-style';

/** 品质是否属于顶级（传说 / 神话 / 唯一）。认得别名（legendary 等），认不出一律 false */
export function isTopQuality(quality: string | null | undefined): boolean {
  if (!quality) return false;
  const rarity = normalizeRarity(quality);
  if (!rarity) return false;
  return RARITY_LEVELS.indexOf(rarity) >= TOP_QUALITY_INDEX;
}

export interface FoilOptions {
  quality: string | null | undefined;
  /** 宿主最大倾斜角（度），缺省 0 = 不倾斜；超过 2.5 会被夹到 2.5 */
  tilt?: number;
}

/** 箔光样式（只注入一次）。低透明度、边缘以遮罩淡出、混合模式叠在卡面上 */
const FOIL_CSS = `
:root[data-fx='on'] .${FOIL_CLASS} {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  border-radius: inherit;
  opacity: 0;
  mix-blend-mode: soft-light;
  background:
    radial-gradient(circle at var(--foil-x, 50%) var(--foil-y, 50%), rgba(255, 255, 255, 0.28), transparent 42%),
    linear-gradient(
      115deg,
      transparent 18%,
      hsla(195, 85%, 72%, 0.32) 34%,
      hsla(275, 70%, 76%, 0.3) 46%,
      hsla(40, 90%, 72%, 0.3) 58%,
      hsla(155, 70%, 70%, 0.26) 70%,
      transparent 86%
    );
  background-size: 100% 100%, 240% 240%;
  background-position: center, var(--foil-x, 50%) var(--foil-y, 50%);
  -webkit-mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%);
  mask-image: radial-gradient(ellipse at center, #000 55%, transparent 100%);
  transition: opacity var(--motion-duration-base) var(--motion-ease-standard);
}
:root[data-fx='on'] .${FOIL_CLASS}.is-active {
  opacity: 0.55;
}
`;

function ensureFoilStyles(doc: Document): void {
  if (doc.head.querySelector(`style[${STYLE_ATTR}]`)) return;
  const style = doc.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = FOIL_CSS;
  doc.head.appendChild(style);
}

/** 宿主上挂着的运行时状态（WeakMap 持有，不往元素上加属性） */
interface FoilState {
  foil: HTMLElement;
  tilt: number;
  /** 已排的合并帧（fx-ticker 的取消函数）；没排时为 null */
  cancelFrame: (() => void) | null;
  /** 悬停期间对全局指针源的订阅；不悬停时为 null */
  unsubscribePointer: (() => void) | null;
  pending: { x: number; y: number } | null;
  prevPosition: string;
  prevTransform: string;
  prevTransition: string;
  onEnter: (e: PointerEvent) => void;
  onLeave: () => void;
}

const states = new WeakMap<HTMLElement, FoilState>();

function clampTilt(tilt: number | undefined): number {
  if (typeof tilt !== 'number' || !Number.isFinite(tilt) || tilt <= 0) return 0;
  return Math.min(tilt, MAX_FOIL_TILT_DEG);
}

/** 停掉悬停期间的一切：退订指针、撤掉已排的帧、丢弃待落的位置 */
function stopTracking(state: FoilState): void {
  state.unsubscribePointer?.();
  state.unsubscribePointer = null;
  state.cancelFrame?.();
  state.cancelFrame = null;
  state.pending = null;
}

/** 把一次指针位置落到箔光变量（与宿主倾斜）上 */
function applyPointer(host: HTMLElement, state: FoilState, x: number, y: number): void {
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const px = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
  const py = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
  state.foil.style.setProperty('--foil-x', `${(px * 100).toFixed(1)}%`);
  state.foil.style.setProperty('--foil-y', `${(py * 100).toFixed(1)}%`);
  if (state.tilt > 0) {
    const rx = ((0.5 - py) * 2 * state.tilt).toFixed(2);
    const ry = ((px - 0.5) * 2 * state.tilt).toFixed(2);
    host.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  }
}

function attach(host: HTMLElement, tilt: number): void {
  const doc = host.ownerDocument;
  ensureFoilStyles(doc);
  const foil = doc.createElement('span');
  foil.className = FOIL_CLASS;
  foil.setAttribute('aria-hidden', 'true');

  /** 记下最新指针位置；本帧还没排就经 fx-ticker 排一帧（同帧多次移动只落最后一次） */
  function queuePointer(x: number, y: number): void {
    if (!foil.classList.contains('is-active')) return;
    state.pending = { x, y };
    if (state.cancelFrame !== null) return;
    state.cancelFrame = requestFrame(() => {
      state.cancelFrame = null;
      const p = state.pending;
      state.pending = null;
      if (p && foil.classList.contains('is-active')) applyPointer(host, state, p.x, p.y);
    });
  }

  const state: FoilState = {
    foil,
    tilt,
    cancelFrame: null,
    unsubscribePointer: null,
    pending: null,
    prevPosition: host.style.position,
    prevTransform: host.style.transform,
    prevTransition: host.style.transition,
    onEnter: (e) => {
      if (e.pointerType === 'touch' || !isFxEnabled()) return;
      foil.classList.add('is-active');
      if (state.tilt > 0) {
        host.style.transition = 'transform var(--motion-duration-fast) var(--motion-ease-standard)';
      }
      queuePointer(e.clientX, e.clientY);
      // 悬停期间才订阅全局指针源（全应用唯一的 pointermove），离开即退订
      if (state.unsubscribePointer === null) {
        state.unsubscribePointer = subscribePointer((p) => queuePointer(p.x, p.y));
      }
    },
    onLeave: () => {
      stopTracking(state);
      foil.classList.remove('is-active');
      foil.style.removeProperty('--foil-x');
      foil.style.removeProperty('--foil-y');
      if (state.tilt > 0) host.style.transform = state.prevTransform;
    },
  };

  // 箔光绝对定位要一个包含块；宿主若是 static 才补 relative（不改布局）
  const computed = doc.defaultView?.getComputedStyle(host).position ?? '';
  if (computed === '' || computed === 'static') host.style.position = 'relative';

  host.appendChild(foil);
  host.addEventListener('pointerenter', state.onEnter);
  host.addEventListener('pointerleave', state.onLeave);
  states.set(host, state);
}

function detach(host: HTMLElement): void {
  const state = states.get(host);
  if (!state) return;
  stopTracking(state);
  host.removeEventListener('pointerenter', state.onEnter);
  host.removeEventListener('pointerleave', state.onLeave);
  state.foil.remove();
  host.style.position = state.prevPosition;
  host.style.transform = state.prevTransform;
  host.style.transition = state.prevTransition;
  states.delete(host);
}

/** 按当前绑定值决定挂 / 摘 / 更新倾斜 */
function sync(host: HTMLElement, value: FoilOptions | null | undefined): void {
  const want = Boolean(value) && isTopQuality(value?.quality) && isFxEnabled();
  const existing = states.get(host);
  if (!want) {
    if (existing) detach(host);
    return;
  }
  const tilt = clampTilt(value?.tilt);
  if (existing) {
    if (existing.tilt !== tilt) {
      existing.onLeave();
      existing.tilt = tilt;
    }
    return;
  }
  attach(host, tilt);
}

/** 每个绑定元素的闸门订阅：记下最近一次绑定值，闸门翻转时按它重新同步 */
interface GateBinding {
  value: FoilOptions | null | undefined;
  stop: WatchStopHandle;
}

const gateBindings = new WeakMap<HTMLElement, GateBinding>();

function bindGate(host: HTMLElement, value: FoilOptions | null | undefined): void {
  const existing = gateBindings.get(host);
  if (existing) {
    existing.value = value;
    return;
  }
  const entry: GateBinding = { value, stop: () => {} };
  entry.stop = watch(useFxEnabled(), () => sync(host, entry.value));
  gateBindings.set(host, entry);
}

function unbindGate(host: HTMLElement): void {
  gateBindings.get(host)?.stop();
  gateBindings.delete(host);
}

/** 箔光指令。`v-foil="{ quality: '传说', tilt: 2.5 }"` */
export const vFoil: Directive<HTMLElement, FoilOptions | null | undefined> = {
  mounted(el, binding: DirectiveBinding<FoilOptions | null | undefined>) {
    bindGate(el, binding.value);
    sync(el, binding.value);
  },
  updated(el, binding) {
    bindGate(el, binding.value);
    sync(el, binding.value);
  },
  beforeUnmount(el) {
    unbindGate(el);
    detach(el);
  },
};
