/**
 * action-digest.ts — 行动面板摘要
 *
 * 守的是：谁对谁做了什么、结论、资源变化（同单位同资源合并、不重复计数）、战况名册、
 * 关键格；认不出的老面板 facts 恒等于 summaryCells(第一节)；任何输入都不抛、不回溯。
 * 样例全部是自编的名字与文字（只借世界书面板的形状）。
 */
import { describe, expect, it } from 'vitest';
import { buildCraftPanelLines } from '@engine/crafting/craft-projection';
import type {
  CraftActionRequest,
  CraftCheckResult,
  CraftPrepResult,
  CraftSettleResult,
} from '@engine/types/types';
import { parseActionPanel, summaryCells, type ActionPanel } from '../../../src/ui/lib/action-panel';
import { digestActionPanel } from '../../../src/ui/lib/action-digest';

function digestOf(raw: string) {
  return digestActionPanel(parseActionPanel(raw));
}

describe('digestActionPanel — 世界书攻击行动（三节）', () => {
  const RAW = `{攻击行动}
| 攻方: 莱恩 | 守方: 铁颚蛛群(集群) | 招式: 烈焰新星 | 所使武器: 橡木法杖 |
| 消耗: HP 0 | MP 300 | SP 0 |
| 意图: 常规打击 -> 判定为 常规 |
{伤害基准计算}
| 初始伤害: (智力9×10×2.8 + 300 + 120) = 672 |
| 集群攻击次数: HP百分比100%-> 次数2 |
{结算清单}
| 掷骰: 正常 d20[13] |
| 检定结果: d20[13] + 命中0 - 闪避0 = 13 | 结果: 有效(1.0) |
| 最终伤害: 1344 | 变更: 铁颚蛛群(集群) HP 900 -> 0[0%] (-1344) |
| 集群减员: 0/3 |`;
  const d = digestOf(RAW);

  it('exchange：攻方 / 守方 / 招式', () => {
    expect(d.kind).toBe('exchange');
    expect(d.title).toBe('攻击行动');
    expect(d.actor).toBe('莱恩');
    expect(d.targets).toEqual(['铁颚蛛群(集群)']);
    expect(d.action).toBe('烈焰新星');
  });

  it('命中评级做结论：有效 = success，去掉系数括注', () => {
    expect(d.verdict).toEqual({ text: '有效', tone: 'success' });
  });

  it('变更取起止差（不取模型写的溢出伤害），消耗归行动者且零值跳过', () => {
    expect(d.deltas).toEqual([
      { who: '莱恩', resource: 'MP', delta: -300 },
      { who: '铁颚蛛群(集群)', resource: 'HP', delta: -900, from: 900, to: 0 },
    ]);
  });

  it('`HP百分比` 不是资源记号', () => {
    expect(d.deltas.every((x) => x.resource !== 'HP' || x.who !== '莱恩')).toBe(true);
  });
});

describe('digestActionPanel — 资源记号变体', () => {
  it('方括号包住名字与数值都认，`/上限` 与 `(62%)` 都吃', () => {
    const d = digestOf('{环境伤害结算}\n| 变更: [白鸦] HP [400/500] -> [250/500] (50%) |');
    expect(d.deltas).toEqual([
      { who: '白鸦', resource: 'HP', delta: -150, from: 400, to: 250, max: 500 },
    ]);
  });

  it('`(-0)`：起止相等，delta 为 0 且保留', () => {
    const d = digestOf('| 最终伤害: 0 | 变更: 灰刃 HP 320 -> 320[100%] (-0) |');
    expect(d.deltas).toEqual([{ who: '灰刃', resource: 'HP', delta: 0, from: 320, to: 320 }]);
  });

  it('标签式 `林狼 HP: 60 → 26` 与 SP 变化', () => {
    const d = digestOf(
      '{莱恩 -> 林狼 · 斩击}\n| 结果: 命中 |\n| 林狼 HP: 60 → 26 |\n| 莱恩 SP: 140 → 128 |',
    );
    expect(d.kind).toBe('exchange');
    expect(d.actor).toBe('莱恩');
    expect(d.targets).toEqual(['林狼']);
    expect(d.action).toBe('斩击');
    expect(d.verdict).toEqual({ text: '命中', tone: 'success' });
    expect(d.deltas).toEqual([
      { who: '林狼', resource: 'HP', delta: -34, from: 60, to: 26 },
      { who: '莱恩', resource: 'SP', delta: -12, from: 140, to: 128 },
    ]);
  });

  it('`HP -30 (剩余HP: 120)` → ±N 与 to', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|林狼|\n|变更|林狼 HP -30 (剩余HP: 120)|');
    expect(d.deltas).toEqual([{ who: '林狼', resource: 'HP', delta: -30, to: 120 }]);
  });

  it('千分位数字', () => {
    const d = digestOf('| 变更: 石像守卫 HP 1,200 -> 900 |');
    expect(d.deltas[0]).toMatchObject({ who: '石像守卫', from: 1200, to: 900, delta: -300 });
  });
});

describe('digestActionPanel — 多目标行', () => {
  const RAW = `{攻击行动}
| 攻方: 沼泽巫妖 | 守方: 莱恩、赛琳 | 招式: 寒霜链 |
| 消耗: HP 0 | MP 250 | SP 0 |
{结算清单}
| -> 莱恩: 检定(骰15+0-0=15 -> 有效) | 伤害: (300) | HP: 900 -> 600[66%] | 效果: 附加[冻结]1回合 |
| -> 目标赛琳: 检定(骰6+0-0=6 -> 擦伤) | 伤害: (90) | HP: 500 -> 410[82%] |`;
  const d = digestOf(RAW);

  it('行首名字认作目标，资源变化按行首名字归属', () => {
    expect(d.actor).toBe('沼泽巫妖');
    expect(d.targets).toEqual(['莱恩', '赛琳']);
    expect(d.deltas).toEqual([
      { who: '沼泽巫妖', resource: 'MP', delta: -250 },
      { who: '莱恩', resource: 'HP', delta: -300, from: 900, to: 600 },
      { who: '赛琳', resource: 'HP', delta: -90, from: 500, to: 410 },
    ]);
  });

  it('守方写成一行、多目标行补进来的名字不重复', () => {
    expect(new Set(d.targets).size).toBe(d.targets.length);
  });
});

describe('digestActionPanel — 战术动作', () => {
  it('角色 + 对象自身 + 执行：恢复归行动者，「使用」前缀去掉', () => {
    const d = digestOf(`{战术动作}
| 角色: 赛琳 | 类型: 装备效果 | 对象: 自身 |
| 消耗: HP 0 | MP 0 | SP 0 |
| 执行: 使用 月纹斗篷-汲取 |
| 效果: 恢复MP(+120) |`);
    expect(d.kind).toBe('exchange');
    expect(d.actor).toBe('赛琳');
    expect(d.targets).toEqual([]);
    expect(d.action).toBe('月纹斗篷-汲取');
    expect(d.deltas).toEqual([{ who: '赛琳', resource: 'MP', delta: 120 }]);
  });

  it('对象写成与角色同名也不算目标', () => {
    const d = digestOf(
      '| 角色: 腐沼蠕虫 | 对象: 腐沼蠕虫 |\n| 执行: 使用 再生 |\n| 效果: 恢复HP(+20) |',
    );
    expect(d.targets).toEqual([]);
    expect(d.deltas).toEqual([{ who: '腐沼蠕虫', resource: 'HP', delta: 20 }]);
  });

  it('只有「角色」没有对象 / 执行不算行动者', () => {
    const d = digestOf('{人物卡}\n| 角色: 赛琳 | 职业: 游侠 |');
    expect(d.actor).toBeUndefined();
    expect(d.kind).toBe('generic');
  });
});

