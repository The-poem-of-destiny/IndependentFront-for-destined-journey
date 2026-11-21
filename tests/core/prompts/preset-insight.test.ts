/**
 * preset-insight 测试：预设生效总览 + 逐条 token 估算
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPresetEntryToggles,
  readPresetGroups,
  selectPresetGroupOption,
} from '../../../src/core/prompts/preset-groups';
import { summarizePresetEntries } from '../../../src/core/prompts/preset-insight';
import {
  assemblePresetContent,
  listActivePresetPrompts,
} from '../../../src/core/prompts/preset-loader';
import { setEngineSettingsProvider } from '../../../src/core/runtime/engine-settings';
import { estimateTokens } from '../../../src/core/utils/token-estimate';
import type { AgentPreset, ChatPreset } from '../../../src/core/types/types';

type Prompt = Record<string, unknown>;

function makePreset(prompts: Prompt[], extra: Record<string, unknown> = {}): AgentPreset {
  return {
    id: 'p',
    name: 'p',
    fixedSystem: '',
    fixedExamples: '',
    settings: { prompts, ...extra },
  } as unknown as AgentPreset;
}

const setNsfw = (value: boolean) => setEngineSettingsProvider(() => ({ nsfwContent: value }));

afterEach(() => setEngineSettingsProvider(undefined));

function row(preset: AgentPreset, id: string) {
  const found = summarizePresetEntries(preset).entries.find((e) => e.identifier === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

describe('estimateTokens', () => {
  it('字符数 / 1.5 向上取整', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(2);
    expect(estimateTokens('abcd')).toBe(3);
  });
});

describe('listActivePresetPrompts', () => {
  it('与 assemblePresetContent 同口径：自身 enabled、排除 assistant 与五区占位、按 injection_order 排序', () => {
    const prompts = [
      { identifier: 'b', content: 'B', injection_order: 20 },
      { identifier: 'a', content: 'A', injection_order: 10 },
      { identifier: 'off', content: 'X', enabled: false, injection_order: 5 },
      { identifier: 'asst', role: 'assistant', content: 'Y', injection_order: 1 },
      { identifier: 'story_zone_1', content: '', injection_order: 0 },
      null,
    ];
    expect(listActivePresetPrompts<Prompt>(prompts).map((p) => p.identifier)).toEqual(['a', 'b']);
    // 引擎输出顺序与之一致
    expect(assemblePresetContent(makePreset(prompts as Prompt[]), '').startsWith('A\nB')).toBe(
      true,
    );
  });
});

describe('summarizePresetEntries', () => {
  it('逐条之和恒等于 totalTokens，并统计生效数', () => {
    const preset = makePreset([
      { identifier: 'a', content: '你好世界，这是一段正文。', injection_order: 10 },
      { identifier: 'b', content: '{{setvar::x::一二三四五六}}', injection_order: 20 },
      { identifier: 'c', content: '读：{{getvar::x}} 再读 {{getvar::x}}', injection_order: 30 },
      { identifier: 'd', content: '关掉的', enabled: false, injection_order: 40 },
      { identifier: 'e', content: '{{LORE_BOOK_STATIC}}{{// 注释}}', injection_order: 50 },
    ]);
    const s = summarizePresetEntries(preset);
    expect(s.totalCount).toBe(5);
    expect(s.activeCount).toBe(4);
    expect(s.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(s.totalTokens);
    // setvar 值归因：6 字 → 4 token，被读 2 次
    expect(row(preset, 'b').tokens).toBe(8);
    expect(row(preset, 'b').defines).toEqual(['x']);
    // 读取方 getvar 按空串计
    expect(row(preset, 'c').tokens).toBe(estimateTokens('读： 再读 '));
    // 系统占位符与注释宏记 0
    expect(row(preset, 'e').tokens).toBe(0);
    // 未生效：tokens 0，tokensIfEnabled 为自身成本
    const d = row(preset, 'd');
    expect(d).toMatchObject({ active: false, inactiveReason: 'disabled', tokens: 0 });
    expect(d.tokensIfEnabled).toBe(estimateTokens('关掉的'));
  });

  it('被后面的 setvar 覆盖的定义记 0 并标 overridden', () => {
    const preset = makePreset([
      { identifier: 'first', content: '{{setvar::v::很长很长的旧值}}', injection_order: 10 },
      { identifier: 'second', content: '{{setvar::v::新值}}', injection_order: 20 },
      { identifier: 'reader', content: '{{getvar::v}}', injection_order: 30 },
    ]);
    const first = row(preset, 'first');
    expect(first).toMatchObject({ active: true, tokens: 0, overridden: true, unread: false });
    const second = row(preset, 'second');
    expect(second).toMatchObject({ tokens: estimateTokens('新值'), overridden: false });
    const s = summarizePresetEntries(preset);
    expect(s.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(s.totalTokens);
    // 引擎实际用的是后者
    const assembled = assemblePresetContent(preset, '');
    expect(assembled).toContain('新值');
    expect(assembled).not.toContain('旧值');
  });

  it('没人读取的变量记 0 并标 unread', () => {
    const preset = makePreset([
      { identifier: 'def', content: '{{setvar::lonely::没有人读我}}', injection_order: 10 },
      { identifier: 'other', content: '正文', injection_order: 20 },
      // 读取方未启用 → 不计读取次数
      { identifier: 'off', content: '{{getvar::lonely}}', enabled: false, injection_order: 30 },
    ]);
    expect(row(preset, 'def')).toMatchObject({ tokens: 0, unread: true, overridden: false });
    // 假如启用读取方：它自身文本为空，变量成本仍归 def
    expect(row(preset, 'off').tokensIfEnabled).toBe(0);
  });

  it('未生效的 setvar 条目：tokensIfEnabled 计入它会生效的变量成本', () => {
    const preset = makePreset([
      { identifier: 'opt', content: '{{setvar::b::四千字}}', enabled: false, injection_order: 10 },
      { identifier: 'cot', content: '预算 {{getvar::b}}', injection_order: 20 },
    ]);
    const opt = row(preset, 'opt');
    expect(opt.tokens).toBe(0);
    expect(opt.tokensIfEnabled).toBe(estimateTokens('四千字'));
  });

  it('random 取最长一项', () => {
    const preset = makePreset([
      { identifier: 'r', content: '{{random::短,长一点的,中等}}', injection_order: 10 },
    ]);
    expect(row(preset, 'r').tokens).toBe(estimateTokens('长一点的'));
  });

  it('nsfw 条目：开关关闭时 inactiveReason=nsfw，打开后生效', () => {
    const prompts = [
      { identifier: 'n', content: '露骨内容', nsfw: true, injection_order: 10 },
      {
        identifier: 'both',
        content: '关掉的露骨',
        nsfw: true,
        enabled: false,
        injection_order: 20,
      },
      { identifier: 'inline', content: '前<nsfw>露骨</nsfw>后', injection_order: 30 },
    ];
    setNsfw(false);
    const off = makePreset(prompts);
    expect(row(off, 'n')).toMatchObject({ active: false, inactiveReason: 'nsfw', tokens: 0 });
    expect(row(off, 'n').tokensIfEnabled).toBe(estimateTokens('露骨内容'));
    expect(row(off, 'both').inactiveReason).toBe('disabled');
    expect(row(off, 'inline').tokens).toBe(estimateTokens('前后'));
    expect(summarizePresetEntries(off).activeCount).toBe(1);

    setNsfw(true);
    expect(row(off, 'n')).toMatchObject({ active: true, inactiveReason: null });
    expect(row(off, 'inline').tokens).toBe(estimateTokens('前露骨后'));
    expect(summarizePresetEntries(off).activeCount).toBe(2);
  });

  it('assistant 条目只在末尾预填充生效时单独列出', () => {
    const prompts = [
      { identifier: 'a', content: '正文', injection_order: 10 },
      { identifier: 'tail', role: 'assistant', content: '前缀续写', injection_order: 99 },
    ];
    const without = summarizePresetEntries(makePreset(prompts));
    expect(without.entries.map((e) => e.identifier)).toEqual(['a']);

    const withPrefill = summarizePresetEntries(makePreset(prompts, { prefill: { enabled: true } }));
    const tail = withPrefill.entries.find((e) => e.identifier === 'tail');
    expect(tail).toMatchObject({ active: true, prefill: true, tokens: estimateTokens('前缀续写') });
    expect(withPrefill.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(withPrefill.totalTokens);
  });

  it('不是条目数组时返回空总览', () => {
    const s = summarizePresetEntries({
      id: 'x',
      name: 'x',
      fixedSystem: 'sys',
      fixedExamples: '',
    } as AgentPreset);
    expect(s).toEqual({ entries: [], activeCount: 0, totalCount: 0, totalTokens: 0 });
  });
});

describe('互斥组成员的 tokensIfEnabled', () => {
  // 六份出厂预设的人称组结构：三条各自 setvar 同一个变量，后面的写作规范条目 getvar 读取
  const FIRST = '以第一人称“我”叙述主角的所见所感，内心独白直接写出。';
  const SECOND = '以第二人称“你”称呼主角，让玩家代入角色的视角与行动。';
  const THIRD = '以第三人称有限视角叙述，镜头贴着主角，不越界写他人心理。';
  function personPreset(): AgentPreset {
    return makePreset(
      [
        {
          identifier: 'p1',
          name: '第一人称',
          content: `{{setvar::pov::${FIRST}}}`,
          enabled: false,
          injection_order: 10,
        },
        {
          identifier: 'p2',
          name: '第二人称',
          content: `{{setvar::pov::${SECOND}}}`,
          enabled: false,
          injection_order: 11,
        },
        {
          identifier: 'p3',
          name: '第三人称',
          content: `{{setvar::pov::${THIRD}}}`,
          enabled: true,
          injection_order: 12,
        },
        { identifier: 'body', content: '叙述要求：{{getvar::pov}}', injection_order: 50 },
        { identifier: 'cot', content: '检查人称：{{getvar::pov}}', injection_order: 60 },
      ],
      {
        extensions: {
          poem: {
            groups: [
              {
                id: 'pov',
                label: '人称',
                options: [
                  { identifier: 'p1', label: '第一人称' },
                  { identifier: 'p2', label: '第二人称' },
                  { identifier: 'p3', label: '第三人称' },
                ],
              },
            ],
          },
        },
      },
    );
  }
  const cost = (text: string) => estimateTokens(text) * 2;

  it('默认状态下三项都按「本条成为生效定义」计，量级相近', () => {
    const preset = personPreset();
    expect(row(preset, 'p1')).toMatchObject({ active: false, tokensIfEnabled: cost(FIRST) });
    expect(row(preset, 'p2')).toMatchObject({ active: false, tokensIfEnabled: cost(SECOND) });
    expect(row(preset, 'p3')).toMatchObject({ active: true, tokens: cost(THIRD) });
    const values = ['p1', 'p2', 'p3'].map((id) => row(preset, id).tokensIfEnabled);
    for (const v of values) expect(v).toBeGreaterThan(0);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.5);
  });

  it('切换选项后数值依然正确', () => {
    const base = personPreset() as unknown as ChatPreset;
    const [group] = readPresetGroups(base);
    const patch = selectPresetGroupOption(base, group, 'p1');
    const switched = applyPresetEntryToggles(base, patch) as unknown as AgentPreset;
    expect(row(switched, 'p1')).toMatchObject({ active: true, tokens: cost(FIRST) });
    expect(row(switched, 'p2')).toMatchObject({ active: false, tokensIfEnabled: cost(SECOND) });
    expect(row(switched, 'p3')).toMatchObject({ active: false, tokensIfEnabled: cost(THIRD) });
    const s = summarizePresetEntries(switched);
    expect(s.entries.reduce((sum, e) => sum + e.tokens, 0)).toBe(s.totalTokens);
  });

  it('非组条目口径不变：被更后面的已启用定义覆盖时仍记 0', () => {
    const preset = makePreset([
      {
        identifier: 'early',
        content: '{{setvar::v::早期定义}}',
        enabled: false,
        injection_order: 10,
      },
      { identifier: 'late', content: '{{setvar::v::后来}}', injection_order: 20 },
      { identifier: 'reader', content: '{{getvar::v}}', injection_order: 30 },
    ]);
    expect(row(preset, 'early').tokensIfEnabled).toBe(0);
  });
});
