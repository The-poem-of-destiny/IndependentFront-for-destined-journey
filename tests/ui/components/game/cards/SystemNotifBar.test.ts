/** @vitest-environment jsdom */
/**
 * SystemNotifBar —— 插件通知条（插件设计 §5.8，`PluginNoteSystemEvent`）
 *
 * 钉两件事：插件名与正文都显示出来；第三方文本只当纯文本（写 HTML 也不会变成元素）。
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SystemEvent } from '@engine/types/types';
import SystemNotifBar from '../../../../../src/ui/components/game/cards/SystemNotifBar.vue';

describe('SystemNotifBar', () => {
  it('插件通知：显示插件名与正文，带插件图标', () => {
    const event: SystemEvent = {
      type: 'plugin_note',
      pluginId: 'shop',
      pluginName: '商店',
      text: '你买下了一把短剑。',
      narrative: '商店：你买下了一把短剑。',
    };
    const wrapper = mount(SystemNotifBar, { props: { event } });
    expect(wrapper.find('.notif-plugin-name').text()).toBe('商店');
    expect(wrapper.find('.notif-plugin-text').text()).toBe('你买下了一把短剑。');
    expect(wrapper.find('i').classes()).toContain('fa-puzzle-piece');
  });

  it('🔴 插件文本里的 HTML 只按纯文本显示，不生成元素', () => {
    const event: SystemEvent = {
      type: 'plugin_note',
      pluginId: 'evil',
      pluginName: '<b>坏</b>',
      text: '<img src=x onerror=alert(1)>',
      narrative: '',
    };
    const wrapper = mount(SystemNotifBar, { props: { event } });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('b').exists()).toBe(false);
    expect(wrapper.find('.notif-plugin-text').text()).toBe('<img src=x onerror=alert(1)>');
  });

  it('其他通知仍渲染 narrative', () => {
    const event: SystemEvent = {
      type: 'quest_update',
      questName: '送信',
      status: '完成',
      narrative: '任务「送信」已完成',
    };
    const wrapper = mount(SystemNotifBar, { props: { event } });
    expect(wrapper.text()).toContain('任务「送信」已完成');
    expect(wrapper.find('.notif-plugin-name').exists()).toBe(false);
  });
});
