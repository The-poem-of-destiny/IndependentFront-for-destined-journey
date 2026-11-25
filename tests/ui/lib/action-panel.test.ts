/**
 * action-panel.ts — `<action_info>` 面板纯解析器
 *
 * 守的是：正文切片容忍流式残缺；分节 / 行 / 格的拆法覆盖世界书竖线表、直出 `|名称|值|`
 * 与制作投影三种来源；结论色只在该上色的地方上色；高亮 token 拼回去恒等于原值；任何输入都不抛。
 */
import { describe, expect, it } from 'vitest';
import { buildCraftPanelLines } from '@engine/crafting/craft-projection';
import { extractStoryBeats, resolveBeatBreaks } from '@engine/story/story-beats';
import { paragraphBreaks } from '../../../src/ui/lib/stage-playback';
import type {
  CraftActionRequest,
  CraftCheckResult,
  CraftPrepResult,
  CraftSettleResult,
  BeautifierRule,
} from '@engine/types/types';
import {
  cellTone,
  highlightValue,
  parseActionPanel,
  rulesClaimActionInfo,
  sectionHue,
  splitActionInfo,
  summaryCells,
  type ActionPanelCell,
} from '../../../src/ui/lib/action-panel';

const COMBAT = `{战况总览}
| 回合: 1 | 先攻: 莱恩 18 > 灰刃 12 > 林狼 9 |
{莱恩 -> 林狼 · 斩击}
| 检定: d20=15 +5 = 20 | 闪避: 13 | 结果: 命中 |
| 伤害: 42 物理 − 防御 8 = 34 |
| 林狼 HP: 60 → 26 |
| 莱恩 SP: 140 → 128 |`;

const CRAFT = `{生产准备}
| 目标: 精炼铁剑 | 数量: 1 | 类型: 成品 | 品质: 优良 |
| 行业: 锻造 | 核心属性: 力量 |
| 资源预检: SP 140 / 需 20 | 状态: 充足 |
{制作检定}
| 基础DC: 12 + 材料 2 − 减免 1 = 13 |
| 掷骰: d20=11 + 6 = 17 vs 13 | 结果: 成功 |
{生产结算}
| 产物: 精炼铁剑 ×1 | 品质: 优良 |
| 消耗: SP −20 | 经验: +35 |`;

function cellsOf(raw: string, sectionIndex = 0): ActionPanelCell[] {
  return parseActionPanel(raw).sections[sectionIndex].rows.flatMap((r) => r.cells);
}

function joined(value: string): string {
  return highlightValue(value)
    .map((t) => t.text)
    .join('');
}

describe('splitActionInfo — 正文切片', () => {
  it('普通闭合面板切成 文本 / 面板 / 文本', () => {
    const segs = splitActionInfo('前文<action_info>\n|a: 1|\n</action_info>后文');
    expect(segs).toEqual([
      { kind: 'text', text: '前文' },
      { kind: 'panel', raw: '\n|a: 1|\n' },
      { kind: 'text', text: '后文' },
    ]);
  });

  it('大小写与标签内空白都认', () => {
    const segs = splitActionInfo('甲< ACTION_INFO >x</ Action_Info >乙');
    expect(segs.map((s) => s.kind)).toEqual(['text', 'panel', 'text']);
    expect(segs[1]).toEqual({ kind: 'panel', raw: 'x' });
  });

  it('多个面板与纯空白文本片段：空白片段丢掉', () => {
    const segs = splitActionInfo('<action_info>A</action_info>\n\n<action_info>B</action_info>');
    expect(segs).toEqual([
      { kind: 'panel', raw: 'A' },
      { kind: 'panel', raw: 'B' },
    ]);
  });

  it('未闭合的开标签（流式中）把其后全部算面板', () => {
    const segs = splitActionInfo('正文<action_info>{检定}\n| 掷骰: d20=3');
    expect(segs).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'panel', raw: '{检定}\n| 掷骰: d20=3' },
    ]);
  });

  it('孤立的闭标签丢掉，两侧仍是文本', () => {
    const segs = splitActionInfo('前</action_info>后');
    expect(segs).toEqual([
      { kind: 'text', text: '前' },
      { kind: 'text', text: '后' },
    ]);
  });

  it('partial：结尾半截开标签被裁掉', () => {
    expect(splitActionInfo('正文<action_i', { partial: true })).toEqual([
      { kind: 'text', text: '正文' },
    ]);
    expect(splitActionInfo('正文<', { partial: true })).toEqual([{ kind: 'text', text: '正文' }]);
    // 非 partial 时原样保留
    expect(splitActionInfo('正文<action_i')).toEqual([{ kind: 'text', text: '正文<action_i' }]);
  });

  it('partial：未闭合面板结尾的半截闭标签被裁掉，普通的 < 不动', () => {
    expect(splitActionInfo('<action_info>| a: 1 |</action_in', { partial: true })).toEqual([
      { kind: 'panel', raw: '| a: 1 |' },
    ]);
    expect(splitActionInfo('HP < 50', { partial: true })).toEqual([
      { kind: 'text', text: 'HP < 50' },
    ]);
  });
});

