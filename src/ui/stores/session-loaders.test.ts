import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import * as database from '@engine/database';
import { useSceneImageStore } from './scene-image-store';
import { useCharacterAppearanceStore } from './character-appearance-store';

beforeEach(() => setActivePinia(createPinia()));

describe('page-owned image projections', () => {
  it.each(['images', 'appearances'] as const)(
    'a late %s load cannot replace a newer save',
    async (kind) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy =
        kind === 'images'
          ? vi.spyOn(database, 'getSceneImages').mockImplementation(async (id) => {
              if (id === 'a') await gate;
              return [];
            })
          : vi.spyOn(database, 'getCharacterAppearances').mockImplementation(async (id) => {
              if (id === 'a') await gate;
              return [];
            });
      const store = kind === 'images' ? useSceneImageStore() : useCharacterAppearanceStore();
      try {
        const first = store.load('a');
        await store.load('b');
        release();
        await first;
        expect(store.activeSaveId).toBe('b');
      } finally {
        release();
        spy.mockRestore();
      }
    },
  );
});
