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
 * 4. 事务性提交（全部成功或全部回滚）
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
  StatusEffect,
  Skill,
  InventoryItem,
  Snapshot,
} from './types';
import {
  getCharacters,
  saveCharacter,
  saveCharacters,
  deleteCharacter,
  saveMemory,
  deleteMemoriesAfter,
  deleteSnapshotsAfter,
  getPlotEvents,
  savePlotEvents,
  deletePlotEvent,
  getSave,
  saveSaveSlot,
  getSnapshot,
  saveSnapshot,
  trimSnapshots,
  deleteMessagesAfterTurn,
  getMessages,
  saveMessages,
  deleteMessagesBySaveId,
  getDatabase,
} from './database';
import { getVar, setVar, delVar, insertVar, applyPathOps } from './var-resolver';
import { getTierConfig } from './tier-constants';
// 经验系统改造 v1（2026-08-24）：升级/登神判定归 Code（ADR-11）。resolveAscensionFlyup
// 负责「持物即飞升」，resolveLevelUps 负责 totalExp 驱动的升级循环。
import {
  resolveAscensionFlyup,
  resolveLevelUps,
  xpToNextNumber,
  tierNameForTier,
  MILESTONE_LEVELS,
  applyExpFloor,
} from './exp-table';
import { getEngineSettings } from './engine-settings';
// 并行化改造（docs/planning/2026-08-16-pipeline-parallelism.md）：一切 Dexie 写入
// 经 per-saveId FIFO 队列串行 —— 锁粒度 = 读-改-写区段，锁内禁止再入队列（铁律②）。
import { withSaveWriteLock } from './state-write-queue';
// Q-19：这三个模块此前在 14 处 handler 里各 `await import` 一次。它们都不 import
// 本模块（已核实无环），动态化没有换来任何解耦，只是让每个 handler 多一次 await
// 和一行噪音，还遮蔽了 1471 行那处同名解构。script-executor 仍留动态 —— 它是
// 唯一可能成环的那个（沙盒会回调状态层），单独验证后再说。
import {
  getProfile,
  updateProfile,
  setQuestInPlace,
  removeQuestInPlace,
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
import { clampAffection } from './affection-system';
import { advanceTime, getSeason, toEpochMinutes } from './time-system';
// 地图 v1 接线（设计 §5 接线表）：落位 / 天气断言 / 在途旗三条钩子的依赖。
// 全是纯函数叶 + 一条注入缝（`map-runtime`），没有一个会读注册表或碰 Dexie ——
// 静态 import 因此不成环（map-* 一律不 import 本模块）。
import { getMapIndex, getMapPack } from './map-runtime';
import { isEmptyMapPack } from './map-pack';
import { findTileByName, resolveTileByLocation, type MapIndex } from './map-index';
import { findPath } from './map-path';
import { weatherAt, weatherZoneOfTile } from './map-weather';
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
} from './map-dynamics';
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
} from './types-map';
// 随机事件 v1 接线（设计 §4.1 掷骰 / §4.2 首访 / §4.3 保洁 / §5.2 结算）。
// 与地图那一组同款依赖形状：全是纯函数叶 + 一条注入缝（`random-event-runtime`），
// 没有一个会读注册表或碰 Dexie，静态 import 不成环。
import { getRandomEventPack } from './random-event-runtime';
import { isEmptyRandomEventPack } from './random-event-pack';
import {
  armFirstVisitEvent,
  armRandomEventForced,
  pruneRandomEvents,
  rollRandomEvents,
  settleRandomEventTrigger,
} from './random-event-scheduler';
// 地点键与上下文快照的**唯一**实现（写侧与读侧共用，见该模块文件头）
import { buildRandomEventRollContext } from './random-event-snapshot';
import type { RandomEventRollContext } from './types-random-events';
import type { EjsVarsDiff } from './ejs-vars-diff';
import {
  normalizeQuestStatus,
  normalizeStatusCategory,
  normalizeItemType,
  normalizeRarity,
  normalizeSlot,
} from './field-enums';

// ========== Types ==========

export interface StateManagerConfig {
  saveId: string;
}

/** commitChatState 的可选载荷（工坊 P2 / ADR-30 D5） */
export interface CommitChatStateOptions {
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

// ========== update_character 白名单 (M2 T9, #19 #20 #21) ==========

/**
 * update_character value 白名单 — 从 CharacterState (types.ts) 逐字段推导:
 * 全部字段 MINUS 禁止项（数组实体 / name / 账务字段）。
 * 白名单外的未知键一律 loud 拒绝（大概率 AI 拼写错误）。
 */
const UPDATE_CHAR_WHITELIST = new Set<string>([
  // 基础信息（name 除外 — 改名走 rename_character）
  'type',
  'race',
  'identity',
  'occupation',
  // 生命层级
  'tier',
  'tierName',
  'level',
  'totalExp',
  'expToNext',
  // 五维属性
  'attributes',
  'freeAttrPoints',
  // 资源
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  // 登神长阶
  'ascension',
  // 经济 / 位置 / 冒险者等级 / 当前行为
  'money',
  'location',
  'present',
  'adventurerRank',
  'currentAction',
  // 血脉 / 集群数量 / 叙事字段
  'bloodlineIds',
  'quantity',
  'appearance',
  'background',
  'personality',
  'gender',
  'outfit',
  'thoughts',
  // 扩展字段
  'customFields',
]);

/** 禁止的数组实体字段 → 必须走各自专用 op（杀 #21 假字段污染） */
const UPDATE_CHAR_FORBIDDEN_ARRAY_FIELDS = new Set<string>([
  'inventory',
  'skills',
  'statusEffects',
  'equipment', // equipment 在 M2 T12 删除前同样禁止
]);

/** 禁止的账务字段 — 仅 Code 层维护（铁律3） */
const UPDATE_CHAR_FORBIDDEN_LEDGER_FIELDS = new Set<string>(['id', 'saveId']);

/** 可 delta 加法的数值字段（metadata.delta=true 时仅允许这些键，杀 #20 delta 变替换） */
const UPDATE_CHAR_NUMERIC_FIELDS = new Set<string>([
  'tier',
  'level',
  'totalExp',
  'expToNext',
  'freeAttrPoints',
  'hp',
  'maxHp',
  'mp',
  'maxMp',
  'sp',
  'maxSp',
  'money',
  'quantity',
]);

/** 五维属性键（英文，对齐 CharacterState.attributes；升层自动加点逐键遍历用） */
const ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'spi'] as const;

// ========== StateManager ==========

/**
 * Q-07：一次 commit 里「事件 → 订阅脚本 → 补丁 → 又是事件」这条链的最大轮数。
 * 3 轮足够表达「装备回血 → 触发满血 buff → 触发第三件装备」这类连锁，再多就是脚本互相触发。
 */
const MAX_EVENT_REACTION_DEPTH = 3;

export class StateManager {
  private saveId: string;
  private events: GameEvent[] = [];
  /** Q-07：已装备物品的脚本注销函数缓存（key=ownerKey，卸下时调用） */
  private _itemUnsubs: Map<string, () => void> = new Map();
  /** Q-07：事件反应轮的当前深度（见 reactToEvents） */
  private reactionDepth = 0;
  /**
   * 当前提交作用域缓存（见 `CommitScope`）。非 null 仅在 `commitChatState` 的锁段内成立。
   * 嵌套提交（`reactToEvents` / `applyTimeAdvance` 尾部自提交）一律发生在锁**外**，
   * 那时本字段已经复位成 null，各自建自己的作用域。
   */
  private commitScope: CommitScope | null = null;

  constructor(config: StateManagerConfig) {
    this.saveId = config.saveId;
  }

