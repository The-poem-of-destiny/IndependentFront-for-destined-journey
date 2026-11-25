import { describe, expect, it } from 'vitest';
import {
  attachCharacterDefinition,
  characterAssetRows,
  legacyCharacterDefinitions,
  characterLoreEntryUids,
  linkCharacterDefinitions,
  prepareTurnCharacterDefinitions,
  readCharacterDefinitions,
  resolveCharacterLoreLinks,
} from '../../../src/core/character/character-definitions';
import { createDefaultCharacterState } from '../../../src/core/types/types';
import type { AssetMetaRecord, WorldBook } from '../../../src/core/types/types';

describe('native character definitions', () => {
  it('reads independent definitions and preserves explicit asset links and approximate past', () => {
    const definitions = readCharacterDefinitions([
      {
        id: 'guide',
        name: '向导',
        profile: { background: '来自河谷', aliases: ['渡口向导'] },
        assets: [{ type: '立绘', assetId: 'portrait' }],
        past: [
          {
            title: '离乡',
            summary: '离开河谷。',
            importance: 8,
            time: { kind: 'past', label: '多年前' },
          },
        ],
      },
    ]);
    const character = attachCharacterDefinition(
      createDefaultCharacterState({ name: '向导', background: '已在本档改变' }),
      definitions[0],
    );
    expect(character.background).toBe('已在本档改变');
    character.definition!.profile.background = '副本';
    expect(definitions[0].profile.background).toBe('来自河谷');
    expect(
      characterAssetRows(definitions[0], [
        { id: 'portrait', name: '旧名字', type: '立绘' } as AssetMetaRecord,
      ])[0].id,
    ).toBe('portrait');
  });
  it('only removes positively converted lore, extracts assets without executing EJS', () => {
    const book = {
      id: 'characters',
      partition: 'character',
      entries: [
        {
          uid: 'fated:character/guide',
          enabled: true,
          content: `来自河谷的向导。<%# char-info-ejs-builder:start:v3 %><% const profile = {"characterName":"向导","avatarUrl":"https://example.com/guide.png"}; throw new Error('must not execute'); %><%# char-info-ejs-builder:end %>`,
        },
        { uid: 'fated:character/dynamic', enabled: true, content: '<% dynamicProfile() %>' },
        {
          uid: 'fated:character/secret',
          enabled: true,
          content: `<% if (revealed) { %>秘密身世<% } %><%# char-info-ejs-builder:start %><% const profile = {"characterName":"秘密角色","avatarUrl":"https://example.com/secret.png"}; %><%# char-info-ejs-builder:end %>`,
        },
      ],
    } as WorldBook;
    const definitions = legacyCharacterDefinitions([book]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].assets[0].url).toBe('https://example.com/guide.png');
    expect(definitions[0].lore).toBe('来自河谷的向导。');
    expect(definitions[0].legacyEntry).toEqual({
      bookId: 'characters',
      uid: 'fated:character/guide',
      token: 'fated:character/guide',
    });
    // 条目仍是给模型的人设：转换只建目录并链接，不把条目从书里拿掉
    expect(definitions[0].loreEntry).toBe('fated:character/guide');
    expect(resolveCharacterLoreLinks(definitions, [book])[0].loreEntry).toBe(
      'fated:character/guide',
    );
    expect(book.entries).toHaveLength(3);
  });
});

describe('character lore entry links', () => {
  const book = (uids: string[]) =>
    ({
      id: 'character',
      partition: 'character',
      entries: uids.map((uid) => ({ uid, enabled: true, content: '人设' })),
    }) as unknown as WorldBook;
  const definition = (id: string, extra: Record<string, unknown> = {}) =>
    readCharacterDefinitions([{ id, name: id, profile: {}, assets: [], past: [], ...extra }])[0];

  it('reads an explicit loreEntry and ignores blank links', () => {
    expect(definition('a', { loreEntry: ' fated:character/a ' }).loreEntry).toBe(
      'fated:character/a',
    );
    expect(definition('b', { loreEntry: '  ' }).loreEntry).toBeUndefined();
  });

  it('links frozen definitions via legacyEntry or the registry definition with the same id', () => {
    const frozen = [
      definition('hassan'),
      {
        ...definition('muir'),
        legacyEntry: { bookId: 'character', uid: 'fated:character/muir', token: 'x' },
      },
      definition('stranger'),
    ];
    const linked = linkCharacterDefinitions(frozen, [
      definition('hassan', { loreEntry: 'fated:character/hassan' }),
    ]);
    expect(linked.map((d) => d.loreEntry)).toEqual([
      'fated:character/hassan',
      'fated:character/muir',
      undefined,
    ]);
    expect(frozen[0].loreEntry).toBeUndefined();
    expect(characterLoreEntryUids(linked)).toEqual([
      'fated:character/hassan',
      'fated:character/muir',
    ]);
  });

  it('drops links to entries that are not loaded so the fallback lore still applies', () => {
    const [kept, dropped] = resolveCharacterLoreLinks(
      [
        definition('a', { loreEntry: 'fated:character/a', lore: '兜底' }),
        definition('b', { loreEntry: 'fated:character/b', lore: '兜底' }),
      ],
      [book(['fated:character/a'])],
    );
    expect(kept.loreEntry).toBe('fated:character/a');
    expect(dropped.loreEntry).toBeUndefined();
    expect(dropped.lore).toBe('兜底');
  });
});

