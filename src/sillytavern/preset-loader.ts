/**
 * 预设加载器 (Phase 8 + Phase 10)
 *
 * 职责:
 * - 从 data/presets/ 加载预设 JSON 文件
 * - 将预设格式化为 Prompt 的「预设」部分
 * - Phase 10: 解析 ST 占位符宏
 *   - {{setvar::name::value}} → 收集变量表 + 剥离标签
 *   - {{getvar::name}} → 用变量表做纯文本替换
 *   - {{random::A,B,C}} → 运行时随机选一
 *   - {{//注释}} / {{roll ...}} / 未知占位符 → 剥离
 *   - {{char}} / {{user}} → 替换为角色名/用户名
 *   - EJS (<%.*%>) → 保留原样
 */

import type { AgentPreset } from './types';

// 🪦 D28（波 1 T2）: `PRESET_BASE = '/data/presets/'` 常量已删（死路径，见文件尾注释）。

// ═══════════════════════════════════════════════════════════
// Phase 10: ST 占位符预处理
//
// ST preset 使用三种核心占位符来实现"条件内容注入"：
//
//   {{setvar::变量名::变量值}}  — 声明/赋值变量
//   {{getvar::变量名}}          — 读取变量值（在 EJS 外使用）
//   {{random::A,B,C}}          — 随机选一个值
//
// 工作机制（以思维预算为例）：
//   条目 54 开启 → {{setvar::思维预算c::No more than 4096 words.}}
//                  {{setvar::思维预算g::至少3000字中文}}
//                  {{setvar::思维预算d::3000字以上}}
//   COT 条目     → 思维链预算: {{getvar::思维预算c}}
//   → 替换后     → 思维链预算: No more than 4096 words.
//
// 同名 setvar 后者覆盖，实现"互斥条目"语义（同类条目只开一个）。
// ═══════════════════════════════════════════════════════════

/** setvar 变量表: key → value (同名后者覆盖) */
export interface SetvarMap {
  [key: string]: string;
}

/**
 * 从内容中解析 {{setvar::name::value}}，收集到变量表（后者覆盖），
 * 并剥离所有 {{setvar}} 标签。
 */
export function parseSetvars(content: string): { variables: SetvarMap; stripped: string } {
  const variables: SetvarMap = {};
  const stripped = content.replace(
    /\{\{setvar::([^:}]+)::([^}]*)\}\}/g,
    (_match, name: string, value: string) => {
      const key = name.trim();
      // 有值的 setvar 写入变量表，后者覆盖；空值只是声明，不写入
      if (value.length > 0) {
        variables[key] = value;
      }
      return '';
    },
  );
  return { variables, stripped };
}

/**
 * 替换 {{getvar::name}} 和 {{getvar::name::}}（带尾双冒号）
 * 查变量表替换为对应值，表里没有的 key → 替换为空字符串
 */
export function resolveGetvars(content: string, vars: SetvarMap): string {
  return content.replace(/\{\{getvar::([^}:]+)(?:::)?\}\}/g, (_match, name: string) => {
    const key = name.trim();
    return vars[key] ?? '';
  });
}

/**
 * 替换 {{random::A,B,C,D}} → 随机选一个
 * 支持逗号分隔的选项列表
 */
export function resolveRandoms(content: string): string {
  return content.replace(/\{\{random::([^}]*)\}\}/g, (_match, options: string) => {
    // 去掉两侧空白和尾逗号
    const trimmed = options.replace(/^\s+|\s+$/g, '');
    if (!trimmed) return '';
    const parts = trimmed
      .split(',')
      .map((s) => s.replace(/^\s+|\s+$/g, ''))
      .filter(Boolean);
    if (parts.length === 0) return '';
    const idx = Math.floor(Math.random() * parts.length);
    return parts[idx];
  });
}

/**
 * 替换 {{char}} / {{user}}
 */
export function replaceCharUser(
  content: string,
  opts?: { characterName?: string; userName?: string },
): string {
  return content
    .replace(/\{\{char\}\}/gi, opts?.characterName ?? '{{CHARACTER_NAME}}')
    .replace(/\{\{user\}\}/gi, opts?.userName ?? '{{USER_NAME}}');
}

/**
 * Phase 10: 单条目预处理管线
 *
 * 处理顺序:
 *   1. {{char}}/{{user}} 先替换（必须在剥离未知占位符之前做）
 *   2. {{getvar::name}} → 查变量表替换
 *   3. {{random::A,B,C}} → 随机选一
 *   4. {{setvar::...}} → 剥离
 *   5. {{//注释}} → 剥离
 *   6. {{roll ...}} → 剥离
 *   7. 其他非系统 {{...}} → 剥离
 *
 * @param content - 条目原文
 * @param vars - 已收集的 setvar 变量表
 * @param opts - char/user 替换名
 * @returns 处理后纯文本
 */
