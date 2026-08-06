/**
 * IndexedDB Database Layer — v4 多 Agent 引擎
 *
 * Tables: lorebooks, presets, settings (v1-v3)
 *         memories, plot_events, characters, snapshots, saves, api_endpoints (v4 new)
 *         （v9 起 chats 表已删除，消息持久化走 messages 表）
 */

import Dexie, { Table } from 'dexie';
import type {
  Lorebook,
  ChatPreset,
  AppSettings,
  MemoryRecord,
  PlotEvent,
  CharacterState,
  Snapshot,
  SaveSlot,
  ApiEndpoint,
  PlotOutline,
  SaveProfile,
  ChatMessage,
  AudioTrack,
  AudioBlobRecord,
  AudioPlaylist,
  AudioHandleRecord,
  AssetMetaRecord,
  AssetBlobRecord,
  WorldBook,
  WorkshopProject,
  BeautifierRule,
  RegexStorageRecord,
} from './types';
import type {
  SceneImageRecord,
  SceneImageBlobRecord,
  CharacterSessionAppearance,
  SceneImageUsage,
  ImagePreset,
} from './types-image';
import type { CreatePreset } from '../ui/stores/create-store';
import type { ContentPack } from './types-content';
import { hashWorldBook } from './content-source';

/** 捏人预设记录 (DB 存储格式) */
export interface CreatePresetRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: CreatePreset;
}

/**
 * contentPacks 表行形状（D18）。
 *
 * 🔴 **payload 是整包 ContentPack**：恢复默认 / 卸载 / 升级 diff 都不需要重新拿文件 ——
 *    所有「装包时发生过什么」都从这一份还原。`sectionHashes` 与 `notes` 直接复用
 *    ContentPack 的同名字段（构建器盖章 / 安装处置记录），为查询便利提升到一等字段。
 *
 * 🔴 **contentPacks 不进 FullBackup**（D18）：payload 进备份 = 每份日常备份都是可自由转发的
 *    完整内容包 + 体积翻倍。备份/恢复一致性由 `reconcilePackState()` 解决。
 */
export interface ContentPackRecord {
  /** 主键 = `payload.packId`（与 payload 同源，提升为索引便于直接查询） */
  packId: string;
  /** = `payload.packVersion`（semver，驱动升级判定 D40） */
  packVersion: string;
  /** 安装时间戳（epoch ms）；本次 put 的时间，非 payload.exportedAt */
  installedAt: number;
  /** 整包内容（ContentPack 原样入库） */
  payload: ContentPack;
  /** = `payload.sectionHashes`（D40 升级 diff 展示与快速比对用；逐书基线从 payload 现算） */
  sectionHashes?: Readonly<Record<string, string>>;
  /** 安装处置记录（WorkshopNote[]，由执行器在安装时产出） */
  notes?: unknown[];
}

const DB_NAME = 'SillyTavernWebDB';
/**
 * 🔴 **必须等于下面最后一个 `this.version(n)`**。它只出现在 `FullBackup.version` 上
 * （导入侧不拿它做判断），所以对不上时**不会有任何报错** —— 只是每份导出的备份都盖了
 * 一个过期的戳，日后靠它排查「这份备份是哪一版导的」时会被误导。
 *
 * 曾经落后过两版：v17 那次记得改，v18（删地点预设行）与 v19（角色外貌会话副本表）都忘了，
 * 而 `database.test.ts` 里那条断言跟着写了 17，于是漂移被测试**固定**下来而不是拦下来。
 * 升版时这两处一起改。
 */
const DB_VERSION = 20;

// ═══════════════════════════════════════════════════════════
// Schema 声明（Q-26）
// ═══════════════════════════════════════════════════════════
//
// 16 个 Dexie 版本此前各自**全量重述**整份表清单，约 390 行是同一张单子的拷贝。
// 加一张表要把上一版的 21 行原样抄一遍再加一行，抄错一个索引名不会有任何提示。
//
// v1–v12 **原样冻结**：它们已经出厂，任何改动都要在用户既有库上比对 schema 字符串，
// 差一个字节就触发真正的索引重建。v13 起改走下面的 delta 写法，一版一行。
//
// 🔴 `withSchema` 生成的字符串必须与手写版**逐字节相同** —— 键序沿用插入序
//    （JS 对象字符串键保序），delta 追加在尾部，正是原来手写的位置。
//    database.test.ts 的升版回归测试是这条的闸门。

/** 表名 → 索引声明。`null` = 删表（Dexie 的显式删表语义，见 v9 的 `chats: null`） */
type SchemaSpec = Record<string, string | null>;

/**
 * 基线 + 增量 → 新版 schema。
 *
 * 增量里写 `null` 表示删表 —— 与 Dexie 的 `表名: null` 语义一致，原样透传。
 * 不做任何排序/归一化：Dexie 比对的是字符串，重排键序会让既有库以为 schema 变了。
 */
function withSchema(base: SchemaSpec, delta: SchemaSpec): SchemaSpec {
  return { ...base, ...delta };
}

/** v12 全量基线（v1–v12 的终态；上面那批冻结版本仍各自手写） */
const SCHEMA_V12: SchemaSpec = {
  lorebooks: 'id, name, updatedAt',
  presets: 'id, name, updatedAt',
  settings: 'key',
  memories: 'id, saveId, createdAt, realTimestamp',
  plotEvents: 'id, saveId, parentId, status, updatedAt',
  characters: 'id, saveId, type',
  snapshots: 'id, saveId, createdAt',
  saves: 'id, slot, updatedAt',
  apiEndpoints: 'id, name',
  plotOutlines: 'id, saveId, updatedAt',
  saveProfiles: 'saveId, updatedAt',
  createPresets: 'id, name, updatedAt',
  messages: 'id, saveId, [saveId+turn]',
  audioTracks: 'id, name, kind, *tags, updatedAt',
  audioBlobs: 'id',
  audioPlaylists: 'id, name, updatedAt',
  audioHandles: 'id',
};

const SCHEMA_V13: SchemaSpec = withSchema(SCHEMA_V12, {
  assetMeta: 'id, name, type, [name+type], createdAt, updatedAt',
  assetBlobs: 'id',
});

const SCHEMA_V14: SchemaSpec = withSchema(SCHEMA_V13, {
  worldBooks: 'id, partition, updatedAt',
  workshopProjects: 'id, installedAt, updatedAt',
});

const SCHEMA_V15: SchemaSpec = withSchema(SCHEMA_V14, {
  beautifierRules: 'id, group, order',
});

const SCHEMA_V16: SchemaSpec = withSchema(SCHEMA_V15, { regexStorage: 'key' });

class AppDatabase extends Dexie {
  // v1-v3 tables (chats 已于 v9 删除)
  lorebooks!: Table<Lorebook>;
  presets!: Table<ChatPreset>;
  settings!: Table<AppSettings>;

  // v4 new tables
  memories!: Table<MemoryRecord>;
  plotEvents!: Table<PlotEvent>;
  characters!: Table<CharacterState>;
  snapshots!: Table<Snapshot>;
  saves!: Table<SaveSlot>;
  apiEndpoints!: Table<ApiEndpoint>;

  // v5 new table (Phase 4)
  plotOutlines!: Table<PlotOutline>;

  // v6 new table (Phase 4.6)
  saveProfiles!: Table<SaveProfile>;

  // v7 new table (Phase 7d)
  createPresets!: Table<CreatePresetRecord>;

  // v8 new table (Phase 10h)
  messages!: Table<ChatMessage>;

  // v11 new tables (Audio System) — 元数据 / 字节 分表存储（设计 §3.2）
  audioTracks!: Table<AudioTrack>;
  audioBlobs!: Table<AudioBlobRecord>;
  audioPlaylists!: Table<AudioPlaylist>;

  // v12 new table (Audio 本地文件夹) — File System Access 目录句柄（结构化克隆存储）
  audioHandles!: Table<AudioHandleRecord>;

  // v13 new tables (Asset System) — 元数据 / 字节 分表存储（设计 §4.1）
  assetMeta!: Table<AssetMetaRecord>;
  assetBlobs!: Table<AssetBlobRecord>;

  // v14 new tables (创意工坊 / 世界书迁出 localStorage) — 设计 D3
  //   worldBooks: 全部世界书（内置 / 导入 / 工坊）唯一一张表
  //   workshopProjects: 仅项目生命周期元数据（WorldBook 没有字段位的那些）
  worldBooks!: Table<WorldBook>;
  workshopProjects!: Table<WorkshopProject>;

  // v15 new table (美化规则迁出 localStorage) — Phase 0b
  //   仅**用户规则**。内置 22 条预设规则（~378 KB）是 loadPresetRules() 从
  //   data/defaults/beautifier-rules.json 现算出来的派生缓存，纯内存持有，不进任何表。
  beautifierRules!: Table<BeautifierRule>;

  // v16 new table — untrusted regex persistent KV. The table itself is the
  // single shared namespace; iframe callers never select an application table.
  regexStorage!: Table<RegexStorageRecord>;

  // v17 new tables (图像生成 v1 / 情景插画) — 设计 §7.1
  //   sceneImages:      元数据 = **配方**（prompt/seed/model/标题说明），随存档隔离
  //   sceneImageBlobs:  字节，与 assetBlobs 同形状（id 对应元数据 id）
  //   imagePresets:     角色 + 地点视觉预设，**全局**（不随存档删除，D40 / D2）
  sceneImages!: Table<SceneImageRecord>;
  sceneImageBlobs!: Table<SceneImageBlobRecord>;
  imagePresets!: Table<ImagePreset>;

  // v19 (D56): 角色外貌的**会话副本** —— 随存档隔离，删存档连带删。
  // 基线在 imagePresets.appearance（全局、干净、用户可编辑），这一份由出图 AI 自动写。
  characterAppearances!: Table<CharacterSessionAppearance>;

  // v20 (内容-引擎分离波 1 / D18): 内容包安装持久化。
  //   payload = 整包 ContentPack；恢复默认/卸载/升级 diff 都从这里还原，无需重拿文件。
  //   🔴 **不进 FullBackup**（payload 进备份 = 每份备份都是可转发的完整内容包）。
  contentPacks!: Table<ContentPackRecord>;