describe('digestActionPanel — 直出逐拍', () => {
  it('旧格式：裸伤害数字记给唯一目标', () => {
    const d = digestOf(
      '|行动者|莱恩|\n|目标|林狼|\n|行动|斩击|\n|判定|d20=15 命中|\n|伤害|36|\n|状态|林狼 流血|',
    );
    expect(d.kind).toBe('exchange');
    expect(d).toMatchObject({ actor: '莱恩', targets: ['林狼'], action: '斩击' });
    expect(d.verdict).toEqual({ text: '命中', tone: 'success' });
    expect(d.deltas).toEqual([{ who: '林狼', resource: 'HP', delta: -36 }]);
  });

  it('新约定：变更行与消耗 / 伤害同单位不重复计数', () => {
    const d = digestOf(
      [
        '|行动者|莱恩|',
        '|目标|林狼|',
        '|行动|疾风斩|',
        '|伤害|36|',
        '|消耗|SP 12|',
        '|变更|林狼 HP 60→24|',
        '|变更|莱恩 SP 140→128|',
      ].join('\n'),
    );
    expect(d.deltas).toEqual([
      { who: '莱恩', resource: 'SP', delta: -12, from: 140, to: 128 },
      { who: '林狼', resource: 'HP', delta: -36, from: 60, to: 24 },
    ]);
  });

  it('散行全角冒号「行动者：甲」补拆；目标写「无」没有目标', () => {
    const d = digestOf('行动者：灰刃\n| 目标: 无 |\n| 行动: 蓄力 |\n| 消耗: SP 30 |');
    expect(d.actor).toBe('灰刃');
    expect(d.targets).toEqual([]);
    expect(d.action).toBe('蓄力');
    expect(d.deltas).toEqual([{ who: '灰刃', resource: 'SP', delta: -30 }]);
  });

  it('目标按顿号拆多个；没有行动者时「目标」不算目标', () => {
    expect(digestOf('|行动者|赛琳|\n|目标|林狼、灰刃|').targets).toEqual(['林狼', '灰刃']);
    expect(digestOf('| 目标: 精钢长剑 | 数量: 1 |').targets).toEqual([]);
  });

  it('旧格式恢复：无目标时归行动者', () => {
    const d = digestOf('|行动者|赛琳|\n|目标|无|\n|行动|治愈术|\n|恢复|25|');
    expect(d.deltas).toEqual([{ who: '赛琳', resource: 'HP', delta: 25 }]);
  });
});

describe('digestActionPanel — 战况名册', () => {
  it('世界书战况总览：多格行与集群人数', () => {
    const d = digestOf(`{战况总览}
| 回合: 2 | 类型: 标准 | 环境: 林间空地 |
| 莱恩: HP 800/900 | MP 300/600 | SP 500/500 | 力6 敏7 |
| 状态: 无 |
| 铁颚蛛群 (4/5): HP 1500/2000 | MP 0/0 | SP 900/1000 |`);
    expect(d.kind).toBe('roster');
    expect(d.roster).toEqual([
      {
        name: '莱恩',
        hp: { cur: 800, max: 900 },
        mp: { cur: 300, max: 600 },
        sp: { cur: 500, max: 500 },
      },
      {
        name: '铁颚蛛群',
        cluster: { alive: 4, total: 5 },
        hp: { cur: 1500, max: 2000 },
        mp: { cur: 0, max: 0 },
        sp: { cur: 900, max: 1000 },
      },
    ]);
    expect(d.deltas).toEqual([]);
    expect(d.verdict).toBeUndefined();
  });

  it('CombatMessageFlow 现算的战况总览（单格 · 分隔）', () => {
    // 形状照 CombatMessageFlow.vue 的 overviewRows：`HP a/b · MP a/b · SP a/b · 位置 n`
    const panel: ActionPanel = {
      sections: [
        {
          title: '战况总览',
          hue: 'info',
          rows: [
            { cells: [{ label: '赛琳', value: 'HP 80/120 · MP 10/40 · SP 30/60 · 位置 2' }] },
            { cells: [{ label: '林狼', value: 'HP 0/60 · MP 0/0 · SP 5/20 · 位置 5' }] },
          ],
        },
      ],
    };
    const d = digestActionPanel(panel);
    expect(d.kind).toBe('roster');
    expect(d.roster).toEqual([
      {
        name: '赛琳',
        hp: { cur: 80, max: 120 },
        mp: { cur: 10, max: 40 },
        sp: { cur: 30, max: 60 },
      },
      { name: '林狼', hp: { cur: 0, max: 60 }, mp: { cur: 0, max: 0 }, sp: { cur: 5, max: 20 } },
    ]);
  });
});

describe('digestActionPanel — 结算类', () => {
  it('战斗结算：胜利 = success，关键格按重要度', () => {
    const d = digestOf(`{战斗结算}
| 结果: [胜利] |
| 战果: [石像守卫崩解] |
| EXP: [石像守卫] Lv[6]×系数[20] = [120] |
| EXP合计: 120 | 上限检查: 120 vs 1000 → 实得 120 |
| 奖励: EXP +120 | FP +40 |
| 掉落: 碎裂的核心 x1 |`);
    expect(d.kind).toBe('outcome');
    expect(d.verdict).toEqual({ text: '胜利', tone: 'success' });
    expect(d.facts.map((c) => c.label)).toEqual(['奖励', '掉落', 'EXP合计']);
  });

  it('战败 = error', () => {
    expect(digestOf('{战斗结算}\n| 结果: 战败 |').verdict).toEqual({ text: '战败', tone: 'error' });
  });

  it('战意判定：箭头后的结论；过长的结果进 facts', () => {
    const d = digestOf(`{战意判定}
| 触发: 灰鬃狼王 HP 300/1200 < 阈值 30% |
| 类型: 死斗 -> 需要检定 |
| 判定: d20=[5] vs 12 -> 战意崩溃 |`);
    expect(d.kind).toBe('outcome');
    expect(d.verdict).toEqual({ text: '战意崩溃' });
    expect(d.deltas).toEqual([]);
    expect(d.roster).toEqual([]);

    const long = digestOf(
      '{战意判定}\n| 判定: 绝境本能触发 |\n| 结果: 灰鬃狼王放弃一切防御扑向最近的敌人 |',
    );
    expect(long.verdict).toEqual({ text: '绝境本能触发' });

    const onlyLong = digestOf('{战意判定}\n| 结果: 灰鬃狼王放弃一切防御扑向最近的敌人 |');
    expect(onlyLong.verdict).toBeUndefined();
    expect(onlyLong.facts.map((c) => c.label)).toEqual(['结果']);
  });

  it('命中评级「失手」= error', () => {
    const d = digestOf(
      '|攻方: 灰刃|守方: 林狼|招式: 突刺|\n| 检定结果: d20[2] = 2 | 结果: 失手(0) |',
    );
    expect(d.verdict).toEqual({ text: '失手', tone: 'error' });
  });

  it('回合状态结算：每行行首名字认领资源变化', () => {
    const d = digestOf(`{回合状态结算}
| 白鸦: 受到[灼烧] 40 点伤害 | HP: 500 -> 460 |
| 石像守卫: 受到[腐蚀] 100 点伤害 | HP 1800 -> 1700[94%] |
| 石像守卫: 触发[石肤] 恢复 50 点 HP | HP 1700 -> 1750[97%] |`);
    expect(d.kind).toBe('outcome');
    expect(d.deltas).toEqual([
      { who: '白鸦', resource: 'HP', delta: -40, from: 500, to: 460 },
      { who: '石像守卫', resource: 'HP', delta: -50, from: 1800, to: 1750 },
    ]);
  });

  it('行动顺序：序列作关键格', () => {
    const d = digestOf('{行动顺序}\n| 莱恩: (敏捷7) + 骰[12] = 19 |\n| 序列: 莱恩 -> 林狼 |');
    expect(d.kind).toBe('outcome');
    expect(d.facts).toEqual([{ label: '序列', value: '莱恩 → 林狼' }]);
  });
});

