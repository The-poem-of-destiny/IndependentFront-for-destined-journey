/**
 * 行动面板五种收起样式的公共契约（参数化套件）
 *
 * 五种样式（对决条 / 血条残影 / 战报行 / 跳字舞台 / 打出的牌）同吃一份 `{ view, open, entering }`，
 * 下面这些行为对每一种都成立，只是落在各自的类名上：
 *   - 根元素按 kind 挂 `k-*`；
 *   - 通用面板：标题 + 前三个关键格，无标题写「行动详情」；
 *   - 名册：标题（+ 环境）与每个单位的名字（含集群人数）；
 *   - 入场类与资源条动画只在 `entering` 时挂上（历史面板静止）；
 *   - 展开提示随 `open` 换字；
 *   - 全程文本插值，不走 v-html；
 *   - 多人状态结算（A4）判 outcome，状态带归属人名。
 * 各样式自己的画法（残影条、跳字、牌面句子、战报行 ……）留在各自的 `ActionStyle*.test.ts`。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { Component } from 'vue';
import ActionStyleAfterimage from '../../../../../src/ui/components/game/action-panel/ActionStyleAfterimage.vue';
import ActionStyleBattleLog from '../../../../../src/ui/components/game/action-panel/ActionStyleBattleLog.vue';
import ActionStyleCard from '../../../../../src/ui/components/game/action-panel/ActionStyleCard.vue';
import ActionStyleDuel from '../../../../../src/ui/components/game/action-panel/ActionStyleDuel.vue';
import ActionStyleFloating from '../../../../../src/ui/components/game/action-panel/ActionStyleFloating.vue';
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

interface StyleCase {
  name: string;
  component: Component;
  /** 根元素 */
  root: string;
  generic: { title: string; fact: string; value: string };
  roster: { title: string; unitName: string; note?: string; gauges: boolean };
  /** 「不走 v-html」用例里招式 / 牌名所在的元素 */
  action: string;
  /** 多人结算的状态行与它的文字 */
  settleStatus: { sel: string; text: string };
}

const CASES: StyleCase[] = [
  {
    name: 'ActionStyleDuel',
    component: ActionStyleDuel,
    root: '.duel',
    generic: { title: '.d1-head-t', fact: '.d1-kv-item', value: '.d1-kv-v' },
    roster: { title: '.d1-head-t', unitName: '.d1-u .nm', note: '.d1-head small', gauges: true },
    action: '.d1-act',
    settleStatus: { sel: '.d1-f .d1-st', text: '灰狼 流血(1回合)' },
  },
  {
    name: 'ActionStyleAfterimage',
    component: ActionStyleAfterimage,
    root: '.d2',
    generic: { title: '.d2-h .nm', fact: '.d2-kv-item', value: '.d2-kv-v' },
    roster: { title: '.d2-h .nm', unitName: '.d2-ros .d2-who', note: '.d2-note', gauges: true },
    action: '.d2-h .act',
    settleStatus: { sel: '.d2-st', text: '灰狼 流血(1回合)' },
  },
  {
    name: 'ActionStyleBattleLog',
    component: ActionStyleBattleLog,
    root: '.blog',
    generic: { title: '.bl-title', fact: '.bl-l.l-fact', value: '.bl-l.l-fact .m' },
    roster: {
      title: '.bl-l.l-title .bl-title',
      unitName: '.bl-l.l-unit .nm',
      note: '.bl-l.l-title .m',
      gauges: false,
    },
    action: '.bl-act',
    settleStatus: { sel: '.bl-l.l-status .bl-tx', text: '灰狼 流血(1回合)。' },
  },
  {
    name: 'ActionStyleFloating',
    component: ActionStyleFloating,
    root: '.floating',
    generic: { title: '.f8-title', fact: '.f8-tile', value: '.f8-tile-v' },
    roster: { title: '.f8-title', unitName: '.f8-st.is-roster .f8-tk .nm', gauges: true },
    action: '.f8-act',
    settleStatus: { sel: '.f8-ft .f8-status', text: '＋灰狼 流血(1回合)' },
  },
  {
    name: 'ActionStyleCard',
    component: ActionStyleCard,
    root: '.cardx',
    generic: { title: '.c10-name', fact: '.c10-kv', value: '.c10-kv' },
    roster: {
      title: '.c10-name',
      unitName: '.c10-board .c10-u .nm',
      note: '.c10-ty',
      gauges: true,
    },
    action: '.c10-name',
    settleStatus: { sel: '.c10-tx .c10-st', text: '灰狼 获得 流血(1回合)。' },
  },
];

