/**
 * 预设目录工厂（2026-11-25 R7）：管线与设置页共用同一个工厂，内容所有 id 含出厂预设。
 *
 * - 登记过的出厂 id（哪怕不带播种指纹、也没被默认层引用）在目录里算内容所有、只读；
 * - 设置页 `usePresets().catalog`（无覆写时）与工厂直接产出的目录同输入同输出。
 *   管线一侧的同一断言在 game-pipeline.test.ts「预设目录工厂（R7）」。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { getDatabase } from '@engine/persistence/database';
import { builtinDirectPresets } from '@engine/prompts/preset-resolution';
import type { ChatPreset } from '@engine/types/types';

const holder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => holder.store,
}));

import { loadPresets, usePresets } from '../../../src/ui/composables/usePresets';
import { buildUiPresetCatalog, registerFactoryPresetIds } from '../../../src/ui/lib/preset-catalog';

const EXTRA_FACTORY_ID = 'factory-extra';

function rowOf(id: string, extra: Partial<ChatPreset> = {}): ChatPreset {
  return {
    id,
    name: id,
    settings: { prompts: [{ identifier: 'a', content: 'A', enabled: true }] },
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  } as ChatPreset;
}

const agentDefaults = { story: { presetId: 'factory-story' } };

beforeEach(async () => {
  holder.store = reactive({
    settings: { activePresetId: '', presetEntryToggles: {} },
    projectAgentDefaults: { agents: agentDefaults },
  });
  const db = getDatabase();
  await db.presets.clear();
  await db.presets.bulkPut([
    rowOf('factory-story'),
    // 出厂文件里有、默认层没引用、也没盖指纹的行：只能靠登记认出来
    rowOf(EXTRA_FACTORY_ID),
    rowOf('mine'),
  ]);
  registerFactoryPresetIds(['factory-story', EXTRA_FACTORY_ID]);
  await loadPresets();
});

afterEach(async () => {
  registerFactoryPresetIds([]);
  await getDatabase().presets.clear();
});

describe('buildUiPresetCatalog', () => {
  it('登记过的出厂 id 算内容所有（只读），玩家预设不算；内置直出预设在目录里', () => {
    const catalog = buildUiPresetCatalog(
      [rowOf('factory-story'), rowOf(EXTRA_FACTORY_ID), rowOf('mine')],
      agentDefaults,
    );
    const byId = new Map(catalog.map((entry) => [entry.preset.id, entry]));
    expect(byId.get(EXTRA_FACTORY_ID)?.readonly).toBe(true);
    expect(byId.get(EXTRA_FACTORY_ID)?.origin).toBe(byId.get('factory-story')?.origin);
    expect(byId.get('mine')?.readonly).toBe(false);
    for (const builtin of Object.values(builtinDirectPresets())) {
      expect(byId.get(builtin!.id)?.origin).toBe('builtin');
    }
  });

  it('取消登记后同一行回到玩家预设（登记是唯一的出厂判据来源）', () => {
    registerFactoryPresetIds([]);
    const entry = buildUiPresetCatalog([rowOf(EXTRA_FACTORY_ID)], agentDefaults).find(
      (e) => e.preset.id === EXTRA_FACTORY_ID,
    );
    expect(entry?.readonly).toBe(false);
  });
});

describe('设置页目录与工厂同输入同输出', () => {
  it('usePresets().catalog（无覆写）逐条等于 buildUiPresetCatalog(同一批行, 同一默认层)', () => {
    const { catalog, presets } = usePresets();
    expect(catalog.value).toEqual(buildUiPresetCatalog(presets.value, agentDefaults));
  });
});
