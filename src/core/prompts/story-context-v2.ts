/**
 * Story 上下文新模式（v2）的消息组装器（计划 §3.1 / §3.1.1 / §3.2 / §3.4）。
 *
 * 遍历 Story 预设：普通条目照常渲染，五个分区占位条目的位置填入该区已组装好的内容。
 * 产出的是**一组消息**，不是一条 system 字符串 —— 第 4 区保留真实的 user / assistant 角色。
 *
 * ── 分区内容（尚未冻结的部分都是临时规则，见计划 Q11 / P3 / P5）──
 *   第 1 区：`fixed` 分区条目（未声明分区、且无动态正文的条目按 `fixed` 处理）；没有可用
 *            普通条目（无预设 / 预设全空）时退回模板存根作为固定前缀。
 *   第 2 区：全部有效阶段归档的概括记录（历史年表），不按本轮话题筛选；被归档覆盖的摘要
 *            随之退出第 4 区。回退掉的归档按来源消息自动失效（计划 D20–D23）。
 *   第 3 区：`region` 分区条目，`activation.locations` 被当前地理路径任一层级包含时才
 *            进入；未命中当地区域的 region 条目作为本轮候选归第 5 区（判定见 `lore-selection.ts`）。
 *   第 4 区：窗口外全部未归档摘要（缺摘要的回合以原文顶上并明确标注）+ 最近 N 个完整回合原文。
 *   第 5 区：`lore_select` 筛选后的本轮候选与补充（含动态 EJS 条目）、剧情指引、相关回忆
 *            （新模式召回的展开结果）、角色状态、当前时空、随机事件候选（与旧预设
 *            `placeholder-context` 的本轮资料同一组来源，去掉了归第 4 区与玩家输入的部分）。
 *
 * ── 消息角色（Q11 临时规则）──
 *   第 4 区原文之前的一切（普通条目、第 1–3 区、第 4 区摘要）→ 前导 system 消息；
 *   第 4 区原文 → 逐回合 user / assistant；
 *   第 4 区原文之后的一切（普通条目、第 5 区）连同本轮玩家输入 → 末尾**一条** user 消息。
 *   这样 Claude / Gemini 适配器「会话中途不许出现 system」的限制天然满足，
 *   不需要靠挪动作者的条目位置去规避。
 *
 * ── 旧占位符（Q11 临时规则）──
 *   普通条目里归分区负责的旧占位符（`{{NARRATIVE}}` `{{USER_INPUT}}` `{{LORE_BOOK*}}`
 *   `{{AGENT.MEMORY_RECALL}}` 等）在新模式下渲染为空，避免与分区重复注入；
 *   条目里其余的指令文字原样保留，不删条目。
 *
 * 🔴 不走 Delta 会话：本模块每轮从当前状态完整组装（计划 §10.3）。
 * 🔴 EJS 世界书本轮只预渲染一次，同一份 pass 供第 1 区与第 5 区挑段。
 */
import type {
  AgentConfig,
  AgentContext,
  AgentPreset,
  ChatMessage,
  StoryArchiveRecord,
  StoryContextV2Diagnostics,
  StoryContextBudgetCategory,
  StoryContextBudgetRemoval,
  WorldBook,
} from '../types/types';
import { prerenderWorldBookEntries } from '../content/worldbook-loader';
import { buildEjsPassContext, getAgentTemplate, reportEjsFallback } from './agent-templates';
import { getPreset, preprocessEntry, preprocessPresetEntryContents } from './preset-loader';
import { createLoreReadContext } from '../content/lore-activation';
import { buildLoreDefinitions, missingLoreDefinitions } from '../content/lore-definitions';
import { resolveTemplateWithGlobals } from './template-resolver';
import {
  ensureStoryZonePlaceholders,
  isStoryZonePlaceholder,
  segmentPresetByStoryZones,
  type PresetEntryLike,
  type StoryZoneNumber,
} from './story-zone-placeholders';
import {
  archivedSegmentIdsOf,
  buildStoryZone4,
  resolveActiveStoryArchives,
  type StoryTurn,
  type StoryTurnSummarySegment,
} from '../memory/memory-context';
import { renderLongTermOverview } from '../memory/story-archive';

import { selectStoryLore, type LoreSelector } from '../content/lore-selection';

const STORY_AGENT_ID = 'story';

/** 普通条目里归分区负责的旧占位符：新模式下渲染为空（见文件头）。 */
const ZONE_OWNED_PLACEHOLDERS = [
  'NARRATIVE',
  'USER_INPUT',
  'LORE_BOOK',
  'LORE_BOOK_STATIC',
  'LORE_BOOK_DYNAMIC',
  'CHARACTER_STATE',
  'GAME_TIME',
  'RANDOM_EVENTS',
  'MEMORY_ENTRIES',
  'AGENT.MEMORY_RECALL',
  'AGENT.PLOT_PRE_CHECK',
] as const;

