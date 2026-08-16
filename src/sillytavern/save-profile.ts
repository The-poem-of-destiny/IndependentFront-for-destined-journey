/**
 * SaveProfile — 存档档案管理 (Phase 4.6)
 *
 * 职责: FP 读写、交易审计、契约管理、成就/新闻管理
 * ADR-22: FP 是存档级元货币，独立于 CharacterState
 */

import type { SaveProfile, FPTransaction, FateContract, Achievement, NewsItem } from './types';
import { getSaveProfile, saveSaveProfile, createDefaultSaveProfile } from './database';

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

export async function markNewsRead(profile: SaveProfile, newsId: string): Promise<SaveProfile> {
  const item = profile.news.find((n) => n.id === newsId);
  if (item) item.read = true;
  await updateProfile(profile);
  return profile;
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

/** 设置/更新任务 (upsert) */
export async function setQuest(
  profile: SaveProfile,
  name: string,
  quest: Partial<Quest>,
): Promise<SaveProfile> {
  const existing = profile.quests[name] ?? createDefaultQuest();
  profile.quests[name] = { ...existing, ...quest };
  await updateProfile(profile);
  return profile;
}

/** 删除任务 */
export async function removeQuest(profile: SaveProfile, name: string): Promise<SaveProfile> {
  delete profile.quests[name];
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
  // 存量记录（与手搓的测试 profile）可能整个缺 worldFlags；缺了就补一个空袋子
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[MAP_FLAGS_KEY] = flags;
  await updateProfile(profile);
  return profile;
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
  // 存量记录（与手搓的测试 profile）可能整个缺 worldFlags；缺了就补一个空袋子
  if (profile.worldFlags === undefined || profile.worldFlags === null) profile.worldFlags = {};
  profile.worldFlags[RANDOM_EVENT_FLAGS_KEY] = flags;
  await updateProfile(profile);
  return profile;
}
