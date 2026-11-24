/**
 * ActionStyleAfterimage — 血条残影
 *
 * 守的是：每个受影响的人一条资源条 —— 下降段是斜纹残影、回升段提亮、失手 / 看不出的目标画虚线槽；
 * 出手方消耗排在目标之后；结算的 d20 对抗检定画成刻度（DC 刻线 + 落点），制作类画产物与品质格；
 * 名册是 HP 主条 + MP / SP 小条；通用面板是前三个关键格；
 * 盖片与入场类只在 `entering` 时出现；展开提示随 `open` 换字；全程文本插值。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionStyleAfterimage from '../../../../../src/ui/components/game/action-panel/ActionStyleAfterimage.vue';
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

function mountAfterimage(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
  return mount(ActionStyleAfterimage, {
    props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
    global: { stubs: ASSET_STUB },
  });
}

/** 三个目标：命中 / 失手 / 只挂了增益（看不出打没打中） */
const EXCHANGE_THREE = sheet('出手 · 霜环术', [
  ['行动者', '莉娅'],
  ['目标', '盗匪甲、盗匪乙、盗匪丙'],
  ['行动', '霜环术'],
  ['盗匪甲', 'd20=15 +6 → 21 / 抗性 12 命中'],
  ['盗匪乙', 'd20=4 +6 → 10 / 抗性 12 失手'],
  ['判定', '命中 1/3'],
  ['变更', '盗匪甲 HP 48→27'],
  ['变更', '莉娅 MP 64→46'],
]);

/** 治疗：目标 HP 回升，出手方 MP 消耗 */
const HEAL = sheet('施法 · 愈合之光', [
  ['行动者', '塞拉'],
  ['目标', '艾琳'],
  ['行动', '愈合之光'],
  ['判定', '成功'],
  ['变更', '艾琳 HP 40→70'],
  ['变更', '塞拉 MP 50→38'],
]);

/** ⑥ 技能检定 · 失败（d20 对 DC） */
const CHECK = sheet('检定 · 撬开铁匣', [
  ['行动者', '艾琳'],
  ['行动', '开锁'],
  ['检定', 'd20=6 +3 → 9 / DC 14'],
  ['判定', '失败'],
  ['结果', '锁芯卡死，撬针折断'],
]);

