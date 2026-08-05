/**
 * image-preset-store.ts — 视觉预设（角色 + 地点）的 Dexie 唯一读写口
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §4 / §7.1（D40）。
 *
 * **角色预设管人的一致性，地点预设管场景的一致性** —— 两者形状完全一样，所以是
 * 同一张表加一个 `kind`，不是两张表（D40）。
 *
 * 三条不变式:
 *
 * 1. 🔴 主键 = `` `${kind}:${name}` ``。合表之后**不能**再拿 `name` 当主键 ——
 *    幻想设定里人名与地名撞车是会发生的（某人以某地为名）。
 * 2. 🔴 `name` 保留**原始字符串**，`===` 匹配：不 trim / 不折叠大小写 / 不 NFKC
 *    （铁律 1 / 素材系统 D2）。归一化会让「苏婉 」和「苏婉」在库里合成一条，
 *    而角色名的真源在别处，这边偷偷改名只会让预设查不中。
 * 3. **全局，不随存档隔离** —— `deleteSaveSlot` 刻意不删这张表（§7.2），与素材库同口径。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ImagePreset, ImagePresetKind } from '@engine/types-image';
import {
  deleteImagePreset,
  getImagePreset,
  getImagePresets,
  saveImagePreset,
} from '@engine/database';
import { detach } from './db-write';
import { mutationFail, mutationOk, type MutationResult } from './store-result';

/**
 * 主键 —— **唯一**一处拼法。
 *
 * 分隔符是 `:`；名字里含 `:` 不会造成歧义，因为 `kind` 只有两个字面值且都不含 `:`，
 * 从左边第一个 `:` 切开即可还原（真的需要还原时；平时两段都是分别传进来的）。
 */
export function imagePresetKey(kind: ImagePresetKind, name: string): string {
  return `${kind}:${name}`;
}

/** 新建/更新时的入参。`key` 由 {@link imagePresetKey} 派生，不许调用方自己拼 */
export interface ImagePresetInput {
  kind: ImagePresetKind;
  name: string;
  danbooru?: { positive: string; negative: string };
  /** v2 的 OpenAI/Gemini 用；形状先留好（D11） */
  prose?: { positive: string; negative: string };
  /**
   * 角色一致性的穷人版；仅 `kind==='character'` 有意义。
   *
   * ⚠️ 同一 seed 只让构图更接近，**不保证同一张脸** —— 编辑器里要照实说。
   */
  pinnedSeed?: number;
}

