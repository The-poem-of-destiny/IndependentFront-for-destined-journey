import { describe, it, expect } from 'vitest';
import {
  scanEntityGenRequests,
  scanCharUpdateRequests,
  scanItemUpdateRequests,
  scanCraftGenRequests,
  scanMarkers,
} from '../../../src/core/story/marker-protocol';

describe('scanEntityGenRequests', () => {
  it('should detect a single entity_gen_request tag (character)', () => {
    const text =
      '<entity_gen_request type="character" characterName="汉斯" race="人类" characterType="npc">\n  白曜城铁匠铺主人\n</entity_gen_request>';
    const results = scanEntityGenRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('entity_gen_request');
    expect(results[0].attributes.entityType).toBe('character');
    expect(results[0].attributes.characterName).toBe('汉斯');
    expect(results[0].attributes.race).toBe('人类');
    expect(results[0].attributes.characterType).toBe('npc');
    expect(results[0].bodyText).toContain('铁匠铺');
  });

  it('should detect multiple entity_gen_request tags', () => {
    const text = `
<entity_gen_request type="character" characterName="A" tier="T2">body A</entity_gen_request>
<entity_gen_request type="skill" owner="A">body B</entity_gen_request>
`;
    const results = scanEntityGenRequests(text);
    expect(results).toHaveLength(2);
    expect(results[0].attributes.characterName).toBe('A');
    expect(results[0].attributes.tier).toBe('T2');
    expect(results[1].attributes.entityType).toBe('skill');
    expect(results[1].attributes.owner).toBe('A');
  });

  it('should handle missing optional attributes (type 回落 item)', () => {
    const text = '<entity_gen_request>just body</entity_gen_request>';
    const results = scanEntityGenRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.entityType).toBe('item');
    expect(results[0].attributes.characterName).toBeUndefined();
    expect(results[0].bodyText).toBe('just body');
  });
});

describe('scanCharUpdateRequests', () => {
  it('should detect a char_update_request with target', () => {
    const text = '<char_update_request target="player_1">花费50金币购买长剑</char_update_request>';
    const results = scanCharUpdateRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('char_update_request');
    expect(results[0].attributes.target).toBe('player_1');
    expect(results[0].bodyText).toBe('花费50金币购买长剑');
  });
});

describe('scanItemUpdateRequests', () => {
  it('should detect a consume operation', () => {
    const text =
      '<item_update_request target="治疗药水" operation="consume" quantity="1" owner="player_1">用掉一瓶</item_update_request>';
    const results = scanItemUpdateRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.operation).toBe('consume');
    expect(results[0].attributes.quantity).toBe('1');
    expect(results[0].attributes.target).toBe('治疗药水');
  });

  it('should detect equip operation', () => {
    const text =
      '<item_update_request target="铁剑" operation="equip" owner="player_1">装备铁剑</item_update_request>';
    const results = scanItemUpdateRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].attributes.operation).toBe('equip');
    expect(results[0].attributes.target).toBe('铁剑');
  });
});

describe('scanCraftGenRequests', () => {
  it('should detect a craft_gen_request', () => {
    const text =
      '<craft_gen_request characterId="player_1" industry="锻造" productName="长剑" targetQuality="稀有">使用铁矿石x3和皮革x1</craft_gen_request>';
    const results = scanCraftGenRequests(text);
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('craft_gen_request');
    expect(results[0].attributes.characterId).toBe('player_1');
    expect(results[0].attributes.industry).toBe('锻造');
    expect(results[0].attributes.productName).toBe('长剑');
    expect(results[0].bodyText).toBe('使用铁矿石x3和皮革x1');
  });
});

describe('scanMarkers with new vars_update format', () => {
  it('should scan mixed old and new tags', () => {
    const text = `
<entity_gen_request type="character" characterName="NPC">body</entity_gen_request>
<craft_request characterId="p1" industry="锻造">craft body</craft_request>
<item_update_request target="药水" operation="consume">body</item_update_request>
`;
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(3);
    // cleanText should strip all markers
    expect(result.cleanText).not.toContain('<entity_gen_request');
    expect(result.cleanText).not.toContain('<craft_request');
    expect(result.cleanText).not.toContain('<item_update_request');
  });

  it('should produce cleanText with vars_update JSON-like format', () => {
    const text =
      '<json>{"delta_time": 30}</json>\n<entity_gen_request type="character" characterName="汉斯">铁匠铺主人</entity_gen_request>\n<item_update_request target="药水" operation="consume">用掉一瓶</item_update_request>';
    const result = scanMarkers(text);
    // <json> is NOT in MARKER_TAGS, so it's not stripped by scanMarkers
    // It's handled separately in the orchestrator via regex
    expect(result.markers).toHaveLength(2); // entity_gen_request + item_update_request only
  });
});
