/**
 * 预设加载器 (Phase 8)
 *
 * 职责:
 * - 从 data/presets/ 加载预设 JSON 文件
 * - 将预设格式化为 Prompt 的「预设」部分
 */

import type { AgentPreset } from './types';

/** 预设文件路径前缀 */
const PRESET_BASE = '/data/presets/';

/**
 * 从 data/presets/ 加载所有预设
 */
export async function loadPresets(): Promise<AgentPreset[]> {
  // 预设索引从服务器端点获取，或硬编码预设文件名列表
  // 当前通过 fetch 逐个加载
  const presetIds = await fetchPresetIds();
  const presets: AgentPreset[] = [];
  for (const id of presetIds) {
    try {
      const response = await fetch(`${PRESET_BASE}${id}.json`);
      if (!response.ok) continue;
      const preset = await response.json() as AgentPreset;
      presets.push(preset);
    } catch {
      // 加载失败，跳过
    }
  }
  return presets;
}

/** 获取预设 ID 列表 */
async function fetchPresetIds(): Promise<string[]> {
  try {
    const response = await fetch(`${PRESET_BASE}_index.json`);
    if (response.ok) {
      return await response.json() as string[];
    }
  } catch {
    // 无索引文件
  }
  return [];
}

/** 同步版：从预加载数据获取预设 */
export function loadPresetsSync(
  preloaded: Record<string, AgentPreset>,
): AgentPreset[] {
  return Object.values(preloaded);
}

/** 获取指定预设 */
export function getPreset(
  id: string,
  presets: AgentPreset[],
): AgentPreset | undefined {
  return presets.find(p => p.id === id);
}

/**
 * Phase 10: Assemble preset content from prompts[] entries.
 * If the assembled content doesn't contain any of our placeholders ({{SYS_PROMPT}}, {{NARRATIVE}}, etc.),
 * auto-append the default context block so old ST presets get dynamic context injection.
 *
 * @param preset - The AgentPreset to assemble
 * @param defaultContextBlock - Default context placeholders to append if missing
 * @returns Assembled preset content string
 */
export function assemblePresetContent(
  preset: AgentPreset,
  defaultContextBlock?: string,
): string {
  const prompts = (preset as any).settings?.prompts;
  if (!prompts || !Array.isArray(prompts)) {
    // No prompts array — use fixedSystem/fixedExamples
    return [preset.fixedSystem, preset.fixedExamples].filter(Boolean).join('\n\n');
  }

  // Sort by injection_order, filter enabled
  const sorted = [...prompts]
    .filter((p: any) => p.enabled !== false)
    .sort((a: any, b: any) => (a.injection_order ?? 0) - (b.injection_order ?? 0));

  const content = sorted.map((p: any) => p.content || '').join('\n');

  // Check if content already has our placeholder syntax
  const hasOurPlaceholders = /\{\{(?:SYS_PROMPT|NARRATIVE|USER_INPUT|LORE_BOOK|CHARACTER_STATE|AGENT\.|INVENTORY|GAME_TIME|ACTIVE_EFFECTS|MEMORY_ENTRIES|PLOT_EVENTS)\b/.test(content);

  if (hasOurPlaceholders) {
    return content;
  }

  // Auto-append default context block for old presets
  const contextBlock = defaultContextBlock || DEFAULT_STORY_CONTEXT_BLOCK;
  return content + '\n' + contextBlock;
}

/** Default context block for Story Agent — appended to old ST presets without placeholders */
export const DEFAULT_STORY_CONTEXT_BLOCK = [
  '{{AGENT.MEMORY_RECALL}}',
  '{{AGENT.PLOT_PRE_CHECK}}',
  '{{LORE_BOOK}}',
  '{{CHARACTER_STATE}}',
  '{{GAME_TIME}}',
  '{{NARRATIVE}}',
  '{{USER_INPUT}}',
].join('\n');

/**
 * 将预设格式化为 Prompt 的「预设」部分
 * 拼接 fixedSystem + fixedExamples
 */
export function buildPresetSection(preset: AgentPreset): string {
  const parts: string[] = [];

  if (preset.fixedSystem) {
    parts.push(preset.fixedSystem);
  }
  if (preset.fixedExamples) {
    parts.push('---\n' + preset.fixedExamples);
  }

  return parts.join('\n\n');
}