describe('digestActionPanel — 制作三阶段', () => {
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
    qualityReqCheck: { passed: true },
    resourceCheck: { sufficient: true },
  } as unknown as CraftPrepResult;
  const check = (rating: string) =>
    ({
      breakdown: {
        baseDC: 12,
        materialDCModifier: 2,
        bonusDCReduction: 1,
        finalDC: 13,
        fixedBonusBreakdown: { attribute: 3, skill: 2, tool: 1, identity: 0 },
        fixedBonus: 6,
        advantage: false,
        disadvantage: false,
        diceRolls: [16],
        diceValue: 16,
        totalValue: 22,
        rating,
      },
    }) as unknown as CraftCheckResult;
  const settle = {
    breakdown: {
      resourceCost: { hp: 0, mp: 0, sp: 20 },
      materialLoss: { lossRate: 0, lostMaterials: [] },
      outputQuality: '稀有',
      qualityDowngraded: false,
      productDCModifier: 1,
      expReward: { actualExp: 35, baseExp: 35, tierSuppressed: false },
      perfectionBonus: { batchExtraYield: 1 },
    },
    fpReward: 5,
  } as unknown as CraftSettleResult;

  it('buildCraftPanelLines 产出：outcome、检定结论、产出 / 品质 / 奖励', () => {
    const raw = buildCraftPanelLines(request, prep, check('精益求精'), settle).join('\n');
    const d = digestOf(raw);
    expect(d.kind).toBe('outcome');
    expect(d.title).toBe('生产准备');
    expect(d.actor).toBeUndefined();
    expect(d.targets).toEqual([]);
    expect(d.verdict).toEqual({ text: '精益求精', tone: 'success' });
    expect(d.facts.map((c) => [c.label, c.value])).toEqual([
      ['产出列表', '精炼铁剑(稀有, DC修正+1) x1'],
      ['品质', '稀有'],
      ['奖励', 'EXP +35'],
    ]);
    // 没有行动者时资源消耗记给空名（渲染层当「出手方」），零值仍跳过
    expect(d.deltas).toEqual([{ who: '', resource: 'SP', delta: -20 }]);
  });

  it('手写三阶段面板：失败结论与损失', () => {
    const d = digestOf(`{生产准备}
| 目标: 青铜护符 | 数量: 1 | 品质: 优良 |
{制作检定}
| 检定结果: 失败 |
{生产结算}
| 状态: [制作失败] | 投入物损耗 50% |
| 损失: 青铜锭 x1 损毁 |`);
    expect(d.kind).toBe('outcome');
    expect(d.verdict).toEqual({ text: '失败', tone: 'error' });
    expect(d.facts.map((c) => c.label)).toEqual(['品质', '损失']);
  });
});

describe('digestActionPanel — 认不出的老面板', () => {
  it('generic：facts 与 summaryCells(第一节) 逐个相同', () => {
    const panel = parseActionPanel(
      '{物品鉴定}\n| 名称: 古旧怀表 | 材质: 黄铜 | 年代: 不详 |\n{附注}\n| 备注: 表盖有刻痕 |',
    );
    const d = digestActionPanel(panel);
    expect(d.kind).toBe('generic');
    expect(d.title).toBe('物品鉴定');
    expect(d.facts).toEqual(summaryCells(panel.sections[0]));
    expect(d.facts[0]).toBe(panel.sections[0].rows[0].cells[0]);
    expect(d.deltas).toEqual([]);
    expect(d.roster).toEqual([]);
  });

  it('空面板', () => {
    expect(digestActionPanel({ sections: [] })).toEqual({
      kind: 'generic',
      title: '',
      targets: [],
      targetResults: [],
      deltas: [],
      roster: [],
      facts: [],
      statuses: [],
    });
  });
});

describe('digestActionPanel — 健壮性', () => {
  it('垃圾输入不抛', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'x',
      {},
      { sections: null },
      { sections: [null] },
      { sections: [{ title: 5, rows: [{ cells: [{ label: null, value: 7 }] }] }] },
      { sections: [{ title: '甲 → ', rows: [{ cells: [{}] }] }] },
    ];
    for (const b of bad) {
      expect(() => digestActionPanel(b as ActionPanel)).not.toThrow();
      expect(digestActionPanel(b as ActionPanel).kind).toBeTypeOf('string');
    }
    for (const raw of ['HP', 'HP →', '| HP 1 → |', '| 变更: HP -> 3 |', '|消耗|SP|', '→', '{→}']) {
      expect(() => digestOf(raw)).not.toThrow();
    }
  });

  it('20 万个空格夹在资源记号之间：很快结束', () => {
    const spaces = ' '.repeat(200_000);
    const raws = [
      `| 变更: 林狼 HP${spaces}60${spaces}-> |`,
      `| 林狼: HP${spaces}`,
      `| 效果: 恢复MP(${spaces}`,
      `| 变更: ${spaces}HP 1 -> 2 (${spaces}`,
    ];
    for (const raw of raws) {
      const t0 = performance.now();
      digestOf(raw);
      // 防的是灾难性回溯（那会是数秒到数分钟）；CI 机器比本机慢 4–5 倍，1 秒上限会偶发误报
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });

  it('2 万个重复条目：很快结束且正确合并', () => {
    const lines = Array.from({ length: 20_000 }, () => '| 变更: 林狼 HP 60 -> 59 |').join('\n');
    const t0 = performance.now();
    const d = digestOf(`|行动者|莱恩|\n${lines}`);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.deltas).toEqual([{ who: '林狼', resource: 'HP', delta: -1, from: 60, to: 59 }]);

    const one = `| 赛琳: ${'HP 1/2 · '.repeat(20_000)} |`;
    const t1 = performance.now();
    digestOf(one);
    expect(performance.now() - t1).toBeLessThan(2000);

    const failing = `| 备注: ${'HP百分比 '.repeat(20_000)} |`;
    const t2 = performance.now();
    expect(digestOf(failing).deltas).toEqual([]);
    expect(performance.now() - t2).toBeLessThan(2000);
  });
});

/** 直出 `|标签|值|` 形状的一节面板（典型样例的展开原文） */
function sheet(title: string, rows: ReadonlyArray<readonly [string, string]>): string {
  return [`{${title}}`, ...rows.map(([k, v]) => `|${k}|${v}|`)].join('\n');
}

