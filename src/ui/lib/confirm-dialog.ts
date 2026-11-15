/**
 * 应用内确认弹窗（Promise 风格）。
 *
 * 用法：`if (!(await confirmDialog({ title, message, danger: true }))) return;`
 * - 确认 → true；取消 / Esc / 点遮罩 / × → false。
 * - 弹窗打开期间的新调用按先进先出排队。
 * - 未挂载宿主（例如单测未挂载 App）时回退到 `window.confirm`，不存在则直接 false。
 * 状态保存在模块级 ref 中，不依赖 Pinia，便于 `vi.mock` 替换。
 */
import { ref, shallowRef } from 'vue';

export interface ConfirmDialogOptions {
  /** 弹窗标题 */
  title: string;
  /** 正文一句话 */
  message: string;
  /** 可选：逐行列出的受影响项 */
  details?: string[];
  /** 确认按钮文案，默认「确定」 */
  confirmLabel?: string;
  /** 取消按钮文案，默认「取消」 */
  cancelLabel?: string;
  /** true 时确认按钮使用危险样式 */
  danger?: boolean;
}

interface ConfirmDialogRequest {
  id: number;
  options: ConfirmDialogOptions;
  resolve: (value: boolean) => void;
}

/** 当前正在展示的请求（宿主组件读取） */
export const activeConfirm = shallowRef<ConfirmDialogRequest | null>(null);

/** 等待中的请求队列 */
const queue: ConfirmDialogRequest[] = [];

/** 已挂载的宿主数量 */
const hostCount = ref(0);

let nextId = 1;

function showNext(): void {
  if (activeConfirm.value) return;
  activeConfirm.value = queue.shift() ?? null;
}

function fallbackConfirm(options: ConfirmDialogOptions): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return false;
  const details = options.details?.length ? `\n${options.details.join('\n')}` : '';
  try {
    return window.confirm(`${options.title}\n${options.message}${details}`);
  } catch {
    return false;
  }
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (hostCount.value <= 0) {
    return Promise.resolve(fallbackConfirm(options));
  }
  return new Promise<boolean>((resolve) => {
    queue.push({ id: nextId++, options, resolve });
    showNext();
  });
}

/** 宿主调用：结束当前请求并展示下一条 */
export function settleConfirm(result: boolean): void {
  const current = activeConfirm.value;
  if (!current) return;
  activeConfirm.value = null;
  current.resolve(result);
  showNext();
}

/** 宿主挂载时注册；返回注销函数。最后一个宿主卸载时，未决请求全部按取消处理。 */
export function registerConfirmHost(): () => void {
  hostCount.value += 1;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    hostCount.value -= 1;
    if (hostCount.value <= 0) {
      hostCount.value = 0;
      const pending = [...(activeConfirm.value ? [activeConfirm.value] : []), ...queue];
      queue.length = 0;
      activeConfirm.value = null;
      for (const req of pending) req.resolve(false);
    }
  };
}

/** 仅测试用：重置模块状态 */
export function __resetConfirmDialogForTests(): void {
  for (const req of queue) req.resolve(false);
  queue.length = 0;
  activeConfirm.value?.resolve(false);
  activeConfirm.value = null;
  hostCount.value = 0;
  nextId = 1;
}
