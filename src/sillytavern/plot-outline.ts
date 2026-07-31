/**
 * 剧情大纲管理 — CRUD + AI 生成 + 自检 + 事件树生成
 *
 * Phase 4 核心模块。职责:
 * 1. 生成剧情大纲（AI-driven）
 * 2. 大纲自检（AI 评估精彩程度）
 * 3. 大纲 → 事件树转换
 * 4. 世界线变动时更新大纲
 */

import type { PlotOutline, PlotSettings, PlotEvent, CharacterState } from './types';
import { getLatestPlotOutline, savePlotOutline, getPlotEvents, savePlotEvents } from './database';

// ========== 大纲生成 ==========

export interface GenerateOutlineInput {
  saveId: string;
  settings: PlotSettings;
  characters: CharacterState[];
  /** 世界设定文本（从世界书中提取） */
  worldSettings?: string;
  /** 用户自定义偏好 */
  userInput?: string;
}

/** plot_outline Agent 输出的结构化 JSON/XML 形状（chapters[].keyEvents 用于 Code 层生成事件树） */
export interface ParsedOutlineOutput {
  title: string;
  summary: string;
  /** 大纲覆盖的时间范围（AI 的 SeasonalTime 格式，如 "488-春"；createOutlineFromAgent 优先用它，入参作兜底） */
  timeRange?: { start: string; end: string };
  content: string;
  /** 大方向锚（核心张力 / 主角主题 / 关键关系人）— post_check 演化时的「不偏离」判据 */
  directionAnchors?: string;
  chapters: Array<{
    title: string;
    summary: string;
    /** 此大事件涉及的关键 NPC 议程（去中心化行动线索，自然语言多议程描述；主要 depth 0 大事件用） */
    npcAgendas?: string;
    /** 主角不介入时，该态势的世界默认演化（反事实基线；主要 depth 0 大事件用） */
    ifAbsent?: string;
    keyEvents: Array<{
      title: string;
      description: string;
      triggerHint?: string;
      /** 事件时间窗口（季节性，如 "512-春" 到 "512-夏"） */
      timeWindow?: { start: string; end: string };
      /** 完成条件提示 */
      completeHint?: string;
      /** 失败条件提示 */
      failHint?: string;
    }>;
  }>;
  selfCritique?: string;
}

function formatSelfCritique(sc?: {
  score: number;
  strengths?: string[];
  weaknesses?: string[];
  suggestions?: string[];
}): string | undefined {
  if (!sc) return undefined;
  return `评分: ${sc.score}/10\n优点: ${sc.strengths?.join('; ')}\n不足: ${sc.weaknesses?.join('; ')}\n建议: ${sc.suggestions?.join('; ')}`;
}

interface RawOutlineJson {
  title?: string;
  summary?: string;
  content: string;
  timeRange?: { start: string; end: string };
  directionAnchors?: string;
  chapters?: Array<{
    title?: string;
    summary?: string;
    npcAgendas?: string;
    ifAbsent?: string;
    keyEvents?: Array<{
      title?: string;
      description?: string;
      triggerHint?: string;
      timeWindow?: { start: string; end: string };
      completeHint?: string;
      failHint?: string;
    }>;
  }>;
  selfCritique?: {
    score: number;
    strengths?: string[];
    weaknesses?: string[];
    suggestions?: string[];
  };
}

function normalizeOutlineJson(parsed: RawOutlineJson): ParsedOutlineOutput | null {
  if (!parsed.content) return null;
  return {
    title: parsed.title || '',
    summary: parsed.summary || '',
    content: parsed.content,
    timeRange: parsed.timeRange,
    directionAnchors: parsed.directionAnchors,
    chapters: Array.isArray(parsed.chapters)
      ? parsed.chapters
          .filter((ch) => ch && ch.title)
          .map((ch) => ({
            title: ch.title!,
            summary: ch.summary || '',
            npcAgendas: ch.npcAgendas,
            ifAbsent: ch.ifAbsent,
            keyEvents: Array.isArray(ch.keyEvents)
              ? ch.keyEvents
                  .filter((ke) => ke && ke.title)
                  .map((ke) => ({
                    title: ke.title!,
                    description: ke.description || '',
                    triggerHint: ke.triggerHint,
                    timeWindow: ke.timeWindow,
                    completeHint: ke.completeHint,
                    failHint: ke.failHint,
                  }))
              : [],
          }))
      : [],
    selfCritique: formatSelfCritique(parsed.selfCritique),
  };
}

