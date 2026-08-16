/**
 * content-pack-plan.test.ts — planner 四态基线 + 存档 uid 迁移 + 卸载 + diff 测试。
 *
 * 🔴 这些测试是 **D38 契约测试 + D43 回归测试的共享内核**（brief T6 要求）:
 * 写扎实 —— 公开仓的 `tests/contract/pack-install.contract.test.ts`（D38）会复用同样的
 * 四态断言形状，fake-indexeddb 集成测试会复用同样的迁移 fixture。
 *
 * 主路径覆盖（brief T6 四条）:
 * 1. **首装零冲突**: 新鲜占位状态 + pack 全新书 → 全 added，0 conflicted
 * 2. **编辑后 N 冲突**: 用户编辑过占位书（现 hash ≠ 占位基线）+ 首装 → 该书 conflicted
 * 3. **占位建档 → 装包 uid 迁移**: 存档 enabledWorldBookEntries 含占位 uid → 按名配对产 rewrite；
 *    system_core 失配 → needsSelectionPartitions（恰好单条，不是整本）；多选失配 → 清除 + note
 * 4. **卸载编辑检测**: 用户编辑过的 pack 书 → 出现在确认清单
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §4 / §5.1 / §5.2 / D18 / D19 / D20 / D43 / D40
 */

import { describe, it, expect } from 'vitest';

import type { ContentPack, PackBaseline } from './types-content';
import {
  planPackInstall,
  planSaveUidMigration,
  planPackUninstall,
  diffPackUpgrade,
  SINGLE_SELECT_PINNED_PARTITIONS,
} from './content-pack-plan';
import type { CurrentLibrary } from './content-pack-plan';
import { hashWorldBook, PLACEHOLDER_UID_RESERVED_BASE } from './content-source';
import type { WorldBook, WorldBookEntry, WorkshopNote } from './types';

// ── fixtures ──

function minimalPack(): ContentPack {
  return { formatVersion: 1, packId: 'test-pack', packVersion: '1.0.0' };
}

/** 造一条最小合法 WorldBookEntry */
function entry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    uid: 1,
    name: '条目',
    content: '内容',
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 0,
    position: 0,
    ...overrides,
  };
}

/** 造一本最小合法 WorldBook */
function book(overrides: Partial<WorldBook> = {}): WorldBook {
  return {
    id: 'world_overview',
    name: '世界总览',
    partition: 'world_setting',
    builtIn: true,
    entries: [entry()],
    ...overrides,
  };
}

/** 占位书：uid 在保留段（900001+） */
function placeholderBook(overrides: Partial<WorldBook> = {}): WorldBook {
  return book({
    entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '占位条目' })],
    ...overrides,
  });
}

// ═══════════════════════════════════════════════════════════
// 主路径 1: 首装零冲突
// ═══════════════════════════════════════════════════════════

