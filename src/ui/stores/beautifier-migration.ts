/**
 * 美化规则 localStorage → Dexie 一次性迁移（Phase 0b）
 *
 * 与世界书迁移（worldbook-migration.ts）**同一套六步机制**，那套已通过独立审查：
 *   1. 显式标志位 `settings.beautifierRulesMigratedAt` 判定，不看「表里有没有行」
 *   2. 单个 `db.transaction` 内 `bulkPut`，写入全有或全无
 *   3. 销毁前回读校验：规则数量 + 逐条 id/pattern 一致
 *   4. 校验通过**才**删 localStorage 副本、置标志位（顺序不可颠倒）
 *   5. 任何一步失败：localStorage 原封不动、标志位不置，下次启动重试
 *   6. id 碰撞先唯一化再写，避免 bulkPut 静默合并成一条
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

/** `AppDatabase` 类本身未导出，用返回类型取到它 */
type AppDatabase = ReturnType<typeof getDatabase>;

/** 迁移完成标志位在 settings 里的键名 */
export const RULES_MIGRATED_FLAG_KEY = 'beautifierRulesMigratedAt';

/** 用户规则在 settings 里的旧键名（迁移后会被删除） */
export const LEGACY_RULES_KEY = 'beautifierRules';

/** 预设规则派生缓存在 settings 里的旧键名（无条件删除，见下） */
export const LEGACY_PRESET_CACHE_KEY = 'beautifierPresetRules';

export interface BeautifierMigrationDeps {
  /** 设置对象本体（settings-store 的 `settings.value`）—— 既是迁移源，也承载标志位 */
  settings: Record<string, unknown>;
  /** 把 settings 同步落 localStorage（settings-store 的 `saveNow`） */
  persistSettings: () => void;
  /** 注入缝：默认取应用单例 */
  db?: AppDatabase;
}

/** id 碰撞化解记录（语义同 worldbook 侧的 `WorldBookIdRename`） */
export interface BeautifierRuleIdRename {
  from: string;
  to: string;
  name: string;
  sourceIndex: number;
}

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

function readSource(settings: Record<string, unknown>): BeautifierRule[] {
  const raw = settings[LEGACY_RULES_KEY];
  return Array.isArray(raw) ? (raw as BeautifierRule[]) : [];
}

/**
 * 深拷贝 —— 源数组来自 Vue 响应式 ref，直接塞给 Dexie 会连 Proxy 一起走 structured clone
 * （抛 DataCloneError）。同时切断与源的引用，保证第 3 步比的是真回读出来的字节。
 *
 * 顺带丢掉 `locked`：它在 `BeautifierRule` 上就注明是「运行时计算，不持久化」，
 * 由 mergeRules/resolveAutoEnable 每次现算。存进库就成了会过期的第二真相来源。
 */
function toRows(source: BeautifierRule[]): BeautifierRule[] {
  return source.map((rule) => {
    const copy = JSON.parse(JSON.stringify(rule)) as BeautifierRule;
    delete copy.locked;
    return copy;
  });
}

/**
 * id 唯一化 —— 保内容优先，与世界书迁移同一处置。
 *
 * 美化规则的 id 同样可以撞：设置页导入规则文件走的是「同 id 覆盖、否则追加」，
 * 而 `saveRule` 新建时的 id 由调用方给。两条同 id 进 `bulkPut` 只会落一行，
 * 若回读校验按下标比对又会被「同一行返回两次」骗过 → 静默丢规则。
 *
 * 首条保留原 id（可能已被 `beautifierBuiltinDisabled` 按 id 引用），
 * 后续赋确定性新 id `${id}__dup2` / `__dup3` …，递增到不与任何已占用 id 冲突。
 */
function dedupeIds(rows: BeautifierRule[]): {
  rows: BeautifierRule[];
  renames: BeautifierRuleIdRename[];
} {
  const taken = new Set<string>(rows.map((r) => r.id));
  const seen = new Set<string>();
  const renames: BeautifierRuleIdRename[] = [];

  const out = rows.map((rule, sourceIndex) => {
    if (!seen.has(rule.id)) {
      seen.add(rule.id);
      return rule;
    }
    let n = 2;
    let candidate = `${rule.id}__dup${n}`;
    while (taken.has(candidate) || seen.has(candidate)) {
      n += 1;
      candidate = `${rule.id}__dup${n}`;
    }
    taken.add(candidate);
    seen.add(candidate);
    renames.push({ from: rule.id, to: candidate, name: rule.name, sourceIndex });
    return { ...rule, id: candidate };
  });

  return { rows: out, renames };
}

