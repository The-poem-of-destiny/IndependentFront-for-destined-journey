import { describe, it, expect, vi, afterEach } from 'vitest';
import { installMapPack, resetMapRuntime } from '../../../src/core/map/map-runtime';
import { EMPTY_MAP_PACK } from '../../../src/core/map/map-pack';
import type { AgentContext, LoreEntryMeta, WorldBook } from '../../../src/core/types/types';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import { selectStoryLore, type LoreSelector } from '../../../src/core/content/lore-selection';
import { buildStoryContextV2Messages } from '../../../src/core/prompts/story-context-v2';
import { buildAgentMessagesAsync } from '../../../src/core/prompts/agent-templates';
import { getEntriesForAgent } from '../../../src/core/content/worldbook-loader';
import { createLoreReadContext, loreRecentText } from '../../../src/core/content/lore-activation';

function book(items: Array<[string, LoreEntryMeta, string?]>): WorldBook {
  return {
    id: 'test',
    name: '合成资料',
    partition: 'world_setting',
    entries: items.map(([key, lore, content], i) => ({
      uid: i,
      name: key,
      content: content ?? `正文:${key}`,
      enabled: true,
      order: i,
      position: 0,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      extra: { lore: { audiences: ['story', 'lore_select'], key, ...lore } },
    })),
  };
}
function context(input = '交易'): AgentContext {
  const player = createDefaultCharacterState({ name: '旅人', type: 'player' });
  player.location = '国-城-港';
  return {
    userInput: input,
    characters: [player],
    history: [],
    worldBooks: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
  };
}

