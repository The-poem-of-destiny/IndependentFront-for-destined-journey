/**
 * plugin-commands.ts —— 插件命令翻译（§5.3）与前置条件求值（§5.4）。
 */
import { describe, expect, it } from 'vitest';
import {
  evaluatePluginExpect,
  translatePluginCommands,
} from '../../../src/core/plugins/plugin-commands';
import { PLUGIN_COMMANDS } from '../../../src/core/plugins/plugin-surface';
import {
  createDefaultCharacterState,
  type CharacterState,
  type SaveProfile,
  type StatePatch,
} from '../../../src/core/types/types';
import type { PluginExpectState } from '../../../src/core/types/types-plugin';

const ALL_COMMANDS = Object.keys(PLUGIN_COMMANDS);
const PLAYER = '艾琳';

function run(commands: unknown, expectList?: unknown, declared: readonly string[] = ALL_COMMANDS) {
  return translatePluginCommands({
    commands,
    expect: expectList,
    declared,
    saveId: 'save-1',
    playerName: PLAYER,
  });
}

/** 单条命令翻译成功，返回那条补丁 */
function one(command: Record<string, unknown>): StatePatch {
  const result = run([command]);
  if (!result.ok) throw new Error(`期望成功，实际：${result.code} ${result.message}`);
  expect(result.patches).toHaveLength(1);
  expect(result.commandIndexOfPatch).toEqual([0]);
  const name = command.type as keyof typeof PLUGIN_COMMANDS;
  expect(PLUGIN_COMMANDS[name] as readonly string[]).toContain(result.patches[0].op);
  return result.patches[0];
}

function invalid(command: Record<string, unknown>): string {
  const result = run([command]);
  expect(result.ok).toBe(false);
  if (result.ok) return '';
  expect(result.code).toBe('INVALID');
  expect(result.index).toBe(0);
  return result.message;
}

