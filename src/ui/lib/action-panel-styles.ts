/**
 * `<action_info>` 行动面板 — 样式目录
 *
 * 行动面板有五种呈现样式，玩家在设置页「消息显示 → 行动面板样式」里挑一种，存进
 * `settings.actionPanelStyle`。本模块是样式的唯一目录：id、中文名、一句话说明、入场动画时长。
 *
 *   - `ACTION_PANEL_STYLES`         — 全部样式（设置页下拉框按这个顺序列出）
 *   - `DEFAULT_ACTION_PANEL_STYLE`  — 缺省样式（对决条）
 *   - `resolveActionPanelStyle()`   — 任意值 → 合法样式 id；旧设置缺键 / 写坏的值一律回落缺省
 *
 * 纯数据 + 纯函数，不碰 store；读写设置走 `composables/useActionPanelStyle.ts`。
 */

/** 行动面板样式 id */
export type ActionPanelStyleId = 'duel' | 'afterimage' | 'battlelog' | 'floating' | 'card';

export interface ActionPanelStyleInfo {
  id: ActionPanelStyleId;
  /** 中文名（设置页下拉框显示） */
  label: string;
  /** 一句话说明 */
  description: string;
  /**
   * 入场动画总时长（毫秒）：盖住该样式最长一段动画（延迟 + 时长）再留约 60ms 余量，到点才撤入场类。
   * 改了组件里的动画或 `--motion-*` token 要同步这里；算式与断言在 tests/ui/lib/action-panel-styles.test.ts。
   * 减动效时由渲染面自行跳过。
   */
  entranceMs: number;
}

/** 全部样式，顺序即设置页下拉框顺序 */
export const ACTION_PANEL_STYLES: readonly ActionPanelStyleInfo[] = [
  {
    id: 'duel',
    label: '对决条',
    description: '双方左右对峙，检定与结算在中间一条上依次亮起。',
    entranceMs: 660,
  },
  {
    id: 'afterimage',
    label: '血条残影',
    description: '资源条先扣到新值，旧值留一道残影再慢慢追上。',
    entranceMs: 1020,
  },
  {
    id: 'battlelog',
    label: '战报行',
    description: '一行一句紧凑战报，像战斗日志一样逐行写出。',
    entranceMs: 1240,
  },
  {
    id: 'floating',
    label: '跳字舞台',
    description: '骰值与伤害数字从面板上弹起后落定。',
    entranceMs: 930,
  },
  {
    id: 'card',
    label: '打出的牌',
    description: '整块面板像一张牌被打出，翻面后露出结算。',
    entranceMs: 840,
  },
];

/** 缺省样式 */
export const DEFAULT_ACTION_PANEL_STYLE: ActionPanelStyleId = 'duel';

/** 任意值 → 合法样式 id；不认识的（含缺键的 undefined）回落 `DEFAULT_ACTION_PANEL_STYLE` */
export function resolveActionPanelStyle(value: unknown): ActionPanelStyleId {
  const hit = ACTION_PANEL_STYLES.find((s) => s.id === value);
  return hit ? hit.id : DEFAULT_ACTION_PANEL_STYLE;
}
