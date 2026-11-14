/**
 * 设置页 Agent 子导航的清单与分组（Q-25 第 9 步；2026-11-14 改为按模式分组）。
 *
 * 为什么单独一个文件：它有**两个**消费者，且分居两侧 ——
 *   · 设置页壳层的 Agent 子导航（`.sub-nav`，它是三栏布局里 `.settings-content` 的
 *     **兄弟**，属于页面骨架，不能搬进分区组件里）；
 *   · `AgentSection` 的详情页头（拿 `name` 显示当前 Agent 叫什么）。
 *
 * 🔴 这**不是**「Agent 有哪些」的唯一真源 —— 真源是引擎侧的
 *    `agent-config.json` 与 `agent-templates.ts`。本表只是**设置页的展示元数据**
 *    （一句话说明 + 出现顺序）。新增 Agent 时两边都要动：
 *    引擎那边决定它跑不跑，这里决定它在设置页里看不看得见。
 *    中文名与「哪个模式跑哪些 Agent」在 `lib/agent-roster.ts`，分组由它**推导**，不在这里手写
 *    （漂移由 tests/ui/components/settings/agent/agent-list.groups.test.ts 钉住）。
 */

import { getDefaultTemplate } from '@engine/prompts/placeholder-registry';
import {
  AGENT_DISPLAY_NAMES,
  AGENT_MODE_AGENT_IDS,
  DIRECT_MODE_AGENT_IDS,
  DIRECT_PROFILE_IDS,
  STORY_V2_ONLY_AGENT_IDS,
} from '../../../lib/agent-roster';

export { agentDisplayName } from '../../../lib/agent-roster';

/** 子导航的三个分组 */
export type AgentGroupKey = 'agent' | 'direct' | 'auxiliary';

export interface AgentListEntry {
  /** 与 agent-config.json / agent-templates.ts 一致的 id */
  id: string;
  /** 设置页显示的中文名 */
  name: string;
  /** 子导航悬停与详情页头下方的一句话说明 */
  desc: string;
  /** 所属分组（由引擎管线与直出名册推导） */
  group: AgentGroupKey;
  /** 行内的次要标签（如「直出也使用」「仅 Story v2」） */
  tags: readonly string[];
}

export interface AgentGroup {
  key: AgentGroupKey;
  label: string;
  /** 分组标题下的一句白话说明 */
  caption: string;
  items: readonly AgentListEntry[];
}

/**
 * 每个 Agent 的一句话说明。声明顺序只决定**直出 / 辅助**两组内的先后；
 * Agent 模式组一律按管线阶段顺序排。
 */
const AGENT_DESCRIPTIONS: readonly { id: string; desc: string }[] = [
  { id: 'memory_recall', desc: '根据用户输入从记忆库中 Embedding 召回相关记忆' },
  { id: 'plot_pre_check', desc: '正文前检查需要触发的剧情事件和背景' },
  { id: 'lore_select', desc: '仅 Story v2：筛选本轮资料并有限补充；独立配置 API 池' },
  { id: 'story', desc: '核心叙事 Agent，生成游戏正文内容' },
  {
    id: 'request_dispatcher',
    desc: '分析正文，判断新-vs-已有角色/物品/制作，输出 XML 标签调度下游 Agent',
  },
  { id: 'memory_summary', desc: '生成本轮记忆摘要并计算 Embedding' },
  { id: 'daily_check', desc: '结算状态倒计时/到期/周期与条件效果（不做社交/属性检定）' },
  { id: 'vars_update', desc: '根据调度器标签更新角色状态、物品状态、环境效果' },
  { id: 'plot_post_check', desc: '正文后检查世界线变动，修正剧情大纲' },
  {
    id: 'direct_main',
    desc: '直出存档使用：一次完成叙事与演算，记忆仍独立调用；存档模式在创建时选择',
  },
  {
    id: 'direct_cached',
    desc: '缓存直出存档使用：运行时仍执行直出主生成，连接、参数与预设单独配置',
  },
  { id: 'craft_gen', desc: '处理制作意图，调用 $craft 工具生成创意效果' },
  { id: 'entity_gen', desc: '生成新角色/技能/装备/道具/状态/登神（原 char_gen + item_gen 合并）' },
  { id: 'combat', desc: '理解玩家意图，并负责战斗开场、结算与终局叙事' },
  {
    id: 'prose_rewrite',
    desc: '把最新一段正文按文风规范重写（DeepSeek beta 前缀续写，手动触发）',
  },
  { id: 'plot_outline', desc: '主线/支线模式下生成剧情大纲和事件树' },
];

