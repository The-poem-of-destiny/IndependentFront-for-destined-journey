/**
 * ActionStyleCard — 打出的牌
 *
 * 守的是：四种 kind 各画一张牌 —— 费用宝石（自身第一笔消耗 / 无费）、牌名与类型线、一句牌面效果、
 * 目标小牌（HP 变化 / 失手 / 无证据）、角上的结论绶带；名册是一排单位小牌；结算的产物品质色、
 * 经验与检定骰小牌；通用面板的牌面句子。
 * 五种样式共有的契约（kind 类、通用面板、名册标题与名字、入场类、展开提示、不走 v-html、A4 状态）
 * 在 action-style-shared.test.ts。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionStyleCard from '../../../../../src/ui/components/game/action-panel/ActionStyleCard.vue';
import {
  ASSET_STUB,
  EXCHANGE,
  EXCHANGE_MISS,
  GENERIC,
  OUTCOME,
  ROSTER,
  SETTLE,
  sheet,
  viewOf,
} from './fixtures';

function mountCard(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
  return mount(ActionStyleCard, {
    props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
    global: { stubs: ASSET_STUB },
  });
}

/** 单体治疗 */
const HEAL = sheet('施术 · 晨露祷言', [
  ['行动者', '塞拉'],
  ['目标', '艾琳'],
  ['行动', '晨露祷言'],
  ['判定', '成功'],
  ['变更', '艾琳 HP 41→69'],
  ['变更', '塞拉 MP 55→43'],
]);

/** 三目标：命中 / 失手 / 只挂了状态（无证据） */
const EXCHANGE_MIXED = sheet('出手 · 霜环术', [
  ['行动者', '莉娅'],
  ['目标', '盗匪甲、盗匪乙、盗匪头目'],
  ['行动', '霜环术'],
  ['盗匪甲', 'd20=15 +6 → 21 / 抗性 12 命中'],
  ['盗匪乙', 'd20=4 +6 → 10 / 抗性 12 失手'],
  ['判定', '命中 1/3'],
  ['变更', '盗匪甲 HP 48→27'],
  ['变更', '莉娅 MP 64→46'],
  ['状态', '盗匪头目 获得 迟缓(1回合)'],
]);

/** 检定失败：行动者行但无目标 —— 视图改判 outcome，没有产物 */
const CHECK = sheet('技能检定 · 撬锁', [
  ['行动者', '艾琳'],
  ['行动', '撬锁'],
  ['检定', 'd20=6 +敏捷5 → 11 / 难度 15'],
  ['判定', '失败'],
  ['结果', '锁芯卡死，没能打开'],
]);

