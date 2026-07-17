/**
 * StateManager — 唯一状态写入入口 (ADR-21)
 *
 * Phase 4.5 核心模块。所有状态变更必须通过 commitChatState()。
 * 替代分散的 saveChat() / saveCharacter() / setVariables() 等直接操作。
 *
 * 职责:
 * 1. 接收 StatePatch[] → 验证 → 应用 → 持久化
 * 2. 自动生成 GameEvent 记录变更
 * 3. 快照管理（自动创建检查点）
 * 4. 事务性提交（全部成功或全部回滚）
 */

import type {
  StatePatch, StatePatchOp, StateCommitResult,
  GameEvent, CharacterState, MemoryRecord, PlotEvent,
  StatusEffect, Skill, InventoryItem,
} from './types';
import {
  getCharacter, getCharacters, saveCharacter, saveCharacters, deleteCharacter,
  getMemories, saveMemory,
  getPlotEvents, savePlotEvents,
  getSave, saveSaveSlot,
  getSnapshots, saveSnapshot, trimSnapshots,
  getSettings, getLatestSnapshot,
} from './database';
import type { SaveSlot } from './types';
import { getVar, setVar, delVar, insertVar } from './var-resolver';
import { normalizeQuestStatus, normalizeStatusCategory, normalizeItemType, normalizeRarity, normalizeSlot } from './field-enums';

// ========== Types ==========

export interface StateManagerConfig {
  saveId: string;
  /** 最大快照数 */
  maxSnapshots?: number;
  /** 是否自动创建快照 */
  autoSnapshot?: boolean;
  /** 每 N 个 patch 自动创建快照 */
  autoSnapshotInterval?: number;
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
  'type', 'race', 'identity', 'occupation',
  // 生命层级
  'tier', 'tierName', 'level', 'totalExp', 'expToNext',
  // 五维属性
  'attributes', 'freeAttrPoints',
  // 资源
  'hp', 'maxHp', 'mp', 'maxMp', 'sp', 'maxSp',
  // 登神长阶
  'ascension',
  // 经济 / 位置 / 冒险者等级 / 当前行为
  'money', 'location', 'adventurerRank', 'currentAction',
  // 血脉 / 集群数量 / 叙事字段
  'bloodlineIds', 'quantity',
  'appearance', 'background', 'personality', 'gender', 'outfit', 'thoughts',
  // 扩展字段
  'customFields',
]);

/** 禁止的数组实体字段 → 必须走各自专用 op（杀 #21 假字段污染） */
const UPDATE_CHAR_FORBIDDEN_ARRAY_FIELDS = new Set<string>([
  'inventory', 'skills', 'statusEffects', 'equipment', // equipment 在 M2 T12 删除前同样禁止
]);

/** 禁止的账务字段 — 仅 Code 层维护（铁律3） */
const UPDATE_CHAR_FORBIDDEN_LEDGER_FIELDS = new Set<string>(['id', 'saveId']);

/** 可 delta 加法的数值字段（metadata.delta=true 时仅允许这些键，杀 #20 delta 变替换） */
const UPDATE_CHAR_NUMERIC_FIELDS = new Set<string>([
  'tier', 'level', 'totalExp', 'expToNext', 'freeAttrPoints',
  'hp', 'maxHp', 'mp', 'maxMp', 'sp', 'maxSp',
  'money', 'quantity',
]);

// ========== StateManager ==========

export class StateManager {
  private saveId: string;
  private maxSnapshots: number;
  private autoSnapshot: boolean;
  private autoSnapshotInterval: number;
  private patchCount: number = 0;
  private events: GameEvent[] = [];

  constructor(config: StateManagerConfig) {
    this.saveId = config.saveId;
    this.maxSnapshots = config.maxSnapshots ?? 30;
    this.autoSnapshot = config.autoSnapshot ?? true;
    this.autoSnapshotInterval = config.autoSnapshotInterval ?? 5;
  }

  // ========== 主入口 ==========