describe('parseActionPanel — 战斗样例', () => {
  const panel = parseActionPanel(COMBAT);

  it('两个分节，标题与色相正确，-> 归一成 →', () => {
    expect(panel.sections.map((s) => s.title)).toEqual(['战况总览', '莱恩 → 林狼 · 斩击']);
    expect(panel.sections.map((s) => s.hue)).toEqual(['info', 'strike']);
  });

  it('多格行逐格拆 label / value', () => {
    expect(panel.sections[1].rows[0].cells).toEqual([
      { label: '检定', value: 'd20=15 +5 = 20' },
      { label: '闪避', value: '13' },
      { label: '结果', value: '命中', tone: 'success' },
    ]);
    expect(panel.sections[1].rows[2].cells).toEqual([{ label: '林狼 HP', value: '60 → 26' }]);
  });

  it('收起摘要：结论格优先，再关键标签，≤3', () => {
    const chips = summaryCells(panel.sections[1]);
    expect(chips.map((c) => c.label)).toEqual(['结果', '伤害', '林狼 HP']);
  });

  it('没有结论与关键标签时取前两格', () => {
    expect(summaryCells(panel.sections[0]).map((c) => c.label)).toEqual(['回合', '先攻']);
  });
});

describe('parseActionPanel — 制作样例', () => {
  const panel = parseActionPanel(CRAFT);

  it('三个分节与色相：准备 info / 检定 check / 结算 gain', () => {
    expect(panel.sections.map((s) => [s.title, s.hue])).toEqual([
      ['生产准备', 'info'],
      ['制作检定', 'check'],
      ['生产结算', 'gain'],
    ]);
  });

  it('{生产准备} 多格行与「状态: 充足」', () => {
    const cells = cellsOf(CRAFT, 0);
    expect(cells.slice(0, 4).map((c) => c.label)).toEqual(['目标', '数量', '类型', '品质']);
    expect(cells.find((c) => c.label === '状态')).toEqual({
      label: '状态',
      value: '充足',
      tone: 'success',
    });
  });

  it('基础DC 算式与「结果: 成功」', () => {
    const cells = cellsOf(CRAFT, 1);
    expect(cells[0]).toEqual({ label: '基础DC', value: '12 + 材料 2 − 减免 1 = 13' });
    expect(cells.find((c) => c.label === '结果')?.tone).toBe('success');
  });

  it('buildCraftPanelLines 的真实产出：成功路径', () => {
    const request = {
      productName: '精炼铁剑',
      stage: '成品',
      targetQuality: '优良',
      industry: '锻造',
      currentResources: { hp: 100, mp: 50, sp: 140 },
      resourceCosts: { hp: 0, mp: 0, sp: 20 },
      hasRecipe: true,
      materials: [{ itemName: '铁锭', quantity: 3 }],
    } as unknown as CraftActionRequest;
    const prep = {
      batchCount: 1,
      canProceed: true,
      regulatedCheck: { passed: true, missingLicenses: [] },
      qualityReqCheck: { passed: false, downgradeReason: '材料品质不足' },
      resourceCheck: { sufficient: true },
    } as unknown as CraftPrepResult;
    const check = {
      breakdown: {
        baseDC: 12,
        materialDCModifier: 2,
        bonusDCReduction: 1,
        finalDC: 13,
        fixedBonusBreakdown: { attribute: 3, skill: 2, tool: 1, identity: 0 },
        fixedBonus: 6,
        advantage: false,
        disadvantage: false,
        diceRolls: [11],
        diceValue: 11,
        totalValue: 17,
        rating: '成功',
      },
    } as unknown as CraftCheckResult;
    const settle = {
      breakdown: {
        resourceCost: { hp: 0, mp: 0, sp: 20 },
        materialLoss: { lossRate: 0, lostMaterials: [] },
        outputQuality: '优良',
        qualityDowngraded: false,
        productDCModifier: 1,
        expReward: { actualExp: 0, baseExp: 0, tierSuppressed: false },
      },
      fpReward: 0,
    } as unknown as CraftSettleResult;
    const raw = buildCraftPanelLines(request, prep, check, settle).join('\n');
    const panel = parseActionPanel(raw);
    expect(panel.sections.map((s) => s.title)).toEqual(['生产准备', '制作检定', '生产结算']);

    const prepCells = cellsOf(raw, 0);
    // 「不满足(…)」先判失败，不被「满足」吃掉
    expect(prepCells.find((c) => c.label === '品质要求检查')?.tone).toBe('error');
    expect(prepCells.find((c) => c.label === '管制投入物检查')?.tone).toBeUndefined();
    // `->` 归一
    expect(prepCells.find((c) => c.label === '批量检查')?.value).toBe('允许批量');

    const checkCells = cellsOf(raw, 1);
    expect(checkCells.find((c) => c.label === '检定结果')?.tone).toBe('success');
    expect(checkCells.find((c) => c.label === '掷骰')?.value).toBe('正常:d20(11)');

    const settleCells = cellsOf(raw, 2);
    // `状态: [制作成功]` → 结论标签 → success
    expect(settleCells.find((c) => c.label === '状态')?.tone).toBe('success');
  });

  it('buildCraftPanelLines 的资源不足终止行判失败', () => {
    const raw = [
      '{制作检定}',
      '| 状态: [终止] 资源不足 |',
      '| 资源预检: SP[5/20] | 状态: 不足(终止) |',
    ].join('\n');
    const cells = cellsOf(raw);
    expect(cells.filter((c) => c.label === '状态').map((c) => c.tone)).toEqual(['error', 'error']);
  });
});

