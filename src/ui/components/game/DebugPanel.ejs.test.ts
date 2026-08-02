/**
 * DebugPanel.vue — 世界书 EJS 诊断区块
 * @vitest-environment jsdom
 *
 * ## 为什么这个区块值得单独测
 * 它展示的三样东西**全是静默失效**：
 *
 * - **求值后端降级**：`fail-closed` = wasm 没装上，世界书 EJS 整体停用；
 *   `legacy` = 没有隔离边界。两种都不会报错，只会「世界书好像不生效」。
 * - **条目回退（D8）**：条目照常进提示词，只是没被求值 —— 玩家看到的是一段源码或没反应。
 * - **变量丢弃（D5）**：账务静默失灵。
 *
 * 三样原本都只有 `console.warn`，而调试循环的口径是「游玩 → 导出 → 分析」，
 * 没人会去翻浏览器控制台。所以「面板上到底显不显示」本身就是功能。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DebugPanel from './DebugPanel.vue';
import { useGameStore } from '../../stores/game-store';
import { setEjsBackend, resetEjsBackend, FailClosedBackend } from '@engine/ejs-backend';

beforeEach(() => {
  setActivePinia(createPinia());
});
afterEach(() => {
  resetEjsBackend();
});

const mountPanel = () => mount(DebugPanel);

describe('DebugPanel · 世界书 EJS 区块', () => {
  it('永远有这一节 —— 后端身份是出问题时第一个该确认的东西', () => {
    const text = mountPanel().text();
    expect(text).toContain('世界书 EJS');
    expect(text).toContain('求值后端');
  });

  it('干净局给正面结论，不摆一堆空标题', () => {
    expect(mountPanel().text()).toContain('本局未出现回退');
  });

  it('🔴 fail-closed 后端要明说「EJS 已整体停用」而不只是印个名字', () => {
    setEjsBackend(new FailClosedBackend('隔离后端装载失败: 模拟'));
    const text = mountPanel().text();
    expect(text).toContain('fail-closed');
    expect(text).toContain('整体停用');
  });

  it('降级态带告警样式（扫一眼就能看见，不用逐字读）', () => {
    setEjsBackend(new FailClosedBackend('x'));
    expect(mountPanel().find('.debug-warn').exists()).toBe(true);
  });

  it('条目回退：书名 / uid / 次数 / 错因四样都得在', () => {
    const game = useGameStore();
    game.recordEjsFallback('story', [
      { uid: 417, bookName: '系统核心', error: 'SyntaxError: unexpected token' },
    ]);
    const text = mountPanel().text();
    expect(text).toContain('系统核心');
    expect(text).toContain('417');
    expect(text).toContain('SyntaxError: unexpected token');
    expect(text).toContain('story');
  });

  it('变量丢弃仍在（原有诊断没被新区块挤掉）', () => {
    const game = useGameStore();
    game.recordEjsVarsRejection('story', '正文', 262144);
    const text = mountPanel().text();
    expect(text).toContain('变量写入被丢弃');
    expect(text).toContain('262144');
  });

  it('ui.log 折叠着放 —— 内容作者的调试输出可能上百行，不能顶开整个面板', () => {
    const game = useGameStore();
    game.recordEjsUiLog('作者打的第一行');
    const wrapper = mountPanel();
    expect(wrapper.find('details').exists()).toBe(true);
    expect(wrapper.text()).toContain('内容调试输出');
    expect(wrapper.text()).toContain('作者打的第一行');
  });

  it('三样都没有时不渲染空区块', () => {
    const wrapper = mountPanel();
    expect(wrapper.text()).not.toContain('已回退原文');
    expect(wrapper.text()).not.toContain('变量写入被丢弃');
    expect(wrapper.text()).not.toContain('内容调试输出');
  });
});
