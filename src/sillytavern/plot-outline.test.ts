/**
 * plot-outline.ts — 剧情大纲管理测试
 *
 * Phase 4 核心模块测试。覆盖大纲解析/创建/自检/确认/章节解析/
 * 事件生成/版本更新/设置判断/事件同步等全部导出函数。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PlotOutline, PlotSettings, PlotEvent, CharacterState } from './types';

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
  parseOutlineJson,
  parseOutlineXml,
  tryParseOutline,
  createOutlineFromAgent,
  evaluateOutlineQuality,
  confirmOutline,
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
    tabooContent: '',
    ...overrides,
  };
}

function makeOutline(overrides: Partial<PlotOutline> = {}): PlotOutline {
  return {
    id: 'outline-1',
    saveId: 'save-1',
    mode: 'main',
    title: '测试大纲',
    summary: '一句话摘要',
    content: '# 出发\n主角踏上旅程。\n\n## 遭遇\n在森林中遭遇魔兽。',
    chapters: [],
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
    visibility: 'hidden',
    depth: 0,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

// ========== parseOutlineAgentOutput ==========

describe('parseOutlineAgentOutput', () => {
  it('应解析完整新 JSON 形状（title/summary/content/chapters/selfCritique）', () => {
    const raw = JSON.stringify({
      title: '血色纹章',
      summary: '一场围绕帝国纹章的阴谋',
      content: '# 第一章 血色纹章\n主线剧情大纲...',
      chapters: [
        {
          title: '第一章 血色纹章',
          summary: '主角卷入阴谋',
          keyEvents: [
            { title: '纹章失窃', description: '皇家纹章被盗', triggerHint: '主角到达帝都' },
          ],
        },
      ],
      selfCritique: {
        score: 8,
        strengths: ['结构清晰', '节奏好'],
        weaknesses: ['角色动机模糊'],
        suggestions: ['补充角色背景'],
      },
    });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('血色纹章');
    expect(result!.summary).toBe('一场围绕帝国纹章的阴谋');
    expect(result!.content).toContain('主线剧情大纲');
    expect(result!.chapters).toHaveLength(1);
    expect(result!.chapters[0].keyEvents).toHaveLength(1);
    expect(result!.chapters[0].keyEvents[0].triggerHint).toBe('主角到达帝都');
    expect(result!.selfCritique).toContain('评分: 8/10');
    expect(result!.selfCritique).toContain('结构清晰');
  });

  it('应兼容旧形状（仅 content，无 title/summary/chapters）', () => {
    const raw = JSON.stringify({ content: '纯大纲内容，无自检' });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('纯大纲内容，无自检');
    expect(result!.title).toBe('');
    expect(result!.summary).toBe('');
    expect(result!.chapters).toEqual([]);
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

  it('chapters 中缺 title 的章节和缺 title 的 keyEvent 应被过滤', () => {
    const raw = JSON.stringify({
      content: '大纲',
      chapters: [
        { title: '', summary: '无标题章节' },
        {
          title: '有效章节',
          summary: 'ok',
          keyEvents: [
            { title: '', description: '无标题事件' },
            { title: '有效事件', description: 'ok' },
          ],
        },
      ],
    });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.chapters).toHaveLength(1);
    expect(result!.chapters[0].keyEvents).toHaveLength(1);
    expect(result!.chapters[0].keyEvents[0].title).toBe('有效事件');
  });

  it('selfCritique 中缺少 strengths/weaknesses/suggestions 字段时不应报错', () => {
    const raw = JSON.stringify({
      content: '大纲内容',
      selfCritique: { score: 5 },
    });
    const result = parseOutlineAgentOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.selfCritique).toContain('评分: 5/10');
    expect(result!.selfCritique).toContain('优点:');
    expect(result!.selfCritique).toContain('不足:');
    expect(result!.selfCritique).toContain('建议:');
    expect(result!.content).toBe('大纲内容');
  });
});

// ========== createOutlineFromAgent ==========

describe('createOutlineFromAgent', () => {
  const saveId = 'save-test-1';
  const timeRange = { start: '元年1月', end: '元年3月' };

  it('应从有效 agentOutput 创建完整 PlotOutline', () => {
    const raw = JSON.stringify({
      title: '大纲标题',
      summary: '一句话摘要',
      content: '完整剧情大纲...',
      chapters: [
        {
          title: '第一章',
          summary: '章节摘要',
          keyEvents: [{ title: '事件A', description: '描述' }],
        },
      ],
      selfCritique: { score: 7, strengths: ['好'], weaknesses: [], suggestions: [] },
    });
    const outline = createOutlineFromAgent(saveId, 'main', raw, timeRange);
    expect(outline).not.toBeNull();
    expect(outline!.saveId).toBe(saveId);
    expect(outline!.mode).toBe('main');
    expect(outline!.title).toBe('大纲标题');
    expect(outline!.summary).toBe('一句话摘要');
    expect(outline!.content).toBe('完整剧情大纲...');
    expect(outline!.chapters).toHaveLength(1);
    expect(outline!.chapters[0]).toEqual({
      title: '第一章',
      summary: '章节摘要',
      status: 'pending',
    });
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

// ========== outlineToEvents ==========

describe('outlineToEvents', () => {
  const chapters = [
    {
      title: '第一章 启程',
      summary: '离开村庄，踏上旅途。',
      keyEvents: [
        { title: '告别故乡', description: '与家人告别', triggerHint: '游戏开始' },
        { title: '初遇同伴', description: '在路上遇到旅伴', triggerHint: '{{location}} == "官道"' },
      ],
    },
    {
      title: '第二章 试炼',
      summary: '通过古代遗迹的考验。',
      keyEvents: [{ title: '遗迹之门', description: '找到遗迹入口' }],
    },
  ];

  it('章节=depth 0、keyEvent=depth 1，结构正确', () => {
    const events = outlineToEvents(chapters, 'save-x');
    expect(events).toHaveLength(5);

    const chapterEvents = events.filter((e) => e.depth === 0);
    const keyEvents = events.filter((e) => e.depth === 1);
    expect(chapterEvents).toHaveLength(2);
    expect(keyEvents).toHaveLength(3);
    expect(chapterEvents[0].title).toBe('第一章 启程');
    expect(chapterEvents[1].title).toBe('第二章 试炼');
  });

  it('keyEvent 的 parentId 指向章节事件，章节 childrenIds 包含 keyEvent', () => {
    const events = outlineToEvents(chapters, 'save-1');
    const ch1 = events.find((e) => e.title === '第一章 启程')!;
    const ke1 = events.find((e) => e.title === '告别故乡')!;
    const ke2 = events.find((e) => e.title === '初遇同伴')!;
    expect(ke1.parentId).toBe(ch1.id);
    expect(ke2.parentId).toBe(ch1.id);
    expect(ch1.childrenIds).toEqual([ke1.id, ke2.id]);
  });

  it('triggerCondition 使用 keyEvent.triggerHint', () => {
    const events = outlineToEvents(chapters, 'save-1');
    const ke = events.find((e) => e.title === '初遇同伴')!;
    expect(ke.triggerCondition).toBe('{{location}} == "官道"');
    const keNoHint = events.find((e) => e.title === '遗迹之门')!;
    expect(keNoHint.triggerCondition).toBeUndefined();
  });

  it('全部事件 visibility=hidden 且 chapterTitle=所属章标题', () => {
    const events = outlineToEvents(chapters, 'save-1');
    for (const e of events) {
      expect(e.visibility).toBe('hidden');
    }
    expect(events.find((e) => e.title === '告别故乡')!.chapterTitle).toBe('第一章 启程');
    expect(events.find((e) => e.title === '遗迹之门')!.chapterTitle).toBe('第二章 试炼');
    expect(events.find((e) => e.title === '第一章 启程')!.chapterTitle).toBe('第一章 启程');
  });

  it('所有事件应有正确的 saveId 且状态为 pending', () => {
    const events = outlineToEvents(chapters, 'save-target');
    for (const e of events) {
      expect(e.saveId).toBe('save-target');
      expect(e.status).toBe('pending');
    }
  });

  it('描述应被截断至 500 字符', () => {
    const longSummary = 'A'.repeat(600);
    const events = outlineToEvents(
      [{ title: '长章节', summary: longSummary, keyEvents: [] }],
      'save-1',
    );
    expect(events[0].description.length).toBeLessThanOrEqual(500);
    expect(events[0].description).toBe(longSummary.slice(0, 500));
  });

  it('章节 order 应递增，keyEvent order 章内独立递增', () => {
    const events = outlineToEvents(chapters, 'save-1');
    const chapterEvents = events.filter((e) => e.depth === 0);
    expect(chapterEvents[0].order).toBe(0);
    expect(chapterEvents[1].order).toBe(10);
    const ch1Keys = events.filter((e) => e.parentId === chapterEvents[0].id);
    expect(ch1Keys[0].order).toBe(0);
    expect(ch1Keys[1].order).toBe(10);
  });

  it('每个事件应有唯一 UUID', () => {
    const events = outlineToEvents(chapters, 'save-1');
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(events.length);
  });

  it('空章节列表应返回空数组', () => {
    const events = outlineToEvents([], 'save-1');
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

    const updated = await updateOutlineVersion(outline, 'v2 内容', '主角选择了另一条道路');
    expect(updated.selfCritique).toContain('原自检内容');
    expect(updated.selfCritique).toContain('世界线变动记录 (v2)');
    expect(updated.selfCritique).toContain('主角选择了另一条道路');
  });

  it('有 changeDescription 但原自检不存在时，应新建自检记录', async () => {
    const outline = makeOutline({ version: 1, selfCritique: undefined });
    mockSavePlotOutline.mockResolvedValue('outline-1');

    const updated = await updateOutlineVersion(outline, 'v2 内容', '世界线分歧');
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
    const existing = [makePlotEvent({ id: 'old-1', title: '第一章' })];
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

// ========== parseOutlineXml ==========

describe('parseOutlineXml', () => {
  it('应解析完整 XML 输出为 ParsedOutlineOutput', () => {
    const xml = `<outline>
<title>血色纹章</title>
<summary>一场围绕帝国纹章的阴谋</summary>
<timerange start="512-春" end="513-秋" />
<content># 第一章 血色纹章
主线剧情大纲...</content>
<chapter title="第一章 血色纹章" summary="主角卷入阴谋" start="512-春" end="512-夏">
  <event title="纹章失窃">
    <time start="512-春" end="512-春-04" />
    <desc>皇家纹章被盗，主角被诬陷</desc>
    <trigger>主角到达帝都</trigger>
    <complete>找到真凶并洗清嫌疑</complete>
    <fail>主角被关进大牢</fail>
  </event>
  <event title="初遇同伴">
    <time start="512-春-05" end="512-夏" />
    <desc>在追查途中遇到同伴</desc>
  </event>
</chapter>
<chapter title="第二章 暗流" summary="帝都势力登场">
  <event title="潜入议会">
    <desc>潜入议会窃取情报</desc>
  </event>
</chapter>
<self_critique score="8">
  <strength>结构清晰，节奏紧凑</strength>
  <strength>角色动机明确</strength>
  <weakness>第二章内容略显单薄</weakness>
  <suggestion>增加更多政治势力描写</suggestion>
</self_critique>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('血色纹章');
    expect(result!.summary).toBe('一场围绕帝国纹章的阴谋');
    expect(result!.content).toContain('主线剧情大纲');
    expect(result!.chapters).toHaveLength(2);

    // Chapter 1
    expect(result!.chapters[0].title).toBe('第一章 血色纹章');
    expect(result!.chapters[0].keyEvents).toHaveLength(2);

    // Event 1 with all fields
    const ev1 = result!.chapters[0].keyEvents[0];
    expect(ev1.title).toBe('纹章失窃');
    expect(ev1.description).toBe('皇家纹章被盗，主角被诬陷');
    expect(ev1.triggerHint).toBe('主角到达帝都');
    expect(ev1.completeHint).toBe('找到真凶并洗清嫌疑');
    expect(ev1.failHint).toBe('主角被关进大牢');
    expect(ev1.timeWindow).toEqual({ start: '512-春', end: '512-春-04' });

    // Event 2 with only some fields
    const ev2 = result!.chapters[0].keyEvents[1];
    expect(ev2.title).toBe('初遇同伴');
    expect(ev2.description).toBe('在追查途中遇到同伴');
    expect(ev2.timeWindow).toEqual({ start: '512-春-05', end: '512-夏' });
    expect(ev2.triggerHint).toBeUndefined();
    expect(ev2.completeHint).toBeUndefined();
    expect(ev2.failHint).toBeUndefined();

    // Chapter 2
    expect(result!.chapters[1].title).toBe('第二章 暗流');
    expect(result!.chapters[1].keyEvents).toHaveLength(1);
    const ev3 = result!.chapters[1].keyEvents[0];
    expect(ev3.title).toBe('潜入议会');
    expect(ev3.description).toBe('潜入议会窃取情报');

    // self_critique
    expect(result!.selfCritique).toContain('评分: 8/10');
    expect(result!.selfCritique).toContain('结构清晰');
    expect(result!.selfCritique).toContain('角色动机明确');
    expect(result!.selfCritique).toContain('第二章内容略显单薄');
    expect(result!.selfCritique).toContain('增加更多政治势力描写');
  });

  it('缺少可选字段（无 trigger/complete/fail）时字段为 undefined', () => {
    const xml = `<outline>
<title>测试</title>
<summary>摘要</summary>
<content>正文内容</content>
<chapter title="第一章" summary="章节摘要">
  <event title="事件A">
    <desc>描述文字</desc>
  </event>
</chapter>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    expect(result!.chapters[0].keyEvents[0].triggerHint).toBeUndefined();
    expect(result!.chapters[0].keyEvents[0].completeHint).toBeUndefined();
    expect(result!.chapters[0].keyEvents[0].failHint).toBeUndefined();
    expect(result!.chapters[0].keyEvents[0].timeWindow).toBeUndefined();
  });

  it('无 content 且无 chapters 时返回 null', () => {
    const xml = `<outline>
<title>空大纲</title>
<summary>无内容</summary>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).toBeNull();
  });

  it('无 <outline> 包裹标签时返回 null', () => {
    const xml = `<title>孤立的标题</title><content>孤立的正文</content>`;
    const result = parseOutlineXml(xml);
    expect(result).toBeNull();
  });

  it('self_critique 应正确填充 strengths/weaknesses/suggestions', () => {
    const xml = `<outline>
<title>T</title>
<summary>S</summary>
<content>C</content>
<self_critique score="7">
  <strength>优点A</strength>
  <weakness>缺点A</weakness>
  <weakness>缺点B</weakness>
  <suggestion>建议A</suggestion>
</self_critique>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    expect(result!.selfCritique).toContain('评分: 7/10');
    expect(result!.selfCritique).toContain('优点: 优点A');
    expect(result!.selfCritique).toContain('不足: 缺点A; 缺点B');
    expect(result!.selfCritique).toContain('建议: 建议A');
  });

  it('空 self_critique 标签不应报错', () => {
    const xml = `<outline>
<title>T</title>
<summary>S</summary>
<content>C</content>
<self_critique score="5" />
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    // self_critique 在空标签时可能为 undefined 或空字符串
  });

  it('应处理 timerange 自闭合标签', () => {
    const xml = `<outline>
<title>T</title>
<summary>S</summary>
<timerange start="512-春" end="513-冬" />
<content>C</content>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('C');
  });

  it('应解析 direction_anchors/npc_agendas/if_absent 新标签', () => {
    const xml = `<outline>
<title>开放世界测试</title>
<summary>摘要</summary>
<timerange start="512-春" end="513-冬" />
<direction_anchors>核心张力：帝国与教会的权力斗争；主角主题：寻求真相；关键关系人：失踪的公主</direction_anchors>
<content>正文</content>
<chapter title="第一章" summary="章节摘要">
  <npc_agendas>帝国宰相计划借刀杀人；教会暗中调查皇室秘密；公主试图传递情报</npc_agendas>
  <if_absent>主角若未介入，公主将在三日后被捕处决，帝国与教会关系恶化</if_absent>
  <event title="事件A">
    <desc>描述</desc>
  </event>
</chapter>
</outline>`;

    const result = parseOutlineXml(xml);
    expect(result).not.toBeNull();
    expect(result!.directionAnchors).toBe(
      '核心张力：帝国与教会的权力斗争；主角主题：寻求真相；关键关系人：失踪的公主',
    );
    expect(result!.chapters[0].npcAgendas).toBe(
      '帝国宰相计划借刀杀人；教会暗中调查皇室秘密；公主试图传递情报',
    );
    expect(result!.chapters[0].ifAbsent).toBe(
      '主角若未介入，公主将在三日后被捕处决，帝国与教会关系恶化',
    );
  });
});

// ========== tryParseOutline ==========

describe('tryParseOutline', () => {
  it('XML 输入应走 XML 解析', () => {
    const xml = `<outline>
<title>XML大纲</title>
<summary>XML摘要</summary>
<content>XML正文</content>
<chapter title="第一章" summary="章节摘要">
  <event title="事件A">
    <desc>描述</desc>
  </event>
</chapter>
</outline>`;

    const result = tryParseOutline(xml);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('XML大纲');
    expect(result!.summary).toBe('XML摘要');
  });

  it('JSON 输入应回退到 JSON 解析', () => {
    const json = JSON.stringify({
      title: 'JSON大纲',
      summary: 'JSON摘要',
      content: 'JSON正文',
      chapters: [
        {
          title: '第一章',
          summary: '章节摘要',
          keyEvents: [{ title: '事件A', description: '描述' }],
        },
      ],
    });

    const result = tryParseOutline(json);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('JSON大纲');
    expect(result!.summary).toBe('JSON摘要');
  });

  it('XML 无效但 JSON 有效时应回退到 JSON', () => {
    const json = JSON.stringify({
      title: '回退大纲',
      summary: '回退摘要',
      content: '回退正文',
    });

    const result = tryParseOutline(json);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('回退大纲');
  });

  it('两者都无效时应返回 null', () => {
    const result = tryParseOutline('这不是任何有效格式');
    expect(result).toBeNull();
  });

  it('XML 优先于 JSON：包含 XML 片段和 JSON 的混合文本应走 XML', () => {
    const mixed = `一些前言文本 <outline>
<title>XML标题</title>
<summary>XML摘要</summary>
<content>XML正文</content>
</outline> {"title":"JSON标题","summary":"JSON摘要","content":"JSON正文"}`;

    const result = tryParseOutline(mixed);
    expect(result).not.toBeNull();
    expect(result!.title).toBe('XML标题');
  });
});

// ========== parseOutlineJson backward compat ==========

describe('parseOutlineJson', () => {
  it('parseOutlineJson 和 parseOutlineAgentOutput 应指向同一函数', () => {
    expect(parseOutlineJson).toBe(parseOutlineAgentOutput);
  });

  it('应解析 JSON 中的新字段（timeWindow/completeHint/failHint）', () => {
    const json = JSON.stringify({
      title: '新字段测试',
      summary: '摘要',
      content: '正文',
      chapters: [
        {
          title: '第一章',
          summary: '章节摘要',
          keyEvents: [
            {
              title: '事件A',
              description: '描述',
              timeWindow: { start: '512-春', end: '512-夏' },
              completeHint: '完成任务',
              failHint: '任务失败',
            },
          ],
        },
      ],
    });

    const result = parseOutlineJson(json);
    expect(result).not.toBeNull();
    expect(result!.chapters[0].keyEvents[0].timeWindow).toEqual({ start: '512-春', end: '512-夏' });
    expect(result!.chapters[0].keyEvents[0].completeHint).toBe('完成任务');
    expect(result!.chapters[0].keyEvents[0].failHint).toBe('任务失败');
  });

  it('应解析 JSON 中的 directionAnchors/npcAgendas/ifAbsent 新字段', () => {
    const json = JSON.stringify({
      title: '开放世界测试',
      summary: '摘要',
      content: '正文',
      directionAnchors:
        '核心张力：帝国与教会的权力斗争；主角主题：寻求真相；关键关系人：失踪的公主',
      chapters: [
        {
          title: '第一章',
          summary: '章节摘要',
          npcAgendas: '帝国宰相计划借刀杀人；教会暗中调查皇室秘密；公主试图传递情报',
          ifAbsent: '主角若未介入，公主将在三日后被捕处决，帝国与教会关系恶化',
          keyEvents: [{ title: '事件A', description: '描述' }],
        },
      ],
    });

    const result = parseOutlineJson(json);
    expect(result).not.toBeNull();
    expect(result!.directionAnchors).toBe(
      '核心张力：帝国与教会的权力斗争；主角主题：寻求真相；关键关系人：失踪的公主',
    );
    expect(result!.chapters[0].npcAgendas).toBe(
      '帝国宰相计划借刀杀人；教会暗中调查皇室秘密；公主试图传递情报',
    );
    expect(result!.chapters[0].ifAbsent).toBe(
      '主角若未介入，公主将在三日后被捕处决，帝国与教会关系恶化',
    );
  });
});

// ========== outlineToEvents (new fields) ==========

describe('outlineToEvents with new fields', () => {
  it('event 的 timeWindow/completeCondition/failCondition 应正确填充', () => {
    const chapters = [
      {
        title: '第一章',
        summary: '章节摘要',
        keyEvents: [
          {
            title: '关键事件',
            description: '描述',
            triggerHint: '{{location}} == "帝都"',
            timeWindow: { start: '512-春', end: '512-夏' },
            completeHint: '找到线索',
            failHint: '线索丢失',
          },
        ],
      },
    ];

    const events = outlineToEvents(chapters, 'save-1');
    const ke = events.find((e) => e.title === '关键事件')!;
    expect(ke.triggerCondition).toBe('{{location}} == "帝都"');
    expect(ke.completeCondition).toBe('找到线索');
    expect(ke.failCondition).toBe('线索丢失');
    expect(ke.timeWindow).toEqual({ start: '512-春', end: '512-夏' });
  });

  it('新字段缺省时（undefined）不应报错', () => {
    const chapters = [
      {
        title: '第一章',
        summary: '章节摘要',
        keyEvents: [{ title: '简单事件', description: '描述' }],
      },
    ];

    const events = outlineToEvents(chapters, 'save-1');
    const ke = events.find((e) => e.title === '简单事件')!;
    expect(ke.triggerCondition).toBeUndefined();
    expect(ke.completeCondition).toBeUndefined();
    expect(ke.failCondition).toBeUndefined();
    expect(ke.timeWindow).toBeUndefined();
  });

  it('outlineToEvents 应透传 npcAgendas/ifAbsent 到 depth 0 事件', () => {
    const chapters = [
      {
        title: '第一章',
        summary: '章节摘要',
        npcAgendas: '帝国宰相计划借刀杀人；教会暗中调查',
        ifAbsent: '主角若未介入，公主将被捕处决',
        keyEvents: [{ title: '事件A', description: '描述' }],
      },
    ];

    const events = outlineToEvents(chapters, 'save-1');
    const chapterEvent = events.find((e) => e.depth === 0)!;
    expect(chapterEvent.npcAgendas).toBe('帝国宰相计划借刀杀人；教会暗中调查');
    expect(chapterEvent.ifAbsent).toBe('主角若未介入，公主将被捕处决');
  });

  it('outlineToEvents: depth 1 的 keyEvent 不带 npcAgendas/ifAbsent', () => {
    const chapters = [
      {
        title: '第一章',
        summary: '章节摘要',
        npcAgendas: 'NPC 议程',
        ifAbsent: '反事实基线',
        keyEvents: [{ title: '事件A', description: '描述' }],
      },
    ];

    const events = outlineToEvents(chapters, 'save-1');
    const keyEvent = events.find((e) => e.depth === 1)!;
    expect(keyEvent.npcAgendas).toBeUndefined();
    expect(keyEvent.ifAbsent).toBeUndefined();
  });
});
