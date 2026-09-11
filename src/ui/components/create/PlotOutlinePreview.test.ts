/**
 * PlotOutlinePreview.vue — 大纲预览流式统计显示
 *
 * 回归钉（2026-09-10）：推理模型先流思维链时，界面必须离开 connecting、
 * 显示「模型思考中」与思维链字数，而不是冻在「正在连接模型」。
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PlotOutlinePreview from './PlotOutlinePreview.vue';

type Stats = {
  phase: 'connecting' | 'thinking' | 'streaming';
  round: number;
  chars: number;
  reasoningChars: number;
  charsPerSec: number;
  estimatedTotal: number;
  estimatedRemainingSec: number | null;
  elapsedSec: number;
};

function stats(over: Partial<Stats>): Stats {
  return {
    phase: 'connecting',
    round: 1,
    chars: 0,
    reasoningChars: 0,
    charsPerSec: 0,
    estimatedTotal: 5000,
    estimatedRemainingSec: null,
    elapsedSec: 0,
    ...over,
  };
}

function mountWith(streamStats: Stats | null) {
  return mount(PlotOutlinePreview, {
    props: { outline: null, chapters: [], isGenerating: true, revealed: false, streamStats },
  });
}

describe('PlotOutlinePreview 流式统计', () => {
  it('connecting：只显示连接提示', () => {
    const w = mountWith(stats({ phase: 'connecting' }));
    expect(w.text()).toContain('正在连接模型');
    expect(w.text()).not.toContain('模型思考中');
  });

  it('thinking：显示思维链字数与思考中，且不显示轮次', () => {
    const w = mountWith(stats({ phase: 'thinking', reasoningChars: 1234 }));
    expect(w.text()).toContain('模型思考中');
    expect(w.text()).toContain('思维链 1,234 字');
    expect(w.text()).not.toContain('正在连接模型');
    expect(w.text()).not.toContain('第 1 轮');
  });

  it('streaming：显示轮次、正文/思维链字数与剩余时间', () => {
    const w = mountWith(
      stats({
        phase: 'streaming',
        chars: 800,
        reasoningChars: 600,
        charsPerSec: 40,
        estimatedRemainingSec: 90,
      }),
    );
    expect(w.text()).toContain('第 1 轮');
    expect(w.text()).toContain('正文 800 字');
    expect(w.text()).toContain('思维链 600 字');
    expect(w.text()).toContain('预计剩余 1 分 30 秒');
  });

  it('无统计对象时回退到通用等待文案', () => {
    const w = mountWith(null);
    expect(w.text()).toContain('AI 正在生成剧情大纲');
  });
});
