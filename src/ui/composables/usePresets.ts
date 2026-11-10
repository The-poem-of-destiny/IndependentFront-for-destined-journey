import { computed, ref, shallowRef, type Ref } from 'vue';
import { deletePreset, getDatabase, savePreset } from '@engine/persistence/database';
import {
  isProtectedPackPresetId,
  getRuntimePackPresets,
  overlayRows,
  setRuntimePackPresets,
  subscribePackRuntime,
} from '@engine/content/pack-runtime';
import type { ChatPreset } from '@engine/types/types';

// Disk is the source for user/local presets; authenticated pack presets exist only in this memory view.
const diskPresets = ref<ChatPreset[]>([]);
const packOverlayPresets = shallowRef(getRuntimePackPresets());
subscribePackRuntime(() => {
  packOverlayPresets.value = getRuntimePackPresets();
});
const presetsRef = computed(() => overlayRows(diskPresets.value, packOverlayPresets.value));
let loaded = false;

function setPackOverlayPresets(rows: ChatPreset[]): void {
  setRuntimePackPresets(rows);
}

export async function loadPresets(): Promise<ChatPreset[]> {
  diskPresets.value = await getDatabase().presets.toArray();
  loaded = true;
  return presetsRef.value;
}

export function presetsLoaded(): boolean {
  return loaded;
}

function protectedPreset(id: string): boolean {
  return isProtectedPackPresetId(id);
}

export async function upsertPreset(preset: ChatPreset): Promise<void> {
  if (protectedPreset(preset.id)) {
    setPackOverlayPresets(overlayRows(packOverlayPresets.value, [preset]));
    return;
  }
  await savePreset(preset);
  diskPresets.value = overlayRows(diskPresets.value, [preset]);
}

export async function removePreset(id: string): Promise<void> {
  if (protectedPreset(id)) {
    setPackOverlayPresets(packOverlayPresets.value.filter((preset) => preset.id !== id));
    return;
  }
  await deletePreset(id);
  diskPresets.value = diskPresets.value.filter((preset) => preset.id !== id);
}

export function usePresets(): {
  presets: Readonly<Ref<ChatPreset[]>>;
  loadPresets: typeof loadPresets;
  upsertPreset: typeof upsertPreset;
  removePreset: typeof removePreset;
  presetsLoaded: typeof presetsLoaded;
} {
  return { presets: presetsRef, loadPresets, upsertPreset, removePreset, presetsLoaded };
}