describe('parseActionPanel — 结构边界', () => {
  it('直出 |名称|值| 格式合成一格', () => {
    const cells = cellsOf('|检定|d20=12，成功|\n|伤害|8|');
    expect(cells).toEqual([
      { label: '检定', value: 'd20=12，成功', tone: 'success' },
      { label: '伤害', value: '8' },
    ]);
  });

  it('两格里有冒号时不合成；三格无冒号各成无标签格', () => {
    expect(cellsOf('| 甲: 1 | 乙 |')).toEqual([
      { label: '甲', value: '1' },
      { label: '', value: '乙' },
    ]);
    expect(cellsOf('|a|b|c|').map((c) => c.label)).toEqual(['', '', '']);
  });

  it('全无标题：整面板一个空标题分节（渲染时为「行动详情」），色相 info', () => {
    const panel = parseActionPanel('| a: 1 |\n| b: 2 |');
    expect(panel.sections).toHaveLength(1);
    expect(panel.sections[0]).toMatchObject({ title: '', hue: 'info' });
    expect(panel.sections[0].rows).toHaveLength(2);
  });

  it('第一个标题前的内容归入空标题分节；空分节丢弃', () => {
    const panel = parseActionPanel('| 回合: 2 |\n{空的}\n{检定}\n| 掷骰: d20=4 |\n{也空}');
    expect(panel.sections.map((s) => s.title)).toEqual(['', '检定']);
  });

  it('{} 空标题行开一个空标题分节', () => {
    const panel = parseActionPanel('{准备}\n| a: 1 |\n{}\n| b: 2 |');
    expect(panel.sections.map((s) => s.title)).toEqual(['准备', '']);
  });

  it('一行多个 {…} 用 · 合并；全角｛｝也认', () => {
    expect(parseActionPanel('{甲}{乙}\n|a: 1|').sections[0].title).toBe('甲 · 乙');
    expect(parseActionPanel('｛制作检定｝\n|a: 1|').sections[0]).toMatchObject({
      title: '制作检定',
      hue: 'check',
    });
  });

  it('散行备注不丢，作为无标签格并入当前分节', () => {
    const cells = cellsOf('{检定}\n| 掷骰: d20=9 |\n灰刃在侧翼牵制');
    expect(cells[1]).toEqual({ label: '', value: '灰刃在侧翼牵制' });
  });

  it('全角竖线与全角冒号', () => {
    expect(cellsOf('｜结果：未命中｜伤害：0｜')).toEqual([
      { label: '结果', value: '未命中', tone: 'error' },
      { label: '伤害', value: '0' },
    ]);
  });

  it('剥 HTML 注释（含流式未闭合的）', () => {
    const panel = parseActionPanel('<!-- 内部推理 -->\n{检定}\n| a: 1 |\n<!-- 写到一半');
    expect(panel.sections).toHaveLength(1);
    expect(cellsOf('<!-- x\n| 藏: 1 |\n-->| 露: 2 |')).toEqual([{ label: '露', value: '2' }]);
  });

  it('传入带标签的原文也能解析', () => {
    expect(cellsOf('<action_info>| a: 1 |</action_info>')).toEqual([{ label: 'a', value: '1' }]);
  });

  it('空输入返回空面板', () => {
    expect(parseActionPanel('')).toEqual({ sections: [] });
    expect(parseActionPanel('  \n\n ')).toEqual({ sections: [] });
  });
});

