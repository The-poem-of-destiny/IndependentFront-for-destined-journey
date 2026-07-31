/**
 * workshop-store.ts — 创意工坊**执行器**（Phase 1 / P1-3）
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D7/D8/D13/D15/D16/D17
 *
 * 职责与 asset-store 逐字同构: 一次安装/更新的**全部决策**（发哪些 uid、条目怎么转、
 * 哪些丢弃、与已装内容冲不冲、哪些条目被用户改过）已经由 `planInstall()` 这个纯同步
 * 函数定完了；本模块只做那件蠢而明显的事 —— **照单写行**。于是这里没有任何自己的
 * 转换逻辑，取而代之的是五条纪律:
 *
 * 1. **落库一律走既有唯一入口**。世界书经 `worldbook-store`、美化规则经
 *    `beautifier-store`，本模块**只**直写 `workshopProjects` 一张自己的表。
 *    伸手进别人的表就是第二个写入口，Phase 0/0b 的验收会当场作废。
 *
 * 2. **uid 游标只增不减（D8）**。卸载**绝不**回收号段 —— 回收会让旧存档里残留的
 *    `enabledWorldBookEntries`（`"creative_workshop:5"` 格式）指向新项目的条目，
 *    是静默的内容错位。浪费几个整数远比错启用一段陌生内容便宜。
 *    游标持久化在 `settings.workshopUidCursor`（一个整数，与「书别写回 settings」
 *    的禁令无关），并在每次启动用 {@link cursorFloor} 抬到「**曾被任何存档引用过**
 *    的号之上」—— 三个来源: 在装项目的 `uidRange`、工坊分区各书的实际 uid、
 *    以及**所有存档的 `enabledWorldBookEntries`**。第三个来源是关键: 前两个只覆盖
 *    「当前装着的号」，而风险恰恰经由**已卸载**项目留在存档里的陈旧引用兑现
 *    （装 A 用 105 → 卸 A → 恢复不含 localStorage 的 FullBackup → 游标丢失 →
 *    B 拿到 105 → 老存档静默启用 B 的无关条目）。从存档取地板等于直接堵死那条路，
 *    且不需要新增存储、不需要动 FullBackup。
 *
 * 3. **丢弃必须 loud**。`WorkshopBundle.notes`（客户端侧处置，如「载荷缺失，取自
 *    详情预览」）与 `InstallPlan.droppedNotes`（计划侧处置）**并进同一个数组**落进
 *    `WorkshopProject.droppedNotes`。任何一侧被吞掉，UI 上的处置计数就会少报。
 *    ⚠️ loud 不等于**报错**：note 分 `dropped` / `degraded` / `sideEffect` 三类，
 *    只有 `dropped` 配叫「未导入」，后两类是**装上了**之后的表现。
 *
 * 4. **冲突不自作主张（D15）**。`plan.conflicts` 非空时 `install()` **不提交**，
 *    返回 `needs_confirmation` + 冲突清单；UI 弹警告拿到用户确认后再调
 *    {@link useWorkshopStore.confirmInstall}。两段式是本模块对外接口的形状，
 *    不是可选项。
 *
 * 5. **网络失败不抛穿（D17）**。`workshop-client` 已经把一切变成判别联合；本模块
 *    把失败翻译成 `installState: 'broken'`（仅当该项目已在库）+ `status: 'failed'`
 *    回执。一次上游抽风不该冒泡成未捕获的 Promise rejection。
 *
 * 两条来源，一条管线: 网络安装与本地 `project-{id}.json` 导入只在「JSON 从哪来」
 * 上不同，汇合于 {@link WorkshopPrepared} → `commitInstall`。第二条并行管线就是
 * 第二套 uid 分配与第二套冲突判定。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getDatabase } from '@engine/database';
import type { BeautifierRule, WorkshopProject } from '@engine/types';
import { parsePayload, parseProjectMeta } from '@engine/workshop-manifest';
import { planInstall } from '@engine/workshop-install-plan';
import {
  WORKSHOP_PARTITION,
  normalizeWorkshopNotes,
  workshopBookId,
  workshopRuleId,
} from '@engine/workshop-types';
import type {
  BeautifierRuleDraft,
  InstallConflict,
  InstallPlan,
  InstallRegistry,
  WorkshopInstallInput,
} from '@engine/workshop-types';
import { fetchInstallInput, fetchProject } from '../lib/workshop-client';
import type { WorkshopBundle, WorkshopFailure } from '../lib/workshop-client';
import { useBeautifierStore } from './beautifier-store';
import { useSettingsStore } from './settings-store';
import { useWorldBookStore } from './worldbook-store';

// ═══════════════════════════════════════════════════════════
// 常量与对外形状
// ═══════════════════════════════════════════════════════════

/**
 * 分区级 uid 分配游标在 `settings` 里的键名（D8）。
 *
 * 住在 settings 而非 Dexie，是因为它必须**比任何一行工坊数据活得久**: 卸载会删掉
 * 项目行与书行，而游标恰恰在那时最不能退。放进 `workshopProjects` 表就得为它造一行
 * 哨兵，那行会漏进列表、漏进 FullBackup、漏进每一次 `toArray()`。
 * 体积是一个整数，与「书别写回 settings」那条禁令（~0.85 MB）不是一回事。
 */
