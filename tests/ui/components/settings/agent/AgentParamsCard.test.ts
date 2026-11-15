/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import AgentParamsCard from '../../../../../src/ui/components/settings/agent/AgentParamsCard.vue';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';
import type { AgentSettingsEntry } from '../../../../../src/ui/stores/agent-settings';
import {
  DIRECT_CACHE_REBUILD_DEFAULTS,
  DIRECT_CACHE_REBUILD_RANGE,
} from '@engine/prompts/direct-context-session';

const state = vi.hoisted(() => ({
  config: null as unknown as {
    settings: {
      storyContextV2Enabled: boolean;
      apiPool: unknown[];
      agents: Record<
        string,
        Partial<AgentSettingsEntry> & { worldBookIds?: string[]; worldBookEnabled?: boolean }
      >;
      agentDirty: Record<string, boolean>;
    };
    projectAgentDefaults: { agents: Record<string, Partial<AgentSettingsEntry>> };
  },
  wb: null as unknown as { books: WorldBook[] },
}));
vi.mock('../../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => state.config,
}));
vi.mock('../../../../../src/ui/stores/worldbook-store', () => ({
  useWorldBookStore: () => state.wb,
}));
const wrappers: VueWrapper[] = [];
beforeEach(() => {
  state.config = reactive({
    settings: { storyContextV2Enabled: true, apiPool: [], agents: {}, agentDirty: {} },
    projectAgentDefaults: { agents: {} },
  });
  state.wb = reactive({ books: [] });
});
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()));
function entry(index: number, audiences?: string[], enabled = true): WorldBookEntry {
  return {
    uid: `user:world_setting/entry_${index}`,
    name: `条目${index}`,
    content: '正文',
    enabled,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: index,
    position: 0,
    ...(audiences ? { extra: { lore: { audiences } } } : {}),
  };
}
function book(patch: Partial<WorldBook> = {}): WorldBook {
  return {
    id: 'user',
    name: '自建书',
    partition: 'world_setting',
    entries: [entry(1, ['story'])],
    ...patch,
  };
}
function card(agentId = 'story') {
  const wrapper = mount(AgentParamsCard, { props: { agentId } });
  wrappers.push(wrapper);
  return wrapper;
}

describe('AgentParamsCard 只读权限范围', () => {
  it('只计启用且可读的条目，尊重条目覆盖和显式空范围，无授权控件', () => {
    state.wb.books = [
      book({
        name: 'Public',
        entries: [entry(1, ['story']), entry(2, []), entry(3, undefined, false)],
      }),
      book({
        id: 'override',
        name: 'Override',
        entries: [entry(1, ['story'])],
      }),
      book({ id: 'secret', name: 'Hidden', entries: [entry(1, ['char_gen'])] }),
      book({ id: 'unknown', name: 'Unknown', entries: [entry(1)] }),
    ];
    const wrapper = card();
    expect(wrapper.findAll('.worldbook-scope-list li').map((row) => row.text())).toEqual([
      'Public1 条',
      'Override1 条',
    ]);
    expect(
      wrapper.findAll(
        '.worldbook-scope-list input, .worldbook-scope-list select, .worldbook-scope-list button',
      ),
    ).toHaveLength(0);
    expect(state.config.settings.agents).toEqual({});
  });

  it('旧 Agent 书清单不授权，挂载不重写其他用户设置', () => {
    state.wb.books = [book({ id: 'secret', entries: [entry(1, ['char_gen'])] })];
    state.config.settings.agents.story = {
      worldBookIds: ['secret'],
      worldBookEnabled: true,
      model: 'custom',
      temperature: 0.25,
      systemPrompt: 'custom instruction',
    };
    const before = JSON.stringify(state.config.settings);
    const wrapper = card();
    expect(wrapper.findAll('.worldbook-scope-list li')).toHaveLength(0);
    expect(JSON.stringify(state.config.settings)).toBe(before);
  });

  it('切换 Agent 即时重新计算读取范围', async () => {
    state.wb.books = [
      book({ name: 'Story only' }),
      book({ id: 'char', name: 'Character only', entries: [entry(1, ['char_gen'])] }),
    ];
    const wrapper = card();
    expect(wrapper.get('.worldbook-scope-list').text()).toContain('Story only');
    await wrapper.setProps({ agentId: 'char_gen' });
    expect(wrapper.get('.worldbook-scope-list').text()).toContain('Character only');
    expect(wrapper.get('.worldbook-scope-list').text()).not.toContain('Story only');
  });
});

