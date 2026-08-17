/**
 * content-pack-plan.ts — 内容-引擎分离（波 1）的安装/升级/卸载**纯函数 planner**。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md`
 * 重点决策: D19（纯 planner + 哑执行器）/ D20（四态基线 + 占位基线来源）/
 * D43（存档 uid 迁移三段式）/ D18（hash 分工）/ §5.2（安装/升级/卸载流）。
 *
 * 为什么存在（与 content-source.ts 的分工）:
 * `content-source.ts` 承载校验 + hash 工具 + 分节解析（T1 范围）；**planner 的四态判定
 * 逻辑搬到本文件**——它是波 1 最复杂的纯函数（四态 + uid 迁移 + 卸载 + diff），独立成模块
 * 便于单测、便于执行器（content-store）只 import 一个 `planPackInstall` 入口。
 *
 * 🔴 **两个文件互相 import，是一条真实的运行时环**（如实记录，别照旧注释理解成单向）：
 * 本文件取 content-source.ts 的 hash / 校验工具（`hashWorldBook` /
 * `hashContentDeterministic` / `validatePackOrThrow` / `PLACEHOLDER_UID_RESERVED_BASE`），
 * 而 content-source.ts 又 import 本文件的 `planPackInstall` 做委托转发（那边:575）。
 * 目前无害**只因为两侧的使用点全在函数体内**——ESM 环下模块初始化期取到的是 undefined，
 * 所以**任一侧都不许在模块顶层（含字段初始值 / 顶层常量表达式）使用对方的导出**。
 * 真要解环: 把共用的 hash 工具下沉成第三个叶子模块，或删掉 content-source 那个转发口。
 *
 * 纯度约束（与 workshop-install-plan.ts / asset-import-plan.ts 同一个规矩）:
 * 无 I/O、无 Dexie、无 Vue、无 `crypto.subtle`（异步会把 planner 传染成 async）。
 * 🔴 **planner 不 fetch**: 基线 hash 由调用方作参数传入（D19/D20 裁定 ——
 * 占位基线来源 = 构建期生成、随引擎打包的 `placeholder-hashes.json`，不许运行时 fetch）。
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §4 / §5.1 / §5.2 / D8 / D18 / D19 / D20 / D43
 */

import {
  hashContentDeterministic,
  hashWorldBook,
  validatePackOrThrow,
  PLACEHOLDER_UID_RESERVED_BASE,
} from './content-source';
import { emptySectionPlan } from './types-content';
import type {
  ContentPack,
  PackBaseline,
  PackInstallPlan,
  PackSaveUidMigration,
  PackSectionPlan,
} from './types-content';
import type {
  BeautifierRule,
  Bloodline,
  ChatPreset,
  LocationNode,
  MapMarker,
  WorldBook,
  WorldBookPartition,
  WorkshopNote,
} from './types';

// ═══════════════════════════════════════════════════════════
// 类型：当前库状态（planner 第二个参数）
// ═══════════════════════════════════════════════════════════

/**
 * planner 第二参数 —— 当前库里各分节的状态 + 存档级 uid 允许清单。
 *
 * 🔴 `enabledWorldBookEntries` 是 D43 迁移的唯一信号源：占位期建的存档把单选钉选分区
 * （system_core/character）的 uid 钉进这个清单，装包后占位 uid 失配 → 触发按名配对 /
 * needs_selection 判定。它从存档的 SaveProfile 读出来交给调用方（content-store）传入。
 *
 * 与 content-source.ts 的 planPackInstall 签名兼容：那边的 `current` 类型是这里的子集
 * （本文件加 `enabledWorldBookEntries` 字段做迁移）。
 */
export interface CurrentLibrary {
  worldBooks?: readonly WorldBook[];
  presets?: readonly ChatPreset[];
  beautifierRules?: readonly BeautifierRule[];
  mapMarkers?: readonly MapMarker[];
  locations?: readonly LocationNode[];
  bloodlines?: readonly Bloodline[];
  /** 存档级 uid 允许清单（`"partition:uid"`），D43 迁移信号源 */
  enabledWorldBookEntries?: readonly string[];
}

