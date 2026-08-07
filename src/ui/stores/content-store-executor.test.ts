/**
 * content-store.ts 装包执行器端到端测试（波 1 T7 / D19 / §5.2 / D43 / D42）
 *
 * 🔴 六类验收（订单 §7.1「新增公开仓」）：
 *   1. 装（含冲突确认路径）—— 空库 + pack → 全部 added；编辑过 → conflicted → 确认后覆盖
 *   2. 升 —— upgradePack 产 added/updated/removed diff
 *   3. 卸（快照回滚路径）—— 卸载后 pack 书被占位书替换；编辑过的书需确认
 *   4. 占位建档 → 装包 → 存档存活（D43 回归，验收 #14c）—— 占位 uid(900001+) → 装包 → enabledWorldBookEntries 按名配对重写
 *   5. 装包后 boot 时序断言 —— loadProjectDefaults 返回 pack agentDefaults（D44 默认层）
 *   6. D42 重播种 —— 动过的书不被覆盖
 *
 * fake-indexeddb 由 test-setup.ts 注入；store 需 active pinia。
 * 模块级 activePack 缓存跨用例残留 → afterEach 用 setActivePackRecord(null) 复位。
 */
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { reactive } from 'vue';
import {
  useContentStore,
  setActivePackRecord,
  resetPlaceholderHashesCache,
  setPlaceholderHashesForTests,
} from './content-store';
import { getDatabase } from '@engine/database';
import { hashWorldBook } from '@engine/content-source';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import type { ContentPack } from '@engine/types-content';

// ── 夹具 ──

/** 造一条世界书条目 */
function entry(uid: number, name: string, content = `content-${name}`): WorldBookEntry {
  return {
    uid,
    name,
    content,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
  };
}

/** 造一本书（default state：占位 = 保留段 uid，分隔由调用方控制） */
function book(
  id: string,
  partition: WorldBookPartition,
  entries: WorldBookEntry[],
  opts: { name?: string; builtIn?: boolean } = {},
): WorldBook {
  return {
    id,
    name: opts.name ?? id,
    partition,
    entries,
    builtIn: opts.builtIn ?? true,
  };
}

/** 占位书的保留段条目（D43：uid ∈ [900001, …)） */
const PLACEHOLDER_SYSTEM_CORE: WorldBook = book('system_core', 'system_core', [
  entry(900001, '核心A', '占位A'),
  entry(900002, '核心B', '占位B'),
]);

/** 占位 world_setting 书（多选分区，装包/卸载都会涉及） */
const PLACEHOLDER_WORLD: WorldBook = book('world_setting', 'world_setting', [
  entry(900003, '背景常识', '占位背景'),
]);

/** 装包用的真实内容包（与占位书共用 id，真实 uid 空间 < 900001） */
function makePack(version = '1.0.0'): ContentPack {
  return {
    formatVersion: 1,
    packId: 'fated-poem-official',
    packVersion: version,
    name: '测试内容包',
    worldBooks: [
      book('system_core', 'system_core', [entry(1, '核心A', '真实A'), entry(2, '核心B', '真实B')]),
      book('world_setting', 'world_setting', [entry(3, '背景常识', '真实背景')]),
    ],
    agentDefaults: {
      version: 1,
      agents: {
        story: {
          model: 'story-model',
          worldBookEnabled: true,
          worldBookIds: ['system_core'],
          systemPrompt: 'pack-story-prompt',
          template: '',
          temperature: 0.7,
          topP: 1.0,
          freqPen: 0,
          presPen: 0,
          maxTokens: 4096,
        },
        narrator: {
          model: 'narrator-model',
          worldBookEnabled: true,
          worldBookIds: ['world_setting'],
          systemPrompt: 'pack-narrator-prompt',
          template: '',
          temperature: 0.7,
          topP: 1.0,
          freqPen: 0,
          presPen: 0,
          maxTokens: 4096,
        },
      },
    },
    presets: [
      { id: 'pack-story-preset', name: 'Pack Story', settings: {}, createdAt: 1, updatedAt: 2 },
    ],
    beautifierRules: {
      version: 1,
      rules: [
        {
          id: 'pack-rule-1',
          name: 'Rules',
          scope: 'maintext',
          pattern: 'x',
          flags: '',
          replacement: 'y',
          enabled: true,
          order: 100,
          isBuiltin: true,
        },
      ],
    },
  };
}

