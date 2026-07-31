/**
 * preset-loader 测试 (Phase 8 + Phase 10)
 */

import { describe, it, expect } from 'vitest';
import {
  loadPresetsSync,
  getPreset,
  buildPresetSection,
  assemblePresetContent,
  parseSetvars,
  resolveGetvars,
  resolveRandoms,
  replaceCharUser,
  preprocessEntry,
  hasSTMacros,
  DEFAULT_STORY_CONTEXT_BLOCK,
} from './preset-loader';
import type { AgentPreset } from './types';

function makePreset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'default-creative',
    name: '默认-创意',
    fixedSystem: '你是一个叙事引擎',
    fixedExamples: '示例输出: ...',
    ...overrides,
  };
}

describe('loadPresetsSync', () => {
  it('returns all presets from preloaded object', () => {
    const preloaded = {
      creative: makePreset({ id: 'creative', name: '创意' }),
      precise: makePreset({ id: 'precise', name: '精准' }),
    };
    const presets = loadPresetsSync(preloaded);
    expect(presets).toHaveLength(2);
  });

  it('returns empty for empty preloaded', () => {
    expect(loadPresetsSync({})).toHaveLength(0);
  });
});

describe('getPreset', () => {
  it('finds preset by ID', () => {
    const presets = [makePreset({ id: 'creative' }), makePreset({ id: 'precise' })];
    const found = getPreset('creative', presets);
    expect(found).toBeDefined();
    expect(found!.id).toBe('creative');
  });

  it('returns undefined for unknown ID', () => {
    const presets = [makePreset({ id: 'creative' })];
    expect(getPreset('nonexistent', presets)).toBeUndefined();
  });
});

describe('buildPresetSection', () => {
  it('joins fixedSystem and fixedExamples', () => {
    const preset = makePreset({
      fixedSystem: '你是叙事引擎',
      fixedExamples: '示例1\n示例2',
    });
    const result = buildPresetSection(preset);
    expect(result).toContain('你是叙事引擎');
    expect(result).toContain('示例1');
  });

  it('returns only fixedSystem when no examples', () => {
    const preset = makePreset({ fixedSystem: '仅系统提示', fixedExamples: '' });
    const result = buildPresetSection(preset);
    expect(result).toBe('仅系统提示');
  });

  it('returns empty for empty preset', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    expect(buildPresetSection(preset)).toBe('');
  });
});