export function preprocessEntry(
  content: string,
  vars: SetvarMap,
  opts?: { characterName?: string; userName?: string },
): string {
  let result = content;

  // 1. 替换 {{char}} / {{user}}
  result = replaceCharUser(result, opts);

  // 2. 替换 {{getvar::name}} → 查表
  result = resolveGetvars(result, vars);

  // 3. 替换 {{random::A,B,C}} → 随机选一
  result = resolveRandoms(result);

  // 4. 剥离 {{setvar::...}}
  result = result.replace(/\{\{setvar::[^}]*\}\}/g, '');

  // 5. 剥离 {{//注释}}
  result = result.replace(/\{\{\/\/[^}]*\}\}/g, '');

  // 6. 剥离 {{roll ...}}
  result = result.replace(/\{\{roll\s+[^}]*\}\}/gi, '');

  // 7. 剥离其他非系统 {{...}} 占位符
  const SYSTEM_RE =
    /\{\{(?:SYS_PROMPT|NARRATIVE|USER_INPUT|LORE_BOOK|LORE_BOOK_STATIC|LORE_BOOK_DYNAMIC|CHARACTER_STATE|AGENT\.\w+|INVENTORY|GAME_TIME|ACTIVE_EFFECTS|MEMORY_ENTRIES|PLOT_EVENTS|CRAFT_REQUEST|CHAR_DETECT|CHAR_GEN_RESULT|CRAFT_RESULT|ITEM_REQUEST|USER_NAME|CHARACTER_NAME)\}\}/;
  result = result.replace(/\{\{([^}]+)\}\}/g, (match) => {
    if (SYSTEM_RE.test(match)) return match;
    return '';
  });

  return result;
}

/** 检查内容是否包含任何需要预处理的 ST 宏 */
export function hasSTMacros(content: string): boolean {
  return /\{\{(?:setvar::|getvar::|random::|\/\/|roll\s|char\}\}|user\}\})/.test(content);
}

// ═══════════════════════════════════════════════════════════
// 同步版加载（Vite import.meta.glob 预加载对象）
// ═══════════════════════════════════════════════════════════

// 🪦 D28（波 1 T2）: `PRESET_BASE` 常量 + 异步 `loadPresets()` + `fetchPresetIds()` 已删。
// 此前它们从 `/data/presets/` fetch——该目录在生产构建里不存在（§1.1），整条路径是死的，
// 零生产引用。预设真源是 `data/defaults/agent-config.json` 内嵌的 preset + Dexie `presets` 表。
// `loadPresetsSync`（从预加载对象取）保留——它是纯函数，被 preset-loader.test.ts 覆盖。

/** 同步版：从预加载数据获取预设 */
export function loadPresetsSync(preloaded: Record<string, AgentPreset>): AgentPreset[] {
  return Object.values(preloaded);
}

/** 获取指定预设 */
export function getPreset(id: string, presets: AgentPreset[]): AgentPreset | undefined {
  return presets.find((p) => p.id === id);
}

/**
 * Phase 10: Assemble preset content from prompts[] entries.
 *
 * 两遍扫描管线:
 *   Pass 1 — 遍历所有 enabled 条目，收集 {{setvar}} → 变量表 (后者覆盖)
 *   Pass 2 — 逐条目做纯文本替换 (getvar/random/char/user) + 剥离 (setvar/注释/roll/未知)
 *
 * EJS (<%.*%>) 保留原样，不做任何处理。
 *
 * If the resulting content lacks our placeholder syntax, auto-append the default context block.
 */