/** 解析 plot_outline Agent 的 JSON 输出 */
export function parseOutlineJson(rawOutput: string): ParsedOutlineOutput | null {
  try {
    return normalizeOutlineJson(JSON.parse(rawOutput) as RawOutlineJson);
  } catch {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return normalizeOutlineJson(JSON.parse(jsonMatch[0]) as RawOutlineJson);
    } catch {
      return null;
    }
  }
}

/** @deprecated 使用 parseOutlineJson 或 tryParseOutline */
export const parseOutlineAgentOutput = parseOutlineJson;

// ========== XML 解析 ==========

/** 用非贪婪正则提取一对 XML 标签的内容（不含标签本身） */
function extractXmlTag(content: string, tag: string): { text: string; rest: string } {
  const regex = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\/\\s*${tag}\\s*>`, 'i');
  const match = content.match(regex);
  if (!match) return { text: '', rest: content };
  return { text: match[1], rest: content.replace(regex, '') };
}

/** 用非贪婪正则提取带属性的 XML 标签内容 */
function extractXmlTagWithAttrs(
  content: string,
  tag: string,
  attrs: string[],
): { text: string; attrs: Record<string, string>; rest: string } {
  const attrPattern = attrs.map((a) => `\\s+${a}\\s*=\\s*"([^"]*)"`).join('') || '\\s*';
  const regex = new RegExp(`<\\s*${tag}${attrPattern}\\s*>([\\s\\S]*?)<\\/\\s*${tag}\\s*>`, 'i');
  const match = content.match(regex);
  if (!match) return { text: '', attrs: {}, rest: content };
  const result: Record<string, string> = {};
  for (let i = 0; i < attrs.length; i++) {
    result[attrs[i]] = match[i + 1] || '';
  }
  return { text: match[attrs.length + 1], attrs: result, rest: content.replace(regex, '') };
}

/** 提取自闭合标签的属性（如 <timerange start="..." end="..." />） */
function extractSelfClosingAttrs(
  content: string,
  tag: string,
  attrs: string[],
): { attrs: Record<string, string>; rest: string } | null {
  const attrPattern = attrs.map((a) => `\\s+${a}\\s*=\\s*"([^"]*)"`).join('');
  const regex = new RegExp(`<\\s*${tag}${attrPattern}\\s*\\/>`, 'i');
  const match = content.match(regex);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (let i = 0; i < attrs.length; i++) {
    result[attrs[i]] = match[i + 1] || '';
  }
  return { attrs: result, rest: content.replace(regex, '') };
}

/** 提取非贪婪匹配的正则 — 提取指定模式后的剩余文本 */
function extractPattern(
  content: string,
  regex: RegExp,
): { match: RegExpExecArray | null; rest: string } {
  const m = regex.exec(content);
  if (!m) return { match: null, rest: content };
  return { match: m, rest: content.replace(regex, '') };
}

/**
 * 解析 plot_outline Agent 的 XML 输出
 *
 * 期望结构:
 * <outline>
 *   <title>大纲标题</title>
 *   <summary>一句话摘要</summary>
 *   <timerange start="512-春" end="513-秋" />
 *   <content>大纲正文 (Markdown, 保留原样)</content>
 *   <chapter title="第一章" summary="..." start="..." end="...">
 *     <event title="事件标题">
 *       <time start="512-春" end="512-夏" />
 *       <desc>事件描述</desc>
 *       <trigger>触发条件提示</trigger>
 *       <complete>完成条件提示</complete>
 *       <fail>失败条件提示</fail>
 *     </event>
 *   </chapter>
 *   <self_critique score="8">
 *     <strength>优点1</strength>
 *     <weakness>不足1</weakness>
 *     <suggestion>建议1</suggestion>
 *   </self_critique>
 * </outline>
 */
