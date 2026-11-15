import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  getCharacters,
  getMemories,
  initializeDatabase,
  saveMemory,
  saveCharacter,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { createStateManager } from '../../../src/core/state/state-manager';
import { withGlobalWriteLock, withSaveWriteLock } from '../../../src/core/state/state-write-queue';
import { getProfile, updateProfile } from '../../../src/core/state/save-profile';
import { translatePluginCommands } from '../../../src/core/plugins/plugin-commands';
import { createDefaultCharacterState, type MemoryRecord } from '../../../src/core/types/types';
import type { StatePatch } from '../../../src/core/types/types';
import type { PluginRunGuard } from '../../../src/core/types/types-plugin';

const SAVE = 'plugin-commit';
const ok: PluginRunGuard = () => 'ok';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function player() {
  return (await getCharacters(SAVE)).find((c) => c.type === 'player')!;
}

beforeEach(async () => {
  await clearAllData();
  await initializeDatabase();
  await saveSaveSlot({
    id: SAVE,
    name: SAVE,
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: { characterName: 'Player', userName: '玩家', gameStartTime: '', totalTurns: 1 },
  });
  await saveCharacter(
    createDefaultCharacterState({
      id: 'p',
      saveId: SAVE,
      name: 'Player',
      aliases: ['阿明'],
      type: 'player',
      hp: 80,
      maxHp: 100,
      money: 50,
    }),
  );
  await saveCharacter(
    createDefaultCharacterState({ id: 'n', saveId: SAVE, name: '店主', type: 'npc' }),
  );
  const profile = await getProfile(SAVE);
  profile.fp = 10;
  await updateProfile(profile);
});

