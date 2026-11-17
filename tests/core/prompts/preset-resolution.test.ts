/**
 * 预设目录与生效预设解析（preset-resolution）
 *
 * 守的是「空或失效的选择永远落到内容默认，绝不解析出空白预设」这条契约，
 * 以及归一只清「与默认等价」的值、不清暂时缺席的 id。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPresetCatalog,
  builtinDirectPresets,
  copyScopeFor,
  normalizePresetSelection,
  PLACEHOLDER_STORY_PRESET_ID,
  presetScopeMatches,
  resolveEffectivePreset,
  type PresetAgentDefaults,
  type PresetProfile,
  type PresetScope,
} from '../../../src/core/prompts/preset-resolution';
import { DIRECT_CACHED_PRESET_ID, DIRECT_PRESET_ID } from '../../../src/core/prompts/direct-prompt';
import type { ChatPreset } from '../../../src/core/types/types';

function preset(id: string, extra: Partial<ChatPreset> = {}): ChatPreset {
  return {
    id,
    name: `预设 ${id}`,
    settings: { prompts: [] },
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

function catalogOf(
  storedRows: ChatPreset[],
  agentDefaults: PresetAgentDefaults = {},
  contentOwnedIds: string[] = [],
) {
  return buildPresetCatalog({
    storedRows,
    agentDefaults,
    builtins: builtinDirectPresets(),
    contentOwnedIds,
  });
}

describe('buildPresetCatalog', () => {
  it('存储行优先于同 id 的内嵌默认；内嵌与内置缺席时补上', () => {
    const edited = preset('story-a', { name: '玩家改过的' });
    const defaults = { story: { presetId: 'story-a', preset: preset('story-a') } };
    const catalog = catalogOf([edited], defaults);
    expect(catalog.filter((e) => e.preset.id === 'story-a')).toHaveLength(1);
    expect(catalog.find((e) => e.preset.id === 'story-a')?.preset.name).toBe('玩家改过的');
    expect(catalog.map((e) => e.preset.id)).toEqual(
      expect.arrayContaining([DIRECT_PRESET_ID, DIRECT_CACHED_PRESET_ID]),
    );
  });

  it('来源与只读：内置 → builtin，内容拥有/默认层引用 → content，其余 → user', () => {
    const catalog = catalogOf(
      [preset('pack-x'), preset('mine'), preset(PLACEHOLDER_STORY_PRESET_ID)],
      { story: { presetId: 'story-a', preset: preset('story-a') } },
      ['pack-x'],
    );
    const by = (id: string) => catalog.find((e) => e.preset.id === id)!;
    expect(by(DIRECT_PRESET_ID)).toMatchObject({
      origin: 'builtin',
      scope: 'direct',
      readonly: true,
    });
    expect(by('pack-x')).toMatchObject({ origin: 'content', scope: 'story', readonly: true });
    expect(by('story-a')).toMatchObject({ origin: 'content', scope: 'story' });
    expect(by(PLACEHOLDER_STORY_PRESET_ID)).toMatchObject({ origin: 'content' });
    expect(by('mine')).toMatchObject({ origin: 'user', readonly: false });
    expect(by('mine').scope).toBeUndefined();
  });

  it('直出默认引用的内容预设归 direct；行自带 scope 时以行为准', () => {
    const catalog = catalogOf([preset('mine-direct', { scope: 'direct' })], {
      direct_main: { presetId: 'pack-direct', preset: preset('pack-direct') },
    });
    expect(catalog.find((e) => e.preset.id === 'pack-direct')?.scope).toBe('direct');
    const mine = catalog.find((e) => e.preset.id === 'mine-direct')!;
    expect(mine).toMatchObject({ origin: 'user', scope: 'direct' });
  });
});

describe('resolveEffectivePreset', () => {
  const storyDefaults = { story: { presetId: 'story-a', preset: preset('story-a') } };

  it('空选择 → 内容默认，followsDefault', () => {
    const r = resolveEffectivePreset({
      profile: 'story',
      selection: '',
      agentDefaults: storyDefaults,
      catalog: catalogOf([], storyDefaults),
    });
    expect(r).toMatchObject({
      presetId: 'story-a',
      source: 'content-default',
      followsDefault: true,
      staleSelection: false,
    });
    expect(r.preset?.id).toBe('story-a');
  });

  it('失效选择 → 默认，并报告 staleSelection', () => {
    const r = resolveEffectivePreset({
      profile: 'story',
      selection: 'deleted',
      agentDefaults: storyDefaults,
      catalog: catalogOf([], storyDefaults),
    });
    expect(r).toMatchObject({ presetId: 'story-a', followsDefault: true, staleSelection: true });
  });

  it('有效选择 → 用它；等于默认 id 时仍算跟随默认', () => {
    const catalog = catalogOf([preset('mine')], storyDefaults);
    expect(
      resolveEffectivePreset({
        profile: 'story',
        selection: 'mine',
        agentDefaults: storyDefaults,
        catalog,
      }),
    ).toMatchObject({ presetId: 'mine', source: 'selection', followsDefault: false });
    expect(
      resolveEffectivePreset({
        profile: 'story',
        selection: 'story-a',
        agentDefaults: storyDefaults,
        catalog,
      }),
    ).toMatchObject({ presetId: 'story-a', source: 'selection', followsDefault: true });
  });

  it('包的 agentDefaults.story.presetId 与 presets[0] 不同 → 以 agentDefaults 为准', () => {
    const defaults = { story: { presetId: 'pack-main' } };
    const catalog = catalogOf([preset('pack-first'), preset('pack-main')], defaults, [
      'pack-first',
      'pack-main',
    ]);
    const r = resolveEffectivePreset({
      profile: 'story',
      selection: '',
      agentDefaults: defaults,
      catalog,
    });
    expect(r.presetId).toBe('pack-main');
  });

  it('只带 presets 分节的包（默认层无 story 默认）→ 第一条内容 story 预设', () => {
    const catalog = catalogOf([preset('mine'), preset('pack-first')], {}, ['pack-first']);
    const r = resolveEffectivePreset({
      profile: 'story',
      selection: '',
      agentDefaults: {},
      catalog,
    });
    expect(r).toMatchObject({ presetId: 'pack-first', source: 'content-default' });
  });

  it('什么都没有 → none，不编造预设', () => {
    const r = resolveEffectivePreset({ profile: 'story', selection: 'x', catalog: catalogOf([]) });
    expect(r).toMatchObject({ presetId: '', preset: null, source: 'none', staleSelection: true });
  });

  it.each([
    ['direct', DIRECT_PRESET_ID],
    ['direct_cached', DIRECT_CACHED_PRESET_ID],
  ] as const)('%s 无内容默认 → 对应内置预设', (profile, builtinId) => {
    const r = resolveEffectivePreset({
      profile,
      selection: '',
      agentDefaults: {},
      catalog: catalogOf([]),
    });
    expect(r).toMatchObject({ presetId: builtinId, source: 'builtin-default' });
  });

  it('direct_cached 有内容默认 → 用内容默认', () => {
    const defaults = { direct_cached: { presetId: 'pack-cached', preset: preset('pack-cached') } };
    const r = resolveEffectivePreset({
      profile: 'direct_cached',
      selection: '',
      agentDefaults: defaults,
      catalog: catalogOf([], defaults),
    });
    expect(r).toMatchObject({ presetId: 'pack-cached', source: 'content-default' });
  });

  it('作用域过滤：story 预设不能被直出选中，直出预设不能被 story 选中；无 scope 的玩家预设两边都行', () => {
    const catalog = catalogOf([preset('pack-story'), preset('mine')], {}, ['pack-story']);
    const direct = resolveEffectivePreset({
      profile: 'direct',
      selection: 'pack-story',
      agentDefaults: {},
      catalog,
    });
    expect(direct).toMatchObject({ presetId: DIRECT_PRESET_ID, staleSelection: true });
    const story = resolveEffectivePreset({
      profile: 'story',
      selection: DIRECT_PRESET_ID,
      agentDefaults: {},
      catalog,
    });
    expect(story).toMatchObject({ presetId: 'pack-story', staleSelection: true });
    for (const profile of ['story', 'direct', 'direct_cached'] as const) {
      expect(
        resolveEffectivePreset({ profile, selection: 'mine', agentDefaults: {}, catalog }).presetId,
      ).toBe('mine');
    }
  });

  it('钉死在 direct_cached 的预设在 direct 下被选中 → staleSelection，回落默认', () => {
    const catalog = catalogOf([preset('pin-cached', { scope: 'direct_cached' })]);
    const r = resolveEffectivePreset({
      profile: 'direct',
      selection: 'pin-cached',
      agentDefaults: {},
      catalog,
    });
    expect(r).toMatchObject({
      presetId: DIRECT_PRESET_ID,
      staleSelection: true,
      followsDefault: true,
      source: 'builtin-default',
    });
    const cached = resolveEffectivePreset({
      profile: 'direct_cached',
      selection: 'pin-cached',
      agentDefaults: {},
      catalog,
    });
    expect(cached).toMatchObject({ presetId: 'pin-cached', staleSelection: false });
  });

  it('旧版 scope=direct 的玩家行在两种直出下都生效（免迁移），story 下不生效', () => {
    const catalog = catalogOf([preset('legacy', { scope: 'direct' })]);
    for (const profile of ['direct', 'direct_cached'] as const) {
      expect(
        resolveEffectivePreset({ profile, selection: 'legacy', agentDefaults: {}, catalog }),
      ).toMatchObject({ presetId: 'legacy', staleSelection: false });
    }
    expect(
      resolveEffectivePreset({ profile: 'story', selection: 'legacy', agentDefaults: {}, catalog })
        .staleSelection,
    ).toBe(true);
  });
});

describe('presetScopeMatches', () => {
  const table: Array<[PresetScope | undefined, Record<PresetProfile, boolean>]> = [
    [undefined, { story: true, direct: true, direct_cached: true }],
    ['story', { story: true, direct: false, direct_cached: false }],
    ['direct', { story: false, direct: true, direct_cached: true }],
    ['direct_main', { story: false, direct: true, direct_cached: false }],
    ['direct_cached', { story: false, direct: false, direct_cached: true }],
  ];
  it.each(table)('scope=%s 的可见性', (scope, expected) => {
    for (const profile of ['story', 'direct', 'direct_cached'] as const) {
      expect(presetScopeMatches(scope, profile)).toBe(expected[profile]);
    }
  });
});

describe('copyScopeFor', () => {
  it('来源钉死在单一直出方式 → 保留原 scope', () => {
    expect(copyScopeFor({ scope: 'direct_main' }, 'direct')).toBe('direct_main');
    expect(copyScopeFor({ scope: 'direct_cached' }, 'direct_cached')).toBe('direct_cached');
  });

  it('其余来源 → 按当前生成方式取 profileScope', () => {
    expect(copyScopeFor({}, 'story')).toBe('story');
    expect(copyScopeFor({}, 'direct_cached')).toBe('direct');
    expect(copyScopeFor({ scope: 'direct' }, 'direct')).toBe('direct');
    expect(copyScopeFor({ scope: 'story' }, 'story')).toBe('story');
  });
});

describe('normalizePresetSelection', () => {
  const defaults = { story: { presetId: 'pack-main', preset: preset('pack-main') } };
  const catalog = catalogOf([preset('mine'), preset(PLACEHOLDER_STORY_PRESET_ID)], defaults);
  const norm = (profile: 'story' | 'direct' | 'direct_cached', selection: string) =>
    normalizePresetSelection({ profile, selection, agentDefaults: defaults, catalog });

  it('等于默认链结果 → 空串', () => {
    expect(norm('story', 'pack-main')).toBe('');
    expect(norm('direct', DIRECT_PRESET_ID)).toBe('');
  });

  it('不再是默认的遗留占位 story 预设 → 空串', () => {
    expect(norm('story', PLACEHOLDER_STORY_PRESET_ID)).toBe('');
  });

  it('🔴 内容包自带直出默认时，显式选中的引擎内置预设保留（仍可选）', () => {
    const withDirect = {
      ...defaults,
      direct_main: { presetId: 'pack-direct', preset: preset('pack-direct', { scope: 'direct' }) },
    };
    const cat = catalogOf([preset('mine')], withDirect);
    const r = (selection: string) =>
      normalizePresetSelection({
        profile: 'direct',
        selection,
        agentDefaults: withDirect,
        catalog: cat,
      });
    expect(r(DIRECT_PRESET_ID)).toBe(DIRECT_PRESET_ID);
    expect(r('pack-direct')).toBe('');
    // 选中之后读取侧确实解析到内置那份
    expect(
      resolveEffectivePreset({
        profile: 'direct',
        selection: DIRECT_PRESET_ID,
        agentDefaults: withDirect,
        catalog: cat,
      }).presetId,
    ).toBe(DIRECT_PRESET_ID);
  });

  it('🔴 只是暂时不在目录里的 id 不清（受保护包锁定时会缺席）', () => {
    expect(norm('story', 'locked-pack-preset')).toBe('locked-pack-preset');
  });

  it('玩家自己的有效选择原样保留；空串保持空串；幂等', () => {
    expect(norm('story', 'mine')).toBe('mine');
    expect(norm('story', '')).toBe('');
    expect(norm('story', norm('story', 'pack-main'))).toBe('');
  });
});
