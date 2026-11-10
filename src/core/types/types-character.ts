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
export interface CharacterDefinition {
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
