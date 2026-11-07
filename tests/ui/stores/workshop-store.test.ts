/**
 * workshop-store 测试（Phase 1 / P1-3）
 *
 * 本 store 是**执行器**，所以这里断言的从来不是「转换对不对」（那是
 * workshop-install-plan.test.ts 的活），而是**落库这件事本身**:
 *
 * 1. 三处都写到了（`worldBooks` / `beautifierRules` / `workshopProjects`）
 * 2. **UID 按项目隔离且重装稳定** —— 装 A → 卸 A → 装 B，不得让旧存档指向另一个项目。
 *    安装顺序、本机设置和其他存档都不参与身份生成。
 * 3. 冲突时**一行都不写**（D15），确认后才覆盖
 * 4. **丢弃必须 loud** —— 客户端侧 notes 与计划侧 notes 都要落进 droppedNotes
 * 5. 网络失败 → `broken`，不抛穿
 *
 * 网络全程走 `setWorkshopFetch()` 注入缝喂假响应，**不发任何真实请求**；
 * 数据层是真 Dexie + fake-indexeddb。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { getDatabase } from '@engine/persistence/database';
import type { WorkshopProject } from '@engine/types/types';
import { normalizeWorkshopNotes } from '@engine/workshop/workshop-types';

import { worldBookUidStem } from '@engine/content/worldbook-uid';
import { hashWorkshopContent } from '@engine/workshop/workshop-install-plan';

const uid = (projectId: string, name = '甲') =>
  `workshop.${projectId.toLowerCase()}:creative_workshop/${worldBookUidStem(name)}_${hashWorkshopContent(name)}`;
// 内置世界书 / 预设美化规则都靠 fetch 读静态文件，node 下不可用 —— 直接替身，
// 免得每次 init 都去撞一次注定失败的 fetch。
vi.mock('@engine/content/builtin-worldbooks', () => ({
  loadBuiltInWorldBooks: vi.fn(async () => []),
  loadWorldBooksWithFallback: vi.fn(async (books: unknown[]) => books ?? []),
}));
vi.mock('@engine/story/beautifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/story/beautifier')>();
  return { ...actual, loadPresetRules: vi.fn(async () => []) };
});

import {
  buildProjectUrl,
  clearWorkshopCache,
  resetWorkshopClient,
  setWorkshopConfig,
  setWorkshopFetch,
} from '../../../src/ui/lib/workshop-client';

/** 测试用社区源（D41：真实地址已改运行时配置，默认 unset） */
const WORKSHOP_API_BASE = 'https://workshop.test';
import { useWorkshopStore } from '../../../src/ui/stores/workshop-store';
import { useWorldBookStore } from '../../../src/ui/stores/worldbook-store';
import { useBeautifierStore } from '../../../src/ui/stores/beautifier-store';
import { useSettingsStore } from '../../../src/ui/stores/settings-store';

// ═══════════════════════════════════════════════════════════
// 环境替身
// ═══════════════════════════════════════════════════════════

const lsBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsBacking.get(k) ?? null,
  setItem: (k: string, v: string) => void lsBacking.set(k, v),
  removeItem: (k: string) => void lsBacking.delete(k),
  clear: () => lsBacking.clear(),
  get length() {
    return lsBacking.size;
  },
  key: (i: number) => [...lsBacking.keys()][i] ?? null,
});

/** url → 响应体（JSON 可序列化）。没登记的 url 一律 404 */
const upstream = new Map<string, unknown>();
/** 命中即抛（模拟断网）；`'*'` 表示全部 */
const offline = new Set<string>();

function installFetchMock(): void {
  setWorkshopFetch(async (url: string) => {
    if (offline.has('*') || offline.has(url)) throw new Error('模拟断网');
    const body = upstream.get(url);
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  });
}

// ═══════════════════════════════════════════════════════════
// 上游夹具
// ═══════════════════════════════════════════════════════════

function downloadUrlFor(id: string): string {
  return `${WORKSHOP_API_BASE}/api/files/${id}.json`;
}

/** 详情预览形状：uid 是**字符串**，有 `enabled` */
function previewEntry(comment: string, content: string, uid: number) {
  return {
    uid: String(uid),
    comment,
    content,
    enabled: true,
    key: [comment],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 4,
  };
}

