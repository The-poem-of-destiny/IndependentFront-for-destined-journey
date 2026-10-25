import { describe, expect, it, vi } from 'vitest';
import type { AgentContext, LoreEntryMeta, WorldBook } from '../../../src/core/types/types';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import { createDefaultTime } from '../../../src/core/time/time-system';
import { selectStoryLore } from '../../../src/core/content/lore-selection';
import { buildStoryContextV2Messages } from '../../../src/core/prompts/story-context-v2';
import {
  buildEjsPassContext,
  buildAgentMessagesAsync,
} from '../../../src/core/prompts/agent-templates';
import {
  buildLoreDefinitions,
  createFixedLoreSnapshot,
} from '../../../src/core/content/lore-definitions';
import {
  createLoreReadContext,
  passesLoreReadWhen,
} from '../../../src/core/content/lore-activation';
import { getEntriesForAgent } from '../../../src/core/content/worldbook-loader';
import { validateLoreProtocol } from '../../../src/core/content/lore-protocol';
import { LegacyBackend } from '../../../src/core/ejs/ejs-backend';
import { createQuickJsBackend } from '../../../src/core/ejs/ejs-quickjs-backend';

function book(items: Array<[string, LoreEntryMeta, string]>): WorldBook {
  return {
    id: 'test',
    name: 'test',
    partition: 'world_setting',
    entries: items.map(([key, lore, content], uid) => ({
      uid,
      name: key,
      content,
      enabled: true,
      order: uid,
      position: 0,
      key: [],
      keysecondary: [],
      selectiveLogic: 0,
      extra: { lore: { audiences: ['story', 'lore_select'], key, ...lore } },
    })),
  };
}
function context(input = ''): AgentContext {
  const player = createDefaultCharacterState({ name: 'player', type: 'player' });
  player.location = 'realm central province-city';
  return {
    userInput: input,
    history: [],
    characters: [player],
    worldBooks: [],
    variables: {},
    plotEvents: [],
    memories: [],
    agentOutputs: new Map(),
    gameTime: { ...createDefaultTime(), month: 12, day: 28 },
  };
}
const emptySelector = vi.fn(async () => '{"keep":[],"extra":[]}');
const assemble = (books: WorldBook[], ctx = context(), budgetChars?: number) =>
  buildStoryContextV2Messages({
    ctx,
    worldBooks: books,
    configs: [],
    presets: [],
    windowTurns: 1,
    segments: [],
    archives: [],
    selectLore: emptySelector,
    budgetChars,
  });
const festival: LoreEntryMeta = {
  section: 'turn',
  required: true,
  activation: {
    readWhen: {
      any: [
        {
          locations: ['realm'],
          annualWindow: {
            start: { month: 12, day: 28 },
            end: { month: 12, day: 29 },
            beforeDays: 14,
            afterDays: 7,
          },
        },
        { keywords: ['festival'] },
      ],
    },
  },
};

