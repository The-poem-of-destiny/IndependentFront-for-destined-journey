/**
 * 出厂预设播种（按播种指纹同步，2026-11-17）的三条评审回归
 *
 * 1. 默认层内嵌了引擎内置直出预设（开发态「保存为默认」造得出）：不许播种，否则
 *    `migrateBuiltinPresetRows` 每次启动都把带指纹的行当成「改过」另存副本、改指选择键。
 * 2. 同一 id 的预设在 agent-config 内嵌版与 `pack.presets` 里内容不一致：播种必须与装包同源
 *    （provider 列表优先），否则播种覆盖装包结果、升级报虚假冲突，循环往复。
 * 3. 两个标签页同时启动：读库 → 计划 → 写库在同一个事务里，旧行只另存一份副本。
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSettingsStore } from '../../../src/ui/stores/settings-store';
import {
  resetPlaceholderHashesCache,
  setActivePackRecord,
  setPlaceholderHashesForTests,
  useContentStore,
} from '../../../src/ui/stores/content-store';
import { getDatabase } from '@engine/persistence/database';
import { createDirectPreset } from '@engine/prompts/direct-prompt';
import type { ContentPack } from '@engine/types/types-content';

const store_ = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store_.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store_.set(k, v);
  },
  removeItem: (k: string) => {
    store_.delete(k);
  },
  clear: () => {
    store_.clear();
  },
  get length() {
    return store_.size;
  },
  key: (i: number) => [...store_.keys()][i] ?? null,
});

const drainMacrotasks = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** 新建一个 store 并抽干它构造期的启动任务，避免与之后装的 spy 抢跑 */
async function bootStore() {
  store_.clear();
  setActivePinia(createPinia());
  const store = useSettingsStore();
  await drainMacrotasks(6);
  await store.loadAgentProjectDefaults();
  await drainMacrotasks(6);
  return store;
}

const disposers: Array<() => void> = [];
afterEach(async () => {
  while (disposers.length) disposers.pop()!();
  setActivePackRecord(null);
  resetPlaceholderHashesCache();
  vi.restoreAllMocks();
  await getDatabase().presets.clear();
  await getDatabase().contentPacks.clear();
});

describe('出厂预设播种 —— 引擎内置直出预设 id', () => {
  it('默认层内嵌内置直出预设：不播种，连续启动行数不涨、选择键不被改写', async () => {
    const store = await bootStore();
    disposers.push(() => store.$dispose());
    const db = getDatabase();
    await db.presets.clear();
    const builtin = JSON.parse(JSON.stringify(createDirectPreset()));
    const cs = useContentStore();
    vi.spyOn(cs, 'loadProjectDefaults').mockResolvedValue({
      version: 1,
      agents: { direct_main: { presetId: builtin.id, preset: builtin } },
    } as never);
    vi.spyOn(cs, 'resolveProjectPresets').mockResolvedValue([] as never);
    store.settings.directPresetId = builtin.id;
    // 播种本身就不许碰内置 id（哪怕随后的迁移会把它删掉，写进去本身就是错的）
    const written: string[] = [];
    const table = db.presets;
    const originalBulkPut = table.bulkPut.bind(table);
    vi.spyOn(table, 'bulkPut').mockImplementation(((rows: Array<{ id: string }>) => {
      written.push(...rows.map((r) => r.id));
      return originalBulkPut(rows as never);
    }) as never);

    for (let boot = 1; boot <= 3; boot++) {
      await store.loadAgentProjectDefaults();
      expect(await db.presets.count()).toBe(0);
      // 内置 id 恰是默认，归一可能把它清成「跟随默认」；绝不能被改指到某个副本
      expect([builtin.id, '', undefined]).toContain(store.settings.directPresetId);
    }
    expect(written).not.toContain(builtin.id);
  });

  it('旧版落盘的内置直出行只多了播种指纹：仍视为原样，删掉而不另存副本', async () => {
    const store = await bootStore();
    disposers.push(() => store.$dispose());
    const db = getDatabase();
    await db.presets.clear();
    const builtin = createDirectPreset();
    await db.presets.put({ ...builtin, factorySeedHash: 'stale', updatedAt: 99 });
    store.settings.directPresetId = builtin.id;

    await store.normalizePresetSelections();

    expect(await db.presets.count()).toBe(0);
    expect(store.settings.directPresetId).toBeUndefined();
  });
});

