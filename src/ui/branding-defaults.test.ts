/**
 * @vitest-environment jsdom
 *
 * branding-defaults.test.ts —— 品牌面解析器 + 运行时接线（T13 / D26 / D41）
 *
 * 三组断言：
 * 1. **中性默认值里一个 IP 专名都没有** —— 这是开源边界的钉子（验收 #1），
 *    不是功能测试。它红了说明有人把世界内容写回了引擎默认值。
 * 2. **解析器面对垃圾输入不崩**：注册表那一面来自用户导入的 JSON 或一个可能半损的
 *    fetch，一个 `as BrandingConfig` 就能让首页在 `subtitles.map()` 上炸掉。
 * 3. **运行时两个非 Vue 消费点真的被推到**（`document.title` / 工坊配置）——
 *    「声明了但没人传」正是图像 v1 的 blurByDefault 踩过的坑。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import {
  NEUTRAL_BRANDING,
  applyBranding,
  getBranding,
  loadBranding,
  resolveBranding,
  type BrandingConfig,
} from './branding-defaults';
import {
  getContentRegistry,
  seedPlaceholderRegistry,
  setContentRegistry,
  resetContentRegistryLoadedForTests,
} from './stores/content-store';
import { getWorkshopApiBase, getWorkshopLoginHint, setWorkshopConfig } from './lib/workshop-client';

// ═══════════════════════════════════════════════════════════
// 1. 中性默认值不许含 IP
// ═══════════════════════════════════════════════════════════

/**
 * 世界专名词表（D32 守门规则的本地小抄）。
 *
 * 只列**必然是 IP** 的词：产品名、世界名、纪元名、创作组署名。像「命运」「黄昏」
 * 这种通用词不入表 —— 那会让中性文案写不出一句像样的话。
 */
const IP_TERMS = ['命定之诗', '黄昏之歌', '阿斯塔利亚', '复兴纪元', 'Fated Poem', 'Destined'];

