/**
 * entity-gen-agent.test.ts — 通用实体生成（entity_gen）测试
 *
 * 2026-10-02：由 char-gen-agent.test.ts + item-gen-chain.test.ts 合并重写。
 * 覆盖：统一解析（protocolText/tags 两层、忽略结构化效果字段）/ patches 形状 /
 * assembleCharacterState / runEntityGenChain（角色 & 批量）/ 重铸。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runEntityGenChain,
  assembleCharacterState,
  buildEntityGenPatches,
  buildRewritePatches,
  rewriteLoadoutItem,
  buildEntityRequestsXML,
  callEntityGenForCraft,
  $chargen,
} from '../../../src/core/agents/entity-gen-agent';
import type {
  EntityGenClient,
  EntityGenDeps,
  EntityGenRequest,
  RewriteTarget,
} from '../../../src/core/agents/entity-gen-agent';
import {
  parseEntityGenOutput,
  parseStatusesXML,
  parseStatusEffectsXML,
  extractPersonalityText,
} from '../../../src/core/agents/entity-gen-parse';
import type {
  EntityGenOutput,
  EntityGenRequestMarker,
  ApiEndpoint,
  AgentContext,
} from '../../../src/core/types/types';

// ========== Factory Helpers ==========

function makeEndpoint(overrides: Partial<ApiEndpoint> = {}): ApiEndpoint {
  return {
    id: 'ep-test',
    name: 'Test Endpoint',
    provider: 'deepseek',
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat'],
    timeout: 60000,
    ...overrides,
  };
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    userInput: 'test input',
    history: [],
    worldBooks: [],
    characters: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    ...overrides,
  };
}

function makeMarker(overrides: Partial<EntityGenRequestMarker> = {}): EntityGenRequestMarker {
  return {
    type: 'entity_gen_request',
    rawContent: '<entity_gen_request type="item">治疗药水</entity_gen_request>',
    position: 0,
    attributes: { entityType: 'item' },
    bodyText: '治疗药水',
    ...overrides,
  };
}

function makeClient(output: string, opts: { error?: string } = {}): EntityGenClient {
  return {
    chatWithTools: async () => ({
      output: opts.error ? null : output,
      rawResponse: opts.error ? '' : output,
      tokensUsed: 0,
      cacheHit: false,
      duration: 0,
      ...(opts.error ? { error: opts.error } : {}),
    }),
  };
}

function makeDeps(output: string, stateManager?: EntityGenDeps['stateManager']): EntityGenDeps {
  return {
    clientFactory: () => makeClient(output),
    ...(stateManager ? { stateManager } : {}),
  };
}

// ========== parseEntityGenOutput ==========

describe('parseEntityGenOutput', () => {
  it('解析 <entity_result> 角色块（内嵌技能/装备/道具/登神）', () => {
    const raw = `<entity_result>
      <character>
        <name>艾琳</name>
        <race>精灵</race>
        <gender>女</gender>
        <tier>2</tier>
        <level>8</level>
        <attributes str="4" dex="10" con="5" int="7" spi="8"/>
        <identity>巡林者</identity>
        <occupation>弓箭手</occupation>
        <background>精灵巡林者</background>
        <personality>wOaGz(A)+冷静果断</personality>
        <skills>
          <skill name="精准射击" type="active" quality="稀有" cost_type="SP" cost_amount="15" cooldown="3" power="120" attr="dex" dtype="物理">
            精准瞄准
            <effect name="命中提升">命中率+20%</effect>
            <tag>远程</tag>
          </skill>
        </skills>
        <equipment>
          <equip slot="武器" name="长弓" quality="优良" durability="50" stats="str:2,dex:5">
            一把精灵长弓<tag>弓</tag>
          </equip>
        </equipment>
        <inventory>
          <item name="箭袋" quantity="3" type="消耗品" rarity="普通">备用箭矢</item>
        </inventory>
        <ascension enabled="true" path="星辰" description="登神之路">
          <elements><element name="星辰" description="星辰之力"/></elements>
        </ascension>
      </character>
    </entity_result>`;

    const out = parseEntityGenOutput(raw);
    expect(out.character?.name).toBe('艾琳');
    expect(out.character?.race).toBe('精灵');
    expect(out.character?.personality).toBe('wOaGz(A)+冷静果断');
    expect(out.character?.skills[0].name).toBe('精准射击');
    expect(out.character?.skills[0].quality).toBe('稀有');
    expect(out.character?.skills[0].skillPower).toBe(120);
    expect(out.character?.skills[0].relevantAttribute).toBe('dex');
    expect(out.character?.skills[0].effects).toEqual({ 命中提升: '命中率+20%' });
    // 两层协议字段
    expect(out.character?.skills[0].tags).toContain('远程');
    expect(out.character?.skills[0].protocolText).toContain('<effect name="命中提升">');
    expect(out.character?.equipment[0].slot).toBe('武器');
    expect(out.character?.equipment[0].stats).toEqual({ str: 2, dex: 5 });
    expect(out.character?.inventory[0].name).toBe('箭袋');
    expect(out.character?.ascension.enabled).toBe(true);
    expect(out.character?.ascension.path).toBe('星辰');
  });

  it('解析顶层 skills/equipment/inventory/statuses（独立生成）', () => {
    const raw = `<entity_result>
      <skills><skill name="火球术" type="active" power="300" attr="int" dtype="能量">放火<tag>火焰</tag></skill></skills>
      <equipment><equip slot="身体" name="法袍" quality="史诗" stats="int:8">法袍</equip></equipment>
      <inventory><item name="面包" quantity="5" type="食物" rarity="普通">干粮</item></inventory>
      <statuses><status name="灼烧" category="减益" stacks="2" remainingTime="3" timeUnit="回合">持续<effect name="dot">每回合30伤</effect><tag>燃烧</tag></status></statuses>
    </entity_result>`;

    const out = parseEntityGenOutput(raw);
    expect(out.character).toBeUndefined();
    expect(out.skills[0].name).toBe('火球术');
    expect(out.skills[0].tags).toEqual(['火焰']);
    expect(out.equipment[0].name).toBe('法袍');
    expect(out.inventory[0].name).toBe('面包');
    const status = out.statuses![0];
    expect(status.name).toBe('灼烧');
    expect(status.category).toBe('减益');
    expect(status.stacks).toBe(2);
    expect(status.timeUnit).toBe('回合');
    expect(status.effects).toEqual({ dot: '每回合30伤' });
    expect(status.tags).toContain('燃烧');
  });

  it('🔴 不解析 modifiers/buffs/automaton 块（忽略且不落进 description）', () => {
    const raw = `<entity_result>
      <skills><skill name="毒刃" type="active">带毒
        <modifiers>{"category":"检定","bonus":5}</modifiers>
        <buffs>{"name":"流血","stacks":1}</buffs>
        <automaton>{"subscribe":"damage.after","intents":[]}</automaton>
      </skill></skills>
    </entity_result>`;

    const out = parseEntityGenOutput(raw);
    const skill = out.skills[0] as (typeof out.skills)[number] & {
      modifiers?: unknown;
      buffs?: unknown;
      automata?: unknown;
    };
    expect(skill.modifiers).toBeUndefined();
    expect(skill.buffs).toBeUndefined();
    expect(skill.automata).toBeUndefined();
    expect(skill.description).not.toContain('category');
    expect(skill.description).not.toContain('subscribe');
  });

  it('JSON 兜底：分组形状 / 单对象', () => {
    const grouped = JSON.stringify({
      skills: [{ name: '斩击', type: 'active', description: '挥砍' }],
      inventory: [{ name: '药水', quantity: 2, type: '消耗品' }],
    });
    expect(parseEntityGenOutput(grouped).skills[0].name).toBe('斩击');

    const single = JSON.stringify({
      name: '薇拉',
      race: '人类',
      attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    });
    expect(parseEntityGenOutput(single).character?.name).toBe('薇拉');
  });

  it('全失败 → 空输出（不抛）', () => {
    const out = parseEntityGenOutput('这只是一句普通文本');
    expect(out.character).toBeUndefined();
    expect(out.skills).toHaveLength(0);
    expect(out.statuses).toHaveLength(0);
  });

  it('parseStatusesXML 归一化非法 category/timeUnit', () => {
    const out = parseStatusesXML('<status name="x" category="乱写" timeUnit="乱写">y</status>');
    expect(out[0].category).toBe('减益');
    expect(out[0].timeUnit).toBe('回合');
  });

  it('parseStatusEffectsXML 解析 vars_update 的 <status_effects> 形状', () => {
    const out = parseStatusEffectsXML(
      '<effect owner="理查德" name="中毒" category="减益" stacks="2" remainingTime="3" timeUnit="回合">毒素侵蚀<effect name="dot">10</effect></effect>',
    );
    expect(out).toHaveLength(1);
    expect(out[0].owner).toBe('理查德');
    expect(out[0].effects).toEqual({ dot: '10' });
  });

  it('extractPersonalityText 保留性格编码', () => {
    expect(
      extractPersonalityText(
        '<character><personality code="wOaGz(A)">冷静果断</personality></character>',
      ),
    ).toBe('wOaGz(A)+冷静果断');
    expect(
      extractPersonalityText('<character><personality>wOaGz(A)+描述</personality></character>'),
    ).toBe('wOaGz(A)+描述');
  });
});

// ========== buildEntityGenPatches ==========

describe('buildEntityGenPatches', () => {
  function output(partial: Partial<EntityGenOutput>): EntityGenOutput {
    return { skills: [], equipment: [], inventory: [], statuses: [], ...partial };
  }

  it('装备 → add_item（带 equippedSlot + protocolText/tags）', () => {
    const patches = buildEntityGenPatches(
      output({
        equipment: [
          {
            slot: '武器',
            name: '长剑',
            description: '锋利的剑',
            stats: { str: 3 },
            quality: '优良',
            protocolText: '锋利的剑',
            tags: ['单手'],
          },
        ],
      }),
      '理查德',
    );
    expect(patches).toHaveLength(1);
    expect(patches[0].op).toBe('add_item');
    expect(patches[0].target).toBe('characters.理查德');
    const value = patches[0].value as Record<string, unknown>;
    expect(value.equippedSlot).toBe('武器');
    expect(value.protocolText).toBe('锋利的剑');
    expect(value.tags).toEqual(['单手']);
  });

  it('技能 → add_skill（透传 skillPower/relevantAttribute/damageType/rarity/protocolText）', () => {
    const patches = buildEntityGenPatches(
      output({
        skills: [
          {
            name: '火球术',
            description: '放火',
            type: 'active',
            quality: '史诗',
            skillPower: 300,
            relevantAttribute: 'int',
            damageType: '能量',
            protocolText: '放火',
            tags: ['火焰'],
          },
        ],
      }),
      '理查德',
    );
    expect(patches[0].op).toBe('add_skill');
    const value = patches[0].value as Record<string, unknown>;
    expect(value.rarity).toBe('史诗');
    expect(value.skillPower).toBe(300);
    expect(value.relevantAttribute).toBe('int');
    expect(value.damageType).toBe('能量');
    expect(value.protocolText).toBe('放火');
  });

  it('状态 → add_status_effect（owner 缺省取 characterId）', () => {
    const patches = buildEntityGenPatches(
      output({
        statuses: [
          {
            owner: '',
            name: '灼烧',
            category: '减益',
            description: '燃烧',
            stacks: 1,
            maxStacks: 1,
            remainingTime: 3,
            timeUnit: '回合',
          },
        ],
      }),
      '理查德',
    );
    expect(patches[0].op).toBe('add_status_effect');
    expect(patches[0].target).toBe('characters.理查德');
    expect((patches[0].value as Record<string, unknown>).owner).toBe('理查德');
  });

  it('登神 → update_character.value.ascension', () => {
    const patches = buildEntityGenPatches(
      output({
        ascension: {
          enabled: true,
          path: '星辰',
          description: '登神',
          elements: [{ name: '空间', description: 'x', effects: ['a'] }],
          authorities: [],
          laws: [],
          deityPosition: '',
          divineKingdom: { name: '', description: '' },
        },
      }),
      '理查德',
    );
    expect(patches[0].op).toBe('update_character');
    expect((patches[0].value as Record<string, unknown>).ascension).toBeTruthy();
  });
});

// ========== assembleCharacterState ==========

describe('assembleCharacterState', () => {
  it('合并角色内嵌与顶层条目（去重）+ 两层字段透传', () => {
    const out: EntityGenOutput = {
      character: {
        name: '艾琳',
        race: '精灵',
        gender: '女',
        tier: 2,
        level: 8,
        attributes: { str: 4, dex: 10, con: 5, int: 7, spi: 8 },
        identity: ['巡林者'],
        occupation: ['弓箭手'],
        background: '背景',
        appearance: '外貌',
        clothing: '斗篷',
        personality: '冷静',
        likes: '森林',
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
        skills: [{ name: '精准射击', description: 'x', type: 'active' }],
        equipment: [],
        inventory: [],
      },
      skills: [
        { name: '精准射击', description: '重复应去重', type: 'active' },
        { name: '火球术', description: 'y', type: 'active', protocolText: 'y', tags: ['火焰'] },
      ],
      equipment: [],
      inventory: [],
      statuses: [],
    };

    const char = assembleCharacterState(out);
    expect(char.name).toBe('艾琳');
    // 顶层补充技能在前、角色内嵌在后（去重后角色内嵌的同名不再重复）
    expect(char.skills.map((s) => s.name)).toEqual(['火球术', '精准射击']);
    const fireball = char.skills.find((s) => s.name === '火球术');
    expect(fireball?.protocolText).toBe('y');
    expect(fireball?.tags).toEqual(['火焰']);
    expect(char.tierName).toBeTruthy();
    expect(char.maxHp).toBeGreaterThan(0);
  });

  it('顶层 statuses → CharacterState.statusEffects', () => {
    const out: EntityGenOutput = {
      character: {
        name: '艾琳',
        race: '精灵',
        gender: '女',
        tier: 1,
        level: 1,
        attributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
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
      skills: [],
      equipment: [],
      inventory: [],
      statuses: [
        {
          owner: '',
          name: '祝福',
          category: '增益',
          description: '增益',
          stacks: 1,
          maxStacks: 1,
          remainingTime: 5,
          timeUnit: '分钟',
        },
      ],
    };
    const char = assembleCharacterState(out);
    expect(char.statusEffects).toHaveLength(1);
    expect(char.statusEffects[0].name).toBe('祝福');
  });
});

// ========== runEntityGenChain ==========

describe('runEntityGenChain', () => {
  it('角色路径：单次调用 → add_character，落库走 commitDomainCommand', async () => {
    const commit = vi.fn(async () => {});
    const raw = `<entity_result><character>
      <name>新角色</name><race>人类</race><tier>1</tier><level>1</level>
      <attributes str="10" dex="10" con="10" int="10" spi="10"/>
    </character></entity_result>`;
    const request: EntityGenRequest = {
      saveId: 'save-test',
      marker: makeMarker({ attributes: { entityType: 'character' } }),
      context: makeContext(),
      endpoint: makeEndpoint(),
    };
    const result = await runEntityGenChain(request, makeDeps(raw, { commitDomainCommand: commit }));
    expect(result.character?.name).toBe('新角色');
    expect(result.patches[0].op).toBe('add_character');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(result.narrativeSummary).toContain('新角色');
  });

  it('批量物品路径：打包 <entity_requests> → add_item/add_skill', async () => {
    const raw = `<entity_result>
      <skills><skill name="斩击" type="active">挥砍</skill></skills>
      <inventory><item name="药水" quantity="2" type="消耗品">恢复</item></inventory>
    </entity_result>`;
    const request: EntityGenRequest = {
      saveId: 'save-test',
      markers: [
        makeMarker(),
        makeMarker({ attributes: { entityType: 'skill' }, bodyText: '斩击' }),
      ],
      context: makeContext({
        characters: [
          {
            name: '主角',
            type: 'player',
            skills: [],
            inventory: [],
          } as never,
        ],
      }),
      endpoint: makeEndpoint(),
    };
    const result = await runEntityGenChain(request, makeDeps(raw));
    const ops = result.patches.map((p) => p.op);
    expect(ops).toContain('add_skill');
    expect(ops).toContain('add_item');
    expect(result.patches[0].target).toBe('characters.主角');
  });

  it('无 owner 且无玩家角色 → 空 patches（不抛）', async () => {
    const request: EntityGenRequest = {
      saveId: 'save-test',
      markers: [makeMarker()],
      context: makeContext(),
      endpoint: makeEndpoint(),
    };
    const result = await runEntityGenChain(request, makeDeps('<entity_result></entity_result>'));
    expect(result.patches).toHaveLength(0);
  });

  it('调用失败 → 空输出（角色路径无 <character> 块 → 上浮可读错误）', async () => {
    const request: EntityGenRequest = {
      saveId: 'save-test',
      marker: makeMarker({ attributes: { entityType: 'character' } }),
      context: makeContext(),
      endpoint: makeEndpoint(),
    };
    const deps: EntityGenDeps = { clientFactory: () => makeClient('', { error: 'boom' }) };
    await expect(runEntityGenChain(request, deps)).rejects.toThrow(/无法解析/);
  });
});

describe('buildEntityRequestsXML', () => {
  it('N 个 marker → N 个 <request>（装备带 slot，owner 透传）', () => {
    const xml = buildEntityRequestsXML([
      makeMarker({ attributes: { entityType: 'equipment', owner: '理查德' }, bodyText: '长剑' }),
      makeMarker({ attributes: { entityType: 'skill', owner: '理查德' }, bodyText: '火球术' }),
    ]);
    expect(xml).toContain('<request type="equipment"');
    expect(xml).toContain('owner="理查德"');
    expect((xml.match(/<request /g) || []).length).toBe(2);
  });
});

// ========== 重铸 ==========

describe('重铸', () => {
  function makeOutput(): EntityGenOutput {
    return {
      skills: [
        {
          name: '火球术·改',
          description: 'x',
          type: 'active',
          replace: '火球术',
          protocolText: 'x',
        },
      ],
      equipment: [],
      inventory: [],
      statuses: [],
    };
  }

  it('buildRewritePatches：命中 replace → remove + add（同事务）', () => {
    const r = buildRewritePatches(makeOutput(), '理查德', '火球术');
    expect(r.ok).toBe(true);
    expect(r.patches[0].op).toBe('remove_skill');
    expect(r.patches[1].op).toBe('add_skill');
  });

  it('buildRewritePatches：未命中 → ok:false + reason', () => {
    const r = buildRewritePatches(makeOutput(), '理查德', '不存在的技能');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('replace');
  });

  it('rewriteLoadoutItem：命中 → commit 一次；未命中 → ok:false', async () => {
    const commit = vi.fn(async () => {});
    const target: RewriteTarget = {
      kind: 'skill',
      entry: { name: '火球术', description: 'old', type: 'active' },
    };
    const request = {
      saveId: 'save-test',
      characterId: '理查德',
      target,
      context: makeContext(),
      endpoint: makeEndpoint(),
    };
    const out = `<entity_result><skills><skill name="火球术·改" type="active" replace="火球术">x</skill></skills></entity_result>`;
    const r = await rewriteLoadoutItem(request, makeDeps(out, { commitDomainCommand: commit }));
    expect(r.ok).toBe(true);
    expect(commit).toHaveBeenCalledTimes(1);

    const r2 = await rewriteLoadoutItem(
      {
        ...request,
        target: { kind: 'skill', entry: { name: '目标', description: '', type: 'active' } },
      },
      makeDeps(out),
    );
    expect(r2.ok).toBe(false);
  });
});

// ========== callEntityGenForCraft ==========

describe('callEntityGenForCraft', () => {
  it('把 item_requests 作为 ENTITY_REQUEST 注入，产出 EntityGenOutput', async () => {
    const out = await callEntityGenForCraft(
      '<request type="equipment">长剑</request>',
      '<craft_output/>',
      { context: makeContext(), endpoint: makeEndpoint(), saveId: 'save-test' },
      makeDeps(
        '<entity_result><equipment><equip slot="武器" name="长剑">x</equip></equipment></entity_result>',
      ),
    );
    expect(out.equipment[0].name).toBe('长剑');
  });
});

// ========== $chargen ==========

describe('$chargen', () => {
  it('暴露 generate / assemble', () => {
    expect($chargen.generate).toBe(runEntityGenChain);
    expect($chargen.assemble).toBe(assembleCharacterState);
  });
});