describe('cellTone — 结论色判定', () => {
  it('结论标签在整串里找结论词，失败类优先', () => {
    expect(cellTone('结果', '命中')).toBe('success');
    expect(cellTone('结果', '未命中')).toBe('error');
    expect(cellTone('结果', '大失败')).toBe('error');
    expect(cellTone('结果', '大成功，暴击')).toBe('success');
    expect(cellTone('检定结果', '失败')).toBe('error');
    expect(cellTone('判定', '通过')).toBe('success');
    expect(cellTone('结果', '闪避成功')).toBe('error');
    expect(cellTone('结果', '被格挡')).toBe('error');
    expect(cellTone('结果', '击退')).toBeUndefined();
  });

  it('「闪避: 13」这类数值不误判；非结论标签下描述里的结论词也不上色', () => {
    expect(cellTone('闪避', '13')).toBeUndefined();
    expect(cellTone('检定', 'd20=15 +5 = 20')).toBeUndefined();
    expect(cellTone('目标', '成功之剑的仿制品')).toBeUndefined();
    expect(cellTone('批量检查', '允许批量')).toBeUndefined();
  });

  it('非结论标签：值本身是结论词（可带动作前缀与括注）才上色', () => {
    expect(cellTone('攻击', '命中')).toBe('success');
    expect(cellTone('', '[制作成功]')).toBe('success');
    expect(cellTone('资源', '不足(终止)')).toBe('error');
    expect(cellTone('', '检定失败')).toBe('error');
  });

  it('防守动作标签下的裸结论翻转（对出手方而言）', () => {
    expect(cellTone('闪避', '成功')).toBe('error');
    expect(cellTone('格挡', '失败')).toBe('success');
  });

  it('空值不上色', () => {
    expect(cellTone('结果', '  ')).toBeUndefined();
  });
});

describe('sectionHue', () => {
  it('→ / -> 出手、检定、结算/结果、其余', () => {
    expect(sectionHue('A → B')).toBe('strike');
    expect(sectionHue('A -> B')).toBe('strike');
    expect(sectionHue('先攻检定')).toBe('check');
    expect(sectionHue('战斗结果')).toBe('gain');
    expect(sectionHue('生产结算')).toBe('gain');
    expect(sectionHue('战况总览')).toBe('info');
  });
});

describe('highlightValue — 值高亮 token', () => {
  it('骰值 dN=数字（含空格与括号形）', () => {
    // 算式里的 +5 是项不是增益，不上色
    expect(highlightValue('d20=15 +5 = 20')).toEqual([
      { text: 'd20=15', kind: 'dice' },
      { text: ' +5 = 20' },
    ]);
    expect(highlightValue('正常:d20(11)')).toEqual([
      { text: '正常:' },
      { text: 'd20(11)', kind: 'dice' },
    ]);
    expect(highlightValue('2d6=7')).toEqual([{ text: '2d6=7', kind: 'dice' }]);
    expect(highlightValue('xd6=7')).toEqual([{ text: 'xd6=7' }]);
  });

  it('数值变化：减少标 down、增加标 up、相等不标，箭头标 arrow', () => {
    expect(highlightValue('60 → 26')).toEqual([
      { text: '60 ' },
      { text: '→', kind: 'arrow' },
      { text: ' ' },
      { text: '26', kind: 'down' },
    ]);
    expect(highlightValue('10→12').map((t) => t.kind)).toEqual([undefined, 'arrow', 'up']);
    expect(highlightValue('5 → 5').slice(-1)[0]).toEqual({ text: ' 5' });
    expect(highlightValue('−20 -> −5').slice(-1)[0]).toEqual({ text: '−5', kind: 'up' });
  });

  it('两端不是数字的箭头不标', () => {
    expect(highlightValue('成品-图纸→强制单件')).toEqual([{ text: '成品-图纸→强制单件' }]);
  });

  it('独立的增减：+N / ＋N up，−N / -N down', () => {
    expect(highlightValue('SP −20')).toEqual([{ text: 'SP ' }, { text: '−20', kind: 'down' }]);
    expect(highlightValue('经验 ＋35').slice(-1)[0]).toEqual({ text: '＋35', kind: 'up' });
    expect(highlightValue('-3')[0]).toEqual({ text: '-3', kind: 'down' });
  });

  it('不标：等号前的减项、连在字母/汉字后的符号、二元减号', () => {
    expect(highlightValue('d20=11 −2 = 9').map((t) => t.kind)).toEqual(['dice', undefined]);
    expect(highlightValue('HP-5')).toEqual([{ text: 'HP-5' }]);
    expect(highlightValue('DC修正+3')).toEqual([{ text: 'DC修正+3' }]);
    expect(highlightValue('42 物理 − 防御 8 = 34')).toEqual([{ text: '42 物理 − 防御 8 = 34' }]);
  });

  it('token 拼回去恒等于原值', () => {
    for (const v of ['d20=15 +5 = 20', 'HP: 60 → 26', 'SP −20 | EXP +35', '奇怪的 -> 值', '']) {
      expect(joined(v)).toBe(v);
    }
    // 唯一的例外：数值变化里的 `->` 渲染成 `→`
    expect(joined('3 -> 4')).toBe('3 → 4');
  });
});