describe('assemblePresetContent', () => {
  it('old ST preset (no placeholders) auto-appends context block', () => {
    const preset = makePreset({
      fixedSystem: '',
      fixedExamples: '',
    });
    // Fake settings.prompts on the preset
    (preset as any).settings = {
      prompts: [
        {
          name: 'rule1',
          content: 'Be creative.',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
        {
          name: 'rule2',
          content: 'Use short paragraphs.',
          enabled: true,
          role: 'system',
          injection_order: 1,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('Be creative.');
    expect(result).toContain('Use short paragraphs.');
    expect(result).toContain('{{NARRATIVE}}');
    expect(result).toContain('{{USER_INPUT}}');
    // Context block should be at the end
    const idxNarrative = result.indexOf('{{NARRATIVE}}');
    const idxBeCreative = result.indexOf('Be creative.');
    expect(idxNarrative).toBeGreaterThan(idxBeCreative);
  });

  it('new preset (already has {{NARRATIVE}}) does not auto-append', () => {
    const preset = makePreset({
      fixedSystem: '',
      fixedExamples: '',
    });
    (preset as any).settings = {
      prompts: [
        {
          name: 'context',
          content: 'Use these: {{NARRATIVE}}\n{{USER_INPUT}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('{{NARRATIVE}}');
    expect(result).toContain('{{USER_INPUT}}');
    // Should appear only once (no duplicate from context block)
    const narrativeCount = (result.match(/\{\{NARRATIVE\}\}/g) || []).length;
    expect(narrativeCount).toBe(1);
  });

  it('preset with no prompts array uses fixedSystem/fixedExamples', () => {
    const preset = makePreset({
      fixedSystem: 'You are a narrator.',
      fixedExamples: 'Example output',
    });
    // No settings.prompts
    const result = assemblePresetContent(preset);
    expect(result).toContain('You are a narrator.');
    expect(result).toContain('Example output');
    // No auto-append since no prompts array → just uses fixed parts
    expect(result).not.toContain('{{NARRATIVE}}');
  });

  it('disabled prompts are excluded', () => {
    const preset = makePreset({
      fixedSystem: '',
      fixedExamples: '',
    });
    (preset as any).settings = {
      prompts: [
        {
          name: 'enabled1',
          content: 'Include me.',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
        {
          name: 'disabled',
          content: 'Skip me.',
          enabled: false,
          role: 'system',
          injection_order: 1,
        },
        {
          name: 'enabled2',
          content: 'Also include.',
          enabled: true,
          role: 'system',
          injection_order: 2,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('Include me.');
    expect(result).not.toContain('Skip me.');
    expect(result).toContain('Also include.');
  });

  it('prompts sorted by injection_order', () => {
    const preset = makePreset({
      fixedSystem: '',
      fixedExamples: '',
    });
    (preset as any).settings = {
      prompts: [
        { name: 'third', content: 'C', enabled: true, role: 'system', injection_order: 3 },
        { name: 'first', content: 'A', enabled: true, role: 'system', injection_order: 1 },
        { name: 'second', content: 'B', enabled: true, role: 'system', injection_order: 2 },
      ],
    };
    const result = assemblePresetContent(preset);
    const idxA = result.indexOf('A');
    const idxB = result.indexOf('B');
    const idxC = result.indexOf('C');
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it('uses custom defaultContextBlock when provided', () => {
    const preset = makePreset({
      fixedSystem: '',
      fixedExamples: '',
    });
    (preset as any).settings = {
      prompts: [
        { name: 'rule', content: 'Hello.', enabled: true, role: 'system', injection_order: 0 },
      ],
    };
    const customBlock = '{{CUSTOM_PLACEHOLDER}}';
    const result = assemblePresetContent(preset, customBlock);
    expect(result).toContain('Hello.');
    expect(result).toContain('{{CUSTOM_PLACEHOLDER}}');
    expect(result).not.toContain('{{NARRATIVE}}');
  });
});

// ═══════════════════════════════════════════════════════════
// Phase 10: ST 占位符解析 + 替换 + 剥离
// ═══════════════════════════════════════════════════════════

describe('parseSetvars', () => {
  it('extracts single setvar', () => {
    const { variables, stripped } = parseSetvars('Hello {{setvar::name::world}} end');
    expect(variables).toEqual({ name: 'world' });
    expect(stripped).toBe('Hello  end');
  });

  it('later setvars override earlier ones (same key)', () => {
    const { variables, stripped } = parseSetvars('{{setvar::抢话::值A}} {{setvar::抢话::值B}}');
    expect(variables).toEqual({ 抢话: '值B' });
    expect(stripped.trim()).toBe('');
  });

  it('multiple different keys', () => {
    const { variables, stripped } = parseSetvars(
      '{{setvar::a::1}}{{setvar::b::2}}{{setvar::c::3}}',
    );
    expect(variables).toEqual({ a: '1', b: '2', c: '3' });
    expect(stripped).toBe('');
  });

  it('preserves multi-line values', () => {
    const { variables } = parseSetvars('{{setvar::rule::第一行\n第二行\n第三行}}');
    expect(variables.rule).toContain('第一行');
    expect(variables.rule).toContain('第二行');
    expect(variables.rule).toContain('第三行');
  });

  it('trims key name, preserves value whitespace', () => {
    const { variables } = parseSetvars('{{setvar::  key with spaces  ::\n  indented value\n}}');
    expect(variables).toHaveProperty('key with spaces');
    expect(variables['key with spaces']).toContain('indented value');
  });

  it('empty value setvars are NOT collected (declaration only)', () => {
    const { variables, stripped } = parseSetvars('{{setvar::empty::}}');
    expect(variables).toEqual({});
    expect(stripped).toBe('');
  });

  it('returns empty variables for content without setvars', () => {
    const { variables, stripped } = parseSetvars('plain text');
    expect(variables).toEqual({});
    expect(stripped).toBe('plain text');
  });
});

describe('resolveGetvars', () => {
  it('replaces getvar with value from vars table', () => {
    const result = resolveGetvars('Budget: {{getvar::思维预算c}}', {
      思维预算c: 'No more than 4096 words.',
    });
    expect(result).toBe('Budget: No more than 4096 words.');
  });

  it('replaces getvar with empty string when key not found', () => {
    const result = resolveGetvars('{{getvar::unknown}}', {});
    expect(result).toBe('');
  });

  it('handles getvar with trailing double colon', () => {
    const result = resolveGetvars('{{getvar::转述::}} rule', { 转述: '不转述模式' });
    expect(result).toBe('不转述模式 rule');
  });

  it('multiple getvars in same string', () => {
    const result = resolveGetvars('{{getvar::a}} and {{getvar::b}}', { a: '1', b: '2' });
    expect(result).toBe('1 and 2');
  });
});

describe('resolveRandoms', () => {
  it('replaces random with one of the options', () => {
    // Run multiple times to check it always picks a valid option
    for (let i = 0; i < 20; i++) {
      const result = resolveRandoms('{{random::A,B,C}}');
      expect(['A', 'B', 'C']).toContain(result);
    }
  });

  it('handles single option', () => {
    const result = resolveRandoms('{{random::only}}');
    expect(result).toBe('only');
  });

  it('handles empty random gracefully', () => {
    const result = resolveRandoms('{{random::}}');
    expect(result).toBe('');
  });
});

describe('replaceCharUser', () => {
  it('replaces {{char}} and {{user}} with custom names', () => {
    const result = replaceCharUser('{{char}} talks to {{user}}', {
      characterName: '艾丽莎',
      userName: '冒险者',
    });
    expect(result).toBe('艾丽莎 talks to 冒险者');
  });

  it('uses placeholder when names not provided', () => {
    const result = replaceCharUser('{{char}} and {{user}}');
    expect(result).toBe('{{CHARACTER_NAME}} and {{USER_NAME}}');
  });
});

describe('preprocessEntry', () => {
  it('strips setvars, resolves getvars, strips comments', () => {
    const vars = { model: 'Gemini' };
    const result = preprocessEntry(
      '{{setvar::model::Gemini}}{{//comment}} output: {{getvar::model}} {{char}}',
      vars,
      { characterName: 'NPC' },
    );
    expect(result.trim()).toBe('output: Gemini NPC');
  });

  it('resolves random + getvar together', () => {
    const vars = { style: 'epic' };
    const result = preprocessEntry('Style: {{getvar::style}}, pick: {{random::X,Y,Z}}', vars);
    expect(result).toContain('Style: epic, pick: ');
    expect(['X', 'Y', 'Z'].some((v) => result.endsWith(v))).toBe(true);
  });

  it('strips unknown non-system placeholders', () => {
    const result = preprocessEntry('{{生成菜单美化}}plain text{{roll 1d99999+1000}}end', {});
    expect(result.trim()).toBe('plain textend');
  });

  it('preserves system placeholders', () => {
    const result = preprocessEntry('{{NARRATIVE}}\n{{USER_INPUT}}\n{{AGENT.MEMORY_RECALL}}', {});
    expect(result).toContain('{{NARRATIVE}}');
    expect(result).toContain('{{USER_INPUT}}');
    expect(result).toContain('{{AGENT.MEMORY_RECALL}}');
  });

  it('setvar empty declarations are stripped', () => {
    const result = preprocessEntry('{{setvar::抢话::}}{{setvar::转述::}}text', {});
    expect(result.trim()).toBe('text');
  });
});

describe('hasSTMacros', () => {
  it('detects setvar', () => {
    expect(hasSTMacros('{{setvar::key::value}}')).toBe(true);
  });
  it('detects getvar', () => {
    expect(hasSTMacros('{{getvar::key}}')).toBe(true);
  });
  it('detects random', () => {
    expect(hasSTMacros('{{random::A,B}}')).toBe(true);
  });
  it('detects comment', () => {
    expect(hasSTMacros('{{//note}}')).toBe(true);
  });
  it('detects char/user', () => {
    expect(hasSTMacros('{{char}}')).toBe(true);
    expect(hasSTMacros('{{user}}')).toBe(true);
  });
  it('returns false for plain text', () => {
    expect(hasSTMacros('plain text')).toBe(false);
  });
  it('returns false for system placeholders only', () => {
    expect(hasSTMacros('{{NARRATIVE}} {{USER_INPUT}}')).toBe(false);
  });
});

describe('assemblePresetContent (Phase 10 extended)', () => {
  it('Pass 1 collects setvar, Pass 2 resolves getvar (real ST pattern)', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'init',
          content: '{{setvar::抢话::}}{{setvar::转述::}}{{setvar::思维预算c::}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
        {
          name: 'choose',
          content: '{{setvar::思维预算c::No more than 4096 words.}}',
          enabled: true,
          role: 'system',
          injection_order: 1,
        },
        {
          name: 'body',
          content: 'Budget: {{getvar::思维预算c}}',
          enabled: true,
          role: 'system',
          injection_order: 2,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('Budget: No more than 4096 words.');
    expect(result).not.toContain('{{setvar::');
    expect(result).not.toContain('{{getvar::');
  });

  it('later setvar overrides earlier (互斥条目 semantics)', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'a',
          content: '{{setvar::style::old}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
        {
          name: 'b',
          content: '{{setvar::style::new}}',
          enabled: true,
          role: 'system',
          injection_order: 1,
        },
        {
          name: 'c',
          content: '{{getvar::style}}',
          enabled: true,
          role: 'system',
          injection_order: 2,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('new');
    expect(result).not.toContain('old');
  });

  it('strips comments and roll macros', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'r',
          content: 'Hello {{//这是注释}} world {{roll 1d99999+1000}} end',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('Hello  world  end');
    expect(result).not.toContain('{{//');
    expect(result).not.toContain('{{roll');
  });

  it('replaces char and user placeholders', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'r',
          content: '{{char}} meets {{user}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset, undefined, {
      characterName: 'Knight',
      userName: 'Hero',
    });
    expect(result).toContain('Knight meets Hero');
  });

  it('preserves system placeholders untouched', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'ctx',
          content: 'Context: {{NARRATIVE}}\nInput: {{USER_INPUT}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('{{NARRATIVE}}');
    expect(result).toContain('{{USER_INPUT}}');
  });

  it('preserves EJS code blocks untouched', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'cot',
          content: '<%_ if (getvar("model") === "Gemini") { _%>GEMINI_MODE<%_ } _%>',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toContain('<%_ if');
    expect(result).toContain('GEMINI_MODE');
  });

  it('resolves random randomly (runs without error)', () => {
    const preset = makePreset({ fixedSystem: '', fixedExamples: '' });
    (preset as any).settings = {
      prompts: [
        {
          name: 'r',
          content: 'Pick: {{random::A,B,C,D}}',
          enabled: true,
          role: 'system',
          injection_order: 0,
        },
      ],
    };
    const result = assemblePresetContent(preset);
    expect(result).toMatch(/Pick: [ABCD]/);
  });
});