describe('digestActionPanel — 掷骰', () => {
  const rollOf = (value: string, label = '判定') => digestOf(`|${label}|${value}|`).roll;

  it('`d20=17 +5 → 22 / 闪避 14`：修正、合计、对抗值', () => {
    expect(rollOf('d20=17 +5 → 22 / 闪避 14')).toEqual({
      die: 20,
      value: 17,
      modifier: 5,
      total: 22,
      against: { label: '闪避', value: 14 },
      raw: 'd20=17 +5 → 22 / 闪避 14',
    });
  });

  it('`1d20(13)+4=17`：括注骰值与等号合计', () => {
    expect(rollOf('1d20(13)+4=17')).toEqual({
      die: 20,
      value: 13,
      modifier: 4,
      total: 17,
      raw: '1d20(13)+4=17',
    });
  });

  it('`d100=31 / 成功率 78`：没有修正与合计', () => {
    expect(rollOf('d100=31 / 成功率 78')).toEqual({
      die: 100,
      value: 31,
      against: { label: '成功率', value: 78 },
      raw: 'd100=31 / 成功率 78',
    });
  });

  it('`d20=6 +3 → 9 / DC 14`', () => {
    expect(rollOf('d20=6 +3 → 9 / DC 14')).toMatchObject({
      die: 20,
      value: 6,
      modifier: 3,
      total: 9,
      against: { label: 'DC', value: 14 },
    });
  });

  it('带标签的修正、方括号骰值、vs 与比较号', () => {
    expect(rollOf('d20=17 +敏捷5 → 22 / 闪避 14')).toMatchObject({ modifier: 5, total: 22 });
    expect(rollOf('d20[13] + 命中0 - 闪避0 = 13', '检定结果')).toMatchObject({
      die: 20,
      value: 13,
      modifier: 0,
      total: 13,
    });
    expect(rollOf('d20=[5] vs 12 -> 战意崩溃')).toMatchObject({
      value: 5,
      against: { label: '', value: 12 },
    });
    expect(rollOf('d100=08 ≤ 暴击率 15', '暴击检定')).toMatchObject({
      value: 8,
      against: { label: '暴击率', value: 15 },
    });
  });

  it('多骰取和；多骰的伤害格不当主掷骰，单骰的普通格可以', () => {
    expect(rollOf('2d8(5,6) +力量6 = 17')).toMatchObject({ die: 8, value: 11, total: 17 });
    expect(digestOf('|治疗量|4d6(6,5,4,3) +感知10 = 28|').roll).toBeUndefined();
    expect(digestOf('|潜行|1d20(13)+4=17|').roll).toMatchObject({ die: 20, value: 13 });
  });

  it('判定 / 检定 / 命中 / 掷骰 格优先于其他格', () => {
    const d = digestOf('|潜行|d20=3|\n|行动者|甲|\n|命中|d20=17 +5 → 22|');
    expect(d.roll).toMatchObject({ value: 17, raw: 'd20=17 +5 → 22' });
  });

  it('没有骰子记号：无 roll；`DC 14`、`3d6`、`add20` 这类不是掷骰', () => {
    expect(rollOf('成功')).toBeUndefined();
    expect(rollOf('DC 14')).toBeUndefined();
    expect(rollOf('3d6 伤害')).toBeUndefined();
    expect(rollOf('add20=5')).toBeUndefined();
  });
});

