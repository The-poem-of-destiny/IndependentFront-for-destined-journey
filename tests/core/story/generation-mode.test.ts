import { describe, expect, it } from 'vitest';
import {
  requireGenerationMode,
  resolveGenerationMode,
} from '../../../src/core/story/generation-mode';
import type { SaveSlot } from '../../../src/core/types/types';

describe('save generation mode', () => {
  it('keeps untagged saves on Agent and resolves tagged saves independently', () => {
    const save = (mode?: 'agent' | 'direct') =>
      ({ metadata: { generationMode: mode } }) as SaveSlot;
    expect(resolveGenerationMode(save())).toBe('agent');
    expect(resolveGenerationMode(save('direct'))).toBe('direct');
    expect(resolveGenerationMode(save('agent'))).toBe('agent');
  });

  it('requires an explicit valid choice for creation', () => {
    for (const value of [undefined, null, '', 'unknown'])
      expect(() => requireGenerationMode(value)).toThrow();
    expect(() => requireGenerationMode('agent')).not.toThrow();
    expect(() => requireGenerationMode('direct')).not.toThrow();
  });
});
