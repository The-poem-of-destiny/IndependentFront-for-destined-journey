/**
 * StateManager.updatePlayerPersona — 玩家主动修订叙事人设。
 *
 * 这不是世界内行动：只窄改当前存档唯一主角的三个叙事字段，不产 GameEvent；
 * 写入仍必须进入 per-save 队列并在锁内重读，避免覆盖同回合刚落下的其它角色状态。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllData,
  getCharacters,
  initializeDatabase,
  saveCharacter,
  saveSaveSlot,
} from './database';
import { createStateManager } from './state-manager';
import { withSaveWriteLock } from './state-write-queue';
import { createDefaultCharacterState, type CharacterState, type SaveSlot } from './types';

const SAVE_ID = 'save-persona-001';

function makeSave(): SaveSlot {
  return {
    id: SAVE_ID,
    name: 'Persona Test',
    slot: 0,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      characterName: '阿黑',
      userName: 'Tester',
      gameStartTime: '0488-01-01',
      totalTurns: 0,
    },
  };
}

async function seedPlayer(overrides: Partial<CharacterState> = {}): Promise<CharacterState> {
  const player = createDefaultCharacterState({
    id: 'player-1',
    saveId: SAVE_ID,
    name: '阿黑',
    type: 'player',
    personality: '天真',
    appearance: '身形纤细',
    background: '来自异世界',
    hp: 80,
    maxHp: 100,
    ...overrides,
  });
  await saveCharacter(player);
  return player;
}

async function readPlayer(): Promise<CharacterState> {
  return (await getCharacters(SAVE_ID)).find((char) => char.type === 'player')!;
}

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* 首次运行时数据库尚未建立 */
  }
  await initializeDatabase();
  await saveSaveSlot(makeSave());
});

describe('StateManager.updatePlayerPersona', () => {
  it('规范化并只替换三个人设字段，不产生 GameEvent', async () => {
    await seedPlayer();
    const manager = createStateManager(SAVE_ID);

    const result = await manager.updatePlayerPersona({
      personality: '  冷静但心软  ',
      appearance: '银白短发\r\n金色眼眸',
      background: '\n曾在边境长大。\r第二段。\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.character).toMatchObject({
      personality: '冷静但心软',
      appearance: '银白短发\n金色眼眸',
      background: '曾在边境长大。\n第二段。',
      hp: 80,
      maxHp: 100,
      name: '阿黑',
    });
    expect(await readPlayer()).toEqual(result.character);
    expect(manager.getEvents()).toEqual([]);
  });

  it('允许清空全部人设字段', async () => {
    await seedPlayer();

    const result = await createStateManager(SAVE_ID).updatePlayerPersona({
      personality: ' ',
      appearance: '\r\n',
      background: '',
    });

    expect(result.ok).toBe(true);
    expect(await readPlayer()).toMatchObject({ personality: '', appearance: '', background: '' });
  });

  it('内容未变化时返回 changed:false', async () => {
    await seedPlayer();

    const result = await createStateManager(SAVE_ID).updatePlayerPersona({
      personality: '天真',
      appearance: '身形纤细',
      background: '来自异世界',
    });

    expect(result).toMatchObject({ ok: true, changed: false });
  });

  it('写锁内重读最新角色，保留排在前面的状态提交', async () => {
    await seedPlayer();
    let release!: () => void;
    let announceHeld!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const lockAcquired = new Promise<void>((resolve) => (announceHeld = resolve));

    const earlierCommit = withSaveWriteLock(SAVE_ID, async () => {
      const fresh = await readPlayer();
      fresh.hp = 37;
      fresh.location = '召唤大厅';
      await saveCharacter(fresh);
      announceHeld();
      await held;
    });
    await lockAcquired;

    const personaWrite = createStateManager(SAVE_ID).updatePlayerPersona({
      personality: '谨慎',
      appearance: '黑发金瞳',
      background: '被召唤而来',
    });
    release();
    await earlierCommit;
    await personaWrite;

    expect(await readPlayer()).toMatchObject({
      hp: 37,
      location: '召唤大厅',
      personality: '谨慎',
      appearance: '黑发金瞳',
      background: '被召唤而来',
    });
  });

  it('没有主角或存在多个主角时明确拒绝，不任选一条写入', async () => {
    const missing = await createStateManager(SAVE_ID).updatePlayerPersona({
      personality: 'A',
      appearance: 'B',
      background: 'C',
    });
    expect(missing).toEqual({ ok: false, error: '当前存档找不到唯一主角' });

    await seedPlayer();
    await saveCharacter(
      createDefaultCharacterState({
        id: 'player-2',
        saveId: SAVE_ID,
        name: '另一位主角',
        type: 'player',
      }),
    );
    const duplicate = await createStateManager(SAVE_ID).updatePlayerPersona({
      personality: 'A',
      appearance: 'B',
      background: 'C',
    });
    expect(duplicate).toEqual({ ok: false, error: '当前存档找不到唯一主角' });
    expect((await getCharacters(SAVE_ID)).filter((char) => char.type === 'player')).toHaveLength(2);
  });
});
