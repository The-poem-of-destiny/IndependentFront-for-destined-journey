/**
 * localStorage → Dexie 一次性迁移的**唯一实现**（Q-08）。
 *
 * 🔴 这是仓库里唯一「用户唯一副本 + 校验通过就删源」的数据销毁路径。
 *    铁律：**宁可迁移永不成功，也不能半成功。**
 *    任何一步失败都让 localStorage 原封不动、标志位不置，应用继续走旧路径，下次启动重试。
 *
 * 起因：世界书（Phase 0）与美化规则（Phase 0b）曾各存一份逐字相同的六步流程，
 * 连「从 settings 对象上删键、而不是只改 localStorage 字符串」那段注释都一样。
 * 漂移已经开始：两份 `dedupeIds` 只差 `book`→`rule` 的变量名，而回读校验强度
 * 一份比 `entries.length`、一份比 `pattern`/`replacement`。
 * 以后要修 dedupe 规则、加一个 stage、或提升回读强度，漏改一处的代价不是编译错误，
 * 而是用户数据静默永久丢失 —— 所以这类流程只许有一份。
 *
 * **`api-key-migration.ts` 刻意留在外面**：它没有 dedupe、不把标志位当充分条件
 * （还要看 `legacyKeysRetained`）、多一个带回滚的第 4 阶段 scrub、还要把本地条目 merge 回去。
 * 四条差异塞进同一个泛型签名等于把骨架撑成一个带四个开关的怪物，风险大于收益。
 *
 * ---
 *
 * 六步（顺序不可变）：
 *   0. 可选 `preStep` —— 与迁移成败无关的无条件副作用（如丢弃派生缓存）。
 *      在标志位判定**之前**跑，且必须在每一条失败分支上都被如实报出。
 *   1. 以显式标志位判定，**不**以「表里有没有行」判定 —— 半失败的运行会留下行，
 *      看起来像已完成。
 *   2. 单个 `db.transaction` 内 `bulkPut`，写入全有或全无。
 *   3. 销毁前回读校验：数量 + 逐行 id + 调用方给的 `verifyRow`。
 *   4. 校验通过**才**删 localStorage 副本、置标志位（顺序不可颠倒）。
 *   5. 任何一步失败：localStorage 原封不动、标志位不置。
 *
 * 不保留 localStorage 回滚副本 —— 留着就没释放配额，而释放配额正是迁移的目的。
 * 代价由第 3 步的校验强度承担，所以 **`verifyRow` 各调用方保留自己的强度，
 * 不许「统一」成较弱的那份**。
 */
import type { Table } from 'dexie';

/**
 * 迁移期间为化解 id 碰撞而做的重命名记录。
 *
 * 结构化返回（而非只打 console）是为了上层将来能如实告诉用户
 * 「你有两本重名的书，第二本已改名为 X」—— 静默改 id 和静默丢数据一样不可接受。
 */
export interface IdRename {
  /** 碰撞前的原 id（= 首次出现者保留的那个） */
  from: string;
  /** 分配到的新唯一 id */
  to: string;
  /** 显示名，供 UI 提示时指认是哪一条 */
  name: string;
  /** 该行在源数组里的下标，便于排查 */
  sourceIndex: number;
}

/**
 * id 唯一化 —— **保内容优先**。
 *
 * 🔴 为什么必须有这一步：localStorage 里的 id 是可以撞的（各处新建/导入都是裸 `push`，
 *    没有去重）。两行同 id 进 `bulkPut` 只会落一行 —— 而回读校验若按下标比对，
 *    `bulkGet(['x','x'])` 会把同一行返回两次，数量/ id /内容全对得上
 *    （同 id 通常来自重复导入同一文件，内容必然相同）→ 校验通过 → 删 localStorage
 *    → **其中一行静默永久丢失**。
 *
 * 处置原则：
 * - **首次出现者保留原 id** —— 它可能已被别处按 id 引用（Agent 配置的 `worldBookIds`、
 *   `beautifierBuiltinDisabled`），改了会断绑定。
 * - 后续碰撞者赋确定性新 id `${id}__dup2` / `__dup3` …，编号一直递增到不再与
 *   **任何**已占用 id 冲突（包括源里正好存在一个真的叫 `x__dup2` 的行）。
 * - 一条内容都不丢；重命名如实记账返回。
 *
 * 刻意**不**采取「碰撞即 verify 失败」：那会让这类用户永远卡在 localStorage 上、
 * 没有前进路径，把小问题变成死局。
 */