describe('出厂预设播种 —— 与装包同源', () => {
  const agent = (extra: object = {}) => ({
    model: '',
    systemPrompt: 'p',
    template: '',
    temperature: 0.7,
    topP: 1,
    freqPen: 0,
    presPen: 0,
    maxTokens: 4096,
    ...extra,
  });
  function makePack(version: string): ContentPack {
    const listed = {
      id: 'pack-story-preset',
      name: 'Pack Story',
      settings: { prompts: [{ identifier: 'main', content: 'listed' }] },
      createdAt: 1,
      updatedAt: 2,
    };
    // agent-config 内嵌的同 id 预设与 pack.presets 那份内容不一致
    const embedded = {
      ...listed,
      settings: { prompts: [{ identifier: 'main', content: 'embedded' }] },
    };
    return {
      formatVersion: 1,
      packId: 'fated-poem-official',
      packVersion: version,
      name: '测试内容包',
      agentDefaults: {
        version: 1,
        agents: { story: agent({ presetId: embedded.id, preset: embedded }) },
      },
      presets: [listed],
    } as unknown as ContentPack;
  }

  it('内嵌版与 pack.presets 不一致：播种取 pack.presets 那份，下次升级无预设冲突', async () => {
    const db = getDatabase();
    await db.presets.clear();
    await db.contentPacks.clear();
    await db.worldBooks.clear();
    setActivePinia(createPinia());
    setPlaceholderHashesForTests({ version: '1', byBook: {} });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
    store_.clear();
    const c = useContentStore();
    const settings = useSettingsStore();
    disposers.push(() => settings.$dispose());
    await drainMacrotasks(6);

    const first = await c.installPack(makePack('1.0.0'));
    expect(first.ok).toBe(true);
    await settings.loadAgentProjectDefaults();
    await drainMacrotasks(6);

    const row = await db.presets.get('pack-story-preset');
    expect(row?.settings).toEqual({ prompts: [{ identifier: 'main', content: 'listed' }] });

    const next = await c.upgradePack(makePack('1.0.1'));
    expect(next.plan?.sections.presets?.conflicted ?? []).toHaveLength(0);
    expect(next.ok).toBe(true);
  });
});

describe('出厂预设播种 —— 并发启动', () => {
  it('两个实例同时启动遇到就地改过的旧行：只另存一份「（更新前备份）」', async () => {
    const row = (content: string) => ({
      id: 'story-preset',
      name: '故事',
      settings: { prompts: [{ identifier: 'main', content }] },
      createdAt: 1,
      updatedAt: 1,
    });
    const mk = async () => {
      const s = await bootStore();
      disposers.push(() => s.$dispose());
      const cs = useContentStore();
      vi.spyOn(cs, 'loadProjectDefaults').mockResolvedValue({
        version: 1,
        agents: { story: { presetId: 'story-preset', preset: row('新出厂') } },
      } as never);
      vi.spyOn(cs, 'resolveProjectPresets').mockResolvedValue([] as never);
      return s;
    };
    const a = await mk();
    const b = await mk();
    const db = getDatabase();
    await db.presets.clear();
    await db.presets.put(row('玩家就地改过') as never);

    await Promise.all([a.loadAgentProjectDefaults(), b.loadAgentProjectDefaults()]);

    const rows = await db.presets.toArray();
    expect(rows.filter((r) => r.name.endsWith('（更新前备份）'))).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'story-preset')!.settings).toEqual({
      prompts: [{ identifier: 'main', content: '新出厂' }],
    });
  });
});
