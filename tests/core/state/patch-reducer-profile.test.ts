/**
 * patch-reducer：档案域补丁纯变换的单元测试（审查报告 R5c）+ update_character 非有限增量回归。
 *
 * StateManager 的档案 handler、状态树翻译层的工作状态与建补丁预演共用这一份变换；
 * 端到端的「工作状态后值 = 真实落库」对照在 tests/core/variables/state-tree-shadow-parity.test.ts。
 */

import { describe, expect, it } from 'vitest';
import {
  reduceAddCharacter,
  reduceAddNews,
  reduceAffectionPatch,
  reduceCharacterPatch,
  reduceFatePointPatch,
  reduceQuestPatch,
  reduceRenameCharacter,
  reduceStatePatch,
  reduceVariablePatch,
  resolveCharacterTarget,
  type ReducibleState,
  type StateReduceContext,
} from '../../../src/core/state/patch-reducer';
import {
  createDefaultCharacterState,
  createDefaultQuest,
  type CharacterState,
  type StatePatch,
} from '../../../src/core/types/types';

const GAME_TIME = { year: 1000, month: 3, day: 15, hour: 8, minute: 0 };

function person(name: string, overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({ id: `id-${name}`, name, ...overrides });
}

function state(): ReducibleState {
  return {
    characters: [person('主角甲', { type: 'player' }), person('布兰'), person('卡拉')],
    profile: {
      fp: 10,
      fpHistory: [],
      quests: { 寻找钥匙: { ...createDefaultQuest(), status: '进行中' } },
      news: [],
      variables: { sys: { 计数: 1 } },
      gameTime: GAME_TIME as ReducibleState['profile']['gameTime'],
      affections: { 布兰: 30, 卡拉: -10 },
    },
  };
}

const ctx = (clampSpend: boolean): StateReduceContext => ({
  fatePoints: { clampSpend },
  newsStamp: () => ({ id: 'n-1', publishedAt: 0 }),
});

const p = (op: StatePatch['op'], target: string, extra: Partial<StatePatch> = {}): StatePatch =>
  ({ op, target, ...extra }) as StatePatch;

describe('update_character delta：非有限增量忽略并记 warn（第 4 波审查回归）', () => {
  const delta = (target: string, value: unknown) =>
    p('update_character', target, { value, metadata: { delta: true } });

  it('totalExp 增量为 NaN → 该键忽略，主角不会从 Lv.1 直升', () => {
    const hero = person('主角甲', { type: 'player', level: 1, totalExp: 0 });
    const { notes } = reduceCharacterPatch(
      hero,
      delta('characters.主角甲', { totalExp: Number.NaN }),
    );
    expect(hero.level).toBe(1);
    expect(Number.isFinite(hero.totalExp)).toBe(true);
    expect(notes).toContainEqual(
      expect.objectContaining({ level: 'warn', text: expect.stringContaining('totalExp') }),
    );
  });

  it('Infinity 增量与五维 NaN 增量同样忽略，同一补丁里的有限键照常加；金钱沿 V1 钳 0', () => {
    const c = person('布兰', { money: 5, level: 3 });
    const str = c.attributes.str;
    const { notes } = reduceCharacterPatch(
      c,
      delta('characters.布兰', { level: Infinity, freeAttrPoints: 2, attributes: { str: NaN } }),
    );
    expect(c.level).toBe(3);
    expect(c.freeAttrPoints).toBe(2);
    expect(c.attributes.str).toBe(str);
    expect(notes.filter((n) => n.level === 'warn')).toHaveLength(2);
    reduceCharacterPatch(c, delta('characters.布兰', { money: Infinity }));
    expect(c.money).toBe(0);
  });
});

describe('档案域：变量 / 命运点', () => {
  it('变量五种 op 按字面路径写；move 缺 toPath 抛错', () => {
    const s = state();
    reduceVariablePatch(s.profile, p('set_variable', 'variables.user.线索', { value: ['钥匙'] }));
    reduceVariablePatch(s.profile, p('delta_variable', 'variables.sys.计数', { amount: 4 }));
    reduceVariablePatch(
      s.profile,
      p('move_variable', 'variables.sys.计数', { metadata: { toPath: 'user.计数' } }),
    );
    expect(s.profile.variables).toEqual({ sys: {}, user: { 线索: ['钥匙'], 计数: 5 } });
    expect(() => reduceVariablePatch(s.profile, p('move_variable', 'variables.user.计数'))).toThrow(
      'toPath',
    );
    reduceVariablePatch(s.profile, p('remove_variable', 'variables.user.计数'));
    expect(s.profile.variables.user).toEqual({ 线索: ['钥匙'] });
  });

  it('命运点：AI 口径扣超钳到 0，玩家 / 领域命令口径不足抛错；记账只在给了落款时发生', () => {
    const s = state();
    reduceFatePointPatch(s.profile, p('delta_variable', 'profile.fp', { amount: -50 }), {
      clampSpend: true,
    });
    expect(s.profile.fp).toBe(0);
    expect(s.profile.fpHistory).toEqual([]);
    expect(() =>
      reduceFatePointPatch(s.profile, p('delta_variable', 'profile.fp', { amount: -1 }), {
        clampSpend: false,
      }),
    ).toThrow('FP 不足');
    reduceFatePointPatch(s.profile, p('delta_variable', 'profile.fp', { amount: 7 }), {
      clampSpend: false,
      ledger: { reason: '奖励', id: 'tx-1', timestamp: 123 },
    });
    expect(s.profile.fp).toBe(7);
    expect(s.profile.fpHistory).toEqual([
      { id: 'tx-1', timestamp: 123, amount: 7, reason: '奖励', balance: 7, source: 'other' },
    ]);
    expect(() =>
      reduceFatePointPatch(s.profile, p('delta_variable', 'profile.fp', { amount: NaN }), {
        clampSpend: true,
      }),
    ).toThrow('finite');
  });

  it('总分发：profile.fp 走命运点，其余 delta_variable 走变量', () => {
    const s = state();
    reduceStatePatch(s, p('delta_variable', 'profile.fp', { amount: -3 }), ctx(true));
    reduceStatePatch(s, p('delta_variable', 'variables.sys.计数', { amount: 1 }), ctx(true));
    expect(s.profile.fp).toBe(7);
    expect(s.profile.variables.sys.计数).toBe(2);
    expect(s.profile.variables.profile).toBeUndefined();
  });
});

