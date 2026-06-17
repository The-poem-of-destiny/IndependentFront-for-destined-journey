/**
 * 剧情运行时引擎 — 正文前触发检查 + 正文后世界线修正
 *
 * Phase 4 核心模块。职责:
 * 1. 正文前: 解析 plot_pre_check Agent 输出 → 触发 pending 事件
 * 2. 正文后: 解析 plot_post_check Agent 输出 → 更新事件/大纲/世界线
 * 3. EJS 条件表达式评估
 * 4. 世界线变动级联传播
 * 5. 事件完成/失败 → 自动生成关联记忆
 */

import type {
  PlotEvent, PlotOutline, MemoryRecord, CharacterState,
} from './types';
import {
  getPlotEvents, savePlotEvent, savePlotEvents,
} from './database';
import { getActiveOutline, updateOutlineVersion, outlineToEvents, syncOutlineEvents } from './plot-outline';

// ========== 条件评估 ==========

/**
 * 评估 EJS 风格的条件表达式
 * 支持的语法:
 * - 简单比较: `{{hp}} < 50`, `{{location}} == "白曜城"`
 * - 逻辑组合: `condition1 && condition2`, `condition1 || condition2`
 * - 变量引用: `{{变量名}}` 或 `{{对象.属性}}`
 */
export function evaluateCondition(
  condition: string | undefined,
  variables: Record<string, any>,
): boolean {
  if (!condition || condition.trim() === '') return true; // 无条件 = 总是触发

  try {
    // 替换模板变量
    let expr = condition.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const value = resolveVariablePath(path.trim(), variables);
      if (typeof value === 'string') return JSON.stringify(value);
      return String(value);
    });

    // 安全评估（使用 Function 构造器，限制可用全局）
    const fn = new Function('variables', `
      try {
        return !!(${expr});
      } catch {
        return false;
      }
    `);
    return fn(variables);
  } catch {
    // 简单字符串匹配（回退）
    return condition.includes('true') && !condition.includes('false');
  }
}

/** 解析变量路径 "a.b.c" */
function resolveVariablePath(path: string, vars: Record<string, any>): any {
  const parts = path.split('.');
  let value: any = vars;
  for (const part of parts) {
    if (value === undefined || value === null) return undefined;
    value = value[part.trim()];
  }
  return value;
}

// ========== Pre-Check 结果类型 ==========

/** plot_pre_check Agent 的输出解析结果 */
export interface PreCheckResult {
  triggeredEvents: Array<{ id: string; reason: string }>;
  relevantBackground: string;
  outlineRelevance: string;
}

/** 解析 plot_pre_check Agent 的 JSON 输出 */
export function parsePreCheckOutput(rawOutput: string): PreCheckResult | null {
  try {
    const parsed = JSON.parse(rawOutput) as PreCheckResult;
    if (!Array.isArray(parsed.triggeredEvents)) return null;
    return {
      triggeredEvents: parsed.triggeredEvents.filter(e => e.id),
      relevantBackground: parsed.relevantBackground || '',
      outlineRelevance: parsed.outlineRelevance || '',
    };
  } catch {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]) as PreCheckResult;
      return {
        triggeredEvents: parsed.triggeredEvents?.filter(e => e.id) || [],
        relevantBackground: parsed.relevantBackground || '',
        outlineRelevance: parsed.outlineRelevance || '',
      };
    } catch {
      return null;
    }
  }
}

/**
 * 正文前: 执行剧情触发检查
 *
 * agentOutput: plot_pre_check Agent 的原始输出文本
 *
 * 返回:
 * - triggeredEvents: 被触发的事件列表
 * - background: 需要注入正文 prompt 的剧情背景
 */
export async function preCheckPlot(
  saveId: string,
  agentOutput: string,
  variables: Record<string, any>,
): Promise<{ triggeredEvents: PlotEvent[]; background: string }> {
  const parsed = parsePreCheckOutput(agentOutput);
  if (!parsed || parsed.triggeredEvents.length === 0) {
    return { triggeredEvents: [], background: parsed?.relevantBackground || '' };
  }

  const allEvents = await getPlotEvents(saveId);
  const eventMap = new Map(allEvents.map(e => [e.id, e]));

  const triggered: PlotEvent[] = [];

  for (const trigger of parsed.triggeredEvents) {
    const event = eventMap.get(trigger.id);
    if (!event) continue;

    // 只有 pending 的事件可以被触发
    if (event.status !== 'pending') continue;

    // 验证触发条件
    if (event.triggerCondition && !evaluateCondition(event.triggerCondition, variables)) {
      continue;
    }

    // 激活事件
    event.status = 'active';
    event.updatedAt = Date.now();
    await savePlotEvent(event);
    triggered.push(event);
  }

  return {
    triggeredEvents: triggered,
    background: parsed.relevantBackground,
  };
}