describe('Story v2 read gates', () => {
  it.each([
    ['realm', 12, 14, '', true],
    ['realm', 1, 6, '', true],
    ['realm', 12, 13, '', false],
    ['realm', 1, 7, '', false],
    ['outside', 12, 28, '', false],
    ['outside', 1, 7, 'festival', true],
    ['realm', 1, 7, 'festival', true],
  ])('location=%s date=%s/%s mention=%s -> %s', async (location, month, day, input, active) => {
    const ctx = context(input);
    ctx.characters[0].location = location;
    ctx.gameTime = { ...ctx.gameTime!, month, day };
    const books = [book([['festival', festival, 'celebration']])];
    const result = await selectStoryLore(books, ctx, emptySelector);
    expect(result.mandatoryKeys.includes('festival')).toBe(active);
    expect(result.zones[5].map((r) => r.key)).toEqual(active ? ['festival'] : []);
    expect(getEntriesForAgent('story', books)).toHaveLength(1); // Legacy is unchanged.
  });

  it.each([
    [1, 15, 1, 15, 1, 1, 1, 22],
    [2, 8, 2, 8, 1, 24, 2, 15],
    [3, 19, 3, 20, 3, 5, 3, 27],
    [5, 12, 5, 14, 4, 28, 5, 21],
    [6, 6, 6, 10, 5, 22, 6, 17],
    [8, 6, 8, 8, 7, 22, 8, 15],
    [9, 8, 9, 14, 8, 24, 9, 21],
    [9, 22, 9, 23, 9, 8, 9, 30],
    [10, 18, 10, 18, 10, 4, 10, 25],
    [10, 29, 10, 30, 10, 15, 11, 7],
    [11, 5, 11, 6, 10, 21, 11, 13],
    [12, 8, 12, 8, 11, 24, 12, 15],
    [12, 14, 12, 14, 11, 30, 12, 21],
    [12, 28, 12, 29, 12, 14, 1, 6],
    [12, 29, 1, 2, 12, 15, 1, 9], // Celebration itself crosses the year.
  ])(
    'calendar window %s/%s through %s/%s has the declared inclusive bounds',
    (sm, sd, em, ed, lm, ld, rm, rd) => {
      const activation = {
        readWhen: {
          any: [
            {
              annualWindow: {
                start: { month: sm, day: sd },
                end: { month: em, day: ed },
                beforeDays: 14,
                afterDays: 7,
              },
            },
          ],
        },
      };
      const left = (lm - 1) * 30 + ld - 1;
      const right = (rm - 1) * 30 + rd - 1;
      for (let day = 0; day < 360; day++) {
        const gameTime = {
          ...createDefaultTime(),
          month: Math.floor(day / 30) + 1,
          day: (day % 30) + 1,
        };
        expect(passesLoreReadWhen(activation, { location: '', recentText: '', gameTime })).toBe(
          left <= right ? day >= left && day <= right : day >= left || day <= right,
        );
      }
    },
  );

  it('recomputes on rollback and includes the whole final day, but not the next midnight', async () => {
    const books = [book([['festival', festival, 'celebration']])];
    const ctx = context();
    ctx.gameTime = { ...ctx.gameTime!, month: 1, day: 6, hour: 23, minute: 59 };
    expect((await selectStoryLore(books, ctx)).zones[5]).toHaveLength(1);
    ctx.gameTime = { ...ctx.gameTime!, day: 7, hour: 0, minute: 0 };
    expect((await selectStoryLore(books, ctx)).zones[5]).toHaveLength(0);
    ctx.gameTime = { ...ctx.gameTime!, day: 6 };
    expect((await selectStoryLore(books, ctx)).zones[5]).toHaveLength(1);
  });

  it('does not self-activate from an injected index, or enter through supplement/dependencies/EJS', async () => {
    const b = book([
      ['index', { section: 'region', activation: { locations: ['realm'] } }, 'festival'],
      ['festival', festival, 'secret celebration'],
      ['dependent', { section: 'fixed', dependsOn: ['festival'] }, 'must be blocked'],
      [
        'reader',
        { section: 'fixed' },
        '<%= lore.get("festival") %>|<%= lore.has("festival") %>|<%= lore.list("test").includes("festival") %>',
      ],
    ]);
    const ctx = context();
    ctx.gameTime = { ...ctx.gameTime!, month: 5, day: 1 };
    const result = await assemble([b], ctx);
    const text = result.messages.map((m) => m.content).join('\n');
    expect(text).toContain('|false|false');
    expect(text).not.toContain('secret celebration');
    expect(text).not.toContain('must be blocked');
    expect(result.diagnostics.loreKeysByZone?.[5]).toEqual([]);
    const failed = await selectStoryLore([b], ctx, async () => {
      throw new Error('offline');
    });
    expect(failed.zones[5]).toEqual([]);
  });

  it('mention is independent of missing date, but never grants permission or enables a source', async () => {
    const b = book([
      ['allowed', festival, 'yes'],
      ['disabled', festival, 'no'],
      ['denied', { ...festival, audiences: [] }, 'no'],
      [
        'excluded',
        { ...festival, activation: { ...festival.activation, excludeKeywords: ['stop'] } },
        'no',
      ],
    ]);
    b.entries[1].enabled = false;
    const ctx = context('festival stop');
    ctx.gameTime = undefined;
    expect((await selectStoryLore([b], ctx)).zones[5].map((r) => r.key)).toEqual(['allowed']);
    ctx.userInput = '';
    expect((await selectStoryLore([b], ctx)).zones[5]).toEqual([]);
  });

  it('uses only current input and the last six conversational messages', async () => {
    const ctx = context();
    ctx.characters[0].location = 'outside';
    ctx.history = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      role: 'assistant' as const,
      content: i === 0 ? 'festival' : 'neutral',
      timestamp: i,
    }));
    const b = book([['festival', festival, 'celebration']]);
    expect((await selectStoryLore([b], ctx)).zones[5]).toEqual([]);
    ctx.history[1].content = 'festival';
    expect((await selectStoryLore([b], ctx)).zones[5]).toHaveLength(1);
  });

  it('activated required lore survives empty selection and budget pruning', async () => {
    const result = await assemble(
      [book([['festival', festival, 'required celebration']])],
      context(),
      1,
    );
    expect(result.messages.map((m) => m.content).join('')).toContain('required celebration');
    expect(result.diagnostics.budgetDroppedLoreKeys).toEqual([]);
  });
});