describe('档案域：任务 / 好感 / 新闻', () => {
  it('update_quest 合并缺省任务并归一化状态；remove_quest 删除；缺名字抛错', () => {
    const s = state();
    reduceQuestPatch(
      s.profile,
      p('update_quest', 'quests', { value: { name: '送信', status: '完毕' } }),
    );
    expect(s.profile.quests['送信']).toEqual({ ...createDefaultQuest(), status: '已完成' });
    reduceQuestPatch(s.profile, p('remove_quest', 'quests', { value: { name: '寻找钥匙' } }));
    expect(Object.keys(s.profile.quests)).toEqual(['送信']);
    expect(() => reduceQuestPatch(s.profile, p('update_quest', 'quests', { value: {} }))).toThrow(
      '缺少任务名称',
    );
  });

  it('好感取整并钳到 [-100, 100]；target 不合格抛错', () => {
    const s = state();
    reduceAffectionPatch(s.profile, p('delta_affection', 'affections.布兰', { amount: 90.6 }));
    reduceAffectionPatch(s.profile, p('set_affection', 'affections.新人', { value: -500 }));
    expect(s.profile.affections).toEqual({ 布兰: 100, 卡拉: -10, 新人: -100 });
    expect(() =>
      reduceAffectionPatch(s.profile, p('set_affection', 'chars.布兰', { value: 1 })),
    ).toThrow('affections.<角色名>');
  });

  it('add_news 用调用方给的账务字段；缺标题 / 正文抛错', () => {
    const s = state();
    reduceAddNews(s.profile, p('add_news', 'news', { value: { title: '号外', content: '大事' } }), {
      id: 'x',
      publishedAt: 9,
    });
    expect(s.profile.news).toEqual([
      { title: '号外', content: '大事', category: '', id: 'x', publishedAt: 9, read: false },
    ]);
    expect(() =>
      reduceAddNews(s.profile, p('add_news', 'news', { value: { title: '空' } }), {
        id: 'y',
        publishedAt: 0,
      }),
    ).toThrow('content');
  });
});

describe('档案域：人物增删与改名', () => {
  it('add_character：同名（不同 id）抛错、同 id 重放不重复追加、补年龄锚点', () => {
    const s = state();
    expect(() =>
      reduceAddCharacter(s.characters, person('布兰', { id: 'other' }), GAME_TIME),
    ).toThrow('同名角色已存在');
    const smith = person('铁匠');
    reduceAddCharacter(s.characters, smith, GAME_TIME);
    reduceAddCharacter(s.characters, smith, GAME_TIME);
    expect(s.characters.filter((c) => c.name === '铁匠')).toHaveLength(1);
    expect(smith.ageAnchor).toBeDefined();
  });

  it('rename_character：好感跟着搬；同名 no-op；撞名抛错；删人按 id 摘除', () => {
    const s = state();
    const kara = resolveCharacterTarget(s.characters, 'characters.卡拉.skills');
    expect(reduceRenameCharacter(s, kara, '卡拉')).toMatchObject({ renamed: false });
    expect(() => reduceRenameCharacter(s, kara, ' 布兰 ')).toThrow('新名已被占用');
    expect(reduceRenameCharacter(s, kara, ' 卡拉丽 ')).toMatchObject({
      renamed: true,
      affectionMoved: true,
    });
    expect(kara.name).toBe('卡拉丽');
    expect(s.profile.affections).toEqual({ 布兰: 30, 卡拉丽: -10 });
    reduceStatePatch(s, p('remove_character', 'characters.卡拉丽'), ctx(true));
    expect(s.characters.map((c) => c.name)).toEqual(['主角甲', '布兰']);
  });

  it('总分发不认识的 op 抛错', () => {
    expect(() => reduceStatePatch(state(), p('add_memory', 'memories'), ctx(true))).toThrow(
      '状态切片不认识',
    );
  });
});
