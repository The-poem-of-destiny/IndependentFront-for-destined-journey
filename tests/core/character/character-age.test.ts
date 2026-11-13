import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHARACTER_AGE,
  ageAt,
  characterAge,
  ensureCharacterAge,
  extractLoreAge,
  formatCharacterAge,
  parseAgeHint,
} from '../../../src/core/character/character-age';
import {
  legacyCharacterDefinitions,
  readCharacterDefinitions,
} from '../../../src/core/character/character-definitions';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { WorldBook } from '../../../src/core/types/types';
import type { CharacterDefinition } from '../../../src/core/types/types-character';
import {
  GAME_EPOCH_YEAR,
  advanceDays,
  createDefaultTime,
} from '../../../src/core/time/time-system';

const START = GAME_EPOCH_YEAR;
const at = (year: number, month: number, day: number) => ({ year, month, day });
const definition = (hint: Partial<CharacterDefinition>): CharacterDefinition => ({
  id: 'd',
  name: '向导',
  profile: {},
  assets: [],
  past: [],
  ...hint,
});

describe('角色年龄：开局年龄 + 生日为真源', () => {
  it('年龄随游戏时间增长：生日当天加一岁，前一天不加', () => {
    const anchor = { startAge: 30, month: 3, day: 15 };
    expect(ageAt(anchor, at(START, 1, 1))).toBe(30);
    expect(ageAt(anchor, at(START, 3, 14))).toBe(30);
    expect(ageAt(anchor, at(START, 3, 15))).toBe(31);
    expect(ageAt(anchor, at(START + 7, 12, 30))).toBe(38);
  });

  it('生日就在开局当天的角色，开局时已满 startAge，次年同日加一岁', () => {
    const anchor = { startAge: 18, month: 1, day: 1 };
    expect(ageAt(anchor, at(START, 1, 1))).toBe(18);
    expect(ageAt(anchor, at(START, 12, 30))).toBe(18);
    expect(ageAt(anchor, at(START + 1, 1, 1))).toBe(19);
  });

  it('长寿角色不需要出生年：开局 500 岁，十年后 510 岁', () => {
    const elder = createDefaultCharacterState({ name: '古龙' });
    elder.definition = definition({ age: 500, birthday: { month: 6, day: 6 } });
    ensureCharacterAge(elder, at(START, 1, 1));
    expect(elder.ageAnchor).toEqual({ startAge: 500, month: 6, day: 6 });
    expect(characterAge(elder, at(START, 1, 1))).toBe(500);
    expect(characterAge(elder, at(START + 10, 6, 6))).toBe(511);
    expect(characterAge(elder, at(START + 10, 6, 5))).toBe(510);
  });

  it('作者定义的 age 是开局年龄，与角色第几年才登场无关', () => {
    const late = createDefaultCharacterState({ name: '向导' });
    late.definition = definition({ age: 34 });
    // 开局三年后才实例化
    ensureCharacterAge(late, at(START + 3, 5, 1));
    expect(late.ageAnchor).toEqual({ startAge: 34, month: 1, day: 1 });
    expect(characterAge(late, at(START + 3, 5, 1))).toBe(37);
  });

  it('实例自带的 age 是此刻的年龄，按实例化时间折算回开局', () => {
    const now = at(START + 3, 5, 1);
    const npc = createDefaultCharacterState({
      name: '路人',
      customFields: { age: 40, birthday: '9月20日' },
    });
    ensureCharacterAge(npc, now);
    expect(characterAge(npc, now)).toBe(40);
    // 开局到此刻过了 3 个生日（今年 9 月的还没到）→ 开局 37 岁
    expect(npc.ageAnchor).toEqual({ startAge: 37, month: 9, day: 20 });
    expect(characterAge(npc, at(START + 3, 9, 20))).toBe(41);
  });

  it('没有任何线索时兜底：实例化那一刻 18 岁、生日 1 月 1 日', () => {
    const now = at(START + 2, 7, 10);
    const npc = createDefaultCharacterState({ name: '无名' });
    expect(ensureCharacterAge(npc, now)).toBe(true);
    expect(characterAge(npc, now)).toBe(DEFAULT_CHARACTER_AGE);
    expect(npc.ageAnchor).toEqual({ startAge: 16, month: 1, day: 1 });
  });

  it('开局后才出生的角色：出生前不出负数', () => {
    const now = at(START + 5, 1, 1);
    const child = createDefaultCharacterState({ name: '幼童', customFields: { age: 2 } });
    ensureCharacterAge(child, now);
    expect(child.ageAnchor!.startAge).toBe(-3);
    expect(characterAge(child, now)).toBe(2);
    expect(characterAge(child, at(START, 1, 1))).toBe(0);
  });

  it('与时间系统对接：推进一整年后兜底角色从 18 变 19', () => {
    const start = createDefaultTime();
    const character = createDefaultCharacterState({ name: '旅人' });
    ensureCharacterAge(character, start);
    expect(characterAge(character, start)).toBe(18);
    expect(characterAge(character, advanceDays(start, 359))).toBe(18);
    expect(characterAge(character, advanceDays(start, 360))).toBe(19);
  });

  it('宽容解析线索：坏掉的那一半丢弃，不连累另一半；不接受出生年', () => {
    expect(parseAgeHint({ age: '34岁', birthday: '3月15日' })).toEqual({
      age: 34,
      birthday: { month: 3, day: 15 },
    });
    // 历法每月 30 天，31 日并到 30 日
    expect(parseAgeHint({ age: 20, birthday: '12-31' })).toEqual({
      age: 20,
      birthday: { month: 12, day: 30 },
    });
    expect(parseAgeHint({ age: '外貌约16岁', birthday: { month: 2, day: 9 } })).toEqual({
      birthday: { month: 2, day: 9 },
    });
    expect(parseAgeHint({ age: 20, birthday: '470-03-15' })).toEqual({ age: 20 });
    expect(parseAgeHint({ birthday: { year: 88, month: 4, day: 2 } })).toEqual({
      birthday: { month: 4, day: 2 },
    });
    expect(parseAgeHint({ age: -3, birthday: '13-40' })).toEqual({});
    expect(parseAgeHint({ age: NaN, birthday: 42 })).toEqual({});
    expect(parseAgeHint(null)).toEqual({});
  });

  it('年龄与生日各自独立取用，作者优先；闸门幂等', () => {
    const now = at(START, 1, 1);
    const character = createDefaultCharacterState({
      name: '向导',
      customFields: { age: 50, birthday: '6月6日' },
    });
    character.definition = definition({ age: 27 });
    expect(ensureCharacterAge(character, now)).toBe(true);
    expect(character.ageAnchor).toEqual({ startAge: 27, month: 6, day: 6 });
    expect(ensureCharacterAge(character, at(START + 99, 1, 1))).toBe(false);
    expect(character.ageAnchor).toEqual({ startAge: 27, month: 6, day: 6 });
  });

  it('主角建号年龄（customFields.age）在开局时刻原样成为开局年龄', () => {
    const player = createDefaultCharacterState({ type: 'player', customFields: { age: 22 } });
    ensureCharacterAge(player, createDefaultTime());
    expect(player.ageAnchor).toEqual({ startAge: 22, month: 1, day: 1 });
  });

  it('非法锚点视为缺失并重建', () => {
    const character = createDefaultCharacterState({ name: '坏档' });
    character.ageAnchor = { startAge: 30, month: 13, day: 1 };
    expect(ensureCharacterAge(character, at(START, 1, 1))).toBe(true);
    expect(character.ageAnchor).toEqual({ startAge: 18, month: 1, day: 1 });
  });

  it('未回填锚点或缺游戏时间时不显示年龄', () => {
    const character = createDefaultCharacterState({ name: '旧档角色' });
    expect(characterAge(character, at(START, 1, 1))).toBeNull();
    expect(formatCharacterAge(character, at(START, 1, 1))).toBe('');
    character.ageAnchor = { startAge: 17, month: 3, day: 15 };
    expect(formatCharacterAge(character, null)).toBe('');
    expect(formatCharacterAge(character, at(START, 3, 15))).toBe('18岁（生日3月15日）');
  });

  it('原生定义读取 age / birthday，写坏的只丢这一项', () => {
    const base = { profile: {}, assets: [], past: [] };
    const definitions = readCharacterDefinitions([
      { ...base, id: 'a', name: '甲', age: 34, birthday: { month: 3, day: 15 } },
      { ...base, id: 'b', name: '乙', birthday: '4月2日' },
      { ...base, id: 'c', name: '丙', age: '不详', birthday: '某个冬天' },
    ]);
    expect(definitions).toHaveLength(3);
    expect(definitions[0]).toMatchObject({ age: 34, birthday: { month: 3, day: 15 } });
    expect(definitions[1].birthday).toEqual({ month: 4, day: 2 });
    expect(definitions[2].age).toBeUndefined();
    expect(definitions[2].birthday).toBeUndefined();
  });

  it('旧世界书人物只认整行明确的年龄，带限定语的不猜', () => {
    expect(extractLoreAge('姓名: 甲\n年龄: 20岁\n种族: 人类')).toBe(20);
    expect(extractLoreAge('- 年龄：约400岁')).toBe(400);
    expect(extractLoreAge('年龄: 外貌约16岁 (实际百年以上)')).toBeUndefined();
    expect(extractLoreAge('年龄: 19 (实际年龄160岁)')).toBeUndefined();
    expect(extractLoreAge('年龄: 未知')).toBeUndefined();

    const profile = (name: string) =>
      `<%# char-info-ejs-builder:start:v3 %><% const profile = {"characterName":"${name}","avatarUrl":"https://example.com/a.png"}; %><%# char-info-ejs-builder:end %>`;
    const book = {
      id: 'characters',
      partition: 'character',
      entries: [
        { uid: 'a', enabled: true, content: `沉默的佣兵。\n年龄: 26岁\n${profile('甲')}` },
        { uid: 'b', enabled: true, content: `森林的守望者。\n年龄: 外表16岁\n${profile('乙')}` },
      ],
    } as WorldBook;
    const legacy = legacyCharacterDefinitions([book]);
    expect(legacy.map((d) => [d.name, d.age])).toEqual([
      ['甲', 26],
      ['乙', undefined],
    ]);
  });
});