/**
 * 单选钉选分区（D43）：建档时单选写入 enabledWorldBookEntries 的分区。
 *
 * 🔴 裸删这些分区的失配键 = 该分区「整本原样通过」（worldbook-loader.ts:190 的
 * partition 未收录 → 整本通过），把玩家单选的一个命定核心炸成全书注入（内容通胀回归）。
 * 故失配时标记 needs_selection，不许裸删。多选分区的失配键允许清除 + note。
 */
export const SINGLE_SELECT_PINNED_PARTITIONS: readonly WorldBookPartition[] = [
  'system_core',
  'character',
];

// ═══════════════════════════════════════════════════════════
// 主入口：planPackInstall
// ═══════════════════════════════════════════════════════════

/**
 * 产出一个内容包的安装计划（D19 / D20 / D43 / §5.2）。
 *
 * **四态规则**（D20，逐书/逐项）:
 * - 当前库里某 id 不存在 + pack 有 → `added`（新增）
 * - pack 声明 `[]`（空数组）→ `removed`（清空当前所有拥有项）
 * - 当前存在某 id:
 *   - **有上次装包基线**（`packBaseline.byBook[id]`）: 现 hash = 基线 → `updated`（静默覆盖）；≠ → `conflicted`
 *   - **无装包基线（首次安装——主路径）**: 现 hash = **占位基线**（`placeholderBaseline.byBook[id]`）→ `updated`（未动过的占位书，静默覆盖）；≠ → `conflicted`（覆盖既存测试者的真实编辑书前必须确认）
 *
 * 🔴 **planner 不 fetch**: 两个基线都由调用方传入。占位基线来源是构建期生成的
 * `placeholder-hashes.json`（D20），调用方读盘后作参数喂进来。
 *
 * 🔴 **hash 从 payload 现算**（D18 hash 分工）: 本函数用 `hashWorldBook` 现算当前书的
 * 正文 hash，**不**用 pack 的 `sectionHashes`（那玩意只用于 D40 升级 diff 展示）。
 *
 * @param pack 待安装的内容包
 * @param current 当前库里各分节的状态 + 存档级 uid 允许清单（D43）
 * @param packBaseline 上次装包的逐项基线 hash（D20 四态规则操作数之一）；首装时 undefined
 * @param placeholderBaseline 占位内容的逐项基线 hash（D20 四态规则操作数之二）
 */
