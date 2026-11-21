import { describe, expect, it } from 'vitest';
import { buildDirectProtocol } from '../../../src/core/prompts/direct-prompt';

const variants = [
  ['结构化战斗开启', buildDirectProtocol(true)],
  ['结构化战斗关闭', buildDirectProtocol(false)],
] as const;

describe('直出协议：骰池与 diceUsed', () => {
  it.each(variants)('%s：diceUsed 以 sides + 行内位置寻址', (_label, text) => {
    expect(text).toContain(
      'diceUsed:[{sides:骰面数,index:该骰式行内从 0 起的位置,purpose:"判定用途",target:"对象名"}]',
    );
    expect(text).not.toContain('骰池索引');
  });

  it.each(variants)('%s：骰池按骰式分行的花括号格式，逐位取用、用尽即停', (_label, text) => {
    expect(text).toContain('d20: {12, 5, 17}');
    expect(text).toContain('依次为 d4、d6、d8、d10、d12、d20、d100');
    expect(text).toContain('从左到右依次取用，每个位置至多消费一次');
    expect(text).toContain('所需骰式用尽就停在尚未解决的行动前，不编造骰值');
  });
});

describe('直出协议：character 实体嵌套', () => {
  it.each(variants)('%s：人物字段写进 output.character，并给嵌套示例', (_label, text) => {
    expect(text).toContain(
      'kind 为 character 时人物字段全部写进 output.character，不平铺在 output 上',
    );
    expect(text).toContain('output 顶层的 skills/equipment/inventory 仍必填');
    expect(text).toContain('loadout 的 output 不含 character');
    expect(text).toContain(
      '{kind:"character",placement:{location:"…",present:true},output:{skills:[],equipment:[],inventory:[],statuses:[],character:{name:"…",race:"…",…,skills:[],equipment:[],inventory:[],ascension:{…}}}}',
    );
  });
});
