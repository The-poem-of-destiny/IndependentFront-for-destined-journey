/**
 * action-panel-view.ts — 行动面板视图模型
 *
 * 守的是：七类典型面板（单体攻击、群攻、治疗、暴击、制作、带行动者行的失败检定、战况）里
 * 各款卡片样式都要现算的东西 —— 出手方消耗、逐目标 HP 与状态、失手、暴击 / 治疗、
 * 结算的产物品质经验、算式区结论行 —— 由视图模型一次给齐；带行动者行的失败检定按 outcome 呈现；
 * 只挂增益的目标是 unknown 不是 miss；任何输入都不抛。
 * 样例全部是自编的名字与文字。
 */
import { describe, expect, it } from 'vitest';
import { parseActionPanel, type ActionPanel } from '../../../src/ui/lib/action-panel';
import { buildActionView } from '../../../src/ui/lib/action-panel-view';

function sheet(title: string, rows: ReadonlyArray<readonly [string, string]>): string {
  return [`{${title}}`, ...rows.map(([k, v]) => `|${k}|${v}|`)].join('\n');
}

function viewOf(raw: string) {
  return buildActionView(parseActionPanel(raw));
}

/** 算式区某一行（按标签 + 第几次出现） */
function calcRow(view: ReturnType<typeof viewOf>, label: string, nth = 0) {
  return view.calc.flatMap((s) => s.rows).filter((r) => r.label === label)[nth];
}

function tokensText(tokens: ReadonlyArray<{ text: string }>): string {
  return tokens.map((t) => t.text).join('');
}