export function planPackInstall(
  pack: ContentPack,
  current: CurrentLibrary = {},
  packBaseline: PackBaseline = {},
  placeholderBaseline: PackBaseline = {},
): PackInstallPlan {
  const validationErrors = validatePackOrThrow(pack);
  const notes: WorkshopNote[] = [];

  const sections: PackInstallPlan['sections'] = {};

  // ── worldBooks: 完整四态（D20 双基线）──
  if (pack.worldBooks !== undefined) {
    sections.worldBooks = planWorldBooks(
      pack.worldBooks,
      current.worldBooks ?? [],
      packBaseline,
      placeholderBaseline,
    );
  }

  // ── presets / beautifierRules / mapMarkers / locations / bloodlines: 简化四态骨架 ──
  // 本波这些分节按 id/key 判 added/updated/removed/conflicted；基线机制留简化版
  // （重点是 worldBooks 四态 + 存档迁移）。
  if (pack.presets !== undefined) {
    sections.presets = planIdKeySection(
      pack.presets,
      current.presets ?? [],
      packBaseline.byPreset,
      placeholderBaseline.byPreset,
      (p: ChatPreset) => p.id,
      hashPresetRow,
    );
  }
  if (pack.beautifierRules !== undefined) {
    sections.beautifierRules = planIdKeySection(
      pack.beautifierRules.rules,
      current.beautifierRules ?? [],
      packBaseline.byBeautifierRule,
      placeholderBaseline.byBeautifierRule,
      (r: BeautifierRule) => r.id,
      hashRuleRow,
    );
  }
  if (pack.mapMarkers !== undefined) {
    sections.mapMarkers = planIdKeySection(
      pack.mapMarkers,
      current.mapMarkers ?? [],
      undefined,
      undefined,
      (m: MapMarker) => m.id,
      (m: MapMarker) => hashContentDeterministic(JSON.stringify(stableSerialize(m))),
    );
  }
  if (pack.locations !== undefined) {
    sections.locations = planIdKeySection(
      pack.locations,
      current.locations ?? [],
      undefined,
      undefined,
      (l: LocationNode) => l.id,
      (l: LocationNode) => hashContentDeterministic(JSON.stringify(stableSerialize(l))),
    );
  }
  if (pack.bloodlines !== undefined) {
    // bloodlines 是 Record 形状整块替换分节（运行态 getBloodlineSet 消费，与占位
    // bloodlines.json 同形）——无逐项冲突语义，与 catalog/namePools 同走 opaque。
    // 🪦 曾按 id-keyed 四态读 `pack.bloodlines.bloodlines`（数组假设）：T10 落地
    //    Record 形状后 planner 未同步，装真实 pack 时 `undefined.length` 崩溃。
    sections.bloodlines = planOpaqueSection(pack.bloodlines);
  }
  if (pack.namePools !== undefined) {
    // namePools 是 `{ data: unknown }` 透传分节，本波按整块判定（无逐项键）
    sections.namePools = planOpaqueSection(pack.namePools);
  }
  if (pack.catalog !== undefined) {
    // catalog 同样是 `{ data: unknown }` 透传分节
    sections.catalog = planOpaqueSection(pack.catalog);
  }
  if (pack.randomEvents !== undefined) {
    // randomEvents（第 13 面）是 `{ config?, defs }` 整块替换分节 —— 事件定义没有 id，
    // 逐项键只能是事件名，而「同名后装覆盖」的判定已经在 `coerceRandomEventPack` 里做过；
    // planner 再做一遍就是两处口径，而不一致时先出错的那一处永远没人手工验。
    sections.randomEvents = planOpaqueSection(pack.randomEvents);
  }

  // ── agentDefaults / branding 名册/键集（透传，无四态）──
  const agentDefaults: PackInstallPlan['agentDefaults'] | undefined = pack.agentDefaults
    ? { agentIds: Object.keys(pack.agentDefaults.agents ?? {}) }
    : undefined;

  const branding: PackInstallPlan['branding'] | undefined = pack.branding
    ? { declaredKeys: Object.keys(pack.branding) }
    : undefined;

  // ── 存档 uid 迁移（D43 三段式）──
  let saveUidMigration: PackSaveUidMigration | undefined;
  if (pack.worldBooks !== undefined) {
    saveUidMigration = planSaveUidMigration(
      pack.worldBooks,
      current.worldBooks ?? [],
      current.enabledWorldBookEntries ?? [],
      notes,
    );
  }

  return {
    packId: typeof pack.packId === 'string' ? pack.packId : '',
    packVersion: typeof pack.packVersion === 'string' ? pack.packVersion : '',
    sections,
    agentDefaults,
    branding,
    saveUidMigration,
    notes,
    validationErrors,
  };
}

// ═══════════════════════════════════════════════════════════
// worldBooks 四态（D20 双基线 hash）
// ═══════════════════════════════════════════════════════════

/**
 * worldBooks 分节的四态判定（D20）。
 *
 * 双基线规则:
 * 1. 当前库里该 id 不存在 + pack 有 → `added`
 * 2. pack 声明 `[]` → `removed`（清空当前所有拥有项——但「当前所有」界定为同 id 集合的当前行；
 *    本函数只清空与 pack 声明 id 集合重合的当前行，不强删无关行）
 * 3. 当前存在该 id:
 *    - packBaseline.byBook[id] 存在（上次装过）: 现 hash = packBaseline → updated; ≠ → conflicted
 *    - packBaseline 无此 id（首次安装）: 现 hash = placeholderBaseline.byBook[id] → updated（占位书未动过）; ≠ → conflicted
 *    - 两个基线都没有此 id（既不是装过的、也不在占位基线——比如用户手编书占用了 pack 想覆盖的 id）→ conflicted
 */