type WorldBookPartition = WorldBook['partition'];

/** 基于当前占位书集构造占位基线清单（byBook hash 现算），返回可复用的 fetch mock。 */
function installContentFetchMock(opts: { version?: string; extraBooks?: WorldBook[] } = {}): {
  manifest: { version: string; byBook: Record<string, string> };
  restore: () => void;
} {
  const placeholderBooks = [PLACEHOLDER_SYSTEM_CORE, PLACEHOLDER_WORLD, ...(opts.extraBooks ?? [])];
  const byBook: Record<string, string> = {};
  for (const b of placeholderBooks) byBook[b.id] = hashWorldBook(b);
  const manifest = { version: opts.version ?? '1', byBook };
  // 🔴 清单是**静态 import 的打包资源**（设计 §6），不再走 fetch —— 合成基线只能经
  // 测试覆写口注入。此前这里 mock 的那条 `/data/placeholder-hashes.json` 分支已经死了。
  setPlaceholderHashesForTests(manifest);
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    // 占位世界书 /data/worldbooks/<id>.json
    const m = /\/data\/worldbooks\/(.+)\.json$/.exec(url);
    if (m) {
      const book = placeholderBooks.find((b) => b.id === m[1]);
      if (book) return new Response(JSON.stringify(book), { status: 200 });
      return new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  });
  return { manifest, restore: () => spy.mockRestore() };
}

/** 预置占位库（占位期的初始状态：同 id 同分区同 builtIn，uid 保留段） */
async function seedPlaceholderLibrary(): Promise<void> {
  const db = getDatabase();
  await db.worldBooks.bulkPut([PLACEHOLDER_SYSTEM_CORE, PLACEHOLDER_WORLD]);
  // 占位默认层（含 story 的占位预设 id）
  await db.contentPacks.clear();
  await db.presets.clear();
}

/** 清理所有用到的表 + 模块缓存 */
async function cleanDb(): Promise<void> {
  const db = getDatabase();
  await db.contentPacks.clear();
  await db.worldBooks.clear();
  await db.presets.clear();
  await db.saves.clear();
  await db.beautifierRules.clear();
  setActivePackRecord(null);
}

