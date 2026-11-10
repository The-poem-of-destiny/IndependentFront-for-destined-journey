import type { DirectGenerationInput } from '../agents/direct-main';
import type { AgentContext, ChatPreset } from '../types/types';
import { buildAgentMessagesAsync } from './agent-templates';
import { resolveTemplateWithGlobals } from './template-resolver';
import { buildCharacterContext } from '../character/character-chronicle';
import type { DirectContextFrame } from './direct-context-session';
import { DIRECT_TEMPLATE } from './direct-prompt';

/** Move engine-owned changing inputs out of the prefix; custom dynamic instructions still rebase. */
export async function buildLegacyDirectCacheFrame(
  input: DirectGenerationInput,
  books: DirectGenerationInput['worldBooks'],
  history: string,
): Promise<DirectContextFrame> {
  const preset = input.presets.find((p) => p.id === input.config.presetId);
  const prompts = (preset as ChatPreset | undefined)?.settings?.prompts;
  const authored = Array.isArray(prompts)
    ? prompts
        .filter((p) => p.enabled !== false)
        .map((p) => p.content)
        .join('\n')
    : [preset?.fixedSystem, preset?.fixedExamples, input.config.systemPrompt].join('\n');
  const template = input.config.template?.replace(/\r\n/g, '\n').trim();
  // Authored macros and custom layouts retain their original positions. Their rendered
  // prefix participates in the signature, so changing input safely rebuilds the session.
  if ((template && template !== DIRECT_TEMPLATE) || /\{\{|<%/.test(authored)) {
    const built = await buildAgentMessagesAsync(
      'direct_main',
      input.context,
      input.configs,
      books,
      input.presets,
      { NARRATIVE: history },
    );
    if (!built) throw new Error('直出提示词未配置');
    return {
      prefix: built.map((m) => ({ role: 'system', content: m.content })),
      history: [],
      sections: {},
    };
  }
  const moving = [
    'NARRATIVE',
    'USER_INPUT',
    'LORE_BOOK',
    'LORE_BOOK_STATIC',
    'LORE_BOOK_DYNAMIC',
    'CHARACTER_STATE',
    'GAME_TIME',
    'MAP_CONTEXT',
    'RANDOM_EVENTS',
    'MEMORY_ENTRIES',
    'AGENT.MEMORY_RECALL',
    'CHARACTER_CONTEXT',
  ];
  let rendered: AgentContext = input.context;
  const prefix = await buildAgentMessagesAsync(
    'direct_main',
    input.context,
    input.configs,
    books,
    input.presets,
    Object.fromEntries(moving.map((k) => [k, ''])),
    (ctx) => {
      rendered = ctx;
    },
  );
  if (!prefix) throw new Error('直出提示词未配置');
  const reference = resolveTemplateWithGlobals(
    '{{LORE_BOOK_STATIC}}\n{{LORE_BOOK_DYNAMIC}}\n{{MAP_CONTEXT}}\n{{RANDOM_EVENTS}}\n{{MEMORY_ENTRIES}}',
    'direct_main',
    rendered,
    input.config,
    books,
    input.configs,
    {},
  );
  return {
    prefix: prefix.map((m) => ({ role: 'system', content: m.content })),
    history: history ? [{ role: 'system', content: history }] : [],
    sections: {
      references: reference,
      characterContext: buildCharacterContext(input.context),
    },
  };
}
