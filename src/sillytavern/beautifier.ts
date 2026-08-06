/**
 * 输出美化器 — 正则替换管道 (Beautifier)
 *
 * Phase 7e: 对 AI 生成的叙事文本进行基于正则的后处理美化。
 * Phase 10i: 预设规则库 (beautifier-rules.json) + 世界书/角色绑定 auto-enable。
 *
 * 设计决策:
 * - 纯函数模块，无副作用，无外部依赖
 * - 规则替换保持原样，由 UI 的网络可用 opaque iframe 承担执行边界
 * - 编译失败静默跳过，不阻断管道
 */

import type { BeautifierRule } from './types';
import { reportContentFetch } from './content-source';

// ========== Helpers ==========

/**
 * 将字符串中的 HTML 特殊字符转义为实体。
 * 用于内置规则中防止 AI 输出内容被浏览器解析为 HTML。
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 🔒 仅转义 & < >（不转义引号）— 用于 beautifier 处理原始模型文本 (P1-01)。
 *
 * 规则 pattern 可能依赖原文引号（如内置对话卡片规则匹配 `("对话")` 里的 `"`），
 * 若把引号也转义成 `&quot;` 会破坏匹配；而在纯文本上下文里引号不构成注入 ——
 * 原文的标签已被 `<` `>` 转义废掉，残留的引号只是字面字符。
 *
 * 与 escapeHtml 的区别：后者额外转义 `"` `'`，用于属性值等需要引号安全的场景。
 */
