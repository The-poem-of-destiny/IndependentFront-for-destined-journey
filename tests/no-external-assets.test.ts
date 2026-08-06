import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「零外部资源」闸门 —— 字体与图标必须自托管（2026-08-05）。
 *
 * ## 为什么值得单开一条
 * 2026-08-05 之前，`index.html` 挂着两个 CDN：`fonts.googleapis.com`（Noto Sans SC /
 * Noto Serif SC / Cinzel）与 `cdnjs.cloudflare.com`（Font Awesome）。**它们失败时不报错** ——
 * `font-display: swap` 会安安静静落到系统字体，图标退化成方框，而设置页的「标题字体」
 * 仍然写着「衬线」。对一款中文游戏来说这不是边缘情况：`fonts.googleapis.com`
 * 在中国大陆长期不可达，也就是说**相当一部分玩家从来没见过设计里那套字体**。
 *
 * 加上离线、CDN 故障、企业代理拦截，这条外部依赖没有任何一处能报警。
 * 所以把「不许再出现外链」变成断言，而不是靠 code review 记住。
 *
 * ## 它挡不住什么
 * 只扫源码里的静态引用。运行时拼出来的 URL、以及工坊正则 iframe 里用户自己装的规则
 * （`beautifier-frame.ts` 的 CSP 刻意放行 `font-src http: https:`）不在范围内 ——
 * 那是另一份威胁模型，见 AGENTS.md 里工坊执行边界那一节。
 */

const REPO_ROOT = join(__dirname, '..');

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

describe('index.html 不引用任何外部资源', () => {
  const html = read('index.html');

  it('没有 <link>/<script> 指向 http(s)', () => {
    const tags = html.match(/<(?:link|script)\b[^>]*>/gi) ?? [];
    const external = tags.filter((t) => /\b(?:href|src)\s*=\s*["']?https?:/i.test(t));
    expect(external).toEqual([]);
  });

  it('点名挡住那两个回来过的域名', () => {
    // 注释里提到它们是允许的（本文件与 index.html 的注释正是在解释为什么不能用），
    // 所以只在**标签**里找，不在整份文本里找。
    const tags = (html.match(/<[^>]+>/g) ?? []).filter((t) => !t.startsWith('<!--'));
    const joined = tags.join('\n');
    expect(joined).not.toContain('fonts.googleapis.com');
    expect(joined).not.toContain('fonts.gstatic.com');
    expect(joined).not.toContain('cdnjs.cloudflare.com');
  });

  it('preconnect 也一并没有了（留着就是在说这里还要连外网）', () => {
    expect(html).not.toMatch(/rel\s*=\s*["']preconnect["']/i);
  });
});

describe('字体与图标从本地包引入', () => {
  const main = read('src/ui/main.ts');

  it('三款字体走 @fontsource-variable/*', () => {
    expect(main).toContain("import '@fontsource-variable/noto-sans-sc'");
    expect(main).toContain("import '@fontsource-variable/noto-serif-sc'");
    expect(main).toContain("import '@fontsource-variable/cinzel'");
  });

  it('Font Awesome 只引 solid + regular，不引 brands（全仓零处使用）', () => {
    // 只看 **import 语句**：main.ts 的注释里正解释着「刻意不引 brands.css」，
    // 拿整份文本做否定断言会被自己的注释绊倒（这一轮已经栽过两次）。
    const imports = (main.match(/^\s*import\s+.*$/gm) ?? []).join('\n');
    expect(imports).toContain('@fortawesome/fontawesome-free/css/fontawesome.css');
    expect(imports).toContain('@fortawesome/fontawesome-free/css/solid.css');
    expect(imports).toContain('@fortawesome/fontawesome-free/css/regular.css');
    expect(imports).not.toContain('brands.css');
  });

  it('字体 import 排在样式表之前（否则首屏按兜底字体排版再回流一次）', () => {
    const firstFont = main.indexOf('@fontsource-variable');
    const firstStyle = main.indexOf("'./styles/base.css'");
    expect(firstFont).toBeGreaterThan(-1);
    expect(firstStyle).toBeGreaterThan(-1);
    expect(firstFont).toBeLessThan(firstStyle);
  });

  it('package.json 把四个包记成生产依赖（devDependencies 会在构建时缺席）', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    const deps = pkg.dependencies ?? {};
    expect(Object.keys(deps)).toEqual(
      expect.arrayContaining([
        '@fontsource-variable/noto-sans-sc',
        '@fontsource-variable/noto-serif-sc',
        '@fontsource-variable/cinzel',
        '@fortawesome/fontawesome-free',
      ]),
    );
  });
});

describe('许可与署名（OFL 1.1 + CC BY 4.0）', () => {
  it('四份许可证全文随 dist 分发（public/ 被 Vite 逐字复制）', () => {
    for (const f of [
      'OFL-Noto-Sans-SC.txt',
      'OFL-Noto-Serif-SC.txt',
      'OFL-Cinzel.txt',
      'Font-Awesome-Free.txt',
    ]) {
      expect(read(join('public', 'licenses', f)).length).toBeGreaterThan(1000);
    }
  });

  it('署名在界面上可见 —— CC BY 4.0 唯一一条光靠文件满足不了的义务', () => {
    const about = read('src/ui/components/settings/AboutSection.vue');
    expect(about).toContain('Fonticons, Inc.');
    expect(about).toContain('CC BY 4.0');
    expect(about).toContain('/licenses/Font-Awesome-Free.txt');
    // 三款 OFL 字体的入口也要能点到
    expect(about).toContain('/licenses/OFL-Noto-Sans-SC.txt');
    expect(about).toContain('/licenses/OFL-Cinzel.txt');
  });

  it('THIRD-PARTY-NOTICES.md 在，且写明了不能自托管的那批系统字体', () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    expect(notices).toContain('SIL Open Font License 1.1');
    expect(notices).toContain('CC BY 4.0');
    // 专有系统字体：只能按名字引用，不能打包
    for (const proprietary of ['Monaco', 'Consolas', 'Palatino', 'KaiTi']) {
      expect(notices).toContain(proprietary);
    }
  });
});
