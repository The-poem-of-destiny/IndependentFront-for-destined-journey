/**
 * fx-sheen.ts — 指针光泽（FxSheen）的纯逻辑与控制器
 *
 * 形态：全应用只有**一个** `.fx-sheen-puck`（盖在悬停的控件上）与**一个** `.fx-sheen-ring`
 * （盖在包住该控件的面板框上、遮罩成 2px 描边环），都住在 FxSheen 的覆盖层里。
 *
 * 性能纪律（与 fx-pointer.ts 同一哲学）：
 * - 控件 / 面板的矩形与圆角**只在进入时量一次**（pointerover 命中新控件、或滚动后的第一次移动），
 *   从不逐帧读布局。
 * - 跟随高光只往 puck / ring **自己**身上写 CSS 变量，经 fx-ticker 合帧；指针不动 = 没有事件 =
 *   零 rAF。🔴 永远不往 html / body 写任何东西。
 * - 只在悬停到控件期间订阅全局指针；离开即退订。触屏指针（pointerType=touch）一律忽略。
 */
import { requestFrame as defaultRequestFrame, type FrameCallback } from './fx-ticker';
import { subscribePointer as defaultSubscribePointer } from './fx-pointer';

/**
 * 会得到光泽的控件：通用按钮、工具栏 / 顶栏 / 输入栏按钮、页签、战斗指令片，
 * 以及任何显式声明 `data-fx-sheen` 的元素（液态玻璃控件就是这些类名本身）。
 */
const SHEEN_CONTROL_SELECTOR = [
  '.app-btn',
  '.tool-btn',
  '.top-btn',
  '.input-btn',
  '.send-btn',
  '.stop-btn',
  '.scene-date-btn',
  '.tab-item',
  '.combat-chip',
  '[data-fx-sheen]',
].join(', ');

/** 承载描边环的面板框（同时是 FxGlint 的候选框） */
export const SHEEN_FRAME_SELECTOR = [
  '.scene-panel',
  '.status-hud',
  '.top-bar',
  '.input-bar',
  '.modal-content',
  '.combat-panel',
].join(', ');

/** 叙事流与回合账本：其中的任何东西都不加光泽 */
const SHEEN_EXCLUDE_SELECTOR = '.chat-flow, .turn-activity';

/** 视口坐标下的盒子 + 圆角（CSS 原值字符串） */
export interface SheenBox {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: string;
}

export interface SheenTarget {
  control: Element;
  frame: Element | null;
}

/** 从事件目标解析出光泽控件及其面板框；不该有光泽时返回 null */
export function findSheenTarget(from: EventTarget | null): SheenTarget | null {
  if (!from || typeof (from as Element).closest !== 'function') return null;
  const control = (from as Element).closest(SHEEN_CONTROL_SELECTOR);
  if (!control) return null;
  if (control.closest(SHEEN_EXCLUDE_SELECTOR)) return null;
  if ((control as HTMLButtonElement).disabled === true) return null;
  if (control.getAttribute('aria-disabled') === 'true') return null;
  const frame = control.closest(SHEEN_FRAME_SELECTOR);
  return { control, frame };
}

type GetStyle = (el: Element) => Pick<CSSStyleDeclaration, 'borderRadius'>;

function defaultGetStyle(el: Element): Pick<CSSStyleDeclaration, 'borderRadius'> {
  return getComputedStyle(el);
}

/** 量一次盒子与圆角。只在进入时调用 */
export function measureBox(el: Element, getStyle: GetStyle = defaultGetStyle): SheenBox {
  const r = el.getBoundingClientRect();
  let radius = '0px';
  try {
    radius = getStyle(el).borderRadius || '0px';
  } catch {
    // 拿不到计算样式（元素已离树等）就按直角处理
  }
  return { x: r.left, y: r.top, w: r.width, h: r.height, radius };
}

/** 指针相对盒子左上角的局部坐标（px，不夹取：高光中心可以落在盒子外，渐变自然衰减） */
export function localPoint(box: SheenBox, px: number, py: number): { x: number; y: number } {
  return { x: px - box.x, y: py - box.y };
}

/** 把盒子摆到覆盖层元素上：只在进入时写一次几何 */
function placeBox(el: HTMLElement, box: SheenBox): void {
  el.style.transform = `translate3d(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px, 0)`;
  el.style.width = `${box.w.toFixed(1)}px`;
  el.style.height = `${box.h.toFixed(1)}px`;
  el.style.borderRadius = box.radius;
}

/** 写跟随高光的位置变量（只写到该元素自己身上） */
function writeSheenPoint(el: HTMLElement, x: number, y: number): void {
  el.style.setProperty('--fx-sheen-x', `${x.toFixed(1)}px`);
  el.style.setProperty('--fx-sheen-y', `${y.toFixed(1)}px`);
}

type PointerSubscriber = (cb: (p: { x: number; y: number }) => void) => () => void;

