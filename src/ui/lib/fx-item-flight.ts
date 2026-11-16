/**
 * fx-item-flight.ts — 物品入包的「飞入」（界面特效 T5 / 第 11 项）
 *
 * 新推入的一条「获得物品」系统消息（`item_gen` / `craft`）出现时，一道细光沿弧线从
 * 最后一条系统消息行（`.bubble-row-system`，缺席或不在可见区则取对话区底部中点）飞向侧栏背包按钮
 * （`.tool-btn[data-tool='items']`），落地后按钮图标轻轻一缩一弹（0.9 → 1.04 → 1）。
 *
 * - `arcKeyframes(from, to, steps)`：纯函数，给 WAAPI 的关键帧（单测覆盖）。
 * - `createItemFlight(deps)`：执行器。以下任一成立就**整个跳过**（不建任何节点）：
 *   闸门关、标签页隐藏、目标不在 / 不可见、`element.animate` 不存在、已有一次在飞。
 *   同一时间至多一次飞行 —— 一阵连发只飞一次（在飞时的请求直接合并掉）。
 *
 * 🔴 只读 DOM、只往覆盖层里放一个临时节点；不碰 store，也不改任何数据。
 */
import type { ChatMessage } from '@engine/types/types';
import { isFxEnabled as defaultIsFxEnabled } from './fx-gate';

export interface FlightPoint {
  x: number;
  y: number;
}

/** 物品入包类的系统事件：生成物品 / 制作产物 */
const ITEM_GAIN_EVENT_TYPES: ReadonlySet<string> = new Set(['item_gen', 'craft']);

/** 这条消息是否是一次「获得物品」的系统通知 */
export function isItemGainMessage(msg: Pick<ChatMessage, 'role' | 'systemEvent'>): boolean {
  return (
    msg.role === 'system' && !!msg.systemEvent && ITEM_GAIN_EVENT_TYPES.has(msg.systemEvent.type)
  );
}

/** 飞行时长（ms） */
export const FLIGHT_DURATION_MS = 700;
/** 落地后图标挤压时长（ms） */
const SQUEEZE_DURATION_MS = 360;
/** 弧线拱起上限（px）：距离再远也不拱得更高 */
const MAX_ARC_LIFT = 160;

/**
 * 二次贝塞尔弧线上的关键帧。控制点在起止连线中点、沿法线**朝上**偏出
 * `min(160, 距离 × 0.35)`；每帧带 `translate` + 沿切线的 `rotate`（光条顺着轨迹指向），
 * 透明度两头为 0、中段最亮。
 *
 * @param steps 关键帧数（至少 2；非整数向下取整）
 */