describe('ST definitions and evaluation lifetime', () => {
  it('unselected and budget-pruned sources still supply fixed macros; source bodies do not leak', async () => {
    const b = book([
      ['rule', { section: 'fixed' }, 'rule={{getvar::advantage}}'],
      ['source', { section: 'turn' }, '{{setvar::advantage::working}}SOURCE_BODY'],
    ]);
    const result = await assemble([b]);
    const text = result.messages.map((m) => m.content).join('');
    expect(result.diagnostics.loreKeysByZone?.[1]).toEqual(['rule']);
    expect(text).toContain('rule=working');
    expect(text).not.toContain('SOURCE_BODY');
    const pruned = await assemble([b], context(), 1);
    expect(pruned.messages.map((m) => m.content).join('')).toContain('rule=working');
  });

  it('keeps fixed EJS rules in zone 1 without freezing their per-turn value', async () => {
    const b = book([['rule', { section: 'fixed' }, '<%= getvar("turn") %>']]);
    const ctx = context();
    ctx.variables.sys = { turn: 1 };
    const first = await assemble([b], ctx);
    ctx.variables.sys.turn = 2;
    const second = await assemble([b], ctx);
    expect(first.diagnostics.loreKeysByZone?.[1]).toEqual(['rule']);
    expect(first.messages.map((m) => m.content).join('')).toContain('1');
    expect(second.messages.map((m) => m.content).join('')).toContain('2');
  });

  it('stable source ordering, explicit empties, permissions and disabled sources', () => {
    const b = book([
      ['first', {}, '{{setvar::x::old}}'],
      ['last', { section: 'turn' }, '{{setvar::x::}}'],
      ['disabled', {}, '{{setvar::x::disabled}}'],
      ['denied', { audiences: [] }, '{{setvar::x::denied}}'],
    ]);
    b.entries[2].enabled = false;
    expect(buildLoreDefinitions('story', [b]).values.x).toBe('');
    expect(buildLoreDefinitions('story', [b]).sources.x).toBe('last');
  });

  it('does not execute or extract conditional definitions from unselected EJS; accepts literal projections', async () => {
    const b = book([
      ['rule', { section: 'fixed' }, '{{getvar::x}}|{{getvar::missing}}'],
      [
        'source',
        { section: 'turn', definitions: { x: 'projected' } },
        '<% throw new Error("must not execute") %>{{setvar::x::wrong}}',
      ],
      ['conditional', { section: 'turn' }, '<% if (false) { %>{{setvar::missing::wrong}}<% } %>'],
    ]);
    const result = await assemble([b]);
    expect(result.messages.map((m) => m.content).join('')).toContain('projected|');
    expect(result.diagnostics.loreDefinitions).toEqual({
      deferredKeys: ['conditional'],
      missing: { rule: ['missing'] },
    });
  });

  it.each([new LegacyBackend(), createQuickJsBackend()])(
    'bridges literal definitions read-only in $name',
    async (backend) => {
      const ctx = {
        stats: { priority: 'stats' },
        vars: { runtime: 'vars' },
        historyText: '',
        stDefinitions: Object.freeze({
          priority: 'ST',
          runtime: 'ST',
          x: 'ST',
          empty: '',
          'literal.key': 'literal',
        }),
      };
      const result = await backend.runPass(
        [
          {
            uid: 1,
            content:
              '<%= getvar("priority") %>|<%= getvar("runtime") %>|<%= getvar("x") %>|<%= getvar("empty", { defaults: "BAD" }) %>|<%= getvar("literal.key") %>|<%= getvar("absent", { defaults: "fallback" }) %><% setvar("x", "changed") %>|<%= getvar("x") %>',
          },
        ],
        ctx,
      );
      expect(result[0].ok).toBe(true);
      expect(result[0].text).toBe('stats|vars|ST||literal|fallback|changed');
      expect(ctx.vars).toEqual({ runtime: 'vars', x: 'changed' });
      expect(ctx.stDefinitions.x).toBe('ST');
    },
  );

  it('does not write ST definitions into an EJS commit draft', () => {
    const ctx = context();
    ctx.ejsVarsDrafts = new Map();
    const pass = buildEjsPassContext(
      'story',
      ctx,
      { agentId: 'story', ejsVarsCommit: true } as never,
      [],
      [book([['definition', {}, '{{setvar::x::ST}}']])],
    );
    expect(pass.stDefinitions?.x).toBe('ST');
    expect(ctx.ejsVarsDrafts.get('story')?.draft).toEqual({});
  });

  it.each([
    ['realm', 12, 28, '', true],
    ['outside', 12, 28, '', false],
    ['realm', 5, 1, '', false],
    ['outside', 5, 1, 'festival', true],
    ['realm', 12, 28, 'festival stop', false],
  ])(
    'opening definitions respect location=%s date=%s/%s mention=%s -> %s',
    (location, month, day, input, readable) => {
      const b = book([
        ['revival', { section: 'fixed', evaluation: 'onCreate' }, '{{getvar::revival}}'],
        [
          'provider',
          {
            ...festival,
            activation: { ...festival.activation, excludeKeywords: ['stop'] },
          },
          '{{setvar::revival::OPENING}}',
        ],
      ]);
      const ctx = context(input);
      ctx.characters[0].location = location;
      ctx.gameTime = { ...ctx.gameTime!, month, day };
      const freeze = () => createFixedLoreSnapshot([b], undefined, createLoreReadContext(ctx));
      if (readable) expect(freeze().revival.text).toBe('OPENING');
      else expect(freeze).toThrow('missing definitions');
    },
  );

  it('does not bypass a gated definition when opening context is omitted', () => {
    const b = book([
      ['revival', { section: 'fixed', evaluation: 'onCreate' }, '{{getvar::revival}}'],
      ['provider', festival, '{{setvar::revival::WINDOW_ONLY}}'],
    ]);
    expect(() => createFixedLoreSnapshot([b])).toThrow('missing definitions');
  });

  it('applies the opening read context to the complete dependency closure', () => {
    const b = book([
      ['revival', { section: 'fixed', evaluation: 'onCreate', dependsOn: ['gated'] }, 'OPENING'],
      ['gated', festival, 'dependency'],
    ]);
    const ctx = context();
    ctx.gameTime = { ...ctx.gameTime!, month: 5, day: 1 };
    expect(createFixedLoreSnapshot([b], undefined, createLoreReadContext(ctx))).toEqual({});
    ctx.userInput = 'festival';
    expect(createFixedLoreSnapshot([b], undefined, createLoreReadContext(ctx)).revival.text).toBe(
      'OPENING',
    );
  });

  it.each([
    '{{setvar::revival::ORIGINAL}}',
    '<% if (true) { %>{{setvar::revival::ORIGINAL}}<% } %>',
  ])('keeps fixed revival live without an opening snapshot: %s', async (coreContent) => {
    const b = book([
      ['revival', { section: 'fixed' }, 'REVIVAL={{getvar::revival}}'],
      ['core-original', { section: 'turn', required: true }, coreContent],
      ['core-changed', { section: 'turn', required: true }, '{{setvar::revival::CHANGED}}'],
    ]);
    b.entries[2].enabled = false;
    const ctx = context();
    for (let turn = 0; turn < 2; turn++) {
      const result = await assemble([b], ctx);
      expect(result.diagnostics.loreKeysByZone?.[1]).toEqual(['revival']);
      expect(result.messages.map((m) => m.content).join('')).toContain('REVIVAL=ORIGINAL');
    }
    b.entries[1].enabled = false;
    b.entries[2].enabled = true;
    const changed = await assemble([b], ctx);
    const text = changed.messages.map((m) => m.content).join('');
    expect(changed.diagnostics.loreKeysByZone?.[1]).toEqual(['revival']);
    expect(text).toContain('REVIVAL=CHANGED');
    expect(text).not.toContain('REVIVAL=ORIGINAL');
    expect(ctx.fixedLore).toBeUndefined();
  });

  it('freezes opening text once, persists through JSON, and still respects the entry read gate', async () => {
    const b = book([
      ['revival', { section: 'fixed', evaluation: 'onCreate' }, '{{getvar::revival}}'],
      ['core', { section: 'turn' }, '{{setvar::revival::ORIGINAL}}'],
      ['reader', { section: 'fixed' }, 'indirect=<%= lore.get("revival") %>'],
    ]);
    const ctx = context();
    ctx.fixedLore = JSON.parse(JSON.stringify(createFixedLoreSnapshot([b])));
    b.entries[1].content = '{{setvar::revival::CHANGED}}';
    b.entries[0].content = '{{getvar::different}}';
    expect((await assemble([b], ctx)).messages.map((m) => m.content).join('')).toContain(
      'indirect=ORIGINAL',
    );
    b.entries[0].enabled = false;
    expect((await assemble([b], ctx)).diagnostics.loreKeysByZone?.[1]).toEqual(['reader']);
  });

  it('never freezes missing/empty definitions or silently initializes during assembly', async () => {
    const b = book([
      ['revival', { section: 'fixed', evaluation: 'onCreate' }, '{{getvar::missing}}'],
    ]);
    expect(() => createFixedLoreSnapshot([b])).toThrow('missing definitions');
    await expect(assemble([b])).rejects.toThrow('Missing opening lore snapshot');
    b.entries[0].extra!.lore!.definitions = { missing: '' };
    expect(() => createFixedLoreSnapshot([b])).toThrow('empty text');
  });

  it('isolates preset definitions from worldbook definitions', async () => {
    const result = await buildStoryContextV2Messages({
      ctx: context(),
      worldBooks: [
        book([
          ['rule', { section: 'fixed' }, 'WORLD_RULE={{getvar::x}}'],
          ['source', { section: 'turn' }, '{{setvar::x::WORLD}}'],
        ]),
      ],
      configs: [{ agentId: 'story', presetId: 'p' } as never],
      presets: [
        {
          id: 'p',
          name: 'p',
          settings: {
            prompts: [
              {
                identifier: 'normal',
                enabled: true,
                content: '{{setvar::x::PRESET}}PRESET_RULE={{getvar::x}}',
              },
            ],
          },
        } as never,
      ],
      windowTurns: 1,
      segments: [],
      archives: [],
      selectLore: emptySelector,
    });
    const text = result.messages.map((m) => m.content).join('');
    expect(text).toContain('PRESET_RULE=PRESET');
    expect(text).toContain('WORLD_RULE=WORLD');
  });

  it('shares worldbook definitions across legacy static/dynamic placeholders, without merging preset scope', async () => {
    const b = book([
      ['definition', {}, '{{setvar::x::WORLD}}'],
      ['rule', {}, '{{getvar::x}}'],
    ]);
    const messages = await buildAgentMessagesAsync(
      'story',
      context(),
      [{ agentId: 'story', template: '{{LORE_BOOK_STATIC}}|{{LORE_BOOK_DYNAMIC}}' } as never],
      [b],
    );
    expect(messages?.map((m) => m.content).join('')).toContain('WORLD');
  });
});

