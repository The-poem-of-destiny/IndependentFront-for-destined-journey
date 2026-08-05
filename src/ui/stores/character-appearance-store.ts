/**
 * character-appearance-store.ts — 角色外貌**会话副本**的 Dexie 唯一读写口（D56）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md`「v1.2 修订」D56/D58。
 *
 * ---
 *
 * ## 两份定义，这里是可变的那一份
 *
 * - **基线** 在 `imagePresets.appearance` —— 全局、跨存档共用、**只有用户能改**
 * - **会话（本店）** 按存档隔离，**由出图 AI 自动写入**，删存档连带删
 *
 * 🔴 「只有用户能改基线」这句话在 v1.3（2026-08-05）之前是**假的**：D57 让 AI 为没有
 * 基线的角色现建一份基线，而基线是全局的 —— A 周目的即兴会成为 B 周目的定义，而下面
 * 两个重置口都够不着它（它们只清本店）。现在那种角色的即兴外貌也落本店，差量基准是
 * 全空（见 `character-appearance-resolve.ts` 的 `appearanceWriteTarget`），于是本店是
 * **AI 唯一能写的地方**，上面那句话第一次成立。
 *
 * 🔴 自动写入之所以可接受，全靠「写的是副本」这一条：基线永远干净，会话怎么漂
 * 都能一键回去。所以本店**必须**提供重置，且不能只提供一种粒度 ——
 *
 * - `resetOne(name)` 单个角色：某个角色被写歪了，别的角色的正确变化不该跟着丢
 * - `resetAll()` 整档：连着几张图都不对时，真正会去按的是这个
 *
 * ## 存 patch，不存快照
 *
 * 行里只放**与基线不同的槽**（`diffFromBase` 的产物）。存全量的话：
 * ① 「重置」退化成「重置回一堆基线的复制品」；② 用户日后改了基线，已有存档
 * 收不到那次修改（每个槽都被一份等值快照挡着）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { CharacterAppearance, CharacterAppearancePatch } from '@engine/character-appearance';
import {
  diffFromBase,
  isMeaningfulPatch,
  mergeAppearance,
  stackPatches,
} from '@engine/character-appearance';
import type { CharacterSessionAppearance } from '@engine/types-image';
import {
  characterAppearanceKey,
  clearCharacterAppearances,
  deleteCharacterAppearance,
  getCharacterAppearances,
  saveCharacterAppearance,
} from '@engine/database';
import { detach } from './db-write';
import { mutationFail, mutationOk, type MutationResult } from './store-result';

export const useCharacterAppearanceStore = defineStore('characterAppearance', () => {
  /** 当前存档的全部会话覆盖，按角色名索引 */
  const rows = ref<CharacterSessionAppearance[]>([]);
  const activeSaveId = ref<string | null>(null);
  const loading = ref(false);

  /**
   * 载入某个存档的会话副本。**切存档必须调**，否则会拿上一个存档的外貌去出图
   * （同一个角色名在两周目里长得不一样是正常的，这正是会话副本存在的理由）。
   */
  async function load(saveId: string): Promise<void> {
    loading.value = true;
    try {
      rows.value = await getCharacterAppearances(saveId);
      activeSaveId.value = saveId;
    } catch {
      // IndexedDB 不可用 → 空覆盖层。出图会退回基线，是可接受的降级：
      // 少一件衣服总比整条出图链路挂掉好（对齐 image-preset-store 的降级）
      rows.value = [];
      activeSaveId.value = saveId;
    } finally {
      loading.value = false;
    }
  }

  /** 🔴 `===` 匹配，不归一化（铁律 1）—— 名字真源在别处，这边偷偷改名只会查不中 */
  function patchOf(name: string): CharacterAppearancePatch | undefined {
    return rows.value.find((r) => r.name === name)?.patch;
  }

  /** 出图时该用的外貌 = 基线 + 本档覆盖 */
  function resolve(name: string, base: CharacterAppearance): CharacterAppearance {
    return mergeAppearance(base, patchOf(name));
  }

  function syncLocal(row: CharacterSessionAppearance): void {
    const i = rows.value.findIndex((r) => r.key === row.key);
    if (i >= 0) rows.value.splice(i, 1, row);
    else rows.value.push(row);
  }

  /**
   * AI 报了一次外貌变化 —— **自动写入**这一档的会话副本。
   *
   * @param base  该角色的基线（用来算差异；没有基线就没有「变化」可言）
   * @param patch AI 观察到的槽变化；只含它真的要改的槽
   *
   * 三条纪律:
   * 1. 与基线等价的 patch **不落库**（`isMeaningfulPatch`）—— 每张图都写一行
   *    等于基线的噪音，会把「重置」变成重置回一堆复制品
   * 2. 与已有覆盖**叠加**而不是替换：AI 这回合只报了衣服，上回合的疤不该消失
   * 3. 叠加完再与基线做一次差异，把「改回基线值」的槽清出去 ——
   *    否则覆盖层只增不减，永远回不到干净状态
   */
  async function applyPatch(
    name: string,
    base: CharacterAppearance,
    patch: CharacterAppearancePatch,
  ): Promise<MutationResult<CharacterSessionAppearance | undefined>> {
    const saveId = activeSaveId.value;
    if (!saveId) return mutationFail('failed', '还没有载入存档，外貌变化无处可存。');

    const existing = patchOf(name);
    // 🔴 「有没有变化」要跟**当前生效的外貌**比，不是跟基线比。
    //    跟基线比会漏掉最要紧的一种变化：她换回了那件白袍 —— 那个 patch 与基线相同、
    //    与当前（披着斗篷）不同，按基线判会被当成噪音丢掉，覆盖层于是永远脱不下来。
    //    这条是写完被测试逮回来的。
    const current = mergeAppearance(base, existing);
    if (!isMeaningfulPatch(current, patch)) return mutationOk(undefined);

    const stacked = stackPatches(existing, patch);
    // 叠加后可能有槽被改回了基线值 —— 再过一次差异，让覆盖层能缩回去
    const trimmed = diffFromBase(base, mergeAppearance(base, stacked));

    const key = characterAppearanceKey(saveId, name);
    if (Object.keys(trimmed).length === 0) {
      // 全都回到基线了 → 这一行没有存在的意义
      await removeRow(key);
      return mutationOk(undefined);
    }

    const row: CharacterSessionAppearance = {
      key,
      saveId,
      name,
      patch: trimmed,
      updatedAt: Date.now(),
    };
    try {
      const detached = detach(row);
      await saveCharacterAppearance(detached);
      syncLocal(detached);
      return mutationOk(detached);
    } catch {
      return mutationFail('failed', '外貌变化保存失败。');
    }
  }

  async function removeRow(key: string): Promise<void> {
    await deleteCharacterAppearance(key);
    const i = rows.value.findIndex((r) => r.key === key);
    if (i >= 0) rows.value.splice(i, 1);
  }

  /** 重置口 ①：单个角色回到基线。别的角色的正确变化一个都不动 */
  async function resetOne(name: string): Promise<MutationResult<void>> {
    const saveId = activeSaveId.value;
    if (!saveId) return mutationFail('failed', '还没有载入存档。');
    try {
      await removeRow(characterAppearanceKey(saveId, name));
      return mutationOk();
    } catch {
      return mutationFail('failed', '重置失败，请重试。');
    }
  }

  /** 重置口 ②：整档回到基线。连着几张图都不对时真正会按的那个 */
  async function resetAll(): Promise<MutationResult<void>> {
    const saveId = activeSaveId.value;
    if (!saveId) return mutationFail('failed', '还没有载入存档。');
    try {
      await clearCharacterAppearances(saveId);
      rows.value = [];
      return mutationOk();
    } catch {
      return mutationFail('failed', '重置失败，请重试。');
    }
  }

  return {
    rows: computed(() => rows.value),
    activeSaveId: computed(() => activeSaveId.value),
    loading: computed(() => loading.value),
    /** 有覆盖的角色名 —— UI 用它标出「这个角色在本档里变过样子」 */
    changedNames: computed(() => rows.value.map((r) => r.name)),
    load,
    patchOf,
    resolve,
    applyPatch,
    resetOne,
    resetAll,
  };
});