function planWorldBooks(
  packBooks: readonly WorldBook[],
  currentBooks: readonly WorldBook[],
  packBaseline: PackBaseline,
  placeholderBaseline: PackBaseline,
): PackSectionPlan<WorldBook> {
  const plan: PackSectionPlan<WorldBook> = emptySectionPlan<WorldBook>();

  // pack 声明 [] = 刻意清空 → removed 标记当前所有同 id 拥有行
  if (packBooks.length === 0) {
    plan.removed.push(...currentBooks);
    return plan;
  }

  const currentById = new Map<string, WorldBook>();
  for (const b of currentBooks) currentById.set(b.id, b);

  for (const packBook of packBooks) {
    const current = currentById.get(packBook.id);
    if (!current) {
      // 当前不存在 → 新增
      plan.added.push(packBook);
      continue;
    }
    // 当前存在 → 双基线判定
    const currentHash = hashWorldBook(current);
    const packBaseHash = packBaseline.byBook?.[packBook.id];
    const placeholderBaseHash = placeholderBaseline.byBook?.[packBook.id];

    if (packBaseHash !== undefined) {
      // 上次装过这本书
      if (currentHash === packBaseHash) {
        plan.updated.push(packBook);
      } else {
        plan.conflicted.push({
          key: packBook.id,
          name: packBook.name,
          currentHash,
          packHash: packBaseHash,
        });
      }
    } else if (placeholderBaseHash !== undefined) {
      // 首次安装 + 占位基线命中（未动过的占位书）
      if (currentHash === placeholderBaseHash) {
        plan.updated.push(packBook);
      } else {
        plan.conflicted.push({
          key: packBook.id,
          name: packBook.name,
          currentHash,
          packHash: placeholderBaseHash,
        });
      }
    } else {
      // 两个基线都没有此 id —— 用户既没装过、也不在占位集 → 必须确认
      plan.conflicted.push({
        key: packBook.id,
        name: packBook.name,
        currentHash,
        packHash: hashWorldBook(packBook),
      });
    }
  }

  return plan;
}

// ═══════════════════════════════════════════════════════════
// 通用 id-keyed 四态（presets / beautifierRules / mapMarkers / locations / bloodlines）
// ═══════════════════════════════════════════════════════════

/**
 * 泛型 id-keyed 分节的四态判定。
 *
 * 用 `getId` 抽取每行的唯一键（presets=id / rules=id / markers=id / ...），
 * `hashRow` 抽取每行的正文 hash。基线机制与 worldBooks 同（双基线），但本波这些分节
 * 通常无占位基线（简化：传 undefined 即退化为「有装包基线 → 比对；无 → updated 或 conflicted」）。
 */
function planIdKeySection<T>(
  packRows: readonly T[],
  currentRows: readonly T[],
  packBaselineById: Readonly<Record<string, string>> | undefined,
  placeholderBaselineById: Readonly<Record<string, string>> | undefined,
  getId: (row: T) => string,
  hashRow: (row: T) => string,
): PackSectionPlan<T> {
  const plan: PackSectionPlan<T> = emptySectionPlan<T>();

  if (packRows.length === 0) {
    plan.removed.push(...currentRows);
    return plan;
  }

  const currentById = new Map<string, T>();
  for (const r of currentRows) currentById.set(getId(r), r);

  for (const packRow of packRows) {
    const id = getId(packRow);
    const current = currentById.get(id);
    if (!current) {
      plan.added.push(packRow);
      continue;
    }
    const currentHash = hashRow(current);
    const packBaseHash = packBaselineById?.[id];
    const placeholderBaseHash = placeholderBaselineById?.[id];

    if (packBaseHash !== undefined) {
      if (currentHash === packBaseHash) plan.updated.push(packRow);
      else
        plan.conflicted.push({
          key: id,
          name: id,
          currentHash,
          packHash: packBaseHash,
        });
    } else if (placeholderBaseHash !== undefined) {
      if (currentHash === placeholderBaseHash) plan.updated.push(packRow);
      else
        plan.conflicted.push({
          key: id,
          name: id,
          currentHash,
          packHash: placeholderBaseHash,
        });
    } else {
      // 无任何基线 → 默认 updated（本波简化：这些分节基线机制未全铺，避免首装全冲突）
      plan.updated.push(packRow);
    }
  }

  return plan;
}

