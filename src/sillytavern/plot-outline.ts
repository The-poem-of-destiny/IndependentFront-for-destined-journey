/**
 * 剧情大纲管理 — CRUD + AI 生成 + 自检 + 事件树生成
 *
 * Phase 4 核心模块。职责:
 * 1. 生成剧情大纲（AI-driven）
 * 2. 大纲自检（AI 评估精彩程度）
 * 3. 大纲 → 事件树转换
 * 4. 世界线变动时更新大纲
 */

import type {
  PlotOutline, PlotSettings, PlotEvent, CharacterState,
} from './types';
import {
  getLatestPlotOutline, savePlotOutline,
  getPlotEvents, savePlotEvents,
} from './database';

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

/** 解析 plot_outline Agent 的输出 */
export function parseOutlineAgentOutput(rawOutput: string): {
  content: string;
  selfCritique?: string;
} | null {
  try {
    const parsed = JSON.parse(rawOutput) as {
      content: string;
      selfCritique?: { score: number; strengths: string[]; weaknesses: string[]; suggestions: string[] };
    };

    if (!parsed.content) return null;

    return {
      content: parsed.content,
      selfCritique: parsed.selfCritique
        ? `评分: ${parsed.selfCritique.score}/10\n优点: ${parsed.selfCritique.strengths?.join('; ')}\n不足: ${parsed.selfCritique.weaknesses?.join('; ')}\n建议: ${parsed.selfCritique.suggestions?.join('; ')}`
        : undefined,
    };
  } catch {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { content: string };
      return parsed.content ? { content: parsed.content } : null;
    } catch {
      return null;
    }
  }
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
  const parsed = parseOutlineAgentOutput(agentOutput);
  if (!parsed) return null;

  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    saveId,
    mode,
    content: parsed.content,
    selfCritique: parsed.selfCritique,
    confirmed: false,
    version,
    timeRange,
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

/** 解析大纲内容为章节结构 */
export function parseOutlineChapters(content: string): Array<{
  title: string;
  summary: string;
}> {
  const chapters: Array<{ title: string; summary: string }> = [];
  const lines = content.split('\n');

  let currentTitle = '';
  let currentSummary = '';

  for (const line of lines) {
    // 匹配章节标题（# 或 ## 开头，或 "第X章"）
    const chapterMatch = line.match(/^#{1,3}\s*(.+)/) || line.match(/^(第[一二三四五六七八九十\d]+[章节部].*)/);
    if (chapterMatch) {
      if (currentTitle) {
        chapters.push({ title: currentTitle, summary: currentSummary.trim() });
      }
      currentTitle = chapterMatch[1];
      currentSummary = '';
    } else if (currentTitle && line.trim()) {
      currentSummary += line + '\n';
    }
  }

  // 最后一个章节
  if (currentTitle) {
    chapters.push({ title: currentTitle, summary: currentSummary.trim() });
  }

  return chapters;
}

/**
 * 将大纲转换为 PlotEvent 列表
 * 大纲的每个章节成为一个顶层事件，关键节点成为子事件
 */
export function outlineToEvents(
  outline: PlotOutline,
  saveId: string,
  depth: number = 0,
): PlotEvent[] {
  const chapters = parseOutlineChapters(outline.content);
  if (chapters.length === 0) return [];

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
      depth,
      createdAt: now,
      updatedAt: now,
    };

    events.push(chapterEvent);
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
  const existingTitles = new Set(existingEvents.map(e => e.title));

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
