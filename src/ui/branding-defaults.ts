/**
 * branding-defaults.ts —— 品牌面的中性默认值 + 解析器（设计 D26 / D41）
 *
 * ## 这个文件解决什么
 *
 * 引擎仓开源后，代码里**不许再有任何世界 IP 专名**：应用名、副标题、风味文字、制作人员、
 * 关于页页脚、剧情大纲示例、纪元名、工坊社区源地址——这些今天全是硬编码的中文字面量，
 * 散在 `index.html` / `HomePage.vue` / `AboutSection.vue` / `PlotSection.vue` 里。
 * 本文件把它们收成**一份中性默认值**（{@link NEUTRAL_BRANDING}），真实值由内容包的
 * `branding` 分节供给，经 T8a 的内容注册表（`content-store.ts` 的 `branding` 面）灌进来。
 *
 * ## 落点纪律（🔴 不要另起第二套机制）
 *
 * 品牌面**只有一条链**：
 *
 * ```
 * data/content/branding.json（占位期 fetch）┐
 *                                          ├─► ContentRegistry.branding ─► resolveBranding()
 * 内容包 pack.branding（装包后整节盖）      ┘        （unknown）              （BrandingConfig）
 * ```
 *
 * 注册表的三态优先级（pack > 占位 > 缺省）由 `content-store.ts` 负责，本文件只做
 * **最后一步**：把注册表那个 `unknown` 逐字段收窄，缺什么补 {@link NEUTRAL_BRANDING}。
 * 于是「内容没加载出来」与「内容包没这个字段」是同一条路径——都拿中性默认值，永不空屏。
 *
 * ## 为什么解析器是纯函数 + 逐字段类型守卫
 *
 * 注册表那一面的来源是**用户导入的 JSON**（内容包）或一个可能 404/半损的 fetch。
 * 一个 `as BrandingConfig` 就能让 `subtitles.map()` 在首页上抛运行时错误——首页是
 * 唯一一个「炸了就什么都点不了」的页面。所以这里不做断言、只做守卫：类型不对的字段
 * 静默回落默认值，不整份丢弃（部分正确的 branding 仍然可用）。
 *
 * ## 反应式
 *
 * 注册表是模块级 `let`（**不是** reactive），因为 agent-tools 这类同步消费方读它。
 * Vue 侧照 `MapPanel.vue` 的既有姿势：`onMounted` 里 `await loadBranding()` 拿一份快照
 * 塞进本地 `ref`。{@link useBranding} 把这三行包好，顺带在首轮解析后写 `document.title`。
 */
import { ref, shallowRef, type Ref } from 'vue';

import { ensureContentRegistryLoaded, getContentRegistry } from './stores/content-store';
import { setWorkshopConfig } from './lib/workshop-client';

// ═══════════════════════════════════════════════════════════
// 1. 形状
// ═══════════════════════════════════════════════════════════

/** 首页「制作人员」弹窗里的世界速览块 */
interface BrandingWorldSummary {
  /** 块标题（世界名）；空串 = 不渲染整块 */
  title: string;
  /** 块正文，逐行渲染 */
  lines: string[];
}

/** 剧情大纲示例的一段（设置页 PlotSection 的防剧透预览） */
interface BrandingPlotBeat {
  /** 小标题，如「第一年 — 序章：…」 */
  title: string;
  /** 该段的一句话说明 */
  body: string;
}

/**
 * 解析完成的品牌面。**全字段必填**——解析器保证每一格都有值，
 * 消费方不必写 `?.` 与兜底三元（那种兜底散在 UI 里就是第二套默认值）。
 */
