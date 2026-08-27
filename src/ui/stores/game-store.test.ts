/**
 * game-store.ts — 游戏页 Store 测试
 *
 * 重点覆盖 refreshFromDb()：管线跑完后 StateManager 直接写 Dexie，
 * 回读必须用合并语义（DB 覆盖同 id / 追加本存档新角色 / 保留内存独有 mock）。
 * DB 层用 fake-indexeddb（src/test-setup.ts 全局注入）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useGameStore } from './game-store';
import * as database from '@engine/database';
import * as effectWiring from '@engine/effect-wiring';
import {
  initializeDatabase,
  clearAllData,
  saveSaveSlot,
  saveCharacter,
  saveSaveProfile,
  saveSnapshot,
  saveMessage,
  savePlotOutline,
  savePlotEvents,
  getDatabase,
  getSave,
} from '@engine/database';
import { createDefaultCharacterState } from '@engine/types';
import {
  clearAllEffectWirings,
  ownerKeyOf,
  peekEffectWiring,
  wireEffectSystem,
} from '@engine/effect-wiring';
import type { SaveSlot, SaveProfile, CharacterState, PlotOutline, PlotEvent } from '@engine/types';
import {
  runCombatV3,
  type CombatCommand,
  type CombatView,
  type RunCombatV3Opts,
} from '@engine/combat-v3';
import type { CombatClient, CombatEvent } from '@engine/combat-v2-types';
import { mkAttack, mkBundle, mkParticipant, mkPass } from '../../sillytavern/combat-v3/test-utils';

/**
 * 引擎的 `allocateAttributePoint` 在这里被替身掉 —— 它自己的校验/落库有一整份真实 DB
 * 集成测试（`src/sillytavern/attribute-allocation.test.ts`）。本文件要证的是**接线**：
 * 参数按 (saveId, 玩家名, 维度) 传对了，成功之后回读了。
 */
const allocateAttributePointMock = vi.hoisted(() => vi.fn());
vi.mock('@engine/attribute-allocation', () => ({
  allocateAttributePoint: allocateAttributePointMock,
}));

// 🔴 2026-08-23 真机 bug：快照回退/重开战斗后必须失效 prompt session（delta transcript
// 残留旧分支正文）。这里替身掉 invalidatePromptSession，断言三个回退点都把它叫到。
const invalidatePromptSessionMock = vi.hoisted(() => vi.fn());
vi.mock('@engine/prompt-session-assembler', () => ({
  invalidatePromptSession: invalidatePromptSessionMock,
}));

// ===== 辅助 =====

const SAVE_ID = 'save-refresh-test';

function makeSaveSlot(overrides: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'Refresh Test Save',
    slot: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activeSnapshotId: null,
    metadata: {
      characterName: '理查德',
      userName: 'Tester',
      gameStartTime: '001-01-01',
      totalTurns: 0,
    },
    ...overrides,
  };
}

function makeProfile(overrides: Partial<SaveProfile> = {}): SaveProfile {
  return {
    saveId: SAVE_ID,
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 0 },
    variables: {},
    worldFlags: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeChar(overrides: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({
    saveId: SAVE_ID, // v9: 一等字段（M1 #43，替代 customFields.saveId）
    ...overrides,
  });
}

/** v3 单位替身（T13：v3_units_snapshot 载荷）——照 combat-v3-projection.ts 的 V3Unit 推导 */
function makeV3Unit(id: string, side: 'player' | 'enemy'): CombatView['units'][string] {
  return {
    id,
    name: id,
    side,
    tier: 1,
    hp: 100,
    maxHp: 100,
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    attacksRemaining: 1,
    actionsRemaining: 1,
    canAct: true,
    morale: 'steady',
    statusEffects: [],
  };
}

function makeStore() {
  setActivePinia(createPinia());
  return useGameStore();
}

function makeOutline(overrides: Partial<PlotOutline> = {}): PlotOutline {
  return {
    id: crypto.randomUUID(),
    saveId: SAVE_ID,
    mode: 'main',
    title: '血色纹章',
    summary: '一句话摘要',
    content: '# 大纲正文',
    chapters: [{ title: '第一章', summary: '章节摘要', status: 'pending' }],
    confirmed: true,
    version: 1,
    timeRange: { start: '复兴纪元001年01月01日', end: '复兴纪元005年12月30日' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makePlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: crypto.randomUUID(),
    saveId: SAVE_ID,
    title: '初入王都',
    description: '主角抵达艾瑟嘉德',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    visibility: 'hidden',
    depth: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ===== refreshFromDb =====

describe('refreshFromDb', () => {
  let store: ReturnType<typeof useGameStore>;

  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
    store = makeStore();
  });

  it('无 activeSaveId 时应为 no-op', async () => {
    store.characters = [makeChar({ id: 'c1', name: '内存角色' })];
    await store.refreshFromDb();
    expect(store.characters).toHaveLength(1);
    expect(store.saves).toHaveLength(0);
  });

  it('DB 角色应覆盖同 id 内存角色（背包/装备更新可见）', async () => {
    const memChar = makeChar({ id: 'c1', name: '理查德', type: 'player', inventory: [] });
    store.activeSaveId = SAVE_ID;
    store.characters = [memChar];

    // 模拟 StateManager 落库：DB 版本多了一件物品
    const dbChar = { ...JSON.parse(JSON.stringify(memChar)) };
    dbChar.inventory = [{ id: 'item1', name: '磨秃的粉笔残片', quantity: 1 }];
    await saveCharacter(dbChar);
    await saveSaveSlot(makeSaveSlot());

    await store.refreshFromDb();
    expect(store.characters).toHaveLength(1);
    expect(store.characters[0].inventory).toHaveLength(1);
    expect(store.characters[0].inventory[0].name).toBe('磨秃的粉笔残片');
  });

  it('DB 中本存档的新角色（侧链 char_gen NPC）应被追加', async () => {
    store.activeSaveId = SAVE_ID;
    store.characters = [makeChar({ id: 'c1', name: '理查德', type: 'player' })];

    await saveCharacter(makeChar({ id: 'npc1', name: '妲丽安', type: 'npc' }));
    await saveSaveSlot(makeSaveSlot());

    await store.refreshFromDb();
    expect(store.characters.map((c) => c.name)).toContain('妲丽安');
  });

  it('其他存档的 DB 角色不应被追加', async () => {
    store.activeSaveId = SAVE_ID;
    store.characters = [];

    await saveCharacter(
      makeChar({
        id: 'other1',
        name: '别人家的NPC',
        saveId: 'other-save',
      }),
    );
    await saveSaveSlot(makeSaveSlot());

    await store.refreshFromDb();
    expect(store.characters.map((c) => c.name)).not.toContain('别人家的NPC');
  });

  it('内存独有的 mock 角色（DB 无此 id）应保留', async () => {
    store.activeSaveId = SAVE_ID;
    store.characters = [makeChar({ id: 'mock1', name: '预览注入NPC' })];
    await saveSaveSlot(makeSaveSlot());

    await store.refreshFromDb();
    expect(store.characters.map((c) => c.name)).toContain('预览注入NPC');
  });

  it('save.metadata 与 saveProfile 应回读最新值', async () => {
    store.activeSaveId = SAVE_ID;
    store.saves = [makeSaveSlot()];

    // 模拟 StateManager 落库后的最新状态
    await saveSaveSlot(
      makeSaveSlot({
        metadata: {
          characterName: '理查德',
          userName: 'Tester',
          gameStartTime: '001-01-01',
          totalTurns: 3,
        } as any,
      }),
    );
    await saveSaveProfile(
      makeProfile({
        gameTime: { era: '复兴纪元', year: 1, month: 1, day: 1, weekday: 1, hour: 8, minute: 10 },
        fp: 5,
      }),
    );

    await store.refreshFromDb();
    expect(store.activeSave?.metadata?.totalTurns).toBe(3);
    expect(store.saveProfile?.fp).toBe(5);
    expect(store.saveProfile?.gameTime?.minute).toBe(10);
  });

  it('剧情大纲与事件应回读最新值（post_check 落库后 PlotPanel 可见）', async () => {
    store.activeSaveId = SAVE_ID;
    await saveSaveSlot(makeSaveSlot());

    await savePlotOutline(makeOutline({ title: '血色纹章' }));
    const chapter = makePlotEvent({ id: 'ch1', depth: 0, childrenIds: ['ke1'] });
    const keyEvent = makePlotEvent({ id: 'ke1', title: '命运初显', depth: 1, parentId: 'ch1' });
    await savePlotEvents([chapter, keyEvent]);

    await store.refreshFromDb();
    expect(store.plotOutline?.title).toBe('血色纹章');
    expect(store.plotOutline?.confirmed).toBe(true);
    expect(store.activePlotEvents).toHaveLength(2);
    expect(store.activePlotEvents.map((e) => e.title)).toContain('命运初显');
  });
});

// ===== loadSave 剧情回读 =====

describe('loadSave 剧情回读', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  it('loadSave 应并行回读最新大纲与事件树', async () => {
    await saveSaveSlot(makeSaveSlot());
    await savePlotOutline(makeOutline({ title: '旧版', version: 1, updatedAt: Date.now() - 1000 }));
    await savePlotOutline(makeOutline({ title: '确认版', version: 2 }));
    await savePlotEvents([
      makePlotEvent({ id: 'ch1', title: '第一章 序幕', depth: 0, childrenIds: ['ke1'] }),
      makePlotEvent({ id: 'ke1', title: '初入王都', depth: 1, parentId: 'ch1' }),
    ]);

    const store = makeStore();
    await store.loadSave(SAVE_ID);

    expect(store.plotOutline?.title).toBe('确认版');
    expect(store.activePlotEvents).toHaveLength(2);
    expect(store.activePlotEvents.every((e) => e.visibility === 'hidden')).toBe(true);
  });

  it('无大纲的存档 loadSave 后 plotOutline 应为 null', async () => {
    await saveSaveSlot(makeSaveSlot());
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(store.plotOutline).toBeNull();
    expect(store.activePlotEvents).toHaveLength(0);
  });
});

// ===== persistMessage 前置校验 (#13) =====

describe('persistMessage 前置校验', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  it('activeSaveId 为 null 时拒绝持久化（不产生孤儿消息）', async () => {
    const store = makeStore();
    // activeSaveId 默认 null
    store.addMessage('测试内容', 'user');
    await new Promise((r) => setTimeout(r, 20)); // addMessage 内部异步持久化
    // getMessages(undefined) 会被 Dexie 的 where().equals(undefined) 拒绝，
    // 改为直接查全表：库里不应出现这条孤儿消息
    const all = await getDatabase().messages.toArray();
    expect(all.filter((m) => m.content === '测试内容')).toHaveLength(0);
  });
});