/** 判定分组：先看是不是主 DAG 成员，再看是不是直出配置，其余都是按需触发的辅助 Agent */
function agentGroupOf(id: string): AgentGroupKey {
  if (AGENT_MODE_AGENT_IDS.includes(id)) return 'agent';
  if (DIRECT_PROFILE_IDS.includes(id)) return 'direct';
  return 'auxiliary';
}

function tagsOf(id: string): string[] {
  const tags: string[] = [];
  if (AGENT_MODE_AGENT_IDS.includes(id) && DIRECT_MODE_AGENT_IDS.includes(id)) {
    tags.push('直出也使用');
  }
  if (STORY_V2_ONLY_AGENT_IDS.includes(id)) tags.push('仅 Story v2');
  return tags;
}

const GROUP_META: readonly Omit<AgentGroup, 'items'>[] = [
  { key: 'agent', label: 'Agent 模式', caption: '每回合由多个 Agent 接力完成' },
  { key: 'direct', label: '直出模式', caption: '单个模型一次写完整回合' },
  { key: 'auxiliary', label: '辅助 Agent', caption: '按需触发，任何模式都会用到' },
];

const ENTRIES: AgentListEntry[] = AGENT_DESCRIPTIONS.map(({ id, desc }) => ({
  id,
  name: AGENT_DISPLAY_NAMES[id] ?? id,
  desc,
  group: agentGroupOf(id),
  tags: tagsOf(id),
}));

/** 分好组、排好序的子导航（Agent 模式组按管线阶段顺序） */
export const AGENT_GROUPS: readonly AgentGroup[] = GROUP_META.map((meta) => {
  const items = ENTRIES.filter((e) => e.group === meta.key);
  if (meta.key === 'agent') {
    items.sort((a, b) => AGENT_MODE_AGENT_IDS.indexOf(a.id) - AGENT_MODE_AGENT_IDS.indexOf(b.id));
  }
  return { ...meta, items };
});

/** 扁平清单（与子导航同序）：选中校验、页头取名、世界书受众列表等消费方用 */
export const AGENT_LIST: readonly AgentListEntry[] = AGENT_GROUPS.flatMap((g) => g.items);

/**
 * 把**持久化的** Agent 选择解析成一个当前仍然有效的 id（查不到 → null）。
 *
 * `settings.activeAgent` 存在 localStorage 里，而本清单是会改的（新增 / 改名 /
 * 下线一个 Agent）。直接拿旧值去渲染，`AgentSection` 的页头会是**空白** ——
 * 它取的是 `AGENT_LIST.find(...)?.name` —— 子导航里也没有任何一项高亮，
 * 于是用户面对的是一个说不出自己是谁的配置面。查不到就退回「未选择」空态。
 *
 * 🔴 与 `agentDisplayName` 的「查不到就原样显示 id」**刻意相反**：那个是在已经
 *    决定要显示某个 Agent 之后尽量说点什么，这个是在决定**要不要显示**。
 *    一个不在清单里的 id 没有子导航项可高亮，让它进去只会得到半个界面。
 *    顺带接住 `image_prompt` —— 它按 D53 刻意不在 AGENT_LIST 里。
 */
export function resolveAgentSelection(persisted: string | null | undefined): string | null {
  if (!persisted) return null;
  return AGENT_LIST.some((a) => a.id === persisted) ? persisted : null;
}

/**
 * 非 story Agent 的**出厂上下文模板**（引擎的 placeholder-registry 提供）。
 *
 * 两个消费者，分居两个组件：`AgentConfigPanel` 载入草稿时的最后一级兜底，
 * 以及 `AgentPromptCard` 在草稿为空时给模板预览用的输入。所以放这儿共享。
 *
 * 取不到就返回空串 —— 引擎没给这个 Agent 登记模板不是错误，
 * 意味着它走的是纯 systemPrompt 路径。
 */
export function getDefaultTemplateForAgent(agentId: string | null): string {
  if (!agentId) return '';
  try {
    return getDefaultTemplate(agentId);
  } catch {
    return '';
  }
}
