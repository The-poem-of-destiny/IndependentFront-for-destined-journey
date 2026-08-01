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
import { createDefaultCharacterState } from './types';
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
    affections: { a1: 75, d1: -80 },
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

  it('affection / affectionLabel；查不到的人给 0 与空串，不抛', () => {
    const { caps } = build(input);
    expect(caps.char.affection('艾波丽斯')).toBe(75);
    expect(caps.char.affectionLabel('艾波丽斯')).toBeTruthy();
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
    expect(caps.world.时间详情.时).toBe(15);
    expect(caps.world.时间详情.时段).toBeTruthy();
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
  const quests = {
    寻找失落的琴弦: { status: '进行中', description: '找琴弦' },
    旧日之约: { status: '已完成', description: '完成了' },
  } as never;

  it('all / active / get / has / focus', () => {
    const { caps } = build({ quests, focusQuest: '寻找失落的琴弦' });
    expect(caps.quest.all()).toHaveLength(2);
    expect(caps.quest.active().map((q) => q.名字)).toEqual(['寻找失落的琴弦']);
    expect(caps.quest.get('旧日之约')?.状态).toBe('已完成');
    expect(caps.quest.has('旧日之约')).toBe(true);
    expect(caps.quest.has('没有这个')).toBe(false);
    expect(caps.quest.focus()?.名字).toBe('寻找失落的琴弦');
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
    expect(caps.engine.has(undefined)).toBe(false);
  });

  it('engineVersion 可被调用方覆盖', () => {
    const { caps } = build({ engineVersion: '9.9.9' });
    expect(caps.engine.version).toBe('9.9.9');
  });
});
