/**
 * workshop-install-plan.ts — 安装计划器（Phase 1 / P1-1）
 *
 * 为什么存在: 这是工坊子系统的**承重模块**，与 asset-import-plan.ts 同一个规矩 ——
 * 一次安装/更新的全部决策（发哪些 uid、条目怎么转、哪些丢弃、与已装内容冲不冲、
 * 哪些条目被用户改过）收在一个**纯同步函数**里，于是每一条规则都变成对普通数据的
 * 断言：没有 IndexedDB、没有 fetch、没有 Vue。store 拿到计划之后只做一件蠢事：
 * 照单写行。
 *
 * 三条不可动摇的规则:
 *
 * 1. **uid 必须在分区内重新发号（D8）**。`filterBooksByEnabledEntries()` 以
 *    **partition 为键**建 uid 允许表，而工坊是「多本书共用一个分区」的第一例；
 *    上游每个项目 uid 都从 0 起编（实测），照搬必然撞号，`creative_workshop:5`
 *    会同时命中所有工坊书里的 uid=5 —— 静默的内容错位。
 *
 * 2. **卸载不回收号段（D8）**。回收会让旧存档里残留的 `enabledWorldBookEntries`
 *    指向新项目的条目。浪费几个整数远比错启用一段陌生内容便宜。本模块的体现是：
 *    `nextUid` 只增不减，`retiredUids` 只是记录，绝不回填分配器。
 *
 * 3. **更新按名匹配（D15，铁律 1）**。新旧条目按 `name`（= 上游 `comment`）配对；
 *    存活条目 **uid 保持不变** → 存档的 `enabledWorldBookEntries` 无需重写。
 *    这正是「逻辑键 = 名字，uid 只是引擎内寻址句柄」的直接后果。
 *
 * 冲突判定用 `sourceHash`（D14/D15）: 安装时记下正文哈希，更新时比对当前正文。
 * 它的**唯一**用途是让警告精确（只在用户真编辑过时出现），而不是无条件恐吓。
 * 覆盖是覆盖式的 —— 不做逐条保留，只是覆盖前让 store 有机会弹窗。
 *
 * 纯度约束: 无 I/O、无 Dexie、无 Vue、无浏览器全局、无 `crypto`
 * （`crypto.subtle` 是异步的，会把整个计划器传染成 async —— 见 `hashWorkshopContent`）。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D7/D8/D14/D15/D16
 */

import type { WorldBookEntry } from './types';
import { mapWorkshopRegexes } from './workshop-regex-map';
import type {
  InstallConflict,
  InstallPlan,
  InstallRegistry,
  WorkshopInstallInput,
  WorkshopSourceEntry,
} from './workshop-types';
import { WORKSHOP_PARTITION, workshopBookId } from './workshop-types';

/**
 * 正文哈希 —— 只为「这段文本被人改过吗」这一个问题服务（D15）。
 *
 * **刻意不用 `crypto.subtle`**: 它是异步的，用它就得把 `planInstall` 改成 async，
 * 而「纯同步出计划」是这一层存在的全部理由（asset-import-plan.ts 为同一原因把
 * SHA-256 推到了上游）。这里也不需要密码学强度 —— 没有对手在构造碰撞，只有
 * 用户在编辑条目正文，任何一次真实编辑都会翻动大量比特。
 *
 * 实现是双种子 FNV-1a 32 位拼成 16 位十六进制（约 64 位空间）。
 */
export function hashWorkshopContent(content: string): string {
  let h1 = 0x811c9dc5; // FNV offset basis
  let h2 = 0x01000193; // 换一个起点，让两条链不同步
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((code << 5) | (code >>> 11)), 0x85ebca6b) >>> 0;
  }
  // 长度进哈希：截断/追加空白这类「同字符集」编辑也能被区分
  h2 = Math.imul(h2 ^ content.length, 0xc2b2ae35) >>> 0;
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * 项目内名字唯一化。
 *
 * 上游 `comment` 没有唯一性约束，实测虽未撞但没有任何东西拦着。名字是 D15 的
 * 配对键，重名会让两条上游条目抢同一个已装 uid —— 一条覆盖另一条，且更新时
 * 抖动。这里在**批内**去重，第二条起加 ` (2)` / ` (3)`，并记 note。
 */
