/**
 * ejs-capabilities.ts 测试 —— 引擎侧能力面（能力面 §3.3-§3.12，切片 T4+T5）
 *
 * 三条贯穿断言（每个 namespace 都验）：
 * 1. **永不抛**（P3）：缺参 / 越界 / 不可见一律安全默认值
 * 2. **只读即孤儿**（P4）：改返回值不回流引擎
 * 3. **写只有两个口**（P2）：只有 `local` 能写，且落在 vars 草稿的命名空间里
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildEjsCapabilities,
  LOCAL_ROOT,
  LOCAL_KEY_MAX_BYTES,
  NOTIFY_PER_PASS,
  LORE_GET_PER_ENTRY,
  EJS_SURFACE_VERSION,
  type EjsCapabilityInput,
} from './ejs-capabilities';
import {
  EJS_ALIAS_SYMBOLS,
  EJS_FMT_NAMES,
  EJS_RNG_NAMES,
  EJS_SURFACE,
  EJS_TOP_LEVEL_SYMBOLS,
} from './ejs-capabilities';
import { createDefaultCharacterState, createDefaultQuest, type Quest } from './types';
import type { GameTime } from './time-system';

const TIME: GameTime = {
  era: '复兴纪元',
  year: 1,
  month: 5,
  day: 24,
  weekday: 1,
  hour: 15,
  minute: 30,
};

function build(input: EjsCapabilityInput = {}, vars: Record<string, any> = {}, historyText = '') {
  return { caps: buildEjsCapabilities(vars, historyText, input), vars };
}

// ═══════════════════════════════════════════════════════════
// chat
// ═══════════════════════════════════════════════════════════

describe('chat（§3.8）', () => {
  const history = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2 咖啡馆' },
    { role: 'assistant', content: 'a2' },
  ];

  it('last / at 支持负数下标（-1 = 最新）', () => {
    const { caps } = build({ history });
    expect(caps.chat.last()).toBe('a2');
    expect(caps.chat.last('user')).toBe('u2 咖啡馆');
    expect(caps.chat.last('assistant')).toBe('a2');
    expect(caps.chat.at(0)).toBe('u1');
    expect(caps.chat.at(-2)).toBe('u2 咖啡馆');
  });

  it('slice 取区间；role 过滤后再切', () => {
    const { caps } = build({ history });
    expect(caps.chat.slice(0, 2)).toEqual(['u1', 'a1']);
    expect(caps.chat.slice(0, 2, 'user')).toEqual(['u1', 'u2 咖啡馆']);
  });

  it('match 支持字符串与正则；g/y 标志被剥（连续 test 不漂移）', () => {
    const { caps } = build({ history }, {}, 'u1\na1\nu2 咖啡馆\na2');
    expect(caps.chat.match('咖啡馆')).toBe(true);
    const re = /咖啡馆/g;
    expect(caps.chat.match(re)).toBe(true);
    expect(caps.chat.match(re)).toBe(true); // 第二次仍然 true
    expect(caps.chat.match(/不存在/)).toBe(false);
    expect(caps.chat.match(123)).toBe(false);
  });

  it('越界 / 无历史 → 空串空表，不抛（P3）', () => {
    const { caps } = build({});
    expect(caps.chat.last()).toBe('');
    expect(caps.chat.at(99)).toBe('');
    expect(caps.chat.at(NaN)).toBe('');
    expect(caps.chat.slice(0, 5)).toEqual([]);
    expect(caps.chat.text()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// char
// ═══════════════════════════════════════════════════════════

describe('char（§3.4）', () => {
  const player = createDefaultCharacterState({ id: 'p1', type: 'player', name: '莉泽尔', hp: 70 });
  const ally = createDefaultCharacterState({ id: 'a1', type: 'npc', name: '艾波丽斯', hp: 40 });
  const downed = createDefaultCharacterState({ id: 'd1', type: 'npc', name: '倒地者', hp: 0 });
  const input: EjsCapabilityInput = {
    characters: [player, ally, downed],
    // 🔴 好感表按**名字**索引（`SaveProfile.affections` 的真实形状）；早先这里按 id 建 fixture，
    //    把「投影按 c.id 取值」的 bug 一起盖住了
    affections: { 艾波丽斯: 75, 倒地者: -80 },
  };

  it('player / get / has 按名解析', () => {
    const { caps } = build(input);
    expect(caps.char.player()?.名字).toBe('莉泽尔');
    expect(caps.char.get('艾波丽斯')?.生命值).toBe(40);
    expect(caps.char.has('艾波丽斯')).toBe(true);
    expect(caps.char.has('不存在的人')).toBe(false);
  });

  it('present 只给还站着的；all 给全部', () => {
    const { caps } = build(input);
    expect(caps.char.present().map((c) => c.名字)).toEqual(['莉泽尔', '艾波丽斯']);
    expect(caps.char.all()).toHaveLength(3);
  });

  it('affection / affectionLabel 按名字索引好感表；查不到的人给 0 与空串，不抛', () => {
    const { caps } = build(input);
    expect(caps.char.affection('艾波丽斯')).toBe(75);
    expect(caps.char.affectionLabel('艾波丽斯')).toBeTruthy();
    expect(caps.char.affection('倒地者')).toBe(-80);
    // id 键不该被当好感表键用（真实存档里没有这种键）
    expect(build({ ...input, affections: { a1: 75 } }).caps.char.affection('艾波丽斯')).toBe(0);
    expect(caps.char.affection('不存在')).toBe(0);
    expect(caps.char.affectionLabel('不存在')).toBe('');
    expect(caps.char.get('')).toBeNull();
    expect(caps.char.get(null as unknown as string)).toBeNull();
  });

  it('只读孤儿：改返回值不回流引擎（P4）', () => {
    const { caps } = build(input);
    const c = caps.char.get('艾波丽斯')!;
    c.生命值 = 1;
    c.身份.push('脏数据');
    expect(ally.hp).toBe(40);
    expect(ally.identity).not.toContain('脏数据');
  });

  it('无角色输入 → player() 为 null，其余空表', () => {
    const { caps } = build({});
    expect(caps.char.player()).toBeNull();
    expect(caps.char.all()).toEqual([]);
    expect(caps.char.present()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// world
// ═══════════════════════════════════════════════════════════

describe('world（§3.5）', () => {
  it('时间 / 时间详情 / 回合 / 地点', () => {
    const player = createDefaultCharacterState({ id: 'p1', type: 'player', location: '晨曦镇' });
    const { caps } = build({ gameTime: TIME, turn: 12, weather: '小雨', characters: [player] });
    expect(caps.world.时间).toContain('复兴纪元');
    expect(caps.world.时间详情!.时).toBe(15);
    expect(caps.world.时间详情!.时段).toBeTruthy();
    expect(caps.world.回合).toBe(12);
    expect(caps.world.天气).toBe('小雨');
    expect(caps.world.地点).toBe('晨曦镇');
    expect(caps.world.isDaytime()).toBe(true);
  });

  it('全缺省 → 空串 / 0 / null，不抛', () => {
    const { caps } = build({});
    expect(caps.world.时间).toBe('');
    expect(caps.world.时间详情).toBeNull();
    expect(caps.world.回合).toBe(0);
    expect(caps.world.地点).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// quest
// ═══════════════════════════════════════════════════════════

describe('quest（§3.6）', () => {
  // 真 `Quest` 形状（types.ts）：detail / objective / reward 都是**单数串**
  const quests: Record<string, Quest> = {
    寻找失落的琴弦: {
      ...createDefaultQuest(),
      status: '进行中',
      priority: '高',
      progress: '已问过三个乐师',
      detail: '找回被拆走的第七根琴弦',
      objective: '找到琴弦',
      reward: '晨曦镇声望 + 一枚旧银币',
    },
    旧日之约: { ...createDefaultQuest(), status: '已完成', detail: '完成了' },
  };

  it('all / active / get / has / focus', () => {
    const { caps } = build({ quests, focusQuest: '寻找失落的琴弦' });
    expect(caps.quest.all()).toHaveLength(2);
    expect(caps.quest.active().map((q) => q.名字)).toEqual(['寻找失落的琴弦']);
    expect(caps.quest.get('旧日之约')?.状态).toBe('已完成');
    expect(caps.quest.has('旧日之约')).toBe(true);
    expect(caps.quest.has('没有这个')).toBe(false);
    expect(caps.quest.focus()?.名字).toBe('寻找失落的琴弦');
  });

  it('投影读的是 Quest 真字段（detail/objective/reward/priority），单数串包成数组', () => {
    const { caps } = build({ quests });
    const q = caps.quest.get('寻找失落的琴弦')!;
    expect(q.描述).toBe('找回被拆走的第七根琴弦');
    expect(q.目标).toEqual(['找到琴弦']);
    expect(q.奖励).toEqual(['晨曦镇声望 + 一枚旧银币']);
    expect(q.进度).toBe('已问过三个乐师');
    expect(q.关注度).toBe('高');
  });

  it('空的 objective / reward → 空表（不是 [""]）', () => {
    const { caps } = build({ quests });
    const q = caps.quest.get('旧日之约')!;
    expect(q.目标).toEqual([]);
    expect(q.奖励).toEqual([]);
  });

  it('无任务表 → 空表 / null，不抛', () => {
    const { caps } = build({});
    expect(caps.quest.all()).toEqual([]);
    expect(caps.quest.get('x')).toBeNull();
    expect(caps.quest.focus()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// lore
// ═══════════════════════════════════════════════════════════

describe('lore（§3.7）', () => {
  const lore = {
    get: (entryName: string, bookName?: string) =>
      entryName === '剧情设计' && (bookName === undefined || bookName === '维拉核心')
        ? '设计正文'
        : null,
    list: (bookName: string) => (bookName === '维拉核心' ? ['剧情设计'] : []),
  };

  it('两种调用形态：(条目名) 与 (书名, 条目名)', () => {
    const { caps } = build({ lore });
    expect(caps.lore.get('剧情设计')).toBe('设计正文');
    expect(caps.lore.get('维拉核心', '剧情设计')).toBe('设计正文');
    expect(caps.lore.get('别的书', '剧情设计')).toBe('');
  });

  it('不可见 / 无 lookup → 空串，让内容走自己的降级分支', () => {
    expect(build({ lore }).caps.lore.get('不存在')).toBe('');
    expect(build({}).caps.lore.get('剧情设计')).toBe('');
    expect(build({}).caps.lore.list('任何书')).toEqual([]);
  });

  it(`预算：每条目最多 ${LORE_GET_PER_ENTRY} 次 get，超出静默返回空`, () => {
    const { caps } = build({ lore });
    for (let i = 0; i < LORE_GET_PER_ENTRY; i++) {
      expect(caps.lore.get('剧情设计')).toBe('设计正文');
    }
    expect(caps.lore.get('剧情设计'), '第 9 次应被预算拦下').toBe('');
  });

  it('has 不吃预算（它是判断不是注入）', () => {
    const { caps } = build({ lore });
    for (let i = 0; i < 50; i++) expect(caps.lore.has('剧情设计')).toBe(true);
    expect(caps.lore.get('剧情设计')).toBe('设计正文');
  });
});

// ═══════════════════════════════════════════════════════════
// local
// ═══════════════════════════════════════════════════════════

describe('local（§3.3）', () => {
  it('读写落在 vars._local.<projectId> 下（随快照回退天然覆盖）', () => {
    const { caps, vars } = build({ projectId: 'proj-a' });
    caps.local.set('展示模式', '简洁');
    expect(vars[LOCAL_ROOT]['proj-a']['展示模式']).toBe('简洁');
    expect(caps.local.get('展示模式')).toBe('简洁');
    expect(caps.local.has('展示模式')).toBe(true);
    expect(caps.local.keys()).toEqual(['展示模式']);
    caps.local.remove('展示模式');
    expect(caps.local.has('展示模式')).toBe(false);
  });

  it('缺失键返回 fallback ?? null', () => {
    const { caps } = build({});
    expect(caps.local.get('没有')).toBeNull();
    expect(caps.local.get('没有', '默认值')).toBe('默认值');
  });

  it('项目之间互不可见（刻意的隔离）', () => {
    const vars: Record<string, any> = {};
    const a = buildEjsCapabilities(vars, '', { projectId: 'proj-a' });
    const b = buildEjsCapabilities(vars, '', { projectId: 'proj-b' });
    a.local.set('key', 'A 的值');
    expect(b.local.get('key')).toBeNull();
    expect(b.local.keys()).toEqual([]);
  });

  it('危险键被拒（原型污染）', () => {
    const { caps, vars } = build({});
    caps.local.set('__proto__', { polluted: true });
    caps.local.set('constructor', 1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(caps.local.keys()).toEqual([]);
    expect(vars[LOCAL_ROOT]).toBeUndefined();
  });

  it('单键超限 → 静默失败 + 日志（不抛）', () => {
    const log = vi.fn();
    const { caps } = build({ log });
    caps.local.set('大', 'x'.repeat(LOCAL_KEY_MAX_BYTES + 100));
    expect(caps.local.has('大')).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it('不可序列化的值被拒（契约是 JSON-ish）', () => {
    const { caps } = build({});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    caps.local.set('环', cyclic);
    expect(caps.local.has('环')).toBe(false);
  });

  it('存的是深拷贝：之后改原对象不影响已存值', () => {
    const { caps } = build({});
    const obj = { n: 1 };
    caps.local.set('o', obj);
    obj.n = 999;
    expect((caps.local.get('o') as { n: number }).n).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// localSeed —— 引擎供的只读回落层（地图 v1 §8.1-2 的 runtime_geo_compact_data）
// ═══════════════════════════════════════════════════════════

describe('local 的只读种子（localSeed）', () => {
  const seed = { runtime_geo_compact_data: { places: [{ id: 'p1' }], edges: [] } };

  it('读得到、has 为真、进 keys —— 但**一个字节都不落 vars 草稿**', () => {
    const { caps, vars } = build({ localSeed: seed });
    expect(caps.local.get('runtime_geo_compact_data')).toEqual(seed.runtime_geo_compact_data);
    expect(caps.local.has('runtime_geo_compact_data')).toBe(true);
    expect(caps.local.keys()).toEqual(['runtime_geo_compact_data']);
    // 🔴 这一条是这个特性存在的**理由**：种子若落进 vars，就会经 ejs-vars-diff
    // 每回合把一份可重算的派生数据写进存档变量（还会顶到 local 的项目配额）
    expect(vars[LOCAL_ROOT]).toBeUndefined();
  });

  it('是只读孤儿：改返回值不影响下一次读，也改不到宿主那份输入', () => {
    const { caps } = build({ localSeed: seed });
    const got = caps.local.get('runtime_geo_compact_data') as { places: unknown[] };
    got.places.push({ id: '偷偷加的' });
    expect(
      (caps.local.get('runtime_geo_compact_data') as { places: unknown[] }).places,
    ).toHaveLength(1);
    expect(seed.runtime_geo_compact_data.places).toHaveLength(1);
  });

  it('同名 set 就地遮蔽（桶 > 种子）；remove 只删自己写的那份，种子照旧读得到', () => {
    const { caps } = build({ localSeed: seed });
    caps.local.set('runtime_geo_compact_data', '我自己的值');
    expect(caps.local.get('runtime_geo_compact_data')).toBe('我自己的值');
    // 遮蔽后不该在 keys 里出现两次
    expect(caps.local.keys()).toEqual(['runtime_geo_compact_data']);
    caps.local.remove('runtime_geo_compact_data');
    expect(caps.local.get('runtime_geo_compact_data')).toEqual(seed.runtime_geo_compact_data);
  });

  it('种子里没有的键仍走 fallback ?? null（种子不是「什么都有」）', () => {
    const { caps } = build({ localSeed: seed });
    expect(caps.local.get('别的键')).toBeNull();
    expect(caps.local.get('别的键', 7)).toBe(7);
  });

  it('危险键即使出现在种子里也读不到（护栏在 safeKey，不在种子）', () => {
    const { caps } = build({ localSeed: { __proto__: { polluted: true } } as never });
    expect(caps.local.get('__proto__')).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// $map（地图 v1 §5）
// ═══════════════════════════════════════════════════════════

describe('$map（地图 v1 §5）', () => {
  const snapshot = {
    current: {
      name: '白曜城',
      terrain: '平原',
      water: null,
      impassable: false,
      midTierName: '云息盆地',
      countryName: '诺斯加德联盟',
    },
    neighbors: [
      {
        name: '雾凇海岸',
        terrain: '苔原',
        dir: 'N' as const,
        water: null,
        impassable: false,
        ownerName: null,
      },
    ],
    journey: { toName: '铁炉堡', nextName: '驰原省边墙', remainingDays: 3 },
    weatherLabel: '小雪',
    discontinuity: null,
  };

  it('没有快照（空包 / 未落位 / 老调用方）→ 空值而不是 undefined', () => {
    // 🔴 这条钉的是世界书 EJS 的写法：`if ($map.currentTile)` 必须能直接写，
    //    不必先判 `typeof $map`（各格 undefined 会让作者去写防御性 try/catch）
    const { caps } = build({});
    expect(caps.$map.currentTile).toBeNull();
    expect(caps.$map.neighbors).toEqual([]);
    expect(caps.$map.weatherNow).toBeNull();
    expect(caps.$map.journey).toBeNull();
    expect(caps.$map.discontinuity).toBeNull();
  });

  it('有快照 → 逐格转发（weatherLabel → weatherNow，current → currentTile）', () => {
    const { caps } = build({ mapSnapshot: snapshot });
    expect(caps.$map.currentTile?.name).toBe('白曜城');
    expect(caps.$map.currentTile?.countryName).toBe('诺斯加德联盟');
    expect(caps.$map.neighbors).toHaveLength(1);
    expect(caps.$map.neighbors[0].dir).toBe('N');
    expect(caps.$map.weatherNow).toBe('小雪');
    expect(caps.$map.journey?.remainingDays).toBe(3);
  });

  it('只读孤儿：改返回值不回流宿主那份快照', () => {
    const { caps } = build({ mapSnapshot: snapshot });
    caps.$map.neighbors.push({ ...snapshot.neighbors[0], name: '凭空多出来的' });
    caps.$map.currentTile!.name = '改过的名字';
    expect(snapshot.neighbors).toHaveLength(1);
    expect(snapshot.current.name).toBe('白曜城');
  });

  it('🔴 整面没有函数 —— 函数过不了 JSON 编组，会让两个后端分叉（world.isDaytime 的教训）', () => {
    const { caps } = build({ mapSnapshot: snapshot });
    for (const [k, v] of Object.entries(caps.$map)) {
      expect(typeof v, `$map.${k} 是函数`).not.toBe('function');
    }
    // 且整面能原样过 JSON（QuickJS 后端就是这么送过去的）
    expect(JSON.parse(JSON.stringify(caps.$map)).currentTile.name).toBe('白曜城');
  });

  // ── 地块动态（v1.2 / ADR-33 §5）────────────────────────────────────────
  // 🔴 快照那侧缺席是**没有这个键**（省提示词字节），这一面一律是**空值** ——
  //    世界书条目要能直接写 `for (const s of $map.statuses)` 而不必先判 typeof。

  const dynamicSnapshot = {
    ...snapshot,
    current: {
      ...snapshot.current,
      development: { level: 3, levelName: '城镇', progress: 42 },
      statuses: [{ title: '洪水', description: '水漫低地', permanent: false, remainingDays: 12 }],
      buildings: {
        slots: 3,
        entries: [{ name: '磨坊', ownerFlavor: '镇长', playerOwned: false }],
        freeSlots: 2,
      },
      history: [{ day: 7, kind: 'built' as const, building: '磨坊' }],
    },
    developmentLevels: ['村落', '集镇', '城镇'],
  };

  it('v1.2 四格 + 档名表逐格转发（都取自当前地块行）', () => {
    const { caps } = build({ mapSnapshot: dynamicSnapshot });

    expect(caps.$map.development).toEqual({ level: 3, levelName: '城镇', progress: 42 });
    expect(caps.$map.statuses[0].remainingDays).toBe(12);
    expect(caps.$map.buildings?.freeSlots).toBe(2);
    expect(caps.$map.history[0]).toEqual({ day: 7, kind: 'built', building: '磨坊' });
    expect(caps.$map.developmentLevels).toEqual(['村落', '集镇', '城镇']);
  });

  it('🔴 缺席时是空值不是 undefined（`if ($map.development)` 必须能直接写）', () => {
    const { caps } = build({ mapSnapshot: snapshot });

    expect(caps.$map.development).toBeNull();
    expect(caps.$map.buildings).toBeNull();
    expect(caps.$map.statuses).toEqual([]);
    expect(caps.$map.history).toEqual([]);
    expect(caps.$map.developmentLevels).toEqual([]);

    const empty = build({}).caps;
    expect(empty.$map.development).toBeNull();
    expect(empty.$map.statuses).toEqual([]);
  });

  it('只读孤儿：改这四格不回流宿主那份快照', () => {
    const { caps } = build({ mapSnapshot: dynamicSnapshot });
    caps.$map.statuses.push({
      title: '凭空多出来的',
      description: '',
      permanent: true,
      remainingDays: null,
    });
    caps.$map.history[0].building = '改过的';
    caps.$map.developmentLevels[0] = '改过的';

    expect(dynamicSnapshot.current.statuses).toHaveLength(1);
    expect(dynamicSnapshot.current.history[0].building).toBe('磨坊');
    expect(dynamicSnapshot.developmentLevels[0]).toBe('村落');
  });
});

// ═══════════════════════════════════════════════════════════
// ui
// ═══════════════════════════════════════════════════════════

describe('ui（§3.11）', () => {
  it(`notify 限频 ${NOTIFY_PER_PASS} 条 + 同文去重`, () => {
    const notify = vi.fn();
    const { caps } = build({ notify });
    caps.ui.notify('第一条');
    caps.ui.notify('第一条'); // 去重
    caps.ui.notify('第二条');
    caps.ui.notify('第三条');
    caps.ui.notify('第四条'); // 超限
    expect(notify).toHaveBeenCalledTimes(NOTIFY_PER_PASS);
  });

  it('空消息不发；宿主出口抛错不连累条目', () => {
    const notify = vi.fn(() => {
      throw new Error('toast 挂了');
    });
    const { caps } = build({ notify });
    caps.ui.notify('   ');
    expect(notify).not.toHaveBeenCalled();
    expect(() => caps.ui.notify('正常')).not.toThrow();
  });

  it('无出口时静默丢弃，不抛', () => {
    const { caps } = build({});
    expect(() => {
      caps.ui.notify('没人听');
      caps.ui.log('也没人听');
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// engine
// ═══════════════════════════════════════════════════════════

describe('engine（§3.12）', () => {
  it('version / name / has', () => {
    const { caps } = build({});
    expect(caps.engine.name).toBe('poem-of-destiny');
    expect(caps.engine.version).toBe(EJS_SURFACE_VERSION);
    expect(caps.engine.has('lore.get')).toBe(true);
    expect(caps.engine.has('stats.主角.背包')).toBe(true);
    expect(caps.engine.has('完全不存在的能力')).toBe(false);
    // Q-09: has 的签名收成 string 之后，这一条改成显式的"脏输入"而不是类型漏洞
    expect(caps.engine.has(undefined as unknown as string)).toBe(false);
  });

  it('engineVersion 可被调用方覆盖', () => {
    const { caps } = build({ engineVersion: '9.9.9' });
    expect(caps.engine.version).toBe('9.9.9');
  });
});

// ═══════════════════════════════════════════════════════════
// 能力面唯一真源（Q-09）
// ═══════════════════════════════════════════════════════════

describe('EJS_SURFACE —— engine.has 不许再说谎', () => {
  const caps = () => build({ gameTime: TIME }).caps;

  it('每个 namespace 的每个成员，engine.has 都必须认得', () => {
    const has = caps().engine.has;
    for (const [ns, members] of Object.entries(EJS_SURFACE.namespaces)) {
      expect(has(ns), `engine.has('${ns}') 为假`).toBe(true);
      for (const m of members as readonly string[]) {
        expect(has(`${ns}.${m}`), `engine.has('${ns}.${m}') 为假`).toBe(true);
      }
    }
  });

  it('🔴 world.isDaytime 与 engine.name —— 两条曾经漏在表外的真实能力', () => {
    // 创作者写 engine.has('world.isDaytime') 曾拿到 false，
    // 于是他的守卫分支反过来禁用了一个可用能力，且完全无声。
    const c = caps();
    expect(c.engine.has('world.isDaytime')).toBe(true);
    expect(typeof c.world.isDaytime).toBe('function');
    expect(c.engine.has('engine.name')).toBe(true);
    expect(typeof c.engine.name).toBe('string');
  });

  // `fmt` / `rng` 是纯函数库（ejs-fmt / ejs-rng），由 runtime 直接注入沙盒，
  // 不经 buildEjsCapabilities —— 它们的同源性由下面那条「与 EJS_SURFACE 同源」覆盖。
  const ON_CAPS = [
    'chat',
    'char',
    'world',
    '$map',
    'quest',
    'lore',
    'local',
    'ui',
    'engine',
  ] as const;

  it('namespace 里声明的成员，实际对象上必须真的有', () => {
    const c = caps() as unknown as Record<string, Record<string, unknown>>;
    for (const ns of ON_CAPS) {
      const obj = c[ns];
      expect(obj, `能力面上没有 namespace ${ns}`).toBeTruthy();
      for (const m of EJS_SURFACE.namespaces[ns] as readonly string[]) {
        expect(m in obj, `${ns}.${m} 在表里但对象上没有`).toBe(true);
      }
    }
  });

  it('🔴 $map 键集合**双向**对齐 —— 表里少一格就是 engine.has 又开始说谎', () => {
    // 上一条（`m in obj`）只抓「表里有、对象上没有」。真正犯过两次的是**反方向**：
    // 能力真的加了、这张表没跟上（Q-09 的 world.isDaytime，v1.2 的 $map 六格）。
    // 那个方向不会有任何东西变红 —— 创作者写 engine.has('$map.buildings') 拿到 false，
    // 于是他的守卫分支反过来禁用了一个可用能力。所以这里比的是**集合相等**。
    const actual = Object.keys(build({ gameTime: TIME }).caps.$map).sort();
    expect([...EJS_SURFACE.namespaces.$map].sort()).toEqual(actual);
  });

  it('地块动态六格（地图 v1.2）engine.has 一格不落', () => {
    const has = caps().engine.has;
    for (const key of [
      'development',
      'statuses',
      'mainBuilding',
      'buildings',
      'history',
      'developmentLevels',
    ]) {
      expect(has(`$map.${key}`), `engine.has('$map.${key}') 为假`).toBe(true);
    }
  });

  it('不存在的路径仍然返回 false（探测口不能一律说有）', () => {
    const has = caps().engine.has;
    expect(has('world.不存在')).toBe(false);
    expect(has('随便什么')).toBe(false);
    expect(has('')).toBe(false);
  });

  it('预检的两张符号表与 EJS_SURFACE 同源', () => {
    for (const ns of Object.keys(EJS_SURFACE.namespaces)) {
      expect(EJS_TOP_LEVEL_SYMBOLS.has(ns)).toBe(true);
    }
    for (const s of EJS_SURFACE.bareTopLevel) expect(EJS_TOP_LEVEL_SYMBOLS.has(s)).toBe(true);
    for (const a of EJS_SURFACE.aliases) expect(EJS_ALIAS_SYMBOLS.has(a)).toBe(true);
  });

  it('guest 门面的 fmt/rng 名单与 EJS_SURFACE 同源', () => {
    expect(EJS_FMT_NAMES).toEqual([...EJS_SURFACE.namespaces.fmt]);
    expect(EJS_RNG_NAMES).toEqual([...EJS_SURFACE.namespaces.rng]);
  });
});
