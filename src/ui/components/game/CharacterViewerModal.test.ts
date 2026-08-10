/**
 * CharacterViewerModal — 通栏角色档案
 *
 * 覆盖的都是「只有链路测试才证明得了」的那几条:
 * - 画像位**只认** `立绘bg → 立绘`：只有头像的角色宁可显示首字母（不复用共享链）
 * - 画像取景真的传到了 CharacterPortrait（framing 断在半路的表现是「这张图偶尔没对齐」）
 * - 相册按 (名字, 类型, **变体**) 取图 —— 变体寻址是这次给渲染缝新开的能力
 * - 角色数据换新后弹窗跟着变（不攥旧对象）
 * - 换人时展开态归零
 * - `name=null` → 不渲染；名字查不到人 → 说清楚而不是静默空白
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { reactive } from 'vue';
import { createDefaultCharacterState } from '@engine/types';
import type { AssetMetaRecord, AssetType, CharacterState } from '@engine/types';
import CharacterViewerModal from './CharacterViewerModal.vue';
// 源码断言用（jsdom 不算布局，某些 CSS 不变式只能这么钉）——
// 同 ApiSection.image-endpoint.test.ts 的 `?raw` 先例
import viewerSource from '@ui/components/game/CharacterViewerModal.vue?raw';

let mockGame: any;
let mockAssets: any;

vi.mock('../../stores/game-store', () => ({ useGameStore: () => mockGame }));
vi.mock('../../stores/asset-store', () => ({ useAssetStore: () => mockAssets }));

function makeRow(
  name: string,
  type: AssetType,
  id = 'asset_1',
  over: Partial<AssetMetaRecord> = {},
): AssetMetaRecord {
  return {
    id,
    name,
    type,
    ext: 'png',
    mime: 'image/png',
    bytes: 12,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function makeChar(over: Partial<CharacterState> = {}): CharacterState {
  return createDefaultCharacterState({ name: '维奥莱塔', type: 'npc', ...over });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `reactive` 而不是裸对象: 弹窗每次都从 store 回查角色（刻意不攥旧对象），
  // 而裸对象上的赋值不会让 computed 重算 —— 那会让「跟着数据走」那条断言测的是
  // 一个从未通电的门
  mockGame = reactive({
    characters: [makeChar()] as CharacterState[],
    saveProfile: { affections: {} as Record<string, number> },
    getThoughts: vi.fn(() => ''),
  });
  mockAssets = reactive({
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async (id: string) => `blob:${id}`),
    releaseAssetUrl: vi.fn(),
  });
});

/**
 * 弹窗 Teleport 到 body，所以断言一律在 document 上找 —— 也正因为如此，
 * **必须逐个用例拆干净**: Teleport 的内容不随 wrapper 的 DOM 一起消失，
 * 留着会让下一个用例的 `querySelector` 命中上一个用例的节点。
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function viewer(name: string | null = '维奥莱塔') {
  wrapper?.unmount();
  wrapper = mount(CharacterViewerModal, { props: { name }, attachTo: document.body });
  return wrapper;
}

describe('CharacterViewerModal — 开合', () => {
  it('name=null 时什么都不渲染', async () => {
    viewer(null);
    await flushPromises();
    expect(document.querySelector('.viewer')).toBeNull();
  });

  it('给了名字 → 渲染名字与副标题', async () => {
    mockGame.characters = [
      makeChar({
        race: '人类',
        identity: ['帝王'],
        occupation: ['法则代行者'],
        tierName: '神话',
        level: 24,
      }),
    ];
    viewer();
    await flushPromises();
    expect(document.querySelector('.head-name')?.textContent).toBe('维奥莱塔');
    const meta = document.querySelector('.head-meta')?.textContent ?? '';
    expect(meta).toContain('人类');
    expect(meta).toContain('法则代行者');
    expect(meta).toContain('Lv 24');
  });

  it('★ 名字给了却查不到人（被删 / 改名）→ 说清楚，不是一片空白', async () => {
    mockGame.characters = [];
    viewer('无此人');
    await flushPromises();
    expect(document.querySelector('.viewer-missing')?.textContent).toContain('不在记载');
  });

  it('点 × 抛 close（关不关由调用方决定，本组件不自持 open）', async () => {
    const w = viewer();
    await flushPromises();
    (document.querySelector('.head-close') as HTMLElement).click();
    expect(w.emitted('close')).toHaveLength(1);
  });

  /**
   * ★ 本弹窗走 AppModal 的 `bare` 档（不画页头），而 `bare` **不该**顺手废掉 Esc ——
   * design.md §4.5 要求必须支持。这里从查看器这一端把整条链钉住
   * （AppModal 那一端另有 AppModal.test.ts）。
   */
  it('★ Esc 关闭（bare 档不许把 Esc 一起关掉）', async () => {
    const w = viewer();
    await flushPromises();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(w.emitted('close')).toHaveLength(1);
  });
});

