/**
 * 预设生效总览 + 逐条 token 估算（给 UI 用，纯读、不改入参）。
 *
 * 生效判据与 `assemblePresetContent` **同一份**：`listActivePresetPrompts`（条目自身
 * `enabled !== false` + 露骨内容开关、排除 assistant 与五区占位、按 `injection_order` 排序、
 * **不读 `prompt_order`**）。token 口径是 `estimateTokens`（字符数 / 1.5 向上取整）。
 *
 * 计数规则：
 * - `{{setvar::名::值}}` 本身不产出文本；变量值的成本**归因**到生效的那条 setvar 条目上：
 *   值的 token × 已启用条目里 `{{getvar::名}}` 的出现次数。读取方的 getvar 按替换成空串计。
 *   被后面的 setvar 覆盖、或没人读取的定义记 0，并打上 `overridden` / `unread`。
 * - `{{random::A,B}}` 按最长的一项计（选项分隔与引擎 `resolveRandoms` 一致：逗号）。
 * - 注释宏 / roll / 未知宏按引擎剥离记 0；系统占位符（`{{LORE_BOOK_STATIC}}` 等）记 0。
 * - 行内 `<nsfw>` / `<sfw>` 按当前开关过滤后再计（请求出口会这样过滤）。
 * - assistant 条目只在末尾预填充生效时（`getPresetPrefill` 非空）单独列一行（`prefill: true`）。
 * - 未生效条目的 `tokensIfEnabled`：若它是互斥组成员，假设同组其他成员都已停用（本条成为生效定义），
 *   因为在 UI 上选中它就意味着别的选项被关掉；非组条目按「只多启用这一条」计。
 *
 * 不变式：`entries` 的 `tokens` 之和恒等于 `totalTokens`。拼接用的换行与旧预设自动追加的
 * 默认上下文块（全是系统占位符）不计。`prompts` 不是数组的老式 `fixedSystem` 预设返回空总览。
 */

import { applyNsfwMode, isPresetPromptActive, nsfwEnabled } from '../content/nsfw-filter';
import type { AgentPreset, ChatPreset } from '../types/types';
import { estimateTokens } from '../utils/token-estimate';
import {
  PRESET_SYSTEM_PLACEHOLDER_RE,
  getPresetPrefill,
  hasSTMacros,
  listActivePresetPrompts,
  parseSetvars,
  preprocessEntry,
} from './preset-loader';
import { readPresetGroups } from './preset-groups';
import { isStoryZonePlaceholder } from './story-zone-placeholders';

/** 未生效原因：自身关闭 / 露骨内容开关关闭时被排除的 `nsfw: true` 条目。 */
type PresetInactiveReason = 'disabled' | 'nsfw';

export interface PresetEntryInsight {
  identifier: string;
  name?: string;
  active: boolean;
  /** 生效时为 `null` */
  inactiveReason: PresetInactiveReason | null;
  /** 当前实际计入的 token（未生效为 0） */
  tokens: number;
  /** 假如单独启用这一条时它这一行的 token（已生效时等于 `tokens`） */
  tokensIfEnabled: number;
  /** 本条 `{{setvar}}` 定义的变量名（无则缺席） */
  defines?: string[];
  /** 生效条目：至少一个定义被后面的 setvar 覆盖 */
  overridden?: boolean;
  /** 生效条目：至少一个生效的定义没有任何已启用条目读取 */
  unread?: boolean;
  /** 末尾预填充的 assistant 条目（只在预填充生效时出现） */
  prefill?: true;
}

export interface PresetInsightSummary {
  entries: PresetEntryInsight[];
  activeCount: number;
  totalCount: number;
  totalTokens: number;
}

type PromptLike = {
  identifier?: unknown;
  name?: unknown;
  role?: unknown;
  enabled?: unknown;
  nsfw?: unknown;
  content?: unknown;
  injection_order?: number;
};

const SYSTEM_PLACEHOLDER_GLOBAL_RE = new RegExp(PRESET_SYSTEM_PLACEHOLDER_RE.source, 'g');
const GETVAR_RE = /\{\{getvar::([^}:]+)(?:::)?\}\}/g;
const RANDOM_RE = /\{\{random::([^}]*)\}\}/g;

