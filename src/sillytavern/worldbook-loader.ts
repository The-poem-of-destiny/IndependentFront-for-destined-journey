/**
 * 世界书加载引擎 (Phase 8)
 *
 * 职责:
 * - 从 data/worldbooks/ 加载世界书 JSON 文件
 * - 按 AgentConfig.worldBookIds 过滤 Agent 可见的世界书
 * - constant/keyword 双层激活
 * - 按 order 排序 + 格式化输出
 */

import type { WorldBook, WorldBookEntry, AgentConfig } from './types';
import {
  compileEjsEntry,
  executeEjsEntry,
  type CompiledEjsEntry,
  type EjsEvalContext,
} from './ejs-runtime';
import {
  clearEjsBackendCache,
  getCompiledEntry,
  getEjsBackend,
  LegacyBackend,
  type EjsPassEntry,
} from './ejs-backend';

// ========== 加载 ==========

/** 所有可用的世界书文件路径 */
const WORLD_BOOK_FILES: Record<string, string> = {
  world_setting: 'world_setting.json',
  race: 'race.json',
  faction: 'faction.json',
  character: 'character.json',
  event: 'event.json',
  adventure_area: 'adventure_area.json',
  monster_ecology: 'monster_ecology.json',
  industry: 'industry.json',
  organization: 'organization.json',
  system_core: 'system_core.json',
  variable: 'variable.json',
  quick_feature: 'quick_feature.json',
  extra_setting: 'extra_setting.json',
  cot: 'cot.json',
  dlc: 'dlc.json',
};

/**
 * 从 data/worldbooks/ 加载指定 ID 的世界书
 * 使用动态 import 兼容 Vite 打包
 */
export async function loadWorldBooks(ids: string[]): Promise<WorldBook[]> {
  const books: WorldBook[] = [];
  for (const id of ids) {
    const filename = WORLD_BOOK_FILES[id];
    if (!filename) continue;
    try {
      // Vite 环境下用 fetch 从 public 或 data 目录加载
      // 注：data/worldbooks/ 在构建时需要配置为静态资源
      const url = `/data/worldbooks/${filename}`;
      const response = await fetch(url);
      if (!response.ok) continue;
      const book = (await response.json()) as WorldBook;
      books.push(book);
    } catch {
      // 文件不存在或加载失败，跳过
    }
  }
  return books;
}

/** 同步版：从预加载的对象加载（Vite import.meta.glob） */
export function loadWorldBooksSync(
  ids: string[],
  preloaded: Record<string, WorldBook>,
): WorldBook[] {
  return ids.filter((id) => preloaded[id]).map((id) => preloaded[id]);
}

// ========== 过滤 ==========

/**
 * 获取指定 Agent 可见的世界书条目
 * @param agentId Agent ID
 * @param configs 所有 Agent 配置
 * @param books 已加载的世界书列表
 */
