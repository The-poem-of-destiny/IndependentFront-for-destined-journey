/**
 * content-source.test.ts — 内容-引擎分离（波 1）纯函数层测试。
 *
 * 测试覆盖（brief T1 要求）:
 * - malformed 包全谱: 空对象 / 错 formatVersion / 坏分节形状 / 含 creative_workshop 分区书 → 不 throw，出 notes
 * - 三态语义表（absent / [] / rows 的分节解析）
 * - hash 工具: 同输入产同 hash；不同输入产不同 hash
 * - __ENGINE_VERSION__ 缺省时跳过 version 门（本波契约）
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §4 / §5.1 / §5.2 / D8 / D20
 */

import { describe, it, expect } from 'vitest';

import type { ContentPack, PackValidationNote } from './types-content';
import {
  validatePackOrThrow,
  checkEngineVersion,
  semverGte,
  hashContentDeterministic,
  hashWorldBook,
  hashPackSectionSha256,
  resolveSection,
  planPackInstall,
  CURRENT_PACK_FORMAT_VERSION,
  PLACEHOLDER_UID_RESERVED_BASE,
} from './content-source';
import type { WorldBook } from './types';

// ── fixtures ──

/** 一个最小的合法 pack（只有必读字段，无任何分节） */
function minimalPack(): ContentPack {
  return {
    formatVersion: 1,
    packId: 'test-pack',
    packVersion: '1.0.0',
  };
}

/** 一本合法的占位世界书（uid 在真实段，非 creative_workshop 分区） */
function makeBook(overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: 'world_overview',
    name: '世界总览',
    partition: 'world_setting',
    builtIn: true,
    entries: [
      {
        uid: 1,
        name: '世界设定',
        content: '通用奇幻世界。',
        enabled: true,
        key: ['世界'],
        keysecondary: [],
        selectiveLogic: 0,
        order: 0,
        position: 0,
      },
    ],
    ...overrides,
  };
}

function errorNotes(notes: PackValidationNote[]): PackValidationNote[] {
  return notes.filter((n) => n.level === 'error');
}

function hasCode(notes: PackValidationNote[], code: string): boolean {
  return notes.some((n) => n.code === code);
}

// ═══════════════════════════════════════════════════════════
// validatePackOrThrow: malformed 全谱
// ═══════════════════════════════════════════════════════════