describe('digestActionPanel — 逐目标命中', () => {
  it('以目标名开头的行写了失手 → miss，且带它自己的掷骰', () => {
    const d = digestOf(
      [
        '|行动者|莉娅|',
        '|目标|盗匪甲、盗匪乙|',
        '|盗匪甲|d20=15 +6 → 21 / 抗性 12 命中|',
        '|盗匪乙|d20=4 +6 → 10 / 抗性 12 失手|',
        '|变更|盗匪甲 HP 48→27|',
      ].join('\n'),
    );
    expect(d.targetResults).toEqual([
      {
        name: '盗匪甲',
        hit: 'hit',
        roll: {
          die: 20,
          value: 15,
          modifier: 6,
          total: 21,
          against: { label: '抗性', value: 12 },
          raw: 'd20=15 +6 → 21 / 抗性 12 命中',
        },
      },
      expect.objectContaining({
        name: '盗匪乙',
        hit: 'miss',
        roll: expect.objectContaining({ value: 4 }),
      }),
    ]);
    // 目标自己那几行不算主掷骰
    expect(d.roll).toBeUndefined();
  });

  it('失手行胜过 HP 变化', () => {
    const d = digestOf('|行动者|甲|\n|目标|乙|\n|状态|乙 闪避成功|\n|变更|乙 HP 10→8|');
    expect(d.targetResults).toEqual([{ name: '乙', hit: 'miss' }]);
  });

  it('`/ 闪避 14` 只是对抗值，不算失手', () => {
    const d = digestOf('|行动者|甲|\n|目标|乙|\n|乙|d20=17 → 17 / 闪避 14|');
    expect(d.targetResults[0].hit).toBe('unknown');
  });

  it('HP 变化（扣血或治疗）→ hit；零变化不算', () => {
    const healed = digestOf('|行动者|甲|\n|目标|乙|\n|变更|乙 HP 10→18|');
    expect(healed.targetResults[0].hit).toBe('hit');
    const same = digestOf('|行动者|甲|\n|目标|乙|\n|变更|乙 HP 10→10|');
    expect(same.targetResults[0].hit).toBe('unknown');
  });

  it('单目标按命中评级定', () => {
    const missed = digestOf('|攻方: 灰刃|守方: 林狼|招式: 突刺|\n| 结果: 失手(0) |');
    expect(missed.targetResults).toEqual([{ name: '林狼', hit: 'miss' }]);
    expect(digestOf('|攻方: 灰刃|守方: 林狼|\n| 结果: 擦伤 |').targetResults[0].hit).toBe('hit');
  });

  it('`伤害: 21 / 0 / 18` 按位置；个数对不上不用', () => {
    const three = digestOf('|行动者|甲|\n|目标|乙、丙、丁|\n|伤害|21 / 0 / 18|');
    expect(three.targetResults.map((r) => r.hit)).toEqual(['hit', 'miss', 'hit']);
    const two = digestOf('|行动者|甲|\n|目标|乙、丙、丁|\n|伤害|21 / 18|');
    expect(two.targetResults.map((r) => r.hit)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('同前缀的名字取最长的那个', () => {
    const d = digestOf('|行动者|甲|\n|目标|盗匪、盗匪头目|\n|盗匪头目|失手|');
    expect(d.targetResults.map((r) => r.hit)).toEqual(['unknown', 'miss']);
  });

  it('与 targets 等长同序；没有目标时为空', () => {
    const d = digestOf('|行动者|甲|\n|目标|乙、丙|');
    expect(d.targetResults.map((r) => r.name)).toEqual(d.targets);
    expect(digestOf('|行动者|甲|\n|目标|无|').targetResults).toEqual([]);
  });
});

describe('digestActionPanel — 状态与结果句', () => {
  it('statuses 只收不是结论的状态格；结论状态与「无」不收', () => {
    const d = digestOf('|行动者|甲|\n|状态|乙 获得 流血(2回合)|\n|状态|[制作失败]|\n|状态|无|');
    expect(d.statuses).toEqual(['乙 获得 流血(2回合)']);
  });

  it('result 取结果行的叙述；结果只是结论词时不给', () => {
    expect(digestOf('|判定|失败|\n|结果|锁芯卡死，撬针折断|').result).toBe('锁芯卡死，撬针折断');
    expect(digestOf('{战斗结算}\n| 结果: [胜利] |').result).toBeUndefined();
  });
});

describe('digestActionPanel — 缺口修补', () => {
  it('① 带结论色的结论胜过不带色的短「结果」', () => {
    const d = digestOf('|判定|失败|\n|结果|锁芯卡死|');
    expect(d.verdict).toEqual({ text: '失败', tone: 'error' });
    expect(d.result).toBe('锁芯卡死');
    // 都不带色时仍按组优先级
    expect(digestOf('|判定|战意崩溃|\n|结果|狼王逃走|').verdict).toEqual({ text: '狼王逃走' });
  });

  it('② 单独一格「品质」不再让面板成为 outcome', () => {
    const d = digestOf('{生产准备}\n| 目标: 青铜护符 | 数量: 1 | 品质: 优良 |');
    expect(d.kind).toBe('generic');
    expect(digestOf('{生产准备}\n| 品质: 优良 | 产物: 青铜护符 |').kind).toBe('outcome');
  });

  it('③ 没有行动者时消耗记给空名', () => {
    const d = digestOf('{锻造}\n| 消耗: SP 15 |\n| 产物: 短剑 |');
    expect(d.deltas).toEqual([{ who: '', resource: 'SP', delta: -15 }]);
  });

  it('④ 带空格的参与者名按最长后缀认整名，认不出才退回最后一个词', () => {
    const d = digestOf('|行动者|赛琳|\n|目标|暗影 骑士|\n|变更|暗影 骑士 HP 50→20|');
    expect(d.deltas).toEqual([{ who: '暗影 骑士', resource: 'HP', delta: -30, from: 50, to: 20 }]);
    const unknown = digestOf('|行动者|赛琳|\n|变更|荒原 骑士 HP 50→20|');
    expect(unknown.deltas).toEqual([{ who: '骑士', resource: 'HP', delta: -30, from: 50, to: 20 }]);
  });

  it('⑤ `恢复 / 消耗 N 点 HP` 后置资源名', () => {
    const d = digestOf('|行动者|赛琳|\n|目标|无|\n|效果|赛琳 消耗 10 点 SP，恢复了 30 点 MP|');
    expect(d.deltas).toEqual([
      { who: '赛琳', resource: 'SP', delta: -10 },
      { who: '赛琳', resource: 'MP', delta: 30 },
    ]);
    const named = digestOf('|行动者|赛琳|\n|目标|莱恩|\n|效果|莱恩 恢复 20 点 HP|');
    expect(named.deltas).toEqual([{ who: '莱恩', resource: 'HP', delta: 20 }]);
    // 回看窗口有上限：动词离得太远就不认
    expect(digestOf(`|行动者|赛琳|\n|效果|恢复${'　'.repeat(20)}20 点 HP|`).deltas).toEqual([]);
    // 括号里的技能名不当人名，交给行首名字
    const skill = digestOf('{回合状态结算}\n| 石像守卫: 触发[石肤] 恢复 50 点 HP |');
    expect(skill.deltas).toEqual([{ who: '石像守卫', resource: 'HP', delta: 50 }]);
  });
});

describe('digestActionPanel — 七类典型面板（自编名字）', () => {
  it('① 单体攻击 · 暴击 · 自身消耗 · 附加状态', () => {
    const d = digestOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['行动', '裂风斩'],
        ['命中', 'd20=17 +敏捷5 → 22 / 闪避 14'],
        ['暴击检定', 'd100=08 ≤ 暴击率 15'],
        ['基础伤害', '2d8(5,6) +力量6 = 17'],
        ['暴击倍率', '17 × 2.0 = 34'],
        ['护甲减免', '0（破甲）'],
        ['判定', '暴击'],
        ['伤害', '34'],
        ['变更', '灰狼 HP 60→26'],
        ['变更', '艾琳 SP 88→76'],
        ['状态', '灰狼 获得 流血(2回合)'],
      ]),
    );
    expect(d).toMatchObject({
      kind: 'exchange',
      actor: '艾琳',
      targets: ['灰狼'],
      action: '裂风斩',
    });
    expect(d.verdict).toEqual({ text: '暴击', tone: 'success' });
    expect(d.roll).toEqual({
      die: 20,
      value: 17,
      modifier: 5,
      total: 22,
      against: { label: '闪避', value: 14 },
      raw: 'd20=17 +敏捷5 → 22 / 闪避 14',
    });
    expect(d.targetResults).toEqual([{ name: '灰狼', hit: 'hit' }]);
    expect(d.deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 },
      { who: '艾琳', resource: 'SP', delta: -12, from: 88, to: 76 },
    ]);
    expect(d.statuses).toEqual(['灰狼 获得 流血(2回合)']);
  });

  it('② 范围攻击 · 三个目标 · 一人失手', () => {
    const d = digestOf(
      sheet('出手 · 霜环术', [
        ['行动者', '莉娅'],
        ['目标', '盗匪甲、盗匪乙、盗匪头目'],
        ['行动', '霜环术'],
        ['施法检定', '法强 14，范围 3 格'],
        ['盗匪甲', 'd20=15 +6 → 21 / 抗性 12 命中，3d6(6,5,4)+6 = 21'],
        ['盗匪乙', 'd20=4 +6 → 10 / 抗性 12 失手'],
        ['盗匪头目', 'd20=12 +6 → 18 / 抗性 16 命中，3d6(5,4,3)+6 = 18'],
        ['判定', '命中 2/3'],
        ['伤害', '21 / 0 / 18'],
        ['变更', '盗匪甲 HP 48→27'],
        ['变更', '盗匪头目 HP 120→102'],
        ['变更', '莉娅 MP 64→46'],
        ['状态', '盗匪甲 获得 迟缓(1回合)'],
      ]),
    );
    expect(d.targets).toEqual(['盗匪甲', '盗匪乙', '盗匪头目']);
    expect(d.verdict?.text).toBe('命中 2/3');
    expect(d.roll).toBeUndefined();
    expect(d.targetResults.map((r) => [r.name, r.hit, r.roll?.value])).toEqual([
      ['盗匪甲', 'hit', 15],
      ['盗匪乙', 'miss', 4],
      ['盗匪头目', 'hit', 12],
    ]);
    expect(d.targetResults[2].roll?.against).toEqual({ label: '抗性', value: 16 });
    expect(d.deltas.map((x) => [x.who, x.resource, x.delta])).toEqual([
      ['盗匪甲', 'HP', -21],
      ['盗匪头目', 'HP', -18],
      ['莉娅', 'MP', -18],
    ]);
    expect(d.statuses).toEqual(['盗匪甲 获得 迟缓(1回合)']);
  });

  it('③ 治疗 / 增益友方', () => {
    const d = digestOf(
      sheet('施术 · 晨露祷言', [
        ['行动者', '塞拉'],
        ['目标', '艾琳'],
        ['行动', '晨露祷言'],
        ['治疗量', '4d6(6,5,4,3) +感知10 = 28'],
        ['过量治疗', '0'],
        ['判定', '生效'],
        ['恢复', '28'],
        ['变更', '艾琳 HP 41→69'],
        ['变更', '塞拉 MP 70→55'],
        ['状态', '艾琳 获得 再生(3回合)'],
      ]),
    );
    expect(d).toMatchObject({ kind: 'exchange', actor: '塞拉', targets: ['艾琳'] });
    expect(d.verdict?.text).toBe('生效');
    expect(d.roll).toBeUndefined();
    expect(d.targetResults).toEqual([{ name: '艾琳', hit: 'hit' }]);
    expect(d.deltas).toEqual([
      { who: '艾琳', resource: 'HP', delta: 28, from: 41, to: 69 },
      { who: '塞拉', resource: 'MP', delta: -15, from: 70, to: 55 },
    ]);
    expect(d.statuses).toEqual(['艾琳 获得 再生(3回合)']);
  });

  it('④ 回合总览 · 单位名册', () => {
    const d = digestOf(
      sheet('第 3 回合 · 战况总览', [
        ['环境', '夜雨 · 林道，视野 −2'],
        ['先攻顺序', '艾琳 → 灰狼 → 莉娅 → 盗匪头目 → 塞拉 → 盗匪喽啰'],
        ['艾琳', 'HP 69/96 MP 20/40 SP 76/110 · 再生(3回合)'],
        ['塞拉', 'HP 52/60 MP 55/120 SP 30/45'],
        ['莉娅', 'HP 38/58 MP 46/90 SP 22/40'],
        ['灰狼', 'HP 26/72 SP 40/60 · 流血(2回合)'],
        ['盗匪头目', 'HP 102/140 SP 55/80'],
        ['盗匪喽啰(2/3)', 'HP 27/110 · 迟缓(1回合)'],
      ]),
    );
    expect(d.kind).toBe('roster');
    expect(d.roster).toEqual([
      {
        name: '艾琳',
        hp: { cur: 69, max: 96 },
        mp: { cur: 20, max: 40 },
        sp: { cur: 76, max: 110 },
      },
      {
        name: '塞拉',
        hp: { cur: 52, max: 60 },
        mp: { cur: 55, max: 120 },
        sp: { cur: 30, max: 45 },
      },
      {
        name: '莉娅',
        hp: { cur: 38, max: 58 },
        mp: { cur: 46, max: 90 },
        sp: { cur: 22, max: 40 },
      },
      { name: '灰狼', hp: { cur: 26, max: 72 }, sp: { cur: 40, max: 60 } },
      { name: '盗匪头目', hp: { cur: 102, max: 140 }, sp: { cur: 55, max: 80 } },
      { name: '盗匪喽啰', cluster: { alive: 2, total: 3 }, hp: { cur: 27, max: 110 } },
    ]);
    expect(d.deltas).toEqual([]);
    expect(d.targetResults).toEqual([]);
    expect(d.roll).toBeUndefined();
  });

  it('⑤ 制作结果 · 成功', () => {
    const d = digestOf(
      [
        sheet('备料', [
          ['材料', '精钢锭 ×3、硬木柄 ×1'],
          ['材料品质', '优良 → 成功率 +8'],
        ]),
        sheet('锻打', [
          ['基础成功率', '60 +技艺10 +材料8 = 78'],
          ['检定', 'd100=31 ≤ 78 成功'],
        ]),
        sheet('淬火', [
          ['品质骰', 'd100=83 +技艺10 → 93 ≥ 85 稀有'],
          ['产物', '精钢短剑'],
          ['品质', '稀有'],
          ['经验', '+45'],
          ['变更', '艾琳 SP 76→61'],
          ['结果', '锻成一柄稀有品质的精钢短剑'],
        ]),
      ].join('\n'),
    );
    expect(d.kind).toBe('outcome');
    expect(d.title).toBe('备料');
    expect(d.verdict).toEqual({ text: '成功', tone: 'success' });
    expect(d.roll).toEqual({
      die: 100,
      value: 31,
      against: { label: '', value: 78 },
      raw: 'd100=31 ≤ 78 成功',
    });
    expect(d.result).toBe('锻成一柄稀有品质的精钢短剑');
    expect(d.deltas).toEqual([{ who: '艾琳', resource: 'SP', delta: -15, from: 76, to: 61 }]);
    // 已有结论时过长的结果句不进 facts（照旧），改由 result 给出
    expect(d.facts.map((c) => c.label)).toEqual(['产物', '品质']);
  });

  it('⑥ 技能检定 · 失败（d20 对 DC）', () => {
    const d = digestOf(
      sheet('检定 · 撬开铁匣', [
        ['行动者', '艾琳'],
        ['行动', '开锁'],
        ['难度', 'DC 14（精工锁）'],
        ['掷骰', 'd20=6'],
        ['修正', '灵巧 +3，无工具加成'],
        ['合计', '6 + 3 = 9 < 14'],
        ['判定', '失败'],
        ['结果', '锁芯卡死，撬针折断'],
      ]),
    );
    expect(d).toMatchObject({ actor: '艾琳', action: '开锁', targets: [] });
    expect(d.verdict).toEqual({ text: '失败', tone: 'error' });
    expect(d.result).toBe('锁芯卡死，撬针折断');
    expect(d.roll).toEqual({ die: 20, value: 6, raw: 'd20=6' });
    expect(d.targetResults).toEqual([]);
    expect(d.statuses).toEqual([]);
  });

  it('⑦ 旧式面板 · 无约定行（降级）：facts 仍是 summaryCells，另认出单骰', () => {
    const panel = parseActionPanel(
      sheet('潜行 · 穿过哨卡', [
        ['潜行', '1d20(13)+4=17'],
        ['守卫警觉', '12'],
        ['光照', '昏暗 +2'],
        ['负重', '轻'],
        ['距离', '约 20 米'],
        ['备注', '雨声掩盖了脚步'],
      ]),
    );
    const d = digestActionPanel(panel);
    expect(d.kind).toBe('generic');
    expect(d.facts).toEqual(summaryCells(panel.sections[0]));
    expect(d.roll).toEqual({ die: 20, value: 13, modifier: 4, total: 17, raw: '1d20(13)+4=17' });
    expect(d.verdict).toBeUndefined();
    expect(d.targetResults).toEqual([]);
  });
});

