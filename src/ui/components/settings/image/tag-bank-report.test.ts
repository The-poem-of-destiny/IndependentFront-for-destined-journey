/**
 * tag-bank-report.test.ts — 导入报告的分类（图像 v1.4）
 *
 * 这段判定住在文件选择器回调后面，组件测试够不到它 —— 提成纯函数正是为了这个。
 */

import { describe, it, expect } from 'vitest';
import { groupImportNotes, NOTE_PREVIEW } from './tag-bank-report';
import type { TagBankImportNote, TagBankImportNoteKind } from '@engine/types-image';

const note = (kind: TagBankImportNoteKind, i = 0): TagBankImportNote => ({
  kind,
  uid: i,
  label: `条目${i}`,
  text: `原因${i}`,
});

describe('groupImportNotes', () => {
  it('没有记录 → 空数组（报告里那一节整个不出现）', () => {
    expect(groupImportNotes([])).toEqual([]);
  });

  it('空类不出现 —— 不画一行「跳过 0 条」', () => {
    const groups = groupImportNotes([note('skipped')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('skipped');
  });

  it('🔴 四类各自成组，不合并 —— 「丢了」和「清了几个坏字节」不是一回事', () => {
    const groups = groupImportNotes([
      note('duplicate'),
      note('repaired'),
      note('warning'),
      note('skipped'),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['skipped', 'warning', 'repaired', 'duplicate']);
    expect(groups.every((g) => g.total === 1)).toBe(true);
  });

  it('用户最关心「我丢了什么」，所以 skipped 永远排第一', () => {
    const groups = groupImportNotes([note('duplicate'), note('skipped')]);
    expect(groups[0].kind).toBe('skipped');
  });

  it('每类最多列 NOTE_PREVIEW 条，但 total 报的是真实总数（不静默截断）', () => {
    const many = Array.from({ length: 50 }, (_, i) => note('skipped', i));
    const [group] = groupImportNotes(many);
    expect(group.shown).toHaveLength(NOTE_PREVIEW);
    expect(group.total).toBe(50);
  });

  it('每一类都有能读的中文标签（报告里直接印它）', () => {
    const kinds: TagBankImportNoteKind[] = ['skipped', 'repaired', 'warning', 'duplicate'];
    for (const kind of kinds) {
      const [group] = groupImportNotes([note(kind)]);
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.label).not.toBe(kind);
    }
  });
});
