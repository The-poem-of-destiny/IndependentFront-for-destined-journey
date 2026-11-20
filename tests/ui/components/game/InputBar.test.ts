/**
 * InputBar —— 回车发送的两道闸
 *
 * - GAME-11：输入法选字时的回车（isComposing / keyCode 229）不发送
 * - GAME-07：润色进行中（lockedReason）输入框与发送键锁住，回车也不发送
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import InputBar from '../../../../src/ui/components/game/InputBar.vue';

enableAutoUnmount(afterEach);

const store = vi.hoisted(() => ({ pendingOptions: [] as string[] }));

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({
    get pendingOptions() {
      return store.pendingOptions;
    },
    pendingInput: '',
    clearPendingInput: vi.fn(),
  }),
}));

async function typed(props: Record<string, unknown> = {}) {
  const wrapper = mount(InputBar, { props });
  await wrapper.get('textarea').setValue('推开那扇门');
  return wrapper;
}

describe('InputBar 回车发送', () => {
  it('普通回车发送', async () => {
    const wrapper = await typed();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('send')).toEqual([['推开那扇门']]);
  });

  it('输入法选字中的回车（isComposing）不发送', async () => {
    const wrapper = await typed();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', isComposing: true });
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('keyCode 229（部分浏览器的输入法回车）不发送', async () => {
    const wrapper = await typed();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', keyCode: 229 });
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('Shift+Enter 换行不发送', async () => {
    const wrapper = await typed();
    await wrapper.get('textarea').trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(wrapper.emitted('send')).toBeUndefined();
  });

  it('lockedReason 有值：输入框与发送键锁住、占位写原因、回车不发送，且不出现停止键', async () => {
    const wrapper = await typed({ lockedReason: '正在润色正文…' });
    const textarea = wrapper.get('textarea');
    expect(textarea.attributes('disabled')).toBeDefined();
    expect(textarea.attributes('placeholder')).toBe('正在润色正文…');
    expect(wrapper.get('.send-btn').attributes('disabled')).toBeDefined();
    expect(wrapper.find('.stop-btn').exists()).toBe(false);
    await textarea.trigger('keydown', { key: 'Enter' });
    await wrapper.get('.send-btn').trigger('click');
    expect(wrapper.emitted('send')).toBeUndefined();
  });
});

describe('InputBar 行动选项暂扣（交互式推进）', () => {
  afterEach(() => {
    store.pendingOptions = [];
  });

  it('holdOptions 为真时不出选项按钮，转假后出现；暂扣时已开的浮层收起', async () => {
    store.pendingOptions = ['跟上去'];
    const wrapper = mount(InputBar, { props: { holdOptions: false } });
    await wrapper.get('.input-btn[title="可选行动"]').trigger('click');
    expect(wrapper.find('.options-popup').exists()).toBe(true);

    await wrapper.setProps({ holdOptions: true });
    expect(wrapper.find('.input-btn[title="可选行动"]').exists()).toBe(false);
    expect(wrapper.find('.options-popup').exists()).toBe(false);

    await wrapper.setProps({ holdOptions: false });
    expect(wrapper.find('.input-btn[title="可选行动"]').exists()).toBe(true);
  });
});
