/**
 * tag-bank-report.ts — 导入报告的展示层纯函数（图像 v1.4）
 *
 * 从 `ImageTagBankCard.vue` 里提出来，理由与 `scene-image-view.ts` / `format.ts` 相同：
 * 这段判定的正确性与「组件挂没挂上」无关，而它藏在文件选择器回调里 ——
 * 留在组件内**测不到**（jsdom 里没法真的选一个文件），于是那条「报告如实分类」的
 * 承诺就只剩注释在保证。
 */

import type { TagBankImportNote, TagBankImportNoteKind } from '@engine/types-image';

/** 每类最多列几条；其余照实说还有多少（不静默截断） */
export const NOTE_PREVIEW = 8;

/**
 * 四类的**显示顺序**：先说没进库的，再说进库但有话讲的。
 *
 * 用户最关心「我丢了什么」，所以 `skipped` 永远第一；`duplicate` 压根不是问题
 * （查询会一并返回），放最后。
 */
const NOTE_ORDER: TagBankImportNoteKind[] = ['skipped', 'warning', 'repaired', 'duplicate'];

const NOTE_LABELS: Record<TagBankImportNoteKind, string> = {
  skipped: '跳过（没进库）',
  repaired: '修过（清掉了坏字符）',
  warning: '存疑（进库了，但值得看一眼）',
  duplicate: '重名（查询时会一并返回）',
};

export interface TagBankNoteGroup {
  kind: TagBankImportNoteKind;
  label: string;
  /** 该类总条数 */
  total: number;
  /** 实际列出来的那几条（≤ {@link NOTE_PREVIEW}） */
  shown: TagBankImportNote[];
}

/**
 * 处置记录 → 按类分组（空类不出现）。
 *
 * 🔴 **不合并类别**。「跳过」与「修过」在用户那里是两件完全不同的事：前者是内容没了，
 * 后者是内容进来了只是清掉几个坏字节。合成一句「N 项有问题」会把后者也报成失败 ——
 * 与 `WorkshopNoteKind` 当年分家的理由逐字相同。
 */
export function groupImportNotes(notes: readonly TagBankImportNote[]): TagBankNoteGroup[] {
  return NOTE_ORDER.map((kind) => {
    const all = notes.filter((n) => n.kind === kind);
    return {
      kind,
      label: NOTE_LABELS[kind],
      total: all.length,
      shown: all.slice(0, NOTE_PREVIEW),
    };
  }).filter((g) => g.total > 0);
}
