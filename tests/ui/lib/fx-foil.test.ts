/**
 * fx-foil.ts — 顶级品质箔光
 *
 * 守的是：品质判定沿用 RARITY_LEVELS 顺序（传说及以上）；低品质与闸门关着时零节点；
 * 悬停才亮、离开复位；变量只写在箔光元素自己身上；倾斜不超过 2.5°；品质变化时挂 / 摘。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { defineComponent, h, ref, withDirectives, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { isTopQuality, vFoil, MAX_FOIL_TILT_DEG } from '../../../src/ui/lib/fx-foil';
import { RARITY_LEVELS } from '@engine/content/field-enums';
import { syncFxGate, useFxEnabled } from '../../../src/ui/lib/fx-gate';

function setFx(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-fx', 'on');
  else document.documentElement.removeAttribute('data-fx');
}

function makeHost(quality: { value: string }, tilt?: number) {
  return defineComponent({
    setup() {
      return () =>
        withDirectives(h('div', { class: 'card' }, 'x'), [
          [vFoil, { quality: quality.value, tilt }],
        ]);
    },
  });
}

function pointer(type: string, init: { clientX?: number; clientY?: number; pointerType?: string }) {
  const ev = new Event(type, { bubbles: false }) as Event & Record<string, unknown>;
  Object.assign(ev, { clientX: 0, clientY: 0, pointerType: 'mouse', ...init });
  return ev;
}

function stubRect(el: Element): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 }) as DOMRect;
}

beforeEach(() => {
  // 同步执行帧回调，免得测试里等 rAF
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
});

afterEach(() => {
  setFx(false);
  // 让共享镜像跟回 DOM，免得污染后续用例
  useFxEnabled();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('isTopQuality', () => {
  it('传说 / 神话 / 唯一 为顶级（RARITY_LEVELS 下标 ≥ 4）', () => {
    expect(RARITY_LEVELS.slice(4)).toEqual(['传说', '神话', '唯一']);
    for (const q of ['传说', '神话', '唯一']) expect(isTopQuality(q)).toBe(true);
  });

  it('普通到史诗都不是顶级', () => {
    for (const q of ['普通', '优良', '稀有', '史诗']) expect(isTopQuality(q)).toBe(false);
  });

  it('认得英文别名，认不出的一律 false', () => {
    expect(isTopQuality('legendary')).toBe(true);
    expect(isTopQuality('epic')).toBe(false);
    expect(isTopQuality('???')).toBe(false);
    expect(isTopQuality(undefined)).toBe(false);
    expect(isTopQuality('')).toBe(false);
  });
});

describe('vFoil', () => {
  it('低品质：闸门开着也不加任何箔光节点', () => {
    setFx(true);
    const w = mount(makeHost({ value: '史诗' }, 2.5));
    expect(w.find('.fx-foil').exists()).toBe(false);
    expect(w.element.childElementCount).toBe(0);
  });

  it('闸门关着：顶级品质也不加节点', () => {
    const w = mount(makeHost({ value: '神话' }));
    expect(w.find('.fx-foil').exists()).toBe(false);
  });

  it('顶级品质 + 闸门开：恰好追加一个 aria-hidden 的箔光子元素', () => {
    setFx(true);
    const w = mount(makeHost({ value: '传说' }));
    const foils = w.element.querySelectorAll('.fx-foil');
    expect(foils).toHaveLength(1);
    expect(foils[0].getAttribute('aria-hidden')).toBe('true');
    // 样式只注入一次，且挂在闸门之下
    const styles = document.head.querySelectorAll('style[data-fx-foil-style]');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain(":root[data-fx='on'] .fx-foil");
  });

  it('悬停才亮，指针位置只写在箔光元素的变量上；离开即复位', () => {
    setFx(true);
    const w = mount(makeHost({ value: '唯一' }), { attachTo: document.body });
    const host = w.element as HTMLElement;
    stubRect(host);
    const foil = host.querySelector('.fx-foil') as HTMLElement;
    expect(foil.classList.contains('is-active')).toBe(false);

    host.dispatchEvent(pointer('pointerenter', { clientX: 50, clientY: 25 }));
    expect(foil.classList.contains('is-active')).toBe(true);
    expect(foil.style.getPropertyValue('--foil-x')).toBe('25.0%');
    expect(foil.style.getPropertyValue('--foil-y')).toBe('25.0%');
    expect(host.style.getPropertyValue('--foil-x')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--foil-x')).toBe('');
    // 详情面不传 tilt：宿主不倾斜
    expect(host.style.transform).toBe('');

    host.dispatchEvent(pointer('pointerleave', {}));
    expect(foil.classList.contains('is-active')).toBe(false);
    expect(foil.style.getPropertyValue('--foil-x')).toBe('');
    w.unmount();
  });

  it('触屏指针不激活', () => {
    setFx(true);
    const w = mount(makeHost({ value: '传说' }));
    const host = w.element as HTMLElement;
    stubRect(host);
    host.dispatchEvent(pointer('pointerenter', { pointerType: 'touch' }));
    expect(host.querySelector('.fx-foil')!.classList.contains('is-active')).toBe(false);
  });

  it('倾斜被夹在 2.5° 以内，离开复位', () => {
    setFx(true);
    const w = mount(makeHost({ value: '传说' }, 10));
    const host = w.element as HTMLElement;
    stubRect(host);
    host.dispatchEvent(pointer('pointerenter', { clientX: 200, clientY: 0 }));
    const m = /rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)/.exec(host.style.transform);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]))).toBeLessThanOrEqual(MAX_FOIL_TILT_DEG);
    expect(Math.abs(Number(m![2]))).toBeLessThanOrEqual(MAX_FOIL_TILT_DEG);
    expect(Math.abs(Number(m![2]))).toBe(MAX_FOIL_TILT_DEG);

    host.dispatchEvent(pointer('pointerleave', {}));
    expect(host.style.transform).toBe('');
  });

  it('运行中闸门关闭：不等重渲染就摘掉节点与监听、还原内联样式；再开闸重新挂上', async () => {
    syncFxGate(true);
    const w = mount(makeHost({ value: '传说' }, 2.5), { attachTo: document.body });
    const host = w.element as HTMLElement;
    stubRect(host);
    expect(host.style.position).toBe('relative');
    host.dispatchEvent(pointer('pointerenter', { clientX: 200, clientY: 0 }));
    expect(host.style.transform).not.toBe('');
    const removeSpy = vi.spyOn(host, 'removeEventListener');

    syncFxGate(false);
    await nextTick();
    expect(host.querySelector('.fx-foil')).toBeNull();
    expect(host.style.position).toBe('');
    expect(host.style.transform).toBe('');
    expect(host.style.transition).toBe('');
    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(
      expect.arrayContaining(['pointerenter', 'pointermove', 'pointerleave']),
    );

    syncFxGate(true);
    await nextTick();
    expect(host.querySelectorAll('.fx-foil')).toHaveLength(1);
    w.unmount();
    syncFxGate(false);
  });

  it('卸载后闸门再翻转不会给旧宿主挂节点', async () => {
    syncFxGate(true);
    const w = mount(makeHost({ value: '传说' }));
    const host = w.element as HTMLElement;
    w.unmount();
    syncFxGate(false);
    syncFxGate(true);
    await nextTick();
    expect(host.querySelector('.fx-foil')).toBeNull();
    syncFxGate(false);
  });

  it('品质由顶级变为低级时摘掉箔光，卸载时清理干净', async () => {
    setFx(true);
    const quality = ref('传说');
    const w = mount(makeHost(quality));
    expect(w.element.querySelector('.fx-foil')).not.toBeNull();
    quality.value = '稀有';
    await nextTick();
    expect(w.element.querySelector('.fx-foil')).toBeNull();
    quality.value = '神话';
    await nextTick();
    expect(w.element.querySelectorAll('.fx-foil')).toHaveLength(1);
    const host = w.element as HTMLElement;
    w.unmount();
    expect(host.querySelector('.fx-foil')).toBeNull();
  });
});