/**
 * 透传分节（catalog / namePools，`{ data: unknown }` 形状）的四态。
 *
 * 这些分节没有逐项键（data 是不透明对象/数组），本波只判「pack 声明了 → 整块替换」。
 * 与 absent 语义的区别：absent 分节不进 sections（别动），present 分节进 sections.data
 * 的 updated（执行器整块覆盖）。
 */
function planOpaqueSection<T>(packPayload: T): PackSectionPlan<T> {
  const plan: PackSectionPlan<T> = emptySectionPlan<T>();
  plan.updated.push(packPayload);
  return plan;
}

// ═══════════════════════════════════════════════════════════
// 存档 uid 迁移（D43 三段式）
// ═══════════════════════════════════════════════════════════

/**
 * 产存档 uid 迁移步骤（D43 三段式）。
 *
 * 占位书与真实书同分区不同 uid 空间（占位 uid ∈ 900001+ 保留段）→ 占位期建的存档
 * 在装包后核心分区会被静默滤成零条。三段式处置:
 *
 * 1. **保留段隔离**: 占位书 uid ∈ `[PLACEHOLDER_UID_RESERVED_BASE, ...)`，与真实语料
 *    uid 空间物理隔离（本函数据此识别存档里的占位 uid）。
 * 2. **按名配对**（D43 v1.2，工坊先例 `workshop-install-plan.ts`）: 对每个分区，把
 *    占位书条目名 ↔ pack 书条目名配对，产 `partition:oldUid → partition:newUid` 重写映射。
 * 3. **配不上的键分两类**:
 *    - **单选钉选分区**（system_core / character）失配 → 标记 `needsSelectionPartitions`
 *      （裸删 = 该分区「整本原样通过」= 内容通胀，D43）
 *    - **多选分区**失配 → 允许清除 + `WorkshopNote sideEffect`
 *
 * @param packBooks pack 的世界书分节（真实 uid 空间）
 * @param currentBooks 当前库里的世界书（含占位书，uid 在保留段）
 * @param enabledEntries 存档级 uid 允许清单（`"partition:uid"`）
 * @param notes 处置记录出口（sideEffect note 写进这里）
 */
export function planSaveUidMigration(
  packBooks: readonly WorldBook[],
  currentBooks: readonly WorldBook[],
  enabledEntries: readonly string[],
  notes: WorkshopNote[],
): PackSaveUidMigration {
  const rewrite: Record<string, number> = {};
  const needsSelectionSet = new Set<WorldBookPartition>();
  const sideEffectPartitions = new Set<string>();

  // pack 书按 partition → name → uid 索引（真实 uid 空间）
  const packByNameByPartition = new Map<string, Map<string, number>>();
  for (const book of packBooks) {
    let byName = packByNameByPartition.get(book.partition);
    if (!byName) {
      byName = new Map<string, number>();
      packByNameByPartition.set(book.partition, byName);
    }
    for (const entry of book.entries) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry.uid);
    }
  }

  // 当前占位书按 partition → name → uid 索引（占位 uid 空间，900001+）
  const placeholderByNameByPartition = new Map<string, Map<string, number>>();
  for (const book of currentBooks) {
    let byName = placeholderByNameByPartition.get(book.partition);
    if (!byName) {
      byName = new Map<string, number>();
      placeholderByNameByPartition.set(book.partition, byName);
    }
    for (const entry of book.entries) {
      if (entry.uid >= PLACEHOLDER_UID_RESERVED_BASE) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry.uid);
      }
    }
  }

  // 遍历存档里的 enabledEntries，逐条判定
  for (const entry of enabledEntries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx <= 0 || colonIdx >= entry.length - 1) continue;
    const partition = entry.slice(0, colonIdx) as WorldBookPartition;
    const oldUid = parseInt(entry.slice(colonIdx + 1), 10);
    if (!Number.isFinite(oldUid)) continue;

    // 只迁移占位保留段的 uid（真实 uid 空间不动）
    if (oldUid < PLACEHOLDER_UID_RESERVED_BASE) continue;

    // 查占位书里这条 uid 对应的条目名
    const placeholderByName = placeholderByNameByPartition.get(partition);
    if (!placeholderByName) {
      // 该分区没有占位书条目 → 无法按名配对
      handleUnmatchedPartition(partition, entry, notes, needsSelectionSet, sideEffectPartitions);
      continue;
    }
    let entryName: string | undefined;
    for (const [name, uid] of placeholderByName) {
      if (uid === oldUid) {
        entryName = name;
        break;
      }
    }
    if (entryName === undefined) {
      handleUnmatchedPartition(partition, entry, notes, needsSelectionSet, sideEffectPartitions);
      continue;
    }

    // 按名配对到 pack 书
    const packByName = packByNameByPartition.get(partition);
    const newUid = packByName?.get(entryName);
    if (newUid === undefined) {
      // 名字配不上（pack 没有这个条目名）
      handleUnmatchedPartition(partition, entry, notes, needsSelectionSet, sideEffectPartitions);
      continue;
    }

    // 配对成功 → 产 old→new 重写映射
    if (newUid !== oldUid) {
      rewrite[entry] = newUid;
    }
    // newUid === oldUid 时无需重写（理论上不会发生——占位与真实不同 uid 空间）
  }

  const needsSelectionPartitions = SINGLE_SELECT_PINNED_PARTITIONS.filter((p) =>
    needsSelectionSet.has(p),
  );

  return { rewrite, needsSelectionPartitions };
}