describe('planPackInstall — 首装零冲突（D20 主路径）', () => {
  it('新鲜占位状态（current 空 + 两个 baseline 空）+ pack 全新书 → 全 added，0 conflicted', () => {
    const packBook = book({ id: 'b1', name: '书一' });
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };
    const plan = planPackInstall(pack);

    expect(plan.sections.worldBooks?.added).toHaveLength(1);
    expect(plan.sections.worldBooks?.added[0].id).toBe('b1');
    expect(plan.sections.worldBooks?.updated).toEqual([]);
    expect(plan.sections.worldBooks?.conflicted).toEqual([]);
    expect(plan.sections.worldBooks?.removed).toEqual([]);
  });

  it('多本书全 added', () => {
    const pack: ContentPack = {
      ...minimalPack(),
      worldBooks: [book({ id: 'b1' }), book({ id: 'b2' }), book({ id: 'b3' })],
    };
    const plan = planPackInstall(pack);
    expect(plan.sections.worldBooks?.added).toHaveLength(3);
  });

  it('占位书未动过 + 首装（无装包基线、占位基线命中）→ updated 静默覆盖', () => {
    // 场景: 当前库里有一本占位书（未动过），它的正文 hash 等于占位基线
    const placeholderBk = placeholderBook({ id: 'b1', name: '书一' });
    const placeholderBaseline: PackBaseline = {
      byBook: { b1: hashWorldBook(placeholderBk) },
    };
    // pack 要覆盖同一 id 的书（内容不同但同 id）
    const packBook = book({ id: 'b1', name: '书一', entries: [entry({ content: '真实内容' })] });
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };

    const current: CurrentLibrary = { worldBooks: [placeholderBk] };
    const plan = planPackInstall(pack, current, {}, placeholderBaseline);

    // 占位书未动过（现 hash = 占位基线）→ updated 静默覆盖
    expect(plan.sections.worldBooks?.updated).toHaveLength(1);
    expect(plan.sections.worldBooks?.conflicted).toEqual([]);
    expect(plan.sections.worldBooks?.added).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 主路径 2: 编辑后冲突
// ═══════════════════════════════════════════════════════════

describe('planPackInstall — 编辑后冲突（D20 四态）', () => {
  it('用户编辑过占位书（现 hash ≠ 占位基线）+ 首装 → conflicted', () => {
    // 场景: 占位基线记录的是「未动过」的 hash；用户编辑后当前书的 hash 已不同
    const pristinePlaceholder = placeholderBook({ id: 'b1', name: '书一' });
    const editedPlaceholder = placeholderBook({
      id: 'b1',
      name: '书一',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, content: '用户编辑过的内容' })],
    });
    const placeholderBaseline: PackBaseline = {
      byBook: { b1: hashWorldBook(pristinePlaceholder) },
    };
    const packBook = book({ id: 'b1', name: '书一', entries: [entry({ content: '真实内容' })] });
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };

    const current: CurrentLibrary = { worldBooks: [editedPlaceholder] };
    const plan = planPackInstall(pack, current, {}, placeholderBaseline);

    // 占位书被编辑过（现 hash ≠ 占位基线）→ conflicted，需确认
    expect(plan.sections.worldBooks?.conflicted).toHaveLength(1);
    expect(plan.sections.worldBooks?.conflicted[0].key).toBe('b1');
    expect(plan.sections.worldBooks?.updated).toEqual([]);
    expect(plan.sections.worldBooks?.added).toEqual([]);
  });

  it('有装包基线 + 用户没动过（现 hash = 装包基线）→ updated', () => {
    // 场景: 上次装过这本书，记录了装包基线；用户没编辑 → 静默覆盖
    const packBookV1 = book({ id: 'b1', name: '书一', entries: [entry({ content: 'v1' })] });
    const packBookV2 = book({ id: 'b1', name: '书一', entries: [entry({ content: 'v2' })] });
    const packBaseline: PackBaseline = { byBook: { b1: hashWorldBook(packBookV1) } };

    // 当前库里是 v1（用户没动过）
    const current: CurrentLibrary = { worldBooks: [packBookV1] };
    // 升级到 v2
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBookV2] };
    const plan = planPackInstall(pack, current, packBaseline, {});

    expect(plan.sections.worldBooks?.updated).toHaveLength(1);
    expect(plan.sections.worldBooks?.conflicted).toEqual([]);
  });

  it('有装包基线 + 用户编辑过（现 hash ≠ 装包基线）→ conflicted', () => {
    const packBookV1 = book({ id: 'b1', name: '书一', entries: [entry({ content: 'v1' })] });
    const userEdited = book({ id: 'b1', name: '书一', entries: [entry({ content: '用户改的' })] });
    const packBaseline: PackBaseline = { byBook: { b1: hashWorldBook(packBookV1) } };

    const current: CurrentLibrary = { worldBooks: [userEdited] };
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBookV1] };
    const plan = planPackInstall(pack, current, packBaseline, {});

    expect(plan.sections.worldBooks?.conflicted).toHaveLength(1);
  });

  it('pack 声明 [] (空数组) → removed（清空当前所有拥有行）', () => {
    const currentBk1 = book({ id: 'b1' });
    const currentBk2 = book({ id: 'b2' });
    const current: CurrentLibrary = { worldBooks: [currentBk1, currentBk2] };
    const pack: ContentPack = { ...minimalPack(), worldBooks: [] };
    const plan = planPackInstall(pack, current);

    expect(plan.sections.worldBooks?.removed).toHaveLength(2);
    expect(plan.sections.worldBooks?.added).toEqual([]);
    expect(plan.sections.worldBooks?.updated).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 主路径 3: 存档 uid 迁移（D43 三段式）
// ═══════════════════════════════════════════════════════════

describe('planSaveUidMigration — D43 三段式', () => {
  it('占位书条目名 ↔ pack 书条目名配对成功 → rewrite 产 old→new 映射', () => {
    // 当前库里有一本占位书，条目名「命定核心」，uid=900001
    const placeholderBk = placeholderBook({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '命定核心' })],
    });
    // pack 的同分区书里，同名的条目 uid=413（真实 uid）
    const packBk = book({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: 413, name: '命定核心' })],
    });
    // 存档里钉了 system_core:900001（占位期建档的单选）
    const enabledEntries = [`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`];

    const notes: WorkshopNote[] = [];
    const migration = planSaveUidMigration([packBk], [placeholderBk], enabledEntries, notes);

    // 按名配对成功 → rewrite 产 system_core:900001 → 413
    expect(migration.rewrite[`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`]).toBe(413);
    expect(migration.needsSelectionPartitions).toEqual([]);
  });

  it('system_core 失配（pack 没有同名条目）→ needsSelectionPartitions 恰好单条', () => {
    // 占位书条目名「旧核心」，pack 书改成「新核心」—— 配不上
    const placeholderBk = placeholderBook({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '旧核心' })],
    });
    const packBk = book({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: 413, name: '新核心' })],
    });
    const enabledEntries = [`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`];

    const notes: WorkshopNote[] = [];
    const migration = planSaveUidMigration([packBk], [placeholderBk], enabledEntries, notes);

    // 单选钉选分区失配 → needs_selection（不许裸删）
    expect(migration.needsSelectionPartitions).toEqual(['system_core']);
    expect(migration.rewrite).toEqual({});
    // 不产 sideEffect note（单选钉选分区不走清除路径）
    expect(notes.filter((n) => n.kind === 'sideEffect')).toEqual([]);
  });

  it('character 失配 → needsSelectionPartitions 含 character', () => {
    const placeholderBk = placeholderBook({
      id: 'character',
      partition: 'character',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE + 1, name: '旧角色' })],
    });
    const packBk = book({
      id: 'character',
      partition: 'character',
      entries: [entry({ uid: 100, name: '新角色' })],
    });
    const enabledEntries = [`character:${PLACEHOLDER_UID_RESERVED_BASE + 1}`];

    const migration = planSaveUidMigration([packBk], [placeholderBk], enabledEntries, []);

    expect(migration.needsSelectionPartitions).toEqual(['character']);
  });

  it('多选分区失配 → 允许清除 + sideEffect note', () => {
    // 多选分区（如 world_setting），占位期启用过的条目名在 pack 里没了
    const placeholderBk = placeholderBook({
      id: 'world_setting',
      partition: 'world_setting',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '旧设定' })],
    });
    const packBk = book({
      id: 'world_setting',
      partition: 'world_setting',
      entries: [entry({ uid: 10, name: '新设定' })],
    });
    const enabledEntries = [`world_setting:${PLACEHOLDER_UID_RESERVED_BASE}`];

    const notes: WorkshopNote[] = [];
    const migration = planSaveUidMigration([packBk], [placeholderBk], enabledEntries, notes);

    // 多选分区失配 → 不进 needs_selection
    expect(migration.needsSelectionPartitions).toEqual([]);
    // 产 sideEffect note（清除）
    expect(notes.some((n) => n.kind === 'sideEffect')).toBe(true);
  });

  it('真实 uid（< 保留段）的 enabledEntries 不被迁移', () => {
    // 存档里有真实 uid 的启用项（如 system_core:413），不该被 planner 动
    const packBk = book({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: 413, name: '核心' })],
    });
    const enabledEntries = ['system_core:413'];

    const migration = planSaveUidMigration([packBk], [], enabledEntries, []);

    expect(migration.rewrite).toEqual({});
    expect(migration.needsSelectionPartitions).toEqual([]);
  });

  it('无 enabledEntries → 空迁移（无副作用）', () => {
    const packBk = book({ id: 'b1' });
    const migration = planSaveUidMigration([packBk], [placeholderBook()], [], []);
    expect(migration.rewrite).toEqual({});
    expect(migration.needsSelectionPartitions).toEqual([]);
  });

  it('格式非法的 enabledEntries 项被静默跳过', () => {
    const migration = planSaveUidMigration(
      [book()],
      [placeholderBook()],
      ['no-colon', ':', 'x:'],
      [],
    );
    expect(migration.rewrite).toEqual({});
    expect(migration.needsSelectionPartitions).toEqual([]);
  });
});

