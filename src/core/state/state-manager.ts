import { isDirectMode } from '../story/generation-mode';
/**
 * StateManager — 唯一状态写入入口 (ADR-21)
 *
 * Phase 4.5 核心模块。所有状态变更必须通过 commitChatState()。
 * 替代分散的 saveChat() / saveCharacter() / setVariables() 等直接操作。
 *
 * 职责:
 * 1. 接收 StatePatch[] → 验证 → 应用 → 持久化
 * 2. 自动生成 GameEvent 记录变更
 * 3. 快照管理（M5 §11.2: createSnapshot 整份深拷贝 / restoreSnapshot 覆写 + 对话回滚）
 * 4. AI patches are best-effort; domain commands commit atomically.
 */

import type {
  StatePatch,
  StatePatchOp,
  StateCommitResult,
  GameEvent,
  CharacterState,
  MemoryRecord,
  PlotEvent,
  SaveProfile,
  Snapshot,
  StateUpdateOpRecord,
  StateUpdateRecord,
} from '../types/types';
import {
  getCharacters,
  saveCharacter,
  saveCharacters,
  deleteCharacter,
  saveMemory,
  deleteMemoriesAfter,
  pruneOrphanStoryContextRecords,
  deleteSnapshotsAfter,
  getPlotEvents,
  savePlotEvents,
  deletePlotEvent,
  getSave,
  saveSaveSlot,
  getSnapshot,
  getLatestTurnSnapshotMeta,
  saveSnapshot,
  trimSnapshots,
  deleteMessagesAfterTurn,
  getMessages,
  saveMessages,
  deleteMessagesBySaveId,
  getDatabase,
} from '../persistence/database';
import { getVar, setVar, applyPathOps } from '../variables/var-resolver';
// 补丁的纯变换（审查报告 R5b 角色域 / R5c 档案域）：唯一实现在 patch-reducer，翻译层工作状态与
// 建补丁预演共用；本文件只「读 → 变换 → 写」，I/O 与副作用（地图钩子、saveId、账目落款）留在这里
import {
  readTransferItemRequest,
  reduceAddCharacter,
  reduceAddNews,
  reduceAffectionPatch,
  reduceCharacterPatch,
  reduceFatePointPatch,
  reduceQuestPatch,
  reduceRemoveCharacter,
  reduceRenameCharacter,
  reduceTransferItem,
  reduceVariablePatch,
  resolveCharacterTarget,
  type ReduceResult,
} from './patch-reducer';
import { getEngineSettings } from '../runtime/engine-settings';
import { logEngine } from '../runtime/engine-logger';
// 并行化改造（docs/planning/2026-08-16-pipeline-parallelism.md）：一切 Dexie 写入
// 经 per-saveId FIFO 队列串行 —— 锁粒度 = 读-改-写区段，锁内禁止再入队列（铁律②）。
import { withSaveWriteLock } from './state-write-queue';
// 状态树协议 T10：玩家编辑的试算 / 只读与时间闸门 / 撤销 op（纯函数，本文件只接写入口）
import {
  PLAYER_EDIT_SOURCE,
  applyRevisionToRecord,
  playerEditFingerprint,
  previewPlayerEdit,
  type PlayerEditCommitResult,
  type PlayerEditOp,
  type PlayerEditRecordWriteback,
  type PlayerEditUndoResult,
  type PlayerEditUndoToken,
} from '../variables/state-tree-edit';
import { resolveCharacterByName, validateStatePatch } from './patch-rules';
import type { CharacterDefinition, CharacterNarrativeUpdate } from '../types/types-character';
import type { StoryMemorySource } from '../types/types';
import {
  attachCharacterDefinition,
  matchCharacterDefinition,
} from '../character/character-definitions';
import { ensureCharacterAge } from '../character/character-age';
import { authorChronicle, turnChronicle } from '../character/character-chronicle';
import { collectCompleteStoryTurns } from '../memory/memory-context';
import { storyMemorySourceMatches, storyTurnGameTimeRange } from '../memory/story-memory-source';
// Q-19：这三个模块此前在 14 处 handler 里各 `await import` 一次。它们都不 import
// 本模块（已核实无环），动态化没有换来任何解耦，只是让每个 handler 多一次 await
// 和一行噪音，还遮蔽了 1471 行那处同名解构。script-executor 仍留动态 —— 它是
// 唯一可能成环的那个（沙盒会回调状态层），单独验证后再说。
import {
  getProfile,
  updateProfile,
  getMapFlags,
  updateMapFlags,
  setMapFlagsInPlace,
  getMapFactsFlags,
  updateMapFactsFlags,
  setMapFactsInPlace,
  addNews,
  getRandomEventFlags,
  updateRandomEventFlags,
  setRandomEventFlagsInPlace,
} from './save-profile';
import { advanceTime, getSeason, toEpochMinutes } from '../time/time-system';
// 地图 v1 接线（设计 §5 接线表）：落位 / 天气断言 / 在途旗三条钩子的依赖。
// 全是纯函数叶 + 一条注入缝（`map-runtime`），没有一个会读注册表或碰 Dexie ——
// 静态 import 因此不成环（map-* 一律不 import 本模块）。
import { getMapIndex, getMapPack } from '../map/map-runtime';
import { isEmptyMapPack } from '../map/map-pack';
import { findTileByName, resolveTileByLocation, type MapIndex } from '../map/map-index';
import { findPath } from '../map/map-path';
import { weatherAt, weatherZoneOfTile } from '../map/map-weather';
// 地图 v1.2 接线（ADR-33 §2 六个 op / §4 结算钩子 / §F5 首访记档）。同上一组的依赖形状：
// `map-dynamics` 是纯函数叶（零 I/O、零时钟、零随机），中文措辞与钱的账全在本接线层。
import {
  applyBuildingAdd as addBuildingRecord,
  applyDevProgressDelta as addDevProgress,
  applyTileStatusAdd as addTileStatus,
  applyBuildingUpdate as updateBuildingRecord,
  applyMainBuildingUpdate as updateMainBuildingRecord,
  applyTileStatusRemove as removeTileStatus,
  recordFirstVisit,
  recordTileHistory,
  settleMapFacts,
  seedTileFacts,
  type BuildingPatch,
  type MainBuildingPatch,
  type MapSettlementEvent,
} from '../map/map-dynamics';
import type {
  BuildingRecord,
  MapFactsFlags,
  MapJourneyFlag,
  MapPack,
  MapSaveFlags,
  MapTile,
  TileFactsEntry,
  TileStatus,
  TileStatusEffect,
} from '../types/types-map';
// 随机事件 v1 接线（设计 §4.1 掷骰 / §4.2 首访 / §4.3 保洁 / §5.2 结算）。
// 与地图那一组同款依赖形状：全是纯函数叶 + 一条注入缝（`random-event-runtime`），
// 没有一个会读注册表或碰 Dexie，静态 import 不成环。
import { getRandomEventPack } from '../random-events/random-event-runtime';
import { isEmptyRandomEventPack } from '../random-events/random-event-pack';
import {
  armFirstVisitEvent,
  armRandomEventForced,
  pruneRandomEvents,
  rollRandomEvents,
  settleRandomEventTrigger,
} from '../random-events/random-event-scheduler';
// 地点键与上下文快照的**唯一**实现（写侧与读侧共用，见该模块文件头）
import { buildRandomEventRollContext } from '../random-events/random-event-snapshot';
import type { RandomEventRollContext } from '../types/types-random-events';
import type { EjsVarsDiff } from '../ejs/ejs-vars-diff';

// ========== Types ==========

export interface StateManagerConfig {
  saveId: string;
  onMaintenanceWarning?: (message: string) => void;
}

/** 玩家在游玩中主动修订的叙事人设；只开放三个玩家可写正式字段。 */
export interface PlayerPersonaDraft {
  personality: string;
  appearance: string;
  background: string;
}

export type PlayerPersonaUpdateResult =
  { ok: true; changed: boolean; character: CharacterState } | { ok: false; error: string };

/** commitChatState 的可选载荷（工坊 P2 / ADR-30 D5） */
export interface CommitChatStateOptions {
  isCurrent?: () => boolean;
  /**
   * EJS `vars` 草稿差量，**有序**。
   *
   * 应用顺序钉死（契约级，设计 D5 / §0）: 本列表按序逐个应用 → **然后**才是
   * `patches`（vars_update 的 AI 补丁）。同路径冲突时 **AI 覆盖 EJS** ——
   * EJS 在装配期基于回合开始的旧状态计算，AI 补丁反映本回合正文，更新鲜。
   *
   * 体积护栏（整份拒绝）在调用方（GamePipeline）判定 —— 只有那里知道差量来源
   * 是哪个 Agent，能把拒绝点名报给用户。
   */
  ejsVarsDiffs?: EjsVarsDiff[];
}

function assertCurrentTurn(isCurrent?: () => boolean): void {
  if (isCurrent && !isCurrent()) {
    const error = new Error('回合已取消或切换');
    error.name = 'AbortError';
    throw error;
  }
}

/** 表行深拷贝（结构化数据：JSON 往返即可；撤销凭据与写回都不能和库里的对象共用引用）。 */
function cloneRow<T>(row: T): T {
  return JSON.parse(JSON.stringify(row)) as T;
}

/** 撤销指纹不符时给玩家的说明：点名涉及的对象（R4）。 */
function undoDriftReason(
  token: PlayerEditUndoToken,
  current: Record<string, CharacterState | null>,
): string {
  const parts: string[] = [];
  const names = Object.keys(token.characters).map(
    (id) => current[id]?.name ?? token.characters[id]?.name ?? id,
  );
  if (names.length) parts.push(`角色（${names.join('、')}）`);
  if (token.profile) parts.push('存档档案');
  if (token.message) parts.push('本楼更新记录');
  const what = parts.length ? parts.join('、') : '相关状态';
  return `${what}在这次修改之后又被别处改过，撤销会覆盖那些改动，已拒绝；需要时可用快照回退`;
}

/** 单个 Patch 的应用结果 */
interface PatchApplicationResult {
  patch: StatePatch;
  success: boolean;
  error?: string;
  event?: GameEvent;
}

/**
 * 🗃 一次 `commitChatState` 的**提交作用域缓存**（性能改造 2026-08-17）
 *
 * 此前每个 patch 各跑一趟完整的读-改-写：10 个变量补丁 = 20 次 `getProfile` + 10 次
 * `updateProfile`；每个角色类补丁各扫一遍 `characters` 全表。改法是把读收到入口、把写收到出口，
 * 中间全在内存上演进 —— 一次提交至多 1 读 1 写 profile、1 读 1 次 bulkPut characters。
 *
 * 🔴 四条不变式（破一条就是**不报错的错**）:
 *   ① **缓存的边界 = SaveProfile + 本存档 characters 两样**。别的表（memories / plotEvents /
 *      saves / snapshots）照旧直读直写 —— 它们各自是单行操作，收进来只会多一层可错的间接。
 *   ② **锁内独占**。整个作用域活在 `withSaveWriteLock` 那一段里（`commitChatState` 进锁即建、
 *      出锁前 flush 并清空），所以「读进来之后有别人改了库」在同 saveId 内不可能发生。
 *      作用域外的方法（快照 / 时间推进 / 三条 sync 钩子的公开入口）**照旧直读 Dexie**，
 *      它们各自有自己的锁段，缓存不该跨段活着。
 *   ③ **顺序语义不变**：补丁 N 必须看得见补丁 N-1 的结果。所以按名解析走缓存里那份数组
 *      （含本次新增/改名的角色），删除立刻从数组里摘掉、绝不被后续查询复活。
 *   ④ **flush 无条件发生**（哪怕有补丁失败）：旧行为里先成功的补丁已经落库了，
 *      不能因为后面某个补丁抛错就把它们一起丢掉。
 *
 * 📌 与旧路径唯一的可观察差异：handler 现在改的是**共享对象**而不是各自的 Dexie 副本。
 *    所有 handler 都是「先校验后落地」（`update_character` 的原子拒绝、`remove_item` 的
 *    库存不足、`transfer_item` 的两段式），没有一个会「改到一半再抛」，所以失败补丁不会
 *    在缓存里留下半成品。新增 handler 必须守住这条。
 */
interface CommitScope {
  /** 本存档 SaveProfile；`profileLoaded` 之前一律 undefined（惰性读，纯角色补丁零 profile 读） */
  profile: SaveProfile | undefined;
  /** 读过了没有 —— 用布尔而不是 `profile !== undefined` 判：mock 的 getProfile 可能给 undefined */
  profileLoaded: boolean;
  /** 有没有人改过 profile（出口据此决定落不落库） */
  profileDirty: boolean;
  /** 本存档全量角色，按补丁顺序就地演进；undefined = 这次提交还没有人要过角色 */
  characters: CharacterState[] | undefined;
  /** 待落库的角色（按 id 去重 —— 同一个角色被 5 个补丁改过也只落一次） */
  dirtyCharacters: Map<string, CharacterState>;
  /** 待删除的角色 id。与 `dirtyCharacters` **构造上互斥**（写进来时互相剔除） */
  deletedCharacterIds: Set<string>;
}

/** 建一份空的提交作用域 */
function createCommitScope(): CommitScope {
  return {
    profile: undefined,
    profileLoaded: false,
    profileDirty: false,
    characters: undefined,
    dirtyCharacters: new Map(),
    deletedCharacterIds: new Set(),
  };
}

/** 保留段落，只统一跨平台换行并清掉字段外围空白。 */
function normalizePersonaText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

// ========== StateManager ==========

export class StateManager {
  private saveId: string;
  private onMaintenanceWarning?: (message: string) => void;
  private events: GameEvent[] = [];
  /**
   * 当前提交作用域缓存（见 `CommitScope`）。非 null 仅在 `commitChatState` 的锁段内成立。
   * 嵌套提交（`reactToEvents` / `applyTimeAdvance` 尾部自提交）一律发生在锁**外**，
   * 那时本字段已经复位成 null，各自建自己的作用域。
   */
  private commitScope: CommitScope | null = null;

  constructor(config: StateManagerConfig) {
    this.saveId = config.saveId;
    this.onMaintenanceWarning = config.onMaintenanceWarning;
  }

  // ========== 主入口 ==========

