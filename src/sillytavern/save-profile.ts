/**
 * SaveProfile — 存档档案管理 (Phase 4.6)
 *
 * 职责: FP 读写、交易审计、契约管理、成就/新闻管理
 * ADR-22: FP 是存档级元货币，独立于 CharacterState
 */

import type { SaveProfile, FPTransaction, FateContract, Achievement, NewsItem } from './types';
import { getSaveProfile, saveSaveProfile, createDefaultSaveProfile } from './database';

// ========== Profile CRUD ==========

export async function getProfile(saveId: string): Promise<SaveProfile> {
  const existing = await getSaveProfile(saveId);
  if (existing) return existing;
  const created = createDefaultSaveProfile(saveId);
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

export function getContractByTarget(profile: SaveProfile, targetId: string): FateContract | undefined {
  return profile.contracts.find(c => c.targetId === targetId);
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
  const item = profile.news.find(n => n.id === newsId);
  if (item) item.read = true;
  await updateProfile(profile);
  return profile;
}
