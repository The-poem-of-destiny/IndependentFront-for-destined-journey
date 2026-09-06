import {
  getDatabase,
  saveCharacter,
  saveSaveSlot,
  savePlotOutline,
  savePlotEvents,
} from './database';
import { getProfile, addFP, updateProfile } from './save-profile';
import type { CharacterState, SaveSlot, PlotOutline, PlotEvent } from './types';

/** Publish a complete new journey, or leave no records behind on failure. */
export async function createJourney(input: {
  character: CharacterState;
  save: SaveSlot;
  era: string;
  experienceMode: 'normal' | 'easy';
  destinyPoints: number;
  outline?: PlotOutline;
  events: PlotEvent[];
}): Promise<string> {
  const db = getDatabase();
  await db.transaction(
    'rw',
    [db.characters, db.saves, db.saveProfiles, db.plotOutlines, db.plotEvents],
    async () => {
      await saveCharacter(input.character);
      await saveSaveSlot(input.save);
      const profile = await getProfile(input.save.id, input.era);
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
