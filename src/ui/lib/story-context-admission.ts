/**
 * Story 上下文新模式的**前端措辞来源**（准入拒绝、窗口设置错误、摘要缺失 / 失败）。
 *
 * 判据都在引擎（`@engine/story/story-context-mode`、`@engine/memory/memory-context`），
 * 这里只把结论翻成玩家看得懂的话。存档管理、游戏页与管线共用这一份文案，避免各说各的。
 */
import type { StoryContextRejection } from '@engine/story/story-context-mode';

const REJECTION_MESSAGES: Record<StoryContextRejection, string> = {
  'v2-save-requires-v2-mode':
    '这是「Story 上下文与记忆新模式」的测试存档，需先在 设置 → 开发者模式 中开启新模式才能载入或继续。',
  'legacy-save-in-v2-mode':
    '已开启「Story 上下文与记忆新模式」，普通存档不能在新模式下继续。请新建测试存档，或关闭新模式后再载入。',
};

export function storyContextRejectionMessage(reason: StoryContextRejection): string {
  return REJECTION_MESSAGES[reason];
}

/** 正文窗口 N 非法（新模式只接受正整数，N=0 也不行） */
export function storyContextWindowInvalidMessage(configured: unknown): string {
  return `新模式的正文窗口必须是正整数（当前为 ${String(configured)}）。请在 设置 → Agent 配置 → 正文 的「历史层数」里填一个大于 0 的整数，本回合未发送。`;
}

/** 窗口外有回合缺少摘要：本轮以原文代替（不静默丢历史，计划 Q10） */
export function storyContextMissingSummaryMessage(count: number): string {
  return `有 ${count} 个较早回合缺少摘要，本回合以这些回合的原文代替。`;
}

/** 总结 Agent 判定结束、但没通过代码把关的归档（事件保持未归档） */
export function storyContextArchiveRejectedMessage(eventNames: readonly string[]): string {
  return `「${eventNames.join('」「')}」的结束判断没有在本回合正文里找到依据，事件暂不归档，之后的回合会继续判断。`;
}

/** 本回合摘要没产出或没落库 */
export function storyContextSummaryFailedMessage(): string {
  return '本回合的摘要没有生成成功；正文已保存，之后的回合会以原文代替这一回合。';
}

/** 整轮上下文粗估超过端点上下文窗口：报告各区用量，由玩家调小 N 或换更大窗口 */
export function storyContextOverBudgetMessage(
  diagnostics: { zoneChars: Record<1 | 2 | 3 | 4 | 5, number> },
  budget: { estimatedTokens: number; contextWindowTokens?: number },
): string {
  const zones = ([1, 2, 3, 4, 5] as const)
    .map((zone) => `第${zone}区 ${diagnostics.zoneChars[zone]} 字`)
    .join('、');
  return `本回合上下文约 ${budget.estimatedTokens} token，超过正文模型的上下文窗口（${String(budget.contextWindowTokens)}）。各区用量：${zones}。可以调小正文「历史层数」或换用更大窗口的模型。`;
}

/** 较早回合的摘要补建没成功：那些回合继续以原文代替，之后的回合会再试 */
export function storyContextBackfillFailedMessage(count: number): string {
  return `有 ${count} 个较早回合的摘要没能补上，暂时继续以原文代替，之后的回合会再试。`;
}

/** 新模式召回失败（本回合照常生成，只是没有带上过往记忆的细节） */
export function storyContextRecallFailedMessage(): string {
  return '本回合的记忆召回没有成功，正文照常生成，只是没有带上过往记忆的细节。';
}
