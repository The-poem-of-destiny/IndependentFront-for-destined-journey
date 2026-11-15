/**
 * usePluginContributions —— 游戏页各贡献点读「当前存档生效插件的 UI 贡献」的唯一入口
 * （插件系统设计 §5.7）。
 *
 * 侧栏（`game.toolbar` + `game.overlay` 的触发按钮）、游戏菜单（`game.menu`）、
 * 背包面板（`panel.items.footer`）与插件界面图层都从这里取，免得四处各写一遍
 * 「运行时绑定的存档 → 生效插件 → manifest.contributions」的推导。
 *
 * 几条约束：
 * - 只认**运行时绑定的存档**（`pluginRuntime.saveId`）：GamePage 进档前、离档后一律为空，
 *   不会出现按钮点了却开不了界面的窗口期。
 * - `label` 原样交给模板做文本插值（§5.7「只做文本插值」），这里不加工、不拼 HTML。
 * - `icon` 只取 `pluginStore.iconFor` —— 宿主用 preparePluginIcon 重编码出的
 *   `data:image/png;base64` URL（§4.4 规则二），绝不回落到 manifest 里插件写的路径。
 */
import { computed, type ComputedRef } from 'vue';
import type { PluginSlot, PluginSurfaceKind } from '@engine/types/types-plugin';
import { usePluginRuntimeStore, type PluginOpenSurface } from '../stores/plugin-runtime-store';
import { usePluginStore } from '../stores/plugin-store';

/** 一个可点的插件贡献 */
export interface PluginContributionEntry {
  /** `pluginId/contributionId`，给 v-for 当 key */
  key: string;
  pluginId: string;
  pluginName: string;
  contributionId: string;
  /** 纯文本标签 */
  label: string;
  slot: PluginSlot;
  surface: PluginSurfaceKind;
  /** 宿主重编码的 PNG data URL；没有图标时为 null */
  icon: string | null;
}

export function usePluginContributions() {
  const runtime = usePluginRuntimeStore();
  const plugins = usePluginStore();

  const all = computed<PluginContributionEntry[]>(() => {
    const saveId = runtime.saveId;
    if (saveId === null) return [];
    const out: PluginContributionEntry[] = [];
    for (const record of plugins.effectivePluginsForSave(saveId)) {
      for (const c of record.manifest.contributions) {
        out.push({
          key: `${record.id}/${c.id}`,
          pluginId: record.id,
          pluginName: record.manifest.name,
          contributionId: c.id,
          label: c.label,
          slot: c.slot,
          surface: c.surface,
          icon: plugins.iconFor(record.id, c.id),
        });
      }
    }
    return out;
  });

  /** 某几个贡献点的条目（保持插件启用顺序 + manifest 内声明顺序） */
  function entriesFor(...slots: PluginSlot[]): ComputedRef<PluginContributionEntry[]> {
    return computed(() => all.value.filter((e) => slots.includes(e.slot)));
  }

  /** 已打开界面属于哪个贡献点；插件已不生效时为 null */
  function slotOf(pluginId: string, contributionId: string): PluginSlot | null {
    return (
      all.value.find((e) => e.pluginId === pluginId && e.contributionId === contributionId)?.slot ??
      null
    );
  }

  /** 打开（或聚焦已开着的）贡献界面 */
  function open(entry: PluginContributionEntry): void {
    runtime.openSurface(entry.pluginId, entry.contributionId);
  }

  /** 这个贡献当前打开着的界面（面板插槽据此决定内联帧还是入口按钮） */
  function surfaceOf(entry: PluginContributionEntry): PluginOpenSurface | null {
    return (
      runtime.openSurfaces.find(
        (s) => s.pluginId === entry.pluginId && s.contributionId === entry.contributionId,
      ) ?? null
    );
  }

  /** 关闭界面（面板卸载时收掉自己内联的那些） */
  function close(surfaceId: string): void {
    runtime.closeSurface(surfaceId);
  }

  /** PluginSurface 的 `mountFrame`（挂帧 + 建桥，见运行时 store） */
  function mountFrameFor(surfaceId: string): (container: HTMLElement) => { dispose(): void } {
    return runtime.mountFrameFor(surfaceId);
  }

  return { entriesFor, slotOf, open, surfaceOf, close, mountFrameFor };
}
