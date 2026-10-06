/**
 * PresetManager.vue —— 预填充控件（末尾 assistant 条目 → 前缀续写）
 *
 * 照 `AgentParamsCard.tail-prompt.test.ts` 的先例读 SFC 源码（?raw）而不 mount。
 *
 * 守四条：
 *   1. 开关是否出现，判据复用**引擎**的 `findTailAssistantEntry`（不在这里另写一份）；
 *   2. 开关/填充位置写进预设 `settings.prefill`；
 *   3. 「填充位置」两档 content / reasoning_content 都在；
 *   4. 提醒点名 DeepSeek Beta 端点。
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/settings/agent/PresetManager.vue?raw';

describe('PresetManager —— 预填充（末尾 assistant 条目）', () => {
  it('开关是否出现复用引擎 findTailAssistantEntry（不另写判据）', () => {
    expect(source).toContain('findTailAssistantEntry');
    expect(source).toMatch(/v-if="tailAssistantEntry"/);
  });

  it('开关 / 填充位置写进预设 settings.prefill', () => {
    expect(source).toContain('function patchPrefill');
    expect(source).toContain('{ ...prev, ...patch }');
    expect(source).toContain('@change="togglePrefill"');
    expect(source).toContain('@change="onPrefillFieldChange"');
  });

  it('「填充位置」两档：正文前缀（content）/ 思维链种子（reasoning_content）', () => {
    expect(source).toContain('value="content"');
    expect(source).toContain('value="reasoning_content"');
  });

  it('提醒点名仅支持 DeepSeek Beta 端点', () => {
    expect(source).toContain('仅支持 DeepSeek Beta 端点');
    expect(source).toContain('api.deepseek.com/beta');
  });
});
