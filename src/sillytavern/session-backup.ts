/**
 * session-backup.ts — 单存档（一周目）导出 / 导入
 *
 * 与 `FullBackup`（database.ts）刻意分工：那份是「整个库照原样搬走再照原样放回去」，
 * 这份是「**把一周目送给别人**」。差别不在体积，在三条语义：
 *
 * 1. **只收每存档的表** —— 表清单与 `deleteSaveSlot` 同源（它是「什么算这个存档的」
 *    唯一权威判据）。全局库（worldBooks / presets / imagePresets / contentPacks /
 *    audio* / asset*）一行都不进，导入侧也一行都不改。
 * 2. **带一份内容依赖清单** —— 存档本身不含世界书正文，但它**指着**世界书条目
 *    （`metadata.enabledWorldBookEntries` 里的 `${partition}:${uid}` 串）。收件人库里
 *    没有那些条目时，存档能导进去、跑起来却少了半个世界，而且**没有任何报错**。
 *    清单让「缺什么」在导入**之前**就说得出来（`checkSessionSaveDependencies`）。
 * 3. **导入必重发 id** —— 同一个文件导两次得到两个互不相干的存档，且永不撞上库里已有的行。
 *    不重发 id 的话，第二次导入是**静默覆盖**第一次（Dexie `put` 语义），
 *    用户看到的是「怎么只有一个存档」而不是任何一种错误。
 *
 * 🔴 **字节永不随行**：`sceneImageBlobs` 不导出（与 FullBackup 同口径 —— 图片字节进
 *    JSON 会爆炸）。导出的插画记录一律打上 `blobDropped`，于是收件人那边图鉴显示
 *    「字节已清理 + 重画」这个**已有的、说得通的**状态，而不是一格坏图。
 *
 * 设计参考：database.ts 的 `deleteSaveSlot`（表清单）/ `validateBackupOrThrow`（三态校验）。
 */

import { getDatabase, characterAppearanceKey, DB_VERSION } from './database';
// 记忆编号分配器与 generateMemoryId() **共用同一个实现**（两处各写一份就是漂移的来路：
// 一边补齐到 6 位、另一边截断到 6 位，撞号了也不会有任何报错）。
import { allocateMemoryIds } from './memory-summarizer';
import { WORKSHOP_PARTITION } from './workshop-types';
import type {
  SaveSlot,
  SaveProfile,
  CharacterState,
  ChatMessage,
  Snapshot,
  MemoryRecord,
  PlotEvent,
  PlotOutline,
  WorldBook,
  WorkshopProject,
} from './types';
import type { SceneImageRecord, CharacterSessionAppearance } from './types-image';

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 内容依赖清单 —— 「这份存档要跑起来，收件人库里得有什么」。
 *
 * 清单是**导出时点的观察**，不是承诺：每一项都可能在收件人那边缺席或版本不同，
 * 这正是 `checkSessionSaveDependencies` 要回答的问题。
 */
export interface SessionDependencies {
  /** 装着的内容包（通常 0–1 个）。版本不同不等于不能玩，但值得在导入前说一声 */
  packs: Array<{ packId: string; packVersion: string; name?: string }>;
  /**
   * 本存档启用的世界书条目 token（`${partition}:${uid}`），带导出侧解析出的书名/条目名。
   *
   * 🔴 解析不出来的 token **照样进清单**（只是没有注释）—— 导出方自己都缺的条目，
   *    收件人更可能缺，把它藏起来只会让体检结果偏乐观。
   */
  worldBookEntries: Array<{ token: string; bookName?: string; entryTitle?: string }>;
  /** 上面那些 token 里属于创意工坊的，归拢成项目粒度（UI 粒度是项目，存储粒度是条目） */
  workshopProjects: Array<{ id: string; name: string; version?: string }>;
  /**
   * story 预设 —— **由调用方传入**，本模块不去猜。
   * 选中的预设 id 是全局 UI 状态（localStorage 的 `activePresetId`），不在引擎的可见范围内。
   */
  storyPreset?: { id: string; name: string };
}