describe.each(CASES)('$name（公共契约）', (c) => {
  function mountStyle(raw: string, extra: { open?: boolean; entering?: boolean } = {}) {
    return mount(c.component, {
      props: { view: viewOf(raw), open: extra.open ?? false, entering: extra.entering ?? false },
      global: { stubs: ASSET_STUB },
    });
  }

  it('根元素按 kind 挂 k-* 类（多人状态结算判 outcome）', () => {
    const cases: Array<[string, string]> = [
      [EXCHANGE, 'k-exchange'],
      [EXCHANGE_MISS, 'k-exchange'],
      [ROSTER, 'k-roster'],
      [OUTCOME, 'k-outcome'],
      [SETTLE, 'k-outcome'],
      [GENERIC, 'k-generic'],
    ];
    for (const [raw, cls] of cases) {
      expect(mountStyle(raw).find(c.root).classes(), cls).toContain(cls);
    }
  });

  it('通用：标题 + 摘要关键格（至多三个），首格的值照写', () => {
    const view = viewOf(GENERIC);
    expect(view.facts.length).toBeGreaterThan(0);
    const w = mountStyle(GENERIC);
    expect(w.find(c.generic.title).text()).toBe('潜行 · 穿过哨卡');
    expect(w.findAll(c.generic.fact)).toHaveLength(Math.min(3, view.facts.length));
    expect(w.find(c.generic.value).text()).toBe('1d20(13)+4=17');
  });

  it('无标题的通用面板显示「行动详情」', () => {
    expect(mountStyle('| 气味 | 潮湿的苔藓 |').find(c.generic.title).text()).toBe('行动详情');
  });

  it('名册：标题（与环境）、每个单位的名字带集群人数', () => {
    const w = mountStyle(ROSTER);
    expect(w.find(c.roster.title).text()).toBe('第 3 回合 · 战况总览');
    if (c.roster.note) expect(w.find(c.roster.note).text()).toContain('夜雨 · 林道');
    expect(w.findAll(c.roster.unitName).map((n) => n.text())).toEqual([
      '艾琳',
      '灰狼',
      '盗匪喽啰2/3',
    ]);
  });

  it('入场类只在 entering 时挂上：历史面板不带任何动画钩子', () => {
    for (const raw of [EXCHANGE, EXCHANGE_MISS, ROSTER, OUTCOME, GENERIC]) {
      const still = mountStyle(raw);
      expect(still.find(c.root).classes()).not.toContain('is-entering');
      expect(still.find('.is-entering').exists()).toBe(false);
      expect(still.find('.gbar.is-animate').exists()).toBe(false);
      expect(mountStyle(raw, { entering: true }).find(c.root).classes()).toContain('is-entering');
    }
  });

  // 战报行的名册是纯文字读数，没有资源条
  if (c.roster.gauges) {
    it('名册的资源条跟着入场播放', () => {
      expect(mountStyle(ROSTER).find('.gbar.is-animate').exists()).toBe(false);
      expect(mountStyle(ROSTER, { entering: true }).find('.gbar.is-animate').exists()).toBe(true);
    });
  }

  it('展开提示随 open 换字', () => {
    expect(mountStyle(EXCHANGE).find('.more').text()).toBe('算式');
    const opened = mountStyle(EXCHANGE, { open: true }).find('.more');
    expect(opened.text()).toBe('收起');
    expect(opened.classes()).toContain('is-open');
  });

  it('不走 v-html：名字与值里的标签按字面显示', () => {
    const w = mountStyle(
      sheet('<b>出手</b>', [
        ['行动者', '<script>x</script>'],
        ['目标', '<b>狼</b>'],
        ['变更', '<b>狼</b> HP 10→5'],
      ]),
    );
    expect(w.find('script').exists()).toBe(false);
    // 组件自己的 <b> 都带类名；原文里的 <b> 不该变成元素
    expect(w.findAll('b').filter((b) => b.classes().length === 0)).toHaveLength(0);
    expect(w.text()).toContain('<script>x</script>');
    expect(w.find(c.action).text()).toBe('<b>出手</b>');
  });

  it('结算（A4）：多人状态结算的状态带归属人名', () => {
    expect(mountStyle(SETTLE).find(c.settleStatus.sel).text()).toBe(c.settleStatus.text);
  });
});