export function parseOutlineXml(raw: string): ParsedOutlineOutput | null {
  // 提取 <outline>...</outline> 块
  const outlineMatch = raw.match(/<\s*outline\s*>([\s\S]*?)<\/\s*outline\s*>/i);
  if (!outlineMatch) return null;
  let inner = outlineMatch[1];

  // title
  const titleResult = extractXmlTag(inner, 'title');
  inner = titleResult.rest;
  const title = titleResult.text.trim() || '';

  // summary
  const summaryResult = extractXmlTag(inner, 'summary');
  inner = summaryResult.rest;
  const summary = summaryResult.text.trim() || '';

  // timerange (self-closing)
  const trResult = extractSelfClosingAttrs(inner, 'timerange', ['start', 'end']);
  let timeRange: { start: string; end: string } | undefined;
  if (trResult) {
    inner = trResult.rest;
    timeRange = { start: trResult.attrs.start || '', end: trResult.attrs.end || '' };
  }

  // direction_anchors (optional)
  const daResult = extractXmlTag(inner, 'direction_anchors');
  inner = daResult.rest;
  const directionAnchors = daResult.text.trim() || undefined;

  // content (preserve markdown, no escaping)
  const contentResult = extractXmlTag(inner, 'content');
  inner = contentResult.rest;
  const content = contentResult.text;

  if (!content) {
    // content is required — but we'll check chapters later before returning null
  }

  // chapters — parse each <chapter> with attrs
  const chapters: ParsedOutlineOutput['chapters'] = [];

  while (true) {
    const chRegex =
      /<\s*chapter\s+title\s*=\s*"([^"]*)"(?:\s+summary\s*=\s*"([^"]*)")?(?:\s+start\s*=\s*"([^"]*)")?(?:\s+end\s*=\s*"([^"]*)")?\s*>([\s\S]*?)<\/\s*chapter\s*>/i;
    const chExec = chRegex.exec(inner);
    if (!chExec) break;
    inner = inner.replace(chRegex, '');

    const chTitle = chExec[1] || '';
    const chSummary = chExec[2] || '';
    let chInner = chExec[5];

    // npc_agendas (optional, before event parsing)
    const naResult = extractXmlTag(chInner, 'npc_agendas');
    chInner = naResult.rest;
    const npcAgendas = naResult.text.trim() || undefined;

    // if_absent (optional, before event parsing)
    const iaResult = extractXmlTag(chInner, 'if_absent');
    chInner = iaResult.rest;
    const ifAbsent = iaResult.text.trim() || undefined;

    const keyEvents: ParsedOutlineOutput['chapters'][number]['keyEvents'] = [];

    while (true) {
      const evRegex = /<\s*event\s+title\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/\s*event\s*>/i;
      const evExec = evRegex.exec(chInner);
      if (!evExec) break;
      chInner = chInner.replace(evRegex, '');

      const evTitle = evExec[1] || '';
      let evInner = evExec[2];

      // time (self-closing inside event)
      let timeWindow: { start: string; end: string } | undefined;
      const twResult = extractSelfClosingAttrs(evInner, 'time', ['start', 'end']);
      if (twResult) {
        evInner = twResult.rest;
        if (twResult.attrs.start || twResult.attrs.end) {
          timeWindow = { start: twResult.attrs.start || '', end: twResult.attrs.end || '' };
        }
      }

      // desc
      const descResult = extractXmlTag(evInner, 'desc');
      evInner = descResult.rest;
      const description = descResult.text.trim() || '';

      // trigger
      const triggerResult = extractXmlTag(evInner, 'trigger');
      evInner = triggerResult.rest;
      const triggerHint = triggerResult.text.trim() || undefined;

      // complete
      const completeResult = extractXmlTag(evInner, 'complete');
      evInner = completeResult.rest;
      const completeHint = completeResult.text.trim() || undefined;

      // fail
      const failResult = extractXmlTag(evInner, 'fail');
      evInner = failResult.rest;
      const failHint = failResult.text.trim() || undefined;

      keyEvents.push({
        title: evTitle,
        description,
        triggerHint,
        timeWindow,
        completeHint,
        failHint,
      });
    }

    chapters.push({
      title: chTitle,
      summary: chSummary,
      npcAgendas,
      ifAbsent,
      keyEvents,
    });
  }

  // If no chapters and no content → invalid
  if (chapters.length === 0 && !content) return null;

  // self_critique
  const scResult = extractXmlTagWithAttrs(inner, 'self_critique', ['score']);
  let selfCritique: string | undefined;
  if (scResult.text) {
    inner = scResult.rest;
    const score = scResult.attrs.score || '?';
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const suggestions: string[] = [];

    // Parse strength/weakness/suggestion within self_critique
    let scInner = scResult.text;

    while (true) {
      const strResult = extractXmlTag(scInner, 'strength');
      if (!strResult.text) break;
      scInner = strResult.rest;
      strengths.push(strResult.text.trim());
    }

    while (true) {
      const weakResult = extractXmlTag(scInner, 'weakness');
      if (!weakResult.text) break;
      scInner = weakResult.rest;
      weaknesses.push(weakResult.text.trim());
    }

    while (true) {
      const sugResult = extractXmlTag(scInner, 'suggestion');
      if (!sugResult.text) break;
      scInner = sugResult.rest;
      suggestions.push(sugResult.text.trim());
    }

    selfCritique = formatSelfCritique({
      score: parseInt(score, 10) || 0,
      strengths: strengths.length > 0 ? strengths : undefined,
      weaknesses: weaknesses.length > 0 ? weaknesses : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    });
  }

  return {
    title,
    summary,
    content,
    chapters,
    selfCritique,
    ...(timeRange ? { timeRange } : {}),
    ...(directionAnchors ? { directionAnchors } : {}),
  };
}