// ===== rollbackOneTurn / restoreToSnapshot =====

describe('rollbackOneTurn / restoreToSnapshot', () => {
  let store: ReturnType<typeof useGameStore>;

  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
    store = makeStore();
    invalidatePromptSessionMock.mockClear();
    clearAllEffectWirings();
  });

  it('restoreToSnapshot: 生成中在写数据库前拒绝时间线恢复', async () => {
    store.activeSaveId = SAVE_ID;
    store.isGenerating = true;

    const result = await store.restoreToSnapshot('missing-snapshot');

    expect(result).toEqual({ status: 'rejected', error: '生成进行中，无法恢复' });
  });

  it('rollbackOneTurn: 生成中在读取回退目标前拒绝时间线恢复', async () => {
    store.activeSaveId = SAVE_ID;
    store.isGenerating = true;

    const result = await store.rollbackOneTurn();

    expect(result).toEqual({ status: 'rejected', error: '生成进行中，无法回退' });
  });

  /** 种入两回合：存档当前在 turn2，并有一张 turn1 快照(上一轮状态) */
  async function seedTwoTurns() {
    await saveSaveSlot(
      makeSaveSlot({
        metadata: {
          characterName: '理查德',
          userName: 'Tester',
          gameStartTime: '001-01-01',
          totalTurns: 2,
        } as any,
      }),
    );
    // 当前角色 (turn2 状态 hp=30) + profile (fp=9)
    await saveCharacter(
      makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 30, maxHp: 100 }),
    );
    await saveSaveProfile(makeProfile({ fp: 9 }));
    // turn1 快照 (上一轮): 角色 hp=80 / profile fp=5
    await saveSnapshot({
      id: 'snap-turn1',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'turn',
      turn: 1,
      characters: [makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 80, maxHp: 100 })],
      saveProfile: makeProfile({ fp: 5 }),
      plotEvents: [],
    });
    // 消息: turn1(user+assistant) + turn2(user+assistant)
    const base = Date.now();
    await saveMessage({
      id: 'u1',
      role: 'user',
      content: '第一轮输入',
      timestamp: base,
      saveId: SAVE_ID,
      turn: 1,
    });
    await saveMessage({
      id: 'a1',
      role: 'assistant',
      content: '第一轮正文',
      timestamp: base + 1,
      saveId: SAVE_ID,
      turn: 1,
    });
    await saveMessage({
      id: 'u2',
      role: 'user',
      content: '第二轮输入(待回填)',
      timestamp: base + 2,
      saveId: SAVE_ID,
      turn: 2,
    });
    await saveMessage({
      id: 'a2',
      role: 'assistant',
      content: '第二轮正文',
      timestamp: base + 3,
      saveId: SAVE_ID,
      turn: 2,
    });
    await store.loadSave(SAVE_ID);
  }

  it('rollbackOneTurn: 回退到上一轮 → 输入回填 + turn2消息删除 + 状态恢复 + totalTurns对齐', async () => {
    await seedTwoTurns();
    expect(store.messages.map((m) => m.id)).toContain('a2');

    const result = await store.rollbackOneTurn();

    expect(result.status).toBe('restored');
    // 输入框回填 turn2 的玩家输入
    expect(store.pendingInput).toBe('第二轮输入(待回填)');
    // turn2 消息删除，turn1 保留
    const ids = store.messages.map((m) => m.id);
    expect(ids).not.toContain('u2');
    expect(ids).not.toContain('a2');
    expect(ids).toContain('u1');
    // 状态恢复到 turn1 快照: hp 80 / fp 5
    expect(store.characters.find((c) => c.id === 'hero')?.hp).toBe(80);
    expect(store.saveProfile?.fp).toBe(5);
    // totalTurns 对齐到快照 turn
    expect(store.activeSave?.metadata?.totalTurns).toBe(1);
    // 🔴 2026-08-23 bug：回退后必须失效该存档 prompt session（防 delta transcript 残留旧分支）
    expect(invalidatePromptSessionMock).toHaveBeenCalledWith(SAVE_ID);
  });

  it('rollbackOneTurn: 战斗中拒绝回退', async () => {
    await seedTwoTurns();
    store.activeCombat = { status: 'ongoing' } as any;
    expect(store.isInCombat).toBe(true);
    const result = await store.rollbackOneTurn();
    expect(result).toEqual({ status: 'rejected', error: '战斗进行中，无法回退' });
    // 未回退：turn2 消息仍在
    expect(store.messages.map((m) => m.id)).toContain('a2');
  });

  it('rollbackOneTurn: 已是最早回合(turn1)拒绝', async () => {
    await saveSaveSlot(makeSaveSlot());
    await saveCharacter(makeChar({ id: 'hero', name: '理查德', type: 'player' }));
    await saveSaveProfile(makeProfile());
    const base = Date.now();
    await saveMessage({
      id: 'u1',
      role: 'user',
      content: '唯一一轮',
      timestamp: base,
      saveId: SAVE_ID,
      turn: 1,
    });
    await saveMessage({
      id: 'a1',
      role: 'assistant',
      content: '正文',
      timestamp: base + 1,
      saveId: SAVE_ID,
      turn: 1,
    });
    await store.loadSave(SAVE_ID);
    const result = await store.rollbackOneTurn();
    expect(result).toEqual({ status: 'rejected', error: '已是最早回合，无可回退' });
  });

  it('restoreToSnapshot: 恢复到指定历史快照(不回填输入) + 状态恢复', async () => {
    await seedTwoTurns();
    const result = await store.restoreToSnapshot('snap-turn1');
    expect(result).toEqual({ status: 'restored', continuation: 'same-save' });
    // 不回填输入
    expect(store.pendingInput).toBe('');
    // turn2 消息删除
    expect(store.messages.map((m) => m.id)).not.toContain('a2');
    // 状态恢复到 turn1 快照
    expect(store.characters.find((c) => c.id === 'hero')?.hp).toBe(80);
    expect(store.activeSave?.metadata?.totalTurns).toBe(1);
    // 🔴 2026-08-23 bug：恢复快照后必须失效该存档 prompt session
    expect(invalidatePromptSessionMock).toHaveBeenCalledWith(SAVE_ID);
  });

  // 🔴 2026-08-08 真机：恢复后内存角色必须**整表替换**。refreshFromDb 的角色同步是
  // 合并语义（内存独有角色保留）——回退点之后才生成、快照里没有的 NPC 会永远留在
  // 内存/UI/导出里（症状：回退后角色列表仍显示后来的角色）。见 rollbackOneTurn 与
  // restoreToSnapshot 里的 characters.value 整表替换。
  it('restoreToSnapshot: 回退点之后生成的 NPC 不留在内存角色里', async () => {
    await seedTwoTurns();
    // 模拟 turn2 期间生成、不在 turn1 快照里的 NPC：DB 直写 + 内存已有（管线合并进来）
    await saveCharacter(makeChar({ id: 'npc-late', name: '后来者', type: 'npc' }));
    store.characters.push(makeChar({ id: 'npc-late', name: '后来者', type: 'npc' }));

    const result = await store.restoreToSnapshot('snap-turn1');
    expect(result.status).toBe('restored');
    // 恢复后 DB 只剩快照角色 → 内存必须同步为整表替换，后来者消失
    expect(store.characters.find((c) => c.id === 'npc-late')).toBeUndefined();
    expect(store.characters.find((c) => c.id === 'hero')).toBeDefined();
  });

  it('restoreToSnapshot: 权威恢复后投影读取失败会隔离会话并保留已恢复存档', async () => {
    await seedTwoTurns();
    const readMessages = vi
      .spyOn(database, 'getMessages')
      .mockRejectedValueOnce(new Error('projection read failed'));

    const result = await store.restoreToSnapshot('snap-turn1');

    expect(result).toEqual({
      status: 'projection-failed',
      error: '时间线已恢复，但界面重载失败，请重新进入存档',
    });
    expect(store.activeSaveId).toBeNull();
    readMessages.mockRestore();

    await store.loadSave(SAVE_ID);
    expect(store.activeSave?.metadata?.totalTurns).toBe(1);
  });

  it('restoreToSnapshot: 清除旧分支瞬态并保留布局偏好', async () => {
    await seedTwoTurns();
    store.fillInput('旧分支输入');
    store.setPendingOptions(['旧选项']);
    store.focusItem('inventory', '旧物品');
    store.startAgentLogTurn({ id: 'run-before-restore', saveId: SAVE_ID, turn: 2 });
    store.addAgentLogEntry({
      invocationId: 'run-before-restore:story:1',
      turnId: 'run-before-restore',
      agentId: 'story',
    } as never);
    await store.flushAgentLogWrites();
    store.recordEjsVarsRejection('story', '旧差量', 10);
    store.recordEjsFallback('story', [{ uid: 1, error: '旧错误' }]);
    store.recordEjsUiLog('旧日志');
    store.setCombatCoordinator({ submit: async () => {} });
    store.sidebarCollapsed = true;
    store.fullscreenStatus = true;

    const result = await store.restoreToSnapshot('snap-turn1');

    expect(result.status).toBe('restored');
    expect(store.pendingInput).toBe('');
    expect(store.pendingOptions).toEqual([]);
    expect(store.pendingItemFocus).toBeNull();
    expect(store.activeModal).toBeNull();
    expect(store.agentLogHistory).toHaveLength(1);
    expect(store.agentLog).toHaveLength(1);
    expect(store.ejsVarsRejections).toEqual([]);
    expect(store.ejsFallbacks).toEqual([]);
    expect(store.ejsUiLog).toEqual([]);
    expect(store.combatCoordinator).toBeNull();
    expect(store.sidebarCollapsed).toBe(true);
    expect(store.fullscreenStatus).toBe(true);
  });

  it('restoreToSnapshot: 用恢复分支的角色替换旧效果 owner', async () => {
    await seedTwoTurns();
    const oldCharacter = makeChar({
      id: 'hero',
      name: '理查德',
      type: 'player',
      inventory: [
        {
          name: '旧分支之剑',
          quantity: 1,
          equippedSlot: '武器',
          scripts: { init: '// old branch' },
        },
      ],
    });
    const restoredCharacter = makeChar({
      id: 'hero',
      name: '理查德',
      type: 'player',
      inventory: [
        {
          name: '恢复分支之剑',
          quantity: 1,
          equippedSlot: '武器',
          scripts: { init: '// restored branch' },
        },
      ],
    });
    wireEffectSystem(SAVE_ID, [oldCharacter]);
    await saveSnapshot({
      id: 'snap-turn1',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'turn',
      turn: 1,
      characters: [restoredCharacter],
      saveProfile: makeProfile({ fp: 5 }),
      plotEvents: [],
    });

    const result = await store.restoreToSnapshot('snap-turn1');

    expect(result.status).toBe('restored');
    const owners = peekEffectWiring(SAVE_ID)?.owners;
    expect(owners?.has(ownerKeyOf('hero', 'item', '旧分支之剑'))).toBe(false);
    expect(owners?.has(ownerKeyOf('hero', 'item', '恢复分支之剑'))).toBe(true);
  });

  it('restoreToSnapshot: 效果重接线失败进入第三态并清掉半成品 owner', async () => {
    await seedTwoTurns();
    const restoredCharacter = makeChar({
      id: 'hero',
      name: '理查德',
      type: 'player',
      inventory: [
        {
          name: '恢复分支之剑',
          quantity: 1,
          equippedSlot: '武器',
          scripts: { init: '// restored branch' },
        },
      ],
    });
    await saveSnapshot({
      id: 'snap-wire-failure',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'turn',
      turn: 1,
      characters: [restoredCharacter],
      saveProfile: makeProfile({ fp: 5 }),
      plotEvents: [],
    });
    const realWireEffectSystem = effectWiring.wireEffectSystem;
    const wire = vi
      .spyOn(effectWiring, 'wireEffectSystem')
      .mockImplementationOnce((saveId, characters) => {
        realWireEffectSystem(saveId, characters);
        throw new Error('effect wiring failed');
      });

    const result = await store.restoreToSnapshot('snap-wire-failure');

    expect(result).toEqual({
      status: 'projection-failed',
      error: '时间线已恢复，但界面重载失败，请重新进入存档',
    });
    expect(store.activeSaveId).toBeNull();
    expect(peekEffectWiring(SAVE_ID)).toBeUndefined();
    wire.mockRestore();
  });

  it('rollbackOneTurn: 投影读取期间切档不会覆写或清空新存档输入', async () => {
    await seedTwoTurns();
    const originalGetMessages = database.getMessages;
    let releaseRead: (messages: Awaited<ReturnType<typeof database.getMessages>>) => void = () => {
      throw new Error('projection read did not start');
    };
    let markReadStarted: (() => void) | null = null;
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
    const readMessages = vi.spyOn(database, 'getMessages').mockImplementation((saveId) => {
      if (saveId !== SAVE_ID) return originalGetMessages(saveId);
      markReadStarted?.();
      return new Promise((resolve) => (releaseRead = resolve));
    });

    const restoring = store.rollbackOneTurn();
    await readStarted;

    const otherSaveId = 'save-opened-during-restore';
    await saveSaveSlot(makeSaveSlot({ id: otherSaveId, name: 'Other Save' }));
    await saveSaveProfile(makeProfile({ saveId: otherSaveId }));
    await store.loadSave(otherSaveId);
    store.fillInput('新存档草稿');
    releaseRead([]);

    const result = await restoring;

    expect(result).toEqual({
      status: 'restored',
      continuation: 'save-switched',
      warning: '时间线已恢复；当前已切换到其他存档',
    });
    expect(store.activeSaveId).toBe(otherSaveId);
    expect(store.activeSave?.name).toBe('Other Save');
    expect(store.pendingInput).toBe('新存档草稿');
    readMessages.mockRestore();
  });
});