export function escapeHtmlBasic(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ========== Built-in Rules (Legacy) ==========

/**
 * 返回内置美化规则列表。
 *
 * @deprecated Phase 10i: 内置规则已迁移到 data/defaults/beautifier-rules.json。
 *   请使用 loadPresetRules() + mergeRules() 获取完整规则列表。
 *   此函数保留仅用于向后兼容，未来版本将移除。
 */
export function getBuiltinRules(): BeautifierRule[] {
  return [
    {
      id: 'builtin-dialogue-card',
      name: '对话卡片',
      scope: 'maintext',
      pattern: '\\[([^\\]]+)\\](?:\\{([^}]*)\\})?\\(\\"([^\\"]*)\\"\\)',
      flags: 'gm',
      replacement:
        '<div class="dialogue-card">' +
        '<div class="dialogue-header">' +
        '<span class="dialogue-avatar">$1</span>' +
        '<span class="dialogue-name">$1</span>' +
        '</div>' +
        '<div class="dialogue-body">"$3"</div>' +
        '</div>',
      enabled: true,
      order: 0,
      isBuiltin: true,
    },
    {
      id: 'builtin-kill-proliferation',
      name: '杀增殖',
      scope: 'global',
      pattern: '极其|由于',
      flags: 'gi',
      replacement: '',
      enabled: false,
      order: 1,
      isBuiltin: true,
    },
  ];
}

// ========== Preset Rules ==========

/**
 * 从 beautifier-rules.json 加载预设规则库。
 *
 * @returns 预设规则列表（含内置 + 远程导入的规则）
 */
export async function loadPresetRules(): Promise<BeautifierRule[]> {
  try {
    const resp = await fetch('/data/defaults/beautifier-rules.json');
    if (!resp.ok) {
      // 内容-引擎分离（波 1 T2 / §5.5 census）：上报内容态，不阻塞启动。
      reportContentFetch({ source: 'beautifier.loadPresetRules', status: resp.status, ok: false });
      console.warn('[Beautifier] 预设规则加载失败，回退到 getBuiltinRules():', resp.status);
      return getBuiltinRules();
    }
    const data = await resp.json();
    const raw: any[] = data?.rules ?? [];
    const rules = raw.map(
      (r: any) =>
        ({
          id: r.id,
          name: r.name,
          scope: r.scope ?? 'maintext',
          pattern: r.pattern,
          flags: r.flags ?? 'g',
          replacement: r.replacement,
          enabled: r.defaultEnabled ?? false,
          order: r.order ?? 99,
          isBuiltin: r.isBuiltin ?? true,
          minDepth: Number.isFinite(r.minDepth) ? r.minDepth : undefined,
          maxDepth: Number.isFinite(r.maxDepth) ? r.maxDepth : undefined,
          autoEnable: r.autoEnable,
          group: r.group,
          locked: false,
        }) satisfies BeautifierRule,
    );
    reportContentFetch({ source: 'beautifier.loadPresetRules', status: resp.status, ok: true });
    return rules;
  } catch (err) {
    reportContentFetch({
      source: 'beautifier.loadPresetRules',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    console.warn('[Beautifier] 预设规则加载异常，回退到 getBuiltinRules():', err);
    return getBuiltinRules();
  }
}

// ========== Auto-Enable Resolution ==========

/**
 * 从存档的 enabledWorldBookEntries（格式 'system_core:413'）提取 autoEnable 信号。
 *
 * 这是 autoEnable 的正确信号源 —— 命定核心/启用角色是**存档级**选择
 * （存于 save.metadata.enabledWorldBookEntries），不等于 worldBooks 条目的 enabled
 * （后者是「是否注入 prompt」的开关，核心书里几乎全 enabled，用它会让所有绑核心的规则恒亮）。
 *
 * @param enabledEntries 存档启用的条目 ID 列表（partition:uid）
 */
export function collectActiveSignalsFromEntries(enabledEntries: string[]): {
  activeWorldBookIds: Set<string>;
  activeEntryUids: Set<number>;
} {
  const activeWorldBookIds = new Set<string>();
  const activeEntryUids = new Set<number>();
  for (const id of enabledEntries) {
    const i = id.indexOf(':');
    if (i < 0) continue;
    const partition = id.slice(0, i);
    const uid = Number(id.slice(i + 1));
    if (!Number.isNaN(uid)) {
      activeEntryUids.add(uid);
      activeWorldBookIds.add(partition);
    }
  }
  return { activeWorldBookIds, activeEntryUids };
}

/**
 * 根据活跃世界书和角色，自动启用匹配的预设规则。
 *
 * 匹配逻辑:
 * - worldBookIds: 任一条目 ID 在活跃世界书集合中 → 匹配
 * - worldBookEntryUids: 任一条目 UID 已启用 → 匹配
 * - characterNames: 任一名字在活跃角色集合中 → 匹配
 * - 以上条件为 OR：任意一个维度匹配即启用
 *
 * 纯函数，不修改原数组。
 *
 * @param rules            预设规则列表
 * @param activeWorldBookIds 活跃世界书的 ID 集合
 * @param activeWorldBookEntryUids 活跃世界书条目的 UID 集合
 * @param activeCharacterNames 活跃角色名集合
 * @returns 处理后的规则列表（locked 字段已置位）
 */
export function resolveAutoEnable(
  rules: BeautifierRule[],
  activeWorldBookIds: Set<string>,
  activeWorldBookEntryUids: Set<number>,
  activeCharacterNames: Set<string>,
): BeautifierRule[] {
  return rules.map((rule) => {
    const ae = rule.autoEnable;
    if (!ae) return rule;

    let matched = false;

    // 检查 worldBookIds
    if (ae.worldBookIds?.length) {
      for (const id of ae.worldBookIds) {
        if (activeWorldBookIds.has(id)) {
          matched = true;
          break;
        }
      }
    }

    // 检查 worldBookEntryUids
    if (!matched && ae.worldBookEntryUids?.length) {
      for (const uid of ae.worldBookEntryUids) {
        if (activeWorldBookEntryUids.has(uid)) {
          matched = true;
          break;
        }
      }
    }

    // 检查 characterNames
    if (!matched && ae.characterNames?.length) {
      for (const name of ae.characterNames) {
        if (activeCharacterNames.has(name)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      return { ...rule, enabled: true, locked: true };
    }
    return rule;
  });
}

// ========== Rule Merging ==========

/**
 * 合并预设规则、用户规则和禁用列表，返回最终的规则列表。
 *
 * 合并逻辑:
 * 1. 预设规则默认状态 → 应用 auto-enable 覆盖
 * 2. `builtinDisabled` 是历史字段名，现表示「相对内置默认值翻转」的规则 ID；
 *    因而既能关掉默认开启规则，也能开启默认关闭规则（locked 除外）
 * 3. 用户自定义规则追加（同名 ID 用户优先）
 *
 * @param presetRules      loadPresetRules() 返回的预设规则
 * @param userRules        用户自定义规则
 * @param builtinDisabled  用户手动禁用的规则 ID 列表
 * @param activeWorldBookIds 活跃世界书 ID 集合
 * @param activeWorldBookEntryUids 活跃世界书条目 UID 集合
 * @param activeCharacterNames 活跃角色名集合
 * @returns 合并后的规则列表
 */
export function mergeRules(
  presetRules: BeautifierRule[],
  userRules: BeautifierRule[],
  builtinDisabled: string[],
  activeWorldBookIds: Set<string>,
  activeWorldBookEntryUids: Set<number>,
  activeCharacterNames: Set<string>,
): BeautifierRule[] {
  // Step 1: 解析 auto-enable
  const resolved = resolveAutoEnable(
    presetRules,
    activeWorldBookIds,
    activeWorldBookEntryUids,
    activeCharacterNames,
  );

  // Step 2: 应用用户手动覆盖。字段名沿用历史契约，但语义是默认状态 XOR，
  // 否则 21 条 defaultEnabled=false 的预设永远无法从设置页开启。
  const overrideSet = new Set(builtinDisabled);
  const merged = resolved.map((r) => {
    if (r.locked) return r;
    if (overrideSet.has(r.id)) return { ...r, enabled: !r.enabled };
    return r;
  });

  // Step 3: 追加用户规则（同名 ID 覆盖预设）
  const presetIds = new Set(merged.map((r) => r.id));
  const uniqueUserRules = userRules.filter((r) => !presetIds.has(r.id));

  return [...merged, ...uniqueUserRules];
}

// ========== Processing Pipeline ==========

export interface BeautifierTextSegment {
  kind: 'text';
  /** Raw unmatched source. Escaping is deferred to serialization. */
  text: string;
}

export interface BeautifierMatchSegment {
  kind: 'match';
  ruleId: string;
  ruleName: string;
  /**
   * Who authored the markup in `replacement`.
   *
   * - `rule` —— 用户装过的规则（内置预设 / 用户自建 / 工坊）。信任级别 = 用户自己选的。
   * - `model` —— 本轮模型输出里合成出来的卡片（`<item_info>` / `<task_info>`）。
   *
   * 两者的隔离契约**不同**：模型正文会被世界书 / 角色卡 / 工坊文案里的注入牵着走，
   * 所以渲染面必须给 `model` 片段关掉脚本执行与共享正则存储（见
   * `BeautifiedNarrative.vue` 与 `beautifier-frame.ts` 的 `scripts` 策略）。
   */
  origin: 'rule' | 'model';
  /** Zero-based occurrence within this rule, in source order. */
  occurrence: number;
  /** Raw full match and capture groups for structured renderers. */
  source: string;
  captures: string[];
  /** Rule replacement after capture expansion; rule-authored markup is retained verbatim. */
  replacement: string;
}

export type BeautifierSegment = BeautifierTextSegment | BeautifierMatchSegment;

export interface BeautifierCompileOptions {
  /** Zero-based conversational depth from the newest user/assistant message. */
  depth?: number;
}

const CARD_PATTERN = /<\s*(item_info|task_info)\s*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;

/**
 * 单条规则在一条正文上、**仅越界重试分支**允许扫过的字符数上限。
 *
 * 只卡这一个分支是刻意的：正常命中的 `exec` 一找到就返回，成本与正文长度不成正比，
 * 拿总量卡它会误伤「长正文 + 多命中」的正经规则。见 `findEligibleMatches`。
 */
const MAX_OVERLAP_SCAN_CHARS_PER_RULE = 5_000_000;

function appendText(segments: BeautifierSegment[], text: string): void {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.kind === 'text') previous.text += text;
  else segments.push({ kind: 'text', text });
}

function nextOccurrence(occurrences: Map<string, number>, ruleId: string): number {
  const occurrence = occurrences.get(ruleId) ?? 0;
  occurrences.set(ruleId, occurrence + 1);
  return occurrence;
}

/** Native JavaScript replacement-string expansion (`$$`, `$&`, `$1..$99`, named groups, etc.). */
function expandReplacement(
  template: string,
  match: RegExpExecArray,
  input: string,
  matchIndex: number,
): string {
  const captures = match.slice(1).map((capture) => String(capture ?? ''));
  return template.replace(/\$([$&'`]|\d{1,2}|<[^>]*>)/g, (token, marker: string) => {
    if (marker === '$') return '$';
    if (marker === '&') return match[0];
    if (marker === '`') return input.slice(0, matchIndex);
    if (marker === "'") return input.slice(matchIndex + match[0].length);
    if (marker.startsWith('<')) {
      if (!match.groups) return token;
      return String(match.groups[marker.slice(1, -1)] ?? '');
    }

    const index = Number(marker);
    if (index > 0 && index <= captures.length) return captures[index - 1];
    if (marker.length === 2) {
      const first = Number(marker[0]);
      if (first > 0 && first <= captures.length) return `${captures[first - 1]}${marker[1]}`;
    }
    return token;
  });
}

function advanceStringIndex(text: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= text.length) return index + 1;
  const first = text.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff) return index + 1;
  const second = text.charCodeAt(index + 1);
  return second >= 0xdc00 && second <= 0xdfff ? index + 2 : index + 1;
}

function findMatches(text: string, expression: RegExp): RegExpExecArray[] {
  const matcher = new RegExp(expression.source, expression.flags);
  if (!matcher.global) {
    const match = matcher.exec(text);
    return match ? [match] : [];
  }

  const matches: RegExpExecArray[] = [];
  const unicode = matcher.flags.includes('u') || matcher.flags.includes('v');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    matches.push(match);
    if (match[0] === '') {
      matcher.lastIndex = advanceStringIndex(text, matcher.lastIndex, unicode);
    }
  }
  return matches;
}

interface TextRange {
  segmentIndex: number;
  start: number;
  end: number;
}

interface EligibleMatch {
  segmentIndex: number;
  localIndex: number;
  match: RegExpExecArray;
}

function projectSegments(segments: BeautifierSegment[]): {
  text: string;
  ranges: TextRange[];
} {
  let text = '';
  const ranges: TextRange[] = [];
  segments.forEach((segment, segmentIndex) => {
    if (segment.kind === 'match') {
      text += `\x00BEAUTIFY_${segmentIndex}\x00`;
      return;
    }
    const start = text.length;
    text += segment.text;
    ranges.push({ segmentIndex, start, end: text.length });
  });
  return { text, ranges };
}

function findEligibleMatches(
  projection: string,
  ranges: TextRange[],
  expression: RegExp,
): EligibleMatch[] {
  if (expression.sticky) {
    const found = findMatches(projection, expression);
    const eligible: EligibleMatch[] = [];
    for (const match of found) {
      const end = match.index + match[0].length;
      const range = ranges.find(
        ({ start, end: rangeEnd }) => match.index >= start && end <= rangeEnd,
      );
      if (!range) continue;
      eligible.push({
        segmentIndex: range.segmentIndex,
        localIndex: match.index - range.start,
        match,
      });
      if (!expression.global) break;
    }
    return eligible;
  }

  const flags = expression.global ? expression.flags : `${expression.flags}g`;
  const matcher = new RegExp(expression.source, flags);
  const unicode = matcher.flags.includes('u') || matcher.flags.includes('v');
  const eligible: EligibleMatch[] = [];
  let overlapScan = 0;

  for (const range of ranges) {
    let searchIndex = range.start;
    while (searchIndex <= range.end) {
      matcher.lastIndex = searchIndex;
      const match = matcher.exec(projection);
      if (!match || match.index > range.end) break;
      const matchEnd = match.index + match[0].length;
      if (matchEnd <= range.end) {
        eligible.push({
          segmentIndex: range.segmentIndex,
          localIndex: match.index - range.start,
          match,
        });
        if (!expression.global) return eligible;
        searchIndex =
          match[0] === ''
            ? advanceStringIndex(projection, matcher.lastIndex, unicode)
            : matcher.lastIndex;
        continue;
      }

      // 越界重试是**二次方**的：匹配从范围内起头、却越过范围尾（撞上前一条规则留下的
      // 占位符），只能退一个字符重来，而贪婪模式每次都会一路扫到正文末尾。给这个分支
      // 记账并封顶，让病态 pattern 退化成「少匹配几处」而不是卡死渲染线程。正常命中
      // 不经过这里，所以「长正文 + 多命中」的正经规则不受影响。
      overlapScan += projection.length - match.index;
      if (overlapScan > MAX_OVERLAP_SCAN_CHARS_PER_RULE) return eligible;
      searchIndex = advanceStringIndex(projection, match.index, unicode);
    }
  }

  return eligible;
}

function extractCardSegments(text: string, occurrences: Map<string, number>): BeautifierSegment[] {
  const segments: BeautifierSegment[] = [];
  let cursor = 0;
  CARD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CARD_PATTERN.exec(text)) !== null) {
    appendText(segments, text.slice(cursor, match.index));
    const tag = match[1].toLowerCase();
    const inner = match[2];
    const ruleId = `builtin:${tag}`;
    segments.push({
      kind: 'match',
      ruleId,
      ruleName: tag,
      // 卡片正文是**本轮模型输出**，不是用户装过的规则；渲染面据此收紧隔离契约。
      origin: 'model',
      occurrence: nextOccurrence(occurrences, ruleId),
      source: match[0],
      captures: [inner],
      replacement: `<div class="st-card st-${tag}">${inner}</div>`,
    });
    cursor = match.index + match[0].length;
  }
  appendText(segments, text.slice(cursor));
  if (segments.length === 0) segments.push({ kind: 'text', text: '' });
  return segments;
}

