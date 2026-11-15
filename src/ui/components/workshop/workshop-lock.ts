/**
 * workshop-lock.ts — 创意工坊入口锁定状态的**唯一出处**
 *
 * 自 `db9ee1e`（2026-11-12）起，因数据结构不兼容，创意工坊入口临时锁定：
 * 没有任何代码会 `navigate('workshop')`。扩展管理页的锁定卡片与首页「扩展管理」
 * 按钮的显隐都读这里，解锁时只改这一个常量。
 *
 * ⚠️ 这不是安全边界：它只决定入口画成什么样、首页按钮出不出现。
 * 工坊/正则的执行边界见 `docs/CHANGELOG.md`「工坊入口执行边界」。
 *
 * 纯度约束：无 Vue、无 store、无 I/O。
 */

/** 创意工坊入口是否锁定 */
export const WORKSHOP_LOCKED = true;

/** 判定扩展入口所需的工坊状态快照 */
export interface ExtensionEntryState {
  /** 工坊是否锁定（缺省读 {@link WORKSHOP_LOCKED}） */
  locked?: boolean;
  /** 工坊 store 是否已成功读完已装项目 */
  ready: boolean;
  /** 已安装的社区扩展数量 */
  installedCount: number;
}

/**
 * 扩展管理页上有没有玩家能做的事 —— 决定首页「扩展管理」按钮是否显示。
 *
 * - 工坊已解锁 → 有（可进工坊浏览安装）。
 * - 工坊锁定 → 只有装过社区扩展时才有（启用 / 卸载）。
 * - 还没读完（或读取失败）→ 先不显示，避免按钮闪一下又消失。
 */
export function hasExtensionWork(state: ExtensionEntryState): boolean {
  const locked = state.locked ?? WORKSHOP_LOCKED;
  if (!locked) return true;
  return state.ready && state.installedCount > 0;
}