// ===== M2：v3 战斗接线（submitCombatCommand / abandonCombat） =====
describe('M2 v3 战斗接线', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await initializeDatabase();
  });

  it('submitCombatCommand：无 Coordinator 时静默忽略（不抛）', async () => {
    const store = useGameStore();
    await expect(
      store.submitCombatCommand({ kind: 'PassAttack', actorId: '甲' }),
    ).resolves.not.toThrow();
  });

  it('submitCombatCommand：自动补 commandId + expectedRevision + 转 Coordinator.submit', async () => {
    const store = useGameStore();
    const received: {
      commandId?: string;
      expectedRevision?: number;
      kind?: string;
      actorId?: string;
      cost?: string;
    } = {};
    store.setCombatCoordinator({
      submit: async (cmd: {
        commandId?: string;
        expectedRevision?: number;
        kind?: string;
        actorId?: string;
        cost?: string;
      }) => {
        received.commandId = cmd.commandId;
        received.expectedRevision = cmd.expectedRevision;
        received.kind = cmd.kind;
        received.actorId = cmd.actorId;
        received.cost = cmd.cost;
      },
    });
    await store.submitCombatCommand({ kind: 'DeclareAttack', actorId: '甲' });
    expect(received.commandId).toBeTruthy();
    expect(received.expectedRevision).toBeTypeOf('number');
    expect(received.kind).toBe('DeclareAttack');
    expect(received.actorId).toBe('甲');
  });

  it('abandonCombat：清空 v3 战斗态并叫 Coordinator.abandon（C4）', async () => {
    const store = useGameStore();
    let abandoned = false;
    store.setCombatCoordinator({ abandon: () => (abandoned = true) });
    store.v3ActiveCombat = {} as never; // 模拟进行中的 v3 战斗
    store.abandonCombat();
    expect(abandoned).toBe(true);
    expect(store.v3ActiveCombat).toBeNull();
    expect(store.combatAwaitingInput).toBeNull();
  });

  it('submitCombatIntent（主持人模式）：意图文本原样转 Coordinator.submitPlayerIntent', async () => {
    const store = useGameStore();
    let received: string | null = null;
    store.setCombatCoordinator({
      submitPlayerIntent: async (text: string) => {
        received = text;
      },
    });
    await store.submitCombatIntent('我方「甲」使用火焰术攻击「骷髅兵」');
    expect(received).toBe('我方「甲」使用火焰术攻击「骷髅兵」');
  });

  it('submitCombatIntent：无意图桥（旧 coordinator / 测试）→ 静默忽略（不抛）', async () => {
    const store = useGameStore();
    await expect(store.submitCombatIntent('随便说点什么')).resolves.not.toThrow();
  });

  it('应用 v3 战斗事件驱动面板状态', () => {
    const store = useGameStore();
    store.applyCombatEvent({
      type: 'v3_combat_started',
      combatId: 'c1',
      round: 1,
      unitNames: ['甲'],
    });
    expect(store.v3ActiveCombat).not.toBeNull();
    expect(store.isInCombat).toBe(true);
    store.applyCombatEvent({ type: 'v3_combat_ended', reason: 'hp_zero', winner: 'player' });
    store.applyCombatEvent({ type: 'v3_settlement', fpDelta: 0, reason: 'hp_zero' });
    expect(store.v3ActiveCombat?.phase).toBe('SettlementCommitted');
    expect(store.isInCombat).toBe(false);
  });

  it('T13：v3_units_snapshot 到达后填充 v3ActiveCombat.units（问题 4 核心：面板不再空）', () => {
    const store = useGameStore();
    store.applyCombatEvent({
      type: 'v3_combat_started',
      combatId: 'c1',
      round: 1,
      unitNames: ['甲', '乙'],
    });
    // 开战事件本身不带 units（主通道是独立快照事件）→ 先空
    expect(store.v3ActiveCombat?.units).toEqual({});

    store.applyCombatEvent({
      type: 'v3_units_snapshot',
      units: { 甲: makeV3Unit('甲', 'player'), 乙: makeV3Unit('乙', 'enemy') },
    });
    expect(store.v3ActiveCombat?.units['甲']).toMatchObject({ id: '甲', side: 'player', hp: 100 });
    expect(store.v3ActiveCombat?.units['乙']).toMatchObject({ id: '乙', side: 'enemy' });
    expect(Object.keys(store.v3ActiveCombat?.units ?? {})).toHaveLength(2);
    // 快照只填 units，不碰其他字段
    expect(store.v3ActiveCombat?.initiativeOrder).toEqual(['甲', '乙']);
    expect(store.v3ActiveCombat?.phase).toBe('CombatOpen');
  });

  it('T13：v3_combat_started 带 units 载荷时不再留空 units（兼容路径）', () => {
    const store = useGameStore();
    store.applyCombatEvent({
      type: 'v3_combat_started',
      combatId: 'c1',
      round: 1,
      unitNames: ['甲'],
      units: { 甲: makeV3Unit('甲', 'player') },
    });
    expect(store.v3ActiveCombat?.units['甲']).toMatchObject({ id: '甲', side: 'player' });
    expect(Object.keys(store.v3ActiveCombat?.units ?? {})).toHaveLength(1);
  });

  // ════════════════════════════════════════════════════════════════════════
  // F2（2026-08-10）：就绪态 —— combat_trigger 检出 → combatReady 置位
  // （isInCombat 认它，面板先弹）→ 玩家点「开始战斗」（startCombat →
  // coordinator.start）→ 才 openCombat + runCombatV3 真开打。
  // ════════════════════════════════════════════════════════════════════════
  describe('F2：就绪态（就绪面板 → 点开始 → 才开打）', () => {
    it('v3_combat_ready 到达：combatReady 置位（含名单数组）+ isInCombat=true + 战斗视图未开', () => {
      const store = useGameStore();
      expect(store.isInCombat).toBe(false);
      store.applyCombatEvent({
        type: 'v3_combat_ready',
        combatType: '死斗',
        environment: '竞技场',
        allies: ['理查德', '妲丽安'],
        enemies: ['冠军'],
        bodyText: '决一死战',
      });
      expect(store.combatReady).toMatchObject({
        combatType: '死斗',
        environment: '竞技场',
        allies: ['理查德', '妲丽安'],
        enemies: ['冠军'],
        bodyText: '决一死战',
      });
      // 就绪态 = 战斗中（覆盖层锁 UI），但战斗视图（v3ActiveCombat）还没开
      expect(store.isInCombat).toBe(true);
      expect(store.v3ActiveCombat).toBeNull();
      // 就绪事件不污染消息流
      expect(store.combatLog).toHaveLength(0);
    });

    it('startCombat：清就绪态并调 coordinator.start（真开打回调）', async () => {
      const store = useGameStore();
      let started = 0;
      store.setCombatCoordinator({ start: async () => (started += 1) });
      store.applyCombatEvent({ type: 'v3_combat_ready', combatType: '标准' });
      await store.startCombat();
      expect(started).toBe(1);
      expect(store.combatReady).toBeNull();
    });

    it('startCombat：句柄无 start（战斗已开/占位缺失）时不崩', async () => {
      const store = useGameStore();
      store.setCombatCoordinator({ abandon: () => {} });
      store.applyCombatEvent({ type: 'v3_combat_ready', combatType: '标准' });
      await store.startCombat();
      expect(store.combatReady).toBeNull();
    });

    it('skipCombat / enterCombat / exitCombat 都清就绪态', () => {
      const store = useGameStore();
      store.applyCombatEvent({ type: 'v3_combat_ready', combatType: '标准' });
      store.skipCombat();
      expect(store.combatReady).toBeNull();
      expect(store.isInCombat).toBe(false);

      store.applyCombatEvent({ type: 'v3_combat_ready', combatType: '标准' });
      store.enterCombat();
      expect(store.combatReady).toBeNull();

      store.applyCombatEvent({ type: 'v3_combat_ready', combatType: '标准' });
      store.exitCombat();
      expect(store.combatReady).toBeNull();
    });
  });

  // ===== 结算确认态（2026-08-13 需求 D）：终局数值卡 + 可编辑摘要 =====
  describe('combatSummaryReview 结算确认', () => {
    const payload = {
      outcome: 'ally_win' as const,
      totalExp: 2,
      totalFp: 5,
      loot: [{ name: '断爪', description: '', quantity: 1 }],
      rounds: 2,
      summaryText: '摘要文本',
    };

    it('awaitCombatSummaryReview：面板置位（isInCombat 保持 true）+ 挂起 Promise；confirm 收编辑文本并清态', async () => {
      const store = useGameStore();
      const p = store.awaitCombatSummaryReview(payload);
      expect(store.combatSummaryReview).not.toBeNull();
      // v3_settlement 已把 phase 置 SettlementCommitted（isInCombat 其它判据都 false），
      // 确认面板期间 isInCombat 必须仍为 true（否则面板自己关掉）
      store.v3ActiveCombat = {
        combatId: 'c1',
        revision: 0,
        phase: 'SettlementCommitted',
        round: 2,
        initiativeOrder: [],
        currentTurnIndex: 0,
        units: {},
        resourceSnapshots: { FP: 0 },
      } as never;
      expect(store.isInCombat).toBe(true);

      store.confirmCombatSummary('我改过的摘要');
      await expect(p).resolves.toBe('我改过的摘要');
      expect(store.combatSummaryReview).toBeNull();
    });

    it('discardCombatSummary：resolve(null)（放弃注入，数值不回滚）', async () => {
      const store = useGameStore();
      const p = store.awaitCombatSummaryReview(payload);
      store.discardCombatSummary();
      await expect(p).resolves.toBeNull();
      expect(store.combatSummaryReview).toBeNull();
    });

    it('exitCombat 兜底：确认挂起时被 exitCombat（离开页面/停止生成）→ resolve(null)，promise 不悬挂', async () => {
      const store = useGameStore();
      const p = store.awaitCombatSummaryReview(payload);
      store.exitCombat();
      await expect(p).resolves.toBeNull();
      expect(store.combatSummaryReview).toBeNull();
      expect(store.isInCombat).toBe(false);
    });
  });

  it('skipCombat：abandonCombat 包装（战斗放弃 → 面板关闭、不落库）', () => {
    const store = useGameStore();
    let abandoned = false;
    store.setCombatCoordinator({ abandon: () => (abandoned = true) });
    store.v3ActiveCombat = {} as never; // 模拟进行中的 v3 战斗
    store.combatAwaitingInput = { unit: '甲', unitId: '甲', round: 1 };
    store.skipCombat();
    expect(abandoned).toBe(true); // 走 coordinator abandon（FP 不落库）
    expect(store.v3ActiveCombat).toBeNull(); // 面板关闭（isInCombat=false）
    expect(store.isInCombat).toBe(false);
    expect(store.combatAwaitingInput).toBeNull();
  });

  it('restartCombat：abandon → restore pre-combat 快照 → 调 restart 回调重触发', async () => {
    const store = useGameStore();
    // 开战前状态：角色 hp=80 / totalTurns=2（pre-combat 快照）
    const preChar = makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 80, maxHp: 100 });
    await saveSaveSlot(
      makeSaveSlot({
        metadata: {
          characterName: '理查德',
          userName: 'Tester',
          gameStartTime: '001-01-01',
          totalTurns: 2,
        } as any,
      }),
    );
    await saveCharacter(preChar);
    await saveSaveProfile(makeProfile({ fp: 5 }));
    await saveSnapshot({
      id: 'snap-pre-combat',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'pre-combat',
      turn: 2,
      characters: [preChar],
      saveProfile: makeProfile({ fp: 5 }),
      plotEvents: [],
    });
    const base = Date.now();
    await saveMessage({
      id: 'u1',
      role: 'user',
      content: '第一轮输入',
      timestamp: base,
      saveId: SAVE_ID,
      turn: 1,
    });
    await saveMessage({
      id: 'a1',
      role: 'assistant',
      content: '第一轮正文',
      timestamp: base + 1,
      saveId: SAVE_ID,
      turn: 1,
    });
    await store.loadSave(SAVE_ID);

    // 模拟战斗中：角色被削到 hp=30（战斗进行中的状态，快照恢复后应回到 80）
    await saveCharacter(
      makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 30, maxHp: 100 }),
    );

    let restarted = false;
    invalidatePromptSessionMock.mockClear();
    store.setCombatCoordinator({
      abandon: () => {},
      preSnapshotId: 'snap-pre-combat',
      restart: async () => {
        restarted = true;
      },
    });
    store.v3ActiveCombat = {} as never; // 进行中的战斗（重开前先被放弃）

    const result = await store.restartCombat();

    expect(result).toEqual({ status: 'restored', continuation: 'same-save' });
    expect(restarted).toBe(true); // 重触发回调被调（pipeline 重走 handleCombatTriggerV3）
    expect(store.v3ActiveCombat).toBeNull(); // 旧战斗已被放弃
    expect(store.isInCombat).toBe(false);
    expect(store.characters.find((c) => c.id === 'hero')?.hp).toBe(80); // 快照恢复
    expect(store.activeSave?.metadata?.totalTurns).toBe(2); // totalTurns 对齐快照 turn
    // 🔴 2026-08-23 bug：重开战斗（恢复开战前快照）后必须失效该存档 prompt session
    expect(invalidatePromptSessionMock).toHaveBeenCalledWith(SAVE_ID);
  });

  it('restartCombat：没有 pre-combat 快照时拒绝（不静默）', async () => {
    const store = useGameStore();
    const save = makeSaveSlot();
    await saveSaveSlot(save);
    await saveSaveProfile(makeProfile());
    await store.loadSave(SAVE_ID);
    let abandoned = false;
    store.setCombatCoordinator({ abandon: () => (abandoned = true), preSnapshotId: null });
    store.v3ActiveCombat = {} as never;

    const result = await store.restartCombat();
    expect(result).toEqual({ status: 'rejected', error: '没有 pre-combat 快照，无法重开' });
    expect(abandoned).toBe(false);
    expect(store.isInCombat).toBe(true);
  });

  it('restartCombat：恢复期间切档不会触发旧战斗重启回调', async () => {
    const store = useGameStore();
    const preChar = makeChar({ id: 'hero', name: '理查德', type: 'player' });
    await saveSaveSlot(makeSaveSlot());
    await saveCharacter(preChar);
    await saveSaveProfile(makeProfile());
    await saveSnapshot({
      id: 'snap-pre-combat-switch',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'pre-combat',
      turn: 0,
      characters: [preChar],
      saveProfile: makeProfile(),
      plotEvents: [],
    });
    await store.loadSave(SAVE_ID);

    const restart = vi.fn(async () => {});
    store.setCombatCoordinator({
      abandon: () => {},
      preSnapshotId: 'snap-pre-combat-switch',
      restart,
    });
    store.v3ActiveCombat = {} as never;
    const originalGetMessages = database.getMessages;
    let releaseRead: (messages: Awaited<ReturnType<typeof database.getMessages>>) => void = () => {
      throw new Error('projection read did not start');
    };
    let markReadStarted: (() => void) | null = null;
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve));
    const readMessages = vi.spyOn(database, 'getMessages').mockImplementation((saveId) => {
      if (saveId !== SAVE_ID) return originalGetMessages(saveId);
      markReadStarted?.();
      return new Promise((resolve) => (releaseRead = resolve));
    });

    const restarting = store.restartCombat();
    await readStarted;
    const otherSaveId = 'save-opened-during-combat-restart';
    await saveSaveSlot(makeSaveSlot({ id: otherSaveId, name: 'Other Save' }));
    await saveSaveProfile(makeProfile({ saveId: otherSaveId }));
    await store.loadSave(otherSaveId);
    releaseRead([]);

    const result = await restarting;

    expect(result).toEqual({
      status: 'restored',
      continuation: 'save-switched',
      warning: '时间线已恢复；当前已切换到其他存档',
    });
    expect(restart).not.toHaveBeenCalled();
    expect(store.activeSaveId).toBe(otherSaveId);
    readMessages.mockRestore();
  });

  it('restartCombat：时间线恢复成功但重触发失败时返回 warning 并保留存档', async () => {
    const store = useGameStore();
    const preChar = makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 80, maxHp: 100 });
    await saveSaveSlot(makeSaveSlot());
    await saveCharacter(preChar);
    await saveSaveProfile(makeProfile());
    await saveSnapshot({
      id: 'snap-pre-combat-warning',
      saveId: SAVE_ID,
      createdAt: 1000,
      reason: 'pre-combat',
      turn: 0,
      characters: [preChar],
      saveProfile: makeProfile(),
      plotEvents: [],
    });
    await store.loadSave(SAVE_ID);
    store.setCombatCoordinator({
      abandon: () => {},
      preSnapshotId: 'snap-pre-combat-warning',
      restart: async () => {
        throw new Error('restart failed');
      },
    });
    store.v3ActiveCombat = {} as never;
    store.isGenerating = true;

    const result = await store.restartCombat();

    expect(result).toEqual({
      status: 'restored',
      continuation: 'same-save',
      warning: '已回到战斗前，但战斗未能重新开始',
    });
    expect(store.activeSaveId).toBe(SAVE_ID);
    expect(store.characters.find((character) => character.id === 'hero')?.hp).toBe(80);
  });

  it('T16：runCombatV3 期间经 store.submitCombatCommand 喂入玩家命令并推进战斗（coordinator 句柄先挂）', async () => {
    const store = useGameStore();
    const seen: CombatEvent[] = [];
    // 模拟 game-pipeline 的桥（T16 时序修复后的真实形状）：submitCommand 是 no-op
    // （等待态由事件驱动 store），waitForCommand 暴露 pendingResolve，coordinator 句柄
    // 在 runCombatV3 **之前**挂到 store —— 战斗进行中玩家命令才能经 submit 喂入。
    let pendingResolve: ((c: CombatCommand) => void) | null = null;
    const waitForCommand = () => new Promise<CombatCommand>((r) => (pendingResolve = r));

    const opts: RunCombatV3Opts = {
      saveId: SAVE_ID,
      bundle: mkBundle({
        combatId: 't16-bridge',
        participants: [
          mkParticipant('甲'),
          mkParticipant('乙', {
            side: 'enemy',
            characterId: '乙',
            name: '乙',
            hp: 1,
            maxHp: 1,
            defense: 0,
            dr: 0,
          }),
        ],
      }),
      deps: {
        clientFactory: () =>
          ({
            chatWithTools: async () => ({ output: null, rawResponse: '', toolCalls: [] }),
            chat: async () => ({ output: null, rawResponse: '' }),
          }) as never,
        endpoint: { id: 'ep' } as never,
        stateManager: { commitChatState: async () => {} },
        characters: [],
        context: {} as never,
        submitCommand: async () => {}, // 等待态由 v3_awaiting_player_input 事件驱动 store
        waitForCommand,
        abandon: () => {},
        drawDice: () => ({ outputId: 't16-dice', dice: Array.from({ length: 60 }, () => 10) }),
      },
      onCombatEvent: (evt) => {
        seen.push(evt);
        store.applyCombatEvent(evt);
      },
    };

    // 🔴 时序修复契约：句柄先挂（runCombatV3 之前），战斗进行中才能喂命令
    store.setCombatCoordinator({
      submit: async (cmd: CombatCommand) => {
        if (pendingResolve) {
          const r = pendingResolve;
          pendingResolve = null;
          r(cmd);
        }
      },
      abandon: () => {},
      waitForCommand,
    });

    const runPromise = runCombatV3(opts); // 不 await：让战斗在玩家回合挂起

    // 等轮到玩家（v3_awaiting_player_input 到达 → combatAwaitingInput 亮起「轮到你了」）
    await vi.waitFor(() => {
      expect(store.combatAwaitingInput?.unitId).toBe('甲');
    });

    // 玩家命令经 store.submitCombatCommand 喂入（自动补 commandId/expectedRevision）并推进战斗。
    // 🔴 照真实 UI 的节奏：每次提交都**等下一枚等待事件**再喂下一条 —— 战斗面板的
    //    提交按钮正是由 combatAwaitingInput 门控的（submit 只消费当前 pendingResolve；
    //    抢跑的命令会因 pendingResolve 未就绪被静默丢弃）。
    await store.submitCombatCommand({
      kind: 'DeclareAttack',
      actorId: '甲',
      cost: 'attack',
      payload: { targetId: '乙', intentionLevel: '常规' },
    });
    // 等第二枚等待事件（攻击后内核要求消费 action 槽）
    await vi.waitFor(() => {
      expect(seen.filter((e) => e.type === 'v3_awaiting_player_input').length).toBe(2);
    });
    await store.submitCombatCommand({
      kind: 'PassAction',
      actorId: '甲',
      cost: 'action',
      payload: {},
    });

    const result = await runPromise;
    expect(result.outcome).toBe('ally_win');
    expect(seen.some((e) => e.type === 'v3_awaiting_player_input')).toBe(true);
  });

  it('🎭 主持人/DM 模式：玩家意图文本 → 主持人解析 → Command → 内核推进（submitCombatIntent 链路）', async () => {
    const store = useGameStore();
    const seen: CombatEvent[] = [];
    // game-pipeline 意图文本桥（主持人模式）：waitForPlayerIntent 暴露 pending resolve，
    // coordinator 句柄在 runCombatV3 之前挂到 store。
    let pendingIntentResolve: ((text: string) => void) | null = null;
    const waitForPlayerIntent = () => new Promise<string>((r) => (pendingIntentResolve = r));

    // fake 主持人：玩家意图文本「攻击乙」→ 声明攻击；敌方轮次 → 扮演乙 pass 双槽。
    // 首个 chatWithTools 调用是开局氛围（F5：openCombatScene，含「战斗开场」user）
    // ——返回氛围描写、不产命令；此后进入正式决策（【玩家意图】/轮到敌方）。
    let hostCallIdx = 0;
    const opts: RunCombatV3Opts = {
      saveId: SAVE_ID,
      bundle: mkBundle({
        combatId: 't16-host-bridge',
        participants: [
          mkParticipant('甲'),
          mkParticipant('乙', {
            side: 'enemy',
            characterId: '乙',
            name: '乙',
            hp: 1,
            maxHp: 1,
            defense: 0,
            dr: 0,
          }),
        ],
      }),
      deps: {
        configs: [
          {
            agentId: 'combat_v3',
            systemPrompt: 'TEST_HOST_SYSTEM_PROMPT',
          } as never,
        ],
        clientFactory: () =>
          ({
            chatWithTools: async (
              req: { messages: Array<{ role: string; content: string | null }> },
              toolExecutor: (n: string, a: Record<string, any>) => Promise<unknown>,
            ) => {
              hostCallIdx++;
              // ① 开局氛围调用：只输出氛围，不产命令
              if (hostCallIdx === 1) {
                return { output: '战场杀意弥漫', rawResponse: '', toolCalls: [] } as never;
              }
              // ② 正式决策：主持人读到【玩家意图】→ 按意图声明玩家动作；否则视为敌方轮次
              const lastUser =
                req.messages
                  .filter((m) => m.role === 'user' && m.content !== null)
                  .map((m) => m.content as string)
                  .pop() ?? '';
              const history: Array<{ name: string; arguments: unknown; result: unknown }> = [];
              if (lastUser.includes('【玩家意图】') && lastUser.includes('结束本回合')) {
                const args = { actorName: '甲' };
                const result = await toolExecutor('end_turn', args);
                history.push({ name: 'end_turn', arguments: args, result });
              } else if (lastUser.includes('【玩家意图】')) {
                const args = { actorName: '甲', targetName: '乙', intentionLevel: '常规' };
                const result = await toolExecutor('declare_attack', args);
                history.push({ name: 'declare_attack', arguments: args, result });
              } else {
                // 敌方轮次：扮演乙 pass 双槽（不撞 SLOT_EXHAUSTED）
                const script = [
                  { name: 'pass_slot', args: { actorName: '乙', slot: 'attack' } },
                  { name: 'pass_slot', args: { actorName: '乙', slot: 'action' } },
                ];
                for (const step of script) {
                  const result = await toolExecutor(step.name, step.args);
                  history.push({ name: step.name, arguments: step.args, result });
                }
              }
              return { output: '主持人演绎', rawResponse: '', toolCalls: history } as never;
            },
            chat: async () => ({ output: null, rawResponse: '' }),
          }) as never,
        endpoint: { id: 'ep' } as never,
        stateManager: { commitChatState: async () => {} },
        characters: [],
        context: {} as never,
        submitCommand: async () => {},
        waitForCommand: async () => {
          throw new Error('主持人模式不应走 Command 桥');
        },
        submitPlayerIntent: async () => {},
        waitForPlayerIntent,
        abandon: () => {},
        drawDice: () => ({ outputId: 'host-dice', dice: Array.from({ length: 60 }, () => 10) }),
      },
      onCombatEvent: (evt) => {
        seen.push(evt);
        store.applyCombatEvent(evt);
      },
    };

    // 🔴 句柄先挂（runCombatV3 之前），战斗进行中玩家意图才能喂入
    store.setCombatCoordinator({
      submitPlayerIntent: async (text: string) => {
        if (pendingIntentResolve) {
          const r = pendingIntentResolve;
          pendingIntentResolve = null;
          r(text);
        }
      },
      abandon: () => {},
    });

    const runPromise = runCombatV3(opts); // 不 await：让战斗在玩家回合挂起

    // 等轮到玩家 → 喂意图「攻击乙」→ 主持人解析成 DeclareAttack → 内核结算
    await vi.waitFor(() => {
      expect(store.combatAwaitingInput?.unitId).toBe('甲');
    });
    await store.submitCombatIntent('攻击乙');
    // 等第二枚等待事件（攻击后内核要求消费 action 槽）→ 喂「结束本回合」
    await vi.waitFor(() => {
      expect(seen.filter((e) => e.type === 'v3_awaiting_player_input').length).toBe(2);
    });
    await store.submitCombatIntent('我方「甲」结束本回合');

    const result = await runPromise;
    // 主持人链路推进战斗并正常结算（意图文本 → 主持人 → Command → 内核）
    expect(result.outcome).toBe('ally_win');
    // 敌人真的被攻击（v3_action 攻击卡片来自内核真实结算）
    expect(seen.some((e) => e.type === 'v3_action' && e.toolName === 'attack')).toBe(true);
  });
});

