/**
 * S-00 / S-10（2026-11-14 UI/UX 审查）：
 *   · 默认层（内容包）里本机不存在的 API 池 id 在读取咽喉按「未设置」处理；
 *     用户覆写层的失效 id 原样保留（F10 fail-closed）。
 *   · `resolveAgentLlmParamSources` 与 `resolveAgentLlmParams` 同一份优先级，并报告来源。
 */
import { describe, expect, it } from 'vitest';
import {
  getAgentSettings,
  resolveAgentLlmParams,
  resolveAgentLlmParamSources,
} from '../../../src/ui/stores/agent-settings';

const llm = { id: 'local-llm', name: '本机', kind: 'llm' };
const embedding = { id: 'local-emb', name: '向量', kind: 'embedding' };

describe('S-00 默认层的池 id 在本机不存在 → 按未设置处理', () => {
  it('默认层给了作者机器上的 UUID、本机池里没有 → model 为空串（走默认端点）', () => {
    const bag = { apiPool: [llm], agents: {} };
    const cfg = getAgentSettings(bag, 'story', { story: { model: 'author-uuid' } });
    expect(cfg.model).toBe('');
  });

  it('默认层给的 id 恰好存在于本机 → 原样保留', () => {
    const bag = { apiPool: [llm], agents: {} };
    expect(getAgentSettings(bag, 'story', { story: { model: 'local-llm' } }).model).toBe(
      'local-llm',
    );
  });

  it('默认层指向的是本机的 Embedding 源（不是对话源）→ 同样按未设置处理', () => {
    const bag = { apiPool: [llm, embedding], agents: {} };
    expect(getAgentSettings(bag, 'story', { story: { model: 'local-emb' } }).model).toBe('');
  });

  it('🔴 用户覆写层的失效 id 原样保留 —— 交给解析器判 stale-binding（F10）', () => {
    const bag = { apiPool: [llm], agents: { story: { model: 'deleted-by-user' } } };
    const cfg = getAgentSettings(bag, 'story', { story: { model: 'author-uuid' } });
    expect(cfg.model).toBe('deleted-by-user');
  });

  it('空池时默认层的 id 也清空（本机没有任何池，它不可能存在）', () => {
    const bag = { apiPool: [], agents: {} };
    expect(getAgentSettings(bag, 'story', { story: { model: 'author-uuid' } }).model).toBe('');
  });

  it('袋子里没有 apiPool（测试裸袋 / 旧调用方）→ 不替它下结论，原样返回', () => {
    expect(getAgentSettings({}, 'story', { story: { model: 'author-uuid' } }).model).toBe(
      'author-uuid',
    );
  });
});

describe('S-10 采样参数的实际值与来源', () => {
  const defaults = { story: { temperature: 0.85, topP: 0.95, freqPen: 0.1, presPen: 0.2 } };

  it('Agent 覆写 > API 池默认 > 内容包默认，逐键报告来源', () => {
    const bag = { apiPool: [llm], agents: { story: { topP: 0.5 } } };
    const sources = resolveAgentLlmParamSources(bag, 'story', defaults, {
      temperature: 1,
      topP: 0.9,
    });
    expect(sources.topP).toEqual({ value: 0.5, source: 'override' });
    expect(sources.temperature).toEqual({ value: 1, source: 'pool' });
    expect(sources.freqPen).toEqual({ value: 0.1, source: 'default' });
    expect(sources.presPen).toEqual({ value: 0.2, source: 'default' });
    expect(sources.maxTokens.source).toBe('default');
  });

  it('与 resolveAgentLlmParams 给出逐字相同的值（同一份实现，不漂移）', () => {
    const bag = { apiPool: [llm], agents: { story: { presPen: -0.5 } } };
    const pool = { temperature: 1.3, maxTokens: 4096 };
    const sources = resolveAgentLlmParamSources(bag, 'story', defaults, pool);
    const values = resolveAgentLlmParams(bag, 'story', defaults, pool);
    expect(values).toEqual({
      temperature: sources.temperature.value,
      topP: sources.topP.value,
      freqPen: sources.freqPen.value,
      presPen: sources.presPen.value,
      maxTokens: sources.maxTokens.value,
    });
    expect(values.temperature).toBe(1.3);
    expect(values.presPen).toBe(-0.5);
  });

  it('池没配采样参数时一律落内容包默认', () => {
    const sources = resolveAgentLlmParamSources({ agents: {} }, 'story', defaults, undefined);
    expect(sources.temperature).toEqual({ value: 0.85, source: 'default' });
  });
});
