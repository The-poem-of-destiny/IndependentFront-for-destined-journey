import type { AssetType, StoryMemorySource } from './types';
import type { GameTime } from '../time/time-system';

/** Narrator-owned fields. Mechanical state remains owned by the existing patch pipeline. */
export interface CharacterProfile {
  aliases?: string[];
  race?: string;
  identity?: string[];
  occupation?: string[];
  appearance?: string;
  background?: string;
  personality?: string;
  gender?: string;
  outfit?: string;
  goals?: string;
}

/**
 * 年龄锚点 —— 年龄的唯一真源，见 `character/character-age.ts`。
 * 不存出生年：单纪元下长寿角色的出生年会落到纪元之前，没有意义。
 */
export interface CharacterAgeAnchor {
  /** 开局时刻（纪元年 1 月 1 日）的周岁；开局后才出生的角色为负 */
  startAge: number;
  /** 生日（历法 12 月 × 30 日） */
  month: number; // 1-12
  day: number; // 1-30
}

/** 作者 / 模型给的年龄线索；只在角色实例化那一刻换算成 `CharacterAgeAnchor`，此后不再读。 */
export interface CharacterAgeHint {
  /** 周岁。写在作者定义里 = 开局时的年龄；实例自带（建号 / 模型输出）= 实例化那一刻的年龄 */
  age?: number;
  birthday?: { month: number; day: number };
}

interface CharacterAssetRef {
  type: AssetType;
  variant?: string;
  assetId?: string;
  url?: string;
}

export interface CharacterPastEntry {
  title: string;
  summary: string;
  time: { kind: 'past'; label: string };
  importance: number;
  impact?: string;
  location?: string;
  people?: string[];
}

/** Reusable author data; a save freezes its selected definitions at creation. */
export interface CharacterDefinition extends CharacterAgeHint {
  id: string;
  name: string;
  profile: CharacterProfile;
  lore?: string;
  assets: CharacterAssetRef[];
  past: CharacterPastEntry[];
  legacyEntry?: { bookId: string; uid: string; token: string };
}

export interface CharacterChronicleDraft extends Omit<CharacterPastEntry, 'time'> {
  time: { kind: 'this_turn' } | { kind: 'past'; label: string };
}

export interface CharacterNarrativeUpdate {
  name: string;
  profile_changes: CharacterProfile;
  chronicle: CharacterChronicleDraft[];
}

export interface CharacterUpdatesParseResult {
  present: boolean;
  updates: CharacterNarrativeUpdate[];
  warnings: string[];
}

export interface CharacterChronicleEntry extends Omit<CharacterChronicleDraft, 'time'> {
  id: string;
  saveId: string;
  characterId: string;
  time: { kind: 'game'; value: GameTime | null } | { kind: 'past'; label: string };
  origin: 'author' | 'generated' | 'experience';
  order: number;
  createdAt: number;
  source: { kind: 'definition'; definitionId: string } | ({ kind: 'turn' } & StoryMemorySource);
  sourceText: string;
}