// ===== T15：v3 事件链路（真实 runCombatV3 → store.applyCombatEvent） =====
// 设计 2026-08-09 §3.4 问题 3（面板不弹）：从 coordinator 的 emitEvents（含 T13 的
// v3_units_snapshot 补发）一路跑到 game-store，验证事件**完整到达**且 v3ActiveCombat
// 正确填充（含 units）。驱动方式照 coordinator.test.ts 的先例（玩家命令队列 + fake
// 敌方 agent）；onCombatEvent 桥与 game-pipeline.handleCombatTriggerV3 的接法一致
// （evt => game.applyCombatEvent(evt)）。
describe('T15 v3 事件链路（真实 runCombatV3 → store）', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await initializeDatabase();
  });

  /** fake 敌方 agent client：脚本化工具调用（一次调用 = 一个 Command）；无脚本 → 防御性 pass */
  function fakeEnemyClient(
    script: Array<{ name: string; args: Record<string, any> }>,
  ): CombatClient {
    let idx = 0;
    return {
      chatWithTools: async () => {
        const step = script[Math.min(idx, script.length - 1)];
        idx++;
        if (!step) {
          return { output: null, rawResponse: '', toolCalls: [] } as never;
        }
        return {
          output: 'ok',
          rawResponse: '',
          toolCalls: [{ name: step.name, arguments: step.args }],
        } as never;
      },
      chat: async () => ({ output: null, rawResponse: '' }) as never,
    };
  }

  it('v3_combat_started 先行、v3_units_snapshot 紧随到达 store；v3ActiveCombat 含完整 units；isInCombat 驱动面板显示', async () => {
    const store = useGameStore();
    const seen: CombatEvent[] = [];
    // 事件到达**那一刻**的 store 状态快照（证明面板驱动与数据填充是事件本身完成的）
    const snapshots: Array<{ type: string; isInCombat: boolean; unitsCount: number }> = [];
    const commit = vi.fn(async () => {});

    // 甲(player) 一刀杀乙(enemy, 脆皮 HP1) → hp_zero 终局；乙若轮到自己则 pass（不真打）
    const queue: CombatCommand[] = [
      mkAttack('t15-att', -1, '甲', '乙'),
      mkPass('t15-act', -1, '甲', 'action'),
    ];
    const opts: RunCombatV3Opts = {
      saveId: SAVE_ID,
      bundle: mkBundle({
        combatId: 't15-link',
        participants: [
          mkParticipant('甲'),
          mkParticipant('乙', {
            side: 'enemy',
            characterId: '乙',
            name: '乙',
            hp: 1,
            maxHp: 1,
            defense: 0,
            dr: 0,
          }),
        ],
      }),
      deps: {
        clientFactory: () => fakeEnemyClient([]),
        endpoint: { id: 'ep' } as never,
        stateManager: { commitChatState: commit },
        characters: [],
        context: {} as never,
        submitCommand: async () => {},
        waitForCommand: async () => queue.shift()!,
        abandon: () => {},
        drawDice: () => ({ outputId: 't15-dice', dice: Array.from({ length: 60 }, () => 10) }),
      },
      onCombatEvent: (evt) => {
        seen.push(evt);
        store.applyCombatEvent(evt);
        snapshots.push({
          type: evt.type,
          isInCombat: store.isInCombat,
          unitsCount: Object.keys(store.v3ActiveCombat?.units ?? {}).length,
        });
      },
    };

    const result = await runCombatV3(opts);

    // ① T13 时序契约：v3_combat_started 先落 store（建 v3ActiveCombat），
    //    v3_units_snapshot 紧随（填 units 字典）——顺序不可换。
    //    （注意：首次 dispatch 是 SupplyDice，reducer 有独立短路只产「骰池续杯」
    //    NarrativeCue，不走 autoFn——所以 v3_combat_started 在第 2 次 dispatch 才发，
    //    但它的到达与随后的快照仍是同一对、相邻且有序。）
    const startedIdx = seen.findIndex((e) => e.type === 'v3_combat_started');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(seen[startedIdx]).toMatchObject({ type: 'v3_combat_started', combatId: 't15-link' });
    expect(seen[startedIdx + 1]).toMatchObject({ type: 'v3_units_snapshot' });

    // ② 面板弹出驱动（§3.4 问题 3）：v3_combat_started 到达的瞬间 isInCombat 已为 true
    //    （CombatPanel 的 v-if 显示条件），v3_units_snapshot 随后把 units 补齐（面板有数据）
    const startedSnapshot = snapshots.find((s) => s.type === 'v3_combat_started');
    expect(startedSnapshot).toMatchObject({ isInCombat: true, unitsCount: 0 });
    const snapshotShot = snapshots.find((s) => s.type === 'v3_units_snapshot');
    expect(snapshotShot).toMatchObject({ isInCombat: true, unitsCount: 2 });

    // ③ v3ActiveCombat 填充正确（含 units 完整字典）
    expect(store.v3ActiveCombat).not.toBeNull();
    expect(store.v3ActiveCombat?.units['甲']).toMatchObject({ id: '甲', side: 'player' });
    expect(store.v3ActiveCombat?.units['乙']).toMatchObject({ id: '乙', side: 'enemy' });
    expect(Object.keys(store.v3ActiveCombat?.units ?? {})).toHaveLength(2);

    // ④ 战斗正常走完（非熔断 abandon）→ 终局事件到达 store。M1 内核 settle 只产
    //    CombatEnded + NarrativeCue（**不产 SettlementCommitted**，projection-ui 注释
    //    明说那要 M2 补）→ store 的 v3_combat_ended 分支把 phase 置 Terminal；面板最终
    //    关闭由 game-pipeline.handleCombatTriggerV3 终局后的 exitCombat() 兜底（这里模拟）
    expect(result.outcome).toBe('ally_win');
    expect(seen.some((e) => e.type === 'v3_combat_ended')).toBe(true);
    expect(store.v3ActiveCombat?.phase).toBe('Terminal');
    store.exitCombat();
    expect(store.v3ActiveCombat).toBeNull();
    expect(store.isInCombat).toBe(false);
  });
});