export function arcKeyframes(from: FlightPoint, to: FlightPoint, steps: number): Keyframe[] {
  const n = Math.max(2, Math.floor(Number.isFinite(steps) ? steps : 2));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const lift = Math.min(MAX_ARC_LIFT, dist * 0.35);

  // 法线取朝上（屏幕 y 向下，所以选 y 分量为负的那一支）
  let nx = 0;
  let ny = -1;
  if (dist > 0) {
    nx = -dy / dist;
    ny = dx / dist;
    if (ny > 0 || (ny === 0 && nx > 0)) {
      nx = -nx;
      ny = -ny;
    }
  }
  const cx = (from.x + to.x) / 2 + nx * lift;
  const cy = (from.y + to.y) / 2 + ny * lift;

  const frames: Keyframe[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * cx + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * cy + t * t * to.y;
    // 切线：B'(t) = 2(1-t)(C-P0) + 2t(P1-C)
    const tx = 2 * u * (cx - from.x) + 2 * t * (to.x - cx);
    const ty = 2 * u * (cy - from.y) + 2 * t * (to.y - cy);
    const angle = tx === 0 && ty === 0 ? 0 : (Math.atan2(ty, tx) * 180) / Math.PI;
    const opacity = i === 0 || i === n - 1 ? 0 : Math.sin(Math.PI * t) ** 0.6;
    frames.push({
      offset: t,
      transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle.toFixed(1)}deg)`,
      opacity: Number(opacity.toFixed(3)),
    });
  }
  return frames;
}

/** 落地挤压：0.9 → 1.04 → 1 */
const SQUEEZE_KEYFRAMES: Keyframe[] = [
  { transform: 'scale(1)', offset: 0 },
  { transform: 'scale(0.9)', offset: 0.3 },
  { transform: 'scale(1.04)', offset: 0.7 },
  { transform: 'scale(1)', offset: 1 },
];

const FLIGHT_TARGET_SELECTOR = ".tool-btn[data-tool='items']";
const FLIGHT_SOURCE_SELECTOR = '.bubble-row-system';
const CHAT_FALLBACK_SELECTOR = '.chat-flow';
const STREAK_CLASS = 'fx-flight-streak';

type FlightResult =
  'started' | 'fx-off' | 'hidden' | 'no-overlay' | 'no-target' | 'no-animate' | 'busy';

export interface ItemFlightDeps {
  /** 承载光条的覆盖层（FxItemFlight 的根元素） */
  getOverlay: () => HTMLElement | null;
  doc?: Document;
  isFxEnabled?: () => boolean;
}

export interface ItemFlight {
  /** 请求一次飞行；返回启动结果或跳过原因 */
  request(): FlightResult;
  isBusy(): boolean;
  /** 立即中止在飞的动画并清掉临时节点（卸载时调） */
  dispose(): void;
}

function centreOf(rect: DOMRect): FlightPoint {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function isVisibleRect(rect: DOMRect | undefined): rect is DOMRect {
  return !!rect && rect.width > 0 && rect.height > 0;
}

/** 两个矩形是否有面积大于零的交集 */
function intersects(a: DOMRect, b: DOMRect): boolean {
  return (
    Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
  );
}

/**
 * 起点：最后一条系统消息行的中心 —— 但只在它与视口**且**（有对话区时）对话区可见矩形相交时才用；
 * 已滚出视野的行（玩家正往上翻旧消息）会让光条从屏幕外飞进来，此时退回对话区底部中点；
 * 对话区也缺席则取视口底部中点。
 */
function resolveSource(doc: Document): FlightPoint {
  const view = doc.defaultView;
  const w = view?.innerWidth ?? 0;
  const h = view?.innerHeight ?? 0;
  const viewport = { left: 0, top: 0, right: w, bottom: h } as DOMRect;
  const chatRect = doc.querySelector<HTMLElement>(CHAT_FALLBACK_SELECTOR)?.getBoundingClientRect();
  const chatVisible = isVisibleRect(chatRect) ? chatRect : null;

  const rows = doc.querySelectorAll<HTMLElement>(FLIGHT_SOURCE_SELECTOR);
  const last = rows.length > 0 ? rows[rows.length - 1] : null;
  const rowRect = last?.getBoundingClientRect();
  if (
    isVisibleRect(rowRect) &&
    intersects(rowRect, viewport) &&
    (!chatVisible || intersects(rowRect, chatVisible))
  ) {
    return centreOf(rowRect);
  }

  if (chatVisible) {
    return { x: chatVisible.left + chatVisible.width / 2, y: chatVisible.bottom - 24 };
  }
  return { x: w / 2, y: h - 24 };
}

function isTabHidden(doc: Document): boolean {
  return doc.visibilityState === 'hidden' || doc.hidden === true;
}

export function createItemFlight(deps: ItemFlightDeps): ItemFlight {
  const isFxOn = deps.isFxEnabled ?? defaultIsFxEnabled;
  const getDoc = () => deps.doc ?? (typeof document !== 'undefined' ? document : undefined);

  let busy = false;
  let streak: HTMLElement | null = null;
  const running = new Set<Animation>();

  function track(anim: Animation, done: () => void): void {
    running.add(anim);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      running.delete(anim);
      done();
    };
    // 老实现可能没有 `finished`（类型上恒在，运行时未必），退回事件回调
    const finished = anim.finished as Promise<Animation> | undefined;
    if (finished !== undefined) {
      finished.then(finish, finish);
    } else {
      anim.onfinish = finish;
      anim.oncancel = finish;
    }
  }

  function clearStreak(): void {
    streak?.remove();
    streak = null;
  }

  function squeeze(target: HTMLElement): void {
    const icon = target.querySelector<HTMLElement>('i') ?? target;
    if (typeof icon.animate !== 'function') {
      busy = false;
      return;
    }
    const anim = icon.animate(SQUEEZE_KEYFRAMES, {
      duration: SQUEEZE_DURATION_MS,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    });
    track(anim, () => {
      busy = false;
    });
  }

  function request(): FlightResult {
    if (busy) return 'busy';
    if (!isFxOn()) return 'fx-off';
    const doc = getDoc();
    if (!doc || isTabHidden(doc)) return 'hidden';
    const overlay = deps.getOverlay();
    if (!overlay) return 'no-overlay';
    const target = doc.querySelector<HTMLElement>(FLIGHT_TARGET_SELECTOR);
    const targetRect = target?.getBoundingClientRect();
    if (!target || !isVisibleRect(targetRect)) return 'no-target';

    const el = doc.createElement('span');
    el.className = STREAK_CLASS;
    if (typeof el.animate !== 'function') return 'no-animate';

    const frames = arcKeyframes(resolveSource(doc), centreOf(targetRect), 16);
    busy = true;
    streak = el;
    overlay.appendChild(el);
    const anim = el.animate(frames, {
      duration: FLIGHT_DURATION_MS,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'forwards',
    });
    track(anim, () => {
      if (streak !== el) return; // 已被 dispose
      clearStreak();
      // 落地时目标可能已被卸载（切页 / 折叠）：不再挤压，直接收尾
      if (!target.isConnected) {
        busy = false;
        return;
      }
      squeeze(target);
    });
    return 'started';
  }

  function dispose(): void {
    for (const anim of [...running]) anim.cancel();
    running.clear();
    clearStreak();
    busy = false;
  }

  return {
    request,
    isBusy: () => busy,
    dispose,
  };
}
