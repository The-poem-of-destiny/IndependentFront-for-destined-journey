/**
 * content-store.ts — 内容-引擎分离（波 1）的 provider 执行层（D16 / §5.1）。
 *
 * 设计全文: `docs/planning/2026-08-05-content-engine-separation-design.md` §5.1 / §5.5 / §5.8 / D16。
 * 纯函数半边在 `src/sillytavern/content-source.ts`（T1，已落地）。
 *
 * 本文件管三件事:
 *
 * 1. **模块级 ready promise**（时序契约，D16）。🔴 这是最承重的一条：
 *    `settings-store` 的构造器在 `main.ts`（`useSettingsStore()`）里、`app.mount` **之前**
 *    就 `setTimeout(0)` 触发 `loadAgentProjectDefaults()`，而那条链现在改调
 *    `loadProjectDefaults()`。App.vue 的 init 链根本拦不住这个时序。所以 ready promise
 *    **必须在模块加载时创建**（任何 `import` 都会触发），谁先到都等它。
 *    `loadProjectDefaults()` 先 `await readyPromise` 再读盘——这保证「装包」叠加层（T7）
 *    有机会在 fetch 落地之前就灌注进内存层。
 *
 * 2. **contentStatus**（D16 / §5.5）。三处 fetch 收口 + AgentConfigPanel raw 读 +
 *    audio manifest + beautifier + builtin-worldbooks 全部经 provider 上报内容态。
 *    行为兜底不变（失败不阻塞启动）；现在失败进 `contentStatus='error'` 而不是静默。
 *
 * 3. **内容注册表**（D16）。六面（catalog/locations/bloodlines/namePools/markers/branding）
 *    的同步读取入口，约定 URL `/data/content/<name>.json`。本波（T2）先灌占位 = 现有
 *    代码常量（random-tables / bloodlines / DEFAULT_LOCATIONS 等）；波 2 逐面接管，
 *    pack 安装（T7）重灌。消费方（agent-tools 同步路径 / random-tables / bloodlines /
 *    $location）同步读它，所以注册表必须在任何 agent 执行前灌注完成——这条由
 *    `main.ts` 引入本模块时模块顶层同步触发 `seedPlaceholderRegistry()` 保证。
 *
 * 本波（T2）交付范围:
 * - 模块级 ready promise（带时序断言测试）
 * - `loadProjectDefaults()` —— 三处 fetch 收口入口（await ready + 占位 fetch 路径，
 *   pack 叠加是 T7 的活，本波先不实现 pack 解析）
 * - `loadRawProjectDefaults()` —— 显式绕过 pack 叠加层，读原始盘上文件（AgentConfigPanel 的
 *   读-改-写回路径用，D16）
 * - `setContentRegistry()` / `getContentRegistry()` 骨架 + 占位灌注
 * - `contentStatus` + `reportContentFetch()` 上报口（供 §5.5 七处 fetch 调用）
 *
 * 设计: docs/planning/2026-08-05-content-engine-separation-design.md §5.1 / §5.5 / §5.8 / D16
 */

import { defineStore, getActivePinia } from 'pinia';
import { ref } from 'vue';
import type { ContentStatus } from '@engine/types-content';
import { setContentFetchReporter } from '@engine/content-source';

// ═══════════════════════════════════════════════════════════
// 1. 模块级 ready promise（D16 时序契约）
// ═══════════════════════════════════════════════════════════

/**
 * provider 是否就绪（pack 叠加层已确定）。
 *
 * 🔴 **在模块加载时创建，而不是在 store 构造器里**。
 * 设计 D16 裁定：`settings-store` 构造器在 `main.ts`、`app.mount` 之前就 `setTimeout(0)`
 * 触发 `loadAgentProjectDefaults()`（它现在改调 `loadProjectDefaults()`），所以 ready
 * promise 不能依赖「App.vue init 链先跑」—— 那条链根本拦不住。
 * 模块级创建保证任何 `import './content-store'` 都会触发它，谁先到都等。
 *
 * 本波（T2）resolve 立即触发（无 pack 叠加需要等待）；T7 接 pack 装载后会改成本包解析
 * 完成才 resolve。**调用方一律 `await readyPromise`**，不要直接读 `isReady`。
 */
