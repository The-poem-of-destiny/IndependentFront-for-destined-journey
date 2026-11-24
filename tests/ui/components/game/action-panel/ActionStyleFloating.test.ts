/**
 * ActionStyleFloating — 跳字舞台
 *
 * 守的是：四种 kind 各画各的收起视图 —— 交锋的行动者头顶自身消耗 / 招式箭 / 目标头顶跳字
 * （暴击放大、失手淡写、拿不出证据的目标不写「失手」）/ 单目标结论写在数字下、多目标结论进脚注 / 状态，
 * 回复类的跳字带「+」，名册的单位与 HP 条，结算的大结论字、产物品质色、经验 / 检定骰 / 消耗，
 * 通用面板的前三个关键格；入场类只在 `entering` 时挂上（历史面板静止）；全程文本插值。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionStyleFloating from '../../../../../src/ui/components/game/action-panel/ActionStyleFloating.vue';
import { STAGGER_INDEX_MAX } from '../../../../../src/ui/components/game/action-panel/entrance-timing';
import {
  ASSET_STUB,
  EXCHANGE,
  EXCHANGE_MISS,
  GENERIC,
  OUTCOME,
  ROSTER,
  sheet,
  viewOf,
} from './fixtures';

function mountFloating(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
  return mount(ActionStyleFloating, {
    props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
    global: { stubs: ASSET_STUB },
  });
}

/** 回复类：目标 HP 回升 */
const HEAL = sheet('治疗 · 愈光', [
  ['行动者', '莉娅'],
  ['目标', '艾琳'],
  ['行动', '愈光'],
  ['判定', '成功'],
  ['变更', '艾琳 HP 30→58'],
  ['变更', '莉娅 MP 40→28'],
]);

/** 三个目标：命中 / 失手 / 拿不出证据（只挂了状态） */
const EXCHANGE_UNKNOWN = sheet('出手 · 霜环术', [
  ['行动者', '莉娅'],
  ['目标', '盗匪甲、盗匪乙、盗匪丙'],
  ['行动', '霜环术'],
  ['盗匪甲', 'd20=15 +6 → 21 / 抗性 12 命中'],
  ['盗匪乙', 'd20=4 +6 → 10 / 抗性 12 失手'],
  ['判定', '命中 1/3'],
  ['变更', '盗匪甲 HP 48→27'],
  ['状态', '盗匪丙 获得 冻结(1回合)'],
]);

/** 法力灼烧：目标只有 MP / SP 变化，行动者两笔消耗 */
const MANA_BURN = sheet('出手 · 法力灼烧', [
  ['行动者', '莉娅'],
  ['目标', '巫妖'],
  ['行动', '法力灼烧'],
  ['变更', '巫妖 MP 80→50'],
  ['变更', '巫妖 SP 30→25'],
  ['变更', '莉娅 MP 64→46'],
  ['变更', '莉娅 SP 30→25'],
]);

/** 技能检定失败：没有目标、只有检定与结果句 */
const CHECK = sheet('攀爬 · 断崖', [
  ['行动者', '艾琳'],
  ['行动', '攀爬'],
  ['检定', 'd20=6 +力量3 → 9 / 难度 14'],
  ['判定', '失败'],
  ['结果', '指尖一滑，跌回崖底'],
]);