  constructor() {
    super(DB_NAME);

    this.version(1).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
    });

    this.version(2).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
    });

    this.version(3)
      .stores({
        lorebooks: 'id, name, updatedAt',
        presets: 'id, name, updatedAt',
        settings: 'key',
        chats: 'id, name, updatedAt',
      })
      .upgrade(async (tx) => {
        const settings = await tx.table('settings').toCollection().toArray();
        for (const s of settings) {
          if (s.uiMode === undefined) s.uiMode = 'game';
          if (s.customTags === undefined)
            s.customTags = ['maintext', 'option', 'sum', 'vars', 'thinking', 'think'];
          if (s.thinkingDisplay === undefined) s.thinkingDisplay = 'fold';
          if (s.formatPromptTemplate === undefined) s.formatPromptTemplate = '';
          if (s.api && s.api.secondary === undefined) {
            s.api.secondary = { enabled: false, baseUrl: '', apiKey: '', model: '' };
          }
          await tx.table('settings').put(s);
        }
      });

    // v4: 多 Agent 引擎 — 新增 6 表 + Settings 字段扩展
    this.version(4)
      .stores({
        lorebooks: 'id, name, updatedAt',
        presets: 'id, name, updatedAt',
        settings: 'key',
        chats: 'id, name, updatedAt',
        memories: 'id, saveId, createdAt, realTimestamp',
        plotEvents: 'id, saveId, parentId, status, updatedAt',
        characters: 'id, type',
        snapshots: 'id, saveId, index, timestamp',
        saves: 'id, slot, updatedAt',
        apiEndpoints: 'id, name',
      })
      .upgrade(async (tx) => {
        // 迁移现有 settings — 添加 v4 新字段
        const settings = await tx.table('settings').toCollection().toArray();
        for (const s of settings) {
          if (s.apiEndpoints === undefined) s.apiEndpoints = [];
          if (s.agentConfigs === undefined) s.agentConfigs = [];
          if (s.agentPipeline === undefined) {
            const { DEFAULT_AGENT_PIPELINE } = await import('./types');
            s.agentPipeline = DEFAULT_AGENT_PIPELINE;
          }
          if (s.cacheStrategy === undefined) s.cacheStrategy = 'userid_isolated';
          if (s.maxSnapshotsPerSave === undefined) s.maxSnapshotsPerSave = 30;
          if (s.maxMemoriesRecall === undefined) s.maxMemoriesRecall = 10;
          await tx.table('settings').put(s);
        }
      });

    // v5: Phase 4 — 剧情大纲表 + Settings 扩展字段
    this.version(5)
      .stores({
        lorebooks: 'id, name, updatedAt',
        presets: 'id, name, updatedAt',
        settings: 'key',
        chats: 'id, name, updatedAt',
        memories: 'id, saveId, createdAt, realTimestamp',
        plotEvents: 'id, saveId, parentId, status, updatedAt',
        characters: 'id, type',
        snapshots: 'id, saveId, index, timestamp',
        saves: 'id, slot, updatedAt',
        apiEndpoints: 'id, name',
        plotOutlines: 'id, saveId, updatedAt',
      })
      .upgrade(async (tx) => {
        // 迁移现有 settings — 添加 Phase 4 新字段
        const settings = await tx.table('settings').toCollection().toArray();
        for (const s of settings) {
          if (s.plotSettings === undefined) {
            const { DEFAULT_PLOT_SETTINGS } = await import('./types');
            s.plotSettings = DEFAULT_PLOT_SETTINGS;
          }
          if (s.embeddingEndpointId === undefined) s.embeddingEndpointId = null;
          if (s.embeddingModel === undefined) s.embeddingModel = 'Qwen/Qwen3-Embedding-8B';
          if (s.embeddingDimension === undefined) s.embeddingDimension = 4096;
          if (s.memoryCompressionThreshold === undefined) s.memoryCompressionThreshold = 100;
          // Fix: maxMemoriesRecall 默认改为 20
          if (s.maxMemoriesRecall === undefined || s.maxMemoriesRecall === 10)
            s.maxMemoriesRecall = 20;
          await tx.table('settings').put(s);
        }
      });

    // v6: Phase 4.6 — SaveProfile 存档档案
    this.version(6).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
    });

    // v7: Phase 7d — 捏人预设表
    this.version(7).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
      createPresets: 'id, name, updatedAt',
    });

    // v8: Phase 10h — 消息持久化表
    this.version(8).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      chats: 'id, name, updatedAt',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, type',
      snapshots: 'id, saveId, index, timestamp',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
      createPresets: 'id, name, updatedAt',
      messages: 'id, saveId, [saveId+turn]',
    });

    // v9: 数据字段规范 M1 — characters saveId 一等索引 (#43)；chats v3 遗留表删除 (#46)
    this.version(9)
      .stores({
        lorebooks: 'id, name, updatedAt',
        presets: 'id, name, updatedAt',
        settings: 'key',
        chats: null, // 删表
        memories: 'id, saveId, createdAt, realTimestamp',
        plotEvents: 'id, saveId, parentId, status, updatedAt',
        characters: 'id, saveId, type',
        snapshots: 'id, saveId, index, timestamp',
        saves: 'id, slot, updatedAt',
        apiEndpoints: 'id, name',
        plotOutlines: 'id, saveId, updatedAt',
        saveProfiles: 'saveId, updatedAt',
        createPresets: 'id, name, updatedAt',
        messages: 'id, saveId, [saveId+turn]',
      })
      .upgrade(async (tx) => {
        // 开发期迁移: 把 customFields.saveId 回填为一等字段（老数据仅开发自用）
        const chars = await tx.table('characters').toCollection().toArray();
        for (const c of chars) {
          if (!c.saveId) {
            c.saveId = c.customFields?.saveId ?? '';
            await tx.table('characters').put(c);
          }
        }
        // SaveProfile.variables 为 v9 新必填字段，存量记录回填空对象
        const profiles = await tx.table('saveProfiles').toCollection().toArray();
        for (const p of profiles) {
          if (p.variables === undefined) {
            p.variables = {};
            await tx.table('saveProfiles').put(p);
          }
        }
      });

    // v10: 数据字段规范 M5 — Snapshot 重定义（规范 §11.2）: 索引 index/timestamp → createdAt
    this.version(10)
      .stores({
        lorebooks: 'id, name, updatedAt',
        presets: 'id, name, updatedAt',
        settings: 'key',
        memories: 'id, saveId, createdAt, realTimestamp',
        plotEvents: 'id, saveId, parentId, status, updatedAt',
        characters: 'id, saveId, type',
        snapshots: 'id, saveId, createdAt',
        saves: 'id, slot, updatedAt',
        apiEndpoints: 'id, name',
        plotOutlines: 'id, saveId, updatedAt',
        saveProfiles: 'saveId, updatedAt',
        createPresets: 'id, name, updatedAt',
        messages: 'id, saveId, [saveId+turn]',
      })
      .upgrade(async (tx) => {
        // 旧快照开发数据直接清弃（结构不兼容: index/timestamp/寄生 variables → reason/turn/整份深拷贝）
        await tx.table('snapshots').clear();
      });

    // v11: 音频子系统 — 新增 3 表（纯增量，无 upgrade 回调）
    this.version(11).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, saveId, type',
      snapshots: 'id, saveId, createdAt',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
      createPresets: 'id, name, updatedAt',
      messages: 'id, saveId, [saveId+turn]',
      audioTracks: 'id, name, kind, *tags, updatedAt',
      audioBlobs: 'id',
      audioPlaylists: 'id, name, updatedAt',
    });

    // v12: 音频本地文件夹 — 新增 audioHandles 表（纯增量，无 upgrade 回调）
    // ⚠️ 这句曾写着「Dexie 要求每版重述完整 schema，漏写任一表即为删表」——
    //    **对 Dexie 4 不成立**（stores() 跨版累加，漏写的表从上一版继承；删表要显式
    //    写 `表名: null`，见 v9 的 `chats: null`）。留着它是反向指导，故更正（Q-26）。
    this.version(12).stores({
      lorebooks: 'id, name, updatedAt',
      presets: 'id, name, updatedAt',
      settings: 'key',
      memories: 'id, saveId, createdAt, realTimestamp',
      plotEvents: 'id, saveId, parentId, status, updatedAt',
      characters: 'id, saveId, type',
      snapshots: 'id, saveId, createdAt',
      saves: 'id, slot, updatedAt',
      apiEndpoints: 'id, name',
      plotOutlines: 'id, saveId, updatedAt',
      saveProfiles: 'saveId, updatedAt',
      createPresets: 'id, name, updatedAt',
      messages: 'id, saveId, [saveId+turn]',
      audioTracks: 'id, name, kind, *tags, updatedAt',
      audioBlobs: 'id',
      audioPlaylists: 'id, name, updatedAt',
      audioHandles: 'id',
    });

    // v13: 素材子系统 — 新增 assetMeta / assetBlobs 两表（纯增量，无 upgrade 回调，照 v11/v12 先例）
    //
    // 照本文件惯例重述全部 17 张旧表 —— 这是**约定**，不是 Dexie 的硬要求:
    // Dexie 4 的 Version.stores() 跨版本**累加** schema（dexie.js: `extend(storesSpec, ...)` 逐版合并），
    // 漏写的表会从上一版继承下来；真要删表必须显式写 `表名: null`（见上方 v9 的 `chats: null`）。
    // 仍然全量重述的理由: 每一版一眼可见完整形状，且与既有 v4–v12 写法一致。
    // （上方 v12 注释说"漏写即删表"—— 那句对 Dexie 4 不成立，见 database.test.ts 的升版回归测试。）
    //
    // 刻意不建的索引/表（设计 §4.1，各有理由）:
    //   · 独立 hash 索引 —— 去重按 (name, type) 定域，查询走 [name+type] 后在内存里比 hash，
    //     没有查询在背后的索引就是死重量。
    //   · assetHandles 表 —— v1 无 File System Access 层级（D5），等 v14 再做一次纯增量升版。
    //   · category 列 —— 由 type 经 categoryForType() 派生，落库即第二个真相来源（违反铁律4）。
    this.version(13).stores(
      withSchema(SCHEMA_V12, {
        assetMeta: 'id, name, type, [name+type], createdAt, updatedAt',
        assetBlobs: 'id',
      }),
    );

    // v14: 世界书迁出 localStorage + 创意工坊 — 新增 worldBooks / workshopProjects 两表
    //      （纯增量，无 upgrade 回调；迁移例程在 UI 层单独跑，见设计 D4）
    //
    // 照本文件惯例重述全部 19 张旧表（约定，非 Dexie 硬要求，见 v13 注释）。
    //
    // 🔴 刻意**不写** `lorebooks: null` / `settings: null`（设计 D3）:
    //    这两张是 v1–v3 遗留死表、生产零读写，但删表会永久抹掉长期用户可能仍存有的旧行。
    //    放着不花钱，导出也只是空数组。删除是独立的、需要明确决定的动作，不是本次迁移的附带损伤。
    //
    // 索引取舍:
    //   · worldBooks.partition —— 工坊过滤（按分区整体识别/开关/排除）是一等访问模式，保留。
    //   · workshopProjects 不建 rootProjectId / installState 索引 —— 项目量级是几十条，全表扫即可。
    this.version(14).stores(
      withSchema(SCHEMA_V13, {
        worldBooks: 'id, partition, updatedAt',
        workshopProjects: 'id, installedAt, updatedAt',
      }),
    );

    // v15: 美化规则迁出 localStorage（Phase 0b）— 新增 beautifierRules 一表
    //      （纯增量，无 upgrade 回调；迁移例程在 UI 层单独跑，复用 Phase 0 的六步）
    //
    // 🔴 必须**新开 v15 而不是就地改 v14**：v14 已在本分支存在，本地可能已有跑到 v14 的库，
    //    就地改 v14 不会触发 Dexie 升级，新表永远建不出来。
    //
    // 照本文件惯例重述全部 21 张旧表；同样刻意**不写**任何 `表名: null`（设计 D3）。
    //
    // 索引取舍：`group` 供设置页按分组折叠，`order` 供 processRules 排序取用；
    // 用户规则量级是几十条，不再多建索引。
    this.version(15).stores(withSchema(SCHEMA_V14, { beautifierRules: 'id, group, order' }));

    // v16: persistent storage for isolated beautifier regexes. Pure addition;
    // no upgrade callback and no existing table is removed.
    this.version(16).stores(SCHEMA_V16);

    // v17: 图像生成子系统（设计 §7.1）— 新增三表，纯增量，无 upgrade 回调。
    //
    // 索引取舍：
    //   · sceneImages 的 `[saveId+messageId]` 是**正文渲染的那条路径** —— 一条消息就几张，
    //     occurrence / take / pinned 在内存里挑，不再往复合索引里塞第三段。
    //   · `turn` 供图鉴按剧情顺序排序；`saveId` 供图鉴整取与 D23 去重扫描。
    //   · imagePresets 主键是 `${kind}:${name}`（D40）—— 幻想设定里人名与地名会撞车，
    //     合表之后不能再拿 name 当主键。`name` 另建索引，值保持**原样**供 `===` 匹配
    //     （铁律 1：不 trim / 不折叠大小写 / 不 NFKC）。
    this.version(17).stores(
      withSchema(SCHEMA_V16, {
        sceneImages: 'id, saveId, messageId, [saveId+messageId], turn',
        sceneImageBlobs: 'id',
        imagePresets: 'key, kind, name',
      }),
    );

    /**
     * v18 —— 地点视觉预设废除（D59）。
     *
     * 表结构一个字没变，只删数据：`kind === 'location'` 的行从此没有任何读者
     * （`composePrompt` 不再查表、设置页也没有那个页签了）。留着就是**看不见的
     * 垃圾**——用户删不掉、UI 不显示、下一个读这张表的人还得先搞懂它们是什么。
     *
     * 🔴 只删 location，character 一行不动：那是 D56 里「初始定义」的真源。
     */
    // 🔴 **不带 `.stores()`**：表结构没变，这一版只搬数据。带上就得把 v17 的全套表名
    //    再抄一遍（`withSchema(SCHEMA_V16, …)` 里没有 sceneImages），抄漏一张就是删表。
    this.version(18).upgrade(async (tx) => {
      await tx.table('imagePresets').where('kind').equals('location').delete();
    });

    // v19 (D56): 角色外貌会话副本。`saveId` 单独建索引 —— 「整档重置」与
    // `deleteSaveSlot` 都是按存档整批删，没有它就得全表扫。
    this.version(19).stores({ characterAppearances: 'key, saveId, name' });

    // v20 (内容-引擎分离波 1 / D18): contentPacks 表 —— 安装持久化的唯一真源。
    //
    // 🔴 payload 是整包 ContentPack：恢复默认 / 卸载 / 升级 diff 不需要重新拿文件。
    //    🔴 **不进 FullBackup**（D18）：payload 进备份 = 每份日常备份都是可自由转发的
    //       完整内容包 + 体积翻倍；备份/恢复一致性由 `reconcilePackState()` 解决。
    //
    // 索引取舍：只建 `packId` 主键。安装/卸载/升级/对账全部按 packId 直查，无第二索引需求。
    // 与 v19 同款用对象字面量（仅声明本版新增表，旧表跨版继承，Dexie 4 累加语义）。
    this.version(20).stores({ contentPacks: 'packId' });
  }
}