/** 载荷文件形状：uid 是**数字**，只有 `disable` */
function payloadEntry(comment: string, content: string, uid: number) {
  return {
    uid,
    comment,
    content,
    disable: false,
    key: [comment],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 4,
  };
}

/** markdownOnly: true 是为了不额外产出 note，让测试能精确断言 droppedNotes */
function regexEntry(id: string, scriptName: string, over: Record<string, unknown> = {}) {
  return {
    id,
    scriptName,
    findRegex: '/(妲丽安)/g',
    replaceString: '<b>$1</b>',
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    trimStrings: [],
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    placement: [2],
    ...over,
  };
}

function projectJson(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    rootProjectId: id,
    name: `项目${id}`,
    description: `${id} 的简介`,
    version: '1.0.0',
    authorGlobalName: '某位作者',
    tags: ['命定核心'],
    downloadUrl: downloadUrlFor(id),
    fileSize: 2048,
    // 上游那 17 个身份/审核/社交字段，确认被丢弃
    likesCount: 99,
    userLiked: true,
    ...over,
  };
}

interface UpstreamSpec {
  version?: string;
  /** [名字, 正文] 对 */
  entries?: Array<[string, string]>;
  regexes?: Array<ReturnType<typeof regexEntry>>;
  /** 传 false 则项目不带 downloadUrl，走详情预览那条回退支 */
  withDownload?: boolean;
}