describe('Story lore selection', () => {
  afterEach(resetMapRuntime);

  it('current place ancestry supplies region; same province keeps identical region bytes', async () => {
    installMapPack({
      ...EMPTY_MAP_PACK,
      countries: [
        { id: 'realm', name: 'Realm', color: [0, 0, 0], unclaimed: false, anchorTileId: 1 },
      ],
      midTiers: ['Vale', 'Ridge'].map((name, i) => ({
        id: name,
        name,
        countryId: 'realm',
        climateId: 'mild',
        anchorTileId: i + 1,
      })),
      tiles: ['TownA', 'TownB', 'TownC'].map((name, i) => ({
        id: i + 1,
        name,
        countryId: 'realm',
        midTierId: i === 2 ? 'Ridge' : 'Vale',
        terrain: 'plains',
        water: null,
        impassable: false,
        centroid: [i, 0],
        areaPx: 10,
      })),
    });
    const b = book([
      ['vale', { section: 'region', activation: { locations: ['Vale'] } }],
      ['ridge', { section: 'region', activation: { locations: ['Ridge'] } }],
    ]);
    const ctx = context('讨论 Ridge');
    ctx.characters[0].location = 'Realm-TownA-Inn';
    const selector = async () => '{"keep":[],"extra":[]}';
    const first = await selectStoryLore([b], ctx, selector);
    expect(ctx.characters[0].location).toBe('Realm-TownA-Inn');
    expect(first.zones[3].map((r) => r.key)).toEqual(['vale']);
    ctx.characters[0].location = 'Realm-TownB-Gate';
    const same = await selectStoryLore([b], ctx, selector);
    expect(same.diagnostics.regionSnapshotKey).toBe(first.diagnostics.regionSnapshotKey);
    expect(same.zones[3]).toEqual(first.zones[3]);
    ctx.characters[0].location = 'Realm-TownC';
    const moved = await selectStoryLore([b], ctx, selector);
    expect(moved.zones[3].map((r) => r.key)).toEqual(['ridge']);
    expect(moved.diagnostics.regionSnapshotKey).not.toBe(first.diagnostics.regionSnapshotKey);
    installMapPack({ ...EMPTY_MAP_PACK });
    expect((await selectStoryLore([b], ctx, selector)).zones[3]).toEqual([]);
  });
  it.each([
    [undefined, 6, false],
    [12, 10, true],
    [0, 0, false],
  ])(
    'history limit %s drives keyword selection and selector history together',
    async (limit, size, hit) => {
      const ctx = context('current input');
      ctx.loreHistoryMessages = limit;
      ctx.history = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: i === 0 ? 'old harbor' : `message ${i}`,
        timestamp: i,
      }));
      ctx.history.push({ id: 'system', role: 'system', content: 'system secret', timestamp: 10 });
      const b = book([
        ['candidate', { section: 'turn', activation: { keywords: ['old harbor'] } }],
      ]);
      const selector = vi.fn<LoreSelector>(async () => JSON.stringify({ keep: ['C1'], extra: [] }));
      const result = await selectStoryLore([b], ctx, selector);
      const payload = JSON.parse(selector.mock.calls[0][0][1].content);

      expect(payload.recent).toHaveLength(size);
      expect(payload.recent).not.toContain('system secret');
      expect(result.diagnostics.candidateKeys).toEqual(hit ? ['candidate'] : []);
      expect(result.zones[5].map((r) => r.key)).toEqual(hit ? ['candidate'] : []);
      expect(createLoreReadContext(ctx).recentText.includes('old harbor')).toBe(hit);
      expect(loreRecentText(ctx)).toContain('current input');
    },
  );

  it('zero history still activates lore from the current input', async () => {
    const ctx = context('old harbor');
    ctx.loreHistoryMessages = 0;
    const result = await selectStoryLore(
      [book([['current', { section: 'turn', activation: { keywords: ['old harbor'] } }]])],
      ctx,
    );
    expect(result.diagnostics.candidateKeys).toEqual(['current']);
  });

  it.each([
    ['realm central province-city', 'realm', true],
    ['realm-city-port district', 'port', true],
    ['realm-city', 'city', true],
    ['realm-city', 'remote', false],
    ['realm-city', 'city district', false],
    ['realm-city', 'realm-city', false],
    ['realm-city', '', false],
    ['', 'realm', false],
  ])(
    'location %s contains declaration %s: %s for both region and turn',
    async (location, declared, hits) => {
      const books = [
        book([
          ['region', { section: 'region', activation: { locations: [declared] } }],
          ['turn', { section: 'turn', activation: { locations: [declared] } }],
        ]),
      ];
      const ctx = context('neutral');
      ctx.characters[0].location = location;
      const result = await selectStoryLore(books, ctx);
      expect(result.zones[3].map((r) => r.key)).toEqual(hits ? ['region'] : []);
      expect(result.diagnostics.candidateKeys).toEqual(hits ? ['turn'] : []);
      expect(result.zones[5].map((r) => r.key)).toEqual(hits ? ['turn'] : []);
      const repeated = await selectStoryLore(books, ctx);
      expect(repeated.diagnostics.regionSnapshotKey).toBe(result.diagnostics.regionSnapshotKey);
    },
  );

  it('contained locations cannot bypass audiences, disabled entries, exclusions or dependencies', async () => {
    const activation = { locations: ['realm'] };
    const b = book([
      ['allowed', { section: 'region', activation }],
      ['unreadable', { section: 'region', activation, audiences: ['char_gen'] }],
      ['disabled', { section: 'region', activation }],
      ['excluded', { section: 'region', activation: { ...activation, excludeKeywords: ['stop'] } }],
      ['root', { section: 'turn', activation, dependsOn: ['unreadable'] }],
    ]);
    b.entries[2].enabled = false;
    const ctx = context('stop');
    ctx.characters[0].location = 'realm central province-city';
    const result = await selectStoryLore([b], ctx);
    expect(result.zones[3].map((r) => r.key)).toEqual(['allowed']);
    expect(result.zones[5]).toEqual([]);
    expect(result.diagnostics.blockedDependencyKeys).toContain('unreadable');
  });

  it('budget drops optional dependency groups and recall before EJS but preserves mandatory lore and conversation', async () => {
    const books = [
      book([
        ['required', { section: 'turn', required: true }, 'mandatory'],
        ['dependency', { section: 'turn', activation: { keywords: ['other'] } }, 'd'.repeat(500)],
        [
          'optional',
          { section: 'turn', dependsOn: ['dependency'] },
          '<% throw new Error("budget body must never execute"); %>' + 'x'.repeat(1000),
        ],
      ]),
    ];
    const ctx = context();
    ctx.agentOutputs.set('memory_recall', 'r'.repeat(2000));
    ctx.history = [
      { id: 'u', role: 'user', content: 'original user', timestamp: 1 },
      { id: 'a', role: 'assistant', content: 'original story', timestamp: 2 },
    ];
    const result = await buildStoryContextV2Messages({
      ctx,
      configs: [],
      worldBooks: books,
      presets: [],
      windowTurns: 1,
      segments: [],
      archives: [],
      budgetChars: 1000,
    });
    const text = result.messages.map((m) => m.content).join('\n');
    expect(text).toContain('mandatory');
    expect(text).toContain('original user');
    expect(text).toContain('original story');
    expect(text).not.toContain('budget body');
    expect(text).not.toContain('相关回忆');
    expect(result.diagnostics.budgetDroppedLoreKeys).toEqual(['dependency', 'optional']);
    expect(result.diagnostics.budgetDroppedRecall).toBe(true);
    expect(ctx.agentOutputs.get('memory_recall')).toHaveLength(2000);
  });
  it('local geography remains stable when distant places are mentioned; moving replaces it', async () => {
    const books = [
      book([
        ['city', { section: 'region', activation: { locations: ['港'] } }],
        ['remote', { section: 'region', activation: { locations: ['远城'], keywords: ['远城'] } }],
      ]),
    ];
    const first = await selectStoryLore(books, context());
    const discussed = await selectStoryLore(books, context('远城'));
    expect(first.zones[3].map((r) => r.key)).toEqual(['city']);
    expect(discussed.diagnostics.regionSnapshotKey).toBe(first.diagnostics.regionSnapshotKey);
    expect(discussed.zones[5].map((r) => r.key)).toContain('remote');
    const moved = context();
    moved.characters[0].location = '国-远城';
    expect((await selectStoryLore(books, moved)).zones[3].map((r) => r.key)).toEqual(['remote']);
    books[0].entries[0].content = '修订';
    expect((await selectStoryLore(books, context())).diagnostics.regionSnapshotKey).not.toBe(
      first.diagnostics.regionSnapshotKey,
    );
  });
  it('catalogues omit bodies and story-only entries; model cannot discard required dependencies or bypass exclusions', async () => {
    const books = [
      book([
        ['base', { section: 'fixed' }],
        ['must', { section: 'turn', required: true, dependsOn: ['base'] }],
        ['candidate', { section: 'turn' }, 'SECRET BODY'],
        ['private', { section: 'turn', audiences: ['story'] }],
        ['blocked', { section: 'turn', activation: { excludeKeywords: ['交易'] } }],
        ['extra', { section: 'turn', activation: { keywords: ['旅行'] } }],
      ]),
    ];
    const selector = vi.fn(async (messages) => {
      const text = JSON.stringify(messages);
      expect(text).not.toContain('SECRET BODY');
      expect(text).not.toContain('private');
      expect(text).not.toContain('blocked');
      return '{"keep":[],"extra":["E1","C1","E99"],"reason":"test"}';
    });
    const result = await selectStoryLore(books, context(), selector);
    expect(result.zones[5].map((r) => r.key)).toEqual(['must', 'private', 'extra']);
    expect(result.zones[1].map((r) => r.key)).toEqual(['base']);
    expect(result.diagnostics.rejectedRefs).toEqual(['C1', 'E99']);
    expect(selector).toHaveBeenCalledTimes(1);
  });
  it('unavailable or malformed selector falls back to candidates; disabled dependencies block their roots', async () => {
    const books = [
      book([
        ['candidate', { section: 'turn' }],
        ['root', { section: 'turn', required: true, dependsOn: ['disabled'] }],
        ['disabled', { section: 'fixed' }],
      ]),
    ];
    books[0].entries[2].enabled = false;
    for (const selector of [
      undefined,
      async () => '{}',
      async () => {
        throw new Error('network');
      },
    ]) {
      const result = await selectStoryLore(books, context(), selector);
      expect(result.diagnostics.status).toBe('fallback');
      expect(result.zones[5].map((r) => r.key)).toEqual(['candidate']);
      expect(result.diagnostics.blockedDependencyKeys).toEqual(['disabled']);
    }
  });
  it('ranks relevant supplement metadata before the eighty-entry cap without reading bodies', async () => {
    const fillers: Array<[string, LoreEntryMeta, string?]> = Array.from({ length: 85 }, (_, i) => [
      `unrelated-${i}`,
      { section: 'turn', activation: { keywords: [`unused-${i}`] } },
      '秘密码头是渔船停靠处，正文中的匹配词不得影响目录排序',
    ]);
    const b = book([
      ...fillers,
      [
        '当前资料',
        {
          section: 'turn',
          summary: '秘密码头的泊位、渔船与船工',
          activation: { keywords: ['disabled-trigger'] },
        },
        'BODY_MUST_STAY_PRIVATE',
      ],
      [
        'denied',
        {
          section: 'turn',
          summary: '秘密码头',
          activation: { keywords: ['disabled-trigger'] },
          audiences: ['char_gen'],
        },
      ],
      [
        'disabled',
        { section: 'turn', summary: '秘密码头', activation: { keywords: ['disabled-trigger'] } },
      ],
    ]);
    b.entries[b.entries.length - 1].enabled = false;
    const ctx = context('我去秘密码头寻找船工');
    ctx.characters[0].location = '城-东岸';
    const calls: unknown[] = [];
    const selector: LoreSelector = async (messages) => {
      const payload = JSON.parse(messages[1].content);
      calls.push(payload.catalog);
      expect(payload.catalog).toHaveLength(80);
      expect(payload.catalog[0]).toMatchObject({ ref: 'E1', name: '当前资料' });
      expect(JSON.stringify(messages)).not.toContain('BODY_MUST_STAY_PRIVATE');
      expect(payload.catalog.map((r: { name: string }) => r.name)).not.toContain('denied');
      expect(payload.catalog.map((r: { name: string }) => r.name)).not.toContain('disabled');
      return '{"keep":[],"extra":["E1"]}';
    };
    const result = await selectStoryLore([b], ctx, selector);
    await selectStoryLore([b], ctx, selector);
    expect(calls[1]).toEqual(calls[0]);
    expect(result.diagnostics.supplementKeys).toEqual(['当前资料']);
    expect(result.zones[5].map((r) => r.key)).toEqual(['当前资料']);
  });

  it('uses current input, location and bounded recent messages to rank supplements, preserving tie order', async () => {
    const b = book([
      ['无关一', { section: 'turn', activation: { keywords: ['unused'] } }],
      ['无关二', { section: 'turn', activation: { keywords: ['unused'] } }],
      [
        '旧线索',
        { section: 'turn', summary: '北岸矿井矿工', activation: { keywords: ['unused'] } },
      ],
      ['当前位置', { section: 'turn', summary: '月湖码头', activation: { keywords: ['unused'] } }],
      [
        '当前问题',
        { section: 'turn', summary: '贷款抵押利率', activation: { keywords: ['unused'] } },
      ],
    ]);
    const ctx = context('贷款抵押利率');
    ctx.characters[0].location = '月湖码头';
    ctx.history = [{ id: 'old', role: 'assistant', content: '北岸矿井矿工', timestamp: 1 }];
    const capture = async () => {
      let names: string[] = [];
      await selectStoryLore([b], ctx, async (messages) => {
        names = JSON.parse(messages[1].content).catalog.map((r: { name: string }) => r.name);
        return '{"keep":[],"extra":[]}';
      });
      return names;
    };
    expect(await capture()).toEqual(['当前问题', '当前位置', '旧线索', '无关一', '无关二']);
    ctx.loreHistoryMessages = 0;
    expect(await capture()).toEqual(['当前问题', '当前位置', '无关一', '无关二', '旧线索']);
    ctx.userInput = '';
    ctx.characters[0].location = '';
    expect(await capture()).toEqual(b.entries.map((r) => r.name));
  });

  it('asks the selector for necessary context rather than filling the supplement quota with nearby cities', async () => {
    let instruction = '';
    await selectStoryLore(
      [book([['candidate', { section: 'turn' }]])],
      context(),
      async (messages) => {
        instruction = messages[0].content;
        return '{"keep":[],"extra":[]}';
      },
    );
    expect(instruction).toContain('上限不是配额');
    expect(instruction).toContain('同国、相邻或可作备选');
    expect(instruction).toContain('明确目的地');
  });
  it('supplements are deduplicated, capped at fifteen; cycles and audiences cannot be bypassed', async () => {
    const keys = Array.from({ length: 16 }, (_, i) => `extra-${i + 1}`);
    const books = [
      book([
        ['a', { section: 'fixed', dependsOn: ['b'] }],
        ['b', { section: 'fixed', dependsOn: ['a'] }],
        ['unreadable', { section: 'fixed', audiences: ['char_gen'] }],
        ['root', { section: 'fixed', dependsOn: ['unreadable'] }],
        ...keys.map(
          (key) =>
            [key, { section: 'turn', activation: { keywords: ['other'] } }] as [
              string,
              LoreEntryMeta,
            ],
        ),
      ]),
    ];
    const result = await selectStoryLore(books, context(), async (messages) => {
      expect(messages[0].content).toContain('最多补充 15 个 E 条目');
      return JSON.stringify({
        keep: [],
        extra: ['E1', 'E1', ...keys.map((_, i) => `E${i + 1}`), 'E99', 'C1'],
      });
    });
    expect(result.zones[1]).toEqual([]);
    expect(result.zones[5].map((r) => r.key)).toEqual(keys.slice(0, 15));
    expect(result.diagnostics.supplementKeys).toEqual(keys.slice(0, 15));
    expect(result.diagnostics.rejectedRefs).toEqual(['E99', 'C1']);
    expect(result.diagnostics.blockedDependencyKeys).toContain('unreadable');
  });

  it.each([0, 14, 15, 16])('retains up to fifteen of %i supplement roots', async (count) => {
    const keys = Array.from({ length: 16 }, (_, i) => `extra-${i + 1}`);
    const books = [
      book(
        keys.map((key) => [
          key,
          {
            section: 'turn',
            activation: { keywords: ['other'] },
          },
        ]),
      ),
    ];
    const result = await selectStoryLore(books, context(), async () =>
      JSON.stringify({
        keep: [],
        extra: Array.from({ length: count }, (_, i) => `E${i + 1}`),
      }),
    );
    expect(result.diagnostics.supplementKeys).toEqual(keys.slice(0, Math.min(count, 15)));
    expect(result.zones[5].map((r) => r.key)).toEqual(keys.slice(0, Math.min(count, 15)));
  });
  it.each(['disabled', 'missing', 'audience', 'exclude', 'cycle'])(
    '实际双模式 EJS get/list/has 不得间接注入被 %s 拒绝的根',
    async (mode) => {
      const b = book([
        [
          'reader',
          { section: 'turn', required: true },
          '<%= lore.get("root") %>|<%= lore.has("root") %>|<%= JSON.stringify(lore.list("合成资料")) %>',
        ],
        ['root', { section: 'turn', dependsOn: ['dep'] }, 'ROOT_SHOULD_BE_BLOCKED'],
        ['dep', { section: 'turn' }, 'DEPENDENCY_SHOULD_BE_BLOCKED'],
      ]);
      if (mode === 'disabled') b.entries[2].enabled = false;
      if (mode === 'missing') b.entries.pop();
      if (mode === 'audience') b.entries[2].extra!.lore!.audiences = ['char_gen'];
      if (mode === 'exclude') b.entries[2].extra!.lore!.activation = { excludeKeywords: ['stop'] };
      if (mode === 'cycle') b.entries[2].extra!.lore!.dependsOn = ['root'];
      const ctx = context('stop');
      const selector = vi.fn(async (messages) => {
        expect(JSON.stringify(messages)).not.toContain('ROOT_SHOULD_BE_BLOCKED');
        return '{"keep":[],"extra":[]}';
      });
      const selected = await selectStoryLore([b], ctx, selector);
      expect(
        Object.values(selected.zones)
          .flat()
          .map((r) => r.key),
      ).toEqual(['reader']);
      expect(selected.diagnostics.blockedDependencyKeys.length).toBeGreaterThan(0);
      expect(getEntriesForAgent('story', [b], 'stop').map((e) => e.name)).toEqual(['reader']);
      // 无合法候选无需网络；读取有效性并不以 selector 成功为前提。
      expect(selector).not.toHaveBeenCalled();
      const v2 = await buildStoryContextV2Messages({
        ctx: context('stop'),
        configs: [],
        worldBooks: [b],
        presets: [],
        windowTurns: 1,
        segments: [],
        archives: [],
      });
      const old = await buildAgentMessagesAsync(
        'story',
        context('stop'),
        [
          {
            agentId: 'story',
            enabled: true,
            apiEndpointId: '',
            model: '',
            temperature: 0.7,
            maxTokens: 4096,
            topP: 1,
            frequencyPenalty: 0,
            presencePenalty: 0,
            retryOnFail: false,
            timeout: 0,
            userId: '',
            promptTemplate: { fixedSystem: '', fixedExamples: '' },
          },
        ],
        [b],
      );
      for (const messages of [v2.messages, old!]) {
        const text = messages.map((m) => m.content).join('\n');
        expect(text).not.toContain('ROOT_SHOULD_BE_BLOCKED');
        expect(text).not.toContain('DEPENDENCY_SHOULD_BE_BLOCKED');
        expect(text).not.toContain('"root"');
        expect(text).toContain('false');
      }
    },
  );
  it('逐条诊断仅含稳定键与原因，覆盖权限/依赖/硬排除/选择器/有限补充', async () => {
    const result = await selectStoryLore(
      [
        book([
          ['fixed', { section: 'fixed' }],
          ['city', { section: 'region', activation: { locations: ['城'] } }],
          ['denied', { audiences: ['char_gen'] }],
          ['root', { dependsOn: ['denied'] }],
          ['excluded', { activation: { excludeKeywords: ['交易'] } }],
          ['candidate', { section: 'turn' }],
          ['supplement', { section: 'turn', activation: { keywords: ['other'] } }],
        ]),
      ],
      context(),
      async () => '{"keep":[],"extra":["E1"]}',
    );
    expect(result.diagnostics.decisions).toEqual(
      expect.arrayContaining([
        { key: 'fixed', reason: 'fixed', outcome: 'selected', zone: 1 },
        { key: 'city', reason: 'region-match', outcome: 'selected', zone: 3 },
        { key: 'denied', reason: 'not-readable', outcome: 'excluded' },
        { key: 'root', reason: 'dependency-not-readable', outcome: 'excluded' },
        { key: 'excluded', reason: 'hard-exclusion', outcome: 'excluded' },
        { key: 'candidate', reason: 'selector-not-selected', outcome: 'excluded' },
        { key: 'supplement', reason: 'limited-supplement', outcome: 'selected', zone: 5 },
      ]),
    );
    expect(JSON.stringify(result.diagnostics.decisions)).not.toContain('正文:');
  });
  it('selected EJS is evaluated once; omitted EJS never runs, regardless of uid collisions', async () => {
    const books = [
      book([
        ['fixed', { section: 'fixed' }],
        ['local', { section: 'region', activation: { locations: ['城'] } }],
        [
          'dynamic',
          { section: 'turn' },
          '<% vars.count = (vars.count || 0) + 1; %>value:<%= vars.count %>',
        ],
        ['omitted', { section: 'turn' }, '<% throw new Error("must not run"); %>'],
      ]),
    ];
    const result = await buildStoryContextV2Messages({
      ctx: context(),
      configs: [],
      worldBooks: books,
      presets: [],
      windowTurns: 1,
      segments: [],
      archives: [],
      selectLore: async () => '{"keep":["C1"],"extra":[]}',
    });
    const text = result.messages.map((m) => m.content).join('\n');
    expect(text).toContain('正文:fixed');
    expect(text).toContain('<区域资料>');
    expect(text).toContain('value:1');
    expect(text).not.toContain('must not run');
    expect(result.diagnostics.loreKeysByZone).toEqual({
      1: ['fixed'],
      3: ['local'],
      5: ['dynamic'],
    });
  });
});