export const useImagePresetStore = defineStore('imagePreset', () => {
  const presets = ref<ImagePreset[]>([]);
  const loading = ref(false);
  let initialized = false;

  async function refresh(): Promise<void> {
    try {
      presets.value = await getImagePresets();
    } catch {
      // IndexedDB 不可用 → 空库；缺预设只是让这次出图里的角色变成随机的，
      // 不该把整个设置页/出图路径拖垮（对齐 asset-store 的降级）
      presets.value = [];
    }
  }

  /** 幂等；分区 onMounted / 出图前调 */
  async function init(): Promise<void> {
    if (initialized) return;
    initialized = true;
    loading.value = true;
    try {
      await refresh();
    } finally {
      loading.value = false;
    }
  }

  const characters = computed<ImagePreset[]>(() =>
    presets.value
      .filter((p) => p.kind === 'character')
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
  );

  // 🪦 D59：`locations` 已删。地点预设整个废除（地点无法穷举，见 types-image
  //    的 `ImagePresetKind` 注释），Dexie v18 已把 kind==='location' 的行删掉。

  /** 严格 `===` 匹配，**不做任何归一化**（铁律 1） */
  function find(kind: ImagePresetKind, name: string): ImagePreset | undefined {
    return presets.value.find((p) => p.kind === kind && p.name === name);
  }

  function findByKey(key: string): ImagePreset | undefined {
    return presets.value.find((p) => p.key === key);
  }

  /**
   * 按名字批量取 —— 装配提示词那一步的入口（一次出图要查若干角色 + 一个地点）。
   *
   * 查不到的**不报错**、也不在返回里占位: 缺预设是首次游玩的常态，装配层要的是
   * 「命中的这些」，缺席由它自己产 `{kind:'missing-preset'}` 告警（D41）。
   */
  function findMany(kind: ImagePresetKind, names: readonly string[]): ImagePreset[] {
    const out: ImagePreset[] = [];
    for (const name of names) {
      const hit = find(kind, name);
      if (hit) out.push(hit);
    }
    return out;
  }

  function syncLocal(row: ImagePreset): void {
    const i = presets.value.findIndex((p) => p.key === row.key);
    if (i >= 0) presets.value.splice(i, 1, row);
    else presets.value.push(row);
  }

  /**
   * 新建或整体覆盖一条预设。
   *
   * 空名字**拒收**: 主键会退化成 `character:`，两个空名字的预设互相覆盖，
   * 而界面上它们看起来是两条。
   */
  async function upsert(input: ImagePresetInput): Promise<MutationResult<ImagePreset>> {
    if (input.name === '') {
      return mutationFail('failed', '名字不能为空。');
    }
    const key = imagePresetKey(input.kind, input.name);
    const now = Date.now();
    const existing = findByKey(key) ?? (await getImagePreset(key));
    const row: ImagePreset = {
      key,
      kind: input.kind,
      name: input.name,
      dialects: {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (input.danbooru !== undefined) row.dialects.danbooru = { ...input.danbooru };
    if (input.prose !== undefined) row.dialects.prose = { ...input.prose };
    if (input.pinnedSeed !== undefined) row.pinnedSeed = input.pinnedSeed;

    try {
      const detached = detach(row);
      await saveImagePreset(detached);
      syncLocal(detached);
      return mutationOk(detached);
    } catch {
      return mutationFail('failed', '预设保存失败，请重试。');
    }
  }

  /**
   * 改名 —— 主键随之变化，所以是**删旧建新**，不是原地改。
   *
   * 目标名已被占用时拒绝（`name-taken`）：自动编号在这里是骗人的，
   * 预设是按名字被查中的，编号过的名字永远查不中。
   */
  async function rename(
    kind: ImagePresetKind,
    from: string,
    to: string,
  ): Promise<MutationResult<ImagePreset>> {
    if (to === '') return mutationFail('failed', '名字不能为空。');
    const source = find(kind, from);
    if (!source) return mutationFail('not-found', '这条预设已经不存在了。');
    if (from === to) return mutationOk(source);
    if (find(kind, to) !== undefined) {
      return mutationFail('name-taken', `已经有一条叫「${to}」的预设了。`);
    }
    const next: ImagePresetInput = { kind, name: to };
    if (source.dialects.danbooru !== undefined) next.danbooru = { ...source.dialects.danbooru };
    if (source.dialects.prose !== undefined) next.prose = { ...source.dialects.prose };
    if (source.pinnedSeed !== undefined) next.pinnedSeed = source.pinnedSeed;
    const created = await upsert(next);
    if (!created.ok) return created;
    await remove(source.key);
    return created;
  }

  /**
   * 「把这次的 seed 钉给他」（§10.3）—— `pinnedSeed` **唯一现实可用的设置路径**。
   *
   * 没人会在预设编辑器里手打一个十位随机整数，而一个谁也设不了的字段等于不存在。
   * 传 `undefined` 即取消钉住（回到每次随机）。
   *
   * 目标预设不存在时**就地建一条** —— 图鉴里那个按钮出现在「这张图恰好一个角色」时，
   * 而那个角色多半正是还没有预设的那个（D41 提示行说的就是他）。
   */
  async function setPinnedSeed(
    name: string,
    seed: number | undefined,
  ): Promise<MutationResult<ImagePreset>> {
    const existing = find('character', name);
    const input: ImagePresetInput = { kind: 'character', name };
    if (existing?.dialects.danbooru !== undefined) {
      input.danbooru = { ...existing.dialects.danbooru };
    }
    if (existing?.dialects.prose !== undefined) input.prose = { ...existing.dialects.prose };
    if (seed !== undefined) input.pinnedSeed = seed;
    return upsert(input);
  }

  async function remove(key: string): Promise<MutationResult<void>> {
    try {
      await deleteImagePreset(key);
      const i = presets.value.findIndex((p) => p.key === key);
      if (i >= 0) presets.value.splice(i, 1);
      return mutationOk();
    } catch {
      return mutationFail('failed', '预设删除失败，请重试。');
    }
  }

  return {
    presets: computed(() => presets.value),
    loading: computed(() => loading.value),
    characters,

    init,
    refresh,
    find,
    findByKey,
    findMany,
    upsert,
    rename,
    setPinnedSeed,
    remove,
  };
});