describe('露骨内容开关下给模型的角色定义投影（A11 回归）', () => {
  const definition = (id: string, extra: Record<string, unknown> = {}) =>
    readCharacterDefinitions([{ id, name: id, profile: {}, assets: [], past: [], ...extra }])[0];
  const rawBook = {
    id: 'character',
    partition: 'character',
    entries: [
      { uid: 'fated:character/safe', enabled: true, content: '人设' },
      {
        uid: 'fated:character/explicit',
        enabled: true,
        content: '露骨人设',
        extra: { lore: { nsfw: true } },
      },
    ],
  } as unknown as WorldBook;
  // 开关关时游戏侧拿到的书：整条标记条目已被 filterNsfwBooks 剔除
  const filteredBook = { ...rawBook, entries: [rawBook.entries[0]] } as WorldBook;
  const frozen = () => [
    definition('safe', { loreEntry: 'fated:character/safe', lore: '安全兜底' }),
    definition('whole', { nsfw: true, lore: '整条露骨角色' }),
    definition('linked', { loreEntry: 'fated:character/explicit', lore: '露骨兜底原文' }),
    definition('gone', {
      loreEntry: 'fated:character/missing',
      lore: '前文<nsfw>露骨段</nsfw><sfw>净版</sfw>后文',
    }),
  ];

  it('开关关：整条 nsfw 角色不进定义、因露骨被剔的链接不回落 lore、其余回落 lore 过滤', () => {
    const input = frozen();
    const snapshot = structuredClone(input);
    const out = resolveCharacterLoreLinks(input, [filteredBook], {
      enabled: false,
      sourceBooks: [rawBook],
    });
    expect(out.map((d) => d.id)).toEqual(['safe', 'linked', 'gone']);
    expect(out[0]).toBe(input[0]);
    expect(out[1].loreEntry).toBeUndefined();
    expect(out[1].lore).toBeUndefined();
    expect(out[2].loreEntry).toBeUndefined();
    expect(out[2].lore).toBe('前文净版后文');
    // 只在使用时投影，不改入参（冻结定义原样，永不写回）
    expect(input).toEqual(snapshot);
  });

  it('旧档首轮冻结：开关关时也用过滤前的书现转，冻结份含露骨角色、给模型的份不含', () => {
    const profileBlock = (name: string) =>
      `<%# char-info-ejs-builder:start %><% const profile = {"characterName":"${name}","avatarUrl":"https://example.com/${name}.png"}; %><%# char-info-ejs-builder:end %>`;
    const legacyRaw = {
      id: 'characters',
      partition: 'character',
      entries: [
        { uid: 'fated:character/a', enabled: true, content: `甲的人设。${profileBlock('甲')}` },
        {
          uid: 'fated:character/b',
          enabled: true,
          content: `乙的露骨人设。${profileBlock('乙')}`,
          extra: { lore: { nsfw: true } },
        },
      ],
    } as unknown as WorldBook;
    const legacyFiltered = { ...legacyRaw, entries: [legacyRaw.entries[0]] } as WorldBook;

    const off = prepareTurnCharacterDefinitions({
      frozen: undefined,
      books: [legacyFiltered],
      sourceBooks: [legacyRaw],
      nsfwEnabled: false,
    });
    // 冻结份与开关无关：两个角色都在，链接按过滤前的书保留
    expect(off.toFreeze.map((d) => d.name)).toEqual(['甲', '乙']);
    expect(off.toFreeze[1].loreEntry).toBe('fated:character/b');
    expect(off.toFreeze[1].nsfw).toBe(true);
    // 给模型的份按开关投影
    expect(off.forModel.map((d) => d.name)).toEqual(['甲']);

    // 开关开时冻结份与关时相同（开关状态没写进存档）
    const on = prepareTurnCharacterDefinitions({
      frozen: undefined,
      books: [legacyRaw],
      nsfwEnabled: true,
    });
    expect(on.toFreeze).toEqual(off.toFreeze);
    expect(on.forModel).toEqual(on.toFreeze);

    // 已有冻结定义时原样沿用，不再现转
    const frozen = [definition('kept')];
    expect(
      prepareTurnCharacterDefinitions({
        frozen,
        books: [legacyFiltered],
        sourceBooks: [legacyRaw],
        nsfwEnabled: false,
      }).toFreeze.map((d) => d.id),
    ).toEqual(['kept']);
  });

  it('开关开：与不传开关时逐项相同（行为不变）', () => {
    const books = [rawBook];
    const plain = resolveCharacterLoreLinks(frozen(), books);
    expect(resolveCharacterLoreLinks(frozen(), books, { enabled: true })).toEqual(plain);
    expect(plain.map((d) => d.id)).toEqual(['safe', 'whole', 'linked', 'gone']);
    expect(plain[3].lore).toBe('前文<nsfw>露骨段</nsfw><sfw>净版</sfw>后文');
  });
});
