/**
 * App.fx-gate.test.ts — 界面特效闸门在 App.vue 里的接线
 *
 * 闸门判据（设置开 且 不减动效）由 `tests/ui/lib/fx-gate.test.ts` 钉住；「谁在什么时候调 syncFxGate」
 * 是**接线**问题，只有挂上 App 才证明得了：
 * - 设置 `visualEffects` 与应用内 `reducedMotion` 变化时 `<html data-fx>` 跟着开 / 关，FxLayer 跟着挂 / 卸；
 * - 减动效 watch 排在闸门 watch 之前（同一拍里同时改两项也不会用上一拍的减动效状态开闸）；
 * - 系统 `prefers-reduced-motion` 不经过设置，靠 matchMedia 的 change 监听重算；
 * - 卸载时摘掉监听并关闸。
 *
 * 其余 store / 页面 / 宿主组件全部替身：本测只关心闸门这一条线。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

const { settingsState, stub } = vi.hoisted(() => ({
  settingsState: { visualEffects: true, reducedMotion: false } as Record<string, unknown>,
  /** 宿主组件替身：vi.mock 工厂被提升到 import 之前，所以在工厂里按需取 vue */
  stub: async (name: string, cls = name) => {
    const { defineComponent, h } = await import('vue');
    return { default: defineComponent({ name, render: () => h('div', { class: cls }) }) };
  },
}));

vi.mock('../../src/ui/stores/settings-store', async () => {
  const { reactive: r } = await import('vue');
  const store = {
    settings: r(settingsState),
    initApiSecrets: () => Promise.resolve({ status: 'ok' }),
  };
  return { useSettingsStore: () => store };
});
vi.mock('../../src/ui/stores/ui-store', () => ({
  useUIStore: () => ({ currentView: 'home', activeSaveId: null, toast: vi.fn() }),
}));
vi.mock('../../src/ui/stores/audio-store', () => ({
  useAudioStore: () => ({ init: () => Promise.resolve(), playByScene: () => Promise.resolve() }),
}));
vi.mock('../../src/ui/stores/asset-store', () => ({
  useAssetStore: () => ({ init: () => Promise.resolve() }),
}));
vi.mock('../../src/ui/stores/api-source-store', () => ({
  useApiSourceStore: () => ({ initialize: () => Promise.resolve() }),
}));
vi.mock('../../src/ui/stores/worldbook-store', () => ({ useWorldBookStore: () => ({}) }));
vi.mock('../../src/ui/stores/beautifier-store', () => ({
  useBeautifierStore: () => ({ init: () => Promise.resolve() }),
}));
vi.mock('../../src/ui/stores/workshop-store', () => ({ useWorkshopStore: () => ({}) }));
vi.mock('../../src/ui/lib/content-startup-chain', () => ({
  runContentStartupChain: () => Promise.resolve(),
}));
vi.mock('../../src/ui/lib/view-audio', () => ({ queryForView: () => null }));
vi.mock('../../src/ui/lib/view-loader', () => ({
  createViewRegistry: () => ({
    ensure: () => Promise.resolve(),
    prefetch: () => () => {},
    resolved: () => undefined,
    failed: () => false,
  }),
}));
vi.mock('../../src/ui/components/shared/ViewLoading.vue', () =>
  stub('ViewLoading', 'view-loading'),
);
vi.mock('../../src/ui/components/shared/ToastContainer.vue', () => stub('ToastContainer'));
vi.mock('../../src/ui/components/shared/ConfirmDialogHost.vue', () => stub('ConfirmDialogHost'));
vi.mock('../../src/ui/components/shared/ApiRateLimitWaitPopup.vue', () =>
  stub('ApiRateLimitWaitPopup'),
);
vi.mock('../../src/ui/components/shared/SaveManager.vue', () => stub('SaveManager'));
vi.mock('../../src/ui/components/fx/FxLayer.vue', () => stub('FxLayer', 'fx-layer-stub'));

import App from '../../src/ui/App.vue';
import { useSettingsStore } from '../../src/ui/stores/settings-store';

/** 可控的 `prefers-reduced-motion` 媒体查询替身 */
const systemMotion = reactive({ matches: false });
let listeners: Array<() => void> = [];
const mediaQuery = {
  get matches() {
    return systemMotion.matches;
  },
  media: '(prefers-reduced-motion: reduce)',
  addEventListener: vi.fn((_type: string, cb: () => void) => {
    listeners.push(cb);
  }),
  removeEventListener: vi.fn((_type: string, cb: () => void) => {
    listeners = listeners.filter((l) => l !== cb);
  }),
};

