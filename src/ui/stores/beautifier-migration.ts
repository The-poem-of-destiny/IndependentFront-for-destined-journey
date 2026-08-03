/**
 * 美化规则 localStorage → Dexie 一次性迁移（Phase 0b）
 *
 * **六步流程本身在 `legacy-dexie-migration.ts`**（Q-08：本文件与 worldbook-migration
 * 曾各存一份逐字相同的实现）。本文件只留美化规则特有的东西：
 *   - 第 0 步 `dropPresetCache`：无条件丢弃派生缓存（骨架的 `preStep`）
 *   - `toRow`：深拷贝 + 丢掉运行时字段 `locked`
 *   - `verifyRow`：逐条比 `pattern`/`replacement`
 *   - `pruneLegacyBuiltinOverrides`：与迁移无关的一次性语义修正，见下
 *
 * 三个字段分别处置（刻意不一刀切）：
 *
 * | 字段 | 处置 | 理由 |
 * | --- | --- | --- |
 * | `beautifierRules`（用户规则） | 迁进 Dexie 表 | 用户数据；工坊正则将来也往这儿装（~494 KB） |
 * | `beautifierPresetRules`（内置 22 条，~378 KB） | **彻底不再持久化** | 是 `loadPresetRules()` 从磁盘现算的派生缓存 |
 * | `beautifierBuiltinDisabled`（string[]） | 留在 settings | 就是几个 id，体积无关紧要 |
 *
 * 中间那行是本次最大的净收益：直接省掉 ~378 KB，且修掉「派生数据被当真源持久化」。
 */
import { getDatabase } from '@engine/database';
import type { BeautifierRule } from '@engine/types';
import { runLegacyMigration, type IdRename } from './legacy-dexie-migration';

/** `AppDatabase` 类本身未导出，用返回类型取到它 */
type AppDatabase = ReturnType<typeof getDatabase>;

/** 迁移完成标志位在 settings 里的键名 */
export const RULES_MIGRATED_FLAG_KEY = 'beautifierRulesMigratedAt';

/** 用户规则在 settings 里的旧键名（迁移后会被删除） */
export const LEGACY_RULES_KEY = 'beautifierRules';

/** 预设规则派生缓存在 settings 里的旧键名（无条件删除，见下） */
export const LEGACY_PRESET_CACHE_KEY = 'beautifierPresetRules';

/** 内置规则手动覆盖列表的键名（字段名沿用历史，语义已改，见 `pruneLegacyBuiltinOverrides`） */
export const BUILTIN_OVERRIDES_KEY = 'beautifierBuiltinDisabled';

/** 覆盖列表语义迁移的标志位 */
export const BUILTIN_OVERRIDES_MIGRATED_FLAG_KEY = 'beautifierBuiltinOverridesMigratedAt';

/**
 * `beautifierBuiltinDisabled` 的语义从「强制关掉」改成「相对出厂默认翻转」（2026-08-03）。
 *
 * 为什么要迁：22 条预设里 **21 条出厂 `defaultEnabled: false`**，旧 `mergeRules` 对它们
 * 一律强制 `enabled = false` —— 也就是说在设置页点这 21 条是**空操作**。但
 * `toggleBuiltinRule` 不管有没有效果，照样把 id 塞进了列表。语义一改成 XOR，那些
 * 「点了没反应」留下的 id 会在升级后突然把规则全打开，老存档一进游戏页满屏卡片。
 *
 * 处置：只保留在**旧语义下真的起过作用**的 id（出厂就开着、被这个列表关掉的那些）。
 * 认不出来的 id（预设里查无此条）保守留着，不替用户做主。想开哪条再点一次即可 ——
 * 这次会真的生效。
 *
 * 纯函数：只读 `presetRules` 的出厂 `enabled`，就地改 settings，返回是否动过。
 */
export function pruneLegacyBuiltinOverrides(
  settings: Record<string, unknown>,
  presetRules: readonly BeautifierRule[],
): boolean {
  if (settings[BUILTIN_OVERRIDES_MIGRATED_FLAG_KEY]) return false;

  const raw = settings[BUILTIN_OVERRIDES_KEY];
  const list = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  const defaultEnabledById = new Map(presetRules.map((rule) => [rule.id, rule.enabled === true]));
  const kept = list.filter((id) => defaultEnabledById.get(id) ?? true);

  settings[BUILTIN_OVERRIDES_MIGRATED_FLAG_KEY] = Date.now();
  if (kept.length !== list.length || !Array.isArray(raw)) settings[BUILTIN_OVERRIDES_KEY] = kept;
  return true;
}