describe('ActionStyleCard', () => {
  it('交锋：宝石是自身消耗，牌名 / 类型线 / 牌面效果 / 绶带 / 目标小牌', () => {
    const w = mountCard(EXCHANGE);
    expect(w.find('.cardx').classes()).toEqual(expect.arrayContaining(['k-exchange', 'has-rib']));
    const gem = w.find('.c10-gem');
    expect(gem.classes()).toContain('r-sp');
    expect(gem.find('.c10-gem-n').text()).toBe('12');
    expect(gem.find('.c10-gem-l').text()).toBe('SP');
    expect(w.find('.c10-name').text()).toBe('裂风斩');
    expect(w.find('.c10-ty').text()).toBe('攻击 · 单体 · 艾琳');
    const tx = w.find('.c10-tx');
    expect(tx.text()).toContain('对 灰狼 造成 34 点伤害');
    expect(tx.find('.c10-n').classes()).toContain('down');
    expect(tx.find('.c10-st').text()).toBe('灰狼 获得 流血(2回合)。');
    const rib = w.find('.c10-rib');
    expect(rib.text()).toBe('暴击');
    expect(rib.classes()).toContain('t-ok');
    const units = w.findAll('.c10-tg .c10-u');
    expect(units).toHaveLength(1);
    expect(units[0].find('.nm').text()).toBe('灰狼');
    expect(units[0].find('.c10-dv').text()).toBe('−34');
    expect(units[0].find('.c10-dv').classes()).toContain('down');
    expect(units[0].find('.gbar').attributes('data-dir')).toBe('down');
    expect(units[0].find('.c10-hp').text()).toBe('26/60');
    expect(w.findAll('.am-stub').map((n) => n.attributes('data-name'))).toEqual(['灰狼']);
  });

  it('交锋：群体 · 失手的目标写「闪开」与「失手」，不写数字', () => {
    const w = mountCard(EXCHANGE_MISS);
    expect(w.find('.c10-ty').text()).toBe('攻击 · 群体 · 莉娅');
    expect(w.find('.c10-gem-n').text()).toBe('18');
    expect(w.find('.c10-gem').classes()).toContain('r-mp');
    expect(w.find('.c10-tx').text()).toContain('盗匪乙 闪开');
    const units = w.findAll('.c10-tg .c10-u');
    expect(units).toHaveLength(2);
    expect(units[0].find('.c10-dv').text()).toBe('−21');
    expect(units[1].classes()).toContain('is-miss');
    expect(units[1].find('.c10-dv').text()).toBe('失手');
    expect(units[1].find('.gbar').exists()).toBe(false);
  });

  it('交锋：多目标里命中 / 失手 / 无证据各有写法，状态归到目标名下', () => {
    const view = viewOf(EXCHANGE_MIXED);
    expect(view.targets.map((t) => t.hit)).toEqual(['hit', 'miss', 'unknown']);
    const w = mountCard(EXCHANGE_MIXED);
    const units = w.findAll('.c10-tg .c10-u');
    expect(units.map((u) => u.find('.c10-dv').text())).toEqual(['−21', '失手', '—']);
    expect(units[2].classes()).not.toContain('is-miss');
    const tx = w.find('.c10-tx').text();
    expect(tx).toContain('作用于 盗匪头目');
    expect(tx).toContain('盗匪头目 获得 迟缓(1回合)。');
    expect(w.find('.c10-rib').text()).toBe('命中 1/3');
  });

  it('治疗：类型线写「治疗」，牌面写恢复，小牌的变化是回升', () => {
    const w = mountCard(HEAL);
    expect(w.find('.c10-ty').text()).toBe('治疗 · 单体 · 塞拉');
    expect(w.find('.c10-tx').text()).toContain('为 艾琳 恢复 28 点生命');
    expect(w.find('.c10-n').classes()).toContain('up');
    const unit = w.find('.c10-tg .c10-u');
    expect(unit.find('.c10-dv').text()).toBe('+28');
    expect(unit.find('.c10-dv').classes()).toContain('up');
    expect(unit.find('.gbar').attributes('data-dir')).toBe('up');
  });

  it('自我治疗：回升不是费用 —— 宝石取那笔 MP 消耗，类型线写「治疗 · 自身」，牌面写恢复', () => {
    const w = mountCard(
      sheet('施术 · 自愈', [
        ['行动者', '艾琳'],
        ['目标', '无'],
        ['行动', '自愈'],
        ['变更', '艾琳 HP 50→70'],
        ['变更', '艾琳 MP 40→30'],
      ]),
    );
    const gem = w.find('.c10-gem');
    expect(gem.classes()).toContain('r-mp');
    expect(gem.find('.c10-gem-n').text()).toBe('10');
    expect(gem.find('.c10-gem-l').text()).toBe('MP');
    expect(w.find('.c10-ty').text()).toBe('治疗 · 自身 · 艾琳');
    const tx = w.find('.c10-tx');
    expect(tx.text()).toContain('为 艾琳 恢复 20 点生命');
    expect(tx.find('.c10-n').classes()).toContain('up');
  });

  it('只有回升的自身变化时宝石写「无费」，回升进牌面', () => {
    const w = mountCard(
      sheet('施术 · 调息', [
        ['行动者', '艾琳'],
        ['行动', '调息'],
        ['变更', '艾琳 SP 20→50'],
      ]),
    );
    expect(w.find('.c10-gem-l').text()).toBe('无费');
    expect(w.find('.c10-gem').classes()).toContain('is-free');
    expect(w.text()).toContain('为 艾琳 恢复 30 点 SP');
  });

  it('目标的非 HP 变化：牌面写削减，小牌主变化写 MP，其余资源写小字；自身第二笔消耗也写出', () => {
    const w = mountCard(
      sheet('出手 · 法力灼烧', [
        ['行动者', '莉娅'],
        ['目标', '巫妖'],
        ['行动', '法力灼烧'],
        ['变更', '巫妖 MP 80→50'],
        ['变更', '巫妖 SP 30→25'],
        ['变更', '莉娅 MP 64→46'],
        ['变更', '莉娅 SP 30→25'],
      ]),
    );
    expect(w.find('.c10-gem-n').text()).toBe('18');
    const tx = w.find('.c10-tx').text();
    expect(tx).toContain('对 巫妖 削减 30 点 MP');
    expect(tx).toContain('对 巫妖 削减 5 点 SP');
    expect(tx).toContain('莉娅 额外消耗 5 点 SP');
    expect(tx).not.toContain('作用于');
    const unit = w.find('.c10-tg .c10-u');
    expect(unit.find('.c10-dv').text()).toBe('MP −30');
    expect(unit.find('.c10-dv').classes()).toEqual(expect.arrayContaining(['down', 'r-mp']));
    expect(unit.find('.c10-hp').text()).toBe('50/80');
    expect(unit.findAll('.c10-mini').map((m) => m.text())).toEqual(['SP −5']);
  });

  it('名册：无宝石与绶带，「场面」类型线，每个单位一张小牌（HP 条 + 读数）', () => {
    const w = mountCard(ROSTER);
    expect(w.find('.c10-gem').exists()).toBe(false);
    expect(w.find('.c10-rib').exists()).toBe(false);
    expect(w.find('.c10-ty').text()).toContain('场面 · 夜雨 · 林道');
    const units = w.findAll('.c10-board .c10-u');
    expect(units[0].findAll('.gbar')).toHaveLength(1);
    expect(units[0].findAll('.c10-sv').map((n) => n.text())).toEqual(['69/96', '20/40', '76/110']);
    expect(units[1].findAll('.c10-sv')).toHaveLength(2);
  });

  it('结算 · 制作：牌名是产物（品质色），类型线带品质，牌面是结果与经验，检定骰小牌', () => {
    const w = mountCard(OUTCOME);
    expect(w.find('.cardx').classes()).toContain('k-outcome');
    const name = w.find('.c10-prod');
    expect(name.text()).toBe('精钢短剑');
    expect(name.attributes('style')).toContain('--qc: var(--theme-quality-');
    expect(w.find('.c10-ty').text()).toContain('稀有');
    expect(w.find('.c10-ty').text()).toContain('艾琳');
    expect(w.find('.c10-gem-n').text()).toBe('15');
    const tx = w.find('.c10-tx').text();
    expect(tx).toContain('锻成一柄稀有品质的精钢短剑。');
    expect(tx).toContain('经验 +45');
    const die = w.find('.c10-check .c10-die');
    expect(die.find('.c10-die-v').text()).toBe('31');
    expect(die.find('.c10-die-l').text()).toBe('d100');
  });

  it('结算 · 检定：无产物时牌名是动作，类型线写「检定」，失败绶带标红', () => {
    const view = viewOf(CHECK);
    expect(view.kind).toBe('outcome');
    const w = mountCard(CHECK);
    expect(w.find('.c10-prod').exists()).toBe(false);
    expect(w.find('.c10-name').text()).toBe('撬锁');
    expect(w.find('.c10-ty').text()).toBe('检定 · 艾琳');
    expect(w.find('.c10-gem-l').text()).toBe('无费');
    expect(w.find('.c10-gem').classes()).toContain('is-free');
    expect(w.find('.c10-tx').text()).toContain('锁芯卡死，没能打开');
    const rib = w.find('.c10-rib');
    expect(rib.text()).toBe('失败');
    expect(rib.classes()).toContain('t-bad');
    expect(w.find('.c10-die').classes()).toContain('t-bad');
    expect(w.find('.c10-check .c10-hp').text()).toContain('15');
  });

  it('通用：类型线写「行动详情」，没有目标小牌', () => {
    const w = mountCard(GENERIC);
    expect(w.find('.c10-ty').text()).toBe('行动详情');
    expect(w.find('.c10-tg').exists()).toBe(false);
  });

  it('入场：目标小牌的资源条跟着播', () => {
    expect(mountCard(EXCHANGE).find('.gbar.is-animate').exists()).toBe(false);
    expect(mountCard(EXCHANGE, { entering: true }).find('.gbar.is-animate').exists()).toBe(true);
  });

  it('`|目标|自身|` / `|目标|行动者|`：类型线写「自身」，宝石取 MP 消耗', () => {
    for (const target of ['自身', '艾琳']) {
      const w = mountCard(
        sheet('施术 · 自愈', [
          ['行动者', '艾琳'],
          ['目标', target],
          ['行动', '自愈'],
          ['变更', '艾琳 HP 50→70'],
          ['变更', '艾琳 MP 40→30'],
        ]),
      );
      expect(w.find('.c10-ty').text()).toBe('治疗 · 自身 · 艾琳');
      const gem = w.find('.c10-gem');
      expect(gem.classes()).toContain('r-mp');
      expect(gem.find('.c10-gem-n').text()).toBe('10');
    }
  });

  it('结算（A4）：多人状态结算在牌面逐人写出资源变化', () => {
    const w = mountCard(SETTLE);
    const settle = w.findAll('.c10-tx .c10-settle');
    expect(settle.map((s) => s.text().replace(/\s+/g, ' '))).toEqual([
      '莱恩 失去 5 点 HP。',
      '灰狼 失去 5 点 HP。',
    ]);
    expect(settle[0].find('.c10-n').classes()).toContain('down');
  });
});
