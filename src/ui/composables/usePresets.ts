/**
 * 正文 Agent 预设（ChatPreset）的共享响应式状态 + Dexie 持久化。
 *
 * 内容-引擎分离波 1 / D22：预设撤出 localStorage。
 * 此前预设同时写 Dexie 与 `settings.presets` 镜像，UI 全读镜像 ——
 * 装包写 Dexie、UI 读镜像 = 装了看不见。本 composable 收口为：
 *   · Dexie `presets` 表是唯一真源
 *   · 模块级单例 `ref<ChatPreset[]>` 作跨组件共享响应式视图
 *   · CRUD 经此处的 `loadPresets / upsertPreset / removePreset`，写 Dexie + 更新 ref
 *
 * `activePresetId` 仍在 settings-store（D22：settings 只留它）。
 *
 * 🔴 **模块级单例**：`presetsRef` 在文件作用域，所有调用方拿到同一份 ref，
 *    一处刷新全部响应。不要把它挪进函数体——那会让 PresetManager 与
 *    AgentConfigPanel 各持一份，saveAsDefault 写入后另一边看不到。
 */
import { ref, type Ref } from 'vue';
import { deletePreset, getPresets, savePreset } from '@engine/database';
import type { ChatPreset } from '@engine/types';

const presetsRef: Ref<ChatPreset[]> = ref<ChatPreset[]>([]);
let loaded = false;

/** 从 Dexie 加载全部预设到内存 ref（幂等；首次调用后重复调用会刷新整表）。 */
export async function loadPresets(): Promise<ChatPreset[]> {
  const rows = await getPresets();
  presetsRef.value = rows;
  loaded = true;
  return rows;
}

/** 已加载过则返回 true（避免每次挂载都触发 DB 读）。 */
export function presetsLoaded(): boolean {
  return loaded;
}

/** upsert 一条预设：写 Dexie + 更新内存 ref（命中同 id 则替换，否则追加）。 */
export async function upsertPreset(preset: ChatPreset): Promise<void> {
  await savePreset(preset);
  const idx = presetsRef.value.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    presetsRef.value[idx] = preset;
  } else {
    presetsRef.value.push(preset);
  }
}

/** 删除一条预设：写 Dexie + 从内存 ref 移除。 */
export async function removePreset(id: string): Promise<void> {
  await deletePreset(id);
  presetsRef.value = presetsRef.value.filter((p) => p.id !== id);
}

/** 共享响应式视图（只读语义：消费方不要直接改数组，走 upsert/remove）。 */
export function usePresets(): {
  presets: Ref<ChatPreset[]>;
  loadPresets: typeof loadPresets;
  upsertPreset: typeof upsertPreset;
  removePreset: typeof removePreset;
  presetsLoaded: typeof presetsLoaded;
} {
  return {
    presets: presetsRef,
    loadPresets,
    upsertPreset,
    removePreset,
    presetsLoaded,
  };
}
