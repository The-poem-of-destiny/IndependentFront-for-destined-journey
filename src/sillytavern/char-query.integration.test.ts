/**
 * char-query.integration.test.ts — char-query saveId 真实 DB 集成测试
 *
 * 验证 getNpcs/getMonsters/getCharactersByType 的 saveId 参数在真实
 * IndexedDB（fake-indexeddb）上正确过滤。独立文件避免 vi.mock 干扰。
 *
 * 前置: characters 表 v9 schema: 'id, saveId, type'
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createDefaultCharacterState } from './types';
import { clearAllData, initializeDatabase, saveCharacter, getCharactersByType } from './database';
import { getNpcs, getMonsters } from './char-query';

beforeEach(async () => {
  try {
    await clearAllData();
  } catch {
    /* db may not exist yet */
  }
  await initializeDatabase();
});

// ========== getCharactersByType 集成测试 ==========

describe('getCharactersByType saveId 集成', () => {
  it('带 saveId 只返回该存档匹配类型的角色', async () => {
    await saveCharacter(createDefaultCharacterState({ id: 'a1', type: 'npc', saveId: 's1' }));
    await saveCharacter(createDefaultCharacterState({ id: 'a2', type: 'npc', saveId: 's2' }));
    await saveCharacter(createDefaultCharacterState({ id: 'a3', type: 'monster', saveId: 's1' }));
    const got = await getCharactersByType('npc', 's1');
    expect(got.map((c) => c.id)).toEqual(['a1']);
  });

  it('不传 saveId 保持全量', async () => {
    await saveCharacter(createDefaultCharacterState({ id: 'b1', type: 'npc', saveId: 's1' }));
    await saveCharacter(createDefaultCharacterState({ id: 'b2', type: 'npc', saveId: 's2' }));
    const got = await getCharactersByType('npc');
    expect(got.length).toBe(2);
  });
});

// ========== getNpcs 集成测试 ==========

describe('getNpcs saveId 集成（修 #30）', () => {
  it('getNpcs(saveId) 只返回该存档的 NPC', async () => {
    await saveCharacter(
      createDefaultCharacterState({ id: 'n1', name: '本档NPC', type: 'npc', saveId: 'save_Q' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'n2', name: '外档NPC', type: 'npc', saveId: 'save_Z' }),
    );
    const got = await getNpcs('save_Q');
    expect(got.map((c) => c.id)).toEqual(['n1']);
  });

  it('getNpcs() 不传 saveId 保持全量（兼容既有语义）', async () => {
    await saveCharacter(createDefaultCharacterState({ id: 'n1', type: 'npc', saveId: 'save_Q' }));
    await saveCharacter(createDefaultCharacterState({ id: 'n2', type: 'npc', saveId: 'save_Z' }));
    const got = await getNpcs();
    expect(got.length).toBeGreaterThanOrEqual(2);
    expect(got.find((c) => c.id === 'n1')).toBeDefined();
    expect(got.find((c) => c.id === 'n2')).toBeDefined();
  });

  it('不同存档的 NPC 互不干扰', async () => {
    await saveCharacter(
      createDefaultCharacterState({ id: 'a', name: 'A', type: 'npc', saveId: 's1' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'b', name: 'B', type: 'npc', saveId: 's2' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'c', name: 'C', type: 'npc', saveId: 's1' }),
    );
    const s1Npcs = await getNpcs('s1');
    const s2Npcs = await getNpcs('s2');
    expect(s1Npcs.map((c) => c.id).sort()).toEqual(['a', 'c']);
    expect(s2Npcs.map((c) => c.id)).toEqual(['b']);
  });

  it('player 类型不受 getNpcs 影响', async () => {
    await saveCharacter(
      createDefaultCharacterState({ id: 'p1', type: 'player', saveId: 'save_Q' }),
    );
    await saveCharacter(createDefaultCharacterState({ id: 'n1', type: 'npc', saveId: 'save_Q' }));
    const npcs = await getNpcs('save_Q');
    expect(npcs.map((c) => c.id)).toEqual(['n1']);
  });
});

// ========== getMonsters 集成测试 ==========

describe('getMonsters saveId 集成', () => {
  it('getMonsters(saveId) 只返回该存档的怪物', async () => {
    await saveCharacter(
      createDefaultCharacterState({ id: 'm1', type: 'monster', saveId: 'save_Q' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'm2', type: 'monster', saveId: 'save_Z' }),
    );
    const got = await getMonsters('save_Q');
    expect(got.map((c) => c.id)).toEqual(['m1']);
  });

  it('getMonsters() 不传 saveId 保持全量', async () => {
    await saveCharacter(
      createDefaultCharacterState({ id: 'm1', type: 'monster', saveId: 'save_Q' }),
    );
    await saveCharacter(
      createDefaultCharacterState({ id: 'm2', type: 'monster', saveId: 'save_Z' }),
    );
    const got = await getMonsters();
    expect(got.length).toBeGreaterThanOrEqual(2);
  });
});