/** 第 5 区的资料块：标签 + 占位符。`null` 标签 = 占位符自带外壳。 */
const ZONE5_BLOCKS: ReadonlyArray<{ tag: string | null; placeholder: string }> = [
  { tag: '剧情指引', placeholder: 'AGENT.PLOT_PRE_CHECK' },
  // 新模式召回的展开结果（摘要 / 事件档案 / 来源原文，计划 §9）；召回为空时整块不出
  { tag: '相关回忆', placeholder: 'AGENT.MEMORY_RECALL' },
  { tag: '角色状态', placeholder: 'CHARACTER_STATE' },
  { tag: '当前时空', placeholder: 'GAME_TIME' },
  { tag: null, placeholder: 'RANDOM_EVENTS' },
];

type StoryContextV2Message = { role: 'system' | 'user' | 'assistant'; content: string };

export interface StoryContextV2Input {
  /** 本轮上下文：`history` 为本轮之前的正式消息，`userInput` 为本轮玩家输入 */
  ctx: AgentContext;
  configs: AgentConfig[];
  worldBooks: WorldBook[];
  presets: AgentPreset[];
  /** 正文窗口 N（正整数，非法时由 `buildStoryZone4` 抛 RangeError） */
  windowTurns: number;
  segments: readonly StoryTurnSummarySegment[];
  /** 本档全部阶段归档；有效性按 `ctx.history` 派生（回退掉的归档自动不算） */
  archives: readonly StoryArchiveRecord[];
  /** Estimated input character allowance after the actual provider output reserve. */
  budgetChars?: number;
  /** Actual request output reserve after provider overrides/omissions; not usage. */
  outputReservedTokens?: number;
  selectLore?: LoreSelector;
  onLore?: (diagnostics: import('../types/types').StoryLoreSelectionDiagnostics) => void;
}

export interface StoryContextV2Result {
  messages: StoryContextV2Message[];
  diagnostics: StoryContextV2Diagnostics;
}

function wrapBlock(tag: string, body: string): string {
  return `<${tag}>\n${body}\n</${tag}>`;
}

function turnUserText(turn: StoryTurn): string {
  return turn.userMessage?.content ?? '';
}

function turnStoryText(turn: StoryTurn): string {
  return turn.storyMessages.map((m: ChatMessage) => m.content).join('\n\n');
}

/** 第 4 区的摘要段（system 文本）。缺摘要的回合以原文顶上，并写明这是原文。 */
function renderZone4History(history: ReturnType<typeof buildStoryZone4>['history']): string {
  if (history.length === 0) return '';
  const lines = history.map((item) => {
    if (item.kind === 'summary') {
      const { eventName, content } = item.segment;
      return eventName ? `- 【${eventName}】${content}` : `- ${content}`;
    }
    const user = turnUserText(item.turn);
    const story = turnStoryText(item.turn);
    return [
      '- （本回合摘要缺失，以下为原文）',
      ...(user ? [`  玩家：${user}`] : []),
      `  正文：${story}`,
    ].join('\n');
  });
  return wrapBlock('前情摘要', lines.join('\n'));
}

/**
 * 组装新模式的 Story 消息。异步只因为世界书 EJS 预渲染；其余全是纯计算。
 */