  // ========== 主入口 ==========

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
  async commitChatState(
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
          }
        }

        const newEvents: GameEvent[] = [];
        for (const patch of patches) {
          try {
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

    // Q-07：把本次产生的 GameEvent 发到存档 EventBus，触发已装备物品/技能的 $event.on 订阅，
    // 并把订阅脚本产出的效果转成补丁再提交一轮。此前这些事件只进 this.events（一个只被读取
    // 用于展示的数组），从未 publish —— 于是整条 emitChain 层永远空转。
    await this.reactToEvents(applied.newEvents);

    return {
      success: applied.errors.length === 0,
      patchesApplied: applied.results.filter((r) => r.success).length,
      eventsGenerated: [...this.events],
      errors: applied.errors,
    };
  }

  /**
   * Q-07：事件 → 效果订阅 → 补丁 的反应轮。
   *
   * 反应产生的补丁自己也会产生事件，所以有深度上限：超过就停下并告警，
   * 而不是让「A 触发 B、B 触发 A」把一次 commit 拖成事件风暴。
   */
  private async reactToEvents(events: GameEvent[]): Promise<void> {
    if (events.length === 0) return;

    const { peekEffectWiring, publishToEffectSystem } = await import('./effect-wiring');
    // 本存档没接线（没有带 scripts 的装备/技能）→ 零开销返回，不凭空建 EventBus
    if (!peekEffectWiring(this.saveId)) return;

    if (this.reactionDepth >= MAX_EVENT_REACTION_DEPTH) {
      console.warn(
        `[StateManager] 效果反应递归超限 (${MAX_EVENT_REACTION_DEPTH})，本轮 ${events.length} 个事件不再触发订阅`,
      );
      return;
    }

    this.reactionDepth++;
    try {
      const effects = await publishToEffectSystem(this.saveId, events);
      const patches = await convertScriptEffects(this.saveId, effects);
      if (patches.length > 0) {
        await this.commitChatState(patches);
      }
    } catch (err) {
      // 效果反应失败不能回滚已提交的正文状态 —— 记录即可
      console.error(
        '[StateManager] 效果反应失败:',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.reactionDepth--;
    }
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
    if (!patch.op) throw new Error('缺少 op 字段');
    if (!patch.target) throw new Error('缺少 target 字段');

    // amount 必填
    const AMOUNT_REQUIRED_OPS: StatePatchOp[] = [
      'delta_variable',
      'delta_hp',
      'delta_mp',
      'delta_sp',
      'delta_affection',
    ];
    if (AMOUNT_REQUIRED_OPS.includes(patch.op) && patch.amount === undefined) {
      throw new Error(`${patch.op} 需要 amount 字段`);
    }

    // value 必填
    const VALUE_REQUIRED_OPS: StatePatchOp[] = [
      'set_variable',
      'insert_variable',
      'set_hp',
      'set_mp',
      'set_sp',
      'set_location',
      'update_quest',
      'remove_quest',
      'add_item',
      'remove_item',
      'update_item',
      'transfer_item',
      'equip_item',
      'unequip_item',
      'add_skill',
      'update_skill',
      'remove_skill',
      'add_status_effect',
      'remove_status_effect',
      'add_character',
      'rename_character',
      'add_memory',
      'update_plot_event',
      'set_affection',
      'add_news',
      // 地图 v1.2：六个地块事实 op 的整份载荷都在 value 里（含寻址用的 `value.tile`），
      // 缺 value 就连「改哪块地」都不知道 —— 这里拦下比在 handler 里各拦一次好
      'tile_status_add',
      'tile_status_remove',
      'tile_building_add',
      'tile_building_update',
      'tile_dev_progress_add',
      'tile_history_note',
    ];
    if (VALUE_REQUIRED_OPS.includes(patch.op) && patch.value === undefined) {
      throw new Error(`${patch.op} 需要 value 字段`);
    }

    // move_variable 需要目标路径
    if (patch.op === 'move_variable' && !patch.metadata?.toPath) {
      throw new Error('move_variable 需要 metadata.toPath');
    }
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
    const chars = await this.readCharacters();

    // ① 名字精确匹配
    const byName = chars.find((c) => c.name === key);
    if (byName) return byName;

    // ② 主角别名
    if (key === '主角' || key === '玩家') {
      const player = chars.find((c) => c.type === 'player');
      if (player) return player;
    }

    // ③ 找不到
    throw new Error(`角色不存在: ${key}`);
  }

  /**
   * 从 patch.target 解析角色 — 剥离 'characters.' 前缀后只取第一段
   * （防御子路径写法 'characters.X.skills'，#11 Code 侧防御）
   */
  private async resolveCharTarget(target: string): Promise<CharacterState> {
    const raw = target.startsWith('characters.') ? target.slice('characters.'.length) : target;
    const key = raw.split('.')[0];
    if (!key) throw new Error(`无效的 character target: ${target}`);
    return this.resolveCharacter(key);
  }

  // ========== Patch Handlers ==========

  private async applySetVariable(patch: StatePatch): Promise<GameEvent> {
    // 读取当前 save 的 variables（真源: SaveProfile.variables，M5）
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.')
      ? patch.target.slice('variables.'.length)
      : patch.target;
    const newVars = setVar(vars, path, patch.value);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyDeltaVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.')
      ? patch.target.slice('variables.'.length)
      : patch.target;
    const current = getVar(vars, path);
    const newValue = (typeof current === 'number' ? current : 0) + (patch.amount ?? 0);
    const newVars = setVar(vars, path, newValue);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyRemoveVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.')
      ? patch.target.slice('variables.'.length)
      : patch.target;
    const newVars = delVar(vars, path);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyMoveVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const fromPath = patch.target.startsWith('variables.')
      ? patch.target.slice('variables.'.length)
      : patch.target;
    const toPath = patch.metadata?.toPath as string;
    if (!toPath) throw new Error('move_variable 需要 metadata.toPath');
    const value = getVar(vars, fromPath);
    let newVars = delVar(vars, fromPath);
    newVars = setVar(newVars, toPath, value);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyInsertVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.')
      ? patch.target.slice('variables.'.length)
      : patch.target;
    const newVars = insertVar(vars, path, patch.value, patch.metadata?.index as number);
    await this.persistVariables(newVars);
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

  private async applyUpdateCharacter(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    if (patch.value && typeof patch.value === 'object') {
      const value = patch.value as Record<string, any>;
      const keys = Object.keys(value);
      const isDelta = patch.metadata?.delta === true;

      // 升级/升层自动加点的取值基准 —— 必须在 value 落地**之前**抓，
      // 否则 delta 与 set 两条路径都会把旧值就地改掉，差值恒为 0（ADR-11：数值规则归 Code）
      const prevLevel = char.level;
      const prevTier = char.tier;

      // ===== 白名单校验（先验证后赋值 — 原子拒绝，任一非法键则整个 value 不落地）=====
      for (const k of keys) {
        if (UPDATE_CHAR_FORBIDDEN_ARRAY_FIELDS.has(k)) {
          // #21: 数组实体禁走 update_character，防假字段污染
          throw new Error(
            `update_character 禁止写数组字段 "${k}" — 请使用专用 op（add/update/remove_status_effect、add/update/remove_skill、add/update/remove_item、equip/unequip_item）`,
          );
        }
        if (k === 'name') {
          // 改名唯一途径 rename_character（名字是逻辑键，铁律1）
          throw new Error(`update_character 禁止改 name — 改名请使用 rename_character`);
        }
        if (UPDATE_CHAR_FORBIDDEN_LEDGER_FIELDS.has(k)) {
          // 账务字段仅 Code 层维护（铁律3）
          throw new Error(`update_character 禁止写账务字段 "${k}"（仅引擎内部维护）`);
        }
        if (!UPDATE_CHAR_WHITELIST.has(k)) {
          // 未知键 = 大概率 AI 拼写错误，loud 拒绝优于静默吞掉
          throw new Error(`update_character 不认识的字段 "${k}" — 白名单外的键一律拒绝`);
        }
        if (isDelta) {
          // delta 模式: 数值字段直接加；attributes 为嵌套对象（五维），其内部数值键各自加法
          if (k === 'attributes') {
            if (typeof value[k] !== 'object' || value[k] === null) {
              throw new Error(`update_character delta=true 的 attributes 必须是对象`);
            }
          } else if (!UPDATE_CHAR_NUMERIC_FIELDS.has(k)) {
            throw new Error(`update_character delta=true 仅支持数值字段，"${k}" 不是数值字段`);
          } else if (typeof value[k] !== 'number') {
            throw new Error(
              `update_character delta=true 要求 "${k}" 的值为 number，实际为 ${typeof value[k]}`,
            );
          }
        }
      }

      // ===== 全部合法 → 落地 =====
      if (isDelta) {
        // #20: delta 真加法（缺省/脏数据从 0 起加），不再退化为替换
        for (const k of keys) {
          if (k === 'attributes') {
            // 五维属性 delta：逐键加法（读缺省 0），不动未提及的维度
            const incoming = (value as Record<string, any>).attributes as Record<string, number>;
            const base = (char.attributes ?? {}) as Record<string, number>;
            const next: Record<string, number> = { ...base };
            for (const attr of Object.keys(incoming)) {
              const cur = typeof base[attr] === 'number' ? base[attr] : 0;
              next[attr] = cur + (incoming[attr] ?? 0);
            }
            char.attributes = next as CharacterState['attributes'];
          } else {
            const current = (char as any)[k];
            (char as any)[k] = (typeof current === 'number' ? current : 0) + value[k];
          }
        }
      } else {
        // attributes 深合并: AI 只发 {attributes:{力量:12}} 不得抹掉其余维度（终审修复）
        const { attributes: incomingAttrs, ...rest } = value;
        Object.assign(char, rest);
        if (incomingAttrs && typeof incomingAttrs === 'object') {
          char.attributes = { ...char.attributes, ...incomingAttrs };
        }
      }

      // ===== hp/mp/sp 钳制: 与 set_hp 语义一致 [0, 对应 max]（终审修复）=====
      // 仅在本次 patch 涉及资源或其 max 时钳制（若本次也写了 max* 则以写后值为准）
      // Q-19: 字段对由 RESOURCE_MAX_FIELD 给（`satisfies` 保证两侧都真的在
      // CharacterState 上），不再靠字符串拼 `max${...}` + `as` 断言。
      for (const res of RESOURCE_KEYS) {
        const maxField = RESOURCE_MAX_FIELD[res];
        if (keys.includes(res) || keys.includes(maxField)) {
          const cur = char[res];
          const max = char[maxField];
          if (typeof cur === 'number' && typeof max === 'number') {
            char[res] = Math.max(0, Math.min(cur, max));
          }
        }
      }

      // ===== 升级 / 升层自动加点（ADR-11：确定性数值规则归 Code，不交给 AI 算）=====
      // 只认主角：NPC/怪物/召唤物的等级由生成器一次性给定，没有「攒点数分配」这回事。
      //
      // 🔴 两条路径互斥（防双发放，经验系统改造 v1 2026-08-24）：
      //  · 本次 patch 触及 totalExp 或 ascension → 走下面的 applyPlayerProgression ——
      //    升级/登神全部由 exp-table 的纯函数判定，属性点/里程碑统一发放；
      //  · 否则 → 保留下面的旧兜底逻辑（兼容 AI 直接写 level/tier 的存量行为）。
      if (char.type === 'player' && !keys.includes('totalExp') && !keys.includes('ascension')) {
        // ① 升级：每升 1 级 +1 自由属性点
        //    双重发放 guard —— patch 自己写了 freeAttrPoints 时不再叠加，
        //    否则 AI 一边发点数一边升级，玩家会白拿一倍。
        if (
          typeof prevLevel === 'number' &&
          typeof char.level === 'number' &&
          !keys.includes('freeAttrPoints')
        ) {
          const levelGain = char.level - prevLevel;
          // 降级不回收（剧情降级/数据修正不该没收玩家已到手的点数）
          if (levelGain > 0) {
            char.freeAttrPoints = (char.freeAttrPoints ?? 0) + levelGain;
          }
        }

        // ② 升层：每升 1 层五维各 +1，钳到**新层级**上限
        //    同样的双重发放 guard —— patch 自己写了 attributes 时不再叠加。
        if (
          typeof prevTier === 'number' &&
          typeof char.tier === 'number' &&
          !keys.includes('attributes')
        ) {
          const tierGain = char.tier - prevTier;
          if (tierGain > 0) {
            // 层级配置查不到（越界层级/脏数据）时只加不钳 —— 少给上限强于把属性削掉
            const cap = getTierConfig(char.tier)?.attributeCap;
            const base = (char.attributes ?? {}) as Record<string, number>;
            const next: Record<string, number> = { ...base };
            for (const attr of ATTRIBUTE_KEYS) {
              const cur = typeof base[attr] === 'number' ? base[attr] : 0;
              const raw = cur + tierGain;
              // 钳制只封顶不回削 —— delta 五维加法不钳上限，已超上限的属性升层时不得被静默压低
              next[attr] = typeof cap === 'number' ? Math.max(cur, Math.min(raw, cap)) : raw;
            }
            char.attributes = next as CharacterState['attributes'];
          }
        }
      }
    }

    // ===== 经验系统改造 v1：totalExp / ascension 驱动的主角推进（升级循环 + 登神飞升）=====
    // 战斗（combat_v3）与制作（craft_gen）的经验都经 update_character delta 累加 totalExp；
    // 登神物（ascension 字段）由 AI 写入。这两条变化一落地，升级/登神就由 Code 统一接管。
    // 放在旧自动加点块之外、且在 value 落地之后 —— resolveLevelUps 读的是「落地后」的新状态。
    // 🔴 keys 是上面 `if (patch.value ...)` 块内的局部变量，这里在块外要用得重取一份。
    const touchedKeys =
      patch.value && typeof patch.value === 'object'
        ? Object.keys(patch.value as Record<string, any>)
        : [];
    if (
      char.type === 'player' &&
      (touchedKeys.includes('totalExp') || touchedKeys.includes('ascension'))
    ) {
      this.applyPlayerProgression(char);
    }
    // metadata.action 保留原行为: 有则覆盖 currentAction（可与 value.currentAction 并存，metadata 优先）
    char.currentAction = patch.metadata?.action ?? char.currentAction;
    await this.persistCharacter(char);

    return this.createEvent('character_action', patch);
  }

  /**
   * 主角经验/登神推进（经验系统改造 v1，2026-08-24）。
   *
   * 由 `applyUpdateCharacter` 在本次 patch 触及主角 `totalExp` 或 `ascension` 时调用。
   * 两段式（ADR-11：确定性数值规则归 Code，不交给 AI 算）：
   *  ① 登神飞升（`resolveAscensionFlyup`，主人裁定放宽版）：持物即飞升 + 层级-1 硬性限制 ——
   *     等级跳到目标层起点（13/17/21/25）、tier 同步，**顺便升级**（每级 +1 属性点 + 里程碑全属性+1）；
   *  ② 升级循环（`resolveLevelUps`）：totalExp 攒够就逐级升，里程碑全属性+1 且 tier 提升，
   *     关键等级（12/16/20/24）登神条件不满足时 totalExp 截断到当前级门槛。
   */
  private applyPlayerProgression(char: CharacterState): void {
    // 旧档经验保底归一化（幂等兜底，方案 A）：totalExp 抬到「升当前等级门槛」、expToNext 重算。
    // 加载时（game-store）已做过一次，这里再兜一道——任何 totalExp/ascension 提交路径都自愈。
    applyExpFloor(char);
    // ① 登神飞升（放宽版）
    const fly = resolveAscensionFlyup({ level: char.level, ascension: char.ascension });
    if (fly.flyup && fly.nextLevel !== undefined && fly.nextTier !== undefined) {
      const oldLevel = char.level;
      char.level = fly.nextLevel;
      char.tier = fly.nextTier;
      char.tierName = tierNameForTier(fly.nextTier);
      char.expToNext = xpToNextNumber(fly.nextLevel);
      // 顺便升级：每级 +1 自由属性点 + 里程碑全属性+1
      char.freeAttrPoints = (char.freeAttrPoints ?? 0) + (fly.nextLevel - oldLevel);
      for (let lv = oldLevel + 1; lv <= fly.nextLevel; lv++) {
        const milestone = MILESTONE_LEVELS[lv];
        if (milestone) {
          const base = (char.attributes ?? {}) as Record<string, number>;
          const next: Record<string, number> = { ...base };
          for (const attr of ATTRIBUTE_KEYS) {
            next[attr] =
              (typeof base[attr] === 'number' ? base[attr] : 0) + milestone.attributeBonus;
          }
          char.attributes = next as CharacterState['attributes'];
        }
      }
    }

    // ② 升级循环（totalExp 驱动）
    const res = resolveLevelUps({
      level: char.level,
      totalExp: char.totalExp,
      expToNext: char.expToNext,
      freeAttrPoints: char.freeAttrPoints,
      attributes: char.attributes,
      tier: char.tier,
      tierName: char.tierName,
      ascension: char.ascension,
    });
    char.level = res.level;
    char.totalExp = res.totalExp;
    char.expToNext = res.expToNext;
    char.freeAttrPoints = res.freeAttrPoints;
    char.attributes = res.attributes;
    char.tier = res.tier;
    char.tierName = res.tierName;
    if (res.ascensionBlocked) {
      console.info(
        `[StateManager] 登神长阶未开启，${char.name} 经验已封顶于 Lv.${res.level}（需持有对应登神物突破）`,
      );
    }
  }

  private async applySetResource(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const resource = patch.op.replace('set_', '') as ResourceKey;
    const maxField = RESOURCE_MAX_FIELD[resource];

    const newValue = Math.max(0, Math.min(patch.value as number, char[maxField]));
    char[resource] = newValue;
    await this.persistCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applyDeltaResource(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const resource = patch.op.replace('delta_', '') as ResourceKey;
    const maxField = RESOURCE_MAX_FIELD[resource];

    const current = char[resource];
    const delta = patch.amount ?? 0;
    const newValue = Math.max(0, Math.min(current + delta, char[maxField]));
    char[resource] = newValue;
    await this.persistCharacter(char);

    return this.createEvent('character_action', patch);
  }

  /**
   * add_status_effect — M2 按名寻址 (#4)
   *
   * value = { name(必), ... } — 不要求 id（AI 永不产 id，铁律1/3）
   * 同名叠层规则:
   * - stackable=false: 永远 1 层，只刷新时长（取 max；新效果永久则覆盖为永久）
   * - 其他（含缺省）: stacks 累加（缺省视作 1 层），有 maxStacks 则封顶
   * category 过 normalizeStatusCategory 归一（'buff' → '增益' 等，铁律5）
   */
  private async applyAddStatusEffect(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as Partial<StatusEffect>;
    if (!value?.name) throw new Error('add_status_effect 需要 value.name');

    const incomingStacks = typeof value.stacks === 'number' && value.stacks > 0 ? value.stacks : 1;

    // 刷新时长: 双方有限取 max；新效果永久(null) 覆盖为永久；未提供(undefined) 不动
    const refreshTime = (existing: StatusEffect): void => {
      if (value.remainingTime === undefined) return;
      if (value.remainingTime === null) {
        existing.remainingTime = null;
      } else if (existing.remainingTime == null) {
        // 遗留数据 remainingTime === undefined → 直接取来值，防 Math.max(undefined, n) 产 NaN（终审修复）
        // existing 已是永久(null) → 保持永久不覆盖
        if (existing.remainingTime === undefined) {
          existing.remainingTime = value.remainingTime;
        }
      } else {
        existing.remainingTime = Math.max(existing.remainingTime, value.remainingTime);
      }
    };

    const existing = findByName(char.statusEffects, value.name);
    if (existing) {
      if (existing.stackable === false) {
        // 不可叠加: 同名再施加不重复插入，保持 1 层，只刷新时长
        existing.stacks = 1;
        refreshTime(existing);
      } else {
        // 可叠加（含缺省）: 累加层数，有上限则封顶
        existing.stacks += incomingStacks;
        if (existing.maxStacks && existing.maxStacks > 0) {
          existing.stacks = Math.min(existing.stacks, existing.maxStacks);
        }
        refreshTime(existing);
      }
    } else {
      // 新效果: 不写 id（铁律1，id 字段 @deprecated），category 归一，缺省补账务字段
      const effect: StatusEffect = {
        name: value.name,
        description: value.description ?? '',
        category: normalizeStatusCategory(value.category ?? ''),
        stacks: incomingStacks,
        maxStacks: value.maxStacks,
        stackable: value.stackable,
        remainingTime: value.remainingTime ?? null,
        timeUnit: value.timeUnit ?? '分钟',
        source: value.source ?? '',
        effects: value.effects ?? {},
        effectDescriptions: value.effectDescriptions,
        scripts: value.scripts,
        onApply: value.onApply,
        onTick: value.onTick,
        onRemove: value.onRemove,
        onTrigger: value.onTrigger,
      };
      if (effect.maxStacks && effect.maxStacks > 0) {
        effect.stacks = Math.min(effect.stacks, effect.maxStacks);
      }
      char.statusEffects.push(effect);
    }
    await this.persistCharacter(char);

    return this.createEvent('status_effect', patch);
  }

  /**
   * remove_status_effect — M2 按名删除 (#22) / M3 统一 {name} 对象形态
   */
  private async applyRemoveStatusEffect(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const name = (patch.value as { name?: string })?.name;
    if (!name) throw new Error('remove_status_effect 需要 value.name');

    char.statusEffects = char.statusEffects.filter((e) => e.name !== name);
    await this.persistCharacter(char);

    return this.createEvent('status_effect', patch);
  }

  /**
   * add_item — M2 按名寻址 + 同名合并 (#5)
   *
   * value = { name(必), quantity?=1, type?, rarity?, description?, stats?,
   *           effects?, scripts?, equippedSlot?, durability?, maxDurability?, data? }
   * 同名合并: 只累加 quantity，既有字段不覆盖（改字段走 update_item）。
   * 归一化（铁律5）: type→normalizeItemType / rarity→normalizeRarity / equippedSlot→normalizeSlot
   * （equippedSlot 无法识别 → null，不 throw，物品视作躺背包）。
   */
  private async applyAddItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as Partial<InventoryItem>;
    if (!value?.name) throw new Error('add_item 需要 value.name');

    const quantity = typeof value.quantity === 'number' && value.quantity > 0 ? value.quantity : 1;

    const existing = findByName(char.inventory, value.name);
    if (existing) {
      // 同名合并: 只累加数量，不动既有字段
      existing.quantity += quantity;
    } else {
      // 新物品: 不写 id（铁律1，id @deprecated），枚举字段归一
      char.inventory.push({
        name: value.name,
        quantity,
        description: value.description,
        type: value.type !== undefined ? normalizeItemType(value.type) : undefined,
        rarity: value.rarity !== undefined ? normalizeRarity(value.rarity) : undefined,
        equippedSlot:
          value.equippedSlot != null ? normalizeSlot(value.equippedSlot) : value.equippedSlot,
        stats: value.stats,
        durability: value.durability,
        maxDurability: value.maxDurability,
        data: value.data,
        effects: value.effects,
        scripts: value.scripts,
        // 🆕 词条效果链路修复（S1，见 2026-08-01-item-gen-combat-link-plan.md）：
        //     craft_gen→item_gen 产物 + item_gen 独立链都在 patch.value 写 modifiers/buffs/divinity，
        //     此前落库只收 9 字段把这三个丢了 → 装备词条效果战斗/制造都不生效。现补齐。
        modifiers: value.modifiers,
        buffs: value.buffs,
        divinity: value.divinity,
        // 🆕 战斗 v3 (S3 2026-08-01): <automaton> DSL 自由效果落库保留（compileEffectProgram 编译进 activeEffects）
        automata: value.automata,
      });
    }
    await this.persistCharacter(char);

    return this.createEvent('item_use', patch);
  }

  /**
   * remove_item — M2 按名寻址 / M3 统一 {name, quantity?} 对象形态 (#5 #35)
   *
   * 扣减 ≤0 时 splice 删除条目；找不到 → throw 进 errors[]（杀静默失败）。
   */
  private async applyRemoveItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as { name?: string; quantity?: number };
    const name = value?.name;
    const qty = value?.quantity ?? 1;
    if (!name) throw new Error('remove_item 需要 value.name');

    const idx = char.inventory.findIndex((i) => i.name === name);
    if (idx < 0) throw new Error(`物品不存在: ${name}`);

    // 🔒 P1-07: 删除前验证库存总量 —— 此前 qty > 持有时扣到负数再 splice，静默吞错，
    // 上游（craft_settle 等）拿到的 patchesApplied 无法反映材料不够。现在库存不足直接抛错。
    if (char.inventory[idx].quantity < qty) {
      throw new Error(`物品「${name}」库存不足: 持有 ${char.inventory[idx].quantity}，需要 ${qty}`);
    }
    char.inventory[idx].quantity -= qty;
    if (char.inventory[idx].quantity === 0) {
      char.inventory.splice(idx, 1);
    }
    await this.persistCharacter(char);

    return this.createEvent('item_use', patch);
  }

  /**
   * update_item — M2 新增，按名修改 (#5 #21)
   *
   * value = { name(必), changes: Partial<InventoryItem> }
   * changes 白名单禁 name/quantity（改名走删加，数量走 add/remove）→ throw 进 errors[]。
   * changes 里的 id 剥离（铁律1）；type/rarity/equippedSlot 归一化（铁律5）。
   */
  private async applyUpdateItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const update = patch.value as { name?: string; changes?: Partial<InventoryItem> };
    if (!update?.name) throw new Error('update_item 需要 value.name');

    const item = findByName(char.inventory, update.name);
    if (!item) throw new Error(`物品不存在: ${update.name}`);

    const rawChanges = update.changes ?? {};
    if ('name' in rawChanges)
      throw new Error('update_item 禁止改 name（改名走 remove_item + add_item）');
    if ('quantity' in rawChanges)
      throw new Error('update_item 禁止改 quantity（数量走 add_item / remove_item）');

    // id 剥离（铁律1）+ 枚举字段归一化（铁律5）
    const { id: _ignoredId, ...changes } = rawChanges;
    if (changes.type !== undefined) changes.type = normalizeItemType(changes.type);
    if (changes.rarity !== undefined) changes.rarity = normalizeRarity(changes.rarity);
    if (changes.equippedSlot != null) changes.equippedSlot = normalizeSlot(changes.equippedSlot);
    Object.assign(item, changes);
    await this.persistCharacter(char);

    return this.createEvent('item_use', patch);
  }

  /**
   * transfer_item — M2 新增，原子转移 (#5)
   *
   * target = characters.<甲>  value = { name(必), to: '<乙名>', quantity?=1 }
   * 原子性: 先全部校验（甲乙都解析成功 + 甲有该物品且数量足够）再变更，
   * 任一校验失败整体不动 → throw 进 errors[]；双方通过 saveCharacters 一次事务落库。
   */
  private async applyTransferItem(patch: StatePatch): Promise<GameEvent> {
    const from = await this.resolveCharTarget(patch.target);

    const value = patch.value as { name?: string; to?: string; quantity?: number };
    if (!value?.name) throw new Error('transfer_item 需要 value.name');
    if (!value.to) throw new Error('transfer_item 需要 value.to（接收方名字）');
    const qty = typeof value.quantity === 'number' && value.quantity > 0 ? value.quantity : 1;

    // ── 校验阶段: 任一失败在此 throw，尚未发生任何变更 ──
    const to = await this.resolveCharacter(value.to); // 乙不存在 → throw，甲不动

    // 自转移防复制: 甲乙为同一角色时 bulkPut 同主键后写覆盖前写，会凭空复制物品
    if (to.id === from.id) {
      throw new Error(`transfer_item 不允许自我转移: ${from.name}`);
    }
    const idx = from.inventory.findIndex((i) => i.name === value.name);
    if (idx < 0) throw new Error(`物品不存在: ${value.name}`);
    if (from.inventory[idx].quantity < qty) {
      throw new Error(
        `物品数量不足: ${value.name}（持有 ${from.inventory[idx].quantity}，需 ${qty}）`,
      );
    }

    // ── 变更阶段: 校验全过后才动内存，双方一次事务落库 ──
    const source = from.inventory[idx];
    const received = findByName(to.inventory, value.name);
    if (received) {
      received.quantity += qty; // 乙同名合并
    } else {
      // 乙新增: 物品字段随转移带过去，剥离 id（铁律1）
      const { id: _ignoredId, ...fields } = source;
      to.inventory.push({ ...fields, quantity: qty, equippedSlot: null });
    }
    source.quantity -= qty;
    if (source.quantity <= 0) {
      from.inventory.splice(idx, 1);
    }
    // 双方进同一份脏表 → 出口那次 bulkPut 仍是 Dexie 单事务，避免半持久化
    await this.persistCharacters([from, to]);

    return this.createEvent('item_use', patch);
  }

  /**
   * equip_item — M2 equippedSlot 单真源 (#10 #23 #24, 规范 §3)
   *
   * value = { name(必), slot(必) }
   * 装备不是独立实体，是物品的状态: 穿=设 inventory[].equippedSlot，零数据搬运。
   * slot 过 normalizeSlot（铁律5），无法识别 → throw 进 errors[]。
   * quantity>1 拒绝直接穿（堆叠穿戴互斥，提示先拆分）。
   * 同槽已有穿戴者 → 自动脱下（仅清其 equippedSlot，字段无损）。
   */
  private async applyEquipItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as { name?: string; slot?: string };
    if (!value?.name) throw new Error('equip_item 需要 value.name');
    if (!value.slot) throw new Error('equip_item 需要 value.slot');

    const slot = normalizeSlot(value.slot);
    if (!slot) throw new Error(`无法识别的装备槽位: ${value.slot}`);

    const item = findByName(char.inventory, value.name);
    if (!item) throw new Error(`物品不存在: ${value.name}`);

    // 堆叠穿戴互斥: 堆叠物品穿上后 quantity 语义会撕裂（穿 1 件还是 5 件？）
    if (item.quantity > 1) {
      throw new Error(
        `堆叠物品不可直接穿戴: ${value.name}（数量 ${item.quantity}），请先拆分为单件`,
      );
    }

    // 同槽顶替: 仅清旧穿戴者的 equippedSlot，物品留在背包字段无损（杀 #10 有损穿脱）
    for (const other of char.inventory) {
      if (other !== item && other.equippedSlot === slot) {
        other.equippedSlot = null;
      }
    }

    item.equippedSlot = slot;
    await this.persistCharacter(char);

    // Q-07：装备时接线 —— init 脚本 + $event.on 持久订阅（战斗外效果系统）
    try {
      const { wireObject, ownerKeyOf } = await import('./effect-wiring');
      const unsub = wireObject(this.saveId, char, 'item', item.name, item.scripts);
      // 暂存注销函数，供同物品卸下时用（挂内存，不落库）
      if (unsub) {
        this._itemUnsubs.set(ownerKeyOf(char.id, 'item', item.name), unsub);
      }
    } catch (err) {
      console.warn('[StateManager] equip_item 效果接线失败（不阻断落库）:', err);
    }

    return this.createEvent('item_use', patch);
  }

  /**
   * unequip_item — M2/M3 equippedSlot 单真源 (#10 #23 #24, 规范 §3)
   *
   * value = { name } 或 { slot }（按 slot 找当前穿戴者，slot 先归一化）
   * 脱=清 equippedSlot，零数据搬运。找不到（无此物品 / 该槽无穿戴）→ throw 进 errors[]。
   */
  private async applyUnequipItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as { name?: string; slot?: string };
    let item: InventoryItem | undefined;

    if (value?.name) {
      // 按名脱
      item = findByName(char.inventory, value.name);
      if (!item) throw new Error(`物品不存在: ${value.name}`);
    } else if (value?.slot) {
      // 按槽脱: slot 先归一化再匹配穿戴者（铁律5）
      const slot = normalizeSlot(value.slot);
      if (!slot) throw new Error(`无法识别的装备槽位: ${value.slot}`);
      item = char.inventory.find((i) => i.equippedSlot === slot);
      if (!item) throw new Error(`该槽位无穿戴: ${slot}`);
    } else {
      throw new Error('unequip_item 需要 value.name 或 value.slot');
    }

    item.equippedSlot = null;
    await this.persistCharacter(char);

    // Q-07：卸下时拆除接线 —— cleanup 脚本 + 注销 $event.on 持久订阅
    try {
      const { unwireObject, ownerKeyOf } = await import('./effect-wiring');
      const unsub = this._itemUnsubs.get(ownerKeyOf(char.id, 'item', item.name));
      if (unsub) {
        unsub();
        this._itemUnsubs.delete(ownerKeyOf(char.id, 'item', item.name));
      }
      unwireObject(this.saveId, char, 'item', item.name, item.scripts);
    } catch (err) {
      console.warn('[StateManager] unequip_item 效果拆除失败（不阻断落库）:', err);
    }

    return this.createEvent('item_use', patch);
  }

  /**
   * add_skill — M2 按名寻址 (#4)
   *
   * value = { name(必), ... } — 不要求 id（AI 永不产 id，铁律1/3）
   * 同名 = 覆盖升级（规范 §4）: 提供的字段逐一覆盖既有技能，
   * 未提供的字段保留原值（merge 语义，不整体替换、不重复插入）。
   */
  private async applyAddSkill(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as Partial<Skill>;
    if (!value?.name) throw new Error('add_skill 需要 value.name');

    // 剥离 id: 无论上游是否夹带，引擎不再读写技能 id（铁律1，id @deprecated）
    const { id: _ignoredId, ...fields } = value;

    const existing = findByName(char.skills, value.name);
    if (existing) {
      // 同名覆盖升级: 只覆盖提供的字段，未提供的保留
      Object.assign(existing, fields);
    } else {
      // 新技能: 不写 id，补账务缺省
      char.skills.push({
        name: value.name,
        description: value.description ?? '',
        type: value.type ?? 'active',
        cost: value.cost,
        cooldown: value.cooldown,
        maxCooldown: value.maxCooldown,
        level: value.level,
        effects: value.effects,
        scripts: value.scripts,
        // 🔴 2026-08-02 修: 补战斗声明透传 —— 此前只收 8 字段丢 modifiers/buffs/divinity/automata，
        //   item_gen 合法产出的技能 modifiers（如高等材料学 checkType:"生产" bonus:4）落库即丢，
        //   生产检定加值不生效。与 applyAddItem（S1/S3 已补）对齐。
        modifiers: value.modifiers,
        buffs: value.buffs,
        divinity: value.divinity,
        automata: value.automata,
        // 🆕 skillPower 链路修复 (2026-08-04 漏网 2026-08-12): 主体威力三字段透传。
        //   0694453 只补了 char_gen 链路的 assembleCharacterState，本入口（request_dispatcher →
        //   item_gen 独立链的 add_skill patch 同样带这三字段）的新技能白名单漏收 →
        //   开局初始技能（火球术等）落库后 skillPower/relevantAttribute/damageType 全丢，
        //   characterToCombatParticipant 按 typeof 过滤踢出 activeSkills，战斗兜底 0 伤害。
        skillPower: value.skillPower,
        relevantAttribute: value.relevantAttribute,
        damageType: value.damageType,
      });
    }
    await this.persistCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  /**
   * update_skill — M2 按名寻址 (#4)
   *
   * value = { name, changes } — 旧 { skillId, changes } 形状不再支持。
   * 技能不存在 → throw 进 errors[]。
   */
  private async applyUpdateSkill(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const update = patch.value as { name?: string; changes?: Partial<Skill> };
    if (!update?.name) throw new Error('update_skill 需要 value.name');

    const skill = findByName(char.skills, update.name);
    if (!skill) throw new Error(`技能不存在: ${update.name}`);

    // changes 里的 id 同样剥离（铁律1）
    const { id: _ignoredId, ...changes } = update.changes ?? {};
    Object.assign(skill, changes);
    await this.persistCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  /**
   * remove_skill — M2 新增，按名删除 (#4 #21)
   *
   * value = { name } — 删除不存在的技能 throw 进 errors[]
   * （替代旧世界的 removeSkill 假字段路径，#21）。
   */
  private async applyRemoveSkill(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const name = (patch.value as { name?: string })?.name;
    if (!name) throw new Error('remove_skill 需要 value.name');

    if (!findByName(char.skills, name)) throw new Error(`技能不存在: ${name}`);

    char.skills = char.skills.filter((s) => s.name !== name);
    await this.persistCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  private async applySetLocation(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    char.location = String(patch.value);
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

    // 名字是逻辑键（铁律1）: 非空必填（终审修复）
    const name = typeof character.name === 'string' ? character.name.trim() : '';
    if (!name) throw new Error('add_character 需要非空 name（名字是逻辑键，铁律1）');

    // 同存档同名查重（排除同 id 重放 — Dexie put 幂等覆盖无害），与 rename_character 查重口径一致（终审修复）
    // 查的是缓存那份：同一次提交里连着加两个同名角色，第二个必须被这里拦下（不变式③）
    const chars = await this.readCharacters();
    const clash = chars.find((c) => c.name === name && c.id !== character.id);
    if (clash) throw new Error(`同名角色已存在: ${name}`);

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
    const newName = patch.value.trim();
    if (!newName) throw new Error('rename_character 新名不能为空');

    // M4: resolveCharTarget 仅在本存档内按名解析，跨档命中已无可能（旧守卫随之拆除）
    const char = await this.resolveCharTarget(patch.target);
    const oldName = char.name;

    // 幂等: 新名等于旧名 → no-op 成功
    if (newName === oldName) {
      return this.createEvent('system', patch);
    }

    // 同存档新名查重（排除自身 — 自己改自己的名不算撞名，上面已 no-op 短路）
    const chars = await this.readCharacters();
    const clash = chars.find((c) => c.name === newName && c.id !== char.id);
    if (clash) {
      throw new Error(`rename_character 新名已被占用: ${newName}`);
    }

    // 改名落库
    char.name = newName;
    await this.persistCharacter(char);

    // 按名引用迁移 — 当前仅 affections（M5/M6 新增按名引用时必须回来扩这里）
    const profile = await this.readProfile();
    if (profile?.affections && Object.prototype.hasOwnProperty.call(profile.affections, oldName)) {
      profile.affections[newName] = profile.affections[oldName];
      delete profile.affections[oldName];
      await this.persistProfile(profile);
    }

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

  private async applyUpdateQuest(patch: StatePatch): Promise<GameEvent> {
    const questData = patch.value as { name: string } & Record<string, any>;
    const questName = questData.name;
    if (!questName) throw new Error('缺少任务名称');
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    // M6 #52: 用 delete 剔除寻址键，替代 `{ name: _name, ...rest }` 的未用解构 + eslint-disable
    const questFields: Record<string, any> = { ...questData };
    delete questFields.name;
    // #32: status 自由字符串归一化（'active'/'done' 等别名 → 中文枚举）
    if (questFields.status !== undefined) {
      questFields.status = normalizeQuestStatus(questFields.status);
    }
    // 合并语义留在 save-profile 一处（`setQuestInPlace`），落库那一拍由提交出口统一做
    setQuestInPlace(profile, questName, questFields);
    await this.persistProfile(profile);
    return this.createEvent('quest_update', patch);
  }

  private async applyRemoveQuest(patch: StatePatch): Promise<GameEvent> {
    // #40: value 形态统一为 {name} 对象（与 update_quest 对齐）
    const questName = (patch.value as { name?: string })?.name;
    if (!questName) throw new Error('缺少任务名称');
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    removeQuestInPlace(profile, questName);
    await this.persistProfile(profile);
    return this.createEvent('quest_update', patch);
  }

  // ========== 好感度 / 新闻 (M2 T10, #15 #16 — 写 SaveProfile，非 CharacterState) ==========

  /**
   * set_affection / delta_affection — 好感度写入 (规范 §7)
   *
   * target 形态: `affections.<角色名>` — 名字是 profile.affections 的自由键，
   * 不经 resolveCharacter（好感度键无需角色实体存在）。
   * clamp 到 [-100, +100]（复用 affection-system 的 clampAffection）。
   */
  private async applyAffection(patch: StatePatch): Promise<GameEvent> {
    // 解析 target: 必须是 affections.<名> 且名字非空
    const AFFECTION_PREFIX = 'affections.';
    if (!patch.target.startsWith(AFFECTION_PREFIX)) {
      throw new Error(`${patch.op} target 必须为 affections.<角色名> 格式: ${patch.target}`);
    }
    const charName = patch.target.slice(AFFECTION_PREFIX.length).trim();
    if (!charName) throw new Error(`${patch.op} target 缺少角色名: ${patch.target}`);
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);

    if (patch.op === 'set_affection') {
      // 绝对值设置 — value 必须是数字
      if (typeof patch.value !== 'number' || Number.isNaN(patch.value)) {
        throw new Error(`set_affection value 必须是数字: ${JSON.stringify(patch.value)}`);
      }
      profile.affections[charName] = clampAffection(patch.value);
    } else {
      // 增量 — amount 必须是数字（与 set_affection 守卫一致，终审修复），现值缺省 0 起算，加完再 clamp（双向）
      if (typeof patch.amount !== 'number' || Number.isNaN(patch.amount)) {
        throw new Error(`delta_affection amount 必须是数字: ${JSON.stringify(patch.amount)}`);
      }
      const current = profile.affections[charName] ?? 0;
      profile.affections[charName] = clampAffection(current + patch.amount);
    }

    await this.persistProfile(profile);
    // GameEventType 无 affection 成员（M1 实测），走 'system'
    return this.createEvent('system', patch);
  }

  /**
   * add_news — 追加世界新闻 (规范 §8)
   *
   * AI 只填叙事字段 {title(必), content(必), category?}；
   * Code 补账务字段 id / publishedAt / read（铁律3）。
   */
  private async applyAddNews(patch: StatePatch): Promise<GameEvent> {
    const newsData = patch.value as { title?: string; content?: string; category?: string };
    if (!newsData?.title) throw new Error('add_news 缺少 title');
    if (!newsData.content) throw new Error('add_news 缺少 content');
    const profile = await this.readProfile();
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);

    profile.news.push({
      title: newsData.title,
      content: newsData.content,
      category: newsData.category ?? '',
      // Code 补账务字段
      id: crypto.randomUUID(),
      publishedAt: Date.now(),
      read: false,
    });

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
    }
  }

  /**
   * 按期结算钩子（§4 时间账本）—— `applyTimeAdvance` 推进完时间后调用，**在锁内**。
   *
   * 三件事，缺一不可:
   *   ① 纯函数结算 `(prevDay, nextDay]` 区间（到期 / 周期效果 / 收益），整份覆盖回事实袋子；
   *   ② `incomeDue` → 玩家 `money` 的 delta patch **push 进调用方的 `patches[]`**
   *      —— 那个数组由 `applyTimeAdvance` 在**锁外**自提交（ADR-21 唯一写入口）。
   *      这里绝不自己调 `commitChatState`：锁内嵌套提交 = 同 saveId 自等死锁（铁律②）。
   *   ③ 结构化事件 → 中文新闻（措辞在本接线层，`map-dynamics` 零中文字面量的原因）。
   *
   * 🔴 **休眠地块整块冻结**（§3）：`resolveTile` 认不出的名字返回 `undefined`，纯函数据此跳过。
   *    换包再换回来时那座玩家酒馆不会一次性补上几十期收益。
   */
  private async syncMapFactsSettlement(
    profile: SaveProfile,
    prevDay: number,
    patches: StatePatch[],
  ): Promise<void> {
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
      await updateMapFactsFlags(profile, settled.facts);

      // ── 收益入账：每座建筑一条 delta patch（总额 = 每期金额 × 补结算期数） ──
      const player = (await this.readCharacters()).find((c) => c.type === 'player');
      if (player !== undefined) {
        for (const { event } of settled.events) {
          if (event.kind !== 'incomeDue') continue;
          patches.push({
            op: 'update_character',
            target: `characters.${player.name}`,
            value: { money: event.amount * event.periods },
            metadata: { source: 'map_dynamics', delta: true },
          });
        }
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
  async createSnapshot(reason: Snapshot['reason'], turn: number): Promise<Snapshot> {
    // 🔴 并行化改造：快照 = 读全表 + 写快照行 + 改 activeSnapshotId + trim 的整段
    // RMW 区段，整段互斥（与提交 / advanceTurn 交错会留下「快照与状态不一致」）。
    // 内部只调裸 DB 函数，无嵌套入队（铁律②）。
    return withSaveWriteLock(this.saveId, async () => {
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

      return snapshot;
    });
  }

  /**
   * 回合推进 — GamePipeline 每轮管线成功后调用 (M5 Task 4, 杀 #27)
   *
   * totalTurns 语义 = 已完成的对话回合数（每轮管线恰 +1，不再随每次 commit 虚高），
   * 随后打一张 reason='turn' 的回合快照（turn = 新回合数，恢复时按此截断消息）。
   */
  async advanceTurn(): Promise<void> {
    let newTotalTurns = 1;
    // 🔴 并行化改造：totalTurns 读-改-写是一段 RMW 区段，整段互斥（与 commitChatState
    // 尾部的 saveSaveSlot 争同一条 save 记录，交错会互相覆盖 totalTurns）。
    // createSnapshot 自带锁（它也被战斗 pre-combat 直接调用），必须在锁外调用，
    // 否则同 saveId 嵌套自等死锁（state-write-queue 铁律②）。
    await withSaveWriteLock(this.saveId, async () => {
      const save = await getSave(this.saveId);
      if (save) {
        newTotalTurns = (save.metadata.totalTurns ?? 0) + 1;
        save.metadata.totalTurns = newTotalTurns;
        await saveSaveSlot(save);
      }
    });
    await this.createSnapshot('turn', newTotalTurns);
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
            db.saveProfiles,
            db.plotEvents,
            db.messages,
            db.memories,
            db.saves,
            db.snapshots,
            // v22 拆表：④.c 的 deleteSnapshotsAfter 要连载荷行一起删，表清单必须带上它
            db.snapshotPayloads,
          ],
          async () => {
            // ② characters 整体覆写: 全删 → 写入快照副本
            //    structuredClone 防库内对象与快照对象引用共享（快照需保持不可变，可重复恢复）
            const current = await getCharacters(this.saveId);
            for (const c of current) {
              await deleteCharacter(c.id);
            }
            await saveCharacters(structuredClone(snapshot.characters));

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

      // emit 形状照 `applyTimeAdvance` 末尾那条（真 push 进 this.events，不是只构造），
      // 再走一次 `reactToEvents` —— 效果系统的 `$event.on('random_event')` 订阅者要吃得到
      // （§5.2 步 5）。没接过线的存档在 `reactToEvents` 里零开销返回。
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
      await this.reactToEvents([event]);
    } catch (err) {
      // 事件系统只记「触发过」这一事实（铁则 5）；记不上不该让这一回合的正文崩掉
      console.warn('[StateManager] 随机事件触发结算失败（不影响正文）:', err);
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
      return { ok: false, error: '调试入池失败（详见控制台）' };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // 🆕 时间推进 & 状态效果结算 (Phase 7e+8)
  // ═══════════════════════════════════════════════════════════

  /**
   * 推进全局游戏时间，并自动结算所有角色的状态效果 remainingTime。
   *
   * @param minutes - 推进的分钟数
   * @returns 生成的 StatePatch[] (remove_status_effect + time update)
   */
  async applyTimeAdvance(minutes: number): Promise<StatePatch[]> {
    const patches: StatePatch[] = [];
    if (minutes <= 0) return patches;

    // 1. 更新 SaveProfile.gameTime
    const { getCharacters } = await import('./database');

    // 🔴 并行化改造：时间推进的全部 DB 工作（gameTime / 天气 / 随机事件 / 角色
    // 状态效果）是一段连续读-改-写区段，整段互斥；末尾的自提交 commitChatState
    // 刻意在锁外 —— 嵌套提交要重新排队拿锁，在锁内即自死锁（铁律②）。
    await withSaveWriteLock(this.saveId, async () => {
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
      //     排在掷骰之后是因为它会往 `patches` 里塞收益补丁，而那个数组在**锁外**统一自提交：
      //     锁内嵌套 commitChatState 就是同 saveId 自等死锁（state-write-queue 铁律②）
      await this.syncMapFactsSettlement(profile, prevDay, patches);

      // 2. 遍历所有角色, 扣减 StatusEffect.remainingTime
      const characters = await getCharacters(this.saveId);

      for (const char of characters) {
        let changed = false;
        const expired: StatusEffect[] = [];

        for (const fx of char.statusEffects) {
          // 永久效果跳过
          if (fx.remainingTime === null) continue;

          // 战斗回合效果跳过 (由 combat 系统管理)
          if (fx.timeUnit === '回合') continue;

          // 按时间单位扣减
          if (fx.timeUnit === '小时') {
            fx.remainingTime -= Math.floor(minutes / 60);
          } else {
            fx.remainingTime -= minutes;
          }
          changed = true;

          if (fx.remainingTime <= 0) {
            expired.push(fx);
          }
        }

        // 过期移除 — M2 按名删除（#22，旧数据带 id 也按 name 过滤，不受影响）
        for (const fx of expired) {
          // 执行 onRemove 脚本
          if (fx.onRemove && fx.scripts) {
            const { executeScript } = await import('./script-executor');
            const result = executeScript(fx.scripts[fx.onRemove]!, {
              owner: char.id,
              self: { stacks: fx.stacks, remainingTime: 0, name: fx.name },
            });
            patches.push(...(await convertScriptEffects(this.saveId, result)));
          }

          char.statusEffects = char.statusEffects.filter((e) => e.name !== fx.name);

          patches.push({
            op: 'remove_status_effect',
            target: `characters.${char.name}`,
            value: { name: fx.name },
          });

          // Q-02 修复：createEvent 只构造不落库，改 push 进 events（旧代码假 emit）
          this.events.push(
            this.createEvent('status_effect', {
              op: 'remove_status_effect',
              target: `characters.${char.name}`,
              value: { name: fx.name },
            }),
          );
        }

        // 时长扣减/移除的持久化走 saveCharacter（statusEffects 数组被 update_character 白名单
        // 禁止直写，防 AI 假字段污染；此处引擎内存内已 mutate，一条直写即可）。Q-02 修复的
        // 是 patches 里的脚本效果（remove/hp/stat）曾被调用点丢弃 —— 它们现在走末尾自提交。
        if (changed) {
          await saveCharacter(char);
        }
      }

      // 3. emit time_advanced（Q-02：改成真 push，旧代码 createEvent 不落库）
      this.events.push(
        this.createEvent('system', {
          op: 'set_variable',
          target: 'variables.gameTime',
          value: profile.gameTime,
        }),
      );
    });

    // Q-02 修复：自提交 —— 之前返回值在唯一调用点（agent-orchestrator.ts:854）被丢弃，
    // 到期效果的 remove/hp/stat 与 onRemove 脚本全部蒸发。这里在方法内提交，符合 ADR-21
    // 唯一写入口约定，调用点无需自己 commit。
    if (patches.length > 0) {
      await this.commitChatState(patches);
    }

    return patches;
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
// 辅助
// ═══════════════════════════════════════════════════════════

/**
 * 集合内按名字查找 — M2 铁律1（逻辑键=名字）的集合级辅助
 * 供各 op handler 在 inventory/skills/statusEffects 等列表中按名寻址。
 */
export function findByName<T extends { name: string }>(list: T[], name: string): T | undefined {
  return list.find((item) => item.name === name);
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

import type { ScriptEffects } from './script-executor';

async function convertScriptEffects(saveId: string, se: ScriptEffects): Promise<StatePatch[]> {
  const patches: StatePatch[] = [];
  // 名字解析唯一入口（铁律1：逻辑键=名字，charId 一律先换名）。
  // 脚本按名调用（modifyHp('Hero', -30)）是最常见路径，直接透传；id 形态才查库。
  const resolveName = async (charId: string): Promise<string> => {
    const chars = await getCharacters(saveId);
    const byName = chars.find((c) => c.name === charId);
    if (byName) return byName.name;
    if (charId === '主角' || charId === '玩家') {
      const player = chars.find((c) => c.type === 'player');
      if (player) return player.name;
    }
    return charId;
  };
  // M2: add_status_effect 不再要求 id → Partial<StatusEffect> 直接透传（handler 内按 name 寻址+补缺省）
  for (const a of se.adds)
    patches.push({
      op: 'add_status_effect',
      target: `characters.${await resolveName(a.charId)}`,
      value: a.effect,
    });
  // M2: effectId 字符串按 name 解释（remove handler 的裸字符串过渡形态）
  for (const r of se.removes)
    patches.push({
      op: 'remove_status_effect',
      target: `characters.${await resolveName(r.charId)}`,
      value: r.effectId,
    });
  // M2: 逻辑键=name（铁律1）— stackSets 的 effectId 按 name 解释（脚本层 $status.setStacks 过渡形态，M3 收敛）
  for (const s of se.stackSets)
    patches.push({
      op: 'set_variable',
      target: `characters.${await resolveName(s.charId)}.statusEffects`,
      value: { name: s.effectId, stacks: s.stacks },
    });
  // Q-02 修复：hpChanges 走 delta_hp（角色资源真源），不再用 delta_variable 写错 variables 树
  for (const h of se.hpChanges)
    patches.push({
      op: 'delta_hp',
      target: `characters.${await resolveName(h.charId)}`,
      amount: h.amount,
    } as unknown as StatePatch);
  // Q-02 修复：statChanges 走 update_character + metadata.delta（按名寻址，五维加法）
  for (const st of se.statChanges)
    patches.push({
      op: 'update_character',
      target: `characters.${await resolveName(st.charId)}`,
      value: { attributes: { [st.stat]: st.amount } },
      metadata: { delta: true },
    } as unknown as StatePatch);
  return patches;
}

// ═══════════════════════════════════════════════════════════
// 资源字段对（Q-19）
// ═══════════════════════════════════════════════════════════

/** 三种资源 */
const RESOURCE_KEYS = ['hp', 'mp', 'sp'] as const;
type ResourceKey = (typeof RESOURCE_KEYS)[number];

/**
 * 资源 → 它的上限字段。
 *
 * Q-19：此前是三处 `\`max\${res.charAt(0).toUpperCase()}…\`` 字符串拼接 + `as` 断言，
 * 读写一律 `(char as any)[k]`（10 处）。`satisfies` 让「字段名写错」变成编译错误 ——
 * 拼字符串那种写法编译器一个字都看不懂。
 */
const RESOURCE_MAX_FIELD = {
  hp: 'maxHp',
  mp: 'maxMp',
  sp: 'maxSp',
} as const satisfies Record<ResourceKey, keyof CharacterState>;

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
  set_variable: (sm, p) => sm['applySetVariable'](p),
  delta_variable: (sm, p) => sm['applyDeltaVariable'](p),
  remove_variable: (sm, p) => sm['applyRemoveVariable'](p),
  move_variable: (sm, p) => sm['applyMoveVariable'](p),
  insert_variable: (sm, p) => sm['applyInsertVariable'](p),
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
  update_quest: (sm, p) => sm['applyUpdateQuest'](p),
  remove_quest: (sm, p) => sm['applyRemoveQuest'](p),
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
