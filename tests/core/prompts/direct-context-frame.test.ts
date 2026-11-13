import { describe, expect, it } from 'vitest';
import {
  buildDirectCharacterSections,
  buildDirectMemorySections,
  buildLegacyDirectCacheFrame,
} from '../../../src/core/prompts/direct-context-frame';
import { createCachedDirectPreset, DIRECT_TEMPLATE } from '../../../src/core/prompts/direct-prompt';
import type { DirectGenerationInput } from '../../../src/core/agents/direct-main';
import {
  createDefaultCharacterState,
  type MemoryRecord,
  type WorldBook,
  type WorldBookEntry,
} from '../../../src/core/types/types';
import {
  prepareDirectContext,
  acceptDirectContext,
  invalidateDirectContext,
} from '../../../src/core/prompts/direct-context-session';

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

  it('resolves session-static ST macros into a stable prefix instead of the authored layout', async () => {
    const input = fixture();
    const preset = createCachedDirectPreset();
    preset.settings.prompts = [
      {
        content:
          '{{setvar::tone::克制}}{{// 作者注释}}你扮演 {{char}}，与 {{user}} 同行。语气 {{getvar::tone}}。{{roll 1d20}}',
        injection_order: 1,
      },
    ];
    input.presets = [preset];
    const first = await buildLegacyDirectCacheFrame(input, [], '旧楼正文');
    input.context.userInput = '离开铁匠铺';
    input.context.agentOutputs.set('memory_recall', '已取走短剑');
    const next = await buildLegacyDirectCacheFrame(input, [], '新楼正文');
    expect(next.prefix).toEqual(first.prefix);
    const text = JSON.stringify(first.prefix);
    expect(text).toContain('语气 克制');
    expect(text).not.toContain('进入铁匠铺');
    expect(text).not.toContain('旧楼正文');
    expect(next.history).toEqual([{ role: 'system', content: '新楼正文' }]);
  });

  it.each([
    ['random', '语气 {{random::冷静,急切,嘲讽,悲伤,欢快,疑惑}}'],
    ['EJS', '语气 <%= "固定" %>'],
  ])('keeps the authored layout for genuinely dynamic %s presets', async (_kind, content) => {
    const input = fixture();
    const preset = createCachedDirectPreset();
    preset.settings.prompts = [{ content, injection_order: 1 }];
    input.presets = [preset];
    const frame = await buildLegacyDirectCacheFrame(input, [], '原始历史');
    expect(frame.history).toEqual([]);
    expect(JSON.stringify(frame.prefix)).toContain('原始历史');
  });

  it('keeps fixed lore with random macros out of the cached prefix', async () => {
    const input = fixture();
    const entry = (name: string, content: string): WorldBookEntry => ({
      uid: `frame-lore:world_setting/${name}`,
      name,
      content,
      enabled: true,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      order: 1,
      position: 0,
      extra: { lore: { audiences: ['direct_main'], section: 'fixed' } },
    });
    const stable = entry('stable', '固定法则');
    const rolled = entry('rolled', '今日天象 {{random::晴,雨,雪,雾,风,雷,霜,冰}}');
    const books: WorldBook[] = [
      { id: 'frame-lore', name: '规则', partition: 'world_setting', entries: [stable, rolled] },
    ] as WorldBook[];
    const fixed = new Set([stable, rolled]);
    const first = await buildLegacyDirectCacheFrame(input, books, '历史', fixed);
    expect(JSON.stringify(first.prefix)).toContain('固定法则');
    expect(JSON.stringify(first.prefix)).not.toContain('今日天象');
    expect(first.sections.currentLore).toMatch(/今日天象 [晴雨雪雾风雷霜冰]/);
    for (let i = 0; i < 5; i++) {
      const next = await buildLegacyDirectCacheFrame(input, books, '历史', fixed);
      expect(next.prefix).toEqual(first.prefix);
    }
  });

  it('moves only opted-in entries, preserving shared ST definitions and current data', async () => {
    const input = fixture();
    const preset = createCachedDirectPreset();
    preset.settings.prompts = [
      { content: '静态 {{getvar::tone}}', injection_order: 1 },
      {
        content: '{{setvar::tone::克制}}当前输入 {{USER_INPUT}}；{{INVENTORY}}',
        injection_order: 2,
        directCachePlacement: 'turn',
      },
    ];
    input.presets = [preset];
    input.context.characters = [
      createDefaultCharacterState({ name: '旅人', inventory: [{ name: '铁', quantity: 2 }] }),
    ];
    const first = await buildLegacyDirectCacheFrame(input, [], '历史');
    expect(JSON.stringify(first.prefix)).toContain('静态 克制');
    expect(JSON.stringify(first.prefix)).not.toContain('进入铁匠铺');
    expect(first.sections.authoredTurn).toContain('当前输入 进入铁匠铺');
    expect(first.sections.authoredTurn).toContain('铁 ×2');
    input.context.userInput = '离开铁匠铺';
    input.context.characters[0].inventory = [];
    const next = await buildLegacyDirectCacheFrame(input, [], '历史');
    expect(next.prefix).toEqual(first.prefix);
    expect(next.sections.authoredTurn).toContain('离开铁匠铺');
    expect(next.sections.authoredTurn).not.toContain('铁 ×2');
  });

  it('updates resources without repeating profiles and explicitly clears/removes entity groups', async () => {
    const saveId = 'direct-groups';
    invalidateDirectContext(saveId);
    const player = createDefaultCharacterState({
      name: '旅人',
      hp: 80,
      inventory: [{ name: '铁', quantity: 2, protocolText: '材料规则' }],
      customFields: { secret: '唯一设定' },
    });
    const npc = createDefaultCharacterState({ name: '铁匠' });
    const build = (characters: (typeof player)[]) => ({
      saveId,
      signature: 'fixed',
      history: [],
      turn: '继续',
      outputBudget: 100,
      frame: {
        prefix: [{ role: 'system' as const, content: '规则'.repeat(4000) }],
        history: [],
        sections: { ...buildDirectCharacterSections(characters), combat: null },
      },
    });
    try {
      const first = await prepareDirectContext(build([player, npc]));
      expect(JSON.stringify(first.messages)).toContain('唯一设定');
      expect(JSON.stringify(first.messages)).toContain('材料规则');
      await acceptDirectContext(first, { rawResponse: '完成', acceptedMessages: [] });
      player.hp = 60;
      const second = await prepareDirectContext(build([player, npc]));
      const delta = JSON.parse(
        second.messages[second.messages.length - 1].content!.match(
          /<direct_context>\n([\s\S]*?)\n<\/direct_context>/,
        )![1],
      );
      expect(Object.keys(delta.set).sort()).toEqual(['combat', 'resources']);
      expect(delta.set.resources[0].hp).toBe(60);
      await acceptDirectContext(second, { rawResponse: '完成', acceptedMessages: [] });
      player.inventory = [];
      const third = await prepareDirectContext(build([player]));
      const cleared = JSON.parse(
        third.messages[third.messages.length - 1].content!.match(
          /<direct_context>\n([\s\S]*?)\n<\/direct_context>/,
        )![1],
      );
      expect(cleared.set['character/旅人/inventory']).toEqual([]);
      expect(cleared.remove.sort()).toEqual([
        'character/铁匠/inventory',
        'character/铁匠/profile',
        'character/铁匠/skills',
        'character/铁匠/statusEffects',
      ]);
      expect(cleared.set.resources).toHaveLength(1);
    } finally {
      invalidateDirectContext(saveId);
    }
  });

  it('keeps one section per memory out of the prefix', async () => {
    const input = fixture();
    input.context.memories = [memory(1), memory(2)];
    const first = await buildLegacyDirectCacheFrame(input, [], '历史');
    expect(first.sections).not.toHaveProperty('memoryEntries');
    expect(first.sections['memory/MEM000001']).toBe(
      '[MEM000001] 第1日~第1日 | 重要度:5\n正文: 第1条记忆',
    );
    expect(first.sections['memory/MEM000002']).toContain('第2条记忆');
    input.context.memories = [memory(1), memory(2), memory(3)];
    const next = await buildLegacyDirectCacheFrame(input, [], '历史');
    expect(next.prefix).toEqual(first.prefix);
    expect(JSON.stringify(next.prefix)).not.toContain('第3条记忆');
    expect(next.sections['memory/MEM000003']).toContain('第3条记忆');
  });

  it('appends new memories, replaces edited ones and removes deleted ones without resending the library', async () => {
    const saveId = 'direct-memories';
    invalidateDirectContext(saveId);
    const build = (memories: MemoryRecord[]) => ({
      saveId,
      signature: 'fixed',
      history: [],
      turn: '继续',
      outputBudget: 100,
      frame: {
        prefix: [{ role: 'system' as const, content: '规则'.repeat(4000) }],
        history: [],
        sections: { ...buildDirectMemorySections(memories), combat: null },
      },
    });
    const delta = (messages: { content?: string | null }[]) =>
      JSON.parse(
        messages[messages.length - 1].content!.match(
          /<direct_context>\n([\s\S]*?)\n<\/direct_context>/,
        )![1],
      );
    try {
      const library = Array.from({ length: 30 }, (_, i) => memory(i + 1));
      const first = await prepareDirectContext(build(library));
      await acceptDirectContext(first, { rawResponse: '完成', acceptedMessages: [] });
      const added = await prepareDirectContext(build([...library, memory(31)]));
      expect(added.rebaseReason).toBeUndefined();
      expect(Object.keys(delta(added.messages).set).sort()).toEqual(['combat', 'memory/MEM000031']);
      await acceptDirectContext(added, { rawResponse: '完成', acceptedMessages: [] });
      const edited = { ...memory(5), content: '第5条记忆已改写' };
      const changed = [...library.slice(0, 4), edited, ...library.slice(5, 29), memory(31)];
      const third = await prepareDirectContext(build(changed));
      const next = delta(third.messages);
      expect(Object.keys(next.set).sort()).toEqual(['combat', 'memory/MEM000005']);
      expect(next.set['memory/MEM000005']).toContain('第5条记忆已改写');
      expect(next.remove).toEqual(['memory/MEM000030']);
    } finally {
      invalidateDirectContext(saveId);
    }
  });
});

function memory(i: number): MemoryRecord {
  return {
    id: `MEM${String(i).padStart(6, '0')}`,
    saveId: 'direct-memories',
    createdAt: i,
    realTimestamp: i,
    timeRange: { start: `第${i}日`, end: `第${i}日` },
    content: `第${i}条记忆`,
    hiddenLine: '',
    keywords: [],
    relatedCharacterIds: [],
    importance: 5,
  };
}
