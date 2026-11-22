import { describe, expect, it } from 'vitest';
import {
  characterKeyOfTarget,
  resolveCharacterByName,
  validateStatePatch,
} from '../../../src/core/state/patch-rules';
import {
  createDefaultCharacterState,
  type CharacterState,
  type StatePatch,
} from '../../../src/core/types/types';

function cast(): CharacterState[] {
  return [
    createDefaultCharacterState({ id: 'p', saveId: 's', name: '旅人', type: 'player' }),
    createDefaultCharacterState({ id: 'a', saveId: 's', name: '艾拉', aliases: ['小艾'] }),
    createDefaultCharacterState({ id: 'b', saveId: 's', name: '贝拉', aliases: ['姐妹'] }),
    createDefaultCharacterState({ id: 'c', saveId: 's', name: '塞拉', aliases: ['姐妹'] }),
  ];
}

describe('resolveCharacterByName：与提交时同一份按名寻址', () => {
  it('名字精确匹配优先', () => {
    expect(resolveCharacterByName(cast(), '艾拉').id).toBe('a');
  });
  it('唯一别名命中', () => {
    expect(resolveCharacterByName(cast(), '小艾').id).toBe('a');
  });
  it('别名不唯一时抛错', () => {
    expect(() => resolveCharacterByName(cast(), '姐妹')).toThrow('角色别名不唯一: 姐妹');
  });
  it('「主角」「玩家」指向 type=player 的角色', () => {
    expect(resolveCharacterByName(cast(), '主角').id).toBe('p');
    expect(resolveCharacterByName(cast(), '玩家').id).toBe('p');
  });
  it('没有主角时「主角」也按找不到处理', () => {
    const npcs = cast().filter((c) => c.type !== 'player');
    expect(() => resolveCharacterByName(npcs, '主角')).toThrow('角色不存在: 主角');
  });
  it('找不到时抛错', () => {
    expect(() => resolveCharacterByName(cast(), '路人')).toThrow('角色不存在: 路人');
  });
});

describe('characterKeyOfTarget', () => {
  it('取 characters. 之后的第一段；非角色目标返回 undefined', () => {
    expect(characterKeyOfTarget('characters.艾拉')).toBe('艾拉');
    expect(characterKeyOfTarget('characters.艾拉.skills')).toBe('艾拉');
    expect(characterKeyOfTarget('affections.艾拉')).toBeUndefined();
    expect(characterKeyOfTarget('characters.')).toBeUndefined();
  });
});

describe('validateStatePatch：静态形状', () => {
  const patch = (fields: Partial<StatePatch>) => fields as StatePatch;
  it('缺 op / target 抛错', () => {
    expect(() => validateStatePatch(patch({ target: 'x' }))).toThrow('缺少 op 字段');
    expect(() => validateStatePatch(patch({ op: 'set_variable' }))).toThrow('缺少 target 字段');
  });
  it('需要 amount 的 op 缺 amount 抛错', () => {
    expect(() => validateStatePatch(patch({ op: 'delta_hp', target: 'characters.旅人' }))).toThrow(
      'delta_hp 需要 amount 字段',
    );
  });
  it('需要 value 的 op 缺 value 抛错', () => {
    expect(() => validateStatePatch(patch({ op: 'set_variable', target: '世界.天气' }))).toThrow(
      'set_variable 需要 value 字段',
    );
  });
  it('move_variable 缺 metadata.toPath 抛错', () => {
    expect(() => validateStatePatch(patch({ op: 'move_variable', target: 'a.b' }))).toThrow(
      'move_variable 需要 metadata.toPath',
    );
  });
  it('形状完整的补丁通过；update_character 允许无 value', () => {
    expect(() =>
      validateStatePatch(patch({ op: 'delta_hp', target: 'characters.旅人', amount: -3 })),
    ).not.toThrow();
    expect(() =>
      validateStatePatch(patch({ op: 'update_character', target: 'characters.旅人' })),
    ).not.toThrow();
  });
});
