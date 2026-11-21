/**
 * create-custom-library-store.ts — 玩家自制开局条目（技能 / 物品 / 装备）全局库的唯一读写口
 *
 * 行存在 Dexie `createCustomItems` 表（v35）：**全局**，不随存档隔离、删存档不动它
 * （与 image-preset-store 同口径）。纯逻辑在 `@engine/content/start-custom-entries`：
 *
 * - 读出的每一行都再过一遍 `sanitizeCustomCatalogItem`（手编备份 / 旧版本数据不可信），
 *   收窄失败的行直接不显示，不删库 —— 删数据是玩家的决定。
 * - 写入走 `planLibrarySave`：同「类别 + 名称」视为同一逻辑条目，新的替换旧的，
 *   替换与写入在同一事务（`saveCreateCustomItem` 的 `replaceIds`）。替换对象按写入前
 *   **现读的库**算，不按内存视图（整库备份导入不刷新页面，内存可能是旧快照）。
 * - `refresh()` 每次都重读；捏人页选择步骤每次挂载都调它。`init()` 只管首次加载，
 *   读失败不算加载过，下次再试。
 * - 🔴 只收 `custom_` 开头的 id：目录条目的 id 进了这张表，捏人页就会出现两条同 id 的卡片，
 *   选中 / 取消会互相串。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { CatalogItem } from '@engine/content/start-catalog-mechanics';
import { planLibrarySave, sanitizeCustomCatalogItem } from '@engine/content/start-custom-entries';
import {
  deleteCreateCustomItem,
  getCreateCustomItems,
  saveCreateCustomItem,
  type CreateCustomItemRecord,
} from '@engine/persistence/database';
import { detach } from './db-write';
import { mutationFail, mutationOk, type MutationResult } from './store-result';

const CUSTOM_ID_PREFIX = 'custom_';

/** 把表行收窄成可用的行；`data` 不合法或与主键对不上的行丢弃 */
function sanitizeRecord(raw: CreateCustomItemRecord): CreateCustomItemRecord | null {
  const item = sanitizeCustomCatalogItem(raw?.data);
  if (!item || item.id !== raw.id) return null;
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    data: item,
  };
}

/** 最近更新在前；同时刻按 id 稳定排序 */
function byRecent(a: CreateCustomItemRecord, b: CreateCustomItemRecord): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** 读库并收窄；IndexedDB 不可用时抛出，由调用方决定怎么处置 */
async function readRecords(): Promise<CreateCustomItemRecord[]> {
  const rows = await getCreateCustomItems();
  return rows.map(sanitizeRecord).filter((r): r is CreateCustomItemRecord => r !== null);
}

export const useCreateCustomLibraryStore = defineStore('createCustomLibrary', () => {
  const records = ref<CreateCustomItemRecord[]>([]);
  const loading = ref(false);
  /** 至少成功读过一次库；读失败不置位，下次 init / refresh 会再读 */
  let loaded = false;
  /**
   * 内存视图的世代号：每次发起读库、每次本地写入提交都 +1。
   * 读库回来时世代已变 = 期间有更新的读取或写入，丢弃这次结果，免得旧快照盖掉新状态。
   */
  let generation = 0;

  /**
   * 总是重读一次库（整库备份导入不刷新页面，库可能已被外部换掉）。
   * 读失败时保留现有内存视图、不标记已加载；返回是否读成功。
   */
  async function refresh(): Promise<boolean> {
    const gen = ++generation;
    loading.value = true;
    try {
      const rows = await readRecords();
      if (gen === generation) records.value = rows.sort(byRecent);
      loaded = true;
      return true;
    } catch {
      // IndexedDB 不可用 → 保持现状；缺自制条目不该拖垮捏人页，下次挂载再试
      return false;
    } finally {
      if (gen === generation) loading.value = false;
    }
  }

  /** 首次加载：成功读过就不再读；上次读失败会重试 */
  async function init(): Promise<void> {
    if (loaded) return;
    await refresh();
  }

  /** 本地写入提交后替换内存视图；在途的旧读取随世代号作废 */
  function commitView(next: CreateCustomItemRecord[]): void {
    generation++;
    loading.value = false;
    records.value = next.sort(byRecent);
  }

  /** 全部条目（已收窄的 `CatalogItem`），最近更新在前 */
  const entries = computed<CatalogItem[]>(() => records.value.map((r) => r.data));

  function byCategory(category: CatalogItem['category']): CatalogItem[] {
    return records.value.filter((r) => r.category === category).map((r) => r.data);
  }

  function has(id: string): boolean {
    return records.value.some((r) => r.id === id);
  }

  /**
   * 存入一条自制条目（同类别同名会替换旧条目）。
   * 输入不合法（含非 `custom_` id）时拒收，返回 `failed`。
   */
  async function save(item: CatalogItem): Promise<MutationResult<CatalogItem>> {
    const clean = sanitizeCustomCatalogItem(detach(item));
    if (!clean) return mutationFail('failed', '这个条目不完整，无法存入自定义库。');
    // 🔴 替换对象按**库里此刻的行**算，不按内存视图：内存可能是整库导入之前的旧快照，
    //    按旧快照算 replaceIds 会漏掉真正的同名行，库里就多出一条同名重复
    let fresh: CreateCustomItemRecord[];
    try {
      fresh = await readRecords();
    } catch {
      return mutationFail('failed', '存入自定义库失败，请重试。');
    }
    const plan = planLibrarySave(fresh, clean, Date.now());
    const record = detach(plan.record);
    try {
      await saveCreateCustomItem(record, plan.replaceIds);
    } catch {
      return mutationFail('failed', '存入自定义库失败，请重试。');
    }
    const drop = new Set([record.id, ...plan.replaceIds]);
    commitView([...fresh.filter((r) => !drop.has(r.id)), record]);
    loaded = true;
    return mutationOk(record.data);
  }

  async function remove(id: string): Promise<MutationResult<void>> {
    if (!id.startsWith(CUSTOM_ID_PREFIX)) {
      return mutationFail('failed', '只能删除自定义条目。');
    }
    if (!has(id)) return mutationFail('not-found', '这个条目已经不在自定义库里了。');
    try {
      await deleteCreateCustomItem(id);
    } catch {
      return mutationFail('failed', '从自定义库删除失败，请重试。');
    }
    commitView(records.value.filter((r) => r.id !== id));
    return mutationOk();
  }

  return {
    entries,
    loading: computed(() => loading.value),

    init,
    refresh,
    byCategory,
    has,
    save,
    remove,
  };
});
