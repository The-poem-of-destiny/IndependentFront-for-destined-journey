/**
 * plot-engine.ts — 剧情运行时引擎测试
 *
 * 覆盖: evaluateCondition / parsePreCheckOutput / parsePostCheckOutput /
 *       eventToMemory / propagateWorldLineChange / preCheckPlot /
 *       postCheckPlot / getPendingEventsForTrigger / autoGenerateMemoriesFromEvents
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlotEvent, MemoryRecord, PlotOutline } from './types';
import {
  evaluateCondition,
  parsePreCheckOutput,
  parsePostCheckOutput,
  eventToMemory,
  propagateWorldLineChange,
  preCheckPlot,
  postCheckPlot,
  getPendingEventsForTrigger,
  autoGenerateMemoriesFromEvents,
} from './plot-engine';

// ========== 工具函数 ==========

/** 创建一个基础 PlotEvent */
function makeEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    saveId: overrides.saveId ?? 'save-1',
    title: overrides.title ?? '测试事件',
    description: overrides.description ?? '这是一个测试用的剧情事件',
    status: overrides.status ?? 'pending',
    childrenIds: overrides.childrenIds ?? [],
    parentId: overrides.parentId,
    order: overrides.order ?? 0,
    relatedCharacterIds: overrides.relatedCharacterIds ?? [],
    worldLineChanged: overrides.worldLineChanged ?? false,
    depth: overrides.depth ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    triggerCondition: overrides.triggerCondition,
    completeCondition: overrides.completeCondition,
    failCondition: overrides.failCondition,
    timeWindow: overrides.timeWindow,
    location: overrides.location,
  };
}

/** 创建一个基础 PlotOutline */
function makeOutline(overrides: Partial<PlotOutline> = {}): PlotOutline {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    saveId: overrides.saveId ?? 'save-1',
    mode: overrides.mode ?? 'main',
    content: overrides.content ?? '# 第一章\n章节内容',
    confirmed: overrides.confirmed ?? true,
    version: overrides.version ?? 1,
    timeRange: overrides.timeRange ?? { start: '第1年', end: '第5年' },
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
  };
}

// ====================================================================
// evaluateCondition
// ====================================================================

describe('evaluateCondition', () => {
  // --- 简单比较 ---

  it('应正确处理 == 比较为真', () => {
    const vars = { hp: 100 };
    expect(evaluateCondition('{{hp}} == 100', vars)).toBe(true);
  });

  it('应正确处理 == 比较为假', () => {
    const vars = { hp: 50 };
    expect(evaluateCondition('{{hp}} == 100', vars)).toBe(false);
  });

  it('应正确处理 < 比较', () => {
    const vars = { hp: 30 };
    expect(evaluateCondition('{{hp}} < 50', vars)).toBe(true);
  });

  it('应正确处理 > 比较', () => {
    const vars = { hp: 80 };
    expect(evaluateCondition('{{hp}} > 50', vars)).toBe(true);
  });

  it('应正确处理字符串 == 比较', () => {
    const vars = { location: '白曜城' };
    expect(evaluateCondition('{{location}} == "白曜城"', vars)).toBe(true);
    expect(evaluateCondition('{{location}} == "黑曜城"', vars)).toBe(false);
  });

  // --- 逻辑 AND / OR ---

  it('应正确处理 && 逻辑', () => {
    const vars = { hp: 60, mp: 30 };
    expect(evaluateCondition('{{hp}} > 50 && {{mp}} > 20', vars)).toBe(true);
    expect(evaluateCondition('{{hp}} > 50 && {{mp}} > 50', vars)).toBe(false);
  });

  it('应正确处理 || 逻辑', () => {
    const vars = { hp: 30, mp: 80 };
    expect(evaluateCondition('{{hp}} > 50 || {{mp}} > 50', vars)).toBe(true);
    expect(evaluateCondition('{{hp}} > 50 || {{mp}} > 100', vars)).toBe(false);
  });

  // --- 模板变量替换 ---

  it('应替换模板变量 {{var}} 为值', () => {
    const vars = { hp: 42 };
    // {{hp}} 会替换为 42，表达式变成 42 == 42
    expect(evaluateCondition('{{hp}} == 42', vars)).toBe(true);
  });

  // --- 嵌套路径解析 ---

  it('应解析嵌套路径 {{a.b.c}}', () => {
    const vars = { player: { stats: { hp: 75 } } };
    expect(evaluateCondition('{{player.stats.hp}} > 50', vars)).toBe(true);
    expect(evaluateCondition('{{player.stats.hp}} < 50', vars)).toBe(false);
  });

  it('嵌套路径不存在时应返回 undefined 并可能导致 false', () => {
    const vars = { player: { stats: {} } };
    // {{player.stats.hp}} 会解析为 undefined → 字符串 "undefined"
    // 表达式 "undefined" > 50 → false
    expect(evaluateCondition('{{player.stats.hp}} > 50', vars)).toBe(false);
  });

  // --- undefined 条件 ---

  it('undefined 条件应返回 true（无条件 = 总是触发）', () => {
    expect(evaluateCondition(undefined, {})).toBe(true);
  });

  it('空字符串条件应返回 true', () => {
    expect(evaluateCondition('', {})).toBe(true);
  });

  it('纯空白字符串条件应返回 true', () => {
    expect(evaluateCondition('   ', {})).toBe(true);
  });

  // --- 无效表达式 ---

  it('无效表达式应不抛异常，返回回退值', () => {
    // 语法错误应被 catch 捕获，走回退逻辑
    // 回退: condition.includes('true') && !condition.includes('false')
    const vars = { x: 1 };
    expect(() => evaluateCondition('{{{bad', vars)).not.toThrow();
  });

  // --- 边界: truthy/falsy ---

  it('应正确评估 truthy 值', () => {
    const vars = { flag: 1, zero: 0 };
    expect(evaluateCondition('{{flag}}', vars)).toBe(true);
    expect(evaluateCondition('{{zero}}', vars)).toBe(false);
  });
});