describe('digestActionPanel — 掷骰与目标证据的健壮性', () => {
  it('掷骰残片不抛', () => {
    for (const raw of [
      '|判定|d|',
      '|判定|d20=|',
      '|判定|d20(|',
      '|判定|d20(1,|',
      '|判定|1d20(13)+|',
      '|判定|d20=5 / |',
      '|判定|d20=5 → |',
      '|判定|d20=5 vs|',
      '|判定|d20=5 + 敏捷敏捷敏捷敏捷敏捷 3|',
      '|行动者|甲|\n|目标|→|\n|→|失手|',
    ]) {
      expect(() => digestOf(raw)).not.toThrow();
    }
  });

  it('20 万字符的骰子垃圾：很快结束', () => {
    const spaces = ' '.repeat(200_000);
    const raws = [
      `|判定|d20${spaces}=${spaces}5${spaces}+${spaces}3${spaces}→${spaces}|`,
      `|判定|${'d'.repeat(200_000)}|`,
      `|判定|${'d1 '.repeat(70_000)}|`,
      `|判定|1d20(${'1,'.repeat(100_000)}|`,
      `|效果|${'恢复 1 点 '.repeat(20_000)}HP|`,
      `|行动者|甲|\n|目标|乙|\n|备注|${'乙 · '.repeat(40_000)}|`,
    ];
    for (const raw of raws) {
      const t0 = performance.now();
      digestOf(raw);
      // 防的是灾难性回溯（那会是数秒到数分钟）；CI 机器比本机慢 4–5 倍，1 秒上限会偶发误报
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });

  it('2 万个目标行：很快结束', () => {
    const names = Array.from({ length: 20_000 }, (_, i) => `匪${i}`);
    const rows = names.map((n) => `|${n}|d20=3 失手|`).join('\n');
    const t0 = performance.now();
    const d = digestOf(`|行动者|甲|\n|目标|${names.join('、')}|\n${rows}`);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.targetResults).toHaveLength(20_000);
    expect(d.targetResults.every((r) => r.hit === 'miss')).toBe(true);
  });
});

