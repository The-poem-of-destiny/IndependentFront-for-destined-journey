import { describe, expect, it } from 'vitest';
import {
  buildCharacterContext,
  chronicleTimeLabel,
  compareChronicleEntries,
  turnChronicle,
} from '../../../src/core/character/character-chronicle';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { AgentConfig, AgentContext } from '../../../src/core/types/types';
import { buildAgentMessages } from '../../../src/core/prompts/agent-templates';
import { buildStoryContextV2Messages } from '../../../src/core/prompts/story-context-v2';
import { buildLlmRequest } from '../../../src/core/api/llm-adapter';
import type { LlmProtocol, NativeLlmContent } from '../../../src/core/types/types-api';
import {
  preparePromptSession,
  completePromptSession,
  invalidatePromptSession,
} from '../../../src/core/prompts/prompt-session-assembler';

const character = createDefaultCharacterState({
  id: 'guide',
  saveId: 's1',
  name: '向导',
  present: true,
});
const entries = turnChronicle({
  character,
  update: {
    name: '向导',
    profile_changes: {},
    chronicle: [
      { title: '闲聊', summary: '日常闲聊。', importance: 1, time: { kind: 'this_turn' } },
      {
        title: '同行之约',
        summary: '约定共同寻找渡口。',
        importance: 9,
        time: { kind: 'this_turn' },
      },
      {
        title: '离乡',
        summary: '离开河谷。',
        importance: 8,
        time: { kind: 'past', label: '少年时期' },
      },
    ],
  },
  source: { sourceTurnKey: 'u1', sourceMessageIds: ['u1', 'a1'], sourceFingerprint: 'f' },
  gameTime: null,
  sourceText: '正文',
  createdAt: 1,
});
function context(): AgentContext {
  return {
    userInput: '继续',
    history: [],
    worldBooks: [],
    characters: [character],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    characterDefinitions: [],
    characterChronicle: entries,
  };
}
const config = {
  agentId: 'story',
  systemPrompt: '叙事',
  template: '{{SYS_PROMPT}}',
} as AgentConfig;

describe('chronicle selection and prompt wiring', () => {
  it('provides authored important past before the first encounter without leaking ordinary past', () => {
    const ctx = context();
    ctx.characters = [];
    ctx.userInput = '去拜访向导';
    ctx.characterDefinitions = [
      {
        id: 'guide',
        name: '向导',
        profile: {},
        assets: [],
        past: [
          {
            title: '失去师父',
            summary: '师父离世。',
            importance: 9,
            time: { kind: 'past', label: '数年前' },
          },
          {
            title: '喝茶',
            summary: '在家喝茶。',
            importance: 1,
            time: { kind: 'past', label: '某天' },
          },
        ],
      },
    ];
    expect(buildCharacterContext(ctx)).toContain('失去师父');
    expect(buildCharacterContext(ctx)).not.toContain('喝茶');
    expect(buildCharacterContext({ ...ctx, userInput: '继续旅行' })).not.toContain('失去师父');
  });
  it('hard-filters low importance and unrelated characters, honoring a separate budget', () => {
    expect(buildCharacterContext(context())).toContain('同行之约');
    expect(buildCharacterContext(context())).not.toContain('闲聊');
    expect(
      buildCharacterContext({ ...context(), characters: [{ ...character, present: false }] }),
    ).toBe('');
    expect(buildCharacterContext(context(), 1)).toBe('');
    expect(chronicleTimeLabel(entries[0])).toBe('日期未载');
    expect(chronicleTimeLabel(entries[2])).toBe('少年时期');
    expect(compareChronicleEntries(entries[2], entries[0])).toBeLessThan(0);
  });
  it('ordinary and v2 assembly both carry protocol and important history', async () => {
    const ordinary = JSON.stringify(buildAgentMessages('story', context(), [config], [], []));
    const v2 = await buildStoryContextV2Messages({
      ctx: context(),
      configs: [config],
      worldBooks: [],
      presets: [],
      windowTurns: 2,
      segments: [],
      archives: [],
    });
    for (const wire of [ordinary, JSON.stringify(v2.messages)]) {
      expect(wire).toContain('character_updates');
      expect(wire).toContain('同行之约');
      expect(wire).not.toContain('日常闲聊');
    }
    expect(v2.diagnostics.totalChars).toBe(
      v2.messages.reduce((sum, m) => sum + m.content.length, 0),
    );
  });
  it.each<LlmProtocol>(['openai-chat', 'gemini', 'anthropic-messages'])(
    'Delta %s excludes low importance from the actual request while preserving native reasoning',
    async (protocol) => {
      const input = {
        saveId: `s1-${protocol}`,
        agentId: 'story',
        ctx: context(),
        configs: [config],
        worldBooks: [],
        presets: [],
      };
      const first = await preparePromptSession(input);
      expect(first.handle).toBeTruthy();
      const raw =
        '<maintext>正文</maintext><character_updates>{"low":"日常闲聊"}</character_updates>';
      const parts = [raw.slice(0, 30), raw.slice(30)];
      const nativeAssistant: NativeLlmContent = {
        protocol,
        value:
          protocol === 'openai-chat'
            ? { role: 'assistant', content: raw, reasoning_content: '保留推理' }
            : protocol === 'gemini'
              ? {
                  role: 'model',
                  parts: [
                    { thought: true, text: '保留推理' },
                    { text: parts[0], thoughtSignature: '签名' },
                    { text: parts[1] },
                  ],
                }
              : {
                  content: [
                    { type: 'thinking', thinking: '保留推理', signature: '签名' },
                    ...parts.map((text) => ({ type: 'text', text })),
                  ],
                },
      };
      completePromptSession(first.handle!, {
        rawResponse: raw,
        nativeAssistant,
        tokensUsed: 10,
      } as Parameters<typeof completePromptSession>[1]);
      const second = await preparePromptSession(input);
      expect(second.messages[second.messages.length - 1]?.content).toContain('同行之约');
      expect(JSON.stringify(second.messages)).not.toContain('日常闲聊');
      const wire = JSON.stringify(
        buildLlmRequest({
          protocol,
          model: 'test',
          messages: second.messages,
          stream: false,
          userId: 'test',
        }).body,
      );
      expect(wire).not.toContain('日常闲聊');
      expect(wire).toContain('保留推理');
      if (protocol !== 'openai-chat') expect(wire).toContain('签名');
      expect(JSON.stringify(nativeAssistant)).toContain('日常闲聊');
      if (second.handle) invalidatePromptSession(second.handle);
    },
  );
});