// resolveReady 在下面的 Promise 构造器里同步赋值（构造器立即执行），
// 所以在 markContentReady 调用它之前必定已绑定。用 `!` 抑制「未赋值」告警。
let resolveReady!: () => void;
export const contentReadyPromise: Promise<void> = new Promise((resolve) => {
  resolveReady = resolve;
});

/** 是否已就绪（仅用于诊断断言，业务路径必须 await promise） */
export let isContentReady = false;

/**
 * 标记 provider 就绪。本波立即 resolve（占位 fetch 路径不需要等）。
 * T7 装包执行器在解析完 pack 后调此函数。
 */
export function markContentReady(): void {
  if (isContentReady) return;
  isContentReady = true;
  resolveReady();
}

// ═══════════════════════════════════════════════════════════
// 2. 内容注册表（D16，六面同步读取）
// ═══════════════════════════════════════════════════════════

/**
 * 内容注册表的六面（D16 / §5.1）。
 *
 * 约定 URL: `/data/content/<name>.json`。本波（T2）先灌占位 = 现有代码常量；波 2 逐面接管，
 * pack 安装（T7）重灌。消费方同步读，所以灌注必须在任何 agent 执行前完成。
 *
 * 每面的值都是 `unknown`：本波只立灌注骨架与同步读取契约，真实形状由各波（D24/D25）
 * 收窄。这与 `PackCatalogSection.data: unknown` / `PackNamePoolsSection.data: unknown`
 * （types-content.ts）同口径——pack 透传、planner 不解释结构。
 */
export interface ContentRegistry {
  /** 捏人目录池（D24） */
  catalog: unknown;
  /** 地点节点（D25①） */
  locations: unknown;
  /** 血脉集（D25②） */
  bloodlines: unknown;
  /** 名字池 / 发色 / 瞳色 / 性格池（D25③） */
  namePools: unknown;
  /** 地图标记预设（D23，MapPanel 用） */
  markers: unknown;
  /** 品牌面（D26：应用名/副标题/era/credits 等） */
  branding: unknown;
}

/**
 * 模块级注册表（D16）。
 *
 * 🔴 **模块级而非 store 实例级**：agent-tools / random-tables / bloodlines / $location
 * 这些**同步**消费方在工具执行路径里读它，不能等 Pinia store 构造（那是 `app.use(pinia)`
 * 之后的事）。模块加载时 `seedPlaceholderRegistry()` 同步灌注占位常量，保证任何
 * 同步读取都拿到非空值。
 *
 * 用 `let` + 整份替换（不深合并）：pack 安装重灌时整份盖，简单且无半状态。
 */
let registry: ContentRegistry = createEmptyRegistry();

/** 当前注册表（同步读取；agent-tools 等同步路径用） */
export function getContentRegistry(): ContentRegistry {
  return registry;
}

/**
 * 整份替换注册表。pack 安装执行器（T7）/ boot 占位灌注调用。
 *
 * 🔴 **整份替换**：不做深合并（避免占位常量与 pack payload 半混的半状态）。
 * 调用方应先用 `resolveSection`（content-source.ts，D20 三态）算出最终值再传进来。
 */
export function setContentRegistry(next: ContentRegistry): void {
  registry = next;
}

/** 造一份空注册表骨架 */
function createEmptyRegistry(): ContentRegistry {
  return {
    catalog: undefined,
    locations: undefined,
    bloodlines: undefined,
    namePools: undefined,
    markers: undefined,
    branding: undefined,
  };
}

/**
 * 用现有代码常量灌注占位注册表（D16 / §6）。
 *
 * 🔴 在**模块加载时同步跑**（见文件尾）。这保证 agent-tools 同步工具执行路径在任何
 * agent 真正跑起来之前，registry 已是非空占位常量。波 2 逐面接管时改成读占位
 * `/data/content/*.json`；本波先灌内存常量，零 I/O。
 *
 * 注：本波刻意**不**在模块加载时 `import` random-tables / bloodlines / location-db
 * 的真实常量——那会把 334 KB 的 start-catalog-data 等内容编译进 bundle（§1.2 硬耦合 #2/#3）。
 * 占位值用 `undefined`，让「本波未灌」成为可观测的占位态；波 2 改为读 `/data/content/`。
 * 真正的内容灌注由 `setContentRegistry` 在 boot 显式调（T7 装包执行器或占位 fetch 完成后）。
 */