export function dedupeById<T extends { id: string }>(
  rows: T[],
  nameOf: (row: T) => string,
): { rows: T[]; renames: IdRename[] } {
  const taken = new Set<string>(rows.map((r) => r.id)); // 先占住全部原始 id，新 id 不许撞上它们
  const seen = new Set<string>();
  const renames: IdRename[] = [];

  const out = rows.map((row, sourceIndex) => {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      return row;
    }
    // 撞了：为这一行找一个没人占的确定性新 id
    let n = 2;
    let candidate = `${row.id}__dup${n}`;
    while (taken.has(candidate) || seen.has(candidate)) {
      n += 1;
      candidate = `${row.id}__dup${n}`;
    }
    taken.add(candidate);
    seen.add(candidate);
    renames.push({ from: row.id, to: candidate, name: nameOf(row), sourceIndex });
    return { ...row, id: candidate };
  });

  return { rows: out, renames };
}

export type LegacyMigrationOutcome<T> =
  /** 标志位已置位，表没动（`preStep` 仍会跑，见 `preStepChanged`） */
  | { status: 'already-migrated'; preStepChanged: boolean }
  /** 迁移成功：localStorage 副本已删、标志位已置 */
  | { status: 'migrated'; rows: T[]; renames: IdRename[]; preStepChanged: boolean }
  /** 失败：localStorage 完好、标志位未置，下次启动重试 */
  | {
      status: 'failed';
      stage: 'read' | 'write' | 'verify';
      message: string;
      preStepChanged: boolean;
    };

export interface LegacyMigrationOptions<T extends { id: string }> {
  /** 迁移完成标志位在 settings 里的键名 */
  flagKey: string;
  /** 源数据在 settings 里的旧键名（迁移成功后会被删除） */
  legacyKey: string;
  /** 目标表 */
  table: Table<T, string>;
  /** 事务宿主 —— 只用它开 `transaction('rw', table, …)` */
  db: { transaction<R>(mode: 'rw', table: Table<T, string>, fn: () => Promise<R>): Promise<R> };
  /** 设置对象本体（settings-store 的 `settings.value`）—— 既是迁移源，也承载标志位 */
  settings: Record<string, unknown>;
  /** 把 settings 同步落 localStorage（settings-store 的 `saveNow`） */
  persistSettings: () => void;
  /** 显示名提取，只用于 `IdRename.name` 与错误消息 */
  nameOf: (row: T) => string;
  /**
   * 源行 → 落库行。**必须深拷贝**：源数组来自 Vue 响应式 ref，直接塞给 Dexie 会连
   * Proxy 一起走 structured clone（抛 DataCloneError）；同时切断与源的引用，
   * 保证第 3 步比的是真正回读出来的字节，而不是同一个对象。
   */
  toRow: (src: T) => T;
  /**
   * 第 3 步的**内容**校验（数量与 id 已由骨架统一比过）。
   * 返回 `null` 通过，返回字符串即失败原因。
   *
   * 🔴 各调用方保留自己的强度，不许在这里做「统一」——校验强度就是不留回滚副本的代价。
   */
  verifyRow: (expected: T, actual: T) => string | null;
  /** 单位量词，只用于拼错误消息（如「本书」「条规则」） */
  unit: string;
  /**
   * 第 0 步：与迁移成败无关的无条件副作用，在标志位判定**之前**跑。
   * 返回是否真的改了 settings —— 骨架据此在每条早退/失败分支上补 `persistSettings()`。
   */
  preStep?: () => boolean;
}

/**
 * 执行迁移。**永不抛** —— 失败以 outcome 形式返回，调用方（store init）静默继续。
 */