describe('永不抛', () => {
  const garbage: unknown[] = [
    undefined,
    null,
    42,
    {},
    '<action_info><action_info></action_info></action_info>',
    '{{{|||:::}}}',
    '｛｝｜：｜',
    '<!--',
    '\u0000￿|\n{',
    '->->->',
    'd20=',
    '+'.repeat(1000),
  ];

  it('任何输入都返回结构，不抛', () => {
    for (const g of garbage) {
      expect(() => splitActionInfo(g as string)).not.toThrow();
      expect(() => splitActionInfo(g as string, { partial: true })).not.toThrow();
      expect(() => splitActionInfo(g as string, { partial: true, bareSheets: true })).not.toThrow();
      expect(() => parseActionPanel(g as string)).not.toThrow();
      expect(() => highlightValue(g as string)).not.toThrow();
      const panel = parseActionPanel(g as string);
      for (const s of panel.sections) expect(() => summaryCells(s)).not.toThrow();
    }
  });

  it('summaryCells 收到残缺分节也不抛', () => {
    expect(summaryCells({} as never)).toEqual([]);
  });
});

describe('splitActionInfo — bareSheets（战斗流：无外层标签的裸面板）', () => {
  it('{标题} + 竖线行 → 面板；纯文本 → 文本（迁自 parseCombatNarrative）', () => {
    const segs = splitActionInfo(
      ['雨点砸在石栏上。', '{战况总览}', '| 理查德 | HP 78/100 |', '| 骷髅兵 | HP 40/40 |'].join(
        '\n',
      ),
      { bareSheets: true },
    );
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: 'text', text: '雨点砸在石栏上。' });
    expect(segs[1].kind).toBe('panel');
    const panel = parseActionPanel((segs[1] as { raw: string }).raw);
    expect(panel.sections).toHaveLength(1);
    expect(panel.sections[0].title).toBe('战况总览');
    expect(panel.sections[0].rows.flatMap((r) => r.cells)).toEqual([
      { label: '理查德', value: 'HP 78/100' },
      { label: '骷髅兵', value: 'HP 40/40' },
    ]);
  });

  it('无标题的竖线行（尾竖线可有可无）新开无标题面板，单格冒号拆标签', () => {
    const segs = splitActionInfo('出手。\n| 检定: 17\n| 伤害: 620 |\n敌人倒下。', {
      bareSheets: true,
    });
    expect(segs.map((s) => s.kind)).toEqual(['text', 'panel', 'text']);
    expect(cellsOf((segs[1] as { raw: string }).raw)).toEqual([
      { label: '检定', value: '17' },
      { label: '伤害', value: '620' },
    ]);
    expect(segs[2]).toEqual({ kind: 'text', text: '敌人倒下。' });
  });

  it('连续的多个 {标题} 合进同一张面板、各成一节；空行不打断面板', () => {
    const segs = splitActionInfo('{甲 → 乙}\n| 结果: 命中 |\n\n{反击}\n| 结果: 未命中 |', {
      bareSheets: true,
    });
    expect(segs).toHaveLength(1);
    const panel = parseActionPanel((segs[0] as { raw: string }).raw);
    expect(panel.sections.map((s) => s.title)).toEqual(['甲 → 乙', '反击']);
  });

  it('只有标题、没跟竖线行的 {…} 行原样还给文本', () => {
    expect(splitActionInfo('{旁白}\n夜色很深。', { bareSheets: true })).toEqual([
      { kind: 'text', text: '{旁白}\n夜色很深。' },
    ]);
  });

  it('标签内的面板照常切出；标签外的裸面板另成一块', () => {
    const segs = splitActionInfo('<action_info>| a: 1 |</action_info>\n叙事\n| b: 2 |', {
      bareSheets: true,
    });
    expect(segs.map((s) => s.kind)).toEqual(['panel', 'text', 'panel']);
  });

  it('不开 bareSheets 时裸竖线行仍是文本（主线正文不受影响）', () => {
    expect(splitActionInfo('{战况}\n| a: 1 |')).toEqual([
      { kind: 'text', text: '{战况}\n| a: 1 |' },
    ]);
  });

  it('空文本 / 坏格式永不抛（迁自 parseCombatNarrative）', () => {
    expect(splitActionInfo('', { bareSheets: true })).toEqual([]);
    expect(splitActionInfo('{', { bareSheets: true })).toEqual([{ kind: 'text', text: '{' }]);
  });
});