// ====================================================================
// parsePreCheckOutput
// ====================================================================

describe('parsePreCheckOutput', () => {
  it('应正确解析标准 JSON 输出', () => {
    const raw = JSON.stringify({
      triggeredEvents: [
        { id: 'evt-1', reason: '玩家到达白曜城' },
        { id: 'evt-2', reason: '触发商队事件' },
      ],
      relevantBackground: '白曜城是北境最大的贸易中心',
      outlineRelevance: '符合主线剧情第三章',
    });
    const result = parsePreCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.triggeredEvents).toHaveLength(2);
    expect(result!.triggeredEvents[0].id).toBe('evt-1');
    expect(result!.triggeredEvents[0].reason).toBe('玩家到达白曜城');
    expect(result!.relevantBackground).toContain('北境');
    expect(result!.outlineRelevance).toBe('符合主线剧情第三章');
  });

  it('应过滤掉没有 id 的触发事件', () => {
    const raw = JSON.stringify({
      triggeredEvents: [
        { id: '', reason: '无效' },
        { id: 'evt-valid', reason: '有效' },
      ],
    });
    const result = parsePreCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.triggeredEvents).toHaveLength(1);
    expect(result!.triggeredEvents[0].id).toBe('evt-valid');
  });

  it('missing triggeredEvents 时应返回空数组', () => {
    const raw = JSON.stringify({
      relevantBackground: '一些背景',
    });
    const result = parsePreCheckOutput(raw);
    expect(result).toBeNull(); // !Array.isArray → null
  });

  it('应从嵌入文本中提取 JSON', () => {
    const raw = `以下是剧情触发检查结果：
\`\`\`json
{
  "triggeredEvents": [
    { "id": "evt-embed", "reason": "文本内嵌" }
  ],
  "relevantBackground": "嵌入的背景信息"
}
\`\`\`
以上就是结果。`;
    const result = parsePreCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.triggeredEvents).toHaveLength(1);
    expect(result!.triggeredEvents[0].id).toBe('evt-embed');
  });

  it('无效文本应返回 null', () => {
    expect(parsePreCheckOutput('这是一段完全没有 JSON 的纯文本')).toBeNull();
    expect(parsePreCheckOutput('')).toBeNull();
  });

  it('空 triggeredEvents 数组应返回空结果', () => {
    const raw = JSON.stringify({
      triggeredEvents: [],
      relevantBackground: '',
    });
    const result = parsePreCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.triggeredEvents).toEqual([]);
  });
});

// ====================================================================
// parsePostCheckOutput
// ====================================================================