export const WORKSHOP_UID_CURSOR_KEY = 'workshopUidCursor';

/** 本地文件导入的溯源记录 —— 与上游版本无从校对，必须说出来 */
export const LOCAL_IMPORT_NOTE = '内容取自本地文件导入，未与上游校对版本';

/** 内容来自哪一侧（`WorkshopBundle.entriesSource` 加上本地文件这一支） */
export type WorkshopSourceKind = WorkshopBundle['entriesSource'] | 'local_file';

/**
 * 「算好了、还没写」的中间态 —— 两段式提交的载体。
 *
 * 保留 `input` 而非只保留 `plan`，是为了 `commitInstall` 能**重算**: prepare 与
 * commit 之间用户可能装了别的项目，游标已经走了；拿旧计划写行会发出重号。
 */
export interface WorkshopPrepared {
  projectId: string;
  /** 喂给 `planInstall()` 的原始输入（详情 + 载荷合成，或本地文件解析结果） */
  input: WorkshopInstallInput;
  /** prepare 时算出的计划 —— 供 UI 预览；提交时会以当时的游标重算 */
  plan: InstallPlan;
  /** 客户端侧处置记录（`WorkshopBundle.notes` / 本地导入溯源），必须并进 droppedNotes */
  sourceNotes: string[];
  entriesSource: WorkshopSourceKind;
}

/** 一次安装/更新的回执 */
export type WorkshopOutcome =
  | { status: 'installed'; project: WorkshopProject; plan: InstallPlan }
  /** D15: 有用户改过的条目将被覆盖 —— **尚未写任何一行**，等 UI 确认 */
  | { status: 'needs_confirmation'; prepared: WorkshopPrepared; conflicts: InstallConflict[] }
  | { status: 'failed'; error: WorkshopFailure };

/** prepare 阶段的判别联合（形状对齐 `WorkshopResult`，少一个 `fromCache`） */
export type WorkshopPrepareResult =
  | { ok: true; prepared: WorkshopPrepared }
  | { ok: false; error: WorkshopFailure };

/** `checkUpdate()` 回执 */
export type WorkshopUpdateCheck =
  | { ok: true; project: WorkshopProject; hasUpdate: boolean }
  | { ok: false; error: WorkshopFailure };

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return '未知错误';
}

/** 切断 Vue Proxy —— 否则 structured clone 抛 DataCloneError */
function detach<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ═══════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════