describe('planPackInstall — saveUidMigration 接线（端到端）', () => {
  it('占位建档 → 装包 → rewrite 映射进 plan.saveUidMigration', () => {
    const placeholderBk = placeholderBook({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '命定核心' })],
    });
    const packBk = book({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: 413, name: '命定核心' })],
    });
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBk] };
    const current: CurrentLibrary = {
      worldBooks: [placeholderBk],
      enabledWorldBookEntries: [`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`],
    };
    // 占位基线命中 → updated（不冲突）
    const placeholderBaseline: PackBaseline = {
      byBook: { system_core: hashWorldBook(placeholderBk) },
    };

    const plan = planPackInstall(pack, current, {}, placeholderBaseline);

    expect(plan.sections.worldBooks?.updated).toHaveLength(1);
    expect(plan.saveUidMigration?.rewrite[`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`]).toBe(
      413,
    );
    expect(plan.saveUidMigration?.needsSelectionPartitions).toEqual([]);
  });

  it('system_core 失配 → plan.saveUidMigration.needsSelectionPartitions 恰好单条', () => {
    const placeholderBk = placeholderBook({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: PLACEHOLDER_UID_RESERVED_BASE, name: '旧核心' })],
    });
    const packBk = book({
      id: 'system_core',
      partition: 'system_core',
      entries: [entry({ uid: 413, name: '新核心' })],
    });
    const pack: ContentPack = { ...minimalPack(), worldBooks: [packBk] };
    const current: CurrentLibrary = {
      worldBooks: [placeholderBk],
      enabledWorldBookEntries: [`system_core:${PLACEHOLDER_UID_RESERVED_BASE}`],
    };

    const plan = planPackInstall(pack, current, {}, {});

    expect(plan.saveUidMigration?.needsSelectionPartitions).toEqual(['system_core']);
    // 恰好单条，不是整本（裸删会触发内容通胀，D43）
    expect(plan.saveUidMigration?.needsSelectionPartitions).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 主路径 4: 卸载编辑检测
