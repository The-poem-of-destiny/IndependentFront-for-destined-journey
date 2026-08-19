/**
 * SaveProfile — 存档档案管理 (Phase 4.6)
 *
 * 职责: FP 读写、交易审计、契约管理、成就/新闻管理
 * ADR-22: FP 是存档级元货币，独立于 CharacterState
 */

import type { SaveProfile, FPTransaction, FateContract, Achievement, NewsItem } from './types';
import { getSaveProfile, saveSaveProfile, createDefaultSaveProfile } from './database';
import { withSaveWriteLock } from './state-write-queue';

// ========== Profile CRUD ==========

/**
 * 读存档档案；不存在则**当场创建**。
 *
 * 🔴 `era` 只在「不存在 → 新建」那一支用得上（D9 盖章）：存量档案一律读自己那份，
 * 传什么都不会改写它。所以在读路径上忘了传 era 不会污染既有存档 ——
 * 只有存档创建那一次的调用方（捏人页）需要把内容侧的 era 交进来。
 */
export async function getProfile(saveId: string, era?: string): Promise<SaveProfile> {
  const existing = await getSaveProfile(saveId);
  if (existing) {
    // M5: 存量记录归一化 — M1 加的 variables 字段在旧 profile 上可能缺失（M1 终审备忘履约）
    if (existing.variables === undefined) existing.variables = {};
    return existing;
  }
  const created = createDefaultSaveProfile(saveId, era);
  await saveSaveProfile(created);
  return created;
}

export async function updateProfile(profile: SaveProfile): Promise<void> {
  await saveSaveProfile(profile);
}

// ========== FP Operations ==========

export function getFP(profile: SaveProfile): number {
  return profile.fp;
}

export async function addFP(
  profile: SaveProfile,
  amount: number,
  reason: string,
  source: FPTransaction['source'] = 'other',
): Promise<SaveProfile> {
  if (amount <= 0) return profile;

  profile.fp += amount;
  profile.fpHistory.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    amount,
    reason,
    balance: profile.fp,
    source,
  });
  await updateProfile(profile);
  return profile;
}

export async function spendFP(
  profile: SaveProfile,
  amount: number,
  reason: string,
  source: FPTransaction['source'] = 'other',
): Promise<SaveProfile> {
  if (amount <= 0) return profile;
  if (profile.fp < amount) {
    throw new Error(`FP 不足: 需要 ${amount}, 当前 ${profile.fp}`);
  }

  profile.fp -= amount;
  profile.fpHistory.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    amount: -amount,
    reason,
    balance: profile.fp,
    source,
  });
  await updateProfile(profile);
  return profile;
}

export function canAffordFP(profile: SaveProfile, amount: number): boolean {
  return profile.fp >= amount;
}

// ========== Contracts ==========

export async function addContract(
  profile: SaveProfile,
  contract: Omit<FateContract, 'id' | 'createdAt'>,
): Promise<SaveProfile> {
  profile.contracts.push({
    ...contract,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });
  await updateProfile(profile);
  return profile;
}

export function getContracts(profile: SaveProfile): FateContract[] {
  return profile.contracts;
}

export function getContractByTarget(
  profile: SaveProfile,
  targetId: string,
): FateContract | undefined {
  return profile.contracts.find((c) => c.targetId === targetId);
}

// ========== Achievements ==========

export async function addAchievement(
  profile: SaveProfile,
  achievement: Omit<Achievement, 'id' | 'unlockedAt'>,
): Promise<SaveProfile> {
  profile.achievements.push({
    ...achievement,
    id: crypto.randomUUID(),
    unlockedAt: Date.now(),
  });
  await updateProfile(profile);
  return profile;
}

// ========== News ==========

export async function addNews(
  profile: SaveProfile,
  news: Omit<NewsItem, 'id' | 'publishedAt' | 'read'>,
): Promise<SaveProfile> {
  profile.news.push({
    ...news,
    id: crypto.randomUUID(),
    publishedAt: Date.now(),
    read: false,
  });
  await updateProfile(profile);
  return profile;
}

