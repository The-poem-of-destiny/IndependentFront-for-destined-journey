import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { initializeDatabase, clearAllData, saveCharacter, getCharacters } from '@engine/database';
import { createDefaultCharacterState } from '@engine/types';
import { createStateManager } from '@engine/state-manager';
import { getProfile } from '@engine/save-profile';
import { runCraftGenChain } from '@engine/craft-gen-chain';
vi.mock('@engine/agent-templates', () => ({
  buildAgentMessagesAsync: async () => [{ role: 'user', content: 'test' }],
}));
const saveId = 'review-craft';
const args = {
  characterId: 'Smith',
  industry: '锻造',
  stage: '成品',
  productName: 'Product',
  targetQuality: '普通',
  materials: [{ name: 'Material', quantity: 1, quality: '普通' }],
};
let player: any;
beforeEach(async () => {
  await initializeDatabase();
  await clearAllData();
  player = createDefaultCharacterState({
    id: 'p',
    saveId,
    name: 'Smith',
    type: 'player',
    tier: 1,
    level: 1,
    totalExp: 0,
    attributes: { str: 20, dex: 10, con: 10, int: 10, spi: 10 },
    inventory: [{ name: 'Material', quantity: 1 }],
  });
  await saveCharacter(player);
  vi.spyOn(Math, 'random').mockReturnValue(0.75);
});
afterEach(() => vi.restoreAllMocks());
async function craft(stateManager: any) {
  return runCraftGenChain(
    {
      saveId,
      marker: { rawContent: 'test', body: 'test', attributes: {} },
      storyOutput: 'test',
      endpoint: { id: 'fake' },
      context: { characters: [player], variables: {}, agentOutputs: new Map() },
    } as any,
    {
      stateManager,
      clientFactory: () => ({
        chat: async () => ({ output: '' }),
        chatWithTools: async (_request: any, tool: any) => {
          await tool('craft_check', args);
          const result = await tool('craft_settle', args);
          return {
            output: `<craft_result><success>${result.success}</success><product_name>Product</product_name><quality>普通</quality><rating>成功</rating><narrative>Test result</narrative><craft_params><quantity>1</quantity><exp_gained>${result.xpGained}</exp_gained><fp_gained>${result.fpGained}</fp_gained></craft_params></craft_result>`,
          };
        },
      }),
    } as any,
  );
}
it('crafting cannot grant a product after its material was already consumed', async () => {
  await saveCharacter({ ...player, inventory: [] });
  await expect(craft(createStateManager(saveId))).rejects.toThrow();
  const stored = (await getCharacters(saveId))[0];
  expect(stored.inventory.some((item) => item.name === 'Product')).toBe(false);
});
it('crafting leaves its material intact when the final product command fails', async () => {
  await expect(
    craft({
      commitDomainCommand: async () => {
        throw new Error('product write failure');
      },
    }),
  ).rejects.toThrow('product write failure');
  const stored = (await getCharacters(saveId))[0];
  expect(stored.inventory.find((item) => item.name === 'Material')?.quantity).toBe(1);
});
it('commits the material, product and canonical rewards exactly once', async () => {
  await craft(createStateManager(saveId));
  const stored = (await getCharacters(saveId))[0];
  expect(stored.inventory.some((item) => item.name === 'Material')).toBe(false);
  expect(stored.inventory.find((item) => item.name === 'Product')?.quantity).toBe(1);
  expect(stored.totalExp).toBe(50);
  expect((await getProfile(saveId)).fp).toBe(1);
});

it('ordinary chat fallback still grants its accepted parsed rewards when no tool settlement exists', async () => {
  const output =
    '<craft_result><success>true</success><product_name>Product</product_name><quality>普通</quality><rating>成功</rating><narrative>Test result</narrative><craft_params><quantity>1</quantity><exp_gained>50</exp_gained><fp_gained>1</fp_gained></craft_params></craft_result>';
  await runCraftGenChain(
    {
      saveId,
      marker: { rawContent: 'test', body: 'test', attributes: {} },
      storyOutput: 'test',
      endpoint: { id: 'fake' },
      context: { characters: [player], variables: {}, agentOutputs: new Map() },
    } as any,
    {
      stateManager: createStateManager(saveId),
      clientFactory: () => ({
        chatWithTools: async () => ({ error: 'provider does not support tools' }),
        chat: async () => ({ output }),
      }),
    } as any,
  );
  const stored = (await getCharacters(saveId))[0];
  expect(stored.inventory.some((item) => item.name === 'Product')).toBe(true);
  expect(stored.totalExp).toBe(50);
  expect((await getProfile(saveId)).fp).toBe(1);
});