// ===== Agent 调试历史 =====

describe('Agent 调试历史', () => {
  it('同名 Agent 的不同 invocation 不覆盖，并可从 IndexedDB 恢复', async () => {
    await saveSaveSlot(makeSaveSlot());
    const game = makeStore();
    await game.loadSave(SAVE_ID);
    game.startAgentLogTurn({ id: 'run-1', saveId: SAVE_ID, turn: 1, sourceMessageId: 'msg-1' });

    const makeEntry = (invocationId: string, rawResponse: string) => ({
      invocationId,
      turnId: 'run-1',
      agentId: 'char_gen',
      label: '角色生成',
      endpointId: 'ep',
      endpointName: 'DeepSeek',
      baseUrl: 'https://api.example.test',
      model: 'model',
      messages: [{ role: 'system', content: 'prompt' }],
      rawResponse,
      tokensUsed: 10,
      cacheHit: false,
      duration: 20,
      startedAt: 100,
      completedAt: 120,
    });

    game.addAgentLogEntry(makeEntry('run-1:char_gen:1', 'first'));
    game.addAgentLogEntry(makeEntry('run-1:char_gen:2', 'second'));
    game.addAgentLogEntry({ ...makeEntry('run-1:char_gen:1', 'first-updated'), tokensUsed: 11 });
    game.finishAgentLogTurn('run-1', 'completed');
    await game.flushAgentLogWrites();

    expect(game.agentLog).toHaveLength(2);
    expect(game.agentLog.map((entry) => entry.rawResponse)).toEqual(['first-updated', 'second']);

    const reloaded = makeStore();
    await reloaded.loadSave(SAVE_ID);
    expect(reloaded.agentLogHistory).toHaveLength(1);
    expect(reloaded.agentLog).toHaveLength(2);
    expect(reloaded.agentLogHistory[0].status).toBe('completed');
  });
});