/** 标记一条新闻已读 —— **只改内存不落库**（`markNewsRead` 的纯变更那一半，理由同 `setQuestInPlace`） */
function markNewsReadInPlace(profile: SaveProfile, newsId: string): void {
  const item = profile.news.find((n) => n.id === newsId);
  if (item) item.read = true;
}

export async function markNewsRead(profile: SaveProfile, newsId: string): Promise<SaveProfile> {
  markNewsReadInPlace(profile, newsId);
  await updateProfile(profile);
  return profile;
}

// ═══════════════════════════════════════════════════════════
// P1-09 UI 辅助字段的持久化入口（**锁内窄字段读-改-写**）
// ═══════════════════════════════════════════════════════════

/**
 * 焦点任务落库（`focusQuest`，QuestsPanel 的下拉选择）。
 *
 * 🔴 **两件事缺一不可，各挡一种败法**（2026-08-17 评审补，提交级缓存落地后暴露）：
 *
 *   ① **进写队列**（`withSaveWriteLock`）—— 与 `commitChatState` 那一段串行。
 *      不进队列时，这个写有可能落在提交的读-改-写中间，被出口那一次整档 flush 直接盖掉。
 *      （缓存之前每个补丁各自重读一次库，UI 的写被顺带吸收了 —— 那是**巧合**不是设计，
 *      读收进作用域之后这层意外保护就没有了。）
 *   ② **锁内重新读一份新鲜的 profile，只改那一个字段** —— 只加锁而拿着 UI 手里那份
 *      陈旧整档写回去，照样会把提交刚落的 fp/任务/变量全抹回旧值。锁解决的是交错，
 *      解决不了陈旧；真正的修法是这次**锁内的重读**。
 *
 * 语义仍是 P1-09 那条受控例外：UI 辅助字段，**失败不致命**（调用方 try/catch 记一条日志即可，
 * 别弹窗打断游玩）。AI 产生的 SaveProfile 变更照旧走 `vars_update`，不在此例外内。
 */
export async function persistFocusQuest(saveId: string, questName: string): Promise<void> {
  await withSaveWriteLock(saveId, async () => {
    const fresh = await getProfile(saveId);
    fresh.focusQuest = questName;
    await updateProfile(fresh);
  });
}

/**
 * 新闻已读标记落库（`news[].read`，ScenePanel 展开一条世界消息）。
 *
 * 两条铁律与 `persistFocusQuest` 同源（进队列 + 锁内重读窄改），此处只改中选那一条新闻的
 * `read` 标志：整档写回去会把提交期间新增的新闻/FP/任务一起抹掉。
 * 库里没有这个 id（快照回退把它撤掉了）时**静默不改**，与 `markNewsRead` 同口径。
 */
export async function persistNewsRead(saveId: string, newsId: string): Promise<void> {
  await withSaveWriteLock(saveId, async () => {
    const fresh = await getProfile(saveId);
    markNewsReadInPlace(fresh, newsId);
    await updateProfile(fresh);
  });
}

// ═══════════════════════════════════════════════════════════
// Quest 便利函数 (Phase 7e)
// ═══════════════════════════════════════════════════════════

import type { Quest } from './types';
import { createDefaultQuest } from './types';

/** 获取所有任务 */
export function getQuests(profile: SaveProfile): Record<string, Quest> {
  return profile.quests ?? {};
}

/** 获取单个任务 */
export function getQuest(profile: SaveProfile, name: string): Quest | undefined {
  return profile.quests[name];
}

/**
 * 设置/更新任务 —— **只改内存不落库**（`setQuest` 的纯变更那一半）。
 *
 * 🔴 `*InPlace` 这一族的存在理由只有一个：`StateManager.commitChatState` 的**提交作用域缓存**
 *    （见 state-manager.ts 的 `CommitScope` 注释）把「改」与「落」拆成了两拍 —— 一次提交里
 *    十个补丁改同一份 profile，出口只落一次库。合并语义（缺省任务补 `createDefaultQuest`）
 *    必须留在本文件一处：搬去 state-manager 抄一份，漂了不会报错，只会让两条路径产出不同形状的任务。
 */
