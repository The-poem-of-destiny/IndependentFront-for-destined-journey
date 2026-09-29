/**
 * AgentParamsCard.vue —— Delta 会话单一 tailPrompt 控件的结构断言
 *
 * 照 `ApiSection.image-endpoint.test.ts` 的先例读 SFC 源码（?raw）而不 mount：
 * 本组件是 AgentConfigPanel 内部的一张卡，mount 它要拖进 settings-store / 内容包
 * 一整条启动逻辑；而这里守的全是「这一格在不在」这种结构决定。
 *
 * 守三条：
 *   1. 有且只有一个 tailPrompt 文本域（v1 只此一个 tail，不增加第二个）。
 *   2. 留空 = 写 `undefined` = 删键（与 historyLayers/historySlice 同一条纪律，
 *      「键不存在」编码「未配置」，不会挡掉引擎对空值的处理）。
 *   3. 标签是文字（design.md：保留文字标签，不用纯图标按钮）。
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/settings/agent/AgentParamsCard.vue?raw';

describe('AgentParamsCard —— tailPrompt 控件（T4）', () => {
  it('有且只有一个 tailPrompt 文本域', () => {
    const setAgentFieldCalls = source.match(/tailPrompt:/g) ?? [];
    expect(setAgentFieldCalls.length).toBeGreaterThan(0);
    // 文本域只出现一次（v1 只此一个 tail：不增加第二个 tail、优先级列表）
    expect(source.match(/class="form-input form-textarea"/g) ?? []).toHaveLength(1);
    expect(source).toContain('@input="onTailPromptInput($event)"');
  });

  it('🔴 留空 = 写 undefined = 删键（空白归一化在输入侧）', () => {
    // AgentConfigPanel 的 diff-write 收到 undefined 才删覆写键 —— 控件必须产出 undefined
    // 而不是空串（空串会变成「键存在」，挡掉引擎默认；与 historyLayers 同一陷阱）。
    expect(source).toMatch(/tailPrompt:\s*v\.trim\(\) === '' \? undefined : v/);
  });

  it('保留文字标签（design.md：不用纯图标按钮）', () => {
    expect(source).toContain('末尾指令 (tailPrompt)');
  });
});