/** 单存档备份文件的顶层结构 */
export interface SessionBackup {
  kind: 'fated-poem-session-save';
  /** = `DB_VERSION`（只作排查标记，导入侧不拿它做判断，与 FullBackup 同口径） */
  version: number;
  exportedAt: number;
  save: SaveSlot;
  profile: SaveProfile | null;
  characters: CharacterState[];
  messages: ChatMessage[];
  snapshots: Snapshot[];
  memories: MemoryRecord[];
  plotEvents: PlotEvent[];
  plotOutlines: PlotOutline[];
  /** 🔴 只有元数据（= 配方），字节永不随行 */
  sceneImages: SceneImageRecord[];
  characterAppearances: CharacterSessionAppearance[];
  dependencies: SessionDependencies;
}

/** 导入前体检结果 —— 只读，永不因内容缺失而抛错 */
export interface SessionImportCheck {
  ok: boolean;
  missingEntries: Array<{ token: string; bookName?: string; entryTitle?: string }>;
  packMismatches: Array<{
    packId: string;
    name?: string;
    expectedVersion: string;
    /** `null` = 这个包压根没装 */
    installedVersion: string | null;
  }>;
  missingStoryPreset?: { id: string; name: string };
}

const SESSION_BACKUP_KIND = 'fated-poem-session-save';

/** `creative_workshop:` —— 工坊条目 token 前缀（与 workshop-enable.ts 同源，值来自 WORKSHOP_PARTITION） */
const WORKSHOP_TOKEN_PREFIX = `${WORKSHOP_PARTITION}:`;

// ═══════════════════════════════════════════════════════════
// 结构判定
// ═══════════════════════════════════════════════════════════

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 结构判定 —— 只认 `kind`，够 UI 在「这是哪种备份文件」的岔路口分流 */
export function isSessionBackup(data: unknown): data is SessionBackup {
  const rec = asRecord(data);
  return rec !== null && rec.kind === SESSION_BACKUP_KIND;
}

// ═══════════════════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════════════════

/** 世界书条目 token → 注释（书名 / 条目名）。先到先得：uid 段按项目分配，实际不重叠 */
function buildEntryAnnotations(
  books: WorldBook[],
): Map<string, { bookName: string; entryTitle: string; entry: WorldBook['entries'][number] }> {
  const index = new Map<
    string,
    { bookName: string; entryTitle: string; entry: WorldBook['entries'][number] }
  >();
  for (const book of books) {
    for (const entry of book.entries ?? []) {
      const token = `${book.partition}:${entry.uid}`;
      if (index.has(token)) continue;
      index.set(token, { bookName: book.name, entryTitle: entry.name, entry });
    }
  }
  return index;
}

/**
 * 工坊 token → 项目。两条解析路径：
 * ① 条目自带溯源（`extra.workshop.projectId`，D14）—— 首选，精确
 * ② uid 落在某项目的 `uidRange` 内 —— 兜底（老条目没有溯源字段）
 *
 * 两条都不中就**不产出**：编不出 projectId 的「项目」进了清单，
 * 收件人那边只会得到一条永远匹配不上的缺失提示。
 */
function resolveWorkshopProjects(
  tokens: string[],
  entryIndex: ReturnType<typeof buildEntryAnnotations>,
  projects: WorkshopProject[],
): SessionDependencies['workshopProjects'] {
  const byId = new Map<string, WorkshopProject>();
  for (const p of projects) byId.set(p.id, p);

  const out: SessionDependencies['workshopProjects'] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    if (!token.startsWith(WORKSHOP_TOKEN_PREFIX)) continue;

    let projectId: string | undefined;
    let projectName: string | undefined;

    const annotation = entryIndex.get(token);
    const provenance = annotation?.entry.extra?.workshop;
    if (provenance?.projectId) {
      projectId = provenance.projectId;
      projectName = provenance.projectName;
    } else {
      const uid = Number(token.slice(WORKSHOP_TOKEN_PREFIX.length));
      if (Number.isFinite(uid)) {
        const hit = projects.find((p) => uid >= p.uidRange?.start && uid <= p.uidRange?.end);
        if (hit) {
          projectId = hit.id;
          projectName = hit.name;
        }
      }
    }

    if (!projectId || seen.has(projectId)) continue;
    seen.add(projectId);
    const row = byId.get(projectId);
    out.push({
      id: projectId,
      name: row?.name ?? projectName ?? projectId,
      version: row?.installedVersion || row?.version,
    });
  }
  return out;
}

