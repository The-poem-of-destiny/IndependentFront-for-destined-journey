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
  getPlotEvents,
  savePlotEvents,
  deletePlotEvent,
  getSave,
  saveSaveSlot,
  getSnapshot,
  saveSnapshot,
  trimSnapshots,
  getSettings,
  deleteMessagesAfterTurn,
  getDatabase,
} from './database';
import { getVar, setVar, delVar, insertVar, applyPathOps } from './var-resolver';
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

    const results: PatchApplicationResult[] = [];
    const errors: string[] = [];

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

    // Q-07：把本次产生的 GameEvent 发到存档 EventBus，触发已装备物品/技能的 $event.on 订阅，
    // 并把订阅脚本产出的效果转成补丁再提交一轮。此前这些事件只进 this.events（一个只被读取
    // 用于展示的数组），从未 publish —— 于是整条 emitChain 层永远空转。
    await this.reactToEvents(newEvents);

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

    return {
      success: errors.length === 0,
      patchesApplied: results.filter((r) => r.success).length,
      eventsGenerated: [...this.events],
      errors,
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

  // ========== Patch 应用 ==========

  private async applyPatch(patch: StatePatch): Promise<PatchApplicationResult> {
    // 验证 — 失败直接 throw → 被 commitChatState 的 try/catch 收进 errors[]（M2 语义修正）
    this.validatePatch(patch);

    // 分发
    let event: GameEvent | undefined;

    switch (patch.op) {
      case 'set_variable':
        event = await this.applySetVariable(patch);
        break;
      case 'delta_variable':
        event = await this.applyDeltaVariable(patch);
        break;
      case 'update_character':
        event = await this.applyUpdateCharacter(patch);
        break;
      case 'set_hp':
      case 'set_mp':
      case 'set_sp':
        event = await this.applySetResource(patch);
        break;
      case 'delta_hp':
      case 'delta_mp':
      case 'delta_sp':
        event = await this.applyDeltaResource(patch);
        break;
      case 'add_status_effect':
        event = await this.applyAddStatusEffect(patch);
        break;
      case 'remove_status_effect':
        event = await this.applyRemoveStatusEffect(patch);
        break;
      case 'add_item':
        event = await this.applyAddItem(patch);
        break;
      case 'remove_item':
        event = await this.applyRemoveItem(patch);
        break;
      case 'update_item':
        event = await this.applyUpdateItem(patch);
        break;
      case 'transfer_item':
        event = await this.applyTransferItem(patch);
        break;
      case 'equip_item':
        event = await this.applyEquipItem(patch);
        break;
      case 'unequip_item':
        event = await this.applyUnequipItem(patch);
        break;
      case 'add_skill':
        event = await this.applyAddSkill(patch);
        break;
      case 'update_skill':
        event = await this.applyUpdateSkill(patch);
        break;
      case 'remove_skill':
        event = await this.applyRemoveSkill(patch);
        break;
      case 'set_location':
        event = await this.applySetLocation(patch);
        break;
      case 'add_character':
        event = await this.applyAddCharacter(patch);
        break;
      case 'remove_character':
        event = await this.applyRemoveCharacter(patch);
        break;
      case 'rename_character':
        event = await this.applyRenameCharacter(patch);
        break;
      case 'add_memory':
        event = await this.applyAddMemory(patch);
        break;
      case 'update_plot_event':
        event = await this.applyUpdatePlotEvent(patch);
        break;
      case 'update_quest':
        event = await this.applyUpdateQuest(patch);
        break;
      case 'remove_quest':
        event = await this.applyRemoveQuest(patch);
        break;
      case 'set_affection':
      case 'delta_affection':
        event = await this.applyAffection(patch);
        break;
      case 'add_news':
        event = await this.applyAddNews(patch);
        break;
      case 'remove_variable':
        event = await this.applyRemoveVariable(patch);
        break;
      case 'move_variable':
        event = await this.applyMoveVariable(patch);
        break;
      case 'insert_variable':
        event = await this.applyInsertVariable(patch);
        break;
      default:
        // 未知 op 必须 loud 失败 → commitChatState 收进 errors[]（终审修复: 旧 return 形态被上层当成功吞掉）
        throw new Error(`未知操作: ${patch.op}`);
    }

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
    const chars = await getCharacters(this.saveId);

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
    const { getProfile } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
    return profile.variables ?? {};
  }

  /** 持久化变量到 SaveProfile */
  private async persistVariables(variables: Record<string, any>): Promise<void> {
    const { getProfile, updateProfile } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
    profile.variables = variables;
    await updateProfile(profile);
  }

  private async applyUpdateCharacter(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    if (patch.value && typeof patch.value === 'object') {
      const value = patch.value as Record<string, any>;
      const keys = Object.keys(value);
      const isDelta = patch.metadata?.delta === true;

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
      for (const res of ['hp', 'mp', 'sp'] as const) {
        const maxField = `max${res.charAt(0).toUpperCase()}${res.slice(1)}` as
          'maxHp' | 'maxMp' | 'maxSp';
        if (keys.includes(res) || keys.includes(maxField)) {
          const cur = (char as any)[res];
          const max = (char as any)[maxField];
          if (typeof cur === 'number' && typeof max === 'number') {
            (char as any)[res] = Math.max(0, Math.min(cur, max));
          }
        }
      }
    }
    // metadata.action 保留原行为: 有则覆盖 currentAction（可与 value.currentAction 并存，metadata 优先）
    char.currentAction = patch.metadata?.action ?? char.currentAction;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applySetResource(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const resource = patch.op.replace('set_', '') as 'hp' | 'mp' | 'sp';
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as
      'maxHp' | 'maxMp' | 'maxSp';

    const newValue = Math.max(0, Math.min(patch.value as number, (char as any)[maxField]));
    (char as any)[resource] = newValue;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applyDeltaResource(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const resource = patch.op.replace('delta_', '') as 'hp' | 'mp' | 'sp';
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as
      'maxHp' | 'maxMp' | 'maxSp';

    const current = (char as any)[resource] as number;
    const delta = patch.amount ?? 0;
    const newValue = Math.max(0, Math.min(current + delta, (char as any)[maxField]));
    (char as any)[resource] = newValue;
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacters([from, to]); // Dexie bulkPut 单事务，避免半持久化

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
    await saveCharacter(char);

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
    await saveCharacter(char);

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
      });
    }
    await saveCharacter(char);

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
    await saveCharacter(char);

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
    await saveCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  private async applySetLocation(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    char.location = String(patch.value);
    await saveCharacter(char);

    return this.createEvent('location_change', patch);
  }

  private async applyAddCharacter(patch: StatePatch): Promise<GameEvent> {
    const character = patch.value as CharacterState;
    if (!character?.id) throw new Error('缺少角色数据');

    // 名字是逻辑键（铁律1）: 非空必填（终审修复）
    const name = typeof character.name === 'string' ? character.name.trim() : '';
    if (!name) throw new Error('add_character 需要非空 name（名字是逻辑键，铁律1）');

    // 同存档同名查重（排除同 id 重放 — Dexie put 幂等覆盖无害），与 rename_character 查重口径一致（终审修复）
    const chars = await getCharacters(this.saveId);
    const clash = chars.find((c) => c.name === name && c.id !== character.id);
    if (clash) throw new Error(`同名角色已存在: ${name}`);

    // 铁律3: saveId 是账务字段，由 Code 无条件注入，不信任上游 patch 构造方 (#8/M2硬前置②)
    // M6 T2: customFields.saveId 双写已退役 — saveId 单源一等字段
    character.saveId = this.saveId;

    await saveCharacter(character);
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
    await deleteCharacter(char.id);
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
    const chars = await getCharacters(this.saveId);
    const clash = chars.find((c) => c.name === newName && c.id !== char.id);
    if (clash) {
      throw new Error(`rename_character 新名已被占用: ${newName}`);
    }

    // 改名落库
    char.name = newName;
    await saveCharacter(char);

    // 按名引用迁移 — 当前仅 affections（M5/M6 新增按名引用时必须回来扩这里）
    const { getProfile, updateProfile } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
    if (profile?.affections && Object.prototype.hasOwnProperty.call(profile.affections, oldName)) {
      profile.affections[newName] = profile.affections[oldName];
      delete profile.affections[oldName];
      await updateProfile(profile);
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
    const { getProfile, setQuest } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    // M6 #52: 用 delete 剔除寻址键，替代 `{ name: _name, ...rest }` 的未用解构 + eslint-disable
    const questFields: Record<string, any> = { ...questData };
    delete questFields.name;
    // #32: status 自由字符串归一化（'active'/'done' 等别名 → 中文枚举）
    if (questFields.status !== undefined) {
      questFields.status = normalizeQuestStatus(questFields.status);
    }
    await setQuest(profile, questName, questFields);
    return this.createEvent('quest_update', patch);
  }

  private async applyRemoveQuest(patch: StatePatch): Promise<GameEvent> {
    // #40: value 形态统一为 {name} 对象（与 update_quest 对齐）
    const questName = (patch.value as { name?: string })?.name;
    if (!questName) throw new Error('缺少任务名称');
    const { getProfile, removeQuest } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
    if (!profile) throw new Error(`SaveProfile 不存在: ${this.saveId}`);
    await removeQuest(profile, questName);
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

    const { clampAffection } = await import('./affection-system');
    const { getProfile, updateProfile } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
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

    await updateProfile(profile);
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

    const { getProfile, updateProfile } = await import('./save-profile');
    const profile = await getProfile(this.saveId);
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

    await updateProfile(profile);
    return this.createEvent('system', patch);
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
    const { getProfile } = await import('./save-profile');
    const characters = await getCharacters(this.saveId);
    const profile = await getProfile(this.saveId);
    const plotEvents = await getPlotEvents(this.saveId);

    const snapshot: Snapshot = {
      id: crypto.randomUUID(),
      saveId: this.saveId,
      createdAt: Date.now(),
      reason,
      turn,
      characters: structuredClone(characters),
      saveProfile: structuredClone(profile),
      plotEvents: structuredClone(plotEvents),
    };

    await saveSnapshot(snapshot);

    // activeSnapshotId 指向最新快照
    const save = await getSave(this.saveId);
    if (save) {
      save.activeSnapshotId = snapshot.id;
      await saveSaveSlot(save);
    }

    // 滚动上限 + 保留模式（读 settings；缺省 30 / tiered）
    const settings = await getSettings();
    const maxSnapshots = settings?.maxSnapshotsPerSave ?? 30;
    const retentionMode = settings?.snapshotRetentionMode ?? 'tiered';
    await trimSnapshots(this.saveId, maxSnapshots, retentionMode);

    return snapshot;
  }

  /**
   * 回合推进 — GamePipeline 每轮管线成功后调用 (M5 Task 4, 杀 #27)
   *
   * totalTurns 语义 = 已完成的对话回合数（每轮管线恰 +1，不再随每次 commit 虚高），
   * 随后打一张 reason='turn' 的回合快照（turn = 新回合数，恢复时按此截断消息）。
   */
  async advanceTurn(): Promise<void> {
    let newTotalTurns = 1;
    const save = await getSave(this.saveId);
    if (save) {
      newTotalTurns = (save.metadata.totalTurns ?? 0) + 1;
      save.metadata.totalTurns = newTotalTurns;
      await saveSaveSlot(save);
    }
    await this.createSnapshot('turn', newTotalTurns);
  }

  /**
   * 恢复快照 — 整体覆写 + 对话回滚 (M5 规范 §11.2, #2 恢复死路径根治)
   *
   * ① 按 id 读快照 + saveId 校验（防跨档恢复）
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
      // ① 读快照 + 防跨档校验
      const snapshot = await getSnapshot(snapshotId);
      if (!snapshot) throw new Error(`快照不存在: ${snapshotId}`);
      if (snapshot.saveId !== this.saveId) {
        throw new Error(`快照不属于当前存档: ${snapshot.saveId}（当前 ${this.saveId}）`);
      }

      // 🔒 P1-06: 单事务覆盖所有被修改的表 —— 快照恢复此前是顺序多步独立 DB 操作，
      // 后段失败会留下部分恢复状态（如角色已覆写但对话/记忆未回滚）。包进单事务后任一步
      // 抛错 Dexie 自动回滚全表，恢复要么完整成功要么完全不动。
      const { updateProfile } = await import('./save-profile');
      const db = getDatabase();
      await db.transaction(
        'rw',
        [db.characters, db.saveProfiles, db.plotEvents, db.messages, db.memories, db.saves],
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

          // ④ 对话回滚: 删除快照 turn 之后的消息
          await deleteMessagesAfterTurn(this.saveId, snapshot.turn);

          // ④.b 清理"未来"记忆（realTimestamp > 快照创建时间；记忆 append-only 安全）
          await deleteMemoriesAfter(this.saveId, snapshot.createdAt);

          // ⑤ activeSnapshotId 指向 + totalTurns 对齐快照 turn（防重发后 turn 编号错位）
          const save = await getSave(this.saveId);
          if (save) {
            save.activeSnapshotId = snapshot.id;
            save.metadata.totalTurns = snapshot.turn;
            await saveSaveSlot(save);
          }
        },
      );
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
    const { getProfile, updateProfile } = await import('./save-profile');
    const { advanceTime } = await import('./time-system');
    const { getCharacters } = await import('./database');

    const profile = await getProfile(this.saveId);
    profile.gameTime = advanceTime(profile.gameTime, minutes);
    await updateProfile(profile);

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