// ========== Post-Check 结果类型 ==========

/** plot_post_check Agent 的输出解析结果 */
export interface PostCheckResult {
  worldLineChanged: boolean;
  changeLevel: 'none' | 'minor' | 'moderate' | 'major';
  outlineChanges: {
    action: 'none' | 'update' | 'addChapter' | 'removeChapter';
    changes: string;
  };
  eventUpdates: Array<{
    id: string;
    action: 'update' | 'addChild' | 'skip' | 'fail' | 'complete';
    changes: Record<string, any>;
  }>;
  newChildEvents: Array<{
    title: string;
    description: string;
    triggerCondition?: string;
    depth: number;
  }>;
}

/** 解析 plot_post_check Agent 的 JSON 输出 */
export function parsePostCheckOutput(rawOutput: string): PostCheckResult | null {
  try {
    const parsed = JSON.parse(rawOutput) as PostCheckResult;
    return {
      worldLineChanged: parsed.worldLineChanged || false,
      changeLevel: parsed.changeLevel || 'none',
      outlineChanges: parsed.outlineChanges || { action: 'none', changes: '' },
      eventUpdates: Array.isArray(parsed.eventUpdates) ? parsed.eventUpdates : [],
      newChildEvents: Array.isArray(parsed.newChildEvents) ? parsed.newChildEvents : [],
    };
  } catch {
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]) as PostCheckResult;
    } catch {
      return null;
    }
  }
}

/**
 * 正文后: 执行剧情修正
 *
 * agentOutput: plot_post_check Agent 的原始输出文本
 *
 * 返回:
 * - eventsUpdated: 更新的事件列表
 * - newEvents: 新创建的子事件
 * - outlineUpdated: 大纲是否被更新
 * - worldLineChanged: 是否有世界线变动
 */
export async function postCheckPlot(
  saveId: string,
  agentOutput: string,
): Promise<{
  eventsUpdated: PlotEvent[];
  newEvents: PlotEvent[];
  outlineUpdated: boolean;
  worldLineChanged: boolean;
  changeLevel: string;
}> {
  const parsed = parsePostCheckOutput(agentOutput);
  if (!parsed) {
    return { eventsUpdated: [], newEvents: [], outlineUpdated: false, worldLineChanged: false, changeLevel: 'none' };
  }

  const allEvents = await getPlotEvents(saveId);
  const eventMap = new Map(allEvents.map(e => [e.id, e]));

  const eventsUpdated: PlotEvent[] = [];
  const now = Date.now();

  // 1. 处理事件状态更新
  for (const update of parsed.eventUpdates) {
    const event = eventMap.get(update.id);
    if (!event) continue;

    switch (update.action) {
      case 'complete':
        event.status = 'completed';
        break;
      case 'fail':
        event.status = 'failed';
        break;
      case 'skip':
        event.status = 'skipped';
        break;
      case 'addChild':
        // 添加子事件引用会在 newChildEvents 处理
        break;
      case 'update':
        // 合并 changes 中的字段
        if (update.changes) {
          if (update.changes.status) event.status = update.changes.status;
          if (update.changes.description) event.description = update.changes.description;
          if (update.changes.worldLineChanged !== undefined) {
            event.worldLineChanged = update.changes.worldLineChanged;
          }
        }
        break;
    }

    event.updatedAt = now;
    eventsUpdated.push(event);
  }

  // 2. 处理新建子事件
  const newEvents: PlotEvent[] = [];
  for (const child of parsed.newChildEvents) {
    const newEvent: PlotEvent = {
      id: crypto.randomUUID(),
      saveId,
      title: child.title,
      description: child.description,
      status: 'pending',
      triggerCondition: child.triggerCondition,
      childrenIds: [],
      parentId: undefined, // 由调用方指定
      order: eventsUpdated.length * 10,
      relatedCharacterIds: [],
      worldLineChanged: false,
      depth: child.depth || 1,
      createdAt: now,
      updatedAt: now,
    };
    newEvents.push(newEvent);
  }

  // 3. 保存所有变更
  const allUpdates = [...eventsUpdated, ...newEvents];
  if (allUpdates.length > 0) {
    await savePlotEvents(allUpdates);
  }

  // 4. 如有世界线变动 → 处理大纲
  let outlineUpdated = false;
  if (parsed.worldLineChanged && parsed.outlineChanges.action !== 'none') {
    const outline = await getActiveOutline(saveId);
    if (outline) {
      await updateOutlineVersion(
        outline,
        outline.content + '\n\n## 世界线变动 (v' + (outline.version + 1) + ')\n' + parsed.outlineChanges.changes,
        parsed.outlineChanges.changes,
      );
      outlineUpdated = true;
    }
  }

  // 5. 如有世界线变动 → 级联传播
  if (parsed.worldLineChanged && parsed.changeLevel !== 'minor') {
    const changedIds = eventsUpdated.filter(e => e.worldLineChanged).map(e => e.id);
    for (const changedId of changedIds) {
      propagateWorldLineChange(allEvents, changedId, 2); // 默认 2 层
    }
  }

  return {
    eventsUpdated,
    newEvents,
    outlineUpdated,
    worldLineChanged: parsed.worldLineChanged,
    changeLevel: parsed.changeLevel,
  };
}