/**
 * 导出一个存档为可分享的 `SessionBackup`。
 *
 * @param saveId 要导出的存档
 * @param opts.storyPreset 当前选中的 story 预设（调用方从 UI 状态取；引擎读不到它）
 * @throws 存档不存在时抛中文错误
 */
export async function exportSessionSave(
  saveId: string,
  opts?: { storyPreset?: { id: string; name: string } },
): Promise<SessionBackup> {
  const db = getDatabase();

  const save = await db.saves.get(saveId);
  if (!save) {
    throw new Error(`导出失败：存档不存在（saveId=${saveId}）`);
  }

  // 表清单与 deleteSaveSlot 同源，唯独不含 sceneImageBlobs（字节永不随行）
  const [
    profile,
    characters,
    messages,
    snapshots,
    memories,
    plotEvents,
    plotOutlines,
    sceneImages,
    characterAppearances,
    books,
    projects,
    packs,
  ] = await Promise.all([
    db.saveProfiles.get(saveId),
    db.characters.where('saveId').equals(saveId).toArray(),
    db.messages.where('saveId').equals(saveId).toArray(),
    db.snapshots.where('saveId').equals(saveId).toArray(),
    db.memories.where('saveId').equals(saveId).toArray(),
    db.plotEvents.where('saveId').equals(saveId).toArray(),
    db.plotOutlines.where('saveId').equals(saveId).toArray(),
    db.sceneImages.where('saveId').equals(saveId).toArray(),
    db.characterAppearances.where('saveId').equals(saveId).toArray(),
    db.worldBooks.toArray(),
    db.workshopProjects.toArray(),
    db.contentPacks.toArray(),
  ]);

  // ── 依赖清单 ──
  const tokens: string[] = [];
  const tokenSeen = new Set<string>();
  for (const t of save.metadata?.enabledWorldBookEntries ?? []) {
    if (typeof t !== 'string' || tokenSeen.has(t)) continue;
    tokenSeen.add(t);
    tokens.push(t);
  }

  const entryIndex = buildEntryAnnotations(books);
  const dependencies: SessionDependencies = {
    packs: packs.map((p) => ({
      packId: p.packId,
      packVersion: p.packVersion,
      ...(p.payload?.name ? { name: p.payload.name } : {}),
    })),
    worldBookEntries: tokens.map((token) => {
      const hit = entryIndex.get(token);
      return hit ? { token, bookName: hit.bookName, entryTitle: hit.entryTitle } : { token };
    }),
    workshopProjects: resolveWorkshopProjects(tokens, entryIndex, projects),
    ...(opts?.storyPreset ? { storyPreset: { ...opts.storyPreset } } : {}),
  };

  return {
    kind: SESSION_BACKUP_KIND,
    version: DB_VERSION,
    exportedAt: Date.now(),
    save: structuredClone(save),
    profile: profile ? structuredClone(profile) : null,
    characters: structuredClone(characters),
    messages: structuredClone(messages),
    snapshots: structuredClone(snapshots),
    memories: structuredClone(memories),
    plotEvents: structuredClone(plotEvents),
    plotOutlines: structuredClone(plotOutlines),
    // 🔴 字节不随行 → 导出副本一律打 blobDropped，收件人看到的是「已清理 + 重画」。
    //    只打给**真的画出来过**的记录（status==='done'）：给 failed/queued 打这个标记，
    //    等于对着一条从没画出来的记录说「字节已清理」（判据同 hasStoredSceneImageBytes）。
    //    ⚠️ 改的是**副本**，库里的行一个字节都不动。
    sceneImages: structuredClone(sceneImages).map((row) =>
      row.status === 'done' ? { ...row, blobDropped: true } : row,
    ),
    characterAppearances: structuredClone(characterAppearances),
    dependencies,
  };
}

// ═══════════════════════════════════════════════════════════
// 导入前体检
// ═══════════════════════════════════════════════════════════

/**
 * 导入前只读体检 —— **一个字节都不写**，也**永不因内容缺失抛错**。
 *
 * 缺内容不是错误，是一个需要用户知情后决定的状况（照样导入 / 先去装内容包）。
 * 把它做成抛错，UI 就只能在「拦下来」和「假装没事」之间二选一。
 */