describe('A03 Story v2 正文窗口设置', () => {
  it.each(['0', '-1', '1.5'])('输入 %s 拒绝保存且给出可解释错误', async (value) => {
    state.config.settings.agents.story = { historyLayers: 6 };
    const wrapper = card();
    const input = wrapper.get('input[aria-label="历史注入层数"]');
    expect(input.attributes('min')).toBe('1');
    await input.setValue(value);
    expect(state.config.settings.agents.story.historyLayers).toBe(6);
    expect(state.config.settings.agentDirty.story).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('必须是正整数');
    expect(input.attributes('aria-invalid')).toBe('true');
  });

  it('正整数保存；留空删覆写恢复默认；旧截断值保留但禁用且不能写入', async () => {
    state.config.settings.agents.story = { historyLayers: 6, historySlice: 800 };
    const wrapper = card();
    const input = wrapper.get('input[aria-label="历史注入层数"]');
    await input.setValue('3');
    expect(state.config.settings.agents.story.historyLayers).toBe(3);
    await input.setValue('');
    expect(state.config.settings.agents.story).not.toHaveProperty('historyLayers');
    const slice = wrapper.get('input[aria-label="历史截断字数"]');
    expect(slice.attributes('disabled')).toBeDefined();
    await slice.setValue('1200');
    expect(state.config.settings.agents.story.historySlice).toBe(800);
    expect(wrapper.text()).toContain('此旧模式截断设置不生效');
  });

  it.each(['legacy-story', 'char_gen'])('%s 仍允许 0 且可调整历史截断', async (kind) => {
    if (kind === 'legacy-story') state.config.settings.storyContextV2Enabled = false;
    const id = kind === 'legacy-story' ? 'story' : kind;
    const wrapper = card(id);
    const input = wrapper.get('input[aria-label="历史注入层数"]');
    expect(input.attributes('min')).toBe('0');
    await input.setValue('0');
    expect(state.config.settings.agents[id].historyLayers).toBe(0);
    const slice = wrapper.get('input[aria-label="历史截断字数"]');
    expect(slice.attributes('disabled')).toBeUndefined();
    await slice.setValue('1200');
    expect(state.config.settings.agents[id].historySlice).toBe(1200);
  });
});

describe('S-08 API 绑定状态', () => {
  const pool = [
    { id: 'p1', name: '主力 API', model: 'm1', kind: 'llm' },
    { id: 'p2', name: '备用 API', model: 'm2', kind: 'llm' },
  ];

  it('没绑定 → 不再挂红色「未选择」，显示「跟随默认：<第一个 API>」', () => {
    state.config.settings.apiPool = pool;
    const wrapper = card('vars_update');
    expect(wrapper.text()).not.toContain('未选择');
    expect(wrapper.get('.api-follow').text()).toBe('跟随默认：主力 API');
    expect(wrapper.find('.api-warn').exists()).toBe(false);
  });

  it('内容包默认层带着本机不存在的池 id（S-00）→ 同样是跟随默认，不报失效', () => {
    state.config.settings.apiPool = pool;
    state.config.projectAgentDefaults.agents.story = { model: 'author-machine-uuid' };
    const wrapper = card('story');
    expect(wrapper.get('.api-follow').text()).toContain('主力 API');
    expect(wrapper.text()).not.toContain('绑定失效');
  });

  it('用户指定的 API 已被删除 → 红字说明 + 下拉里有「（已删除的 API）」占位项，不是空白', () => {
    state.config.settings.apiPool = pool;
    state.config.settings.agents.vars_update = { model: 'deleted-id' };
    const wrapper = card('vars_update');
    expect(wrapper.get('.binding-stale-msg').text()).toContain('已被删除');
    const option = wrapper.get('option[value="deleted-id"]');
    expect(option.text()).toContain('已删除的 API');
    expect(option.attributes('disabled')).toBeDefined();
    expect((wrapper.get('select').element as HTMLSelectElement).value).toBe('deleted-id');
  });

  it('显式指定且存在 → ✓', () => {
    state.config.settings.apiPool = pool;
    state.config.settings.agents.vars_update = { model: 'p2' };
    const wrapper = card('vars_update');
    expect(wrapper.find('.api-ok').exists()).toBe(true);
  });

  it('没有任何 API → 请先配置 API', () => {
    const wrapper = card('vars_update');
    expect(wrapper.get('.api-warn').text()).toBe('请先配置 API');
  });
});