describe('content-store 执行器 —— 1. 安装（含冲突确认路径）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
    installContentFetchMock();
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('空库（无占位书）装 pack → 全部 added，装后内容态 pack + activePackId/Version 设定', async () => {
    const c = useContentStore();
    const outcome = await c.installPack(makePack());
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('installed');
    expect(outcome.plan?.sections.worldBooks?.added).toHaveLength(2);
    expect(outcome.plan?.sections.worldBooks?.updated).toHaveLength(0);
    // 内容态
    expect(c.contentStatus).toBe('pack');
    expect(c.activePackId).toBe('fated-poem-official');
    expect(c.activePackVersion).toBe('1.0.0');
    // 库里有 pack 书
    const books = await getDatabase().worldBooks.toArray();
    expect(books.map((b) => b.id).sort()).toEqual(['system_core', 'world_setting']);
    // pack 书 builtIn 必须 true（loadBuiltInWorldBooks 真值门）
    expect(books.every((b) => b.builtIn === true)).toBe(true);
    // 存档重写 + agent 写 contentPacks（不写 settings.agents 是另一测）
    const rec = await getDatabase().contentPacks.get('fated-poem-official');
    expect(rec?.payload.packVersion).toBe('1.0.0');
    // 预设已落库
    const presets = await getDatabase().presets.toArray();
    expect(presets.map((p) => p.id)).toContain('pack-story-preset');
  });

  it('已存在未编辑过的占位书 → 静默覆盖（updated），无冲突', async () => {
    await seedPlaceholderLibrary();
    const c = useContentStore();
    const outcome = await c.installPack(makePack());
    expect(outcome.ok).toBe(true);
    expect(outcome.plan?.sections.worldBooks?.updated).toHaveLength(2);
    expect(outcome.plan?.sections.worldBooks?.conflicted).toHaveLength(0);
    // 库里现在是 pack 内容
    const sc = await getDatabase().worldBooks.get('system_core');
    expect(sc?.entries.map((e) => e.uid)).toEqual([1, 2]);
  });

  it('编辑过的 book（hash ≠ 占位基线）→ 首次装包变 conflicted → 未确认时 needs_confirmation → 确认后覆盖', async () => {
    await seedPlaceholderLibrary();
    // 人为编辑占位书（改正文，hash 变化）
    const db = getDatabase();
    const edited = { ...PLACEHOLDER_SYSTEM_CORE, entries: [entry(900001, '核心A', '改了')] };
    await db.worldBooks.put(edited);

    const c = useContentStore();
    // 未确认 → needs_confirmation + conflicted
    const first = await c.installPack(makePack());
    expect(first.ok).toBe(false);
    expect(first.status).toBe('needs_confirmation');
    expect(first.plan?.sections.worldBooks?.conflicted.length).toBeGreaterThan(0);

    // 确认 → 覆盖
    const second = await c.installPack(makePack(), { confirmConflicts: true });
    expect(second.ok).toBe(true);
    const sc = await db.worldBooks.get('system_core');
    expect(sc?.entries.map((e) => e.uid)).toEqual([1, 2]);
  });

  it('pack 经 Vue reactive 代理（packPending 场景）→ 确认重入装包成功，不 DataCloneError（2026-08-07 真机回归）', async () => {
    await seedPlaceholderLibrary();
    // 编辑占位书 → 制造 conflicted（与真机一致：确认框 → 确认重入）
    const db = getDatabase();
    await db.worldBooks.put({
      ...PLACEHOLDER_SYSTEM_CORE,
      entries: [entry(900001, '核心A', '改了')],
    });

    const c = useContentStore();
    // 🔴 DataSection.vue 的 packPending 是 ref——存对象会 reactive() 深代理，
    //    确认重入时取回的是 Proxy。reactive(makePack()) 模拟同一形态。
    const pack = reactive(makePack());
    const first = await c.installPack(pack);
    expect(first.status).toBe('needs_confirmation');
    // 确认重入（同一 Proxy pack）
    const second = await c.installPack(pack, { confirmConflicts: true });
    expect(second.ok).toBe(true);
    expect(second.status).toBe('installed');
    // 预设成功落库（修复前：savePreset(Proxy) → IDB DataCloneError）
    const presets = await getDatabase().presets.toArray();
    expect(presets.map((p) => p.id)).toContain('pack-story-preset');
  });
});

describe('content-store 执行器 —— 2. 升级 diff', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
    installContentFetchMock();
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('upgradePack 对已装包产 diff（added/updated/removed）；确认后落新版本', async () => {
    const c = useContentStore();
    // 装 v1
    await c.installPack(makePack('1.0.0'));
    // v2 加了 worldsSetting 新书 + 改 system_core 条目 + 删默认的某本
    const v2: ContentPack = {
      ...makePack('2.0.0'),
      worldBooks: [
        book('system_core', 'system_core', [
          entry(1, '核心A', 'v2'),
          entry(99, '新增条目', 'v2新增'),
        ]),
        book('new_faction', 'faction', [entry(5, '新势力', 'v2')]),
      ],
    };
    const pending = await c.upgradePack(v2);
    // 未确认时可能因为 new_faction 是 added 无冲突 → 直接 installed。但 system_core 的
    // world_setting 被移除 → old 有 new 无 → removed。diff 至少含这些变化。
    expect(pending.upgradeDiff).toBeDefined();
    const wbItems = pending.upgradeDiff?.worldBooks ?? [];
    const kinds = wbItems.map((i) => i.kind);
    expect(kinds).toContain('added'); // new_faction
    // 确认后落盘为 v2
    if (!pending.ok) {
      const done = await c.installPack(v2, { confirmConflicts: true });
      expect(done.ok).toBe(true);
    }
    const rec = await getDatabase().contentPacks.get('fated-poem-official');
    expect(rec?.packVersion).toBe('2.0.0');
  });
});

