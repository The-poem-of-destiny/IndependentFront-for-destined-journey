/**
 * preset-loader 测试 (Phase 8)
 */

import { describe, it, expect } from 'vitest';
import {
  loadPresetsSync,
  getPreset,
  buildPresetSection,
  assemblePresetContent,
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
        { name: 'rule1', content: 'Be creative.', enabled: true, role: 'system', injection_order: 0 },
        { name: 'rule2', content: 'Use short paragraphs.', enabled: true, role: 'system', injection_order: 1 },
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
        { name: 'context', content: 'Use these: {{NARRATIVE}}\n{{USER_INPUT}}', enabled: true, role: 'system', injection_order: 0 },
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
        { name: 'enabled1', content: 'Include me.', enabled: true, role: 'system', injection_order: 0 },
        { name: 'disabled', content: 'Skip me.', enabled: false, role: 'system', injection_order: 1 },
        { name: 'enabled2', content: 'Also include.', enabled: true, role: 'system', injection_order: 2 },
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
