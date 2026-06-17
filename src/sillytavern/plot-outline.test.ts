/**
 * plot-outline.ts — 剧情大纲管理测试
 *
 * Phase 4 核心模块测试。覆盖大纲解析/创建/自检/确认/章节解析/
 * 事件生成/版本更新/设置判断/事件同步等全部导出函数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  PlotOutline,
  PlotSettings,
  PlotEvent,
  CharacterState,
} from './types';

// ========== Mock database ==========

const mockGetLatestPlotOutline = vi.fn();
const mockSavePlotOutline = vi.fn();
const mockGetPlotEvents = vi.fn();
const mockSavePlotEvents = vi.fn();

vi.mock('./database', () => ({
  getLatestPlotOutline: (...args: any[]) => mockGetLatestPlotOutline(...args),
  savePlotOutline: (...args: any[]) => mockSavePlotOutline(...args),
  getPlotEvents: (...args: any[]) => mockGetPlotEvents(...args),
  savePlotEvents: (...args: any[]) => mockSavePlotEvents(...args),
}));

// Imported after mock so they resolve to mocked DB
import {
  parseOutlineAgentOutput,
  createOutlineFromAgent,
  evaluateOutlineQuality,
  confirmOutline,
  parseOutlineChapters,
  outlineToEvents,
  updateOutlineVersion,
  shouldGenerateOutline,
  isSideMode,
  isMainMode,
  getActiveOutline,
  syncOutlineEvents,
} from './plot-outline';

// ========== Helpers ==========

function makePlotSettings(overrides: Partial<PlotSettings> = {}): PlotSettings {
  return {
    mode: 'off',
    ...overrides,
  };
}

function makeOutline(overrides: Partial<PlotOutline> = {}): PlotOutline {
  return {
    id: 'outline-1',
    saveId: 'save-1',
    mode: 'main',
    content: '# 出发\n主角踏上旅程。\n\n## 遭遇\n在森林中遭遇魔兽。',
    selfCritique: '评分: 8/10\n优点: 结构清晰\n不足: 细节不足\n建议: 增加描写',
    confirmed: false,
    version: 1,
    timeRange: { start: '元年1月', end: '元年12月' },
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makePlotEvent(overrides: Partial<PlotEvent> = {}): PlotEvent {
  return {
    id: 'event-1',
    saveId: 'save-1',
    title: '出发',
    description: '主角踏上旅程',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    depth: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

// ========== parseOutlineAgentOutput ==========

describe('parseOutlineAgentOutput', () => {
  it('应解析带 selfCritique 的有效 JSON 输出', () => {
    const raw = JSON.stringify({
      content: '主线剧情大纲...',
      selfCritique: {
        score: 8,
        strengths: ['结构清晰', '节奏好'],
        weaknesses: ['角色动机模糊'],
        suggestions: ['补充角色背景'],
      },
    });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('主线剧情大纲...');
    expect(result!.selfCritique).toContain('评分: 8/10');
    expect(result!.selfCritique).toContain('结构清晰');
    expect(result!.selfCritique).toContain('角色动机模糊');
    expect(result!.selfCritique).toContain('补充角色背景');
  });

  it('应解析不带 selfCritique 的有效 JSON 输出', () => {
    const raw = JSON.stringify({ content: '纯大纲内容，无自检' });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('纯大纲内容，无自检');
    expect(result!.selfCritique).toBeUndefined();
  });

  it('空 content 字段应返回 null', () => {
    const raw = JSON.stringify({ content: '' });
    const result = parseOutlineAgentOutput(raw);
    expect(result).toBeNull();
  });

  it('无效 JSON 但包含 JSON 子串的文本应尝试二次解析', () => {
    const raw = '这是一些前缀文本 {"content": "嵌入的JSON大纲"} 这是一些后缀文本';
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('嵌入的JSON大纲');
  });

  it('完全无效且无 JSON 子串的文本应返回 null', () => {
    const raw = '这不是 JSON，只是一段普通文本。';
    const result = parseOutlineAgentOutput(raw);
    expect(result).toBeNull();
  });

  it('JSON 子串中 content 为空也应返回 null', () => {
    const raw = 'text prefix {"content": ""} text suffix';
    const result = parseOutlineAgentOutput(raw);
    expect(result).toBeNull();
  });

  it('selfCritique 中缺少 strengths/weaknesses/suggestions 字段时不应报错', () => {
    const raw = JSON.stringify({
      content: '大纲内容',
      selfCritique: { score: 5 },
    });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    // .join() on undefined produces the string "undefined"
    expect(result!.selfCritique).toContain('评分: 5/10');
    expect(result!.selfCritique).toContain('优点:');
    expect(result!.selfCritique).toContain('不足:');
    expect(result!.selfCritique).toContain('建议:');
    // Should not throw even with missing optional fields
    expect(result!.content).toBe('大纲内容');
  });
});

// ========== createOutlineFromAgent ==========

describe('createOutlineFromAgent', () => {
  const saveId = 'save-test-1';
  const timeRange = { start: '元年1月', end: '元年3月' };

  it('应从有效 agentOutput 创建完整 PlotOutline', () => {
    const raw = JSON.stringify({
      content: '完整剧情大纲...',
      selfCritique: { score: 7, strengths: ['好'], weaknesses: [], suggestions: [] },
    });
    const outline = createOutlineFromAgent(saveId, 'main', raw, timeRange);
    expect(outline).not.toBeNull();
    expect(outline!.saveId).toBe(saveId);
    expect(outline!.mode).toBe('main');
    expect(outline!.content).toBe('完整剧情大纲...');
    expect(outline!.selfCritique).toContain('评分: 7/10');
    expect(outline!.confirmed).toBe(false);
    expect(outline!.version).toBe(1);
    expect(outline!.timeRange).toEqual(timeRange);
    expect(outline!.id).toBeDefined();
    expect(typeof outline!.id).toBe('string');
    expect(outline!.createdAt).toBeGreaterThan(0);
    expect(outline!.updatedAt).toBe(outline!.createdAt);
  });

  it('无效 agentOutput 应返回 null', () => {
    const result = createOutlineFromAgent(saveId, 'side', '纯文本无JSON', timeRange);
    expect(result).toBeNull();
  });

  it('应支持自定义 version 参数', () => {
    const raw = JSON.stringify({ content: 'v3 大纲' });
    const outline = createOutlineFromAgent(saveId, 'main', raw, timeRange, 3);
    expect(outline).not.toBeNull();
    expect(outline!.version).toBe(3);
  });

  it('mode 为 off 时也能创建 outline（尽管不应通常调用）', () => {
    const raw = JSON.stringify({ content: 'off 模式大纲' });
    const outline = createOutlineFromAgent(saveId, 'off', raw, timeRange);
    expect(outline).not.toBeNull();
    expect(outline!.mode).toBe('off');
  });
});

// ========== evaluateOutlineQuality ==========

describe('evaluateOutlineQuality', () => {
  it('高评分自检（>=6）应判定为 isGood', () => {
    const outline = makeOutline({
      selfCritique: '评分: 8/10\n优点: 节奏紧凑\n不足: 无\n建议: 无',
    });
    const eval_ = evaluateOutlineQuality(outline);
    expect(eval_.hasCritique).toBe(true);
    expect(eval_.isGood).toBe(true);
    expect(eval_.critiqueText).toContain('8/10');
  });

  it('低评分自检（<6）应判定为 not good', () => {
    const outline = makeOutline({
      selfCritique: '评分: 3/10\n优点: 无\n不足: 结构混乱\n建议: 重写',
    });
    const eval_ = evaluateOutlineQuality(outline);
    expect(eval_.hasCritique).toBe(true);
    expect(eval_.isGood).toBe(false);
    expect(eval_.critiqueText).toContain('3/10');
  });

  it('边界值 6 分应判定为 isGood', () => {
    const outline = makeOutline({
      selfCritique: '评分: 6/10\n优点: 尚可\n不足: 一般\n建议: 改进',
    });
    const eval_ = evaluateOutlineQuality(outline);
    expect(eval_.isGood).toBe(true);
  });

  it('无自检的 outline 应返回 hasCritique=false 且 isGood=false', () => {
    const outline = makeOutline({ selfCritique: undefined });
    const eval_ = evaluateOutlineQuality(outline);
    expect(eval_.hasCritique).toBe(false);
    expect(eval_.isGood).toBe(false);
    expect(eval_.critiqueText).toBe('暂无自检结果');
  });

  it('评分格式为中文冒号也应正确提取', () => {
    const outline = makeOutline({
      selfCritique: '评分：9/10\n优点: 出色',
    });
    const eval_ = evaluateOutlineQuality(outline);
    expect(eval_.isGood).toBe(true);
  });
});

// ========== confirmOutline ==========

describe('confirmOutline', () => {
  beforeEach(() => {
    mockSavePlotOutline.mockReset();
  });

  it('应将 confirmed 设为 true 并调用 savePlotOutline', async () => {
    const outline = makeOutline({ confirmed: false });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const result = await confirmOutline(outline);
    expect(result.confirmed).toBe(true);
    expect(mockSavePlotOutline).toHaveBeenCalledTimes(1);
    expect(mockSavePlotOutline).toHaveBeenCalledWith(outline);
  });

  it('应在持久化前更新 updatedAt', async () => {
    const before = Date.now();
    const outline = makeOutline({ confirmed: false, updatedAt: 1000 });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    await confirmOutline(outline);
    expect(outline.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('应返回同一个 outline 对象引用', async () => {
    const outline = makeOutline();
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const result = await confirmOutline(outline);
    expect(result).toBe(outline);
  });
});

// ========== parseOutlineChapters ==========

describe('parseOutlineChapters', () => {
  it('应解析以 # 开头的章节标题', () => {
    const content = '# 第一章 启程\n离开村庄，踏上旅途。\n\n# 第二章 试炼\n通过古代遗迹的考验。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('第一章 启程');
    expect(chapters[0].summary).toBe('离开村庄，踏上旅途。');
    expect(chapters[1].title).toBe('第二章 试炼');
    expect(chapters[1].summary).toBe('通过古代遗迹的考验。');
  });

  it('应解析以 ## 开头的章节标题', () => {
    const content = '## 序章\n故事的开端。\n\n## 终章\n故事的终结。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('序章');
    expect(chapters[1].title).toBe('终章');
  });

  it('应解析以 ### 开头的章节标题', () => {
    const content = '### 小节一\n细节描述。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('小节一');
  });

  it('应解析中文数字编号的章节（第X章）', () => {
    const content = '第一章 初遇\n在酒馆中相遇。\n\n第二章 分离\n因战争被迫分别。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('第一章 初遇');
    expect(chapters[1].title).toBe('第二章 分离');
  });

  it('应解析阿拉伯数字编号的章节（第1章）', () => {
    const content = '第1章 初始\n出发前往王都。\n第2章 挑战\n遭遇骑士団。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('第1章 初始');
    expect(chapters[1].title).toBe('第2章 挑战');
  });

  it('空内容应返回空数组', () => {
    const chapters = parseOutlineChapters('');
    expect(chapters).toHaveLength(0);
  });

  it('仅有标题无内容的章节也应被解析', () => {
    const content = '# 独立标题';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('独立标题');
    expect(chapters[0].summary).toBe('');
  });

  it('无章节标题的纯文本应返回空数组', () => {
    const content = '这是一段没有章节标题的纯文本描述。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(0);
  });

  it('应正确处理章节间的空行', () => {
    // 注意: 内容避免以"第X章"开头，否则会触发编号章节正则
    const content = '# 第一章\n\n\n这是第一章的内容。\n\n\n\n# 第二章\n这是第二章的内容。';
    const chapters = parseOutlineChapters(content);
    expect(chapters).toHaveLength(2);
    expect(chapters[0].summary).toContain('这是第一章的内容');
    expect(chapters[1].summary).toContain('这是第二章的内容');
  });
});

// ========== outlineToEvents ==========

describe('outlineToEvents', () => {
  it('应为每个章节生成一个 PlotEvent', () => {
    const outline = makeOutline({
      content: '# 出发\n踏上旅程。\n\n# 试炼\n通过考验。\n\n# 归来\n回到故乡。',
    });
    const events = outlineToEvents(outline, 'save-x');
    expect(events).toHaveLength(3);
    expect(events[0].title).toBe('出发');
    expect(events[1].title).toBe('试炼');
    expect(events[2].title).toBe('归来');
  });

  it('所有事件应有正确的 saveId', () => {
    const outline = makeOutline({ content: '# 一章\n内容。' });
    const events = outlineToEvents(outline, 'save-target');
    for (const e of events) {
      expect(e.saveId).toBe('save-target');
    }
  });

  it('所有事件状态应为 pending', () => {
    const outline = makeOutline({ content: '# 一章\n内容。\n\n# 二章\n内容。' });
    const events = outlineToEvents(outline, 'save-1');
    for (const e of events) {
      expect(e.status).toBe('pending');
    }
  });

  it('应使用正确的 depth 参数', () => {
    const outline = makeOutline({ content: '# 事件\n描述。' });
    const eventsDepth0 = outlineToEvents(outline, 'save-1', 0);
    expect(eventsDepth0[0].depth).toBe(0);

    const eventsDepth2 = outlineToEvents(outline, 'save-1', 2);
    expect(eventsDepth2[0].depth).toBe(2);
  });

  it('默认 depth 应为 0', () => {
    const outline = makeOutline({ content: '# 事件\n描述。' });
    const events = outlineToEvents(outline, 'save-1');
    expect(events[0].depth).toBe(0);
  });

  it('描述应被截断至 500 字符', () => {
    const longSummary = 'A'.repeat(600);
    const outline = makeOutline({
      content: `# 长章节\n${longSummary}`,
    });
    const events = outlineToEvents(outline, 'save-1');
    expect(events[0].description.length).toBeLessThanOrEqual(500);
    expect(events[0].description).toBe(longSummary.slice(0, 500));
  });

  it('事件的 order 应正确递增', () => {
    const outline = makeOutline({
      content: '# 一\n一。\n\n# 二\n二。\n\n# 三\n三。\n\n# 四\n四。',
    });
    const events = outlineToEvents(outline, 'save-1');
    expect(events[0].order).toBe(0);
    expect(events[1].order).toBe(10);
    expect(events[2].order).toBe(20);
    expect(events[3].order).toBe(30);
  });

  it('每个事件应有唯一 UUID', () => {
    const outline = makeOutline({
      content: '# A\n内容。\n\n# B\n内容。',
    });
    const events = outlineToEvents(outline, 'save-1');
    expect(events[0].id).not.toBe(events[1].id);
  });

  it('空章节大纲应返回空数组', () => {
    const outline = makeOutline({ content: '无标题的纯文本' });
    const events = outlineToEvents(outline, 'save-1');
    expect(events).toHaveLength(0);
  });
});

// ========== updateOutlineVersion ==========

describe('updateOutlineVersion', () => {
  beforeEach(() => {
    mockSavePlotOutline.mockReset();
  });

  it('应增加版本号并更新内容', async () => {
    const outline = makeOutline({ version: 1 });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(outline, '新的大纲内容');
    expect(updated.version).toBe(2);
    expect(updated.content).toBe('新的大纲内容');
    expect(mockSavePlotOutline).toHaveBeenCalledWith(updated);
  });

  it('应更新 updatedAt', async () => {
    const before = Date.now();
    const outline = makeOutline({ version: 1, updatedAt: 1000 });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(outline, '新内容');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('有 changeDescription 且原来自检存在时，应追加至 selfCritique', async () => {
    const outline = makeOutline({
      version: 1,
      selfCritique: '评分: 7/10\n原自检内容',
    });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(
      outline,
      'v2 内容',
      '主角选择了另一条道路',
    );
    expect(updated.selfCritique).toContain('原自检内容');
    expect(updated.selfCritique).toContain('世界线变动记录 (v2)');
    expect(updated.selfCritique).toContain('主角选择了另一条道路');
  });

  it('有 changeDescription 但原自检不存在时，应新建自检记录', async () => {
    const outline = makeOutline({ version: 1, selfCritique: undefined });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(
      outline,
      'v2 内容',
      '世界线分歧',
    );
    expect(updated.selfCritique).toContain('世界线变动记录 (v2)');
    expect(updated.selfCritique).toContain('世界线分歧');
    expect(updated.selfCritique).not.toContain('---');
  });

  it('无 changeDescription 时不应修改自检', async () => {
    const outline = makeOutline({
      version: 1,
      selfCritique: '评分: 8/10\n原始自检',
    });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(outline, 'v2 内容');
    expect(updated.selfCritique).toBe('评分: 8/10\n原始自检');
  });
});

// ========== shouldGenerateOutline ==========

describe('shouldGenerateOutline', () => {
  it('mode 为 off 时应返回 false', () => {
    const settings = makePlotSettings({ mode: 'off' });
    expect(shouldGenerateOutline(settings)).toBe(false);
  });

  it('mode 为 side 时应返回 true', () => {
    const settings = makePlotSettings({ mode: 'side' });
    expect(shouldGenerateOutline(settings)).toBe(true);
  });

  it('mode 为 main 时应返回 true', () => {
    const settings = makePlotSettings({ mode: 'main' });
    expect(shouldGenerateOutline(settings)).toBe(true);
  });
});

// ========== isSideMode / isMainMode ==========

describe('isSideMode', () => {
  it('mode=side 返回 true', () => {
    expect(isSideMode(makePlotSettings({ mode: 'side' }))).toBe(true);
  });

  it('mode=main 返回 false', () => {
    expect(isSideMode(makePlotSettings({ mode: 'main' }))).toBe(false);
  });

  it('mode=off 返回 false', () => {
    expect(isSideMode(makePlotSettings({ mode: 'off' }))).toBe(false);
  });
});

describe('isMainMode', () => {
  it('mode=main 返回 true', () => {
    expect(isMainMode(makePlotSettings({ mode: 'main' }))).toBe(true);
  });

  it('mode=side 返回 false', () => {
    expect(isMainMode(makePlotSettings({ mode: 'side' }))).toBe(false);
  });

  it('mode=off 返回 false', () => {
    expect(isMainMode(makePlotSettings({ mode: 'off' }))).toBe(false);
  });
});

// ========== getActiveOutline ==========

describe('getActiveOutline', () => {
  beforeEach(() => {
    mockGetLatestPlotOutline.mockReset();
  });

  it('应将调用委托给 getLatestPlotOutline', async () => {
    const expectedOutline = makeOutline({ id: 'active-1' });
    mockGetLatestPlotOutline.mockResolvedValue(expectedOutline);

    const result = await getActiveOutline('save-1');
    expect(mockGetLatestPlotOutline).toHaveBeenCalledWith('save-1');
    expect(result).toBe(expectedOutline);
  });

  it('无大纲时返回 undefined', async () => {
    mockGetLatestPlotOutline.mockResolvedValue(undefined);
    const result = await getActiveOutline('save-empty');
    expect(result).toBeUndefined();
  });
});

// ========== syncOutlineEvents ==========

describe('syncOutlineEvents', () => {
  beforeEach(() => {
    mockGetPlotEvents.mockReset();
    mockSavePlotEvents.mockReset();
  });

  it('应添加数据库中不存在的新事件', async () => {
    mockGetPlotEvents.mockResolvedValue([]);
    mockSavePlotEvents.mockResolvedValue(undefined);

    const newEvents = [
      makePlotEvent({ id: 'e1', title: '出发' }),
      makePlotEvent({ id: 'e2', title: '试炼' }),
    ];
    const result = await syncOutlineEvents('save-1', newEvents);
    expect(result).toEqual({ added: 2, skipped: 0 });
    expect(mockSavePlotEvents).toHaveBeenCalledWith(newEvents);
  });

  it('应跳过标题重复的事件', async () => {
    const existingEvent = makePlotEvent({ id: 'existing', title: '出发' });
    mockGetPlotEvents.mockResolvedValue([existingEvent]);
    mockSavePlotEvents.mockResolvedValue(undefined);

    const newEvents = [
      makePlotEvent({ id: 'e1', title: '出发' }),
      makePlotEvent({ id: 'e2', title: '试炼' }),
    ];
    const result = await syncOutlineEvents('save-1', newEvents);
    expect(result).toEqual({ added: 1, skipped: 1 });
    // 只保存新的（试炼）
    expect(mockSavePlotEvents).toHaveBeenCalledTimes(1);
    const saved = mockSavePlotEvents.mock.calls[0][0] as PlotEvent[];
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe('试炼');
  });

  it('所有事件都重复时应 skip 全部', async () => {
    const existing = [
      makePlotEvent({ id: 'a', title: '出发' }),
      makePlotEvent({ id: 'b', title: '试炼' }),
      makePlotEvent({ id: 'c', title: '归来' }),
    ];
    mockGetPlotEvents.mockResolvedValue(existing);
    mockSavePlotEvents.mockResolvedValue(undefined);

    const newEvents = [
      makePlotEvent({ id: 'x', title: '出发' }),
      makePlotEvent({ id: 'y', title: '试炼' }),
      makePlotEvent({ id: 'z', title: '归来' }),
    ];
    const result = await syncOutlineEvents('save-1', newEvents);
    expect(result).toEqual({ added: 0, skipped: 3 });
    expect(mockSavePlotEvents).not.toHaveBeenCalled();
  });

  it('空新事件列表应返回全零', async () => {
    mockGetPlotEvents.mockResolvedValue([]);
    const result = await syncOutlineEvents('save-1', []);
    expect(result).toEqual({ added: 0, skipped: 0 });
    expect(mockSavePlotEvents).not.toHaveBeenCalled();
  });

  it('混合场景：部分新增 + 部分重复', async () => {
    const existing = [
      makePlotEvent({ id: 'old-1', title: '第一章' }),
    ];
    mockGetPlotEvents.mockResolvedValue(existing);
    mockSavePlotEvents.mockResolvedValue(undefined);

    const newEvents = [
      makePlotEvent({ id: 'new-1', title: '第一章' }),
      makePlotEvent({ id: 'new-2', title: '第二章' }),
      makePlotEvent({ id: 'new-3', title: '第三章' }),
    ];
    const result = await syncOutlineEvents('save-1', newEvents);
    expect(result).toEqual({ added: 2, skipped: 1 });
    const saved = mockSavePlotEvents.mock.calls[0][0] as PlotEvent[];
    expect(saved.map((e: PlotEvent) => e.title)).toEqual(['第二章', '第三章']);
  });
});