describe('parsePostCheckOutput', () => {
  it('应正确解析完整 JSON 输出（含所有字段）', () => {
    const raw = JSON.stringify({
      worldLineChanged: true,
      changeLevel: 'moderate',
      outlineChanges: {
        action: 'addChapter',
        changes: '新增一章关于北境秘密结社的内容',
      },
      eventUpdates: [
        { id: 'evt-1', action: 'complete', changes: {} },
        { id: 'evt-2', action: 'fail', changes: {} },
      ],
      newChildEvents: [
        { title: '潜入结社', description: '深入北境秘密结社调查', depth: 2 },
      ],
    });
    const result = parsePostCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worldLineChanged).toBe(true);
    expect(result!.changeLevel).toBe('moderate');
    expect(result!.outlineChanges.action).toBe('addChapter');
    expect(result!.eventUpdates).toHaveLength(2);
    expect(result!.newChildEvents).toHaveLength(1);
    expect(result!.newChildEvents[0].title).toBe('潜入结社');
  });

  it('应正确处理最小有效 JSON（无变化）', () => {
    const raw = JSON.stringify({
      worldLineChanged: false,
      eventUpdates: [],
      newChildEvents: [],
    });
    const result = parsePostCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worldLineChanged).toBe(false);
    expect(result!.changeLevel).toBe('none');
    expect(result!.eventUpdates).toEqual([]);
    expect(result!.newChildEvents).toEqual([]);
  });

  it('应正确处理缺少部分字段的 JSON（兜底默认值）', () => {
    const raw = JSON.stringify({});
    const result = parsePostCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worldLineChanged).toBe(false);
    expect(result!.changeLevel).toBe('none');
    expect(result!.outlineChanges.action).toBe('none');
    expect(result!.eventUpdates).toEqual([]);
    expect(result!.newChildEvents).toEqual([]);
  });

  it('应从嵌入文本中提取 JSON', () => {
    const raw = `分析结果：
\`\`\`json
{
  "worldLineChanged": true,
  "changeLevel": "major",
  "outlineChanges": { "action": "update", "changes": "世界线大幅偏移" },
  "eventUpdates": [{ "id": "evt-major", "action": "update", "changes": { "description": "修改后的描述" } }],
  "newChildEvents": []
}
\`\`\`
以上。`;
    const result = parsePostCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.worldLineChanged).toBe(true);
    expect(result!.changeLevel).toBe('major');
    expect(result!.eventUpdates).toHaveLength(1);
  });

  it('无效文本应返回 null', () => {
    expect(parsePostCheckOutput('没有JSON的文本')).toBeNull();
    expect(parsePostCheckOutput('')).toBeNull();
  });

  it('eventUpdates 不是数组时应兜底为空数组', () => {
    const raw = JSON.stringify({
      worldLineChanged: false,
      eventUpdates: null,
      newChildEvents: null,
    });
    const result = parsePostCheckOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.eventUpdates).toEqual([]);
    expect(result!.newChildEvents).toEqual([]);
  });
});

// ====================================================================
// eventToMemory
// ====================================================================

describe('eventToMemory', () => {
  it('completed 事件应生成 importance=8 的记忆', () => {
    const event = makeEvent({
      id: 'evt-complete',
      title: '商队护送',
      description: '成功护送商队到达白曜城',
      status: 'completed',
      relatedCharacterIds: ['char-1'],
    });
    const mem = eventToMemory(event, 'save-1');
    expect(mem.saveId).toBe('save-1');
    expect(mem.importance).toBe(8);
    expect(mem.content).toContain('剧情完成');
    expect(mem.content).toContain('商队护送');
    expect(mem.hiddenLine).toContain('剧情事件完成');
    expect(mem.relatedCharacterIds).toEqual(['char-1']);
    expect(mem.relatedPlotEventId).toBe('evt-complete');
  });

  it('failed 事件应生成 importance=9 的记忆（更高重要度）', () => {
    const event = makeEvent({
      id: 'evt-failed',
      title: '拯救村庄',
      description: '未能及时拯救被袭击的村庄',
      status: 'failed',
    });
    const mem = eventToMemory(event, 'save-2');
    expect(mem.importance).toBe(9);
    expect(mem.content).toContain('剧情失败');
    expect(mem.content).toContain('拯救村庄');
    expect(mem.content).toContain('深远影响');
    expect(mem.hiddenLine).toContain('剧情事件失败');
  });

  it('应包含正确的 keywords', () => {
    const event = makeEvent({
      title: '古墓探索',
      status: 'completed',
    });
    const mem = eventToMemory(event, 'save-1');
    expect(mem.keywords).toContain('古墓探索');
    expect(mem.keywords).toContain('完成');
    expect(mem.keywords).toContain('剧情事件');
  });

  it('failed 事件的 keywords 应包含"失败"', () => {
    const event = makeEvent({ title: 'A', status: 'failed' });
    const mem = eventToMemory(event, 'save-1');
    expect(mem.keywords).toContain('失败');
  });

  it('应使用传入的 gameTimeRange', () => {
    const event = makeEvent({ status: 'completed' });
    const range = { start: '第3年春', end: '第3年秋' };
    const mem = eventToMemory(event, 'save-1', range);
    expect(mem.timeRange).toEqual(range);
  });

  it('未传 gameTimeRange 时应使用默认"未知"', () => {
    const event = makeEvent({ status: 'completed' });
    const mem = eventToMemory(event, 'save-1');
    expect(mem.timeRange).toEqual({ start: '未知', end: '未知' });
  });
});