function applyRule(
  segments: BeautifierSegment[],
  rule: BeautifierRule,
  expression: RegExp,
  occurrences: Map<string, number>,
): BeautifierSegment[] {
  const { text: projection, ranges } = projectSegments(segments);
  const eligible = findEligibleMatches(projection, ranges, expression);
  if (eligible.length === 0) return segments;

  const bySegment = new Map<number, EligibleMatch[]>();
  for (const found of eligible) {
    const group = bySegment.get(found.segmentIndex);
    if (group) group.push(found);
    else bySegment.set(found.segmentIndex, [found]);
  }

  const next: BeautifierSegment[] = [];
  segments.forEach((segment, segmentIndex) => {
    if (segment.kind === 'match') {
      next.push(segment);
      return;
    }

    const found = bySegment.get(segmentIndex);
    if (!found) {
      appendText(next, segment.text);
      return;
    }

    let cursor = 0;
    for (const { localIndex, match } of found) {
      appendText(next, segment.text.slice(cursor, localIndex));
      const captures = match.slice(1).map((capture) => String(capture ?? ''));
      next.push({
        kind: 'match',
        ruleId: rule.id,
        ruleName: rule.name,
        origin: 'rule',
        occurrence: nextOccurrence(occurrences, rule.id),
        source: match[0],
        captures,
        replacement: expandReplacement(rule.replacement, match, segment.text, localIndex),
      });
      cursor = localIndex + match[0].length;
    }
    appendText(next, segment.text.slice(cursor));
  });

  return next;
}

