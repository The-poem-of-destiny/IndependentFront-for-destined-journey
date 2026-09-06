/** Focus ownership for the existing modal shell, including nested dialogs. */
const dialogs: HTMLElement[] = [];
let previousOverflow = '';

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
