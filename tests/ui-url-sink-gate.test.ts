/**
 * ui-url-sink-gate.test.ts — 结构闸门：`src/ui/**` 里的 URL / HTML 汇点必须逐条登记来源
 *
 * 出处：插件系统设计 §4.4「宿主侧的 URL 汇点」规则一
 * （docs/planning/2026-11-15-plugin-system-design.md）。
 *
 * ## 为什么要钉
 * 插件写进状态的字符串，一旦被宿主当 URL 请求（`<img :src>`、`<a :href>`、`url()` 背景……），
 * 宿主就替插件访问了内网 —— 插件帧自己的 CSP 再严也拦不住，因为请求是从宿主 origin 发出的。
 * 这类汇点**破坏时不会报错**：新加一个 `:src="someState.url"` 编译得过、跑得通、测试全绿，
 * review 里看上去也人畜无害。所以把「每个汇点都说清值从哪来」变成断言。
 *
 * ## 判据
 * - 扫 `src/ui/**` 的 `.vue` 与 `.ts`（不含 `*.test.ts` / `*.spec.ts`），逐行匹配下面 `SINK_RULES`。
 * - 每个命中必须落在 `ALLOWLIST` 的某一条里：按「文件路径 + 稳定片段」匹配，不认行号。
 * - 每条登记写明命中次数（默认 1）。次数对不上、或整条一个都没命中（陈旧登记），同样判红 ——
 *   名单得一直说真话，删掉的汇点要顺手把登记删掉。
 * - 插件可写字段不许成为汇点的直接来源。新增登记时，备注要写到「值最终从哪来」这一层。
 *
 * ## 它挡不住什么
 * 逐行扫源码字符串：跨行拼出来的属性名（`:[attr]`）、把元素交给第三方库再由库去设 `src`、
 * 以及 `window.open` / `fetch` 这类请求型 API 都不在范围内。注释行（`//`、`*`、`<!--` 开头）跳过。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..');
const UI_DIR = join(REPO_ROOT, 'src', 'ui');

// ──────────────────────────────────────────────────────────────────────────────
// 判据
// ──────────────────────────────────────────────────────────────────────────────

type SinkKind =
  | 'v-html'
  | ':src'
  | ':href'
  | ':srcset'
  | ':poster'
  | ':srcdoc'
  | 'style-url'
  | 'dom-assign'
  | 'dom-html';

/** 每条规则命中一行即算一个汇点；同一行命中多条规则只记第一条 */
const SINK_RULES: ReadonlyArray<{ kind: SinkKind; re: RegExp }> = [
  { kind: 'v-html', re: /(?<![\w-])v-html\s*=/ },
  { kind: ':srcset', re: /(?<![\w-])(?::|v-bind:)srcset\s*=/ },
  { kind: ':srcdoc', re: /(?<![\w-])(?::|v-bind:)srcdoc\s*=/ },
  { kind: ':src', re: /(?<![\w-])(?::|v-bind:)src\s*=/ },
  { kind: ':href', re: /(?<![\w-])(?::|v-bind:)href\s*=/ },
  { kind: ':poster', re: /(?<![\w-])(?::|v-bind:)poster\s*=/ },
  // 绑定的 style 里出现 url()；或任意 TS / 模板里用变量拼 `url(...)`（模板串插值或字符串拼接）
  { kind: 'style-url', re: /(?<![\w-])(?::|v-bind:)style\s*=\s*"[^"]*url\(/ },
  { kind: 'style-url', re: /url\(\s*(?:["']?\$\{|["'`]\s*\+)/ },
  // 命令式写 DOM 的 URL 属性：`el.src = …`、`a.href = …`、`setAttribute('src', …)`
  { kind: 'dom-assign', re: /\.(?:src|href|srcset|poster|srcdoc)\s*=(?!=)/ },
  { kind: 'dom-assign', re: /\.setAttribute\(\s*['"](?:src|href|srcset|poster|srcdoc)['"]/ },
  { kind: 'dom-html', re: /\.(?:innerHTML|outerHTML)\s*=(?!=)|\.insertAdjacentHTML\(/ },
];

interface SinkHit {
  file: string;
  line: number;
  kind: SinkKind;
  text: string;
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--')
  );
}

/** 扫一份源码文本，返回其中的汇点命中。下面的夹具测试也直接调它 */
function scanSource(file: string, source: string): SinkHit[] {
  const hits: SinkHit[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const text = raw.trim();
    if (!text || isCommentLine(text)) return;
    const rule = SINK_RULES.find((r) => r.re.test(text));
    if (rule) hits.push({ file, line: i + 1, kind: rule.kind, text });
  });
  return hits;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(?:vue|ts)$/.test(entry.name) && !/\.(?:test|spec)\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

function scanUiTree(): SinkHit[] {
  return walk(UI_DIR).flatMap((full) => {
    const rel = relative(REPO_ROOT, full).split(sep).join('/');
    return scanSource(rel, readFileSync(full, 'utf8'));
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 登记表
// ──────────────────────────────────────────────────────────────────────────────

interface SinkEntry {
  /** 仓库根相对路径，正斜杠 */
  file: string;
  /** 命中行里必须包含的稳定片段（trim 之后的整行里找） */
  snippet: string;
  /** 本条应当命中的行数，默认 1 */
  count?: number;
  /** 一句话说清值从哪来 */
  note: string;
}

const ALLOWLIST: readonly SinkEntry[] = [
  // ═══ v-html ═══
  {
    file: 'src/ui/components/game/ChatFlow.vue',
    snippet: 'v-html="escapeHtml(msg.content)',
    note: '先 escapeHtml 再把换行换成 <br>，不产生任何属性或标签',
  },

  // ═══ :srcdoc ═══
  {
    file: 'src/ui/components/game/BeautifierFrame.vue',
    snippet: ':srcdoc="srcdoc"',
    note: 'buildBeautifierFrameDocument 拼的美化帧文档，跑在沙盒 iframe + CSP 里（§4.4 末行、§11 收紧）',
  },

  // ═══ :href ═══
  {
    file: 'src/ui/components/settings/DiscordPackAccess.vue',
    snippet: ':href="inviteUrl"',
    note: 'Discord 会话里服务端下发的邀请链接，经 new URL 解析且只放行 https:',
  },

  // ═══ :src —— 素材库 / 插画表 object URL ═══
  {
    file: 'src/ui/components/create/CreateStepConfirm.vue',
    snippet: ':src="portraitUrl ?? undefined"',
    note: '本地 blob URL，useAssetImage 按角色名从素材库解析',
  },
  {
    file: 'src/ui/components/game/CharacterViewerModal.vue',
    snippet: ':src="portraitUrl"',
    note: '本地 blob URL，useAssetImage 按角色名从素材库解析',
  },
  {
    file: 'src/ui/components/game/StatusOverview.vue',
    snippet: ':src="portraitUrl"',
    count: 2,
    note: '本地 blob URL，useAssetImage 按玩家名从素材库解析（立绘与设置对话框各一处）',
  },
  {
    file: 'src/ui/components/game/StatusOverview.vue',
    snippet: ':src="portraitUrl ?? undefined"',
    note: '本地 blob URL，useAssetImage 按玩家名从素材库解析（头像兜底）',
  },
  {
    file: 'src/ui/components/game/MapPoliticalTab.vue',
    snippet: ':src="playerPinImage"',
    note: '本地 blob URL，useAssetImage 按玩家名从素材库解析，视频素材不用',
  },
  {
    file: 'src/ui/components/game/CgGalleryPanel.vue',
    snippet: ':src="urls.urlFor(cell.displayed.id)',
    note: '本地 blob URL，useSceneImageUrls 从插画表的字节按 id 生成',
  },
  {
    file: 'src/ui/components/game/CgGalleryDetail.vue',
    snippet: ':src="url"',
    note: '父组件 CgGalleryPanel 传入的 urls.urlFor(id)，插画表字节的本地 blob URL',
  },
  {
    file: 'src/ui/components/game/SceneImageSegment.vue',
    snippet: ':src="url"',
    count: 2,
    note: '本地 blob URL，useSceneImageUrls 从插画表的字节按 id 生成（正文图与灯箱各一处）',
  },
  {
    file: 'src/ui/components/settings/assets/AssetCharacterDrawer.vue',
    snippet: ':src="thumbFor(row.id) ?? undefined"',
    count: 2,
    note: '本地 blob URL，useAssetThumbs 从素材库行的字节生成缩略图',
  },
  {
    file: 'src/ui/components/settings/assets/AssetLibrary.vue',
    snippet: ':src="thumbFor(coverRow(g).id) ?? undefined"',
    count: 2,
    note: '本地 blob URL，useAssetThumbs 从素材库行的字节生成缩略图（分组封面）',
  },
  {
    file: 'src/ui/components/settings/assets/AssetLibrary.vue',
    snippet: ':src="thumbFor(row.id) ?? undefined"',
    count: 2,
    note: '本地 blob URL，useAssetThumbs 从素材库行的字节生成缩略图',
  },
  {
    file: 'src/ui/components/shared/AssetCropEditor.vue',
    snippet: ':src="srcUrl"',
    note: '本地 blob URL，组件自己对传入的素材 Blob 调 createObjectURL',
  },
  {
    file: 'src/ui/components/shared/AssetMedia.vue',
    snippet: ':src="url"',
    count: 2,
    note: '本地 blob URL，useAssetImage 按名字从素材库解析',
  },
  {
    file: 'src/ui/components/shared/AvatarPanel.vue',
    snippet: ':src="src"',
    count: 2,
    note: '展示组件透传 prop；调用方（CreateStepConfirm / StatusOverview）只传素材库 blob URL',
  },
  {
    file: 'src/ui/components/shared/CharacterPortrait.vue',
    snippet: ':src="src"',
    count: 2,
    note: '展示组件透传 prop；调用方只传素材库 blob URL（经 PortraitSettingsDialog 等）',
  },
  {
    file: 'src/ui/components/shared/PortraitSettingsDialog.vue',
    snippet: '<CharacterPortrait :name="name" :src="src"',
    note: '透传给 CharacterPortrait 的 prop，调用方 StatusOverview 传素材库 blob URL',
  },

  // ═══ :src —— 地图标记图片 ═══
  {
    file: 'src/ui/components/game/MapPanel.vue',
    snippet: ':src="activeMarkerImage"',
    note: 'worldFlags.mapMarkers[].imageUrls 原样当 URL；StatePatch 写不到，且不开放任何地图标记命令（§4.4）',
  },

  // ═══ :src —— 创意工坊（上游服务器下发的远程 URL） ═══
  {
    file: 'src/ui/components/workshop/WorkshopDetailModal.vue',
    snippet: ':src="coverSrc"',
    note: '工坊上游详情的 coverUrl，经 coverCandidates 先走 wsrv 代理再退原图',
  },
  {
    file: 'src/ui/components/workshop/WorkshopProjectCard.vue',
    snippet: ':src="coverSrc"',
    note: '工坊上游列表的 coverUrl，经 coverCandidates 先走 wsrv 代理再退原图',
  },
  {
    file: 'src/ui/components/workshop/WorkshopProjectCard.vue',
    snippet: ':src="authorAvatar"',
    note: '工坊上游列表的 authorAvatarUrl，缺省退 Discord CDN 默认头像',
  },
  {
    file: 'src/ui/components/workshop/WorkshopPage.vue',
    snippet: ':src="avatarUrl"',
    note: 'discordAvatarUrl 拼的 cdn.discordapp.com 固定前缀地址，或 Discord 默认头像',
  },

  // ═══ style-url ═══
  {
    file: 'src/ui/components/shared/AssetCropEditor.vue',
    snippet: 'backgroundImage: `url("${srcUrl.value}")`',
    note: '同上 srcUrl：组件自己对素材 Blob 调 createObjectURL 得到的本地 blob URL',
  },

  // ═══ dom-assign —— 导出下载用的 <a href> ═══
  {
    file: 'src/ui/components/create/CreateStepPlot.vue',
    snippet: 'a.href = url;',
    note: '导出下载：宿主自己 JSON.stringify 的 application/json Blob 的 object URL',
  },
  {
    file: 'src/ui/components/create/PresetModal.vue',
    snippet: 'a.href = url;',
    count: 2,
    note: '导出下载：宿主自己 JSON.stringify 的预设 Blob 的 object URL（单条与全部各一处）',
  },
  {
    file: 'src/ui/components/game/CgGalleryPanel.vue',
    snippet: 'a.href = url;',
    note: '导出插画：urls.urlFor(id)，插画表字节的本地 blob URL',
  },
  {
    file: 'src/ui/components/game/DebugPanel.vue',
    snippet: 'a.href = url;',
    note: '导出下载：宿主自己 JSON.stringify 的调试数据 Blob 的 object URL',
  },
  {
    file: 'src/ui/components/settings/agent/AgentPresetBar.vue',
    snippet: 'a.href = url;',
    note: '导出下载：宿主自己 JSON.stringify 的 agent 预设 Blob 的 object URL',
  },
  {
    file: 'src/ui/components/settings/assets/AssetImportStrip.vue',
    snippet: 'a.href = url;',
    note: '导出下载：素材 store 打好的导出包 Blob 的 object URL',
  },
  {
    file: 'src/ui/components/settings/BeautifierSection.vue',
    snippet: 'a.href = url;',
    note: '导出下载：宿主自己 JSON.stringify 的美化规则 Blob 的 object URL',
  },
  {
    file: 'src/ui/components/settings/DataSection.vue',
    snippet: 'a.href = u;',
    note: '导出下载：exportAllData 结果 JSON.stringify 后的 Blob 的 object URL',
  },
  {
    file: 'src/ui/components/shared/SaveManager.vue',
    snippet: 'anchor.href = url;',
    note: '导出下载：exportSessionSave 结果 JSON.stringify 后的 Blob 的 object URL',
  },
  {
    file: 'src/ui/stores/create-store.ts',
    snippet: 'a.href = url;',
    note: '导出下载：宿主自己 JSON.stringify 的建卡数据 Blob 的 object URL',
  },

  // ═══ dom-assign —— 牢笼帧内层（生成的脚本跑在 opaque 沙盒里，不在宿主 origin） ═══
  {
    file: 'src/ui/lib/frame-cage.ts',
    snippet: "frame.setAttribute('src', blobUrl);",
    note: '牢笼帧脚本在自身 opaque origin 里对调用方给的内层文档建 text/html blob，首次 load 即撤销',
  },
  {
    file: 'src/ui/lib/frame-cage.ts',
    snippet: "frame.setAttribute('srcdoc', config.inner);",
    note: '牢笼帧脚本把调用方给的内层文档写进 srcdoc，沙盒标志与 CSP 从牢笼继承（§4.1）',
  },
  {
    file: 'src/ui/stores/plugin-store.ts',
    snippet: "frame.setAttribute('srcdoc', html);",
    note: '启动自检的探针文档：全部由 plugin-selfcheck.ts 生成（对照帧 / 加固美化帧 / S5 测试策略），挂在离屏沙盒 iframe 里，目标只有本机金丝雀（§4.8）',
  },
  {
    file: 'src/ui/lib/plugin-frame.ts',
    snippet: "frame.setAttribute('srcdoc', cage)",
    note: 'buildPluginFrameDocument 生成的插件牢笼文档（只含宿主脚本与内嵌引导文档），跑在沙盒 iframe + 同一份插件 CSP 里（§4.1）',
  },
  {
    file: 'src/ui/components/workshop/PluginManagerSection.vue',
    snippet: ':src="iconOf(entry)!"',
    note: '插件图标：pluginStore.iconFor 给的值，只可能是宿主用 preparePluginIcon 重编码出的 data:image/png;base64 URL（§4.4 规则二），不是插件写的字符串',
  },
  {
    file: 'src/ui/components/game/SideToolbar.vue',
    snippet: ':src="entry.icon"',
    note: '侧栏插件按钮图标：usePluginContributions 只从 pluginStore.iconFor 取值，即宿主用 preparePluginIcon 重编码出的 data:image/png;base64 URL（§4.4 规则二），从不回落到 manifest 里插件写的路径',
  },
  {
    file: 'src/ui/components/game/ItemsPanel.vue',
    snippet: ':src="item.entry.icon"',
    note: '背包面板插件插槽的入口图标：同上，usePluginContributions 只从 pluginStore.iconFor 取宿主重编码的 data:image/png;base64 URL（§4.4 规则二）',
  },

  // ═══ dom-assign —— 其他 ═══
  {
    file: 'src/ui/lib/map-provinces-raster.ts',
    snippet: 'el.src = objectUrl;',
    note: '省份栅格图解码：对传入的图片 Blob 调 createObjectURL，用完即撤',
  },
  {
    file: 'src/ui/components/home/drift/runtime.ts',
    snippet: "img.src = 'data:image/svg+xml;charset=utf-8,'",
    note: '首页法阵：内置 SVG 文本编码成 data URL 画进 canvas 纹理',
  },
  {
    file: 'src/ui/lib/discord-auth-client.ts',
    snippet: 'popup.location.href = `${serverUrl}/api/v1/auth/discord/login',
    note: 'Discord 登录弹窗：serverUrl 来自已校验 origin 的会话设置，路径固定',
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// 比对
// ──────────────────────────────────────────────────────────────────────────────

interface GateResult {
  unregistered: SinkHit[];
  mismatched: Array<{ entry: SinkEntry; matched: number }>;
}

function checkAgainst(hits: readonly SinkHit[], allowlist: readonly SinkEntry[]): GateResult {
  const matches = (e: SinkEntry, h: SinkHit) => e.file === h.file && h.text.includes(e.snippet);
  return {
    unregistered: hits.filter((h) => !allowlist.some((e) => matches(e, h))),
    mismatched: allowlist
      .map((entry) => ({ entry, matched: hits.filter((h) => matches(entry, h)).length }))
      .filter(({ entry, matched }) => matched !== (entry.count ?? 1)),
  };
}

function formatHit(h: SinkHit): string {
  return `${h.file}:${h.line} [${h.kind}] ${h.text}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// 测试
// ──────────────────────────────────────────────────────────────────────────────

describe('src/ui 的 URL / HTML 汇点全部登记来源（§4.4 规则一）', () => {
  const hits = scanUiTree();
  const result = checkAgainst(hits, ALLOWLIST);

  it('扫得到东西（防止路径或正则改坏后空跑变绿）', () => {
    expect(hits.length).toBeGreaterThan(20);
    expect(hits.some((h) => h.kind === 'v-html')).toBe(true);
    expect(hits.some((h) => h.kind === ':src')).toBe(true);
  });

  it('没有未登记的汇点', () => {
    expect(result.unregistered.map(formatHit)).toEqual([]);
  });

  it('登记表没有陈旧或次数不符的条目', () => {
    expect(
      result.mismatched.map(
        ({ entry, matched }) =>
          `${entry.file} 「${entry.snippet}」期望 ${entry.count ?? 1} 处，实际 ${matched} 处`,
      ),
    ).toEqual([]);
  });

  it('每条登记都写了来源备注，且没有重复登记', () => {
    for (const e of ALLOWLIST) expect(e.note.trim().length, e.snippet).toBeGreaterThan(4);
    const keys = ALLOWLIST.map((e) => `${e.file}\u0000${e.snippet}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('扫描器自检（夹具字符串，不改 src）', () => {
  const FIXTURE_FILE = 'src/ui/components/fixture/Fake.vue';
  const fixture = [
    '<template>',
    '  <!-- <img :src="commented"> 注释行不算 -->',
    '  <img :src="plugin.iconUrl" />',
    '  <img v-bind:src="other" />',
    '  <a :href="link">x</a>',
    '  <img :srcset="set" />',
    '  <video :poster="poster" />',
    '  <div v-html="raw" />',
    '  <div :style="`background: url(${bg})`" />',
    '  <div :data-src="notASink" :srcName="alsoNot" />',
    '</template>',
    '<script setup lang="ts">',
    'el.src = state.url;',
    "const css = 'url(' + x + ')';",
    "const ok = 'url(/static.png)';",
    'if (a.href == b) {}',
    '</script>',
  ].join('\n');
  const hits = scanSource(FIXTURE_FILE, fixture);

  it('各类汇点都能识别，注释与无关属性不误报', () => {
    expect(hits.map((h) => [h.line, h.kind])).toEqual([
      [3, ':src'],
      [4, ':src'],
      [5, ':href'],
      [6, ':srcset'],
      [7, ':poster'],
      [8, 'v-html'],
      [9, 'style-url'],
      [13, 'dom-assign'],
      [14, 'style-url'],
    ]);
  });

  it('未登记的 :src 让闸门判红', () => {
    const allowlist: SinkEntry[] = hits
      .filter((h) => !h.text.includes('plugin.iconUrl'))
      .map((h) => ({ file: FIXTURE_FILE, snippet: h.text, note: '夹具' }));
    const { unregistered, mismatched } = checkAgainst(hits, allowlist);
    expect(unregistered.map((h) => h.text)).toEqual(['<img :src="plugin.iconUrl" />']);
    expect(mismatched).toEqual([]);
  });

  it('陈旧登记与次数不符都让闸门判红', () => {
    const stale: SinkEntry = { file: FIXTURE_FILE, snippet: ':src="gone"', note: '已删' };
    const wrongCount: SinkEntry = {
      file: FIXTURE_FILE,
      snippet: '<a :href="link">',
      count: 2,
      note: '次数写错',
    };
    const { mismatched } = checkAgainst(hits, [stale, wrongCount]);
    expect(mismatched.map((m) => [m.entry.snippet, m.matched])).toEqual([
      [':src="gone"', 0],
      ['<a :href="link">', 1],
    ]);
  });
});
