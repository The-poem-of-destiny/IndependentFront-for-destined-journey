/**
 * format.ts — 工坊 UI 的展示层纯函数（Phase 1 / P1-4）
 *
 * 只有「数字/时间戳 → 给人看的串」这一类无状态转换。放这里而不是各组件里各写一份，
 * 是因为同一个体积会同时出现在浏览卡片、详情模态与已装列表上，三处口径必须一致。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */

/** 字节 → 人类可读。上游 `fileSize` 缺失或为 0 时返回空串（调用方据此不渲染那一格） */
export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** 时间戳 → `YYYY-MM-DD`。0 / 非法值返回空串 */
export function formatDate(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 版本串在 UI 上一律带 `v` 前缀；上游自己带了就不重复加（D13: 只做串比对不解析） */
export function formatVersion(version: string | undefined): string {
  const v = (version ?? '').trim();
  if (!v) return '';
  return /^v/i.test(v) ? v : `v${v}`;
}
