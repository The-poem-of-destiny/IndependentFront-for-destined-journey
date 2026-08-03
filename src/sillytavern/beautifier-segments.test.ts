/**
 * Beautifier segment compiler interface tests.
 */
import { describe, expect, it } from 'vitest';
import bundledRulesJson from '../../data/defaults/beautifier-rules.json?raw';
import {
  compileBeautifierSegments,
  serializeBeautifierSegments,
  type BeautifierMatchSegment,
} from './beautifier';
import type { BeautifierRule } from './types';

function activeRule(over: Partial<BeautifierRule> = {}): BeautifierRule {
  return {
    id: 'rule',
    name: 'rule',
    scope: 'maintext',
    pattern: 'x',
    flags: 'g',
    replacement: 'y',
    enabled: true,
    order: 0,
    isBuiltin: false,
    ...over,
  };
}

function matches(segments: ReturnType<typeof compileBeautifierSegments>): BeautifierMatchSegment[] {
  return segments.filter((segment): segment is BeautifierMatchSegment => segment.kind === 'match');
}

describe('compileBeautifierSegments', () => {
  it('retains duplicate rich matches as distinct stable occurrences', () => {
    const segments = compileBeautifierSegments(
      'before <card>A</card> middle <card>A</card> after',
      'maintext',
      [
        activeRule({
          id: 'card',
          name: 'Card',
          pattern: '<card>(.*?)<\\/card>',
          replacement: '<div class="card">$1</div>',
        }),
      ],
    );

    expect(segments).toEqual([
      { kind: 'text', text: 'before ' },
      {
        kind: 'match',
        ruleId: 'card',
        ruleName: 'Card',
        origin: 'rule',
        occurrence: 0,
        source: '<card>A</card>',
        captures: ['A'],
        replacement: '<div class="card">A</div>',
      },
      { kind: 'text', text: ' middle ' },
      {
        kind: 'match',
        ruleId: 'card',
        ruleName: 'Card',
        origin: 'rule',
        occurrence: 1,
        source: '<card>A</card>',
        captures: ['A'],
        replacement: '<div class="card">A</div>',
      },
      { kind: 'text', text: ' after' },
    ]);
  });

  it('keeps raw captures and applies native replacement semantics inside the isolated renderer', () => {
    const [match] = matches(
      compileBeautifierSegments('<card><img src=x onerror=alert(1)></card>', 'maintext', [
        activeRule({
          pattern: '<card>([\\s\\S]*?)<\\/card>',
          replacement: '<div>$1</div>',
        }),
      ]),
    );

    expect(match.captures).toEqual(['<img src=x onerror=alert(1)>']);
    expect(match.replacement).toBe('<div><img src=x onerror=alert(1)></div>');
  });

  it('supports double-digit and special JavaScript replacement tokens', () => {
    const [match] = matches(
      compileBeautifierSegments('prefix [a|b|c] suffix', 'maintext', [
        activeRule({
          pattern: '\\[([^|]+)\\|([^|]+)\\|([^\\]]+)\\]',
          replacement: "$3/$2/$1/$12/$$/$&/$`/$'",
        }),
      ]),
    );

    expect(match.replacement).toBe('c/b/a/a2/$/[a|b|c]/prefix / suffix');
  });

  it('expands multi-digit capture references without treating $10 as $1 plus text', () => {
    const [match] = matches(
      compileBeautifierSegments('abcdefghij', 'maintext', [
        activeRule({
          pattern: '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)',
          replacement: '$10|$1|$9',
        }),
      ]),
    );

    expect(match.captures).toHaveLength(10);
    expect(match.replacement).toBe('j|a|i');
  });

  it('retains every global deletion occurrence while serialization removes it', () => {
    const segments = compileBeautifierSegments('A drop B drop C', 'maintext', [
      activeRule({ id: 'delete', pattern: 'drop', replacement: '' }),
    ]);

    expect(
      matches(segments).map(({ occurrence, replacement }) => ({ occurrence, replacement })),
    ).toEqual([
      { occurrence: 0, replacement: '' },
      { occurrence: 1, replacement: '' },
    ]);
    expect(serializeBeautifierSegments(segments)).toBe('A  B  C');
  });

  it.each([
    { depth: 0, applies: false },
    { depth: 1, applies: true },
    { depth: 2, applies: true },
    { depth: 3, applies: true },
    { depth: 4, applies: false },
  ])('applies inclusive depth bounds at depth $depth', ({ depth, applies }) => {
    const segments = compileBeautifierSegments(
      'x',
      'maintext',
      [activeRule({ replacement: '<b>bounded</b>', minDepth: 1, maxDepth: 3 })],
      { depth },
    );

    expect(matches(segments).length > 0).toBe(applies);
  });

  it('keeps unbounded rules active at arbitrary history depth', () => {
    const segments = compileBeautifierSegments(
      'x',
      'maintext',
      [activeRule({ replacement: '<b>unbounded</b>' })],
      { depth: 999 },
    );

    expect(matches(segments)).toHaveLength(1);
  });

  it('skips invalid regular expressions without losing unmatched text', () => {
    const segments = compileBeautifierSegments('<unmatched>', 'maintext', [
      activeRule({ pattern: '[', replacement: '<b>broken</b>' }),
    ]);

    expect(segments).toEqual([{ kind: 'text', text: '<unmatched>' }]);
    expect(serializeBeautifierSegments(segments)).toBe('&lt;unmatched&gt;');
  });

  it('applies rules by order and never runs later rules inside a prior replacement', () => {
    const segments = compileBeautifierSegments('TOKEN', 'maintext', [
      activeRule({
        id: 'later',
        name: 'Later',
        pattern: 'LOW',
        replacement: '<i>late</i>',
        order: 2,
      }),
      activeRule({
        id: 'first',
        name: 'First',
        pattern: 'TOKEN',
        replacement: '<b>LOW</b>',
        order: 1,
      }),
    ]);

    expect(matches(segments)).toHaveLength(1);
    expect(matches(segments)[0]).toMatchObject({ ruleId: 'first', replacement: '<b>LOW</b>' });
    expect(serializeBeautifierSegments(segments)).toBe('<b>LOW</b>');
  });

  it('keeps whole-input anchor semantics after an earlier rule creates protected segments', () => {
    const startAnchored = compileBeautifierSegments('AB', 'maintext', [
      activeRule({ id: 'first', pattern: 'A', replacement: '<b>A</b>', order: 1 }),
      activeRule({ id: 'anchored', pattern: '^B', replacement: 'wrong', order: 2 }),
    ]);
    const endAnchored = compileBeautifierSegments('BA', 'maintext', [
      activeRule({ id: 'first', pattern: 'A', replacement: '<b>A</b>', order: 1 }),
      activeRule({ id: 'anchored', pattern: 'B$', replacement: 'wrong', order: 2 }),
    ]);

    expect(serializeBeautifierSegments(startAnchored)).toBe('<b>A</b>B');
    expect(serializeBeautifierSegments(endAnchored)).toBe('B<b>A</b>');
    expect(matches(startAnchored).map(({ ruleId }) => ruleId)).toEqual(['first']);
    expect(matches(endAnchored).map(({ ruleId }) => ruleId)).toEqual(['first']);
  });

  it('preserves item_info/task_info as rich synthetic matches without filtering their markup', () => {
    const source =
      'before<item_info><style>.x{color:red}</style><script>probe()</script>' +
      '<svg><circle /></svg><audio src="track.mp3"></audio></item_info>' +
      '<task_info><div>quest</div></task_info>after';
    const segments = compileBeautifierSegments(source, 'maintext', []);
    const rich = matches(segments);

    expect(rich.map(({ ruleId, occurrence }) => ({ ruleId, occurrence }))).toEqual([
      { ruleId: 'builtin:item_info', occurrence: 0 },
      { ruleId: 'builtin:task_info', occurrence: 0 },
    ]);
    // 卡片来自模型输出，不是用户装过的规则 —— 渲染面据此关掉脚本面（见 BeautifiedNarrative）。
    expect(rich.map(({ origin }) => origin)).toEqual(['model', 'model']);
    expect(rich[0].replacement).toContain('<style>.x{color:red}</style>');
    expect(rich[0].replacement).toContain('<script>probe()</script>');
    expect(rich[0].replacement).toContain('<svg><circle /></svg>');
    expect(rich[0].replacement).toContain('<audio src="track.mp3"></audio>');
    expect(serializeBeautifierSegments(segments)).toContain(
      '<div class="st-card st-item_info"><style>.x{color:red}</style>',
    );
  });

  it('bounds overlap retries so a greedy rule cannot pin the render thread', () => {
    // 先让一条规则在正文**末尾**留下一个不可穿透的占位片段，再让一条贪婪规则去匹配。
    // `a[\s\S]*` 每次都会一路吃到投影末尾（越过文本范围尾），于是退一格重来 ——
    // 没有封顶的话就是 200k 次 exec × 每次扫 200k 字符。
    const filler = 'a'.repeat(200000);
    const source = `${filler}<mark>x</mark>`;
    const rules = [
      activeRule({ id: 'first', pattern: '<mark>x</mark>', replacement: '<b>x</b>', order: 1 }),
      activeRule({ id: 'greedy', pattern: 'a[\\s\\S]*', replacement: 'never', order: 2 }),
    ];

    const started = Date.now();
    const segments = compileBeautifierSegments(source, 'maintext', rules);
    const elapsed = Date.now() - started;

    // 贪婪规则一处都不该命中，正文与前一条规则的替换都要原样保留。
    expect(matches(segments).map(({ ruleId }) => ruleId)).toEqual(['first']);
    expect(serializeBeautifierSegments(segments)).toBe(`${filler}<b>x</b>`);
    expect(elapsed).toBeLessThan(2000);
  });

  it('retains all 22 bundled replacement structures byte-for-byte', () => {
    const payload = JSON.parse(bundledRulesJson) as {
      rules: Array<{ id: string; name: string; replacement: string }>;
    };
    expect(payload.rules).toHaveLength(22);

    const rules = payload.rules.map((bundled, index) =>
      activeRule({
        id: bundled.id,
        name: bundled.name,
        pattern: `__BUNDLED_${index}__`,
        replacement: bundled.replacement,
        order: index,
      }),
    );
    const input = rules.map((_, index) => `__BUNDLED_${index}__`).join('|');
    const compiled = matches(compileBeautifierSegments(input, 'maintext', rules));

    expect(compiled).toHaveLength(22);
    compiled.forEach((segment, index) => {
      expect(segment.ruleId).toBe(payload.rules[index].id);
      expect(segment.replacement).toBe(payload.rules[index].replacement);
    });
    expect(compiled.some(({ replacement }) => replacement.includes('<style>'))).toBe(true);
    expect(compiled.some(({ replacement }) => replacement.includes('<script>'))).toBe(true);
    expect(compiled.some(({ replacement }) => replacement.includes('<svg'))).toBe(true);
    expect(
      compiled.some(
        ({ replacement }) => replacement.includes('<audio') || replacement.includes('<img'),
      ),
    ).toBe(true);
  });
});