describe('StateManager.commitPluginCommand', () => {
  it('成功时整批落库并发布事件', async () => {
    const manager = createStateManager(SAVE);
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.shop',
      patches: [
        { op: 'set_hp', target: 'characters.Player', value: 20 },
        { op: 'delta_variable', target: 'profile.fp', amount: 3 },
        { op: 'set_variable', target: 'variables.user.shop.stock', value: 4 },
      ],
      expect: [],
      isAllowed: ok,
    });
    expect(result).toEqual({ ok: true });
    expect((await player()).hp).toBe(20);
    const profile = await getProfile(SAVE);
    expect(profile.fp).toBe(13);
    expect(profile.variables).toMatchObject({ user: { shop: { stock: 4 } } });
    expect(manager.getEvents()).toHaveLength(3);
  });

  it('前置条件不满足时什么都不写，返回 PRECONDITION_FAILED 与下标', async () => {
    const manager = createStateManager(SAVE);
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.shop',
      patches: [{ op: 'set_hp', target: 'characters.Player', value: 20 }],
      expect: [
        { var: 'user.missing', exists: false },
        { view: 'player.money', gte: 999 },
      ],
      isAllowed: ok,
    });
    expect(result).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED', index: 1 });
    expect((await player()).hp).toBe(80);
    expect(manager.getEvents()).toEqual([]);
  });

  it('批次中途某条补丁失败时整批回滚（含 FP 账务），下标换算成命令下标', async () => {
    const manager = createStateManager(SAVE);
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.shop',
      patches: [
        { op: 'delta_variable', target: 'profile.fp', amount: 5 },
        { op: 'set_hp', target: 'characters.Player', value: 20 },
        { op: 'remove_item', target: 'characters.Player', value: { name: '不存在', quantity: 1 } },
      ],
      expect: [],
      isAllowed: ok,
      commandIndexOfPatch: [0, 1, 4],
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID', index: 4 });
    expect((await getProfile(SAVE)).fp).toBe(10);
    expect((await getProfile(SAVE)).fpHistory).toEqual([]);
    expect((await player()).hp).toBe(80);
    expect(manager.getEvents()).toEqual([]);
  });

  it('FP 不足时扣 FP 失败，整批不落', async () => {
    const manager = createStateManager(SAVE);
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.shop',
      patches: [
        { op: 'set_hp', target: 'characters.Player', value: 20 },
        { op: 'delta_variable', target: 'profile.fp', amount: -50 },
      ],
      expect: [],
      isAllowed: ok,
    });
    expect(result).toMatchObject({ ok: false, code: 'INVALID', index: 1 });
    expect((await player()).hp).toBe(80);
    expect((await getProfile(SAVE)).fp).toBe(10);
  });

  it.each(['BUSY', 'IN_COMBAT'] as const)(
    '排队等锁期间运行态翻转为 %s 时返回该码且不写入',
    async (code) => {
      const gate = deferred();
      const entered = deferred();
      let state: 'ok' | 'BUSY' | 'IN_COMBAT' = 'ok';
      const held = withSaveWriteLock(SAVE, async () => {
        entered.resolve();
        await gate.promise;
      });
      await entered.promise;
      const manager = createStateManager(SAVE);
      const pending = manager.commitPluginCommand({
        saveId: SAVE,
        pluginId: 'demo.shop',
        patches: [{ op: 'set_hp', target: 'characters.Player', value: 20 }],
        expect: [],
        isAllowed: () => state,
      });
      state = code;
      gate.resolve();
      await held;
      expect(await pending).toMatchObject({ ok: false, code });
      expect((await player()).hp).toBe(80);
      expect(manager.getEvents()).toEqual([]);
    },
  );

  it('经别名移除主角时返回 DENIED，什么都不写', async () => {
    const manager = createStateManager(SAVE);
    const translated = translatePluginCommands({
      commands: [
        { type: 'resource.set', resource: 'hp', value: 20 },
        { type: 'character.remove', target: '阿明' },
      ],
      expect: [],
      declared: ['resource.set', 'character.remove'],
      saveId: SAVE,
      playerName: 'Player',
    });
    expect(translated.ok).toBe(true);
    if (!translated.ok) return;
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.evil',
      patches: translated.patches,
      expect: translated.expect,
      isAllowed: ok,
      commandIndexOfPatch: translated.commandIndexOfPatch,
    });
    expect(result).toMatchObject({ ok: false, code: 'DENIED', index: 1 });
    expect((await getCharacters(SAVE)).map((c) => c.name).sort()).toEqual(['Player', '店主']);
    expect((await player()).hp).toBe(80);
    expect(manager.getEvents()).toEqual([]);
  });

  it('经别名给主角改名时返回 DENIED', async () => {
    const manager = createStateManager(SAVE);
    const patches: StatePatch[] = [
      { op: 'rename_character', target: 'characters.阿明', value: '新名字' },
    ];
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo.evil',
      patches,
      expect: [],
      isAllowed: ok,
    });
    expect(result).toMatchObject({ ok: false, code: 'DENIED', index: 0 });
    expect((await player()).name).toBe('Player');
  });

  it('移除普通 NPC 仍然允许', async () => {
    const manager = createStateManager(SAVE);
    const result = await manager.commitPluginCommand({
      saveId: SAVE,
      pluginId: 'demo',
      patches: [{ op: 'remove_character', target: 'characters.店主' }],
      expect: [],
      isAllowed: ok,
    });
    expect(result).toEqual({ ok: true });
    expect((await getCharacters(SAVE)).map((c) => c.name)).toEqual(['Player']);
  });

  it('存档 id 不符或存档不存在时返回 NO_SAVE', async () => {
    const patches: StatePatch[] = [{ op: 'set_hp', target: 'characters.Player', value: 20 }];
    const mismatch = await createStateManager(SAVE).commitPluginCommand({
      saveId: 'other',
      pluginId: 'demo',
      patches,
      expect: [],
      isAllowed: ok,
    });
    expect(mismatch).toMatchObject({ ok: false, code: 'NO_SAVE' });
    const missing = await createStateManager('ghost').commitPluginCommand({
      saveId: 'ghost',
      pluginId: 'demo',
      patches,
      expect: [],
      isAllowed: ok,
    });
    expect(missing).toMatchObject({ ok: false, code: 'NO_SAVE' });
    expect((await player()).hp).toBe(80);
  });

  describe('§7 商店购买端到端（translatePluginCommands → commitPluginCommand）', () => {
    const buy = () =>
      translatePluginCommands({
        commands: [
          { type: 'money.spend', amount: 30 },
          {
            type: 'item.grant',
            item: {
              name: '治疗药水',
              quantity: 1,
              type: 'consumable',
              rarity: '普通',
              description: '一瓶淡红色的药水。',
            },
          },
        ],
        expect: [],
        declared: ['money.spend', 'item.grant'],
        saveId: SAVE,
        playerName: 'Player',
      });

    it('余额足够时扣款并发放物品', async () => {
      const translated = buy();
      expect(translated.ok).toBe(true);
      if (!translated.ok) return;
      const manager = createStateManager(SAVE);
      const result = await manager.commitPluginCommand({
        saveId: SAVE,
        pluginId: 'demo.shop',
        patches: translated.patches,
        expect: translated.expect,
        isAllowed: ok,
        commandIndexOfPatch: translated.commandIndexOfPatch,
      });
      expect(result).toEqual({ ok: true });
      const p = await player();
      expect(p.money).toBe(20);
      expect(p.inventory).toMatchObject([{ name: '治疗药水', quantity: 1 }]);
      expect(manager.getEvents()).toHaveLength(2);
    });

    it('第二次购买余额不足时返回 PRECONDITION_FAILED，什么都不落', async () => {
      const manager = createStateManager(SAVE);
      const commit = async () => {
        const translated = buy();
        if (!translated.ok) throw new Error(translated.message);
        return manager.commitPluginCommand({
          saveId: SAVE,
          pluginId: 'demo.shop',
          patches: translated.patches,
          expect: translated.expect,
          isAllowed: ok,
          commandIndexOfPatch: translated.commandIndexOfPatch,
        });
      };
      expect(await commit()).toEqual({ ok: true });
      const eventsAfterFirst = manager.getEvents().length;
      expect(await commit()).toMatchObject({ ok: false, code: 'PRECONDITION_FAILED' });
      const p = await player();
      expect(p.money).toBe(20);
      expect(p.inventory).toMatchObject([{ name: '治疗药水', quantity: 1 }]);
      expect(manager.getEvents()).toHaveLength(eventsAfterFirst);
    });
  });
  describe('memory.add：记忆 id 由引擎在全局锁 + 事务里分配', () => {
    const addMemory = (content: string, extra: Record<string, unknown> = {}) =>
      translatePluginCommands({
        commands: [{ type: 'memory.add', content, ...extra }],
        expect: [],
        declared: ['memory.add', 'resource.set', 'item.remove'],
        saveId: SAVE,
        playerName: 'Player',
      });

    function existingMemory(id: string, saveId: string): MemoryRecord {
      return {
        id,
        saveId,
        createdAt: 1,
        realTimestamp: 1,
        timeRange: { start: '', end: '' },
        content: '旧记忆',
        hiddenLine: '',
        keywords: [],
        relatedCharacterIds: [],
        importance: 5,
      };
    }

    it('落一条记忆，id 接着全库最大号往下发（跨存档），其余字段由引擎补齐', async () => {
      await saveMemory(existingMemory('MEM000007', 'another-save'));
      const translated = addMemory('在旧城门下与店主立了约。', {
        keywords: ['约定', '店主'],
        importance: 8,
      });
      expect(translated.ok).toBe(true);
      if (!translated.ok) return;
      expect(translated.patches[0].value).not.toHaveProperty('id');
      const manager = createStateManager(SAVE);
      const result = await manager.commitPluginCommand({
        saveId: SAVE,
        pluginId: 'demo.diary',
        patches: [...translated.patches, ...translated.patches],
        expect: [],
        isAllowed: ok,
      });
      expect(result).toEqual({ ok: true });
      const memories = (await getMemories(SAVE)).sort((a, b) => a.id.localeCompare(b.id));
      expect(memories.map((m) => m.id)).toEqual(['MEM000008', 'MEM000009']);
      expect(memories[0]).toMatchObject({
        saveId: SAVE,
        content: '在旧城门下与店主立了约。',
        keywords: ['约定', '店主'],
        importance: 8,
        hiddenLine: '',
        relatedCharacterIds: [],
      });
      expect(memories[0].timeRange.start.length).toBeGreaterThan(0);
      expect(manager.getEvents()).toHaveLength(2);
    });

    it('锁顺序为全局在外、存档在内：全局锁被占时提交等待，不先占存档锁', async () => {
      const gate = deferred();
      const entered = deferred();
      const held = withGlobalWriteLock(async () => {
        entered.resolve();
        await gate.promise;
      });
      await entered.promise;
      const translated = addMemory('等锁的记忆');
      if (!translated.ok) throw new Error(translated.message);
      const manager = createStateManager(SAVE);
      let settled = false;
      const pending = manager
        .commitPluginCommand({
          saveId: SAVE,
          pluginId: 'demo.diary',
          patches: translated.patches,
          expect: [],
          isAllowed: ok,
        })
        .then((r) => {
          settled = true;
          return r;
        });
      // 全局锁还没放：存档锁此时必须空闲（提交没有先抢存档锁再等全局锁）
      // （反了的话这里会排在提交后面、跟着等全局锁，用超时兜住免得测试挂死）
      const saveLockFree = await Promise.race([
        withSaveWriteLock(SAVE, () => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
      ]);
      expect(saveLockFree).toBe(true);
      expect(settled).toBe(false);
      expect(await getMemories(SAVE)).toEqual([]);
      gate.resolve();
      await held;
      expect(await pending).toEqual({ ok: true });
      expect(await getMemories(SAVE)).toHaveLength(1);
    });

    it('不含记忆的批次不等全局锁', async () => {
      const gate = deferred();
      const entered = deferred();
      const held = withGlobalWriteLock(async () => {
        entered.resolve();
        await gate.promise;
      });
      await entered.promise;
      const result = await createStateManager(SAVE).commitPluginCommand({
        saveId: SAVE,
        pluginId: 'demo.shop',
        patches: [{ op: 'set_hp', target: 'characters.Player', value: 20 }],
        expect: [],
        isAllowed: ok,
      });
      expect(result).toEqual({ ok: true });
      gate.resolve();
      await held;
    });

    it('后面的补丁失败时记忆一并回滚', async () => {
      const translated = translatePluginCommands({
        commands: [
          { type: 'memory.add', content: '不该留下的记忆' },
          { type: 'resource.set', resource: 'hp', value: 20 },
          { type: 'item.remove', name: '不存在', quantity: 1 },
        ],
        expect: [],
        declared: ['memory.add', 'resource.set', 'item.remove'],
        saveId: SAVE,
        playerName: 'Player',
      });
      if (!translated.ok) throw new Error(translated.message);
      const manager = createStateManager(SAVE);
      const result = await manager.commitPluginCommand({
        saveId: SAVE,
        pluginId: 'demo.diary',
        patches: translated.patches,
        expect: [],
        isAllowed: ok,
        commandIndexOfPatch: translated.commandIndexOfPatch,
      });
      expect(result).toMatchObject({ ok: false, code: 'INVALID', index: 2 });
      expect(await getMemories(SAVE)).toEqual([]);
      expect((await player()).hp).toBe(80);
      expect(manager.getEvents()).toEqual([]);
    });
  });
});