describe('ActionStyleFloating', () => {
  it('交锋：行动者头顶浮自身消耗、招式箭、暴击跳字带结论、状态进脚注', () => {
    const w = mountFloating(EXCHANGE);
    expect(w.find('.floating').classes()).toContain('k-exchange');
    const actor = w.find('.f8-tk.is-actor');
    expect(actor.find('.nm').text()).toBe('艾琳');
    const cost = actor.find('.f8-fl');
    expect(cost.classes()).toEqual(expect.arrayContaining(['sm', 'cost', 'r-sp']));
    expect(cost.text()).toBe('−12 SP');
    expect(actor.find('.hp').text()).toBe('SP 76');
    expect(w.find('.f8-act').text()).toBe('裂风斩');
    const target = w.find('.f8-tk.is-target');
    expect(target.find('.nm').text()).toBe('灰狼');
    const fl = target.find('.f8-fl');
    expect(fl.classes()).toEqual(expect.arrayContaining(['down', 'crit']));
    // 伤害只写量，结论写在数字下；方向另给读屏一句（不只靠颜色）
    expect(fl.find('.f8-num').text()).toBe('34');
    expect(fl.find('.sr-only').text()).toBe('HP 减少');
    expect(fl.find('.f8-vd').text()).toBe('暴击');
    expect(target.find('.hp').text()).toBe('HP 26');
    // 单目标时脚注不再重复结论
    expect(w.find('.f8-ft .vd').exists()).toBe(false);
    expect(w.findAll('.f8-ft .f8-status').map((s) => s.text())).toEqual(['＋灰狼 流血(2回合)']);
    expect(w.findAll('.am-stub').map((n) => n.attributes('data-name'))).toEqual(['艾琳', '灰狼']);
  });

  it('交锋多目标：失手写淡淡的「失手」，结论进脚注，目标按序错开', () => {
    const w = mountFloating(EXCHANGE_MISS);
    const targets = w.findAll('.f8-tk.is-target');
    expect(targets).toHaveLength(2);
    expect(targets[0].find('.f8-fl .f8-num').text()).toBe('21');
    expect(targets[0].find('.f8-fl').classes()).not.toContain('crit');
    expect(targets[0].find('.f8-vd').exists()).toBe(false);
    const miss = targets[1].find('.f8-fl');
    expect(miss.text()).toBe('失手');
    expect(miss.classes()).toContain('miss');
    expect(targets[1].attributes('style')).toContain('--i: 1');
    expect(w.find('.f8-ft .vd').text()).toBe('命中 1/2');
  });

  it('交锋：拿不出命中证据的目标不写「失手」，头顶浮它的状态', () => {
    const w = mountFloating(EXCHANGE_UNKNOWN);
    const targets = w.findAll('.f8-tk.is-target');
    expect(targets.map((t) => t.find('.nm').text())).toEqual(['盗匪甲', '盗匪乙', '盗匪丙']);
    expect(targets[1].find('.f8-fl').text()).toBe('失手');
    const quiet = targets[2].find('.f8-fl');
    expect(quiet.classes()).not.toContain('miss');
    expect(quiet.classes()).toContain('f8-quiet');
    expect(quiet.text()).toBe('冻结(1回合)');
  });

  it('交锋：既无变化也无状态的目标写「—」', () => {
    const w = mountFloating(
      sheet('出手 · 试探', [
        ['行动者', '艾琳'],
        ['目标', '灰狼'],
        ['行动', '试探'],
      ]),
    );
    const fl = w.find('.f8-tk.is-target .f8-fl');
    expect(fl.text()).toBe('—');
    expect(fl.classes()).toContain('f8-none');
  });

  it('回复：跳字带「+」并提亮', () => {
    const w = mountFloating(HEAL);
    const fl = w.find('.f8-tk.is-target .f8-fl');
    expect(fl.classes()).toContain('up');
    expect(fl.classes()).not.toContain('crit');
    expect(fl.find('.f8-num').text()).toBe('+28');
    expect(fl.find('.f8-vd').text()).toBe('成功');
    expect(fl.find('.sr-only').text()).toBe('HP 增加');
    expect(w.find('.is-actor .f8-fl').text()).toBe('−12 MP');
  });

  it('交锋：目标只有 MP 变化时跳字写 MP，其余资源与自身的第二笔消耗都写出来', () => {
    const w = mountFloating(MANA_BURN);
    const target = w.find('.f8-tk.is-target');
    const fl = target.find('.f8-fl');
    expect(fl.classes()).toEqual(expect.arrayContaining(['f8-res', 'down', 'r-mp']));
    expect(fl.find('.f8-num').text()).toBe('30');
    expect(fl.find('.sr-only').text()).toBe('MP 减少');
    expect(fl.text()).toContain('MP');
    expect(target.find('.hp').text()).toBe('MP 50');
    expect(target.findAll('.f8-sub').map((s) => s.text())).toEqual(['−5 SP']);
    const actor = w.find('.f8-tk.is-actor');
    expect(actor.find('.f8-fl').text()).toBe('−18 MP');
    expect(actor.findAll('.f8-sub').map((s) => s.text())).toEqual(['−5 SP']);
  });

  it('目标很多时交错下标封顶，入场最长一段有上限', () => {
    const names = Array.from({ length: 9 }, (_, i) => `喽啰${i + 1}`);
    const w = mountFloating(
      sheet('出手 · 横扫', [
        ['行动者', '艾琳'],
        ['目标', names.join('、')],
        ['行动', '横扫'],
      ]),
    );
    const styles = w.findAll('.f8-tk.is-target').map((t) => t.attributes('style'));
    expect(styles).toHaveLength(9);
    expect(styles[8]).toContain(`--i: ${STAGGER_INDEX_MAX}`);
  });

  it('名册：标题、每个单位的 HP 条与读数、集群人数', () => {
    const w = mountFloating(ROSTER);
    expect(w.find('.floating').classes()).toContain('k-roster');
    expect(w.find('.f8-title').text()).toBe('第 3 回合 · 战况总览');
    const units = w.findAll('.f8-st.is-roster .f8-tk');
    expect(units.map((u) => u.find('.nm').text())).toEqual(['艾琳', '灰狼', '盗匪喽啰2/3']);
    expect(units[0].findAll('.gbar')).toHaveLength(1);
    expect(units[0].find('.hp').text()).toBe('69/96');
    expect(units[2].find('.hp').text()).toBe('27/110');
    expect(w.find('.f8-fl').exists()).toBe(false);
  });

  it('结算（制作）：大结论字、产物品质色；脚注是经验 / 检定骰 / 消耗', () => {
    const w = mountFloating(OUTCOME);
    expect(w.find('.floating').classes()).toContain('k-outcome');
    expect(w.find('.f8-word-t').text()).toBe('成功');
    expect(w.find('.f8-word').classes()).toContain('t-ok');
    const product = w.find('.f8-prod');
    expect(product.text()).toBe('精钢短剑');
    expect(product.attributes('style')).toContain('--qc: var(--theme-quality-');
    expect(w.find('.f8-info .rng').text()).toBe('稀有');
    const foot = w.find('.f8-ft');
    expect(foot.find('.f8-exp').text()).toBe('+45 经验');
    expect(foot.find('.f8-roll').text()).toContain('d100=31');
    expect(foot.find('.f8-cost').text()).toBe('SP −15');
  });

  it('结算（检定）：失败结论 + 行动者与动作 + 结果句', () => {
    const w = mountFloating(CHECK);
    expect(w.find('.floating').classes()).toContain('k-outcome');
    expect(w.find('.f8-word-t').text()).toBe('失败');
    expect(w.find('.f8-word').classes()).toContain('t-bad');
    expect(w.find('.f8-info .nm').text()).toBe('艾琳');
    expect(w.find('.f8-info').text()).toContain('攀爬');
    expect(w.find('.f8-info .txt').text()).toBe('指尖一滑，跌回崖底');
    expect(w.find('.f8-roll').text()).toContain('d20=6');
  });

  it('通用：标题 + 摘要关键格（至多三个，值在上标签在下）', () => {
    const view = viewOf(GENERIC);
    const w = mountFloating(GENERIC);
    expect(w.find('.floating').classes()).toContain('k-generic');
    expect(w.find('.f8-title').text()).toBe('潜行 · 穿过哨卡');
    expect(view.facts.length).toBeGreaterThan(0);
    expect(w.findAll('.f8-tile')).toHaveLength(Math.min(3, view.facts.length));
    expect(w.find('.f8-tile-v').text()).toBe('1d20(13)+4=17');
    expect(w.find('.f8-tile-l').text()).toBe('潜行');
  });

  it('无标题的通用面板显示「行动详情」', () => {
    expect(mountFloating('| 气味 | 潮湿的苔藓 |').find('.f8-title').text()).toBe('行动详情');
  });

  it('入场类只在 entering 时挂上：历史面板不带任何动画钩子', () => {
    for (const raw of [EXCHANGE, EXCHANGE_MISS, ROSTER, OUTCOME, GENERIC]) {
      const still = mountFloating(raw);
      expect(still.find('.floating').classes()).not.toContain('is-entering');
      expect(still.find('.is-entering').exists()).toBe(false);
      expect(still.find('.gbar.is-animate').exists()).toBe(false);
      expect(mountFloating(raw, { entering: true }).find('.floating').classes()).toContain(
        'is-entering',
      );
    }
    expect(mountFloating(ROSTER, { entering: true }).find('.gbar.is-animate').exists()).toBe(true);
  });

  it('展开提示随 open 换字', () => {
    expect(mountFloating(EXCHANGE).find('.more').text()).toBe('算式');
    const opened = mountFloating(EXCHANGE, { open: true }).find('.more');
    expect(opened.text()).toBe('收起');
    expect(opened.classes()).toContain('is-open');
  });

  it('不走 v-html：名字与值里的标签按字面显示', () => {
    const w = mountFloating(
      sheet('<b>出手</b>', [
        ['行动者', '<script>x</script>'],
        ['目标', '<b>狼</b>'],
        ['变更', '<b>狼</b> HP 10→5'],
      ]),
    );
    expect(w.find('script').exists()).toBe(false);
    expect(w.findAll('b').filter((b) => b.classes().length === 0)).toHaveLength(0);
    expect(w.text()).toContain('<script>x</script>');
    expect(w.find('.f8-act').text()).toBe('<b>出手</b>');
  });

  it('自身变化着色：头顶第一笔是回升时用增益色，其余消耗仍用资源色', () => {
    const w = mountFloating(
      sheet('施术 · 自愈', [
        ['行动者', '艾琳'],
        ['目标', '无'],
        ['行动', '自愈'],
        ['变更', '艾琳 HP 50→70'],
        ['变更', '艾琳 MP 40→30'],
      ]),
    );
    const top = w.find('.f8-tk.is-actor .f8-fl');
    expect(top.text()).toBe('+20 HP');
    expect(top.classes()).toContain('up');
    expect(top.classes()).not.toContain('cost');
    const rest = w.find('.f8-tk.is-actor .f8-sub');
    expect(rest.classes()).toEqual(expect.arrayContaining(['cost', 'r-mp']));
  });
});
