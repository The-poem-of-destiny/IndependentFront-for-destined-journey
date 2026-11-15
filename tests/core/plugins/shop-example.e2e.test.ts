// @vitest-environment jsdom
/**
 * shop-example.e2e —— 插件系统设计 §7 商店示例的端到端走查（fake-indexeddb）。
 *
 * 夹具在 `tests/fixtures/plugins/shop/`，就是一个能直接丢进插件目录的真包。三段检查：
 *
 * 1. **包能装**：服务端 `listPlugins` / `readPluginFile` 照 §4.6 的路径、扩展名与体积规则
 *    接受它；引擎侧 `coercePluginManifest` + `planPluginInstall` 判为 `ok`。
 * 2. **命令批次能落**：用货架条目拼出与 `shop.js` 同形的批次，经 `translatePluginCommands`
 *    → `StateManager.commitPluginCommand` 写进真存档：扣钱、发物品；余额不足时
 *    `PRECONDITION_FAILED`，钱与背包都不动。
 * 3. **页面脚本真能跑**：在 jsdom 里载入 `shop.html` 的节点、执行 `shop.js`，
 *    注入一个把 `commit` 接到上面那条真链路的假 `host`，点按钮看余额、背包与提示。
 *    帧本身（CSP、牢笼、端口）由 plugin-frame / frame-cage 的测试负责，这里不重复。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPlugins, PLUGIN_DIR_LIMITS, readPluginFile } from '../../../server/plugin-dir';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { translatePluginCommands } from '../../../src/core/plugins/plugin-commands';
import {
  computePluginContentHash,
  planPluginInstall,
} from '../../../src/core/plugins/plugin-install-plan';
import { coercePluginManifest } from '../../../src/core/plugins/plugin-manifest';
import { buildPluginView } from '../../../src/core/plugins/plugin-projection';
import { getProfile } from '../../../src/core/state/save-profile';
import { createStateManager } from '../../../src/core/state/state-manager';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type {
  PluginManifest,
  PluginResult,
  PluginRunGuard,
} from '../../../src/core/types/types-plugin';

const PLUGINS_DIR = join(__dirname, '..', '..', 'fixtures', 'plugins');
const SHOP_DIR = join(PLUGINS_DIR, 'shop');
const SAVE = 'shop-e2e';
const PLAYER = 'Player';
const ok: PluginRunGuard = () => 'ok';

interface StockEntry {
  id: string;
  price: number;
  limit?: number;
  item: { name: string; type?: string; rarity?: string; description?: string };
}

const readText = (name: string) => readFileSync(join(SHOP_DIR, name), 'utf8');
const stock = JSON.parse(readText('stock.json')) as { items: StockEntry[] };

function loadManifest(): PluginManifest {
  const coercion = coercePluginManifest(readText('manifest.json'));
  expect(coercion.errors).toEqual([]);
  return coercion.manifest!;
}

/** 与 shop.js 的 buildCommands 同形：先扣钱，再发一件物品 */
function shopCommands(entry: StockEntry): unknown[] {
  return [
    { type: 'money.spend', amount: entry.price },
    { type: 'item.grant', item: { quantity: 1, ...entry.item } },
  ];
}

async function player() {
  return (await getCharacters(SAVE)).find((c) => c.type === 'player')!;
}

async function setMoney(money: number): Promise<void> {
  await saveCharacter({ ...(await player()), money });
}

/** 宿主侧的一次 commit：翻译 → 提交（D1 plugin-host 的写链路去掉锁与刷新后的最小形） */
async function commitAsHost(manifest: PluginManifest, input: unknown): Promise<PluginResult> {
  const { commands, expect: expectList } = (input ?? {}) as {
    commands?: unknown;
    expect?: unknown;
  };
  const translated = translatePluginCommands({
    commands,
    expect: expectList,
    declared: manifest.capabilities.commands,
    saveId: SAVE,
    playerName: PLAYER,
  });
  if (!translated.ok) return translated;
  return createStateManager(SAVE).commitPluginCommand({
    saveId: SAVE,
    pluginId: manifest.id,
    patches: translated.patches,
    expect: translated.expect,
    isAllowed: ok,
    commandIndexOfPatch: translated.commandIndexOfPatch,
  });
}

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await saveSaveSlot({
    id: SAVE,
    name: SAVE,
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: { characterName: PLAYER, userName: '玩家', gameStartTime: '', totalTurns: 1 },
  });
  await saveCharacter(
    createDefaultCharacterState({
      id: 'p',
      saveId: SAVE,
      name: PLAYER,
      type: 'player',
      money: 50,
    }),
  );
});

