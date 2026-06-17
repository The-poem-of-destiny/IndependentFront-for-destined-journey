/**
 * EffectRuntime — 声明式效果执行引擎
 *
 * Phase 4.5 核心模块。管线完成后批量执行 EffectDefinition[]，
 * 生成 StatePatch[] 提交给 StateManager，保持 DAG 原子性。
 *
 * 设计原则 (ADR-20):
 * - 声明式优先: VarsPatch + StatusEffect 格式
 * - 预编译 DSL 仅在覆盖率 <90% 时引入
 * - 效果按 priority 排序，低→高执行
 * - 执行结果产生 StatePatch → StateManager.commitChatState()
 */

import type {
  EffectDefinition, EffectResult, StatePatch, GameEvent,
  VarsPatch, StatusEffectPayload, CharacterUpdatePayload,
  DiceRollPayload, ItemEffectPayload, SkillEffectPayload,
  CharacterState,
} from './types';
import { executeDiceRoll } from './dice';
import { getCharacter, getMemories } from './database';

// ========== EffectRuntime ==========

export interface EffectRuntimeConfig {
  saveId: string;
  /** 可用的角色状态引用 */
  characters?: CharacterState[];
  /** 当前变量快照 */
  variables?: Record<string, any>;
}

export class EffectRuntime {
  private saveId: string;
  private characters: Map<string, CharacterState>;
  private variables: Record<string, any>;

  constructor(config: EffectRuntimeConfig) {
    this.saveId = config.saveId;
    this.characters = new Map();
    if (config.characters) {
      for (const c of config.characters) {
        this.characters.set(c.id, c);
      }
    }
    this.variables = config.variables ?? {};
  }

  // ========== 主入口 ==========

  /**
   * 批量执行效果
   *
   * 流程:
   * 1. 按 priority 排序
   * 2. 依次执行每个效果
   * 3. 验证 condition（如果存在）
   * 4. 收集生成的 StatePatch
   * 5. 处理连锁子效果
   */
  async execute(effects: EffectDefinition[]): Promise<EffectResult[]> {
    // 按优先级排序
    const sorted = [...effects].sort((a, b) => a.priority - b.priority);
    const results: EffectResult[] = [];

    for (const effect of sorted) {
      const result = await this.executeOne(effect);
      results.push(result);

      // 连锁子效果
      if (result.childEffects.length > 0) {
        const childResults = await this.execute(result.childEffects);
        results.push(...childResults);
      }
    }

    return results;
  }

  /** 执行单个效果 */
  async executeOne(effect: EffectDefinition): Promise<EffectResult> {
    const startTime = Date.now();

    try {
      // 条件检查
      if (effect.condition && !this.evaluateCondition(effect.condition)) {
        return {
          effectId: effect.id,
          success: true,
          patches: [],
          childEffects: [],
          duration: Date.now() - startTime,
        };
      }

      let patches: StatePatch[] = [];
      let childEffects: EffectDefinition[] = [];

      switch (effect.type) {
        case 'vars_patch':
          patches = this.executeVarsPatch(effect);
          break;
        case 'status_effect':
          patches = this.executeStatusEffect(effect);
          break;
        case 'character_update':
          patches = this.executeCharacterUpdate(effect);
          break;
        case 'dice_roll':
          patches = this.executeDiceEffect(effect);
          break;
        case 'item_effect':
          patches = this.executeItemEffect(effect);
          break;
        case 'skill_effect':
          patches = this.executeSkillEffect(effect);
          break;
        default:
          throw new Error(`未知效果类型: ${effect.type}`);
      }

      return {
        effectId: effect.id,
        success: true,
        patches,
        childEffects,
        duration: Date.now() - startTime,
      };
    } catch (err) {
      return {
        effectId: effect.id,
        success: false,
        patches: [],
        childEffects: [],
        error: err instanceof Error ? err.message : String(err),
        duration: Date.now() - startTime,
      };
    }
  }

  /** 将所有 EffectResult 展平为 StatePatch 列表 */
  collectPatches(results: EffectResult[]): StatePatch[] {
    return results
      .filter(r => r.success)
      .flatMap(r => r.patches);
  }

  // ========== 效果分发 ==========