describe('NEUTRAL_BRANDING', () => {
  it('🔴 中性默认值里没有任何世界专名（开源边界）', () => {
    const blob = JSON.stringify(NEUTRAL_BRANDING);
    for (const term of IP_TERMS) {
      expect(blob).not.toContain(term);
    }
  });

  it('🔴 默认不带社区源 —— 引擎自己不指向任何工坊（D41）', () => {
    expect(NEUTRAL_BRANDING.workshopApiBase).toBe('');
    expect(NEUTRAL_BRANDING.workshopLoginHint).toBe('');
  });

  it('剧情大纲示例默认为空 —— 它讲的是某个具体世界，不该由引擎编一份', () => {
    expect(NEUTRAL_BRANDING.plotTemplate).toEqual([]);
  });

  it('era 有中性缺省（存档创建时要盖章，不能是空串）', () => {
    expect(NEUTRAL_BRANDING.era.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. resolveBranding（纯函数）
// ═══════════════════════════════════════════════════════════

describe('resolveBranding', () => {
  it('undefined / null / 数组 / 字符串 → 整份中性默认值', () => {
    for (const raw of [undefined, null, [], 'nope', 42]) {
      expect(resolveBranding(raw)).toEqual(NEUTRAL_BRANDING);
    }
  });

  it('部分字段 → 只覆盖给了的那些，其余留默认', () => {
    const out = resolveBranding({ appTitle: '某某传说', era: '星历' });
    expect(out.appTitle).toBe('某某传说');
    expect(out.era).toBe('星历');
    expect(out.tagline).toBe(NEUTRAL_BRANDING.tagline);
    expect(out.credits).toBe(NEUTRAL_BRANDING.credits);
  });

  it('🔴 类型不对的字段静默回落，不整份丢弃（半正确的 branding 仍然可用）', () => {
    const out = resolveBranding({
      appTitle: 123, // 不是串
      subtitles: 'not-an-array',
      worldSummary: 'nope',
      plotTemplate: { title: 'x' }, // 不是数组
      era: '星历', // 这个是好的，必须活下来
    });
    expect(out.appTitle).toBe(NEUTRAL_BRANDING.appTitle);
    expect(out.subtitles).toEqual(NEUTRAL_BRANDING.subtitles);
    expect(out.worldSummary).toEqual(NEUTRAL_BRANDING.worldSummary);
    expect(out.plotTemplate).toEqual([]);
    expect(out.era).toBe('星历');
  });

  it('🔴 空数组是「刻意清空」不是「没给」—— 内容包能关掉风味文字轮播', () => {
    expect(resolveBranding({ subtitles: [] }).subtitles).toEqual([]);
  });

  it('空串 = 没给（避免内容包一个空字段把标题清成空白屏）', () => {
    expect(resolveBranding({ appTitle: '' }).appTitle).toBe(NEUTRAL_BRANDING.appTitle);
  });

  it('只给 appTitle 没给分行 → 单行显示整串，而不是显示中性默认名', () => {
    expect(resolveBranding({ appTitle: '某某传说' }).titleLines).toEqual(['某某传说']);
  });

  it('titleLines 里的非字符串项被剔除，剩下的照用', () => {
    expect(resolveBranding({ titleLines: ['甲', 7, null, '乙'] }).titleLines).toEqual(['甲', '乙']);
  });

  it('plotTemplate 逐段收窄：非对象项跳过，标题正文都空的段也跳过', () => {
    const out = resolveBranding({
      plotTemplate: [
        'nope',
        { title: '第一年', body: '开局' },
        { title: '', body: '' },
        { title: '第二年' },
      ],
    });
    expect(out.plotTemplate).toEqual([
      { title: '第一年', body: '开局' },
      { title: '第二年', body: '' },
    ]);
  });

  it('🔴 返回值与默认值之间不共享数组引用（改了返回值不该污染下一次解析）', () => {
    const a = resolveBranding(undefined);
    a.subtitles.push('污染');
    a.worldSummary.lines.push('污染');
    expect(resolveBranding(undefined).subtitles).toEqual(NEUTRAL_BRANDING.subtitles);
    expect(resolveBranding(undefined).worldSummary.lines).toEqual(
      NEUTRAL_BRANDING.worldSummary.lines,
    );
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 运行时接线
// ═══════════════════════════════════════════════════════════

describe('getBranding / applyBranding / loadBranding', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
    setWorkshopConfig({ apiBase: '', loginHint: '' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
    setWorkshopConfig({ apiBase: '', loginHint: '' });
  });

  it('注册表未加载 → 中性默认值（永不空屏）', () => {
    expect(getContentRegistry().branding).toBeUndefined();
    expect(getBranding()).toEqual(NEUTRAL_BRANDING);
  });

  it('注册表灌了值 → 同步读得到', () => {
    setContentRegistry({ ...getContentRegistry(), branding: { appTitle: '某某传说' } });
    expect(getBranding().appTitle).toBe('某某传说');
  });

  it('🔴 applyBranding 推 document.title（D26 的运行时改点）', () => {
    const branding: BrandingConfig = { ...NEUTRAL_BRANDING, appTitle: '某某传说' };
    applyBranding(branding);
    expect(document.title).toBe('某某传说');
  });

  it('🔴 applyBranding 推工坊配置（D41：社区源与登录前提都由内容包供给）', () => {
    applyBranding({
      ...NEUTRAL_BRANDING,
      workshopApiBase: 'https://mirror.example/',
      workshopLoginHint: '需要先加入某个服务器',
    });
    // 尾斜杠由 setter 剃掉
    expect(getWorkshopApiBase()).toBe('https://mirror.example');
    expect(getWorkshopLoginHint()).toBe('需要先加入某个服务器');
  });

  it('🔴 loadBranding 走完整条链：fetch 占位 JSON → 注册表 → title + 工坊配置', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/data/content/branding.json') {
        return new Response(
          JSON.stringify({
            appTitle: '某某传说',
            workshopApiBase: 'https://community.example',
            workshopLoginHint: '需要先加入某个服务器',
          }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    });

    const branding = await loadBranding();

    expect(branding.appTitle).toBe('某某传说');
    expect(document.title).toBe('某某传说');
    expect(getWorkshopApiBase()).toBe('https://community.example');
    expect(getWorkshopLoginHint()).toBe('需要先加入某个服务器');
  });

  it('branding.json 取不到 → 中性默认值 + 工坊仍是未配置（不阻塞启动）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    const branding = await loadBranding();
    expect(branding).toEqual(NEUTRAL_BRANDING);
    expect(getWorkshopApiBase()).toBe('');
  });
});
