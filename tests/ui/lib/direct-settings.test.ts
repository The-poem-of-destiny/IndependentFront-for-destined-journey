import { describe, expect, it } from 'vitest';
import {
  initializeDirectSettings,
  initializeCachedDirectSettings,
} from '../../../src/ui/lib/direct-settings';
import { checkJourneyReadiness } from '../../../src/ui/lib/journey-readiness';
import type { UiSettings } from '../../../src/ui/stores/settings-types';

describe('direct settings', () => {
  it('snapshots the effective story connection and parameters once without copying the story prompt', () => {
    const settings = {
      agents: { story: { model: 'ep', temperature: 0.8, systemPrompt: 'delegate everything' } },
      apiPool: [
        {
          id: 'ep',
          model: 'test',
          baseUrl: 'http://localhost:1234/v1',
          apiType: 'chat',
          defaultParameters: { maxTokens: 4096, topP: 0.7 },
        },
      ],
      activePresetId: 'story-preset',
    } as unknown as UiSettings;
    initializeDirectSettings(settings, {});
    expect(settings.agents.direct_main).toMatchObject({
      model: 'ep',
      temperature: 0.8,
      topP: 0.7,
      maxTokens: 4096,
      historyLayers: 6,
      maxRetries: 0,
    });
    expect(settings.agents.direct_main?.systemPrompt).toBeUndefined();
    expect(settings.directPresetId).toBe('direct-generation-v1');
    settings.agents.story.temperature = 0.1;
    initializeDirectSettings(settings, {});
    expect(settings.agents.direct_main?.temperature).toBe(0.8);
    expect(settings.activePresetId).toBe('story-preset');
  });
  it('ignores stale non-memory Agent bindings only when creating a direct save', () => {
    const settings = {
      agents: { request_dispatcher: { model: 'deleted' } },
      apiPool: [{ id: 'ep', model: 'test', baseUrl: 'http://localhost:1234/v1', apiType: 'chat' }],
    };
    expect(checkJourneyReadiness(settings, {}, 'off', 'direct')).toEqual([]);
    expect(checkJourneyReadiness(settings, {}, 'off', 'agent')).toContainEqual(
      expect.objectContaining({ blocking: true }),
    );
  });
});

it('keeps the cached profile and preset independent after initialization', () => {
  const settings = {
    agents: { direct_main: { model: 'ep', temperature: 0.6 } },
    directInitialized: true,
    directPresetId: 'custom-direct',
    apiPool: [{ id: 'ep', model: 'test', baseUrl: 'http://localhost:1234/v1', apiType: 'chat' }],
  } as unknown as UiSettings;
  initializeCachedDirectSettings(settings, {});
  expect(settings.agents.direct_cached).toMatchObject({
    model: 'ep',
    temperature: 0.6,
    maxRetries: 0,
  });
  settings.agents.direct_cached.model = 'cached-ep';
  settings.directCachedPresetId = 'cached-preset';
  initializeCachedDirectSettings(settings, {});
  expect(settings.agents.direct_main.model).toBe('ep');
  expect(settings.directPresetId).toBe('custom-direct');
  expect(settings.directCachedPresetId).toBe('cached-preset');
  expect(checkJourneyReadiness(settings, {}, 'off', 'direct_cached')).toContainEqual(
    expect.objectContaining({ blocking: true }),
  );
});