describe('rulesClaimActionInfo — 美化规则接管 <action_info> 的判据', () => {
  const base: BeautifierRule = {
    id: 'r',
    name: 'R',
    scope: 'maintext',
    pattern: '<action_info>([\\s\\S]*?)<\\/action_info>',
    flags: 'g',
    replacement: '<div>$1</div>',
    enabled: true,
    order: 1,
    isBuiltin: false,
  };
  const text = '挥剑。\n<action_info>\n| 掷骰: 12 |\n</action_info>\n敌人后退。';

  it('启用、scope 覆盖 maintext（含 global）、能整块匹配正文里的面板 → 接管', () => {
    expect(rulesClaimActionInfo([base], text)).toBe(true);
    expect(rulesClaimActionInfo([{ ...base, scope: 'global' }], text)).toBe(true);
    expect(
      rulesClaimActionInfo(
        [{ ...base, pattern: '<ACTION_INFO>([\\s\\S]*?)</ACTION_INFO>', flags: 'gi' }],
        text,
      ),
    ).toBe(true);
  });

  it('未启用 / scope 不覆盖 / pattern 无关 / 空列表 → 不接管', () => {
    expect(rulesClaimActionInfo([{ ...base, enabled: false }], text)).toBe(false);
    expect(rulesClaimActionInfo([{ ...base, scope: 'options' }], text)).toBe(false);
    expect(rulesClaimActionInfo([{ ...base, pattern: '<card>([\\s\\S]*?)</card>' }], text)).toBe(
      false,
    );
    expect(rulesClaimActionInfo([], text)).toBe(false);
    expect(rulesClaimActionInfo(undefined, text)).toBe(false);
  });

  it('只提到 action_info、编译不过、或只吃得下半块的规则 → 不接管', () => {
    // 只匹配开标签
    expect(rulesClaimActionInfo([{ ...base, pattern: '<action_info>' }], text)).toBe(false);
    // 吃不到闭标签（`.` 不跨行）
    expect(
      rulesClaimActionInfo([{ ...base, pattern: '<action_info>(.*)</action_info>' }], text),
    ).toBe(false);
    // 编译不过
    expect(rulesClaimActionInfo([{ ...base, pattern: '<action_info>(' }], text)).toBe(false);
    // 注释里提一句、实际匹配别的东西
    expect(rulesClaimActionInfo([{ ...base, pattern: '(?:action_info)?<b>' }], text)).toBe(false);
  });

  it('正文里没有闭合面板（流式中 / 没有面板）→ 不接管', () => {
    expect(rulesClaimActionInfo([base], '正文<action_info>| a: 1 |')).toBe(false);
    expect(rulesClaimActionInfo([base], '纯正文')).toBe(false);
  });

  it('深度范围不含本条消息 → 不接管（与 compileBeautifierSegments 同口径）', () => {
    expect(rulesClaimActionInfo([{ ...base, minDepth: 2 }], text, 'maintext', 0)).toBe(false);
    expect(rulesClaimActionInfo([{ ...base, minDepth: 2 }], text, 'maintext', 3)).toBe(true);
    expect(rulesClaimActionInfo([{ ...base, maxDepth: 1 }], text, 'maintext', 5)).toBe(false);
  });

  it('残缺规则不抛', () => {
    expect(rulesClaimActionInfo([null, {}] as never, text)).toBe(false);
  });
});

