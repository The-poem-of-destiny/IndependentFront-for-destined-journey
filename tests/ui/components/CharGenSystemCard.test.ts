/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CharGenSystemCard from '../../../src/ui/components/game/cards/CharGenSystemCard.vue';
import type { CharGenSystemEvent } from '@engine/types';

describe('CharGenSystemCard', () => {
  const mockFull: CharGenSystemEvent = {
    type: 'char_gen',
    characterName: '艾琳·霜语',
    race: '极北精灵',
    tier: 3,
    narrative: '[新角色] 艾琳·霜语',
    details: {
      name: '艾琳·霜语',
      race: '极北精灵',
      gender: '女',
      faction: '诺斯加德联盟',
      tier: 3,
      level: 12,
      attributes: { str: 5, dex: 8, con: 4, int: 9, spi: 10 },
      identity: ['霜语者', '冰原巡行者', '龙族后裔'],
      occupation: ['元素法师', '符文工匠'],
      background: '艾琳出身于极北冰原的霜语氏族，自幼便能听见寒风中传来的古老低语...',
      personality: '冷静理智，善于察言观色，对陌生人有戒心但一旦信任便极为忠诚',
      appearance: '银白长发及腰，冰蓝色瞳孔，皮肤苍白如雪，身材纤细修长',
      clothing: '身着冰蓝色法师长袍，腰间挂满符文水晶，胸前佩戴霜语氏族徽章',
      likes: '冰霜魔法、古老符文、极寒荒原的风雪',
      ascension: {
        enabled: true,
        path: '冰霜之道 — 极寒主宰',
        description: '掌控绝对零度之力',
        deityPosition: '冰霜之神',
        divineKingdom: {
          name: '永冻圣域',
          description:
            '一片永远冰封的极寒领域，寒风中回荡着古老的霜语，冰晶构筑的宫殿在极光下熠熠生辉',
        },
        elements: [
          // 要素/权能的 effects 是 string[]（char-gen-agent 按行切 <element> 正文），不是 name→desc 表
          {
            name: '极寒元素',
            description: '纯粹的冰霜之力凝聚体，可冻结万物',
            effects: ['冰霜伤害+30%', '冻结概率+15%'],
          },
          { name: '凛冬之风', description: '来自极北荒原的刺骨寒风', effects: ['速度降低20%'] },
        ],
        authorities: [
          {
            name: '冰封纪元',
            description: '将一片区域瞬间冻结，进入冰河时代',
            effects: ['范围冻结100m', '持续时间30s'],
            costDescription: '消耗100 MP，冷却60秒',
          },
        ],
        laws: [
          {
            name: '绝对零度法则',
            description: '触及绝对零度边界的禁忌之力',
            passiveEffects: ['冰霜抗性+50%', '冻结免疫'],
            activeEffects: ['绝对零度爆发'],
            costDescription: '每次触发消耗10% MP',
          },
        ],
      },
      skills: [
        {
          name: '冰霜箭矢',
          description: '凝聚水汽形成冰箭，造成冰霜伤害并降低目标速度。',
          type: 'active',
          cost: { type: 'MP', amount: 15 },
          cooldown: 2,
          effects: { 伤害: '80', 减速: '30%' },
        },
        {
          name: '寒冰护体',
          description: '被动凝聚寒气形成护盾，减免20%伤害并反弹冰霜。',
          type: 'passive',
        },
      ],
      equipment: [
        {
          slot: '主手',
          name: '霜语法杖',
          description: '千年冰晶法杖',
          stats: { int: 4, spi: 3 },
          quality: '稀有',
          effects: { 冰抗: '+20%' },
        },
      ],
      inventory: [
        {
          name: '冰霜符文石',
          description: '刻有古老霜语的符文石，蕴含极寒之力',
          quantity: 3,
          type: '道具',
          rarity: '稀有',
        },
        { name: '霜语族徽', description: '霜语氏族的身份象征', quantity: 1, type: '特殊物品' },
      ],
    },
  };

  const mockMinimal: CharGenSystemEvent = {
    type: 'char_gen',
    characterName: '无名旅者',
    race: '人类',
    tier: 1,
    narrative: '[新角色]',
    details: {
      name: '无名旅者',
      race: '人类',
      gender: '男',
      tier: 1,
      level: 1,
      attributes: { str: 3, dex: 3, con: 3, int: 3, spi: 3 },
      identity: [],
      occupation: [],
      background: '',
      appearance: '',
      clothing: '',
      personality: '',
      likes: '',
      ascension: {
        enabled: false,
        path: '',
        description: '',
        elements: [],
        authorities: [],
        laws: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      skills: [],
      equipment: [],
      inventory: [],
    },
  };

  const mockProfileOnly: CharGenSystemEvent = {
    type: 'char_gen',
    characterName: '测试角色',
    race: '人类',
    tier: 1,
    narrative: '[新角色]',
    details: {
      name: '测试角色',
      race: '人类',
      gender: '男',
      tier: 1,
      level: 1,
      attributes: { str: 3, dex: 3, con: 3, int: 3, spi: 3 },
      identity: [],
      occupation: [],
      background: '',
      personality: '开朗热情',
      appearance: '高大魁梧',
      clothing: '',
      likes: '',
      ascension: {
        enabled: false,
        path: '',
        description: '',
        elements: [],
        authorities: [],
        laws: [],
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      skills: [],
      equipment: [],
      inventory: [],
    },
  };

  // ── 基本渲染 ──
  it('renders name and race', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('艾琳·霜语');
    expect(w.text()).toContain('极北精灵');
  });
  it('renders level badge', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('Lv.12');
  });
  it('renders tier badge', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('T3');
  });

  // ── 收起按钮 ──
  it('starts expanded (body visible)', () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.find('.ci-body').isVisible()).toBe(true);
  });
  it('click collapse button emits collapse', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    await w.find('.ci-collapse-btn').trigger('click');
    expect(w.emitted('collapse')).toBeTruthy();
  });

  // ── 展开内容 ──
  it('renders all 5 attributes', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('5'); // STR
    expect(w.text()).toContain('10'); // SPI
  });
  it('renders identity chips', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('霜语者');
  });
  it('renders faction', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('诺斯加德联盟');
  });
  it('renders background excerpt', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('霜语氏族');
  });
  it('renders skill names and types', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('冰霜箭矢');
    expect(w.text()).toContain('主动');
    expect(w.text()).toContain('寒冰护体');
    expect(w.text()).toContain('被动');
  });
  it('renders equipment slot and name', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('主手');
    expect(w.text()).toContain('霜语法杖');
  });
  it('renders ascension when enabled', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('登神长阶');
    expect(w.text()).toContain('冰霜之道');
  });

  // ── 防御性渲染 ──
  it('hides background when empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } });
    const bg = w.find('.ci-bg');
    expect(bg.exists()).toBe(false);
  });
  it('hides skills section when empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } });
    expect(w.text()).not.toContain('技能');
  });
  it('hides ascension when disabled', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } });
    expect(w.text()).not.toContain('登神长阶');
  });

  // ── Profile grid ──
  it('renders personality in profile grid', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('性格');
    expect(w.text()).toContain('冷静理智');
  });
  it('renders appearance', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('外貌特质');
    expect(w.text()).toContain('银白长发');
  });
  it('renders likes', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('喜爱');
    expect(w.text()).toContain('冰霜魔法');
  });
  it('renders clothing', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('衣物装饰');
    expect(w.text()).toContain('冰蓝色法师长袍');
  });
  it('hides profile grid when all fields empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } });
    expect(w.text()).not.toContain('性格');
    expect(w.text()).not.toContain('外貌特质');
    expect(w.text()).not.toContain('喜爱');
    expect(w.text()).not.toContain('衣物装饰');
  });
  it('renders only non-empty profile cells', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockProfileOnly } });
    // personality and appearance should render
    expect(w.text()).toContain('性格');
    expect(w.text()).toContain('外貌特质');
    // clothing and likes should not render
    expect(w.text()).not.toContain('喜爱');
    expect(w.text()).not.toContain('衣物装饰');
  });

  // ── Inventory ──
  it('renders inventory items grouped by type', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('持有物');
    expect(w.text()).toContain('冰霜符文石');
    expect(w.text()).toContain('x3');
    expect(w.text()).toContain('霜语族徽');
    expect(w.text()).toContain('x1');
  });
  it('hides inventory when empty', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockMinimal } });
    expect(w.text()).not.toContain('持有物');
  });

  // ── Ascension full ──
  it('renders ascension deity position', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('冰霜之神');
  });
  it('renders ascension divine kingdom', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('永冻圣域');
    expect(w.text()).toContain('永远冰封');
  });
  it('renders ascension elements', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('要素');
    expect(w.text()).toContain('极寒元素');
    expect(w.text()).toContain('凛冬之风');
  });
  // 回归：effects 是 string[]，逐条渲染原文；旧模板按 (v, k) 遍历，会把数组下标 0/1 当词条名画出来
  it('renders element effects as plain lines, not indexed pairs', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    const pills = w.findAll('.ci-effect-pill').map((p) => p.text());
    expect(pills).toContain('冰霜伤害+30%');
    expect(pills.some((t) => /^\d+\s/.test(t))).toBe(false);
  });
  it('renders ascension authorities', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('权能');
    expect(w.text()).toContain('冰封纪元');
    expect(w.text()).toContain('消耗100 MP');
    expect(w.findAll('.ci-effect-pill').map((p) => p.text())).toContain('范围冻结100m');
  });
  it('renders ascension laws with passive and active effects', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('法则');
    expect(w.text()).toContain('绝对零度法则');
    expect(w.text()).toContain('冰霜抗性+50%');
    expect(w.text()).toContain('绝对零度爆发');
  });

  // ── Skill effects ──
  it('renders skill effects', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('伤害');
    expect(w.text()).toContain('80');
    expect(w.text()).toContain('减速');
    expect(w.text()).toContain('30%');
  });

  // ── Equipment ──
  it('renders equipment quality subtitle', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    // "稀有" appears twice: once as quality class, once as subtitle text
    const subtitles = w.findAll('.ci-item-subtitle');
    expect(subtitles.length).toBeGreaterThanOrEqual(1);
    // The equipment subtitle should contain '稀有'
    const eqSubtitle = subtitles.filter((s) => s.text() === '稀有');
    expect(eqSubtitle.length).toBeGreaterThanOrEqual(1);
  });
  it('renders equipment effects', async () => {
    const w = mount(CharGenSystemCard, { props: { event: mockFull } });
    expect(w.text()).toContain('冰抗');
    expect(w.text()).toContain('+20%');
  });
});