/**
 * Compile raw narrative into unmatched text and one structured segment per matched rule occurrence.
 * Rules run in ascending order and can only consume unmatched text; prior replacements stay opaque.
 */
export function compileBeautifierSegments(
  text: string,
  scope: string,
  rules: BeautifierRule[],
  options: BeautifierCompileOptions = {},
): BeautifierSegment[] {
  const occurrences = new Map<string, number>();
  let segments = extractCardSegments(text, occurrences);
  const depth = options.depth ?? 0;
  const active = rules
    .filter(
      (rule) =>
        rule.enabled &&
        (rule.scope === 'global' || rule.scope === scope) &&
        (rule.minDepth === undefined || depth >= rule.minDepth) &&
        (rule.maxDepth === undefined || depth <= rule.maxDepth),
    )
    .sort((left, right) => left.order - right.order);

  for (const rule of active) {
    try {
      segments = applyRule(segments, rule, new RegExp(rule.pattern, rule.flags), occurrences);
    } catch {
      // Invalid rules are inert and do not block the remaining pipeline.
    }
  }

  return segments;
}

/** Serialize compiled segments to the legacy HTML string consumed by existing callers. */
export function serializeBeautifierSegments(segments: readonly BeautifierSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === 'text' ? escapeHtmlBasic(segment.text) : segment.replacement,
    )
    .join('');
}

