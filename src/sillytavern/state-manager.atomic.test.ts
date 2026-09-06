import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeDatabase,
  clearAllData,
  saveCharacter,
  getCharacters,
  getDatabase,
} from './database';
import { createStateManager } from './state-manager';
import { createDefaultCharacterState } from './types';
import { getProfile } from './save-profile';

beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
  await saveCharacter(
    createDefaultCharacterState({
      id: 'p',
      saveId: 'atomic',
      name: 'Player',
      type: 'player',
      hp: 80,
      maxHp: 100,
    }),
  );
});

describe('atomic domain commands', () => {
  it('rejects the whole action when a required material cannot be removed', async () => {
    const manager = createStateManager('atomic');
    await expect(
      manager.commitDomainCommand([
        { op: 'set_hp', target: 'characters.Player', value: 20 },
        { op: 'remove_item', target: 'characters.Player', value: { name: 'Missing', quantity: 1 } },
        { op: 'delta_variable', target: 'profile.fp', amount: 3 },
      ]),
    ).rejects.toThrow();
    expect((await getCharacters('atomic'))[0].hp).toBe(80);
    expect(manager.getEvents()).toEqual([]);
  });
  it('rolls back profile writes if character persistence fails', async () => {
    const before = (await getProfile('atomic')).fp;
    const spy = vi
      .spyOn(getDatabase().characters, 'bulkPut')
      .mockRejectedValueOnce(new Error('disk failure'));
    const manager = createStateManager('atomic');
    try {
      await expect(
        manager.commitDomainCommand([
          { op: 'delta_variable', target: 'profile.fp', amount: 3 },
          { op: 'set_hp', target: 'characters.Player', value: 20 },
        ]),
      ).rejects.toThrow('disk failure');
    } finally {
      spy.mockRestore();
    }
    expect((await getProfile('atomic')).fp).toBe(before);
    expect((await getCharacters('atomic'))[0].hp).toBe(80);
    expect(manager.getEvents()).toEqual([]);
  });
});

it('serializes competing actions so a material is consumed only once', async () => {
  const player = (await getCharacters('atomic'))[0];
  player.inventory = [{ name: 'Material', quantity: 1 }];
  await saveCharacter(player);
  const command = () =>
    createStateManager('atomic').commitDomainCommand([
      { op: 'remove_item', target: 'characters.Player', value: { name: 'Material', quantity: 1 } },
      { op: 'add_item', target: 'characters.Player', value: { name: 'Product', quantity: 1 } },
      { op: 'delta_variable', target: 'profile.fp', amount: 3 },
    ]);
  const before = (await getProfile('atomic')).fp;
  const outcomes = await Promise.allSettled([command(), command()]);
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect((await getCharacters('atomic'))[0].inventory).toMatchObject([
    { name: 'Product', quantity: 1 },
  ]);
  expect((await getProfile('atomic')).fp).toBe(before + 3);
});