// ========== 世界线变动传播 ==========

/**
 * 级联传播世界线变动标记
 * 当父事件发生 worldLineChanged 时，mark 其子事件（递归 depth 层）
 */
export function propagateWorldLineChange(
  allEvents: PlotEvent[],
  changedId: string,
  depth: number,
): PlotEvent[] {
  if (depth <= 0) return [];

  const eventMap = new Map(allEvents.map(e => [e.id, e]));
  const affected: PlotEvent[] = [];

  const changedEvent = eventMap.get(changedId);
  if (!changedEvent) return [];

  const queue = [...changedEvent.childrenIds];
  let currentDepth = 0;

  while (queue.length > 0 && currentDepth < depth) {
    const levelSize = queue.length;
    for (let i = 0; i < levelSize; i++) {
      const childId = queue.shift()!;
      const child = eventMap.get(childId);
      if (!child) continue;

      child.worldLineChanged = true;
      child.updatedAt = Date.now();
      affected.push(child);

      // 将孙子事件加入队列
      queue.push(...child.childrenIds);
    }
    currentDepth++;
  }

  return affected;
}

// ========== 事件 → 记忆 ==========

/**
 * 将完成/失败的剧情事件转换为 MemoryRecord
 * 当事件状态变为 completed 或 failed 时自动生成高重要度记忆
 */
export function eventToMemory(
  event: PlotEvent,
  saveId: string,
  gameTimeRange?: { start: string; end: string },
): Omit<MemoryRecord, 'id' | 'embedding'> {
  const now = Date.now();
  const isFailure = event.status === 'failed';

  const content = isFailure
    ? `【剧情失败】${event.title}。${event.description}。这个事件的失败可能对未来产生深远影响。`
    : `【剧情完成】${event.title}。${event.description}。这是一个重要的里程碑。`;

  const hiddenLine = isFailure
    ? `剧情事件失败: ${event.title}`
    : `剧情事件完成: ${event.title}`;

  const importance = isFailure ? 9 : 8;

  return {
    saveId,
    createdAt: now,
    realTimestamp: now,
    timeRange: gameTimeRange || { start: '未知', end: '未知' },
    content,
    hiddenLine,
    keywords: [event.title, isFailure ? '失败' : '完成', '剧情事件'],
    relatedCharacterIds: event.relatedCharacterIds,
    relatedPlotEventId: event.id,
    importance,
  };
}

// ========== 触发辅助 ==========

/**
 * 获取应被触发的 pending 事件
 * 按 triggerCondition 评估
 */
export async function getPendingEventsForTrigger(
  saveId: string,
  variables: Record<string, any>,
): Promise<PlotEvent[]> {
  const allEvents = await getPlotEvents(saveId);
  return allEvents.filter(
    e => e.status === 'pending' && evaluateCondition(e.triggerCondition, variables),
  );
}

/**
 * 自动将剧情事件完成/失败标准化为记忆
 * 遍历所有 completed/failed 且未生成记忆的事件
 */
export async function autoGenerateMemoriesFromEvents(
  saveId: string,
  gameTimeRange?: { start: string; end: string },
): Promise<Array<Omit<MemoryRecord, 'id' | 'embedding'>>> {
  const allEvents = await getPlotEvents(saveId);
  const terminalEvents = allEvents.filter(
    e => (e.status === 'completed' || e.status === 'failed'),
  );

  return terminalEvents.map(e => eventToMemory(e, saveId, gameTimeRange));
}