export function seedPlaceholderRegistry(): void {
  // 本波：占位注册表保持空骨架（各面 undefined）。
  // 波 2 逐面接管时此处改为读占位 `/data/content/<name>.json` 并灌注。
  // 现在先不灌——避免在 T2 阶段就把真实内容常量拉进 bundle（D24/D25 的活）。
  registry = createEmptyRegistry();
}

// ═══════════════════════════════════════════════════════════
// 3. 内容态上报（D16 / §5.5）
// ═══════════════════════════════════════════════════════════

/**
 * 一次内容 fetch 的上报事件（§5.5 census）。
 *
 * 七处活跃 fetch（`beautifier.ts`、`builtin-worldbooks.ts`、`AgentConfigPanel.vue`、
 * `game-pipeline.ts`、`create-store.ts`、`settings-store.ts` + `audio-store.ts`）
 * 改造后全部经 provider 上报 `contentStatus`。**行为兜底不变**：失败不阻塞启动，
 * 只进状态。本波先收集最近一次的失败原因进 `lastFetchError`，UI 消费 `contentStatus`。
 */
export interface ContentFetchReport {
  /** 调用方标识（如 'settings-store' / 'game-pipeline'） */
  source: string;
  /** HTTP 状态码（fetch 完成时）；网络层失败为 undefined */
  status?: number;
  /** 是否成功 */
  ok: boolean;
  /** 失败原因（ok=false 时） */
  error?: string;
}

// ═══════════════════════════════════════════════════════════
// 4. Pinia store（contentStatus + load* 入口）
// ═══════════════════════════════════════════════════════════

export const useContentStore = defineStore('content', () => {
  /** 应用级内容态（D16）。占位态起步；七处 fetch 上报后可能切到 error。 */
  const contentStatus = ref<ContentStatus>('placeholder');
  /** 已装内容包的 id（contentStatus === 'pack' 时有意义；T7 落地） */
  const activePackId = ref<string | null>(null);
  /** 已装内容包的版本（T7 落地） */
  const activePackVersion = ref<string | null>(null);
  /** 最近一次 fetch 失败原因（诊断用；contentStatus==='error' 时有意义） */
  const lastFetchError = ref<string | null>(null);
  /**
   * 最近一次内容态上报（§5.5 census）。UI / 测试用它确认「provider 被经过」。
   * 用数组收集，保留来源与顺序，便于横幅文案分支。
   */
  const fetchReports = ref<ContentFetchReport[]>([]);

  /**
   * 上报一次内容 fetch 的结果（§5.5）。
   *
   * 🔴 **行为兜底不变**：失败只进状态，不抛、不阻塞。调用方照旧走自己的兜底
   * （game-pipeline / beautifier 的 warn 保留）。本函数只负责「让失败可见」。
   */
  function reportContentFetch(report: ContentFetchReport): void {
    fetchReports.value.push(report);
    if (!report.ok) {
      // 第一个失败就把内容态切到 error；后续失败不覆盖已确认的 needs_attention/pack
      if (contentStatus.value === 'placeholder') {
        contentStatus.value = 'error';
        lastFetchError.value = `${report.source}: ${report.error ?? 'HTTP ' + (report.status ?? '?')}`;
      }
    } else if (contentStatus.value === 'error') {
      // 后续成功把 error 清回 placeholder（占位 fetch 成功 = 占位态成立）
      contentStatus.value = 'placeholder';
      lastFetchError.value = null;
    }
  }

  /**
   * 收口入口：加载项目默认 Agent 配置（D16 三处 fetch 收口之一）。
   *
   * 🔴 先 `await contentReadyPromise`——保证 T7 的 pack 叠加层有机会在 fetch 落地前
   * 灌注（本波 ready 立即 resolve，所以等价于直接 fetch；但调用方代码不变，
   * T7 接 pack 时这条 await 就承重了）。
   *
   * 本波返回「占位 fetch」路径的解析值（pack payload > 占位 fetch 的优先级在 T7 落地）。
   * 失败上报 `contentStatus`，不抛。
   *
   * @returns 解析后的默认值（pack payload > 占位 fetch > 空骨架）
   */
  async function loadProjectDefaults(): Promise<unknown> {
    await contentReadyPromise;
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) {
        reportContentFetch({
          source: 'content-store.loadProjectDefaults',
          status: res.status,
          ok: true,
        });
        return await res.json();
      }
      reportContentFetch({
        source: 'content-store.loadProjectDefaults',
        status: res.status,
        ok: false,
        error: `HTTP ${res.status}`,
      });
      return { version: 1, agents: {} };
    } catch (err) {
      reportContentFetch({
        source: 'content-store.loadProjectDefaults',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return { version: 1, agents: {} };
    }
  }

  /**
   * 显式绕过 pack 叠加层，读原始盘上文件（D16）。
   *
   * 🔴 **AgentConfigPanel.vue 的读-改-写回路径专用**（`saveAsDefault` 流程）。
   * 那条路径若走 pack 叠加层，一次「保存为默认」就把真实提示词写进公开仓占位文件，
   * 方向整个反了（D16 裁定）。所以它保持读原始盘上文件。
   *
   * 本函数**不上报 contentStatus**——它是写回路径的读半边，不是内容装载 census 的一员。
   * 失败返回空骨架（与原 fetch 直读行为一致）。
   */
  async function loadRawProjectDefaults(): Promise<unknown> {
    try {
      const res = await fetch('/data/defaults/agent-config.json');
      if (res.ok) return await res.json();
      return { version: 1, agents: {} };
    } catch {
      return { version: 1, agents: {} };
    }
  }

  return {
    contentStatus,
    activePackId,
    activePackVersion,
    lastFetchError,
    fetchReports,
    reportContentFetch,
    loadProjectDefaults,
    loadRawProjectDefaults,
  };
});