/** 与 `resolveRandoms` 同样切分，取最长一项（估算上界）。 */
function longestRandoms(content: string): string {
  return content.replace(RANDOM_RE, (_m, options: string) => {
    const parts = options
      .split(',')
      .map((s) => s.replace(/^\s+|\s+$/g, ''))
      .filter(Boolean);
    return parts.reduce((best, p) => (p.length > best.length ? p : best), '');
  });
}

interface EntryAnalysis {
  /** 本条自身文本的 token（getvar 按空串、setvar 剥离） */
  ownTokens: number;
  /** 本条 setvar：名 → 值（同条内后者覆盖） */
  setvars: Map<string, string>;
  /** 本条 getvar 读取次数：名 → 次数 */
  reads: Map<string, number>;
}

function analyzeEntry(raw: string, preprocess: boolean, nsfwOn: boolean): EntryAnalysis {
  let text: string;
  if (preprocess) {
    // 空变量表 = 所有 getvar 替换为空串；random 预先换成最长项，引擎管线其余步骤原样照走。
    const clean = raw.trim() ? preprocessEntry(longestRandoms(raw), {}) : '';
    text = clean.trim() ? clean : '';
  } else {
    text = raw;
  }
  text = applyNsfwMode(text.replace(SYSTEM_PLACEHOLDER_GLOBAL_RE, ''), nsfwOn);

  const setvars = new Map<string, string>();
  const reads = new Map<string, number>();
  if (preprocess) {
    const vars = parseSetvars(raw).variables;
    for (const key of Object.keys(vars)) setvars.set(key, vars[key]);
    for (const m of raw.matchAll(GETVAR_RE)) {
      const key = m[1].trim();
      reads.set(key, (reads.get(key) ?? 0) + 1);
    }
  }
  return { ownTokens: estimateTokens(text), setvars, reads };
}

function contentOf(p: PromptLike): string {
  return typeof p.content === 'string' ? p.content : '';
}

function baseRow(p: PromptLike): Pick<PresetEntryInsight, 'identifier' | 'name'> {
  return {
    identifier: typeof p.identifier === 'string' ? p.identifier : '',
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
  };
}