export function getEntriesForAgent(
  agentId: string,
  configs: AgentConfig[],
  books: WorldBook[],
): WorldBookEntry[] {
  const config = configs.find((c) => c.agentId === agentId);
  if (!config || !config.worldBookIds?.length) return [];

  const allowedIds = new Set(config.worldBookIds);
  const entries: WorldBookEntry[] = [];

  for (const book of books) {
    if (!allowedIds.has(book.id)) continue;
    for (const entry of book.entries) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * 过滤应激活的条目。
 *
 * 简化语义（2026-07-22）：废弃 ST 的 constant/keyword 双维度激活——
 * enabled=true 即注入，enabled=false 一律不注入，对所有 agent 一致。
 * 原因：内置世界书全量 constant=true（keyword 从未实际参与判定），
 * 且 enabled 开关本就该是"是否注入"的唯一主宰；旧逻辑里 constant 绕过 enabled，
 * 导致用户在 UI 禁用条目完全不生效。
 */
export function filterActiveEntries(entries: WorldBookEntry[]): WorldBookEntry[] {
  return entries.filter((entry) => entry.enabled);
}

// ========== 关键词匹配 ==========

/**
 * 检查条目的关键词是否匹配文本
 * 支持 ST 格式: 普通字符串 + 正则 (/pattern/flags)
 */
export function matchKeyword(
  entry: { key: string[]; keysecondary: string[]; selectiveLogic: number },
  text: string,
): boolean {
  const { key, keysecondary, selectiveLogic } = entry;

  if (key.length === 0) return false;

  const primaryMatches = key.map((k) => matchSingleKeyword(text, k));
  const anyPrimary = primaryMatches.some(Boolean);

  // 如果没有辅助关键词，主关键词任意命中即激活
  if (keysecondary.length === 0) return anyPrimary;

  const secondaryMatches = keysecondary.map((k) => matchSingleKeyword(text, k));
  const allSecondary = secondaryMatches.every(Boolean);
  const anySecondary = secondaryMatches.some(Boolean);

  switch (selectiveLogic) {
    case 0: // AND_ANY: primary AND any secondary
      return anyPrimary && anySecondary;
    case 1: // NOT_ALL: primary AND NOT all secondary
      return anyPrimary && !allSecondary;
    case 2: // NOT_ANY: primary AND NOT any secondary
      return anyPrimary && !anySecondary;
    case 3: // AND_ALL: primary AND all secondary
      return anyPrimary && allSecondary;
    default:
      return anyPrimary;
  }
}

/**
 * 单关键词匹配
 * 支持正则格式: /pattern/flags
 */
function matchSingleKeyword(text: string, keyword: string): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;

  // 正则格式: /pattern/flags
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    try {
      const lastSlash = trimmed.lastIndexOf('/');
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      return new RegExp(pattern, flags).test(text);
    } catch {
      return false;
    }
  }

  // 普通字符串匹配（大小写不敏感）
  return text.toLowerCase().includes(trimmed.toLowerCase());
}

// ========== 格式化 ==========

/**
 * 按存档级 enabledWorldBookEntries 精确过滤世界书条目。
 *
 * 规则:
 * - `enabledEntries` 格式: `"partition:uid"`（如 `"system_core:413"`）
 * - partition 在 enabledEntries 中有记录的 → 只保留 uid 命中条目，其余移除
 * - 内置 system_core/character 的命中条目 → 存档选择覆盖出厂 enabled=false
 * - partition 不在 enabledEntries 中的 → 整本原样通过（走 keyword 激活）
 * - enabledEntries 为空 → 所有书原样通过
 * - 非原始 entry（缺少 `:` 或无有效 uid）→ 静默跳过
 *
 * 纯函数，不修改入参。
 */
export function filterBooksByEnabledEntries(
  books: WorldBook[],
  enabledEntries: string[],
): WorldBook[] {
  if (!enabledEntries || enabledEntries.length === 0) return books;

  // Build lookup: partition → Set<uid>
  const enabledByPartition = new Map<string, Set<number>>();
  for (const entry of enabledEntries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx <= 0 || colonIdx >= entry.length - 1) continue;
    const partition = entry.slice(0, colonIdx);
    const uid = parseInt(entry.slice(colonIdx + 1), 10);
    if (isNaN(uid)) continue;
    let set = enabledByPartition.get(partition);
    if (!set) {
      set = new Set<number>();
      enabledByPartition.set(partition, set);
    }
    set.add(uid);
  }

  // If no valid entries could be parsed, the user intended filtering but
  // nothing matched → apply the filter (which will remove all entries for
  // partitions that appear in enabledEntries). If enabledEntries was non-empty
  // but none had valid partition:uid form, we can't tell which partition was
  // meant, so we pass books through unchanged.
  // For safety: always apply when we have valid parsed data.
  if (enabledByPartition.size === 0) return books;

  return books.map((book) => {
    const allowedUids = enabledByPartition.get(book.partition);
    if (!allowedUids) return book; // partition 未在存档中收录 → 整本原样通过
    const isBuiltInSaveSelection =
      book.builtIn === true && (book.partition === 'system_core' || book.partition === 'character');
    return {
      ...book,
      entries: book.entries
        .filter((e) => allowedUids.has(e.uid))
        // 内置命定核心/角色的 enabled=false 是“默认不全局注入”，不是否定本存档的明确选择。
        // 选择只存在 SaveSlot，不能反写全局世界书；在这个存档级边界克隆为启用态。
        .map((e) => (isBuiltInSaveSelection ? { ...e, enabled: true } : e)),
    };
  });
}

