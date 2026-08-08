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
import { ref, watch } from 'vue';
import { getDatabase } from '@engine/database';
import { loadPresetRules, mergeRules, normalizeRuleRuntime } from '@engine/beautifier';
import { getPackRules } from '@engine/content-source';
import type { BeautifierRule } from '@engine/types';
import {
  migrateBeautifierRulesToDexie,
  pruneLegacyBuiltinOverrides,
  type BeautifierMigrationOutcome,
} from './beautifier-migration';
import { useContentStore } from './content-store';
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

  // 🔴 收敛保险（2026-08-08 真机复现）：App.vue 的 `beautifier.init()` 先于 boot 的
  //    `hydratePackState()` 时，doInit 的 `refreshPresetRules()` 会在 pack provider 挂载前
  //    跑完（回落占位文件）；若 hydratePackState 里那次重算又因时序未生效，presetRules
  //    会一直是占位规则（症状：Dexie 装着 pack 且 getPackRules()=22，但 presetRules=5）。
  //    监听 activePackVersion：boot hydrate / 装包把它从 null 变成版本号时重算，
  //    让所有时序最终收敛到 pack 规则。
  // 🔴 守卫：仅当 pack 规则确实可读（provider 已注册）才重算 —— 否则走 loadPresetRules()
  //    会 fetch 占位文件并把 contentStatus 上报成 error（测试与卸载路径的污染源）。
  watch(
    () => {
      try {
        return useContentStore().activePackVersion;
      } catch {
        // Pinia 未激活（极少见的早调用）→ 保持 null，不抛
        return null;
      }
    },
    (v) => {
      if (v === null || v === undefined) return;
      if (getPackRules() === undefined) return;
      void refreshPresetRules();
    },
  );

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
   * 内容-引擎分离波 1 / D20 + §5.6：预设规则真源 = **已装 pack 的美化规则 > 占位文件**
   * （provider 内存层）。装包 / 卸载 / 恢复默认时经 content-source 的
   * `setPackRulesProvider` 把当前生效的 pack 规则注册进去，由 `getPackRules()` 读取；
   * 无 pack（占位态）时回落 `loadPresetRules()`（占位文件）。
   *
   * 🔴 pack 规则只进内存 `presetRules` ref（`isBuiltin`），**永不写用户表**
   * （beautifierRules）—— 卸载天然免费（D20）。
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
    // 🔴 供测试/装包流程显式注入 pack 规则；生产路径不传，由 provider 惰性读（§5.6 恢复默认）
    packRulesOverride?: readonly BeautifierRule[],
  ): Promise<void> {
    try {
      // provider 内存层优先（D20）：pack 规则 > 占位文件。packRulesOverride 显式传入时
      // 优先用它（装包瞬间 provider 注册与重算谁先谁都互斥，显式传最稳）。
      const packRules = packRulesOverride ?? getPackRules();
      // 🔴 pack 规则必须过 normalizeRuleRuntime（2026-08-07 真机）：构建器 JSON 是
      //    `defaultEnabled` 形状，不经归一化则 enabled=undefined → 渲染侧全判不激活，
      //    builtin-dialogue-card 这类出厂默认开的规则装包后也失效。
      //    兼容下游 mergeRules / pruneLegacyBuiltinOverrides 的 mutable 参数，展开为可变数组
      const preset: BeautifierRule[] =
        packRules !== undefined && packRules.length >= 0
          ? (packRules as BeautifierRule[]).map((r) => normalizeRuleRuntime(r as any))
          : ((await loadPresetRules()) as BeautifierRule[]);
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
    } catch (err) {
      // 加载失败不阻断渲染（设置页打开时会兜底重算），但留痕便于诊断：
      // 2026-08-08 美化规则「只剩占位」真机复现后，这条曾全程静默。
      console.warn('[beautifier-store] refreshPresetRules 失败，presetRules 可能不完整:', err);
    }
  }

  /** 用户手动翻转默认启用状态的内置规则 id —— 仍住在 settings（字段名保持兼容） */
  function builtinDisabled(): string[] {
    return useSettingsStore().settings.beautifierBuiltinDisabled ?? [];
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