/**
 * 丢弃预设规则派生缓存。
 *
 * 🔴 刻意**不受迁移标志位与成败的约束**，无条件执行：它是 `loadPresetRules()` 从
 *    data/defaults/beautifier-rules.json 现算的派生数据，删掉零数据损失、下次启动重算。
 *    把这 ~378 KB 的净收益绑给「用户规则迁移是否成功」没有道理 ——
 *    真源数据（用户规则）该谨慎，派生缓存不该。
 *
 * @returns 是否真的删掉了东西（用于决定要不要落盘）
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
  const { settings, persistSettings } = deps;

  // ── 第 0 步：无条件丢弃派生缓存（与下面的迁移互不影响）──
  const presetCacheDropped = dropPresetCache(settings);

  // ── 第 1 步：显式标志位判定 ──────────────────────────────
  if (settings[RULES_MIGRATED_FLAG_KEY]) {
    if (presetCacheDropped) persistSettings();
    return { status: 'already-migrated', presetCacheDropped };
  }

  let db: AppDatabase;
  let rows: BeautifierRule[];
  let renames: BeautifierRuleIdRename[];
  try {
    db = deps.db ?? getDatabase();
    // 唯一化必须在写库**之前**：同 id 进 bulkPut 就已经只剩一行，事后救不回来。
    const deduped = dedupeIds(toRows(readSource(settings)));
    rows = deduped.rows;
    renames = deduped.renames;
  } catch (err) {
    if (presetCacheDropped) persistSettings();
    return { status: 'failed', stage: 'read', message: String(err), presetCacheDropped };
  }

  // ── 第 2 步：单事务 bulkPut，全有或全无 ──────────────────
  // 空数组（全新用户 / 从没自定义过规则）走同一条路径。
  // 刻意**不 clear 表**：只搬源里有的行，绝不销毁 Dexie 里已有的内容
  // （上一轮失败后重试、或 resetAll 清掉标志位后的重跑）。
  try {
    await db.transaction('rw', db.beautifierRules, async () => {
      if (rows.length > 0) await db.beautifierRules.bulkPut(rows);
    });
  } catch (err) {
    if (presetCacheDropped) persistSettings();
    return { status: 'failed', stage: 'write', message: String(err), presetCacheDropped };
  }

  // ── 第 3 步：销毁前回读校验 ──────────────────────────────
  try {
    const ids = rows.map((r) => r.id);
    // 不变式守卫：dedupeIds 之后 id 必然唯一。若这里还能撞，说明唯一化坏了 ——
    // 此时按下标比对会被「同一行返回两次」骗过去，宁可判失败也不能往下走。
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      return {
        status: 'failed',
        stage: 'verify',
        message: `id 唯一化失效: ${ids.length} 条规则只有 ${uniqueIds.size} 个不同 id`,
        presetCacheDropped,
      };
    }
    const readBack = await db.beautifierRules.bulkGet(ids);
    if (readBack.length !== rows.length) {
      return {
        status: 'failed',
        stage: 'verify',
        message: `回读规则数量不符: 期望 ${rows.length}，实际 ${readBack.length}`,
        presetCacheDropped,
      };
    }
    for (let i = 0; i < rows.length; i++) {
      const expected = rows[i];
      const actual = readBack[i];
      if (!actual) {
        return {
          status: 'failed',
          stage: 'verify',
          message: `回读缺规则: ${expected.id}`,
          presetCacheDropped,
        };
      }
      if (actual.id !== expected.id) {
        return {
          status: 'failed',
          stage: 'verify',
          message: `回读规则 id 不符: 期望 ${expected.id}，实际 ${actual.id}`,
          presetCacheDropped,
        };
      }
      // pattern/replacement 是规则的全部价值所在，逐条比对而不是只数个数
      if (actual.pattern !== expected.pattern || actual.replacement !== expected.replacement) {
        return {
          status: 'failed',
          stage: 'verify',
          message: `规则「${expected.name}」正文不符`,
          presetCacheDropped,
        };
      }
    }
  } catch (err) {
    if (presetCacheDropped) persistSettings();
    return { status: 'failed', stage: 'verify', message: String(err), presetCacheDropped };
  }

  // ── 第 4 步：校验通过才销毁源 + 置标志位（顺序不可颠倒）──
  // 从 settings 对象上删键，而不是只改 localStorage 字符串 —— settings-store 的
  // deep watch 会把整个对象重新序列化写回去，只改字符串下一拍就被覆盖。
  delete settings[LEGACY_RULES_KEY];
  settings[RULES_MIGRATED_FLAG_KEY] = Date.now();
  persistSettings();

  return { status: 'migrated', ruleCount: rows.length, renames, presetCacheDropped };
}