/**
 * 统一解析入口：先尝试 XML，失败则回退 JSON
 */
export function tryParseOutline(raw: string): ParsedOutlineOutput | null {
  const xmlResult = parseOutlineXml(raw);
  if (xmlResult) return xmlResult;
  return parseOutlineJson(raw);
}

/**
 * 创建新的大纲对象
 * agentOutput: plot_outline Agent 的原始输出文本
 */
export function createOutlineFromAgent(
  saveId: string,
  mode: 'off' | 'side' | 'main',
  agentOutput: string,
  timeRange: { start: string; end: string },
  version: number = 1,
): PlotOutline | null {
  const parsed = tryParseOutline(agentOutput);
  if (!parsed) return null;

  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    saveId,
    mode,
    title: parsed.title,
    summary: parsed.summary,
    content: parsed.content,
    chapters: parsed.chapters.map((ch) => ({
      title: ch.title,
      summary: ch.summary,
      status: 'pending' as const,
    })),
    selfCritique: parsed.selfCritique,
    confirmed: false,
    version,
    timeRange: parsed.timeRange ?? timeRange,
    directionAnchors: parsed.directionAnchors,
    createdAt: now,
    updatedAt: now,
  };
}

// ========== 自检 ==========

/** 评估大纲质量（基于 AI 自检内容） */
export function evaluateOutlineQuality(outline: PlotOutline): {
  hasCritique: boolean;
  isGood: boolean;
  critiqueText: string;
} {
  if (!outline.selfCritique) {
    return { hasCritique: false, isGood: false, critiqueText: '暂无自检结果' };
  }

  // 从自检文本中提取评分
  const scoreMatch = outline.selfCritique.match(/评分[：:]\s*(\d+)/);
  const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

  return {
    hasCritique: true,
    isGood: score >= 6,
    critiqueText: outline.selfCritique,
  };
}

/** 确认大纲 */
export async function confirmOutline(outline: PlotOutline): Promise<PlotOutline> {
  outline.confirmed = true;
  outline.updatedAt = Date.now();
  await savePlotOutline(outline);
  return outline;
}

// ========== 大纲 → 事件树 ==========

/**
 * 将结构化章节（chapters[].keyEvents[]）转换为 PlotEvent 树
 * 章节=depth 0，keyEvent=depth 1（parentId 指向章节事件），全部 visibility='hidden'
 */
