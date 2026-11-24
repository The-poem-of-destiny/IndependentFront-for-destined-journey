/**
 * 行动面板组件测试共用样例（覆盖交锋 / 名册 / 结算 / 通用四种 kind，名字与文字全是自编）。
 */
import { parseActionPanel } from '../../../../../src/ui/lib/action-panel';
import { buildActionView, type ActionView } from '../../../../../src/ui/lib/action-panel-view';

export function sheet(title: string, rows: ReadonlyArray<readonly [string, string]>): string {
  return [`{${title}}`, ...rows.map(([k, v]) => `|${k}|${v}|`)].join('\n');
}

export function viewOf(raw: string): ActionView {
  return buildActionView(parseActionPanel(raw));
}

/** AssetMedia 替身：永远交还插槽（首字题签） */
export const ASSET_STUB = {
  AssetMedia: {
    name: 'AssetMedia',
    props: ['name', 'type', 'variant'],
    template: '<span class="am-stub" :data-name="name"><slot /></span>',
  },
};

/** ① 单体攻击 · 暴击 · 自身消耗 · 附加状态 */
export const EXCHANGE = sheet('出手 · 裂风斩', [
  ['行动者', '艾琳'],
  ['目标', '灰狼'],
  ['行动', '裂风斩'],
  ['命中', 'd20=17 +敏捷5 → 22 / 闪避 14'],
  ['判定', '暴击'],
  ['伤害', '34'],
  ['变更', '灰狼 HP 60→26'],
  ['变更', '艾琳 SP 88→76'],
  ['状态', '灰狼 获得 流血(2回合)'],
]);

/** ② 范围攻击 · 一人失手 */
export const EXCHANGE_MISS = sheet('出手 · 霜环术', [
  ['行动者', '莉娅'],
  ['目标', '盗匪甲、盗匪乙'],
  ['行动', '霜环术'],
  ['盗匪甲', 'd20=15 +6 → 21 / 抗性 12 命中'],
  ['盗匪乙', 'd20=4 +6 → 10 / 抗性 12 失手'],
  ['判定', '命中 1/2'],
  ['变更', '盗匪甲 HP 48→27'],
  ['变更', '莉娅 MP 64→46'],
]);

/** ④ 回合总览 · 单位名册 */
export const ROSTER = sheet('第 3 回合 · 战况总览', [
  ['环境', '夜雨 · 林道'],
  ['艾琳', 'HP 69/96 MP 20/40 SP 76/110'],
  ['灰狼', 'HP 26/72 SP 40/60'],
  ['盗匪喽啰(2/3)', 'HP 27/110'],
]);

/** ⑤ 制作结果 · 成功 */
export const OUTCOME = sheet('锻造 · 精钢短剑', [
  ['检定', 'd100=31 ≤ 78 成功'],
  ['产物', '精钢短剑'],
  ['品质', '稀有'],
  ['经验', '+45'],
  ['变更', '艾琳 SP 76→61'],
  ['结果', '锻成一柄稀有品质的精钢短剑'],
]);

/** ⑦ 旧式面板 · 无约定行 */
export const GENERIC = sheet('潜行 · 穿过哨卡', [
  ['潜行', '1d20(13)+4=17'],
  ['守卫警觉', '12'],
  ['距离', '约 20 米'],
  ['备注', '雨声掩盖了脚步'],
]);