  /** Freeze legacy author definitions once, without replacing established save state. */
  async initializeCharacterDefinitions(
    definitions: CharacterDefinition[],
    isCurrent?: () => boolean,
  ): Promise<void> {
    await withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(isCurrent);
      const db = getDatabase();
      // 事务不含 saveProfiles 表，游戏时间在事务外先读（仍在本存档写锁内）
      const now = (await getProfile(this.saveId)).gameTime;
      await db.transaction(
        'rw',
        [db.saves, db.characters, db.messages, db.characterChronicle],
        async () => {
          const save = await getSave(this.saveId);
          if (!save) return;
          if (save.metadata.characterDefinitions === undefined && definitions.length > 0) {
            save.metadata.characterDefinitions = structuredClone(definitions);
            await saveSaveSlot(save);
          }
          const accepted = new Set(
            collectCompleteStoryTurns(await getMessages(this.saveId)).map((t) => t.key),
          );
          for (const character of await getCharacters(this.saveId)) {
            if (character.introducedBy && !accepted.has(character.introducedBy)) continue;
            const definition =
              character.definition ??
              matchCharacterDefinition(save.metadata.characterDefinitions ?? [], character.name);
            const next =
              definition && !character.definition
                ? attachCharacterDefinition(character, definition)
                : character;
            // 旧存档回填：引入年龄系统之前落库的角色没有年龄锚点，按回填时刻补一次（幂等）
            const backfilled = ensureCharacterAge(next, now);
            if (next !== character || backfilled) await saveCharacter(next);
            if (!definition) continue;
            const entries = authorChronicle(next);
            if (entries.length) await db.characterChronicle.bulkPut(entries);
          }
        },
      );
    });
  }

  /** Same-turn narrator updates; each character's profile and chronicle commit atomically. */
  async commitCharacterUpdates(
    updates: CharacterNarrativeUpdate[],
    source: StoryMemorySource,
    isCurrent?: () => boolean,
  ): Promise<string[]> {
    return withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(isCurrent);
      const db = getDatabase();
      const warnings: string[] = [];
      for (const update of updates) {
        try {
          await db.transaction(
            'rw',
            [db.saves, db.characters, db.messages, db.characterChronicle],
            async () => {
              assertCurrentTurn(isCurrent);
              const turn = collectCompleteStoryTurns(await getMessages(this.saveId)).find(
                (t) => t.key === source.sourceTurnKey,
              );
              if (!turn || !storyMemorySourceMatches(source, turn))
                throw new Error('来源回合已失效');
              const character = await this.resolveCharacter(update.name);
              const old = await db.characterChronicle
                .where('[saveId+characterId]')
                .equals([this.saveId, character.id])
                .toArray();
              const sourceRows = old.filter(
                (e) => e.source.kind === 'turn' && e.source.sourceTurnKey === source.sourceTurnKey,
              );
              // Replaying a committed response is a no-op, including profile changes.
              if (
                sourceRows.length &&
                sourceRows.every(
                  (e) =>
                    e.source.kind === 'turn' &&
                    e.source.sourceFingerprint === source.sourceFingerprint,
                )
              )
                return;
              const chronicle = update.chronicle.filter((entry) => {
                if (entry.time.kind !== 'past' || character.introducedBy === source.sourceTurnKey)
                  return true;
                warnings.push(`角色「${character.name}」已存在，未补写其过去。`);
                return false;
              });
              const next = { ...character, ...structuredClone(update.profile_changes) };
              await saveCharacter(next);
              if (sourceRows.length)
                await db.characterChronicle.bulkDelete(sourceRows.map((e) => e.id));
              const entries = turnChronicle({
                character,
                update: { ...update, chronicle },
                source,
                gameTime: storyTurnGameTimeRange(turn).end,
                sourceText: turn.storyMessages.map((m) => m.content).join('\n\n'),
                createdAt: Date.now(),
              });
              const initial = authorChronicle(next).filter((e) => !old.some((o) => o.id === e.id));
              if (initial.length || entries.length)
                await db.characterChronicle.bulkPut([...initial, ...entries]);
            },
          );
        } catch (error) {
          if (isCurrent && !isCurrent()) throw error;
          warnings.push(
            `角色「${update.name}」更新未保存：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return warnings;
    });
  }

  /**
   * 玩家主动修订叙事人设。
   *
   * 这是元设定写入，不是世界内行动：不用 `update_character`，因此不创建
   * `character_action`，也不会误触装备/技能订阅。仍由 StateManager 持有写入口，并在
   * per-save 锁内重读唯一主角，只窄改三个字段，避免拿 UI 陈旧对象覆盖刚提交的状态。
   */
  async updatePlayerPersona(draft: PlayerPersonaDraft): Promise<PlayerPersonaUpdateResult> {
    try {
      return await withSaveWriteLock(this.saveId, async () => {
        const players = (await getCharacters(this.saveId)).filter((char) => char.type === 'player');
        if (players.length !== 1) {
          return { ok: false, error: '当前存档找不到唯一主角' };
        }

        const current = players[0];
        const normalized: PlayerPersonaDraft = {
          personality: normalizePersonaText(draft.personality),
          appearance: normalizePersonaText(draft.appearance),
          background: normalizePersonaText(draft.background),
        };
        const changed =
          (current.personality ?? '') !== normalized.personality ||
          (current.appearance ?? '') !== normalized.appearance ||
          (current.background ?? '') !== normalized.background;
        if (!changed) return { ok: true, changed: false, character: current };

        const next: CharacterState = { ...current, ...normalized };
        await saveCharacter(next);

        // 与 commitChatState 同口径：角色主写已成功，更新时间触碰失败只告警，不能把成功伪装成失败。
        try {
          const save = await getSave(this.saveId);
          if (save) await saveSaveSlot(save);
        } catch (error) {
          console.warn('[StateManager] 人设已保存，但存档更新时间刷新失败:', error);
        }

        return { ok: true, changed: true, character: next };
      });
    } catch (error) {
      console.error('[StateManager] 玩家人设保存失败:', error);
      return { ok: false, error: '人设保存失败，请重试' };
    }
  }

  /** All required changes succeed together; rejection publishes no events or effects. */
  async commitDirectTurn(input: {
    patches: StatePatch[];
    messages: readonly import('../types/types').ChatMessage[];
    turnKey: string;
    /** undefined = 保留既有记录（结构化战斗关闭时休眠）；null = 清除 */
    combat?: import('../combat/direct-combat').DirectCombatRecord | null;
    eventTrigger?: string;
    isCurrent: () => boolean;
    onCommitStart?: () => void;
  }): Promise<'committed' | 'already-accepted'> {
    const source = JSON.parse(
      JSON.stringify(input.messages),
    ) as import('../types/types').ChatMessage[];
    return withSaveWriteLock(this.saveId, async () => {
      const db = getDatabase();
      const result = await db.transaction(
        'rw',
        [db.characters, db.saveProfiles, db.saves, db.memories, db.plotEvents, db.messages],
        async () => {
          assertCurrentTurn(input.isCurrent);
          const save = await getSave(this.saveId);
          if (!isDirectMode(save?.metadata.generationMode))
            throw new Error('直出提交只能用于直出存档');
          if (
            !source.length ||
            source[0].id !== input.turnKey ||
            !source.some((m) => m.role === 'assistant')
          )
            throw new Error('直出来源消息不完整');
          const stored = await db.messages.bulkGet(source.map((m) => m.id));
          if (
            stored.some(
              (row, i) =>
                !row ||
                row.saveId !== this.saveId ||
                row.role !== source[i].role ||
                row.content !== source[i].content ||
                row.storyTurnKey !== input.turnKey,
            )
          )
            throw new Error('直出来源回合已改变');
          if (stored.every((row) => row!.storyTurnStatus === 'accepted'))
            return { status: 'already-accepted' as const, events: [] };
          if (stored.some((row) => row!.storyTurnStatus !== 'pending'))
            throw new Error('直出来源回合不可接纳');
          const scope = createCommitScope();
          this.commitScope = scope;
          try {
            const events: GameEvent[] = [];
            const profile = await this.readProfile();
            if (!profile) throw new Error('存档档案不存在');
            if (input.eventTrigger && getEngineSettings().randomEventsEnabled) {
              const settled = settleRandomEventTrigger(
                getRandomEventFlags(profile),
                input.eventTrigger,
                this.gameDayOf(profile),
              );
              if (settled) setRandomEventFlagsInPlace(profile, settled.flags);
            }
            if (input.combat !== undefined) profile.worldFlags.directCombat = input.combat;
            await this.persistProfile(profile);
            // AI 来源（直出整楼）：扣命运点超出余额时钳到 0，不因此拒收整楼（A9）
            events.push(
              ...(await this.applyPatchesAtomic(input.patches, {
                fpReason: '行动结算',
                clampFpSpend: true,
                checkItemStock: true,
              })),
            );
            assertCurrentTurn(input.isCurrent);
            input.onCommitStart?.();
            await this.flushCommitScope(scope);
            await db.messages.bulkPut(
              stored.map((row) => ({
                ...row!,
                storyTurnStatus: 'accepted' as const,
                storyTurnKey: input.turnKey,
              })),
            );
            await saveSaveSlot(save);
            return { status: 'committed' as const, events };
          } finally {
            this.commitScope = null;
          }
        },
      );
      this.events.push(...result.events);
      return result.status;
    });
  }

  /**
   * 命运点补丁（`delta_variable profile.fp`）走 FP 账务，真源是 `SaveProfile.fp`。
   * 增减与记账的纯变换在 patch-reducer（`reduceFatePointPatch`），账目 id / 时间戳在这里落款。
   *
   * `clampSpend`：AI 来源（commitAiPatches / commitDirectTurn）扣超余额时钳到 0（A9，
   * 旧协议与 Agent 模式同样受保护）；领域命令与玩家修改传 false，不足照旧抛错。
   */
  private async applyFatePointPatch(
    patch: StatePatch,
    reason: string,
    clampSpend: boolean,
  ): Promise<GameEvent> {
    this.validatePatch(patch);
    const profile = await this.readProfile();
    const before = profile.fp;
    reduceFatePointPatch(profile, patch, {
      clampSpend,
      ledger: { reason, id: crypto.randomUUID(), timestamp: Date.now() },
    });
    if (profile.fp !== before) await this.persistProfile(profile);
    return this.createEvent('variable_change', patch);
  }

  /**
   * 整批原子提交的事务体（commitDirectTurn / commitDomainCommand / commitPlayerEdit 共用，R8）。
   * 调用方负责开 Dexie 事务与提交作用域；任一补丁抛错即向上抛，由事务回滚。
   * `checkItemStock`：消耗 / 转移物品前先核对数量（直出接纳沿用的前置校验）。
   */
  private async applyPatchesAtomic(
    patches: readonly StatePatch[],
    options: { fpReason: string; clampFpSpend?: boolean; checkItemStock?: boolean },
  ): Promise<GameEvent[]> {
    const events: GameEvent[] = [];
    for (const patch of patches) {
      if (options.checkItemStock && (patch.op === 'remove_item' || patch.op === 'transfer_item')) {
        const character = await this.resolveCharTarget(patch.target);
        const value = patch.value as { name: string; quantity?: number };
        const item = character.inventory.find((row) => row.name === value.name);
        if (!item || (value.quantity !== undefined && item.quantity < value.quantity))
          throw new Error(`物品「${value.name}」数量不足`);
      }
      if (patch.op === 'delta_variable' && patch.target === 'profile.fp') {
        events.push(
          await this.applyFatePointPatch(patch, options.fpReason, options.clampFpSpend === true),
        );
        continue;
      }
      const result = await this.applyPatch(patch);
      if (result.event) events.push(result.event);
    }
    return events;
  }

  /** All required changes succeed together; rejection publishes no events or effects. */
  async commitDomainCommand(patches: StatePatch[]): Promise<void> {
    if (!patches.length) return;
    await withSaveWriteLock(this.saveId, async () => {
      const db = getDatabase();
      const events = await db.transaction(
        'rw',
        [db.characters, db.saveProfiles, db.saves, db.memories, db.plotEvents],
        async () => {
          const scope = createCommitScope();
          this.commitScope = scope;
          try {
            // 领域命令（制作 / 战斗扣费等）：命运点不足照旧抛错，整批拒收
            const events = await this.applyPatchesAtomic(patches, { fpReason: '行动结算' });
            await this.flushCommitScope(scope);
            const save = await getSave(this.saveId);
            if (save) await saveSaveSlot(save);
            return events;
          } finally {
            this.commitScope = null;
          }
        },
      );
      this.events.push(...events);
      return events;
    });
  }

  /**
   * 变量修改器 / 更新块修订的写入口（状态树协议 §11.2、§12.3）。
   *
   * 与 `commitChatState` 同一把 `withSaveWriteLock`、同一批 `applyPatch` 处理器（钳制、升级、
   * 上限重算、地图落位钩子照常）；不同在于**整批原子**（语义同 `commitDomainCommand`）：
   * 锁内重读新鲜状态 → 翻译（actor: player）→ 只读键 / 时间 / 任一条被丢弃 → 整批拒绝并回传原因；
   * 应用中任一补丁抛错 → Dexie 事务回滚，状态零变化。
   *
   * 补丁带 `metadata.source: 'player_edit'`；档案文字改动由翻译层产成 `update_character` 补丁，
   * 与改名等同批补丁按序落（2026-11-25，审查 A8）。不产 deltaMinutes、不推进时间、
   * 不告知模型（§11.5 裁定）。它**不属于** `persistFocusQuest` 那类受控例外：走完整补丁路径。
   *
   * 撤销凭据（2026-11-25 审查 R4）：同一事务里比对提交前后的角色与档案，记下被触及部分提交前的
   * 整份内核快照与提交后的指纹，交 `undoPlayerEdit` 整体还原（不再生成反向 op）。
   * 传 `record` 时（更新块修订）该楼记录的改写并入同一事务：记录写回失败，状态一并回滚。
   */
  async commitPlayerEdit(
    ops: readonly PlayerEditOp[],
    options?: { isCurrent?: () => boolean; record?: PlayerEditRecordWriteback },
  ): Promise<PlayerEditCommitResult> {
    const outcome = await withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(options?.isCurrent);
      const snapshot = {
        characters: await getCharacters(this.saveId),
        profile: await getProfile(this.saveId),
      };
      const preview = previewPlayerEdit(ops, snapshot);
      const translation = preview.translation;
      if (!preview.ok || !translation) {
        return {
          ok: false as const,
          reasons: preview.reasons,
          records: preview.records,
          dropped: preview.dropped,
        };
      }
      // 提交前的整份内核快照（深拷贝：之后的读写一律不碰它）
      const beforeChars = new Map(snapshot.characters.map((c) => [c.id, cloneRow(c)]));
      const beforeProfile = cloneRow(snapshot.profile);
      const patches = translation.patches.map((p) => ({
        ...p,
        metadata: { ...(p.metadata ?? {}), source: PLAYER_EDIT_SOURCE },
      }));
      const db = getDatabase();
      try {
        const committed = await db.transaction(
          'rw',
          [db.characters, db.saveProfiles, db.saves, db.memories, db.plotEvents, db.messages],
          async () => {
            const scope = createCommitScope();
            this.commitScope = scope;
            let events: GameEvent[];
            try {
              events = await this.applyPatchesAtomic(patches, { fpReason: '玩家修改' });
              await this.flushCommitScope(scope);
            } finally {
              this.commitScope = null;
            }
            const writeback = options?.record
              ? await this.writeStateUpdateRecord(options.record, translation.records)
              : undefined;
            const undo = await this.buildPlayerEditUndo(beforeChars, beforeProfile, writeback);
            const save = await getSave(this.saveId);
            if (save) await saveSaveSlot(save);
            return { events, undo, stateUpdates: writeback?.after };
          },
        );
        this.events.push(...committed.events);
        return {
          ok: true as const,
          records: translation.records,
          normalized: translation.normalized,
          undo: committed.undo,
          ...(committed.stateUpdates ? { stateUpdates: committed.stateUpdates } : {}),
          patches,
        };
      } catch (error) {
        return {
          ok: false as const,
          reasons: [`提交失败：${error instanceof Error ? error.message : String(error)}`],
          records: translation.records,
          dropped: translation.dropped,
        };
      }
    });

    logEngine(
      outcome.ok ? 'info' : 'warn',
      'state.manual_edit',
      outcome.ok
        ? `玩家修改 ${ops.length} 条 op：已提交`
        : `玩家修改 ${ops.length} 条 op：整批拒绝`,
      () => ({
        ops,
        ...(outcome.ok
          ? {
              patches: outcome.patches.map((p) => ({
                op: p.op,
                target: p.target,
                source: p.metadata.source,
              })),
              normalized: outcome.normalized,
              ...(options?.record ? { recordMessageId: options.record.messageId } : {}),
            }
          : { reasons: outcome.reasons }),
      }),
      { saveId: this.saveId },
    );

    if (outcome.ok) {
      const { patches: _patches, ...rest } = outcome;
      return rest;
    }
    return outcome;
  }

  /**
   * 更新块修订的记录写回（`commitPlayerEdit` 事务内）：读出该楼消息、只换 `stateUpdates`。
   * 消息不在 / 不属本存档 / 没有记录 → 抛错，由事务把状态一并回滚。
   */
  private async writeStateUpdateRecord(
    target: PlayerEditRecordWriteback,
    committed: readonly StateUpdateOpRecord[],
  ): Promise<{ id: string; before: StateUpdateRecord; after: StateUpdateRecord }> {
    const table = getDatabase().messages;
    const row = await table.get(target.messageId);
    if (!row || row.saveId !== this.saveId || !row.stateUpdates)
      throw new Error('本楼更新记录不存在，记录写回失败');
    const before = cloneRow(row.stateUpdates);
    const after = cloneRow(
      applyRevisionToRecord(row.stateUpdates, target.index, target.revision, committed),
    );
    await table.put({ ...row, stateUpdates: after });
    return { id: row.id, before, after };
  }

  /** 比对提交前后（事务内重读库），记下被触及部分提交前的快照与提交后的指纹。 */
  private async buildPlayerEditUndo(
    beforeChars: ReadonlyMap<string, CharacterState>,
    beforeProfile: SaveProfile,
    writeback?: { id: string; before: StateUpdateRecord; after: StateUpdateRecord },
  ): Promise<PlayerEditUndoToken> {
    const afterChars = new Map((await getCharacters(this.saveId)).map((c) => [c.id, c]));
    const afterProfile = await getProfile(this.saveId);
    const sameChar = (a: CharacterState | null, b: CharacterState | null) =>
      playerEditFingerprint({ characters: { x: a } }) ===
      playerEditFingerprint({ characters: { x: b } });
    const characters: Record<string, CharacterState | null> = {};
    const afterTouched: Record<string, CharacterState | null> = {};
    for (const id of new Set([...beforeChars.keys(), ...afterChars.keys()])) {
      const before = beforeChars.get(id) ?? null;
      const after = afterChars.get(id) ?? null;
      if (sameChar(before, after)) continue;
      characters[id] = before;
      afterTouched[id] = after;
    }
    const profileTouched =
      playerEditFingerprint({ characters: {}, profile: beforeProfile }) !==
      playerEditFingerprint({ characters: {}, profile: afterProfile });
    return {
      saveId: this.saveId,
      characters,
      ...(profileTouched ? { profile: beforeProfile } : {}),
      ...(writeback ? { message: { id: writeback.id, stateUpdates: writeback.before } } : {}),
      fingerprint: playerEditFingerprint({
        characters: afterTouched,
        ...(profileTouched ? { profile: afterProfile } : {}),
        ...(writeback ? { stateUpdates: writeback.after } : {}),
      }),
    };
  }

  /**
   * 修改器「撤销上一次修改」（§11.4；2026-11-25 审查 R4）：按 `commitPlayerEdit` 给的凭据整体还原。
   *
   * 与提交同一把锁、同一个事务：先按凭据重读被触及的角色、档案与该楼记录算指纹，与提交后的指纹
   * 不符（之后又被别处改过）→ 拒绝并说明，什么都不写；相符 → 写回提交前的整份快照（角色 id、
   * 年龄锚点、投影外的内部字段原样回来；本次新建的角色删掉），该楼记录一并还原。
   * 直写表行、不经补丁处理器（不重算、不钳制、不触发钩子）—— 写回的就是提交前库里的样子。
   */
  async undoPlayerEdit(
    token: PlayerEditUndoToken,
    options?: { isCurrent?: () => boolean },
  ): Promise<PlayerEditUndoResult> {
    const outcome = await withSaveWriteLock(
      this.saveId,
      async (): Promise<PlayerEditUndoResult> => {
        assertCurrentTurn(options?.isCurrent);
        if (token.saveId !== this.saveId) return { ok: false, reasons: ['撤销凭据不属于当前存档'] };
        const db = getDatabase();
        try {
          return await db.transaction(
            'rw',
            [db.characters, db.saveProfiles, db.saves, db.messages],
            async (): Promise<PlayerEditUndoResult> => {
              const ids = Object.keys(token.characters);
              const rows = await db.characters.bulkGet(ids);
              const current: Record<string, CharacterState | null> = {};
              ids.forEach((id, i) => {
                const row = rows[i];
                current[id] = row && row.saveId === this.saveId ? row : null;
              });
              const profile = token.profile ? await getProfile(this.saveId) : undefined;
              const message = token.message ? await db.messages.get(token.message.id) : undefined;
              if (token.message && (!message || message.saveId !== this.saveId))
                return { ok: false, reasons: ['本楼消息已不存在，无法撤销；可用快照回退'] };
              const fingerprint = playerEditFingerprint({
                characters: current,
                ...(token.profile ? { profile } : {}),
                ...(token.message ? { stateUpdates: message?.stateUpdates ?? null } : {}),
              });
              if (fingerprint !== token.fingerprint)
                return { ok: false, reasons: [undoDriftReason(token, current)] };
              for (const id of ids) {
                const before = token.characters[id];
                if (before) await db.characters.put(cloneRow(before));
                else await db.characters.delete(id);
              }
              // 直写表行：updateProfile 会盖新的 updatedAt，栈里更早那次撤销的指纹就对不上了
              if (token.profile) await db.saveProfiles.put(cloneRow(token.profile));
              let restored: { id: string; stateUpdates: StateUpdateRecord } | undefined;
              if (token.message && message) {
                const stateUpdates = cloneRow(token.message.stateUpdates);
                await db.messages.put({ ...message, stateUpdates });
                restored = { id: message.id, stateUpdates };
              }
              const save = await getSave(this.saveId);
              if (save) await saveSaveSlot(save);
              return { ok: true, ...(restored ? { message: restored } : {}) };
            },
          );
        } catch (error) {
          return {
            ok: false,
            reasons: [`撤销失败：${error instanceof Error ? error.message : String(error)}`],
          };
        }
      },
    );
    logEngine(
      outcome.ok ? 'info' : 'warn',
      'state.manual_edit',
      outcome.ok ? '撤销玩家修改：已整体还原' : '撤销玩家修改：拒绝',
      () => ({
        characters: Object.keys(token.characters),
        profile: token.profile !== undefined,
        ...(token.message ? { recordMessageId: token.message.id } : {}),
        ...(outcome.ok ? {} : { reasons: outcome.reasons }),
      }),
      { saveId: this.saveId },
    );
    return outcome;
  }

  /** Compatibility entry point; AI batches retain valid patches when another is rejected. */
  async commitChatState(
    patches: StatePatch[],
    options?: CommitChatStateOptions,
  ): Promise<StateCommitResult> {
    return this.commitAiPatches(patches, options);
  }

  /**
   * 提交状态变更 — 唯一写入入口
   *
   * 流程:
   * 0. 🆕 工坊 P2 (D5): 先应用 EJS vars 差量（有序），**再**应用 patches ——
   *    同路径冲突时 AI 补丁覆盖 EJS，顺序钉死不可调换
   * 1. 验证所有 patches
   * 2. 依次应用每个 patch（读写数据库）
   * 3. 返回结果
   *
   * M5: 不再自动创建快照（杀 #28 patchCount%N 即建即抛），
   * 快照由 createSnapshot()/advanceTurn() 显式触发（GamePipeline 每轮一拍）。
   */
  async commitAiPatches(
    patches: StatePatch[],
    options?: CommitChatStateOptions,
  ): Promise<StateCommitResult> {
    const ejsDiffs = (options?.ejsVarsDiffs ?? []).filter(
      (d) => (d?.replace?.length ?? 0) > 0 || (d?.remove?.length ?? 0) > 0,
    );

    if (!patches.length && !ejsDiffs.length) {
      return { success: true, patchesApplied: 0, eventsGenerated: [], errors: [] };
    }

    // 🔴 并行化改造：EJS 差量段 + patches 应用段 + saveSaveSlot 是同一段
    // 读-改-写区段，必须整段互斥（同 saveId 并发提交会各自读到旧快照、后写覆盖
    // 先写 —— 变量 / gameTime / 事件旗互相回滚且零报错）。
    // `reactToEvents` 刻意放在锁外：它内部的嵌套 commitChatState 需要重新排队
    // 拿锁，留在锁内即同 saveId 自等死锁（state-write-queue 铁律②）。
    const applied = await withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(options?.isCurrent);
      const results: PatchApplicationResult[] = [];
      const errors: string[] = [];

      // 🗃 提交作用域缓存开张（不变式见 `CommitScope`）：读收在这里、写收在 flush，
      // 中间所有 handler 都在内存上改同一份 profile / 同一批角色对象。
      // 保存并复原上一层的作用域而不是直接置 null —— 万一将来真出现锁内嵌套提交，
      // 内层结束时不该把外层的脏标记连同缓存一起抹掉（现在不可能：锁内嵌套即自死锁）。
      const scope = createCommitScope();
      const outerScope = this.commitScope;
      this.commitScope = scope;
      try {
        // ===== Step 0: EJS 差量先落（D5 仲裁顺序） =====
        if (ejsDiffs.length) {
          try {
            let vars = await this.getCurrentVariables();
            for (const diff of ejsDiffs) {
              vars = applyPathOps(vars, diff);
            }
            await this.persistVariables(vars);
          } catch (err) {
            // 不阻塞 AI 补丁 —— EJS 是簿记旁路，正文状态更重要
            const msg = err instanceof Error ? err.message : String(err);
            errors.push(`EJS vars 差量应用失败: ${msg}`);
            console.warn('[StateManager] EJS vars 差量应用失败（不阻塞 AI 补丁）:', err);
            this.onMaintenanceWarning?.(
              `[StateManager] EJS vars 差量应用失败（不阻塞 AI 补丁）: ${String(err)}`,
            );
          }
        }

        const newEvents: GameEvent[] = [];
        for (const patch of patches) {
          try {
            // 🔴 命运点数(FP) 的真源是 `SaveProfile.fp`（**不是**变量路径、也不在角色身上）：
            //    `delta_variable profile.fp` 必须走既有 FP 账务（addFP/spendFP），否则会被
            //    `applyVariablePatch` 当成 `variables.profile.fp` 写进伪路径 —— AI 的
            //    `fp.delta` 看起来「提交成功」，真源却纹丝不动（与 commitDomainCommand 同口径）。
            //    AI 来源扣超余额时钳到 0（A9），不抛错丢条。
            if (patch.op === 'delta_variable' && patch.target === 'profile.fp') {
              const event = await this.applyFatePointPatch(patch, '行动结算', true);
              results.push({ patch, success: true, event });
              this.events.push(event);
              newEvents.push(event);
              continue;
            }
            const result = await this.applyPatch(patch);
            results.push(result);
            if (result.event) {
              this.events.push(result.event);
              newEvents.push(result.event);
            }
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            errors.push(`Patch ${patch.op} on ${patch.target}: ${errorMsg}`);
            results.push({ patch, success: false, error: errorMsg });
          }
        }

        // 🗃 落库唯一一拍（不变式④：有补丁失败也照落 —— 旧路径里先成功的补丁已经进库了）
        try {
          await this.flushCommitScope(scope);
        } catch (err) {
          // 落库失败必须 loud：整段状态没进库，而调用方只看 errors[] 判成败
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`状态落库失败: ${msg}`);
          console.error('[StateManager] 提交落库失败:', err);
        }

        // 更新 SaveSlot 触碰时间（saveSaveSlot 内部刷新 updatedAt）
        // M5 #27: totalTurns 不再随每次 commit 虚高，回合推进统一走 advanceTurn()
        try {
          const save = await getSave(this.saveId);
          if (save) {
            await saveSaveSlot(save);
          }
        } catch {
          // 存档更新失败不阻塞
        }

        return { results, errors, newEvents };
      } finally {
        this.commitScope = outerScope;
      }
    });

    logEngine(
      applied.errors.length === 0 ? 'debug' : 'warn',
      'state.commit',
      `提交 ${patches.length} 条补丁：成功 ${applied.results.filter((r) => r.success).length}`,
      () => ({
        patches,
        ejsVarsDiffs: ejsDiffs,
        results: applied.results.map((r) => ({
          op: r.patch.op,
          target: r.patch.target,
          success: r.success,
          ...(r.error ? { error: r.error } : {}),
        })),
        errors: applied.errors,
        events: applied.newEvents,
      }),
      { saveId: this.saveId },
    );

    return {
      success: applied.errors.length === 0,
      patchesApplied: applied.results.filter((r) => r.success).length,
      eventsGenerated: [...this.events],
      errors: applied.errors,
    };
  }

  /** 获取已生成的事件列表 */
  getEvents(): ReadonlyArray<GameEvent> {
    return this.events;
  }

  /** 清空事件缓存 */
  clearEvents(): void {
    this.events = [];
  }

  // ═══════════════════════════════════════════════════════════
  // 🗃 提交作用域缓存的读写口（不变式与边界见 `CommitScope`）
  // ═══════════════════════════════════════════════════════════
  //
  // 这六个方法是 commit 路径上**唯一**允许碰 profile / characters 的地方。
  // 作用域外调用（快照、时间推进、三条 sync 钩子的公开入口）会自动退化成直读直写，
  // 所以同一个 handler 两种上下文下都对 —— 调用点不必知道自己在不在提交里。

  /** 读本存档 profile：作用域内只读一次，之后全走缓存 */
  private async readProfile(): Promise<SaveProfile> {
    const scope = this.commitScope;
    if (scope === null) return getProfile(this.saveId);
    if (!scope.profileLoaded) {
      // 🔴 失败**不缓存**：EJS 差量那一步读炸之后，后面的 AI 补丁仍要能自己再读一次
      //    （「差量应用抛错不阻塞 AI 补丁」那条用例钉的就是这个）
      scope.profile = await getProfile(this.saveId);
      scope.profileLoaded = true;
    }
    return scope.profile as SaveProfile;
  }

  /**
   * 标记 profile 待落库：作用域内只打脏标记（出口统一落一次），作用域外立即写。
   *
   * 🔴 认的是**对象身份**：传进来的若不是缓存里那一份（作用域外读来的、或者别处构造的），
   *    立即落库才是对的 —— 打脏标记只会让这次写静默消失。
   */
  private async persistProfile(profile: SaveProfile): Promise<void> {
    const scope = this.commitScope;
    if (scope !== null && scope.profileLoaded && scope.profile === profile) {
      scope.profileDirty = true;
      return;
    }
    await updateProfile(profile);
  }

  /** 读本存档全量角色：作用域内只查一次表，之后全走缓存（含本次提交新增/删除的结果） */
  private async readCharacters(): Promise<CharacterState[]> {
    const scope = this.commitScope;
    if (scope === null) return getCharacters(this.saveId);
    if (scope.characters === undefined) {
      // 复制一份数组再缓存：本层会就地增删，绝不去改调用方（含测试 mock）持有的那个数组。
      // 元素对象仍是共享的 —— handler 就地改角色正是靠这一点（不变式③）。
      scope.characters = [...(await getCharacters(this.saveId))];
    }
    return scope.characters;
  }

  /** 标记单个角色待落库：作用域内进脏表（出口一次 bulkPut），作用域外立即写 */
  private async persistCharacter(char: CharacterState): Promise<void> {
    const scope = this.commitScope;
    if (scope === null) {
      await saveCharacter(char);
      return;
    }
    // 先删后加同一 id（remove_character 之后又 add_character）→ 这一条不再算删除
    scope.deletedCharacterIds.delete(char.id);
    scope.dirtyCharacters.set(char.id, char);
    // 新增角色必须当场进缓存数组，否则同一次提交里后续补丁按名解析不到它（不变式③）
    const chars = await this.readCharacters();
    if (!chars.some((c) => c.id === char.id)) chars.push(char);
  }

  /** 标记多个角色待落库（transfer_item 的双方 —— 出口那次 bulkPut 仍是单事务） */
  private async persistCharacters(chars: CharacterState[]): Promise<void> {
    for (const char of chars) await this.persistCharacter(char);
  }

  /** 标记角色待删除：作用域内当场从缓存摘掉（不得被后续查询复活），作用域外立即删 */
  private async dropCharacter(id: string): Promise<void> {
    const scope = this.commitScope;
    if (scope === null) {
      await deleteCharacter(id);
      return;
    }
    scope.dirtyCharacters.delete(id);
    scope.deletedCharacterIds.add(id);
    if (scope.characters !== undefined) {
      const idx = scope.characters.findIndex((c) => c.id === id);
      if (idx >= 0) scope.characters.splice(idx, 1);
    }
  }

  /**
   * 落库唯一一拍：至多 1 次 `updateProfile` + 1 次 characters bulkPut + n 次删除。
   * 脏表与删除表构造上互斥（见 `persistCharacter` / `dropCharacter`），所以两者顺序无关。
   */
  private async flushCommitScope(scope: CommitScope): Promise<void> {
    if (scope.profileDirty && scope.profile !== undefined) {
      await updateProfile(scope.profile);
    }
    if (scope.dirtyCharacters.size > 0) {
      await saveCharacters([...scope.dirtyCharacters.values()]);
    }
    for (const id of scope.deletedCharacterIds) {
      await deleteCharacter(id);
    }
  }

  // ========== Patch 应用 ==========

  private async applyPatch(patch: StatePatch): Promise<PatchApplicationResult> {
    // 验证 — 失败直接 throw → 被 commitChatState 的 try/catch 收进 errors[]（M2 语义修正）
    this.validatePatch(patch);

    const handler = PATCH_HANDLERS[patch.op];
    if (!handler) {
      // 未知 op 必须 loud 失败 → commitChatState 收进 errors[]
      // （终审修复: 旧 return 形态被上层当成功吞掉）
      throw new Error(`未知操作: ${patch.op}`);
    }
    const event = await handler(this, patch);

    return { patch, success: true, event };
  }

  // ========== 验证 ==========

  /**
   * Patch 验证 — 失败即 throw（M2 语义修正）
   *
   * 需求矩阵（M2 规范附录 A）:
   * - value 必填: set/add/update/remove/equip/rename 类（见 VALUE_REQUIRED_OPS）
   * - amount 必填: delta 类（见 AMOUNT_REQUIRED_OPS）
   * - 无额外要求: remove_character / remove_variable
   * - move_variable: 需要 metadata.toPath
   * - 例外: update_character 允许 value 为空（metadata.action-only 场景）
   */
  private validatePatch(patch: StatePatch): void {
    // 规则住 patch-rules.ts（直出建补丁时用同一份预判）
    validateStatePatch(patch);
  }

  // ========== 名字解析 (M2 铁律2: 名字解析唯一入口) ==========

  /**
   * 按名字解析角色 — 所有角色类 handler 的唯一寻址入口
   *
   * 解析顺序 (M4: 名字寻址唯一化，铁律1 收口 — 不再按 id 查库):
   * ① 本存档内按 name 精确匹配
   * ② '主角'/'玩家' 别名 → 本存档 type='player' 的角色
   * ③ 找不到 → throw
   */
  private async resolveCharacter(key: string): Promise<CharacterState> {
    // 走提交作用域缓存：同一次提交里 patch N 必须解析得到 patch N-1 新增/改名的角色（不变式③）
    // 解析顺序住 patch-rules.ts（直出建补丁时用同一份预判）
    return resolveCharacterByName(await this.readCharacters(), key);
  }

  /**
   * 从 patch.target 解析角色 — 剥离 'characters.' 前缀后只取第一段
   * （防御子路径写法 'characters.X.skills'，#11 Code 侧防御）
   */
  private async resolveCharTarget(target: string): Promise<CharacterState> {
    // 剥前缀与取首段的口径住 patch-reducer（翻译层工作状态用同一份）
    return resolveCharacterTarget(await this.readCharacters(), target);
  }

  // ========== Patch Handlers ==========

  /**
   * set / delta / remove / move / insert_variable（真源 SaveProfile.variables，M5）：
   * 读 profile → `reduceVariablePatch` → 落库。按字面路径写（命运点由调用方先分流）。
   */
  private async applyVariablePatch(patch: StatePatch): Promise<GameEvent> {
    const profile = await this.readProfile();
    reduceVariablePatch(profile, patch);
    await this.persistProfile(profile);
    return this.createEvent('variable_change', patch);
  }

  // ========== Variable Persistence ==========
  // M5 Task 1: 变量唯一真源 = SaveProfile.variables（规范 §12，杀 #1 静默丢弃 + #33 双轨）
  // 寄生快照路径已删——快照恢复时 variables 随 saveProfile 深拷贝整体回滚（M5 Task 2/3）。

  /** 获取当前变量（真源: SaveProfile.variables） */
  private async getCurrentVariables(): Promise<Record<string, any>> {
    const profile = await this.readProfile();
    return profile.variables ?? {};
  }

  /** 持久化变量到 SaveProfile（提交作用域内 = 改内存打脏标记，出口统一落一次库） */
  private async persistVariables(variables: Record<string, any>): Promise<void> {
    const profile = await this.readProfile();
    profile.variables = variables;
    await this.persistProfile(profile);
  }

  // ---------- 角色域：读 → reducer（`patch-reducer.ts`，翻译层影子共用）→ 写 ----------

  /** reducer 的说明里原先就记日志的两级照旧打出来；`fix`（值被纠正）不记。 */
  private logReduceNotes(result: ReduceResult): void {
    for (const note of result.notes) {
      if (note.level === 'warn') console.warn(`[StateManager] ${note.text}`);
      else if (note.level === 'info') console.info(`[StateManager] ${note.text}`);
    }
  }

  /** 单角色补丁的公共形状：按 target 解析角色 → 纯变换 → 落库 → 事件。 */
  private async applyCharacterReducer(
    patch: StatePatch,
    eventType: GameEvent['type'],
  ): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);
    this.logReduceNotes(reduceCharacterPatch(char, patch));
    await this.persistCharacter(char);
    return this.createEvent(eventType, patch);
  }

  /** update_character（白名单、上限固化与重算、主角推进、NPC 层级、金钱钳 0 全在 reducer）。 */
  private async applyUpdateCharacter(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'character_action');
  }

  private async applySetResource(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'character_action');
  }

  private async applyDeltaResource(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'character_action');
  }

  /** add / update / remove_status_effect（update 找不到状态名 warn 忽略、不抛）。 */
  private async applyAddStatusEffect(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'status_effect');
  }

  private async applyRemoveStatusEffect(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'status_effect');
  }

  private async applyUpdateStatusEffect(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'status_effect');
  }

  private async applyAddItem(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'item_use');
  }

  private async applyRemoveItem(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'item_use');
  }

  private async applyUpdateItem(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'item_use');
  }

  /**
   * transfer_item — 原子转移 (#5)：先读请求、解析接收方（乙不存在 → throw，甲不动），
   * 校验与变换在 reducer；双方进同一份脏表 → 出口那次 bulkPut 仍是单事务。
   */
  private async applyTransferItem(patch: StatePatch): Promise<GameEvent> {
    const from = await this.resolveCharTarget(patch.target);
    const request = readTransferItemRequest(patch);
    const to = await this.resolveCharacter(request.to);
    this.logReduceNotes(reduceTransferItem(from, to, request));
    await this.persistCharacters([from, to]);
    return this.createEvent('item_use', patch);
  }

  private async applyEquipItem(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'item_use');
  }

  private async applyUnequipItem(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'item_use');
  }

  private async applyAddSkill(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'skill_use');
  }

  private async applyUpdateSkill(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'skill_use');
  }

  private async applyRemoveSkill(patch: StatePatch): Promise<GameEvent> {
    return this.applyCharacterReducer(patch, 'skill_use');
  }

  private async applySetLocation(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    this.logReduceNotes(reduceCharacterPatch(char, patch));
    await this.persistCharacter(char);

    // 地图 v1（§8.2）：位置路径先落库，**然后**才投影成地块 —— 顺序是契约的一部分，
    // 位置路径是真源、地块只是投影（裁定 §12-1）。投影失败/抛错一律不影响上面这一步。
    await this.syncMapLocation(char);

    // 地图 v1.2（§F5）：首访记档**必须在落位之后** —— 它读的是刚写进 flags 的 `lastTileId`
    await this.syncTileFirstVisit(char);

    // 随机事件 v1（§4.2）：**必须在落位之后** —— 地点键优先取地块名，而地块名要等
    // `syncMapLocation` 把 `lastTileId` 写进 flags 才拿得到（否则每次都降级成位置路径最深段，
    // 症状是首访事件在「地块名 ≠ 路径末段」的地方永远不触发，而没有任何一处会报错）
    await this.syncRandomEventFirstVisit(char);

    return this.createEvent('location_change', patch);
  }

  private async applyAddCharacter(patch: StatePatch): Promise<GameEvent> {
    const character = patch.value as CharacterState;
    if (!character?.id) throw new Error('缺少角色数据');

    // 校验（非空名字、同存档同名查重 —— 查的是缓存那份，同一次提交里连着加两个同名角色，
    // 第二个必须被拦下，不变式③）与人物内容整理（年龄锚点、§5.6 自带额外的上限规整）都在
    // patch-reducer 一处，翻译层工作状态建人走同一份。作用域外读来的是一份新数组，追加进去无害。
    const chars = await this.readCharacters();
    const gameTime = (await this.readProfile()).gameTime;

    reduceAddCharacter(chars, character, gameTime);

    // 铁律3: saveId 是账务字段，由 Code 无条件注入，不信任上游 patch 构造方 (#8/M2硬前置②)
    // M6 T2: customFields.saveId 双写已退役 — saveId 单源一等字段
    character.saveId = this.saveId;

    await this.persistCharacter(character);
    return this.createEvent('system', patch);
  }

  /**
   * remove_character — M2 新增，怪物生命周期 (规范 §2.2)
   *
   * target = characters.<名> — resolveCharTarget 解析后整条删除 Dexie 记录。
   * 规范 §2.2: 怪物/召唤物死亡或战斗结束即整条删除。
   * op 本身不按 type 限制（任何角色都可删），type 级生命周期策略在上游（翻译层/Prompt）。
   * 找不到 → resolveCharTarget throw 进 errors[]（不静默）。
   */
  private async applyRemoveCharacter(patch: StatePatch): Promise<GameEvent> {
    // M4: resolveCharTarget 仅在本存档内按名解析，跨档命中已无可能（旧守卫随之拆除）
    const char = await this.resolveCharTarget(patch.target);
    // 摘出缓存数组走 reducer（翻译层工作状态同一份）；删除表与落库在 dropCharacter
    reduceRemoveCharacter(await this.readCharacters(), char);
    await this.dropCharacter(char.id);
    return this.createEvent('system', patch);
  }

  /**
   * rename_character — M2 新增，改名兜底 (规范 §2.2)
   *
   * target = characters.<旧名>  value = '<新名>'（裸字符串，非对象）
   * ① 新名 trim 后非空校验，非字符串 → throw
   * ② 同存档新名查重（排除自身）→ 撞名 throw 进 errors[]
   * ③ char.name = 新名 落库
   * ④ 按名引用迁移: profile.affections[旧名] 键迁到新名（值保留，旧键删）
   *    ⚠️ 当前按名引用仅 affections；M5/M6 新增按名引用时必须回来扩这里。
   *    quests 的叙事文本字段不迁移（接受陈旧）。
   * 新名 === 旧名 → no-op 成功（幂等改名无害，不落库不迁移）。
   */
  private async applyRenameCharacter(patch: StatePatch): Promise<GameEvent> {
    if (typeof patch.value !== 'string') {
      throw new Error(`rename_character value 必须是新名字符串: ${JSON.stringify(patch.value)}`);
    }
    // M4: resolveCharTarget 仅在本存档内按名解析，跨档命中已无可能（旧守卫随之拆除）
    const char = await this.resolveCharTarget(patch.target);
    const characters = await this.readCharacters();
    const profile = await this.readProfile();

    // 校验、幂等（新名 = 旧名 no-op）、查重、改名与好感按名迁移都在 patch-reducer
    // （M5/M6 新增按名引用时回那里扩）；这里只按结果决定落哪几样
    const result = reduceRenameCharacter(
      { characters, profile: { affections: profile?.affections ?? {} } },
      char,
      patch.value,
    );
    if (result.renamed) await this.persistCharacter(char);
    if (result.affectionMoved) await this.persistProfile(profile);

    return this.createEvent('system', patch);
  }

  private async applyAddMemory(patch: StatePatch): Promise<GameEvent> {
    const memory = patch.value as MemoryRecord;
    if (!memory?.id) throw new Error('缺少记忆数据');

    await saveMemory(memory);
    return this.createEvent('system', patch);
  }

  private async applyUpdatePlotEvent(patch: StatePatch): Promise<GameEvent> {
    const update = patch.value as { eventId: string; changes: Partial<PlotEvent> };
    if (!update?.eventId) throw new Error('缺少事件 ID');

    const events = await getPlotEvents(this.saveId);
    const event = events.find((e) => e.id === update.eventId);
    if (!event) throw new Error(`剧情事件不存在: ${update.eventId}`);

    Object.assign(event, update.changes);
    event.updatedAt = Date.now();
    await savePlotEvents([event]);

    return this.createEvent('plot_trigger', patch);
  }

  /**
   * update_quest / remove_quest：名字校验、status 归一化（#32）与合并语义都在 patch-reducer
   * （`reduceQuestPatch`），落库那一拍由提交出口统一做。
   */
  private async applyQuestPatch(patch: StatePatch): Promise<GameEvent> {
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    reduceQuestPatch(profile, patch);
    await this.persistProfile(profile);
    return this.createEvent('quest_update', patch);
  }

  // ========== 好感度 / 新闻 (M2 T10, #15 #16 — 写 SaveProfile，非 CharacterState) ==========

  /**
   * set_affection / delta_affection — 好感度写入 (规范 §7)
   *
   * target 形态: `affections.<角色名>` — 名字是 profile.affections 的自由键，
   * 不经 resolveCharacter（好感度键无需角色实体存在）。target 校验、取整与
   * clamp 到 [-100, +100] 都在 patch-reducer（`reduceAffectionPatch`）。
   */
  private async applyAffection(patch: StatePatch): Promise<GameEvent> {
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    reduceAffectionPatch(profile, patch);
    await this.persistProfile(profile);
    // GameEventType 无 affection 成员（M1 实测），走 'system'
    return this.createEvent('system', patch);
  }

  /**
   * add_news — 追加世界新闻 (规范 §8)
   *
   * AI 只填叙事字段 {title(必), content(必), category?}；
   * Code 补账务字段 id / publishedAt / read（铁律3）：校验与追加在 patch-reducer，
   * id 与发布时间在这里落款（reducer 不取随机、不读时钟）。
   */
  private async applyAddNews(patch: StatePatch): Promise<GameEvent> {
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    reduceAddNews(profile, patch, { id: crypto.randomUUID(), publishedAt: Date.now() });
    await this.persistProfile(profile);
    return this.createEvent('system', patch);
  }

  // ═══════════════════════════════════════════════════════════
  // 🧱 地块事实 op（地图 v1.2 / ADR-33 §2，六个）
  // ═══════════════════════════════════════════════════════════
  //
  // 六个 handler 共用同一条骨架:
  //   ① `openTileFacts` —— 按**地块名**解析（精确 → 归一化 → 放弃）+ 读事实 + copy-on-write 播种
  //   ② 调 `map-dynamics` 的对应纯函数（本层不做任何算术、不写任何编年史措辞）
  //   ③ `writeTileFacts` —— 整份覆盖回 `worldFlags.mapFacts`
  //
  // 🔴 **解析失败一律 warn + no-op，绝不 throw**（裁定 §8-3，照 v1 §12-4「被动解析不否决」）：
  //    这些 op 是 AI 顺手产的旁路事实，为一个写错的地名否掉整次提交 = 把正文状态一起丢掉。
  //    所以每条路径都返回一个正常的 GameEvent —— 提交那边看到的是「这条 patch 成功了、
  //    只是什么都没改」，与「AI 移除一条根本不在的状态」是同一种无害。
  // 🔴 事实的键是**地块的正式名**（`tile.name`）而不是 AI 写进 op 的那个串：绑定名/别名
  //    与正式名指同一块地，按 AI 写法存会长出两份互不相干的事实，而两边都「工作正常」。

  /**
   * 六个 op 的公共前段。解析不出地块 → `null`（调用方直接返回空事件）。
   *
   * 播种（`seedTileFacts`）在这里发生而不是在写回时：**首次偏离 pack 基线**就是本次 op，
   * 而基线（起始档 + 初始建筑）必须以**当时**的包为种子（§3 copy-on-write）。
   */
  private async openTileFacts(rawName: unknown, op: string): Promise<TileFactsContext | null> {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length === 0) {
      console.warn(`[StateManager] ${op} 缺少 value.tile（地块名），忽略`);
      return null;
    }
    const index = getMapIndex();
    const tileId = findTileByName(index, name);
    const tile = tileId === null ? undefined : index.tileById.get(tileId);
    if (tile === undefined) {
      console.warn(`[StateManager] ${op} 认不出地块名「${name}」，忽略（不打断正文提交）`);
      return null;
    }

    const profile = await this.readProfile();
    const facts = getMapFactsFlags(profile);
    const day = this.gameDayOf(profile);
    const entry = facts.tiles[tile.name] ?? seedTileFacts(tile, day);
    return { profile, facts, tile, entry, day };
  }

  /** 六个 op 的公共后段：整份覆盖回 `worldFlags.mapFacts`（提交作用域内只打脏标记） */
  private async writeTileFacts(ctx: TileFactsContext, entry: TileFactsEntry): Promise<void> {
    setMapFactsInPlace(ctx.profile, {
      ...ctx.facts,
      tiles: { ...ctx.facts.tiles, [ctx.tile.name]: entry },
    });
    await this.persistProfile(ctx.profile);
  }

  /**
   * tile_status_add —— 挂/刷新一条地块状态（裁定 §8-10 同名即刷新）。
   *
   * 🔴 `value.reason` 在这条 op 上**收下就丢**：状态的挂与除**刻意不记编年史**
   *    （裁定 §8-14 —— 同名刷新会把 10 格 FIFO 刷屏）。收下是为了让 AI 的输出格式在六个 op
   *    之间保持一致（写了不报错），丢掉是因为没有它该落进去的地方。
   */
  private async applyTileStatusAdd(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    const title = typeof v.title === 'string' ? v.title.trim() : '';
    if (title.length === 0) {
      console.warn('[StateManager] tile_status_add 缺少 value.title（状态名=地块内逻辑键），忽略');
      return this.createEvent('system', patch);
    }

    const status: TileStatus = {
      title,
      description: typeof v.description === 'string' ? v.description : '',
      effects: coerceTileStatusEffects(v.effects),
      // 认不出的时长读作**永久**而不是 0：0 = 挂上当天就到期，等于 AI 写错一个字段就静默什么都没发生
      durationDays: coerceDurationDays(v.durationDays),
      appliedAtDay: ctx.day, // 到期与周期结算的锚（§4 零簿记调度）
    };
    await this.writeTileFacts(ctx, addTileStatus(ctx.entry, status));
    return this.createEvent('system', patch);
  }

  /** tile_status_remove —— 按 title 精确移除（永久状态的唯一出口）；不在场即无变化 */
  private async applyTileStatusRemove(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    const title = typeof v.title === 'string' ? v.title.trim() : '';
    if (title.length === 0) {
      console.warn('[StateManager] tile_status_remove 缺少 value.title，忽略');
      return this.createEvent('system', patch);
    }

    const next = removeTileStatus(ctx.entry, title);
    // `null` = 这条状态根本不在（AI 复读）→ 一个字节都不写，连播种都不落
    if (next !== null) await this.writeTileFacts(ctx, next);
    return this.createEvent('system', patch);
  }

  /**
   * tile_building_add —— 记一座建筑，落**最小空槽**（裁定 §8-8）。
   *
   * 收益锚（`anchorDay`）取**当天**：入账点从锚纯推导（§4），锚定错了的表现是钱在
   * 意料之外的日子入账，而不会有任何一处报错。
   *
   * 🔴 这条 op **永远不碰主建筑**（裁定 §8-17）：每块地恰有一座、不可新建也不可替换，
   *    所以 `main: true` 在这里是明确的拒绝而不是「顺手当成 update」——
   *    静默改写会让 AI 以为它能用 add 重建一座主建筑，而那座旧的名字就这么没了。
   */
  private async applyTileBuildingAdd(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    if (v.main === true) {
      console.warn(
        `[StateManager] tile_building_add 不能创建主建筑（每块地恒有一座，改用 tile_building_update + main:true）：${ctx.tile.name}`,
      );
      return this.createEvent('system', patch);
    }

    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (name.length === 0) {
      console.warn('[StateManager] tile_building_add 缺少 value.name（建筑名=地块内逻辑键），忽略');
      return this.createEvent('system', patch);
    }

    const record: BuildingRecord = { name };
    if (typeof v.description === 'string') record.description = v.description;
    if (typeof v.ownerFlavor === 'string') record.ownerFlavor = v.ownerFlavor;
    if (typeof v.playerOwned === 'boolean') record.playerOwned = v.playerOwned;
    // 同名再落 = 当更新处理（见 `applyBuildingAdd`）→ 锚同样要沿用那一座已有的
    const income = coerceBuildingIncome(v.income, ctx.day, existingBuildingIncome(ctx.entry, name));
    if (income !== undefined) record.income = income;

    const reason = typeof v.reason === 'string' ? v.reason : undefined;
    const result = addBuildingRecord(
      ctx.entry,
      ctx.tile,
      record,
      ctx.day,
      reason ? { reason } : {},
    );
    if (!result.ok) {
      // 满槽 / 无发展度都是**明确的拒绝**，不静默吞（`BuildingAddResult` 存在的理由）
      console.warn(
        `[StateManager] tile_building_add 落位失败（${result.reason}）：${ctx.tile.name}·${name}`,
      );
      return this.createEvent('system', patch);
    }
    await this.writeTileFacts(ctx, result.entry);
    return this.createEvent('system', patch);
  }

  /**
   * tile_building_update —— 改建筑归属/描述/收益（玩家取得产业走这条）。
   *
   * 🔴 补丁里**没提的格保持原值**（`undefined` ≠ 清空，见 `applyBuildingUpdate` 的注释），
   *    所以这里只把 AI 真写了的键塞进补丁 —— 一律照抄会把没提的字段全清成 undefined。
   * `playerOwned` 由非真翻成 `true` 时由纯函数记 `acquired` 编年史（裁定 §8-14 第六类），
   * `reason` 原样落进那一条。
   *
   * 🔴 **`value.main === true` 走主建筑分支**（裁定 §8-19）：主建筑的名字随发展档漂移，
   *    按名字寻址一定会在升降档之后失配，所以它**只能**这么寻址 —— 那条分支里
   *    `value.name` 不是寻址键而是**改名**。
   */
  private async applyTileBuildingUpdate(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    if (v.main === true) return this.applyTileMainBuildingUpdate(patch, v, ctx);

    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (name.length === 0) {
      console.warn('[StateManager] tile_building_update 缺少 value.name，忽略');
      return this.createEvent('system', patch);
    }

    const buildingPatch: BuildingPatch = {};
    if (typeof v.description === 'string') buildingPatch.description = v.description;
    if (typeof v.ownerFlavor === 'string') buildingPatch.ownerFlavor = v.ownerFlavor;
    if (typeof v.playerOwned === 'boolean') buildingPatch.playerOwned = v.playerOwned;
    const income = coerceBuildingIncome(v.income, ctx.day, existingBuildingIncome(ctx.entry, name));
    if (income !== undefined) buildingPatch.income = income;

    const reason = typeof v.reason === 'string' ? v.reason : undefined;
    const next = updateBuildingRecord(
      ctx.entry,
      name,
      buildingPatch,
      ctx.day,
      reason ? { reason } : {},
    );
    if (next === null) {
      console.warn(
        `[StateManager] tile_building_update 找不到建筑「${name}」（${ctx.tile.name}），忽略`,
      );
      return this.createEvent('system', patch);
    }
    await this.writeTileFacts(ctx, next);
    return this.createEvent('system', patch);
  }

  /**
   * tile_building_update 的**主建筑**分支（`value.main === true`，裁定 §8-17~19）。
   *
   * 与槽位分支的三处差别，每一处都是设计裁定而不是实现细节:
   *   ① **不按名字寻址** —— 主建筑随档漂移的通名不是稳定键，`main: true` 就是地址；
   *      这里的 `value.name` 因此是**改名**（合法，记 `renamed` 编年史）。
   *   ② **找不到是不可能的** —— 每个可通行陆块恒有一座；纯函数返回 `null` 只有两种成因：
   *      这块地没有发展度（海/湖/不可通行），或者补丁一格都没提。两者都 warn + no-op。
   *   ③ 派生通名表要交下去（`mainBuildingNames`）：事实里还没有名字时，本次 update
   *      会把当前档的通名**钉住**，钉的就是那张表里的那一行。
   */
  private async applyTileMainBuildingUpdate(
    patch: StatePatch,
    v: Record<string, unknown>,
    ctx: TileFactsContext,
  ): Promise<GameEvent> {
    const mainPatch: MainBuildingPatch = {};
    const renamed = typeof v.name === 'string' ? v.name.trim() : '';
    if (renamed.length > 0) mainPatch.name = renamed;
    if (typeof v.description === 'string') mainPatch.description = v.description;
    if (typeof v.ownerFlavor === 'string') mainPatch.ownerFlavor = v.ownerFlavor;
    if (typeof v.playerOwned === 'boolean') mainPatch.playerOwned = v.playerOwned;
    // 周期与锚同槽位建筑：铁律3，AI 只填金额；已有收益时沿用旧锚（复述不重锚）
    const income = coerceBuildingIncome(v.income, ctx.day, ctx.entry.mainBuilding?.income);
    if (income !== undefined) mainPatch.income = income;

    const reason = typeof v.reason === 'string' ? v.reason : undefined;
    const next = updateMainBuildingRecord(ctx.entry, ctx.tile, mainPatch, ctx.day, {
      ...(reason ? { reason } : {}),
      mainBuildingNames: getMapPack().mainBuildingNames ?? [],
    });
    if (next === null) {
      console.warn(
        `[StateManager] tile_building_update(main) 无变化（无发展度的地块，或补丁一格都没提）：${ctx.tile.name}`,
      );
      return this.createEvent('system', patch);
    }
    await this.writeTileFacts(ctx, next);
    return this.createEvent('system', patch);
  }

  /**
   * tile_dev_progress_add —— 一次性发展度进度 ±N（裁定 §8-5 两种推动者之一）。
   *
   * 升降档、钳位与严格槽位摧毁全在纯函数里发生（含随之产生的编年史条目）；
   * 本层只负责把 `reason` 传下去与落库。无发展度的地块（海/湖/不可通行）恒无变化。
   */
  private async applyTileDevProgressAdd(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    const amount = Number(v.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      console.warn('[StateManager] tile_dev_progress_add 的 value.amount 不是非零数字，忽略');
      return this.createEvent('system', patch);
    }

    const reason = typeof v.reason === 'string' ? v.reason : undefined;
    const result = addDevProgress(ctx.entry, ctx.tile, amount, ctx.day, reason ? { reason } : {});
    if (result === null) return this.createEvent('system', patch);
    await this.writeTileFacts(ctx, result.entry);
    return this.createEvent('system', patch);
  }

  /** tile_history_note —— AI 事后追加一条自由文本编年史（裁定 §8-15③；自动条目只加不改） */
  private async applyTileHistoryNote(patch: StatePatch): Promise<GameEvent> {
    const v = (patch.value ?? {}) as Record<string, unknown>;
    const ctx = await this.openTileFacts(v.tile, patch.op);
    if (ctx === null) return this.createEvent('system', patch);

    const text = typeof v.text === 'string' ? v.text.trim() : '';
    if (text.length === 0) {
      console.warn('[StateManager] tile_history_note 缺少 value.text，忽略');
      return this.createEvent('system', patch);
    }

    await this.writeTileFacts(
      ctx,
      recordTileHistory(ctx.entry, { day: ctx.day, kind: 'note', text }),
    );
    return this.createEvent('system', patch);
  }

  /**
   * 首访记档（§F5 五类自动事件之一）—— `applySetLocation` 落位之后旁观记录。
   *
   * 🔴 **只跟踪玩家**（口径同 `syncMapLocation`：这条钩子只从 `applySetLocation` 来，
   *    而那边已经 player only —— 这里再判一次是因为本方法自己也得读得懂自己）。
   * 🔴 **记的是「玩家现在站在哪块地」**，所以读的是刚落位完的 `worldFlags.map.lastTileId`
   *    而不是重新解析一次位置路径：重新解析等于给落位契约开第二个实现，两者漂移时
   *    编年史会指着一块玩家从没去过的地。
   * 🔴 `recordFirstVisit` 幂等（已有首访条目返回 `null`），所以来回走同一块地只记一次。
   */
  private async syncTileFirstVisit(char: CharacterState): Promise<void> {
    if (char.type !== 'player') return;

    const pack = getMapPack();
    if (isEmptyMapPack(pack)) return;

    try {
      // 同 `syncMapLocation`：只从 `applySetLocation` 来，永远在提交作用域内
      const profile = await this.readProfile();
      const tileId = getMapFlags(profile).lastTileId;
      if (tileId === undefined) return; // 还没落过位 → 没有「到访了哪块地」这回事
      const tile = getMapIndex().tileById.get(tileId);
      if (tile === undefined) return; // 悬空块号（换包途中）→ 不记，下次落位自会补上

      const facts = getMapFactsFlags(profile);
      const day = this.gameDayOf(profile);
      const entry = facts.tiles[tile.name] ?? seedTileFacts(tile, day);
      const next = recordFirstVisit(entry, day);
      if (next === null) return; // 已经记过首访 → 一个字节都不写（连播种都不落）

      setMapFactsInPlace(profile, { ...facts, tiles: { ...facts.tiles, [tile.name]: next } });
      await this.persistProfile(profile);
    } catch (err) {
      // 位置路径与地块投影都已落库；编年史少一条不该让正文提交失败
      console.warn('[StateManager] 地块首访记档失败（位置已落库，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 地块首访记档失败（位置已落库，不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 按期结算钩子（§4 时间账本）—— `applyTimeAdvance` 推进完时间后调用，**在锁内**。
   *
   * 三件事，缺一不可:
   *   ① 纯函数结算 `(prevDay, nextDay]` 区间（到期 / 周期效果 / 收益），整份覆盖回事实袋子；
   *   ② `incomeDue` → **持久借据**（`worldFlags.mapIncome`）—— 与事实态同一份 profile、
   *      同一次落库（🔴 拆开就是 F08 病灶：窗口先推进、该给的钱后记账，记账失败即永久丢账）。
   *      钱由锁外 `settlePendingMapIncome()` 以「给钱 + 标记 applied 同事务」原子消费。
   *      这里绝不自己调 `commitChatState`：锁内嵌套提交 = 同 saveId 自等死锁（铁律②）。
   *   ③ 结构化事件 → 中文新闻（措辞在本接线层，`map-dynamics` 零中文字面量的原因）。
   *
   * 🔴 **休眠地块整块冻结**（§3）：`resolveTile` 认不出的名字返回 `undefined`，纯函数据此跳过。
   *    换包再换回来时那座玩家酒馆不会一次性补上几十期收益。
   */
  private async syncMapFactsSettlement(profile: SaveProfile, prevDay: number): Promise<void> {
    try {
      const facts = getMapFactsFlags(profile);
      if (Object.keys(facts.tiles).length === 0) return; // 还没有任何一块地偏离基线 → 零开销

      const nextDay = this.gameDayOf(profile);
      const index = getMapIndex();
      const resolveTile = (name: string): MapTile | undefined => {
        const id = findTileByName(index, name);
        return id === null ? undefined : index.tileById.get(id);
      };

      const settled = settleMapFacts(facts, resolveTile, prevDay, nextDay);
      if (settled === null) return;

      // ── 记收（F08）：事实与应得收益**同一次落库**，收益不再走锁外补丁 ──
      // 旧实现：事实先进 `updateMapFactsFlags` 落库（结算窗口推进），收益只往 `patches[]`
      // 塞 delta 等锁外自提交 —— 自提交失败 = 窗口已推进、收益永久蒸发（时间账本零簿记，
      // 没有游标可重放；known-issue「两条收益丢账」第 2 条，本文件「🧾 收益记收账本」节）。
      // 现在把每一笔收益折叠成**持久借据**，与事实态同一份 profile、同一次落库；
      // 钱由锁外 `settlePendingMapIncome()` 以「给钱 + 标记 applied」同事务原子消费。
      const incomeEvents = settled.events.filter((e) => e.event.kind === 'incomeDue');
      if (incomeEvents.length > 0) {
        const player = (await this.readCharacters()).find((c) => c.type === 'player');
        if (player === undefined) {
          // 存档病态（没有玩家角色）：收益没有入账对象。**不记借据**（与旧实现一致），
          // 但这次起明确告警而不是静默丢账。
          console.warn(
            '[StateManager] 地块结算产出收益但存档没有玩家角色，本次收益未入账（也不会补记）',
          );
          await updateMapFactsFlags(profile, settled.facts);
        } else {
          const nextIncome: MapIncomeFlags = {
            pending: mergeMapIncomePending(getMapIncomeFlags(profile).pending, incomeEvents, {
              recipient: player.name,
              fromDay: prevDay,
              toDay: nextDay,
            }),
          };
          // 🔴 同一次 `persistProfile` 落库：窗口推进与「该给的钱」同生共死 —— 写失败时
          //    两者都不落，下一次结算会从旧窗口重算，不会丢账。先落事实、后落借据就是
          //    病灶本身，**任何时候都不要拆开**。
          setMapFactsInPlace(profile, settled.facts);
          setMapIncomeInPlace(profile, nextIncome);
          await this.persistProfile(profile);
        }
      } else {
        await updateMapFactsFlags(profile, settled.facts);
      }

      // ── 系统提示：每块地一条新闻（一次结算里同一块地的多条变化并成一条，别刷屏） ──
      for (const [tileName, lines] of groupSettlementNews(settled.events)) {
        await addNews(profile, {
          title: `地图 · ${tileName}`,
          content: lines.join('\n'),
          category: MAP_NEWS_CATEGORY,
        });
      }
    } catch (err) {
      // 时间已经推进、正文状态已经落库；结算算不出来只是这一次没有到期与入账
      console.warn('[StateManager] 地块按期结算失败（时间已推进，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 地块按期结算失败（时间已推进，不影响正文）: ${String(err)}`,
      );
    }
  }

  // ========== 辅助 ==========

  private createEvent(type: GameEvent['type'], patch: StatePatch): GameEvent {
    return {
      id: crypto.randomUUID(),
      type,
      source: 'system',
      timestamp: Date.now(),
      data: { op: patch.op, target: patch.target, value: patch.value, amount: patch.amount },
      processed: true,
    };
  }

  // ========== 快照 (M5 规范 §11.2: 打快照 = 整份深拷贝) ==========

  /**
   * 打快照 — characters + saveProfile 整份深拷贝落 snapshots 表
   *
   * - 变量/任务/时间/好感随 saveProfile 深拷贝随行（不再单独寄生存 variables，杀 #2 双轨）
   * - save.activeSnapshotId 指向新快照
   * - 超上限滚动删除最旧（上限读 settings.maxSnapshotsPerSave，缺省 30 — 杀 #28 私藏常量）
   *
   * @param reason 触发原因: turn=每轮一拍 / manual=手动 / pre-combat=战斗前
   * @param turn   对话回合游标（恢复时截断 messages 用）
   */
  async createSnapshot(
    reason: Snapshot['reason'],
    turn: number,
    isCurrent?: () => boolean,
  ): Promise<Snapshot> {
    // 🔴 并行化改造：快照 = 读全表 + 写快照行 + 改 activeSnapshotId + trim 的整段
    // RMW 区段，整段互斥（与提交 / advanceTurn 交错会留下「快照与状态不一致」）。
    // 内部只调裸 DB 函数，无嵌套入队（铁律②）。
    return withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(isCurrent);
      const characters = await getCharacters(this.saveId);
      const profile = await getProfile(this.saveId);
      const plotEvents = await getPlotEvents(this.saveId);
      // 🆕 消息随快照走：恢复时整体覆写 messages，快照才能**向前**恢复
      // （旧实现只截断：恢复到第 N 回合后，N 之后的对话永远找不回来）。
      const messages = await getMessages(this.saveId);

      // 🔴 这里**没有** structuredClone，是刻意的（2026-08-17 快照拆表顺带）：
      //    上面四个 getter 都是裸 Dexie 读（快照路径刻意不走提交作用域的缓存），
      //    IndexedDB 每次读出来的都是新反序列化的对象，与库里、与别处**天然无共享**；
      //    落库那一步 Dexie 的 put 自己还会再结构化克隆一次。于是这四次克隆是纯开销 ——
      //    而它克隆的正是整档对话历史，每回合一次。
      const snapshot: Snapshot = {
        id: crypto.randomUUID(),
        saveId: this.saveId,
        createdAt: Date.now(),
        reason,
        turn,
        characters,
        characterChronicle: await getDatabase()
          .characterChronicle.where('saveId')
          .equals(this.saveId)
          .toArray(),
        saveProfile: profile,
        plotEvents,
        messages,
      };

      await saveSnapshot(snapshot);

      // activeSnapshotId 指向最新快照
      const save = await getSave(this.saveId);
      if (save) {
        save.activeSnapshotId = snapshot.id;
        await saveSaveSlot(save);
      }

      // 滚动上限 + 保留模式。Q-06：此前读 Dexie `settings` 表 —— 那是一份由
      // initializeDatabase 播种、之后只被 game-pipeline 搬过两个字段的影子配置，
      // 桥一断用户就永远拿不到自己选的上限。现在走 engine-settings 注入缝。
      const { maxSnapshotsPerSave, snapshotRetentionMode } = getEngineSettings();
      await trimSnapshots(this.saveId, maxSnapshotsPerSave, snapshotRetentionMode);

      logEngine(
        'info',
        'state.snapshot',
        `打快照：${reason} / 回合 ${turn}`,
        () => ({
          snapshotId: snapshot.id,
          reason,
          turn,
          characterCount: characters.length,
          messageCount: messages.length,
          plotEventCount: plotEvents.length,
        }),
        { saveId: this.saveId },
      );

      return snapshot;
    });
  }

  /**
   * 🆕 自动存档（2026-10-05）：把**当前活表状态**覆写进「本轮那张 turn 快照」。
   *
   * 动机：`turn` 快照是在一轮跑完那一刻拍的；之后玩家做的手动改动（正文润色 / 重铸 /
   * 其它手动编辑）只落在活表，**不进快照** —— 回档到本轮就把它们丢了。本方法把这些
   * 改动吸进**本轮**快照，使「本轮快照」始终 = 本轮结束 + 之后的全部手动改动；
   * 下一轮 `advanceTurn` 拍出新快照后，本轮这张自然冻结不再被覆写。
   *
   * 🔴 只覆写**载荷 + preview**（`saveSnapshot` 会按新载荷重算 preview）；`id / createdAt /
   *    turn / reason` 一律不动 —— 保持它在时间轴上的身份与排序。
   * 🔴 目标 = 最新一张 `reason==='turn'` 的快照；找不到（刚恢复完还没拍）→ no-op。
   * 🔴 整段进 `withSaveWriteLock`，与提交 / 其它快照操作串行（避免读到写一半的状态）。
   */
  async amendCurrentTurnSnapshot(): Promise<void> {
    await withSaveWriteLock(this.saveId, async () => {
      const meta = await getLatestTurnSnapshotMeta(this.saveId);
      if (!meta) return;
      const characters = await getCharacters(this.saveId);
      const profile = await getProfile(this.saveId);
      const plotEvents = await getPlotEvents(this.saveId);
      const messages = await getMessages(this.saveId);
      await saveSnapshot({
        id: meta.id,
        saveId: this.saveId,
        createdAt: meta.createdAt,
        reason: meta.reason,
        turn: meta.turn,
        characters,
        characterChronicle: await getDatabase()
          .characterChronicle.where('saveId')
          .equals(this.saveId)
          .toArray(),
        saveProfile: profile,
        plotEvents,
        messages,
      });
    });
  }

  /**
   * 回合推进 — GamePipeline 每轮管线成功后调用 (M5 Task 4, 杀 #27)
   *
   * totalTurns 语义 = 已完成的对话回合数（每轮管线恰 +1，不再随每次 commit 虚高），
   * 随后打一张 reason='turn' 的回合快照（turn = 新回合数，恢复时按此截断消息）。
   */
  async advanceTurn(isCurrent?: () => boolean): Promise<void> {
    let newTotalTurns = 1;
    // 🔴 并行化改造：totalTurns 读-改-写是一段 RMW 区段，整段互斥（与 commitChatState
    // 尾部的 saveSaveSlot 争同一条 save 记录，交错会互相覆盖 totalTurns）。
    // createSnapshot 自带锁（它也被战斗 pre-combat 直接调用），必须在锁外调用，
    // 否则同 saveId 嵌套自等死锁（state-write-queue 铁律②）。
    await withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(isCurrent);
      const save = await getSave(this.saveId);
      if (save) {
        newTotalTurns = (save.metadata.totalTurns ?? 0) + 1;
        save.metadata.totalTurns = newTotalTurns;
        await saveSaveSlot(save);
      }
    });
    await this.createSnapshot('turn', newTotalTurns, isCurrent);
  }

  /**
   * 恢复快照 — 整体覆写 + 对话回滚 (M5 规范 §11.2, #2 恢复死路径根治)
   *
   * ① 按 id 读快照（v22 拆表后 `getSnapshot` 负责 join 载荷行；载荷缺失它直接抛，
   *    半份快照恢复出去会把存档洗空）+ saveId 校验（防跨档恢复）
   * ② characters: 当前存档全删后重写快照副本（整体覆写语义 — 快照后新增的角色一并消失）
   * ③ saveProfile 覆写（任务/时间/好感/变量随行回滚）
   * ③.b plotEvents 覆写（🆕 剧情事件随快照回滚；旧快照无此字段→清空）
   * ④ deleteMessagesAfterTurn(saveId, snapshot.turn) — 对话截断回滚 (#49 复合索引启用)
   * ④.b 清理"未来"记忆 realTimestamp > snapshot.createdAt（🆕 记忆 append-only，按时间清理安全）
   * ⑤ save.activeSnapshotId 指向该快照 + totalTurns 对齐快照 turn 游标（防重发后 turn 编号错位）
   * ⑥ 任何失败进 errors[]（返回 StateCommitResult，与 commitChatState 口径一致）
   */
  async restoreSnapshot(snapshotId: string): Promise<StateCommitResult> {
    const errors: string[] = [];
    try {
      // 🔴 并行化改造：快照恢复是 7 表大事务，整段互斥（与提交/侧链落库交错会留下
      // 不一致状态 —— 恢复写到一半，并发 commit 又把部分表改回去）。UI 已由
      // isGenerating 挡住管线运行中的恢复，这层锁是兜底（铁律②：内部无嵌套入队）。
      await withSaveWriteLock(this.saveId, async () => {
        // ① 读快照 + 防跨档校验
        const snapshot = await getSnapshot(snapshotId);
        if (!snapshot) throw new Error(`快照不存在: ${snapshotId}`);
        if (snapshot.saveId !== this.saveId) {
          throw new Error(`快照不属于当前存档: ${snapshot.saveId}（当前 ${this.saveId}）`);
        }

        // 🔒 P1-06: 单事务覆盖所有被修改的表 —— 快照恢复此前是顺序多步独立 DB 操作，
        // 后段失败会留下部分恢复状态（如角色已覆写但对话/记忆未回滚）。包进单事务后任一步
        // 抛错 Dexie 自动回滚全表，恢复要么完整成功要么完全不动。
        const db = getDatabase();
        await db.transaction(
          'rw',
          [
            db.characters,
            db.characterChronicle,
            db.saveProfiles,
            db.plotEvents,
            db.messages,
            db.memories,
            db.saves,
            db.snapshots,
            // v22 拆表：④.c 的 deleteSnapshotsAfter 要连载荷行一起删，表清单必须带上它
            db.snapshotPayloads,
            // v27/v28：④.d 按恢复后的消息集合清理 Story v2 摘要与阶段归档
            db.storyTurnSummaries,
            db.storyArchives,
            db.storyArchiveRetries,
          ],
          async () => {
            // ② characters 整体覆写: 全删 → 写入快照副本
            //    structuredClone 防库内对象与快照对象引用共享（快照需保持不可变，可重复恢复）
            const current = await getCharacters(this.saveId);
            for (const c of current) {
              await deleteCharacter(c.id);
            }
            await saveCharacters(structuredClone(snapshot.characters));
            await db.characterChronicle.where('saveId').equals(this.saveId).delete();
            if (snapshot.characterChronicle?.length)
              await db.characterChronicle.bulkPut(structuredClone(snapshot.characterChronicle));

            // ③ saveProfile 覆写（变量/任务/时间/好感随行回滚）
            await updateProfile(structuredClone(snapshot.saveProfile));

            // ③.b plotEvents 覆写：全删 → 写入快照副本（旧快照无 plotEvents → 写空数组=清空）
            const currentEvents = await getPlotEvents(this.saveId);
            for (const e of currentEvents) {
              await deletePlotEvent(e.id);
            }
            await savePlotEvents(structuredClone(snapshot.plotEvents ?? []));

            // ④ 对话恢复：快照带 messages（新快照）→ 整档覆写（截断 + 找回两向都成立）；
            //    旧快照无 messages → 退化为按 turn 截断（旧行为，只能回退不能找回）。
            if (snapshot.messages) {
              await deleteMessagesBySaveId(this.saveId);
              await saveMessages(structuredClone(snapshot.messages));
            } else {
              await deleteMessagesAfterTurn(this.saveId, snapshot.turn);
            }

            // ④.b 清理"未来"记忆（realTimestamp > 快照创建时间；记忆 append-only 安全）
            await deleteMemoriesAfter(this.saveId, snapshot.createdAt);

            // ④.c 🆕 清理"未来"快照（createdAt > 恢复点）：被抛弃的分支（如同轮重发
            //     产生的第二张快照）此前从不清理，恢复后 append 新快照会让同一 turn
            //     出现多条、后续回退 filter(turn<=target) 取错。恢复点之后创建的快照
            //     全是该时间线之后的产物，删除安全。
            await deleteSnapshotsAfter(this.saveId, snapshot.createdAt);

            // ④.d 🆕 Story v2 摘要与阶段归档：来源消息不在恢复后分支里的记录删掉（计划 §11.4）。
            //     判据是**消息 id**，不是时间戳 —— 同回合重生成的正文时间相近而 id 不同。
            //     归档一删，第 2 区退回上一有效节点、被覆盖的摘要恢复未归档语义（D23）。
            //     普通存档这两张表没有行，这一步是空操作。
            await pruneOrphanStoryContextRecords(this.saveId);

            // ⑤ activeSnapshotId 指向 + totalTurns 对齐快照 turn（防重发后 turn 编号错位）
            const save = await getSave(this.saveId);
            if (save) {
              save.activeSnapshotId = snapshot.id;
              save.metadata.totalTurns = snapshot.turn;
              await saveSaveSlot(save);
            }
          },
        );
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    logEngine(
      errors.length === 0 ? 'info' : 'error',
      'state.restore',
      errors.length === 0 ? `恢复快照 ${snapshotId}` : `恢复快照失败 ${snapshotId}`,
      () => ({ snapshotId, errors }),
      { saveId: this.saveId },
    );

    return {
      success: errors.length === 0,
      patchesApplied: 0,
      eventsGenerated: [],
      errors,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // 🗺 地图接线（地图系统 v1 / 设计 §5 接线表）
  // ═══════════════════════════════════════════════════════════
  //
  // 三条钩子（落位 / 天气断言 / 在途旗）都长同一个样子:
  //   ① 空包 → 整段 no-op（地图是**可选**子系统，没装包时游戏一个字节都不受影响）
  //   ② 读 profile → `ensureMapFlags` 自愈 → 纯函数算出下一份 flags
  //   ③ 有变化才经命名写入口 `updateMapFlags` 落库 —— **落位那一条例外**：它跑在
  //      `commitChatState` 的提交作用域里，改的是缓存那份 profile（`setMapFlagsInPlace` +
  //      打脏标记），整份 profile 由提交出口落一次。语义（整份覆盖）与落库时机（本次提交内）
  //      都没变，变的只是「一次提交里落几次库」
  //   ④ 整段包在 try/catch 里：地图是**派生**投影，投影失败绝不能让正文状态提交失败
  //      （§8.2-5「解析失败 → 保持原值，位置路径原文保留」的同一个精神）
  //
  // 🔴 为什么策略（自愈/落位/天气/在途）写在这里而不在 `map-*.ts`:
  //    那五个模块是**纯函数叶**且受结构闸门约束（零中文字面量）；而这三条策略要碰
  //    `variables.sys.天气` / `variables.sys.旅行目的地` 这两个中文变量路径，还要碰 profile 与
  //    Dexie。它们属于**接线层**，接线层就是这里（ADR-21：状态变更只从 StateManager 出去）。

  /**
   * 取本存档的地图派生态，顺手做**换包自愈**（§3.4-2）。
   *
   * 判据是 `packStamp !== pack.contentHash`（**内容哈希，不是语义版本** —— 理由写在
   * `MapSaveFlags.packStamp` 上）。不符时:
   *   · 派生态整份清掉（`lastTileId` / `journey` / `weatherStamp` / 不连通标记全是旧地图的说法）
   *   · **立刻**按玩家当前位置路径重落位一次，不等下一次移动 —— 否则棋子会在地图上消失
   *     整整一段游玩（那正是「投影可自愈」这条红利要兑现的地方）
   *
   * `healed` 供调用方判断「即便这一次没有别的变化，也得落一次库」。
   */
  private async ensureMapFlags(
    profile: SaveProfile,
    pack: MapPack,
  ): Promise<{ flags: MapSaveFlags; healed: boolean }> {
    const current = getMapFlags(profile);
    if (current.packStamp === pack.contentHash) return { flags: current, healed: false };

    const healed: MapSaveFlags = { packStamp: pack.contentHash };
    // 读侧走缓存口：落位钩子跑在提交作用域内（`applySetLocation`），这里必须看得到**本次刚写完**
    // 的 `location`；天气钩子跑在作用域外（`applyTimeAdvance` 自己的锁段），那时它退化成直读
    const player = (await this.readCharacters()).find((c) => c.type === 'player');
    if (!player) return { flags: healed, healed: true };

    // currentTileId 传 null：旧包的块号在新包里没有意义（`resolveTileByLocation` 会把
    // 「当前块不明」当作域外，于是路径只写到国家粗度时落锚地块 —— 正是自愈想要的）
    const tileId = resolveTileByLocation(getMapIndex(), player.location, null);
    return { flags: tileId === null ? healed : { ...healed, lastTileId: tileId }, healed: true };
  }

  /**
   * 落位钩子（§8.2）—— `applySetLocation` 写完 `location` 之后调用。
   *
   * 🔴 **只跟踪玩家**（裁定 §12-3 "player only throughout"）：NPC 的 `set_location` 在这里
   *    一个字节都不写。NPC 的地块是按需纯函数查询，不留历史 —— 留了就要维护它的自愈、
   *    它的快照回滚、它的换包清理，而没有任何消费方要它。
   */
  private async syncMapLocation(char: CharacterState): Promise<void> {
    if (char.type !== 'player') return;

    const pack = getMapPack();
    if (isEmptyMapPack(pack)) return;

    try {
      // 本钩子**只从 `applySetLocation` 来**，即永远在提交作用域内：读走缓存、写只打脏标记，
      // 整份 profile 由提交出口落一次（`updateMapFlags` 那条「整份覆盖」的语义一字未变）
      const profile = await this.readProfile();
      const { flags, healed } = await this.ensureMapFlags(profile, pack);
      const projected = projectLocationFlags(getMapIndex(), flags, char.location);
      if (projected === null && !healed) return; // 落位失败且无需自愈 → 一个字节都不动
      setMapFlagsInPlace(profile, projected ?? flags);
      await this.persistProfile(profile);
    } catch (err) {
      // 位置路径已经落库了（真源没丢），投影失败只让棋子暂时不动
      console.warn('[StateManager] 地图落位失败（位置路径已落库，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 地图落位失败（位置路径已落库，不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 天气断言钩子（§7 / 裁定 §12-6）—— `applyTimeAdvance` 推进完时间后调用。
   *
   * **Code 兜底 + AI 覆盖**：跨天或换气候区时引擎往 `variables.sys.天气` 写一个**标签串**
   * （不是结构体），AI 仍可经既有写路径覆盖它（叙事性天气：血月、法术风暴），下一次跨天
   * 引擎重断言、覆盖自然过期。
   *
   * 🔴 同日同区**绝不重写**：那正是 AI 覆盖能在一天之内活下来的原因。判据是
   *    `weatherStamp`，比的是 `{day, zoneId}` 两格 —— 少比一格（比如只看 day）的症状是
   *    跨区移动不换天气，或者同一天里 AI 的血月被引擎抹掉。
   * 🔴 `weatherAt` 返回 `null`（包里没有一张可用天气表）时**只更新戳、不动 `sys.天气`**：
   *    保持原值与落位失败保 `lastTileId` 同款处置（`map-weather.ts` 文件头），
   *    绝不凭空造一个不在包词汇里的标签串。
   */
  private async syncMapWeather(profile: SaveProfile): Promise<void> {
    const pack = getMapPack();
    if (isEmptyMapPack(pack)) return;

    try {
      const { flags, healed } = await this.ensureMapFlags(profile, pack);
      const gameDay = Math.floor(toEpochMinutes(profile.gameTime) / MINUTES_PER_GAME_DAY);
      const asserted = assertWeatherFlags(
        pack,
        flags,
        // 季节键由调用方从 `getSeason()` 取来原样传进去：历法是内容，`map-weather` 不认识季节
        getSeason(profile.gameTime.month),
        gameDay,
        this.saveId,
      );

      if (asserted === null) {
        if (healed) await updateMapFlags(profile, flags);
        return;
      }

      // 先就地改 variables，再经命名写入口落库 —— `updateMapFlags` 落的是整份 profile，
      // 所以天气标签与它的戳**不可能只落一半**（半落的表现是下一次跨天不再断言）
      if (asserted.label !== null) {
        profile.variables = setVar(profile.variables ?? {}, WEATHER_VAR_PATH, asserted.label);
      }
      await updateMapFlags(profile, asserted.flags);
    } catch (err) {
      console.warn('[StateManager] 天气断言失败（时间已推进，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 天气断言失败（时间已推进，不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 在途旗胶水（§8.2 / 裁定 §12-8）—— 由 orchestrator 的 dispatcher 分支在
   * `commitPatches` + `advanceTime` 之后调用。
   *
   * 读 `variables.sys.旅行目的地`（dispatcher 写的**普通变量**，v1 不加新标记不加新 op）:
   *   · 有值且落位成功、且不是当前块 → 设/更新 `journey`（含 `findPath` 计划路线与到达估算）
   *   · 空值 / 已在目的地 → 清旗
   *   · 落位失败 → **什么都不做**（不设旗、不报错）—— 无害，下一回合 AI 可能写个认得出的名字
   *
   * 🔴 是**数据不是状态机**（§1 非目标）：新计划整份覆盖、到达即清，没有 leg / checkpoint /
   *    事件调度。每回合重算一次 `arriveAtMinute` 是特性 —— 叙事偏离计划路线时按新位置重估
   *    剩余天数（`plannedPath` 是 advisory，绝不 enforcement）。
   */
  async syncMapJourney(): Promise<void> {
    const pack = getMapPack();
    if (isEmptyMapPack(pack)) return;

    try {
      // 🔴 并行化改造：在途旗的读-改-写（getProfile → 纯函数 → updateMapFlags）
      // 是同一段 RMW 区段，整段互斥（与提交/时间推进争同一条 SaveProfile 记录）。
      await withSaveWriteLock(this.saveId, async () => {
        const profile = await getProfile(this.saveId);
        const { flags, healed } = await this.ensureMapFlags(profile, pack);
        const planned = planJourneyFlags(
          pack,
          getMapIndex(),
          flags,
          readTravelDestination(profile.variables),
          toEpochMinutes(profile.gameTime),
        );
        if (planned === null && !healed) return;
        await updateMapFlags(profile, planned ?? flags);
      });
    } catch (err) {
      console.warn('[StateManager] 在途旗同步失败（不影响正文与已落库状态）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 在途旗同步失败（不影响正文与已落库状态）: ${String(err)}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🎲 随机事件接线（随机事件系统 v1 / 设计 §4·§5.2）
  // ═══════════════════════════════════════════════════════════
  //
  // 三条钩子（MTTH 掷骰 / 首访强制 / 每回合保洁）长的是与地图那三条**同一个样子**:
  //   ① 关闭 or 空包 → 整段 no-op（随机事件是**可选**子系统；关掉时 flags 保留不清，§6）
  //   ② 读 profile → 组装只读上下文快照 → 纯函数算出下一份 flags
  //   ③ 有变化才经命名写入口 `updateRandomEventFlags` 落库（纯函数「无变化返回 null」的用途）
  //      —— **首访那一条例外**：同地图落位钩子，它在提交作用域内改缓存（`setRandomEventFlagsInPlace`
  //      + 打脏标记），由提交出口统一落库
  //   ④ 整段包在 try/catch 里：候选池是**旁路**账本，它失败绝不能让正文状态提交失败
  //
  // 🔴 为什么上下文组装在这里而不在 `random-event-scheduler.ts`:
  //    那个模块是**纯函数叶**且受结构闸门约束（零中文字面量 / 零随机 / 零时钟）；而组装要碰
  //    profile、Dexie 里的角色行、地图落位结果与中文任务状态串。它属于**接线层**，
  //    接线层就是这里（理由同 `projectLocationFlags`，ADR-21）。

  /** 本存档当前是第几个游戏日（`applyTimeAdvance` 与三条钩子共用同一个口径） */
  private gameDayOf(profile: SaveProfile): number {
    return Math.floor(toEpochMinutes(profile.gameTime) / MINUTES_PER_GAME_DAY);
  }

  /**
   * 条件求值的只读快照 —— 组装整份委托给 `random-event-snapshot`（**全仓唯一一份**）。
   *
   * 本层只负责把**角色行**查出来（写侧走 Dexie，读侧 game-pipeline 走 store 里那份，
   * 两条取角色的路本来就不同）；判据本身一个字都不许在这里重写：此前这两个函数在这里与
   * game-pipeline 各有一份逐字拷贝，靠注释维持同步，漂了不报错（见那个模块的文件头）。
   */
  private async buildRandomEventContext(profile: SaveProfile): Promise<RandomEventRollContext> {
    // 读侧走缓存口（理由同 `ensureMapFlags`）：首访钩子在提交作用域内，另外四条在作用域外
    const player = (await this.readCharacters()).find((c) => c.type === 'player');
    return buildRandomEventRollContext(profile, player);
  }

  /**
   * MTTH 掷骰钩子（§4.1）—— `applyTimeAdvance` 推进完时间、天气重断言之后调用。
   *
   * **必须在时间推进之后**（同天气那条理由）：逐天走的区间是 `(lastRollDay, 当前日]`，
   * 拿旧时间去走就等于永远差一天。
   *
   * 掷骰之后**顺手保洁一次**：这一次时间推进本身就可能让池里的条目过期（TTL 是按天算的），
   * 而保洁与掷骰共用同一份上下文 —— 分成两次调用要各组装一遍快照，还会多一次落库。
   */
  private async syncRandomEvents(profile: SaveProfile): Promise<void> {
    const settings = getEngineSettings();
    const pack = getRandomEventPack();
    if (isEmptyRandomEventPack(pack)) return;
    if (!settings.randomEventsEnabled) {
      await this.skipRandomEventDays(profile);
      return;
    }

    try {
      const ctx = await this.buildRandomEventContext(profile);
      const currentDay = this.gameDayOf(profile);
      const current = getRandomEventFlags(profile);

      const rolled = rollRandomEvents(pack.defs, pack.config, current, ctx, {
        saveSeed: this.saveId,
        currentDay,
        frequency: settings.randomEventsFrequency,
      });
      const pruned = pruneRandomEvents(pack.defs, pack.config, rolled ?? current, ctx, currentDay);

      // 两个纯函数都可能说「无变化」；只要有一个说了变化就落一次库（`pruned` 更新，优先它）
      const next = pruned ?? rolled;
      if (next === null) return;
      await updateRandomEventFlags(profile, next);
    } catch (err) {
      // 时间已经推进、正文状态已经落库；候选池算不出来只是这一回合没有新事件
      console.warn('[StateManager] 随机事件调度失败（时间已推进，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件调度失败（时间已推进，不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 关闭期间的天数**按「跳过」处理，不补掷**（2026-08-16 审查修复）。
   *
   * 🔴 缺了它就是一次**倒灌**：关掉系统时掷骰整段 no-op，`lastRollDay` 停在关掉那天；
   *    玩家关着系统过了 200 天再打开，下一次掷骰会把这 200 天**一次走完**，候选池当场塞满。
   *    与「首次 ensure 不补历史」是同一条取舍（§4.1）：没在跑的日子不该欠着。
   * 🔴 **只在已经掷过骰的存档上盖戳**（`lastRollDay` 缺席 → 什么都不做）：一个从没用过
   *    随机事件的存档不该因为「关着」而每次时间推进都写一次库；它第一次开起来时，
   *    纯函数的首次 ensure 自会把 `lastRollDay` 置成当天。
   * 🔴 落库仍走命名写入口 `updateRandomEventFlags`（ADR-21），整份覆盖 —— 除 `lastRollDay`
   *    外一格不动（关掉 ≠ 清空，§6：足迹与触发档案是**事实**，不可重算）。
   */
  private async skipRandomEventDays(profile: SaveProfile): Promise<void> {
    try {
      const flags = getRandomEventFlags(profile);
      if (flags.lastRollDay === undefined) return;
      const currentDay = this.gameDayOf(profile);
      // 回退（`lastRollDay > currentDay`）交给纯函数的回退护栏，这里不抢它的活
      if (!Number.isFinite(currentDay) || flags.lastRollDay >= currentDay) return;
      await updateRandomEventFlags(profile, { ...flags, lastRollDay: currentDay });
    } catch (err) {
      console.warn('[StateManager] 随机事件跳日盖戳失败（不影响正文与已落库状态）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件跳日盖戳失败（不影响正文与已落库状态）: ${String(err)}`,
      );
    }
  }

  /**
   * 首访强制钩子（§4.2）—— `applySetLocation` 落位之后调用。
   *
   * 🔴 **只跟踪玩家**（同 `syncMapLocation` 的 player only）：NPC 换位置不该起玩家的首访事件。
   * 🔴 **足迹在触发时记账、不在入池时**（纯函数那边的契约）：AI 一直没触发、玩家离开又回来，
   *    会再次强制入池 —— 这才守得住「点名地点第一次到必定触发」。
   *
   * 入池后同样顺手保洁：换了地点就意味着 `location` 类条件的答案变了，池里可能有条目当场失效
   * （`available` 不再满足 / 权重归零），留到下一回合再撤等于把它注给 AI 看一次。
   */
  private async syncRandomEventFirstVisit(char: CharacterState): Promise<void> {
    if (char.type !== 'player') return;
    if (!getEngineSettings().randomEventsEnabled) return;
    const pack = getRandomEventPack();
    if (isEmptyRandomEventPack(pack)) return;

    try {
      // 同 `syncMapLocation`：只从 `applySetLocation` 来，永远在提交作用域内
      const profile = await this.readProfile();
      const ctx = await this.buildRandomEventContext(profile);
      const placeKey = ctx.placeKey;
      // 地点键都算不出来（没落位且位置路径为空）→ 什么也不做，不拿空键去比足迹
      if (placeKey === undefined || placeKey.length === 0) return;

      const currentDay = this.gameDayOf(profile);
      const current = getRandomEventFlags(profile);

      const armed = armFirstVisitEvent(pack.defs, current, ctx, {
        placeKey,
        currentDay,
        saveSeed: this.saveId,
      });
      const pruned = pruneRandomEvents(pack.defs, pack.config, armed ?? current, ctx, currentDay);

      const next = pruned ?? armed;
      if (next === null) return;
      setRandomEventFlagsInPlace(profile, next);
      await this.persistProfile(profile);
    } catch (err) {
      // 位置路径与地块投影都已落库；首访没入池只是少一次遭遇
      console.warn('[StateManager] 随机事件首访入池失败（位置已落库，不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件首访入池失败（位置已落库，不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 每回合一次的轻量保洁（§4.3）—— 由 orchestrator 的每回合胶水层调用（形状照
   * `syncMapJourney`：公开、自带 try/catch、不污染 `onStateCommitError`）。
   *
   * **只保洁不掷骰**：掷骰的判据是「日子过了几天」，而回合与天数无关（一整天可以是十个回合，
   * 也可以是零个）。这里要处理的是**上下文变了**导致的失效（AI 在正文里改了变量 / 任务状态 /
   * 好感度，于是某条候选的 `available` 不再满足）—— 便宜且幂等，同一回合调两次不会有副作用。
   */
  async syncRandomEventsForTurn(): Promise<void> {
    if (!getEngineSettings().randomEventsEnabled) return;
    const pack = getRandomEventPack();
    if (isEmptyRandomEventPack(pack)) return;

    try {
      // 🔴 并行化改造：保洁的读-改-写（getProfile → 纯函数 → updateRandomEventFlags）
      // 是同一段 RMW 区段，整段互斥 —— 与结算 / 提交 / advanceTime 争同一条
      // SaveProfile 记录，交错执行会各自读到旧快照（最后写的赢，且零报错）。
      await withSaveWriteLock(this.saveId, async () => {
        const profile = await getProfile(this.saveId);
        const ctx = await this.buildRandomEventContext(profile);
        const pruned = pruneRandomEvents(
          pack.defs,
          pack.config,
          getRandomEventFlags(profile),
          ctx,
          this.gameDayOf(profile),
        );
        if (pruned === null) return;
        await updateRandomEventFlags(profile, pruned);
      });
    } catch (err) {
      console.warn('[StateManager] 随机事件保洁失败（不影响正文与已落库状态）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件保洁失败（不影响正文与已落库状态）: ${String(err)}`,
      );
    }
  }

  /**
   * AI 回执 `<event_trigger name>` 后的结算入口（§5.2）。
   *
   * 🔴 **命名方法，不是 `StatePatchOp`**（设计 §5.2 明写）：它不是 AI 面向的通用状态原语，
   *    做成 op 就等于让 `vars_update` 也能伪造一次触发。ADR-21 的「唯一写入口」语义由
   *    StateManager 方法本身承接，与 `applyTimeAdvance` 同档。
   *
   * 两条 warn-noop（都不是错误，是设计内行为）:
   *   · 系统关闭时收到 marker —— 关掉之后 story 预设里可能还留着上一轮的注入块
   *   · 名字不在候选池 —— **AI 幻觉触发不奖励**（§5.2 步 1）。逐字匹配，不做模糊解析：
   *     模糊匹配会让「AI 编了一个相近的名字」静默变成「触发了另一个真事件」
   *
   * 结算五步里的前四步在纯函数 `settleRandomEventTrigger`（清池 / 起冷却 / 记档案 / 记足迹），
   * 这里只做第五步：落库 + emit。
   */
  async confirmRandomEventTrigger(name: string): Promise<void> {
    if (!getEngineSettings().randomEventsEnabled) {
      console.warn(`[StateManager] 随机事件已关闭，忽略触发回执: ${name}`);
      return;
    }

    try {
      // 🔴 并行化改造：结算读-改-写（getProfile → settle → updateRandomEventFlags）
      // 是同一段 RMW 区段，整段互斥；锁外的 reactToEvents 里的嵌套 commitChatState
      // 自己排队拿锁（铁律②：锁内禁再入队列）。
      const settledOut = await withSaveWriteLock(this.saveId, async () => {
        const profile = await getProfile(this.saveId);
        const currentDay = this.gameDayOf(profile);
        const settled = settleRandomEventTrigger(getRandomEventFlags(profile), name, currentDay);
        if (settled === null) {
          console.warn(`[StateManager] 随机事件不在候选池中，忽略触发回执: ${name}`);
          return null;
        }
        await updateRandomEventFlags(profile, settled.flags);
        return { settled, currentDay };
      });
      if (!settledOut) return;

      const { settled, currentDay } = settledOut;

      // emit 形状照 `applyTimeAdvance` 末尾那条（真 push 进 this.events，不是只构造）。
      // 事件系统只记「触发过」这一事实（铁则 5）；脚本订阅链已随脚本系统退役。
      // （§5.2 步 5）
      const event = this.createEvent('random_event', {
        op: 'set_variable',
        target: `worldFlags.randomEvents.fired.${settled.triggered.name}`,
        value: {
          name: settled.triggered.name,
          day: currentDay,
          forced: settled.triggered.forced === true,
          brief: settled.triggered.brief,
        },
      });
      this.events.push(event);
    } catch (err) {
      // 事件系统只记「触发过」这一事实（铁则 5）；记不上不该让这一回合的正文崩掉
      console.warn('[StateManager] 随机事件触发结算失败（不影响正文）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件触发结算失败（不影响正文）: ${String(err)}`,
      );
    }
  }

  /**
   * 调试入池：把一条事件按 forced 塞进候选池，让它在**下一回合**的 `{{RANDOM_EVENTS}}` 里
   * 带 `[!]`（= 必须尽快触发）出现。开发者调试面板专用。
   *
   * 🔴 **命名方法，不是 `StatePatchOp`**（同 `confirmRandomEventTrigger` 那条理由）：
   *    做成 op 就等于把「凭空点燃一个事件」这个能力交给了 AI。它也**不进任何 Agent 工具表**。
   * 🔴 **刻意绕过 `available` / 权重 / 冷却 / `once`**：这就是一个开发者按钮的意义。
   *    调用方（调试面板）只列 `available` 通过的事件，但这一层不替它把关 ——
   *    在这里加闸门会让「为什么按了没反应」变成一道要读三个纯函数才答得上的谜题。
   * 🔴 槽位采样与简报固化整份走 `armRandomEventForced`（= 真实入池那条路），
   *    不在这里手搓条目：手搓出来的候选带着未替换的 `{{槽名}}`，调试的就不是真实形态了。
   *
   * 结果交回调用方转 toast（本层不弹提示，同 `allocateAttributePoint` 的口径）。
   */
  async devForceArmRandomEvent(name: string): Promise<{ ok: boolean; error?: string }> {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (wanted.length === 0) return { ok: false, error: '事件名为空' };

    // 🔴 关掉时**一个字节都不写**（与另外四条钩子同一道闸）：注入侧此时返回空串，
    //    写进去的候选谁也看不见 —— 而按钮会照常 toast 成功。「入了池但永远不出现」
    //    是这个子系统里最难查的一种假象，宁可在这里说清楚。
    if (!getEngineSettings().randomEventsEnabled) {
      console.warn(`[StateManager] 随机事件已关闭，忽略调试入池: ${wanted}`);
      return { ok: false, error: '随机事件系统已关闭（设置 → 剧情）' };
    }

    const pack = getRandomEventPack();
    const def = pack.defs.find((d) => d?.name === wanted);
    if (def === undefined) {
      // 幻觉名字与「换包后名字对不上」共用这一条 warn（铁则 4：认不出就静默跳过，不抛）
      console.warn(`[StateManager] 随机事件定义不存在，忽略调试入池: ${wanted}`);
      return { ok: false, error: '事件定义不存在（可能换过内容包）' };
    }

    try {
      const profile = await getProfile(this.saveId);
      const ctx = await this.buildRandomEventContext(profile);
      const armed = armRandomEventForced(def, getRandomEventFlags(profile), ctx, {
        currentDay: this.gameDayOf(profile),
        saveSeed: this.saveId,
      });
      // `null` = 池里已经有一条一模一样的（同日同名同简报）→ 已经armed，无需再写库
      if (armed !== null) await updateRandomEventFlags(profile, armed);
      return { ok: true };
    } catch (err) {
      console.warn('[StateManager] 随机事件调试入池失败（不影响正文与已落库状态）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 随机事件调试入池失败（不影响正文与已落库状态）: ${String(err)}`,
      );
      return { ok: false, error: '调试入池失败（详见控制台）' };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🆕 时间推进 & 状态效果结算 (Phase 7e+8)
  // ═══════════════════════════════════════════════════════════

  /**
   * 推进全局游戏时间（天气 / 随机事件 / 地块结算三个钩子随之触发）。
   *
   * 🔴 **2026-10-03（Phase 3）起不再结算状态效果**：remainingTime 扣减与到期移除整段
   * 交给 `daily_check` Agent（在 dispatcher 之后的新 stage 里产 `update_status_effect` /
   * `remove_status_effect` 补丁）。Code 只推时钟，不做任何角色状态写。
   *
   * @param minutes - 推进的分钟数
   * @returns 恒为空数组（保留返回形状供调用方兼容；状态补丁已不在此处产生）
   */
  async applyTimeAdvance(minutes: number, isCurrent?: () => boolean): Promise<StatePatch[]> {
    const patches: StatePatch[] = [];
    if (minutes <= 0) return patches;

    // 1. 更新 SaveProfile.gameTime
    // 🔴 并行化改造：时间推进的全部 DB 工作（gameTime / 天气 / 随机事件 / 地块结算）是
    // 一段连续读-改-写区段，整段互斥。状态计时已交 daily_check，本方法不再写角色。
    await withSaveWriteLock(this.saveId, async () => {
      assertCurrentTurn(isCurrent);
      const profile = await getProfile(this.saveId);
      // 地图 v1.2（§4）：结算区间是**半开区间** `(prevDay, nextDay]`，所以推进**之前**
      // 就得把起点记下来 —— 推进完再算就永远拿到同一天，一次跨 90 天的前进会静默结算 0 期
      const prevDay = this.gameDayOf(profile);
      profile.gameTime = advanceTime(profile.gameTime, minutes);
      await updateProfile(profile);

      // 1.5 🗺 天气重断言（地图 v1 §7）——**必须在时间推进之后**：判据是「新时间落在哪一天」，
      //     拿旧时间去比就等于永远差一天（跨天那一次不断言、下一次同日的又不断言）
      await this.syncMapWeather(profile);

      // 1.6 🎲 随机事件逐天掷骰（随机事件 v1 §4.1）——**必须在时间推进之后**，且排在天气之后：
      //     权重条件里有 `time.seasonAnyOf` / `timeOfDayAnyOf`，用的是推进后的新时间；
      //     天气在前是因为它会写 `variables.sys.天气`，而条件 DSL 的 `var` 读的正是这棵树
      await this.syncRandomEvents(profile);

      // 1.7 🧱 地块按期结算（地图 v1.2 §4）——**必须在时间推进之后**（同天气/掷骰那条理由）。
      //     收益改走持久借据（F08）：锁内与事实态同一次落库，锁外由 `settlePendingMapIncome`
      //     原子入账 —— 不再往 `patches` 塞收益补丁（锁内嵌套 commitChatState ≠ 病灶根因，
      //     锁外自提交失败才丢账，借据机制消灭的是那个失败窗口）。
      await this.syncMapFactsSettlement(profile, prevDay);

      // 2. 状态计时全权交 daily_check（Phase 3）：本方法**不再**遍历角色扣减
      //    remainingTime / 移除到期效果 —— 那由后续 daily_check stage 产
      //    update_status_effect / remove_status_effect 补丁落地（时间是它读 {{DELTA_TIME}}）。

      // 3. emit time_advanced（Q-02：改成真 push，旧代码 createEvent 不落库）
      this.events.push(
        this.createEvent('system', {
          op: 'set_variable',
          target: 'variables.gameTime',
          value: profile.gameTime,
        }),
      );
    });

    // Q-02 修复（合并后保留）：本方法若产补丁，必须在方法内自提交 —— 唯一调用点曾丢弃返回值，
    // 到期效果的 remove/hp/stat 与 onRemove 脚本会全部蒸发；且必须带 `isCurrent` 守卫
    // （陈旧回合不得落库）。Phase 3 之后状态计时全权交 daily_check，本方法恒返回空数组，
    // 所以这段自提交在当前架构里是**空转的防御分支**，留着是为了不让「将来重新产补丁」踩回原坑。
    if (patches.length > 0) {
      await this.commitChatState(patches, { isCurrent });
    }

    // F08 收益重放：收益从「锁外补丁」改为「持久借据的原子入账」，与上面的正文自提交
    // **互不连坐** —— 正文补丁失败不影响收益入账，收益入账失败也不回滚已提交的正文。
    assertCurrentTurn(isCurrent);
    await this.settlePendingMapIncome();

    return patches;
  }

  /**
   * F08 — 消费收益借据袋（`worldFlags.mapIncome`），**恰一次入账**。
   *
   * 调度（§4）：`applyTimeAdvance` 每次推进后调用一次；原则上也可以在任何「存档活着且
   * 想收账」的时刻调用（崩溃重开后由下一次推进重放，本方法自身幂等）。
   *
   * 实现（简报 §4 备选方案的第二笔交易）：
   *   · 锁外 + 自带 `withSaveWriteLock`（per-saveId FIFO，与 commitChatState 串行），
   *     锁内开 db 显式**跨表事务** `(saveProfiles + characters)` —— 给钱与标记 applied
   *     在同一事务里翻转，任一步失败 Dexie 整事务回滚：**崩在任何一点都回到
   *     「未给钱 + 未标记」**，下次调用重放；事务提交后丢确认，重放读到的已是
   *     applied → 跳过。两条路都恰一次，靠记账本身而非 retry 计数。
   *   · 事务内**重读** profile 与玩家角色（同一把锁、同一事务）：绝不拿调用方手里的
   *     陈旧整档覆写刚改过的 money（简报 §3 第 2 条 —— 提交级缓存那轮吃过同样的亏，
   *     P1-09 的「锁内重读新鲜」是同款纪律）。
   *   · 防御性消费：畸形金额（非有限/`<= 0`）与重复 id（手改备份塞了两条同 id）跳过
   *     不标记、不丢账，warn 留痕；没有玩家角色 = 永久错误，借据原样保留待查。
   *   · applied 的借据**保留**在袋里作账目审计（不裁剪）：正常存档每个收益窗口一条、
   *     量级极小；裁剪会引入「借据历史被吞」的静默删账，收益小于复杂度。
   *
   * @returns 本次尝试的统计（见 {@link MapIncomeSettleResult}）。调用方不需要对一个
   *          non-zero 结果做补偿动作 —— 未入账的借据仍然留着，下次调用自会重放。
   */
  async settlePendingMapIncome(): Promise<MapIncomeSettleResult> {
    let pendingCount = 0; // 事务里抓到的未应用条数（整轮回滚时用来报 failed）
    let credited = 0;
    try {
      await withSaveWriteLock(this.saveId, async () => {
        const db = getDatabase();
        await db.transaction('rw', [db.saveProfiles, db.characters], async () => {
          // 🔴 事务内重读（不给调用方手里的对象留覆写机会）；same-lock 串行 + IDB 事务
          //    双保险，这里读到的 profile / 玩家就是应用当前的最新值。
          const profile = await db.saveProfiles.get(this.saveId);
          if (!profile) return;
          const bag = getMapIncomeFlags(profile);
          const notApplied = bag.pending.filter((p) => !p.applied);
          if (notApplied.length === 0) return;
          pendingCount = notApplied.length;

          const player = (await db.characters.where('saveId').equals(this.saveId).toArray()).find(
            (c) => c.type === 'player',
          );
          if (player === undefined) {
            // 永久错误：入账对象不存在。借据保留待查，不标记不删除（简报 §4「expose
            // permanent errors, such as a missing recipient, instead of dropping the event」）
            console.warn(
              '[StateManager] 收益借据待入账但没有玩家角色，账目保留待查:',
              notApplied.map((p) => p.id).join(', '),
            );
            return; // 一条都没改，无需落库
          }

          const day = Math.floor(toEpochMinutes(profile.gameTime) / MINUTES_PER_GAME_DAY);
          let total = 0;
          const seen = new Set<string>();
          for (const entry of notApplied) {
            if (seen.has(entry.id)) {
              console.warn(`[StateManager] 重复收益借据 ${entry.id} 已跳过（只入账首条）`);
              continue;
            }
            seen.add(entry.id);
            if (!Number.isFinite(entry.amount) || entry.amount <= 0) {
              console.warn(`[StateManager] 畸形收益借据 ${entry.id} 已跳过不标记（金额非法）`);
              continue;
            }
            total += entry.amount;
            entry.applied = true;
            entry.appliedAtDay = day;
            credited++;
          }
          if (total <= 0) return; // 全是跳过项，一个字节都不写

          player.money = (Number.isFinite(player.money) ? player.money : 0) + total;
          await db.characters.put(player);
          await db.saveProfiles.put(profile);
        });
      });
    } catch (err) {
      // 事务级回滚：钱没给、标记没写，借据原样保留 —— 正是「可恢复」的落点
      console.warn('[StateManager] 地图收益入账失败（借据保留，下次结算自动重放）:', err);
      this.onMaintenanceWarning?.(
        `[StateManager] 地图收益入账失败（借据保留，下次结算自动重放）: ${String(err)}`,
      );
      return { credited: 0, failed: pendingCount, rolledBack: true };
    }
    return { credited, failed: pendingCount - credited, rolledBack: false };
  }
}

// ========== 工厂函数 ==========

/** 创建 StateManager 实例 */
export function createStateManager(
  saveId: string,
  config?: Partial<StateManagerConfig>,
): StateManager {
  return new StateManager({ saveId, ...config });
}

// ═══════════════════════════════════════════════════════════
// 🗺 地图策略（纯函数；上面三条钩子的全部判定都在这里）
// ═══════════════════════════════════════════════════════════

/** 一游戏日 = 1440 分钟（`time-system` 的同一个常量，那边没导出） */
const MINUTES_PER_GAME_DAY = 1440;

/** 引擎断言的天气标签落在这条变量路径（§7：**只写标签串**，不写结构体） */
const WEATHER_VAR_PATH = 'sys.天气';

/**
 * 在途旗的发起面 —— dispatcher 写的**普通变量**（裁定 §12-8：v1 无新标记无新 op）。
 * 值是一个**名字**（地块 / 聚落 / 中层 / 国家），不是路径也不是 id。
 */
const TRAVEL_DESTINATION_VAR_PATH = 'sys.旅行目的地';

// ═══════════════════════════════════════════════════════════
// 🧱 地块事实的接线辅助（地图 v1.2 / ADR-33）
// ═══════════════════════════════════════════════════════════

/** 六个地块 op 解析完地块之后的公共上下文（`openTileFacts` 的产物） */
interface TileFactsContext {
  profile: SaveProfile;
  facts: MapFactsFlags;
  tile: MapTile;
  /** 已有事实条目，或**以当时 pack 基线播下的种子**（§3 copy-on-write） */
  entry: TileFactsEntry;
  /** 当前游戏日（状态锚 / 收益锚 / 编年史日期共用同一个口径） */
  day: number;
}

/** 建筑收益的周期长度（§F4：v1.2 只有「每 30 天一笔」这一种，AI 不可调） */
const BUILDING_INCOME_PERIOD_DAYS = 30;

/** 地块结算新闻的分类（`NewsItem.category` 是自由文本，全仓无枚举） */
const MAP_NEWS_CATEGORY = '地图';

// ═══════════════════════════════════════════════════════════
// 🧾 收益记收账本（F08 可恢复收益 / docs/known-issue.md「地图 v1.2 结算的两条收益丢账」第 2 条）
// ═══════════════════════════════════════════════════════════
//
// 病灶：`syncMapFactsSettlement` 先 `updateMapFactsFlags` 落库（结算窗口推进），收益却只往
// `patches[]` 里塞一条 delta，由 `applyTimeAdvance` 锁外的自提交消费 —— 自提交失败（抛错或
// 补丁级失败落进被调用点丢弃的 `errors`）时，窗口已推进、该笔收益永久蒸发（时间账本是零簿记
// 推导，没有游标可重放）。
//
// 修复（选「持久化 pending 记收 + 幂等重放」，不接单事务 —— 单事务要把时间/天气/随机事件/
// 结算/角色状态的多次既存 best-effort 写全收进一个 IDB 事务，等于改掉整个 applyTimeAdvance
// 的失败语义，F08 简报 §4 明确允许在这种前提下选备用方案）：
//   · **记收**（锁内）：每一笔 `incomeDue` 折叠成一条**持久 pending 记录**（金额算死 =
//     每期 × 期数，不随以后的所有权/费率重算），与事实态同一份 profile、同一次落库 ——
//     「窗口推进」与「该给的钱」同生共死：写失败时两者都不落，下次结算从旧窗口重算。
//   · **重放**（锁外）：`settlePendingMapIncome` 以「给钱 + 标记 applied 原子同事务」消费；
//     崩溃/写失败 = 事务回滚，账目保持未应用未入账，下次调用自动重放。恰好一次入账由
//     **记录本身**保证（applied 位与钱在同一事务里翻转），而非靠 retry 计数。
//   · **去重身份**：id = `地块::建筑::main|slot::fromDay..toDay`，把覆盖区间钉死在记录里；
//     同区间重复结算（应当不可能）或手改备份塞重复行时按 id 合并/跳过，绝不双付。
//   · **随档语义**：借 `worldFlags.mapFacts` 先例（ADR-33），零新 Dexie 表、随 saveProfiles 进
//     FullBackup；与事实态同袋，故快照回退/存档导入把借据和已入账的钱**一起**回滚/搬走，
//     没有「旧借据压掉新重放」的穿越问题。历史已丢的收益**不回溯补偿**（F08 简报 §5）。
//
// 🔴 为什么住接线层而不是 `save-profile.ts` / `types-map.ts`：F08 修复的任务边界只允许动
//    state-manager.ts / map-dynamics.ts / 测试 / known-issue.md。`worldFlags` 在 types.ts 里是
//    `Record<string, any>`，不需要动 schema；读写口放接线层（与 `groupSettlementNews` 同级）——
//    mapIncome 本来就是**结算接线层的私有账本**，其他模块（含 UI）都不该碰它。

/** `worldFlags.mapIncome` 里一条等待入账（或已入账）的收益借据 */
export interface MapIncomePendingEntry {
  /** 稳定结算身份：`{tile}::{building}::{main|slot}::{fromDay}..{toDay}`（重放去重键） */
  id: string;
  /** 来源地块名（逻辑键，不随包版本漂移） */
  tile: string;
  /** 来源建筑名 */
  building: string;
  /** 是否来自主建筑（入口用；槽位建筑缺席） */
  main?: true;
  /** 入账对象 = 玩家逻辑名（存档导入重发 id 不影响名字，无需重映射） */
  recipient: string;
  /** 入账总额 = 每期金额 × 覆盖期数（**记收时算死**，不随以后所有权/费率重算） */
  amount: number;
  /** 覆盖的结算区间（游戏日，半开左端 `fromDay` + 闭右端 `toDay`，与 settlement 同口径） */
  fromDay: number;
  /** 覆盖的结算区间（游戏日，闭右端） */
  toDay: number;
  /** 已入账标记（与给钱同一事务翻转） */
  applied: boolean;
  /** 入账完成的游戏日（诊断；未入账时缺席） */
  appliedAtDay?: number;
  /** 本借据落库当天的游戏日（诊断） */
  recordedAtDay: number;
}

/** `worldFlags.mapIncome` 的形状（照 `worldFlags.mapFacts` 先例：零新表、随档往返） */
export interface MapIncomeFlags {
  /** 待入账 + 已入账的历史借据（applied 的保留作账目审计，见消费端的说明） */
  pending: MapIncomePendingEntry[];
}

/** `settlePendingMapIncome` 的返回值 */
export interface MapIncomeSettleResult {
  /** 本次成功入账的条数 */
  credited: number;
  /** 本次尝试但未能入账的条数（畸形金额 / 重复 id 跳过，或整轮回滚时 = 尝试条数） */
  failed: number;
  /** true = 事务整体回滚（一条都没入、一条都没标记），借据原样保留待下次重放 */
  rolledBack: boolean;
}

/** `worldFlags.mapIncome` 在 profile 里的键 —— 只在本节出现 */
const MAP_INCOME_FLAGS_KEY = 'mapIncome';

/**
 * 读收益借据袋（`worldFlags.mapIncome`）。
 *
 * 缺席（新档 / 这个存档从没产出过地块收益）返回**空账本**（`{ pending: [] }`）而不是
 * `undefined`：「没有借据」与「还没有这一袋」对每个消费方都是同一件事 —— 这也是
 * `applyTimeAdvance` 对它零加载成本的来源。🔴 返回的是**新对象**，往里写不会落库 ——
 * 落库只有 `setMapIncomeInPlace` + profile 落库这一条路。
 */
export function getMapIncomeFlags(profile: SaveProfile): MapIncomeFlags {
  const raw = profile.worldFlags?.[MAP_INCOME_FLAGS_KEY];
  if (raw === null || typeof raw !== 'object') return { pending: [] };
  const bag = raw as MapIncomeFlags;
  if (!Array.isArray(bag.pending)) return { ...bag, pending: [] };
  return bag;
}

/**
 * 整份覆盖收益借据袋（**只改内存不落库**；落库那拍由调用方与事实态合并成同一次 profile 写）。
 * 存在理由同 `setMapFactsInPlace`（save-profile.ts）：F08 要求「窗口推进与借据同一次落库」。
 */
function setMapIncomeInPlace(profile: SaveProfile, flags: MapIncomeFlags): void {
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[MAP_INCOME_FLAGS_KEY] = flags;
}

/**
 * 一条 `incomeDue` 结算事件 → 持久借据条目。
 *
 * 🔴 金额在这里**算死**（每期 × 期数）：重放时不再重新推导 —— 推进之后所有权/费率再变，
 *    这份借据仍按「欠账时的契约」入账（简报 §4「do not recalculate the amount」）。
 *    `amount` 是每期金额、`periods` 是覆盖期数（settle 已过滤非有限），这里再防御一道：
 *    两者乘出来不合法 → `amount: 0`（记账层丢这条，不参与入账也不崩结算）。
 */
function buildMapIncomeEntry(
  tile: string,
  event: Extract<MapSettlementEvent['event'], { kind: 'incomeDue' }>,
  ctx: { recipient: string; fromDay: number; toDay: number },
): MapIncomePendingEntry {
  const main = event.main === true;
  const total = event.amount * event.periods;
  const safeTotal = Number.isFinite(total) && total > 0 ? total : 0;
  return {
    id: `${tile}::${event.building}::${main ? 'main' : 'slot'}::${ctx.fromDay}..${ctx.toDay}`,
    tile,
    building: event.building,
    main: main || undefined,
    recipient: ctx.recipient,
    amount: safeTotal,
    fromDay: ctx.fromDay,
    toDay: ctx.toDay,
    recordedAtDay: ctx.toDay,
    applied: false,
  };
}

/**
 * 把一批收入事件并入既有借据袋（幂等合并）：同 **id** 已存在 → 保留旧记录不动。
 *
 * 正常流程里同一窗口同一来源只会产出一条事件（`settleMapFacts` 的半开区间是排他的），
 * 这条去重是给「同一窗口被重复结算」（快照回退后同一段区间再被推进？不会 —— 窗口由
 * `prevDay` 推导，回退会把 time 一起回退）与「手改/导入坏备份塞了重复行」兜底。
 */
function mergeMapIncomePending(
  existing: MapIncomePendingEntry[],
  incomeEvents: readonly MapSettlementEvent[],
  ctx: { recipient: string; fromDay: number; toDay: number },
): MapIncomePendingEntry[] {
  const out = existing.slice();
  const known = new Set(out.map((p) => p.id));
  for (const { tile, event } of incomeEvents) {
    if (event.kind !== 'incomeDue') continue;
    const fresh = buildMapIncomeEntry(tile, event, ctx);
    if (known.has(fresh.id)) continue;
    out.push(fresh);
    known.add(fresh.id);
  }
  return out;
}

/**
 * `durationDays` 的容错读取。**认不出一律读作永久（-1）而不是 0**：
 * 0 天 = 挂上当天就到期，等于 AI 写错一个字段就静默什么都没发生；永久至少留得住，
 * 而永久状态有明确的出口（`tile_status_remove`）。
 */
function coerceDurationDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return -1;
  const days = Math.trunc(n);
  return days < 0 ? -1 : days;
}

/**
 * `effects` 的容错读取（§F1 词汇表**刻意收窄**：v1.2 只有 `devProgressPerMonth` 一种）。
 * 认不出的条目逐条丢，整份认不出 → 空数组 = 纯 flavor（合法，不是异常）。
 */
function coerceTileStatusEffects(raw: unknown): TileStatusEffect[] {
  if (!Array.isArray(raw)) return [];
  const effects: TileStatusEffect[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.kind !== 'devProgressPerMonth') continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    effects.push({ kind: 'devProgressPerMonth', amount });
  }
  return effects;
}

/**
 * `income` 的容错读取。**周期与锚由 Code 补**（铁律3：AI 只填叙事字段，账务字段归 Code）——
 * AI 自己写锚日就能把钱提前入账，写周期就能把「每月」改成「每天」。
 *
 * 🔴 **已有收益时锚**（`existing`）**原地保留，只换金额**：AI 复述现状是常态
 *   （「你的酒馆每月仍进 50 G」），每复述一次就把 `anchorDay` 挪到今天的话，
 *    30 天的入账点会被无限期往后推 —— 表现是「有产业但永远不发钱」，且一条日志都没有。
 *    同名建筑刷新的幂等性（裁定 §8-10 的同款思路）本来就是给这种复读兜底的。
 *    锚只在**新授予收益**（此前没有 income）时定在今天。
 * 🔴 金额必须是**正的有限数**：负额 = 一条静默抽钱的 op（结算按 `amount × periods` 直接进
 *    玩家 `money`，没有任何一处会拦），0 = 一笔永远不入账的空账。两者一律**丢掉 income 这一格**
 *    并 warn —— 丢一格而不是否掉整条 op：建筑本身（名字/描述/归属）是合法的叙事事实。
 */
function coerceBuildingIncome(
  raw: unknown,
  day: number,
  existing?: BuildingRecord['income'],
): BuildingRecord['income'] | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const amount = Number((raw as Record<string, unknown>).amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.warn(`[StateManager] 建筑收益金额不合法（${String(amount)}），忽略 income 这一格`);
    return undefined;
  }
  const anchorDay = existing && Number.isFinite(existing.anchorDay) ? existing.anchorDay : day;
  return { amount, periodDays: BUILDING_INCOME_PERIOD_DAYS, anchorDay };
}

/** 目标建筑现有的收益锚（找不到那座建筑 = 还没有锚，由调用方定在今天） */
function existingBuildingIncome(
  entry: TileFactsEntry,
  name: string,
): BuildingRecord['income'] | undefined {
  const slots = Array.isArray(entry.buildings) ? entry.buildings : [];
  return slots.find((row) => row?.name === name)?.income;
}

/**
 * 结算事件 → 每块地一段中文新闻行（§5 的四类提示：状态到期 / 升降档 / 建筑被毁 / 收益入账）。
 *
 * 🔴 `devPeriodApplied` **刻意不进新闻**：它是每月效果的节拍，本身没有玩家可感的结果 ——
 *    真正的结果（升降档 / 摧毁）自会各出一条。把节拍也播出去，一场跨年的洪水会刷 12 条
 *    「进度 −2」，而那 12 条里没有一条告诉玩家城怎么样了。
 */
function groupSettlementNews(events: readonly MapSettlementEvent[]): Map<string, string[]> {
  const byTile = new Map<string, string[]>();
  const push = (tile: string, line: string): void => {
    const lines = byTile.get(tile);
    if (lines === undefined) byTile.set(tile, [line]);
    else lines.push(line);
  };

  for (const { tile, event } of events) {
    switch (event.kind) {
      case 'statusExpired':
        push(tile, `状态「${event.title}」已到期结束。`);
        break;
      case 'levelChanged':
        push(
          tile,
          event.to > event.from
            ? `发展等级提升：第 ${event.from} 档 → 第 ${event.to} 档。`
            : `发展等级下滑：第 ${event.from} 档 → 第 ${event.to} 档。`,
        );
        break;
      case 'buildingDestroyed':
        push(
          tile,
          event.causeStatuses.length > 0
            ? `建筑「${event.building}」毁于地块衰退（${event.causeStatuses.join('、')}）。`
            : `建筑「${event.building}」在衰退中损毁。`,
        );
        break;
      case 'incomeDue':
        // `main` 只换一个前缀：入账这件事两者一模一样（§F4b「除降档免疫外一切如常」），
        // 但玩家该分得清这笔钱是主建筑还是某个槽里的铺子来的
        push(
          tile,
          `${event.main === true ? '主建筑' : '产业'}「${event.building}」入账：每期 ${
            event.amount
          } G × ${event.periods} 期 = ${event.amount * event.periods} G。`,
        );
        break;
      case 'devPeriodApplied':
        break;
    }
  }
  return byTile;
}

/** 两块地在**合并后的**邻接图（邻接 ∪ 海峡）上相不相邻 */
function areTilesAdjacent(index: MapIndex, a: number, b: number): boolean {
  const links = index.neighbors.get(a);
  return links !== undefined && links.some((link) => link.tileId === b);
}

/** `sys.旅行目的地` → 修过边的名字；不是非空串一律读作「没有目的地」 */
function readTravelDestination(variables: Record<string, any> | undefined): string {
  const raw = getVar(variables ?? {}, TRAVEL_DESTINATION_VAR_PATH);
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * 位置路径 → 下一份 flags（**落位**，§8.2）。`null` = 这一次不该写任何东西。
 *
 * 三件事一次算完（它们共用「这次落到哪个块」这一个结论，拆开就要各查一遍表）:
 *   ① `lastTileId` —— 落位失败（`resolveTileByLocation` 返回 `null`）时**保持原值**（§8.2-5）
 *   ② `lastMoveDiscontinuity` —— 上一块存在、这次换了块、且两块**不相邻**（裁定 §12-4
 *      只校验不否决：照常落位，只在下一回合的 `MAP_CONTEXT` 附一条提示行）。
 *      不满足时**显式删掉**这一格 —— 留着就是拿上上次的越野说这一次的事，而提示行会一直挂着
 *   ③ 到达即清旗 —— 落到 `journey.toTileId` 就把在途旗删掉（在途旗是数据不是状态机）
 */
function projectLocationFlags(
  index: MapIndex,
  flags: MapSaveFlags,
  locationPath: string,
): MapSaveFlags | null {
  const previous = flags.lastTileId ?? null;
  const resolved = resolveTileByLocation(index, locationPath, previous);
  if (resolved === null) return null;

  const next: MapSaveFlags = { ...flags, lastTileId: resolved };

  if (previous !== null && previous !== resolved && !areTilesAdjacent(index, previous, resolved)) {
    next.lastMoveDiscontinuity = 1;
  } else {
    delete next.lastMoveDiscontinuity;
  }

  if (next.journey !== undefined && next.journey.toTileId === resolved) delete next.journey;

  return next;
}

/**
 * 天气重断言（§7）。`null` = 不必重断言（**同日同区**，或压根没落位 / 没气候区）。
 *
 * 返回的 `label` 为 `null` 时调用方**只更新戳**：包里一张可用天气表都没有，
 * 而凭空造一个不在包词汇里的标签串会被 `image-world-tags` 漏掉、又会被 `<tp>` 栏当真话讲。
 */
function assertWeatherFlags(
  pack: MapPack,
  flags: MapSaveFlags,
  seasonKey: string,
  gameDay: number,
  saveSeed: string,
): { flags: MapSaveFlags; label: string | null } | null {
  const tileId = flags.lastTileId;
  if (tileId === undefined) return null; // 没落位 → 不知道在哪个气候区，什么都不断言

  const zoneId = weatherZoneOfTile(pack, tileId);
  if (zoneId === null) return null;

  const stamp = flags.weatherStamp;
  if (stamp !== undefined && stamp.day === gameDay && stamp.zoneId === zoneId) return null;

  const result = weatherAt(pack, zoneId, seasonKey, gameDay, saveSeed);
  return {
    flags: { ...flags, weatherStamp: { day: gameDay, zoneId } },
    label: result?.label ?? null,
  };
}

/**
 * `sys.旅行目的地` → 下一份 flags（在途旗，§8.2 / 裁定 §12-8）。`null` = 这一次不写。
 *
 * 🔴 `findPath` 无路时**照样设旗**，只是没有 `plannedPath`、`arriveAtMinute` 取**当前时刻**
 *    （= 到达时刻未知 ≈ 现在）。理由：目的地是叙事事实（队伍立志要去某处），而「地图上走不通」
 *    是地图的事实 —— 传送 / 剧情跳转 / 尚未建模的航线都会让一条合法的旅程无路可走。
 *    因此不设旗会把「AI 说了要去」整条丢掉；而胡编一个天数会被 dispatcher 当成锚（§12-5）。
 *    「未知 ≈ 现在」是最诚实的可选项：`MAP_CONTEXT` 的在途行照 `remainingDays: null` 渲染。
 */
function planJourneyFlags(
  pack: MapPack,
  index: MapIndex,
  flags: MapSaveFlags,
  destination: string,
  nowMinute: number,
): MapSaveFlags | null {
  // 清旗：没有旗时返回 `null`（别为了「清一个本来就不存在的旗」白写一次库）
  const cleared = (): MapSaveFlags | null => {
    if (flags.journey === undefined) return null;
    const next = { ...flags };
    delete next.journey;
    return next;
  };

  if (destination.length === 0) return cleared();

  const from = flags.lastTileId ?? null;
  // 目的地是**名字**，按单段路径解析；`from` 当 currentTileId 传进去 —— 目的地只写到
  // 国家粗度且队伍已在域内时，落位契约 3 会给回原地，于是下面判成「已在目的地」清旗
  const toTileId = resolveTileByLocation(index, destination, from);
  if (toTileId === null) return null; // 落位失败 = 不设旗，无害（§8.2）
  if (toTileId === from) return cleared();

  const route = from === null ? null : findPath(pack, from, toTileId);
  const journey: MapJourneyFlag = {
    toTileId,
    arriveAtMinute: nowMinute + (route?.days ?? 0) * MINUTES_PER_GAME_DAY,
  };
  if (route !== null) journey.plannedPath = route.tilePath;

  return { ...flags, journey };
}

// ═══════════════════════════════════════════════════════════
// op → handler 分发表（Q-19）
// ═══════════════════════════════════════════════════════════

/**
 * 🔴 **`Record<StatePatchOp, …>` 是这张表的全部意义**：漏接一个 op 是**编译错误**，
 * 而不是运行到那一条才 `throw new Error('未知操作')`。
 *
 * 此前是一个 30 分支的手写 switch + `default: throw`。加一个 op 时编译器完全不管，
 * 只有真机走到那条 patch 才炸 —— 而 patch 是 AI 产出的，走不走到看运气。
 *
 * 放在 class 之外是必须的：类内静态字段初始化时 `StateManager.prototype` 上的
 * 私有方法还没准备好被引用成值。这里每个条目都是 `(sm, patch) => sm.applyXxx(patch)`
 * 的薄包装，`sm` 就是 `this`。
 */
const PATCH_HANDLERS: Record<
  StatePatchOp,
  (sm: StateManager, patch: StatePatch) => Promise<GameEvent>
> = {
  // 变量
  set_variable: (sm, p) => sm['applyVariablePatch'](p),
  delta_variable: (sm, p) => sm['applyVariablePatch'](p),
  remove_variable: (sm, p) => sm['applyVariablePatch'](p),
  move_variable: (sm, p) => sm['applyVariablePatch'](p),
  insert_variable: (sm, p) => sm['applyVariablePatch'](p),
  // 角色
  update_character: (sm, p) => sm['applyUpdateCharacter'](p),
  add_character: (sm, p) => sm['applyAddCharacter'](p),
  remove_character: (sm, p) => sm['applyRemoveCharacter'](p),
  rename_character: (sm, p) => sm['applyRenameCharacter'](p),
  set_location: (sm, p) => sm['applySetLocation'](p),
  // 资源（三态共用一个 handler，op 本身携带是哪一种）
  set_hp: (sm, p) => sm['applySetResource'](p),
  set_mp: (sm, p) => sm['applySetResource'](p),
  set_sp: (sm, p) => sm['applySetResource'](p),
  delta_hp: (sm, p) => sm['applyDeltaResource'](p),
  delta_mp: (sm, p) => sm['applyDeltaResource'](p),
  delta_sp: (sm, p) => sm['applyDeltaResource'](p),
  // 状态效果
  add_status_effect: (sm, p) => sm['applyAddStatusEffect'](p),
  update_status_effect: (sm, p) => sm['applyUpdateStatusEffect'](p),
  remove_status_effect: (sm, p) => sm['applyRemoveStatusEffect'](p),
  // 物品
  add_item: (sm, p) => sm['applyAddItem'](p),
  remove_item: (sm, p) => sm['applyRemoveItem'](p),
  update_item: (sm, p) => sm['applyUpdateItem'](p),
  transfer_item: (sm, p) => sm['applyTransferItem'](p),
  equip_item: (sm, p) => sm['applyEquipItem'](p),
  unequip_item: (sm, p) => sm['applyUnequipItem'](p),
  // 技能
  add_skill: (sm, p) => sm['applyAddSkill'](p),
  update_skill: (sm, p) => sm['applyUpdateSkill'](p),
  remove_skill: (sm, p) => sm['applyRemoveSkill'](p),
  // 记忆 / 剧情 / 任务
  add_memory: (sm, p) => sm['applyAddMemory'](p),
  update_plot_event: (sm, p) => sm['applyUpdatePlotEvent'](p),
  update_quest: (sm, p) => sm['applyQuestPatch'](p),
  remove_quest: (sm, p) => sm['applyQuestPatch'](p),
  // 好感度（两个 op 共用，handler 内按 op 分绝对/增量）
  set_affection: (sm, p) => sm['applyAffection'](p),
  delta_affection: (sm, p) => sm['applyAffection'](p),
  // 世界新闻
  add_news: (sm, p) => sm['applyAddNews'](p),
  // 地块事实（地图 v1.2 / ADR-33 §2）
  tile_status_add: (sm, p) => sm['applyTileStatusAdd'](p),
  tile_status_remove: (sm, p) => sm['applyTileStatusRemove'](p),
  tile_building_add: (sm, p) => sm['applyTileBuildingAdd'](p),
  tile_building_update: (sm, p) => sm['applyTileBuildingUpdate'](p),
  tile_dev_progress_add: (sm, p) => sm['applyTileDevProgressAdd'](p),
  tile_history_note: (sm, p) => sm['applyTileHistoryNote'](p),
};