describe('splitActionInfo — 定稿消息里未闭合的 <action_info>', () => {
  it('面板到第一个空行为止，其后仍是正文', () => {
    const segs = splitActionInfo(
      '出手。<action_info>\n{检定}\n| 掷骰: d20=3 |\n\n林狼扑了上来。\n他退后一步。',
    );
    expect(segs.map((s) => s.kind)).toEqual(['text', 'panel', 'text']);
    expect(cellsOf((segs[1] as { raw: string }).raw)).toEqual([{ label: '掷骰', value: 'd20=3' }]);
    expect((segs[2] as { text: string }).text).toContain('林狼扑了上来。\n他退后一步。');
  });

  it('面板到第一个不像面板的行为止（没有空行也一样）', () => {
    const segs = splitActionInfo('<action_info>| 结果: 命中 |\n林狼哀鸣一声。');
    expect(segs.map((s) => s.kind)).toEqual(['panel', 'text']);
    expect((segs[1] as { text: string }).text).toContain('林狼哀鸣一声。');
  });

  it('开标签后、内容前的空行跳过；其后的标签照常处理', () => {
    const segs = splitActionInfo(
      '<action_info>\n\n| a: 1 |\n正文\n<action_info>| b: 2 |</action_info>',
    );
    expect(segs.map((s) => s.kind)).toEqual(['panel', 'text', 'panel']);
  });

  it('partial（流式中）仍把其后全部算面板', () => {
    const segs = splitActionInfo('<action_info>| a: 1 |\n\n还没写完', { partial: true });
    expect(segs.map((s) => s.kind)).toEqual(['panel']);
  });
});

describe('cellTone — 否定、混合分句与防守标签', () => {
  it('否定前缀接成功类词判失败', () => {
    for (const v of ['未成功', '不成功', '没有命中', '没命中', '未能通过', '无法完成']) {
      expect(cellTone('结果', v)).toBe('error');
    }
    expect(cellTone('状态', '未完成')).toBe('error');
    expect(cellTone('', '未成功')).toBe('error');
  });

  it('混合分句取最后一个结论词', () => {
    expect(cellTone('结果', '闪避失败，命中')).toBe('success');
    expect(cellTone('结果', '未被格挡，命中')).toBe('success');
    expect(cellTone('结果', '命中，但被格挡')).toBe('error');
  });

  it('防守标签下的裸结论按出手方翻转；写明攻守的复合词不翻', () => {
    expect(cellTone('闪避', '成功')).toBe('error');
    expect(cellTone('闪避', '失败')).toBe('success');
    expect(cellTone('格挡', '失败')).toBe('success');
    expect(cellTone('招架', '大成功')).toBe('error');
    expect(cellTone('闪避', '闪避成功')).toBe('error');
    expect(cellTone('闪避', '13')).toBeUndefined();
  });
});

describe('highlightValue — 箭头两侧与独立增减', () => {
  const kinds = (v: string) => highlightValue(v).map((t) => [t.text, t.kind ?? null]);

  it('分数取分子比较、千分位去掉再比', () => {
    expect(highlightValue('HP 20/100 → 60/100').slice(-1)[0]).toEqual({
      text: '60/100',
      kind: 'up',
    });
    expect(highlightValue('HP 60/100 → 20/100').slice(-1)[0]).toEqual({
      text: '20/100',
      kind: 'down',
    });
    expect(highlightValue('1,200 → 900').slice(-1)[0]).toEqual({ text: '900', kind: 'down' });
    expect(highlightValue('900 → 1,200').slice(-1)[0]).toEqual({ text: '1,200', kind: 'up' });
    expect(
      highlightValue('HP 60 → 26, MP 10 → 15').filter((t) => t.kind && t.kind !== 'arrow'),
    ).toEqual([
      { text: '26', kind: 'down' },
      { text: '15', kind: 'up' },
    ]);
  });

  it('算式里的项、运算链、括号坐标、冒号后的负值都不上色', () => {
    for (const v of [
      '50 -8 -5 = 37',
      '17 +5 -2 +1 = 21',
      '(-3, 5)',
      '位置: -2',
      'd20=15 +5 = 20',
      '10 -2',
    ]) {
      expect(highlightValue(v).filter((t) => t.kind === 'up' || t.kind === 'down')).toEqual([]);
    }
  });

  it('独立的增减照样上色', () => {
    expect(kinds('SP −20')).toEqual([
      ['SP ', null],
      ['−20', 'down'],
    ]);
    expect(kinds('经验: +35').slice(-1)[0]).toEqual(['+35', 'up']);
    expect(kinds('+35 EXP')[0]).toEqual(['+35', 'up']);
  });
});

