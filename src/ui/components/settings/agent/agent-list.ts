/**
 * 11 个 Agent 的清单（Q-25 第 9 步）。
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

/** 找一个 Agent 的展示名；查不到就把 id 原样显示出来，不吞掉未知 Agent */
export function agentDisplayName(agentId: string | null): string {
  if (!agentId) return '';
  return AGENT_LIST.find((a) => a.id === agentId)?.name ?? agentId;
}