export const useWorkshopStore = defineStore('workshop', () => {
  /** 已装项目 —— Dexie `workshopProjects` 的响应式投影 */
  const projects = ref<WorkshopProject[]>([]);
  /** init() 是否已完成（含失败收场） */
  const ready = ref(false);

  let initPromise: Promise<void> | null = null;

  // ── 启动 ────────────────────────────────────────────────

  /**
   * 启动流程，幂等（并发调用共用同一个 Promise）。
   *
   * 先 `worldbook-store.init()` / `beautifier-store.init()` 再自己 hydrate:
   * 那两个 store 的 init 里跑着 localStorage → Dexie 的一次性迁移，而本 store 的
   * 游标兜底要读它们迁完之后的内容。顺序颠倒会让 floor 算在半迁移状态上。
   */
  async function init(): Promise<void> {
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  async function doInit(): Promise<void> {
    await useWorldBookStore().init();
    await useBeautifierStore().init();
    await hydrate();
    await refreshSavesFloor();
    // 灾难兜底：游标若落在「曾被引用过的号」之内（localStorage 被清 / 从不含它的
    // FullBackup 恢复），抬上去
    bumpCursor(cursorFloor());
    ready.value = true;
  }

  /** 从 Dexie 读全表填 ref */
  async function hydrate(): Promise<void> {
    try {
      projects.value = await getDatabase().workshopProjects.toArray();
    } catch {
      // IndexedDB 不可用 → 留空数组，工坊页显示「尚未安装」，不阻断其余功能
    }
  }

  // ── uid 分配游标（D8）─────────────────────────────────

  /** 读持久化游标；脏值一律当 0（由 floor 兜底，不把 NaN 传染给每个 uid） */
  function readCursor(): number {
    const raw: unknown = useSettingsStore().settings[WORKSHOP_UID_CURSOR_KEY];
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  }

  /** 游标**只增不减** —— 这是 D8 在代码里的唯一体现处，别加第二个写点 */
  function bumpCursor(value: number): void {
    if (!Number.isFinite(value)) return;
    const next = Math.trunc(value);
    if (next <= readCursor()) return;
    const settingsStore = useSettingsStore();
    settingsStore.settings[WORKSHOP_UID_CURSOR_KEY] = next;
    settingsStore.saveNow();
  }

  /**
   * 存档引用过的最大工坊 uid + 1 —— 异步算一次，缓存进 ref 供同步的
   * {@link cursorFloor} 取用（`nextUid` 是 computed，不能 await）。
   *
   * 只读 `saves` 表（≤10 行），不写。畸形条目一律跳过，绝不抛 ——
   * 一条脏数据不该让整个工坊装不上东西。
   */
  const savesUidFloor = ref(0);

  async function refreshSavesFloor(): Promise<number> {
    const prefix = `${WORKSHOP_PARTITION}:`;
    let floor = 0;
    try {
      for (const save of await getDatabase().saves.toArray()) {
        const refs = save?.metadata?.enabledWorldBookEntries;
        if (!Array.isArray(refs)) continue;
        for (const token of refs) {
          if (typeof token !== 'string' || !token.startsWith(prefix)) continue;
          const uid = Number(token.slice(prefix.length));
          // `creative_workshop:abc` / `creative_workshop:` → NaN，跳过
          if (!Number.isFinite(uid)) continue;
          floor = Math.max(floor, Math.trunc(uid) + 1);
        }
      }
    } catch {
      // IndexedDB 不可用 → 保持上次的值，不把地板降下去
      return savesUidFloor.value;
    }
    // 地板同样只增不减：本次没读到不代表以前没引用过
    savesUidFloor.value = Math.max(savesUidFloor.value, floor);
    return savesUidFloor.value;
  }

  /**
   * 「曾被引用过的号之上」的下界 —— 仅在持久化游标丢失时才起作用。
   *
   * 三个来源（见文件头纪律 2）: 项目行记的 `uidRange.end`、工坊分区里各书条目的
   * 实际 uid、以及**存档引用过的 uid**。前两个只覆盖「当前装着的」，第三个覆盖
   * 「卸载后仍被老存档引用着的」—— 少了它，D8 要防的静默内容错位仍有一条窄路可走。
   */
  function cursorFloor(): number {
    let floor = savesUidFloor.value;
    for (const project of projects.value) {
      const end = project.uidRange?.end;
      if (typeof end === 'number' && Number.isFinite(end)) floor = Math.max(floor, Math.trunc(end));
    }
    for (const book of useWorldBookStore().books) {
      if (book.partition !== WORKSHOP_PARTITION) continue;
      for (const entry of book.entries) {
        if (Number.isFinite(entry.uid)) floor = Math.max(floor, Math.trunc(entry.uid) + 1);
      }
    }
    return floor;
  }

  /** 下一个可发的 uid（分区级共享） */
  const nextUid = computed(() => Math.max(readCursor(), cursorFloor()));

  /** 组装 `planInstall` 的第二参数：当前游标 + 本项目已装条目（按名匹配用，D15） */
  function buildRegistry(projectId: string): InstallRegistry {
    const book = useWorldBookStore().getBook(workshopBookId(projectId));
    return { nextUid: nextUid.value, existingEntries: book?.entries ?? [] };
  }

  // ── 读 ──────────────────────────────────────────────────

  function getProject(projectId: string): WorkshopProject | undefined {
    return projects.value.find((p) => p.id === projectId);
  }

  function isInstalled(projectId: string): boolean {
    return getProject(projectId) !== undefined;
  }

  // ── 计划（不写任何一行）────────────────────────────────

  /** 走网络取详情 + 载荷，出计划。失败时把已装项目置 `broken`，**不抛** */
  async function prepareInstall(
    projectId: string,
    opts: { force?: boolean } = {},
  ): Promise<WorkshopPrepareResult> {
    const res = await fetchInstallInput(projectId, opts);
    if (!res.ok) {
      await markBroken(projectId);
      return { ok: false, error: res.error };
    }
    const bundle = res.data;
    return { ok: true, prepared: toPrepared(bundle.input, bundle.notes, bundle.entriesSource) };
  }

  /**
   * 吃用户下载的 `project-{id}.json`，出计划 —— **不走网络**，其余与网络路径同一条管线。
   *
   * `parseProjectMeta` 会自动下钻 `.project`，`parsePayload` 吃得下裸数组 /
   * `{ entries }` / `{ worldbookEntriesPreview, regexEntriesPreview }` 三种外层形状，
   * 所以这里不需要认识文件长什么样。
   */
  function prepareInstallFromFile(raw: unknown): WorkshopPrepareResult {
    const project = parseProjectMeta(raw);
    if (!project) {
      return { ok: false, error: { kind: 'malformed', message: '文件里没有项目 id', url: '' } };
    }
    const payload = parsePayload(raw);
    if (payload.worldbookEntries.length === 0 && payload.regexEntries.length === 0) {
      return {
        ok: false,
        error: { kind: 'no_source', message: '文件里既没有世界书条目也没有正则', url: '' },
      };
    }
    return {
      ok: true,
      prepared: toPrepared({ project, ...payload }, [LOCAL_IMPORT_NOTE], 'local_file'),
    };
  }

  function toPrepared(
    input: WorkshopInstallInput,
    sourceNotes: string[],
    entriesSource: WorkshopSourceKind,
  ): WorkshopPrepared {
    return {
      projectId: input.project.id,
      input,
      sourceNotes,
      entriesSource,
      plan: planInstall(input, buildRegistry(input.project.id)),
    };
  }

  // ── 提交（照单写行）────────────────────────────────────

  /**
   * 把计划写进三处。**唯一**的写入路径 —— 安装、更新、本地导入都走它。
   *
   * 顺序刻意如此:
   * 1. **游标先走**。多发几个号是无害的浪费；重发号是数据损坏。中途失败宁可留下
   *    一段没人用的空洞。
   * 2. 世界书（经 worldbook-store）
   * 3. 美化规则（经 beautifier-store；先删本项目上游已移除的，再整批覆盖）
   * 4. 项目行 —— 最后写，它是「装成了」的证据
   */
  async function commitInstall(
    prepared: WorkshopPrepared,
  ): Promise<{ project: WorkshopProject; plan: InstallPlan }> {
    // 以**当下**的游标重算：prepare 之后可能已经有别的项目领过号；
    // 存档地板也重扫一次（会话中途可能新建了存档 / 改了启用轴）
    await refreshSavesFloor();
    const plan = planInstall(prepared.input, buildRegistry(prepared.projectId));
    const meta = prepared.input.project;
    const now = Date.now();

    bumpCursor(plan.nextUid);

    await useWorldBookStore().upsertBook({
      id: plan.bookId,
      name: meta.name,
      partition: plan.partition,
      description: meta.description,
      entries: plan.entries,
      builtIn: false,
    });

    await replaceProjectRules(meta.id, plan.rules);

    const previous = getProject(meta.id);
    const row: WorkshopProject = {
      id: meta.id,
      rootProjectId: meta.rootProjectId,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      authorName: meta.authorName,
      tags: [...meta.tags],
      coverUrl: meta.coverUrl,
      downloadUrl: meta.downloadUrl,
      fileSize: meta.fileSize,
      installState: 'installed',
      installedVersion: meta.version,
      // 重装/更新不重置「第一次装进来是什么时候」
      installedAt: previous?.installedAt ?? now,
      fetchedAt: now,
      uidRange: plan.uidRange,
      // ★ 两侧处置记录并进同一个数组 —— 少任何一侧，UI 的处置计数就少报。
      //   `sourceNotes` 是裸串（客户端侧溯源，如「取自详情预览」），经 normalize
      //   落成 kind: 'dropped'；plan 侧本就带 kind。新写入一律结构化，老行仍是
      //   裸串，读侧统一过 normalizeWorkshopNotes 兼容。
      droppedNotes: normalizeWorkshopNotes([...prepared.sourceNotes, ...plan.droppedNotes]),
      updatedAt: now,
    };
    await putProject(row);

    return { project: row, plan };
  }

  /**
   * 本项目的美化规则整体替换。
   *
   * 先删后写而不是只写: 上游新版本删掉的正则若不删，会永远留在美化库里，
   * 而它的 `autoEnable` 仍绑着这本书 —— 一条卸不掉也找不到出处的规则。
   *
   * 传空数组即「删光本项目规则」，卸载走的就是这一支。
   */
  async function replaceProjectRules(
    projectId: string,
    rules: BeautifierRuleDraft[],
  ): Promise<void> {
    const beautifier = useBeautifierStore();
    const prefix = workshopRuleId(projectId, '');
    const keep = new Set(rules.map((r) => r.id));
    const stale = beautifier.userRules.filter((r) => r.id.startsWith(prefix) && !keep.has(r.id));
    for (const rule of stale) {
      await beautifier.deleteRule(rule.id);
    }
    // BeautifierRuleDraft = Omit<BeautifierRule, 'locked'>，locked 是运行时计算字段
    await beautifier.upsertRules(rules as BeautifierRule[]);
  }

  async function putProject(row: WorkshopProject): Promise<void> {
    const clean = detach(row);
    await getDatabase().workshopProjects.put(clean);
    const idx = projects.value.findIndex((p) => p.id === clean.id);
    if (idx >= 0) projects.value[idx] = clean;
    else projects.value.push(clean);
  }

  /** 上游取不到时的收场（D17）：已装项目标 `broken`；没装过则什么都不做 */
  async function markBroken(projectId: string): Promise<void> {
    const previous = getProject(projectId);
    if (!previous || previous.installState === 'broken') return;
    await putProject({ ...previous, installState: 'broken', updatedAt: Date.now() });
  }

  // ── 对外动作 ────────────────────────────────────────────

  /**
   * 安装或更新（走网络）。
   *
   * 有冲突且未 `force` 时**不写任何一行**，返回 `needs_confirmation`；
   * UI 弹警告后调 {@link confirmInstall} 提交同一个 `prepared`。
   */
  async function install(
    projectId: string,
    opts: { force?: boolean; refresh?: boolean } = {},
  ): Promise<WorkshopOutcome> {
    const prep = await prepareInstall(projectId, { force: opts.refresh === true });
    if (!prep.ok) return { status: 'failed', error: prep.error };
    return settle(prep.prepared, opts.force === true);
  }

  /** 本地文件导入。与 {@link install} 同语义，只是内容来自文件 */
  async function installFromFile(
    raw: unknown,
    opts: { force?: boolean } = {},
  ): Promise<WorkshopOutcome> {
    const prep = prepareInstallFromFile(raw);
    if (!prep.ok) return { status: 'failed', error: prep.error };
    return settle(prep.prepared, opts.force === true);
  }

  /** 用户在覆盖警告上点了确认（D15）—— 无条件提交 */
  async function confirmInstall(prepared: WorkshopPrepared): Promise<WorkshopOutcome> {
    return settle(prepared, true);
  }

  async function settle(prepared: WorkshopPrepared, force: boolean): Promise<WorkshopOutcome> {
    if (!force && prepared.plan.conflicts.length > 0) {
      return { status: 'needs_confirmation', prepared, conflicts: prepared.plan.conflicts };
    }
    try {
      const { project, plan } = await commitInstall(prepared);
      return { status: 'installed', project, plan };
    } catch (err) {
      // 落库炸了（配额 / IndexedDB 不可用）—— 同样不抛穿
      return {
        status: 'failed',
        error: { kind: 'malformed', message: `安装写入失败：${describeError(err)}`, url: '' },
      };
    }
  }

  /**
   * 卸载：删书 + 删规则 + 删项目行。
   *
   * 🔴 **绝不回收 uid 号段（D8）** —— 本函数一个字节都不碰游标。回收会让旧存档的
   * `enabledWorldBookEntries` 指向下一个项目的条目，是静默的内容错位。
   */
  async function uninstall(projectId: string): Promise<boolean> {
    if (!isInstalled(projectId) && !useWorldBookStore().getBook(workshopBookId(projectId))) {
      return false;
    }
    await useWorldBookStore().deleteBook(workshopBookId(projectId));
    await replaceProjectRules(projectId, []);
    await getDatabase().workshopProjects.delete(projectId);
    projects.value = projects.value.filter((p) => p.id !== projectId);
    return true;
  }

  /**
   * 拉一次上游元数据，刷新版本对比与 `fetchedAt`（不下载载荷、不写内容）。
   *
   * 版本只做**串比对**不解析（D13）—— 上游 version 是自由填的字符串。
   */
  async function checkUpdate(
    projectId: string,
    opts: { force?: boolean } = {},
  ): Promise<WorkshopUpdateCheck> {
    const previous = getProject(projectId);
    if (!previous) {
      return { ok: false, error: { kind: 'malformed', message: '该项目尚未安装', url: '' } };
    }
    const res = await fetchProject(projectId, opts);
    if (!res.ok) {
      await markBroken(projectId);
      return { ok: false, error: res.error };
    }
    const meta = res.data.project;
    const hasUpdate = meta.version !== previous.installedVersion;
    const row: WorkshopProject = {
      ...previous,
      // 上游侧字段跟随刷新；本地状态（installedVersion / uidRange / installedAt）不动
      name: meta.name,
      description: meta.description,
      version: meta.version,
      authorName: meta.authorName,
      tags: [...meta.tags],
      coverUrl: meta.coverUrl,
      downloadUrl: meta.downloadUrl,
      fileSize: meta.fileSize,
      installState: hasUpdate ? 'update_available' : 'installed',
      fetchedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await putProject(row);
    return { ok: true, project: row, hasUpdate };
  }

  return {
    projects,
    ready,
    nextUid,
    init,
    hydrate,
    getProject,
    isInstalled,
    prepareInstall,
    prepareInstallFromFile,
    commitInstall,
    install,
    installFromFile,
    confirmInstall,
    uninstall,
    checkUpdate,
  };
});
