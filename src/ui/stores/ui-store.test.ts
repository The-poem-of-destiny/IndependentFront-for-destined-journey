/**
 * ui-store —— `previousView`「原路返回」不变式
 *
 * 工坊页的返回键读的就是它。三条断言各对应一种真会踩到的错法：
 *   1. 不记来路 → 从设置进工坊，返回把人扔到标题画面（本轮加设置入口前的行为）
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

  it('记住离开的那个视图（设置 → 工坊，返回目标是设置）', () => {
    const ui = useUIStore();
    ui.navigate('settings');
    ui.navigate('workshop');
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
});