export function setQuestInPlace(profile: SaveProfile, name: string, quest: Partial<Quest>): void {
  const existing = profile.quests[name] ?? createDefaultQuest();
  profile.quests[name] = { ...existing, ...quest };
}

/** 设置/更新任务 (upsert) —— 改内存 + 立即落库的命名写入口 */
export async function setQuest(
  profile: SaveProfile,
  name: string,
  quest: Partial<Quest>,
): Promise<SaveProfile> {
  setQuestInPlace(profile, name, quest);
  await updateProfile(profile);
  return profile;
}

/** 删除任务 —— **只改内存不落库**（理由同 `setQuestInPlace`） */
export function removeQuestInPlace(profile: SaveProfile, name: string): void {
  delete profile.quests[name];
}

/** 删除任务 */
export async function removeQuest(profile: SaveProfile, name: string): Promise<SaveProfile> {
  removeQuestInPlace(profile, name);
  await updateProfile(profile);
  return profile;
}

/** 获取活跃任务 (状态不为"已完成"和"失败") */
export function getActiveQuests(profile: SaveProfile): [string, Quest][] {
  return Object.entries(profile.quests ?? {}).filter(
    ([, q]) => q.status !== '已完成' && q.status !== '失败',
  );
}

/** 按关注度排序: 高→中→低，同关注度按名称 */
export function getSortedQuests(profile: SaveProfile): [string, Quest][] {
  const priorityOrder: Record<string, number> = { 高: 0, 中: 1, 低: 2 };
  return Object.entries(profile.quests ?? {}).sort(
    ([aName, a], [bName, b]) =>
      (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) ||
      aName.localeCompare(bName),
  );
}

// ═══════════════════════════════════════════════════════════
// Map Marker 便利函数 (Phase 7e)
// ═══════════════════════════════════════════════════════════

import type { MapMarker } from './types';

/** 获取所有地图标记 */
export function getMapMarkers(profile: SaveProfile): MapMarker[] {
  return (profile.worldFlags.mapMarkers as MapMarker[]) ?? [];
}

/** 按 ID 查找标记 */
export function getMapMarker(profile: SaveProfile, id: string): MapMarker | undefined {
  return getMapMarkers(profile).find((m) => m.id === id);
}

/** 添加/更新标记 (upsert by id) */
export async function setMapMarker(profile: SaveProfile, marker: MapMarker): Promise<SaveProfile> {
  const markers = getMapMarkers(profile);
  const idx = markers.findIndex((m) => m.id === marker.id);
  if (idx >= 0) {
    markers[idx] = marker;
  } else {
    markers.push(marker);
  }
  profile.worldFlags.mapMarkers = markers;
  await updateProfile(profile);
  return profile;
}

/** 删除标记 */
export async function removeMapMarker(profile: SaveProfile, id: string): Promise<SaveProfile> {
  profile.worldFlags.mapMarkers = getMapMarkers(profile).filter((m) => m.id !== id);
  await updateProfile(profile);
  return profile;
}

// ═══════════════════════════════════════════════════════════
// 地图派生态（地图系统 v1 / 设计 §4 · §3.4-2）
// ═══════════════════════════════════════════════════════════

import type { MapSaveFlags } from './types-map';

/** `worldFlags.map` 在 profile 里的键 —— 只在本节出现，读写两侧共用一处 */
const MAP_FLAGS_KEY = 'map';

/**
 * 读地图派生态（`worldFlags.map`）。
 *
 * 缺席（新档 / 换包自愈前）返回**空袋子**而不是 `undefined`：全字段可选，
 * 「一格都没有」与「还没有这个袋子」对每个消费方都是同一件事（`MapSaveFlags` 文件头）。
 * 🔴 返回的空袋子是**新对象**，往里写不会落库 —— 落库只有 `updateMapFlags` 这一条路。
 */
