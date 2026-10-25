/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import AgentParamsCard from '../../../../../src/ui/components/settings/agent/AgentParamsCard.vue';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';
import type { AgentSettingsEntry } from '../../../../../src/ui/stores/agent-settings';

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
function entry(uid: number, audiences?: string[], enabled = true): WorldBookEntry {
  return {
    uid,
    name: `条目${uid}`,
    content: '正文',
    enabled,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: uid,
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
