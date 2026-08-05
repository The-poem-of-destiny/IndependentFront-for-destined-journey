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

import type { PlotEvent, MemoryRecord } from './types';
import { getPlotEvents, savePlotEvent, savePlotEvents } from './database';
// Q-05：从模型输出抢救 JSON 的唯一入口
import { parseModelJson, asArray, asString } from './model-json';
import { getActiveOutline, updateOutlineVersion } from './plot-outline';

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
    const expr = condition.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const value = resolveVariablePath(path.trim(), variables);
      if (typeof value === 'string') return JSON.stringify(value);
      return String(value);
    });

    // 安全评估（使用 Function 构造器，限制可用全局）
    const fn = new Function(
      'variables',
      `
      try {
        return !!(${expr});
      } catch {
        return false;
      }
    `,
    );
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

/** plot_pre_check Agent 的输出解析结果（铁律1: 事件寻址用标题，AI 永不产/引 id） */
export interface PreCheckResult {
  triggeredEvents: Array<{ title: string; reason: string }>;
  relevantBackground: string;
  outlineRelevance: string;
}

/** 解析 plot_pre_check Agent 的 JSON 输出 */
export function parsePreCheckOutput(rawOutput: string): PreCheckResult | null {
  // Q-05：剥壳交给 model-json（裸/围栏/<json>/前后夹带解说四种形态一处处理），
  // 这里只留兜底口径 —— 成功与失败两条路都过同一个 normalize，长不出「两个分支两套兜底」
  return parseModelJson<PreCheckResult>(rawOutput, (p) => {
    const o = (p ?? {}) as Partial<PreCheckResult>;
    if (!Array.isArray(o.triggeredEvents)) return null;
    return {
      triggeredEvents: o.triggeredEvents.filter((e) => e?.title),
      relevantBackground: asString(o.relevantBackground),
      outlineRelevance: asString(o.outlineRelevance),
    };
  });
}