/** 把一个项目登记进上游（详情 + 载荷两个 url） */
function publish(id: string, spec: UpstreamSpec = {}): void {
  const entries = spec.entries ?? [['条目甲', '甲的正文']];
  const regexes = spec.regexes ?? [];
  const withDownload = spec.withDownload !== false;

  const project = projectJson(id, {
    version: spec.version ?? '1.0.0',
    downloadUrl: withDownload ? downloadUrlFor(id) : '',
  });

  upstream.set(buildProjectUrl(id), {
    project,
    // 有 downloadUrl 时详情预览不会被使用；没有时它就是唯一内容源
    worldbookEntriesPreview: withDownload
      ? []
      : entries.map(([name, content], i) => previewEntry(name, content, i)),
    regexEntriesPreview: regexes,
  });

  if (withDownload) {
    upstream.set(
      downloadUrlFor(id),
      entries.map(([name, content], i) => payloadEntry(name, content, i)),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// 断言助手
// ═══════════════════════════════════════════════════════════

async function dbRow(id: string): Promise<WorkshopProject | undefined> {
  return getDatabase().workshopProjects.get(id);
}

async function dbBookEntries(id: string) {
  const book = await getDatabase().worldBooks.get(`workshop:${id}`);
  return book?.entries ?? [];
}

async function dbRuleIds(id: string): Promise<string[]> {
  const rows = await getDatabase().beautifierRules.toArray();
  return rows.filter((r) => r.id.startsWith(`workshop-rule:${id}:`)).map((r) => r.id);
}

/** 造一个只带启用轴的存档行（其余字段取最小合法值） */
async function seedSave(slot: number, enabledWorldBookEntries: unknown[]): Promise<void> {
  await getDatabase().saves.put({
    id: `save-${slot}`,
    name: `存档${slot}`,
    slot,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '主角',
      userName: '玩家',
      gameStartTime: '复兴纪元 1 年',
      totalTurns: 0,
      enabledWorldBookEntries: enabledWorldBookEntries as string[],
    },
  });
}

async function freshStore() {
  setActivePinia(createPinia());
  const store = useWorkshopStore();
  await store.init();
  return store;
}

// ═══════════════════════════════════════════════════════════

describe('workshop-store', () => {
  beforeEach(async () => {
    lsBacking.clear();
    upstream.clear();
    offline.clear();
    resetWorkshopClient();
    setWorkshopConfig({ apiBase: WORKSHOP_API_BASE, loginHint: '' });
    installFetchMock();
    const db = getDatabase();
    await db.worldBooks.clear();
    await db.workshopProjects.clear();
    await db.beautifierRules.clear();
    await db.saves.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    resetWorkshopClient();
    vi.clearAllMocks();
  });

  // ── 安装：三处落库 ────────────────────────────────────
  it('安装把三处都写进 Dexie，命名空间 UID 与项目字段正确', async () => {
    publish('P1', {
      entries: [
        ['条目甲', '甲的正文'],
        ['条目乙', '乙的正文'],
      ],
      regexes: [regexEntry('r1', '高亮妲丽安'), regexEntry('r2', '第二条')],
    });

    const store = await freshStore();
    const outcome = await store.install('P1');
    expect(outcome.status).toBe('installed');

    // 1) 世界书行
    const book = await getDatabase().worldBooks.get('workshop:P1');
    expect(book).toBeDefined();
    expect(book!.partition).toBe('creative_workshop');
    expect(book!.builtIn).toBe(false);
    expect(book!.name).toBe('项目P1');
    expect(book!.entries.map((e) => e.name)).toEqual(['条目甲', '条目乙']);
    // 上游数字编号仅作溯源；运行时身份由项目和名称确定。
    expect(book!.entries.map((e) => e.uid)).toEqual([uid('P1', '条目甲'), uid('P1', '条目乙')]);
    // D14 溯源
    expect(book!.entries[0].extra?.workshop?.projectId).toBe('P1');
    expect(typeof book!.entries[0].extra?.workshop?.sourceHash).toBe('string');

    // 2) 美化规则行
    expect(await dbRuleIds('P1')).toEqual(['workshop-rule:P1:r1', 'workshop-rule:P1:r2']);
    const rule = (await getDatabase().beautifierRules.get('workshop-rule:P1:r1'))!;
    expect(rule.enabled).toBe(true);
    expect(rule.autoEnable?.worldBookIds).toEqual(['workshop:P1']);
    expect(rule.group).toContain('项目P1');

    // 3) 项目行
    const row = (await dbRow('P1'))!;
    expect(row.installState).toBe('installed');
    expect(row.installedVersion).toBe('1.0.0');
    expect(row).not.toHaveProperty('uidRange');
    expect(row.installedAt).toBeGreaterThan(0);
    expect(row.fetchedAt).toBeGreaterThan(0);
    expect(row.tags).toEqual(['命定核心']);
    // 上游社交字段刻意丢弃（D13）
    expect(Object.keys(row)).not.toContain('likesCount');

    // ref 是库的投影
    expect(store.projects).toHaveLength(1);
    expect(store.projects[0].id).toBe('P1');
  });

  it('droppedNotes 同时含客户端侧 notes 与计划侧 notes（丢弃必须 loud）', async () => {
    // withDownload:false → 客户端侧 note「取自详情预览」
    // promptOnly 正则  → 计划侧 note「整条未导入」
    publish('P2', {
      withDownload: false,
      entries: [['条目甲', '甲的正文']],
      regexes: [regexEntry('r1', '仅提示词', { promptOnly: true })],
    });

    const store = await freshStore();
    await store.install('P2');

    const notes = normalizeWorkshopNotes((await dbRow('P2'))!.droppedNotes);
    expect(notes.some((n) => n.text.includes('详情预览'))).toBe(true);
    expect(notes.some((n) => n.text.includes('promptOnly'))).toBe(true);
    // 客户端侧裸串经 normalize 落成结构化 —— 新写入的行不再有裸字符串
    expect(notes.every((n) => typeof n === 'object' && typeof n.kind === 'string')).toBe(true);
    expect(notes.find((n) => n.text.includes('详情预览'))!.kind).toBe('dropped');
    // promptOnly 那条整条没导入 → 没有规则落库
    expect(await dbRuleIds('P2')).toEqual([]);
  });

  // ── 卸载与项目身份隔离 ────────────────────────────────
  it('卸载清三处，旧存档不会命中另一项目的同名条目；重装恢复原 UID', async () => {
    publish('A', {
      entries: [
        ['甲', 'a1'],
        ['乙', 'a2'],
        ['丙', 'a3'],
      ],
      regexes: [regexEntry('ra', 'A 的正则')],
    });
    publish('B', {
      entries: [
        ['甲', 'b1'],
        ['乙', 'b2'],
      ],
    });
    const store = await freshStore();
    await store.install('A');
    const idsA = (await dbBookEntries('A')).map((e) => e.uid);
    await seedSave(0, idsA);
    expect(await store.uninstall('A')).toBe(true);
    expect(await dbRow('A')).toBeUndefined();
    expect(await getDatabase().worldBooks.get('workshop:A')).toBeUndefined();
    expect(await dbRuleIds('A')).toEqual([]);
    expect(store.projects).toHaveLength(0);
    await store.install('B');
    const idsB = (await dbBookEntries('B')).map((e) => e.uid);
    expect(idsB).toEqual([uid('B', '甲'), uid('B', '乙')]);
    expect(idsB.every((id) => !idsA.includes(id))).toBe(true);
    expect((await getDatabase().saves.get('save-0'))!.metadata.enabledWorldBookEntries).toEqual(
      idsA,
    );
    await store.install('A');
    expect((await dbBookEntries('A')).map((e) => e.uid)).toEqual(idsA);
  });

  it('清空本机设置后重新初始化，已装和新装项目 UID 均保持确定性', async () => {
    publish('A', {
      entries: [
        ['甲', 'a1'],
        ['乙', 'a2'],
      ],
    });
    publish('C', { entries: [['甲', 'c1']] });
    const store = await freshStore();
    await store.install('A');
    const idsA = (await dbBookEntries('A')).map((e) => e.uid);
    lsBacking.clear();
    const revived = await freshStore();
    expect((await dbBookEntries('A')).map((e) => e.uid)).toEqual(idsA);
    await revived.install('C');
    expect((await dbBookEntries('C')).map((e) => e.uid)).toEqual([uid('C')]);
    expect(idsA).not.toContain(uid('C'));
  });

  // ── 存档引用不参与身份生成 ──────────────────────────────
  it('卸载和设置丢失后，旧存档的 UID 不会被新项目复用', async () => {
    const old = uid('A', '丁');
    const saved = ['fated:system_core/core', old];
    await seedSave(0, saved);
    publish('B', { entries: [['丁', 'b1']] });
    lsBacking.clear();
    const store = await freshStore();
    await store.install('B');
    expect((await dbBookEntries('B')).map((e) => e.uid)).toEqual([uid('B', '丁')]);
    expect(uid('B', '丁')).not.toBe(old);
    expect((await getDatabase().saves.get('save-0'))!.metadata.enabledWorldBookEntries).toEqual(
      saved,
    );
  });

  it('多个存档的其他项目引用不影响新装 UID，也不会被改写', async () => {
    const selections = [[uid('A')], [uid('B'), uid('C')], ['fated:character/person']];
    for (const [slot, entries] of selections.entries()) await seedSave(slot, entries);
    publish('M', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await store.install('M');
    expect((await dbBookEntries('M')).map((e) => e.uid)).toEqual([uid('M')]);
    for (const [slot, entries] of selections.entries()) {
      expect(
        (await getDatabase().saves.get(`save-${slot}`))!.metadata.enabledWorldBookEntries,
      ).toEqual(entries);
    }
  });

  it('存档里的畸形和旧数字引用不参与身份生成，不抛或静默改写', async () => {
    const entries = [
      'creative_workshop:abc',
      'creative_workshop:',
      'creative_workshop',
      '',
      ':5',
      42,
      null,
      'creative_workshop:9',
    ];
    await seedSave(0, entries);
    publish('D', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await store.install('D');
    expect((await dbBookEntries('D')).map((e) => e.uid)).toEqual([uid('D')]);
    expect((await getDatabase().saves.get('save-0'))!.metadata.enabledWorldBookEntries).toEqual(
      entries,
    );
  });

  it('存档无工坊条目或 metadata 缺字段时仍使用相同确定性 UID', async () => {
    await seedSave(0, ['fated:system_core/core']);
    await getDatabase().saves.put({
      id: 'save-9',
      name: '老存档',
      slot: 9,
      createdAt: 1,
      updatedAt: 1,
      activeSnapshotId: null,
      // Phase 10h 之前的存档没有 enabledWorldBookEntries
      metadata: { characterName: '甲', userName: '乙', gameStartTime: '', totalTurns: 0 },
    });
    publish('S', { entries: [['甲', 'x']] });

    const store = await freshStore();
    await store.install('S');
    expect((await dbBookEntries('S')).map((e) => e.uid)).toEqual([uid('S')]);
  });

  it('会话中途出现的存档引用与随后安装的同一项目 UID 完全一致', async () => {
    publish('T', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await seedSave(0, [uid('T')]);
    await store.install('T');
    const saved = (await getDatabase().saves.get('save-0'))!;
    expect((await dbBookEntries('T')).map((e) => e.uid)).toEqual(
      saved.metadata.enabledWorldBookEntries,
    );
  });

  it('卸载未安装的项目返回 false，什么都不动', async () => {
    const store = await freshStore();
    expect(await store.uninstall('不存在')).toBe(false);
  });

  // ── 更新 ──────────────────────────────────────────────
  it('无冲突更新直接覆盖：存活 UID 不变，新增独立身份，移除的删掉', async () => {
    publish('U', {
      entries: [
        ['甲', 'v1 甲'],
        ['乙', 'v1 乙'],
      ],
    });
    const store = await freshStore();
    await store.install('U');
    expect((await dbBookEntries('U')).map((e) => e.uid)).toEqual([uid('U', '甲'), uid('U', '乙')]);

    // 上游发新版：甲改了正文、乙被移除、丙是新增
    clearWorkshopCache();
    publish('U', {
      version: '2.0.0',
      entries: [
        ['甲', 'v2 甲'],
        ['丙', 'v2 丙'],
      ],
    });

    const outcome = await store.install('U');
    expect(outcome.status).toBe('installed');

    const entries = await dbBookEntries('U');
    expect(entries.map((e) => e.name)).toEqual(['甲', '丙']);
    expect(entries[0].uid).toBe(uid('U', '甲')); // 存活 UID 不变 → 存档启用轴无需重写
    expect(entries[0].content).toBe('v2 甲');
    expect(entries[1].uid).toBe(uid('U', '丙')); // 不复用已移除的乙的身份

    const row = (await dbRow('U'))!;
    expect(row.installedVersion).toBe('2.0.0');
    expect(normalizeWorkshopNotes(row.droppedNotes).some((n) => n.text.includes('已移除'))).toBe(
      true,
    );
    // 只有一行项目、一本书
    expect(await getDatabase().workshopProjects.count()).toBe(1);
    expect(await getDatabase().worldBooks.count()).toBe(1);
  });

  it('用户改过的条目：更新不自动提交，返回冲突；确认后才覆盖', async () => {
    publish('K', { entries: [['甲', '原始正文']] });
    const store = await freshStore();
    await store.install('K');

    // 用户在条目编辑器里改了正文（保留 extra，走世界书唯一入口）
    const worldbook = useWorldBookStore();
    const original = worldbook.getBook('workshop:K')!.entries[0];
    await worldbook.upsertEntry('workshop:K', { ...original, content: '我自己改的' });

    clearWorkshopCache();
    publish('K', { version: '2.0.0', entries: [['甲', '上游新正文']] });

    const outcome = await store.install('K');
    expect(outcome.status).toBe('needs_confirmation');
    if (outcome.status !== 'needs_confirmation') throw new Error('unreachable');
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toMatchObject({ uid: uid('K'), name: '甲' });

    // ★ 一行都没写
    expect((await dbBookEntries('K'))[0].content).toBe('我自己改的');
    expect((await dbRow('K'))!.installedVersion).toBe('1.0.0');

    // UI 弹警告 → 用户确认 → 覆盖式提交（不做逐条保留）
    const confirmed = await store.confirmInstall(outcome.prepared);
    expect(confirmed.status).toBe('installed');
    expect((await dbBookEntries('K'))[0].content).toBe('上游新正文');
    expect((await dbBookEntries('K'))[0].uid).toBe(uid('K'));
    expect((await dbRow('K'))!.installedVersion).toBe('2.0.0');
  });

  it('更新时上游删掉的正则一并清掉，不留孤儿规则', async () => {
    publish('R', { regexes: [regexEntry('r1', '一'), regexEntry('r2', '二')] });
    const store = await freshStore();
    await store.install('R');
    expect(await dbRuleIds('R')).toHaveLength(2);

    clearWorkshopCache();
    publish('R', { version: '2.0.0', regexes: [regexEntry('r2', '二改名了')] });
    await store.install('R');

    expect(await dbRuleIds('R')).toEqual(['workshop-rule:R:r2']);
    expect((await getDatabase().beautifierRules.get('workshop-rule:R:r2'))!.name).toBe('二改名了');
  });

  // ── 幂等 ──────────────────────────────────────────────
  it('重复安装同一版本：不产生重复行、重复规则，UID 保持一致', async () => {
    publish('I', {
      entries: [
        ['甲', 'x'],
        ['乙', 'y'],
      ],
      regexes: [regexEntry('r1', '唯一')],
    });
    const store = await freshStore();
    await store.install('I');
    const firstRow = (await dbRow('I'))!;

    clearWorkshopCache();
    await store.install('I');
    const secondRow = (await dbRow('I'))!;

    expect(await getDatabase().workshopProjects.count()).toBe(1);
    expect(await getDatabase().worldBooks.count()).toBe(1);
    expect(await getDatabase().beautifierRules.count()).toBe(1);
    expect((await dbBookEntries('I')).map((e) => e.uid)).toEqual([uid('I', '甲'), uid('I', '乙')]);
    // 「第一次装进来是什么时候」不被重装重置
    expect(secondRow.installedAt).toBe(firstRow.installedAt);
    expect(store.projects).toHaveLength(1);
  });

  // ── 网络失败 ───────────────────────────────────────────
  it('已装项目更新时断网 → installState 置 broken，不抛', async () => {
    publish('N', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await store.install('N');
    expect((await dbRow('N'))!.installState).toBe('installed');

    clearWorkshopCache();
    offline.add('*');
    const outcome = await store.install('N');
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.error.kind).toBe('network');

    expect((await dbRow('N'))!.installState).toBe('broken');
    // 内容没被破坏
    expect(await dbBookEntries('N')).toHaveLength(1);
  });

  it('从未安装过的项目拉取失败 → failed，不留任何行', async () => {
    const store = await freshStore();
    const outcome = await store.install('查无此项');
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('unreachable');
    expect(outcome.error.kind).toBe('http');
    expect(outcome.error.status).toBe(404);

    expect(await getDatabase().workshopProjects.count()).toBe(0);
    expect(await getDatabase().worldBooks.count()).toBe(0);
  });

  it('checkUpdate 刷新版本对比，失败时置 broken', async () => {
    publish('V', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await store.install('V');

    clearWorkshopCache();
    publish('V', { version: '3.1.4', entries: [['甲', 'x']] });
    const check = await store.checkUpdate('V');
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');
    expect(check.hasUpdate).toBe(true);
    expect(check.project.installState).toBe('update_available');
    // 只刷元数据，内容一个字节没动
    expect(check.project.installedVersion).toBe('1.0.0');
    expect((await dbBookEntries('V'))[0].content).toBe('x');

    clearWorkshopCache();
    offline.add('*');
    const failed = await store.checkUpdate('V');
    expect(failed.ok).toBe(false);
    expect((await dbRow('V'))!.installState).toBe('broken');
  });

  // ── 与既有 store 的关系 ────────────────────────────────
  it('工坊书是普通 worldBooks 行：走 worldbook-store，且不回流 settings', async () => {
    publish('W', { entries: [['甲', 'x']] });
    const store = await freshStore();
    await store.install('W');

    const worldbook = useWorldBookStore();
    expect(worldbook.getBook('workshop:W')).toBeDefined();
    expect(worldbook.books.filter((b) => b.partition === 'creative_workshop')).toHaveLength(1);

    const beautifier = useBeautifierStore();
    expect(beautifier.userRules.every((r) => !r.isBuiltin)).toBe(true);

    // 书内容一个字节都不许回到 settings / localStorage（Phase 0 的验收线）
    useSettingsStore().saveNow();
    const serialized =
      JSON.stringify(useSettingsStore().settings) + (lsBacking.get('fated-poem-settings') ?? '');
    expect(serialized).not.toContain('"entries"');
    expect(serialized).not.toContain('项目W');
  });

  it('init 幂等：并发/重复调用只跑一次', async () => {
    publish('Q', { entries: [['甲', 'x']] });
    setActivePinia(createPinia());
    const store = useWorkshopStore();
    await Promise.all([store.init(), store.init()]);
    await store.init();
    expect(store.ready).toBe(true);
    expect(store.projects).toHaveLength(0);
  });
});
