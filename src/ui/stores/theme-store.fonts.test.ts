/**
 * theme-store 的两格字体设置 —— design.md §7.4 那条 bug 的回归测试
 *
 * 原来的形状有三处缺陷，这里逐条钉住：
 *   1. `setFonts()` 往 `fated-poem-fonts` **写了却没人读** —— 全项目没有 initFonts()，
 *      刷新后 ref 重置成默认、DOM 上也没有内联覆盖，于是字体退回主题说了算，
 *      而设置页的下拉框仍显示用户选的值。
 *   2. `parchment` / `ivory` 把 `--theme-font-body` 定义成衬线 —— 换个主题就悄悄
 *      换掉正文字体。字体已从主题 CSS 全部移除（那三处的断言在 themes 那边）。
 *   3. `mixed` 档写的是 `'Noto Sans SC', 'Noto Serif SC', sans-serif` —— 一条字体栈，
 *      有中文字形的字符全部命中第一个，所以它渲染出来和 `sans` 一模一样。
 *      三个选项实际只有两种结果，现在拆成正文/标题两格。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThemeStore } from './theme-store';

// 与 theme-store 的 FONT_STACKS 一字不差。带 `Variable` 后缀是因为自托管走
// @fontsource-variable/*，漏掉后缀会安静地退回系统字体（不报错，只是字变了）。
const SANS = "'Noto Sans SC Variable', 'Noto Sans SC', sans-serif";
const SERIF = "'Noto Serif SC Variable', 'Noto Serif SC', serif";

/** 直接读 `<html>` 上的内联变量 —— 「设置压过主题」靠的就是它 */
function inlineVar(slot: 'body' | 'title'): string {
  return document.documentElement.style.getPropertyValue(`--theme-font-${slot}`);
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

describe('出厂默认', () => {
  it('正文无衬线、标题衬线（design.md §2.1 的手稿标题 + 工整正文）', () => {
    const theme = useThemeStore();
    theme.initFonts();
    expect(theme.fontBody).toBe('sans');
    expect(theme.fontTitle).toBe('serif');
    expect(inlineVar('body')).toBe(SANS);
    expect(inlineVar('title')).toBe(SERIF);
  });

  it('默认值也写内联变量 —— 这是「主题改不动字体」的执行点，不能因为等于默认就跳过', () => {
    useThemeStore().initFonts();
    expect(inlineVar('body')).not.toBe('');
    expect(inlineVar('title')).not.toBe('');
  });
});

describe('两格互不干扰', () => {
  it('改标题不动正文', () => {
    const theme = useThemeStore();
    theme.initFonts();
    theme.setFontTitle('sans');
    expect(inlineVar('title')).toBe(SANS);
    expect(inlineVar('body')).toBe(SANS); // 正文本来就是 sans，没被连带改成 serif
    expect(theme.fontBody).toBe('sans');
  });

  it('改正文不动标题 —— 旧实现里标题根本碰不到，这是新增的那一格', () => {
    const theme = useThemeStore();
    theme.initFonts();
    theme.setFontBody('serif');
    expect(inlineVar('body')).toBe(SERIF);
    expect(inlineVar('title')).toBe(SERIF);
    theme.setFontTitle('sans');
    expect(inlineVar('title')).toBe(SANS);
    expect(inlineVar('body')).toBe(SERIF);
  });
});

describe('持久化（bug 的另一半：写了没人读）', () => {
  it('设过之后能读回来', () => {
    useThemeStore().setFontBody('serif');
    useThemeStore().setFontTitle('sans');

    setActivePinia(createPinia());
    document.documentElement.removeAttribute('style');
    const fresh = useThemeStore();
    fresh.initFonts();

    expect(fresh.fontBody).toBe('serif');
    expect(fresh.fontTitle).toBe('sans');
    expect(inlineVar('body')).toBe(SERIF);
    expect(inlineVar('title')).toBe(SANS);
  });

  it('localStorage 里的垃圾值退回默认，不抛', () => {
    localStorage.setItem('fated-poem-font-body', 'comic-sans');
    localStorage.setItem('fated-poem-font-title', '');
    const theme = useThemeStore();
    expect(() => theme.initFonts()).not.toThrow();
    expect(theme.fontBody).toBe('sans');
    expect(theme.fontTitle).toBe('serif');
  });
});

describe('旧的三档单选迁移 —— 照用户实际看到的样子迁，不是照字面', () => {
  it("legacy 'serif' → 正文衬线，标题仍是默认衬线", () => {
    localStorage.setItem('fated-poem-fonts', 'serif');
    const theme = useThemeStore();
    theme.initFonts();
    expect(theme.fontBody).toBe('serif');
    expect(theme.fontTitle).toBe('serif');
  });

  it("legacy 'mixed' → 正文无衬线（它渲染出来本来就等于 sans，不是第三种结果）", () => {
    localStorage.setItem('fated-poem-fonts', 'mixed');
    const theme = useThemeStore();
    theme.initFonts();
    expect(theme.fontBody).toBe('sans');
    expect(theme.fontTitle).toBe('serif');
  });

  it("legacy 'sans' → 两格都是默认", () => {
    localStorage.setItem('fated-poem-fonts', 'sans');
    const theme = useThemeStore();
    theme.initFonts();
    expect(theme.fontBody).toBe('sans');
    expect(theme.fontTitle).toBe('serif');
  });

  it('已经有新键时不再看旧键 —— 迁移只在两格都没设过时发生', () => {
    localStorage.setItem('fated-poem-fonts', 'serif');
    localStorage.setItem('fated-poem-font-body', 'sans');
    const theme = useThemeStore();
    theme.initFonts();
    expect(theme.fontBody).toBe('sans');
  });
});

describe('主题不再定义字体（§1 主题无关）', () => {
  it('apply() 只写 data-theme，不碰字体变量', () => {
    const theme = useThemeStore();
    theme.initFonts();
    theme.setFontBody('serif');
    theme.apply('parchment');
    expect(document.documentElement.getAttribute('data-theme')).toBe('parchment');
    // 换主题之后正文仍是用户选的衬线，而不是被主题接管
    expect(inlineVar('body')).toBe(SERIF);
    theme.apply('obsidian');
    expect(inlineVar('body')).toBe(SERIF);
  });
});