  private executeVarsPatch(effect: EffectDefinition): StatePatch[] {
    const varsPatch = effect.payload as VarsPatch;
    const patches: StatePatch[] = [];

    // merge 操作
    if (varsPatch.merge) {
      for (const [key, value] of Object.entries(varsPatch.merge)) {
        patches.push({
          op: 'set_variable',
          target: `variables.${key}`,
          value,
        });
      }
    }

    // replace 操作
    if (varsPatch.replace) {
      for (const r of varsPatch.replace) {
        patches.push({
          op: 'set_variable',
          target: `variables.${r.path}`,
          value: r.value,
        });
      }
    }

    // delta 操作
    if (varsPatch.delta) {
      for (const d of varsPatch.delta) {
        patches.push({
          op: 'delta_variable',
          target: `variables.${d.path}`,
          amount: d.amount,
        });
      }
    }

    // insert 操作
    if (varsPatch.insert) {
      for (const ins of varsPatch.insert) {
        patches.push({
          op: 'set_variable',
          target: `variables.${ins.path}`,
          value: ins.value,
          metadata: { insertIndex: ins.index },
        });
      }
    }

    return patches;
  }

  private executeStatusEffect(effect: EffectDefinition): StatePatch[] {
    const payload = effect.payload as StatusEffectPayload;
    return [{
      op: payload.action === 'remove' ? 'remove_status_effect' : 'add_status_effect',
      target: `characters.${payload.targetCharacterId}`,
      value: payload.effect,
    }];
  }

  private executeCharacterUpdate(effect: EffectDefinition): StatePatch[] {
    const payload = effect.payload as CharacterUpdatePayload;
    return [{
      op: 'update_character',
      target: `characters.${payload.characterId}`,
      value: payload.changes,
    }];
  }

  private executeDiceEffect(effect: EffectDefinition): StatePatch[] {
    const payload = effect.payload as DiceRollPayload;
    const result = executeDiceRoll(payload);

    return [{
      op: 'set_variable',
      target: 'variables.lastDiceRoll',
      value: result,
      metadata: {
        criticalSuccess: result.criticalSuccess,
        criticalFailure: result.criticalFailure,
        meetsDC: result.meetsDC,
      },
    }];
  }

  private executeItemEffect(effect: EffectDefinition): StatePatch[] {
    const payload = effect.payload as ItemEffectPayload;
    const opMap: Record<string, StatePatch['op']> = {
      use: 'remove_item',
      equip: 'equip_item',
      unequip: 'unequip_item',
      drop: 'remove_item',
      transfer: 'remove_item',
    };

    return [{
      op: opMap[payload.action] ?? 'remove_item',
      target: `characters.${payload.characterId}`,
      value: payload.itemId,
      amount: payload.quantity,
    }];
  }

  private executeSkillEffect(effect: EffectDefinition): StatePatch[] {
    const payload = effect.payload as SkillEffectPayload;
    const opMap: Record<string, StatePatch['op']> = {
      use: 'update_skill',
      learn: 'add_skill',
      forget: 'update_skill',
    };

    return [{
      op: opMap[payload.action] ?? 'update_skill',
      target: `characters.${payload.characterId}`,
      value: { skillId: payload.skillId, targetId: payload.targetId },
    }];
  }

  // ========== 条件评估 ==========

  /** 简单条件评估（EJS 风格） */
  private evaluateCondition(condition: string): boolean {
    try {
      // 替换变量引用
      let expr = condition.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
        const value = this.resolvePath(path.trim());
        return typeof value === 'string' ? JSON.stringify(value) : String(value);
      });

      const fn = new Function('vars', 'chars', `
        try { return !!(${expr}); } catch { return false; }
      `);
      return fn(this.variables, Object.fromEntries(this.characters));
    } catch {
      return condition.includes('true') && !condition.includes('false');
    }
  }

  private resolvePath(path: string): any {
    const parts = path.split('.');
    if (parts[0] === 'variables' || parts[0] === 'var') {
      let value: any = this.variables;
      for (let i = 1; i < parts.length; i++) {
        if (value === undefined || value === null) return undefined;
        value = value[parts[i]];
      }
      return value;
    }
    // 默认从 variables 取
    let value: any = this.variables;
    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      value = value[part];
    }
    return value;
  }

  // ========== 动态角色加载 ==========

  /** 加载角色到运行时 */
  async loadCharacter(characterId: string): Promise<void> {
    const char = await getCharacter(characterId);
    if (char) {
      this.characters.set(char.id, char);
    }
  }

  /** 设置变量快照 */
  setVariables(variables: Record<string, any>): void {
    this.variables = variables;
  }

  /** 获取内部字符状态 */
  getCharacters(): ReadonlyMap<string, CharacterState> {
    return this.characters;
  }
}

// ========== 工厂 ==========

/** 创建 EffectRuntime 实例 */
export function createEffectRuntime(config: EffectRuntimeConfig): EffectRuntime {
  return new EffectRuntime(config);
}