// ====================================================================
// propagateWorldLineChange
// ====================================================================

describe('propagateWorldLineChange', () => {
  it('depth=0 不应传播', () => {
    const child = makeEvent({ id: 'child-1', parentId: 'root', depth: 1 });
    const root = makeEvent({ id: 'root', childrenIds: ['child-1'] });
    const result = propagateWorldLineChange([root, child], 'root', 0);
    expect(result).toEqual([]);
    expect(child.worldLineChanged).toBe(false);
  });

  it('depth=1 应传播到直接子事件', () => {
    const child = makeEvent({ id: 'child-1', parentId: 'root', depth: 1 });
    const root = makeEvent({ id: 'root', childrenIds: ['child-1'] });
    const result = propagateWorldLineChange([root, child], 'root', 1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('child-1');
    expect(child.worldLineChanged).toBe(true);
  });

  it('depth=2 应传播到孙事件', () => {
    const grandchild = makeEvent({ id: 'gc-1', parentId: 'child-1', depth: 2 });
    const child = makeEvent({ id: 'child-1', parentId: 'root', childrenIds: ['gc-1'], depth: 1 });
    const root = makeEvent({ id: 'root', childrenIds: ['child-1'] });
    const allEvents = [root, child, grandchild];

    const result = propagateWorldLineChange(allEvents, 'root', 2);
    expect(result).toHaveLength(2);
    const ids = new Set(result.map(e => e.id));
    expect(ids.has('child-1')).toBe(true);
    expect(ids.has('gc-1')).toBe(true);
    expect(child.worldLineChanged).toBe(true);
    expect(grandchild.worldLineChanged).toBe(true);
  });

  it('不存在的 changedId 应返回空数组', () => {
    const result = propagateWorldLineChange([], 'nonexistent', 5);
    expect(result).toEqual([]);
  });

  it('事件无子节点时应返回空数组', () => {
    const root = makeEvent({ id: 'root', childrenIds: [] });
    const result = propagateWorldLineChange([root], 'root', 3);
    expect(result).toEqual([]);
  });

  it('深度传播应使用 BFS 层级截断', () => {
    // root → child-1 → gc-1, depth=1 不应到达 gc-1
    const gc = makeEvent({ id: 'gc-1', parentId: 'child-1', depth: 2 });
    const child = makeEvent({ id: 'child-1', parentId: 'root', childrenIds: ['gc-1'], depth: 1 });
    const root = makeEvent({ id: 'root', childrenIds: ['child-1'] });
    const allEvents = [root, child, gc];

    const result = propagateWorldLineChange(allEvents, 'root', 1);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('child-1');
    expect(gc.worldLineChanged).toBe(false);
  });
});

// ====================================================================
// preCheckPlot
// ====================================================================

// Mock database and plot-outline for preCheckPlot
vi.mock('./database', () => ({
  getPlotEvents: vi.fn(),
  savePlotEvent: vi.fn(),
  savePlotEvents: vi.fn(),
}));

vi.mock('./plot-outline', () => ({
  getActiveOutline: vi.fn(),
  updateOutlineVersion: vi.fn(),
  outlineToEvents: vi.fn(),
  syncOutlineEvents: vi.fn(),
}));

import { getPlotEvents, savePlotEvent, savePlotEvents } from './database';

describe('preCheckPlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应触发符合条件的 pending 事件', async () => {
    const event = makeEvent({ id: 'evt-1', status: 'pending', triggerCondition: '{{hp}} < 50' });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);
    vi.mocked(savePlotEvent).mockResolvedValue('evt-1');

    const agentOutput = JSON.stringify({
      triggeredEvents: [{ id: 'evt-1', reason: '血量低触发事件' }],
      relevantBackground: '角色濒死',
    });
    const vars = { hp: 30 };

    const result = await preCheckPlot('save-1', agentOutput, vars);
    expect(result.triggeredEvents).toHaveLength(1);
    expect(result.triggeredEvents[0].id).toBe('evt-1');
    expect(result.triggeredEvents[0].status).toBe('active');
    expect(result.background).toBe('角色濒死');
    expect(savePlotEvent).toHaveBeenCalledTimes(1);
  });

  it('应跳过非 pending 状态的事件', async () => {
    const event = makeEvent({ id: 'evt-1', status: 'completed' });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const agentOutput = JSON.stringify({
      triggeredEvents: [{ id: 'evt-1', reason: '尝试触发已完成事件' }],
      relevantBackground: '',
    });

    const result = await preCheckPlot('save-1', agentOutput, {});
    expect(result.triggeredEvents).toHaveLength(0);
    expect(savePlotEvent).not.toHaveBeenCalled();
  });

  it('应跳过条件不满足的 pending 事件', async () => {
    const event = makeEvent({
      id: 'evt-1',
      status: 'pending',
      triggerCondition: '{{hp}} < 30',
    });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const agentOutput = JSON.stringify({
      triggeredEvents: [{ id: 'evt-1', reason: '不会触发' }],
      relevantBackground: '',
    });
    const vars = { hp: 100 };

    const result = await preCheckPlot('save-1', agentOutput, vars);
    expect(result.triggeredEvents).toHaveLength(0);
    expect(savePlotEvent).not.toHaveBeenCalled();
  });

  it('空的 parse 结果应返回空 triggeredEvents', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);

    const result = await preCheckPlot('save-1', '无JSON文本', {});
    expect(result.triggeredEvents).toEqual([]);
    expect(result.background).toBe('');
    expect(savePlotEvent).not.toHaveBeenCalled();
  });

  it('parse 有 background 但无 triggeredEvents 时应返回 background', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);

    const agentOutput = JSON.stringify({
      triggeredEvents: [],
      relevantBackground: '仅背景信息，无触发事件',
    });
    const result = await preCheckPlot('save-1', agentOutput, {});
    expect(result.triggeredEvents).toEqual([]);
    expect(result.background).toBe('仅背景信息，无触发事件');
  });

  it('事件不在数据库中时应跳过', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);

    const agentOutput = JSON.stringify({
      triggeredEvents: [{ id: 'missing-evt', reason: '不存在' }],
      relevantBackground: '',
    });
    const result = await preCheckPlot('save-1', agentOutput, {});
    expect(result.triggeredEvents).toHaveLength(0);
    expect(savePlotEvent).not.toHaveBeenCalled();
  });

  it('无触发条件的 pending 事件应直接激活', async () => {
    const event = makeEvent({ id: 'evt-no-cond', status: 'pending', triggerCondition: undefined });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);
    vi.mocked(savePlotEvent).mockResolvedValue('evt-no-cond');

    const agentOutput = JSON.stringify({
      triggeredEvents: [{ id: 'evt-no-cond', reason: '无条件触发' }],
      relevantBackground: '',
    });

    const result = await preCheckPlot('save-1', agentOutput, {});
    expect(result.triggeredEvents).toHaveLength(1);
    expect(result.triggeredEvents[0].status).toBe('active');
  });
});