export async function buildStoryContextV2Messages(
  input: StoryContextV2Input,
): Promise<StoryContextV2Result> {
  const { configs, worldBooks, presets } = input;
  const ctx: AgentContext = { ...input.ctx, loreReadContext: createLoreReadContext(input.ctx) };
  const config =
    configs.find((c) => c.agentId === STORY_AGENT_ID) ??
    ({
      agentId: STORY_AGENT_ID,
    } as AgentConfig);

  // ① 同一份 EJS pass：世界书正文本轮只预渲染一次，第 1 区与第 5 区从 memo 挑段
  const ejsPass = buildEjsPassContext(STORY_AGENT_ID, ctx, config, configs, worldBooks);
  const selection = await selectStoryLore(
    worldBooks,
    { ...ctx, agentConfig: config },
    input.selectLore,
  );
  for (const r of [...selection.zones[1], ...selection.zones[3], ...selection.zones[5]]) {
    if (
      r.entry.extra?.lore?.evaluation === 'onCreate' &&
      !Object.prototype.hasOwnProperty.call(ctx.fixedLore ?? {}, r.key)
    )
      throw new Error(`Missing opening lore snapshot: ${r.key}`);
  }
  // Blank lore memo while estimating non-lore blocks: no entry body may execute before pruning.
  ejsPass.loreRender = {
    agentId: STORY_AGENT_ID,
    staticText: '',
    dynamicText: '',
    fallbackEntries: [],
  };
  const tplCtx: AgentContext = {
    ...ctx,
    agentOutputs: new Map(ctx.agentOutputs),
    agentConfig: config,
    ejsPass,
  };

  const blankZoneOwned = Object.fromEntries(ZONE_OWNED_PLACEHOLDERS.map((name) => [name, '']));
  const renderEntryText = (text: string) =>
    resolveTemplateWithGlobals(text, STORY_AGENT_ID, tplCtx, config, worldBooks, configs, {
      ...blankZoneOwned,
    }).trim();
  const renderPlaceholder = (name: string) =>
    resolveTemplateWithGlobals(
      `{{${name}}}`,
      STORY_AGENT_ID,
      tplCtx,
      config,
      worldBooks,
      configs,
      {},
    ).trim();

  // ② 预设条目：补齐五区占位（读取视图），普通条目跨全部启用条目统一预处理 ST 宏
  const preset = config.presetId ? getPreset(config.presetId, presets) : undefined;
  const rawPrompts = (preset as { settings?: { prompts?: unknown } } | undefined)?.settings
    ?.prompts;
  const entries = ensureStoryZonePlaceholders(
    (Array.isArray(rawPrompts) ? rawPrompts : []) as PresetEntryLike[],
  ).entries;
  const normalEntries = entries.filter((e) => !isStoryZonePlaceholder(e) && e.enabled !== false);
  const processed = preprocessPresetEntryContents(normalEntries);
  const processedByEntry = new Map(normalEntries.map((e, i) => [e, processed[i]]));

  // 没有任何可用普通条目（无预设 / 预设全空）→ 沿用旧路径的兜底：模板存根作为固定前缀
  const hasNormalText = processed.some((text) => text.trim() !== '');
  const fallbackPrefix = hasNormalText
    ? ''
    : config.systemPrompt ||
      [
        getAgentTemplate(STORY_AGENT_ID)?.fixedSystem,
        getAgentTemplate(STORY_AGENT_ID)?.fixedExamples,
      ]
        .filter(Boolean)
        .join('\n\n');

  // ③ 各区内容
  const history = ctx.history ?? [];
  const activeArchives = resolveActiveStoryArchives(history, input.archives, input.segments);
  const zone4 = buildStoryZone4({
    messages: history,
    windowTurns: input.windowTurns,
    segments: input.segments,
    archivedSegmentIds: archivedSegmentIdsOf(activeArchives),
  });
  const budgetDroppedLoreKeys: string[] = [];
  const budgetRemovals: StoryContextBudgetRemoval[] = [];
  let budgetDroppedRecall = false;
  if (input.budgetChars !== undefined) {
    const nonLoreChars = () =>
      [
        fallbackPrefix,
        ...processed.map(renderEntryText),
        renderLongTermOverview(activeArchives),
        renderZone4History(zone4.history),
        ...zone4.windowTurns.flatMap((t) => [turnUserText(t) || '（开始）', turnStoryText(t)]),
        wrapBlock('玩家输入', ctx.userInput ?? ''),
        config.tailPrompt ?? '',
        ...ZONE5_BLOCKS.map(({ tag, placeholder }) => {
          const body = renderPlaceholder(placeholder);
          return body ? (tag ? wrapBlock(tag, body) : body) : '';
        }),
      ].reduce((sum, text) => sum + text.length, 0) + 256;
    const all = [...selection.zones[1], ...selection.zones[3], ...selection.zones[5]];
    const groups = [...selection.optionalGroups];
    const keys = () => new Set([...selection.mandatoryKeys, ...groups.flat()]);
    const estimate = () =>
      nonLoreChars() +
      all
        .filter((r) => keys().has(r.key))
        .reduce(
          (sum, r) =>
            sum +
            (r.entry.extra?.lore?.evaluation === 'onCreate'
              ? ctx.fixedLore![r.key].text.length
              : r.entry.content.length) +
            2,
          0,
        );
    // Drop whole optional roots with their dependency closure; shared/mandatory dependencies survive.
    while (groups.length && estimate() > input.budgetChars) groups.pop();
    if (estimate() > input.budgetChars && tplCtx.agentOutputs.get('memory_recall')) {
      const chars = wrapBlock('相关回忆', renderPlaceholder('AGENT.MEMORY_RECALL')).length;
      budgetRemovals.push({
        key: 'memory_recall',
        category: 'recall',
        reason: '移除可选资料后仍超出输入额度，省略本轮召回（不截原文）',
        chars,
        estimatedTokens: Math.ceil(chars / 1.5),
      });
      tplCtx.agentOutputs.delete('memory_recall');
      budgetDroppedRecall = true;
    }
    const keep = keys();
    for (const zone of [1, 3, 5] as const) {
      for (const r of selection.zones[zone].filter((r) => !keep.has(r.key))) {
        budgetDroppedLoreKeys.push(r.key);
        const chars = r.entry.content.length;
        budgetRemovals.push({
          key: r.key,
          category: zone === 1 ? 'fixed' : zone === 3 ? 'region' : 'turnLore',
          reason: 'EJS 前输入预算不足，按可选根及依赖组移除；必选/共享依赖保留',
          chars,
          estimatedTokens: Math.ceil(chars / 1.5),
        });
      }
      selection.zones[zone] = selection.zones[zone].filter((r) => keep.has(r.key));
    }
    selection.diagnostics.selectedKeys = selection.zones[5].map((r) => r.key);
    selection.diagnostics.budgetDroppedKeys = budgetDroppedLoreKeys;
    for (const decision of selection.diagnostics.decisions ?? []) {
      if (budgetDroppedLoreKeys.includes(decision.key)) {
        decision.outcome = 'excluded';
        decision.reason = 'budget-pruned';
        delete decision.zone;
      }
    }
  }
  input.onLore?.(selection.diagnostics);
  const activeRouted = [...selection.zones[1], ...selection.zones[3], ...selection.zones[5]];
  const activeEntries = activeRouted.map((r) => r.entry);
  const rendered = await prerenderWorldBookEntries(
    activeEntries.filter((entry) => entry.extra?.lore?.evaluation !== 'onCreate'),
    ejsPass,
  );
  ejsPass.loreRender = {
    agentId: STORY_AGENT_ID,
    staticText: rendered.staticText,
    dynamicText: rendered.dynamicText,
    fallbackEntries: rendered.fallbackEntries,
  };
  if (rendered.fallbackEntries.length)
    reportEjsFallback(STORY_AGENT_ID, ctx, rendered.fallbackEntries, worldBooks);
  const definitions = buildLoreDefinitions(
    STORY_AGENT_ID,
    worldBooks,
    ctx.loreReadContext!.recentText,
    ctx.loreReadContext,
    rendered.entryTexts,
  );
  const missingDefinitions: Record<string, string[]> = {};
  const loreTextByEntry = new Map(
    activeRouted.map((routed) => {
      const entry = routed.entry;
      if (entry.extra?.lore?.evaluation === 'onCreate')
        return [entry, ctx.fixedLore![routed.key].text] as const;
      const text = rendered.entryTexts.get(entry) ?? '';
      const missing = missingLoreDefinitions(text, definitions.values);
      if (missing.length) missingDefinitions[routed.key] = missing;
      return [entry, preprocessEntry(text, definitions.values)] as const;
    }),
  );
  const zoneLore = (zone: 1 | 3 | 5) =>
    selection.zones[zone]
      .map((r) => loreTextByEntry.get(r.entry) ?? '')
      .filter(Boolean)
      .join('\n\n');
  const zone1Lore = zoneLore(1);
  const zone5Blocks = ZONE5_BLOCKS.map(({ tag, placeholder }) => {
    const body = renderPlaceholder(placeholder);
    return { placeholder, text: body ? (tag ? wrapBlock(tag, body) : body) : '' };
  });
  const zoneText: Record<StoryZoneNumber, string> = {
    1: zone1Lore ? wrapBlock('世界设定', zone1Lore) : '',
    2: renderLongTermOverview(activeArchives),
    3: zoneLore(3) ? wrapBlock('区域资料', zoneLore(3)) : '',
    4: renderZone4History(zone4.history),
    5: [
      zoneLore(5) ? wrapBlock('本轮世界资料', zoneLore(5)) : '',
      ...zone5Blocks.map(({ text }) => text),
    ]
      .filter(Boolean)
      .join('\n\n'),
  };

  // ④ 遍历分段：第 4 区原文之前进前导 system，之后进末尾 user
  const leadingSystem: string[] = fallbackPrefix ? [fallbackPrefix] : [];
  const tailParts: string[] = [];
  let passedZone4 = false;
  for (const segment of segmentPresetByStoryZones(entries)) {
    if (segment.kind === 'entries') {
      const text = renderEntryText(
        segment.entries
          .map((e) => processedByEntry.get(e) ?? '')
          .filter((t) => t.trim() !== '')
          .join('\n'),
      );
      if (text) (passedZone4 ? tailParts : leadingSystem).push(text);
      continue;
    }
    if (segment.zone === 4) {
      if (zoneText[4]) leadingSystem.push(zoneText[4]);
      passedZone4 = true;
      continue;
    }
    const text =
      segment.zone === 5 && zoneText[5]
        ? wrapBlock('本轮参考资料', zoneText[5])
        : zoneText[segment.zone];
    if (text) (passedZone4 ? tailParts : leadingSystem).push(text);
  }

  // ⑤ 第 4 区原文：严格 user / assistant 交替（回合内多条正文合并为一条）
  const conversation: StoryContextV2Message[] = [];
  for (const turn of zone4.windowTurns) {
    const user = turnUserText(turn);
    // Claude / Gemini 要求会话以 user 开头且角色交替：开场只有正文的回合补一个占位输入
    conversation.push({ role: 'user', content: user || '（开始）' });
    conversation.push({ role: 'assistant', content: turnStoryText(turn) });
  }

  const tail = config.tailPrompt?.trim();
  const finalUser = [
    ...tailParts,
    wrapBlock('玩家输入', ctx.userInput ?? ''),
    ...(tail ? [tail] : []),
  ].join('\n\n');

  const messages: StoryContextV2Message[] = [
    ...leadingSystem.map((content) => ({ role: 'system' as const, content })),
    ...conversation,
    { role: 'user', content: finalUser },
  ];

  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  // 非原文类的结构标签与消息内分隔符也分类：第 5 区外壳归本轮事实，其余归固定模板。
  const rawFallbackChars = zone4.history.reduce(
    (sum, item) =>
      item.kind === 'missing'
        ? sum + renderZone4History([item]).length - wrapBlock('前情摘要', '').length
        : sum,
    0,
  );
  const turnLoreChars = zoneLore(5) ? wrapBlock('本轮世界资料', zoneLore(5)).length : 0;
  const recallChars =
    zone5Blocks.find((b) => b.placeholder === 'AGENT.MEMORY_RECALL')?.text.length ?? 0;
  const categoryChars: Record<StoryContextBudgetCategory, number> = {
    fixed: 0,
    longTerm: zoneText[2].length,
    region: zoneText[3].length,
    summary: zoneText[4].length - rawFallbackChars,
    rawHistory: rawFallbackChars + conversation.reduce((sum, m) => sum + m.content.length, 0),
    turnLore: turnLoreChars,
    recall: recallChars,
    currentFactsAndDirections:
      (zoneText[5] ? wrapBlock('本轮参考资料', zoneText[5]).length : 0) -
      turnLoreChars -
      recallChars +
      wrapBlock('玩家输入', ctx.userInput ?? '').length,
    outputReserve: 0,
  };
  categoryChars.fixed =
    totalChars - Object.values(categoryChars).reduce((sum, chars) => sum + chars, 0);
  const budgetCategories = Object.fromEntries(
    Object.entries(categoryChars).map(([category, chars]) => [
      category,
      {
        chars,
        estimatedTokens:
          category === 'outputReserve' ? (input.outputReservedTokens ?? 0) : Math.ceil(chars / 1.5),
      },
    ]),
  ) as NonNullable<StoryContextV2Diagnostics['budgetCategories']>;

  return {
    messages,
    diagnostics: {
      ...(input.outputReservedTokens !== undefined
        ? { outputReservedTokens: input.outputReservedTokens }
        : {}),
      loreDefinitions: { deferredKeys: definitions.deferredKeys, missing: missingDefinitions },
      budgetCategories,
      budgetRemovals,
      budgetDroppedLoreKeys,
      budgetDroppedRecall,
      loreKeysByZone: {
        1: selection.zones[1].map((r) => r.key),
        3: selection.zones[3].map((r) => r.key),
        5: selection.zones[5].map((r) => r.key),
      },
      windowTurns: input.windowTurns,
      archiveIds: activeArchives.map((a) => a.id),
      windowTurnKeys: zone4.windowTurns.map((t) => t.key),
      summarySegmentIds: zone4.history.flatMap((h) => (h.kind === 'summary' ? [h.segment.id] : [])),
      missingSummaryTurnKeys: zone4.missingSummaryTurns.map((t) => t.key),
      zoneChars: {
        1: zoneText[1].length,
        2: zoneText[2].length,
        3: zoneText[3].length,
        4: zoneText[4].length + conversation.reduce((sum, m) => sum + m.content.length, 0),
        5: zoneText[5].length,
      },
      totalChars,
    },
  };
}