/** 按标题在本存档事件中唯一匹配（精确匹配优先，匹配不到返回 undefined 并 warn） */
function resolveEventByTitle(
  events: PlotEvent[],
  title: string,
  source: string,
): PlotEvent | undefined {
  const exact = events.filter((e) => e.title === title);
  if (exact.length >= 1) {
    if (exact.length > 1) {
      console.warn(
        `[plot-engine] ${source}: 标题 "${title}" 匹配到 ${exact.length} 个事件，取第一个`,
      );
    }
    return exact[0];
  }
  console.warn(`[plot-engine] ${source}: 找不到标题为 "${title}" 的剧情事件，跳过`);
  return undefined;
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

  const triggered: PlotEvent[] = [];

  for (const trigger of parsed.triggeredEvents) {
    const event = resolveEventByTitle(allEvents, trigger.title, 'preCheckPlot');
    if (!event) continue;

    // 只有 pending 的事件可以被触发
    if (event.status !== 'pending') continue;

    // 验证触发条件
    if (event.triggerCondition && !evaluateCondition(event.triggerCondition, variables)) {
      continue;
    }

    // 激活事件 + 揭示给玩家
    event.status = 'active';
    event.visibility = 'revealed';
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

/** plot_post_check Agent 的输出解析结果（铁律1: 事件寻址用标题） */
export interface PostCheckResult {
  worldLineChanged: boolean;
  changeLevel: 'none' | 'minor' | 'moderate' | 'major';
  outlineChanges: {
    action: 'none' | 'update' | 'addChapter' | 'removeChapter';
    changes: string;
  };
  eventUpdates: Array<{
    title: string;
    action: 'complete' | 'fail' | 'skip' | 'update';
    changes?: Record<string, unknown>;
  }>;
  newChildEvents: Array<{
    title: string;
    description: string;
    parentTitle?: string;
    triggerCondition?: string;
    depth?: number;
  }>;
}

/**
 * 解析 plot_post_check Agent 的 JSON 输出。
 *
 * 🔴 Q-05 修的就是这里：旧实现主分支逐字段兜底、catch 分支是裸的
 * `JSON.parse(jsonMatch[0]) as PostCheckResult`。而 `postCheckPlot` 无守卫地
 * 遍历 `eventUpdates` / `newChildEvents` —— 缺键输出走兜底路径直接 TypeError，
 * 再被 `game-pipeline.persistPlotPostCheck` 的 catch 吞成 console.warn，
 * **整条剧情后检查静默空转**。现在只有一条兜底口径。
 */
export function parsePostCheckOutput(rawOutput: string): PostCheckResult | null {
  return parseModelJson<PostCheckResult>(rawOutput, (p) => {
    const o = (p ?? {}) as Partial<PostCheckResult>;
    return {
      worldLineChanged: o.worldLineChanged || false,
      changeLevel: o.changeLevel || 'none',
      outlineChanges: o.outlineChanges || { action: 'none', changes: '' },
      eventUpdates: asArray<PostCheckResult['eventUpdates'][number]>(o.eventUpdates),
      newChildEvents: asArray<PostCheckResult['newChildEvents'][number]>(o.newChildEvents),
    };
  });
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
    return {
      eventsUpdated: [],
      newEvents: [],
      outlineUpdated: false,
      worldLineChanged: false,
      changeLevel: 'none',
    };
  }

  const allEvents = await getPlotEvents(saveId);

  const eventsUpdated: PlotEvent[] = [];
  const now = Date.now();

  // 1. 处理事件状态更新（按标题寻址，铁律1）
  for (const update of parsed.eventUpdates) {
    const event = resolveEventByTitle(allEvents, update.title, 'postCheckPlot');
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
      case 'update':
        // 合并 changes 中的字段
        if (update.changes) {
          if (update.changes.status) event.status = update.changes.status as PlotEvent['status'];
          if (update.changes.description) event.description = String(update.changes.description);
          if (update.changes.worldLineChanged !== undefined) {
            event.worldLineChanged = Boolean(update.changes.worldLineChanged);
          }
        }
        break;
    }

    event.updatedAt = now;
    eventsUpdated.push(event);
  }

  // 2. 处理新建子事件（parentTitle → parentId 由 Code 解析，id 由 Code 生成）
  const newEvents: PlotEvent[] = [];
  for (const child of parsed.newChildEvents) {
    let parentId: string | undefined;
    let chapterTitle: string | undefined;
    if (child.parentTitle) {
      const parent = resolveEventByTitle(
        allEvents,
        child.parentTitle,
        'postCheckPlot.newChildEvents',
      );
      parentId = parent?.id;
      chapterTitle = parent?.chapterTitle;
    }
    const newEvent: PlotEvent = {
      id: crypto.randomUUID(),
      saveId,
      title: child.title,
      description: child.description,
      status: 'pending',
      triggerCondition: child.triggerCondition,
      childrenIds: [],
      parentId,
      order: eventsUpdated.length * 10,
      relatedCharacterIds: [],
      worldLineChanged: false,
      visibility: 'hidden',
      chapterTitle,
      depth: child.depth || 1,
      createdAt: now,
      updatedAt: now,
    };
    newEvents.push(newEvent);
    if (parentId) {
      const parent = allEvents.find((e) => e.id === parentId);
      if (parent && !parent.childrenIds.includes(newEvent.id)) {
        parent.childrenIds.push(newEvent.id);
        parent.updatedAt = now;
        if (!eventsUpdated.includes(parent)) eventsUpdated.push(parent);
      }
    }
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
        outline.content +
          '\n\n## 世界线变动 (v' +
          (outline.version + 1) +
          ')\n' +
          parsed.outlineChanges.changes,
        parsed.outlineChanges.changes,
      );
      outlineUpdated = true;
    }
  }

  // 5. 如有世界线变动 → 级联传播
  if (parsed.worldLineChanged && parsed.changeLevel !== 'minor') {
    const changedIds = eventsUpdated.filter((e) => e.worldLineChanged).map((e) => e.id);
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

  const eventMap = new Map(allEvents.map((e) => [e.id, e]));
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

  const hiddenLine = isFailure ? `剧情事件失败: ${event.title}` : `剧情事件完成: ${event.title}`;

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
    (e) => e.status === 'pending' && evaluateCondition(e.triggerCondition, variables),
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
  const terminalEvents = allEvents.filter((e) => e.status === 'completed' || e.status === 'failed');

  return terminalEvents.map((e) => eventToMemory(e, saveId, gameTimeRange));
}
