/**
 * 捏人页与「设置 → 剧情系统」共用的选项与范围常量（UIL-10）。
 *
 * 设置页给的是「新档默认值」，捏人页「剧情规划」逐档调整同一组参数 —— 两处的枚举与范围
 * 必须一致：此前设置页 8 个难度、捏人页只有 5 个，默认值落在 T1/T5/T6 时捏人页按钮全灭；
 * 章节数设置页可填 0（AI 自行判断）、捏人页最小 1，一旦调高就再也回不到 0。
 * 所以只在这里定义一份，两边都从这里读。
 */

/** 剧情难度层级选项：`'adaptive'` = 按玩家层级自适应，数字 = 固定层级上限 */
export const PLOT_DIFFICULTY_OPTIONS: ReadonlyArray<{
  value: 'adaptive' | number;
  label: string;
  desc?: string;
}> = [
  { value: 'adaptive', label: '自适应', desc: '根据玩家的生命层级自动适配' },
  { value: 1, label: 'T1 普通' },
  { value: 2, label: 'T2 中坚' },
  { value: 3, label: 'T3 精英' },
  { value: 4, label: 'T4 史诗' },
  { value: 5, label: 'T5 传说' },
  { value: 6, label: 'T6 神话' },
  { value: 7, label: 'T7 神祇' },
];

/** 主线持续年份范围 */
export const PLOT_DURATION_YEARS_MIN = 1;
export const PLOT_DURATION_YEARS_MAX = 50;

/** 章节数 / 每章事件数范围；0 = AI 自行判断（剧情设置里不写该字段） */
export const PLOT_COUNT_MIN = 0;
export const PLOT_COUNT_MAX = 20;

/**
 * 建档必填校验失败时错误消息的固定前缀。
 *
 * `persistJourney` 抛它、`CreatePage` 据此区分「缺必填项」与「落库失败」——
 * 前者要把缺什么原样告诉玩家，后者只给通用的重试提示。
 */
export const MISSING_FIELDS_PREFIX = '创建前请先补全：';

/** 页脚「下一步」被禁用时的缺项提示：前缀 + 缺项（各带所属步骤，供跳转） */
export interface BlockedHint {
  prefix: string;
  /** 当前所在步骤：同一步内的缺项不必再给跳转 */
  currentStep: number;
  items: Array<{ label: string; step: number }>;
}