export function getMapFlags(profile: SaveProfile): MapSaveFlags {
  const raw = profile.worldFlags?.[MAP_FLAGS_KEY];
  return raw !== null && typeof raw === 'object' ? (raw as MapSaveFlags) : {};
}

/**
 * 整份覆盖地图派生态（**命名写入口**，P1-09 口径，先例 `setMapMarker`）。
 *
 * 🔴 **整份覆盖而不是逐字段合并**：这一袋全是派生态，换包自愈要能把它清空（§3.4-2），
 *    而「合并」这个语义下清空是做不到的 —— 传一个只有新戳的袋子会被旧 `lastTileId` 补回来，
 *    于是自愈之后棋子仍然指着旧地图上的块。调用方负责算出**完整**的下一份。
 * 🔴 `saveSaveProfile` 落的是整份 profile，所以同一次调用前就地改过的 `variables`
 *    （天气断言那条）会随本次写一起落库 —— 天气与它的戳因此**不可能只落一半**。
 */
export async function updateMapFlags(
  profile: SaveProfile,
  flags: MapSaveFlags,
): Promise<SaveProfile> {
  setMapFlagsInPlace(profile, flags);
  await updateProfile(profile);
  return profile;
}

/**
 * 整份覆盖地图派生态 —— **只改内存不落库**（`updateMapFlags` 的纯变更那一半）。
 *
 * 存在理由同 `setQuestInPlace`：落库那一拍由 `StateManager` 的提交作用域缓存统一做。
 * `MAP_FLAGS_KEY` 与「缺 worldFlags 就补空袋子」这条兜底因此仍然只有本文件一处。
 */
export function setMapFlagsInPlace(profile: SaveProfile, flags: MapSaveFlags): void {
  // 存量记录（与手搓的测试 profile）可能整个缺 worldFlags；缺了就补一个空袋子
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[MAP_FLAGS_KEY] = flags;
}

// ═══════════════════════════════════════════════════════════
// 随机事件每存档状态（随机事件系统 v1 / 设计 §3.2）
// ═══════════════════════════════════════════════════════════

import type { RandomEventSaveFlags } from './types-random-events';

/** `worldFlags.randomEvents` 在 profile 里的键 —— 只在本节出现，读写两侧共用一处 */
const RANDOM_EVENT_FLAGS_KEY = 'randomEvents';

/**
 * 读随机事件状态（`worldFlags.randomEvents`）。
 *
 * 缺席（新档 / 还没掷过第一次骰）返回**空袋子**而不是 `undefined`：全字段可选，
 * 「一格都没有」与「还没有这个袋子」对每个消费方都是同一件事（`RandomEventSaveFlags` 注释）。
 * 🔴 返回的空袋子是**新对象**，往里写不会落库 —— 落库只有 `updateRandomEventFlags` 这一条路。
 */
export function getRandomEventFlags(profile: SaveProfile): RandomEventSaveFlags {
  const raw = profile.worldFlags?.[RANDOM_EVENT_FLAGS_KEY];
  return raw !== null && typeof raw === 'object' ? (raw as RandomEventSaveFlags) : {};
}

/**
 * 整份覆盖随机事件状态（**命名写入口**，P1-09 口径，形状照 `updateMapFlags`）。
 *
 * 🔴 **整份覆盖而不是逐字段合并**：四个调度纯函数（掷骰 / 首访 / 保洁 / 结算）返回的都是
 *    **完整的下一份** flags，且它们的产物里「某个数组变短了」「某个字段被删了」是主要的变化
 *    形态 —— 而「合并」这个语义下删除是做不到的。合并的症状是候选池只增不减：过期条目撤不掉、
 *    触发后清不了池。调用方负责算出完整的下一份。
 * 🔴 **与 `worldFlags.map` 的契约刚好相反**：这一袋存的是**事实不是派生态**（足迹与触发档案
 *    不可重算），所以没有换包自愈那条清空路径（设计 §3.2）。
 */