describe('商店示例包：服务端与安装计划都接受', () => {
  const diskFiles = readdirSync(SHOP_DIR).sort();

  it('包内只有设计 §7 列出的六个文件，图标是小于 2KB 的 PNG', () => {
    expect(diskFiles).toEqual([
      'icon.png',
      'manifest.json',
      'shop.css',
      'shop.html',
      'shop.js',
      'stock.json',
    ]);
    const icon = readFileSync(join(SHOP_DIR, 'icon.png'));
    expect(icon.length).toBeLessThan(2048);
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('listPlugins 列出它，没有跳过的文件，大小与哈希与磁盘一致', async () => {
    const listing = await listPlugins(PLUGINS_DIR);
    expect(listing.ok).toBe(true);
    if (!listing.ok) return;
    const shop = listing.plugins.find((p) => p.id === 'shop');
    expect(shop).toBeDefined();
    expect(shop!.error).toBeUndefined();
    expect(shop!.skipped).toEqual([]);
    expect(shop!.manifestText).toBe(readText('manifest.json'));
    expect(shop!.files.map((f) => f.path).sort()).toEqual(diskFiles);
    for (const file of shop!.files) {
      const bytes = readFileSync(join(SHOP_DIR, file.path));
      expect(file.size).toBe(bytes.length);
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(shop!.totalBytes).toBeLessThan(PLUGIN_DIR_LIMITS.maxPluginBytes);
  });

  it('readPluginFile 逐个读得出每个文件', async () => {
    for (const name of diskFiles) {
      const read = await readPluginFile(PLUGINS_DIR, 'shop', name);
      expect(read.ok, name).toBe(true);
      if (read.ok) expect(read.size).toBe(statSync(join(SHOP_DIR, name)).size);
    }
  });

  it('coercePluginManifest 无错误、可安装、兼容，权限与设计 §7 一致', () => {
    const coercion = coercePluginManifest(readText('manifest.json'));
    expect(coercion.errors).toEqual([]);
    expect(coercion.installable).toBe(true);
    expect(coercion.incompatible).toBeUndefined();
    const manifest = coercion.manifest!;
    expect(manifest.id).toBe('shop');
    expect(manifest.network).toEqual([]);
    expect(manifest.capabilities.read).toEqual(['player']);
    expect(manifest.capabilities.commands).toEqual(['money.spend', 'item.grant']);
    expect(manifest.contributions).toHaveLength(1);
    expect(manifest.contributions[0]).toMatchObject({
      slot: 'game.toolbar',
      surface: 'window',
      entry: 'shop.html',
      icon: 'icon.png',
    });
  });

  it('planPluginInstall 用服务端清单算出的内容哈希判为 ok / install', async () => {
    const listing = await listPlugins(PLUGINS_DIR);
    if (!listing.ok) throw new Error(listing.message);
    const shop = listing.plugins.find((p) => p.id === 'shop')!;
    const contentHash = computePluginContentHash(shop.files);
    const plan = planPluginInstall({
      manifestRaw: shop.manifestText,
      files: shop.files,
      contentHash,
      source: 'local',
      existing: undefined,
      folderId: shop.id,
    });
    expect(plan.errors).toEqual([]);
    expect(plan.status).toBe('ok');
    expect(plan.action).toBe('install');
    expect(plan.fileCount).toBe(diskFiles.length);
    expect(plan.contentHash).toBe(contentHash);
  });
});

describe('商店示例：命令批次在真存档上提交', () => {
  const ration = stock.items[0];

  it('余额足够：扣钱、发物品，一次提交全部落库', async () => {
    const manifest = loadManifest();
    const result = await commitAsHost(manifest, { commands: shopCommands(ration) });
    expect(result).toEqual({ ok: true });
    const after = await player();
    expect(after.money).toBe(50 - ration.price);
    expect(after.inventory).toEqual([
      expect.objectContaining({ name: ration.item.name, quantity: 1 }),
    ]);
  });

  it('余额不足：PRECONDITION_FAILED，钱与背包都不变', async () => {
    const manifest = loadManifest();
    await setMoney(ration.price - 1);
    const before = await player();
    const result = await commitAsHost(manifest, { commands: shopCommands(ration) });
    expect(result).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
    const after = await player();
    expect(after.money).toBe(ration.price - 1);
    expect(after.inventory).toEqual(before.inventory);
  });

  it('货架上每一项都能被翻译（物品类型与品质都是引擎认得的值）', () => {
    const manifest = loadManifest();
    for (const entry of stock.items) {
      const translated = translatePluginCommands({
        commands: shopCommands(entry),
        expect: [],
        declared: manifest.capabilities.commands,
        saveId: SAVE,
        playerName: PLAYER,
      });
      expect(translated.ok, entry.id).toBe(true);
    }
  });
});

describe('商店示例：shop.js 在 jsdom 里跑通购买流程', () => {
  /** 假 host：读投影、提交走真链路，存储与 AI 记在内存里 */
  function createFakeHost(manifest: PluginManifest) {
    const saveBag = new Map<string, unknown>();
    const notes: string[] = [];
    const host = {
      read: async (view: string) =>
        buildPluginView(view as 'player', {
          characters: await getCharacters(SAVE),
          profile: await getProfile(SAVE),
          messages: [],
          plotEvents: [],
          run: { generating: false, inCombat: false, turn: 1, mode: 'agent' },
        }),
      subscribe: () => Promise.resolve(() => undefined),
      commit: (input: unknown) => commitAsHost(manifest, input),
      storage: {
        save: {
          get: (key: string) => Promise.resolve(saveBag.get(key)),
          set: (key: string, value: unknown) => {
            saveBag.set(key, JSON.parse(JSON.stringify(value)) as unknown);
            return Promise.resolve(undefined);
          },
          remove: (key: string) => Promise.resolve(void saveBag.delete(key)),
        },
      },
      assets: { readText: (path: string) => Promise.resolve(readText(path)) },
      ai: {
        note: (text: string) => {
          notes.push(text);
          return Promise.resolve(undefined);
        },
      },
    };
    return { host, saveBag, notes };
  }

  function mountShop(host: unknown): void {
    const parsed = new DOMParser().parseFromString(readText('shop.html'), 'text/html');
    // 只采纳 body 的元素节点；<script src> 换成下面直接执行 shop.js
    parsed.querySelectorAll('script').forEach((s) => s.remove());
    document.body.replaceChildren(
      ...Array.from(parsed.body.childNodes).map((n) => document.adoptNode(n)),
    );
    // 与帧内装载器一样，页面脚本把 `host` 当全局读
    new Function('host', readText('shop.js'))(host);
  }

  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('#stock button'));
  const noticeText = () => document.getElementById('notice')!.textContent;

  it('渲染货架与余额，点购买后扣钱、发物品、记已售、发 AI 备注', async () => {
    const manifest = loadManifest();
    const { host, saveBag, notes } = createFakeHost(manifest);
    mountShop(host);
    await vi.waitFor(() => expect(document.getElementById('balance')!.textContent).toBe('50 G'));
    expect(buttons()).toHaveLength(stock.items.length);

    const ration = stock.items[0];
    buttons()[0].click();
    await vi.waitFor(() => expect(noticeText()).toContain(ration.item.name));
    const after = await player();
    expect(after.money).toBe(50 - ration.price);
    expect(after.inventory.map((i) => i.name)).toEqual([ration.item.name]);
    expect(saveBag.get('sold')).toEqual({ [ration.id]: 1 });
    expect(notes).toHaveLength(1);
  });

  it('余额不足时显示「金钱不足」，钱与背包都不变', async () => {
    const manifest = loadManifest();
    await setMoney(1);
    const { host, notes } = createFakeHost(manifest);
    mountShop(host);
    await vi.waitFor(() => expect(document.getElementById('balance')!.textContent).toBe('1 G'));

    buttons()[0].click();
    await vi.waitFor(() => expect(noticeText()).toBe('金钱不足'));
    const after = await player();
    expect(after.money).toBe(1);
    expect(after.inventory).toEqual([]);
    expect(notes).toEqual([]);
  });
});