let dbInstance: AppDatabase | null = null;

export function getDatabase(): AppDatabase {
  if (!dbInstance) {
    dbInstance = new AppDatabase();
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<void> {
  const db = getDatabase();

  const presetCount = await db.presets.count();
  if (presetCount === 0) {
    const { createDefaultPreset } = await import('./types');
    const defaultPreset = createDefaultPreset();
    await db.presets.add({
      ...defaultPreset,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as ChatPreset);
  }

  // 🪦 Q-06：不再播种 `settings` 行。这张表曾是引擎侧读设置的地方，而前端设置的
  //    真源在 localStorage —— 播种出来的那行只会是一份永远停在 DEFAULT_SETTINGS 的
  //    影子配置，让「设置页改了、引擎行为没变」这类问题看起来像是引擎的锅。
  //    引擎现在经 `engine-settings` 注入缝读真源。表本身按数据安全约定保留（删表要写
  //    `表名: null`，会永久抹掉老用户的行），只是停止读写。
}

export async function clearAllData(): Promise<void> {
  const db = getDatabase();
  await db.delete();
  dbInstance = null;
}

// ========== Full Backup (v4) ==========

export interface FullBackup {
  version: number;
  exportedAt: number;
  lorebooks: Lorebook[];
  presets: ChatPreset[];
  settings: AppSettings[];
  // v4
  memories: MemoryRecord[];
  plotEvents: PlotEvent[];
  characters: CharacterState[];
  snapshots: Snapshot[];
  saves: SaveSlot[];
  apiEndpoints: ApiEndpoint[];
  // v5 Phase 4
  plotOutlines: PlotOutline[];
  // v6 Phase 4.6
  saveProfiles: SaveProfile[];
  // v7 Phase 7d
  createPresets: CreatePresetRecord[];
  // v8 Phase 10h
  messages: ChatMessage[];
  // v14 创意工坊 / 世界书迁出 localStorage（设计 D5）—— 旧备份缺这两个字段，导入侧必须容忍
  worldBooks: WorldBook[];
  workshopProjects: WorkshopProject[];
  // v15 美化规则迁出 localStorage（Phase 0b）—— 同样是「旧备份缺字段」的三态语义。
  // 只含**用户规则**；内置预设规则是派生缓存，不进备份（导入方启动时自己从磁盘算）。
  beautifierRules: BeautifierRule[];
  // v16 隔离正则持久 KV。旧备份缺字段时，导入侧保留现有表。
  regexStorage: RegexStorageRecord[];
  // v17 图像生成（设计 §7.3）—— 同样是「旧备份缺字段」的三态语义。
  //
  // 🔴 `sceneImageBlobs` **刻意不在这里**：FullBackup 是一份 JSON，字节进 JSON 就得
  //    base64，与 audioBlobs / assetBlobs 同口径排除。进备份的只有元数据，而元数据
  //    是**配方**（prompt + seed + model + 标题说明）—— 恢复出来是一份读得通的图鉴
  //    目录，随时可一键重画。图片字节走「导出本存档插画」那条独立 zip 路径。
  sceneImages: SceneImageRecord[];
  imagePresets: ImagePreset[];
  // v19 角色外貌会话副本（D56）。**与 sceneImages 同为「每存档」数据，必须同进同出** ——
  // 少了它，导出再导入之后每个角色的本档变化（换了衣服 / 留了疤）会静默退回基线，
  // 而存档的其余部分完好，于是症状看起来像「AI 忘了她换过装」而不是「备份没收这张表」。
  // 纯文本 patch，体积与 imagePresets 同量级。
  characterAppearances: CharacterSessionAppearance[];

  // 🔴 **contentPacks 不在这个列表里，也不会被加进来**（D18 / §5.7）：
  //    payload 进备份 = 每份日常备份都是可自由转发的完整内容包 + 体积翻倍。
  //    备份/恢复一致性由 `reconcilePackState()` 解决 —— 它挂在 `importAllData` 收尾，
  //    逐 pack 拥有项比对（payload 现算 hash vs 恢复行 hash），失配只报 needs_attention、
  //    不自动改任何一边。
}

export async function exportAllData(): Promise<FullBackup> {
  const db = getDatabase();
  const [
    lorebooks,
    presets,
    settings,
    memories,
    plotEvents,
    characters,
    snapshots,
    saves,
    apiEndpoints,
    plotOutlines,
    saveProfiles,
    createPresets,
    messages,
    worldBooks,
    workshopProjects,
    beautifierRules,
    regexStorage,
    sceneImages,
    imagePresets,
    characterAppearances,
  ] = await Promise.all([
    db.lorebooks.toArray(),
    db.presets.toArray(),
    db.settings.toArray(),
    db.memories.toArray(),
    db.plotEvents.toArray(),
    db.characters.toArray(),
    db.snapshots.toArray(),
    db.saves.toArray(),
    db.apiEndpoints.toArray(),
    db.plotOutlines.toArray(),
    db.saveProfiles.toArray(),
    db.createPresets.toArray(),
    db.messages.toArray(),
    db.worldBooks.toArray(),
    db.workshopProjects.toArray(),
    db.beautifierRules.toArray(),
    db.regexStorage.toArray(),
    db.sceneImages.toArray(),
    db.imagePresets.toArray(),
    db.characterAppearances.toArray(),
  ]);
  return {
    version: DB_VERSION,
    exportedAt: Date.now(),
    lorebooks,
    presets,
    settings,
    memories,
    plotEvents,
    characters,
    snapshots,
    saves,
    apiEndpoints,
    plotOutlines,
    saveProfiles,
    createPresets,
    messages,
    worldBooks,
    workshopProjects,
    beautifierRules,
    regexStorage,
    sceneImages,
    imagePresets,
    characterAppearances,
  };
}

/**
 * 🔒 P0-04: 校验备份完整性 —— 空 `{}` / 残缺备份此前会让各事务的 clear() 先执行、
 * bulkPut 因字段非数组全跳过，结果全库被清空。此处要求 version 存在且实体字段为数组。
 */
function validateBackupOrThrow(backup: any): asserts backup is FullBackup {
  if (!backup || typeof backup !== 'object') {
    throw new Error('备份格式无效：非对象');
  }
  if (typeof backup.version !== 'number' || !Number.isFinite(backup.version)) {
    throw new Error('备份格式无效：缺少有效的 version 字段');
  }
  const arrayFields: Array<keyof FullBackup> = [
    'lorebooks',
    'presets',
    'settings',
    'memories',
    'plotEvents',
    'characters',
    'snapshots',
    'saves',
    'apiEndpoints',
    'plotOutlines',
    'saveProfiles',
    'createPresets',
    'messages',
    // v14 新增 —— 此循环只在字段**存在且非数组**时报错，旧备份缺这两个字段照常通过
    'worldBooks',
    'workshopProjects',
    'beautifierRules',
    'regexStorage',
    'sceneImages',
    'imagePresets',
    'characterAppearances',
  ];
  for (const f of arrayFields) {
    const v = backup[f];
    if (v !== undefined && !Array.isArray(v)) {
      throw new Error(`备份格式无效：字段 ${String(f)} 必须是数组`);
    }
  }
}

export async function importAllData(backup: FullBackup): Promise<ReconcileResult> {
  // 🔒 P0-04: 先验证 —— 不合法的备份（空对象/残缺结构）直接拒绝，不进入 clear 流程
  validateBackupOrThrow(backup);

  const db = getDatabase();
  // 🔒 P0-04: 预备份 —— 6 个独立事务跨段不原子，后段失败时前段已永久替换。
  // 导入前先快照当前数据，任一段抛错时用它回滚到导入前状态（review P0-04 要求的「可恢复备份」）。
  const previousData = await exportAllData();

  try {
    await doImportAllData(db, backup);
  } catch (err) {
    // 失败回滚：把预备份重新导入（doImportAllData 不验证/不再预备份，避免递归）
    try {
      await doImportAllData(db, previousData);
    } catch (rollbackErr) {
      console.error('[importAllData] 回滚失败；预备份（内存）仍可手动恢复:', rollbackErr);
    }
    throw err;
  }

  // 内容-引擎分离波 1 / D18 / §5.7：恢复完成后跑对账。
  // contentPacks 不进备份，所以恢复可能让 pack 拥有的 worldBooks/presets 行与 payload
  // 失配（旧备份清了表 / 手编备份删了字段）。对账只读 + 报告，不自动改任何一边；
  // 唯一的写动作是 `activePresetId` 悬空时从 payload 重导 story 预设（D18 明确分支）。
  // 🔴 reconcile 自身绝不再调 importAllData（会递归），也不读 backup（只看现状 vs payload）。
  return reconcilePackState();
}

/** 纯导入内核（无验证、无预备份）— importAllData 与失败回滚共用 */
async function doImportAllData(
  db: ReturnType<typeof getDatabase>,
  backup: FullBackup,
): Promise<void> {
  // Split into multiple transactions — 单事务覆盖 13 张表在 Dexie 上有性能/锁问题
  // `lorebooks` 与 `settings` 是死表（无生产读写，见 Q-06 与 AGENTS.md 架构图）。
  // 这里仍然照搬**只为老备份往返不丢字节**：老包里带着这两张表的行，导入时丢掉
  // 就等于这份备份进去再出来变小了。新包里它们是空数组，clear + bulkPut([]) 是 no-op。
  await db.transaction('rw', db.lorebooks, db.settings, async () => {
    await db.lorebooks.clear();
    await db.settings.clear();
    if (Array.isArray(backup.lorebooks)) await db.lorebooks.bulkPut(backup.lorebooks);
    if (Array.isArray(backup.settings)) await db.settings.bulkPut(backup.settings);
  });

  // 🔴 内容-引擎分离波 1 / D22：presets 拆出 lorebooks/settings 事务，改三态护栏。
  //   此前与死表同段无条件 clear —— 手编/裁剪过的备份（删了 presets 字段）导入会
  //   静默清空 Dexie 预设表。改三态语义（与 v14/v15 同款）：
  //   · undefined（字段缺席，手编备份）→ 整张表原样不动，连 clear 都不执行
  //   · []（字段存在但为空）          → 合法的「确实没有预设」，照常 clear
  //   · 有数据                         → 清空后整表覆盖
  //   注：「旧备份抹掉 pack 预设」的真正救济是 D18 reconcilePackState（T5），不是这条护栏。
  await db.transaction('rw', db.presets, async () => {
    if (backup.presets !== undefined) {
      await db.presets.clear();
      if (Array.isArray(backup.presets)) await db.presets.bulkPut(backup.presets);
    }
  });

  await db.transaction('rw', db.memories, db.plotEvents, db.characters, async () => {
    await db.memories.clear();
    await db.plotEvents.clear();
    await db.characters.clear();
    if (Array.isArray(backup.memories)) await db.memories.bulkPut(backup.memories);
    if (Array.isArray(backup.plotEvents)) await db.plotEvents.bulkPut(backup.plotEvents);
    if (Array.isArray(backup.characters)) {
      // v9: 旧备份（pre-v9）角色只有 customFields.saveId，回填一等字段，否则索引查询查不到
      const normalizedChars = backup.characters.map((c: any) => ({
        ...c,
        saveId: c.saveId ?? c.customFields?.saveId ?? '',
      }));
      await db.characters.bulkPut(normalizedChars);
    }
  });

  await db.transaction('rw', db.snapshots, db.saves, db.apiEndpoints, async () => {
    await db.snapshots.clear();
    await db.saves.clear();
    await db.apiEndpoints.clear();
    if (Array.isArray(backup.snapshots)) await db.snapshots.bulkPut(backup.snapshots);
    if (Array.isArray(backup.saves)) await db.saves.bulkPut(backup.saves);
    if (Array.isArray(backup.apiEndpoints)) await db.apiEndpoints.bulkPut(backup.apiEndpoints);
  });

  await db.transaction('rw', db.plotOutlines, db.saveProfiles, async () => {
    await db.plotOutlines.clear();
    await db.saveProfiles.clear();
    if (Array.isArray(backup.plotOutlines)) await db.plotOutlines.bulkPut(backup.plotOutlines);
    if (Array.isArray(backup.saveProfiles)) {
      // v9: SaveProfile.variables 现为必填字段，旧备份缺失时回填空对象
      const normalizedProfiles = backup.saveProfiles.map((p: any) => ({
        ...p,
        variables: p.variables ?? {},
      }));
      await db.saveProfiles.bulkPut(normalizedProfiles);
    }
  });

  // v7 transaction
  await db.transaction('rw', db.createPresets, async () => {
    await db.createPresets.clear();
    if (Array.isArray(backup.createPresets)) await db.createPresets.bulkPut(backup.createPresets);
  });

  await db.transaction('rw', db.messages, async () => {
    await db.messages.clear();
    if (Array.isArray(backup.messages)) await db.messages.bulkPut(backup.messages);
  });

  // v14 transaction — 🔴 与上面各段**语义不同**，不要照抄成「先 clear 再守卫」:
  //
  // 世界书迁进 Dexie 之后，worldBooks 里装着用户导入的书、自建的书、以及对内置书的全部编辑。
  // pre-v14 的备份根本没有 `worldBooks` 字段（那时书还在 localStorage，压根不在备份里）——
  // 它对这张表**无话可说**，就不该有权删它。无条件 clear 会让「恢复一份旧备份」这个动作
  // 静默抹掉用户全部世界书（内置书下次启动能 fetch 回来，用户自己的书和编辑永久丢失）。
  //
  // 因此按字段**存在与否**分流，两者必须区分，不可用 `?? []` 把 undefined 抹平成 []:
  //   · undefined（字段缺席，pre-v14 备份）→ 整张表原样不动，连 clear 都不执行
  //   · []（字段存在但为空，v14+ 备份）    → 合法的「用户确实没有世界书」，照常 clear
  await db.transaction('rw', db.worldBooks, db.workshopProjects, async () => {
    if (backup.worldBooks !== undefined) {
      await db.worldBooks.clear();
      if (Array.isArray(backup.worldBooks)) await db.worldBooks.bulkPut(backup.worldBooks);
    }
    if (backup.workshopProjects !== undefined) {
      await db.workshopProjects.clear();
      if (Array.isArray(backup.workshopProjects))
        await db.workshopProjects.bulkPut(backup.workshopProjects);
    }
  });

  // v15 transaction — 与上面 v14 段**同一套三态语义**（Phase 0b）:
  //   · undefined（字段缺席，pre-v15 备份）→ 整张表原样不动，连 clear 都不执行
  //   · []（字段存在但为空）               → 合法的「用户确实没有自定义规则」，照常 clear
  //   · 有数据                             → 清空后整表覆盖
  // 守卫必须在 clear() **之前**，不可写成「先 clear 再 if」。
  await db.transaction('rw', db.beautifierRules, async () => {
    if (backup.beautifierRules !== undefined) {
      await db.beautifierRules.clear();
      if (Array.isArray(backup.beautifierRules))
        await db.beautifierRules.bulkPut(backup.beautifierRules);
    }
  });

  // v16 transaction — same three-state semantics as v14/v15:
  //   · undefined (pre-v16 backup) -> preserve the current table
  //   · []                         -> clear the table
  //   · rows                       -> replace the table
  await db.transaction('rw', db.regexStorage, async () => {
    if (backup.regexStorage !== undefined) {
      await db.regexStorage.clear();
      if (Array.isArray(backup.regexStorage)) {
        await db.regexStorage.bulkPut(backup.regexStorage);
      }
    }
  });

  // v17 transaction — 与 v14/v15/v16 同一套三态语义（设计 §7.3）:
  //   · undefined（pre-v17 备份）→ 整张表原样不动，连 clear 都不执行
  //   · []                       → 合法的「确实没有插画 / 没有预设」，照常 clear
  //   · 有数据                   → 清空后整表覆盖
  //
  // 🔴 `sceneImageBlobs` **不在这个事务里，也不该被 clear**：备份里根本没有字节
  //    （§7.3 明确排除），照 v14 那条理由 —— 一份对某张表**无话可说**的备份，
  //    就不该有权删它。恢复旧备份后本地已有的图片字节必须原样活着。
  await db.transaction('rw', db.sceneImages, db.imagePresets, async () => {
    if (backup.sceneImages !== undefined) {
      await db.sceneImages.clear();
      if (Array.isArray(backup.sceneImages)) await db.sceneImages.bulkPut(backup.sceneImages);
    }
    if (backup.imagePresets !== undefined) {
      await db.imagePresets.clear();
      if (Array.isArray(backup.imagePresets)) await db.imagePresets.bulkPut(backup.imagePresets);
    }
  });

  // v19 角色外貌会话副本（D56）—— 同一套三态语义。
  //
  // 🔴 它与 `sceneImages` 一样是**每存档**数据，所以必须与存档一起往返：漏掉它的症状
  //    不是报错，而是导入后每个角色的本档变化静默退回基线（看起来像 AI 失忆）。
  await db.transaction('rw', db.characterAppearances, async () => {
    if (backup.characterAppearances !== undefined) {
      await db.characterAppearances.clear();
      if (Array.isArray(backup.characterAppearances)) {
        await db.characterAppearances.bulkPut(backup.characterAppearances);
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════
// 内容包恢复对账（D18 / §5.7）
// ═══════════════════════════════════════════════════════════

/**
 * 一条 pack 拥有项的失配记录（reconcilePackState 产出）。
 *
 * `kind` 区分两类失配，UI 据此给不同的措辞与二选动作（D18）：
 * - `'missing'`：恢复后该拥有项不见了（旧备份清了表 / 手编备份删了字段）。
 *   用户二选：从本地 payload 重放 / 卸载回占位。
 * - `'replaced'`：拥有项还在但内容与 payload 不符（用户编辑过 / 被别处覆盖）。
 *   同样二选，但措辞要承认「这是你改过的，覆盖会丢你的编辑」。
 */
export interface ReconcileMismatch {
  packId: string;
  /** 'worldBooks' | 'presets' —— 对账范围（D18 限定这两节） */
  section: 'worldBooks' | 'presets';
  /** 该项的逻辑键（世界书 id / 预设 id） */
  key: string;
  /** 该项的人类可读名（UI 展示用） */
  name: string;
  kind: 'missing' | 'replaced';
}

/**
 * 恢复后对账结果（reconcilePackState 产出）。
 *
 * 🔴 `needsAttention` 为空且 `reimportedPresetId === null` → 一切正常，调用方无需提示。
 *    有任意一项 → 调用方（content-store / DataSection）应把 `contentStatus` 置为
 *    `'needs_attention'` 并展示项列表 + 二选动作（D18：**不自动做任何一边**）。
 */
export interface ReconcileResult {
  /** 全部 pack 合计的失配项（跨 pack 跨 section）；空数组 = 无失配 */
  mismatches: ReconcileMismatch[];
  /**
   * activePresetId 悬空时从 payload 重导的 story 预设 id（D18 明确分支）；
   * `null` = 未触发重导（activePresetId 仍指向存在的预设，或没有任何 pack / pack 无 presets）。
   *
   * 🔴 这是 reconcile 唯一的写动作：旧备份清了 presets 表会让 activePresetId 指向不存在的
   *    预设；从 contentPacks.payload 把 story 预设重新 put 进 presets 表。
   *    重导后 activePresetId 的真源（settings-store localStorage）由调用方另行同步，
   *    本函数只负责 DB 层 presets 行存在。
   */
  reimportedPresetId: string | null;
}

/**
 * 恢复后内容包状态对账（D18 / §5.7）。
 *
 * 🔴 **对账范围限定 `{worldBooks, presets}`**（D18）：其余分节的真源就是 contentPacks.payload
 *    本身，恢复动不到它们（FullBackup 不收 contentPacks），无从失配。
 *
 * 🔴 **逐 pack 拥有项比对**（D18 hash 分工）：对每本 pack 拥有的世界书，从 payload 现算
 *    `hashWorldBook` 作为基线，与恢复行 hash 比对；预设走 id 存在性（预设无逐条 hash 基线，
 *    D18 只要求「id 在不在」）。用户自建书 / 工坊书不在任何 pack 的拥有域内，不参与比对。
 *
 * 🔴 **只读 + 报告，不自动改任何一边**（D18「不自动做任何一边」）：失配只产出
 *    `ReconcileMismatch`，调用方决定本地 payload 重放还是卸载回占位。
 *
 * 🔴 唯一的写动作：`activePresetId` 悬空 → 从 payload 重导 story 预设（D18 明确分支）。
 *
 * @returns 对账结果；`mismatches` 为空且 `reimportedPresetId === null` 即一切正常
 */
export async function reconcilePackState(): Promise<ReconcileResult> {
  const db = getDatabase();
  const packs = await db.contentPacks.toArray();

  // 无 pack 安装 → 无从对账（也无需重导预设）
  if (packs.length === 0) {
    return { mismatches: [], reimportedPresetId: null };
  }

  const mismatches: ReconcileMismatch[] = [];

  // ── 1. worldBooks 逐 pack 逐书比对（hash 从 payload 现算） ──
  const allBooks = await db.worldBooks.toArray();
  const booksById = new Map<string, WorldBook>();
  for (const b of allBooks) booksById.set(b.id, b);

  for (const pack of packs) {
    const packBooks = pack.payload.worldBooks;
    if (!packBooks || packBooks.length === 0) continue;
    for (const packBook of packBooks) {
      const current = booksById.get(packBook.id);
      const packHash = hashWorldBook(packBook);
      if (!current) {
        mismatches.push({
          packId: pack.packId,
          section: 'worldBooks',
          key: packBook.id,
          name: packBook.name,
          kind: 'missing',
        });
      } else if (hashWorldBook(current) !== packHash) {
        mismatches.push({
          packId: pack.packId,
          section: 'worldBooks',
          key: packBook.id,
          name: packBook.name,
          kind: 'replaced',
        });
      }
    }
  }

  // ── 2. presets 逐 pack 逐条 id 存在性比对（D18：预设只判 id 在不在） ──
  const allPresets = await db.presets.toArray();
  const presetIds = new Set(allPresets.map((p) => p.id));

  for (const pack of packs) {
    const packPresets = pack.payload.presets;
    if (!packPresets || packPresets.length === 0) continue;
    for (const packPreset of packPresets) {
      if (!presetIds.has(packPreset.id)) {
        mismatches.push({
          packId: pack.packId,
          section: 'presets',
          key: packPreset.id,
          name: packPreset.name,
          kind: 'missing',
        });
      }
      // 预设无逐条 hash 基线（D18），'replaced' 不适用 —— 用户编辑预设是合法的，
      // 不会被对账标记（pack 升级时的 diff 由 D40 sectionHashes 另走路径）。
    }
  }

  // ── 3. activePresetId 悬空 → 从 payload 重导 story 预设（D18 明确分支） ──
  // activePresetId 的真源在 settings-store (localStorage)，本函数读不到它；
  // 这里只保证「DB 层 presets 表里有至少一条 pack 预设可供指向」。调用方据
  // reimportedPresetId 自行同步 activePresetId（若它原本悬空）。
  let reimportedPresetId: string | null = null;
  if (allPresets.length === 0) {
    // presets 表被旧备份清空 → 从第一个含 presets 的 pack 重导第一条预设。
    // 🔴 只重导一条（story 预设通常一条；多 pack 各自预设的完整重放走 needs_attention
    //    二选路径，不在这里自动全量重放——那等于「恢复时静默把所有 pack 预设塞回去」，
    //    违反 D18「不自动做任何一边」）。
    for (const pack of packs) {
      const packPresets = pack.payload.presets;
      if (packPresets && packPresets.length > 0) {
        const seed = packPresets[0];
        await db.presets.put({ ...seed });
        reimportedPresetId = seed.id;
        break;
      }
    }
  }

  return { mismatches, reimportedPresetId };
}

// ========== v1-v3 CRUD (unchanged) ==========

export async function getLorebooks(): Promise<Lorebook[]> {
  return getDatabase().lorebooks.toArray();
}

export async function saveLorebook(lorebook: Lorebook): Promise<string> {
  await getDatabase().lorebooks.put(lorebook);
  return lorebook.id;
}

export async function deleteLorebook(id: string): Promise<void> {
  await getDatabase().lorebooks.delete(id);
}

export async function getPresets(): Promise<ChatPreset[]> {
  return getDatabase().presets.toArray();
}

export async function savePreset(preset: ChatPreset): Promise<string> {
  await getDatabase().presets.put(preset);
  return preset.id;
}

export async function deletePreset(id: string): Promise<void> {
  await getDatabase().presets.delete(id);
}

export async function getSettings(): Promise<AppSettings | undefined> {
  const all = await getDatabase().settings.toArray();
  return all[0];
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await getDatabase().settings.put({ ...settings, key: 'settings' });
}

// v9: chats 表已删除 (M1 #46)，getChats/saveChat/deleteChat/setVariables 一并移除。
// 消息持久化走 messages 表（saveMessage/getMessages），状态写入走 StateManager.commitChatState()。

// ========== v4 新表 CRUD ==========

// --- Memories ---

export async function getMemories(saveId: string): Promise<MemoryRecord[]> {
  return getDatabase().memories.where('saveId').equals(saveId).toArray();
}

export async function getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
  return getDatabase()
    .memories.bulkGet(ids)
    .then((arr) => arr.filter(Boolean) as MemoryRecord[]);
}

export async function saveMemory(memory: MemoryRecord): Promise<string> {
  await getDatabase().memories.put(memory);
  return memory.id;
}

export async function deleteMemory(id: string): Promise<void> {
  await getDatabase().memories.delete(id);
}

/** 删除 realTimestamp 严格大于给定值的记忆（快照恢复时清理"未来"记忆用；记忆 append-only，按时间清理安全） */
export async function deleteMemoriesAfter(saveId: string, realTimestamp: number): Promise<number> {
  const db = getDatabase();
  const ids = await db.memories
    .where('saveId')
    .equals(saveId)
    .and((m) => m.realTimestamp > realTimestamp)
    .primaryKeys();
  if (ids.length > 0) await db.memories.bulkDelete(ids);
  return ids.length;
}

export async function getRecentMemories(saveId: string, limit: number): Promise<MemoryRecord[]> {
  return getDatabase()
    .memories.where('saveId')
    .equals(saveId)
    .reverse()
    .sortBy('createdAt')
    .then((arr) => arr.slice(0, limit));
}

// --- Plot Events ---

export async function getPlotEvents(saveId: string): Promise<PlotEvent[]> {
  return getDatabase().plotEvents.where('saveId').equals(saveId).toArray();
}

export async function getActivePlotEvents(saveId: string): Promise<PlotEvent[]> {
  return getDatabase()
    .plotEvents.where('saveId')
    .equals(saveId)
    .and((e) => e.status === 'active')
    .toArray();
}

export async function savePlotEvent(event: PlotEvent): Promise<string> {
  event.updatedAt = Date.now();
  await getDatabase().plotEvents.put(event);
  return event.id;
}

export async function savePlotEvents(events: PlotEvent[]): Promise<void> {
  const now = Date.now();
  for (const e of events) e.updatedAt = now;
  await getDatabase().plotEvents.bulkPut(events);
}

export async function deletePlotEvent(id: string): Promise<void> {
  await getDatabase().plotEvents.delete(id);
}

// --- Characters ---

export async function getCharacters(saveId?: string): Promise<CharacterState[]> {
  if (saveId) {
    // v9: saveId 一等索引查询（规范 §1.2；替代 customFields 全表扫描）
    return getDatabase().characters.where('saveId').equals(saveId).toArray();
  }
  return getDatabase().characters.toArray();
}

export async function getCharacter(id: string): Promise<CharacterState | undefined> {
  return getDatabase().characters.get(id);
}

export async function getCharactersByType(
  type: CharacterState['type'],
  saveId?: string,
): Promise<CharacterState[]> {
  if (saveId) {
    return getDatabase()
      .characters.where('saveId')
      .equals(saveId)
      .and((c) => c.type === type)
      .toArray();
  }
  return getDatabase().characters.where('type').equals(type).toArray();
}

export async function saveCharacter(character: CharacterState): Promise<string> {
  await getDatabase().characters.put(character);
  return character.id;
}

export async function saveCharacters(characters: CharacterState[]): Promise<void> {
  await getDatabase().characters.bulkPut(characters);
}

export async function deleteCharacter(id: string): Promise<void> {
  await getDatabase().characters.delete(id);
}

// --- Snapshots ---

export async function getSnapshots(saveId: string): Promise<Snapshot[]> {
  // M5: 按 createdAt 升序（旧 index 序号字段已随 §11.2 重定义删除）
  return getDatabase().snapshots.where('saveId').equals(saveId).sortBy('createdAt');
}

export async function getSnapshot(id: string): Promise<Snapshot | undefined> {
  return getDatabase().snapshots.get(id);
}

export async function getLatestSnapshot(saveId: string): Promise<Snapshot | undefined> {
  const snapshots = await getDatabase()
    .snapshots.where('saveId')
    .equals(saveId)
    .reverse()
    .sortBy('createdAt');
  return snapshots[0];
}

export async function saveSnapshot(snapshot: Snapshot): Promise<string> {
  await getDatabase().snapshots.put(snapshot);
  return snapshot.id;
}

export async function deleteSnapshot(id: string): Promise<void> {
  await getDatabase().snapshots.delete(id);
}

/** 删除超出上限的旧快照
 *  - mode='dense'(默认): 按 createdAt 保留最新 maxCount 个（FIFO，向后兼容）
 *  - mode='tiered': 阶梯淘汰——最近5轮全留，再往前每4轮留1，更早每8/10轮留1；
 *    非 turn 档(manual/pre-combat)受保护永不淘汰；最近5个 turn 档铁律保护。
 */
export async function trimSnapshots(
  saveId: string,
  maxCount: number,
  mode: 'tiered' | 'dense' = 'dense',
): Promise<void> {
  const all = await getDatabase()
    .snapshots.where('saveId')
    .equals(saveId)
    .reverse()
    .sortBy('createdAt'); // 最新在前

  if (all.length <= maxCount) return;

  // 非 turn 档(manual/pre-combat)受保护，永不淘汰
  const protectedIds = new Set(all.filter((s) => s.reason !== 'turn').map((s) => s.id));
  const turnSnaps = all.filter((s) => s.reason === 'turn'); // 继承 all 顺序（最新在前）

  let keepTurnIds: Set<string>;
  if (mode === 'tiered') {
    keepTurnIds = selectTieredTurnSnapshots(turnSnaps);
  } else {
    const turnKeep = Math.max(0, maxCount - protectedIds.size);
    keepTurnIds = new Set(turnSnaps.slice(0, turnKeep).map((s) => s.id));
  }

  // 最近 5 个 turn 档铁律保护（回退依赖"上一轮档"必须存在）
  const recentTurnIds = new Set(turnSnaps.slice(0, 5).map((s) => s.id));
  const kept = new Set<string>([...protectedIds, ...keepTurnIds, ...recentTurnIds]);

  // 绝对上限兜底：总数仍超 maxCount → 从最旧可淘汰 turn 档砍起（跳过最近5与非turn）
  if (kept.size > maxCount) {
    const droppable = turnSnaps.filter((s) => kept.has(s.id) && !recentTurnIds.has(s.id)); // 最新在前
    for (let i = droppable.length - 1; i >= 0 && kept.size > maxCount; i--) {
      kept.delete(droppable[i].id);
    }
  }

  const toDelete = all.filter((s) => !kept.has(s.id));
  if (toDelete.length > 0) {
    await getDatabase().snapshots.bulkDelete(toDelete.map((s) => s.id));
  }
}

/** 阶梯选择要保留的 turn 快照（turnSnaps 最新在前；按"年龄"=最新turn-snap.turn 决定保留间隔） */
function selectTieredTurnSnapshots(turnSnaps: Snapshot[]): Set<string> {
  const keep = new Set<string>();
  if (turnSnaps.length === 0) return keep;
  const sorted = [...turnSnaps].sort((a, b) => b.turn - a.turn); // turn 降序兜底
  const newestTurn = sorted[0].turn;
  let lastKeptTurn = Number.POSITIVE_INFINITY;
  for (const s of sorted) {
    const age = newestTurn - s.turn;
    // 最近5轮每轮留 / 接下来每4轮 / 更早每8轮 / 最远每10轮
    const gap = age <= 4 ? 1 : age <= 24 ? 4 : age <= 64 ? 8 : 10;
    if (lastKeptTurn - s.turn >= gap) {
      keep.add(s.id);
      lastKeptTurn = s.turn;
    }
  }
  return keep;
}

// --- Saves ---

export async function getSaves(): Promise<SaveSlot[]> {
  const saves = await getDatabase().saves.orderBy('slot').toArray();
  // 按更新时间倒序：越新的存档越靠前
  return saves.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export async function getSave(id: string): Promise<SaveSlot | undefined> {
  return getDatabase().saves.get(id);
}

export async function getSaveBySlot(slot: number): Promise<SaveSlot | undefined> {
  return getDatabase().saves.where('slot').equals(slot).first();
}

export async function saveSaveSlot(saveSlot: SaveSlot): Promise<string> {
  saveSlot.updatedAt = Date.now();
  await getDatabase().saves.put(saveSlot);
  return saveSlot.id;
}

export async function deleteSaveSlot(id: string): Promise<void> {
  const db = getDatabase();
  // 级联删除关联数据 — M6 Task 4: Dexie 事务包裹（M1 终审 Minor 遗留），
  // 任一步失败整体回滚，杜绝半删存档（如部分表已删但 saves/characters 残留）。
  await db.transaction(
    'rw',
    [
      db.snapshots,
      db.memories,
      db.plotEvents,
      db.plotOutlines,
      db.messages,
      db.characters,
      db.saveProfiles,
      db.saves,
      db.sceneImages,
      db.sceneImageBlobs,
      db.characterAppearances,
    ],
    async () => {
      await db.snapshots.where('saveId').equals(id).delete();
      await db.memories.where('saveId').equals(id).delete();
      await db.plotEvents.where('saveId').equals(id).delete();
      await db.plotOutlines.where('saveId').equals(id).delete();
      await db.messages.where('saveId').equals(id).delete();
      await db.characters.where('saveId').equals(id).delete();
      await db.saveProfiles.where('saveId').equals(id).delete();
      // v17 插画（设计 §7.2）：元数据按 saveId 删，字节按查出来的 id 批删 ——
      // 字节表没有 saveId 索引（它与 assetBlobs 同形状，只有主键），所以必须先查 id。
      //
      // 🔴 `imagePresets` **不删** —— 它是全局的（D40 / D2），与素材库同口径：
      //    删一个存档不该带走用户为全部角色写过的外观预设。
      const imageIds = await db.sceneImages.where('saveId').equals(id).primaryKeys();
      if (imageIds.length > 0) await db.sceneImageBlobs.bulkDelete(imageIds);
      await db.sceneImages.where('saveId').equals(id).delete();
      // v19 (D56): 会话外貌随存档走 —— 与 imagePresets（全局基线）刻意相反
      await db.characterAppearances.where('saveId').equals(id).delete();
      await db.saves.delete(id);
    },
  );
}

// --- 角色外貌会话副本 (v19, D56) ---

/** 主键 —— **唯一**一处拼法。名字原样，不归一化（铁律 1） */
export function characterAppearanceKey(saveId: string, name: string): string {
  return `${saveId}:${name}`;
}

export async function getCharacterAppearances(
  saveId: string,
): Promise<CharacterSessionAppearance[]> {
  return getDatabase().characterAppearances.where('saveId').equals(saveId).toArray();
}

export async function saveCharacterAppearance(row: CharacterSessionAppearance): Promise<void> {
  await getDatabase().characterAppearances.put(row);
}

/** 单个角色重置 —— 删掉会话覆盖，出图即刻回到基线 */
export async function deleteCharacterAppearance(key: string): Promise<void> {
  await getDatabase().characterAppearances.delete(key);
}

/** 整档重置（D56 的第二个重置口）—— 这一周目所有角色回到基线 */
export async function clearCharacterAppearances(saveId: string): Promise<void> {
  await getDatabase().characterAppearances.where('saveId').equals(saveId).delete();
}

// --- API Endpoints ---

export async function getApiEndpoints(): Promise<ApiEndpoint[]> {
  return getDatabase().apiEndpoints.toArray();
}

export async function getApiEndpoint(id: string): Promise<ApiEndpoint | undefined> {
  return getDatabase().apiEndpoints.get(id);
}

export async function saveApiEndpoint(endpoint: ApiEndpoint): Promise<string> {
  await getDatabase().apiEndpoints.put(endpoint);
  return endpoint.id;
}

export async function deleteApiEndpoint(id: string): Promise<void> {
  await getDatabase().apiEndpoints.delete(id);
}

// --- Plot Outlines (Phase 4) ---

export async function getPlotOutlines(saveId: string): Promise<PlotOutline[]> {
  // P1-08: 同毫秒保存会让 updatedAt 并列、Dexie sortBy 顺序不稳定 —— 改复合排序（升序）。
  const outlines = await getDatabase().plotOutlines.where('saveId').equals(saveId).toArray();
  outlines.sort(
    (a, b) =>
      (a.updatedAt ?? 0) - (b.updatedAt ?? 0) ||
      (a.version ?? 0) - (b.version ?? 0) ||
      (a.createdAt ?? 0) - (b.createdAt ?? 0),
  );
  return outlines;
}

export async function getPlotOutline(id: string): Promise<PlotOutline | undefined> {
  return getDatabase().plotOutlines.get(id);
}

export async function getLatestPlotOutline(saveId: string): Promise<PlotOutline | undefined> {
  // P1-08: 同毫秒连续保存会让 updatedAt 并列，Dexie .reverse().sortBy() 此时顺序不稳定
  // （全量测试曾因此返回旧大纲）。改为 toArray + 复合排序：updatedAt 降序为主，
  // 并列时 version 降序（世界线变动递增），再并列则 createdAt 降序（后创建的大纲更新）。
  const outlines = await getDatabase().plotOutlines.where('saveId').equals(saveId).toArray();
  if (outlines.length === 0) return undefined;
  outlines.sort(
    (a, b) =>
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
      (b.version ?? 0) - (a.version ?? 0) ||
      (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  return outlines[0];
}

export async function savePlotOutline(outline: PlotOutline): Promise<string> {
  outline.updatedAt = Date.now();
  await getDatabase().plotOutlines.put(outline);
  return outline.id;
}

export async function deletePlotOutline(id: string): Promise<void> {
  await getDatabase().plotOutlines.delete(id);
}

// --- Save Profiles (Phase 4.6) ---

export async function getSaveProfile(saveId: string): Promise<SaveProfile | undefined> {
  return getDatabase().saveProfiles.get(saveId);
}

export async function saveSaveProfile(profile: SaveProfile): Promise<void> {
  profile.updatedAt = Date.now();
  await getDatabase().saveProfiles.put(profile);
}

export async function deleteSaveProfile(saveId: string): Promise<void> {
  await getDatabase().saveProfiles.delete(saveId);
}

import { createDefaultTime } from './time-system';

export function createDefaultSaveProfile(saveId: string): SaveProfile {
  return {
    saveId,
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: createDefaultTime(),
    variables: {},
    worldFlags: {},
    updatedAt: Date.now(),
  };
}

// ═══════════════════════════════════════════════════════════
// Phase 7d — 捏人预设 CRUD
// ═══════════════════════════════════════════════════════════

export async function getCreatePresets(): Promise<CreatePresetRecord[]> {
  return getDatabase().createPresets.orderBy('updatedAt').reverse().toArray();
}

export async function getCreatePreset(id: string): Promise<CreatePresetRecord | undefined> {
  return getDatabase().createPresets.get(id);
}

export async function saveCreatePreset(preset: CreatePresetRecord): Promise<string> {
  return getDatabase().createPresets.put(preset);
}

export async function deleteCreatePreset(id: string): Promise<void> {
  await getDatabase().createPresets.delete(id);
}

// ═══════════════════════════════════════════════════════════
// Phase 10h — 消息持久化 CRUD
// ═══════════════════════════════════════════════════════════

/** 保存单条消息 */
export async function saveMessage(message: ChatMessage): Promise<string> {
  await getDatabase().messages.put(message);
  return message.id;
}

/** 批量保存消息 */
export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  await getDatabase().messages.bulkPut(messages);
}

/** 按存档 ID 获取全部消息，按时间戳升序排列 */
export async function getMessages(saveId: string): Promise<ChatMessage[]> {
  return getDatabase().messages.where('saveId').equals(saveId).sortBy('timestamp');
}

/** 按存档 ID 删除所有消息 */
export async function deleteMessagesBySaveId(saveId: string): Promise<void> {
  await getDatabase().messages.where('saveId').equals(saveId).delete();
}

/**
 * 删除指定存档中 turn 大于给定值的消息 — 快照恢复的对话回滚 (M5 §11.2, #49 复合索引启用)
 *
 * 使用 [saveId+turn] 复合索引做范围删除：下界 [saveId, turn] 开区间（保留 turn 及之前的消息），
 * 上界 [saveId, Dexie.maxKey] 封住本存档（防越界扫到其他 saveId）。
 * 注: turn 为 undefined 的遗留消息不在复合索引内，不受本删除影响。
 */
export async function deleteMessagesAfterTurn(saveId: string, turn: number): Promise<void> {
  await getDatabase()
    .messages.where('[saveId+turn]')
    .between([saveId, turn], [saveId, Dexie.maxKey], false, true)
    .delete();
}

// ========== Audio (v11) ==========
// 音频库全局共享，不随存档隔离（设计 §3.3）；音频表不进 FullBackup（设计 §12）。

/** 获取全部音轨元数据（不含音频字节 — 字节在 audioBlobs 表，仅播放时读取） */
export async function getAudioTracks(): Promise<AudioTrack[]> {
  const tracks = await getDatabase().audioTracks.toArray();
  return tracks;
}

export async function getAudioTrack(id: string): Promise<AudioTrack | undefined> {
  const track = await getDatabase().audioTracks.get(id);
  return track;
}

/**
 * 保存音轨；传入 blob 时同时写入音频字节。
 *
 * 偏离本文件"单行 CRUD"惯例改用显式事务：元数据与字节分表存储，
 * 两写必须原子 —— 半成功会留下有元数据却无字节（播放即哑）或孤儿 blob 的记录。
 */
export async function saveAudioTrack(track: AudioTrack, blob?: Blob): Promise<string> {
  const db = getDatabase();
  track.updatedAt = Date.now();
  if (blob) {
    await db.transaction('rw', db.audioTracks, db.audioBlobs, async () => {
      await db.audioTracks.put(track);
      await db.audioBlobs.put({ id: track.id, blob });
    });
  } else {
    await db.audioTracks.put(track);
  }
  return track.id;
}

/**
 * 删除音轨：元数据 + 孤儿字节一并清理，并从所有播放列表的 trackIds 中剔除该 id
 * （设计 §2 "dangling ids pruned on track delete"）。三表同事务。
 */
export async function deleteAudioTrack(id: string): Promise<void> {
  const db = getDatabase();
  await db.transaction('rw', db.audioTracks, db.audioBlobs, db.audioPlaylists, async () => {
    await db.audioTracks.delete(id);
    await db.audioBlobs.delete(id);
    const lists = await db.audioPlaylists.toArray();
    const pruned = lists
      .filter((l) => l.trackIds.includes(id))
      .map((l) => ({ ...l, trackIds: l.trackIds.filter((t) => t !== id), updatedAt: Date.now() }));
    if (pruned.length > 0) await db.audioPlaylists.bulkPut(pruned);
  });
}

/** 读取音频字节 — 仅播放时调用 */
export async function getAudioBlob(id: string): Promise<Blob | undefined> {
  const record = await getDatabase().audioBlobs.get(id);
  return record?.blob;
}

export async function getAudioPlaylists(): Promise<AudioPlaylist[]> {
  const lists = await getDatabase().audioPlaylists.toArray();
  return lists;
}

export async function getAudioPlaylist(id: string): Promise<AudioPlaylist | undefined> {
  const list = await getDatabase().audioPlaylists.get(id);
  return list;
}

export async function saveAudioPlaylist(list: AudioPlaylist): Promise<string> {
  list.updatedAt = Date.now();
  await getDatabase().audioPlaylists.put(list);
  return list.id;
}

/** 删除播放列表 — 不级联删除音轨（列表只是音轨的有序引用） */
export async function deleteAudioPlaylist(id: string): Promise<void> {
  await getDatabase().audioPlaylists.delete(id);
}

// ========== Audio 本地文件夹句柄 (v12) ==========
// 目录句柄只对本机有意义，因此同样不进 FullBackup（附录见 addendum "Storage"）。

/** 读取已持久化的目录句柄（当前仅 'library-root' 一行） */
export async function getAudioHandle(id: string): Promise<AudioHandleRecord | undefined> {
  const record = await getDatabase().audioHandles.get(id);
  return record;
}

/** 保存目录句柄；未带 addedAt 时补当前时间戳 */
export async function saveAudioHandle(record: AudioHandleRecord): Promise<string> {
  if (!record.addedAt) record.addedAt = Date.now();
  await getDatabase().audioHandles.put(record);
  return record.id;
}

/** 取消关联音乐文件夹 — 只删句柄，音轨目录保留（missing 由重扫标记） */
export async function deleteAudioHandle(id: string): Promise<void> {
  await getDatabase().audioHandles.delete(id);
}

// ========== Asset (v13) ==========
// 素材库全局共享，不随存档隔离；素材表不进 FullBackup（设计 §4.5）。
// FullBackup 是一份 JSON，字节进 JSON 就得 base64 —— 严格劣于 Blob（§4.2）。
// **zip 导出即素材的迁移路径**，且比多一个备份字段更好用。
// 「清除全部数据」走 db.delete() 整库销毁，新表自动覆盖，无需额外拆卸代码。

/** 获取全部素材元数据（不含字节 — 字节在 assetBlobs 表，仅用到图像时读取） */
export async function getAssets(): Promise<AssetMetaRecord[]> {
  const assets = await getDatabase().assetMeta.toArray();
  return assets;
}

export async function getAsset(id: string): Promise<AssetMetaRecord | undefined> {
  const asset = await getDatabase().assetMeta.get(id);
  return asset;
}

/**
 * 保存素材；传入 blob 时同时写入字节。
 *
 * 与 saveAudioTrack 同理，偏离本文件"单行 CRUD"惯例改用显式事务：元数据与字节分表存储，
 * 两写必须原子 —— 半成功会留下有元数据却无字节（渲染即空图）或孤儿 blob 的记录。
 */
export async function saveAsset(meta: AssetMetaRecord, blob?: Blob): Promise<string> {
  const db = getDatabase();
  meta.updatedAt = Date.now();
  if (blob) {
    await db.transaction('rw', db.assetMeta, db.assetBlobs, async () => {
      await db.assetMeta.put(meta);
      await db.assetBlobs.put({ id: meta.id, blob });
    });
  } else {
    await db.assetMeta.put(meta);
  }
  return meta.id;
}

/** 删除素材：元数据 + 孤儿字节一并清理，两表同事务 */
export async function deleteAsset(id: string): Promise<void> {
  const db = getDatabase();
  await db.transaction('rw', db.assetMeta, db.assetBlobs, async () => {
    await db.assetMeta.delete(id);
    await db.assetBlobs.delete(id);
  });
}

/** 批量删除素材 —— 单事务，要么全删要么全不删（批量删一半是用户最难自查的状态） */
export async function deleteAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDatabase();
  await db.transaction('rw', db.assetMeta, db.assetBlobs, async () => {
    await db.assetMeta.bulkDelete(ids);
    await db.assetBlobs.bulkDelete(ids);
  });
}

/** 读取素材字节 — 仅需要渲染/导出时调用 */
export async function getAssetBlob(id: string): Promise<Blob | undefined> {
  const record = await getDatabase().assetBlobs.get(id);
  return record?.blob;
}

// ========== Scene Images (v17) ==========
// 图像生成 v1 / 情景插画，设计 §7。
//
// 元数据随存档隔离（deleteSaveSlot 连带删），字节分表（与 assetBlobs 同形状）。
// 元数据进 FullBackup、字节不进（§7.3）。这一层只做单行 CRUD 与索引查询 ——
// take 编号 / occurrence 计数 / 队列 / 清理这些**决策**全在
// `src/ui/stores/scene-image-store.ts`，本层不判断任何事。

/** 一个存档的全部插画记录（图鉴整取；排序归调用方） */
export async function getSceneImages(saveId: string): Promise<SceneImageRecord[]> {
  return getDatabase().sceneImages.where('saveId').equals(saveId).toArray();
}

/** 一条消息上的插画记录 —— 正文渲染那条路径，走 `[saveId+messageId]` 复合索引 */
export async function getSceneImagesByMessage(
  saveId: string,
  messageId: string,
): Promise<SceneImageRecord[]> {
  return getDatabase()
    .sceneImages.where('[saveId+messageId]')
    .equals([saveId, messageId])
    .toArray();
}

export async function getSceneImage(id: string): Promise<SceneImageRecord | undefined> {
  return getDatabase().sceneImages.get(id);
}

/**
 * 保存一条插画记录；传入 blob 时同时写入字节。
 *
 * 照 `saveAsset` 的先例用显式事务：元数据与字节分表，两写必须原子 ——
 * 半成功会留下「status 是 done 却没有字节」的记录，渲染即破图。
 */
export async function saveSceneImage(record: SceneImageRecord, blob?: Blob): Promise<string> {
  const db = getDatabase();
  if (blob) {
    await db.transaction('rw', db.sceneImages, db.sceneImageBlobs, async () => {
      await db.sceneImages.put(record);
      await db.sceneImageBlobs.put({ id: record.id, blob });
    });
  } else {
    await db.sceneImages.put(record);
  }
  return record.id;
}

/** 删除一条插画：元数据 + 字节一并清理，两表同事务 */
export async function deleteSceneImage(id: string): Promise<void> {
  const db = getDatabase();
  await db.transaction('rw', db.sceneImages, db.sceneImageBlobs, async () => {
    await db.sceneImages.delete(id);
    await db.sceneImageBlobs.delete(id);
  });
}

/** 读取插画字节 — 仅渲染/导出时调用 */
export async function getSceneImageBlob(id: string): Promise<Blob | undefined> {
  const record = await getDatabase().sceneImageBlobs.get(id);
  return record?.blob;
}

/**
 * 「清理」：删字节、**留记录**（D47 / §7.5）。
 *
 * 🔴 `sceneImages` 的行数一条都不变 —— 只删 `sceneImageBlobs` 的行并给记录打上
 * `blobDropped`。理由是 §7.3 那条：元数据是**配方**（prompt + seed + model 齐全，
 * 同参数可复现），于是清理之后图鉴目录还是完整的、随时能重画 —— 这正是用户说
 * 「清理」时想要的那件事。把记录一起删掉的那种操作叫**删除**，是另一个按钮。
 *
 * `status` 也不动：这张图**画出来过**，那是历史事实，不因为腾空间而改写。
 */
export async function dropSceneImageBlobs(ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDatabase();
  let dropped = 0;
  await db.transaction('rw', db.sceneImages, db.sceneImageBlobs, async () => {
    await db.sceneImageBlobs.bulkDelete([...ids]);
    const rows = await db.sceneImages.bulkGet([...ids]);
    const next: SceneImageRecord[] = [];
    for (const row of rows) {
      if (!row) continue;
      next.push({ ...row, blobDropped: true });
      dropped += 1;
    }
    if (next.length > 0) await db.sceneImages.bulkPut(next);
  });
  return dropped;
}

/**
 * 一条记录此刻是否**占着字节**。
 *
 * `getSceneImageUsage` 与 `listCleanableSceneImageIds` 共用这一个判据，两者才不会
 * 各算各的 —— 「显示 12 张可清理、点下去只清了 8 张」是这类界面最容易长出来的裂缝。
 *
 * `status === 'done'` 是必要条件：只有走完 `saveSceneImage(record, blob)` 那条路的
 * 记录才有字节。给 `failed`/`queued` 打 `blobDropped` 会让图鉴对着一条从没画出来的
 * 记录说「字节已清理」。
 */
function hasStoredSceneImageBytes(row: SceneImageRecord): boolean {
  return row.status === 'done' && row.blobDropped !== true;
}

/**
 * 本存档的插画用量（只读，§7.5）。
 *
 * 一张图都没有时返回全 0 —— 调用方照常渲染「0 张 / 0 B」，**不要**把这一行藏起来：
 * 这行字同时在回答「我这存档到底有没有在攒图」。
 */
export async function getSceneImageUsage(saveId: string): Promise<SceneImageUsage> {
  const usage: SceneImageUsage = {
    records: 0,
    storedCount: 0,
    storedBytes: 0,
    favoriteCount: 0,
    favoriteBytes: 0,
  };
  // 走 saveId 索引逐行累加，不 toArray —— 统计不需要把整份记录数组留在内存里
  await getDatabase()
    .sceneImages.where('saveId')
    .equals(saveId)
    .each((row) => {
      usage.records += 1;
      if (!hasStoredSceneImageBytes(row)) return;
      const bytes = typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? row.bytes : 0;
      usage.storedCount += 1;
      usage.storedBytes += bytes;
      if (row.favorite === true) {
        usage.favoriteCount += 1;
        usage.favoriteBytes += bytes;
      }
    });
  return usage;
}

/**
 * 本存档中「清理」会动到的那些记录 id —— 喂给 `dropSceneImageBlobs`。
 *
 * 默认排除 `favorite`（D6 的豁免位 / §7.5）；`includeFavorite` 留给将来那个措辞更重的
 * 入口，v1 的设置页不传它。
 *
 * 只读；真正删字节的是 `dropSceneImageBlobs`，本函数一个字节都不动。
 */
export async function listCleanableSceneImageIds(
  saveId: string,
  opts: { includeFavorite?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  await getDatabase()
    .sceneImages.where('saveId')
    .equals(saveId)
    .each((row) => {
      if (!hasStoredSceneImageBytes(row)) return;
      if (row.favorite === true && opts.includeFavorite !== true) return;
      ids.push(row.id);
    });
  return ids;
}

// ========== Image Presets (v17) ==========
// 角色 + 地点视觉预设同一张表（D40），**全局**：不随存档隔离、删存档不动它。
// 主键 = `${kind}:${name}`；`name` 保留原始字符串供 `===` 匹配（铁律 1）。

export async function getImagePresets(): Promise<ImagePreset[]> {
  return getDatabase().imagePresets.toArray();
}

export async function getImagePreset(key: string): Promise<ImagePreset | undefined> {
  return getDatabase().imagePresets.get(key);
}

export async function saveImagePreset(preset: ImagePreset): Promise<string> {
  await getDatabase().imagePresets.put(preset);
  return preset.key;
}

export async function deleteImagePreset(key: string): Promise<void> {
  await getDatabase().imagePresets.delete(key);
}
