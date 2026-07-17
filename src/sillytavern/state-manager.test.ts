/**
 * StateManager 测试套件
 *
 * 覆盖: 构造/配置默认值, Patch 验证, 各类 patch 操作,
 *       自动快照, 事件管理, 批量提交, 部分成功
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CharacterState, SaveSlot, PlotEvent, MemoryRecord,
  StatusEffect, Skill, EquipmentSlot,
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
        { op: 'update_character', target: 'characters.char-001', value: { race: '精灵' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.patchesApplied).toBe(1);
      expect(vi.mocked(db.getCharacter)).toHaveBeenCalledWith('char-001');
      expect(vi.mocked(db.saveCharacter)).toHaveBeenCalledTimes(1);
      expect(char.race).toBe('精灵');
    });

    it('should return error when character not found', async () => {
      // db.getCharacter returns undefined by default (from beforeEach)

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.missing', value: { race: 'X' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.patchesApplied).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('角色不存在: missing');
    });

    it('should apply value object to character fields', async () => {
      const char = buildMockCharacter({ id: 'char-001', race: 'Elf', money: 10 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { race: 'Human', money: 200 } },
      ]);

      expect(char.race).toBe('Human');
      expect(char.money).toBe(200);
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

    // ===== M2 T9: 白名单 + delta 真加法 + currentAction 归位 (#19 #20 #21) =====

    it('① 禁数组字段: value 含 inventory → errors 且角色对象无污染（原子拒绝）', async () => {
      const char = buildMockCharacter({ id: 'char-001', race: 'Elf', money: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'update_character',
          target: 'characters.char-001',
          // 合法键 money 与非法键 inventory 混合 → 整个 patch 必须原子拒绝
          value: { money: 999, inventory: [{ name: '伪造物品' }] } as any,
        },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('inventory');
      // 原子拒绝: 合法键也不能落地
      expect(char.money).toBe(100);
      expect((char as any).inventory).toEqual([]);
      expect(vi.mocked(db.saveCharacter)).not.toHaveBeenCalled();
    });

    it('② 禁 name: value 含 name → errors', async () => {
      const char = buildMockCharacter({ id: 'char-001', name: '原名' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { name: '新名' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('name');
      expect(char.name).toBe('原名');
    });

    it('禁账务字段: value 含 saveId → errors', async () => {
      const char = buildMockCharacter({ id: 'char-001', saveId: 'save-001' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { saveId: 'hacked' } as any },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('saveId');
      expect(char.saveId).toBe('save-001');
    });

    it('③ delta 真加法: {money:-50, delta:true} 在 money=100 时结果 50', async () => {
      const char = buildMockCharacter({ id: 'char-001', money: 100 });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'update_character',
          target: 'characters.char-001',
          value: { money: -50 },
          metadata: { delta: true },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.money).toBe(50);
    });

    it('delta 真加法: 起始 undefined 数值字段从 0 开始', async () => {
      const char = buildMockCharacter({ id: 'char-001' });
      // 强制该字段为 undefined 模拟脏数据
      (char as any).money = undefined;
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        {
          op: 'update_character',
          target: 'characters.char-001',
          value: { money: 30 },
          metadata: { delta: true },
        },
      ]);

      expect(char.money).toBe(30);
    });

    it('delta 非数值字段 → errors（loud 拒绝）', async () => {
      const char = buildMockCharacter({ id: 'char-001', race: 'Elf' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        {
          op: 'update_character',
          target: 'characters.char-001',
          value: { race: 'Human' },
          metadata: { delta: true },
        },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('race');
      expect(char.race).toBe('Elf');
    });

    it('未知键 → errors（疑似 AI 拼写错误，loud 拒绝）', async () => {
      const char = buildMockCharacter({ id: 'char-001' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { hpp: 90 } as any },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toContain('hpp');
    });

    it('④ currentAction 正常写入且不顶掉 location', async () => {
      const char = buildMockCharacter({ id: 'char-001', location: 'village_square', currentAction: '' });
      vi.mocked(db.getCharacter).mockResolvedValue(char);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'update_character', target: 'characters.char-001', value: { currentAction: '锻造武器' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.currentAction).toBe('锻造武器');
      expect(char.location).toBe('village_square');
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
  // 8. items — M2 按名寻址 + 同名合并 + update/transfer (#5 #35)
  // ===================================================================
  describe('commitChatState — 物品按名寻址 (M2)', () => {
    // ---------- add_item ----------
    it('add_item 无 id 成功落库，quantity 缺省为 1，不写 id（铁律1）', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { name: '生命药水', description: '恢复生命' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].name).toBe('生命药水');
      expect(char.inventory[0].quantity).toBe(1);
      expect(char.inventory[0].id).toBeUndefined(); // 不为新物品写 id（铁律1）
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('add_item 缺 name → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { description: '无名物品' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(char.inventory).toHaveLength(0);
    });

    it('add_item 同名合并累加 quantity，不覆盖既有字段（#5）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '箭矢', quantity: 10, type: '消耗品', rarity: '优良', description: '精制箭矢' }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { name: '箭矢', quantity: 5 } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(1);          // 不重复插入
      expect(char.inventory[0].quantity).toBe(15);      // 数量累加
      expect(char.inventory[0].rarity).toBe('优良');    // 既有字段不被抹掉
      expect(char.inventory[0].description).toBe('精制箭矢');
    });

    it('add_item 归一化: type/rarity 英文别名 → 中文枚举（铁律5）', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { name: '铁剑', type: 'weapon', rarity: 'rare' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].type).toBe('装备');
      expect(char.inventory[0].rarity).toBe('稀有');
    });

    it('add_item equippedSlot 归一化: 别名 → 枚举；无法识别 → null 不 throw', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { name: '铁剑', equippedSlot: '主手' } },
        { op: 'add_item', target: 'characters.理查德', value: { name: '怪异挂坠', equippedSlot: '不存在的槽位' } },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(char.inventory[0].equippedSlot).toBe('武器');   // 别名归一
      expect(char.inventory[1].equippedSlot ?? null).toBeNull(); // 无法识别 → 躺背包
    });

    it('add_item 角色不存在 → 进 errors[]', async () => {
      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.不存在的人', value: { name: '生命药水' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('角色不存在');
    });

    // ---------- remove_item ----------
    it('remove_item value={name, quantity} 按名扣减', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 5, type: '消耗品' }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_item', target: 'characters.理查德', value: { name: '生命药水', quantity: 2 } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].quantity).toBe(3);
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('remove_item quantity 缺省为 1', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 3 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.理查德', value: { name: '生命药水' } },
      ]);

      expect(char.inventory[0].quantity).toBe(2);
    });

    it('remove_item 扣减到 ≤0 时 splice 删除条目', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 2 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      await sm.commitChatState([
        { op: 'remove_item', target: 'characters.理查德', value: { name: '生命药水', quantity: 5 } },
      ]);

      expect(char.inventory).toHaveLength(0);
    });

    it('remove_item 找不到物品 → 进 errors[] 不静默（#5 #35）', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_item', target: 'characters.理查德', value: { name: '不存在的物品' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('物品不存在');
    });

    it('remove_item 裸字符串过渡形态: value 按 name 解释 + patch.amount 当 quantity（craft-resolver 现行发法）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁锭', quantity: 5, type: '材料' }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'remove_item', target: 'characters.理查德', value: '铁锭', amount: 3 },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].quantity).toBe(2);
    });

    // ---------- update_item ----------
    it('update_item value={name, changes} 按名修改 + 归一化生效', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1, type: '装备', durability: 50 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        {
          op: 'update_item',
          target: 'characters.理查德',
          value: { name: '铁剑', changes: { durability: 30, rarity: 'epic', description: '有些破损的铁剑' } },
        },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].durability).toBe(30);
      expect(char.inventory[0].rarity).toBe('史诗');   // 归一化生效
      expect(char.inventory[0].description).toBe('有些破损的铁剑');
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('update_item 不存在的物品 → 进 errors[]', async () => {
      const char = buildMockCharacter({ id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1', inventory: [] });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'update_item', target: 'characters.理查德', value: { name: '幽灵剑', changes: { durability: 1 } } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('物品不存在');
    });

    it('update_item changes 禁 name/quantity（改名走删加、数量走 add/remove）→ 进 errors[]', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'update_item', target: 'characters.理查德', value: { name: '铁剑', changes: { name: '钢剑' } } },
        { op: 'update_item', target: 'characters.理查德', value: { name: '铁剑', changes: { quantity: 99 } } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(char.inventory[0].name).toBe('铁剑');     // 未被改名
      expect(char.inventory[0].quantity).toBe(1);      // 未被改量
    });

    it('update_item changes 里的 id 剥离不写入（铁律1）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'update_item', target: 'characters.理查德', value: { name: '铁剑', changes: { id: 'evil-id', durability: 10 } } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].id).toBeUndefined();
      expect(char.inventory[0].durability).toBe(10);
    });

    // ---------- transfer_item ----------
    it('transfer_item 原子转移: 扣甲加乙，乙同名合并', async () => {
      const alice = buildMockCharacter({
        id: 'uuid-a', name: '爱丽丝', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 5, type: '消耗品', rarity: '优良' }],
      });
      const bob = buildMockCharacter({
        id: 'uuid-b', name: '鲍勃', type: 'npc', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 1, type: '消耗品' }],
      });
      await db.saveCharacter(alice);
      await db.saveCharacter(bob);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '生命药水', to: '鲍勃', quantity: 2 } },
      ]);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(alice.inventory[0].quantity).toBe(3);
      expect(bob.inventory).toHaveLength(1);          // 同名合并不重复插入
      expect(bob.inventory[0].quantity).toBe(3);
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('transfer_item quantity 缺省 1；甲扣完 splice；乙无同名则新增（不带 id）', async () => {
      const alice = buildMockCharacter({
        id: 'uuid-a', name: '爱丽丝', type: 'player', saveId: 's1',
        inventory: [{ name: '古老怀表', quantity: 1, rarity: '稀有', description: '滴答作响' }],
      });
      const bob = buildMockCharacter({ id: 'uuid-b', name: '鲍勃', type: 'npc', saveId: 's1', inventory: [] });
      await db.saveCharacter(alice);
      await db.saveCharacter(bob);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '古老怀表', to: '鲍勃' } },
      ]);

      expect(result.success).toBe(true);
      expect(alice.inventory).toHaveLength(0);        // 扣完删除条目
      expect(bob.inventory).toHaveLength(1);
      expect(bob.inventory[0].name).toBe('古老怀表');
      expect(bob.inventory[0].quantity).toBe(1);
      expect(bob.inventory[0].rarity).toBe('稀有');   // 物品字段随转移带过去
      expect(bob.inventory[0].id).toBeUndefined();
    });

    it('transfer_item 原子性: 乙不存在 → 整体不动，甲的数量不变，进 errors[]', async () => {
      const alice = buildMockCharacter({
        id: 'uuid-a', name: '爱丽丝', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 5 }],
      });
      await db.saveCharacter(alice);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '生命药水', to: '不存在的人', quantity: 2 } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('角色不存在');
      expect(alice.inventory[0].quantity).toBe(5);    // 甲的数量不变（原子性）
    });

    it('transfer_item 原子性: 甲没有该物品/数量不足 → 整体不动，进 errors[]', async () => {
      const alice = buildMockCharacter({
        id: 'uuid-a', name: '爱丽丝', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 1 }],
      });
      const bob = buildMockCharacter({ id: 'uuid-b', name: '鲍勃', type: 'npc', saveId: 's1', inventory: [] });
      await db.saveCharacter(alice);
      await db.saveCharacter(bob);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '不存在的物品', to: '鲍勃' } },
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '生命药水', to: '鲍勃', quantity: 3 } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(alice.inventory[0].quantity).toBe(1);    // 数量不足时不做部分转移
      expect(bob.inventory).toHaveLength(0);          // 乙也未收到任何东西
    });

    it('transfer_item 缺 to → 进 errors[]', async () => {
      const alice = buildMockCharacter({
        id: 'uuid-a', name: '爱丽丝', type: 'player', saveId: 's1',
        inventory: [{ name: '生命药水', quantity: 5 }],
      });
      await db.saveCharacter(alice);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.爱丽丝', value: { name: '生命药水' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(alice.inventory[0].quantity).toBe(5);
    });

    // ── Finding 1: 自转移防复制 ──
    it('transfer_item 自转移防复制: 甲===乙时 reject 进 errors[] 数量不变', async () => {
      const char = buildMockCharacter({
        id: 'uuid-r', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'transfer_item', target: 'characters.理查德', value: { name: '铁剑', to: '理查德', quantity: 1 } },
      ]);

      // 自转移必须进 errors[]，而非静默复制物品
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('不允许自我转移');
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].quantity).toBe(1);
    });

    // ── Finding 2: 同名合并丢弃来值字段 ──
    it('add_item 同名合并时 quantity 累加，既有字段不被来值覆盖（含 rarity）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1, type: '装备', rarity: '普通', description: '一把普通的铁剑' }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'add_item', target: 'characters.理查德', value: { name: '铁剑', quantity: 2, rarity: '史诗', description: '史诗铁剑（不应覆盖）' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].quantity).toBe(3);       // 数量累加
      expect(char.inventory[0].rarity).toBe('普通');     // 既有字段（含 rarity）不覆盖
      expect(char.inventory[0].description).toBe('一把普通的铁剑'); // description 也不覆盖
    });
  });

  // ===================================================================
  // 9. equipment — M2 equippedSlot 单真源 (#10 #23 #24, 规范 §3)
  // ===================================================================
  describe('commitChatState — equip / unequip (equippedSlot 单真源)', () => {
    it('equip: 设 inventory 物品的 equippedSlot，effects/scripts/rarity 原地未动（零搬运）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{
          name: '木剑', quantity: 1, type: '装备', rarity: '优良',
          effects: { '锋利': '攻击时附加 1 点伤害' },
          scripts: { onHit: 'return 1;' },
        }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'equip_item', target: 'characters.理查德', value: { name: '木剑', slot: '武器' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(1);                    // 物品留在背包，不搬运
      expect(char.inventory[0].equippedSlot).toBe('武器');       // 穿=状态位
      expect(char.inventory[0].rarity).toBe('优良');             // 字段原地未动
      expect(char.inventory[0].effects).toEqual({ '锋利': '攻击时附加 1 点伤害' });
      expect(char.inventory[0].scripts).toEqual({ onHit: 'return 1;' });
      expect(result.eventsGenerated[0].type).toBe('item_use');
    });

    it('equip 同槽顶替: 旧装备 equippedSlot=null 且字段无损，不 splice 不搬运（杀 #10）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [
          { name: '木剑', quantity: 1, equippedSlot: '武器', rarity: '普通', effects: { '旧词条': '保留' } },
          { name: '铁剑', quantity: 1, rarity: '稀有' },
        ],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'equip_item', target: 'characters.理查德', value: { name: '铁剑', slot: '武器' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(2);                    // 零搬运，两件都在
      const old = char.inventory.find(i => i.name === '木剑')!;
      expect(old.equippedSlot).toBeNull();                       // 旧装备自动脱下
      expect(old.rarity).toBe('普通');                           // 字段无损
      expect(old.effects).toEqual({ '旧词条': '保留' });
      expect(char.inventory.find(i => i.name === '铁剑')!.equippedSlot).toBe('武器');
    });

    it('equip: quantity>1 堆叠物品拒穿 → 进 errors[]（堆叠穿戴互斥，提示先拆分）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '飞刀', quantity: 5, type: '装备' }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'equip_item', target: 'characters.理查德', value: { name: '飞刀', slot: '武器' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('先拆分');
      expect(char.inventory[0].equippedSlot ?? null).toBeNull(); // 未穿上
    });

    it('equip: slot=weapon 英文别名归一为 武器（铁律5）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'equip_item', target: 'characters.理查德', value: { name: '铁剑', slot: 'weapon' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory[0].equippedSlot).toBe('武器');
    });

    it('equip: 无法识别的 slot / 缺 slot / 物品不在背包 → 各自进 errors[]', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '铁剑', quantity: 1 }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'equip_item', target: 'characters.理查德', value: { name: '铁剑', slot: '不存在的槽位' } },
        { op: 'equip_item', target: 'characters.理查德', value: { name: '铁剑' } },
        { op: 'equip_item', target: 'characters.理查德', value: { name: '幽灵剑', slot: '武器' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(3);
      expect(result.errors[0]).toContain('槽位');
      expect(result.errors[1]).toContain('slot');
      expect(result.errors[2]).toContain('物品不存在');
      expect(char.inventory[0].equippedSlot ?? null).toBeNull(); // 全部失败，未穿上
    });

    it('unequip 按 name: 清 equippedSlot，物品留在背包字段无损（零搬运）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [{ name: '皮甲', quantity: 1, equippedSlot: '身体', rarity: '优良', stats: { def: 5 } }],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.理查德', value: { name: '皮甲' } },
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory).toHaveLength(1);
      expect(char.inventory[0].equippedSlot).toBeNull();
      expect(char.inventory[0].rarity).toBe('优良');
      expect(char.inventory[0].stats).toEqual({ def: 5 });
    });

    it('unequip 按 slot: 找当前穿戴者清 equippedSlot；slot 英文别名先归一', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [
          { name: '木剑', quantity: 1, equippedSlot: '武器' },
          { name: '皮甲', quantity: 1, equippedSlot: '身体' },
        ],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.理查德', value: { slot: 'weapon' } },  // 英文别名 → 武器
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory.find(i => i.name === '木剑')!.equippedSlot).toBeNull();
      expect(char.inventory.find(i => i.name === '皮甲')!.equippedSlot).toBe('身体');  // 别的槽不受影响
    });

    it('unequip 找不到（无此物品 / 该槽无穿戴）→ 进 errors[] 不静默', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.理查德', value: { name: '不存在的装备' } },
        { op: 'unequip_item', target: 'characters.理查德', value: { slot: '武器' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('物品不存在');
      expect(result.errors[1]).toContain('无穿戴');
    });

    it('unequip 裸字符串: 先按 slot 解释、再按 name 兜底（过渡: M3 删）', async () => {
      const char = buildMockCharacter({
        id: 'uuid-1', name: '理查德', type: 'player', saveId: 's1',
        inventory: [
          { name: '木剑', quantity: 1, equippedSlot: '武器' },
          { name: '幸运吊坠', quantity: 1, equippedSlot: '饰品' },
        ],
      });
      await db.saveCharacter(char);

      const sm = new StateManager({ saveId: 's1' });
      const result = await sm.commitChatState([
        { op: 'unequip_item', target: 'characters.理查德', value: 'weapon' },      // 按 slot（英文别名归一）
        { op: 'unequip_item', target: 'characters.理查德', value: '幸运吊坠' },    // 非槽位词 → 按 name 兜底
      ]);

      expect(result.success).toBe(true);
      expect(char.inventory.find(i => i.name === '木剑')!.equippedSlot).toBeNull();
      expect(char.inventory.find(i => i.name === '幸运吊坠')!.equippedSlot).toBeNull();
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
  // 20. set_affection / delta_affection / add_news — SaveProfile 写入 (M2 T10, #15 #16)
  // ===================================================================
  describe('好感度/新闻 op — set_affection / delta_affection / add_news', () => {
    function buildMockProfile(overrides: Record<string, any> = {}) {
      return {
        saveId: 'save-001',
        affections: {},
        news: [],
        quests: {},
        ...overrides,
      } as any;
    }

    it('set_affection 150 被 clamp 到 100（上限）', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_affection', target: 'affections.艾莉丝', value: 150 },
      ]);

      expect(result.success).toBe(true);
      expect(profile.affections['艾莉丝']).toBe(100);
      expect(vi.mocked(saveProfile.updateProfile)).toHaveBeenCalledWith(profile);
    });

    it('set_affection -150 被 clamp 到 -100（下限）', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_affection', target: 'affections.艾莉丝', value: -150 },
      ]);

      expect(result.success).toBe(true);
      expect(profile.affections['艾莉丝']).toBe(-100);
    });

    it('set_affection value 非数字 → errors[]', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_affection', target: 'affections.艾莉丝', value: '很高' as any },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(profile.affections['艾莉丝']).toBeUndefined();
    });

    it('delta_affection 无现有记录时从 0 起算', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_affection', target: 'affections.雷恩', amount: 30 },
      ]);

      expect(result.success).toBe(true);
      expect(profile.affections['雷恩']).toBe(30);
    });

    it('delta_affection 双向 clamp：上限 100 / 下限 -100', async () => {
      const profile = buildMockProfile({ affections: { 上限者: 90, 下限者: -90 } });
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'delta_affection', target: 'affections.上限者', amount: 50 },
        { op: 'delta_affection', target: 'affections.下限者', amount: -50 },
      ]);

      expect(result.success).toBe(true);
      expect(profile.affections['上限者']).toBe(100);
      expect(profile.affections['下限者']).toBe(-100);
    });

    it('好感度 target 非 affections.<名> 格式 → errors[]', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'set_affection', target: 'characters.艾莉丝', value: 50 },
        { op: 'delta_affection', target: 'affections.', amount: 10 },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(result.patchesApplied).toBe(0);
    });

    it('add_news 自动补齐三账务字段 id/publishedAt/read', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_news', target: 'news', value: { title: '商队失踪', content: '艾瑟嘉德近郊商队接连失踪。', category: '阿斯塔利亚快讯' } },
      ]);

      expect(result.success).toBe(true);
      expect(profile.news).toHaveLength(1);
      const item = profile.news[0];
      expect(item.title).toBe('商队失踪');
      expect(item.content).toBe('艾瑟嘉德近郊商队接连失踪。');
      expect(item.category).toBe('阿斯塔利亚快讯');
      // Code 补账务字段（AI 永不产）
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.publishedAt).toBe('number');
      expect(item.read).toBe(false);
      expect(vi.mocked(saveProfile.updateProfile)).toHaveBeenCalledWith(profile);
    });

    it('add_news category 可选，缺省为空字符串', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_news', target: 'news', value: { title: '无分类新闻', content: '正文' } },
      ]);

      expect(result.success).toBe(true);
      expect(profile.news[0].category).toBe('');
    });

    it('add_news 缺 title 或 content → errors[]', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      const result = await sm.commitChatState([
        { op: 'add_news', target: 'news', value: { content: '没标题' } },
        { op: 'add_news', target: 'news', value: { title: '没正文' } },
      ]);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(profile.news).toHaveLength(0);
    });

    it('三 op 均发出 system 类型 GameEvent（GameEventType 不扩容）', async () => {
      const profile = buildMockProfile();
      vi.mocked(saveProfile.getProfile).mockResolvedValue(profile);

      const sm = new StateManager({ saveId: 'save-001' });
      await sm.commitChatState([
        { op: 'set_affection', target: 'affections.艾莉丝', value: 10 },
        { op: 'delta_affection', target: 'affections.艾莉丝', amount: 5 },
        { op: 'add_news', target: 'news', value: { title: 'T', content: 'C' } },
      ]);

      const events = sm.getEvents();
      expect(events).toHaveLength(3);
      for (const e of events) expect(e.type).toBe('system');
    });
  });

  // ===================================================================
  // 21. createStateManager factory
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
