/**
 * usePresetKnobs + usePresets 的条目开关覆写层（2026-11-21）
 *
 * - 只读预设拨开关：只写 `settings.presetEntryToggles`，Dexie 行（含 factorySeedHash）与选择键不动；
 * - 玩家预设拨开关：直接改行；
 * - 未知 identifier 忽略；单条开关与原始行相同的覆写被归一掉；组选择整组钉住。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { getDatabase } from '@engine/persistence/database';
import type { ChatPreset } from '@engine/types/types';

const holder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => holder.store,
}));

import { loadPresets, usePresets } from '../../../src/ui/composables/usePresets';
import { registerFactoryPresetIds } from '../../../src/ui/lib/preset-catalog';
import { usePresetKnobs } from '../../../src/ui/composables/usePresetKnobs';

type FakeStore = {
  settings: {
    activePresetId: string;
    presetEntryToggles: Record<string, Record<string, boolean>>;
  };
  projectAgentDefaults: { agents: Record<string, { presetId?: string }> };
};

const FACTORY_ID = 'factory-story';

function rowOf(id: string, extra: Partial<ChatPreset> = {}): ChatPreset {
  return {
    id,
    name: id,
    settings: {
      prompts: [
        { identifier: 'a', name: '甲', content: '甲甲甲', enabled: true, injection_order: 10 },
        { identifier: 'b', name: '乙', content: '乙乙乙', enabled: false, injection_order: 20 },
        { identifier: 'c', name: '丙', content: '丙丙丙', enabled: true, injection_order: 30 },
      ],
      extensions: {
        poem: {
          groups: [
            {
              id: 'style',
              label: '文风',
              options: [
                { identifier: 'a', label: '甲' },
                { identifier: 'b', label: '乙' },
              ],
            },
          ],
        },
      },
    },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as ChatPreset;
}

let store: FakeStore;

function enabledMap(preset: ChatPreset | null): Record<string, boolean> {
  const prompts = (
    preset?.settings as { prompts?: Array<{ identifier: string; enabled?: boolean }> }
  )?.prompts;
  return Object.fromEntries((prompts ?? []).map((p) => [p.identifier, p.enabled !== false]));
}

beforeEach(async () => {
  store = reactive({
    settings: { activePresetId: '', presetEntryToggles: {} },
    projectAgentDefaults: { agents: { story: { presetId: FACTORY_ID } } },
  }) as FakeStore;
  holder.store = store;
  const db = getDatabase();
  await db.presets.clear();
  await db.presets.bulkPut([
    rowOf(FACTORY_ID, { factorySeedHash: 'seed-1' }),
    rowOf('mine', { name: '我的预设' }),
  ]);
  registerFactoryPresetIds([FACTORY_ID]);
  await loadPresets();
});

afterEach(async () => {
  registerFactoryPresetIds([]);
  await getDatabase().presets.clear();
});

describe('只读预设：开关只进覆写层', () => {
  it('拨开关后 Dexie 行与 factorySeedHash 不变、选择键不变，生效预设已带覆写', async () => {
    const knobs = usePresetKnobs('story');
    const { presets, pristineEffectivePreset } = usePresets();
    const before = await getDatabase().presets.get(FACTORY_ID);
    expect(knobs.readonly.value).toBe(true);
    expect(knobs.presetId.value).toBe(FACTORY_ID);

    await knobs.toggleEntry('c');
    await nextTick();

    expect(store.settings.presetEntryToggles).toEqual({ [FACTORY_ID]: { c: false } });
    expect(await getDatabase().presets.get(FACTORY_ID)).toEqual(before);
    expect((await getDatabase().presets.get(FACTORY_ID))?.factorySeedHash).toBe('seed-1');
    expect(store.settings.activePresetId).toBe('');
    expect(enabledMap(knobs.preset.value)).toEqual({ a: true, b: false, c: false });
    expect(knobs.adjustedCount.value).toBe(1);
    expect(knobs.summary.value.activeCount).toBe(1);
    // 原始行与「原样」视图都不受覆写影响
    expect(enabledMap(presets.value.find((p) => p.id === FACTORY_ID) ?? null).c).toBe(true);
    expect(enabledMap(pristineEffectivePreset('story').preset).c).toBe(true);
  });

  it('拨回原值后覆写归一为空，整个预设键删掉', async () => {
    const knobs = usePresetKnobs('story');
    await knobs.toggleEntry('c');
    await knobs.toggleEntry('c');
    expect(store.settings.presetEntryToggles).toEqual({});
    expect(knobs.adjustedCount.value).toBe(0);
  });

  it('互斥组：选中一项写出整组补丁，状态随之变；不合法的选择返回 false', async () => {
    const knobs = usePresetKnobs('story');
    expect(knobs.groups.value[0].state).toEqual({ status: 'ok', selected: 'a' });

    expect(await knobs.selectOption('style', 'b')).toBe(true);
    expect(store.settings.presetEntryToggles[FACTORY_ID]).toEqual({ a: false, b: true });
    expect(knobs.groups.value[0].state).toEqual({ status: 'ok', selected: 'b' });

    expect(await knobs.selectOption('style', 'c')).toBe(false);
    expect(await knobs.selectOption('style', null)).toBe(false);
    expect(await knobs.selectOption('nope', 'a')).toBe(false);
    expect(store.settings.presetEntryToggles[FACTORY_ID]).toEqual({ a: false, b: true });
  });

  it('组选择整组钉住：出厂默认日后改变，玩家的选择仍然生效', async () => {
    const knobs = usePresetKnobs('story');
    // 选中当前默认项 a：值与原始行相同，但整组键仍留在覆写层
    expect(await knobs.selectOption('style', 'a')).toBe(true);
    expect(store.settings.presetEntryToggles[FACTORY_ID]).toEqual({ a: true, b: false });
    expect(knobs.adjustedCount.value).toBe(0);

    // 不碰组成员的单条开关不会把钉住的键归一掉
    await knobs.toggleEntry('c');
    await knobs.toggleEntry('c');
    expect(store.settings.presetEntryToggles[FACTORY_ID]).toEqual({ a: true, b: false });
    expect(knobs.adjustedCount.value).toBe(0);

    // 出厂默认改成 b
    const row = rowOf(FACTORY_ID, { factorySeedHash: 'seed-2' });
    const prompts = (row.settings as { prompts: Array<{ enabled?: boolean }> }).prompts;
    prompts[0].enabled = false;
    prompts[1].enabled = true;
    await getDatabase().presets.put(row);
    await loadPresets();
    await nextTick();

    expect(knobs.groups.value[0].state).toEqual({ status: 'ok', selected: 'a' });
    expect(enabledMap(knobs.preset.value)).toEqual({ a: true, b: false, c: true });
    expect(knobs.adjustedCount.value).toBe(2);
  });

  it('resetToggles 清掉这个预设的全部覆写', async () => {
    const knobs = usePresetKnobs('story');
    await knobs.selectOption('style', 'b');
    knobs.resetToggles();
    expect(store.settings.presetEntryToggles).toEqual({});
    expect(enabledMap(knobs.preset.value)).toEqual({ a: true, b: false, c: true });
  });

  it('写时复制的副本带上覆写后的开关，且不带播种指纹', async () => {
    const knobs = usePresetKnobs('story');
    const { duplicateAsUser } = usePresets();
    await knobs.toggleEntry('a');
    const copy = await duplicateAsUser(FACTORY_ID);
    expect(copy).not.toBeNull();
    expect(enabledMap(copy)).toEqual({ a: false, b: false, c: true });
    expect(copy?.factorySeedHash).toBeUndefined();
  });
});

describe('玩家预设：直接改行', () => {
  it('拨开关写回 Dexie 行，覆写层不动', async () => {
    store.settings.activePresetId = 'mine';
    const knobs = usePresetKnobs('story');
    expect(knobs.readonly.value).toBe(false);

    await knobs.toggleEntry('c');

    const row = await getDatabase().presets.get('mine');
    expect(enabledMap(row ?? null)).toEqual({ a: true, b: false, c: false });
    expect(row?.updatedAt).not.toBe(1);
    expect(store.settings.presetEntryToggles).toEqual({});
    expect(enabledMap(knobs.preset.value).c).toBe(false);
    expect(knobs.adjustedCount.value).toBe(0);
  });
});

describe('未知 identifier', () => {
  it('只读预设：被忽略，不留覆写键', async () => {
    const knobs = usePresetKnobs('story');
    const { setEntriesEnabled } = usePresets();
    await knobs.toggleEntry('ghost');
    await setEntriesEnabled(FACTORY_ID, { ghost: true, a: true });
    expect(store.settings.presetEntryToggles).toEqual({});
  });

  it('玩家预设：被忽略，行不写', async () => {
    const { setEntriesEnabled } = usePresets();
    const before = await getDatabase().presets.get('mine');
    await setEntriesEnabled('mine', { ghost: false });
    expect(await getDatabase().presets.get('mine')).toEqual(before);
  });

  it('未知预设 id：什么都不做', async () => {
    const { setEntriesEnabled } = usePresets();
    await setEntriesEnabled('nobody', { a: false });
    expect(store.settings.presetEntryToggles).toEqual({});
  });
});