function uniquifyNames(
  entries: WorkshopSourceEntry[],
  notes: string[],
): Array<{ entry: WorkshopSourceEntry; name: string }> {
  const used = new Set<string>();
  return entries.map((entry) => {
    let name = entry.name;
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${entry.name} (${suffix})`)) suffix++;
      name = `${entry.name} (${suffix})`;
      notes.push(`条目名「${entry.name}」在上游重复，本地重命名为「${name}」以保证按名匹配稳定`);
    }
    used.add(name);
    return { entry, name };
  });
}

/**
 * 出一次安装/更新的完整计划 —— **纯同步、无副作用**。
 *
 * @param payload 规范化后的载荷（`parsePayload` 的产物）+ 项目元数据
 * @param registry 分区级 uid 分配游标 + 本项目当前已装条目（首装省略 `existingEntries`）
 *
 * 首装与更新走的是同一条路径：`existingEntries` 为空时按名匹配自然全部落到
 * 「新增」分支。没有 `if (isInstall) ... else ...`，也就没有两条会各自腐烂的代码路径。
 */
export function planInstall(payload: WorkshopInstallInput, registry: InstallRegistry): InstallPlan {
  const { project } = payload;
  const droppedNotes: string[] = [];

  const existingEntries = registry.existingEntries ?? [];
  const isUpdate = existingEntries.length > 0;

  // 已装条目按名索引；上游重名已在 uniquifyNames 处理，本地重名（用户手改过名）
  // 取先到的那条，后到的等同「上游已移除」进 retired。
  const existingByName = new Map<string, WorldBookEntry>();
  for (const entry of existingEntries) {
    if (!existingByName.has(entry.name)) existingByName.set(entry.name, entry);
  }

  // 分配器游标必须是非负整数；上游传了脏值时从 0 起，而不是把 NaN 传染给每个 uid
  let nextUid = Number.isFinite(registry.nextUid) ? Math.max(0, Math.trunc(registry.nextUid)) : 0;
  const allocatedStart = nextUid;

  const conflicts: InstallConflict[] = [];
  const matchedNames = new Set<string>();
  const entries: WorldBookEntry[] = [];

  for (const { entry: source, name } of uniquifyNames(payload.worldbookEntries, droppedNotes)) {
    const existing = existingByName.get(name);
    let uid: number;

    if (existing) {
      // D15: 存活条目 uid 保持不变 → 存档的 enabledWorldBookEntries 无需重写
      uid = existing.uid;
      matchedNames.add(name);

      const recordedHash = existing.extra?.workshop?.sourceHash;
      if (recordedHash) {
        const currentHash = hashWorkshopContent(existing.content);
        if (currentHash !== recordedHash) {
          // 用户改过 → 仍然覆盖（更新就是覆盖），但让 store 有机会先弹警告
          conflicts.push({ uid, name, sourceHash: recordedHash, currentHash });
        }
      }
      // 没有 recordedHash 说明这条不是本流程装的（手工造的/更早版本装的）——
      // 无从判断是否被改过，不谎报冲突，静默覆盖。
    } else {
      uid = nextUid++;
    }

    entries.push({
      uid,
      name,
      content: source.content,
      enabled: source.enabled,
      key: source.key,
      keysecondary: source.keysecondary,
      selectiveLogic: source.selectiveLogic,
      order: source.order,
      position: source.position,
      extra: {
        workshop: {
          projectId: project.id,
          projectName: project.name,
          sourceUid: source.sourceUid,
          sourceComment: source.name,
          // 装进去的正文的哈希 —— 下次更新拿它判断用户改没改过
          sourceHash: hashWorkshopContent(source.content),
        },
      },
    });
  }

  // 上游移除的条目：uid 退休，**不回收**（D8）。存档里的残留引用惰性失效。
  const retiredUids = existingEntries
    .filter((entry) => !matchedNames.has(entry.name))
    .map((entry) => entry.uid);
  if (retiredUids.length > 0) {
    droppedNotes.push(
      `${retiredUids.length} 条已装条目在上游新版本中已移除，将被删除（uid ${retiredUids.join(', ')} 就此退休，不再复用）`,
    );
  }

  const regexResult = mapWorkshopRegexes(payload.regexEntries, {
    projectId: project.id,
    projectName: project.name,
  });
  droppedNotes.push(...regexResult.droppedNotes);

  const uids = entries.map((entry) => entry.uid);
  const uidRange =
    uids.length > 0
      ? { start: Math.min(...uids), end: Math.max(...uids) + 1 }
      : { start: nextUid, end: nextUid };

  return {
    projectId: project.id,
    projectName: project.name,
    bookId: workshopBookId(project.id),
    partition: WORKSHOP_PARTITION,
    entries,
    rules: regexResult.rules,
    uidRange,
    allocatedUidRange: { start: allocatedStart, end: nextUid },
    nextUid,
    retiredUids,
    conflicts,
    droppedNotes,
    isUpdate,
  };
}
