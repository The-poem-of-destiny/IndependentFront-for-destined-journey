/**
 * 游戏页插件 UI 的测试替身（F1）：插件运行时 store 与 usePluginContributions 两件。
 *
 * 游戏页组件测试大多 mock 了 game-store（字段只给到用得着的那些），真的插件运行时一进档就会
 * 去读 `game.saves`，所以凡是会挂上 SideToolbar / GameMenu / ItemsPanel / 插件图层的测试，
 * 都用这里的替身代替真 store：
 *
 * ```ts
 * vi.mock('<…>/src/ui/stores/plugin-runtime-store', async () =>
 *   (await import('<…>/tests/helpers/plugin-ui-fakes')).pluginRuntimeStoreModule());
 * vi.mock('<…>/src/ui/composables/usePluginContributions', async () =>
 *   (await import('<…>/tests/helpers/plugin-ui-fakes')).pluginContributionsModule());
 * ```
 *
 * 状态是模块级单例（vitest 每个测试文件一份模块图），`resetPluginUiFakes()` 在 beforeEach 里清零。
 */
import { computed, reactive, ref } from 'vue';
import { vi } from 'vitest';
import type { PluginSlot } from '../../src/core/types/types-plugin';
import type { PluginContributionEntry } from '../../src/ui/composables/usePluginContributions';
import type {
  PluginExternalLinkRequest,
  PluginOpenSurface,
} from '../../src/ui/stores/plugin-runtime-store';
import type { PluginSaveLockState } from '../../src/ui/lib/plugin-save-lock';

function createRuntime() {
  const state = reactive({
    saveId: null as string | null,
    lockState: 'released' as PluginSaveLockState,
    openSurfaces: [] as PluginOpenSurface[],
    focusedSurfaceId: null as string | null,
    externalLink: null as PluginExternalLinkRequest | null,
    pendingInputFill: null as string | null,
    hasOverlay: false,
  });
  const frameDispose = vi.fn();
  const actions = {
    enterSave: vi.fn(async (id: string) => {
      state.saveId = id;
    }),
    leaveSave: vi.fn(() => {
      state.saveId = null;
      state.openSurfaces = [];
      state.focusedSurfaceId = null;
    }),
    retryLock: vi.fn(async () => undefined),
    openSurface: vi.fn((_pluginId: string, _contributionId: string): string | null => null),
    closeSurface: vi.fn((surfaceId: string) => {
      state.openSurfaces = state.openSurfaces.filter((s) => s.surfaceId !== surfaceId);
      if (state.focusedSurfaceId === surfaceId) state.focusedSurfaceId = null;
    }),
    focusSurface: vi.fn((surfaceId: string) => {
      state.focusedSurfaceId = surfaceId;
    }),
    mountFrameFor: vi.fn((_surfaceId: string) =>
      vi.fn((_container: HTMLElement) => ({ dispose: frameDispose })),
    ),
    closeExternalLink: vi.fn(() => {
      state.externalLink = null;
    }),
  };
  // 与 Pinia setup store 一样：状态字段直接读写，动作挂在同一个对象上
  return Object.assign(state, actions, { frameDispose });
}

/** 插件运行时替身（单例） */
export const pluginRuntimeFake = createRuntime();
/** 当前存档生效的插件贡献（usePluginContributions 替身的数据源） */
export const pluginEntriesFake = ref<PluginContributionEntry[]>([]);

/** 造一条贡献 */
export function pluginEntry(
  over: Partial<PluginContributionEntry> & Pick<PluginContributionEntry, 'slot'>,
): PluginContributionEntry {
  const pluginId = over.pluginId ?? 'shop';
  const contributionId = over.contributionId ?? 'main';
  return {
    key: `${pluginId}/${contributionId}`,
    pluginId,
    pluginName: '杂货铺',
    contributionId,
    label: '商店',
    surface: 'window',
    icon: null,
    ...over,
  };
}

/** 造一个已打开的界面 */
export function pluginSurface(over: Partial<PluginOpenSurface> = {}): PluginOpenSurface {
  return {
    surfaceId: 'plugin-surface-1',
    pluginId: 'shop',
    pluginName: '杂货铺',
    networked: false,
    contributionId: 'main',
    mode: 'window',
    title: '商店',
    requestedSize: null,
    zIndex: 2,
    ...over,
  };
}

export function resetPluginUiFakes(): void {
  const rt = pluginRuntimeFake;
  rt.saveId = null;
  rt.lockState = 'released';
  rt.openSurfaces = [];
  rt.focusedSurfaceId = null;
  rt.externalLink = null;
  rt.pendingInputFill = null;
  rt.hasOverlay = false;
  for (const fn of [
    rt.enterSave,
    rt.leaveSave,
    rt.retryLock,
    rt.openSurface,
    rt.closeSurface,
    rt.focusSurface,
    rt.mountFrameFor,
    rt.closeExternalLink,
    rt.frameDispose,
  ]) {
    fn.mockClear();
  }
  pluginEntriesFake.value = [];
}

/** `vi.mock` 插件运行时 store 模块用 */
export function pluginRuntimeStoreModule() {
  return { usePluginRuntimeStore: () => pluginRuntimeFake };
}

/** `vi.mock` usePluginContributions 模块用：行为与真实现一致，数据取 `pluginEntriesFake` */
export function pluginContributionsModule() {
  return {
    usePluginContributions: () => ({
      entriesFor: (...slots: PluginSlot[]) =>
        computed(() => pluginEntriesFake.value.filter((e) => slots.includes(e.slot))),
      slotOf: (pluginId: string, contributionId: string) =>
        pluginEntriesFake.value.find(
          (e) => e.pluginId === pluginId && e.contributionId === contributionId,
        )?.slot ?? null,
      open: (entry: PluginContributionEntry) =>
        pluginRuntimeFake.openSurface(entry.pluginId, entry.contributionId),
      surfaceOf: (entry: PluginContributionEntry) =>
        pluginRuntimeFake.openSurfaces.find(
          (s) => s.pluginId === entry.pluginId && s.contributionId === entry.contributionId,
        ) ?? null,
      close: (surfaceId: string) => pluginRuntimeFake.closeSurface(surfaceId),
      mountFrameFor: (surfaceId: string) => pluginRuntimeFake.mountFrameFor(surfaceId),
    }),
  };
}
