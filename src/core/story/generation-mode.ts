import type { SaveSlot } from '../types/types';

export type GenerationMode = 'agent' | 'direct' | 'direct_cached';

export function resolveGenerationMode(
  save: Pick<SaveSlot, 'metadata'> | null | undefined,
): GenerationMode {
  return save?.metadata.generationMode ?? 'agent';
}

export const GENERATION_MODE_LABELS: Record<GenerationMode, string> = {
  agent: 'Agent 模式',
  direct: '直出（无缓存优化）',
  direct_cached: '直出（缓存优化）',
};

export function requireGenerationMode(value: unknown): asserts value is GenerationMode {
  if (value !== 'agent' && !isDirectMode(value))
    throw new Error('请选择本存档的生成模式，创建后不可更改');
}

export function isDirectMode(value: unknown): value is 'direct' | 'direct_cached' {
  return value === 'direct' || value === 'direct_cached';
}