  /**
   * 提交状态变更 — 唯一写入入口
   *
   * 流程:
   * 1. 验证所有 patches
   * 2. 依次应用每个 patch（读写数据库）
   * 3. 自动创建快照（如果达到间隔）
   * 4. 返回结果
   */
  async commitChatState(patches: StatePatch[]): Promise<StateCommitResult> {
    if (!patches.length) {
      return { success: true, patchesApplied: 0, eventsGenerated: [], errors: [] };
    }

    const results: PatchApplicationResult[] = [];
    const errors: string[] = [];

    for (const patch of patches) {
      try {
        const result = await this.applyPatch(patch);
        results.push(result);
        if (result.event) {
          this.events.push(result.event);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(`Patch ${patch.op} on ${patch.target}: ${errorMsg}`);
        results.push({ patch, success: false, error: errorMsg });
      }
    }

    this.patchCount += patches.length;

    // 自动快照
    let snapshotId: string | undefined;
    if (this.autoSnapshot && this.patchCount % this.autoSnapshotInterval === 0) {
      try {
        snapshotId = await this.createAutoSnapshot();
      } catch {
        // 快照失败不阻塞主流程
      }
    }

    // 更新 SaveSlot
    try {
      const save = await getSave(this.saveId);
      if (save) {
        save.metadata.totalTurns = (save.metadata.totalTurns ?? 0) + 1;
        save.updatedAt = Date.now();
        if (snapshotId) {
          save.activeSnapshotId = snapshotId;
        }
        await saveSaveSlot(save);
      }
    } catch {
      // 存档更新失败不阻塞
    }

    return {
      success: errors.length === 0,
      patchesApplied: results.filter(r => r.success).length,
      eventsGenerated: [...this.events],
      snapshotId,
      errors,
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
        return { patch, success: false, error: `未知操作: ${patch.op}` };
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
      'delta_variable', 'delta_hp', 'delta_mp', 'delta_sp', 'delta_affection',
    ];
    if (AMOUNT_REQUIRED_OPS.includes(patch.op) && patch.amount === undefined) {
      throw new Error(`${patch.op} 需要 amount 字段`);
    }

    // value 必填
    const VALUE_REQUIRED_OPS: StatePatchOp[] = [
      'set_variable', 'insert_variable',
      'set_hp', 'set_mp', 'set_sp', 'set_location',
      'update_quest', 'remove_quest',
      'add_item', 'remove_item', 'update_item', 'transfer_item',
      'equip_item', 'unequip_item',
      'add_skill', 'update_skill', 'remove_skill',
      'add_status_effect', 'remove_status_effect',
      'add_character', 'rename_character',
      'add_memory', 'update_plot_event',
      'set_affection', 'add_news',
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
   * 解析顺序:
   * ① 本存档内按 name 精确匹配
   * ② '主角'/'玩家' 别名 → 本存档 type='player' 的角色
   * ③ UUID 兜底（按 id 查库）  // 过渡: M4 删
   * ④ 找不到 → throw
   */
  private async resolveCharacter(key: string): Promise<CharacterState> {
    const chars = await getCharacters(this.saveId);

    // ① 名字精确匹配
    const byName = chars.find(c => c.name === key);
    if (byName) return byName;

    // ② 主角别名
    if (key === '主角' || key === '玩家') {
      const player = chars.find(c => c.type === 'player');
      if (player) return player;
    }

    // ③ UUID 兜底 // 过渡: M4 删
    const byId = await getCharacter(key);
    if (byId) return byId;

    // ④ 找不到
    throw new Error(`角色不存在: ${key}`);
  }

  /**
   * 从 patch.target 解析角色 — 剥离 'characters.' 前缀后只取第一段
   * （防御子路径写法 'characters.X.skills'，#11 Code 侧防御）
   */
  private async resolveCharTarget(target: string): Promise<CharacterState> {
    const raw = target.startsWith('characters.')
      ? target.slice('characters.'.length)
      : target;
    const key = raw.split('.')[0];
    if (!key) throw new Error(`无效的 character target: ${target}`);
    return this.resolveCharacter(key);
  }

  // ========== Patch Handlers ==========

  private async applySetVariable(patch: StatePatch): Promise<GameEvent> {
    // 读取当前 save 的 variables（从最新快照）
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.') ? patch.target.slice('variables.'.length) : patch.target;
    const newVars = setVar(vars, path, patch.value);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyDeltaVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.') ? patch.target.slice('variables.'.length) : patch.target;
    const current = getVar(vars, path);
    const newValue = (typeof current === 'number' ? current : 0) + (patch.amount ?? 0);
    const newVars = setVar(vars, path, newValue);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyRemoveVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const path = patch.target.startsWith('variables.') ? patch.target.slice('variables.'.length) : patch.target;
    const newVars = delVar(vars, path);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  private async applyMoveVariable(patch: StatePatch): Promise<GameEvent> {
    const vars = await this.getCurrentVariables();
    const fromPath = patch.target.startsWith('variables.') ? patch.target.slice('variables.'.length) : patch.target;
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
    const path = patch.target.startsWith('variables.') ? patch.target.slice('variables.'.length) : patch.target;
    const newVars = insertVar(vars, path, patch.value, patch.metadata?.index as number);
    await this.persistVariables(newVars);
    return this.createEvent('variable_change', patch);
  }

  // ========== Variable Persistence ==========

  /** 获取当前变量快照 */
  private async getCurrentVariables(): Promise<Record<string, any>> {
    const snapshot = await getLatestSnapshot(this.saveId);
    if (snapshot?.variables) return snapshot.variables;
    return {};
  }

  /** 持久化变量到当前快照 */
  private async persistVariables(variables: Record<string, any>): Promise<void> {
    const snapshot = await getLatestSnapshot(this.saveId);
    if (snapshot) {
      snapshot.variables = variables;
      await saveSnapshot(snapshot);
    }
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
            `update_character 禁止写数组字段 "${k}" — 请使用专用 op（add/update/remove_status_effect、add/update/remove_skill、add/update/remove_item、equip/unequip_item）`
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
          // delta 模式: 仅数值字段可加法，且传入值必须是 number
          if (!UPDATE_CHAR_NUMERIC_FIELDS.has(k)) {
            throw new Error(`update_character delta=true 仅支持数值字段，"${k}" 不是数值字段`);
          }
          if (typeof value[k] !== 'number') {
            throw new Error(`update_character delta=true 要求 "${k}" 的值为 number，实际为 ${typeof value[k]}`);
          }
        }
      }

      // ===== 全部合法 → 落地 =====
      if (isDelta) {
        // #20: delta 真加法（缺省/脏数据从 0 起加），不再退化为替换
        for (const k of keys) {
          const current = (char as any)[k];
          (char as any)[k] = (typeof current === 'number' ? current : 0) + value[k];
        }
      } else {
        Object.assign(char, value);
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
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as 'maxHp' | 'maxMp' | 'maxSp';

    const newValue = Math.max(0, Math.min(patch.value as number, (char as any)[maxField]));
    (char as any)[resource] = newValue;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applyDeltaResource(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const resource = patch.op.replace('delta_', '') as 'hp' | 'mp' | 'sp';
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as 'maxHp' | 'maxMp' | 'maxSp';

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
      } else if (existing.remainingTime !== null) {
        existing.remainingTime = Math.max(existing.remainingTime, value.remainingTime);
      }
      // existing 已是永久 → 保持永久
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
   * remove_status_effect — M2 按名删除 (#22)
   *
   * value = { name } 或裸字符串（按 name 解释）  // 过渡: M3 删裸字符串形态
   */
  private async applyRemoveStatusEffect(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const name = typeof patch.value === 'string'
      ? patch.value  // 过渡: M3 删
      : (patch.value as { name?: string })?.name;
    if (!name) throw new Error('remove_status_effect 需要 value.name');

    char.statusEffects = char.statusEffects.filter(e => e.name !== name);
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
        equippedSlot: value.equippedSlot != null ? normalizeSlot(value.equippedSlot) : value.equippedSlot,
        stats: value.stats,
        durability: value.durability,
        maxDurability: value.maxDurability,
        data: value.data,
        effects: value.effects,
        scripts: value.scripts,
      });
    }
    await saveCharacter(char);

    return this.createEvent('item_use', patch);
  }

  /**
   * remove_item — M2 按名寻址 (#5 #35)
   *
   * value = { name(必), quantity?=1 }
   * 或裸字符串（按 name 解释、patch.amount 当 quantity，兼容 craft-resolver 现行发法）// 过渡: M3 删
   * 扣减 ≤0 时 splice 删除条目；找不到 → throw 进 errors[]（杀静默失败）。
   */
  private async applyRemoveItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    let name: string | undefined;
    let qty: number;
    if (typeof patch.value === 'string') {
      // 过渡: M3 删 — 裸字符串按 name 解释，patch.amount 当 quantity
      name = patch.value;
      qty = patch.amount ?? 1;
    } else {
      const value = patch.value as { name?: string; quantity?: number };
      name = value?.name;
      qty = value?.quantity ?? 1;
    }
    if (!name) throw new Error('remove_item 需要 value.name');

    const idx = char.inventory.findIndex(i => i.name === name);
    if (idx < 0) throw new Error(`物品不存在: ${name}`);

    char.inventory[idx].quantity -= qty;
    if (char.inventory[idx].quantity <= 0) {
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
    if ('name' in rawChanges) throw new Error('update_item 禁止改 name（改名走 remove_item + add_item）');
    if ('quantity' in rawChanges) throw new Error('update_item 禁止改 quantity（数量走 add_item / remove_item）');

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
    const to = await this.resolveCharacter(value.to);   // 乙不存在 → throw，甲不动

    // 自转移防复制: 甲乙为同一角色时 bulkPut 同主键后写覆盖前写，会凭空复制物品
    if (to.id === from.id) {
      throw new Error(`transfer_item 不允许自我转移: ${from.name}`);
    }
    const idx = from.inventory.findIndex(i => i.name === value.name);
    if (idx < 0) throw new Error(`物品不存在: ${value.name}`);
    if (from.inventory[idx].quantity < qty) {
      throw new Error(`物品数量不足: ${value.name}（持有 ${from.inventory[idx].quantity}，需 ${qty}）`);
    }

    // ── 变更阶段: 校验全过后才动内存，双方一次事务落库 ──
    const source = from.inventory[idx];
    const received = findByName(to.inventory, value.name);
    if (received) {
      received.quantity += qty;   // 乙同名合并
    } else {
      // 乙新增: 物品字段随转移带过去，剥离 id（铁律1）
      const { id: _ignoredId, ...fields } = source;
      to.inventory.push({ ...fields, quantity: qty, equippedSlot: null });
    }
    source.quantity -= qty;
    if (source.quantity <= 0) {
      from.inventory.splice(idx, 1);
    }
    await saveCharacters([from, to]);   // Dexie bulkPut 单事务，避免半持久化

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
      throw new Error(`堆叠物品不可直接穿戴: ${value.name}（数量 ${item.quantity}），请先拆分为单件`);
    }

    // 同槽顶替: 仅清旧穿戴者的 equippedSlot，物品留在背包字段无损（杀 #10 有损穿脱）
    for (const other of char.inventory) {
      if (other !== item && other.equippedSlot === slot) {
        other.equippedSlot = null;
      }
    }

    item.equippedSlot = slot;
    await saveCharacter(char);

    return this.createEvent('item_use', patch);
  }

  /**
   * unequip_item — M2 equippedSlot 单真源 (#10 #23 #24, 规范 §3)
   *
   * value = { name } 或 { slot }（按 slot 找当前穿戴者，slot 先归一化）
   * 或裸字符串（先按 slot 解释找穿戴者，再按 name 兜底，兼容翻译层现行发法）// 过渡: M3 删
   * 脱=清 equippedSlot，零数据搬运。找不到（无此物品 / 该槽无穿戴）→ throw 进 errors[]。
   */
  private async applyUnequipItem(patch: StatePatch): Promise<GameEvent> {
    const char = await this.resolveCharTarget(patch.target);

    const value = patch.value as { name?: string; slot?: string } | string;
    let item: InventoryItem | undefined;

    if (typeof value === 'string') {
      // 过渡: M3 删 — 裸字符串先按 slot 解释（旧语义 value=slot），再按 name 兜底
      const slot = normalizeSlot(value);
      item = (slot ? char.inventory.find(i => i.equippedSlot === slot) : undefined)
        ?? findByName(char.inventory, value);
      if (!item) throw new Error(`该槽位无穿戴且物品不存在: ${value}`);
    } else if (value?.name) {
      // 按名脱
      item = findByName(char.inventory, value.name);
      if (!item) throw new Error(`物品不存在: ${value.name}`);
    } else if (value?.slot) {
      // 按槽脱: slot 先归一化再匹配穿戴者（铁律5）
      const slot = normalizeSlot(value.slot);
      if (!slot) throw new Error(`无法识别的装备槽位: ${value.slot}`);
      item = char.inventory.find(i => i.equippedSlot === slot);
      if (!item) throw new Error(`该槽位无穿戴: ${slot}`);
    } else {
      throw new Error('unequip_item 需要 value.name 或 value.slot');
    }

    item.equippedSlot = null;
    await saveCharacter(char);

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

    char.skills = char.skills.filter(s => s.name !== name);
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

    // 铁律3: saveId 是账务字段，由 Code 无条件注入，不信任上游 patch 构造方 (#8/M2硬前置②)
    character.saveId = this.saveId;
    if (character.customFields) character.customFields.saveId = this.saveId;  // 双写，M6 删

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

    const char = await this.resolveCharTarget(patch.target);
    const oldName = char.name;

    // 幂等: 新名等于旧名 → no-op 成功
    if (newName === oldName) {
      return this.createEvent('system', patch);
    }

    // 同存档新名查重（排除自身 — 自己改自己的名不算撞名，上面已 no-op 短路）
    const chars = await getCharacters(this.saveId);
    const clash = chars.find(c => c.name === newName && c.id !== char.id);
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
    const event = events.find(e => e.id === update.eventId);
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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { name: _name, ...questFields } = questData;
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
      // 增量 — 现值缺省 0 起算，加完再 clamp（双向）
      const current = profile.affections[charName] ?? 0;
      profile.affections[charName] = clampAffection(current + (patch.amount ?? 0));
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

  // ========== 快照 ==========

  private async createAutoSnapshot(): Promise<string> {
    const snapshots = await getSnapshots(this.saveId);
    const nextIndex = snapshots.length > 0
      ? Math.max(...snapshots.map(s => s.index)) + 1
      : 0;

    const snapshot = {
      id: crypto.randomUUID(),
      saveId: this.saveId,
      index: nextIndex,
      timestamp: Date.now(),
      gameTime: new Date().toISOString(),
      variables: {},
      characters: [],
      plotEvents: [],
      memoryIds: [],
      turnNumber: this.patchCount,
      label: `auto_${nextIndex}`,
    };

    await saveSnapshot(snapshot);

    // 清理超限快照
    await trimSnapshots(this.saveId, this.maxSnapshots);

    return snapshot.id;
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
    const { getCharacters, saveCharacter } = await import('./database');

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
          patches.push(...convertScriptEffects(result));
        }

        char.statusEffects = char.statusEffects.filter(e => e.name !== fx.name);

        patches.push({
          op: 'remove_status_effect',
          target: `characters.${char.name}`,
          value: { name: fx.name },
        });

        this.createEvent('status_effect', {
          op: 'remove_status_effect',
          target: `characters.${char.name}`,
          value: { name: fx.name },
        });
      }

      if (changed) {
        await saveCharacter(char);
      }
    }