// ═══════════════════════════════════════════════════════════

describe('planPackUninstall — 卸载编辑检测（§5.2）', () => {
  it('用户编辑过的 pack 书 → 出现在确认清单', () => {
    const packBook = book({ id: 'b1', name: '书一', entries: [entry({ content: '原始' })] });
    const installedPack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };
    // 用户编辑过这本书
    const userEdited = book({ id: 'b1', name: '书一', entries: [entry({ content: '用户改的' })] });
    const packBaseline: PackBaseline = { byBook: { b1: hashWorldBook(packBook) } };
    const current: CurrentLibrary = { worldBooks: [userEdited] };

    const uninstallPlan = planPackUninstall(installedPack, current, packBaseline);

    expect(uninstallPlan.confirmations).toHaveLength(1);
    expect(uninstallPlan.confirmations[0].bookId).toBe('b1');
    expect(uninstallPlan.ownedBookIds).toEqual(['b1']);
  });

  it('用户没动过的 pack 书 → 不出现在确认清单', () => {
    const packBook = book({ id: 'b1', entries: [entry({ content: '原始' })] });
    const installedPack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };
    const current: CurrentLibrary = { worldBooks: [packBook] };
    const packBaseline: PackBaseline = { byBook: { b1: hashWorldBook(packBook) } };

    const uninstallPlan = planPackUninstall(installedPack, current, packBaseline);
    expect(uninstallPlan.confirmations).toEqual([]);
  });

  it('多本书部分编辑 → 只列出编辑过的', () => {
    const b1 = book({ id: 'b1', entries: [entry({ content: 'b1原始' })] });
    const b2 = book({ id: 'b2', entries: [entry({ content: 'b2原始' })] });
    const b2Edited = book({ id: 'b2', entries: [entry({ content: 'b2改了' })] });
    const installedPack: ContentPack = { ...minimalPack(), worldBooks: [b1, b2] };
    const current: CurrentLibrary = { worldBooks: [b1, b2Edited] };
    const packBaseline: PackBaseline = {
      byBook: { b1: hashWorldBook(b1), b2: hashWorldBook(b2) },
    };

    const uninstallPlan = planPackUninstall(installedPack, current, packBaseline);
    expect(uninstallPlan.confirmations).toHaveLength(1);
    expect(uninstallPlan.confirmations[0].bookId).toBe('b2');
    expect(uninstallPlan.ownedBookIds).toEqual(['b1', 'b2']);
  });

  it('无装包基线 → 无确认清单（不谎报）', () => {
    const packBook = book({ id: 'b1' });
    const installedPack: ContentPack = { ...minimalPack(), worldBooks: [packBook] };
    const current: CurrentLibrary = { worldBooks: [packBook] };

    const uninstallPlan = planPackUninstall(installedPack, current, {});
    expect(uninstallPlan.confirmations).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 升级 diff（D40）
// ═══════════════════════════════════════════════════════════

describe('diffPackUpgrade — 升级 diff（D40）', () => {
  it('oldPlan 无 / newPlan 有 → added', () => {
    const newPack: ContentPack = {
      ...minimalPack(),
      worldBooks: [book({ id: 'b1', name: '书一' })],
    };
    const newPlan = planPackInstall(newPack);
    const oldPlan = planPackInstall(minimalPack());

    const diff = diffPackUpgrade(oldPlan, newPlan);
    expect(diff.worldBooks.some((d) => d.kind === 'added' && d.key === 'b1')).toBe(true);
  });

  it('oldPlan 有 / newPlan 无 → removed', () => {
    const oldPack: ContentPack = {
      ...minimalPack(),
      worldBooks: [book({ id: 'b1', name: '书一' })],
    };
    const oldPlan = planPackInstall(oldPack);
    const newPlan = planPackInstall({
      ...minimalPack(),
      worldBooks: [book({ id: 'b2', name: '书二' })],
    });

    const diff = diffPackUpgrade(oldPlan, newPlan);
    expect(diff.worldBooks.some((d) => d.kind === 'removed' && d.key === 'b1')).toBe(true);
  });

  it('两边都有 → updated', () => {
    const oldPlan = planPackInstall({
      ...minimalPack(),
      worldBooks: [book({ id: 'b1', name: '书一' })],
    });
    const newPlan = planPackInstall({
      ...minimalPack(),
      worldBooks: [book({ id: 'b1', name: '书一' })],
    });

    const diff = diffPackUpgrade(oldPlan, newPlan);
    expect(diff.worldBooks.some((d) => d.kind === 'updated' && d.key === 'b1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 第 13 分节 randomEvents（随机事件系统 v1 / §3.3）
// ═══════════════════════════════════════════════════════════

describe('planPackInstall — randomEvents 分节（三态 + 整节替换）', () => {
  /** 一节最小的随机事件分节（形状 = 落盘的 random-events.json，没有外层 `data` 壳） */
  function eventsSection(names: string[]): NonNullable<ContentPack['randomEvents']> {
    return {
      config: { globalCooldownDays: 3, offerTtlDays: 5, maxPending: 3 },
      defs: names.map((name) => ({
        name,
        brief: `${name}的简报`,
        trigger: { type: 'mtth' as const, mtthDays: 20 },
      })),
    };
  }

  it('absent（pack 没声明这一节）→ sections.randomEvents 不出现（语义 = 别动）', () => {
    const plan = planPackInstall(minimalPack());
    expect(plan.sections.randomEvents).toBeUndefined();
    // 🔴 键不许以 `undefined` 值的形式出现 —— 执行器判的是 `if (plan.sections.X)`，
    //    但 `'randomEvents' in sections` 为真会让「这一节到底动没动」在诊断里说不清
    expect('randomEvents' in plan.sections).toBe(false);
  });

  it('rows（声明了定义）→ 整节进 updated（执行器整块覆盖，不做逐条 diff）', () => {
    const section = eventsSection(['旅途小遭遇', '夜半叩门']);
    const plan = planPackInstall({ ...minimalPack(), randomEvents: section });
    expect(plan.sections.randomEvents?.updated).toEqual([section]);
    // 🔴 整节替换分节没有逐项键，所以另外三态恒空 —— 与 catalog/bloodlines 同档
    expect(plan.sections.randomEvents?.added).toEqual([]);
    expect(plan.sections.randomEvents?.removed).toEqual([]);
    expect(plan.sections.randomEvents?.conflicted).toEqual([]);
  });

  it('刻意清空（defs: []）→ 这一节仍然出现（present ≠ absent）', () => {
    const empty = { defs: [] };
    const plan = planPackInstall({ ...minimalPack(), randomEvents: empty });
    // 🔴 这条守的正是三态里最容易被写塌的一格：`defs: []` 是「这个包明确说本局没有随机
    //    事件」，与「本包对随机事件无话可说」是两件事。判据若写成 `pack.randomEvents?.defs
    //    ?.length` 之类，空包会被误判成 absent，于是清空指令永远传不下去。
    expect(plan.sections.randomEvents).toBeDefined();
    expect(plan.sections.randomEvents?.updated).toEqual([empty]);
  });

  it('透传原对象（planner 不解释结构、不复制、不收窄）', () => {
    const section = eventsSection(['旅途小遭遇']);
    const plan = planPackInstall({ ...minimalPack(), randomEvents: section });
    // 引用相等：坏定义的剔除是 `coerceRandomEventPack` 的活，planner 一个字段都不该碰
    expect(plan.sections.randomEvents?.updated[0]).toBe(section);
  });

  it('与其它分节共存时互不影响（randomEvents 声明不牵连 worldBooks 判定）', () => {
    const plan = planPackInstall({
      ...minimalPack(),
      worldBooks: [book({ id: 'b1' })],
      randomEvents: eventsSection(['旅途小遭遇']),
    });
    expect(plan.sections.worldBooks?.added).toHaveLength(1);
    expect(plan.sections.randomEvents?.updated).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 常量断言
// ═══════════════════════════════════════════════════════════

describe('SINGLE_SELECT_PINNED_PARTITIONS', () => {
  it('单选钉选分区恰好是 system_core + character', () => {
    expect(SINGLE_SELECT_PINNED_PARTITIONS).toEqual(['system_core', 'character']);
  });
});
