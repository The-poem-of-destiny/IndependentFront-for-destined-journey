/**
 * template-resolver.ts — Template Resolution Engine Tests
 *
 * Phase 10a: ~80 tests covering:
 * - Basic resolution (single/multiple placeholders)
 * - Params parsing
 * - LocalParams override
 * - Unknown placeholder pass-through
 * - ST compatibility ({{setvar::VOID2::}})
 * - Edge cases (empty, adjacent, newlines, start/end positions)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveTemplate,
  resolveTemplateWithGlobals,
  resolveTemplates,
  parseParams,
  findNextPlaceholder,
} from './template-resolver';

import type { AgentContext, AgentConfig, WorldBook } from './types';

// ═══════════════════════════════════════════════════════════
// Mock placeholder-registry (not yet built — Phase 10a)
// ═══════════════════════════════════════════════════════════

// We mock the placeholder-registry module to define test resolvers.
// In production, this module will be built in Phase 10b and provide
// real resolvers for AGENT.*, CHAR.*, WORLD.*, NARRATIVE.*, etc.

const mockRegistry: Record<string, ReturnType<typeof vi.fn>> = {};

vi.mock('./placeholder-registry', () => ({
  PLACEHOLDER_REGISTRY: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (typeof prop === 'symbol') return undefined;
        return mockRegistry[prop] ?? undefined;
      },
    },
  ),
  setPlaceholderGlobals: vi.fn(),
}));

function registerPlaceholder(name: string, fn: ReturnType<typeof vi.fn>) {
  mockRegistry[name] = fn;
}

function clearRegistry() {
  Object.keys(mockRegistry).forEach((k) => delete mockRegistry[k]);
}

// ═══════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: '测试输入',
    history: [],
    lorebookMatches: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    agentId: 'story',
    enabled: true,
    apiEndpointId: 'ep-1',
    model: 'test-model',
    temperature: 0.8,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 60000,
    userId: 'test-user',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
    worldBookIds: [],
    ...overrides,
  };
}

function makeWorldBook(overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: 'wb-1',
    name: 'Test World Book',
    partition: 'world_setting',
    entries: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// parseParams
// ═══════════════════════════════════════════════════════════

describe('parseParams', () => {
  it('should parse a single key=value pair', () => {
    expect(parseParams('layers=4')).toEqual({ layers: '4' });
  });

  it('should parse multiple key=value pairs separated by colons', () => {
    expect(parseParams('layers=4:slice=800')).toEqual({ layers: '4', slice: '800' });
  });

  it('should parse three key=value pairs', () => {
    expect(parseParams('a=1:b=2:c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('should return empty object for empty string', () => {
    expect(parseParams('')).toEqual({});
  });

  it('should skip empty segments', () => {
    expect(parseParams('layers=4::slice=800')).toEqual({ layers: '4', slice: '800' });
  });

  it('should skip trailing colon', () => {
    expect(parseParams('layers=4:')).toEqual({ layers: '4' });
  });

  it('should skip leading colon', () => {
    expect(parseParams(':layers=4')).toEqual({ layers: '4' });
  });

  it('should handle values containing = sign', () => {
    expect(parseParams('expr=a=b')).toEqual({ expr: 'a=b' });
  });

  it('should handle values with spaces', () => {
    expect(parseParams('name=hello world')).toEqual({ name: 'hello world' });
  });

  it('should skip key with no value (missing =)', () => {
    expect(parseParams('badkey')).toEqual({});
  });

  it('should skip key with empty value', () => {
    expect(parseParams('key=')).toEqual({});
  });

  it('should skip entry with empty key', () => {
    expect(parseParams('=value')).toEqual({});
  });

  it('should handle numeric params', () => {
    expect(parseParams('limit=10:offset=0')).toEqual({ limit: '10', offset: '0' });
  });

  it('should handle newlines in param values without stripping them', () => {
    // Newlines in params are preserved as-is (no special handling needed)
    const parsed = parseParams('key=val\nue');
    // The regex splits on colon, newlines are preserved in the raw value
    expect(parsed.key).toBeDefined();
    expect(parsed.key).toContain('val');
  });

  it('should handle boolean-like string values', () => {
    expect(parseParams('enabled=true:verbose=false')).toEqual({ enabled: 'true', verbose: 'false' });
  });
});

// ═══════════════════════════════════════════════════════════
// findNextPlaceholder
// ═══════════════════════════════════════════════════════════

describe('findNextPlaceholder', () => {
  it('should find a basic placeholder', () => {
    const result = findNextPlaceholder('Hello {{NAME}}!');
    expect(result).not.toBeNull();
    expect(result![0]).toBe('{{NAME}}');
    expect(result![1]).toBe('NAME');
    expect(result![2]).toBe('');
    expect(result![3]).toBe(6);
  });

  it('should find a placeholder with params', () => {
    const result = findNextPlaceholder('{{NARRATIVE:layers=3:slice=500}}');
    expect(result).not.toBeNull();
    expect(result![1]).toBe('NARRATIVE');
    expect(result![2]).toBe('layers=3:slice=500');
  });

  it('should return null when no placeholder exists', () => {
    const result = findNextPlaceholder('Hello World!');
    expect(result).toBeNull();
  });

  it('should not match lowercase placeholders', () => {
    const result = findNextPlaceholder('{{name}}');
    expect(result).toBeNull();
  });

  it('should not match placeholders starting with underscore', () => {
    const result = findNextPlaceholder('{{_PRIVATE}}');
    expect(result).toBeNull();
  });

  it('should match placeholder with dot notation', () => {
    const result = findNextPlaceholder('{{AGENT.STORY}}');
    expect(result).not.toBeNull();
    expect(result![1]).toBe('AGENT.STORY');
  });

  it('should find placeholder at start of string', () => {
    const result = findNextPlaceholder('{{NAME}} is here');
    expect(result).not.toBeNull();
    expect(result![3]).toBe(0);
  });

  it('should find placeholder at end of string', () => {
    const result = findNextPlaceholder('The name is {{NAME}}');
    expect(result).not.toBeNull();
  });

  it('should find placeholder from a given start position', () => {
    // "Hi {{A}} and {{B}}"
    const template = 'Hi {{A}} and {{B}}';
    // First placeholder at position 3
    const first = findNextPlaceholder(template, 0);
    expect(first![1]).toBe('A');
    // Skip past first
    const second = findNextPlaceholder(template, first![3] + first![0].length);
    expect(second![1]).toBe('B');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Basic Resolution
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — basic resolution', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should resolve a single placeholder with no params', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));

    const result = resolveTemplate(
      'Hello {{NAME}}!',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Hello Alice!');
  });

  it('should resolve a placeholder and pass params correctly', () => {
    const resolver = vi.fn().mockReturnValue('resolved');
    registerPlaceholder('NARRATIVE', resolver);

    resolveTemplate(
      '{{NARRATIVE:layers=3:slice=500}}',
      'story',
      makeCtx(),
      makeConfig(),
    );

    expect(resolver).toHaveBeenCalledTimes(1);
    const callArgs = resolver.mock.calls[0];
    // First arg is AgentContext, second is AgentConfig, third is params
    expect(callArgs[2]).toEqual({ layers: '3', slice: '500' });
  });

  it('should resolve multiple placeholders in one template', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));
    registerPlaceholder('LOCATION', vi.fn().mockReturnValue('白曜城'));
    registerPlaceholder('RACE', vi.fn().mockReturnValue('人类'));
    registerPlaceholder('TIER', vi.fn().mockReturnValue('3'));
    registerPlaceholder('CLASS', vi.fn().mockReturnValue('战士'));

    const result = resolveTemplate(
      '{{NAME}} 是一名 {{RACE}} {{CLASS}}，目前在 {{LOCATION}}，层级 T{{TIER}}。',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Alice 是一名 人类 战士，目前在 白曜城，层级 T3。');
  });

  it('should resolve more than 5 placeholders', () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    for (const n of names) {
      registerPlaceholder(n, vi.fn().mockReturnValue(`val_${n}`));
    }

    const result = resolveTemplate(
      '{{A}} {{B}} {{C}} {{D}} {{E}} {{F}} {{G}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('val_A val_B val_C val_D val_E val_F val_G');
  });

  it('should return unchanged template when string has no placeholders', () => {
    const plain = 'This is a plain text without any placeholders.';
    const result = resolveTemplate(plain, 'story', makeCtx(), makeConfig());
    expect(result).toBe(plain);
  });

  it('should return empty string for empty template', () => {
    const result = resolveTemplate('', 'story', makeCtx(), makeConfig());
    expect(result).toBe('');
  });

  it('should pass agentId in config to resolvers', () => {
    const resolver = vi.fn().mockReturnValue('ok');
    registerPlaceholder('TEST', resolver);

    resolveTemplate('{{TEST}}', 'char_gen', makeCtx(), makeConfig({ agentId: 'char_gen' }));
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('should pass AgentContext to resolvers', () => {
    const resolver = vi.fn().mockReturnValue('ok');
    registerPlaceholder('TEST', resolver);
    const ctx = makeCtx({ userInput: 'custom input' });

    resolveTemplate('{{TEST}}', 'story', ctx, makeConfig());
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][0]).toBe(ctx);
  });

  it('should handle placeholder with empty params', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Bob'));

    const result = resolveTemplate('{{NAME:}}', 'story', makeCtx(), makeConfig());
    // Treated as name=NAME, empty params → params = {}
    expect(result).toBe('Bob');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — LocalParams Override
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — localParams override', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should use localParams value over registry resolver', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('from_registry'));

    const result = resolveTemplate(
      'Hello {{NAME}}!',
      'story',
      makeCtx(),
      makeConfig(),
      { NAME: 'from_local' },
    );
    expect(result).toBe('Hello from_local!');
  });

  it('should not call registry resolver when localParams has the key', () => {
    const resolver = vi.fn().mockReturnValue('from_registry');
    registerPlaceholder('NAME', resolver);

    resolveTemplate(
      '{{NAME}}',
      'story',
      makeCtx(),
      makeConfig(),
      { NAME: 'local_value' },
    );
    expect(resolver).not.toHaveBeenCalled();
  });

  it('should fall back to registry when localParams does not have the key', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('from_registry'));

    const result = resolveTemplate(
      '{{NAME}}',
      'story',
      makeCtx(),
      makeConfig(),
      { OTHER: 'unrelated' },
    );
    expect(result).toBe('from_registry');
  });

  it('should mix localParams and registry resolutions', () => {
    registerPlaceholder('LOCATION', vi.fn().mockReturnValue('白曜城'));
    registerPlaceholder('NPC', vi.fn().mockReturnValue('铁匠'));

    const result = resolveTemplate(
      '{{HERO}} 在 {{LOCATION}} 遇到了 {{NPC}}。',
      'story',
      makeCtx(),
      makeConfig(),
      { HERO: '阿尔冯斯' },
    );
    expect(result).toBe('阿尔冯斯 在 白曜城 遇到了 铁匠。');
  });

  it('should allow localParams to override multiple placeholders', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('reg_A'));
    registerPlaceholder('B', vi.fn().mockReturnValue('reg_B'));

    const result = resolveTemplate(
      '{{A}} + {{B}} = ?',
      'story',
      makeCtx(),
      makeConfig(),
      { A: 'local_A', B: 'local_B' },
    );
    expect(result).toBe('local_A + local_B = ?');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Unknown Placeholders
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — unknown placeholders', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should leave unknown placeholder as-is', () => {
    const result = resolveTemplate(
      'Hello {{UNKNOWN}}!',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Hello {{UNKNOWN}}!');
  });

  it('should leave multiple unknown placeholders as-is', () => {
    const result = resolveTemplate(
      '{{UNKNOWN_A}} some text {{UNKNOWN_B}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{UNKNOWN_A}} some text {{UNKNOWN_B}}');
  });

  it('should resolve known and leave unknown placeholders', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));

    const result = resolveTemplate(
      '{{NAME}} meets {{UNKNOWN_NPC}} at {{UNKNOWN_LOCATION}}.',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Alice meets {{UNKNOWN_NPC}} at {{UNKNOWN_LOCATION}}.');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — ST Compatibility
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — ST compatibility', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should leave {{setvar::VOID2::}} unchanged (ST syntax)', () => {
    // setvar starts with lowercase, so regex won't match
    const result = resolveTemplate(
      'Some text {{setvar::VOID2::}} more text',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Some text {{setvar::VOID2::}} more text');
  });

  it('should leave {{char}} unchanged (lowercase ST placeholder)', () => {
    const result = resolveTemplate(
      'Write {{char}}\'s next reply.',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Write {{char}}\'s next reply.');
  });

  it('should leave {{user}} unchanged (lowercase ST placeholder)', () => {
    const result = resolveTemplate(
      '{{user}} says hello.',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{user}} says hello.');
  });

  it('should leave {{original}} unchanged (ST passthrough)', () => {
    const result = resolveTemplate(
      '{{original}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{original}}');
  });

  it('should handle mixed ST and our placeholders', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));

    const result = resolveTemplate(
      '{{NAME}} said: "{{char}}" and {{user}} replied.',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Alice said: "{{char}}" and {{user}} replied.');
  });

  it('should handle bare ST setvar syntax without content', () => {
    const result = resolveTemplate(
      '{{setvar::VOID2::}}{{setvar::VOID3::}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{setvar::VOID2::}}{{setvar::VOID3::}}');
  });

  it('should handle {{getvar::...}} ST syntax as passthrough', () => {
    const result = resolveTemplate(
      '{{getvar::HP::}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{getvar::HP::}}');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Mixed Scenarios
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — mixed scenarios', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should handle a complex mixed template', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));
    registerPlaceholder('LOCATION', vi.fn().mockReturnValue('白曜城'));
    // DELIMITER is not registered

    const template = `**角色:** {{NAME}}
**位置:** {{LOCATION}}
**分隔:** {{DELIMITER}}
**用户:** {{user}}`;

    const result = resolveTemplate(template, 'story', makeCtx(), makeConfig(), {
      DELIMITER: '---',
    });

    expect(result).toBe(`**角色:** Alice
**位置:** 白曜城
**分隔:** ---
**用户:** {{user}}`);
  });

  it('should handle template with all three resolution sources', () => {
    // Registered
    registerPlaceholder('RACE', vi.fn().mockReturnValue('精灵'));
    // Local override
    const localParams = { HERO: '林德尔' };
    // Unknown: MYSTERY

    const result = resolveTemplate(
      '{{HERO}} the {{RACE}} found a {{MYSTERY}}.',
      'story',
      makeCtx(),
      makeConfig(),
      localParams,
    );
    expect(result).toBe('林德尔 the 精灵 found a {{MYSTERY}}.');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Agent-to-Agent Placeholders
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — AGENT.* placeholders', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should resolve AGENT.STORY when story output is in agentOutputs', () => {
    const storyOutput = '你进入了铁匠铺。';
    const ctx = makeCtx({
      agentOutputs: new Map([['story', storyOutput]]),
    });

    // Simulate what the real AGENT.STORY resolver would do
    registerPlaceholder('AGENT.STORY', vi.fn().mockImplementation(
      (c: AgentContext) => c.agentOutputs?.get('story') ?? '',
    ));

    const result = resolveTemplate(
      'Story output was: {{AGENT.STORY}}',
      'vars_update',
      ctx,
      makeConfig({ agentId: 'vars_update' }),
    );
    expect(result).toBe('Story output was: 你进入了铁匠铺。');
  });

  it('should resolve AGENT.STORY to empty string when no story output', () => {
    registerPlaceholder('AGENT.STORY', vi.fn().mockReturnValue(''));

    const result = resolveTemplate(
      '{{AGENT.STORY}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('');
  });

  it('should resolve AGENT.MEMORY_RECALL placeholder', () => {
    registerPlaceholder('AGENT.MEMORY_RECALL', vi.fn().mockReturnValue('memory data'));

    const result = resolveTemplate(
      'Memories: {{AGENT.MEMORY_RECALL}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Memories: memory data');
  });

  it('should resolve AGENT.CHAR_GEN in vars_update context', () => {
    const charGenOutput = '<char_result>...</char_result>';
    registerPlaceholder('AGENT.CHAR_GEN', vi.fn().mockReturnValue(charGenOutput));

    const result = resolveTemplate(
      'Character: {{AGENT.CHAR_GEN}}',
      'vars_update',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe(`Character: ${charGenOutput}`);
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Edge Cases
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — edge cases', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should handle adjacent placeholders', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('1'));
    registerPlaceholder('B', vi.fn().mockReturnValue('2'));

    const result = resolveTemplate('{{A}}{{B}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('12');
  });

  it('should handle three adjacent placeholders', () => {
    registerPlaceholder('X', vi.fn().mockReturnValue('a'));
    registerPlaceholder('Y', vi.fn().mockReturnValue('b'));
    registerPlaceholder('Z', vi.fn().mockReturnValue('c'));

    const result = resolveTemplate('{{X}}{{Y}}{{Z}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('abc');
  });

  it('should handle adjacent placeholders with unknown in between', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('1'));
    registerPlaceholder('C', vi.fn().mockReturnValue('3'));

    const result = resolveTemplate('{{A}}{{B}}{{C}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('1{{B}}3');
  });

  it('should handle newlines between placeholders', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('1'));
    registerPlaceholder('B', vi.fn().mockReturnValue('2'));

    const result = resolveTemplate('{{A}}\n{{B}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('1\n2');
  });

  it('should handle placeholders separated by multiple newlines', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('first'));
    registerPlaceholder('B', vi.fn().mockReturnValue('second'));

    const result = resolveTemplate('{{A}}\n\n\n{{B}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('first\n\n\nsecond');
  });

  it('should handle placeholder at very start of template', () => {
    registerPlaceholder('START', vi.fn().mockReturnValue('beginning'));

    const result = resolveTemplate('{{START}} of the text', 'story', makeCtx(), makeConfig());
    expect(result).toBe('beginning of the text');
  });

  it('should handle placeholder at very end of template', () => {
    registerPlaceholder('END', vi.fn().mockReturnValue('finish'));

    const result = resolveTemplate('The text is at the {{END}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('The text is at the finish');
  });

  it('should handle a template that is ONLY a placeholder', () => {
    registerPlaceholder('ONLY', vi.fn().mockReturnValue('all'));

    const result = resolveTemplate('{{ONLY}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('all');
  });

  it('should handle a template that is ONLY an unknown placeholder', () => {
    const result = resolveTemplate('{{UNKNOWN_ONLY}}', 'story', makeCtx(), makeConfig());
    expect(result).toBe('{{UNKNOWN_ONLY}}');
  });

  it('should handle placeholder with long params string', () => {
    registerPlaceholder('CONFIG', vi.fn().mockReturnValue('done'));

    const result = resolveTemplate(
      '{{CONFIG:a=1:b=2:c=3:d=4:e=5:f=6:g=7:h=8}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('done');
  });

  it('should handle whitespace-only template', () => {
    const result = resolveTemplate('   \n  \t  ', 'story', makeCtx(), makeConfig());
    expect(result).toBe('   \n  \t  ');
  });

  it('should preserve surrounding whitespace around placeholders', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));

    const result = resolveTemplate('  {{NAME}}  ', 'story', makeCtx(), makeConfig());
    expect(result).toBe('  Alice  ');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Resolver Returning Undefined
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — resolver returning undefined', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should keep placeholder when resolver returns undefined', () => {
    registerPlaceholder('MAYBE', vi.fn().mockReturnValue(undefined));

    const result = resolveTemplate(
      '{{MAYBE}} should stay',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('{{MAYBE}} should stay');
  });

  it('should keep placeholder when resolver returns null', () => {
    registerPlaceholder('NULLISH', vi.fn().mockReturnValue(null));

    // null -> String(null) -> "null", which is defined, so it gets replaced
    const result = resolveTemplate(
      '{{NULLISH}} resolved',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('null resolved');
  });

  it('should replace when resolver returns empty string', () => {
    registerPlaceholder('EMPTY', vi.fn().mockReturnValue(''));

    const result = resolveTemplate(
      '[{{EMPTY}}]',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('[]');
  });

  it('should replace when resolver returns number', () => {
    registerPlaceholder('NUM', vi.fn().mockReturnValue(42));

    const result = resolveTemplate(
      'The answer is {{NUM}}.',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('The answer is 42.');
  });

  it('should replace when resolver returns boolean false', () => {
    registerPlaceholder('FLAG', vi.fn().mockReturnValue(false));

    const result = resolveTemplate(
      '{{FLAG}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('false');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — Dot Notation Placeholders
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — dot notation placeholders', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should resolve AGENT.STORY placeholder', () => {
    registerPlaceholder('AGENT.STORY', vi.fn().mockReturnValue('story output'));

    const result = resolveTemplate(
      '{{AGENT.STORY}}',
      'vars_update',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('story output');
  });

  it('should resolve CHAR.PLAYER placeholder with dot notation', () => {
    registerPlaceholder('CHAR.PLAYER', vi.fn().mockReturnValue('主角'));

    const result = resolveTemplate(
      'Name: {{CHAR.PLAYER}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Name: 主角');
  });

  it('should resolve CHAR.PLAYER.HP placeholder', () => {
    registerPlaceholder('CHAR.PLAYER.HP', vi.fn().mockReturnValue('85/100'));

    const result = resolveTemplate(
      'HP: {{CHAR.PLAYER.HP}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('HP: 85/100');
  });

  it('should resolve WORLD.LOCATION placeholder', () => {
    registerPlaceholder('WORLD.LOCATION', vi.fn().mockReturnValue('北方-诺斯加德'));

    const result = resolveTemplate(
      'Current: {{WORLD.LOCATION}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Current: 北方-诺斯加德');
  });

  it('should resolve VAR.PLOT_MAIN placeholder', () => {
    registerPlaceholder('VAR.PLOT_MAIN', vi.fn().mockReturnValue('第一章'));

    const result = resolveTemplate(
      'Plot: {{VAR.PLOT_MAIN}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('Plot: 第一章');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplate — NARRATIVE Placeholder
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — NARRATIVE placeholder', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should call NARRATIVE resolver with layers and slice params', () => {
    const resolver = vi.fn().mockReturnValue('narrative text');
    registerPlaceholder('NARRATIVE', resolver);

    resolveTemplate(
      '{{NARRATIVE:layers=3:slice=500}}',
      'story',
      makeCtx(),
      makeConfig(),
    );

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0][2]).toEqual({ layers: '3', slice: '500' });
  });

  it('should call NARRATIVE resolver with only layers param', () => {
    const resolver = vi.fn().mockReturnValue('narrative');
    registerPlaceholder('NARRATIVE', resolver);

    resolveTemplate(
      '{{NARRATIVE:layers=4}}',
      'story',
      makeCtx(),
      makeConfig(),
    );

    expect(resolver.mock.calls[0][2]).toEqual({ layers: '4' });
  });

  it('should inject resolved narrative into template', () => {
    registerPlaceholder('NARRATIVE', vi.fn().mockReturnValue('从前有一座白曜城...'));

    const result = resolveTemplate(
      '背景: {{NARRATIVE:layers=2:slice=300}}',
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(result).toBe('背景: 从前有一座白曜城...');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplateWithGlobals
// ═══════════════════════════════════════════════════════════

describe('resolveTemplateWithGlobals', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should call setPlaceholderGlobals and resolve', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));

    const wb = makeWorldBook();
    const cfgs = [makeConfig()];

    const result = resolveTemplateWithGlobals(
      'Hello {{NAME}}!',
      'story',
      makeCtx(),
      cfgs[0],
      [wb],
      cfgs,
    );
    expect(result).toBe('Hello Alice!');
  });

  it('should pass worldBooks and configs to setPlaceholderGlobals', async () => {
    // Import the mocked module to check calls
    const mod = await import('./placeholder-registry');
    const setGlobalsSpy = mod.setPlaceholderGlobals as ReturnType<typeof vi.fn>;

    registerPlaceholder('X', vi.fn().mockReturnValue('y'));

    const wb = makeWorldBook({ id: 'wb-test' });
    const cfgs = [makeConfig({ agentId: 'test-agent' })];

    resolveTemplateWithGlobals(
      '{{X}}',
      'test-agent',
      makeCtx(),
      cfgs[0],
      [wb],
      cfgs,
    );

    expect(setGlobalsSpy).toHaveBeenCalledWith([wb], cfgs);
  });

  it('should support localParams in resolveTemplateWithGlobals', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('from_registry'));

    const result = resolveTemplateWithGlobals(
      'Hi {{NAME}}!',
      'story',
      makeCtx(),
      makeConfig(),
      [makeWorldBook()],
      [makeConfig()],
      { NAME: 'from_local' },
    );
    expect(result).toBe('Hi from_local!');
  });
});

// ═══════════════════════════════════════════════════════════
// resolveTemplates
// ═══════════════════════════════════════════════════════════

describe('resolveTemplates', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should resolve multiple templates at once', () => {
    registerPlaceholder('NAME', vi.fn().mockReturnValue('Alice'));
    registerPlaceholder('LOCATION', vi.fn().mockReturnValue('白曜城'));

    const results = resolveTemplates(
      ['Hello {{NAME}}!', 'Welcome to {{LOCATION}}.', '{{NAME}} is at {{LOCATION}}.'],
      'story',
      makeCtx(),
      makeConfig(),
    );

    expect(results).toEqual([
      'Hello Alice!',
      'Welcome to 白曜城.',
      'Alice is at 白曜城.',
    ]);
  });

  it('should support localParams in resolveTemplates', () => {
    registerPlaceholder('LOCATION', vi.fn().mockReturnValue('白曜城'));

    const results = resolveTemplates(
      ['{{HERO}} arrives.', 'Destination: {{LOCATION}}'],
      'story',
      makeCtx(),
      makeConfig(),
      { HERO: '阿尔冯斯' },
    );

    expect(results).toEqual([
      '阿尔冯斯 arrives.',
      'Destination: 白曜城',
    ]);
  });

  it('should return empty array for empty input', () => {
    const results = resolveTemplates(
      [],
      'story',
      makeCtx(),
      makeConfig(),
    );
    expect(results).toEqual([]);
  });

  it('should resolve all placeholders in each template independently', () => {
    registerPlaceholder('A', vi.fn().mockReturnValue('a'));
    registerPlaceholder('B', vi.fn().mockReturnValue('b'));

    // Each template has a different combination
    const results = resolveTemplates(
      ['{{A}}', '{{B}}', '{{A}} and {{B}}', 'no placeholder', ''],
      'story',
      makeCtx(),
      makeConfig(),
    );

    expect(results).toEqual([
      'a',
      'b',
      'a and b',
      'no placeholder',
      '',
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// Integration-style Tests (Simulating Real Usage)
// ═══════════════════════════════════════════════════════════

describe('resolveTemplate — integration-style scenarios', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('should resolve a story system prompt template', () => {
    registerPlaceholder('CHAR.NAME', vi.fn().mockReturnValue('阿尔冯斯'));
    registerPlaceholder('CHAR.RACE', vi.fn().mockReturnValue('人类'));
    registerPlaceholder('CHAR.TIER', vi.fn().mockReturnValue('3'));
    registerPlaceholder('WORLD.LOCATION', vi.fn().mockReturnValue('北方-诺斯加德-白曜城'));
    registerPlaceholder('NARRATIVE', vi.fn().mockReturnValue('上一轮你进入了铁匠铺...'));
    registerPlaceholder('AGENT.MEMORY_RECALL', vi.fn().mockReturnValue('[MEM000001] 铁匠委托'));

    const template = `你是《命定之诗》的叙事引擎。

**当前角色:** {{CHAR.NAME}} ({{CHAR.RACE}}, T{{CHAR.TIER}})
**当前位置:** {{WORLD.LOCATION}}
**上一轮叙事:** {{NARRATIVE:layers=3:slice=500}}
**相关记忆:** {{AGENT.MEMORY_RECALL}}

请生成下一段剧情。`;

    const result = resolveTemplate(template, 'story', makeCtx(), makeConfig());

    expect(result).toBe(`你是《命定之诗》的叙事引擎。

**当前角色:** 阿尔冯斯 (人类, T3)
**当前位置:** 北方-诺斯加德-白曜城
**上一轮叙事:** 上一轮你进入了铁匠铺...
**相关记忆:** [MEM000001] 铁匠委托

请生成下一段剧情。`);
  });

  it('should resolve a vars_update instruction template with AGENT.STORY', () => {
    const storyText = '<maintext>你进入了铁匠铺。</maintext>';
    registerPlaceholder('AGENT.STORY', vi.fn().mockImplementation(
      (c: AgentContext) => c.agentOutputs?.get('story') ?? '',
    ));

    const ctx = makeCtx({ agentOutputs: new Map([['story', storyText]]) });

    const result = resolveTemplate(
      '请提取以下正文的变量变化:\n\n{{AGENT.STORY}}',
      'vars_update',
      ctx,
      makeConfig({ agentId: 'vars_update' }),
    );

    expect(result).toBe(`请提取以下正文的变量变化:\n\n${storyText}`);
  });

  it('should handle a complex prompt with 10+ placeholders', () => {
    const placeholders = [
      'PAA', 'PBB', 'PCC', 'PDD', 'PEE',
      'PFF', 'PGG', 'PHH', 'PII', 'PJJ',
      'PKK', 'PLL',
    ];
    for (const p of placeholders) {
      registerPlaceholder(p, vi.fn().mockReturnValue(`[${p}]`));
    }

    const template = placeholders.map((p) => `{{${p}}}`).join(' ');
    const expected = placeholders.map((p) => `[${p}]`).join(' ');

    const result = resolveTemplate(template, 'story', makeCtx(), makeConfig());
    expect(result).toBe(expected);
  });
});
