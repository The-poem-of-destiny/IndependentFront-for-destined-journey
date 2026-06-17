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
  StatusEffect, EquipmentSlot, Skill, InventoryItem,
} from './types';
import {
  getCharacter, saveCharacter, saveCharacters,
  getMemories, saveMemory,
  getPlotEvents, savePlotEvents,
  getSave, saveSaveSlot,
  getSnapshots, saveSnapshot, trimSnapshots,
  getSettings, getLatestSnapshot,
} from './database';
import type { SaveSlot } from './types';
import { getVar, setVar, delVar, insertVar } from './var-resolver';

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
    // 验证
    const validationError = this.validatePatch(patch);
    if (validationError) {
      return { patch, success: false, error: validationError };
    }

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
      case 'set_location':
        event = await this.applySetLocation(patch);
        break;
      case 'add_memory':
        event = await this.applyAddMemory(patch);
        break;
      case 'update_plot_event':
        event = await this.applyUpdatePlotEvent(patch);
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

  private validatePatch(patch: StatePatch): string | null {
    if (!patch.op) return '缺少 op 字段';
    if (!patch.target) return '缺少 target 字段';

    // 数值操作必须有 amount
    const numericOps: StatePatchOp[] = [
      'delta_variable', 'delta_hp', 'delta_mp', 'delta_sp',
    ];
    if (numericOps.includes(patch.op) && patch.amount === undefined) {
      return `${patch.op} 需要 amount 字段`;
    }

    // set 操作必须有 value
    const setOps: StatePatchOp[] = [
      'set_variable', 'set_hp', 'set_mp', 'set_sp', 'set_location',
    ];
    if (setOps.includes(patch.op) && patch.value === undefined) {
      return `${patch.op} 需要 value 字段`;
    }

    return null;
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
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);

    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    if (patch.value && typeof patch.value === 'object') {
      Object.assign(char, patch.value);
    }
    char.currentAction = patch.metadata?.action ?? char.currentAction;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applySetResource(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const resource = patch.op.replace('set_', '') as 'hp' | 'mp' | 'sp';
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as 'maxHp' | 'maxMp' | 'maxSp';

    const newValue = Math.max(0, Math.min(patch.value as number, (char as any)[maxField]));
    (char as any)[resource] = newValue;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applyDeltaResource(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const resource = patch.op.replace('delta_', '') as 'hp' | 'mp' | 'sp';
    const maxField = `max${resource.charAt(0).toUpperCase()}${resource.slice(1)}` as 'maxHp' | 'maxMp' | 'maxSp';

    const current = (char as any)[resource] as number;
    const delta = patch.amount ?? 0;
    const newValue = Math.max(0, Math.min(current + delta, (char as any)[maxField]));
    (char as any)[resource] = newValue;
    await saveCharacter(char);

    return this.createEvent('character_action', patch);
  }

  private async applyAddStatusEffect(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const effect = patch.value as StatusEffect;
    if (!effect?.id) throw new Error('缺少 status effect 数据');

    // 检查是否已存在同 ID 效果 → 叠加层数
    const existing = char.statusEffects.find(e => e.id === effect.id);
    if (existing) {
      existing.stacks += effect.stacks;
      existing.remainingTime = Math.max(existing.remainingTime, effect.remainingTime);
    } else {
      char.statusEffects.push(effect);
    }
    await saveCharacter(char);

    return this.createEvent('status_effect', patch);
  }

  private async applyRemoveStatusEffect(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const effectId = patch.value as string;
    char.statusEffects = char.statusEffects.filter(e => e.id !== effectId);
    await saveCharacter(char);

    return this.createEvent('status_effect', patch);
  }

  private async applyAddItem(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const item = patch.value as InventoryItem;
    if (!item?.id) throw new Error('缺少物品数据');

    const existing = char.inventory.find(i => i.id === item.id);
    if (existing) {
      existing.quantity += (item.quantity ?? 1);
    } else {
      char.inventory.push({ ...item, quantity: item.quantity ?? 1 });
    }
    await saveCharacter(char);

    return this.createEvent('item_use', patch);
  }

  private async applyRemoveItem(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const itemId = patch.value as string;
    const qty = patch.amount ?? 1;

    const idx = char.inventory.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      char.inventory[idx].quantity -= qty;
      if (char.inventory[idx].quantity <= 0) {
        char.inventory.splice(idx, 1);
      }
    }
    await saveCharacter(char);

    return this.createEvent('item_use', patch);
  }

  private async applyEquipItem(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const equipData = patch.value as { itemId: string; slot: string; name: string; stats?: Record<string, number> };
    if (!equipData?.itemId) throw new Error('缺少装备数据');

    const existing = char.equipment.find(e => e.slot === equipData.slot);
    if (existing) {
      // 卸下旧装备（加入背包）
      char.inventory.push({
        id: existing.itemId,
        name: existing.name,
        quantity: 1,
        type: equipData.slot === 'weapon' ? 'weapon' : 'armor',
      });
    }

    // 装备新物品
    char.equipment = char.equipment.filter(e => e.slot !== equipData.slot);
    char.equipment.push({
      slot: equipData.slot,
      itemId: equipData.itemId,
      name: equipData.name,
      stats: equipData.stats,
    });

    // 从背包中移除
    const invIdx = char.inventory.findIndex(i => i.id === equipData.itemId);
    if (invIdx >= 0) {
      char.inventory[invIdx].quantity -= 1;
      if (char.inventory[invIdx].quantity <= 0) {
        char.inventory.splice(invIdx, 1);
      }
    }

    await saveCharacter(char);
    return this.createEvent('item_use', patch);
  }

  private async applyUnequipItem(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const slot = patch.value as string;
    const equipped = char.equipment.find(e => e.slot === slot);
    if (equipped) {
      char.inventory.push({
        id: equipped.itemId,
        name: equipped.name,
        quantity: 1,
        type: slot === 'weapon' ? 'weapon' : 'armor',
      });
      char.equipment = char.equipment.filter(e => e.slot !== slot);
    }
    await saveCharacter(char);

    return this.createEvent('item_use', patch);
  }

  private async applyAddSkill(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const skill = patch.value as Skill;
    if (!skill?.id) throw new Error('缺少技能数据');

    if (!char.skills.find(s => s.id === skill.id)) {
      char.skills.push(skill);
    }
    await saveCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  private async applyUpdateSkill(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    const update = patch.value as { skillId: string; changes: Partial<Skill> };
    const skill = char.skills.find(s => s.id === update.skillId);
    if (skill) {
      Object.assign(skill, update.changes);
    }
    await saveCharacter(char);

    return this.createEvent('skill_use', patch);
  }

  private async applySetLocation(patch: StatePatch): Promise<GameEvent> {
    const charId = this.extractId(patch.target, 'characters');
    if (!charId) throw new Error(`无效的 character target: ${patch.target}`);
    const char = await getCharacter(charId);
    if (!char) throw new Error(`角色不存在: ${charId}`);

    char.location = String(patch.value);
    await saveCharacter(char);

    return this.createEvent('location_change', patch);
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

  /** 从 target 中提取 ID: "characters.xxx" → "xxx" */
  private extractId(target: string, prefix: string): string | null {
    const parts = target.split('.');
    if (parts[0] === prefix && parts.length >= 2) {
      return parts.slice(1).join('.');
    }
    return null;
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
}

// ========== 工厂函数 ==========

/** 创建 StateManager 实例 */
export function createStateManager(saveId: string, config?: Partial<StateManagerConfig>): StateManager {
  return new StateManager({ saveId, ...config });
}
