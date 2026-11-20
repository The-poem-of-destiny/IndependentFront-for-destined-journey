/**
 * DialogueCard — 对话卡片原生渲染
 *
 * 守的是：名字去掉粗体星号、空情绪不渲染节点、台词按纯文本原样输出（不当 HTML 解析），
 * 以及主题覆盖所依赖的全局类名。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DialogueCard from '../../../../src/ui/components/game/DialogueCard.vue';

describe('DialogueCard', () => {
  it('根节点与子节点使用主题覆盖依赖的类名', () => {
    const wrapper = mount(DialogueCard, { props: { name: '约翰', mood: '愤怒', body: '你好。' } });
    expect(wrapper.classes()).toContain('dialogue-card');
    expect(wrapper.find('.dialogue-name').text()).toBe('约翰');
    expect(wrapper.find('.dialogue-mood').text()).toBe('愤怒');
    expect(wrapper.find('.dialogue-body').text()).toBe('你好。');
  });

  it('名字去掉首尾星号并 trim', () => {
    const wrapper = mount(DialogueCard, { props: { name: ' **灰刃·科尔** ', body: '走吧。' } });
    expect(wrapper.find('.dialogue-name').text()).toBe('灰刃·科尔');
  });

  it.each([undefined, '', '   '])('情绪为 %j 时不渲染情绪节点', (mood) => {
    const wrapper = mount(DialogueCard, { props: { name: '约翰', mood, body: '你好。' } });
    expect(wrapper.find('.dialogue-mood').exists()).toBe(false);
  });

  it('情绪两侧空白被去掉', () => {
    const wrapper = mount(DialogueCard, {
      props: { name: '约翰', mood: '  低声 ', body: '你好。' },
    });
    expect(wrapper.find('.dialogue-mood').text()).toBe('低声');
  });

  it('台词按纯文本原样输出，不当 HTML 解析', () => {
    const body = '他说"走吧"。<b>别</b>&amp;';
    const wrapper = mount(DialogueCard, { props: { name: '约翰', body } });
    const el = wrapper.find('.dialogue-body');
    expect(el.element.textContent).toBe(body);
    expect(el.find('b').exists()).toBe(false);
  });
});