// ===== EJS 诊断（工坊 P2 / 能力面）=====

/**
 * 这三样都是**静默失效**的诊断：条目回退、变量丢弃、内容自打的 log。
 * 它们不影响游戏能不能跑，只影响「坏了之后能不能查」—— 而调试循环手册的口径是
 * 「游玩 → 导出 → 分析」，所以它们必须**留在内存里到导出那一刻**，不能随轮清空。
 */
describe('EJS 诊断累计', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('回退：同 agent+uid 累加计数，不同条目各占一行', () => {
    const game = useGameStore();
    game.recordEjsFallback('story', [
      { uid: 101, bookName: '主世界观', error: 'SyntaxError: x' },
      { uid: 102, bookName: '数值', error: 'ReferenceError: y' },
    ]);
    game.recordEjsFallback('story', [{ uid: 101, bookName: '主世界观', error: 'SyntaxError: z' }]);

    expect(game.ejsFallbacks).toHaveLength(2);
    const first = game.ejsFallbacks.find((f) => f.uid === 101)!;
    expect(first.count).toBe(2);
    // 留最近一次错因 —— 同条目换个错更值得看
    expect(first.error).toBe('SyntaxError: z');
    expect(game.ejsFallbacks.find((f) => f.uid === 102)!.count).toBe(1);
  });

  it('回退：不同 Agent 的同一条目分开记（可见性分区不同，失败原因可能不同）', () => {
    const game = useGameStore();
    game.recordEjsFallback('story', [{ uid: 7, error: 'e1' }]);
    game.recordEjsFallback('vars_update', [{ uid: 7, error: 'e2' }]);
    expect(game.ejsFallbacks).toHaveLength(2);
  });

  it('ui.log：按序累积，且有会话级天花板（512）', () => {
    const game = useGameStore();
    for (let i = 0; i < 600; i++) game.recordEjsUiLog(`line-${i}`);
    expect(game.ejsUiLog).toHaveLength(512);
    // 丢的是最旧的
    expect(game.ejsUiLog[0]).toBe('line-88');
    expect(game.ejsUiLog[511]).toBe('line-599');
  });

  it('三样都是整局累计 —— 不随轮清空（clearAgentLog 不碰它们）', () => {
    const game = useGameStore();
    game.recordEjsFallback('story', [{ uid: 1, error: 'e' }]);
    game.recordEjsVarsRejection('story', '正文', 999);
    game.recordEjsUiLog('hello');

    game.clearAgentLog();

    expect(game.ejsFallbacks).toHaveLength(1);
    expect(game.ejsVarsRejections).toHaveLength(1);
    expect(game.ejsUiLog).toHaveLength(1);
  });
});