// ========== 格式化 ==========

/**
 * 按 order 排序 → 拼接 content
 */
export function formatWorldBookEntries(entries: WorldBookEntry[]): string {
  if (entries.length === 0) return '';

  const sorted = [...entries].sort((a, b) => a.order - b.order);

  return sorted.map((entry) => entry.content).join('\n\n');
}

// ========== 静/动分层 + EJS 求值（工坊 Phase 2 / ADR-30 D7-D9）==========

/**
 * 条目是否「动态」——含任一会随回合漂移的语法特征（设计 D7 三根针）。
 *
 * - `<%`：EJS 本体，求值结果随 stats/vars 变化
 * - `{{random`：`resolveRandoms` 每次装配重掷
 * - `{{getvar`：取值可能来自动态区 setvar / EJS 产出，字节随之漂移
 *
 * 判定按**语法**不按求值结果（某块「恰好每回合输出相同」也算动态）：
 * 简单、可预测、零误判成本。`{{setvar}}` 定义本身无害（确定性剥离），刻意不扫。
 */
export function hasDynamic(content: string): boolean {
  return /<%|\{\{random|\{\{getvar/.test(content ?? '');
}

/** `renderWorldBookEntries` 的产物 */
export interface WorldBookRenderResult {
  /** 静态区：无动态特征的条目按 order 拼接——**可证明地**逐字节稳定，最大化 prompt cache 前缀 */
  staticText: string;
  /** 动态区：含动态特征的条目按 order 拼接（EJS 已求值 / 失败者原文） */
  dynamicText: string;
  /** 编译或执行失败、已回退原文注入的条目（设计 D8） */
  fallbackEntries: Array<{ uid: number; error: string }>;
}

// 🪦 Q-10：本模块曾自带一份 `ejsCompileCache` / `getCompiled` / `clearEjsCompileCache`，
//    与 `ejs-backend` 的 `getCompiledEntry` **函数体逐行相同**，只是变量名不同。
//    两份缓存键都是条目正文原文，缓存内容也一模一样，却各自占一份内存、各自被清空。
//    现在统一用 ejs-backend 那份（它同时服务 LegacyBackend.runPass）。

/** 取（或建）编译产物；语法错误也缓存，避免每回合重炸一遍（设计 D9） */
const getCompiled = getCompiledEntry;

/** 清空编译缓存（测试/性能计时用；生产路径无需调用）。转发到唯一实现 */
export function clearEjsCompileCache(): void {
  clearEjsBackendCache();
}

/**
 * 激活条目 → 静/动两区文本（设计 D7 缓存分层 + D2 整片编译 + D8 条目级回退）。
 *
 * 流程：
 * 1. 全部条目按 `order` 稳定排序（同 order 保持入参顺序）
 * 2. `hasDynamic` 一分为二；两区**内部各自保序**，EJS 条目相对顺序不变 →
 *    pass 内 `vars` 草稿的写→读链不受分层影响
 * 3. 动态区里**只有含 `<%` 的条目才求值**；只含 `{{random}}`/`{{getvar}}` 的
 *    交给下游宏剥离（`resolveRandoms`/`resolveGetvars`），此处原文透传
 * 4. 编译抛错 / 执行 `ok:false` → **原文注入** + 记入 `fallbackEntries`（回退 = 今天的现状，
 *    最坏情况等于不上线；失败条目对 `ejsCtx.vars` 的半途写入由运行时整体回滚）
 *
 * @param entries 已激活（`filterActiveEntries` 之后）的条目
 * @param ejsCtx 求值上下文；`ejsCtx.vars` 会被就地修改（草稿按序可见）
 */
/** 动态区的一格：`needsEval` 为 false 表示只含宏、不进 EJS（原文透传给下游宏剥离） */
interface DynamicSlot {
  uid: number;
  content: string;
  needsEval: boolean;
}

/**
 * 静/动分区（D7）—— **同步与异步两条渲染路径共用**。
 *
 * 曾经两边各抄一份：排序、`hasDynamic` 判定、`includes('<%')` 判定、静态区拼接。
 * 分区规则是缓存前缀稳定性的地基，一旦两条路径判定漂移，同一批条目在同步/异步下
 * 会落进不同分区 —— 那是**静默**的缓存击穿，没有任何报错。故只留一份。
 */
function partitionEntries(entries: WorldBookEntry[]): {
  staticParts: string[];
  slots: DynamicSlot[];
} {
  const staticParts: string[] = [];
  const slots: DynamicSlot[] = [];
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const content = entry.content ?? '';
    if (!hasDynamic(content)) {
      staticParts.push(content);
      continue;
    }
    slots.push({ uid: entry.uid, content, needsEval: content.includes('<%') });
  }
  return { staticParts, slots };
}

/** 结果组装 —— 两条路径共用（段间分隔符是提示词字节的一部分，必须同口径） */
function assembleResult(
  staticParts: string[],
  dynamicParts: string[],
  fallbackEntries: Array<{ uid: number; error: string }>,
): WorldBookRenderResult {
  return {
    staticText: staticParts.join('\n\n'),
    dynamicText: dynamicParts.join('\n\n'),
    fallbackEntries,
  };
}

export function renderWorldBookEntries(
  entries: WorldBookEntry[],
  ejsCtx: EjsEvalContext,
): WorldBookRenderResult {
  const { staticParts, slots } = partitionEntries(entries);
  const dynamicParts: string[] = [];
  const fallbackEntries: Array<{ uid: number; error: string }> = [];

  // 🔴 同步路径的 fail-closed 闸门（2026-08-01 修 F3）
  //
  // 本函数的求值走 `compileEjsEntry`/`executeEjsEntry` —— **宿主 realm 的 `new Function`**：
  // 没有中断、没有执行预算、`Object.constructor("return globalThis")()` 能拿回真全局（SEC-02）。
  // 生产一旦通过 `installProductionEjsBackend()` 切到隔离/停用后端，这条同步路必须**跟着停**，
  // 否则任何还在调同步装配的入口（历史上就有：捏人页大纲）都会绕开隔离，
  // 而应用对外仍报告「已隔离」——那比没有隔离更糟。
  //
  // 判据取**当前后端身份**而非调用方：只有后端本身就是 `LegacyBackend`（测试默认值，
  // 本就没有边界可破）时才允许宿主求值；QuickJS / fail-closed 一律按 D8 原文注入并记回退。
  // 生产装配请走 `buildAgentMessagesAsync` —— 它预渲染出 memo，`{{LORE_BOOK}}` 只挑段不求值，
  // 根本不会落到这里。
  const backendName = getEjsBackend().name;
  const hostEvalAllowed = getEjsBackend() instanceof LegacyBackend;

  for (const slot of slots) {
    const content = slot.content;
    const entry = { uid: slot.uid };

    if (!slot.needsEval) {
      dynamicParts.push(content);
      continue;
    }

    if (!hostEvalAllowed) {
      const error = `EJS 未求值（同步路径不在宿主 realm 求值；当前后端 ${backendName}）`;
      dynamicParts.push(content);
      fallbackEntries.push({ uid: entry.uid, error });
      continue;
    }

    const compiled = getCompiled(content);
    if (!compiled.ok) {
      dynamicParts.push(content);
      fallbackEntries.push({ uid: entry.uid, error: compiled.error });
      console.warn(`[worldbook] EJS 编译失败，回退原文注入 uid=${entry.uid}: ${compiled.error}`);
      continue;
    }

    const executed = executeEjsEntry(compiled.compiled, ejsCtx);
    if (executed.ok) {
      dynamicParts.push(executed.rendered);
    } else {
      dynamicParts.push(content);
      fallbackEntries.push({ uid: entry.uid, error: executed.error });
      console.warn(`[worldbook] EJS 执行失败，回退原文注入 uid=${entry.uid}: ${executed.error}`);
    }
  }

  return assembleResult(staticParts, dynamicParts, fallbackEntries);
}

/**
 * 异步预渲染 —— **生产装配路径用这个**（能力面设计 §11 切片 T1）。
 *
 * 与同步版 `renderWorldBookEntries` 的差别只有两点，其余（静动分层、保序、D8 回退）完全一致：
 *
 * 1. 走 `EjsBackend.runPass` → 能跑 `await getwi(...)` 这类 **async 条目**（同步版对它们直接回退），
 *    也是将来切 QuickJS 的唯一接缝。
 * 2. 整个 pass 一次交给后端（不是逐条目来回），保住「前条目写→后条目立即可见」的同时，
 *    把跨边界编组从 N 次压到 1 次。
 *
 * 调用方拿到结果后应缓存进 `ctx.ejsPass.loreRender`，让**同步的** `{{LORE_BOOK}}` resolver
 * 只挑段不求值 —— 这样 `PlaceholderResolver` / `resolveTemplate` 的签名一个字都不用改。
 */
export async function prerenderWorldBookEntries(
  entries: WorldBookEntry[],
  ejsCtx: EjsEvalContext,
): Promise<WorldBookRenderResult> {
  // 分区与同步版共用（见 partitionEntries）；本函数只多一件事：动态区整批交给后端
  const { staticParts, slots: dynamicSlots } = partitionEntries(entries);
  const fallbackEntries: Array<{ uid: number; error: string }> = [];

  const toEval: EjsPassEntry[] = dynamicSlots
    .filter((s) => s.needsEval)
    .map((s) => ({ uid: s.uid, content: s.content }));

  const backend = getEjsBackend();
  const outcomes = toEval.length > 0 ? await backend.runPass(toEval, ejsCtx) : [];

  // 🔴 按**下标**回填，绝不按 uid 建 Map（2026-08-01 修 F4）
  //
  // uid 只在单本书内唯一：内置书是 1–509，而 ST 导出的用户书 entries 是每本各自 0..N-1，
  // 设置页导入时又用 `uid || Date.now()` 补号 —— 跨书撞号是常态而非意外。
  // 一旦按 uid 建 Map，撞号的两条里会有一条的渲染结果被注入两次、另一条被静默吞掉，
  // 且**没有任何报错**（同步旧路径从不按 uid 寻址，这是异步路引入的回归）。
  //
  // 位置对齐的依据是 `EjsBackend.runPass` 的契约：条目按序执行、返回与入参一一对应且同序。
  // 万一某后端违约（长度对不上），下面的 `!outcome` 分支照 D8 原文注入并留痕。
  const dynamicParts: string[] = [];
  let evalIndex = 0;
  for (const slot of dynamicSlots) {
    if (!slot.needsEval) {
      dynamicParts.push(slot.content);
      continue;
    }
    const outcome = outcomes[evalIndex++];
    if (!outcome) {
      // 后端漏了某条（不该发生）→ 按 D8 原文注入，并留痕
      dynamicParts.push(slot.content);
      fallbackEntries.push({ uid: slot.uid, error: `后端 ${backend.name} 未返回该条目结果` });
      continue;
    }
    dynamicParts.push(outcome.text);
    if (!outcome.ok) {
      fallbackEntries.push({ uid: slot.uid, error: outcome.error ?? '未知错误' });
      console.warn(
        `[worldbook] EJS 失败，回退原文注入 uid=${slot.uid}（后端 ${backend.name}）: ${outcome.error}`,
      );
    }
  }

  return assembleResult(staticParts, dynamicParts, fallbackEntries);
}
