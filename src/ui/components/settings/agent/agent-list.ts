/**
 * 12 个 Agent 的清单（Q-25 第 9 步）。
 *
 * 为什么单独一个文件：它有**两个**消费者，且分居两侧 ——
 *   · 设置页壳层的 Agent 子导航（`.sub-nav`，它是三栏布局里 `.settings-content` 的
 *     **兄弟**，属于页面骨架，不能搬进分区组件里）；
 *   · `AgentSection` 的详情页头（拿 `name` 显示当前 Agent 叫什么）。
 *
 * 🔴 这**不是**「Agent 有哪些」的唯一真源 —— 真源是引擎侧的
 *    `agent-config.json` 与 `agent-templates.ts`。本表只是**设置页的展示元数据**
 *    （中文名、一句话说明、阶段号），用于渲染导航与页头。新增 Agent 时两边都要动：
 *    引擎那边决定它跑不跑，这里决定它在设置页里看不看得见。
 */

import { getDefaultTemplate } from '@engine/placeholder-registry';

export interface AgentListEntry {
  /** 与 agent-config.json / agent-templates.ts 一致的 id */
  id: string;
  /** 设置页显示的中文名 */
  name: string;
  /** 子导航悬停与详情页头下方的一句话说明 */
  desc: string;
  /**
   * 编排阶段号（DAG 里的第几阶段）。
   * 目前只用于阅读时理解顺序，UI 没有按它分组 —— 真正的编排顺序由
   * `agent-orchestrator` 的 DAG 决定，不读这个字段。
   */
  stage: number;
}

export const AGENT_LIST: readonly AgentListEntry[] = [
  {
    id: 'memory_recall',
    name: '记忆召回',
    desc: '根据用户输入从记忆库中 Embedding 召回相关记忆',
    stage: 0,
  },
  { id: 'plot_pre_check', name: '剧情预检', desc: '正文前检查需要触发的剧情事件和背景', stage: 0 },
  { id: 'story', name: '正文生成', desc: '核心叙事 Agent，生成游戏正文内容', stage: 1 },
  {
    id: 'craft_gen',
    name: '制作生成',
    desc: '处理制作意图，调用 $craft 工具生成创意效果',
    stage: 1,
  },
  {
    id: 'combat_v3',
    name: '战斗决策',
    desc: '战斗侧链 Agent：内核主持战斗流程，它做敌方单位战术决策并输出结算演绎',
    stage: 1,
  },
  {
    id: 'request_dispatcher',
    name: '请求调度',
    desc: '分析正文，判断新-vs-已有角色/物品/制作，输出 XML 标签调度下游 Agent',
    stage: 2,
  },
  {
    id: 'vars_update',
    name: '变量更新',
    desc: '根据调度器标签更新角色状态、物品状态、环境效果，必要时编写状态效果脚本',
    stage: 3,
  },
  { id: 'char_gen', name: '角色生成', desc: '生成新 NPC 的五维属性、背景和登神长阶', stage: 3 },
  { id: 'item_gen', name: '物品生成', desc: '为 NPC 生成装备、技能和道具', stage: 3 },
  { id: 'memory_summary', name: '记忆总结', desc: '生成本轮记忆摘要并计算 Embedding', stage: 4 },
  { id: 'plot_post_check', name: '剧情修正', desc: '正文后检查世界线变动，修正剧情大纲', stage: 5 },
  { id: 'plot_outline', name: '大纲生成', desc: '主线/支线模式下生成剧情大纲和事件树', stage: 5 },
];

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

/** 找一个 Agent 的展示名；查不到就把 id 原样显示出来，不吞掉未知 Agent */
export function agentDisplayName(agentId: string | null): string {
  if (!agentId) return '';
  return AGENT_LIST.find((a) => a.id === agentId)?.name ?? agentId;
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
