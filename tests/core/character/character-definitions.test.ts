import { describe, expect, it } from 'vitest';
import {
  attachCharacterDefinition,
  characterAssetRows,
  legacyCharacterDefinitions,
  readCharacterDefinitions,
  withoutCharacterLore,
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
          uid: 1,
          enabled: true,
          content: `来自河谷的向导。<%# char-info-ejs-builder:start:v3 %><% const profile = {"characterName":"向导","avatarUrl":"https://example.com/guide.png"}; throw new Error('must not execute'); %><%# char-info-ejs-builder:end %>`,
        },
        { uid: 2, enabled: true, content: '<% dynamicProfile() %>' },
        {
          uid: 3,
          enabled: true,
          content: `<% if (revealed) { %>秘密身世<% } %><%# char-info-ejs-builder:start %><% const profile = {"characterName":"秘密角色","avatarUrl":"https://example.com/secret.png"}; %><%# char-info-ejs-builder:end %>`,
        },
      ],
    } as WorldBook;
    const definitions = legacyCharacterDefinitions([book]);
    expect(definitions).toHaveLength(1);
    expect(definitions[0].assets[0].url).toBe('https://example.com/guide.png');
    expect(definitions[0].lore).toBe('来自河谷的向导。');
    expect(withoutCharacterLore([book], definitions)[0].entries.map((e) => e.uid)).toEqual([2, 3]);
    expect(book.entries).toHaveLength(3);
  });
});