export interface SheenControllerDeps {
  /** 事件源，缺省 document */
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
  requestFrame?: (cb: FrameCallback) => () => void;
  subscribePointer?: PointerSubscriber;
  getStyle?: GetStyle;
}

export interface SheenController {
  /** 当前高亮的控件（测试与诊断用） */
  current(): Element | null;
  /** 摘掉全部监听、退订指针、取消排着的帧，并隐藏 puck / ring（幂等） */
  dispose(): void;
}

const ACTIVE_CLASS = 'is-active';

/**
 * 建光泽控制器：挂 pointerover / pointerout / scroll / resize 监听，驱动 puck 与 ring。
 * 组件在 onMounted 建、onBeforeUnmount 调 `dispose()`。
 */
export function createSheenController(
  puck: HTMLElement,
  ring: HTMLElement,
  deps: SheenControllerDeps = {},
): SheenController {
  const doc = deps.doc ?? document;
  const raf = deps.requestFrame ?? defaultRequestFrame;
  const subscribe: PointerSubscriber = deps.subscribePointer ?? defaultSubscribePointer;
  const getStyle = deps.getStyle ?? defaultGetStyle;

  let target: SheenTarget | null = null;
  let puckBox: SheenBox | null = null;
  let ringBox: SheenBox | null = null;
  /** 滚动 / 缩放后缓存的矩形作废，下次指针移动时重量一次 */
  let stale = false;
  let unsubscribe: (() => void) | null = null;
  let cancelFrame: (() => void) | null = null;
  let lastX = 0;
  let lastY = 0;
  let disposed = false;

  function measure(): void {
    if (!target) return;
    puckBox = measureBox(target.control, getStyle);
    placeBox(puck, puckBox);
    if (target.frame) {
      ringBox = measureBox(target.frame, getStyle);
      placeBox(ring, ringBox);
      ring.classList.add(ACTIVE_CLASS);
    } else {
      ringBox = null;
      ring.classList.remove(ACTIVE_CLASS);
    }
    stale = false;
  }

  function flush(): void {
    cancelFrame = null;
    if (!target || !puckBox) return;
    if (!target.control.isConnected) {
      deactivate();
      return;
    }
    if (stale) measure();
    const p = localPoint(puckBox, lastX, lastY);
    writeSheenPoint(puck, p.x, p.y);
    if (ringBox) {
      const q = localPoint(ringBox, lastX, lastY);
      writeSheenPoint(ring, q.x, q.y);
    }
  }

  function onPointer(p: { x: number; y: number }): void {
    lastX = p.x;
    lastY = p.y;
    // 合帧：一帧之内多次移动只写一次
    if (cancelFrame === null) cancelFrame = raf(flush);
  }

  function activate(next: SheenTarget, x: number, y: number): void {
    target = next;
    lastX = x;
    lastY = y;
    measure();
    if (puckBox) {
      const p = localPoint(puckBox, x, y);
      writeSheenPoint(puck, p.x, p.y);
    }
    if (ringBox) {
      const q = localPoint(ringBox, x, y);
      writeSheenPoint(ring, q.x, q.y);
    }
    puck.classList.add(ACTIVE_CLASS);
    if (!unsubscribe) unsubscribe = subscribe(onPointer);
  }

  function deactivate(): void {
    target = null;
    puckBox = null;
    ringBox = null;
    stale = false;
    unsubscribe?.();
    unsubscribe = null;
    cancelFrame?.();
    cancelFrame = null;
    puck.classList.remove(ACTIVE_CLASS);
    ring.classList.remove(ACTIVE_CLASS);
  }

  function onOver(ev: Event): void {
    const e = ev as PointerEvent;
    if (e.pointerType === 'touch') return;
    const next = findSheenTarget(e.target);
    if (!next) {
      if (target) deactivate();
      return;
    }
    if (target && next.control === target.control) return;
    activate(next, e.clientX, e.clientY);
  }

  function onOut(ev: Event): void {
    const e = ev as PointerEvent;
    // 指针离开窗口（relatedTarget 为空）才在这里收；控件间移动由 pointerover 接管
    if (e.relatedTarget === null && target) deactivate();
  }

  function onScrollOrResize(): void {
    if (target) stale = true;
  }

  doc.addEventListener('pointerover', onOver, { passive: true });
  doc.addEventListener('pointerout', onOut, { passive: true });
  doc.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  const win = typeof window !== 'undefined' ? window : undefined;
  win?.addEventListener('resize', onScrollOrResize, { passive: true });

  return {
    current: () => target?.control ?? null,
    dispose() {
      if (disposed) return;
      disposed = true;
      deactivate();
      doc.removeEventListener('pointerover', onOver);
      doc.removeEventListener('pointerout', onOut);
      doc.removeEventListener('scroll', onScrollOrResize, { capture: true });
      win?.removeEventListener('resize', onScrollOrResize);
    },
  };
}