export function outlineToEvents(
  chapters: ParsedOutlineOutput['chapters'],
  saveId: string,
): PlotEvent[] {
  const now = Date.now();
  const events: PlotEvent[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];

    const chapterEvent: PlotEvent = {
      id: crypto.randomUUID(),
      saveId,
      title: ch.title,
      description: ch.summary.slice(0, 500),
      status: 'pending',
      childrenIds: [],
      order: i * 10,
      relatedCharacterIds: [],
      worldLineChanged: false,
      visibility: 'hidden',
      chapterTitle: ch.title,
      ...(ch.npcAgendas ? { npcAgendas: ch.npcAgendas } : {}),
      ...(ch.ifAbsent ? { ifAbsent: ch.ifAbsent } : {}),
      depth: 0,
      createdAt: now,
      updatedAt: now,
    };
    events.push(chapterEvent);

    for (let j = 0; j < ch.keyEvents.length; j++) {
      const ke = ch.keyEvents[j];
      const keyEvent: PlotEvent = {
        id: crypto.randomUUID(),
        saveId,
        title: ke.title,
        description: ke.description.slice(0, 500),
        status: 'pending',
        triggerCondition: ke.triggerHint,
        completeCondition: ke.completeHint,
        failCondition: ke.failHint,
        timeWindow: ke.timeWindow,
        childrenIds: [],
        parentId: chapterEvent.id,
        order: j * 10,
        relatedCharacterIds: [],
        worldLineChanged: false,
        visibility: 'hidden',
        chapterTitle: ch.title,
        depth: 1,
        createdAt: now,
        updatedAt: now,
      };
      chapterEvent.childrenIds.push(keyEvent.id);
      events.push(keyEvent);
    }
  }

  return events;
}

// ========== 大纲更新 ==========

/**
 * 更新大纲版本（世界线变动时）
 * 增加 version，更新 content
 */
export async function updateOutlineVersion(
  outline: PlotOutline,
  newContent: string,
  changeDescription?: string,
): Promise<PlotOutline> {
  const updated: PlotOutline = {
    ...outline,
    content: newContent,
    version: outline.version + 1,
    updatedAt: Date.now(),
  };

  // 如果有变更描述，追加到自检中
  if (changeDescription) {
    updated.selfCritique = outline.selfCritique
      ? `${outline.selfCritique}\n\n---\n世界线变动记录 (v${updated.version}): ${changeDescription}`
      : `世界线变动记录 (v${updated.version}): ${changeDescription}`;
  }

  await savePlotOutline(updated);
  return updated;
}

// ========== 设置辅助 ==========

/** 判断是否需要生成大纲 */
export function shouldGenerateOutline(settings: PlotSettings): boolean {
  return settings.mode !== 'off';
}

/** 判断是否为支线模式（每年生成） */
export function isSideMode(settings: PlotSettings): boolean {
  return settings.mode === 'side';
}

/** 判断是否为主线模式 */
export function isMainMode(settings: PlotSettings): boolean {
  return settings.mode === 'main';
}

/** 获取当前活跃的大纲 */
export async function getActiveOutline(saveId: string): Promise<PlotOutline | undefined> {
  return getLatestPlotOutline(saveId);
}

/**
 * 同步大纲中的事件到数据库
 * 比较大纲生成的事件和数据库中的事件，新增缺失的
 */
export async function syncOutlineEvents(
  saveId: string,
  newEvents: PlotEvent[],
): Promise<{ added: number; skipped: number }> {
  const existingEvents = await getPlotEvents(saveId);
  const existingTitles = new Set(existingEvents.map((e) => e.title));

  let added = 0;
  let skipped = 0;

  const toAdd: PlotEvent[] = [];
  for (const event of newEvents) {
    if (!existingTitles.has(event.title)) {
      toAdd.push(event);
      added++;
    } else {
      skipped++;
    }
  }

  if (toAdd.length > 0) {
    await savePlotEvents(toAdd);
  }

  return { added, skipped };
}
