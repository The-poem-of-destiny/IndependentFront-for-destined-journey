/**
 * 首页「开始前的三步」引导 —— 步骤状态与面板态的纯函数（无 Vue / Pinia 依赖）。
 *
 * 🔴 完成状态**全由真实状态推导**：内容包看 content-store、API 看 `settings.apiPool`、
 *    存档看存档列表。不持久化「第几步做完了」，只持久化玩家的「不再显示」偏好
 *    （`UiSettings.onboardingDismissed`）。
 * 🔴 文案对齐 README「首次游玩」一节，本文件是界面上这组文案的**唯一出处**；
 *    组件只渲染这里给的字符串，不另写一份。
 * 🔴 API 判据复用 `buildApiEndpoints`（与运行时、`journey-readiness` 同一口径筛 LLM 源），
 *    不另写一套「这条源算不算对话源」的规则。
 */
import type { ContentStatus } from '@engine/types/types-content';
import { buildApiEndpoints } from './endpoint-resolver';

export type OnboardingStepId = 'content' | 'api' | 'save';

/**
 * - `done` —— 已满足
 * - `todo` —— 还没做
 * - `attention` —— 做过但需要处理（内容包失配 / 载入出错 / 授权锁定、API 源缺地址或模型）
 * - `unknown` —— 对应的数据还在加载，不下结论
 */
export type OnboardingStepStatus = 'done' | 'todo' | 'attention' | 'unknown';

/** 步骤下附带的可选副项（目前只有 API 步的 Embedding） */
interface OnboardingSubItem {
  label: string;
  /** 只取 `done` / `todo`；主步骤为 `unknown` 时副项也为 `unknown` */
  status: OnboardingStepStatus;
  hint: string;
}

export interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStepStatus;
  /** 必需步（API、存档）全部满足后面板自动收起；内容包是建议步 */
  required: boolean;
  /** 步骤序号（从 1 开始），与 README 的小节编号一致 */
  index: number;
  title: string;
  /** 角标：「建议」/「必须」 */
  badge: string;
  /** 按当前状态给出的一句说明 */
  hint: string;
  /** 直达按钮文案 */
  actionLabel: string;
  sub?: OnboardingSubItem;
}

export interface OnboardingModel {
  steps: OnboardingStep[];
  /** 必需步全部为 done */
  requiredDone: boolean;
  /** 三步全部为 done */
  allDone: boolean;
  /** 任一步仍在加载 */
  loading: boolean;
  doneCount: number;
  total: number;
}

export interface OnboardingInput {
  /** content-store 已完成首轮载入（`contentStatus` 可信） */
  contentLoaded: boolean;
  contentStatus: ContentStatus;
  activePackId: string | null | undefined;
  /** API 源已从 Dexie 回填（`apiPool` 可信） */
  apiLoaded: boolean;
  /** `settings.apiPool` 原样传入；内部经 `buildApiEndpoints` 筛 LLM 源 */
  apiPool: readonly unknown[];
  savesLoaded: boolean;
  saveCount: number;
}

export type OnboardingPanelState = 'expanded' | 'collapsed' | 'hidden';

export interface OnboardingPanelInput {
  model: OnboardingModel;
  /** 玩家点过「不再显示」：不再自动展开，但仍留收起态小入口可手动重开 */
  dismissed: boolean;
  /**
   * 本次会话里玩家的手动选择：`true` = 点了重新打开，`false` = 点了关闭，
   * `null` / 省略 = 没动过，按状态自动决定。
   */
  manualOpen?: boolean | null;
}