    // 3. emit time_advanced
    this.createEvent('system', {
      op: 'set_variable',
      target: 'variables.gameTime',
      value: profile.gameTime,
    });

    return patches;
  }
}

// ========== 工厂函数 ==========

/** 创建 StateManager 实例 */
export function createStateManager(saveId: string, config?: Partial<StateManagerConfig>): StateManager {
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
  return list.find(item => item.name === name);
}

import type { ScriptEffects } from './script-executor';

function convertScriptEffects(se: ScriptEffects): StatePatch[] {
  const patches: StatePatch[] = [];
  // M2: add_status_effect 不再要求 id → Partial<StatusEffect> 直接透传（handler 内按 name 寻址+补缺省）
  for (const a of se.adds) patches.push({ op: 'add_status_effect', target: `characters.${a.charId}`, value: a.effect });
  // M2: effectId 字符串按 name 解释（remove handler 的裸字符串过渡形态）
  for (const r of se.removes) patches.push({ op: 'remove_status_effect', target: `characters.${r.charId}`, value: r.effectId });
  // M2: 逻辑键=name（铁律1）— stackSets 的 effectId 按 name 解释（脚本层 $status.setStacks 过渡形态，M3 收敛）
  for (const s of se.stackSets) patches.push({ op: 'set_variable', target: `characters.${s.charId}.statusEffects`, value: { name: s.effectId, stacks: s.stacks } });
  for (const h of se.hpChanges) patches.push({ op: 'delta_variable', target: `characters.${h.charId}.hp`, amount: h.amount });
  for (const st of se.statChanges) patches.push({ op: 'delta_variable', target: `characters.${st.charId}.attributes.${st.stat}`, amount: st.amount });
  return patches;
}
