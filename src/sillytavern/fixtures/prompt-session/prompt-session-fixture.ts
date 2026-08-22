/**
 * 匿名三回合 prompt-session fixture（LLM 组装层 Delta 会话 · T0）
 *
 * 用途：在改生产代码前，用这份小型仓内数据固定「首轮等价」与「wire message 实际形态」
 *       （见 docs/planning/2026-08-22-llm-assembly-delta-implementation-plan.md §4）。
 *       未来 T1–T4 的测试直接 import 这些命名导出，不必在测试里手拼样本数据。
 *
 * 🔴 匿名纪律（必读）：
 *   - 全部角色 / 物品 / 技能 / 地点 / 对话都是**凭空虚构**的，与《命定之诗》世界观、
 *     内置世界书、真实玩家存档、`tests/realtime_export/` 与私有内容仓**没有任何关联**。
 *   - 严禁把真实导出、真实世界书条目、API Key、任何用户内容复制进本目录。
 *   - 条目 uid 故意取 9000+（远离内置书 1–509 与 ST 用户书 0..N-1 的常态区间），
 *     避免与真实 uid 撞号。
 *
 * 内容清单（与计划 §4「工作」1 一一对应）：
 *   - 两个虚构角色（旅人 阿岚 + 旅店伙计 小铃）
 *   - 一个物品（薄荷油灯）
 *   - 一个技能（夜行）
 *   - 一条动态世界书（雨夜旅店，含 `<%` EJS —— 命中 `hasDynamic`）
 *   - 三组 user/assistant 消息
 */

import type { CharacterState, InventoryItem, Skill, WorldBook, WorldBookEntry } from '../../types';
import { createDefaultCharacterState } from '../../types';

/** 虚构存档 id —— 与任何真实存档无关联 */
export const FIXTURE_SAVE_ID = 'fixture-save';

/** 旅人 阿岚 —— 虚构玩家角色 */
export const fixturePlayer: CharacterState = createDefaultCharacterState({
  id: 'fixture-player-alan',
  saveId: FIXTURE_SAVE_ID,
  type: 'player',
  name: '阿岚',
  race: '人类',
  identity: ['旅人'],
  occupation: ['行脚客'],
  tier: 1,
  tierName: '普通',
  level: 3,
  attributes: { str: 10, dex: 12, con: 10, int: 11, spi: 10 },
  hp: 85,
  maxHp: 100,
  mp: 40,
  maxMp: 50,
  sp: 45,
  maxSp: 50,
  money: 32,
  location: '雨夜旅店',
  present: true,
  adventurerRank: 'D',
  currentAction: '在旅店避雨',
  gender: '女',
  appearance: '背着旧行囊的旅人，斗笠压着湿漉漉的发梢。',
  customFields: {},
});

/** 旅店伙计 小铃 —— 虚构 NPC */
export const fixtureNpc: CharacterState = createDefaultCharacterState({
  id: 'fixture-npc-xiaoling',
  saveId: FIXTURE_SAVE_ID,
  type: 'npc',
  name: '小铃',
  race: '人类',
  identity: ['旅店伙计'],
  occupation: ['照看灯盏'],
  tier: 1,
  tierName: '普通',
  level: 2,
  attributes: { str: 8, dex: 10, con: 9, int: 12, spi: 11 },
  hp: 60,
  maxHp: 70,
  mp: 30,
  maxMp: 40,
  sp: 25,
  maxSp: 35,
  money: 5,
  location: '雨夜旅店',
  present: true,
  adventurerRank: '未评级',
  currentAction: '擦拭灯台',
  gender: '女',
  appearance: '系着布围裙的年轻伙计，袖口沾着灯油。',
  customFields: {},
});

/** 两个虚构角色（player + npc） */
export const fixtureCharacters: CharacterState[] = [fixturePlayer, fixtureNpc];

/** 薄荷油灯 —— 虚构物品（躺背包，未装备） */
export const fixtureItem: InventoryItem = {
  name: '薄荷油灯',
  description: '一盏黄铜油灯，添了薄荷味的灯油，夜路上燃起来气味清凉。',
  quantity: 1,
  type: 'consumable',
  rarity: '普通',
  stats: {},
  durability: 3,
  maxDurability: 3,
  effects: { 照明: '为夜路提供一段明亮的光。' },
  data: { 灯油: '薄荷油' },
};

/** 夜行 —— 虚构被动技能 */
export const fixtureSkill: Skill = {
  name: '夜行',
  description: '习得的夜间赶路之法：目能视物、脚步放轻、遇岔路能辨风向。',
  type: 'passive',
  level: 1,
  effects: { 夜视: '夜间辨识道路的能力小幅提升。' },
  relevantAttribute: 'dex',
};

/** 雨夜旅店 —— 虚构动态世界书条目（含 `<%` EJS，命中 hasDynamic） */
export const fixtureWorldBookEntry: WorldBookEntry = {
  // uid 故意取 9001 —— 远离真实 uid 区间，防止撞号（见文件头匿名纪律）
  uid: 9001,
  name: '雨夜旅店',
  content:
    '<% setMessageVar("旅店灯盏", (getMessageVar("旅店灯盏") ?? 0) + 1) %>' +
    '雨夜旅店的檐下挂着<%= getMessageVar("旅店灯盏") %>盏灯，灯影在风里晃。',
  enabled: true,
  key: ['雨夜旅店'],
  keysecondary: [],
  selectiveLogic: 0,
  order: 0,
  position: 0,
};

/** 承载上面那条动态条目的虚构世界书 */
export const fixtureWorldBook: WorldBook = {
  id: 'fixture-worldbook-rainy-inn',
  name: '虚构地理手册',
  partition: 'world_setting',
  entries: [fixtureWorldBookEntry],
};

/** 三组 user/assistant 消息（六条）—— 虚构对话 */
export const fixtureTranscript: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: '雨夜，你推开旅店的门，风卷着湿气扑来。' },
  { role: 'assistant', content: '柜台后的小铃抬起头：「客官，夜路难走，先歇歇脚。」' },
  { role: 'user', content: '「来一盏薄荷油灯。」' },
  {
    role: 'assistant',
    content: '小铃从架子上取下一盏铜灯，灯芯跳动了两下：「给你，路上照着些。」',
  },
  { role: 'user', content: '「再教我怎么在夜里认路。」' },
  { role: 'assistant', content: '小铃眨了眨眼，把夜行的法子细细说了一遍。' },
];