/** 逐条汇总预设的生效状态与 token 估算（见文件头的计数规则）。 */
export function summarizePresetEntries(
  preset: AgentPreset | null | undefined,
): PresetInsightSummary {
  const rawPrompts = (preset as { settings?: { prompts?: unknown } } | null | undefined)?.settings
    ?.prompts;
  if (!Array.isArray(rawPrompts)) {
    return { entries: [], activeCount: 0, totalCount: 0, totalTokens: 0 };
  }
  const nsfwOn = nsfwEnabled();

  // 候选 = 除生效判据外与引擎同口径的条目（对象、非占位、非 assistant），稳定排序。
  const candidates = (rawPrompts as unknown[])
    .filter(
      (p): p is PromptLike =>
        p !== null &&
        typeof p === 'object' &&
        !isStoryZonePlaceholder(p as PromptLike) &&
        (p as PromptLike).role !== 'assistant',
    )
    .sort((a, b) => (a.injection_order ?? 0) - (b.injection_order ?? 0));
  const active = new Set<PromptLike>(listActivePresetPrompts<PromptLike>(rawPrompts));
  const needsPreprocessing = [...active].some((p) => hasSTMacros(contentOf(p)));

  const analyses = candidates.map((p) => {
    const raw = contentOf(p);
    const preprocess = active.has(p) ? needsPreprocessing : needsPreprocessing || hasSTMacros(raw);
    return analyzeEntry(raw, preprocess, nsfwOn);
  });

  // 已启用条目（可排除一批 identifier）：每个变量的生效定义（最后一条）与总读取次数。
  const tally = (exclude?: ReadonlySet<string>) => {
    const definer = new Map<string, number>();
    const reads = new Map<string, number>();
    candidates.forEach((p, i) => {
      if (!active.has(p)) return;
      if (exclude && typeof p.identifier === 'string' && exclude.has(p.identifier)) return;
      for (const key of analyses[i].setvars.keys()) definer.set(key, i);
      for (const [key, n] of analyses[i].reads) reads.set(key, (reads.get(key) ?? 0) + n);
    });
    return { definer, reads };
  };
  const { definer: effectiveDefiner, reads: readCount } = tally();

  // 互斥组：identifier → 同组全部成员；「假如选中这一项」时整组其余成员视为停用。
  // 本条自身未生效，把整组都排除与只排除其余成员结果相同，所以按组缓存一份统计。
  const groupOf = new Map<string, ReadonlySet<string>>();
  for (const group of readPresetGroups(preset as unknown as ChatPreset)) {
    const members = new Set(group.options.map((o) => o.identifier));
    for (const id of members) groupOf.set(id, members);
  }
  const groupTally = new Map<ReadonlySet<string>, ReturnType<typeof tally>>();
  const tallyFor = (p: PromptLike) => {
    const members = typeof p.identifier === 'string' ? groupOf.get(p.identifier) : undefined;
    if (!members) return { definer: effectiveDefiner, reads: readCount };
    let t = groupTally.get(members);
    if (!t) {
      t = tally(members);
      groupTally.set(members, t);
    }
    return t;
  };
  const valueTokens = (value: string) => estimateTokens(applyNsfwMode(value, nsfwOn));

  const entries: PresetEntryInsight[] = candidates.map((p, i) => {
    const a = analyses[i];
    const defines = [...a.setvars.keys()];
    const row: PresetEntryInsight = {
      ...baseRow(p),
      active: false,
      inactiveReason: null,
      tokens: 0,
      tokensIfEnabled: 0,
      ...(defines.length > 0 ? { defines } : {}),
    };
    if (active.has(p)) {
      let tokens = a.ownTokens;
      let overridden = false;
      let unread = false;
      for (const [key, value] of a.setvars) {
        if (effectiveDefiner.get(key) !== i) {
          overridden = true;
          continue;
        }
        const reads = readCount.get(key) ?? 0;
        if (reads === 0) unread = true;
        tokens += valueTokens(value) * reads;
      }
      row.active = true;
      row.tokens = tokens;
      row.tokensIfEnabled = tokens;
      if (defines.length > 0) {
        row.overridden = overridden;
        row.unread = unread;
      }
    } else {
      row.inactiveReason = p.enabled === false ? 'disabled' : 'nsfw';
      // 假设启用这一条（组成员则同组其余成员停用）：它的定义若不被更后面的已启用定义覆盖，
      // 则按（现有读取 + 自身读取）计。
      const t = tallyFor(p);
      let tokens = a.ownTokens;
      for (const [key, value] of a.setvars) {
        const definer = t.definer.get(key);
        if (definer !== undefined && definer > i) continue;
        const reads = (t.reads.get(key) ?? 0) + (a.reads.get(key) ?? 0);
        tokens += valueTokens(value) * reads;
      }
      row.tokensIfEnabled = tokens;
    }
    return row;
  });

  // 末尾预填充：与 `findTailAssistantEntry` 同口径定位那条 assistant 条目。
  const prefill = getPresetPrefill(preset);
  if (prefill) {
    const enabledAll = (rawPrompts as unknown[])
      .filter(
        (p): p is PromptLike =>
          p !== null && typeof p === 'object' && isPresetPromptActive(p as PromptLike),
      )
      .sort((a, b) => (a.injection_order ?? 0) - (b.injection_order ?? 0));
    const tail = enabledAll[enabledAll.length - 1];
    const tokens = estimateTokens(applyNsfwMode(prefill.content, nsfwOn));
    entries.push({
      ...(tail ? baseRow(tail) : { identifier: '' }),
      active: true,
      inactiveReason: null,
      tokens,
      tokensIfEnabled: tokens,
      prefill: true,
    });
  }

  const activeEntries = entries.filter((e) => e.active);
  return {
    entries,
    activeCount: activeEntries.length,
    totalCount: entries.length,
    totalTokens: entries.reduce((sum, e) => sum + e.tokens, 0),
  };
}
