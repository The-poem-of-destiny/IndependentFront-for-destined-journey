/**
 * FxGlint — 偶发闪光层的组件行为
 *
 * 选框 / 选边 / 关键帧的纯逻辑由 `tests/ui/lib/fx-glint.test.ts` 钉住；结构与样式的基本契约在
 * `FxSheen.test.ts`。这里钉组件挂上之后的**行为**：
 * - crimson 主题下到点也不划光（运行器跳过，不只是靠样式藏起来）；
 * - 每次到点只播一次、不循环（动画不带 iterations，播完轨道藏回去，下一次靠重排而不是循环）；
 * - 卸载即停排期、取消在播的动画、藏起轨道。
 *
 * jsdom 没有 `element.animate` 也不排版：给 Element 原型装一个可观察的 animate 替身，
 * 再给候选面板框一个可见的矩形。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import FxGlint from '../../../../src/ui/components/fx/FxGlint.vue';
import { GLINT_DURATION_MS, GLINT_MAX_MS } from '../../../../src/ui/lib/fx-glint';

interface FakeAnimation {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancel: ReturnType<typeof vi.fn>;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

const root = document.documentElement;
let wrapper: VueWrapper | null = null;
let animations: FakeAnimation[] = [];
const originalAnimate = (Element.prototype as { animate?: unknown }).animate;

function addVisibleFrame() {
  const panel = document.createElement('div');
  panel.className = 'scene-panel';
  panel.getBoundingClientRect = () =>
    ({ left: 100, top: 100, width: 400, height: 300, right: 500, bottom: 400 }) as DOMRect;
  document.body.appendChild(panel);
  return panel;
}

function mountGlint() {
  wrapper = mount(FxGlint, { attachTo: document.body });
  return wrapper;
}

const track = () => document.querySelector<HTMLElement>('.fx-glint-track')!;

beforeEach(() => {
  vi.useFakeTimers();
  animations = [];
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      const anim: FakeAnimation = {
        keyframes,
        options,
        onfinish: null,
        oncancel: null,
        cancel: vi.fn(() => anim.oncancel?.()),
      };
      animations.push(anim);
      return anim;
    },
  });
  root.setAttribute('data-fx', 'on');
  addVisibleFrame();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  if (originalAnimate === undefined) {
    delete (Element.prototype as { animate?: unknown }).animate;
  } else {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: originalAnimate,
    });
  }
  document.body.innerHTML = '';
  root.removeAttribute('data-fx');
  root.removeAttribute('data-theme');
});

describe('FxGlint — 主题', () => {
  it('非 crimson 主题：到点沿可见面板框划一次光', () => {
    root.setAttribute('data-theme', 'obsidian');
    mountGlint();
    vi.advanceTimersByTime(GLINT_MAX_MS);
    expect(animations).toHaveLength(1);
    expect(track().hidden).toBe(false);
  });

  it('crimson 主题：到点跳过，不起动画，轨道一直藏着', () => {
    root.setAttribute('data-theme', 'crimson');
    mountGlint();
    vi.advanceTimersByTime(GLINT_MAX_MS * 3);
    expect(animations).toHaveLength(0);
    expect(track().hidden).toBe(true);
    // 跳过不等于停：排期仍在，换回别的主题后下一次照常
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('FxGlint — 不循环', () => {
  it('单次动画：约 900ms、不带 iterations、首尾透明；播完轨道藏回去', () => {
    root.setAttribute('data-theme', 'ivory');
    mountGlint();
    vi.advanceTimersByTime(GLINT_MAX_MS);
    expect(animations).toHaveLength(1);
    const [anim] = animations;
    expect(anim.options.duration).toBe(GLINT_DURATION_MS);
    expect(anim.options.iterations ?? 1).toBe(1);
    expect(anim.keyframes[0].opacity).toBe(0);
    expect(anim.keyframes[anim.keyframes.length - 1].opacity).toBe(0);

    anim.onfinish?.();
    expect(track().hidden).toBe(true);
  });

  it('在播期间到点不叠第二道；下一次靠重排而不是循环', () => {
    root.setAttribute('data-theme', 'ivory');
    mountGlint();
    vi.advanceTimersByTime(GLINT_MAX_MS);
    expect(animations).toHaveLength(1);
    // 第一道还没播完：下一次到点被跳过
    vi.advanceTimersByTime(GLINT_MAX_MS);
    expect(animations).toHaveLength(1);

    animations[0].onfinish?.();
    vi.advanceTimersByTime(GLINT_MAX_MS);
    expect(animations).toHaveLength(2);
  });
});

describe('FxGlint — 卸载清理', () => {
  it('卸载即清掉定时器、取消在播的动画、藏起轨道', () => {
    root.setAttribute('data-theme', 'obsidian');
    mountGlint();
    vi.advanceTimersByTime(GLINT_MAX_MS);
    const el = track();
    expect(el.hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    wrapper?.unmount();
    wrapper = null;
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(el.hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(GLINT_MAX_MS * 2);
    expect(animations).toHaveLength(1);
  });

  it('没有在播动画时卸载也只是停排期', () => {
    mountGlint();
    expect(vi.getTimerCount()).toBe(1);
    wrapper?.unmount();
    wrapper = null;
    expect(vi.getTimerCount()).toBe(0);
    expect(animations).toHaveLength(0);
  });
});