describe('digestActionPanel — 资源归属与去重', () => {
  const deltasOf = (raw: string) =>
    digestOf(raw).deltas.map((x) => [x.who, x.resource, x.delta] as const);

  it('同一格里后面没写名字的记号沿用前一个名字（不落到唯一目标头上）', () => {
    expect(deltasOf('|行动者|艾琳|\n|目标|灰狼|\n|变更|艾琳 HP 80→70，MP 40→28|')).toEqual([
      ['艾琳', 'HP', -10],
      ['艾琳', 'MP', -12],
    ]);
  });

  it('变更行完全没写名字：MP/SP 记给行动者，HP 记给唯一目标', () => {
    expect(deltasOf('|行动者|艾琳|\n|目标|灰狼|\n|变更|MP 40→28，HP 60→45|')).toEqual([
      ['艾琳', 'MP', -12],
      ['灰狼', 'HP', -15],
    ]);
  });

  it('伤害行与变更行写同一笔裸增减：只记一次', () => {
    const d = digestOf(
      '|行动者|艾琳|\n|目标|灰狼|\n|伤害|灰狼 HP -15|\n|变更|灰狼 HP -15 (剩余HP: 45)|',
    );
    const hp = d.deltas.filter((x) => x.who === '灰狼' && x.resource === 'HP');
    expect(hp).toHaveLength(1);
    expect(hp[0].delta).toBe(-15);
  });

  it('多行明细之和等于变更汇总：不重复计数', () => {
    expect(
      deltasOf(
        '|行动者|艾琳|\n|目标|灰狼|\n|第一击|灰狼 HP -10|\n|第二击|灰狼 HP -10|\n|变更|灰狼 HP -20|',
      ),
    ).toEqual([['灰狼', 'HP', -20]]);
  });

  it('两行明细各写一笔（没有变更汇总）照常相加', () => {
    expect(
      deltasOf('|行动者|艾琳|\n|目标|灰狼|\n|第一击|灰狼 HP -10|\n|第二击|灰狼 HP -10|'),
    ).toEqual([['灰狼', 'HP', -20]]);
  });

  it('旧格式 `|伤害|0|` 不产生 −0 的 HP 变化，目标判 miss', () => {
    const d = digestOf('|行动者|艾琳|\n|目标|灰狼|\n|判定|失手|\n|伤害|0|');
    expect(d.deltas).toEqual([]);
    expect(d.targetResults).toEqual([{ name: '灰狼', hit: 'miss' }]);
  });
});

describe('digestActionPanel — generic 多节面板的关键格', () => {
  it('结果写在最后一节末尾：facts 取到它', () => {
    const raw = `{采集准备}
|工具|铁镐|
|地点|北坡矿脉|
{采集过程}
|掷骰|d20=14|
|结果|获得铁矿石×3|`;
    const d = digestOf(raw);
    expect(d.kind).toBe('generic');
    const values = d.facts.map((c) => c.value);
    expect(values).toContain('获得铁矿石×3');
    expect(values).not.toContain('铁镐');
    expect(d.facts.length).toBeLessThanOrEqual(3);
  });

  it('带结论色的结果格同时给出结论', () => {
    const raw = `{采集准备}
|工具|铁镐|
{采集过程}
|掷骰|d20=19|
|结果|大成功|`;
    const d = digestOf(raw);
    expect(d.facts.map((c) => c.value)).toContain('大成功');
    expect(d.verdict?.text).toBe('大成功');
    expect(d.verdict?.tone).toBeDefined();
  });

  it('多节都认不出结论格时退回第一节的 summaryCells', () => {
    const panel = parseActionPanel('{甲}\n|工具|铁镐|\n|地点|北坡|\n{乙}\n|天气|晴|');
    expect(digestActionPanel(panel).facts).toEqual(summaryCells(panel.sections[0]));
  });

  it('至多 3 格，偏向靠后的结论', () => {
    const raw = '{一}\n|结果|甲|\n{二}\n|结果|乙|\n{三}\n|结果|丙|\n{四}\n|结果|丁|';
    expect(digestOf(raw).facts.map((c) => c.value)).toEqual(['乙', '丙', '丁']);
  });
});

describe('digestActionPanel — 资源记号前的修饰语不是单位名', () => {
  const attack = (label: string, value: string) =>
    digestOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['行动', '裂风斩'],
        [label, value],
      ]),
    );

  it.each([['造成 HP -34'], ['最终 HP -34'], ['减伤后 HP -34']])(
    '`|伤害|%s|`：记给唯一目标，不造出新单位',
    (value) => {
      const d = attack('伤害', value);
      expect(d.targets).toEqual(['灰狼']);
      expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -34 }]);
    },
  );

  it('`|伤害|敌方 HP 60→26|`：起止齐全，同样记给唯一目标', () => {
    expect(attack('伤害', '敌方 HP 60→26').deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 },
    ]);
  });

  it('`|变更|敌方 HP 60→26|`：「敌方」不是名字，点名行里也退回唯一目标', () => {
    expect(attack('变更', '敌方 HP 60→26').deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 },
    ]);
  });

  it('`|恢复|回复量 HP +20|`：记给唯一目标', () => {
    const d = digestOf(
      sheet('施术 · 愈光', [
        ['行动者', '莉娅'],
        ['目标', '艾琳'],
        ['恢复', '回复量 HP +20'],
      ]),
    );
    expect(d.deltas).toEqual([{ who: '艾琳', resource: 'HP', delta: 20 }]);
  });

  it('消耗格里的修饰语退回行动者', () => {
    expect(attack('消耗', '本次 SP 12').deltas).toEqual([
      { who: '艾琳', resource: 'SP', delta: -12 },
    ]);
  });

  it('非点名行的行首若不是已知参与者，也不当名字（`|减伤后|HP -34|`）', () => {
    expect(attack('减伤后', 'HP -34').deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -34 },
    ]);
  });

  it('非点名行里写明的已知参与者照认（`|伤害|艾琳 HP -5|` 是反伤）', () => {
    expect(attack('伤害', '艾琳 HP -5').deltas).toEqual([
      { who: '艾琳', resource: 'HP', delta: -5 },
    ]);
  });
});

describe('digestActionPanel — 目标写自己', () => {
  it.each([['自身'], ['自己'], ['本人'], ['艾琳']])(
    '`|目标|%s|`：不另列目标，变化都归行动者',
    (target) => {
      const d = digestOf(
        sheet('施术 · 自愈', [
          ['行动者', '艾琳'],
          ['目标', target],
          ['行动', '自愈'],
          ['变更', '艾琳 HP 50→70'],
          ['变更', '艾琳 MP 40→30'],
        ]),
      );
      expect(d.actor).toBe('艾琳');
      expect(d.targets).toEqual([]);
      expect(d.deltas).toEqual([
        { who: '艾琳', resource: 'HP', delta: 20, from: 50, to: 70 },
        { who: '艾琳', resource: 'MP', delta: -10, from: 40, to: 30 },
      ]);
    },
  );
});