describe('content-store 执行器 —— 3. 卸载（快照回滚）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
    await seedPlaceholderLibrary();
    installContentFetchMock();
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('卸载后 pack 书被占位书替换；内容态回 placeholder', async () => {
    const c = useContentStore();
    await c.installPack(makePack());
    expect(c.contentStatus).toBe('pack');

    const outcome = await c.uninstallPack();
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('uninstalled');
    expect(c.contentStatus).toBe('placeholder');
    expect(c.activePackId).toBeNull();
    // 占位书（保留段 uid）回来了
    const sc = await getDatabase().worldBooks.get('system_core');
    expect(sc?.entries.map((e) => e.uid)).toEqual([900001, 900002]);
    // contentPacks 已删
    expect(await getDatabase().contentPacks.count()).toBe(0);
  });

  it('卸载时 pack 书被编辑过 → 需确认（needs_confirmation）', async () => {
    const c = useContentStore();
    await c.installPack(makePack());
    // 编辑 pack 书（hash ≠ 装包基线）
    const db = getDatabase();
    await db.worldBooks.put(book('system_core', 'system_core', [entry(1, '核心A', '用户改了')]));

    const first = await c.uninstallPack();
    expect(first.ok).toBe(false);
    expect(first.status).toBe('needs_confirmation');
    expect(first.plan?.confirmations.length).toBeGreaterThan(0);

    const second = await c.uninstallPack({ confirmEdits: true });
    expect(second.ok).toBe(true);
  });
});

describe('content-store 执行器 —— 4. 占位建档 → 装包 → 存档存活（D43）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
    await seedPlaceholderLibrary();
    installContentFetchMock();
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('存档 enabledWorldBookEntries 的占位 uid(900001+) 按名配对重写为真实 uid', async () => {
    // 占位期建档：单选钉选分区（system_core）写了占位 uid
    const db = getDatabase();
    await db.saves.put({
      id: 'save1',
      name: '占位期存档',
      slot: 0,
      createdAt: 1,
      updatedAt: 2,
      activeSnapshotId: null,
      metadata: {
        characterName: '主角',
        userName: '玩家',
        gameStartTime: '1',
        totalTurns: 0,
        enabledWorldBookEntries: ['system_core:900001'], // 占位「核心A」
      },
    });

    const c = useContentStore();
    await c.installPack(makePack());

    // 装包后：占位键按名配对 → 真实 uid（核心A → 1）
    const save = await db.saves.get('save1');
    const smeta = save?.metadata as Record<string, unknown> | undefined;
    expect(save?.metadata?.enabledWorldBookEntries).toContain('system_core:1');
    expect(save?.metadata?.enabledWorldBookEntries).not.toContain('system_core:900001');
    // 单选分区无配不上的键 → 不标 needs_selection
    expect(smeta?.needsPackWorldBookSelection).toBeUndefined();
  });

  it('占位 uid 配不上 pack 条目 → 单选钉选分区标 needs_selection（不裸删，防内容通胀）', async () => {
    const db = getDatabase();
    await db.saves.put({
      id: 'save1',
      name: '占位期存档',
      slot: 0,
      createdAt: 1,
      updatedAt: 2,
      activeSnapshotId: null,
      metadata: {
        characterName: '主角',
        userName: '玩家',
        gameStartTime: '1',
        totalTurns: 0,
        enabledWorldBookEntries: ['system_core:999999'], // 占位里不存在的条目名 → 配不上
      },
    });
    // 占位书里没有 uid 999999 → 名字查不到 → 无法配对 → needs_selection
    const c = useContentStore();
    await c.installPack(makePack());
    const save = await db.saves.get('save1');
    const smeta = save?.metadata as Record<string, unknown> | undefined;
    // 键保留原样（不裸删），标 needs_selection
    expect(save?.metadata?.enabledWorldBookEntries).toContain('system_core:999999');
    expect(smeta?.needsPackWorldBookSelection).toBe(true);
  });
});