export function assemblePresetContent(
  preset: AgentPreset,
  defaultContextBlock?: string,
  opts?: { characterName?: string; userName?: string },
): string {
  const prompts = (preset as any).settings?.prompts;
  if (!prompts || !Array.isArray(prompts)) {
    return [preset.fixedSystem, preset.fixedExamples].filter(Boolean).join('\n\n');
  }

  // Sort by injection_order, filter enabled
  const sorted = [...prompts]
    .filter((p: any) => p.enabled !== false)
    .sort((a: any, b: any) => (a.injection_order ?? 0) - (b.injection_order ?? 0));

  // 快速检查：是否有任何条目需要预处理
  const needsPreprocessing = sorted.some((p: any) => hasSTMacros(p.content || ''));

  let content: string;
  if (needsPreprocessing) {
    // Pass 1: 收集所有 setvar → 变量表 (后者覆盖)
    const vars: SetvarMap = {};
    for (const p of sorted) {
      const raw = p.content || '';
      const result = parseSetvars(raw);
      Object.assign(vars, result.variables);
    }

    // Pass 2: 逐条目替换 + 剥离
    const processed: string[] = [];
    for (const p of sorted) {
      const raw = p.content || '';
      if (!raw.trim()) continue;
      const clean = preprocessEntry(raw, vars, opts);
      if (clean.trim()) {
        processed.push(clean);
      }
    }
    content = processed.join('\n');
  } else {
    content = sorted.map((p: any) => p.content || '').join('\n');
  }

  // Check if content already has our placeholder syntax
  // ⚠️ `LORE_BOOK\b` 匹配不到 `{{LORE_BOOK_STATIC}}`（`\b` 在 `_` 前不成立），
  //    故两个裸名分区占位符必须显式列出，否则只用它们的预设会被误判为「无占位符」而被追加默认块。
  const hasOurPlaceholders =
    /\{\{(?:SYS_PROMPT|NARRATIVE|USER_INPUT|LORE_BOOK_STATIC|LORE_BOOK_DYNAMIC|LORE_BOOK|CHARACTER_STATE|AGENT\.|INVENTORY|GAME_TIME|ACTIVE_EFFECTS|MEMORY_ENTRIES|PLOT_EVENTS)\b/.test(
      content,
    );

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
  '{{LORE_BOOK_STATIC}}',
  '{{CHARACTER_STATE}}',
  '{{LORE_BOOK_DYNAMIC}}',
  '{{GAME_TIME}}',
  '{{NARRATIVE}}',
  '{{USER_INPUT}}',
].join('\n');

/**
 * 将预设格式化为 Prompt 的「预设」部分
 * 拼接 fixedSystem + fixedExamples
 */
/**
 * Phase 10: 预设预览预处理
 *
 * 与 assemblePresetContent 的完整预处理不同，此函数仅解析确定性的宏
 * （setvar → 剥离、getvar → 替换），但保留运行时才知道的占位符：
 *   - {{random::...}} → 原样保留
 *   - {{char}} / {{user}} → 原样保留
 *   - {{//注释}} / {{roll ...}} → 剥离
 *   - 系统占位符 → 原样保留
 *
 * 用于前端模板预览面板，让用户看到"预设内容 + setvar/getvar 展开"
 * 同时还能看到系统占位符 badge。
 */
export function preprocessPresetForPreview(
  preset: AgentPreset,
  _opts?: { characterName?: string; userName?: string },
): string {
  const prompts = (preset as any).settings?.prompts;
  if (!prompts || !Array.isArray(prompts)) return '';

  const sorted = [...prompts]
    .filter((p: any) => p.enabled !== false)
    .sort((a: any, b: any) => (a.injection_order ?? 0) - (b.injection_order ?? 0));

  // Pass 1: 收集所有 setvar → 变量表 (后者覆盖)
  const vars: SetvarMap = {};
  for (const p of sorted) {
    const raw = p.content || '';
    Object.assign(vars, parseSetvars(raw).variables);
  }

  // Pass 2: 逐条目处理 — 只做确定性替换，保留运行时占位符
  const processed: string[] = [];
  for (const p of sorted) {
    let content = p.content || '';
    if (!content.trim()) continue;

    // 1. 不替换 {{char}}/{{user}} — 原样保留

    // 2. 替换 {{getvar::name}} → 查表
    content = resolveGetvars(content, vars);

    // 3. 不替换 {{random::...}} — 原样保留

    // 4. 剥离 {{setvar::...}}
    content = content.replace(/\{\{setvar::[^}]*\}\}/g, '');

    // 5. 剥离 {{//注释}}
    content = content.replace(/\{\{\/\/[^}]*\}\}/g, '');

    // 6. 剥离 {{roll ...}}
    content = content.replace(/\{\{roll\s+[^}]*\}\}/gi, '');

    // 7. 剥离未知占位符，但保留已知系统占位符 + random + char + user
    const SYSTEM_RE =
      /\{\{(?:SYS_PROMPT|NARRATIVE|USER_INPUT|LORE_BOOK|LORE_BOOK_STATIC|LORE_BOOK_DYNAMIC|CHARACTER_STATE|AGENT\.\w+|INVENTORY|GAME_TIME|ACTIVE_EFFECTS|MEMORY_ENTRIES|PLOT_EVENTS|CRAFT_REQUEST|CHAR_DETECT|CHAR_GEN_RESULT|CRAFT_RESULT|ITEM_REQUEST|USER_NAME|CHARACTER_NAME)\}\}/;
    const PRESERVE_RE = /\{\{(?:random::|char\}\}|user\}\})/i;
    content = content.replace(/\{\{([^}]+)\}\}/g, (match: string) => {
      if (SYSTEM_RE.test(match)) return match;
      if (PRESERVE_RE.test(match)) return match;
      return '';
    });

    if (content.trim()) {
      processed.push(content);
    }
  }

  return processed.join('\n');
}

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