export async function checkSessionSaveDependencies(
  backup: SessionBackup,
): Promise<SessionImportCheck> {
  const db = getDatabase();
  const deps: SessionDependencies = backup?.dependencies ?? {
    packs: [],
    worldBookEntries: [],
    workshopProjects: [],
  };

  const [books, packs] = await Promise.all([db.worldBooks.toArray(), db.contentPacks.toArray()]);

  // 收件人库里现有的 token 全集
  const available = new Set<string>();
  for (const book of books) {
    for (const entry of book.entries ?? []) available.add(`${book.partition}:${entry.uid}`);
  }

  const missingEntries = (deps.worldBookEntries ?? []).filter((e) => !available.has(e.token));

  const installedPacks = new Map(packs.map((p) => [p.packId, p]));
  const packMismatches: SessionImportCheck['packMismatches'] = [];
  for (const want of deps.packs ?? []) {
    const installed = installedPacks.get(want.packId);
    if (!installed) {
      packMismatches.push({
        packId: want.packId,
        ...(want.name ? { name: want.name } : {}),
        expectedVersion: want.packVersion,
        installedVersion: null,
      });
    } else if (installed.packVersion !== want.packVersion) {
      packMismatches.push({
        packId: want.packId,
        ...(want.name ? { name: want.name } : {}),
        expectedVersion: want.packVersion,
        installedVersion: installed.packVersion,
      });
    }
  }

  let missingStoryPreset: SessionImportCheck['missingStoryPreset'];
  if (deps.storyPreset) {
    const hit = await db.presets.get(deps.storyPreset.id);
    if (!hit) missingStoryPreset = { ...deps.storyPreset };
  }

  return {
    ok: missingEntries.length === 0 && packMismatches.length === 0 && !missingStoryPreset,
    missingEntries,
    packMismatches,
    ...(missingStoryPreset ? { missingStoryPreset } : {}),
  };
}

// ═══════════════════════════════════════════════════════════
// 导入
// ═══════════════════════════════════════════════════════════

/**
 * 旧 id → 新 id 的**惰性**映射。
 *
 * 惰性是关键：快照里嵌着的角色/消息/剧情副本可能引用**顶层数组里已经没有**的行
 * （角色后来被删了、消息被回退掉了）。严格查表会把这些旧 id 原样留下 ——
 * 于是第二次导入同一个文件时，两个存档的快照里出现同一个 id，`bulkPut` 静默互相覆盖。
 */
class IdMap {
  private readonly map = new Map<string, string>();

  get(oldId: string): string {
    let next = this.map.get(oldId);
    if (next === undefined) {
      next = crypto.randomUUID();
      this.map.set(oldId, next);
    }
    return next;
  }

  /** 严格查表 —— 只在旧 id 确实是本备份里的行时才改写 */
  peek(oldId: string): string | undefined {
    return this.map.get(oldId);
  }
}

/**
 * 「软引用」改写：只有查得到才改。
 *
 * `relatedCharacterIds` / `targetId` 这类字段在本仓里**并不保证装的是角色 id** ——
 * 铁律 1 之后不少地方装的是名字。惰性分配会把一个名字改写成 UUID，
 * 那是真正的破坏；查不到就原样留着才是安全的默认。
 */
function remapSoftRefs(ids: string[] | undefined, map: IdMap): string[] | undefined {
  if (!Array.isArray(ids)) return ids;
  return ids.map((id) => map.peek(id) ?? id);
}

function readArray<T>(source: Record<string, unknown>, field: string): T[] {
  const v = source[field];
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * 三态校验（沿用 FullBackup 的 `validateBackupOrThrow` 口径）：
 * 字段**缺席**当空数组容忍，字段**在但不是数组**直接拒。
 */
function validateSessionBackupOrThrow(backup: unknown): Record<string, unknown> {
  const rec = asRecord(backup);
  if (!rec) {
    throw new Error('备份格式无效：非对象');
  }
  if (rec.kind !== SESSION_BACKUP_KIND) {
    throw new Error('备份格式无效：不是单存档备份文件（kind 不匹配）');
  }
  if (typeof rec.version !== 'number' || !Number.isFinite(rec.version)) {
    throw new Error('备份格式无效：缺少有效的 version 字段');
  }
  if (!asRecord(rec.save)) {
    throw new Error('备份格式无效：缺少 save 存档主记录');
  }
  const arrayFields = [
    'characters',
    'messages',
    'snapshots',
    'memories',
    'plotEvents',
    'plotOutlines',
    'sceneImages',
    'characterAppearances',
  ];
  for (const f of arrayFields) {
    const v = rec[f];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(`备份格式无效：字段 ${f} 必须是数组`);
    }
  }
  return rec;
}