function setSystemReducedMotion(on: boolean) {
  systemMotion.matches = on;
  for (const cb of [...listeners]) cb();
}

const root = document.documentElement;
const gate = () => root.getAttribute('data-fx');
let wrapper: VueWrapper | null = null;

function mountApp() {
  wrapper = mount(App, { attachTo: document.body });
  return wrapper;
}

const settings = () => useSettingsStore().settings as Record<string, unknown>;
const hasFxLayer = () => wrapper?.find('.fx-layer-stub').exists() ?? false;

beforeEach(() => {
  settingsState.visualEffects = true;
  settingsState.reducedMotion = false;
  settings().visualEffects = true;
  settings().reducedMotion = false;
  systemMotion.matches = false;
  listeners = [];
  mediaQuery.addEventListener.mockClear();
  mediaQuery.removeEventListener.mockClear();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQuery),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  root.removeAttribute('data-fx');
  root.removeAttribute('data-reduced-motion');
});

describe('App 特效闸门 — 应用内设置', () => {
  it('visualEffects 开、无减动效：开闸并挂上 FxLayer', () => {
    mountApp();
    expect(gate()).toBe('on');
    expect(hasFxLayer()).toBe(true);
  });

  it('visualEffects 关：不开闸；运行中打开即开闸', async () => {
    settings().visualEffects = false;
    mountApp();
    expect(gate()).toBeNull();
    expect(hasFxLayer()).toBe(false);

    settings().visualEffects = true;
    await nextTick();
    expect(gate()).toBe('on');
    expect(hasFxLayer()).toBe(true);

    settings().visualEffects = false;
    await nextTick();
    expect(gate()).toBeNull();
    expect(hasFxLayer()).toBe(false);
  });

  it('应用内减动效开：即使 visualEffects 开也关闸；关掉减动效即重开', async () => {
    mountApp();
    expect(gate()).toBe('on');

    settings().reducedMotion = true;
    await nextTick();
    expect(root.getAttribute('data-reduced-motion')).toBe('true');
    expect(gate()).toBeNull();
    expect(hasFxLayer()).toBe(false);

    settings().reducedMotion = false;
    await nextTick();
    expect(gate()).toBe('on');
    expect(hasFxLayer()).toBe(true);
  });

  it('启动时就开着减动效：首拍即关闸（减动效 watch 先于闸门 watch）', () => {
    settings().reducedMotion = true;
    mountApp();
    expect(gate()).toBeNull();
  });

  it('同一拍里同时关减动效、开特效：读到的是新的减动效状态', async () => {
    settings().visualEffects = false;
    settings().reducedMotion = true;
    mountApp();
    expect(gate()).toBeNull();

    settings().visualEffects = true;
    settings().reducedMotion = false;
    await nextTick();
    expect(gate()).toBe('on');
  });
});

describe('App 特效闸门 — 系统减动效偏好', () => {
  it('挂载时注册 matchMedia change 监听', () => {
    mountApp();
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(mediaQuery.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('系统偏好已开：启动即关闸', () => {
    systemMotion.matches = true;
    mountApp();
    expect(gate()).toBeNull();
  });

  it('系统偏好运行中切换：change 事件触发重算，FxLayer 随之卸 / 挂', async () => {
    mountApp();
    expect(gate()).toBe('on');

    setSystemReducedMotion(true);
    await nextTick();
    expect(gate()).toBeNull();
    expect(hasFxLayer()).toBe(false);

    setSystemReducedMotion(false);
    await nextTick();
    expect(gate()).toBe('on');
    expect(hasFxLayer()).toBe(true);
  });

  it('系统偏好关回来时仍尊重 visualEffects 关', async () => {
    settings().visualEffects = false;
    mountApp();
    setSystemReducedMotion(true);
    setSystemReducedMotion(false);
    await nextTick();
    expect(gate()).toBeNull();
  });

  it('卸载时摘掉监听并关闸', () => {
    mountApp();
    expect(gate()).toBe('on');
    wrapper?.unmount();
    wrapper = null;
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(listeners).toHaveLength(0);
    expect(gate()).toBeNull();
  });
});