export interface BeautifierMigrationDeps {
  /** 设置对象本体（settings-store 的 `settings.value`）—— 既是迁移源，也承载标志位 */
  settings: Record<string, unknown>;
  /** 把 settings 同步落 localStorage（settings-store 的 `saveNow`） */
  persistSettings: () => void;
  /** 注入缝：默认取应用单例 */
  db?: AppDatabase;
}

/** id 碰撞化解记录 —— 语义与结构见 `legacy-dexie-migration` 的 `IdRename` */
export type BeautifierRuleIdRename = IdRename;

export type BeautifierMigrationOutcome =
  /** 标志位已置位，规则表没动（预设缓存仍会被顺手清掉，见 presetCacheDropped） */
  | { status: 'already-migrated'; presetCacheDropped: boolean }
  /** 迁移成功：localStorage 副本已删、标志位已置 */
  | {
      status: 'migrated';
      ruleCount: number;
      renames: BeautifierRuleIdRename[];
      presetCacheDropped: boolean;
    }
  /** 失败：localStorage 里的用户规则完好、标志位未置，下次启动重试 */
  | {
      status: 'failed';
      stage: 'read' | 'write' | 'verify';
      message: string;
      presetCacheDropped: boolean;
    };

/**
 * 丢弃预设规则派生缓存。
 *
 * 🔴 刻意**不受迁移标志位与成败的约束**，无条件执行（走骨架的第 0 步 `preStep`）：
 *    它是 `loadPresetRules()` 从 data/defaults/beautifier-rules.json 现算的派生数据，
 *    删掉零数据损失、下次启动重算。把这 ~378 KB 的净收益绑给「用户规则迁移是否成功」
 *    没有道理 —— 真源数据（用户规则）该谨慎，派生缓存不该。
 *
 * @returns 是否真的删掉了东西（骨架据此决定要不要在失败分支上补落盘）
 */
function dropPresetCache(settings: Record<string, unknown>): boolean {
  if (!(LEGACY_PRESET_CACHE_KEY in settings)) return false;
  delete settings[LEGACY_PRESET_CACHE_KEY];
  return true;
}

/**
 * 执行迁移。**永不抛** —— 失败以 outcome 形式返回，调用方（store init）静默继续。
 */
export async function migrateBeautifierRulesToDexie(
  deps: BeautifierMigrationDeps,
): Promise<BeautifierMigrationOutcome> {
  let db: AppDatabase;
  try {
    db = deps.db ?? getDatabase();
  } catch (err) {
    // getDatabase() 自己炸了：第 0 步还没跑，预设缓存自然没动
    return { status: 'failed', stage: 'read', message: String(err), presetCacheDropped: false };
  }

  const out = await runLegacyMigration<BeautifierRule>({
    flagKey: RULES_MIGRATED_FLAG_KEY,
    legacyKey: LEGACY_RULES_KEY,
    table: db.beautifierRules,
    db,
    settings: deps.settings,
    persistSettings: deps.persistSettings,
    unit: '条规则',
    nameOf: (rule) => rule.name,
    preStep: () => dropPresetCache(deps.settings),
    // 深拷贝（理由见骨架的 `toRow` 文档）+ 丢掉 `locked`：它在 `BeautifierRule` 上
    // 就注明是「运行时计算，不持久化」，由 mergeRules/resolveAutoEnable 每次现算。
    // 存进库就成了会过期的第二真相来源。
    toRow: (rule) => {
      const copy = JSON.parse(JSON.stringify(rule)) as BeautifierRule;
      delete copy.locked;
      return copy;
    },
    // 美化规则的校验强度：pattern/replacement 是规则的全部价值所在，逐条比对而不是只数个数
    // （**别降级**，不留 localStorage 回滚副本就靠它兜着）
    verifyRow: (expected, actual) =>
      actual.pattern === expected.pattern && actual.replacement === expected.replacement
        ? null
        : `规则「${expected.name}」正文不符`,
  });

  const presetCacheDropped = out.preStepChanged;
  if (out.status === 'already-migrated') return { status: 'already-migrated', presetCacheDropped };
  if (out.status === 'failed') {
    return { status: 'failed', stage: out.stage, message: out.message, presetCacheDropped };
  }
  return {
    status: 'migrated',
    ruleCount: out.rows.length,
    renames: out.renames,
    presetCacheDropped,
  };
}