export interface BrandingConfig {
  /** 完整应用名 → `document.title`（D26 的运行时改点） */
  appTitle: string;
  /** 产品短名 → 设置页「关于 X」 */
  shortName: string;
  /** 首页大标题的分行；1 行也合法（数组空 → 退回 `[appTitle]`） */
  titleLines: string[];
  /** 首页标题下那一行小字（原来是英文书名） */
  tagline: string;
  /** 首页风味文字轮播；空数组 = 不渲染轮播区 */
  subtitles: string[];
  /** 首页制作人员弹窗里「世界观设定」那一行的署名 */
  credits: string;
  /** 首页制作人员弹窗里的世界速览块 */
  worldSummary: BrandingWorldSummary;
  /** 设置页关于分区的页脚整句（不含版权行） */
  about: string;
  /** 关于分区页脚的版权行；空串 = 不渲染 */
  copyright: string;
  /**
   * 纪元名（D9）。存档创建时盖章进 SaveProfile，此后只读存档、永不活读内容包。
   *
   * 🔴 引擎侧的 era 中性化由 T12 负责；本字段是**供给侧**——T10/T12 按这个字段名取值。
   */
  era: string;
  /** 设置页剧情分区的大纲示例；空数组 = 不渲染预览卡 */
  plotTemplate: BrandingPlotBeat[];
  /** 创意工坊社区源基址（D41）。**空串 = 未配置** → 工坊页渲染空态，不发任何请求 */
  workshopApiBase: string;
  /** 工坊登录的前提说明（D41）；空串 = 不追加前提句 */
  workshopLoginHint: string;
}

// ═══════════════════════════════════════════════════════════
// 2. 中性默认值
// ═══════════════════════════════════════════════════════════

/**
 * 中性默认值 —— **这里一个 IP 专名都不许有**（验收 #1，守门测试会扫）。
 *
 * 它同时是两种状态的显示值：
 * - 公开仓零安装态（没有 `data/content/branding.json`，六面 fetch 全 404）
 * - 内容包卸载之后（注册表回落占位）
 *
 * 措辞刻意描述的是**引擎**而不是某个世界：装了内容包才谈得上世界名与纪元。
 */
export const NEUTRAL_BRANDING: Readonly<BrandingConfig> = Object.freeze({
  appTitle: '叙事引擎',
  shortName: '叙事引擎',
  titleLines: ['叙事引擎'],
  tagline: 'Narrative Engine',
  subtitles: ['一段还没有被写下的故事', '每一次抉择，都是新的一行', '灯还亮着，故事就还没完'],
  credits: '内置演示内容',
  worldSummary: Object.freeze({
    title: '演示世界',
    lines: ['导入内容包后，这里会显示该世界的概览。'],
  }) as BrandingWorldSummary,
  about: '多 Agent 协作文字 RPG 引擎',
  copyright: '',
  era: '元年',
  plotTemplate: [],
  workshopApiBase: '',
  workshopLoginHint: '',
} satisfies BrandingConfig);

// ═══════════════════════════════════════════════════════════
// 3. 解析（纯函数）
// ═══════════════════════════════════════════════════════════

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 取非空字符串；不是字符串或是空串 → 默认值 */
function str(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : fallback;
}

/**
 * 取字符串数组。
 *
 * 🔴 空数组是**合法的**（「刻意清空」，与内容包分节三态同口径）——只有「不是数组」
 * 才回落默认值。所以内容包可以显式关掉风味文字轮播，而不是被默认值顶回来。
 */
function strArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return [...fallback];
  return raw.filter((x): x is string => typeof x === 'string');
}

function worldSummary(raw: unknown, fallback: BrandingWorldSummary): BrandingWorldSummary {
  if (!isPlainObject(raw)) return { title: fallback.title, lines: [...fallback.lines] };
  return {
    title: str(raw.title, fallback.title),
    lines: strArray(raw.lines, fallback.lines),
  };
}

function plotTemplate(raw: unknown, fallback: BrandingPlotBeat[]): BrandingPlotBeat[] {
  if (!Array.isArray(raw)) return fallback.map((b) => ({ ...b }));
  const beats: BrandingPlotBeat[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const title = typeof item.title === 'string' ? item.title : '';
    const body = typeof item.body === 'string' ? item.body : '';
    // 两格都空的条目没有任何可渲染内容，跳过而不是渲染一段空白
    if (title === '' && body === '') continue;
    beats.push({ title, body });
  }
  return beats;
}

/**
 * 把注册表的 `branding` 面（`unknown`）收窄成 {@link BrandingConfig}。
 *
 * **纯函数**：不读注册表、不写 DOM、不碰 store。测试直接喂对象。
 *
 * @param raw 注册表 branding 面（内容包分节 / 占位 JSON / undefined）
 * @param base 兜底值，默认 {@link NEUTRAL_BRANDING}
 */
