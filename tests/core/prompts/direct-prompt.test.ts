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

describe('直出协议：2026-11-21 格式契约补全', () => {
  it.each(variants)('%s：登神条目形状与凡人默认对象', (_label, text) => {
    expect(text).toContain('登神条目是对象，不能只写名字');
    expect(text).toContain('elements 项 {name,description,effects:[]}');
    expect(text).toContain('authorities 项 {name,description,effects:[],costDescription}');
    expect(text).toContain(
      'laws 项 {name,description,passiveEffects:[],activeEffects:[],costDescription}',
    );
    expect(text).toContain('人物必须带 ascension（凡人写下方 enabled:false 默认对象）');
    expect(text).toContain('人物字段除 thoughts 外全部必填');
  });

  it.each(variants)('%s：statuses 归属、loadout 登神整份替换、存档字段名提醒', (_label, text) => {
    expect(text).toContain('owner 必须等于本实体人物名（loadout 为其 owner）');
    expect(text).toContain('写了即整份替换该人物登神状态，不写即不改');
    expect(text).toContain('新建实体用本协议字段名，不要照抄');
    expect(text).toContain(
      '输入状态区块（direct_state；缓存直出为 direct_context）里的人物用存档字段名',
    );
    // 不再写死只有非缓存直出才有的区块路径
    expect(text).not.toContain('看 direct_state.plotSettings.mode');
    expect(text).not.toContain('。direct_state 用存档字段名');
  });

  it.each(variants)('%s：JSON 不加围栏、effects 包 value、plot 开关与 null', (_label, text) => {
    expect(text).toContain('不加代码围栏、不加注释或说明文字');
    expect(text).toContain('效果字段必须包在 value 里');
    expect(text).toContain('remainingTime(null 为永久，否则 ≥0)');
    expect(text).toContain(
      '剧情开关看输入状态区块的 plotSettings.mode（direct_state.plotSettings；缓存直出为 direct_context 的 plotSettings 分区）：为 off 时 plot 写 {}',
    );
    expect(text).toContain('不写 null');
  });

  it.each(variants)('%s：character_updates 名字须有实体，否则该条不入库', (_label, text) => {
    expect(text).toContain('character_updates 里的每个 name 必须已有实体或由本楼 entities 新建');
    expect(text).toContain('否则该条更新不会入库');
    expect(text).not.toContain('整楼作废');
  });

  it.each(variants)('%s：state 取值类型与 diceUsed 非空', (_label, text) => {
    expect(text).toContain('present 为布尔');
    expect(text).toContain('consume/transfer 的 quantity 为正整数');
    expect(text).toContain('purpose 与 target 不能为空');
  });
});