describe('strict lore protocol', () => {
  it('accepts combined read gates and literal definition projections', () => {
    const b = book([
      ['festival', festival, 'body'],
      [
        'fixed',
        { section: 'fixed', evaluation: 'onCreate', definitions: { x: '' } },
        '{{getvar::x}}',
      ],
    ]);
    expect(validateLoreProtocol([b])).toEqual([]);
  });
  it.each([
    { any: [] },
    { any: [{}] },
    { any: [{ locations: [] }] },
    { any: [{ unknown: ['x'] }] },
    {
      any: [
        {
          annualWindow: {
            start: { month: 10, day: 31 },
            end: { month: 11, day: 1 },
            beforeDays: 14,
            afterDays: 7,
          },
        },
      ],
    },
    {
      any: [
        {
          annualWindow: {
            start: { month: 1, day: 1 },
            end: { month: 1, day: 2 },
            beforeDays: -1,
            afterDays: 7,
          },
        },
      ],
    },
  ])('rejects invalid gate %j', (readWhen) => {
    const b = book([['invalid', { activation: { readWhen } } as LoreEntryMeta, 'body']]);
    expect(validateLoreProtocol([b]).join()).toContain('invalid activation.readWhen');
  });
  it('rejects array values that stringify to a valid evaluation mode', () => {
    for (const evaluation of [['perTurn'], ['onCreate']]) {
      const b = book([
        ['invalid', { section: 'fixed', evaluation } as unknown as LoreEntryMeta, 'body'],
      ]);
      expect(validateLoreProtocol([b]).join()).toContain('invalid evaluation');
    }
  });

  it('rejects dynamic onCreate bodies, wrong placement and executable projections', () => {
    const b = book([
      ['dynamic', { section: 'fixed', evaluation: 'onCreate' }, '<%= 1 %>'],
      ['turn', { section: 'turn', evaluation: 'onCreate' }, 'body'],
      ['projection', { definitions: { x: '<%= 1 %>' } }, 'body'],
    ]);
    expect(validateLoreProtocol([b])).toHaveLength(3);
  });
  it('the definition and EJS lookup gates use the same v2 context', () => {
    const b = book([['festival', festival, '{{setvar::secret::no}}']]);
    const ctx = context();
    ctx.gameTime = undefined;
    const read = createLoreReadContext(ctx);
    expect(buildLoreDefinitions('story', [b], '', read).values.secret).toBeUndefined();
    expect(getEntriesForAgent('story', [b], '', read)).toEqual([]);
  });
});
