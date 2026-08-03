/**
 * store 层共享小工具（Q-16）。
 *
 * 这两个函数此前在 `asset-store` 与 `audio-store` 里逐字相同地各存一份，
 * asset-store 的注释亲口写着「两处判据必须一致，**改一处记得改另一处**」——
 * 那句话本身就是这个文件该存在的理由。漏改一处的表现是
 * 「素材导入把配额撑满却报成普通失败」，用户看不出该去清什么。
 */
import { useUIStore } from './ui-store';

/**
 * 是否是「浏览器存储配额耗尽」。
 *
 * 标准浏览器抛 `DOMException('QuotaExceededError')`，老 Firefox 用
 * `NS_ERROR_DOM_QUOTA_REACHED`；Dexie 会原样透传底层错误。
 * 要加新的浏览器错误名（如 Safari 的 `QUOTA_EXCEEDED_ERR`）只改这里。
 */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/**
 * 提示的唯一出口。
 *
 * 🔴 无 Pinia 上下文（测试 / 早期启动）时**静默**，不该因为一条提示炸掉调用方 ——
 * 若干 store 测试正依赖「没有 toast 目标时 mutation 照样成功」，别把这个 catch 收窄。
 */
export function notify(message: string, type: 'info' | 'error'): void {
  try {
    useUIStore().toast(message, type);
  } catch {
    // 静默：提示失败不能影响主流程的结果
  }
}
