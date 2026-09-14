/** Focus ownership for the existing modal shell, including nested dialogs. */
const dialogs: HTMLElement[] = [];
let previousOverflow = '';

/**
 * 当前是否有打开的对话框。
 *
 * 给「最下层」的快捷键触发器用（游戏菜单的 Esc）：对话框在 `document` 的 **capture**
 * 阶段就把 Esc 吃掉并 `stopImmediatePropagation`，所以浮层开着时下层监听器收不到事件；
 * 但底层监听器若改到 capture 更早的位置（window），就会抢在浮层之前 —— 那时必须自己
 * 问一句「有浮层吗」。问错了的症状不是报错，是「关掉一个弹窗的同时另一个东西弹出来」。
 */
export function hasOpenDialog(): boolean {
  return dialogs.length > 0;
}

function hasHiddenAncestor(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (getComputedStyle(current).display === 'none') return true;
  }
  return false;
}

export function ownModalFocus(dialog: HTMLElement, close: () => void): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!dialogs.length) previousOverflow = document.body.style.overflow;
  dialogs.push(dialog);
  document.body.style.overflow = 'hidden';
  const isTop = () => dialogs[dialogs.length - 1] === dialog;
  const controls = () =>
    [
      ...dialog.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled, [type="hidden"]') &&
        !element.closest('[hidden], [inert]') &&
        !hasHiddenAncestor(element) &&
        getComputedStyle(element).visibility !== 'hidden',
    );
  const focusFirst = () => (controls()[0] ?? dialog).focus();
  function onKeydown(event: KeyboardEvent) {
    if (!isTop()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      const items = controls();
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      if (
        !items.length ||
        !dialog.contains(document.activeElement) ||
        (event.shiftKey
          ? document.activeElement === first || document.activeElement === dialog
          : document.activeElement === last || document.activeElement === dialog)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }
  }
  function onFocus(event: FocusEvent) {
    if (isTop() && !dialog.contains(event.target as Node)) focusFirst();
  }
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocus, true);
  focusFirst();
  return () => {
    const wasTop = isTop();
    dialogs.splice(dialogs.indexOf(dialog), 1);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocus, true);
    if (!dialogs.length) document.body.style.overflow = previousOverflow;
    if (wasTop) {
      if (opener?.isConnected && (!dialogs.length || dialogs[dialogs.length - 1]!.contains(opener)))
        opener.focus();
      else dialogs[dialogs.length - 1]?.focus();
    }
  };
}
