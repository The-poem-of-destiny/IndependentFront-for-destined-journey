/**
 * 露骨内容开关的接线测试（设计：docs/planning/2026-11-20-explicit-content-switch-design.md）。
 * 纯函数语义见 nsfw-filter.test.ts；这里验证各落点确实按开关过滤。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filterNsfwBooks,
  filterNsfwMessages,
  isPresetPromptActive,
  nsfwEnabled,
} from '../../../src/core/content/nsfw-filter';
import { setEngineSettingsProvider } from '../../../src/core/runtime/engine-settings';
import {
  clearEjsCompileCache,
  prerenderWorldBookEntries,
  renderWorldBookEntries,
} from '../../../src/core/content/worldbook-loader';
import { assemblePresetContent } from '../../../src/core/prompts/preset-loader';
import { validateLoreProtocol } from '../../../src/core/content/lore-protocol';
import { validatePackOrThrow } from '../../../src/core/content/content-source';
import { availableCharacterDefinitions } from '../../../src/core/character/character-definitions';
import { effectiveMaxRating } from '../../../src/core/image/image-prompt';
import type { AgentPreset, WorldBook, WorldBookEntry } from '../../../src/core/types/types';

function entry(slug: string, overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    uid: `fated:world_setting/${slug}`,
    name: slug,
    content: `${slug} 正文`,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
    ...overrides,
  };
}

function book(entries: WorldBookEntry[]): WorldBook {
  return { id: 'world_setting', name: '世界', partition: 'world_setting', entries };
}

const setNsfw = (value: boolean) => setEngineSettingsProvider(() => ({ nsfwContent: value }));

afterEach(() => setEngineSettingsProvider(undefined));

describe('开关缺省', () => {
  it('未接 provider 时按关处理（安全默认）', () => {
    setEngineSettingsProvider(undefined);
    expect(nsfwEnabled()).toBe(false);
  });
});

describe('filterNsfwBooks', () => {
  const flagged = entry('flagged', { extra: { lore: { nsfw: true, audiences: ['story'] } } });
  const dependent = entry('dependent', {
    extra: {
      lore: {
        audiences: ['story'],
        summary: '摘要<nsfw>露骨</nsfw>',
        dependsOn: [flagged.uid, 'fated:world_setting/other'],
      },
    },
  });
  const books = [book([flagged, dependent])];

  it('关：剔除整条标记条目、去掉指向它的依赖边、过滤摘要', () => {
    const [out] = filterNsfwBooks(books, false);
    expect(out.entries.map((e) => e.uid)).toEqual([dependent.uid]);
    expect(out.entries[0].extra?.lore?.dependsOn).toEqual(['fated:world_setting/other']);
    expect(out.entries[0].extra?.lore?.summary).toBe('摘要');
  });

  it('开：条目全保留，只剥摘要里的标签', () => {
    const [out] = filterNsfwBooks(books, true);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[1].extra?.lore?.summary).toBe('摘要露骨');
  });

  it('不改入参；无变化时返回同一个数组', () => {
    filterNsfwBooks(books, false);
    expect(books[0].entries).toHaveLength(2);
    const clean = [book([entry('a')])];
    expect(filterNsfwBooks(clean, false)).toBe(clean);
  });
});

describe('世界书渲染（EJS 之后逐条过滤）', () => {
  beforeEach(() => clearEjsCompileCache());
  const entries = [
    entry('static', { content: '静态<nsfw>甲</nsfw><sfw>乙</sfw>', order: 1 }),
    entry('dyn', { content: '<% if (true) { %><nsfw>丙</nsfw>丁<% } %>', order: 2 }),
    // 坏块只影响自己这一条，不吞后一条
    entry('broken', { content: '坏<nsfw>戊', order: 3 }),
    entry('after', { content: '后一条', order: 4 }),
  ];
  const ctx = { stats: {}, vars: {}, historyText: '' };

  it('关：同步渲染路径', () => {
    setNsfw(false);
    const result = renderWorldBookEntries(entries, ctx);
    const all = `${result.staticText}\n${result.dynamicText}`;
    expect(all).toContain('静态乙');
    expect(all).toContain('后一条');
    for (const hidden of ['甲', '丙', '戊', '<nsfw>', '<sfw>']) expect(all).not.toContain(hidden);
    expect(result.entryTexts.get(entries[0])).toBe('静态乙');
  });

  it('开：异步预渲染路径，标签剥掉、内容保留', async () => {
    setNsfw(true);
    const result = await prerenderWorldBookEntries(entries, ctx);
    const all = `${result.staticText}\n${result.dynamicText}`;
    expect(all).toContain('静态甲');
    expect(all).toContain('丙丁');
    expect(all).not.toMatch(/<\/?s?n?sfw>/);
  });
});

describe('预设条目', () => {
  const preset = {
    id: 'p',
    name: 'p',
    settings: {
      prompts: [
        { identifier: 'a', content: '通用规则', enabled: true, injection_order: 1 },
        { identifier: 'b', content: '露骨规则', enabled: true, nsfw: true, injection_order: 2 },
      ],
    },
  } as unknown as AgentPreset;

  it('关：nsfw: true 的条目不参与组装', () => {
    setNsfw(false);
    expect(isPresetPromptActive({ enabled: true, nsfw: true })).toBe(false);
    const text = assemblePresetContent(preset) ?? '';
    expect(text).toContain('通用规则');
    expect(text).not.toContain('露骨规则');
  });

  it('开：照常组装；enabled: false 仍然不组装', () => {
    setNsfw(true);
    expect(assemblePresetContent(preset) ?? '').toContain('露骨规则');
    expect(isPresetPromptActive({ enabled: false, nsfw: true })).toBe(false);
  });
});

describe('LLM 消息出口', () => {
  it('只改字符串 content，native 原样保留', () => {
    const native = { blocks: [{ type: 'thinking', signature: 'sig' }] };
    const messages = [
      { role: 'system', content: 'A<nsfw>B</nsfw>' },
      { role: 'assistant', content: null, native },
    ];
    const out = filterNsfwMessages(messages, false);
    expect(out[0].content).toBe('A');
    expect(out[1]).toBe(messages[1]);
  });
});

describe('校验', () => {
  it('extra.lore.nsfw 进白名单且必须是布尔', () => {
    const ok = [book([entry('x', { extra: { lore: { nsfw: true, audiences: ['story'] } } })])];
    expect(validateLoreProtocol(ok)).toEqual([]);
    const bad = [book([entry('x', { extra: { lore: { nsfw: 'yes' as never } } })])];
    expect(validateLoreProtocol(bad).join('\n')).toContain('invalid nsfw');
  });

  it('内容包里写坏的标记只出 warning，不拦装包', () => {
    const notes = validatePackOrThrow({
      formatVersion: 1,
      packId: 'p',
      packVersion: '1.0.0',
      worldBooks: [book([entry('x', { content: '<nsfw>未闭合' })])],
    });
    const nsfwNotes = notes.filter((n) => n.code === 'bad-nsfw-markup');
    expect(nsfwNotes.length).toBe(1);
    expect(nsfwNotes[0].level).toBe('warning');
  });
});

describe('角色候选', () => {
  it('关：nsfw: true 的角色定义不进候选', async () => {
    const { installContentRegistry, createEmptyContentRegistry } =
      await import('../../../src/core/content/content-registry-runtime');
    installContentRegistry({
      ...createEmptyContentRegistry(),
      characters: [
        { id: 'a', name: '甲', profile: {}, assets: [], past: [] },
        { id: 'b', name: '乙', profile: {}, assets: [], past: [], nsfw: true },
      ],
    });
    setNsfw(false);
    expect(availableCharacterDefinitions([]).map((d) => d.name)).toEqual(['甲']);
    setNsfw(true);
    expect(availableCharacterDefinitions([]).map((d) => d.name)).toEqual(['甲', '乙']);
  });
});

describe('图像分级上限', () => {
  it('关：钳到 sensitive；开：原样', () => {
    expect(effectiveMaxRating('explicit', false)).toBe('sensitive');
    expect(effectiveMaxRating('general', false)).toBe('general');
    expect(effectiveMaxRating('explicit', true)).toBe('explicit');
  });
});
