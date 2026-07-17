/**
 * StateManager 测试套件
 *
 * 覆盖: 构造/配置默认值, Patch 验证, 各类 patch 操作,
 *       自动快照, 事件管理, 批量提交, 部分成功
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CharacterState, SaveSlot, PlotEvent, MemoryRecord,
  StatusEffect, InventoryItem, Skill, EquipmentSlot,
} from './types';
import { createDefaultCharacterState } from './types';

// Hoisted mock — replaces ./database for all consumers
vi.mock('./database', () => ({
  getCharacter: vi.fn(),
  getCharacters: vi.fn(),
  saveCharacter: vi.fn(),
  saveCharacters: vi.fn(),
  saveMemory: vi.fn(),
  getMemories: vi.fn(),
  getPlotEvents: vi.fn(),
  savePlotEvents: vi.fn(),
  getSave: vi.fn(),
  saveSaveSlot: vi.fn(),
  getSnapshots: vi.fn(),
  getLatestSnapshot: vi.fn(),
  saveSnapshot: vi.fn(),
  trimSnapshots: vi.fn(),
  getSettings: vi.fn(),
}));

// save-profile 也 mock（quest 双 op 测试用；state-manager 对其为动态 import，vitest 同样拦截）
vi.mock('./save-profile', () => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  setQuest: vi.fn(),
  removeQuest: vi.fn(),
}));

import { StateManager, createStateManager } from './state-manager';
import * as db from './database';
import * as saveProfile from './save-profile';

// ========== Helpers ==========

function buildMockCharacter(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    id: 'char-test-001',
    name: 'Test Hero',
    type: 'player',
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    inventory: [],
    equipment: [],
    skills: [],
    statusEffects: [],
    location: 'village_square',
    currentAction: '',
    ...overrides,
  });
}

function buildMockSaveSlot(overrides: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id: 'save-slot-001',
    name: 'Test Save',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: 'Test Hero',
      userName: 'Player',
      gameStartTime: 'Year 1',
      totalTurns: 0,
    },
    ...overrides,
  };
}

function buildMockPlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: 'plot-event-001',
    saveId: 'save-001',
    title: 'Test Event',
    description: 'A test plot event',
    status: 'active',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ========== Test Suite ==========

describe('StateManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns (all safe no-ops)
    vi.mocked(db.getCharacter).mockResolvedValue(undefined);
    // In-memory character store for integration-style verification
    const charStore = new Map<string, CharacterState>();
    vi.mocked(db.getCharacters).mockImplementation(async (saveId?: string) => {
      const all = Array.from(charStore.values());
      return saveId ? all.filter(c => c.saveId === saveId) : all;
    });
    vi.mocked(db.saveCharacter).mockImplementation(async (char: any) => {
      charStore.set(char.id, char);
      return 'saved';
    });
    vi.mocked(db.saveCharacters).mockResolvedValue(undefined);
    vi.mocked(db.saveMemory).mockResolvedValue('mem-id');
    vi.mocked(db.getMemories).mockResolvedValue([]);
    vi.mocked(db.getPlotEvents).mockResolvedValue([]);
    vi.mocked(db.savePlotEvents).mockResolvedValue(undefined);
    vi.mocked(db.getSave).mockResolvedValue(undefined);
    vi.mocked(db.saveSaveSlot).mockResolvedValue('saved');
    vi.mocked(db.getSnapshots).mockResolvedValue([]);
    vi.mocked(db.getLatestSnapshot).mockResolvedValue(undefined);
    vi.mocked(db.saveSnapshot).mockResolvedValue('snap-id');
    vi.mocked(db.trimSnapshots).mockResolvedValue(undefined);
    vi.mocked(db.getSettings).mockResolvedValue(undefined);
  });

  // ===================================================================
  // 1. Construction
  // ===================================================================
  describe('construction', () => {
    it('should store saveId from config', () => {
      const sm = new StateManager({ saveId: 'save-001' });
      expect((sm as any).saveId).toBe('save-001');
    });

    it('should use default maxSnapshots (30) when not provided', () => {
      const sm = new StateManager({ saveId: 'save-001' });
      expect((sm as any).maxSnapshots).toBe(30);
    });

    it('should use default autoSnapshot (true) when not provided', () => {
      const sm = new StateManager({ saveId: 'save-001' });
      expect((sm as any).autoSnapshot).toBe(true);
    });

    it('should use default autoSnapshotInterval (5) when not provided', () => {
      const sm = new StateManager({ saveId: 'save-001' });
      expect((sm as any).autoSnapshotInterval).toBe(5);
    });

    it('should accept custom config values', () => {
      const sm = new StateManager({
        saveId: 'save-002',
        maxSnapshots: 10,
        autoSnapshot: false,
        autoSnapshotInterval: 3,
      });
      expect((sm as any).saveId).toBe('save-002');
      expect((sm as any).maxSnapshots).toBe(10);
      expect((sm as any).autoSnapshot).toBe(false);
      expect((sm as any).autoSnapshotInterval).toBe(3);
    });
  });

  // ===================================================================
  // 2. commitChatState — empty & validation
  // ===================================================================
  describe('commitChatState — empty & validation', () => {
    it('should return success with 0 applied for empty patches array', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([]);
      expect(result).toEqual({
        success: true,
        patchesApplied: 0,
        eventsGenerated: [],
        errors: [],
      });
    });

    it('should reject patch with missing op field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: '' as any, target: 'variables.gold' },
      ]);
      // M2 语义修正: 验证失败 throw → 进 errors[]，success=false
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('缺少 op 字段');
      expect(result.success).toBe(false);
    });

    it('should reject patch with missing target field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_variable', target: '' },
      ]);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('缺少 target 字段');
    });

    it('should reject delta_variable without amount field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_variable', target: 'variables.gold' },
      ]);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('delta_variable 需要 amount 字段');
    });

    it('should reject delta_hp without amount field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_hp', target: 'characters.c1' },
      ]);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
    });

    it('should reject set_variable without value field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold' },
      ]);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('set_variable 需要 value 字段');
    });

    it('should reject set_hp without value field', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.c1' },
      ]);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
    });

    it('should reject unknown op', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'unknown_op' as any, target: 'variables.gold', value: 100 },
      ]);
      // 未知 op 通过验证但落 dispatch default 分支 → 不进 errors（Task 5-11 的 8 个新 op 落此）
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ===================================================================
  // 3. set_variable / delta_variable
  // ===================================================================
  describe('commitChatState — set_variable / delta_variable', () => {
    it('should generate variable_change event for set_variable', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 500 },
      ]);
      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(result.eventsGenerated).toHaveLength(1);
      expect(result.eventsGenerated[0].type).toBe('variable_change');
      expect(result.eventsGenerated[0].data.op).toBe('set_variable');
      expect(result.eventsGenerated[0].data.target).toBe('variables.gold');
      expect(result.eventsGenerated[0].data.value).toBe(500);
    });

    it('should generate variable_change event for delta_variable', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_variable', target: 'variables.gold', amount: -50 },
      ]);
      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(result.eventsGenerated).toHaveLength(1);
      expect(result.eventsGenerated[0].type).toBe('variable_change');
      expect(result.eventsGenerated[0].data.op).toBe('delta_variable');
      expect(result.eventsGenerated[0].data.amount).toBe(-50);
    });
  });

  // ===================================================================
  // 4. update_character
  // ===================================================================
  describe('commitChatState — update_character', () => {
    it('should call getCharacter and saveCharacter with correct id', async () => {
      const char = buildMockCharacter({ id: 'char-001' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { name: 'New Name' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(vi.mocked(db.getCharacter)).toHaveBeenCalledWith('char-001');
      expect(vi.mocked(db.saveCharacter)).toHaveBeenCalledTimes(1);
      expect(char.name).toBe('New Name');
    });

    it('should return error when character not found', async () => {
      // db.getCharacter returns undefined by default (from beforeEach)

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.missing', value: { name: 'X' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('角色不存在: missing');
    });

    it('should apply value object to character fields', async () => {
      const char = buildMockCharacter({ id: 'char-001', name: 'Old', race: 'Elf' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { name: 'New', race: 'Human' } },
      ]);

      expect(char.name).toBe('New');
      expect(char.race).toBe('Human');
    });

    it('should set currentAction from metadata.action', async () => {
      const char = buildMockCharacter({ id: 'char-001', currentAction: 'old_action' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        {
          op: 'update_character',
          target: 'characters.char-001',
          value: { hp: 90 },
          metadata: { action: 'new_action' },
        },
      ]);

      expect(char.currentAction).toBe('new_action');
    });

    it('should keep existing currentAction when metadata has no action', async () => {
      const char = buildMockCharacter({ id: 'char-001', currentAction: 'existing_action' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { hp: 90 } },
      ]);

      expect(char.currentAction).toBe('existing_action');
    });
  });

  // ===================================================================
  // 5. set_hp / set_mp / set_sp
  // ===================================================================
  describe('commitChatState — set_hp / set_mp / set_sp', () => {
    it('should clamp set_hp to maxHp', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.char-001', value: 150 },
      ]);

      expect(result.success).toBe(true);
      expect(char.hp).toBe(100); // clamped to maxHp
      expect(result.eventsGenerated[0].type).toBe('character_action');
    });

    it('should clamp set_hp to 0 (lower bound)', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_hp', target: 'characters.char-001', value: -10 },
      ]);

      expect(char.hp).toBe(0);
    });

    it('should clamp set_mp to maxMp', async () => {
      const char = buildMockCharacter({ id: 'char-001', mp: 20, maxMp: 50 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_mp', target: 'characters.char-001', value: 80 },
      ]);

      expect(char.mp).toBe(50);
    });

    it('should clamp set_sp to maxSp', async () => {
      const char = buildMockCharacter({ id: 'char-001', sp: 10, maxSp: 50 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_sp', target: 'characters.char-001', value: 60 },
      ]);

      expect(char.sp).toBe(50);
    });

    it('should set resource to exact value when within bounds', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_hp', target: 'characters.char-001', value: 75 },
      ]);

      expect(char.hp).toBe(75);
    });
  });

  // ===================================================================
  // 6. delta_hp / delta_mp / delta_sp
  // ===================================================================
  describe('commitChatState — delta_hp / delta_mp / delta_sp', () => {
    it('should apply positive delta to hp', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_hp', target: 'characters.char-001', amount: 20 },
      ]);

      expect(result.success).toBe(true);
      expect(char.hp).toBe(70);
      expect(result.eventsGenerated[0].type).toBe('character_action');
    });

    it('should apply negative delta to hp', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'delta_hp', target: 'characters.char-001', amount: -30 },
      ]);

      expect(char.hp).toBe(20);
    });

    it('should clamp delta_hp result at 0 (lower bound)', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 20, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'delta_hp', target: 'characters.char-001', amount: -50 },
      ]);

      expect(char.hp).toBe(0);
    });

    it('should clamp delta_hp result at maxHp (upper bound)', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 90, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'delta_hp', target: 'characters.char-001', amount: 30 },
      ]);

      expect(char.hp).toBe(100);
    });

    it('should apply delta_mp correctly', async () => {
      const char = buildMockCharacter({ id: 'char-001', mp: 30, maxMp: 50 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'delta_mp', target: 'characters.char-001', amount: -15 },
      ]);

      expect(char.mp).toBe(15);
    });

    it('should apply delta_sp correctly', async () => {
      const char = buildMockCharacter({ id: 'char-001', sp: 40, maxSp: 50 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'delta_sp', target: 'characters.char-001', amount: 10 },
      ]);

      expect(char.sp).toBe(50); // clamped
    });
  });

  // ===================================================================
  // 7. status effects
  // ===================================================================
  describe('commitChatState — status effects', () => {
    it('should add new status effect to character', async () => {
      const char = buildMockCharacter({ id: 'char-001', statusEffects: [] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      // M2: 无 id — 逻辑键=名字（铁律1）
      const effect: StatusEffect = {
        name: 'Burn',
        description: 'Burning',
        stacks: 1,
        remainingTime: 3,
        source: 'fire_spell',
        category: '减益' as const,
        timeUnit: '回合' as const,
        effects: { hpPerTurn: -5 },
      };

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.char-001', value: effect },
      ]);

      expect(result.success).toBe(true);
      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].name).toBe('Burn');
      expect(result.eventsGenerated[0].type).toBe('status_effect');
    });

    it('should stack existing status effect (stacks + remainingTime)', async () => {
      // 旧数据带 id（可选字段兼容），叠层按 name 匹配
      const existing: StatusEffect = {
        id: 'poison',
        name: 'Poison',
        description: 'Poisoned',
        stacks: 2,
        remainingTime: 4,
        source: 'snake_bite',
        category: '减益' as const,
        timeUnit: '回合' as const,
        effects: { hpPerTurn: -3 },
      };
      const char = buildMockCharacter({ id: 'char-001', statusEffects: [existing] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const newStack: StatusEffect = {
        name: 'Poison',
        description: 'Poisoned',
        stacks: 3,
        remainingTime: 2,
        source: 'snake_bite',
        category: '减益' as const,
        timeUnit: '回合' as const,
        effects: { hpPerTurn: -3 },
      };

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.char-001', value: newStack },
      ]);

      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].stacks).toBe(5); // 2 + 3
      expect(char.statusEffects[0].remainingTime).toBe(4); // max(4, 2)
    });

    it('should remove status effect by name', async () => {
      const effects: StatusEffect[] = [
        { name: 'Burn', description: '', stacks: 1, remainingTime: 2, source: 'fire', category: '减益' as const, timeUnit: '回合' as const, effects: {} },
        { name: 'Poison', description: '', stacks: 1, remainingTime: 3, source: 'snake', category: '减益' as const, timeUnit: '回合' as const, effects: {} },
      ];
      const char = buildMockCharacter({ id: 'char-001', statusEffects: [...effects] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_status_effect', target: 'characters.char-001', value: { name: 'Burn' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].name).toBe('Poison');
    });

    it('should not error when removing non-existent status effect', async () => {
      const char = buildMockCharacter({ id: 'char-001', statusEffects: [] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_status_effect', target: 'characters.char-001', value: 'nonexistent' },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
    });
  });

  // ===================================================================
  // 7b. status effects — M2 按名寻址 (#4 #22)
  // ===================================================================
  describe('commitChatState — 状态效果按名寻址 (M2)', () => {
    it('#4: add_status_effect 不带 id 成功落库', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1' });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'add_status_effect',
          target: 'characters.理查德',
          value: {
            name: '轻伤',
            description: '手臂上有一道浅浅的伤口',
            category: '减益',
            remainingTime: 120,
            timeUnit: '分钟',
            source: '战斗-哥布林',
            effects: {},
          },
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].name).toBe('轻伤');
      expect(char.statusEffects[0].id).toBeUndefined(); // 不为新效果写 id
      expect(char.statusEffects[0].stacks).toBe(1);     // 缺省 stacks=1
    });

    it('同名再施加 stackable=true → stacks+1，超 maxStacks 封顶', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        statusEffects: [{
          name: '中毒', description: '', category: '减益', stacks: 2, maxStacks: 3,
          stackable: true, remainingTime: 10, timeUnit: '分钟', source: '蛇咬', effects: {},
        }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      // 第一次再施加（不带 stacks → 缺省视作 1 层）: 2+1=3
      const r1 = await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.理查德', value: { name: '中毒', category: '减益' } },
      ]);
      expect(r1.success).toBe(true);
      expect(char.statusEffects[0].stacks).toBe(3);

      // 第二次再施加: 3+1=4 > maxStacks=3 → 封顶 3
      await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.理查德', value: { name: '中毒', category: '减益' } },
      ]);
      expect(char.statusEffects[0].stacks).toBe(3);
      expect(char.statusEffects).toHaveLength(1); // 不重复插入
    });

    it('#22: remove_status_effect value=字符串 按名删除', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        statusEffects: [
          { name: '轻伤', description: '', category: '减益', stacks: 1, remainingTime: 120, timeUnit: '分钟', source: '战斗', effects: {} },
          { name: '鼓舞', description: '', category: '增益', stacks: 1, remainingTime: 30, timeUnit: '分钟', source: '战吼', effects: {} },
        ],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_status_effect', target: 'characters.理查德', value: '轻伤' },
      ]);

      expect(result.success).toBe(true);
      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].name).toBe('鼓舞');
    });

    it("category 传 'buff' 归一为 '增益'", async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1' });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'add_status_effect',
          target: 'characters.理查德',
          value: { name: '鼓舞', description: '士气高昂', category: 'buff', remainingTime: 30, timeUnit: '分钟', source: '战吼', effects: {} },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.statusEffects[0].category).toBe('增益');
    });

    it('add_status_effect 缺 name → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1' });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.理查德', value: { description: '无名效果' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(char.statusEffects).toHaveLength(0);
    });

    it('同名再施加 stackable=false → 保持 1 层，只刷新时长', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        statusEffects: [{
          name: '护盾', description: '', category: '增益', stacks: 1,
          stackable: false, remainingTime: 5, timeUnit: '分钟', source: '法术', effects: {},
        }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      await sm.commitChatState([
        { op: 'add_status_effect', target: 'characters.理查德', value: { name: '护盾', category: '增益', remainingTime: 20, timeUnit: '分钟' } },
      ]);

      expect(char.statusEffects).toHaveLength(1);
      expect(char.statusEffects[0].stacks).toBe(1);          // 不叠层
      expect(char.statusEffects[0].remainingTime).toBe(20);  // 刷新时长 max(5, 20)
    });
  });

  // ===================================================================
  // 8. items
  // ===================================================================
  describe('commitChatState — items', () => {
    it('should add new item to inventory', async () => {
      const char = buildMockCharacter({ id: 'char-001', inventory: [] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const item: InventoryItem = { id: 'potion', name: 'Health Potion', quantity: 1, type: 'consumable' };

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.char-001', value: item },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].id).toBe('potion');
      expect(char.inventory[0].quantity).toBe(1);
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('should default item quantity to 1 when missing', async () => {
      const char = buildMockCharacter({ id: 'char-001', inventory: [] });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const item: InventoryItem = { id: 'sword', name: 'Iron Sword', quantity: 0 } as any;
      // quantity is 0 but the code does: item.quantity ?? 1 → still 0 since 0 is not nullish
      // Let me test with quantity undefined
      const itemNoQty = { id: 'sword', name: 'Iron Sword' } as InventoryItem;

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'add_item', target: 'characters.char-001', value: itemNoQty },
      ]);

      expect(char.inventory[0].quantity).toBe(1);
    });

    it('should stack existing item quantity', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'arrow', name: 'Arrow', quantity: 10, type: 'consumable' }],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const item: InventoryItem = { id: 'arrow', name: 'Arrow', quantity: 5, type: 'consumable' };

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'add_item', target: 'characters.char-001', value: item },
      ]);

      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].quantity).toBe(15);
    });

    it('should reduce item quantity on remove_item', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'potion', name: 'Health Potion', quantity: 5, type: 'consumable' }],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.char-001', value: 'potion', amount: 2 },
      ]);

      expect(char.inventory[0].quantity).toBe(3);
    });

    it('should remove item entirely when quantity reaches 0', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'potion', name: 'Health Potion', quantity: 2, type: 'consumable' }],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.char-001', value: 'potion', amount: 2 },
      ]);

      expect(char.inventory).toHaveLength(0);
    });

    it('should remove item when quantity goes below 0', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'potion', name: 'Health Potion', quantity: 1, type: 'consumable' }],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.char-001', value: 'potion', amount: 5 },
      ]);

      expect(char.inventory).toHaveLength(0);
    });

    it('should default remove_item amount to 1', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'potion', name: 'Health Potion', quantity: 3, type: 'consumable' }],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.char-001', value: 'potion' },
      ]);

      expect(char.inventory[0].quantity).toBe(2);
    });
  });

  // ===================================================================
  // 9. equipment
  // ===================================================================
  describe('commitChatState — equip / unequip', () => {
    it('should equip item and remove it from inventory', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'wood_sword', name: 'Wooden Sword', quantity: 1, type: 'weapon' }],
        equipment: [],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'equip_item',
          target: 'characters.char-001',
          value: { itemId: 'wood_sword', slot: 'weapon', name: 'Wooden Sword', stats: { atk: 5 } },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.equipment).toHaveLength(1);
      expect(char.equipment[0].slot).toBe('weapon');
      expect(char.equipment[0].itemId).toBe('wood_sword');
      expect(char.inventory).toHaveLength(0); // removed
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('should unequip old item from same slot and move to inventory', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [{ id: 'iron_sword', name: 'Iron Sword', quantity: 1, type: 'weapon' }],
        equipment: [
          { slot: 'weapon', itemId: 'wood_sword', name: 'Wooden Sword', stats: { atk: 3 } },
        ],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        {
          op: 'equip_item',
          target: 'characters.char-001',
          value: { itemId: 'iron_sword', slot: 'weapon', name: 'Iron Sword', stats: { atk: 10 } },
        },
      ]);

      // Old weapon moved to inventory
      const oldInInv = char.inventory.find(i => i.id === 'wood_sword');
      expect(oldInInv).toBeDefined();
      expect(oldInInv!.quantity).toBe(1);
      // New weapon equipped
      expect(char.equipment).toHaveLength(1);
      expect(char.equipment[0].itemId).toBe('iron_sword');
      // Iron sword removed from inventory
      expect(char.inventory.filter(i => i.id === 'iron_sword')).toHaveLength(0);
    });

    it('should unequip item and move back to inventory', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [],
        equipment: [
          { slot: 'armor', itemId: 'leather_armor', name: 'Leather Armor', stats: { def: 5 } },
        ],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.char-001', value: 'armor' },
      ]);

      expect(char.equipment).toHaveLength(0);
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].id).toBe('leather_armor');
      expect(char.inventory[0].type).toBe('armor');
    });

    it('should be no-op when unequipping empty slot', async () => {
      const char = buildMockCharacter({
        id: 'char-001',
        inventory: [],
        equipment: [],
      });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.char-001', value: 'weapon' },
      ]);

      expect(result.success).toBe(true);
      expect(char.equipment).toHaveLength(0);
      expect(char.inventory).toHaveLength(0);
    });
  });

  // ===================================================================
  // 10. skills — M2 按名寻址 + remove_skill (#4)
  // ===================================================================
  describe('commitChatState — 技能按名寻址 (M2)', () => {
    it('#4: add_skill 无 id 成功落库', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'add_skill',
          target: 'characters.理查德',
          value: { name: '斩击', description: '凌厉的一斩', type: 'active', level: 1 },
        },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(char.skills).toHaveLength(1);
      expect(char.skills[0].name).toBe('斩击');
      expect(char.skills[0].id).toBeUndefined(); // 不为新技能写 id（铁律1）
      expect(result.eventsGenerated[0].type).toBe('skill_use');
    });

    it('同名 add_skill = 覆盖升级：提供的字段覆盖，未提供的保留，不重复插入（规范 §4）', async () => {
      const existing: Skill = {
        name: '斩击', description: '凌厉的一斩', type: 'active', level: 1,
        cost: { type: 'SP', amount: 10 },
      };
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [existing] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'add_skill',
          target: 'characters.理查德',
          value: { name: '斩击', level: 2, description: '更凌厉的一斩' },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.skills).toHaveLength(1);          // 不重复插入
      expect(char.skills[0].level).toBe(2);          // 提供的字段覆盖
      expect(char.skills[0].description).toBe('更凌厉的一斩');
      expect(char.skills[0].cost).toEqual({ type: 'SP', amount: 10 }); // 未提供的字段保留
      expect(char.skills[0].type).toBe('active');
    });

    it('update_skill value={name, changes} 按名修改', async () => {
      const skill: Skill = { name: '斩击', description: '基础斩击', type: 'active', level: 1 };
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [skill] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'update_skill',
          target: 'characters.理查德',
          value: { name: '斩击', changes: { level: 3, description: '进阶斩击' } },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.skills[0].level).toBe(3);
      expect(char.skills[0].description).toBe('进阶斩击');
    });

    it('update_skill 不存在的技能 → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'update_skill', target: 'characters.理查德', value: { name: '不存在的技能', changes: { level: 2 } } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('技能不存在');
    });

    it('remove_skill value={name} 按名删除', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        skills: [
          { name: '斩击', description: '', type: 'active' },
          { name: '格挡', description: '', type: 'passive' },
        ],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_skill', target: 'characters.理查德', value: { name: '斩击' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(char.skills).toHaveLength(1);
      expect(char.skills[0].name).toBe('格挡');
      expect(result.eventsGenerated[0].type).toBe('skill_use');
    });

    it('remove_skill 删除不存在的技能 → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_skill', target: 'characters.理查德', value: { name: '幻影步' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('技能不存在');
      expect(char.skills).toHaveLength(0);
    });

    it('add_skill 缺 name → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', skills: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_skill', target: 'characters.理查德', value: { description: '无名技能', type: 'active' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(char.skills).toHaveLength(0);
    });
  });

  // ===================================================================
  // 11. set_location
  // ===================================================================
  describe('commitChatState — set_location', () => {
    it('should update character location and generate location_change event', async () => {
      const char = buildMockCharacter({ id: 'char-001', location: 'old_place' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_location', target: 'characters.char-001', value: 'dark_forest' },
      ]);

      expect(result.success).toBe(true);
      expect(char.location).toBe('dark_forest');
      expect(result.eventsGenerated).toHaveLength(1);
      expect(result.eventsGenerated[0].type).toBe('location_change');
      expect(result.eventsGenerated[0].data.value).toBe('dark_forest');
    });

    it('should coerce non-string value to string', async () => {
      const char = buildMockCharacter({ id: 'char-001', location: '' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_location', target: 'characters.char-001', value: 12345 },
      ]);

      expect(char.location).toBe('12345');
    });
  });

  // ===================================================================
  // 12. add_memory
  // ===================================================================
  describe('commitChatState — add_memory', () => {
    it('should call saveMemory with the provided memory record', async () => {
      const memory: MemoryRecord = {
        id: 'MEM000001',
        saveId: 'save-001',
        createdAt: Date.now(),
        realTimestamp: Date.now(),
        timeRange: { start: 'Year 1', end: 'Year 1' },
        content: 'The hero entered the dark forest.',
        hiddenLine: 'Forest is cursed.',
        keywords: ['forest', 'dark'],
        relatedCharacterIds: ['char-001'],
        importance: 5,
      };

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_memory', target: 'memories', value: memory },
      ]);

      expect(result.success).toBe(true);
      expect(vi.mocked(db.saveMemory)).toHaveBeenCalledWith(memory);
      expect(result.eventsGenerated).toHaveLength(1);
      expect(result.eventsGenerated[0].type).toBe('system');
    });
  });

  // ===================================================================
  // 12b. add_character — saveId injection (#8)
  // ===================================================================
  describe('commitChatState — add_character saveId injection', () => {
    it('add_character 落库时自动注入 saveId（修 #8 孤儿 NPC）', async () => {
      const sm = createStateManager('save_inject');
      const npc = createDefaultCharacterState({ id: 'npc_x', name: '妲丽安' });
      npc.saveId = '';   // 模拟 char_gen 链未填
      await sm!.commitChatState([{ op: 'add_character', target: 'characters.妲丽安', value: npc }]);
      const got = await db.getCharacters('save_inject');
      expect(got.map((c: CharacterState) => c.name)).toContain('妲丽安');
      expect(got.find((c: CharacterState) => c.name === '妲丽安')!.saveId).toBe('save_inject');
    });

    it('add_character 携带非空但错误的 saveId 时也被覆写（铁律3: 不信任上游）', async () => {
      const sm = createStateManager('save_right');
      const npc = createDefaultCharacterState({ id: 'npc_y', name: '串档NPC' });
      npc.saveId = 'save_WRONG';
      await sm!.commitChatState([{ op: 'add_character', target: 'characters.串档NPC', value: npc }]);
      const got = await db.getCharacters('save_right');
      expect(got.find((c: CharacterState) => c.name === '串档NPC')?.saveId).toBe('save_right');
    });
  });

  // ===================================================================
  // 13. update_plot_event
  // ===================================================================
  describe('commitChatState — update_plot_event', () => {
    it('should update plot event fields', async () => {
      const event = buildMockPlotEvent({ id: 'event-001', status: 'pending', title: 'Old Title' });
      vi.mocked(db.getPlotEvents).mockResolvedValue([event]);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'update_plot_event',
          target: 'plotEvents.event-001',
          value: { eventId: 'event-001', changes: { status: 'completed', title: 'New Title' } },
        },
      ]);

      expect(result.success).toBe(true);
      expect(event.status).toBe('completed');
      expect(event.title).toBe('New Title');
      expect(event.updatedAt).toBeGreaterThan(0);
      expect(vi.mocked(db.savePlotEvents)).toHaveBeenCalledWith([event]);
      expect(result.eventsGenerated[0].type).toBe('plot_trigger');
    });

    it('should return error when plot event not found', async () => {
      vi.mocked(db.getPlotEvents).mockResolvedValue([]);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'update_plot_event',
          target: 'plotEvents.missing',
          value: { eventId: 'missing', changes: { status: 'completed' } },
        },
      ]);

      expect(result.success).toBe(false);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors[0]).toContain('剧情事件不存在: missing');
    });
  });

  // ===================================================================
  // 14. Auto-snapshot
  // ===================================================================
  describe('commitChatState — auto-snapshot', () => {
    it('should create snapshot when patchCount reaches autoSnapshotInterval', async () => {
      // Interval = 1: every patch triggers a snapshot
      const sm = new StateManager({
        saveId: 'save-001',
        autoSnapshot: true,
        autoSnapshotInterval: 1,
      });

      const char = buildMockCharacter({ id: 'char-001' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);

      expect(result.success).toBe(true);
      expect(vi.mocked(db.getSnapshots)).toHaveBeenCalledWith('save-001');
      expect(vi.mocked(db.saveSnapshot)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.trimSnapshots)).toHaveBeenCalledWith('save-001', 30); // default max
      expect(result.snapshotId).toBeDefined();
      expect(typeof result.snapshotId).toBe('string');
    });

    it('should not create snapshot when autoSnapshot is disabled', async () => {
      const sm = new StateManager({
        saveId: 'save-001',
        autoSnapshot: false,
        autoSnapshotInterval: 1,
      });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);

      expect(vi.mocked(db.saveSnapshot)).not.toHaveBeenCalled();
    });

    it('should not create snapshot before interval is reached', async () => {
      const sm = new StateManager({
        saveId: 'save-001',
        autoSnapshot: true,
        autoSnapshotInterval: 3,
      });

      // First commit: patchCount becomes 1, 1 % 3 !== 0
      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);
      expect(vi.mocked(db.saveSnapshot)).not.toHaveBeenCalled();

      // Second commit: patchCount becomes 2, 2 % 3 !== 0
      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 200 },
      ]);
      expect(vi.mocked(db.saveSnapshot)).not.toHaveBeenCalled();
    });

    it('should create snapshot exactly at the interval boundary', async () => {
      const sm = new StateManager({
        saveId: 'save-001',
        autoSnapshot: true,
        autoSnapshotInterval: 2,
      });

      // First commit (1 patch): patchCount=1, no snapshot
      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);
      expect(vi.mocked(db.saveSnapshot)).not.toHaveBeenCalled();

      // Second commit (1 patch): patchCount=2, 2%2=0 → snapshot!
      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 200 },
      ]);
      expect(vi.mocked(db.saveSnapshot)).toHaveBeenCalledTimes(1);
      expect(result.snapshotId).toBeDefined();
    });

    it('should use custom maxSnapshots for trimming', async () => {
      const sm = new StateManager({
        saveId: 'save-001',
        autoSnapshot: true,
        autoSnapshotInterval: 1,
        maxSnapshots: 5,
      });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);

      expect(vi.mocked(db.trimSnapshots)).toHaveBeenCalledWith('save-001', 5);
    });
  });

  // ===================================================================
  // 15. getEvents / clearEvents
  // ===================================================================
  describe('getEvents / clearEvents', () => {
    it('should return empty array initially', () => {
      const sm = new StateManager({ saveId: 'save-001' });
      expect(sm.getEvents()).toEqual([]);
    });

    it('should return events generated by patches', async () => {
      const sm = new StateManager({ saveId: 'save-001' });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);

      const events = sm.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('variable_change');
    });

    it('should accumulate events across multiple commits', async () => {
      const sm = new StateManager({ saveId: 'save-001' });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);
      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.xp', value: 500 },
      ]);

      expect(sm.getEvents()).toHaveLength(2);
    });

    it('should clearEvents reset the event array', async () => {
      const sm = new StateManager({ saveId: 'save-001' });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);
      expect(sm.getEvents()).toHaveLength(1);

      sm.clearEvents();
      expect(sm.getEvents()).toEqual([]);
    });

    it('should return the internal events array (reference)', async () => {
      const sm = new StateManager({ saveId: 'save-001' });

      await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
      ]);

      const events1 = sm.getEvents();
      expect(events1).toHaveLength(1);

      // getEvents returns the original array; mutation propagates.
      // Callers must treat the returned ReadonlyArray accordingly.
      sm.clearEvents();
      expect(sm.getEvents()).toEqual([]);
    });
  });

  // ===================================================================
  // 16. Multiple patches / partial success
  // ===================================================================
  describe('commitChatState — multiple patches & partial success', () => {
    it('should apply multiple valid patches in one commit', async () => {
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.gold', value: 100 },
        { op: 'delta_hp', target: 'characters.char-001', amount: 20 },
        { op: 'set_location', target: 'characters.char-001', value: 'forest' },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(3);
      expect(result.eventsGenerated).toHaveLength(3);
      expect(char.hp).toBe(70);
      expect(char.location).toBe('forest');
    });

    it('should not block subsequent patches when one fails (partial success)', async () => {
      // Conditional mock: returns char only for char-001, otherwise undefined
      const char = buildMockCharacter({ id: 'char-001', hp: 50, maxHp: 100 });
      vi.mocked(db.getCharacter).mockImplementation(async (id: any) => {
        if (id === 'char-001') return char;
        return undefined;
      });

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        // This one fails validation — missing op → M2: throw → 进 errors[]
        { op: '' as any, target: 'variables.bad' },
        // This one succeeds
        { op: 'set_variable', target: 'variables.good', value: 42 },
        // This one throws — character missing → caught, in errors[]
        { op: 'delta_hp', target: 'characters.missing', amount: -10 },
        // This one succeeds
        { op: 'delta_hp', target: 'characters.char-001', amount: -10 },
      ]);

      // M2 语义修正: 验证失败 + 角色缺失都进 errors → errors.length = 2 → success = false
      expect(result.success).toBe(false);
      expect(result.patchesApplied).toBe(2); // 2 succeeded
      expect(result.errors).toHaveLength(2); // validation throw + missing character
      expect(result.errors[0]).toContain('缺少 op 字段');
      expect(result.errors[1]).toContain('角色不存在: missing');
      expect(result.eventsGenerated).toHaveLength(2); // from the 2 successful patches
      expect(char.hp).toBe(40); // successful delta was applied
    });

    it('should return success:true when all patches succeed', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_variable', target: 'variables.a', value: 1 },
        { op: 'set_variable', target: 'variables.b', value: 2 },
        { op: 'set_variable', target: 'variables.c', value: 3 },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(3);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ===================================================================
  // 17. resolveCharacter — 名字解析唯一入口 (M2 铁律2)
  // ===================================================================
  describe('resolveCharacter 名字解析唯一入口', () => {
    it('按名字解析角色', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', hp: 100, maxHp: 100 });
      await db.saveCharacter(char); // 放入 in-memory charStore

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.理查德', value: 50 },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(char.hp).toBe(50);
    });

    it('主角/玩家 别名解析到 player', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', hp: 100, maxHp: 100 });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const r1 = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.主角', value: 60 },
      ]);
      expect(r1.success).toBe(true);
      expect(char.hp).toBe(60);

      const r2 = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.玩家', value: 70 },
      ]);
      expect(r2.success).toBe(true);
      expect(char.hp).toBe(70);
    });

    it('UUID 兜底仍可用（过渡期）', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'npc', saveId: 'OTHER_SAVE', hp: 100, maxHp: 100 });
      // 不在本存档（saveId 不匹配）→ 名字/别名都查不到 → 走 UUID 兜底 getCharacter
      vi.mocked(db.getCharacter).mockImplementation(async (id: any) => (id === 'uuid-1' ? char : undefined));

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.uuid-1', value: 30 },
      ]);

      expect(result.success).toBe(true);
      expect(char.hp).toBe(30);
    });

    it('解析失败进 errors[] 不静默', async () => {
      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.不存在的人', value: 50 },
      ]);

      expect(result.success).toBe(false);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('角色不存在: 不存在的人');
    });

    it('子路径 target (characters.X.skills) 只取第一段解析到角色 X (#11 防御)', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', hp: 100, maxHp: 100 });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'set_hp', target: 'characters.理查德.skills', value: 40 },
      ]);

      expect(result.success).toBe(true);
      expect(char.hp).toBe(40);
    });
  });

  // ===================================================================
  // 18. validatePatch 语义修正 — 验证失败进 errors[]
  // ===================================================================
  describe('validatePatch 语义修正 — 验证失败进 errors[]', () => {
    it('缺 op/target 的 patch 进 errors 且 success=false', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const r = await sm.commitChatState([{ op: 'set_hp' } as any]);
      expect(r.errors.length).toBe(1);
      expect(r.patchesApplied).toBe(0);
      expect(r.success).toBe(false);
    });

    it('value 必填矩阵: M2 新 op 缺 value 全部进 errors', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const ops = ['rename_character', 'update_item', 'transfer_item', 'remove_skill', 'set_affection', 'add_news'] as const;
      const result = await sm.commitChatState(
        ops.map(op => ({ op, target: 'characters.X' } as any)),
      );
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(ops.length);
      expect(result.patchesApplied).toBe(0);
      for (const op of ops) {
        expect(result.errors.some(e => e.includes(`${op} 需要 value 字段`))).toBe(true);
      }
    });

    it('amount 必填: delta_affection 缺 amount 进 errors', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_affection', target: 'characters.X' } as any,
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('delta_affection 需要 amount 字段');
    });

    it('move_variable 缺 metadata.toPath 进 errors', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'move_variable', target: 'variables.a' },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('move_variable 需要 metadata.toPath');
    });

    it('例外: update_character 允许 value 为空（metadata.action-only）', async () => {
      const char = buildMockCharacter({ id: 'char-001', currentAction: 'old' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', metadata: { action: 'new_action' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(char.currentAction).toBe('new_action');
    });

    it('无额外要求: remove_variable 无 value 也通过验证', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_variable', target: 'variables.gold' },
      ]);
      expect(result.errors).toHaveLength(0);
      expect(result.patchesApplied).toBe(1);
    });

    it('无额外要求: remove_character 通过验证（handler 未实现 → 走 default 分支不进 errors）', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_character', target: 'characters.X' },
      ]);
      // 验证通过（不进 errors）；但 dispatch switch 无 handler → success:false 结果、patchesApplied=0
      expect(result.errors).toHaveLength(0);
      expect(result.patchesApplied).toBe(0);
    });
  });

  // ===================================================================
  // 19. update_quest / remove_quest — 顺带修 (#32 / #40)
  // ===================================================================
  describe('update_quest status 归一化 & remove_quest {name} 形态', () => {
    it('update_quest 写入前 status 走 normalizeQuestStatus (#32)', async () => {
      const profile = { saveId: 'save-001', quests: {} } as any;
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);
      vi.mocked(saveProfile.setQuest).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_quest', target: 'quests.试炼', value: { name: '试炼', status: 'active', progress: '第一步' } },
      ]);

      expect(result.success).toBe(true);
      // 'active' 是自由字符串 → 别名归一化为 '进行中'
      expect(vi.mocked(saveProfile.setQuest)).toHaveBeenCalledWith(
        profile, '试炼', expect.objectContaining({ status: '进行中', progress: '第一步' }),
      );
    });

    it('remove_quest value 为 {name} 对象 (#40)', async () => {
      const profile = { saveId: 'save-001', quests: {} } as any;
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);
      vi.mocked(saveProfile.removeQuest).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_quest', target: 'quests.试炼', value: { name: '试炼' } },
      ]);

      expect(result.success).toBe(true);
      expect(vi.mocked(saveProfile.removeQuest)).toHaveBeenCalledWith(profile, '试炼');
    });

    it('remove_quest value 缺 name 报"缺少任务名称"', async () => {
      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'remove_quest', target: 'quests.试炼', value: {} },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('缺少任务名称');
    });
  });

  // ===================================================================
  // 20. createStateManager factory
  // ===================================================================
  describe('createStateManager factory', () => {
    it('should create a StateManager instance with saveId', () => {
      const sm = createStateManager('save-001');
      expect(sm).toBeInstanceOf(StateManager);
      expect((sm as any).saveId).toBe('save-001');
    });

    it('should pass config overrides to StateManager', () => {
      const sm = createStateManager('save-002', { maxSnapshots: 15, autoSnapshot: false });
      expect((sm as any).maxSnapshots).toBe(15);
      expect((sm as any).autoSnapshot).toBe(false);
    });
  });
});
