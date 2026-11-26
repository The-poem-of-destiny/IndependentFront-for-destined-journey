/**
 * ActionStyleBattleLog — 战报行
 *
 * 守的是：一行一件事 —— 交锋的「使出了」/ 逐目标受到伤害或恢复生命 / 失手 / 状态 / 自身消耗，
 * 行尾 HP 起止；名册的单位读数；结算（制作与检定）的尝试 / 掷骰 / 结论 / 产物 / 经验；
 * 交错序号封顶 `BATTLELOG_STAGGER_LINES` 行（entrance-timing.ts）。
 * 五种样式共有的契约（kind 类、通用面板、名册标题与名字、入场类、展开提示、不走 v-html、A4 状态）
 * 在 action-style-shared.test.ts。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionStyleBattleLog from '../../../../../src/ui/components/game/action-panel/ActionStyleBattleLog.vue';
import { BATTLELOG_STAGGER_LINES } from '../../../../../src/ui/components/game/action-panel/entrance-timing';
import {
  ASSET_STUB,
  EXCHANGE,
  EXCHANGE_MISS,
  OUTCOME,
  ROSTER,
  SETTLE,
  sheet,
  viewOf,
} from './fixtures';

function mountLog(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
  return mount(ActionStyleBattleLog, {
    props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
    global: { stubs: ASSET_STUB },
  });
}

/** 一行的正文（不含行尾小字） */
function lineText(w: ReturnType<typeof mountLog>, sel: string): string {
  return w.find(`${sel} .bl-tx`).text();
}

const HEAL = sheet('出手 · 愈光', [
  ['行动者', '莉娅'],
  ['目标', '艾琳'],
  ['行动', '愈光'],
  ['判定', '成功'],
  ['变更', '艾琳 HP 40→58'],
  ['变更', '莉娅 MP 46→36'],
]);

const CHECK = sheet('检定 · 撬锁', [
  ['行动者', '艾琳'],
  ['行动', '撬锁'],
  ['检定', 'd20=6 +3 → 9 / 难度 12'],
  ['判定', '失败'],
  ['结果', '锁芯纹丝不动'],
]);