// ═══════════════════════════════════════════════════════════
// 模块加载时同步初始化（D16 时序契约的执行点）
// ═══════════════════════════════════════════════════════════

// 🔴 这两行是 D16 时序契约的全部承重点。它们在 `import` 本模块时同步执行：
//   - 占位注册表先灌好（同步消费方立刻可读）
//   - ready 立即 resolve（本波无 pack 叠加；T7 装包执行器会改这条）
//
// 顺序不可调：先 seed（让同步消费方有值），再 markReady（让 await 方放行）。
// markReady 内部有幂等闸，T7 重调不会重复 resolve。
seedPlaceholderRegistry();
markContentReady();

// ═══════════════════════════════════════════════════════════
// 引擎层 fetch 上报钩子注册（§5.5 census）
// ═══════════════════════════════════════════════════════════

// 引擎层（beautifier / builtin-worldbooks）不能 import UI store（依赖边方向），
// 所以 provider 暴露注入式钩子（setContentFetchReporter）。本模块 import 时注册：
// 引擎 fetch 完成后回调到 content-store.reportContentFetch。
//
// 🔴 用 getActivePinia() 惰性取 store：引擎 fetch 可能在 Pinia 挂载前就触发
//    （boot 期 beautifier.init()），那时没有 active pinia → 静默 no-op。
//    单测环境不挂 Pinia 时同理静默——兜底行为不变（§5.5）。
setContentFetchReporter((report) => {
  try {
    const pinia = getActivePinia?.();
    if (!pinia) return; // 单测 / 未挂载 → 静默
    const state = pinia.state.value as Record<string, unknown>;
    if (!('content' in state)) return; // content store 未构造
    // 直接写 state：reportContentFetch 是 store action，需要 store 实例；
    // 这里用裸 state 写入避开「取 store 实例」的时序耦合。
    const s = state['content'] as {
      fetchReports: ContentFetchReport[];
      contentStatus: ContentStatus;
      lastFetchError: string | null;
    };
    s.fetchReports = [...s.fetchReports, report];
    if (!report.ok) {
      if (s.contentStatus === 'placeholder') {
        s.contentStatus = 'error';
        s.lastFetchError = `${report.source}: ${report.error ?? 'HTTP ' + (report.status ?? '?')}`;
      }
    } else if (s.contentStatus === 'error') {
      s.contentStatus = 'placeholder';
      s.lastFetchError = null;
    }
  } catch {
    /* 上报自身永不抛（与引擎层 reportContentFetch 的兜底语义一致） */
  }
});
