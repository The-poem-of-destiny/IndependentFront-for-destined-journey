/**
 * Agent 提示词草稿的「未保存」守卫（S-15，2026-11-14）。
 *
 * System Prompt / 上下文模板的草稿住在 `AgentConfigPanel` 里，而会把它们丢掉的导航
 * （子导航换 Agent、主导航换分区、页头「← 返回」）住在 `SettingsPage`。两边不是父子
 * 直连（中间隔着 AgentSection），所以用一个**模块级**状态把「有没有未保存修改」交给壳层。
 *
 * 🔴 这是纯内存的 UI 状态，**不进** settings 袋子：`settings.agentPromptEdited` 会被 deep watch
 *    写进 localStorage，刷新后还亮着「未保存」就是在说谎（草稿刷新后已经没了）。
 */
import { ref } from 'vue';
import { confirmDialog } from '../../../lib/confirm-dialog';

/** 当前是否有未保存的提示词 / 模板修改（由 AgentConfigPanel 维护） */
export const promptDraftDirty = ref(false);

export function setPromptDraftDirty(dirty: boolean): void {
  promptDraftDirty.value = dirty;
}

/**
 * 导航前调用：没有未保存修改 → 直接放行；有 → 问一句。
 * 返回 true = 可以继续导航（用户选了放弃修改，标志随之清掉）；false = 留在原处继续编辑。
 */
export async function confirmDiscardPromptEdits(): Promise<boolean> {
  if (!promptDraftDirty.value) return true;
  const discard = await confirmDialog({
    title: '有未保存的修改',
    message: 'System Prompt 或上下文模板的修改还没有保存，离开后这些修改会丢失。',
    confirmLabel: '放弃修改',
    cancelLabel: '继续编辑',
    danger: true,
  });
  if (discard) promptDraftDirty.value = false;
  return discard;
}
