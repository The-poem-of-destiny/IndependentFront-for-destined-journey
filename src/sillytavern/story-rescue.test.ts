import { describe, it, expect } from 'vitest';
import { rescueStoryOutput } from './story-rescue';
import type { AgentResult } from './types';

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    agentId: 'story',
    output: '',
    rawResponse: '',
    reasoning: '',
    tokensUsed: 0,
    cacheHit: false,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    completionTokens: 0,
    duration: 0,
    ...overrides,
  };
}

describe('rescueStoryOutput', () => {
  describe('场景 1: 正文吞进思维链 (raw 空)', () => {
    it('reasoning 含 <maintext> → 救回正文 + options', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning:
          'Step 0: 思考...\n\n<maintext>你走进了森林。</maintext>\n<options>\n1. 前进\n</options>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toContain('<maintext>你走进了森林。</maintext>');
      expect(r.rawResponse).toContain('<options>');
      expect(r.rawResponse).not.toContain('Step 0');
      expect(r.output).toBe(r.rawResponse);
    });

    it('思维链前部提及 <maintext> 格式词 → 取最后一个，不误切', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning:
          'Step 1: 记得用 <maintext> 标签包裹正文\nStep 2: ...\n\n<maintext>真正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>真正文</maintext>');
      expect(r.rawResponse).not.toContain('Step 1');
      expect(r.rawResponse).not.toContain('标签');
    });

    it('raw 空 + reasoning 无 <maintext> → 不救', () => {
      const r = makeResult({ rawResponse: '', reasoning: '纯思维链，没有任何 maintext 标签' });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe('');
    });

    it('清洗结尾代码块围栏', () => {
      const r = makeResult({
        rawResponse: '',
        reasoning: 'Final step:\n<maintext>正文</maintext>\n```',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>正文</maintext>');
    });

    it('真实坏轮样本（思维链 15 步 + 正文吞尾部）→ 救回完整正文', () => {
      const reasoning =
        '首先确认Recorder身份...\nStep 1: 分析输入...\nStep 14: 格式回顾\nFinal step: 闭合\n\n```\n\n<maintext>你站在通往地面的石阶前，深吸了一口气。</maintext>\n<options>\n1. 继续前进\n2. 加快脚步\n</options>';
      const r = makeResult({ rawResponse: '', reasoning });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      expect(r.rawResponse).toContain('石阶前');
      expect(r.rawResponse).toContain('<options>');
      expect(r.rawResponse).not.toContain('Recorder');
      expect(r.rawResponse).not.toContain('Step 1');
    });
  });

  describe('场景 2: 思维链泄漏进正文 (raw 非空)', () => {
    it('raw 开头是思维链 → 截掉 <maintext> 之前', () => {
      const r = makeResult({
        rawResponse:
          '首先确认Recorder身份，回顾规则。\n然后开始写。\n<maintext>你走进了森林。</maintext>\n<options>\n1. 前进\n</options>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).not.toContain('首先确认');
      expect(r.rawResponse).not.toContain('回顾规则');
      expect(r.rawResponse.startsWith('<maintext>')).toBe(true);
      expect(r.output).toBe(r.rawResponse);
    });

    it('思维链里提及 <maintext> 格式词 → 取最后一个', () => {
      const r = makeResult({
        rawResponse: '用 <maintext> 包裹正文哦\n然后开始写\n<maintext>真正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>真正文</maintext>');
      expect(r.rawResponse).not.toContain('包裹正文');
    });

    it('raw 无标签（裸正文）→ 不动', () => {
      const r = makeResult({ rawResponse: '一段没有标签的裸正文' });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe('一段没有标签的裸正文');
    });

    it('<maintext> 已在最开头 → 不动', () => {
      const raw = '<maintext>正文</maintext>';
      const r = makeResult({ rawResponse: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });

    it('raw 仅空白 → 走场景 1 逻辑', () => {
      const r = makeResult({
        rawResponse: '   \n  ',
        reasoning: '<maintext>正文</maintext>',
      });
      expect(rescueStoryOutput(r)).toBe(true);
      expect(r.rawResponse).toBe('<maintext>正文</maintext>');
    });
  });

  describe('正常轮不受影响', () => {
    it('完整正常输出 → 不动', () => {
      const raw = '<maintext>正文</maintext>\n<options>\n1. A\n</options>';
      const r = makeResult({ rawResponse: raw, output: raw });
      expect(rescueStoryOutput(r)).toBe(false);
      expect(r.rawResponse).toBe(raw);
    });
  });
});