// ====================================================================
// postCheckPlot
// ====================================================================

import { getActiveOutline, updateOutlineVersion } from './plot-outline';

describe('postCheckPlot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应处理 complete/fail/skip 状态更新', async () => {
    const evt1 = makeEvent({ id: 'evt-1', status: 'active' });
    const evt2 = makeEvent({ id: 'evt-2', status: 'active' });
    const evt3 = makeEvent({ id: 'evt-3', status: 'active' });

    vi.mocked(getPlotEvents).mockResolvedValue([evt1, evt2, evt3]);

    const agentOutput = JSON.stringify({
      worldLineChanged: false,
      changeLevel: 'none',
      outlineChanges: { action: 'none', changes: '' },
      eventUpdates: [
        { id: 'evt-1', action: 'complete', changes: {} },
        { id: 'evt-2', action: 'fail', changes: {} },
        { id: 'evt-3', action: 'skip', changes: {} },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.eventsUpdated).toHaveLength(3);
    expect(evt1.status).toBe('completed');
    expect(evt2.status).toBe('failed');
    expect(evt3.status).toBe('skipped');
    expect(result.worldLineChanged).toBe(false);
    expect(result.outlineUpdated).toBe(false);
  });

  it('应创建新子事件', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);

    const agentOutput = JSON.stringify({
      worldLineChanged: false,
      changeLevel: 'none',
      outlineChanges: { action: 'none', changes: '' },
      eventUpdates: [],
      newChildEvents: [
        { title: '新支线1', description: '描述1', depth: 1 },
        { title: '新支线2', description: '描述2', triggerCondition: '{{flag}} == 1', depth: 2 },
      ],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.newEvents).toHaveLength(2);
    expect(result.newEvents[0].title).toBe('新支线1');
    expect(result.newEvents[0].status).toBe('pending');
    expect(result.newEvents[0].saveId).toBe('save-1');
    expect(result.newEvents[1].triggerCondition).toBe('{{flag}} == 1');
    expect(result.newEvents[1].depth).toBe(2);
    expect(savePlotEvents).toHaveBeenCalled();
  });

  it('世界线变动 + moderate 级别应触发大纲更新和级联传播', async () => {
    const event = makeEvent({
      id: 'evt-wl',
      status: 'active',
      childrenIds: [],
      worldLineChanged: false,
    });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const outline = makeOutline({ content: '原大纲', version: 3 });
    vi.mocked(getActiveOutline).mockResolvedValue(outline);
    vi.mocked(updateOutlineVersion).mockResolvedValue({ ...outline, version: 4 });

    const agentOutput = JSON.stringify({
      worldLineChanged: true,
      changeLevel: 'moderate',
      outlineChanges: { action: 'update', changes: '某角色提前死亡' },
      eventUpdates: [
        { id: 'evt-wl', action: 'update', changes: { worldLineChanged: true } },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.worldLineChanged).toBe(true);
    expect(result.changeLevel).toBe('moderate');
    expect(result.outlineUpdated).toBe(true);
    expect(getActiveOutline).toHaveBeenCalledWith('save-1');
    expect(updateOutlineVersion).toHaveBeenCalled();
  });

  it('minor 级别世界线变动不应触发大纲更新', async () => {
    const event = makeEvent({ id: 'evt-minor', status: 'active', childrenIds: [] });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const outline = makeOutline();
    vi.mocked(getActiveOutline).mockResolvedValue(outline);

    const agentOutput = JSON.stringify({
      worldLineChanged: true,
      changeLevel: 'minor',
      outlineChanges: { action: 'none', changes: '' },
      eventUpdates: [
        { id: 'evt-minor', action: 'complete', changes: {} },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.worldLineChanged).toBe(true);
    expect(result.outlineUpdated).toBe(false);
    // minor → 不调用 updateOutlineVersion
    expect(updateOutlineVersion).not.toHaveBeenCalled();
  });

  it('空解析结果应返回全空/默认值', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);

    const result = await postCheckPlot('save-1', '无JSON');
    expect(result.eventsUpdated).toEqual([]);
    expect(result.newEvents).toEqual([]);
    expect(result.outlineUpdated).toBe(false);
    expect(result.worldLineChanged).toBe(false);
    expect(result.changeLevel).toBe('none');
  });

  it('update action 应合并 changes 字段', async () => {
    const event = makeEvent({
      id: 'evt-update',
      status: 'active',
      description: '原始描述',
    });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const agentOutput = JSON.stringify({
      worldLineChanged: false,
      changeLevel: 'none',
      outlineChanges: { action: 'none', changes: '' },
      eventUpdates: [
        {
          id: 'evt-update',
          action: 'update',
          changes: { status: 'completed', description: '修改后描述', worldLineChanged: false },
        },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.eventsUpdated).toHaveLength(1);
    expect(event.status).toBe('completed');
    expect(event.description).toBe('修改后描述');
  });

  it('worldLineChanged 但 outlineChanges action 为 none 时不更新大纲', async () => {
    const event = makeEvent({ id: 'evt-none', status: 'active' });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);

    const outline = makeOutline();
    vi.mocked(getActiveOutline).mockResolvedValue(outline);

    const agentOutput = JSON.stringify({
      worldLineChanged: true,
      changeLevel: 'moderate',
      outlineChanges: { action: 'none', changes: '' },
      eventUpdates: [
        { id: 'evt-none', action: 'complete', changes: {} },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.outlineUpdated).toBe(false);
  });

  it('worldLineChanged 但无活跃大纲时不应报错', async () => {
    const event = makeEvent({ id: 'evt-no-outline', status: 'active' });
    vi.mocked(getPlotEvents).mockResolvedValue([event]);
    vi.mocked(getActiveOutline).mockResolvedValue(undefined);

    const agentOutput = JSON.stringify({
      worldLineChanged: true,
      changeLevel: 'moderate',
      outlineChanges: { action: 'update', changes: '无大纲时的变动' },
      eventUpdates: [
        { id: 'evt-no-outline', action: 'complete', changes: {} },
      ],
      newChildEvents: [],
    });

    const result = await postCheckPlot('save-1', agentOutput);
    expect(result.outlineUpdated).toBe(false);
    expect(updateOutlineVersion).not.toHaveBeenCalled();
  });
});

// ====================================================================
// getPendingEventsForTrigger
// ====================================================================

describe('getPendingEventsForTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应返回满足条件的 pending 事件', async () => {
    const evt1 = makeEvent({ id: 'evt-1', status: 'pending', triggerCondition: '{{x}} > 10' });
    const evt2 = makeEvent({ id: 'evt-2', status: 'pending', triggerCondition: undefined });
    const evt3 = makeEvent({ id: 'evt-3', status: 'completed', triggerCondition: '{{x}} > 10' });
    vi.mocked(getPlotEvents).mockResolvedValue([evt1, evt2, evt3]);

    const result = await getPendingEventsForTrigger('save-1', { x: 20 });
    expect(result).toHaveLength(2);
    const ids = result.map(e => e.id);
    expect(ids).toContain('evt-1');
    expect(ids).toContain('evt-2');
    // evt-3 不是 pending
  });

  it('应排除条件不满足的 pending 事件', async () => {
    const evt = makeEvent({ id: 'evt-1', status: 'pending', triggerCondition: '{{x}} > 100' });
    vi.mocked(getPlotEvents).mockResolvedValue([evt]);

    const result = await getPendingEventsForTrigger('save-1', { x: 5 });
    expect(result).toEqual([]);
  });

  it('空事件列表应返回空数组', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);
    const result = await getPendingEventsForTrigger('save-1', {});
    expect(result).toEqual([]);
  });
});

