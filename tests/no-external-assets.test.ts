import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
 *
 * ## 2026-08-06 扩展：`src/**` 的 `https?://` 白名单扫描（D23）
 * 原来只扫 `index.html` 与 `main.ts` 两个文件，于是**三条外链在 `.ts` 里活了很久**：
 * `useMapViewer.ts` 的两条 `i.ibb.co` 地图热链（第三方图床）与 OpenSeadragon 控件贴图的
 * `openseadragon.github.io` 前缀。它们全都属于「失败了也不报错」那一类。
 * 现在整个 `src/**` 的源码按**主机名白名单**扫：合法的上游端点逐条声明理由，其余命中即红。
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

/* ═══════════════════════════════════════════════════════════
   src/** 的 https?:// 白名单扫描（D23）
   ═══════════════════════════════════════════════════════════ */

/**
 * 允许出现在 `src/**` 里的外部主机（按**主机名**白名单，不是按整串）。
 *
 * 🔴 **按语义写，别钉死具体字面量**：这些串正在被并行改造（工坊 API base 配置化、
 * 品牌串中性化）。主机名比整条 URL 稳定得多；真的换主机了，那本来就该重新过一遍这份名单。
 *
 * 收录标准只有一条：**它是一个上游服务端点或文档链接，不是被静默加载的资源**。
 * 字体、图标、贴图、地图图片这类「失败了也不报错」的资源永远不许进这份名单 ——
 * 那正是本文件存在的理由。
 */
const ALLOWED_EXTERNAL_HOSTS: ReadonlyArray<{ host: string; why: string }> = [
  // —— LLM / 出图上游（用户自己填 key 才会被调用的服务端点）——
  { host: 'api.openai.com', why: 'LLM 端点默认值（types.ts 的 API 池默认 baseUrl）' },
  { host: 'api.deepseek.com', why: 'LLM 端点示例（ApiSection 的占位提示）' },
  { host: 'image.novelai.net', why: 'NovelAI 出图上游（image-client 的常量地址）' },
  { host: 'api.novelai.net', why: 'NovelAI 文本/账户域（image-client 的「填错了」识别分支）' },
  { host: 'docs.novelai.net', why: 'NAI 官方文档链接（注释里的出处指针）' },
  {
    host: '127.0.0.1:8188',
    // 与其余条目不同：它根本不是外部主机，是**本机** ComfyUI 的默认端口（图像 v2 / C16）。
    // 地址住在 `imageComfy.baseUrl` 里、由用户自己改；这里出现的只是那一格的默认值。
    why: 'ComfyUI 本地默认地址（imageComfy.baseUrl 的默认值，用户可改）',
  },
  // —— 创意工坊（P1/P3/P4）——
  { host: 'poemofdestinycreativeworkshop.1528779666.workers.dev', why: '工坊 API 上游（Worker）' },
  { host: 'cdn.discordapp.com', why: '工坊 Discord 登录后的头像（P3 社交面）' },
  { host: 'wsrv.nl', why: '工坊封面图代理（封面候选链第一跳，失败自动回落原图）' },
  { host: 'invalid.local', why: '不是真主机：workshop-cover 用它当 new URL() 的哨兵 base' },
];

/**
 * 已知的待清理项 —— **允许通过，但记在案**。
 *
 * 与上面那份的区别：这些**不该**长期留着，只是清理归属在别的任务里。
 * 清掉之后请把对应行从这里删掉（留着一条不再命中的规则，下次就没人敢动它了）。
 */
const PENDING_REMOVAL_HOSTS: ReadonlyArray<{ host: string; why: string }> = [
  {
    host: 'testingcf.jsdelivr.net',
    why: '捏人页目录数据的上游参考仓（create-store.ts）—— 内容-引擎分离波 2「捏人目录」任务负责改成 /data/content/catalog.json',
  },
];

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.vue', '.css', '.js', '.mjs'];

/** 递归收集 `src/**` 里的源码文件（跳过测试：它们不进构建产物） */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    if (!SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) continue;
    out.push(full);
  }
  return out;
}

const NON_NETWORK_URIS = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink']);

/**
 * 从一份源码里摘出所有外部主机。
 *
 * 两种**不是主机**的命中要滤掉，否则名单里会混进假条目：
 * - 光秃秃的协议前缀（`'https://'`，补协议用）——`://` 后面什么都没有
 * - 模板拼接（`` `https://${base}` ``）——主机是个表达式，静态扫不出来
 */
function extractExternalHosts(source: string): string[] {
  const hosts: string[] = [];
  for (const m of source.matchAll(/https?:\/\/([^\s"'`<>)\\]*)/g)) {
    if (NON_NETWORK_URIS.has(m[0])) continue;
    const rest = m[1] ?? '';
    const host = rest.split(/[/?#]/)[0];
    if (!host) continue; // 裸协议前缀
    if (host.includes('${') || host.startsWith('$')) continue; // 模板拼接
    hosts.push(host);
  }
  return hosts;
}

describe('src/** 不引用未声明的外部主机', () => {
  const allowed = new Set(
    [...ALLOWED_EXTERNAL_HOSTS, ...PENDING_REMOVAL_HOSTS].map((e) => e.host.toLowerCase()),
  );
  const files = collectSourceFiles(join(REPO_ROOT, 'src'));

  it('扫描面非空（防止 collectSourceFiles 悄悄扫了个空目录）', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('忽略标准 XML 命名空间，但不放行同主机的网络资源', () => {
    expect(
      extractExternalHosts(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://www.w3.org/asset.png"/></svg>',
      ),
    ).toEqual(['www.w3.org']);
  });

  it('每一条 https?:// 字面量的主机都在白名单里', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const host of extractExternalHosts(readFileSync(file, 'utf8'))) {
        if (allowed.has(host.toLowerCase())) continue;
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')} → ${host}`);
      }
    }
    // 命中即红。真的需要一个新外部端点：加进 ALLOWED_EXTERNAL_HOSTS 并写清楚理由；
    // 如果它是**资源**（字体/图片/贴图/脚本），答案不是加白名单，是自托管。
    expect(offenders).toEqual([]);
  });

  // 📌 没有第二条「点名挡住 i.ibb.co / openseadragon.github.io」的断言 —— 上面那条就是。
  //    它们不在白名单里，回来即红，而且**连带说清是哪个文件**。
  //    点名式的整份文本 not.toContain 在这里只会被解释这些坑的注释自己绊倒
  //    （本文件上半段已经栽过两次，见 Font Awesome 那条的注释）。
});

describe('OpenSeadragon 控件贴图自托管（D23）', () => {
  it('prefixUrl 指向本地 /osd/，不是官方 CDN', () => {
    const src = read('src/ui/composables/useMapViewer.ts');
    expect(src).toContain("OSD_PREFIX_URL = '/osd/'");
    expect(src).toContain('prefixUrl: OSD_PREFIX_URL');
  });

  it('贴图随 public/ 分发（Vite 逐字复制），且包含缩放/复位这几个真的会用到的按钮', () => {
    const files = readdirSync(join(REPO_ROOT, 'public', 'osd'));
    for (const needed of [
      'zoomin_rest.png',
      'zoomout_rest.png',
      'home_rest.png',
      'button_rest.png',
    ]) {
      expect(files).toContain(needed);
    }
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
