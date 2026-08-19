/**
 * ui-store —— `previousView`「原路返回」不变式
 *
 * 扩展管理与工坊页的返回键使用历史栈。断言对应几种真会踩到的错法：
 *   1. 不记来路 → 从设置进扩展管理，返回把人扔到标题画面
 *   2. 同视图重复 navigate 也覆盖 → previousView 变成自己，返回键就地失效
 *   3. 只在某几条路径上记 → 侧栏进来的那条忘了记，症状只在一个入口出现
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useUIStore } from '@ui/stores/ui-store';

describe('ui-store previousView', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('初值是 home —— 谁都没导航过时返回键也得有个去处', () => {
    const ui = useUIStore();
    expect(ui.previousView).toBe('home');
  });

  it('记住离开的那个视图（设置 → 扩展管理，返回目标是设置）', () => {
    const ui = useUIStore();
    ui.navigate('settings');
    ui.navigate('extensions');
    expect(ui.previousView).toBe('settings');
  });

  it('游戏页 → 工坊 同样成立（入口不同不该有两种行为）', () => {
    const ui = useUIStore();
    ui.navigate('game', 'save-1');
    ui.navigate('workshop');
    expect(ui.previousView).toBe('game');
    expect(ui.activeSaveId).toBe('save-1');
  });

  it('导航到当前视图不覆盖来路（否则返回键会指向自己）', () => {
    const ui = useUIStore();
    ui.navigate('settings');
    ui.navigate('workshop');
    ui.navigate('workshop');
    expect(ui.previousView).toBe('settings');
  });

  it('设置 → 扩展管理 → 创意工坊可以逐层返回', () => {
    const ui = useUIStore();
    ui.navigate('settings');
    ui.navigate('extensions');
    ui.navigate('workshop');

    ui.back();
    expect(ui.currentView).toBe('extensions');
    expect(ui.previousView).toBe('settings');

    ui.back();
    expect(ui.currentView).toBe('settings');
    expect(ui.previousView).toBe('home');
  });
});

describe('ui-store 设置分区入口', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('首页关于入口导航到设置页，并只交付一次 about 请求', () => {
    const ui = useUIStore();

    ui.openSettings('about');

    expect(ui.currentView).toBe('settings');
    expect(ui.consumeSettingsSectionRequest()).toBe('about');
    expect(ui.consumeSettingsSectionRequest()).toBeNull();
  });
});