describe('性能护栏：超长输入不发生灾难性回溯', () => {
  // 阈值放宽到 10 秒只为拦平方级回溯（旧 `\s*-+>\s*` 在 20 万空格上约 22 秒），慢 CI 不抖红
  const huge = [
    ' '.repeat(300_000),
    '-'.repeat(300_000),
    `1${' '.repeat(300_000)}x`,
    '|'.repeat(300_000),
  ];

  it('parseActionPanel / highlightValue / splitActionInfo 都在护栏内完成', () => {
    for (const text of huge) {
      const start = performance.now();
      parseActionPanel(`{a}\n| v: ${text} -> 3 |`);
      highlightValue(text);
      splitActionInfo(`<action_info>${text}`);
      expect(performance.now() - start).toBeLessThan(10_000);
    }
  });
});

describe('审查 A6：action_info 标签三处判定一致', () => {
  const PANEL_BODY = '|检定|d20=12|\n\n|结果|成功|';
  const variants = [
    `<action_info type="a">\n${PANEL_BODY}\n</action_info>`,
    `< action_info >\n${PANEL_BODY}\n</ action_info >`,
    `<ACTION_INFO>\n${PANEL_BODY}\n</action_info>`,
  ];

  for (const block of variants) {
    const text = `前文一段。\n\n${block}\n\n后文一段。`;
    const from = text.indexOf(block);
    const to = from + block.length;
    const inside = (at: number): boolean => at > from && at < to;

    it(`面板拆分：整块成一张面板、不漏原文（${block.split('\n')[0]}）`, () => {
      const segs = splitActionInfo(text);
      expect(segs.map((s) => s.kind)).toEqual(['text', 'panel', 'text']);
      for (const s of segs) {
        if (s.kind === 'text') expect(s.text).not.toMatch(/action_info/i);
      }
      const panel = segs[1];
      if (panel.kind !== 'panel') throw new Error('不是面板');
      const cells = parseActionPanel(panel.raw).sections.flatMap((sec) =>
        sec.rows.flatMap((r) => r.cells),
      );
      expect(cells.map((c) => c.label)).toEqual(['检定', '结果']);
    });

    it(`逐节演出与引擎分节都不在面板里切（${block.split('\n')[0]}）`, () => {
      const stageBreaks = paragraphBreaks(text);
      const engineBreaks = resolveBeatBreaks(text, null);
      expect(stageBreaks.length).toBeGreaterThan(0);
      expect(stageBreaks.some(inside)).toBe(false);
      expect(engineBreaks.length).toBeGreaterThan(0);
      expect(engineBreaks.some(inside)).toBe(false);
    });

    it(`面板里的 <beat/> 只剥不切（${block.split('\n')[0]}）`, () => {
      const withBeat = text.replace('\n\n|结果|', '\n<beat/>\n|结果|') + '\n<beat/>\n尾声。';
      const { content, breaks } = extractStoryBeats(withBeat);
      expect(breaks).toHaveLength(1);
      expect(content.slice(breaks[0])).toBe('尾声。');
    });
  }

  it('规则接管判定也认带属性 / 带空白的标签', () => {
    const rule = {
      id: 'r',
      name: 'r',
      enabled: true,
      scope: 'maintext',
      pattern: '<\\s*action_info[^>]*>[\\s\\S]*?<\\s*/\\s*action_info\\s*>',
      replacement: '',
    } as BeautifierRule;
    expect(rulesClaimActionInfo([rule], `前文\n${variants[0]}\n后文`)).toBe(true);
    expect(rulesClaimActionInfo([rule], `前文\n${variants[1]}\n后文`)).toBe(true);
  });

  it('流式中半截的带属性开标签被裁掉', () => {
    const segs = splitActionInfo('正文。\n<action_info type="', { partial: true });
    expect(segs).toEqual([{ kind: 'text', text: '正文。\n' }]);
    // 别的标签写到一半不裁
    expect(splitActionInfo('正文 <a href="', { partial: true })).toEqual([
      { kind: 'text', text: '正文 <a href="' },
    ]);
  });
});
