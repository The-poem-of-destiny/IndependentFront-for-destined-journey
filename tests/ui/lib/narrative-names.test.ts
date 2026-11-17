/**
 * narrative-names.ts — 「名字初次登场」的纯判定
 *
 * 守的是：已知名来源与品质门槛；最长优先、不在更长名字内部匹配；早先出现过的不算；
 * 每条至多 3 个。
 */
import { describe, expect, it } from 'vitest';
import type { CharacterState, InventoryItem } from '@engine/types/types';
import {
  MAX_FIRST_MENTIONS,
  buildNameIndex,
  collectKnownNames,
  findFirstMentions,
  scanNames,
} from '../../../src/ui/lib/narrative-names';

type CharacterSource = Pick<CharacterState, 'type' | 'name' | 'location' | 'inventory'>;

function item(name: string, rarity?: InventoryItem['rarity']): InventoryItem {
  return { name, quantity: 1, rarity };
}

describe('collectKnownNames', () => {
  it('收角色名、玩家稀有以上物品、位置路径段与地块名，过滤单字', () => {
    const characters: CharacterSource[] = [
      {
        type: 'player',
        name: '洛恩',
        location: '大陆中东部区域-奥古斯提姆帝国-艾瑟嘉德-城',
        inventory: [item('破旧斗篷', '普通'), item('星辉短剑', '稀有'), item('龙鳞盾', '传说')],
      },
      { type: 'npc', name: '艾琳娜', location: '', inventory: [item('神谕之书', '神话')] },
    ];
    const names = collectKnownNames({ characters, mapTileNames: ['银溪镇', '海'] });
    expect(names).toEqual(
      expect.arrayContaining([
        '洛恩',
        '艾琳娜',
        '星辉短剑',
        '龙鳞盾',
        '艾瑟嘉德',
        '奥古斯提姆帝国',
        '银溪镇',
      ]),
    );
    expect(names).not.toContain('破旧斗篷');
    // NPC 背包不收；单字路径段与单字地块不收
    expect(names).not.toContain('神谕之书');
    expect(names).not.toContain('城');
    expect(names).not.toContain('海');
  });
});

describe('scanNames', () => {
  it('最长优先，短名不在长名内部再匹配', () => {
    const index = buildNameIndex(['艾琳', '艾琳娜', '银溪']);
    const matches = scanNames('艾琳娜走进银溪，艾琳回头。', index);
    expect(matches.map((m) => m.name)).toEqual(['艾琳娜', '银溪', '艾琳']);
    expect(matches[0]).toMatchObject({ start: 0, end: 3 });
  });
});

describe('findFirstMentions', () => {
  const index = buildNameIndex(['艾琳', '艾琳娜', '洛恩', '银溪镇', '星辉短剑', '龙鳞盾']);

  it('跳过早先消息里出现过的名字，按出现先后返回', () => {
    const found = findFirstMentions('洛恩与艾琳娜来到银溪镇。', index, ['洛恩醒来。']);
    expect(found).toEqual(['艾琳娜', '银溪镇']);
  });

  it('早先只以长名形式出现过的短名仍算初次登场', () => {
    const found = findFirstMentions('艾琳挥手。', index, ['艾琳娜在等。']);
    expect(found).toEqual(['艾琳']);
  });

  it('每条至多 3 个', () => {
    const found = findFirstMentions('洛恩、艾琳娜、银溪镇、星辉短剑、龙鳞盾', index, []);
    expect(found).toHaveLength(MAX_FIRST_MENTIONS);
    expect(found).toEqual(['洛恩', '艾琳娜', '银溪镇']);
  });

  it('同名重复出现只算一个', () => {
    expect(findFirstMentions('洛恩看着洛恩的影子', index, [])).toEqual(['洛恩']);
  });

  it('没有已知名时返回空', () => {
    expect(findFirstMentions('洛恩', buildNameIndex([]), [])).toEqual([]);
  });
});
