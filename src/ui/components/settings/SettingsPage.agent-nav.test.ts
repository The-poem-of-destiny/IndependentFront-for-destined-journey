/**
 * 设置页 Agent 子导航 —— 「上次选的那个」要能回得来
 *
 * 修的 bug：主导航里**每一个**按钮（包括「Agent 配置」自己）都无条件
 * `activeAgent = null`。而 `activeSection` 初值是 'api'，想进 Agent 分区必须点那
 * 一下 —— 于是 `s.activeAgent` 变成一个存了却永远读不回来的值，用户每次进来都落在
 * 「← 请从左侧选择一个 Agent」空态。持久化白做，还白搭一次点击。
 *
 * 两层守：
 *   1. 纯函数 `resolveAgentSelection` 的行为（陈旧 id / 空值 / D53 的 image_prompt）
 *   2. 接线本身 —— 源码断言，照本目录既有做法（mount 整个设置页要拖进 API 池 /
 *      世界书 / Agent 一整片启动逻辑）
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/settings/SettingsPage.vue?raw';
import { AGENT_LIST, resolveAgentSelection } from '@ui/components/settings/agent/agent-list';

describe('resolveAgentSelection', () => {
  it('清单里有的 id 原样放行', () => {
    expect(resolveAgentSelection('story')).toBe('story');
    for (const a of AGENT_LIST) expect(resolveAgentSelection(a.id)).toBe(a.id);
  });

  it('清单里没有的陈旧 id → null（否则页头渲染成空白，子导航无一项高亮）', () => {
    expect(resolveAgentSelection('已经下线的_agent')).toBeNull();
  });

  it('image_prompt → null —— 它按 D53 刻意不在 AGENT_LIST 里', () => {
    expect(AGENT_LIST.some((a) => a.id === 'image_prompt')).toBe(false);
    expect(resolveAgentSelection('image_prompt')).toBeNull();
  });

  it('空值一律 null，不抛', () => {
    expect(resolveAgentSelection(null)).toBeNull();
    expect(resolveAgentSelection(undefined)).toBeNull();
    expect(resolveAgentSelection('')).toBeNull();
  });
});

describe('SettingsPage 主导航接线', () => {
  it('导航点击走 selectSection，模板里不再内联置 null', () => {
    // 只看 <template>：bug 本体是那个内联 handler，而 <script> 的注释里正记着
    // 它长什么样 —— 拿整份源码做否定断言会被自己的注释绊倒
    const template = source.slice(source.indexOf('<template>'), source.indexOf('</template>'));
    expect(template).toContain('@click="selectSection(item.key)"');
    expect(template).not.toContain('activeAgent = null');
  });

  it('进 Agent 分区时恢复持久化的选择，而不是清掉它', () => {
    const start = source.indexOf('function selectSection');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    expect(body).toContain("key === 'agent'");
    expect(body).toContain('resolveAgentSelection(s.activeAgent)');
    // 别把置 null 搬进函数体里 —— 那是同一个 bug 换个地方待着
    expect(body).not.toContain('= null');
  });

  it('初值也过同一道校验，不直接吃 s.activeAgent', () => {
    expect(source).toContain('ref<string | null>(resolveAgentSelection(s.activeAgent))');
  });
});
