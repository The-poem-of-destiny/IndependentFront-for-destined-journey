import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 字体不变式闸门 —— 主题 CSS 里**不许出现 `--theme-font-*` 声明**（design.md §1 / §7.4）。
 *
 * ## 为什么值得单开一条
 * `parchment` 与 `ivory` 曾把 `--theme-font-body` 定义成衬线，于是**换个主题就会悄悄
 * 改掉正文字体**，而设置页的字体下拉框仍显示着原来的值。症状不在主题文件里，而在一个
 * 看起来毫不相干的下拉框上 —— 这种「因果分居两处」的缺陷，肉眼审查和组件测试都抓不到。
 *
 * 字体的唯一决定者是设置页那两格（正文 / 标题），`theme-store.initFonts()` 把它们写成
 * `<html>` 的**内联变量**，内联压得过任何 `[data-theme]` 规则。主题只管颜色。
 * 行为侧的断言在 `src/ui/stores/theme-store.fonts.test.ts`；本闸门守的是「别再往主题里
 * 写字体」这条源码约束 —— 写了虽然已经不生效，但会让下一个人以为主题能定字体。
 *
 * ## 为什么在 tests/ 而不是 src/ui/themes/
 * 初版放在 `src/ui/themes/` 并用 Vite 的 `?raw` 读 CSS —— **那样是假绿的**：
 * vitest 默认 `css: false`，`.css?raw` 一律返回**空串**，于是「不含字体声明」这条
 * 对每个文件都轻松通过，闸门整个是死的。（发现它靠的是同一批断言里那条
 * 「variables.css 仍提供三个兜底」—— 空串让它红了。**一条只会变绿的断言证明不了任何事**，
 * 每个扫描类测试都该配一条「扫到的东西非空」的反向断言。）
 *
 * `tests/` 不在 tsconfig 的 include 里，所以这里能直接用 `node:fs` 读到真文件 ——
 * 与 `encoding-invariants.test.ts` 同一个理由、同一个位置。
 */

const THEME_DIR = join(__dirname, '..', 'src', 'ui', 'themes');
/** 唯一允许声明字体的文件：`:root` 兜底（没有 JS 时用）+ 不可配置的装饰体 */
const ALLOWED = 'variables.css';

/** 只找**声明**（`--theme-font-x:`）。注释里提这个名字是允许的 —— 那几处注释正是在
 *  解释为什么不能写，删掉反而让下一个人重新踩一遍 */
function fontDeclarations(css: string): string[] {
  return css
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*'))
    .filter((line) => /^\s*--theme-font-[a-z]+\s*:/.test(line))
    .map((line) => line.trim());
}

const themeFiles = readdirSync(THEME_DIR).filter((f) => f.endsWith('.css') && f !== ALLOWED);

describe('主题 CSS 不定义字体', () => {
  it('确实扫到了 10 套主题（防止 glob/路径写错让闸门空转）', () => {
    expect(themeFiles.length).toBe(10);
  });

  it('读到的确实是非空内容（初版栽在这：?raw 读 CSS 返回空串，闸门整个是死的）', () => {
    // 逐个非空即可证伪「读出来全是空串」。**不设更高的下限**：`obsidian.css` 只有
    // 一行注释（默认主题的值都在 variables.css 的 `:root` 里），它合法地就是很小。
    for (const f of themeFiles) {
      expect(readFileSync(join(THEME_DIR, f), 'utf8').length).toBeGreaterThan(0);
    }
    // 再加一条总量断言：万一将来读取方式又换了、退化成「每个文件一个字符」
    const total = themeFiles.reduce(
      (n, f) => n + readFileSync(join(THEME_DIR, f), 'utf8').length,
      0,
    );
    expect(total).toBeGreaterThan(5000);
  });

  it.each(themeFiles)('%s 不声明 --theme-font-*', (file) => {
    const css = readFileSync(join(THEME_DIR, file), 'utf8');
    expect(fontDeclarations(css)).toEqual([]);
  });

  it('字体栈第一顺位带 Variable 后缀 —— 自托管注册的就是这个族名', () => {
    // 漏掉后缀不会报任何错，只会安静地退回系统字体。所以单独钉一条。
    const css = readFileSync(join(THEME_DIR, ALLOWED), 'utf8');
    for (const decl of fontDeclarations(css)) {
      expect(decl).toMatch(/:\s*'[^']+ Variable'/);
    }
  });

  it('variables.css 仍提供三个兜底，且正文无衬线 / 标题衬线', () => {
    const css = readFileSync(join(THEME_DIR, ALLOWED), 'utf8');
    expect(fontDeclarations(css)).toEqual([
      "--theme-font-title: 'Noto Serif SC Variable', 'Noto Serif SC', serif;",
      "--theme-font-display: 'Cinzel Variable', 'Cinzel', 'Noto Serif SC Variable', serif;",
      "--theme-font-body: 'Noto Sans SC Variable', 'Noto Sans SC', sans-serif;",
    ]);
  });
});