/**
 * 处理配不上的 enabledEntries 键（D43 第二类/第三类）。
 *
 * 单选钉选分区 → 标记 needs_selection（不许裸删）；
 * 多选分区 → 允许清除 + sideEffect note。
 */
function handleUnmatchedPartition(
  partition: WorldBookPartition,
  entry: string,
  notes: WorkshopNote[],
  needsSelectionSet: Set<WorldBookPartition>,
  sideEffectPartitions: Set<string>,
): void {
  if ((SINGLE_SELECT_PINNED_PARTITIONS as readonly string[]).includes(partition)) {
    needsSelectionSet.add(partition);
  } else {
    if (!sideEffectPartitions.has(partition)) {
      sideEffectPartitions.add(partition);
      notes.push({
        kind: 'sideEffect',
        text: `装包后存档的「${partition}」分区有条目（${entry}）无法按名配对到新内容，已从该存档的启用清单清除`,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 逐项基线（D18 hash 分工：冲突判定/对账的逐书基线一律从 payload 现算）
// ═══════════════════════════════════════════════════════════

/**
 * 从一份已装的 `ContentPack.payload` 现算 `PackBaseline`（D18）。
 *
 * 🔴 **hash 分工**：升级 diff 展示用 `payload.sectionHashes`（构建器盖章）；冲突判定 /
 *   卸载确认 / 对账用的**逐项基线**从这里现算（同一份 payload 现算，不信任 sectionHashes）。
 *   安装时执行器把上一次装包的 baseline 喂给 `planPackInstall`；卸载时喂给
 *   `planPackUninstall` 判「N 本已被你编辑过」。
 *
 * 输出覆盖三键（`byBook` / `byPreset` / `byBeautifierRule`），与 planner 四态规则的
 * 消费键一一对应。hash 算法与四态判定侧共用（worldBooks → `hashWorldBook` 同步确定性；
 * rows 用 `hashContentDeterministic` 接 `stableSerialize`）。
 *
 * @param payload 已装内容包的 payload
 */
export function buildPackBaseline(payload: ContentPack): PackBaseline {
  const byBook: Record<string, string> = {};
  for (const b of payload.worldBooks ?? []) byBook[b.id] = hashWorldBook(b);

  const byPreset: Record<string, string> = {};
  for (const p of payload.presets ?? [])
    byPreset[p.id] = hashContentDeterministic(
      JSON.stringify(stableSerialize({ id: p.id, name: p.name, settings: p.settings })),
    );

  const byBeautifierRule: Record<string, string> = {};
  for (const r of payload.beautifierRules?.rules ?? [])
    byBeautifierRule[r.id] = hashContentDeterministic(JSON.stringify(stableSerialize(r)));

  return { byBook, byPreset, byBeautifierRule };
}

// ═══════════════════════════════════════════════════════════
// 卸载计划（§5.2）
// ═══════════════════════════════════════════════════════════

/**
 * 卸载确认项 —— 用户编辑过的 pack 拥有书（卸载将丢弃这些编辑）。
 */
export interface PackUninstallConfirmation {
  /** pack 拥有的世界书 id */
  bookId: string;
  /** 该书的人类可读名 */
  bookName: string;
  /** 当前库里该书的正文 hash */
  currentHash: string;
  /** 上次装包时该书的基线 hash */
  packBaselineHash: string;
}

/**
 * 一次卸载的决策（§5.2 卸载流）。
 *
 * 卸载是**与安装同级的安全面**（v1.2 补齐，§5.2）:
 * - **预检**: 逐 pack 拥有书比对 payload 基线 → 「N 本已被你编辑过」确认清单
 *   （hash ≠ 基线 = 用户编辑过，卸载将丢弃）
 * - **执行序列**: 删 pack 拥有 id → upsert 占位书 → 存档迁移（反向: 真实 uid 消失 →
 *   按名配对回占位 / needs_selection）→ contentPacks.delete
 *
 * 本函数只产**计划**，不执行任何写入（D19 纯 planner + 哑执行器）。
 *
 * @param installedPack 已装的内容包（其 worldBooks 即 pack 拥有的 id 集）
 * @param currentLibrary 当前库状态（含世界书，用于逐本比对 hash）
 * @param packBaseline 上次装包的逐书基线 hash（用于判「编辑过」）
 */
export function planPackUninstall(
  installedPack: ContentPack,
  currentLibrary: CurrentLibrary = {},
  packBaseline: PackBaseline = {},
): PackUninstallPlan {
  const confirmations: PackUninstallConfirmation[] = [];
  const ownedIds = new Set<string>();

  const packBooks = installedPack.worldBooks ?? [];
  for (const book of packBooks) ownedIds.add(book.id);

  // 逐 pack 拥有书比对当前正文 hash vs 基线
  for (const book of packBooks) {
    const baseHash = packBaseline.byBook?.[book.id];
    if (baseHash === undefined) continue; // 无基线 → 无从判编辑，不谎报
    // 找当前库里这本书
    const current = (currentLibrary.worldBooks ?? []).find((b) => b.id === book.id);
    if (!current) continue; // 已不在库里 → 不需确认
    const currentHash = hashWorldBook(current);
    if (currentHash !== baseHash) {
      confirmations.push({
        bookId: book.id,
        bookName: book.name,
        currentHash,
        packBaselineHash: baseHash,
      });
    }
  }

  return {
    packId: installedPack.packId,
    ownedBookIds: [...ownedIds],
    confirmations,
  };
}

/** 卸载计划产物 */
export interface PackUninstallPlan {
  packId: string;
  /** pack 拥有的世界书 id 集（执行器删这些 id → upsert 占位书） */
  ownedBookIds: string[];
  /** 用户编辑过的 pack 拥有书确认清单（hash ≠ 基线） */
  confirmations: PackUninstallConfirmation[];
}

// ═══════════════════════════════════════════════════════════
// 升级 diff（D40）
// ═══════════════════════════════════════════════════════════

/**
 * 一项升级变化（D40）。
 *
 * `added` / `removed` / `updated` / `conflicted` 四态变化条目，每项含 id + 可读名。
 */
export interface PackUpgradeDiffItem {
  kind: 'added' | 'removed' | 'updated' | 'conflicted';
  key: string;
  name: string;
}

/** 一次升级的「这一版会改什么」（D40）—— 从两个已算好的安装计划派生。 */
export interface PackUpgradeDiff {
  worldBooks: PackUpgradeDiffItem[];
  presets: PackUpgradeDiffItem[];
}

/**
 * 从两个已算好的安装计划派生升级 diff（D40）。
 *
 * 🔴 输入是**已算好的计划**而非重拉详情（与工坊 `workshop-diff.ts` 同源）。
 * 比较 oldPlan 的最终态（added ∪ updated，即安装后库里有的）vs newPlan 的最终态:
 * - newPlan 有但 oldPlan 没有 → added
 * - oldPlan 有但 newPlan 没有 → removed
 * - 两边都有但 hash 状态不同 → updated（或 conflicted）
 *
 * 本波只覆盖 worldBooks 与 presets 两个主要分节（D40 完整覆盖是后续波次的活）。
 *
 * @param oldPlan 上次安装的计划
 * @param newPlan 这次安装的计划
 */
export function diffPackUpgrade(
  oldPlan: PackInstallPlan,
  newPlan: PackInstallPlan,
): PackUpgradeDiff {
  return {
    worldBooks: diffSection(
      oldPlan.sections.worldBooks,
      newPlan.sections.worldBooks,
      (b: WorldBook) => b.id,
      (b: WorldBook) => b.name,
    ),
    presets: diffSection(
      oldPlan.sections.presets,
      newPlan.sections.presets,
      (p: ChatPreset) => p.id,
      (p: ChatPreset) => p.name,
    ),
  };
}

/**
 * 单分节的升级 diff 派生（从两个 PackSectionPlan 派生 PackUpgradeDiffItem[]）。
 *
 * 「最终态」= added ∪ updated（安装后库里有的行）；conflicted 不进最终态（需用户确认，
 * 不算已落地）。oldPlan 的最终态 vs newPlan 的最终态:
 * - new 有 old 无 → added
 * - old 有 new 无 → removed
 * - 两边都有: new 标 conflicted → conflicted；否则 → updated
 */
function diffSection<T>(
  oldSection: PackSectionPlan<T> | undefined,
  newSection: PackSectionPlan<T> | undefined,
  getKey: (row: T) => string,
  getName: (row: T) => string,
): PackUpgradeDiffItem[] {
  const items: PackUpgradeDiffItem[] = [];
  if (!oldSection && !newSection) return items;

  const oldFinal = indexFinal(oldSection, getKey, getName);
  const newFinal = indexFinal(newSection, getKey, getName);

  for (const [key, name] of newFinal.entries()) {
    if (!oldFinal.has(key)) {
      items.push({ kind: 'added', key, name });
    } else {
      // 两边都有：new 标 conflicted → conflicted；否则 updated
      const newConflicted = newSection?.conflicted.some((c) => c.key === key) ?? false;
      items.push({ kind: newConflicted ? 'conflicted' : 'updated', key, name });
    }
  }
  for (const [key, name] of oldFinal.entries()) {
    if (!newFinal.has(key)) {
      items.push({ kind: 'removed', key, name });
    }
  }
  return items;
}

/**
 * 把一个 PackSectionPlan 的「最终态」（added ∪ updated）索引成 key → name 表。
 */
function indexFinal<T>(
  section: PackSectionPlan<T> | undefined,
  getKey: (row: T) => string,
  getName: (row: T) => string,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!section) return out;
  for (const row of section.added) out.set(getKey(row), getName(row));
  for (const row of section.updated) out.set(getKey(row), getName(row));
  return out;
}

// ═══════════════════════════════════════════════════════════
// hash 小工具（presets / rules / markers / locations / bloodlines 用）
// ═══════════════════════════════════════════════════════════

/** ChatPreset 整行 hash（排除运行时戳 createdAt/updatedAt） */
function hashPresetRow(p: ChatPreset): string {
  const stable = {
    id: p.id,
    name: p.name,
    description: p.description,
    settings: p.settings,
  };
  return hashContentDeterministic(JSON.stringify(stableSerialize(stable)));
}

/** BeautifierRule 整行 hash */
function hashRuleRow(r: BeautifierRule): string {
  return hashContentDeterministic(JSON.stringify(stableSerialize(r)));
}

/**
 * 把任意值序列化成**键稳定排序**的 JSON 友好形状（避免对象键顺序漂移导致 hash 不稳）。
 *
 * - 对象：键按字典序排序后递归
 * - 数组：保持顺序（数组顺序是语义的一部分），逐项递归
 * - 原始值：原样返回
 */
function stableSerialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSerialize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = stableSerialize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
