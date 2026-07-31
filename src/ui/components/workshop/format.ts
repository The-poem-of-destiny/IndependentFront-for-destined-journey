/**
 * format.ts — 工坊 UI 的展示层纯函数（Phase 1 / P1-4）
 *
 * 只有「数字/时间戳 → 给人看的串」这一类无状态转换。放这里而不是各组件里各写一份，
 * 是因为同一个体积会同时出现在浏览卡片、详情模态与已装列表上，三处口径必须一致。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */
import type { WorkshopNoteKind } from '@engine/types';
import type { WorkshopNoteGroups } from '@engine/workshop-types';
import { WORKSHOP_NOTE_KINDS } from '@engine/workshop-types';

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

// ═══════════════════════════════════════════════════════════
// 处置记录文案
// ═══════════════════════════════════════════════════════════

/**
 * 每类处置记录的标题文案 —— **口径只有一份**（折叠行、分组标题、toast 共用）。
 *
 * ★ 「未导入」这三个字**只属于 `dropped`**。曾经三类合流报「N 项内容未导入」，
 * 用户读到的是安装失败，而 `degraded` / `sideEffect` 那些正则装得好好的。
 */
export const WORKSHOP_NOTE_LABEL: Record<WorkshopNoteKind, string> = {
  dropped: '未导入',
  degraded: '已装但效果受限',
  sideEffect: '有全局副作用',
};

/** 每类的展开区副标题 —— 一句话说清「这一组到底发生了什么」 */
export const WORKSHOP_NOTE_HINT: Record<WorkshopNoteKind, string> = {
  dropped: '上游的这些内容在本引擎没有对应物，确实没装进来。',
  degraded: '这些内容已经装上并启用，只是显示效果不完整。',
  sideEffect: '这些内容已经装上，但影响范围超出规则自身，可能波及整个界面。',
};

/** 「3 项未导入」这种一段。count 为 0 时返回空串，调用方据此不渲染 */
export function formatNoteSegment(kind: WorkshopNoteKind, count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return `${count} 项${WORKSHOP_NOTE_LABEL[kind]}`;
}

/**
 * 折叠行/toast 的整句 —— 只拼**非空**的组，永不出现「0 项」。
 *
 * 三组全空时返回空串（调用方据此整块不渲染）。
 */
export function summarizeNoteGroups(groups: WorkshopNoteGroups): string {
  return WORKSHOP_NOTE_KINDS.map((kind) => formatNoteSegment(kind, groups[kind].length))
    .filter((seg) => seg.length > 0)
    .join(' · ');
}

// ═══════════════════════════════════════════════════════════
// 装前检视（详情模态的条目/正则列表）
// ═══════════════════════════════════════════════════════════

/**
 * ST 条目的 `position` → 中文。
 *
 * 数值取自 ST 的 world info：0/1 是相对角色定义的前后，4 是按深度插入。
 * 本引擎注入时**不消费**这个字段（`formatWorldBookEntries` 只按 order 拼接），
 * 所以这里的用途纯粹是「让用户看懂上游作者的意图」，不代表安装后的行为。
 */
export function describeEntryPosition(position: number): string {
  switch (position) {
    case 0:
      return '角色定义前';
    case 1:
      return '角色定义后';
    case 4:
      return '按深度插入';
    default:
      return `位置 ${position}`;
  }
}

/**
 * ST 的 `selectiveLogic` → 中文（对齐 `worldbook-loader.matchKeyword` 的四分支）。
 *
 * 只在条目**有次要关键词**时才有意义 —— 没有次要关键词时 ST 直接走「主关键词任一
 * 命中」，这个字段的值是什么都不影响结果，照实显示反而误导。
 */
export function describeSelectiveLogic(logic: number): string {
  switch (logic) {
    case 0:
      return '任一次要命中';
    case 1:
      return '非全部次要命中';
    case 2:
      return '无次要命中';
    case 3:
      return '全部次要命中';
    default:
      return `逻辑 ${logic}`;
  }
}

/** 长文本截断 —— 折叠行的预览段，展开后看全文 */
export function truncate(text: string, max = 90): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}