describe('digestActionPanel — 旧协议逐人清单与行首名（宁少认不认错）', () => {
  it('`|目标|盗匪们|` + 一格两人起止：各记各的，不并进群体标签', () => {
    const d = digestOf(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪们'],
        ['伤害', '盗匪甲 HP 40→22；盗匪乙 HP 38→20'],
      ]),
    );
    expect(d.deltas).toEqual([
      { who: '盗匪甲', resource: 'HP', delta: -18, from: 40, to: 22 },
      { who: '盗匪乙', resource: 'HP', delta: -18, from: 38, to: 20 },
    ]);
  });

  it('`|目标|盗匪们|` + 一格两人增减：各 −18，不是盗匪们 −36', () => {
    const d = digestOf(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪们'],
        ['伤害', '盗匪甲 HP -18；盗匪乙 HP -18'],
      ]),
    );
    expect(d.deltas).toEqual([
      { who: '盗匪甲', resource: 'HP', delta: -18 },
      { who: '盗匪乙', resource: 'HP', delta: -18 },
    ]);
  });

  it('`|目标|灰狼|` + `灰狼 HP -34；幼狼 HP -10`：幼狼不并进灰狼', () => {
    const d = digestOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['伤害', '灰狼 HP -34；幼狼 HP -10'],
      ]),
    );
    expect(d.deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -34 },
      { who: '幼狼', resource: 'HP', delta: -10 },
    ]);
  });

  it('行首名起止齐全的行：`|幼狼|HP 30→20|` 是另一个单位', () => {
    const d = digestOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['灰狼', 'HP 60→45'],
        ['幼狼', 'HP 30→20'],
      ]),
    );
    expect(d.deltas).toEqual([
      { who: '灰狼', resource: 'HP', delta: -15, from: 60, to: 45 },
      { who: '幼狼', resource: 'HP', delta: -10, from: 30, to: 20 },
    ]);
  });

  it('多目标 + 名单外的第三人：盗匪丙不并进盗匪乙', () => {
    const d = digestOf(
      sheet('出手 · 霜环术', [
        ['行动者', '莉娅'],
        ['目标', '盗匪甲、盗匪乙'],
        ['伤害', '盗匪甲 HP -18；盗匪乙 HP -18；盗匪丙 HP -9'],
      ]),
    );
    expect(d.deltas).toEqual([
      { who: '盗匪甲', resource: 'HP', delta: -18 },
      { who: '盗匪乙', resource: 'HP', delta: -18 },
      { who: '盗匪丙', resource: 'HP', delta: -9 },
    ]);
  });

  it('多目标时一格里唯一一个认不出的词：没有唯一目标可退，宁可丢掉', () => {
    const d = digestOf(
      sheet('出手 · 霜环术', [
        ['行动者', '莉娅'],
        ['目标', '盗匪甲、盗匪乙'],
        ['伤害', '盗匪丙 HP -9'],
      ]),
    );
    expect(d.deltas).toEqual([]);
  });
});

describe('digestActionPanel — 波及类标签', () => {
  it.each([
    ['波及', 'HP -10'],
    ['溅射', '造成 HP -10'],
    ['连带', 'HP -10'],
  ])('`|%s|%s|`：标签不是单位名，记给唯一目标', (label, value) => {
    const d = digestOf(
      sheet('出手 · 火球术', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        [label, value],
      ]),
    );
    expect(d.targets).toEqual(['灰狼']);
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -10 }]);
  });

  it('`|波及|幼狼 HP 30→20|`：点名行里写明的旁人照认', () => {
    const d = digestOf(
      sheet('出手 · 火球术', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['波及', '幼狼 HP 30→20'],
      ]),
    );
    expect(d.deltas).toEqual([{ who: '幼狼', resource: 'HP', delta: -10, from: 30, to: 20 }]);
  });
});

describe('digestActionPanel — 名字认读的边角', () => {
  it('没有参与者的面板：行首单位名不被记号前的词顶掉（`|灰狼|流血 HP -5|`）', () => {
    const d = digestOf('{回合状态结算}\n|灰狼|流血 HP -5|');
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -5 }]);
  });

  it('点名行里以已知参与者开头的词认那个参与者（`灰狼受创` → 灰狼）', () => {
    const d = digestOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['变更', '灰狼受创 HP 60→26'],
      ]),
    );
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 }]);
  });

  it('只多一个字的词不归前缀那人（`盗匪甲` 不并进目标 `盗匪`）', () => {
    const d = digestOf(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪'],
        ['变更', '盗匪甲 HP 30→12'],
      ]),
    );
    expect(d.deltas.map((x) => x.who)).toEqual(['盗匪甲']);
  });
});

describe('digestActionPanel — 审查 A3：千分位与分句逗号', () => {
  it('`60→26,3回合流血` 读成 26（伤害，不是 263 的治疗）', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|灰狼|\n|变更|灰狼 HP 60→26,3回合流血|');
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 }]);
  });

  it('逗号后恰好三位数字才算千分位：`1,200` 仍是 1200', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|灰狼|\n|变更|灰狼 HP 2,000→1,200|');
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -800, from: 2000, to: 1200 }]);
  });

  it('`HP -15,2回合` 得 −15', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|灰狼|\n|变更|灰狼 HP -15,2回合|');
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -15 }]);
  });

  it('逗号后跟四位数字不算千分位：`HP -15,2000` 得 −15', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|灰狼|\n|变更|灰狼 HP -15,2000|');
    expect(d.deltas).toEqual([{ who: '灰狼', resource: 'HP', delta: -15 }]);
  });
});

describe('digestActionPanel — 审查 A5：长输入不回溯', () => {
  it('10 万空格的 `|目标|` 格：很快结束', () => {
    const raw = `|行动者|甲|\n|目标|乙${' '.repeat(100_000)}丙|`;
    const t0 = performance.now();
    digestOf(raw);
    // 防的是灾难性回溯（原实测 5.7 s）；CI 机器比本机慢 4–5 倍
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('10 万个 `.` 的 `|结果|` 格：很快结束', () => {
    const raws = [`|结果|${'.'.repeat(100_000)}命中|`, `|结果|命中${'.'.repeat(100_000)}|`];
    for (const raw of raws) {
      const t0 = performance.now();
      digestOf(raw);
      // 原实测 15 s
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });

  it('`甲 和 乙` 仍拆成两个目标，`和` 不夹空白时不拆', () => {
    expect(digestOf('|行动者|莱恩|\n|目标|灰狼 和  黑熊|').targets).toEqual(['灰狼', '黑熊']);
    expect(digestOf('|行动者|莱恩|\n|目标|灰狼和黑熊|').targets).toEqual(['灰狼和黑熊']);
  });

  it('结论末尾的句号 / 叹号照旧剥掉', () => {
    expect(digestOf('|结果|命中！。..|').verdict?.text).toBe('命中');
  });
});

describe('digestActionPanel — 审查 A6：交锋误判与百分比', () => {
  it('标题 `{制作流程: 熔炼 → 锻打}` 不判交锋', () => {
    const d = digestOf('{制作流程: 熔炼 → 锻打}\n|产物|铁剑|\n|结果|成功|');
    expect(d.kind).not.toBe('exchange');
    expect(d.actor).toBeUndefined();
    expect(d.targets).toEqual([]);
  });

  it('名字形态的标题 `{莱恩 → 林狼 · 斩击}` 仍判交锋', () => {
    const d = digestOf('{莱恩 → 林狼 · 斩击}\n| 结果: 命中 |');
    expect(d.kind).toBe('exchange');
    expect(d.actor).toBe('莱恩');
    expect(d.targets).toEqual(['林狼']);
    expect(d.action).toBe('斩击');
  });

  it('格子里已认出行动者时，标题左边不是名字也照样补目标', () => {
    const d = digestOf('{第一回合: 莱恩 → 林狼}\n|行动者|莱恩|\n|结果|命中|');
    expect(d.actor).toBe('莱恩');
    expect(d.targets).toEqual(['林狼']);
  });

  it('`HP -10%` 不记成 −10', () => {
    const d = digestOf('|行动者|莱恩|\n|目标|灰狼|\n|变更|灰狼 HP -10%|');
    expect(d.deltas).toEqual([]);
  });
});
