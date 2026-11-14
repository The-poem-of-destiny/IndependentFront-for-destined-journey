/**
 * Agent 名册的前端侧派生：中文显示名 + 「哪种存档模式会跑哪些 Agent」。
 *
 * 两个消费者分居两侧，所以单独成文件：
 *   · 设置页 Agent 子导航（`components/settings/agent/agent-list.ts`）按它分组、打标记；
 *   · 创角前配置检查（`journey-readiness.ts`）用它把报错里的 id 换成中文名。
 *
 * 🔴 「Agent 模式跑哪些」**不在这里手写**：主 DAG 的成员与顺序直接摊平引擎的
 *    `DEFAULT_AGENT_PIPELINE` / `STORY_CONTEXT_V2_PIPELINE`。这里只补管线对象里
 *    看不见的两件事 —— 直出模式的名册，以及仅 Story v2 回合额外装配的 `lore_select`
 *    （`lib/game-pipeline.ts` 的 buildAgentConfigs：只在 v2 且非直出时加入，排在 story 之前）。
 */

import type { GenerationMode } from '@engine/story/generation-mode';
import {
  DEFAULT_AGENT_PIPELINE,
  STORY_CONTEXT_V2_PIPELINE,
  type Pipeline,
} from '@engine/types/types';

/**
 * Agent id → 设置页与提示语里用的中文名。
 * 查不到的 id 由调用方决定怎么兜底（`agentDisplayName` 原样显示 id）。
 */
export const AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  memory_recall: '记忆召回',
  plot_pre_check: '剧情预检',
  lore_select: '资料选择',
  story: '正文生成',
  request_dispatcher: '请求调度',
  memory_summary: '记忆总结',
  daily_check: '日常检定',
  vars_update: '变量更新',
  plot_post_check: '剧情修正',
  direct_main: '直出主生成',
  direct_cached: '直出主生成（缓存优化）',
  craft_gen: '制作生成',
  entity_gen: '实体生成',
  combat: '战斗主持人',
  prose_rewrite: '正文润色',
  plot_outline: '大纲生成',
};

/** 找一个 Agent 的展示名；查不到就把 id 原样显示出来，不吞掉未知 Agent */
export function agentDisplayName(agentId: string | null): string {
  if (!agentId) return '';
  return AGENT_DISPLAY_NAMES[agentId] ?? agentId;
}

/** 直出模式每回合调用的 Agent（独立主生成 + 复用的两段记忆） */
export const DIRECT_MODE_AGENT_IDS: readonly string[] = [
  'memory_recall',
  'direct_main',
  'memory_summary',
];

/** 仅 Story v2 回合装配、管线对象里却看不见的 Agent，以及它要排在谁前面 */
const STORY_V2_EXTRA_AGENTS: readonly { id: string; before: string }[] = [
  { id: 'lore_select', before: 'story' },
];

/** 缓存直出只是一份独立的设置配置，运行时仍执行 direct_main */
const CACHED_DIRECT_PROFILE_ID = 'direct_cached';

function flattenPipeline(pipeline: Pipeline): string[] {
  return pipeline.stages.flatMap((stage) => stage.agents);
}

/** 把 extra 里没出现过的 id 按「排在谁前面」插进 base（找不到锚点就追加） */
function insertBefore(base: string[], extras: readonly { id: string; before: string }[]) {
  const out = [...base];
  for (const { id, before } of extras) {
    if (out.includes(id)) continue;
    const at = out.indexOf(before);
    if (at < 0) out.push(id);
    else out.splice(at, 0, id);
  }
  return out;
}

/**
 * 「Agent 模式」的全部成员，按管线阶段顺序：默认管线摊平，
 * v2 管线里多出来的（若有）补在其前驱之后，再插入仅 v2 的额外 Agent。
 */
export const AGENT_MODE_AGENT_IDS: readonly string[] = (() => {
  const order = flattenPipeline(DEFAULT_AGENT_PIPELINE);
  const v2 = flattenPipeline(STORY_CONTEXT_V2_PIPELINE);
  v2.forEach((id, i) => {
    if (order.includes(id)) return;
    const prev = i > 0 ? order.indexOf(v2[i - 1]!) : -1;
    order.splice(prev + 1, 0, id);
  });
  return insertBefore(order, STORY_V2_EXTRA_AGENTS);
})();

/** 仅 Story v2 回合才会调用的 Agent id */
export const STORY_V2_ONLY_AGENT_IDS: readonly string[] = AGENT_MODE_AGENT_IDS.filter(
  (id) => !flattenPipeline(DEFAULT_AGENT_PIPELINE).includes(id),
);

/** 「直出模式」的设置配置：直出名册里不属于 Agent 模式的那部分，加上缓存直出那份独立配置 */
export const DIRECT_PROFILE_IDS: readonly string[] = [
  ...DIRECT_MODE_AGENT_IDS.filter((id) => !AGENT_MODE_AGENT_IDS.includes(id)),
  CACHED_DIRECT_PROFILE_ID,
];

/**
 * 某个存档每回合实际读取哪些 Agent 配置（按设置页的配置 id 口径）。
 *
 * 缓存直出读的是 `direct_cached` 那份配置而不是 `direct_main`，所以这里换成前者。
 * 按需触发的辅助 Agent 不在其中 —— 它们与模式无关。
 */
export function agentIdsUsedBySave(mode: GenerationMode, storyV2: boolean): ReadonlySet<string> {
  if (mode === 'direct') return new Set(DIRECT_MODE_AGENT_IDS);
  if (mode === 'direct_cached') {
    return new Set(
      DIRECT_MODE_AGENT_IDS.map((id) => (id === 'direct_main' ? CACHED_DIRECT_PROFILE_ID : id)),
    );
  }
  const pipeline = storyV2 ? STORY_CONTEXT_V2_PIPELINE : DEFAULT_AGENT_PIPELINE;
  const ids = flattenPipeline(pipeline);
  return new Set(storyV2 ? insertBefore(ids, STORY_V2_EXTRA_AGENTS) : ids);
}