// ====================================================================
// autoGenerateMemoriesFromEvents
// ====================================================================

describe('autoGenerateMemoriesFromEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应为所有 completed/failed 事件生成记忆', async () => {
    const evt1 = makeEvent({ id: 'evt-1', title: '事件A', status: 'completed' });
    const evt2 = makeEvent({ id: 'evt-2', title: '事件B', status: 'failed' });
    const evt3 = makeEvent({ id: 'evt-3', title: '事件C', status: 'pending' });
    const evt4 = makeEvent({ id: 'evt-4', title: '事件D', status: 'active' });
    vi.mocked(getPlotEvents).mockResolvedValue([evt1, evt2, evt3, evt4]);

    const memories = await autoGenerateMemoriesFromEvents('save-1');
    expect(memories).toHaveLength(2);
    expect(memories[0].relatedPlotEventId).toBe('evt-1');
    expect(memories[1].relatedPlotEventId).toBe('evt-2');
    // 跳过 pending 和 active
  });

  it('应传递 gameTimeRange 给生成的记忆', async () => {
    const evt = makeEvent({ id: 'evt-1', title: '事件', status: 'completed' });
    vi.mocked(getPlotEvents).mockResolvedValue([evt]);

    const range = { start: '第5年春', end: '第5年冬' };
    const memories = await autoGenerateMemoriesFromEvents('save-1', range);
    expect(memories).toHaveLength(1);
    expect(memories[0].timeRange).toEqual(range);
  });

  it('无 completed/failed 事件时应返回空数组', async () => {
    const evt = makeEvent({ id: 'evt-1', status: 'pending' });
    vi.mocked(getPlotEvents).mockResolvedValue([evt]);

    const memories = await autoGenerateMemoriesFromEvents('save-1');
    expect(memories).toEqual([]);
  });

  it('空事件列表应返回空数组', async () => {
    vi.mocked(getPlotEvents).mockResolvedValue([]);
    const memories = await autoGenerateMemoriesFromEvents('save-1');
    expect(memories).toEqual([]);
  });
});
