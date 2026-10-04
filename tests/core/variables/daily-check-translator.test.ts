import { describe, expect, it, vi } from 'vitest';
import { buildDailyCheckPatches } from '../../../src/core/variables/daily-check-translator';

describe('buildDailyCheckPatches', () => {
  it('characterUpdates（fields 形态）→ update_character', () => {
    const patches = buildDailyCheckPatches({
      characterUpdates: [{ name: '艾拉', fields: { hp: 30, maxHp: 50 } }],
    });
    expect(patches).toEqual([
      {
        op: 'update_character',
        target: 'characters.艾拉',
        value: { hp: 30, maxHp: 50 },
        metadata: { source: 'daily_check' },
      },
    ]);
  });

  it('characterUpdates（path/value 形态）→ update_character', () => {
    const patches = buildDailyCheckPatches({
      characterUpdates: [{ name: '艾拉', path: 'mp', value: 12 }],
    });
    expect(patches[0]).toMatchObject({
      op: 'update_character',
      target: 'characters.艾拉',
      value: { mp: 12 },
    });
  });

  it('characterUpdates 缺 name / 无字段 → 跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patches = buildDailyCheckPatches({
      characterUpdates: [{ fields: { hp: 10 } }, { name: '艾拉' }],
    });
    expect(patches).toHaveLength(0);
    warn.mockRestore();
  });

  it('statusAdds → add_status_effect（透传白名单字段）', () => {
    const patches = buildDailyCheckPatches({
      statusAdds: [
        {
          owner: '艾拉',
          name: '狂暴',
          category: '增益',
          remainingTime: 3,
          timeUnit: '回合',
          junk: '忽略我',
        },
      ],
    });
    expect(patches).toEqual([
      {
        op: 'add_status_effect',
        target: 'characters.艾拉',
        value: {
          name: '狂暴',
          category: '增益',
          remainingTime: 3,
          timeUnit: '回合',
        },
        metadata: { source: 'daily_check' },
      },
    ]);
  });

  it('statusAdds 缺 owner / name → 跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patches = buildDailyCheckPatches({
      statusAdds: [{ name: '狂暴' }, { owner: '艾拉' }],
    });
    expect(patches).toHaveLength(0);
    warn.mockRestore();
  });

  it('statusUpdates → update_status_effect（remainingTime + stacks）', () => {
    const patches = buildDailyCheckPatches({
      statusUpdates: [{ owner: '艾拉', name: '中毒', remainingTime: 120, stacks: 2 }],
    });
    expect(patches).toEqual([
      {
        op: 'update_status_effect',
        target: 'characters.艾拉',
        value: { name: '中毒', remainingTime: 120, stacks: 2 },
        metadata: { source: 'daily_check' },
      },
    ]);
  });

  it('statusUpdates remainingTime: null 保留为永久', () => {
    const patches = buildDailyCheckPatches({
      statusUpdates: [{ owner: '艾拉', name: '祝福', remainingTime: null }],
    });
    expect(patches[0]?.value).toEqual({ name: '祝福', remainingTime: null });
  });

  it('statusUpdates 无可改字段 / 缺 owner → 跳过', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const patches = buildDailyCheckPatches({
      statusUpdates: [
        { owner: '艾拉', name: '中毒' },
        { name: '中毒', remainingTime: 5 },
      ],
    });
    expect(patches).toHaveLength(0);
    warn.mockRestore();
  });

  it('statusRemovals → remove_status_effect', () => {
    const patches = buildDailyCheckPatches({
      statusRemovals: [{ owner: '艾拉', name: '灼烧' }],
    });
    expect(patches).toEqual([
      {
        op: 'remove_status_effect',
        target: 'characters.艾拉',
        value: { name: '灼烧' },
        metadata: { source: 'daily_check' },
      },
    ]);
  });

  it('四组合并顺序：角色 → 新增状态 → 状态更新 → 状态移除', () => {
    const patches = buildDailyCheckPatches({
      characterUpdates: [{ name: '艾拉', fields: { hp: 1 } }],
      statusAdds: [{ owner: '艾拉', name: '狂暴', remainingTime: 3 }],
      statusUpdates: [{ owner: '艾拉', name: '中毒', remainingTime: 0 }],
      statusRemovals: [{ owner: '艾拉', name: '灼烧' }],
    });
    expect(patches.map((p) => p.op)).toEqual([
      'update_character',
      'add_status_effect',
      'update_status_effect',
      'remove_status_effect',
    ]);
  });

  it('非数组组 / null / 非对象输入 → 返回空（永不抛）', () => {
    expect(buildDailyCheckPatches({ characterUpdates: 'nope' })).toEqual([]);
    expect(buildDailyCheckPatches(null as unknown as Record<string, unknown>)).toEqual([]);
    expect(buildDailyCheckPatches({})).toEqual([]);
  });
});
