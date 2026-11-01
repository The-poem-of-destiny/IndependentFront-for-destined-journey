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
import {
  attachCharacterDefinition,
  matchCharacterDefinition,
  withoutCharacterLore,
} from '../character/character-definitions';
import { authorChronicle } from '../character/character-chronicle';

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
                filterBooksByEnabledEntries(
                  withoutCharacterLore(
                    input.worldBooks ?? [],
                    input.save.metadata.characterDefinitions ?? [],
                  ),
                  input.save.metadata.enabledWorldBookEntries ?? [],
                ),
                { characterName: input.character.name, userName: input.save.metadata.userName },
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
      const character = definition
        ? attachCharacterDefinition(input.character, definition)
        : input.character;
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