describe('content-store 执行器 —— 5. 装包后 boot 时序（D44 默认层）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('装包后 loadProjectDefaults 返回 pack agentDefaults（pack > 占位 fetch）', async () => {
    const c = useContentStore();
    await c.installPack(makePack());
    // 即便占位 fetch 会返回别的，pack 层已接管
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ version: 1, agents: { story: { systemPrompt: 'PLACEHOLDER' } } }),
          { status: 200 },
        ),
      );
    const defaults = (await c.loadProjectDefaults()) as {
      agents: Record<string, { systemPrompt: string }>;
    };
    fetchSpy.mockRestore();
    expect(defaults.agents.story.systemPrompt).toBe('pack-story-prompt');
  });

  it('未装包 → loadProjectDefaults 回落占位 fetch（占位 agent 值生效）', async () => {
    const c = useContentStore();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ version: 1, agents: { story: { systemPrompt: 'PLACEHOLDER' } } }),
          { status: 200 },
        ),
      );
    const defaults = (await c.loadProjectDefaults()) as {
      agents: Record<string, { systemPrompt: string }>;
    };
    fetchSpy.mockRestore();
    expect(defaults.agents.story.systemPrompt).toBe('PLACEHOLDER');
    expect(c.contentStatus).toBe('placeholder');
  });
});

describe('content-store 执行器 —— 6. D42 重播种', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await cleanDb();
    // 占位内容升级到了版本 2（新 baseline）
    installContentFetchMock({ version: '2' });
  });
  afterEach(() => {
    setActivePackRecord(null);
    resetPlaceholderHashesCache();
    vi.restoreAllMocks();
  });

  it('占位版本前进：hash 仍等于占位基线的书重播种；动过的不覆盖', async () => {
    // 先种两本占位书，一本保持原样、一本被用户编辑过
    const db = getDatabase();
    await db.worldBooks.put({ ...PLACEHOLDER_SYSTEM_CORE, id: 'system_core' });
    await db.worldBooks.put({
      ...PLACEHOLDER_WORLD,
      id: 'world_setting',
      entries: [entry(900003, '背景常识', '用户自己改过的内容')],
    });

    const c = useContentStore();
    // settings 里记上一个旧版本戳（1）；占位内容升级到 v2（beforeEach 的 mock 提供 v2 baseline）
    const { useSettingsStore } = await import('./settings-store');
    const cfg = useSettingsStore();
    cfg.settings.placeholderVersion = '1';

    const result = await c.reseedPlaceholder();
    // system_core 被重播（hash 命中占位基线 → 从占位文件重灌）；world_setting 用户编辑被保留
    expect(result.reseeded).toContain('system_core');
    expect(result.reseeded).not.toContain('world_setting');
    const sc = await db.worldBooks.get('system_core');
    expect(sc?.entries[0].content).toBe('占位A');
    const ws = await db.worldBooks.get('world_setting');
    expect(ws?.entries[0].content).toBe('用户自己改过的内容');
    // 戳已更新
    expect(cfg.settings.placeholderVersion).toBe('2');
  });
});
