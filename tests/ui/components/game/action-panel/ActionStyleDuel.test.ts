/**
 * ActionStyleDuel — 对决条
 *
 * 守的是对决条自己的画法：交锋的行动者 / 自身消耗 / 招式 / 结论印 / 逐目标 HP 与失手 / 状态，
 * 名册单位的三条资源条与读数，结算的产物品质色、经验、消耗与检定骰，多人结算逐人的资源变化。
 * 五种样式共有的契约（kind 类、通用面板、名册标题与名字、入场类、展开提示、不走 v-html、A4 状态）
 * 在 action-style-shared.test.ts。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionStyleDuel from '../../../../../src/ui/components/game/action-panel/ActionStyleDuel.vue';
import { STAGGER_INDEX_MAX } from '../../../../../src/ui/components/game/action-panel/entrance-timing';
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

function mountDuel(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
  return mount(ActionStyleDuel, {
    props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
    global: { stubs: ASSET_STUB },
  });
}

describe('ActionStyleDuel', () => {
  it('交锋：行动者 + 自身消耗、招式与结论印、目标 HP 变化、状态脚注', () => {
    const w = mountDuel(EXCHANGE);
    expect(w.find('.duel').classes()).toContain('k-exchange');
    expect(w.find('.d1-a .nm').text()).toBe('艾琳');
    const own = w.find('.d1-a .sub');
    expect(own.classes()).toEqual(expect.arrayContaining(['cost', 'r-sp']));
    expect(own.text()).toContain('−12');
    expect(own.text()).toContain('88→76');
    expect(w.find('.d1-act').text()).toBe('裂风斩');
    const seal = w.find('.d1-seal');
    expect(seal.text()).toBe('暴击');
    expect(seal.classes()).toContain('t-ok');
    const row = w.find('.d1-row');
    expect(row.find('.nm').text()).toBe('灰狼');
    expect(row.find('.big').text()).toBe('−34');
    expect(row.find('.big').classes()).toContain('down');
    expect(row.find('.rng').text()).toContain('60→26');
    expect(w.find('.d1-st').text()).toBe('灰狼 流血(2回合)');
    // 头像位：行动者与目标各一枚，替身拿到名字、插槽里是首字
    expect(w.findAll('.am-stub').map((n) => n.attributes('data-name'))).toEqual(['艾琳', '灰狼']);
    expect(w.find('.bdg-ini').text()).toBe('艾');
  });

  it('交锋：自身消耗的变化量与起止之间有空格（渲染文本形如「SP −12 88→76」）', () => {
    const w = mountDuel(EXCHANGE);
    expect(w.find('.d1-a .sub').text().replace(/\s+/g, ' ')).toBe('SP −12 88→76');
  });

  it('交锋：目标的非 HP 变化逐条写出（法力灼烧不再是「—」），自身多笔消耗都在', () => {
    const w = mountDuel(
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
    const row = w.find('.d1-row');
    expect(row.find('.big').exists()).toBe(false);
    const minis = row.findAll('.d1-mini');
    expect(minis.map((m) => m.text().replace(/\s+/g, ' '))).toEqual([
      'MP −30 80→50',
      'SP −5 30→25',
    ]);
    expect(minis[0].classes()).toEqual(expect.arrayContaining(['down', 'r-mp']));
    expect(w.findAll('.d1-a .sub').map((s) => s.text().replace(/\s+/g, ' '))).toEqual([
      'MP −18 64→46',
      'SP −5 30→25',
    ]);
  });

  it('交锋：HP 之外还有别的资源时，HP 大字下面再写小字', () => {
    const w = mountDuel(
      sheet('出手 · 吸魂', [
        ['行动者', '莉娅'],
        ['目标', '巫妖'],
        ['变更', '巫妖 HP 90→70'],
        ['变更', '巫妖 MP 40→55'],
      ]),
    );
    const row = w.find('.d1-row');
    expect(row.find('.big').text()).toBe('−20');
    const mini = row.find('.d1-mini');
    expect(mini.text().replace(/\s+/g, ' ')).toBe('MP +15 40→55');
    expect(mini.classes()).toContain('up');
  });

  it('目标很多时交错下标封顶', () => {
    const names = Array.from({ length: 9 }, (_, i) => `喽啰${i + 1}`);
    const w = mountDuel(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', names.join('、')],
      ]),
    );
    const rows = w.findAll('.d1-row');
    expect(rows).toHaveLength(9);
    expect(rows[8].attributes('style')).toContain(`--i: ${STAGGER_INDEX_MAX}`);
  });

  it('交锋：失手的目标写「失手」不写数字', () => {
    const w = mountDuel(EXCHANGE_MISS);
    const rows = w.findAll('.d1-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.big').text()).toBe('−21');
    expect(rows[1].find('.big').text()).toBe('失手');
    expect(rows[1].find('.big').classes()).toContain('miss');
  });

  it('名册：每个单位的资源条与读数', () => {
    const w = mountDuel(ROSTER);
    const units = w.findAll('.d1-u');
    expect(units[0].findAll('.gbar')).toHaveLength(3);
    expect(units[0].find('.n').text()).toBe('69/96');
    expect(units[1].findAll('.gbar')).toHaveLength(2);
  });

  it('结算：产物带品质色、结论印、结果句；脚注是经验 / 消耗 / 检定骰', () => {
    const w = mountDuel(OUTCOME);
    expect(w.find('.duel').classes()).toContain('k-outcome');
    const product = w.find('.d1-prod');
    expect(product.text()).toBe('精钢短剑');
    expect(product.attributes('style')).toContain('--qc: var(--theme-quality-');
    expect(w.find('.d1-out .txt').text()).toBe('锻成一柄稀有品质的精钢短剑');
    const foot = w.find('.d1-f');
    expect(foot.text()).toContain('经验 +45');
    expect(foot.find('.d1-cost').text()).toBe('SP −15');
    expect(foot.text()).toContain('d100=31');
  });

  it('自身变化着色：回升用增益色，消耗用资源色', () => {
    const w = mountDuel(
      sheet('施术 · 自愈', [
        ['行动者', '艾琳'],
        ['目标', '无'],
        ['行动', '自愈'],
        ['变更', '艾琳 HP 50→70'],
        ['变更', '艾琳 MP 40→30'],
      ]),
    );
    const subs = w.findAll('.d1-a .sub');
    expect(subs).toHaveLength(2);
    expect(subs[0].classes()).toEqual(expect.arrayContaining(['up', 'r-hp']));
    expect(subs[0].classes()).not.toContain('cost');
    expect(subs[1].classes()).toEqual(expect.arrayContaining(['cost', 'r-mp']));
  });

  it('结算（A4）：多人状态结算逐人列出资源变化', () => {
    const w = mountDuel(SETTLE);
    const who = w.findAll('.d1-f .d1-who');
    expect(who.map((s) => s.text().replace(/\s+/g, ' '))).toEqual([
      '莱恩 HP −5 80→75',
      '灰狼 HP −5 45→40',
    ]);
    expect(who[0].classes()).toEqual(expect.arrayContaining(['down', 'r-hp']));
  });
});
