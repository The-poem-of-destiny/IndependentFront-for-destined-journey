/**
 * 设置页的扩展管理入口 —— 结构断言（照本目录既有做法读 SFC 源码，不 mount：
 * mount 整个设置页要拖进 API 池 / 世界书 / Agent 一整片启动逻辑）。
 *
 * 守两件事：
 *   1. 入口还在（首页那个 `WORKSHOP_ENTRY_ENABLED` 关过一次，设置页这条别跟着丢）
 *   2. 它**不在 `navItems` 里** —— 一旦有人「顺手补全」把它塞进那张表，
 *      `activeSection` 会多出一个渲染不出任何分区的值，点了就是一片空白右栏
 */
import { describe, it, expect } from 'vitest';
import source from '@ui/components/settings/SettingsPage.vue?raw';
import extensionSource from '@ui/components/workshop/ExtensionManagementPage.vue?raw';
import workshopSource from '@ui/components/workshop/WorkshopPage.vue?raw';

describe('SettingsPage 扩展管理入口', () => {
  it('导航栏底部有一个跳扩展管理的按钮', () => {
    expect(source).toContain(`class="nav-item nav-external"`);
    expect(source).toContain(`@click="ui.navigate('extensions')"`);
    expect(source).toContain('扩展管理');
  });

  it('不混进 navItems（它不是分区，没有对应的 activeSection 值）', () => {
    const start = source.indexOf('const navItems');
    const table = source.slice(start, source.indexOf('];', start));
    expect(start).toBeGreaterThan(-1);
    expect(table).not.toContain('extensions');
  });

  it('带外链角标，长得和分区不一样', () => {
    expect(source).toContain('nav-external-mark');
    expect(source).toContain('.nav-divider');
  });

  it('扩展页与工坊子页面都走历史返回，不写死回首页', () => {
    expect(extensionSource).toContain("ui.back('home')");
    expect(workshopSource).toContain("ui.back('extensions')");
    expect(extensionSource).not.toContain(`@click="ui.navigate('home')"`);
    expect(workshopSource).not.toContain(`@click="ui.navigate('home')"`);
  });
});