describe('translatePluginCommands —— §5.3 每一行', () => {
  it('vars.set → set_variable variables.<path>', () => {
    expect(one({ type: 'vars.set', path: 'user.shop.stock', value: { potion: 3 } })).toEqual({
      op: 'set_variable',
      target: 'variables.user.shop.stock',
      value: { potion: 3 },
    });
    invalid({ type: 'vars.set', path: '', value: 1 });
    invalid({ type: 'vars.set', path: 'user..x', value: 1 });
    invalid({ type: 'vars.set', path: 'user.x' });
  });

  it('vars.delta → delta_variable，amount 必须为有限数', () => {
    expect(one({ type: 'vars.delta', path: 'user.n', amount: -2 })).toEqual({
      op: 'delta_variable',
      target: 'variables.user.n',
      amount: -2,
    });
    invalid({ type: 'vars.delta', path: 'user.n', amount: Number.POSITIVE_INFINITY });
    invalid({ type: 'vars.delta', path: 'user.n', amount: '3' });
  });

  it('vars.remove / vars.move / vars.insert', () => {
    expect(one({ type: 'vars.remove', path: 'user.a' })).toEqual({
      op: 'remove_variable',
      target: 'variables.user.a',
    });
    expect(one({ type: 'vars.move', path: 'user.a', toPath: 'user.b' })).toEqual({
      op: 'move_variable',
      target: 'variables.user.a',
      metadata: { toPath: 'user.b' },
    });
    invalid({ type: 'vars.move', path: 'user.a' });
    expect(one({ type: 'vars.insert', path: 'user.list', value: '新条目', index: 0 })).toEqual({
      op: 'insert_variable',
      target: 'variables.user.list',
      value: '新条目',
      metadata: { index: 0 },
    });
    invalid({ type: 'vars.insert', path: 'user.list', value: 1, index: -1 });
  });

  it('变量路径拒绝原型污染段', () => {
    invalid({ type: 'vars.set', path: 'user.constructor.x', value: 1 });
  });

  it('fp.add / fp.spend → delta_variable profile.fp，数额必须为正', () => {
    expect(one({ type: 'fp.add', amount: 5 })).toEqual({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: 5,
    });
    expect(one({ type: 'fp.spend', amount: 5 })).toEqual({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: -5,
    });
    invalid({ type: 'fp.spend', amount: -5 });
    invalid({ type: 'fp.add', amount: 0 });
  });

  it('character.update → update_character，可带 delta', () => {
    expect(
      one({ type: 'character.update', changes: { currentAction: '在杂货铺挑选药水', hp: 30 } }),
    ).toEqual({
      op: 'update_character',
      target: `characters.${PLAYER}`,
      value: { currentAction: '在杂货铺挑选药水', hp: 30 },
    });
    expect(
      one({
        type: 'character.update',
        target: '老店主',
        delta: true,
        changes: { money: 10, attributes: { str: 1 } },
      }),
    ).toEqual({
      op: 'update_character',
      target: 'characters.老店主',
      value: { money: 10, attributes: { str: 1 } },
      metadata: { delta: true },
    });
  });

  it('character.update 拒绝白名单外字段、数组实体与 delta 下的非数值字段', () => {
    invalid({ type: 'character.update', changes: { name: '新名' } });
    invalid({ type: 'character.update', changes: { inventory: [] } });
    invalid({ type: 'character.update', changes: { type: 'player' } });
    invalid({ type: 'character.update', changes: {} });
    invalid({ type: 'character.update', delta: true, changes: { currentAction: '跑' } });
    invalid({ type: 'character.update', changes: { hp: Number.NaN } });
    invalid({ type: 'character.update', changes: { attributes: { luck: 1 } } });
  });

  it('money.add → update_character {money:+n} delta', () => {
    expect(one({ type: 'money.add', amount: 12 })).toEqual({
      op: 'update_character',
      target: `characters.${PLAYER}`,
      value: { money: 12 },
      metadata: { delta: true },
    });
    invalid({ type: 'money.add', amount: Number.NaN });
  });

  it('money.spend → update_character {money:-n} delta，并补隐含前置条件', () => {
    const result = run([{ type: 'money.spend', amount: 30 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patches).toEqual([
      {
        op: 'update_character',
        target: `characters.${PLAYER}`,
        value: { money: -30 },
        metadata: { delta: true },
      },
    ]);
    expect(result.expect).toEqual([{ view: 'player.money', gte: 30 }]);
  });

  it('money.spend 多条合计成一条隐含前置条件，排在插件自己的前置条件之后', () => {
    const result = run(
      [
        { type: 'money.spend', amount: 30 },
        { type: 'money.spend', amount: 20 },
      ],
      [{ var: 'user.shop.open', eq: true }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.expect).toEqual([
      { var: 'user.shop.open', eq: true },
      { view: 'player.money', gte: 50 },
    ]);
    expect(result.commandIndexOfPatch).toEqual([0, 1]);
  });

  it('money.spend 只能花主角的钱、数额必须为正', () => {
    invalid({ type: 'money.spend', target: '老店主', amount: 5 });
    invalid({ type: 'money.spend', amount: -5 });
    expect(one({ type: 'money.spend', target: '主角', amount: 5 }).target).toBe(
      `characters.${PLAYER}`,
    );
  });

  it('resource.set / resource.delta → set_* / delta_*', () => {
    expect(one({ type: 'resource.set', resource: 'mp', value: 20 })).toEqual({
      op: 'set_mp',
      target: `characters.${PLAYER}`,
      value: 20,
    });
    expect(one({ type: 'resource.delta', target: '莉莉', resource: 'hp', amount: -5 })).toEqual({
      op: 'delta_hp',
      target: 'characters.莉莉',
      amount: -5,
    });
    expect(one({ type: 'resource.delta', resource: 'sp', amount: 3 }).op).toBe('delta_sp');
    invalid({ type: 'resource.set', resource: 'exp', value: 1 });
    invalid({ type: 'resource.set', value: 1 });
  });

  it('character.add 由 createDefaultCharacterState 补默认值，只收叙事字段', () => {
    const patch = one({
      type: 'character.add',
      character: { name: '老店主', race: '矮人', personality: '抠门但心软', aliases: ['掌柜'] },
    });
    expect(patch.op).toBe('add_character');
    expect(patch.target).toBe('characters.老店主');
    const value = patch.value as CharacterState;
    const defaults = createDefaultCharacterState();
    expect(typeof value.id).toBe('string');
    expect(value.id.length).toBeGreaterThan(0);
    expect(value.saveId).toBe('save-1');
    expect(value.type).toBe('npc');
    expect(value.race).toBe('矮人');
    expect(value.personality).toBe('抠门但心软');
    expect(value.aliases).toEqual(['掌柜']);
    expect(value.money).toBe(defaults.money);
    expect(value.hp).toBe(defaults.hp);
    expect(value.inventory).toEqual([]);
    expect(value.attributes).toEqual(defaults.attributes);
  });

  it('character.add 拒绝账务字段、玩家类型与主角名', () => {
    invalid({ type: 'character.add', character: { name: '老店主', money: 999 } });
    invalid({ type: 'character.add', character: { name: '老店主', inventory: [] } });
    invalid({ type: 'character.add', character: { name: '老店主', type: 'player' } });
    invalid({ type: 'character.add', character: { name: PLAYER } });
    invalid({ type: 'character.add', character: { name: '主角' } });
    invalid({ type: 'character.add', character: {} });
  });

  it('character.remove → remove_character，拒绝主角', () => {
    expect(one({ type: 'character.remove', target: '哥布林' })).toEqual({
      op: 'remove_character',
      target: 'characters.哥布林',
    });
    invalid({ type: 'character.remove', target: PLAYER });
    invalid({ type: 'character.remove', target: '玩家' });
    invalid({ type: 'character.remove' });
  });

  it('character.rename → rename_character，值是新名字符串', () => {
    expect(one({ type: 'character.rename', target: '无名旅人', name: '雷恩' })).toEqual({
      op: 'rename_character',
      target: 'characters.无名旅人',
      value: '雷恩',
    });
    invalid({ type: 'character.rename', target: '无名旅人', name: '主角' });
    invalid({ type: 'character.rename', target: '无名旅人', name: '' });
  });

  it('character.rename：缺目标、目标是主角名或主角别名 ⇒ INVALID（翻译期拒绝）', () => {
    expect(invalid({ type: 'character.rename', name: '雷恩' })).not.toBe('');
    expect(invalid({ type: 'character.rename', target: PLAYER, name: '雷恩' })).toContain(
      '不能给主角改名',
    );
    expect(invalid({ type: 'character.rename', target: '主角', name: '雷恩' })).toContain(
      '不能给主角改名',
    );
    expect(invalid({ type: 'character.rename', target: '玩家', name: '雷恩' })).toContain(
      '不能给主角改名',
    );
  });

  it('status.add → add_status_effect，分类枚举归一', () => {
    expect(
      one({
        type: 'status.add',
        status: {
          name: '药效',
          category: 'buff',
          remainingTime: 30,
          timeUnit: '分钟',
          effects: { 力量: 1 },
        },
      }),
    ).toEqual({
      op: 'add_status_effect',
      target: `characters.${PLAYER}`,
      value: {
        name: '药效',
        category: '增益',
        remainingTime: 30,
        timeUnit: '分钟',
        effects: { 力量: 1 },
      },
    });
    expect(
      (
        one({ type: 'status.add', status: { name: '诅咒', remainingTime: null } }).value as Record<
          string,
          unknown
        >
      ).remainingTime,
    ).toBeNull();
    invalid({ type: 'status.add', status: { name: '药效', category: '奇怪' } });
    invalid({ type: 'status.add', status: { name: '药效', timeUnit: '天' } });
  });

  it('status.update / status.remove', () => {
    expect(one({ type: 'status.update', name: '药效', stacks: 2 })).toEqual({
      op: 'update_status_effect',
      target: `characters.${PLAYER}`,
      value: { name: '药效', stacks: 2 },
    });
    invalid({ type: 'status.update', name: '药效' });
    expect(one({ type: 'status.remove', target: '莉莉', name: '中毒' })).toEqual({
      op: 'remove_status_effect',
      target: 'characters.莉莉',
      value: { name: '中毒' },
    });
  });

  it('item.grant → add_item，name 必填、枚举归一、拒绝 equippedSlot', () => {
    expect(one({ type: 'item.grant', item: { name: '绳索' } })).toEqual({
      op: 'add_item',
      target: `characters.${PLAYER}`,
      value: { name: '绳索', quantity: 1 },
    });
    invalid({ type: 'item.grant', item: { quantity: 1 } });
    invalid({ type: 'item.grant', item: { name: '剑', equippedSlot: '武器' } });
    invalid({ type: 'item.grant', item: { name: '剑', rarity: '超神' } });
    invalid({ type: 'item.grant', item: { name: '剑', quantity: 1.5 } });
  });

  it('item.remove → remove_item，缺省数量 1', () => {
    expect(one({ type: 'item.remove', name: '治疗药水' })).toEqual({
      op: 'remove_item',
      target: `characters.${PLAYER}`,
      value: { name: '治疗药水', quantity: 1 },
    });
    invalid({ type: 'item.remove', name: '治疗药水', quantity: 0 });
  });

  it('item.update → update_item，不能改 name / quantity', () => {
    expect(
      one({ type: 'item.update', name: '旧剑', changes: { durability: 3, type: 'weapon' } }),
    ).toEqual({
      op: 'update_item',
      target: `characters.${PLAYER}`,
      value: { name: '旧剑', changes: { durability: 3, type: '装备' } },
    });
    invalid({ type: 'item.update', name: '旧剑', changes: { name: '新剑' } });
    invalid({ type: 'item.update', name: '旧剑', changes: { quantity: 2 } });
    invalid({ type: 'item.update', name: '旧剑', changes: {} });
  });

  it('item.transfer → transfer_item，不许转给自己', () => {
    expect(one({ type: 'item.transfer', name: '信件', to: '莉莉', quantity: 1 })).toEqual({
      op: 'transfer_item',
      target: `characters.${PLAYER}`,
      value: { name: '信件', to: '莉莉', quantity: 1 },
    });
    invalid({ type: 'item.transfer', name: '信件', to: PLAYER });
    invalid({ type: 'item.transfer', name: '信件' });
  });

  it('item.equip / item.unequip 槽位枚举归一', () => {
    expect(one({ type: 'item.equip', name: '短剑', slot: 'weapon' })).toEqual({
      op: 'equip_item',
      target: `characters.${PLAYER}`,
      value: { name: '短剑', slot: '武器' },
    });
    invalid({ type: 'item.equip', name: '短剑', slot: '尾巴' });
    expect(one({ type: 'item.unequip', slot: '头盔' }).value).toEqual({ slot: '头部' });
    expect(one({ type: 'item.unequip', name: '短剑' }).value).toEqual({ name: '短剑' });
    invalid({ type: 'item.unequip', name: '短剑', slot: '武器' });
    invalid({ type: 'item.unequip' });
  });

  it('skill.add / skill.update / skill.remove 按名寻址', () => {
    expect(
      one({
        type: 'skill.add',
        skill: { name: '砍价', type: 'passive', rarity: 'rare', cost: { type: 'SP', amount: 2 } },
      }),
    ).toEqual({
      op: 'add_skill',
      target: `characters.${PLAYER}`,
      value: { name: '砍价', type: 'passive', rarity: '稀有', cost: { type: 'SP', amount: 2 } },
    });
    invalid({ type: 'skill.add', skill: { name: '砍价', type: 'magic' } });
    expect(one({ type: 'skill.update', name: '砍价', changes: { level: 2 } })).toEqual({
      op: 'update_skill',
      target: `characters.${PLAYER}`,
      value: { name: '砍价', changes: { level: 2 } },
    });
    invalid({ type: 'skill.update', name: '砍价', changes: { name: '讲价' } });
    expect(one({ type: 'skill.remove', name: '砍价' })).toEqual({
      op: 'remove_skill',
      target: `characters.${PLAYER}`,
      value: { name: '砍价' },
    });
  });

  it('location.set → set_location，非空字符串', () => {
    expect(one({ type: 'location.set', location: '王都/商业区/杂货铺' })).toEqual({
      op: 'set_location',
      target: `characters.${PLAYER}`,
      value: '王都/商业区/杂货铺',
    });
    invalid({ type: 'location.set', location: '   ' });
  });

  it('quest.upsert / quest.remove，name 必填、状态用中文枚举', () => {
    expect(
      one({ type: 'quest.upsert', quest: { name: '采购药水', status: '进行中', priority: '高' } }),
    ).toEqual({
      op: 'update_quest',
      target: 'quests.采购药水',
      value: { name: '采购药水', status: '进行中', priority: '高' },
    });
    invalid({ type: 'quest.upsert', quest: { status: '进行中' } });
    invalid({ type: 'quest.upsert', quest: { name: '采购药水', status: 'done' } });
    expect(one({ type: 'quest.remove', name: '采购药水' })).toEqual({
      op: 'remove_quest',
      target: 'quests.采购药水',
      value: { name: '采购药水' },
    });
  });

  it('affection.set / affection.delta → affections.<角色名>', () => {
    expect(one({ type: 'affection.set', name: '莉莉', value: 40 })).toEqual({
      op: 'set_affection',
      target: 'affections.莉莉',
      value: 40,
    });
    expect(one({ type: 'affection.delta', name: '莉莉', amount: -3 })).toEqual({
      op: 'delta_affection',
      target: 'affections.莉莉',
      amount: -3,
    });
    invalid({ type: 'affection.delta', name: '莉莉', amount: Number.NaN });
  });

  it('news.add → add_news，title 与 content 必填', () => {
    expect(one({ type: 'news.add', title: '药价上涨', content: '城里的药水涨了两成。' })).toEqual({
      op: 'add_news',
      target: 'news',
      value: { title: '药价上涨', content: '城里的药水涨了两成。' },
    });
    invalid({ type: 'news.add', title: '药价上涨' });
  });

  it('plot.updateEvent → update_plot_event，只开放叙事字段', () => {
    expect(
      one({ type: 'plot.updateEvent', eventId: 'evt-1', changes: { status: 'completed' } }),
    ).toEqual({
      op: 'update_plot_event',
      target: 'plotEvents.evt-1',
      value: { eventId: 'evt-1', changes: { status: 'completed' } },
    });
    invalid({ type: 'plot.updateEvent', eventId: 'evt-1', changes: { order: 3 } });
    invalid({ type: 'plot.updateEvent', eventId: 'evt-1', changes: { status: 'done' } });
    invalid({ type: 'plot.updateEvent', changes: { status: 'completed' } });
  });

  it('map.tile.* 六条，value.tile 是地块名', () => {
    expect(
      one({
        type: 'map.tile.statusAdd',
        tile: '银溪镇',
        title: '集市日',
        durationDays: 3,
        effects: [{ kind: 'devProgressPerMonth', amount: 1 }],
      }),
    ).toEqual({
      op: 'tile_status_add',
      target: 'map',
      value: {
        tile: '银溪镇',
        title: '集市日',
        durationDays: 3,
        effects: [{ kind: 'devProgressPerMonth', amount: 1 }],
      },
    });
    expect(one({ type: 'map.tile.statusRemove', tile: '银溪镇', title: '集市日' }).op).toBe(
      'tile_status_remove',
    );
    expect(
      one({ type: 'map.tile.buildingAdd', tile: '银溪镇', name: '杂货铺', income: { amount: 5 } })
        .value,
    ).toEqual({ tile: '银溪镇', name: '杂货铺', income: { amount: 5 } });
    expect(
      one({ type: 'map.tile.buildingUpdate', tile: '银溪镇', main: true, playerOwned: true }).value,
    ).toEqual({ tile: '银溪镇', main: true, playerOwned: true });
    expect(one({ type: 'map.tile.devProgressAdd', tile: '银溪镇', amount: -2 }).value).toEqual({
      tile: '银溪镇',
      amount: -2,
    });
    expect(one({ type: 'map.tile.historyNote', tile: '银溪镇', text: '新店开张' }).op).toBe(
      'tile_history_note',
    );
    invalid({ type: 'map.tile.statusAdd', title: '集市日' });
    invalid({ type: 'map.tile.buildingAdd', tile: '银溪镇', name: '城堡', main: true });
    invalid({
      type: 'map.tile.buildingAdd',
      tile: '银溪镇',
      name: '杂货铺',
      income: { amount: -5 },
    });
    invalid({ type: 'map.tile.buildingUpdate', tile: '银溪镇', description: '翻新' });
    invalid({ type: 'map.tile.devProgressAdd', tile: '银溪镇', amount: 0 });
  });

  it('没有地图标记命令', () => {
    expect(ALL_COMMANDS.some((name) => name.includes('marker'))).toBe(false);
    const result = run([{ type: 'map.marker.add', name: '宝箱' }]);
    expect(result).toMatchObject({ ok: false, code: 'INVALID', index: 0 });
  });
});

describe('translatePluginCommands —— 通用校验', () => {
  it('载荷任何深度出现 id 或 saveId 即 INVALID', () => {
    expect(invalid({ type: 'item.grant', item: { name: '剑', id: 'x' } })).toContain('item.id');
    expect(
      invalid({ type: 'vars.set', path: 'user.a', value: { list: [{ saveId: 's' }] } }),
    ).toContain('saveId');
    invalid({ type: 'money.add', amount: 1, id: 'abc' });
  });

  it('未声明的命令名 DENIED，并带下标', () => {
    const result = run(
      [
        { type: 'money.spend', amount: 1 },
        { type: 'fp.add', amount: 1 },
      ],
      undefined,
      ['money.spend'],
    );
    expect(result).toMatchObject({ ok: false, code: 'DENIED', index: 1 });
  });

  it('未知命令名或缺 type 即 INVALID', () => {
    expect(run([{ type: 'money.steal', amount: 1 }])).toMatchObject({
      ok: false,
      code: 'INVALID',
      index: 0,
    });
    expect(run([{ amount: 1 }])).toMatchObject({ ok: false, code: 'INVALID', index: 0 });
    expect(run('money.add')).toMatchObject({ ok: false, code: 'INVALID' });
    expect(run([])).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('载荷里有不认识的键即 INVALID', () => {
    invalid({ type: 'money.add', amount: 1, reason: '奖励' });
  });

  it('memory.add → add_memory，只带正文 / 关键词 / 重要度，不带 id', () => {
    expect(
      one({
        type: 'memory.add',
        content: '  一段回忆  ',
        keywords: [' 约定 ', '店主'],
        importance: 8,
      }),
    ).toEqual({
      op: 'add_memory',
      target: 'memories',
      value: { content: '一段回忆', keywords: ['约定', '店主'], importance: 8 },
    });
    // 关键词与重要度可缺省：空数组、中值 5
    expect(one({ type: 'memory.add', content: '一段回忆' }).value).toEqual({
      content: '一段回忆',
      keywords: [],
      importance: 5,
    });
  });

  it('memory.add 带 id / saveId / 其他字段即 INVALID', () => {
    invalid({ type: 'memory.add', content: '一段回忆', id: 'MEM000001' });
    invalid({ type: 'memory.add', content: '一段回忆', saveId: 'save-1' });
    invalid({ type: 'memory.add', content: '一段回忆', hiddenLine: '暗线' });
    invalid({ type: 'memory.add', content: '一段回忆', relatedCharacterIds: [] });
    invalid({ type: 'memory.add', content: '一段回忆', timeRange: { start: 'a', end: 'b' } });
  });

  it('memory.add 的上限：正文 ≤2000、关键词 ≤16 项且每项 ≤32、重要度 1–10 整数', () => {
    one({ type: 'memory.add', content: '记'.repeat(2000) });
    invalid({ type: 'memory.add', content: '记'.repeat(2001) });
    invalid({ type: 'memory.add', content: '   ' });
    invalid({ type: 'memory.add' });
    invalid({ type: 'memory.add', content: 1 });
    one({
      type: 'memory.add',
      content: '回忆',
      keywords: Array.from({ length: 16 }, (_, i) => `k${i}`),
    });
    invalid({
      type: 'memory.add',
      content: '回忆',
      keywords: Array.from({ length: 17 }, (_, i) => `k${i}`),
    });
    one({ type: 'memory.add', content: '回忆', keywords: ['词'.repeat(32)] });
    invalid({ type: 'memory.add', content: '回忆', keywords: ['词'.repeat(33)] });
    invalid({ type: 'memory.add', content: '回忆', keywords: [''] });
    invalid({ type: 'memory.add', content: '回忆', keywords: [1] });
    invalid({ type: 'memory.add', content: '回忆', keywords: '约定' });
    one({ type: 'memory.add', content: '回忆', importance: 1 });
    one({ type: 'memory.add', content: '回忆', importance: 10 });
    invalid({ type: 'memory.add', content: '回忆', importance: 0 });
    invalid({ type: 'memory.add', content: '回忆', importance: 11 });
    invalid({ type: 'memory.add', content: '回忆', importance: 5.5 });
    invalid({ type: 'memory.add', content: '回忆', importance: '5' });
  });

  it('memory.add 未在 manifest 声明即 DENIED', () => {
    const result = run([{ type: 'memory.add', content: '一段回忆' }], undefined, ['money.add']);
    expect(result).toMatchObject({ ok: false, code: 'DENIED', index: 0 });
  });

  it('整次提交序列化超过 256KB 即 INVALID', () => {
    const big = 'a'.repeat(256 * 1024);
    const result = run([{ type: 'vars.set', path: 'user.blob', value: big }]);
    expect(result).toMatchObject({ ok: false, code: 'INVALID' });
    if (!result.ok) expect(result.index).toBeUndefined();
  });

  it('前置条件形状不对即 INVALID', () => {
    expect(run([{ type: 'fp.add', amount: 1 }], [{ view: 'player.hp', gte: 1 }])).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(run([{ type: 'fp.add', amount: 1 }], [{ var: 'user.a', gte: 1, eq: 2 }])).toMatchObject({
      ok: false,
      code: 'INVALID',
    });
    expect(run([{ type: 'fp.add', amount: 1 }], 'x')).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('commandIndexOfPatch 逐条对应命令下标', () => {
    const result = run([
      { type: 'fp.add', amount: 1 },
      { type: 'news.add', title: '标题', content: '正文' },
      { type: 'location.set', location: '城门' },
    ]);
    expect(result.ok && result.commandIndexOfPatch).toEqual([0, 1, 2]);
  });
});

describe('§7 商店示例的购买流程', () => {
  it('money.spend + item.grant 翻成两条补丁外加余额 ≥ 30 的隐含前置条件', () => {
    const result = run(
      [
        { type: 'money.spend', amount: 30 },
        {
          type: 'item.grant',
          item: {
            name: '治疗药水',
            quantity: 1,
            type: 'consumable',
            rarity: '普通',
            description: '…',
          },
        },
      ],
      undefined,
      ['money.spend', 'item.grant'],
    );
    expect(result).toEqual({
      ok: true,
      patches: [
        {
          op: 'update_character',
          target: `characters.${PLAYER}`,
          value: { money: -30 },
          metadata: { delta: true },
        },
        {
          op: 'add_item',
          target: `characters.${PLAYER}`,
          value: {
            name: '治疗药水',
            quantity: 1,
            type: '消耗品',
            rarity: '普通',
            description: '…',
          },
        },
      ],
      expect: [{ view: 'player.money', gte: 30 }],
      commandIndexOfPatch: [0, 1],
    });
  });
});

function makeState(): PluginExpectState {
  const player = createDefaultCharacterState({
    name: PLAYER,
    type: 'player',
    money: 40,
    inventory: [{ name: '治疗药水', quantity: 2 }],
  });
  const keeper = createDefaultCharacterState({
    name: '老店主',
    aliases: ['掌柜'],
    inventory: [{ name: '铜钥匙', quantity: 1 }],
  });
  const profile = {
    variables: { user: { shop: { stock: { potion: 3 }, open: true, tags: ['新'] } } },
  } as unknown as SaveProfile;
  return { characters: [player, keeper], profile };
}

describe('evaluatePluginExpect —— §5.4 每一种前置条件', () => {
  const state = makeState();

  it('player.money gte：满足与不满足', () => {
    expect(evaluatePluginExpect([{ view: 'player.money', gte: 40 }], state)).toEqual({ ok: true });
    expect(evaluatePluginExpect([{ view: 'player.money', gte: 41 }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
  });

  it('item gte：缺省主角、owner 可用名字或别名', () => {
    expect(evaluatePluginExpect([{ item: '治疗药水', gte: 2 }], state)).toEqual({ ok: true });
    expect(evaluatePluginExpect([{ item: '治疗药水', gte: 3 }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
    expect(evaluatePluginExpect([{ item: '铜钥匙', owner: '掌柜', gte: 1 }], state)).toEqual({
      ok: true,
    });
    expect(evaluatePluginExpect([{ item: '铜钥匙', owner: '路人', gte: 1 }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
  });

  it('var gte：满足、不足、非数值', () => {
    expect(evaluatePluginExpect([{ var: 'user.shop.stock.potion', gte: 1 }], state)).toEqual({
      ok: true,
    });
    expect(evaluatePluginExpect([{ var: 'user.shop.stock.potion', gte: 4 }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
    expect(evaluatePluginExpect([{ var: 'user.shop.open', gte: 1 }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
  });

  it('var eq：按 JSON 值深比较', () => {
    expect(evaluatePluginExpect([{ var: 'user.shop.tags', eq: ['新'] }], state)).toEqual({
      ok: true,
    });
    expect(evaluatePluginExpect([{ var: 'user.shop.open', eq: false }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
  });

  it('var exists：真与假两个方向', () => {
    expect(evaluatePluginExpect([{ var: 'user.shop.open', exists: true }], state)).toEqual({
      ok: true,
    });
    expect(evaluatePluginExpect([{ var: 'user.shop.missing', exists: false }], state)).toEqual({
      ok: true,
    });
    expect(evaluatePluginExpect([{ var: 'user.shop.missing', exists: true }], state)).toMatchObject(
      { ok: false, index: 0 },
    );
    expect(evaluatePluginExpect([{ var: 'user.shop.open', exists: false }], state)).toMatchObject({
      ok: false,
      index: 0,
    });
  });

  it('返回第一条失败的下标；空列表与缺省都算满足', () => {
    const result = evaluatePluginExpect(
      [
        { view: 'player.money', gte: 1 },
        { item: '治疗药水', gte: 1 },
        { var: 'user.shop.stock.potion', gte: 99 },
      ],
      state,
    );
    expect(result).toMatchObject({ ok: false, index: 2 });
    expect(evaluatePluginExpect([], state)).toEqual({ ok: true });
    expect(evaluatePluginExpect(undefined, state)).toEqual({ ok: true });
  });

  it('形状不合法也算不满足', () => {
    expect(
      evaluatePluginExpect([{ ok: 1 }, { view: 'player.money', gte: 1 }], state),
    ).toMatchObject({ ok: false, index: 0 });
  });

  it('没有主角时 player.money 不满足', () => {
    const noPlayer: PluginExpectState = { ...state, characters: [state.characters[1]] };
    expect(evaluatePluginExpect([{ view: 'player.money', gte: 0 }], noPlayer)).toMatchObject({
      ok: false,
    });
  });

  it('翻译出的隐含前置条件可直接交给求值：余额不足时失败', () => {
    const result = run([{ type: 'money.spend', amount: 50 }]);
    if (!result.ok) throw new Error('应成功');
    expect(evaluatePluginExpect(result.expect, state)).toMatchObject({ ok: false, index: 0 });
  });
});
