/**
 * 美化规则 Store（Phase 0b）—— 用户规则的**唯一入口**，预设规则的**唯一持有者**。
 *
 * 两半边的存储性质刻意不同：
 *
 * - `userRules` —— 用户数据，真源在 Dexie `beautifierRules` 表。写入一律先 await 落库
 *   再更新 ref；ref 是库的投影，不是第二真相来源。
 * - `presetRules` —— 内置 22 条（~378 KB），是 `loadPresetRules()` 从
 *   data/defaults/beautifier-rules.json 现算的**派生缓存**。**纯内存 ref，不落任何存储**。
 *   每次启动重算，永远与磁盘一致，也不吃 localStorage 配额。
 *
 * `beautifierBuiltinDisabled`（历史字段名，现为「相对默认值翻转」的 id 列表）继续留在
 * settings-store，体积无关紧要，没必要迁移。
 *
 * 🔴 本 store **绝不**把规则写回 settings —— settings-store 的 deep watch 会把整个
 *    设置对象序列化进 localStorage，写回去等于把刚搬出来的容量又塞回配额里。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getDatabase } from '@engine/database';
import { loadPresetRules, mergeRules } from '@engine/beautifier';
import type { BeautifierRule } from '@engine/types';
import {
  migrateBeautifierRulesToDexie,
  pruneLegacyBuiltinOverrides,
  type BeautifierMigrationOutcome,
} from './beautifier-migration';
import { useSettingsStore } from './settings-store';
import { detach, omit } from './db-write';

/**
 * 落库前深拷贝（切断 Vue Proxy —— 理由见 db-write，Q-16）+ 丢掉 locked
 * （运行时计算，不持久化；存进库就成了会过期的第二真相来源）。
 *
 * 与 worldbook-store 的同名 `toRow` **刻意不同**（那边是盖时间戳），所以两者只共用
 * `detach`，不共用名字 —— 收敛成一个名字才是搬错版本的温床。
 */
function toRow(rule: BeautifierRule): BeautifierRule {
  return omit(detach(rule), 'locked');
}

export const useBeautifierStore = defineStore('beautifier', () => {
  /** 用户自定义规则 —— Dexie 的响应式投影 */
  const userRules = ref<BeautifierRule[]>([]);
  /** 内置预设规则 —— 纯内存派生缓存，**不持久化** */
  const presetRules = ref<BeautifierRule[]>([]);
  /** init() 是否已完成（含失败收场） */
  const ready = ref(false);
  /** 上次迁移结果，仅供调试/测试断言 */
  const lastMigration = ref<BeautifierMigrationOutcome | null>(null);

  let initPromise: Promise<void> | null = null;

  // ===== 启动 =====

  /**
   * 启动流程，幂等（并发调用共用同一个 Promise）。
   *
   * 顺序与世界书侧同理：**迁移 → hydrate → 加载预设**。
   * 预设加载若先跑，旧代码会把算出来的 22 条塞回 `settings.beautifierPresetRules`，
   * 源对象在迁移脚下漂移。
   */
  async function init(): Promise<void> {
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  async function doInit(): Promise<void> {
    const settingsStore = useSettingsStore();
    lastMigration.value = await migrateBeautifierRulesToDexie({
      settings: settingsStore.settings,
      persistSettings: settingsStore.saveNow,
    });
    await hydrate();
    await refreshPresetRules();
    ready.value = true;
  }

  /** 从 Dexie 读全表填 ref */
  async function hydrate(): Promise<void> {
    try {
      userRules.value = await getDatabase().beautifierRules.toArray();
    } catch {
      // IndexedDB 不可用 → 留空数组，美化退化为「只有预设规则」，不阻断渲染
    }
  }

  /**
   * 重算预设规则（含 autoEnable 解析）。
   *
   * 启动时无存档上下文 → 传空信号；locked 由游戏页/设置页按存档
   * `enabledWorldBookEntries` 各自重算（`useBeautify` / `BeautifierSection`）。
   *
   * 结果只进内存 ref，**不写任何存储**。
   */
  async function refreshPresetRules(
    activeWorldBookIds: Set<string> = new Set(),
    activeEntryUids: Set<number> = new Set(),
    activeCharacterNames: Set<string> = new Set(),
  ): Promise<void> {
    try {
      const preset = await loadPresetRules();
      // 覆盖列表语义迁移：认得出出厂默认值才能做，所以挂在预设加载之后。
      // 内部有标志位，重复调用是空转。
      const settingsStore = useSettingsStore();
      if (pruneLegacyBuiltinOverrides(settingsStore.settings, preset)) settingsStore.saveNow();
      const merged = mergeRules(
        preset,
        userRules.value,
        builtinDisabled(),
        activeWorldBookIds,
        activeEntryUids,
        activeCharacterNames,
      );
      presetRules.value = merged.filter((r) => r.isBuiltin);
    } catch {
      // 加载失败静默（设置页打开时会兜底重算）
    }
  }

  /** 用户手动翻转默认启用状态的内置规则 id —— 仍住在 settings（字段名保持兼容） */
  function builtinDisabled(): string[] {
    return (useSettingsStore().settings.beautifierBuiltinDisabled as string[]) ?? [];
  }

  // ===== 用户规则 CRUD =====

  /** 新增或整条覆盖 */
  async function upsertRule(rule: BeautifierRule): Promise<void> {
    const row = toRow(rule);
    await getDatabase().beautifierRules.put(row);
    const idx = userRules.value.findIndex((r) => r.id === row.id);
    if (idx >= 0) userRules.value[idx] = row;
    else userRules.value.push(row);
  }

  /** 批量新增或覆盖（导入 / 工坊安装用） */
  async function upsertRules(list: BeautifierRule[]): Promise<void> {
    if (list.length === 0) return;
    const rows = list.map(toRow);
    await getDatabase().beautifierRules.bulkPut(rows);
    for (const row of rows) {
      const idx = userRules.value.findIndex((r) => r.id === row.id);
      if (idx >= 0) userRules.value[idx] = row;
      else userRules.value.push(row);
    }
  }

  async function deleteRule(id: string): Promise<void> {
    await getDatabase().beautifierRules.delete(id);
    userRules.value = userRules.value.filter((r) => r.id !== id);
  }

  /** 整表替换（设置页导入一个「裸数组」格式的规则文件时用） */
  async function replaceAllRules(list: BeautifierRule[]): Promise<void> {
    const rows = list.map(toRow);
    const db = getDatabase();
    await db.transaction('rw', db.beautifierRules, async () => {
      await db.beautifierRules.clear();
      if (rows.length > 0) await db.beautifierRules.bulkPut(rows);
    });
    userRules.value = rows;
  }

  /** 翻转单条用户规则的启用位（设置页开关） */
  async function toggleRule(id: string): Promise<void> {
    const rule = userRules.value.find((r) => r.id === id);
    if (!rule) return;
    await upsertRule({ ...rule, enabled: !rule.enabled });
  }

  return {
    userRules,
    presetRules,
    ready,
    lastMigration,
    init,
    hydrate,
    refreshPresetRules,
    upsertRule,
    upsertRules,
    deleteRule,
    replaceAllRules,
    toggleRule,
  };
});