export function resolveBranding(
  raw: unknown,
  base: Readonly<BrandingConfig> = NEUTRAL_BRANDING,
): BrandingConfig {
  if (!isPlainObject(raw)) {
    return {
      ...base,
      titleLines: [...base.titleLines],
      subtitles: [...base.subtitles],
      worldSummary: { title: base.worldSummary.title, lines: [...base.worldSummary.lines] },
      plotTemplate: base.plotTemplate.map((b) => ({ ...b })),
    };
  }
  const appTitle = str(raw.appTitle, base.appTitle);
  // 🔴 分行**不走 strArray 的默认回落**：内容包给了 appTitle 却没给分行时，
  //    回落成默认分行会让标题画面显示中性默认名、副标题显示真名，一屏两个身份。
  //    没给（或给了个空的）就从 appTitle 派生 —— 标题画面上没有标题不是任何人想要的状态。
  const rawLines = Array.isArray(raw.titleLines)
    ? raw.titleLines.filter((x): x is string => typeof x === 'string' && x !== '')
    : undefined;
  return {
    appTitle,
    shortName: str(raw.shortName, base.shortName),
    titleLines: rawLines && rawLines.length > 0 ? rawLines : [appTitle],
    tagline: str(raw.tagline, base.tagline),
    subtitles: strArray(raw.subtitles, base.subtitles),
    credits: str(raw.credits, base.credits),
    worldSummary: worldSummary(raw.worldSummary, base.worldSummary),
    about: str(raw.about, base.about),
    // copyright 默认是空串，str() 的「空串 → 默认」在这里正好等价于「照抄」
    copyright: str(raw.copyright, base.copyright),
    era: str(raw.era, base.era),
    plotTemplate: plotTemplate(raw.plotTemplate, base.plotTemplate),
    workshopApiBase: str(raw.workshopApiBase, base.workshopApiBase),
    workshopLoginHint: str(raw.workshopLoginHint, base.workshopLoginHint),
  };
}

// ═══════════════════════════════════════════════════════════
// 4. 运行时读取
// ═══════════════════════════════════════════════════════════

/**
 * 同步读当前品牌面（注册表未加载 → 中性默认值）。
 *
 * 同步是有意的：`document.title` 与工坊配置都需要在「注册表已经灌好」的那一刻就能取值，
 * 而那一刻可能在任何一个 `await` 之后。要等加载完请用 {@link loadBranding}。
 */
export function getBranding(): BrandingConfig {
  return resolveBranding(getContentRegistry().branding);
}

/**
 * 等注册表加载完再读，并把两处**非 Vue 的**消费点一起对齐：
 *
 * 1. `document.title`（D26 的运行时改点）
 * 2. 工坊客户端的社区源 / 登录前提文案（D41）——`workshop-client.ts` 是纯网络层，
 *    刻意不让它 import 本模块（那会把 Pinia + Dexie 拖进它的测试），改成本模块推给它。
 *
 * 幂等、永不抛（`ensureContentRegistryLoaded` 自己就是永不抛的）。
 */
export async function loadBranding(): Promise<BrandingConfig> {
  await ensureContentRegistryLoaded();
  const branding = getBranding();
  applyBranding(branding);
  return branding;
}

/** 把品牌面推给 Vue 之外的消费点（`document.title` + 工坊配置）。可单独调用（测试用） */
export function applyBranding(branding: BrandingConfig): void {
  if (typeof document !== 'undefined') {
    document.title = branding.appTitle;
  }
  setWorkshopConfig({
    apiBase: branding.workshopApiBase,
    loginHint: branding.workshopLoginHint,
  });
}

/**
 * Vue 侧取品牌面：先给中性默认值（首屏不空），注册表加载完再换成真值。
 *
 * 用 `shallowRef` 而不是 `ref`：整份替换，没有深层写入，省掉一整棵代理。
 *
 * @returns `{ branding, ready }` —— `ready` 供需要「加载完再渲染」的地方用（一般不必）
 */
export function useBranding(): { branding: Ref<BrandingConfig>; ready: Ref<boolean> } {
  const branding = shallowRef<BrandingConfig>(getBranding());
  const ready = ref(false);
  void loadBranding()
    .then((resolved) => {
      branding.value = resolved;
      ready.value = true;
    })
    .catch(() => {
      // loadBranding 永不抛；这里只是把「万一」挡在组件外面，别让首页挂在未捕获拒绝上
      ready.value = true;
    });
  return { branding, ready };
}
