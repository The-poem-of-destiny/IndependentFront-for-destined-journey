export interface PointerParallaxState {
  x: number;
  y: number;
  targetX: number;
  targetY: number;
}

export interface PointerParallaxBinding {
  state: PointerParallaxState;
  dispose(): void;
}

/**
 * Binds the backdrop's parallax input to an interactive ancestor.
 *
 * The canvas layer intentionally uses `pointer-events: none` so it cannot block the home
 * controls. Listening on that layer would therefore leave the parallax targets at zero.
 */
export function bindPointerParallax(
  stage: HTMLElement,
  eventTarget: EventTarget = stage.parentElement ?? window,
): PointerParallaxBinding {
  const state: PointerParallaxState = { x: 0, y: 0, targetX: 0, targetY: 0 };

  const onPointerMove: EventListener = (event) => {
    const pointerEvent = event as PointerEvent;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;

    state.targetX = ((pointerEvent.clientX - bounds.left) / bounds.width - 0.5) * 2;
    state.targetY = ((pointerEvent.clientY - bounds.top) / bounds.height - 0.5) * 2;
  };

  const resetTarget = () => {
    state.targetX = 0;
    state.targetY = 0;
  };

  eventTarget.addEventListener('pointermove', onPointerMove);
  eventTarget.addEventListener('pointerleave', resetTarget);

  return {
    state,
    dispose() {
      eventTarget.removeEventListener('pointermove', onPointerMove);
      eventTarget.removeEventListener('pointerleave', resetTarget);
    },
  };
}