describe('buildActionView — 七类典型面板', () => {
  it('① 单体攻击 · 暴击 · 自身消耗 · 附加状态', () => {
    const v = viewOf(
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
    expect(v).toMatchObject({
      kind: 'exchange',
      title: '出手 · 裂风斩',
      actor: '艾琳',
      action: '裂风斩',
      verdict: { text: '暴击', tone: 'success' },
      crit: true,
      heal: false,
    });
    expect(v.targets).toEqual([
      {
        name: '灰狼',
        hit: 'hit',
        hp: { who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 },
        deltas: [{ who: '灰狼', resource: 'HP', delta: -34, from: 60, to: 26 }],
        statuses: ['流血(2回合)'],
      },
    ]);
    expect(v.ownDeltas).toEqual([{ who: '艾琳', resource: 'SP', delta: -12, from: 88, to: 76 }]);
    expect(v.looseStatuses).toEqual([]);
    expect(v.outcome).toBeUndefined();
    expect(v.roll?.total).toBe(22);

    // 算式区：一节，13 行，结论行加粗
    expect(v.calc).toHaveLength(1);
    expect(v.calc[0]).toMatchObject({ title: '出手 · 裂风斩', hue: 'info' });
    expect(v.calc[0].rows).toHaveLength(13);
    expect(calcRow(v, '行动者')).toMatchObject({ result: false, wide: false });
    expect(calcRow(v, '判定')).toMatchObject({ result: true, tone: 'success' });
    for (const label of ['伤害', '变更', '状态']) expect(calcRow(v, label).result).toBe(true);
    expect(calcRow(v, '变更', 1).result).toBe(true);
    // 值切成高亮 token：骰值与箭头
    const hit = calcRow(v, '命中');
    expect(tokensText(hit.tokens)).toBe('d20=17 +敏捷5 → 22 / 闪避 14');
    expect(hit.tokens[0]).toEqual({ text: 'd20=17', kind: 'dice' });
    expect(calcRow(v, '变更').tokens).toContainEqual({ text: '26', kind: 'down' });
  });

  it('② 范围攻击 · 三个目标 · 一人失手', () => {
    const v = viewOf(
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
    expect(v.kind).toBe('exchange');
    expect(v.verdict?.text).toBe('命中 2/3');
    expect(v.crit).toBe(false);
    expect(v.heal).toBe(false);
    expect(v.targets.map((t) => [t.name, t.hit, t.hp?.delta, t.roll?.value, t.statuses])).toEqual([
      ['盗匪甲', 'hit', -21, 15, ['迟缓(1回合)']],
      ['盗匪乙', 'miss', undefined, 4, []],
      ['盗匪头目', 'hit', -18, 12, []],
    ]);
    expect(v.targets[1].deltas).toEqual([]);
    expect(v.ownDeltas.map((x) => [x.who, x.resource, x.delta])).toEqual([['莉娅', 'MP', -18]]);
    expect(v.looseStatuses).toEqual([]);
    // 长值跨两列
    expect(calcRow(v, '盗匪甲').wide).toBe(true);
    expect(calcRow(v, '行动').wide).toBe(false);
  });

  it('③ 治疗 / 增益友方', () => {
    const v = viewOf(
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
    expect(v).toMatchObject({ kind: 'exchange', actor: '塞拉', heal: true, crit: false });
    expect(v.verdict?.text).toBe('生效');
    expect(v.targets).toEqual([
      {
        name: '艾琳',
        hit: 'hit',
        hp: { who: '艾琳', resource: 'HP', delta: 28, from: 41, to: 69 },
        deltas: [{ who: '艾琳', resource: 'HP', delta: 28, from: 41, to: 69 }],
        statuses: ['再生(3回合)'],
      },
    ]);
    expect(v.ownDeltas).toEqual([{ who: '塞拉', resource: 'MP', delta: -15, from: 70, to: 55 }]);
    expect(calcRow(v, '恢复').result).toBe(true);
  });

  it('④ 回合总览 · 单位名册', () => {
    const v = viewOf(
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
    expect(v.kind).toBe('roster');
    expect(v.title).toBe('第 3 回合 · 战况总览');
    expect(v.roster.map((u) => [u.name, u.hp?.cur, u.hp?.max])).toEqual([
      ['艾琳', 69, 96],
      ['塞拉', 52, 60],
      ['莉娅', 38, 58],
      ['灰狼', 26, 72],
      ['盗匪头目', 102, 140],
      ['盗匪喽啰', 27, 110],
    ]);
    expect(v.roster[5].cluster).toEqual({ alive: 2, total: 3 });
    expect(v.targets).toEqual([]);
    expect(v.ownDeltas).toEqual([]);
    expect(v.outcome).toBeUndefined();
    expect(v.calc[0].rows).toHaveLength(8);
    expect(v.calc[0].rows.every((r) => !r.result)).toBe(true);
  });

  it('⑤ 制作结果 · 成功：产物 / 品质色与档位 / 经验 / 检定骰，消耗记给唯一的出手人', () => {
    const v = viewOf(
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
    expect(v.kind).toBe('outcome');
    expect(v.actor).toBe('艾琳');
    expect(v.verdict).toEqual({ text: '成功', tone: 'success' });
    expect(v.outcome).toEqual({
      product: '精钢短剑',
      quality: '稀有',
      qualityVar: 'var(--theme-quality-rare)',
      qualityRank: 2,
      exp: '+45',
      resultText: '锻成一柄稀有品质的精钢短剑',
      roll: {
        die: 100,
        value: 31,
        against: { label: '', value: 78 },
        raw: 'd100=31 ≤ 78 成功',
      },
    });
    expect(v.ownDeltas).toEqual([{ who: '艾琳', resource: 'SP', delta: -15, from: 76, to: 61 }]);
    expect(v.targets).toEqual([]);
    // 三节算式，色相取自面板
    expect(v.calc.map((s) => s.title)).toEqual(['备料', '锻打', '淬火']);
    for (const label of ['产物', '品质', '经验', '结果'])
      expect(calcRow(v, label).result).toBe(true);
    expect(calcRow(v, '材料').result).toBe(false);
    // 「品质骰」不是品质
    expect(calcRow(v, '品质骰').result).toBe(false);
  });

  it('⑥ 技能检定 · 失败：有行动者行但无目标、只有检定 → 按 outcome 呈现', () => {
    const v = viewOf(
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
    expect(v).toMatchObject({
      kind: 'outcome',
      actor: '艾琳',
      action: '开锁',
      verdict: { text: '失败', tone: 'error' },
      crit: false,
      heal: false,
    });
    expect(v.outcome).toEqual({
      qualityRank: -1,
      resultText: '锁芯卡死，撬针折断',
      roll: { die: 20, value: 6, raw: 'd20=6' },
    });
    expect(v.targets).toEqual([]);
    expect(v.ownDeltas).toEqual([]);
    expect(v.calc[0].hue).toBe('check');
    expect(calcRow(v, '判定')).toMatchObject({ result: true, tone: 'error' });
    expect(calcRow(v, '结果').result).toBe(true);
  });

  it('⑦ 旧式面板 · 无约定行（降级）', () => {
    const v = viewOf(
      sheet('潜行 · 穿过哨卡', [
        ['潜行', '1d20(13)+4=17'],
        ['守卫警觉', '12'],
        ['光照', '昏暗 +2'],
        ['负重', '轻'],
        ['距离', '约 20 米'],
        ['备注', '雨声掩盖了脚步'],
      ]),
    );
    expect(v.kind).toBe('generic');
    expect(v.title).toBe('潜行 · 穿过哨卡');
    expect(v.actor).toBeUndefined();
    expect(v.verdict).toBeUndefined();
    expect(v.outcome).toBeUndefined();
    expect(v.facts.length).toBeGreaterThan(0);
    expect(v.facts.length).toBeLessThanOrEqual(3);
    expect(v.roll).toMatchObject({ die: 20, value: 13, total: 17 });
    expect(v.calc[0].rows.map((r) => r.label)).toEqual([
      '潜行',
      '守卫警觉',
      '光照',
      '负重',
      '距离',
      '备注',
    ]);
    expect(v.calc[0].rows.every((r) => !r.result)).toBe(true);
  });
});

describe('buildActionView — 边界', () => {
  it('只挂增益的目标：没有 HP 变化也没失手 → unknown，不是 miss', () => {
    const v = viewOf(
      sheet('施术 · 坚壁', [
        ['行动者', '塞拉'],
        ['目标', '艾琳'],
        ['行动', '坚壁'],
        ['判定', '生效'],
        ['变更', '塞拉 MP 70→60'],
        ['状态', '艾琳 获得 护盾(2回合)'],
      ]),
    );
    expect(v.kind).toBe('exchange');
    expect(v.targets).toEqual([
      { name: '艾琳', hit: 'unknown', deltas: [], statuses: ['护盾(2回合)'] },
    ]);
    expect(v.heal).toBe(false);
    expect(v.ownDeltas.map((x) => x.who)).toEqual(['塞拉']);
  });

  it('没写名字的消耗（who 为空）算出手方', () => {
    const v = viewOf(
      sheet('制作 · 绷带', [
        ['资源消耗', 'SP 5'],
        ['判定', '成功'],
      ]),
    );
    expect(v.ownDeltas).toEqual([{ who: '', resource: 'SP', delta: -5 }]);
  });

  it('有行动者、无目标、无检定也无结果行：仍是 exchange', () => {
    const v = viewOf(
      sheet('移动', [
        ['行动者', '艾琳'],
        ['行动', '后撤两格'],
      ]),
    );
    expect(v.kind).toBe('exchange');
    expect(v.outcome).toBeUndefined();
  });

  it('同前缀目标名：状态归最长的那个；认不出归属的进 looseStatuses', () => {
    const v = viewOf(
      sheet('出手', [
        ['行动者', '甲'],
        ['目标', '盗匪、盗匪头目'],
        ['状态', '盗匪头目 获得 眩晕(1回合)'],
        ['状态', '大雾 弥漫'],
      ]),
    );
    expect(v.targets.map((t) => [t.name, t.statuses])).toEqual([
      ['盗匪', []],
      ['盗匪头目', ['眩晕(1回合)']],
    ]);
    expect(v.looseStatuses).toEqual(['大雾 弥漫']);
  });

  it('无标签散行跨两列；认不出的品质落普通色、档位 −1', () => {
    const v = viewOf(
      sheet('结算', [
        ['产物', '怪石'],
        ['品质', '奇特'],
        ['结果', '得到一块怪石'],
      ]) + '\n雨停了',
    );
    expect(v.kind).toBe('outcome');
    expect(v.outcome).toMatchObject({
      product: '怪石',
      quality: '奇特',
      qualityVar: 'var(--theme-quality-common)',
      qualityRank: -1,
    });
    const loose = v.calc[0].rows.find((r) => r.label === '');
    expect(loose).toMatchObject({ wide: true, result: false });
  });

  it('垃圾输入不抛，退回空视图或合法视图', () => {
    const inputs: unknown[] = [
      null,
      undefined,
      {},
      { sections: null },
      { sections: [null, { title: 3, rows: [null, { cells: [null, { label: 1 }] }] }] },
      { sections: 'x' },
      42,
      'raw',
    ];
    for (const input of inputs) {
      expect(() => buildActionView(input as ActionPanel)).not.toThrow();
      const v = buildActionView(input as ActionPanel);
      expect(Array.isArray(v.targets)).toBe(true);
      expect(Array.isArray(v.calc)).toBe(true);
    }
    expect(buildActionView(null as unknown as ActionPanel)).toMatchObject({
      kind: 'generic',
      targets: [],
      calc: [],
    });
  });

  it('getter 抛错的面板：退回空 generic 视图', () => {
    const evil = {
      get sections(): never {
        throw new Error('boom');
      },
    } as unknown as ActionPanel;
    expect(buildActionView(evil)).toEqual({
      kind: 'generic',
      title: '',
      crit: false,
      heal: false,
      targets: [],
      ownDeltas: [],
      looseStatuses: [],
      roster: [],
      facts: [],
      calc: [],
    });
  });
});

describe('buildActionView — 名单外的资源变化', () => {
  it('有变化却不是行动者也不在目标里的旁人补进 targets（交锋里掉 HP 算打中）', () => {
    const v = viewOf(
      sheet('火球术', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['变更', '灰狼 HP 60→45'],
        ['波及', '猎人 HP 30→22'],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['灰狼', '猎人']);
    const hunter = v.targets[1];
    expect(hunter.hit).toBe('hit');
    expect(hunter.hp?.delta).toBe(-8);
    expect(v.ownDeltas).toEqual([]);
  });

  it('补进来的旁人没有掉 HP 时是 unknown', () => {
    const v = viewOf(
      sheet('鼓舞', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['变更', '灰狼 HP 60→45，猎人 SP 10→20'],
      ]),
    );
    const hunter = v.targets.find((t) => t.name === '猎人');
    expect(hunter?.hit).toBe('unknown');
    expect(hunter?.deltas.map((x) => [x.resource, x.delta])).toEqual([['SP', 10]]);
  });

  it('群体标签自己没有变化、成员有：换成成员，不留空的群体条目', () => {
    const v = viewOf(
      sheet('横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪们'],
        ['变更', '盗匪甲 HP 30→12，盗匪乙 HP 30→0'],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['盗匪甲', '盗匪乙']);
    expect(v.targets.map((t) => t.hp?.delta)).toEqual([-18, -30]);
    expect(v.targets.every((t) => t.hit === 'hit')).toBe(true);
  });

  it('群体标签自己有变化时保留它，成员照常补在后面', () => {
    const v = viewOf(
      sheet('横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪们'],
        ['变更', '盗匪们 HP 90→60，盗匪甲 HP 30→12'],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['盗匪们', '盗匪甲']);
  });
});

describe('buildActionView — 修饰语与自身目标', () => {
  it.each([
    ['伤害', '造成 HP -34'],
    ['伤害', '最终 HP -34'],
    ['伤害', '减伤后 HP -34'],
    ['伤害', '敌方 HP 60→26'],
  ])('`|%s|%s|`：只有灰狼一个目标，没有凭空多出的单位', (label, value) => {
    const v = viewOf(
      sheet('出手 · 裂风斩', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        [label, value],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['灰狼']);
    expect(v.targets[0].hp?.delta).toBe(-34);
    expect(v.ownDeltas).toEqual([]);
  });

  it('`|恢复|回复量 HP +20|`：只有一个目标，且判为治疗', () => {
    const v = viewOf(
      sheet('施术 · 愈光', [
        ['行动者', '莉娅'],
        ['目标', '艾琳'],
        ['恢复', '回复量 HP +20'],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['艾琳']);
    expect(v.heal).toBe(true);
  });

  it('`|目标|自身|`：没有目标，回血与耗蓝都是出手方自己的变化', () => {
    const v = viewOf(
      sheet('施术 · 自愈', [
        ['行动者', '艾琳'],
        ['目标', '自身'],
        ['变更', '艾琳 HP 50→70'],
        ['变更', '艾琳 MP 40→30'],
      ]),
    );
    expect(v.kind).toBe('exchange');
    expect(v.targets).toEqual([]);
    expect(v.ownDeltas.map((x) => [x.resource, x.delta])).toEqual([
      ['HP', 20],
      ['MP', -10],
    ]);
  });
});

describe('buildActionView — 旧协议逐人清单', () => {
  it('`|目标|盗匪们|` + `|伤害|` 一格两人：群体换成成员，各 −18', () => {
    const v = viewOf(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', '盗匪们'],
        ['伤害', '盗匪甲 HP 40→22；盗匪乙 HP 38→20'],
      ]),
    );
    expect(v.targets.map((t) => [t.name, t.hp?.delta])).toEqual([
      ['盗匪甲', -18],
      ['盗匪乙', -18],
    ]);
  });

  it('`|波及|HP -10|` 不造出名叫「波及」的目标', () => {
    const v = viewOf(
      sheet('出手 · 火球术', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['波及', 'HP -10'],
      ]),
    );
    expect(v.targets.map((t) => t.name)).toEqual(['灰狼']);
  });
});
