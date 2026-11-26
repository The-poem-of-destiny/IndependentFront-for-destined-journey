/**
 * 内核守卫回归（审查 2026-11-25 A7 / A9 / A2 内核侧）—— 真实 StateManager + fake-indexeddb：
 * - A7：整对象写资源不依赖键序（`{当前,上限}` 与 `{上限,当前}` 结果一致）；
 * - A9：金钱落地后不为负（旧协议 delta 同样受保护）；AI 来源扣命运点钳到 0，直出整楼照常接纳；
 *       领域命令命运点不足仍整批拒收；
 * - A2：时长非有限数、update_item 值类型不符在静态校验拒掉，库里不落 NaN / 坏值。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDirectPatches, parseDirectOutput } from '../../../src/core/agents/direct-output';
import type { DirectDicePool } from '../../../src/core/agents/direct-dice';
import {
  clearAllData,
  getCharacters,
  saveCharacter,
  saveMessages,
  saveSaveSlot,
} from '../../../src/core/persistence/database';
import { setEngineSettingsProvider } from '../../../src/core/runtime/engine-settings';
import { PatchRehearsal } from '../../../src/core/state/patch-rehearsal';
import { getProfile, updateProfile } from '../../../src/core/state/save-profile';
import { createStateManager } from '../../../src/core/state/state-manager';
import {
  createDefaultCharacterState,
  type ChatMessage,
  type SaveSlot,
  type StatePatch,
} from '../../../src/core/types/types';

const saveId = 'kernel-guards';
const POOL: DirectDicePool = [{ sides: 20, values: [7] }];

function wrap(updates: unknown): string {
  return `<maintext>你喘了口气。</maintext><options>1. 等待</options><character_updates>${JSON.stringify({ characters: [] })}</character_updates><direct_updates>${JSON.stringify(updates)}</direct_updates>`;
}

function player() {
  return createDefaultCharacterState({
    id: 'p',
    saveId,
    name: '旅人',
    type: 'player',
    maxHp: 5000,
    hp: 4000,
    maxMp: 100,
    mp: 90,
    maxSp: 100,
    sp: 75,
    money: 50,
    location: '王都',
    present: true,
    inventory: [{ name: '药草', quantity: 2 }],
    statusEffects: [
      {
        name: '中毒',
        description: '慢慢掉血',
        category: '减益',
        stacks: 1,
        remainingTime: 30,
        timeUnit: '分钟',
        source: '毒蛇',
        effects: {},
      },
    ],
  });
}

function source(): ChatMessage[] {
  return [
    {
      id: 'u',
      saveId,
      role: 'user',
      content: '歇一会',
      timestamp: 1,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
    {
      id: 'a',
      saveId,
      role: 'assistant',
      content: '你喘了口气。',
      timestamp: 2,
      storyTurnKey: 'u',
      storyTurnStatus: 'pending',
    },
  ];
}

async function fixture(fp?: number) {
  await saveSaveSlot({
    id: saveId,
    name: 'Guards',
    slot: 1,
    createdAt: 1,
    updatedAt: 1,
    activeSnapshotId: null,
    metadata: {
      generationMode: 'direct',
      characterName: '旅人',
      userName: '',
      gameStartTime: '',
      totalTurns: 0,
    },
  } as SaveSlot);
  await saveCharacter(player());
  await saveMessages(source());
  const profile = await getProfile(saveId);
  if (fp !== undefined) {
    profile.fp = fp;
    await updateProfile(profile);
  }
}

async function runTree(patch: unknown[]) {
  const draft = parseDirectOutput(wrap({ version: 2, patch }), POOL, {
    stateProtocol: 'tree',
    structuredCombat: false,
  });
  const built = buildDirectPatches(draft, {
    characters: await getCharacters(saveId),
    definitions: [],
    sourceTurnKey: 'u',
    profile: await getProfile(saveId),
  });
  const outcome = await createStateManager(saveId).commitDirectTurn({
    patches: built.patches,
    messages: source(),
    turnKey: 'u',
    combat: null,
    isCurrent: () => true,
  });
  return { built, outcome };
}

async function readPlayer() {
  return (await getCharacters(saveId)).find((c) => c.name === '旅人')!;
}

beforeEach(async () => {
  await clearAllData();
  setEngineSettingsProvider(() => ({ stateProtocol: 'tree' }));
});
afterEach(() => {
  setEngineSettingsProvider(undefined);
});

describe('A7：整对象写资源不依赖键序', () => {
  it.each([
    ['当前在前', { 当前: 6000, 上限: 7000 }],
    ['上限在前', { 上限: 7000, 当前: 6000 }],
  ])('replace /主角/生命值（%s，旧上限 5000）得当前 6000、上限 7000', async (_label, value) => {
    await fixture();
    const { outcome } = await runTree([{ op: 'replace', path: '/主角/生命值', value }]);
    expect(outcome).toBe('committed');
    const after = await readPlayer();
    expect(after.maxHp).toBe(7000);
    expect(after.hp).toBe(6000);
  });
});

describe('A9：金钱与命运点守卫下沉内核', () => {
  it('旧协议 money delta −999 落地后钳到 0', async () => {
    await fixture();
    const result = await createStateManager(saveId).commitChatState([
      {
        op: 'update_character',
        target: 'characters.旅人',
        value: { money: -999 },
        metadata: { delta: true },
      },
    ]);
    expect(result.errors).toEqual([]);
    expect((await readPlayer()).money).toBe(0);
  });

  it('整值写负金钱同样钳到 0', async () => {
    await fixture();
    await createStateManager(saveId).commitChatState([
      { op: 'update_character', target: 'characters.旅人', value: { money: -5 } },
    ]);
    expect((await readPlayer()).money).toBe(0);
  });

  it.each([
    ['整值 NaN', { money: Number.NaN }, false],
    ['整值 Infinity', { money: Number.POSITIVE_INFINITY }, false],
    ['整值字符串', { money: '很多' }, false],
    ['delta Infinity', { money: Number.POSITIVE_INFINITY }, true],
  ])('金钱非有限值（%s）落地后归 0', async (_label, value, delta) => {
    await fixture();
    await createStateManager(saveId).commitChatState([
      {
        op: 'update_character',
        target: 'characters.旅人',
        value,
        ...(delta ? { metadata: { delta: true } } : {}),
      },
    ]);
    expect((await readPlayer()).money).toBe(0);
  });

  it('AI 补丁 profile.fp −999（余 3）钳到 0，不报错', async () => {
    await fixture(3);
    const result = await createStateManager(saveId).commitChatState([
      { op: 'delta_variable', target: 'profile.fp', amount: -999 },
    ]);
    expect(result.errors).toEqual([]);
    expect((await getProfile(saveId)).fp).toBe(0);
  });

  it('直出整楼带 profile.fp −999（余 3）照常接纳，命运点钳到 0', async () => {
    await fixture(3);
    const outcome = await createStateManager(saveId).commitDirectTurn({
      patches: [
        { op: 'delta_variable', target: 'profile.fp', amount: -999 },
        { op: 'set_hp', target: 'characters.旅人', value: 4500 },
      ],
      messages: source(),
      turnKey: 'u',
      combat: null,
      isCurrent: () => true,
    });
    expect(outcome).toBe('committed');
    expect((await getProfile(saveId)).fp).toBe(0);
    expect((await readPlayer()).hp).toBe(4500);
  });

  it('领域命令命运点不足仍整批拒收，状态零变化', async () => {
    await fixture(3);
    await expect(
      createStateManager(saveId).commitDomainCommand([
        { op: 'set_hp', target: 'characters.旅人', value: 1 },
        { op: 'delta_variable', target: 'profile.fp', amount: -10 },
      ]),
    ).rejects.toThrow(/FP 不足/);
    expect((await getProfile(saveId)).fp).toBe(3);
    expect((await readPlayer()).hp).toBe(4000);
  });
});

describe('A2 内核侧：值类型在静态校验拒掉', () => {
  it('update_status_effect remainingTime:"3小时" 被拒，库里无 NaN', async () => {
    await fixture();
    const result = await createStateManager(saveId).commitChatState([
      {
        op: 'update_status_effect',
        target: 'characters.旅人',
        value: { name: '中毒', remainingTime: '3小时' },
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/remainingTime/);
    const effect = (await readPlayer()).statusEffects.find((s) => s.name === '中毒')!;
    expect(effect.remainingTime).toBe(30);
  });

  it('add_status_effect 非有限时长被拒，库里不新增坏状态', async () => {
    await fixture();
    const result = await createStateManager(saveId).commitChatState([
      {
        op: 'add_status_effect',
        target: 'characters.旅人',
        value: { name: '灼烧', remainingTime: '3小时' },
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect((await readPlayer()).statusEffects.map((s) => s.name)).toEqual(['中毒']);
  });

  it('update_item changes.stats:"abc" 被拒，物品不被污染', async () => {
    await fixture();
    const result = await createStateManager(saveId).commitChatState([
      {
        op: 'update_item',
        target: 'characters.旅人',
        value: { name: '药草', changes: { stats: 'abc' } },
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/changes\.stats/);
    const item = (await readPlayer()).inventory.find((i) => i.name === '药草')!;
    expect(item.stats).toBeUndefined();
  });

  it('预演只丢坏时长那一条，其余补丁整楼照常接纳', async () => {
    await fixture();
    const patches: StatePatch[] = [
      {
        op: 'update_status_effect',
        target: 'characters.旅人',
        value: { name: '中毒', remainingTime: '3小时' },
      },
      { op: 'set_hp', target: 'characters.旅人', value: 4200 },
    ];
    const rehearsal = new PatchRehearsal(await getCharacters(saveId));
    const kept = patches.filter((patch) => {
      try {
        rehearsal.vet(patch)();
        return true;
      } catch {
        return false;
      }
    });
    expect(kept.map((p) => p.op)).toEqual(['set_hp']);
    const outcome = await createStateManager(saveId).commitDirectTurn({
      patches: kept,
      messages: source(),
      turnKey: 'u',
      combat: null,
      isCurrent: () => true,
    });
    expect(outcome).toBe('committed');
    const after = await readPlayer();
    expect(after.hp).toBe(4200);
    expect(after.statusEffects.find((s) => s.name === '中毒')!.remainingTime).toBe(30);
  });
});