export async function updateRandomEventFlags(
  profile: SaveProfile,
  flags: RandomEventSaveFlags,
): Promise<SaveProfile> {
  setRandomEventFlagsInPlace(profile, flags);
  await updateProfile(profile);
  return profile;
}

/**
 * 整份覆盖随机事件状态 —— **只改内存不落库**（`updateRandomEventFlags` 的纯变更那一半）。
 * 存在理由同 `setQuestInPlace`。
 */
export function setRandomEventFlagsInPlace(
  profile: SaveProfile,
  flags: RandomEventSaveFlags,
): void {
  // 存量记录（与手搓的测试 profile）可能整个缺 worldFlags；缺了就补一个空袋子
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[RANDOM_EVENT_FLAGS_KEY] = flags;
}

// ═══════════════════════════════════════════════════════════
// 地块事实态（地图 v1.2 / ADR-33 §3）
// ═══════════════════════════════════════════════════════════

import type { MapFactsFlags } from './types-map';

/** `worldFlags.mapFacts` 在 profile 里的键 —— 只在本节出现，读写两侧共用一处 */
const MAP_FACTS_KEY = 'mapFacts';

/**
 * 读地块事实态（`worldFlags.mapFacts`）。
 *
 * 缺席（新档 / 还没有任何一块地偏离 pack 基线）返回**空袋子**（`{ tiles: {} }`）而不是
 * `undefined`：「一块地都没记过事」与「还没有这个袋子」对每个消费方都是同一件事。
 * 🔴 返回的空袋子是**新对象**，往里写不会落库 —— 落库只有 `updateMapFactsFlags` 这一条路。
 * 🔴 `tiles` 缺席/被写坏时同样补空表：这一袋会随存档往返（导出/导入/手改备份），
 *    类型说必填不等于运行期真有（口径照 `getRandomEventFlags` 的防御性读取）。
 */
export function getMapFactsFlags(profile: SaveProfile): MapFactsFlags {
  const raw = profile.worldFlags?.[MAP_FACTS_KEY];
  if (raw === null || typeof raw !== 'object') return { tiles: {} };
  const bag = raw as MapFactsFlags;
  if (bag.tiles === null || typeof bag.tiles !== 'object') return { ...bag, tiles: {} };
  return bag;
}

/**
 * 整份覆盖地块事实态（**命名写入口**，P1-09 口径，形状照 `updateRandomEventFlags`）。
 *
 * 🔴 **整份覆盖而不是逐字段合并**：`map-dynamics` 的纯函数返回的都是**完整的下一份**，
 *    且「某条状态被摘掉了」「某个槽变成空的了」正是主要的变化形态 —— 合并语义下删除做不到，
 *    症状是到期的状态永远撤不掉、被毁的建筑第二天又回来了。
 * 🔴 **与 `worldFlags.map` 的契约刚好相反**（ADR-33 §3，与 `worldFlags.randomEvents` 同侧）：
 *    这一袋存的是**事实不是派生态**，所以**永不随 packStamp 清空**。名字在现行包里消失只是
 *    **休眠**（不结算、不删除），包回来自动复活。别把它接进 `ensureMapFlags` 的自愈路径。
 */
export async function updateMapFactsFlags(
  profile: SaveProfile,
  facts: MapFactsFlags,
): Promise<SaveProfile> {
  setMapFactsInPlace(profile, facts);
  await updateProfile(profile);
  return profile;
}

/**
 * 整份覆盖地块事实态 —— **只改内存不落库**（`updateMapFactsFlags` 的纯变更那一半）。
 * 存在理由同 `setMapFlagsInPlace`：落库那一拍由 `StateManager` 的提交作用域缓存统一做。
 */
export function setMapFactsInPlace(profile: SaveProfile, facts: MapFactsFlags): void {
  // 存量记录（与手搓的测试 profile）可能整个缺 worldFlags；缺了就补一个空袋子
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[MAP_FACTS_KEY] = facts;
}
