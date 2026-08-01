/**
 * AppButton.vue — 忙碌态
 *
 * `loading` 与 `disabled` **语义不同**，这份测试守的就是这条区分:
 * disabled 是「不能做」，loading 是「正在做」。两者长一个样时，用户按下按钮后只看到
 * 它变灰，分不清是自己点漏了、还是被拒绝了、还是在跑 —— 而工坊一次安装要下几百 KB
 * 载荷，这段沉默可以长达几十秒。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AppButton from './AppButton.vue';

describe('AppButton loading', () => {
  it('缺省不出转圈，也不禁用', () => {
    const w = mount(AppButton, { slots: { default: '安装' } });
    expect(w.find('.btn-spinner').exists()).toBe(false);
    expect(w.attributes('disabled')).toBeUndefined();
    expect(w.attributes('aria-busy')).toBeUndefined();
    w.unmount();
  });

  it('loading → 转圈 + 自动禁用 + aria-busy', () => {
    const w = mount(AppButton, { props: { loading: true }, slots: { default: '安装中…' } });
    expect(w.find('.btn-spinner').exists()).toBe(true);
    expect(w.attributes('disabled')).toBeDefined();
    expect(w.attributes('aria-busy')).toBe('true');
    // 忙碌不是「不能做」，不该套用 disabled 的 0.5 压暗（会把转圈也压得看不清）
    expect(w.classes()).toContain('btn-loading');
    expect(w.classes()).not.toContain('btn-disabled');
    w.unmount();
  });

  it('loading 期间点不动 —— 双击不会跑两次安装', async () => {
    const w = mount(AppButton, { props: { loading: true } });
    await w.trigger('click');
    // 原生 disabled 已经拦住；这里断言的是「事件一次都没漏出去」
    expect(w.emitted('click')).toBeUndefined();
    w.unmount();
  });

  it('disabled 仍走原来的样式，不出转圈', () => {
    const w = mount(AppButton, { props: { disabled: true } });
    expect(w.find('.btn-spinner').exists()).toBe(false);
    expect(w.classes()).toContain('btn-disabled');
    expect(w.attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('两个都给时以 loading 的外观为准（仍然禁用）', () => {
    const w = mount(AppButton, { props: { disabled: true, loading: true } });
    expect(w.find('.btn-spinner').exists()).toBe(true);
    expect(w.classes()).toContain('btn-loading');
    expect(w.classes()).not.toContain('btn-disabled');
    expect(w.attributes('disabled')).toBeDefined();
    w.unmount();
  });

  it('转圈对读屏隐藏 —— 状态由 aria-busy 和按钮文案承担', () => {
    const w = mount(AppButton, { props: { loading: true }, slots: { default: '卸载中…' } });
    expect(w.find('.btn-spinner').attributes('aria-hidden')).toBe('true');
    expect(w.text()).toContain('卸载中…');
    w.unmount();
  });
});