describe('S-10 采样参数显示实际发送的值与来源', () => {
  it('池默认盖过内容包默认时，框里是池的值，角标是「来自 API 池」；覆写的标「已覆写」', () => {
    state.config.settings.apiPool = [
      {
        id: 'p1',
        name: '主力 API',
        model: 'm1',
        kind: 'llm',
        defaultParameters: { temperature: 1, topP: 1 },
      },
    ];
    state.config.projectAgentDefaults.agents.vars_update = {
      temperature: 0.3,
      topP: 0.9,
      freqPen: 0.1,
    };
    state.config.settings.agents.vars_update = { topP: 0.5 };
    const wrapper = card('vars_update');
    expect(wrapper.get('[data-param="temperature"]').text()).toBe('来自 API 池');
    expect(wrapper.get('[data-param="topP"]').text()).toBe('已覆写');
    expect(wrapper.get('[data-param="freqPen"]').text()).toBe('默认');
    const temperatureInput = wrapper
      .get('[data-param="temperature"]')
      .element.closest('label')!
      .querySelector('input') as HTMLInputElement;
    expect(temperatureInput.value).toBe('1');
    const topPInput = wrapper
      .get('[data-param="topP"]')
      .element.closest('label')!
      .querySelector('input') as HTMLInputElement;
    expect(topPInput.value).toBe('0.5');
  });

  it('来源角标与参数名在同一行（不再独占一行），说明在输入框下方', () => {
    const wrapper = card('vars_update');
    const badge = wrapper.get('[data-param="temperature"]').element;
    expect(badge.parentElement!.classList.contains('param-head')).toBe(true);
    const label = badge.closest('label')!;
    const children = Array.from(label.children);
    expect(children.map((el) => el.tagName)).toEqual(['SPAN', 'INPUT', 'SPAN']);
    expect(children[2].textContent).toContain('越高越随机');
  });

  it('直出页的「不自动重试」是采样参数组里的一行说明，不占网格格子', () => {
    const wrapper = card('direct_main');
    const note = wrapper.get('.param-note');
    expect(note.text()).toContain('不自动重试');
    expect(note.element.closest('.param-grid')).toBeNull();
    expect(wrapper.text()).not.toContain('失败重试次数');
  });
});

describe('缓存直出：重建时机滑块', () => {
  type CacheBag = {
    directCacheRebuildTurns?: number;
    directCacheGrowthLimit?: number;
  };
  const bag = () => state.config.settings as unknown as CacheBag;

  it.each(['story', 'direct_main', 'vars_update'])('%s 页不出现缓存会话组与滑块', (id) => {
    const wrapper = card(id);
    expect(wrapper.find('input[type="range"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('渠道缓存支持');
  });

  it('direct_cached 页出现两个滑块，范围、步长、默认值取自引擎', () => {
    const wrapper = card('direct_cached');
    const turns = wrapper.get('input[aria-label="会话楼数上限"]');
    const growth = wrapper.get('input[aria-label="增长倍数上限"]');
    expect(turns.attributes()).toMatchObject({
      min: String(DIRECT_CACHE_REBUILD_RANGE.maxTurns.min),
      max: String(DIRECT_CACHE_REBUILD_RANGE.maxTurns.max),
      step: String(DIRECT_CACHE_REBUILD_RANGE.maxTurns.step),
    });
    expect(growth.attributes()).toMatchObject({
      min: String(DIRECT_CACHE_REBUILD_RANGE.growthLimit.min),
      max: String(DIRECT_CACHE_REBUILD_RANGE.growthLimit.max),
      step: String(DIRECT_CACHE_REBUILD_RANGE.growthLimit.step),
    });
    expect((turns.element as HTMLInputElement).value).toBe(
      String(DIRECT_CACHE_REBUILD_DEFAULTS.maxTurns),
    );
    expect(wrapper.get('[data-testid="rebuild-turns"]').text()).toContain('默认');
    expect(wrapper.find('.rebuild-reset').exists()).toBe(false);
  });

  it('拖动写入设置；拖回默认值即删键', async () => {
    const wrapper = card('direct_cached');
    await wrapper.get('input[aria-label="会话楼数上限"]').setValue('12');
    expect(bag().directCacheRebuildTurns).toBe(12);
    await wrapper.get('input[aria-label="增长倍数上限"]').setValue('2');
    expect(bag().directCacheGrowthLimit).toBe(2);
    expect(wrapper.get('[data-testid="rebuild-turns"]').text()).toContain('已覆写');
    await wrapper
      .get('input[aria-label="会话楼数上限"]')
      .setValue(String(DIRECT_CACHE_REBUILD_DEFAULTS.maxTurns));
    expect(bag()).not.toHaveProperty('directCacheRebuildTurns');
  });

  it('「恢复默认」删键而不是写入默认数字', async () => {
    bag().directCacheRebuildTurns = 12;
    bag().directCacheGrowthLimit = 2;
    const wrapper = card('direct_cached');
    await wrapper.get('[data-testid="rebuild-turns"] .rebuild-reset').trigger('click');
    expect(bag()).not.toHaveProperty('directCacheRebuildTurns');
    await wrapper.get('[data-testid="rebuild-growth"] .rebuild-reset').trigger('click');
    expect(bag()).not.toHaveProperty('directCacheGrowthLimit');
  });

  it('渠道缓存提示里的楼数随设置变化', async () => {
    const wrapper = card('direct_cached');
    const hint = () => wrapper.get('[data-testid="cache-provider-hint"]').text();
    expect(hint()).toContain(`${DIRECT_CACHE_REBUILD_DEFAULTS.maxTurns} 楼会话`);
    bag().directCacheRebuildTurns = 15;
    await wrapper.vm.$nextTick();
    expect(hint()).toContain('15 楼会话');
  });
});