// ===== allocateAttrPoint（自由属性点） =====

describe('allocateAttrPoint', () => {
  let store: ReturnType<typeof useGameStore>;

  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
    allocateAttributePointMock.mockReset();
    store = makeStore();
  });

  /** 存档 + 一个叫「理查德」的主角 */
  async function seedPlayer() {
    await saveSaveSlot(makeSaveSlot());
    await saveCharacter(
      makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 30, maxHp: 100 }),
    );
    await saveSaveProfile(makeProfile());
    await store.loadSave(SAVE_ID);
  }

  it('按 (saveId, 玩家名, 维度) 调引擎，成功后回读 DB（面板才看得见新值）', async () => {
    await seedPlayer();
    allocateAttributePointMock.mockResolvedValue({ ok: true });

    // 引擎已被替身，DB 不会自己变 —— 手动模拟「引擎落库了」，
    // 回读跑没跑就成了内存里看得出来的差别。
    await saveCharacter(
      makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 99, maxHp: 100 }),
    );

    const result = await store.allocateAttrPoint('str');

    expect(result).toEqual({ ok: true });
    expect(allocateAttributePointMock).toHaveBeenCalledWith(SAVE_ID, '理查德', 'str');
    expect(store.characters.find((c) => c.id === 'hero')?.hp).toBe(99);
  });

  it('无活跃存档 → 直接 ok:false，引擎一次都不调', async () => {
    const result = await store.allocateAttrPoint('dex');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(allocateAttributePointMock).not.toHaveBeenCalled();
  });

  it('有存档但没有主角 → ok:false，引擎一次都不调', async () => {
    await saveSaveSlot(makeSaveSlot());
    await store.loadSave(SAVE_ID);
    const result = await store.allocateAttrPoint('con');
    expect(result.ok).toBe(false);
    expect(allocateAttributePointMock).not.toHaveBeenCalled();
  });

  it('引擎拒绝 → 原样交回失败原因，且不回读（组件负责播报）', async () => {
    await seedPlayer();
    allocateAttributePointMock.mockResolvedValue({ ok: false, error: '没有可用的自由属性点' });

    await saveCharacter(
      makeChar({ id: 'hero', name: '理查德', type: 'player', hp: 99, maxHp: 100 }),
    );

    const result = await store.allocateAttrPoint('int');

    expect(result).toEqual({ ok: false, error: '没有可用的自由属性点' });
    expect(store.characters.find((c) => c.id === 'hero')?.hp).toBe(30);
  });

  it('引擎抛异常 → 收成 ok:false，不把异常泼给组件', async () => {
    await seedPlayer();
    allocateAttributePointMock.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await store.allocateAttrPoint('spi');

    expect(result.ok).toBe(false);
    spy.mockRestore();
  });
});