/** 收起态小入口文案：「开始前的三步 · n/3」 */
export function onboardingEntryLabel(model: OnboardingModel): string {
  return `开始前的三步 · ${model.doneCount}/${model.total}`;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function contentStep(input: OnboardingInput): OnboardingStep {
  const base = {
    id: 'content' as const,
    index: 1,
    required: false,
    title: '导入内容包',
    badge: '建议',
    actionLabel: '前往 设置 → 内容包',
  };
  if (!input.contentLoaded) {
    return { ...base, status: 'unknown', hint: '正在读取内容状态…' };
  }
  switch (input.contentStatus) {
    case 'pack':
      if (input.activePackId) {
        return { ...base, status: 'done', hint: '已装内容包。' };
      }
      break;
    case 'placeholder':
      // 受保护包授权锁定（content-store 的 lockActivePack）：包记录还在、activePackId 保留，
      // 但内容态退回 placeholder。这不是「没装包」，别说成「只有演示级占位内容」。
      if (input.activePackId) {
        return {
          ...base,
          status: 'attention',
          hint: '已装的内容包授权已失效或被锁定（例如未登录绑定的 Discord 账号、授权到期），当前在用占位内容。请到「设置 → 内容包」重新登录或检查更新。',
        };
      }
      break;
    case 'needs_attention':
      return {
        ...base,
        status: 'attention',
        hint: '内容包状态需要处理，请到「设置 → 内容包」查看。',
      };
    case 'error':
      return {
        ...base,
        status: 'attention',
        hint: '内容载入失败，当前可能在用占位内容，请到「设置 → 内容包」查看。',
      };
    default:
      break;
  }
  return {
    ...base,
    status: 'todo',
    hint: '当前只有演示级占位内容。完整的世界书、Agent 提示词、预设与目录通过内容包下发：点「导入 / 升级内容包」选本地文件，或「登录 Discord」后「检查更新」。没有内容包也能运行。',
  };
}

function apiStep(input: OnboardingInput): OnboardingStep {
  const base = {
    id: 'api' as const,
    index: 2,
    required: true,
    title: '添加 API',
    badge: '必须',
    actionLabel: '前往 设置 → API 配置',
  };
  const embeddingLabel = 'Embedding 向量召回';
  if (!input.apiLoaded) {
    return {
      ...base,
      status: 'unknown',
      hint: '正在读取 API 配置…',
      sub: { label: embeddingLabel, status: 'unknown', hint: '可选' },
    };
  }
  const llm = buildApiEndpoints(input.apiPool);
  const usable = llm.some(
    (endpoint) => isHttpUrl(endpoint.baseUrl) && endpoint.defaultModel.trim() !== '',
  );
  const hasEmbedding = input.apiPool.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const row = entry as { kind?: unknown; apiType?: unknown; baseUrl?: unknown };
    return (
      (row.kind ?? row.apiType) === 'embedding' &&
      typeof row.baseUrl === 'string' &&
      isHttpUrl(row.baseUrl)
    );
  });
  const sub: OnboardingSubItem = hasEmbedding
    ? {
        label: embeddingLabel,
        status: 'done',
        hint: '可选：已添加 Embedding 源，到「设置 → 记忆 & 缓存」切换召回模式并选中它。',
      }
    : {
        label: embeddingLabel,
        status: 'todo',
        hint: '可选：默认的「LLM 召回（兼容模式）」不需要额外配置。',
      };
  if (usable) {
    return {
      ...base,
      status: 'done',
      hint: '已有可用的文字 LLM 源。所有 Agent 默认跟随第一个文字 LLM 源，不必逐个绑定。',
      sub,
    };
  }
  if (llm.length > 0) {
    return {
      ...base,
      status: 'attention',
      hint: '已添加的文字 LLM 源还缺有效的「主链接」（http / https）或「模型」。',
      sub,
    };
  }
  return {
    ...base,
    status: 'todo',
    hint: '只需一个：点「+ 添加 API」，用途选「文字 LLM」，填「主链接」「API Key」与「模型」，保存前点「测试连接」。',
    sub,
  };
}

function saveStep(input: OnboardingInput): OnboardingStep {
  const base = {
    id: 'save' as const,
    index: 3,
    required: true,
    title: '新建存档',
    badge: '必须',
    actionLabel: '新建存档',
  };
  if (!input.savesLoaded) {
    return { ...base, status: 'unknown', hint: '正在读取存档…' };
  }
  if (input.saveCount > 0) {
    return { ...base, status: 'done', hint: '已有存档。' };
  }
  return {
    ...base,
    status: 'todo',
    hint: '点「新建存档」，在「启程前的准备」里选择生成模式并通过本机配置检查。模式随存档固定，创建后不可更改。',
  };
}

/** 按真实状态推导三步引导；顺序固定为 内容包 → API → 存档 */
export function deriveOnboardingSteps(input: OnboardingInput): OnboardingModel {
  const steps = [contentStep(input), apiStep(input), saveStep(input)];
  const doneCount = steps.filter((step) => step.status === 'done').length;
  return {
    steps,
    requiredDone: steps.every((step) => !step.required || step.status === 'done'),
    allDone: doneCount === steps.length,
    loading: steps.some((step) => step.status === 'unknown'),
    doneCount,
    total: steps.length,
  };
}

/**
 * 面板态：
 * - 任一步仍在加载 → `hidden`（不闪现）
 * - 三步全完成 → `hidden`（连入口一起藏）
 * - 玩家本次手动打开 / 关闭 → `expanded` / `collapsed`
 * - 点过「不再显示」→ `collapsed`（不自动展开，入口还在，可手动重开）
 * - 必需步全满足 → `collapsed`（自动收起），否则 `expanded`
 */
export function resolveOnboardingPanel({
  model,
  dismissed,
  manualOpen = null,
}: OnboardingPanelInput): OnboardingPanelState {
  if (model.loading || model.allDone) return 'hidden';
  if (manualOpen === true) return 'expanded';
  if (manualOpen === false) return 'collapsed';
  if (dismissed) return 'collapsed';
  return model.requiredDone ? 'collapsed' : 'expanded';
}