describe('ActionStyleBattleLog', () => {
  it('交锋：使出了 → 受到伤害（带结论）→ 状态 → 自身消耗，HP 起止在行尾', () => {
    const w = mountLog(EXCHANGE);
    expect(w.find('.blog').classes()).toContain('k-exchange');
    const lead = w.find('.bl-l.l-use');
    expect(lead.classes()).toContain('lead');
    expect(lead.find('.bl-tx').text()).toBe('艾琳 使出了 裂风斩！');
    const hit = w.find('.bl-l.l-hit');
    expect(hit.find('.bl-tx').text()).toBe('暴击！灰狼 受到 34 点伤害。');
    expect(hit.find('.bl-cry').classes()).toContain('t-ok');
    expect(hit.find('.n').classes()).toContain('down');
    expect(hit.find('.m').text()).toBe('HP 60→26');
    expect(lineText(w, '.bl-l.l-status')).toBe('灰狼 流血(2回合)。');
    const cost = w.find('.bl-l.l-cost');
    expect(cost.classes()).toContain('dim');
    expect(cost.find('.bl-tx').text()).toBe('艾琳 消耗 12 SP。');
    expect(cost.find('.cost').classes()).toContain('r-sp');
    expect(cost.find('.m').text()).toBe('SP 88→76');
    // 顺序：首行、伤害、状态、消耗
    expect(w.findAll('.bl-l').map((l) => l.classes().find((c) => c.startsWith('l-')))).toEqual([
      'l-use',
      'l-hit',
      'l-status',
      'l-cost',
    ]);
  });

  it('交锋多目标：命中的掉血、失手的闪开，结论挂在首行行尾', () => {
    const w = mountLog(EXCHANGE_MISS);
    expect(w.find('.bl-l.l-use .m').text()).toBe('命中 1/2');
    const hits = w.findAll('.bl-l.l-hit');
    expect(hits).toHaveLength(1);
    expect(hits[0].find('.bl-tx').text()).toBe('盗匪甲 受到 21 点伤害。');
    expect(hits[0].find('.bl-cry').exists()).toBe(false);
    const miss = w.find('.bl-l.l-miss');
    expect(miss.find('.bl-tx').text()).toBe('盗匪乙 闪开了攻击。');
    expect(miss.find('.m').text()).toBe('失手');
    expect(miss.classes()).toContain('dim');
  });

  it('治疗：恢复了 N 点生命，数字提亮', () => {
    const w = mountLog(HEAL);
    const heal = w.find('.bl-l.l-heal');
    expect(heal.find('.bl-tx').text()).toBe('成功！艾琳 恢复了 18 点生命。');
    expect(heal.find('.n').classes()).toContain('up');
    expect(heal.find('.m').text()).toBe('HP 40→58');
    expect(lineText(w, '.bl-l.l-cost')).toBe('莉娅 消耗 10 MP。');
  });

  it('名册：每个单位一行三格读数，缺的资源留空格子', () => {
    const w = mountLog(ROSTER);
    const units = w.findAll('.bl-l.l-unit');
    expect(units[0].findAll('.c .rl').map((r) => r.text())).toEqual(['HP', 'MP', 'SP']);
    expect(units[0].find('.c').text()).toBe('HP69/96');
    // 缺的资源留空格子，列对齐不乱
    expect(units[1].findAll('.c')).toHaveLength(3);
    expect(units[1].findAll('.c .rl').map((r) => r.text())).toEqual(['HP', 'SP']);
  });

  it('结算 · 制作：尝试 → 掷骰 → 结论 + 产物（品质色）→ 经验 → 消耗', () => {
    const w = mountLog(OUTCOME);
    expect(w.find('.blog').classes()).toContain('k-outcome');
    expect(w.find('.bl-l.l-try').classes()).toContain('lead');
    expect(lineText(w, '.bl-l.l-roll')).toContain('d100=31');
    const result = w.find('.bl-l.l-result');
    expect(result.find('.bl-tx').text()).toContain('获得 精钢短剑（稀有）。');
    expect(result.find('.bl-prod').attributes('style')).toContain('--qc: var(--theme-quality-');
    expect(lineText(w, '.bl-l.l-exp')).toBe('获得 45 点经验。');
    expect(w.find('.bl-l.l-cost .m').text()).toBe('SP 76→61');
  });

  it('结算 · 检定：失败结论喊出来，接结果句', () => {
    const w = mountLog(CHECK);
    expect(w.find('.blog').classes()).toContain('k-outcome');
    expect(lineText(w, '.bl-l.l-try')).toBe('艾琳 尝试 撬锁……');
    expect(lineText(w, '.bl-l.l-roll')).toContain('d20=6');
    const result = w.find('.bl-l.l-result');
    expect(result.find('.bl-tx').text()).toBe('失败！锁芯纹丝不动。');
    expect(result.find('.bl-cry').classes()).toContain('t-bad');
  });

  it('交错序号封顶第 BATTLELOG_STAGGER_LINES 行', () => {
    const many = sheet(
      '出手 · 连环',
      [
        ['行动者', '艾琳'],
        ['目标', '甲、乙、丙、丁、戊、己、庚'],
        ['行动', '连环斩'],
      ].concat(
        ['甲', '乙', '丙', '丁', '戊', '己', '庚'].map((n): [string, string] => [
          '变更',
          `${n} HP 20→10`,
        ]),
      ) as Array<[string, string]>,
    );
    const lines = mountLog(many, { entering: true }).findAll('.bl-l');
    expect(lines.length).toBe(8);
    expect(lines[0].attributes('style')).toContain('--i: 0');
    expect(lines[7].attributes('style')).toContain(`--i: ${BATTLELOG_STAGGER_LINES - 1}`);
    const longer = mountLog(
      sheet('出手 · 连环', [
        ['行动者', '艾琳'],
        ['目标', '甲、乙、丙、丁、戊、己、庚、辛、壬'],
        ['行动', '连环斩'],
        ...['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'].map((n): [string, string] => [
          '变更',
          `${n} HP 20→10`,
        ]),
      ]),
      { entering: true },
    ).findAll('.bl-l');
    expect(longer.length).toBe(10);
    expect(longer[9].attributes('style')).toContain(`--i: ${BATTLELOG_STAGGER_LINES - 1}`);
  });

  it('自我治疗：正的自身变化写「恢复了」（增益色），负的才写「消耗」', () => {
    const w = mountLog(
      sheet('施术 · 自愈', [
        ['行动者', '艾琳'],
        ['目标', '无'],
        ['行动', '自愈'],
        ['变更', '艾琳 HP 50→70'],
        ['变更', '艾琳 MP 40→30'],
      ]),
    );
    const gain = w.find('.bl-l.l-gain');
    expect(gain.find('.bl-tx').text()).toBe('艾琳 恢复了 20 点 HP。');
    expect(gain.find('.n').classes()).toContain('up');
    expect(gain.find('.m').text()).toBe('HP 50→70');
    const cost = w.findAll('.bl-l.l-cost');
    expect(cost).toHaveLength(1);
    expect(cost[0].find('.bl-tx').text()).toBe('艾琳 消耗 10 MP。');
    expect(w.text()).not.toContain('消耗 20');
  });

  it('`|目标|自身|` 与 `|目标|行动者|` 同样按自身变化写', () => {
    for (const target of ['自身', '艾琳']) {
      const w = mountLog(
        sheet('施术 · 自愈', [
          ['行动者', '艾琳'],
          ['目标', target],
          ['变更', '艾琳 HP 50→70'],
        ]),
      );
      expect(w.find('.bl-l.l-gain .bl-tx').text()).toBe('艾琳 恢复了 20 点 HP。');
      expect(w.find('.bl-l.l-hit').exists()).toBe(false);
      expect(w.find('.bl-l.l-heal').exists()).toBe(false);
    }
  });

  it('目标没有数字、没有状态也不是失手：写一行「受到影响」，不让它消失', () => {
    const w = mountLog(
      sheet('出手 · 威吓', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['行动', '威吓'],
      ]),
    );
    const line = w.find('.bl-l.l-touched');
    expect(line.find('.bl-tx').text()).toBe('灰狼 受到影响。');
    expect(line.classes()).toContain('dim');
  });

  it('目标有状态时不另写「受到影响」，状态行就是它的那一行', () => {
    const w = mountLog(
      sheet('出手 · 威吓', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['行动', '威吓'],
        ['状态', '灰狼 获得 畏惧(1回合)'],
      ]),
    );
    expect(w.find('.bl-l.l-touched').exists()).toBe(false);
    expect(w.find('.bl-l.l-status .bl-tx').text()).toBe('灰狼 畏惧(1回合)。');
  });

  it('结算（A4）：多人状态结算逐人一行资源变化', () => {
    const w = mountLog(SETTLE);
    const deltas = w.findAll('.bl-l.l-delta');
    expect(deltas.map((l) => l.find('.bl-tx').text().replace(/\s+/g, ' '))).toEqual([
      '莱恩 的 HP 减少 5 点。',
      '灰狼 的 HP 减少 5 点。',
    ]);
    expect(deltas.map((l) => l.find('.m').text())).toEqual(['HP 80→75', 'HP 45→40']);
  });
});
