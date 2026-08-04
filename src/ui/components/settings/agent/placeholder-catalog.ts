/**
 * 上下文模板占位符目录（Phase 10e，Q-25 第 9 步搬出）。
 *
 * 一张 23 项的数据表 + 一条「哪些 Agent 看得见哪些占位符」的纯筛选。此前它俩住在
 * `SettingsPage.vue` 的 script 里，于是想验「vars_update 到底该看见几个占位符」
 * 得先挂起整个设置页。搬成纯模块之后是一行 import 一行断言。
 *
 * 🔴 **这不是占位符的真源** —— 真源是引擎的 `placeholder-registry.ts`（谁在装配期
 *    真的被替换）。本表是**设置页的展示元数据**：颜色、中文说明、分类、以及
 *    「给哪个 Agent 显示」。两边会漂：引擎加了一个占位符而这里没加，UI 上就点不出来
 *    （但手打进模板仍然有效）；反过来这里多写一个，UI 会给出一个装配期不认的键。
 *    加占位符时两处都要动。
 */

export interface PlaceholderBadge {
  /** 模板里写作 `{{KEY}}` 的那个 KEY */
  key: string;
  /** 徽章底色（按 category 分组配色，不是随机取的） */
  color: string;
  desc: string;
  category: string;
}

/** 所有已登记的占位符及其展示元数据 */
export const ALL_PLACEHOLDER_META: readonly PlaceholderBadge[] = [
  {
    key: 'SYS_PROMPT',
    color: '#4a9eff',
    desc: '核心指令 — 预设/agent-config systemPrompt',
    category: '自身',
  },
  { key: 'LORE_BOOK', color: '#4caf50', desc: '世界书 — keyword 激活条目', category: '世界' },
  {
    key: 'LORE_BOOK_STATIC',
    color: '#4caf50',
    desc: '世界书静态区 — 字节稳定条目',
    category: '世界',
  },
  {
    key: 'LORE_BOOK_DYNAMIC',
    color: '#4caf50',
    desc: '世界书动态区 — 含 EJS，装配时求值',
    category: '世界',
  },
  { key: 'NARRATIVE', color: '#ab47bc', desc: '对话历史 — 最近 N 轮消息', category: '叙事' },
  { key: 'USER_INPUT', color: '#ab47bc', desc: '用户输入 — 当前轮输入', category: '叙事' },
  { key: 'CHARACTER_STATE', color: '#ff9800', desc: '角色状态 — 属性/装备/技能', category: '角色' },
  { key: 'INVENTORY', color: '#ff9800', desc: '背包 — 角色物品列表', category: '角色' },
  { key: 'GAME_TIME', color: '#4caf50', desc: '世界状态 — 时间/位置/天气', category: '世界' },
  { key: 'ACTIVE_EFFECTS', color: '#ff9800', desc: '活跃效果 — Buff/Debuff', category: '角色' },
  { key: 'MEMORY_ENTRIES', color: '#ff7043', desc: '记忆条目 — embedding 召回', category: '记忆' },
  { key: 'PLOT_EVENTS', color: '#ff7043', desc: '剧情事件 — 活跃+待处理', category: '剧情' },
  {
    key: 'AGENT.MEMORY_RECALL',
    color: '#ef5350',
    desc: 'memory_recall 输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.PLOT_PRE_CHECK',
    color: '#ef5350',
    desc: 'plot_pre_check 输出',
    category: 'Agent通信',
  },
  { key: 'AGENT.STORY', color: '#ef5350', desc: 'story 正文AI 输出', category: 'Agent通信' },
  {
    key: 'AGENT.REQUEST_DISPATCHER',
    color: '#ef5350',
    desc: 'request_dispatcher 调度器输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.MEMORY_SUMMARY',
    color: '#ef5350',
    desc: 'memory_summary 输出',
    category: 'Agent通信',
  },
  {
    key: 'AGENT.VARS_UPDATE',
    color: '#ef5350',
    desc: 'vars_update 执行器输出',
    category: 'Agent通信',
  },
  { key: 'CRAFT_REQUEST', color: '#9e9e9e', desc: '<craft_request> 标记', category: '链调用' },
  { key: 'CHAR_DETECT', color: '#9e9e9e', desc: '<char_detect> 检测标记', category: '链调用' },
  { key: 'ITEM_REQUEST', color: '#9e9e9e', desc: '<item_requests> 物品请求', category: '链调用' },
  { key: 'CHAR_GEN_RESULT', color: '#9e9e9e', desc: 'char_gen NPC生成结果', category: '链调用' },
  { key: 'CRAFT_RESULT', color: '#9e9e9e', desc: 'craft_gen 制作结果', category: '链调用' },
];

/** 每个 Agent 都能用的那一批（与它在 DAG 里的位置无关） */
const COMMON_KEYS: readonly string[] = [
  'SYS_PROMPT',
  'LORE_BOOK',
  'LORE_BOOK_STATIC',
  'LORE_BOOK_DYNAMIC',
  'NARRATIVE',
  'USER_INPUT',
  'CHARACTER_STATE',
  'INVENTORY',
  'GAME_TIME',
  'ACTIVE_EFFECTS',
  'MEMORY_ENTRIES',
  'PLOT_EVENTS',
];

/** 侧链专属：只有被那条链唤起的 Agent 才拿得到这些标记 */
const CHAIN_ONLY: Record<string, readonly string[]> = {
  craft_gen: ['CRAFT_REQUEST', 'ITEM_REQUEST', 'CRAFT_RESULT'],
  char_gen: ['CHAR_DETECT', 'CHAR_GEN_RESULT'],
  item_gen: ['ITEM_REQUEST', 'CHAR_GEN_RESULT', 'CRAFT_RESULT'],
};

/**
 * Agent 间通信：某个 Agent 能读到**哪些上游 Agent** 的输出。
 *
 * 🔴 这张表编码的是 DAG 的**偏序**：只列在它之前跑完的那些。写错方向不会报错，
 *    只会让模板里出现一个装配时还是空串的占位符。
 */
const AGENT_OUTPUTS: Record<string, readonly string[]> = {
  story: ['AGENT.MEMORY_RECALL', 'AGENT.PLOT_PRE_CHECK'],
  plot_pre_check: ['AGENT.MEMORY_RECALL'],
  request_dispatcher: ['AGENT.STORY'],
  vars_update: ['AGENT.STORY', 'AGENT.REQUEST_DISPATCHER'],
  memory_summary: ['AGENT.STORY'],
  plot_post_check: ['AGENT.STORY', 'AGENT.MEMORY_SUMMARY'],
};

/** 这个 Agent 的占位符面板该显示哪些徽章（顺序沿用目录表的声明序） */
export function getPlaceholdersForAgent(agentId: string): PlaceholderBadge[] {
  const allowed = new Set<string>([
    ...(CHAIN_ONLY[agentId] ?? []),
    ...(AGENT_OUTPUTS[agentId] ?? []),
  ]);
  return ALL_PLACEHOLDER_META.filter((p) => COMMON_KEYS.includes(p.key) || allowed.has(p.key));
}

/**
 * 徽章上显示的字面量 `{{KEY}}`。
 *
 * 🔴 拼接而不是写字符串字面量：Vue SFC 的模板编译器会把 `{{ }}` 当插值，
 *    而这个函数虽然在 script 里，返回值仍会被渲染进模板 —— 早年直接写
 *    `` `{{${key}}}` `` 踩过，所以留成拼接并保留这条注释。
 */
export function phLabel(key: string): string {
  return '{' + '{ ' + key + ' }' + '}';
}