/**
 * 对文本应用指定 scope 的活跃规则。
 *
 * 处理流程:
 * 1. 筛选 scope 匹配（或 global）且 enabled 的规则
 * 2. 按 order 升序排序
 * 3. 依次编译正则，把每次匹配保留为独立结构化片段
 *    - 替换字符串按原生 JavaScript 语义展开（`$1..$99`、`$&`、`$$` 等）
 *    - 捕获内容不清洗；富文本片段由 UI 放入隔离 iframe
 * 4. 编译失败静默跳过
 *
 * 🔴 **返回值不是可直接 `v-html` 的安全 HTML。** 未命中正文会转义，但匹配片段的
 * `replacement`（含未转义的捕获内容）原样拼进来 —— 隔离边界在渲染面
 * （`BeautifiedNarrative` 的 per-match iframe），不在这个字符串里。
 * 渲染路径请用 `compileBeautifierSegments()`；本函数只服务测试与非 DOM 消费者。
 *
 * @param text  原始文本
 * @param scope 当前处理的作用域（maintext / options / summary / thinking）
 * @param rules 全量规则列表（含内置 + 用户）
 * @returns 处理后的文本
 */
export function processRules(
  text: string,
  scope: string,
  rules: BeautifierRule[],
  options: BeautifierCompileOptions = {},
): string {
  return serializeBeautifierSegments(compileBeautifierSegments(text, scope, rules, options));
}