describe('ActionStyleAfterimage', () => {
  it('交锋单体：头行行动者 ▸ 招式 ▸ 目标 + 结论印；目标残影条与出手方消耗条；状态脚注', () => {
    const w = mountAfterimage(EXCHANGE);
    expect(w.find('.d2').classes()).toContain('k-exchange');
    const head = w.find('.d2-h');
    expect(head.find('.nm').text()).toBe('艾琳');
    expect(head.find('.act').text()).toBe('裂风斩');
    expect(head.find('.d2-tg').text()).toBe('灰狼');
    expect(head.find('.d2-seal').text()).toBe('暴击');
    expect(head.find('.d2-seal').classes()).toContain('t-ok');

    const names = w.findAll('.d2-rows .d2-who');
    expect(names.map((n) => n.text())).toEqual(['灰狼', '艾琳']);
    expect(names[0].classes()).not.toContain('own');
    expect(names[1].classes()).toContain('own');

    const dv = w.findAll('.d2-rows .dv');
    expect(dv[0].text()).toBe('−34');
    expect(dv[0].classes()).toEqual(expect.arrayContaining(['down', 'r-hp']));
    expect(dv[1].text()).toBe('−12');
    expect(dv[1].classes()).toEqual(expect.arrayContaining(['cost', 'r-sp']));

    const gauges = w.findAll('.d2-rows .gbar');
    expect(gauges).toHaveLength(2);
    expect(gauges[0].attributes('data-dir')).toBe('down');
    expect(w.findAll('.d2-rows .rng')[0].text()).toBe('60→26');

    expect(w.find('.d2-st').text()).toBe('灰狼 流血(2回合)');
    expect(w.findAll('.am-stub').map((n) => n.attributes('data-name'))).toEqual(['艾琳']);
  });

  it('交锋多目标：命中的画残影条，失手写「失手」，看不出的写「—」，都留虚线槽', () => {
    const w = mountAfterimage(EXCHANGE_THREE);
    const names = w.findAll('.d2-rows .d2-who').map((n) => n.text());
    expect(names).toEqual(['盗匪甲', '盗匪乙', '盗匪丙', '莉娅']);
    expect(w.find('.d2-tg').text()).toBe('盗匪甲、盗匪乙、盗匪丙');
    expect(w.findAll('.d2-rows .dashed')).toHaveLength(2);
    const dv = w.findAll('.d2-rows .dv').map((n) => n.text());
    expect(dv).toEqual(['−21', '失手', '—', '−18']);
    expect(w.findAll('.d2-rows .dv')[1].classes()).toContain('miss');
  });

  it('交锋：经典两目标样例里失手目标同样是虚线槽', () => {
    const w = mountAfterimage(EXCHANGE_MISS);
    const dv = w.findAll('.d2-rows .dv').map((n) => n.text());
    expect(dv).toEqual(['−21', '失手', '−18']);
  });

  it('治疗：目标的回升段提亮（dir=up、涨色），出手方消耗仍是下降残影', () => {
    const view = viewOf(HEAL);
    expect(view.heal).toBe(true);
    const w = mountAfterimage(HEAL);
    expect(w.find('.d2').classes()).toContain('is-heal');
    const gauges = w.findAll('.d2-rows .gbar');
    expect(gauges.map((g) => g.attributes('data-dir'))).toEqual(['up', 'down']);
    const dv = w.findAll('.d2-rows .dv');
    expect(dv[0].text()).toBe('+30');
    expect(dv[0].classes()).toContain('up');
    expect(dv[1].classes()).toContain('cost');
  });

  it('名册：标题与环境，HP 主条 + MP / SP 小条与读数，集群人数', () => {
    const w = mountAfterimage(ROSTER);
    expect(w.find('.d2').classes()).toContain('k-roster');
    expect(w.find('.d2-h .nm').text()).toBe('第 3 回合 · 战况总览');
    expect(w.find('.d2-note').text()).toContain('夜雨 · 林道');
    const names = w.findAll('.d2-ros .d2-who').map((n) => n.text());
    expect(names).toEqual(['艾琳', '灰狼', '盗匪喽啰2/3']);
    expect(w.findAll('.d2-ros .n').map((n) => n.text())).toEqual(['69/96', '26/72', '27/110']);
    const minis = w.findAll('.d2-ros .mini');
    expect(minis).toHaveLength(6);
    expect(minis[0].text()).toBe('MP 20/40');
    expect(minis[1].text()).toBe('SP 76/110');
    expect(minis[2].text()).toBe('');
    expect(minis[2].find('.gbar').exists()).toBe(false);
    expect(minis[3].text()).toBe('SP 40/60');
  });

  it('结算 · 制作：产物带品质色、品质格点亮到当前档、经验；出手方消耗残影条', () => {
    const view = viewOf(OUTCOME);
    const w = mountAfterimage(OUTCOME);
    expect(w.find('.d2').classes()).toContain('k-outcome');
    expect(w.find('.d2-track').exists()).toBe(false);
    const product = w.find('.d2-prod');
    expect(product.text()).toBe('精钢短剑');
    expect(product.attributes('style')).toContain('--qc: var(--theme-quality-');
    const pips = w.findAll('.d2-pips i');
    expect(pips).toHaveLength(7);
    expect(pips.filter((p) => p.classes().includes('on'))).toHaveLength(
      view.outcome!.qualityRank + 1,
    );
    expect(w.find('.d2-pips').attributes('aria-label')).toBe('品质 稀有');
    expect(w.find('.d2-exp').text()).toBe('经验 +45');
    expect(w.find('.d2-roll').text()).toContain('d100=31');
    const own = w.find('.d2-own');
    expect(own.find('.d2-who').text()).toBe('艾琳');
    expect(own.find('.dv').text()).toBe('−15');
    expect(own.find('.gbar').attributes('data-dir')).toBe('down');
  });

  it('结算 · 检定：d20 对 DC 画成刻度，刻线标签与落点，结果句', () => {
    const view = viewOf(CHECK);
    expect(view.kind).toBe('outcome');
    const w = mountAfterimage(CHECK);
    const track = w.find('.d2-track');
    expect(track.exists()).toBe(true);
    expect(track.classes()).toContain('t-bad');
    expect(track.find('.dc-l').text()).toBe('DC 14');
    expect(track.find('.pt').text()).toBe('9');
    // 刻度是图形：容器不整块藏起，给读屏一句同义文字，图形部件各自 aria-hidden
    expect(track.attributes('aria-hidden')).toBeUndefined();
    expect(track.find('.sr-only').text()).toBe('d20 9 对 DC 14');
    expect(track.find('.dc').attributes('aria-hidden')).toBe('true');
    expect(track.find('.pt').attributes('aria-hidden')).toBe('true');
    const style = track.attributes('style') ?? '';
    expect(style).toContain('--dc: 67.5%');
    expect(style).toContain('--at: 42.5%');
    expect(w.find('.d2-line .txt').text()).toBe('锁芯卡死，撬针折断');
    expect(w.find('.d2-seal').text()).toBe('失败');
  });

  it('通用：标题 + 摘要关键格（至多三个）；无标题显示「行动详情」', () => {
    const view = viewOf(GENERIC);
    const w = mountAfterimage(GENERIC);
    expect(w.find('.d2').classes()).toContain('k-generic');
    expect(w.find('.d2-h .nm').text()).toBe('潜行 · 穿过哨卡');
    expect(view.facts.length).toBeGreaterThan(0);
    expect(w.findAll('.d2-kv-item')).toHaveLength(Math.min(3, view.facts.length));
    expect(w.find('.d2-kv-v').text()).toBe('1d20(13)+4=17');
    expect(mountAfterimage('| 气味 | 潮湿的苔藓 |').find('.d2-h .nm').text()).toBe('行动详情');
  });

  it('入场：entering=false 时没有任何入场类与盖片', () => {
    for (const raw of [EXCHANGE, HEAL, ROSTER, OUTCOME]) {
      const w = mountAfterimage(raw);
      expect(w.find('.d2').classes()).not.toContain('is-entering');
      expect(w.find('.d2-cover').exists()).toBe(false);
      expect(w.find('.gbar.is-animate').exists()).toBe(false);
    }
  });

  it('入场：entering=true 时下降段挂盖片（宽 = 失去的量），回升段不挂；名册资源条跟着播', () => {
    const w = mountAfterimage(EXCHANGE, { entering: true });
    expect(w.find('.d2').classes()).toContain('is-entering');
    const covers = w.findAll('.d2-cover');
    expect(covers).toHaveLength(2);
    // 灰狼 HP 60→26（无上限，以 60 为满）：盖片从 43.3% 起，宽 56.7%
    expect(covers[0].attributes('style')).toContain('left: 43.3%');
    expect(covers[0].attributes('style')).toContain('width: 56.7%');

    const heal = mountAfterimage(HEAL, { entering: true });
    expect(heal.findAll('.d2-cover')).toHaveLength(1);

    expect(mountAfterimage(ROSTER, { entering: true }).find('.gbar.is-animate').exists()).toBe(
      true,
    );
  });

  it('展开提示随 open 换字', () => {
    expect(mountAfterimage(EXCHANGE).find('.more').text()).toBe('算式');
    const opened = mountAfterimage(EXCHANGE, { open: true }).find('.more');
    expect(opened.text()).toBe('收起');
    expect(opened.classes()).toContain('is-open');
  });

  it('不走 v-html：名字与值里的标签按字面显示', () => {
    const w = mountAfterimage(
      sheet('<b>出手</b>', [
        ['行动者', '<script>x</script>'],
        ['目标', '<b>狼</b>'],
        ['变更', '<b>狼</b> HP 10→5'],
      ]),
    );
    expect(w.find('script').exists()).toBe(false);
    expect(w.findAll('b').filter((b) => b.classes().length === 0)).toHaveLength(0);
    expect(w.text()).toContain('<script>x</script>');
    // 目标名原文以字面出现（摘要层对 `/` 的拆分与本组件无关，只看 `<b>` 没被当成标签）
    expect(w.find('.d2-tg').text()).toContain('<b>狼');
    expect(w.find('.d2-h .act').text()).toBe('<b>出手</b>');
  });
});
