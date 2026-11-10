import { describe, expect, it } from 'vitest';
import { buildLegacyDirectCacheFrame } from '../../../src/core/prompts/direct-context-frame';
import { createCachedDirectPreset, DIRECT_TEMPLATE } from '../../../src/core/prompts/direct-prompt';
import type { DirectGenerationInput } from '../../../src/core/agents/direct-main';

function fixture(): DirectGenerationInput {
  const preset = createCachedDirectPreset();
  const config = {
    agentId: 'direct_main',
    enabled: true,
    presetId: preset.id,
    template: DIRECT_TEMPLATE,
  } as DirectGenerationInput['config'];
  return {
    config,
    configs: [config],
    presets: [preset],
    worldBooks: [],
    combat: null,
    endpoint: {} as DirectGenerationInput['endpoint'],
    context: {
      userInput: '进入铁匠铺',
      history: [],
      characters: [],
      variables: {},
      worldBooks: [],
      memories: [],
      plotEvents: [],
      agentOutputs: new Map([['memory_recall', '已交付材料']]),
    },
  };
}

describe('legacy cached direct layout', () => {
  it('keeps the built-in instructions stable when player input and memory change', async () => {
    const input = fixture();
    const first = await buildLegacyDirectCacheFrame(input, [], '旧楼正文');
    input.context.userInput = '离开铁匠铺';
    input.context.agentOutputs.set('memory_recall', '已取走短剑');
    const next = await buildLegacyDirectCacheFrame(input, [], '新楼正文');
    expect(next.prefix).toEqual(first.prefix);
    expect(JSON.stringify(first.prefix)).not.toContain('已交付材料');
    expect(next.history).toEqual([{ role: 'system', content: '新楼正文' }]);
  });

  it.each(['preset', 'template'] as const)(
    'preserves authored %s macro positions',
    async (kind) => {
      const input = fixture();
      const authored = '前段 {{USER_INPUT}} 中段 {{NARRATIVE}} 后段';
      if (kind === 'template') input.config.template = authored;
      else {
        const preset = createCachedDirectPreset();
        preset.settings.prompts![0].content = authored;
        input.presets = [preset];
      }
      const first = await buildLegacyDirectCacheFrame(input, [], '原始历史');
      const text = first.prefix.map((m) => m.content).join('\n');
      expect(text).toContain('前段 进入铁匠铺 中段 原始历史 后段');
      expect(first.history).toEqual([]);
      input.context.userInput = '离开铁匠铺';
      const second = await buildLegacyDirectCacheFrame(input, [], '原始历史');
      expect(second.prefix).not.toEqual(first.prefix);
    },
  );
});
