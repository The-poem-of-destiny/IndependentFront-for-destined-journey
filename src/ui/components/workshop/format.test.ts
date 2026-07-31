/**
 * format.test.ts — 工坊展示层纯函数
 *
 * 处置文案的口径必须只有一份: 折叠行、分组标题、安装 toast 三处共用
 * `WORKSHOP_NOTE_LABEL` / `summarizeNoteGroups`。三处说法一旦分家，用户会以为
 * 自己遇到了几个不同的问题 —— 而「N 项未导入」这三个字只属于 `dropped`。
 */

import { describe, it, expect } from 'vitest';
import { groupWorkshopNotes, workshopNote } from '@engine/workshop-types';
import {
  WORKSHOP_NOTE_LABEL,
  describeEntryPosition,
  describeSelectiveLogic,
  formatBytes,
  formatDate,
  formatNoteSegment,
  formatVersion,
  summarizeNoteGroups,
  truncate,
} from './format';

describe('formatBytes / formatDate / formatVersion', () => {
  it('字节分档，0 与非法值给空串', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(undefined)).toBe('');
    expect(formatBytes(Number.NaN)).toBe('');
  });

  it('时间戳 → YYYY-MM-DD，0 与非法值给空串', () => {
    expect(formatDate(Date.UTC(2026, 6, 31))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatDate(0)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('版本一律带 v 前缀，上游自己带了不重复加', () => {
    expect(formatVersion('1.2.0')).toBe('v1.2.0');
    expect(formatVersion('v1.2.0')).toBe('v1.2.0');
    expect(formatVersion('  ')).toBe('');
    expect(formatVersion(undefined)).toBe('');
  });
});

describe('处置文案 —— 只有 dropped 配叫「未导入」', () => {
  it('标签口径固定', () => {
    expect(WORKSHOP_NOTE_LABEL.dropped).toBe('未导入');
    expect(WORKSHOP_NOTE_LABEL.degraded).not.toContain('未导入');
    expect(WORKSHOP_NOTE_LABEL.sideEffect).not.toContain('未导入');
  });

  it('单段文案；count ≤ 0 给空串（永不出现「0 项」）', () => {
    expect(formatNoteSegment('dropped', 3)).toBe('3 项未导入');
    expect(formatNoteSegment('sideEffect', 1)).toBe('1 项有全局副作用');
    expect(formatNoteSegment('degraded', 0)).toBe('');
    expect(formatNoteSegment('degraded', Number.NaN)).toBe('');
  });

  it('★ 整句只拼非空组，且 dropped 的数字不吞掉另外两类', () => {
    const groups = groupWorkshopNotes([
      workshopNote('dropped', 'a'),
      workshopNote('degraded', 'b'),
      workshopNote('degraded', 'c'),
      workshopNote('sideEffect', 'd'),
    ]);
    expect(summarizeNoteGroups(groups)).toBe('1 项未导入 · 2 项已装但效果受限 · 1 项有全局副作用');
  });

  it('只有 degraded 时不出现「未导入」字样', () => {
    const groups = groupWorkshopNotes([workshopNote('degraded', 'b')]);
    expect(summarizeNoteGroups(groups)).toBe('1 项已装但效果受限');
  });

  it('★ 老的纯 string[] 项目 → 「N 项未导入」，与旧 UI 口径一致', () => {
    expect(summarizeNoteGroups(groupWorkshopNotes(['a', 'b']))).toBe('2 项未导入');
  });

  it('无 note → 空串（调用方据此整块不渲染）', () => {
    expect(summarizeNoteGroups(groupWorkshopNotes([]))).toBe('');
    expect(summarizeNoteGroups(groupWorkshopNotes(undefined))).toBe('');
  });
});

describe('装前检视的字段翻译', () => {
  it('position 覆盖 ST 的三个已知值，未知值原样报出而不是硬派一个说法', () => {
    expect(describeEntryPosition(0)).toBe('角色定义前');
    expect(describeEntryPosition(1)).toBe('角色定义后');
    expect(describeEntryPosition(4)).toBe('按深度插入');
    // 上游可以有我们没见过的值：宁可显示"位置 7"，也不要错报成"按深度插入"
    expect(describeEntryPosition(7)).toBe('位置 7');
  });

  it('selectiveLogic 四分支与 worldbook-loader.matchKeyword 同义', () => {
    expect(describeSelectiveLogic(0)).toBe('任一次要命中');
    expect(describeSelectiveLogic(1)).toBe('非全部次要命中');
    expect(describeSelectiveLogic(2)).toBe('无次要命中');
    expect(describeSelectiveLogic(3)).toBe('全部次要命中');
    expect(describeSelectiveLogic(9)).toBe('逻辑 9');
  });

  it('truncate 压平空白并在超长时才加省略号', () => {
    expect(truncate('短句')).toBe('短句');
    // 折叠行是单行的，换行/连续空格必须压掉，否则摘要会带一串空洞
    expect(truncate('第一行\n\n第二行   末尾')).toBe('第一行 第二行 末尾');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
    expect(truncate('')).toBe('');
  });
});
