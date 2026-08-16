import { describe, it, expect } from 'vitest';
import { buildSessionImportWarnings } from './session-import-messages';
import type { SessionImportCheck } from '@engine/session-backup';

/** 体检结果的最小骨架 —— 每个用例只覆盖它关心的那一项 */
function check(patch: Partial<SessionImportCheck> = {}): SessionImportCheck {
  return {
    ok: false,
    missingEntries: [],
    packMismatches: [],
    ...patch,
  };
}

describe('buildSessionImportWarnings', () => {
  it('体检通过（三项皆空）→ 空数组，调用方连弹窗都不必开', () => {
    expect(buildSessionImportWarnings(check({ ok: true }))).toEqual([]);
  });

  it('缺失条目按书名归组，一本书一行', () => {
    const lines = buildSessionImportWarnings(
      check({
        missingEntries: [
          { token: 'a:1', bookName: '主世界观', entryTitle: '纪元' },
          { token: 'b:2', bookName: '数值表', entryTitle: '层级' },
          { token: 'a:3', bookName: '主世界观', entryTitle: '种族' },
        ],
      }),
    );
    expect(lines).toEqual([
      '世界书『主世界观』缺少 2 个条目：纪元、种族',
      '世界书『数值表』缺少 1 个条目：层级',
    ]);
  });

  it('书名缺席归到「未知世界书」，条目名缺席退回 token', () => {
    const lines = buildSessionImportWarnings(
      check({ missingEntries: [{ token: 'creative_workshop:900001' }] }),
    );
    expect(lines).toEqual(['世界书『未知世界书』缺少 1 个条目：creative_workshop:900001']);
  });

  it('标题最多列 5 个，超出用「等 N 条」收尾', () => {
    const lines = buildSessionImportWarnings(
      check({
        missingEntries: Array.from({ length: 7 }, (_, i) => ({
          token: `a:${i}`,
          bookName: '主世界观',
          entryTitle: `条目${i}`,
        })),
      }),
    );
    expect(lines).toEqual([
      '世界书『主世界观』缺少 7 个条目：条目0、条目1、条目2、条目3、条目4 等 7 条',
    ]);
  });

  it('恰好 5 个时不加「等 N 条」尾巴', () => {
    const lines = buildSessionImportWarnings(
      check({
        missingEntries: Array.from({ length: 5 }, (_, i) => ({
          token: `a:${i}`,
          bookName: '主世界观',
          entryTitle: `条目${i}`,
        })),
      }),
    );
    expect(lines[0]).toBe('世界书『主世界观』缺少 5 个条目：条目0、条目1、条目2、条目3、条目4');
  });

  it('内容包未安装 / 版本不同是两句不同的话', () => {
    const lines = buildSessionImportWarnings(
      check({
        packMismatches: [
          {
            packId: 'fated-poem',
            name: '命定之诗',
            expectedVersion: '1.2.0',
            installedVersion: null,
          },
          {
            packId: 'extra',
            name: '扩展包',
            expectedVersion: '2.0.0',
            installedVersion: '1.9.0',
          },
        ],
      }),
    );
    expect(lines).toEqual([
      '未安装内容包『命定之诗』（导出端为 v1.2.0）',
      '内容包『扩展包』版本不同（导出端 v2.0.0 / 本机 v1.9.0）',
    ]);
  });

  it('内容包没有 name 时退回 packId', () => {
    const lines = buildSessionImportWarnings(
      check({
        packMismatches: [{ packId: 'anon-pack', expectedVersion: '1.0.0', installedVersion: null }],
      }),
    );
    expect(lines).toEqual(['未安装内容包『anon-pack』（导出端为 v1.0.0）']);
  });

  it('缺正文预设时点明它是全局设置、不影响存档数据', () => {
    const lines = buildSessionImportWarnings(
      check({ missingStoryPreset: { id: 'p1', name: '命定之诗正文' } }),
    );
    expect(lines).toEqual([
      '本机没有导出端使用的正文预设『命定之诗正文』（全局设置，不影响存档数据）',
    ]);
  });

  it('三类同时缺失时按 条目 → 内容包 → 预设 排序', () => {
    const lines = buildSessionImportWarnings(
      check({
        missingEntries: [{ token: 'a:1', bookName: '主世界观', entryTitle: '纪元' }],
        packMismatches: [
          { packId: 'p', name: '内容包', expectedVersion: '1.0.0', installedVersion: null },
        ],
        missingStoryPreset: { id: 'p1', name: '正文预设' },
      }),
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('世界书');
    expect(lines[1]).toContain('内容包');
    expect(lines[2]).toContain('正文预设');
  });
});