export async function runLegacyMigration<T extends { id: string }>(
  opts: LegacyMigrationOptions<T>,
): Promise<LegacyMigrationOutcome<T>> {
  const { settings, persistSettings, table, db, flagKey, legacyKey, unit } = opts;

  // ── 第 0 步：无条件副作用（与下面的迁移互不影响）──
  const preStepChanged = opts.preStep ? opts.preStep() : false;
  /** 早退/失败时补落盘 —— preStep 改过的东西不该被迁移失败连累 */
  const flushPreStep = (): void => {
    if (preStepChanged) persistSettings();
  };

  // ── 第 1 步：显式标志位判定 ──────────────────────────────
  // 刻意不看 `table.count()`：半失败的运行会留下行，看起来像已完成。
  if (settings[flagKey]) {
    flushPreStep();
    return { status: 'already-migrated', preStepChanged };
  }

  let rows: T[];
  let renames: IdRename[];
  try {
    // 源数组读取 —— 只接受数组；其它形状（undefined/null/被写坏）一律当空。
    const raw = settings[legacyKey];
    const source = Array.isArray(raw) ? (raw as T[]) : [];
    // 唯一化必须在写库**之前**：同 id 进 bulkPut 就已经只剩一行了，
    // 事后无论怎么校验都救不回来。
    const deduped = dedupeById(source.map(opts.toRow), opts.nameOf);
    rows = deduped.rows;
    renames = deduped.renames;
  } catch (err) {
    flushPreStep();
    return { status: 'failed', stage: 'read', message: String(err), preStepChanged };
  }

  // ── 第 2 步：单事务 bulkPut，全有或全无 ──────────────────
  // 空数组（全新用户）走同一条路径：bulkPut([]) 是 no-op，随后校验平凡通过，
  // 标志位置位收工。刻意**不 clear 表** —— 迁移只搬源里有的行，绝不销毁 Dexie 里
  // 已有的内容（例如上一轮失败后重试、或 resetAll 清掉标志位后的重跑）。
  try {
    await db.transaction('rw', table, async () => {
      if (rows.length > 0) await table.bulkPut(rows);
    });
  } catch (err) {
    flushPreStep();
    return { status: 'failed', stage: 'write', message: String(err), preStepChanged };
  }

  // ── 第 3 步：销毁前回读校验 ──────────────────────────────
  try {
    const ids = rows.map((r) => r.id);
    // 不变式守卫：dedupeById 之后 id 必然唯一。若这里还能撞，说明唯一化本身坏了 ——
    // 此时按下标比对会被「同一行返回两次」骗过去，宁可判失败也不能往下走。
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      flushPreStep();
      return {
        status: 'failed',
        stage: 'verify',
        message: `id 唯一化失效: ${ids.length} ${unit}只有 ${uniqueIds.size} 个不同 id`,
        preStepChanged,
      };
    }
    const readBack = await table.bulkGet(ids);
    if (readBack.length !== rows.length) {
      flushPreStep();
      return {
        status: 'failed',
        stage: 'verify',
        message: `回读数量不符: 期望 ${rows.length}，实际 ${readBack.length}`,
        preStepChanged,
      };
    }
    for (let i = 0; i < rows.length; i++) {
      const expected = rows[i];
      const actual = readBack[i];
      if (!actual) {
        flushPreStep();
        return {
          status: 'failed',
          stage: 'verify',
          message: `回读缺行: ${expected.id}`,
          preStepChanged,
        };
      }
      if (actual.id !== expected.id) {
        flushPreStep();
        return {
          status: 'failed',
          stage: 'verify',
          message: `回读 id 不符: 期望 ${expected.id}，实际 ${actual.id}`,
          preStepChanged,
        };
      }
      const reason = opts.verifyRow(expected, actual);
      if (reason) {
        flushPreStep();
        return { status: 'failed', stage: 'verify', message: reason, preStepChanged };
      }
    }
  } catch (err) {
    flushPreStep();
    return { status: 'failed', stage: 'verify', message: String(err), preStepChanged };
  }

  // ── 第 4 步：校验通过才销毁源 + 置标志位（顺序不可颠倒）──
  // 从 settings 对象上删键，而不是只改 localStorage 字符串 —— settings-store 的
  // deep watch 会把整个对象重新序列化写回去，只改字符串下一拍就被覆盖。
  delete settings[legacyKey];
  settings[flagKey] = Date.now();
  persistSettings();

  return { status: 'migrated', rows, renames, preStepChanged };
}
