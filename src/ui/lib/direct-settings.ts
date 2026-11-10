import {
  getAgentSettings,
  patchAgentSettings,
  resolveAgentLlmParams,
  type AgentDefaultsLayer,
  type AgentSettingsEntry,
} from '../stores/agent-settings';
import { buildApiEndpoints, resolveAgentEndpoint } from './endpoint-resolver';
import { DIRECT_PRESET_ID, DIRECT_CACHED_PRESET_ID } from '@engine/prompts/direct-prompt';
import type { UiSettings } from '../stores/settings-types';

/** One-time snapshot of the story connection and effective parameters, never its prompt. */
export function initializeDirectSettings(settings: UiSettings, defaults: AgentDefaultsLayer): void {
  if (settings.directInitialized) return;
  const story = getAgentSettings(settings, 'story', defaults);
  const resolved = resolveAgentEndpoint({
    boundPoolId: story.model,
    apiPool: buildApiEndpoints(settings.apiPool),
  });
  if (resolved.status !== 'resolved') return;
  const previous: Partial<AgentSettingsEntry> = settings.agents.direct_main ?? {};
  patchAgentSettings(settings, 'direct_main', {
    model: resolved.endpoint.id,
    ...resolveAgentLlmParams(settings, 'story', defaults, resolved.endpoint.defaultParameters),
    historyLayers: story.historyLayers ?? 6,
    maxRetries: 0,
    ...previous,
  });
  settings.directPresetId ||= DIRECT_PRESET_ID;
  settings.directInitialized = true;
}

/** Settings profile only: execution and lore identity remain direct_main. */
export function initializeCachedDirectSettings(
  settings: UiSettings,
  defaults: AgentDefaultsLayer,
): void {
  initializeDirectSettings(settings, defaults);
  if (settings.directCachedInitialized || !settings.directInitialized) return;
  const current = getAgentSettings(settings, 'direct_main', defaults);
  patchAgentSettings(settings, 'direct_cached', {
    ...current,
    ...settings.agents.direct_cached,
    maxRetries: 0,
  });
  settings.directCachedPresetId ||= DIRECT_CACHED_PRESET_ID;
  settings.directCacheProvider ??= 'prefix';
  settings.directCachedInitialized = true;
}

export function isDirectSettingsProfile(id: string): boolean {
  return id === 'direct_main' || id === 'direct_cached';
}
