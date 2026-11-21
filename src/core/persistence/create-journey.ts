import { isDirectMode } from '../story/generation-mode';
import {
  getDatabase,
  saveCharacter,
  saveSaveSlot,
  savePlotOutline,
  savePlotEvents,
} from './database';
import { getProfile, addFP, updateProfile } from '../state/save-profile';
import type { CharacterState, SaveSlot, PlotOutline, PlotEvent, WorldBook } from '../types/types';
import { filterBooksByEnabledEntries } from '../content/worldbook-loader';
import { createFixedLoreSnapshot } from '../content/lore-definitions';
import { MAX_START_LEVEL } from '../content/start-catalog-mechanics';
import {
  attachCharacterDefinition,
  characterLoreEntryUids,
  matchCharacterDefinition,
} from '../character/character-definitions';
import { authorChronicle } from '../character/character-chronicle';
import { ensureCharacterAge } from '../character/character-age';

/** Publish a complete new journey, or leave no records behind on failure. */
export async function createJourney(input: {
  character: CharacterState;
  save: SaveSlot;
  era: string;
  experienceMode: 'normal' | 'easy';
  destinyPoints: number;
  outline?: PlotOutline;
  events: PlotEvent[];
  worldBooks?: WorldBook[];
}): Promise<string> {
  // 阶位/属性/生命都已按等级推导好，这里只拒收、不截断；必须在开事务之前，失败不留任何记录
  const level = input.character.level;
  if (!Number.isInteger(level) || level < 1 || level > MAX_START_LEVEL) {
    throw new Error(`初始等级必须是 1 到 ${MAX_START_LEVEL} 之间的整数（收到 ${level}）`);
  }
  const db = getDatabase();
  await db.transaction(
    'rw',
    [
      db.characters,
      db.saves,
      db.saveProfiles,
      db.plotOutlines,
      db.plotEvents,
      db.characterChronicle,
    ],
    async () => {
      const profile = await getProfile(input.save.id, input.era);
      const save: SaveSlot = input.save.metadata.storyContextV2
        ? {
            ...input.save,
            metadata: {
              ...input.save.metadata,
              fixedLore: createFixedLoreSnapshot(
                filterBooksByEnabledEntries(input.worldBooks ?? [], [
                  ...(input.save.metadata.enabledWorldBookEntries ?? []),
                  ...characterLoreEntryUids(input.save.metadata.characterDefinitions ?? []),
                ]),
                {
                  characterName: input.character.name,
                  userName: input.save.metadata.userName,
                  agentId: isDirectMode(input.save.metadata.generationMode)
                    ? 'direct_main'
                    : 'story',
                },
                {
                  location: input.character.location,
                  gameTime: profile.gameTime,
                  recentText: '',
                },
              ),
            },
          }
        : input.save;
      const definition = matchCharacterDefinition(
        input.save.metadata.characterDefinitions ?? [],
        input.character.name,
      );
      // 浅拷贝：下面要补 ageAnchor，不能改到调用方传进来的那份输入
      const character = definition
        ? attachCharacterDefinition(input.character, definition)
        : { ...input.character };
      // 建号年龄（customFields.age）在开局时刻换算成年龄锚点，此后年龄随游戏时间推导
      ensureCharacterAge(character, profile.gameTime);
      await saveCharacter(character);
      const past = authorChronicle(character);
      if (past.length) await db.characterChronicle.bulkPut(past);
      await saveSaveSlot(save);
      profile.experienceMode = input.experienceMode;
      if (input.destinyPoints > 0) {
        await addFP(profile, input.destinyPoints, '开局兑换的命运点', 'other');
      } else {
        await updateProfile(profile);
      }
      if (input.outline) await savePlotOutline(input.outline);
      if (input.events.length) await savePlotEvents(input.events);
    },
  );
  return input.save.id;
}