describe('markOpeningPromptConsumed', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  it('claims an opening prompt once across concurrent callers and persists the claim', async () => {
    const base = makeSaveSlot();
    await saveSaveSlot(
      makeSaveSlot({
        metadata: {
          ...base.metadata,
          openingPrompt: 'OPENING',
          openingPromptConsumed: false,
        },
      }),
    );
    const store = makeStore();
    await store.loadSave(SAVE_ID);

    const results = await Promise.all([
      store.markOpeningPromptConsumed(),
      store.markOpeningPromptConsumed(),
    ]);

    expect(results).toEqual([true, false]);
    expect(store.hasOpeningPromptConsumed).toBe(true);
    expect((await getSave(SAVE_ID))?.metadata.openingPromptConsumed).toBe(true);
  });

  it('releases a claim back to disk so a failed opening can be retried', async () => {
    const base = makeSaveSlot();
    await saveSaveSlot(
      makeSaveSlot({
        metadata: { ...base.metadata, openingPrompt: 'OPENING', openingPromptConsumed: false },
      }),
    );
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(await store.markOpeningPromptConsumed()).toBe(true);

    expect(await store.releaseOpeningPromptClaim()).toBe(true);
    expect(store.hasOpeningPromptConsumed).toBe(false);
    expect((await getSave(SAVE_ID))?.metadata.openingPromptConsumed).toBe(false);

    // 归还之后能重新认领，且第二次归还是空转（没认领过就没什么可还的）。
    expect(await store.markOpeningPromptConsumed()).toBe(true);
    expect(await store.releaseOpeningPromptClaim()).toBe(true);
    expect(await store.releaseOpeningPromptClaim()).toBe(false);
  });
});

// ===== removeItem / removeSkill / removeCharacter =====

describe('removeItem / removeSkill / removeCharacter', () => {
  beforeEach(async () => {
    try {
      await clearAllData();
    } catch {
      /* db may not exist yet */
    }
    await initializeDatabase();
  });

  /** 种入：玩家（带物品+技能）+ 一个 NPC */
  async function seedPlayerAndNpc() {
    await saveSaveSlot(
      makeSaveSlot({
        metadata: {
          characterName: '理查德',
          userName: 'Tester',
          gameStartTime: '001-01-01',
          totalTurns: 2,
        } as any,
      }),
    );
    await saveCharacter(
      makeChar({
        id: 'player-1',
        name: '理查德',
        type: 'player',
        hp: 30,
        maxHp: 100,
        inventory: [
          { name: '铁剑', quantity: 1, rarity: '普通' as const },
          { name: '治疗药水', quantity: 3, rarity: '普通' as const },
        ] as any,
        skills: [{ name: '火球术', level: 1 } as any],
      }),
    );
    await saveCharacter(makeChar({ id: 'npc-1', name: '龙套甲', type: 'npc', hp: 10, maxHp: 20 }));
    await saveSaveProfile(makeProfile({ fp: 3 }));
  }

  it('removeItem 丢弃物品：数量扣减，扣到 0 移除', async () => {
    await seedPlayerAndNpc();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(store.player?.name).toBe('理查德');

    // 丢弃治疗药水 1 瓶 → 剩 2
    const r1 = await store.removeItem('治疗药水', 1);
    expect(r1.ok).toBe(true);
    expect(store.player?.inventory.find((i) => i.name === '治疗药水')?.quantity).toBe(2);

    // 再丢 2 瓶 → 归零移除
    const r2 = await store.removeItem('治疗药水', 2);
    expect(r2.ok).toBe(true);
    expect(store.player?.inventory.find((i) => i.name === '治疗药水')).toBeUndefined();
    // 铁剑还在
    expect(store.player?.inventory.some((i) => i.name === '铁剑')).toBe(true);
  });

  it('removeItem 丢弃不存在的物品 → 报错', async () => {
    await seedPlayerAndNpc();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    const r = await store.removeItem('不存在的物品', 1);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('removeSkill 删除技能', async () => {
    await seedPlayerAndNpc();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(store.player?.skills.some((s) => s.name === '火球术')).toBe(true);

    const r = await store.removeSkill('火球术');
    expect(r.ok).toBe(true);
    expect(store.player?.skills.some((s) => s.name === '火球术')).toBe(false);
  });

  it('removeCharacter 删除 NPC（玩家不可删）', async () => {
    await seedPlayerAndNpc();
    const store = makeStore();
    await store.loadSave(SAVE_ID);
    expect(store.npcs.some((c) => c.name === '龙套甲')).toBe(true);

    // 删 NPC 成功，且内存角色整表替换后 NPC 消失
    const r = await store.removeCharacter('龙套甲');
    expect(r.ok).toBe(true);
    expect(store.npcs.some((c) => c.name === '龙套甲')).toBe(false);
    // 玩家还在
    expect(store.player?.name).toBe('理查德');

    // 删玩家被拒
    const r2 = await store.removeCharacter('理查德');
    expect(r2.ok).toBe(false);
  });
});