/**
 * 导入一个 `SessionBackup`，返回新存档 id。
 *
 * **一律重发 id**（存档 / 角色 / 消息 / 快照 / 剧情 / 大纲 / 记忆 / 插画），于是：
 * - 同一个文件导两次 = 两个完全独立的存档，删掉其中一个不影响另一个
 * - 永远撞不上收件人库里已有的行（不重发 id 时，导入是**静默覆盖**）
 *
 * 🔴 **不碰任何全局表**：worldBooks / presets / settings / imagePresets / contentPacks /
 *    audio* / asset* 一行都不动。缺内容由 `checkSessionSaveDependencies` 在导入前告知，
 *    导入本身不去替用户装内容。
 */
export async function importSessionSave(backup: SessionBackup): Promise<{ saveId: string }> {
  const rec = validateSessionBackupOrThrow(backup);
  const db = getDatabase();

  const rawSave = asRecord(rec.save) as unknown as SaveSlot;
  const rawProfile = asRecord(rec.profile) as unknown as SaveProfile | null;

  const characters = readArray<CharacterState>(rec, 'characters');
  const messages = readArray<ChatMessage>(rec, 'messages');
  const snapshots = readArray<Snapshot>(rec, 'snapshots');
  const memories = readArray<MemoryRecord>(rec, 'memories');
  const plotEvents = readArray<PlotEvent>(rec, 'plotEvents');
  const plotOutlines = readArray<PlotOutline>(rec, 'plotOutlines');
  const sceneImages = readArray<SceneImageRecord>(rec, 'sceneImages');
  const characterAppearances = readArray<CharacterSessionAppearance>(rec, 'characterAppearances');

  const newSaveId = crypto.randomUUID();
  const charIds = new IdMap();
  const msgIds = new IdMap();
  const snapIds = new IdMap();
  const plotIds = new IdMap();
  const outlineIds = new IdMap();
  const imageIds = new IdMap();

  // 顺序有讲究：先把顶层真行注册进映射，之后嵌套副本里查不到的才是真悬空引用
  for (const c of characters) charIds.get(c.id);
  for (const m of messages) msgIds.get(m.id);
  for (const s of snapshots) snapIds.get(s.id);
  for (const e of plotEvents) plotIds.get(e.id);
  for (const o of plotOutlines) outlineIds.get(o.id);
  for (const img of sceneImages) imageIds.get(img.id);

  const remapCharacter = (c: CharacterState): CharacterState => ({
    ...c,
    id: charIds.get(c.id),
    saveId: newSaveId,
  });
  const remapMessage = (m: ChatMessage): ChatMessage => ({
    ...m,
    id: msgIds.get(m.id),
    ...(m.saveId !== undefined ? { saveId: newSaveId } : {}),
  });
  const remapPlotEvent = (e: PlotEvent): PlotEvent => {
    const next: PlotEvent = {
      ...e,
      id: plotIds.get(e.id),
      saveId: newSaveId,
      childrenIds: Array.isArray(e.childrenIds) ? e.childrenIds.map((id) => plotIds.get(id)) : [],
    };
    if (e.parentId !== undefined) next.parentId = plotIds.get(e.parentId);
    const related = remapSoftRefs(e.relatedCharacterIds, charIds);
    if (related !== undefined) next.relatedCharacterIds = related;
    return next;
  };
  const remapProfile = (p: SaveProfile): SaveProfile => ({
    ...p,
    saveId: newSaveId,
    // 命运契约指着角色行；affections 的键是**名字**（铁律 1），刻意不动
    contracts: Array.isArray(p.contracts)
      ? p.contracts.map((c) => ({ ...c, targetId: charIds.peek(c.targetId) ?? c.targetId }))
      : p.contracts,
  });

  const nextSave: SaveSlot = {
    ...rawSave,
    id: newSaveId,
    updatedAt: Date.now(),
    // 严格查表：快照不在本备份里 → 置 null（惰性分配会造出一个指向虚空的 id）
    activeSnapshotId: rawSave.activeSnapshotId
      ? (snapIds.peek(rawSave.activeSnapshotId) ?? null)
      : null,
    metadata: asRecord(rawSave.metadata)
      ? { ...rawSave.metadata }
      : { characterName: '', userName: '', gameStartTime: '', totalTurns: 0 },
  };

  const nextCharacters = characters.map(remapCharacter);
  const nextMessages = messages.map(remapMessage);
  const nextPlotEvents = plotEvents.map(remapPlotEvent);
  const nextPlotOutlines = plotOutlines.map((o) => ({
    ...o,
    id: outlineIds.get(o.id),
    saveId: newSaveId,
  }));
  const nextProfile = rawProfile ? remapProfile(rawProfile) : null;

  // 快照里嵌着 characters / saveProfile / plotEvents / messages 的深拷贝，
  // 而 restoreSnapshot 会把它们**原样写回库**（覆写语义）—— 所以必须用同一套映射改写，
  // 否则一次回退就把旧 id 复活到库里，两个导入出来的存档从此互相污染。
  const nextSnapshots: Snapshot[] = snapshots.map((s) => ({
    ...s,
    id: snapIds.get(s.id),
    saveId: newSaveId,
    characters: Array.isArray(s.characters) ? s.characters.map(remapCharacter) : [],
    saveProfile: asRecord(s.saveProfile) ? remapProfile(s.saveProfile) : s.saveProfile,
    ...(s.plotEvents !== undefined
      ? { plotEvents: Array.isArray(s.plotEvents) ? s.plotEvents.map(remapPlotEvent) : [] }
      : {}),
    ...(s.messages !== undefined
      ? { messages: Array.isArray(s.messages) ? s.messages.map(remapMessage) : [] }
      : {}),
  }));

  const nextSceneImages: SceneImageRecord[] = sceneImages.map((img) => ({
    ...img,
    id: imageIds.get(img.id),
    saveId: newSaveId,
    messageId: msgIds.get(img.messageId),
  }));

  const nextAppearances: CharacterSessionAppearance[] = characterAppearances.map((row) => ({
    ...row,
    key: characterAppearanceKey(newSaveId, row.name),
    saveId: newSaveId,
  }));

  await db.transaction(
    'rw',
    [
      db.saves,
      db.saveProfiles,
      db.characters,
      db.messages,
      db.snapshots,
      db.memories,
      db.plotEvents,
      db.plotOutlines,
      db.sceneImages,
      db.characterAppearances,
    ],
    async () => {
      // 槽位：取现有最大 +1（slot 不是唯一索引，这里只求「不和别人挤同一格」）
      const existingSlots = await db.saves.toArray();
      let maxSlot = -1;
      for (const s of existingSlots) {
        if (typeof s.slot === 'number' && Number.isFinite(s.slot) && s.slot > maxSlot) {
          maxSlot = s.slot;
        }
      }
      nextSave.slot = maxSlot + 1;

      // 记忆编号从全库最大号往后续（格式必须留住 —— 换成 UUID 的话新记忆会从
      // MEM000001 重新编号；见 memory-summarizer.allocateMemoryIds）
      const memoryIds = allocateMemoryIds(
        (await db.memories.toArray()).map((m) => m.id),
        memories.length,
      );
      const nextMemories: MemoryRecord[] = memories.map((m, i) => {
        const next: MemoryRecord = { ...m, id: memoryIds[i], saveId: newSaveId };
        const related = remapSoftRefs(m.relatedCharacterIds, charIds);
        if (related !== undefined) next.relatedCharacterIds = related;
        return next;
      });

      await db.saves.put(nextSave);
      if (nextProfile) await db.saveProfiles.put(nextProfile);
      if (nextCharacters.length > 0) await db.characters.bulkPut(nextCharacters);
      if (nextMessages.length > 0) await db.messages.bulkPut(nextMessages);
      if (nextSnapshots.length > 0) await db.snapshots.bulkPut(nextSnapshots);
      if (nextMemories.length > 0) await db.memories.bulkPut(nextMemories);
      if (nextPlotEvents.length > 0) await db.plotEvents.bulkPut(nextPlotEvents);
      if (nextPlotOutlines.length > 0) await db.plotOutlines.bulkPut(nextPlotOutlines);
      if (nextSceneImages.length > 0) await db.sceneImages.bulkPut(nextSceneImages);
      if (nextAppearances.length > 0) await db.characterAppearances.bulkPut(nextAppearances);
    },
  );

  return { saveId: newSaveId };
}