describe('CharacterViewerModal — 画像位', () => {
  it('有立绘 → 铺进画像栏', async () => {
    mockAssets.assets = [makeRow('维奥莱塔', '立绘', 'st')];
    viewer();
    await flushPromises();
    const img = document.querySelector('.viewer-portrait img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBe('blob:st');
  });

  it('立绘与立绘bg都有 → 取立绘bg（这一位的链是 立绘bg → 立绘）', async () => {
    mockAssets.assets = [makeRow('维奥莱塔', '立绘', 'st'), makeRow('维奥莱塔', '立绘bg', 'bg')];
    viewer();
    await flushPromises();
    expect(document.querySelector('.viewer-portrait img')?.getAttribute('src')).toBe('blob:bg');
  });

  /**
   * ★ 这一条是本组件与共享链**刻意的分歧**。两条共享链都以 `头像` 收尾，
   * 复用任何一条都会把一张 1:1 证件照拉满整栏 —— 那看起来像 bug 而不像功能。
   */
  it('★ 只有头像 → 画像栏空着走首字母兜底，绝不把头像拉满整栏', async () => {
    mockAssets.assets = [makeRow('维奥莱塔', '头像', 'av')];
    viewer();
    await flushPromises();
    expect(document.querySelector('.viewer-portrait img')).toBeNull();
    expect(document.querySelector('.portrait-initials')?.textContent).toBe('维奥');
  });

  it('★ 取景真的传到画像组件（framing 断在半路 = 这张图偶尔没对齐）', async () => {
    mockAssets.assets = [
      makeRow('维奥莱塔', '立绘', 'st', { framing: { x: 20, y: 10, scale: 1.5 } }),
    ];
    viewer();
    await flushPromises();
    const style = document.querySelector('.viewer-portrait img')?.getAttribute('style') ?? '';
    expect(style).toContain('20% 10%');
    expect(style).toContain('scale(1.5)');
  });
});

describe('CharacterViewerModal — 档案页', () => {
  it('好感度：标签 + 数值 + 单边比例', async () => {
    mockGame.saveProfile = { affections: { 维奥莱塔: -50 } };
    viewer();
    await flushPromises();
    const value = document.querySelector('.aff-value');
    expect(value?.textContent).toContain('敌意');
    expect(value?.textContent).toContain('-50');
    expect(value?.className).toContain('neg');
    expect(document.querySelector('.aff-fill')?.getAttribute('style')).toContain('scaleX(0.5)');
  });

  it('登神三档全空 → 三个占位格 + 「尚未踏上长阶」', async () => {
    viewer();
    await flushPromises();
    expect(document.querySelectorAll('.asc-track')).toHaveLength(3);
    expect(document.querySelectorAll('.asc-track.filled')).toHaveLength(0);
    expect(document.querySelector('.asc-divine')?.textContent).toContain('尚未踏上长阶');
  });

  it('拿到法则 → 那一档着重，条目点开才显示描述', async () => {
    mockGame.characters = [
      makeChar({
        ascension: {
          enabled: true,
          elements: [],
          authority: [],
          law: [
            {
              name: '镇压与秩序',
              description: '以法则镇压异端',
              effects: ['定身'],
              costDescription: '25% 最大MP',
            },
          ],
          deityPosition: '',
          divineKingdom: { name: '', description: '' },
        },
      }),
    ];
    viewer();
    await flushPromises();
    const filled = document.querySelectorAll('.asc-track.filled');
    expect(filled).toHaveLength(1);
    expect(document.querySelector('.asc-entry-name')?.textContent).toBe('镇压与秩序');
    expect(document.querySelector('.asc-entry-body')).toBeNull();

    (document.querySelector('.asc-entry-head') as HTMLElement).click();
    await flushPromises();
    const body = document.querySelector('.asc-entry-body');
    expect(body?.textContent).toContain('以法则镇压异端');
    expect(body?.textContent).toContain('25% 最大MP');
  });

  it('心里话走 store.getThoughts（唯一真源），没有就整节不出现', async () => {
    viewer();
    await flushPromises();
    expect(document.querySelector('.thoughts')).toBeNull();

    mockGame.getThoughts = vi.fn(() => '多么完美的艺术品');
    viewer();
    await flushPromises();
    expect(document.querySelector('.thoughts')?.textContent).toContain('多么完美的艺术品');
  });
});

describe('CharacterViewerModal — 页签', () => {
  async function open(tabLabel: string, over: Partial<CharacterState> = {}) {
    mockGame.characters = [makeChar(over)];
    const w = viewer();
    await flushPromises();
    const tab = [...document.querySelectorAll('.tab-item')].find(
      (b) => b.textContent?.trim() === tabLabel,
    ) as HTMLElement;
    tab.click();
    await flushPromises();
    return w;
  }

  it('装备页只列穿着的，背包页只列背着的（判据是 equippedSlot）', async () => {
    const inventory = [
      { name: '双头狮鹫帝冕', quantity: 1, equippedSlot: '头部' },
      { name: '古代矿石', quantity: 4 },
    ];
    await open('装备', { inventory });
    expect(document.body.textContent).toContain('双头狮鹫帝冕');
    expect(document.body.textContent).not.toContain('古代矿石');

    await open('背包', { inventory, money: 320 });
    expect(document.body.textContent).toContain('古代矿石');
    expect(document.body.textContent).not.toContain('双头狮鹫帝冕');
    expect(document.querySelector('.purse-value')?.textContent).toContain('320');
  });

  it('状态页：资源条 + 状态效果，点一条才展开详情', async () => {
    await open('状态', {
      statusEffects: [
        {
          name: '秩序庇护',
          description: '受法则庇护',
          category: '增益',
          stacks: 2,
          remainingTime: 3,
          timeUnit: '小时',
          source: '[法则]-维奥莱塔',
          effects: {},
        },
      ],
    });
    expect(document.querySelectorAll('.res-stack .res-track, .res-stack').length).toBeGreaterThan(
      0,
    );
    expect(document.querySelector('.fx-detail')).toBeNull();

    (document.querySelector('.fx-chip-btn') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('.fx-detail')?.textContent).toContain('受法则庇护');
  });

  /**
   * ★ 遗留状态效果整键缺 `remainingTime` / `stacks`（state-manager 自己有一句注释
   * 点名这种行存在）。严格判 `null` 时它会掉进模板串，界面上写的是「undefined小时」。
   */
  it('★ remainingTime / stacks 缺席 → 不许把 undefined 印到界面上', async () => {
    await open('状态', {
      statusEffects: [
        {
          name: '古旧诅咒',
          description: '来历不明',
          category: '减益',
          timeUnit: '小时',
          source: '',
          effects: {},
        } as never,
      ],
    });
    expect(document.querySelector('.fx-time')?.textContent?.trim()).toBe('永久');

    (document.querySelector('.fx-chip-btn') as HTMLElement).click();
    await flushPromises();
    const meta = document.querySelector('.fx-detail-meta')?.textContent ?? '';
    expect(meta).toContain('层数 1');
    expect(meta).toContain('剩余 永久');
    // 整个弹窗里一处都不许出现这个词
    expect(document.querySelector('.viewer')?.textContent).not.toContain('undefined');
  });

  it('技能页空态用装饰空态文案，不是「暂无数据」', async () => {
    await open('技能');
    expect(document.querySelector('.empty-tab')?.textContent).toContain('未修得一技');
  });

  /** ★ 变体寻址：这是本次给渲染缝新开的能力，没有它相册只能显示每个类型的主图 */
  it('★ 相册按 (名字, 类型, 变体) 逐格取图', async () => {
    mockAssets.assets = [
      makeRow('维奥莱塔', '立绘', 'base'),
      makeRow('维奥莱塔', '立绘', 'smile', { variant: '微笑' }),
    ];
    await open('相册');
    const captions = [...document.querySelectorAll('.album-caption')].map((n) => n.textContent);
    expect(captions).toEqual(['立绘', '立绘 · 微笑']);
    const srcs = [...document.querySelectorAll('.album-tile img')].map((n) =>
      n.getAttribute('src'),
    );
    expect(srcs).toEqual(['blob:base', 'blob:smile']);
  });

  it('相册点一格放大、再点收回', async () => {
    mockAssets.assets = [makeRow('维奥莱塔', '立绘', 'base')];
    await open('相册');
    const tile = document.querySelector('.album-tile') as HTMLElement;
    expect(tile.className).not.toContain('focused');
    tile.click();
    await flushPromises();
    expect(document.querySelector('.album-tile')?.className).toContain('focused');
    (document.querySelector('.album-tile') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('.album-tile')?.className).not.toContain('focused');
  });

  it('没有任何素材 → 相册空态', async () => {
    await open('相册');
    expect(document.querySelector('.empty-tab')?.textContent).toContain('尚无留影');
  });
});

describe('CharacterViewerModal — 跟着数据走', () => {
  it('★ 角色数组被整份替换后跟着更新（不攥着旧对象）', async () => {
    mockGame.characters = [makeChar({ hp: 100, maxHp: 100 })];
    viewer();
    await flushPromises();
    const tab = [...document.querySelectorAll('.tab-item')].find(
      (b) => b.textContent?.trim() === '状态',
    ) as HTMLElement;
    tab.click();
    await flushPromises();
    expect(document.body.textContent).toContain('100 / 100');

    // 提交一轮状态：整份换掉数组（同 state-manager）。**弹窗没换人**，
    // 所以这条测的正是"回查"本身，不是换人时的重置
    mockGame.characters = [makeChar({ hp: 40, maxHp: 100 })];
    await flushPromises();
    expect(document.body.textContent).toContain('40 / 100');
  });

  it('★ 换人时展开态与页签归零（否则新角色身上留着上一位的展开区）', async () => {
    mockGame.characters = [makeChar({ name: '甲' }), makeChar({ name: '乙' })];
    const w = viewer('甲');
    await flushPromises();
    const tab = [...document.querySelectorAll('.tab-item')].find(
      (b) => b.textContent?.trim() === '背包',
    ) as HTMLElement;
    tab.click();
    await flushPromises();
    expect(document.querySelector('.purse')).not.toBeNull();

    await w.setProps({ name: '乙' });
    await flushPromises();
    expect(document.querySelector('.purse')).toBeNull();
    expect(document.querySelector('.aff-block')).not.toBeNull();
  });

  it('切页签时相册的放大格收起（回相册不该有一格还摊着）', async () => {
    mockAssets.assets = [makeRow('维奥莱塔', '立绘', 'base')];
    viewer();
    await flushPromises();
    const clickTab = async (label: string) => {
      const b = [...document.querySelectorAll('.viewer .tab-item')].find(
        (n) => n.textContent?.trim() === label,
      ) as HTMLElement;
      b.click();
      await flushPromises();
    };
    await clickTab('相册');
    (document.querySelector('.album-tile') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('.album-tile.focused')).not.toBeNull();

    await clickTab('档案');
    await clickTab('相册');
    expect(document.querySelector('.album-tile.focused')).toBeNull();
  });
});

describe('CharacterViewerModal — 无障碍', () => {
  /**
   * ★ `.viewer-scroll` 是弹窗里唯一的滚动容器（外面几层全 `overflow: hidden`），
   * 而某些页签下它里面一个可聚焦元素都没有（没登神条目、没心里话、只有一段长背景）。
   * 没有 `tabindex` 的话那段文字只有鼠标读得到。
   */
  it('★ 滚动区可聚焦且带 role/label —— 否则键盘用户读不到长背景故事', async () => {
    mockGame.characters = [makeChar({ background: '边'.repeat(800) })];
    viewer();
    await flushPromises();
    const scroll = document.querySelector('.viewer-scroll') as HTMLElement;
    expect(scroll.getAttribute('tabindex')).toBe('0');
    expect(scroll.getAttribute('role')).toBe('region');
    expect(scroll.getAttribute('aria-label')).toContain('维奥莱塔');
  });

  it('展开控件报 aria-expanded（登神条目 / 状态效果）', async () => {
    mockGame.characters = [
      makeChar({
        ascension: {
          enabled: true,
          elements: [],
          authority: [],
          law: [{ name: '秩序', description: 'x', effects: [], costDescription: '' }],
          deityPosition: '',
          divineKingdom: { name: '', description: '' },
        },
      }),
    ];
    viewer();
    await flushPromises();
    const head = document.querySelector('.asc-entry-head') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    await flushPromises();
    expect(document.querySelector('.asc-entry-head')?.getAttribute('aria-expanded')).toBe('true');
  });

  /**
   * ★ jsdom 不算布局，所以这条只能断言源码 —— 但它挡的是一次真机逮到的缺陷:
   * `.viewer-body` 少了 `min-height: 0` 时，窄屏（竖向叠栏）下本栏会撑到内容的自然
   * 高度，把 `.viewer-scroll` 的内部滚动整个作废，弹窗底部内容被切掉且滚不到。
   * 同 ApiSection.image-endpoint.test.ts 的源码断言先例。
   */
  it('★ .viewer-body 保留 min-height: 0（窄屏内部滚动的命门，jsdom 测不到）', () => {
    const rule = viewerSource.slice(viewerSource.indexOf('.viewer-body {'));
    expect(rule.slice(0, rule.indexOf('}'))).toContain('min-height: 0');
  });
});
