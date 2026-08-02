/**
 * workshop-diff.ts — 更新改动预告测试（Phase 4 / B3）
 *
 * 守的是**诚实**: 这个面板是用户按下不可逆的「更新」之前看到的最后一屏。
 * 报出根本不会发生的改动，和漏报真会发生的，两种谎话一样糟。
 *
 * 关键不变式: diff 的输入是 `planInstall()` 已经算好的计划，所以「预告的」与
 * 「提交的」在结构上就是同一批内容 —— 这些用例顺带钉住这一点。
 */
import { describe, it, expect } from 'vitest';
import type { WorldBookEntry } from './types';
import type { BeautifierRuleDraft, InstallPlan } from './workshop-types';
import { diffInstallPlan } from './workshop-diff';

function entry(name: string, content: string, uid = 0): WorldBookEntry {
  return {
    uid,
    name,
    content,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 0,
    position: 'at_depth',
  } as unknown as WorldBookEntry;
}

function rule(id: string, pattern: string, replacement = ''): BeautifierRuleDraft {
  return {
    id,
    name: `规则 ${id}`,
    scope: 'maintext',
    pattern,
    flags: 'g',
    replacement,
    enabled: true,
    order: 0,
    isBuiltin: false,
  } as unknown as BeautifierRuleDraft;
}

function plan(entries: WorldBookEntry[], rules: BeautifierRuleDraft[] = []): InstallPlan {
  return { entries, rules } as unknown as InstallPlan;
}

describe('diffInstallPlan — 世界书条目', () => {
  it('新增 / 变更 / 删除各归各位', () => {
    const existing = [entry('保留', '同样的正文'), entry('要改的', '旧正文'), entry('要删的', 'x')];
    const d = diffInstallPlan(
      plan([entry('保留', '同样的正文'), entry('要改的', '新正文'), entry('新来的', 'y')]),
      existing,
      [],
    );

    expect(d.entries.added.map((r) => r.name)).toEqual(['新来的']);
    expect(d.entries.removed.map((r) => r.name)).toEqual(['要删的']);
    expect(d.entries.modified).toEqual([{ name: '要改的', before: '旧正文', after: '新正文' }]);
    expect(d.hasChanges).toBe(true);
  });

  it('★ 一字未动的条目不进任何一组，只计数 —— 否则真正的改动会被淹没', () => {
    const same = [entry('a', '1'), entry('b', '2')];
    const d = diffInstallPlan(plan([entry('a', '1'), entry('b', '2')]), same, []);

    expect(d.entries.added).toHaveLength(0);
    expect(d.entries.modified).toHaveLength(0);
    expect(d.entries.removed).toHaveLength(0);
    expect(d.unchangedEntryCount).toBe(2);
    expect(d.hasChanges).toBe(false);
  });

  it('★ 按名配对，不按 uid —— 名字才是逻辑键（D15/铁律 1）', () => {
    // uid 换了但名字没变 → 是「同一条」，只比正文
    const d = diffInstallPlan(plan([entry('同名', '新', 99)]), [entry('同名', '旧', 3)], []);
    expect(d.entries.modified).toHaveLength(1);
    expect(d.entries.added).toHaveLength(0);
    expect(d.entries.removed).toHaveLength(0);
  });

  it('首装（库里空的）时全部落在新增', () => {
    const d = diffInstallPlan(plan([entry('a', '1'), entry('b', '2')]), [], []);
    expect(d.entries.added).toHaveLength(2);
    expect(d.unchangedEntryCount).toBe(0);
  });

  it('本地重名取先到的那条 —— 与 planInstall 的 existingByName 同一条规则', () => {
    const d = diffInstallPlan(
      plan([entry('重名', '新')]),
      [entry('重名', '先到的', 1), entry('重名', '后到的', 2)],
      [],
    );
    expect(d.entries.modified).toEqual([{ name: '重名', before: '先到的', after: '新' }]);
    /*
     * 后到的那条**不报删除**。看起来漏了，其实是对的: `planInstall` 的 retiredUids
     * 用的也是按名匹配（`matchedNames.has(entry.name)`），「重名」在计划里匹配上了，
     * 所以它同样不会被退休。diff 报什么、计划做什么，必须是同一件事。
     */
    expect(d.entries.removed).toHaveLength(0);
  });
});

describe('diffInstallPlan — 正则规则', () => {
  it('按 id 配对，匹配式变了算改', () => {
    const d = diffInstallPlan(
      plan([], [rule('r1', '新式'), rule('r2', 'x')]),
      [],
      [rule('r1', '旧式'), rule('r3', 'z')],
    );
    expect(d.rules.modified).toEqual([{ name: '规则 r1', before: '旧式', after: '新式' }]);
    expect(d.rules.added.map((r) => r.name)).toEqual(['规则 r2']);
    expect(d.rules.removed.map((r) => r.name)).toEqual(['规则 r3']);
  });

  it('★ 只有替换文本变了也算改 —— 输出照样会长得不一样', () => {
    const d = diffInstallPlan(
      plan([], [rule('r1', '同样的式子', '新替换')]),
      [],
      [rule('r1', '同样的式子', '旧替换')],
    );
    expect(d.rules.modified).toHaveLength(1);
  });

  it('完全一致时不报改动', () => {
    const same = [rule('r1', 'p', 'v')];
    const d = diffInstallPlan(plan([], same), [], same);
    expect(d.rules.added).toHaveLength(0);
    expect(d.rules.modified).toHaveLength(0);
    expect(d.rules.removed).toHaveLength(0);
    expect(d.hasChanges).toBe(false);
  });
});

describe('hasChanges', () => {
  it('只有正则变了也要为 true —— 正则同样会改变用户看到的输出', () => {
    const d = diffInstallPlan(plan([], [rule('r1', 'p')]), [], []);
    expect(d.hasChanges).toBe(true);
  });

  it('两边都空时为 false', () => {
    expect(diffInstallPlan(plan([]), [], []).hasChanges).toBe(false);
  });
});