describe('validatePackOrThrow', () => {
  it('合法最小 pack 通过（零 error note）', () => {
    const notes = validatePackOrThrow(minimalPack());
    expect(errorNotes(notes)).toHaveLength(0);
  });

  it('不 throw（即使输入是 null / 非对象）', () => {
    expect(() => validatePackOrThrow(null)).not.toThrow();
    expect(() => validatePackOrThrow(undefined)).not.toThrow();
    expect(() => validatePackOrThrow('string')).not.toThrow();
    expect(() => validatePackOrThrow(42)).not.toThrow();
  });

  it('根非对象 → 单条 not-object error，不继续校验', () => {
    const notes = validatePackOrThrow(null);
    expect(errorNotes(notes)).toHaveLength(1);
    expect(errorNotes(notes)[0].code).toBe('not-object');
  });

  it('空对象 → 缺 formatVersion / packId / packVersion 三条 error', () => {
    const notes = validatePackOrThrow({});
    const errs = errorNotes(notes);
    expect(hasCode(errs, 'bad-format-version')).toBe(true);
    expect(hasCode(errs, 'missing-pack-id')).toBe(true);
    expect(hasCode(errs, 'missing-pack-version')).toBe(true);
  });

  it('错 formatVersion（0 / 2 / 字符串）→ bad-format-version', () => {
    for (const bad of [0, 2, '1', undefined]) {
      const notes = validatePackOrThrow({ ...minimalPack(), formatVersion: bad });
      expect(hasCode(errorNotes(notes), 'bad-format-version')).toBe(true);
    }
  });

  it('合法 formatVersion = CURRENT_PACK_FORMAT_VERSION (= 1) 通过', () => {
    expect(CURRENT_PACK_FORMAT_VERSION).toBe(1);
    const notes = validatePackOrThrow({ ...minimalPack(), formatVersion: 1 });
    expect(hasCode(errorNotes(notes), 'bad-format-version')).toBe(false);
  });

  it('packId 是空串 → missing-pack-id', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), packId: '' });
    expect(hasCode(errorNotes(notes), 'missing-pack-id')).toBe(true);
  });

  it('packVersion 缺失 → missing-pack-version', () => {
    const notes = validatePackOrThrow({ packId: 'x', formatVersion: 1 });
    expect(hasCode(errorNotes(notes), 'missing-pack-version')).toBe(true);
  });

  // ── 坏分节形状 ──

  it('worldBooks 非数组 → bad-worldbooks-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: {} });
    expect(hasCode(errorNotes(notes), 'bad-worldbooks-section')).toBe(true);
  });

  it('worldBooks[*] 非对象 → bad-worldbook-row', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: ['not-an-object'] });
    expect(hasCode(errorNotes(notes), 'bad-worldbook-row')).toBe(true);
  });

  it('worldBooks[*] 缺 id → bad-worldbook-row', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      worldBooks: [{ name: 'x', partition: 'world_setting', entries: [] }],
    });
    expect(hasCode(errorNotes(notes), 'bad-worldbook-row')).toBe(true);
  });

  it('worldBooks[*].entries 非数组 → bad-worldbook-row', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      worldBooks: [{ id: 'x', name: 'x', partition: 'world_setting', entries: 'no' }],
    });
    expect(hasCode(errorNotes(notes), 'bad-worldbook-row')).toBe(true);
  });

  it('worldBooks[*].entries[*] 缺 uid → bad-worldbook-entry', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      worldBooks: [
        { id: 'x', name: 'x', partition: 'world_setting', entries: [{ name: 'e', content: 'c' }] },
      ],
    });
    expect(hasCode(errorNotes(notes), 'bad-worldbook-entry')).toBe(true);
  });

  it('presets 非数组 → bad-presets-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), presets: {} });
    expect(hasCode(errorNotes(notes), 'bad-presets-section')).toBe(true);
  });

  it('mapMarkers 非数组 → bad-mapMarkers-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), mapMarkers: {} });
    expect(hasCode(errorNotes(notes), 'bad-mapMarkers-section')).toBe(true);
  });

  it('locations 非数组 → bad-locations-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), locations: 42 });
    expect(hasCode(errorNotes(notes), 'bad-locations-section')).toBe(true);
  });

  it('agentDefaults 非对象 → bad-agent-defaults-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), agentDefaults: [] });
    expect(hasCode(errorNotes(notes), 'bad-agent-defaults-section')).toBe(true);
  });

  it('agentDefaults.version 非数值 → bad-agent-defaults-section', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      agentDefaults: { version: '1', agents: {} },
    });
    expect(hasCode(errorNotes(notes), 'bad-agent-defaults-section')).toBe(true);
  });

  it('agentDefaults.agents 非对象 → bad-agent-defaults-section', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      agentDefaults: { version: 1, agents: [] },
    });
    expect(hasCode(errorNotes(notes), 'bad-agent-defaults-section')).toBe(true);
  });

  it('beautifierRules 非对象 → bad-beautifier-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), beautifierRules: [] });
    expect(hasCode(errorNotes(notes), 'bad-beautifier-section')).toBe(true);
  });

  it('beautifierRules.rules 非数组 → bad-beautifier-section', () => {
    const notes = validatePackOrThrow({
      ...minimalPack(),
      beautifierRules: { version: 1, rules: {} },
    });
    expect(hasCode(errorNotes(notes), 'bad-beautifier-section')).toBe(true);
  });

  it('catalog 非对象 → bad-catalog-section', () => {
    const notes = validatePackOrThrow({ ...minimalPack(), catalog: [] });
    expect(hasCode(errorNotes(notes), 'bad-catalog-section')).toBe(true);
  });

  // ── creative_workshop 分区拒绝（D8）──

  it('worldBooks 含 creative_workshop 分区书 → workshop-partition-rejected (error)', () => {
    const workshopBook: WorldBook = {
      id: 'evil',
      name: '伪装成官方的工坊书',
      partition: 'creative_workshop',
      entries: [
        {
          uid: 1,
          name: 'x',
          content: 'c',
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 0,
          position: 0,
        },
      ],
    };
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: [workshopBook] });
    expect(hasCode(errorNotes(notes), 'workshop-partition-rejected')).toBe(true);
  });

  it('合法分区的书不触发 workshop-partition-rejected', () => {
    const book = makeBook({ partition: 'world_setting' });
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: [book] });
    expect(hasCode(errorNotes(notes), 'workshop-partition-rejected')).toBe(false);
  });

  // ── 占位 uid 保留段警告（D43）──

  it(`uid >= ${PLACEHOLDER_UID_RESERVED_BASE} → placeholder-uid-range (warning, 不阻断)`, () => {
    const book = makeBook();
    book.entries[0].uid = PLACEHOLDER_UID_RESERVED_BASE;
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: [book] });
    const warning = notes.find((n) => n.code === 'placeholder-uid-range');
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warning');
    // warning 不进 error 列表
    expect(errorNotes(notes).some((n) => n.code === 'placeholder-uid-range')).toBe(false);
  });

  it('uid 在真实段（< 保留段）不触发 placeholder-uid-range', () => {
    const book = makeBook();
    book.entries[0].uid = 500;
    const notes = validatePackOrThrow({ ...minimalPack(), worldBooks: [book] });
    expect(notes.some((n) => n.code === 'placeholder-uid-range')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// checkEngineVersion + semverGte
// ═══════════════════════════════════════════════════════════

describe('checkEngineVersion', () => {
  it('🔴 __ENGINE_VERSION__ 未注入时跳过版本门（本波契约）', () => {
    // vitest node 环境下 __ENGINE_VERSION__ 未注入
    const gate = checkEngineVersion('99.0.0');
    expect(gate.result).toBe('skipped');
    expect(gate.engineVersion).toBeUndefined();
  });

  it('pack 未声明 minEngineVersion → ok（无版本要求，直接放行）', () => {
    const gate = checkEngineVersion(undefined);
    expect(gate.result).toBe('ok');
  });

  it('pack 未声明 minEngineVersion 时 engineVersion 仍如实回读（未注入则 undefined）', () => {
    const gate = checkEngineVersion(undefined);
    // vitest node 环境下未注入 → undefined
    expect(gate.engineVersion).toBeUndefined();
  });
});

describe('semverGte', () => {
  it('正式版三段相等 → true', () => {
    expect(semverGte('1.0.0', '1.0.0')).toBe(true);
    expect(semverGte('2.3.4', '2.3.4')).toBe(true);
  });

  it('主版本更高 → true', () => {
    expect(semverGte('2.0.0', '1.0.0')).toBe(true);
  });

  it('主版本更低 → false', () => {
    expect(semverGte('1.5.0', '2.0.0')).toBe(false);
  });

  it('次版本更高 → true', () => {
    expect(semverGte('1.2.0', '1.1.0')).toBe(true);
  });

  it('patch 更高 → true', () => {
    expect(semverGte('1.0.5', '1.0.3')).toBe(true);
  });

  it('正式版 ≥ prerelease → true', () => {
    expect(semverGte('1.0.0', '1.0.0-beta')).toBe(true);
  });

  it('prerelease 不 ≥ 正式版 → false', () => {
    expect(semverGte('1.0.0-beta', '1.0.0')).toBe(false);
  });

  it('无法解析的版本 → false（保守拒绝）', () => {
    expect(semverGte('not-a-version', '1.0.0')).toBe(false);
    expect(semverGte('1.0.0', 'garbage')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// hash 工具
// ═══════════════════════════════════════════════════════════

describe('hashContentDeterministic', () => {
  it('同输入产同 hash', () => {
    expect(hashContentDeterministic('hello')).toBe(hashContentDeterministic('hello'));
  });

  it('不同输入产不同 hash', () => {
    expect(hashContentDeterministic('hello')).not.toBe(hashContentDeterministic('world'));
    expect(hashContentDeterministic('hello')).not.toBe(hashContentDeterministic('hello '));
    expect(hashContentDeterministic('a')).not.toBe(hashContentDeterministic('aa'));
  });

  it('空串也产合法 hash（16 位 hex）', () => {
    const h = hashContentDeterministic('');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('长度进 hash: 同前缀不同长度产不同 hash', () => {
    // 截断/追加这类「同字符集」编辑也能区分
    expect(hashContentDeterministic('abc')).not.toBe(hashContentDeterministic('abcd'));
  });
});

describe('hashWorldBook', () => {
  it('同书两次 hash 相同', () => {
    const book = makeBook();
    expect(hashWorldBook(book)).toBe(hashWorldBook(book));
  });

  it('改条目内容 → hash 变', () => {
    const b1 = makeBook();
    const b2 = makeBook();
    b2.entries[0].content = '被编辑过的内容';
    expect(hashWorldBook(b1)).not.toBe(hashWorldBook(b2));
  });

  it('条目重排 → hash 不变（按 uid 稳定排序）', () => {
    const b1: WorldBook = {
      id: 'x',
      name: 'x',
      partition: 'world_setting',
      entries: [
        {
          uid: 1,
          name: 'a',
          content: 'ca',
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 0,
          position: 0,
        },
        {
          uid: 2,
          name: 'b',
          content: 'cb',
          enabled: true,
          key: [],
          keysecondary: [],
          selectiveLogic: 0,
          order: 0,
          position: 0,
        },
      ],
    };
    const b2: WorldBook = {
      ...b1,
      entries: [b1.entries[1], b1.entries[0]], // 顺序反过来
    };
    expect(hashWorldBook(b1)).toBe(hashWorldBook(b2));
  });

  it('改书 id/name/partition → hash 不变（这些是稳定标识不进内容 hash）', () => {
    const b1 = makeBook();
    const b2: WorldBook = { ...makeBook(), id: 'different-id', name: 'different-name' };
    expect(hashWorldBook(b1)).toBe(hashWorldBook(b2));
  });
});

describe('hashPackSectionSha256', () => {
  it('返回 sha256: 前缀的 hex（在 crypto.subtle 可用的环境）', async () => {
    const h = await hashPackSectionSha256('test');
    // vitest node 环境下 crypto.subtle 通常可用（Node 18+）
    if (h !== undefined) {
      expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('同输入产同 hash', async () => {
    const a = await hashPackSectionSha256('same');
    const b = await hashPackSectionSha256('same');
    if (a !== undefined && b !== undefined) {
      expect(a).toBe(b);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// resolveSection（三态语义 D20）
// ═══════════════════════════════════════════════════════════

describe('resolveSection', () => {
  it('pack absent (undefined) → 用 placeholder', () => {
    const placeholder = [1, 2, 3];
    expect(resolveSection(undefined, placeholder)).toBe(placeholder);
  });

  it('pack 声明 [] → 返回 []（刻意清空，不回落占位）', () => {
    const placeholder = [1, 2, 3];
    expect(resolveSection([], placeholder)).toEqual([]);
    expect(resolveSection([], placeholder)).not.toBe(placeholder);
  });

  it('pack 声明 rows → 返回 pack payload（替换占位）', () => {
    const placeholder = [1, 2, 3];
    const packRows = [4, 5];
    expect(resolveSection(packRows, placeholder)).toBe(packRows);
  });

  it('两边都 absent → undefined', () => {
    expect(resolveSection(undefined, undefined)).toBeUndefined();
  });

  it('pack absent + placeholder absent → undefined（对象分节同理）', () => {
    expect(
      resolveSection(undefined as unknown as Record<string, unknown> | undefined, undefined),
    ).toBeUndefined();
  });

  it('pack 声明空对象 {} → 返回 {}（对象分节的「刻意清空」语义）', () => {
    const placeholder: Record<string, unknown> = { a: 1 };
    const result = resolveSection<Record<string, unknown>>({}, placeholder);
    expect(result).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
// planPackInstall（T1 只验骨架，T6 验四态）
// ═══════════════════════════════════════════════════════════

describe('planPackInstall (T1 skeleton)', () => {
  it('合法 pack → 返回计划，validationErrors 为空', () => {
    const plan = planPackInstall(minimalPack());
    expect(plan.validationErrors.filter((n) => n.level === 'error')).toHaveLength(0);
    expect(plan.packId).toBe('test-pack');
    expect(plan.packVersion).toBe('1.0.0');
  });

  it('malformed pack → validationErrors 非空，但仍返回计划（不 throw）', () => {
    const malformedPack = { formatVersion: 0 } as unknown as ContentPack;
    const plan = planPackInstall(malformedPack);
    expect(plan.validationErrors.filter((n) => n.level === 'error').length).toBeGreaterThan(0);
  });

  it('每个 present 分节在 sections 里有对应键（空计划骨架）', () => {
    const pack: ContentPack = {
      ...minimalPack(),
      worldBooks: [makeBook()],
      presets: [],
      beautifierRules: { version: 1, rules: [] },
      mapMarkers: [],
      locations: [],
      bloodlines: { bloodlines: [] },
    };
    const plan = planPackInstall(pack);
    expect(plan.sections.worldBooks).toBeDefined();
    expect(plan.sections.worldBooks?.added).toEqual([]);
    expect(plan.sections.worldBooks?.updated).toEqual([]);
    expect(plan.sections.worldBooks?.removed).toEqual([]);
    expect(plan.sections.worldBooks?.conflicted).toEqual([]);
    expect(plan.sections.presets).toBeDefined();
    expect(plan.sections.beautifierRules).toBeDefined();
    expect(plan.sections.mapMarkers).toBeDefined();
    expect(plan.sections.locations).toBeDefined();
    expect(plan.sections.bloodlines).toBeDefined();
  });

  it('absent 分节不出现在 sections（语义 = 别动）', () => {
    const plan = planPackInstall(minimalPack());
    expect(plan.sections.worldBooks).toBeUndefined();
    expect(plan.sections.presets).toBeUndefined();
  });

  it('agentDefaults present → agentDefaults.agentIds 收录键', () => {
    const pack: ContentPack = {
      ...minimalPack(),
      agentDefaults: {
        version: 1,
        agents: {
          story: {
            model: 'm',
            worldBookEnabled: true,
            worldBookIds: [],
            systemPrompt: '',
            template: '',
            temperature: 0.7,
            topP: 1,
            freqPen: 0,
            presPen: 0,
            maxTokens: 16384,
          },
          vars_update: {
            model: 'm',
            worldBookEnabled: false,
            worldBookIds: [],
            systemPrompt: '',
            template: '',
            temperature: 0.7,
            topP: 1,
            freqPen: 0,
            presPen: 0,
            maxTokens: 16384,
          },
        },
      },
    };
    const plan = planPackInstall(pack);
    expect(plan.agentDefaults?.agentIds).toEqual(expect.arrayContaining(['story', 'vars_update']));
  });

  it('branding present → branding.declaredKeys 收录子字段名', () => {
    const pack: ContentPack = {
      ...minimalPack(),
      branding: { appTitle: 'X', era: '元年' },
    };
    const plan = planPackInstall(pack);
    expect(plan.branding?.declaredKeys).toEqual(expect.arrayContaining(['appTitle', 'era']));
  });

  it('worldBooks present → saveUidMigration 占位存在（T6/T43 填）', () => {
    const plan = planPackInstall({ ...minimalPack(), worldBooks: [makeBook()] });
    expect(plan.saveUidMigration).toBeDefined();
    expect(plan.saveUidMigration?.rewrite).toEqual({});
    expect(plan.saveUidMigration?.needsSelectionPartitions).toEqual([]);
  });

  it('无 worldBooks → 不出 saveUidMigration', () => {
    const plan = planPackInstall(minimalPack());
    expect(plan.saveUidMigration).toBeUndefined();
  });

  it('🔴 四态逻辑尚未实现: present 分节的 added/updated 均为空（T6 填）', () => {
    // 这是 T1 的骨架契约 —— T6 落地后此断言会变红，提示移除
    const plan = planPackInstall({ ...minimalPack(), worldBooks: [makeBook()] });
    expect(plan.sections.worldBooks?.added).toEqual([]);
    expect(plan.sections.worldBooks?.updated).toEqual([]);
    expect(plan.sections.worldBooks?.conflicted).toEqual([]);
  });
});
