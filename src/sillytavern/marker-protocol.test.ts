/**
 * marker-protocol.test.ts — Marker Protocol 标记检测测试
 *
 * Phase 6e: 测试 scanMarkers / scanCraftRequests / scanCombatTriggers /
 * scanCharDetects / classifyMarker / stripMarkers / parseTagAttributes / isMarkerTag
 */

import { describe, it, expect } from 'vitest';
import {
  scanMarkers,
  scanCraftRequests,
  scanCombatTriggers,
  scanCharDetects,
  classifyMarker,
  stripMarkers,
  parseTagAttributes,
  isMarkerTag,
  MARKER_TAGS,
  MARKER_TAG_SET,
} from './marker-protocol';

// ========== isMarkerTag ==========

describe('isMarkerTag', () => {
  it('应识别 craft_request 为标记标签', () => {
    expect(isMarkerTag('craft_request')).toBe(true);
  });

  it('应识别 combat_trigger 为标记标签', () => {
    expect(isMarkerTag('combat_trigger')).toBe(true);
  });

  it('应识别 char_detect 为标记标签', () => {
    expect(isMarkerTag('char_detect')).toBe(true);
  });

  it('普通 XML 标签不应识别为标记标签', () => {
    expect(isMarkerTag('maintext')).toBe(false);
    expect(isMarkerTag('thinking')).toBe(false);
    expect(isMarkerTag('option')).toBe(false);
  });

  it('空字符串不应识别为标记标签', () => {
    expect(isMarkerTag('')).toBe(false);
  });

  it('未知标签不应识别为标记标签', () => {
    expect(isMarkerTag('unknown_tag')).toBe(false);
  });
});

// ========== classifyMarker ==========

describe('classifyMarker', () => {
  it('应将 craft_request 映射到正确类型', () => {
    expect(classifyMarker('craft_request')).toBe('craft_request');
  });

  it('应将 combat_trigger 映射到正确类型', () => {
    expect(classifyMarker('combat_trigger')).toBe('combat_trigger');
  });

  it('应将 char_detect 映射到正确类型', () => {
    expect(classifyMarker('char_detect')).toBe('char_detect');
  });

  it('未知标签应返回 null', () => {
    expect(classifyMarker('maintext')).toBeNull();
    expect(classifyMarker('')).toBeNull();
    expect(classifyMarker('unknown')).toBeNull();
  });
});

// ========== parseTagAttributes ==========

describe('parseTagAttributes', () => {
  it('应解析单个属性', () => {
    const result = parseTagAttributes('characterId="alice"');
    expect(result).toEqual({ characterId: 'alice' });
  });

  it('应解析多个属性', () => {
    const result = parseTagAttributes('industry="锻造" productName="长剑" targetQuality="稀有"');
    expect(result).toEqual({
      industry: '锻造',
      productName: '长剑',
      targetQuality: '稀有',
    });
  });

  it('应支持单引号属性值', () => {
    const result = parseTagAttributes("combatType='死斗' environment='地下迷宫'");
    expect(result).toEqual({
      combatType: '死斗',
      environment: '地下迷宫',
    });
  });

  it('应处理空字符串', () => {
    const result = parseTagAttributes('');
    expect(result).toEqual({});
  });

  it('应处理仅空格的字符串', () => {
    const result = parseTagAttributes('   ');
    expect(result).toEqual({});
  });

  it('应忽略格式不正确的属性', () => {
    const result = parseTagAttributes('valid="yes" invalid broken="partial');
    expect(result).toEqual({ valid: 'yes' });
  });
});

// ========== scanCraftRequests ==========

describe('scanCraftRequests', () => {
  it('应检测无属性的基本 craft_request', () => {
    const text = '<craft_request>制作一把长剑</craft_request>';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe('craft_request');
    expect(markers[0].bodyText).toBe('制作一把长剑');
    expect(markers[0].position).toBe(0);
  });

  it('应解析带属性的 craft_request', () => {
    const text = '<craft_request industry="锻造" productName="长剑" targetQuality="稀有">需要精炼铁矿石</craft_request>';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].industry).toBe('锻造');
    expect(markers[0].productName).toBe('长剑');
    expect(markers[0].targetQuality).toBe('稀有');
    expect(markers[0].bodyText).toBe('需要精炼铁矿石');
  });

  it('应检测多行 body 的 craft_request', () => {
    const text = '<craft_request characterId="player">\n制作一把附魔长剑\n需要用龙血淬火\n</craft_request>';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].characterId).toBe('player');
    expect(markers[0].bodyText).toContain('制作一把附魔长剑');
    expect(markers[0].bodyText).toContain('龙血淬火');
  });

  it('应检测多个 craft_request', () => {
    const text = '<craft_request>第一件</craft_request>中间的文本<craft_request>第二件</craft_request>';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(2);
    expect(markers[0].bodyText).toBe('第一件');
    expect(markers[1].bodyText).toBe('第二件');
    expect(markers[0].position).toBeLessThan(markers[1].position);
  });

  it('空文本应返回空数组', () => {
    expect(scanCraftRequests('')).toHaveLength(0);
  });

  it('无匹配时应返回空数组', () => {
    expect(scanCraftRequests('普通正文无标记')).toHaveLength(0);
  });

  it('畸形 XML (无闭合标签) 应被忽略', () => {
    const text = '<craft_request>没有闭合标签';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(0);
  });

  it('非标记 XML 标签应不被误检测', () => {
    const text = '<maintext>这是正文内容</maintext>';
    const markers = scanCraftRequests(text);
    expect(markers).toHaveLength(0);
  });
});

// ========== scanCombatTriggers ==========

describe('scanCombatTriggers', () => {
  it('应检测基本的 combat_trigger', () => {
    const text = '<combat_trigger>三个哥布林从暗处跳出</combat_trigger>';
    const markers = scanCombatTriggers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe('combat_trigger');
    expect(markers[0].bodyText).toBe('三个哥布林从暗处跳出');
  });

  it('应解析带属性的 combat_trigger', () => {
    const text = '<combat_trigger combatType="死斗" environment="地下迷宫">Boss 战</combat_trigger>';
    const markers = scanCombatTriggers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].combatType).toBe('死斗');
    expect(markers[0].environment).toBe('地下迷宫');
  });

  it('空 combat_trigger body 应能检测', () => {
    const text = '<combat_trigger></combat_trigger>';
    const markers = scanCombatTriggers(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].bodyText).toBeUndefined();
  });

  it('应检测多个 combat_trigger', () => {
    const text = '<combat_trigger>第一波</combat_trigger><combat_trigger>第二波</combat_trigger>';
    const markers = scanCombatTriggers(text);
    expect(markers).toHaveLength(2);
  });
});

// ========== scanCharDetects ==========

describe('scanCharDetects', () => {
  it('应检测基本的 char_detect', () => {
    const text = '<char_detect>一个银发少女走进酒馆</char_detect>';
    const markers = scanCharDetects(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].type).toBe('char_detect');
    expect(markers[0].bodyText).toBe('一个银发少女走进酒馆');
  });

  it('应解析带属性的 char_detect', () => {
    const text = '<char_detect characterName="艾琳" characterType="npc">银发精灵弓箭手</char_detect>';
    const markers = scanCharDetects(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].characterName).toBe('艾琳');
    expect(markers[0].characterType).toBe('npc');
    expect(markers[0].bodyText).toBe('银发精灵弓箭手');
  });

  it('应支持 monster 类型', () => {
    const text = '<char_detect characterType="monster">巨型蜘蛛</char_detect>';
    const markers = scanCharDetects(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].characterType).toBe('monster');
  });

  it('应支持 summon 类型', () => {
    const text = '<char_detect characterType="summon">火元素</char_detect>';
    const markers = scanCharDetects(text);
    expect(markers).toHaveLength(1);
    expect(markers[0].characterType).toBe('summon');
  });
});

// ========== scanMarkers (集成) ==========

describe('scanMarkers', () => {
  it('空文本应返回空标记和空 cleanText', () => {
    const result = scanMarkers('');
    expect(result.markers).toHaveLength(0);
    expect(result.cleanText).toBe('');
  });

  it('无标记文本应返回空标记和原文本', () => {
    const text = '这是普通正文，没有任何标记。';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(0);
    expect(result.cleanText).toBe(text);
  });

  it('应检测并剥离单个 craft_request', () => {
    const text = '正文开始<craft_request>制作物品</craft_request>正文结束';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].type).toBe('craft_request');
    expect(result.cleanText).toBe('正文开始正文结束');
  });

  it('应检测并剥离单个 combat_trigger', () => {
    const text = '敌人出现！<combat_trigger combatType="标准">战斗场景</combat_trigger>准备战斗';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].type).toBe('combat_trigger');
    expect(result.cleanText).toBe('敌人出现！准备战斗');
  });

  it('应检测并剥离单个 char_detect', () => {
    const text = '遇到了新朋友<char_detect characterName="小明">描述</char_detect>很开心';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(1);
    expect(result.markers[0].type).toBe('char_detect');
    expect(result.cleanText).toBe('遇到了新朋友很开心');
  });

  it('应检测多种标记并按位置排序', () => {
    const text =
      '<craft_request>制作</craft_request>中间<char_detect>新角色</char_detect>后面<combat_trigger>战斗</combat_trigger>';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(3);
    expect(result.markers[0].type).toBe('craft_request');
    expect(result.markers[1].type).toBe('char_detect');
    expect(result.markers[2].type).toBe('combat_trigger');
    // 验证按位置排序
    for (let i = 1; i < result.markers.length; i++) {
      expect(result.markers[i].position).toBeGreaterThanOrEqual(result.markers[i - 1].position);
    }
  });

  it('cleanText 应保留非标记 XML 标签', () => {
    const text = '<thinking>思考中</thinking><maintext>正文<craft_request>制作</craft_request>继续</maintext>';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(1);
    expect(result.cleanText).toBe('<thinking>思考中</thinking><maintext>正文继续</maintext>');
  });

  it('cleanText 应正确剥离所有标记', () => {
    const text =
      '前面<char_detect characterName="A">角色A</char_detect>中间<craft_request industry="锻造">物品</craft_request>后面';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(2);
    expect(result.cleanText).toBe('前面中间后面');
  });

  it('应处理同一类型多个标记', () => {
    const text = '<craft_request>第一件</craft_request>和<craft_request>第二件</craft_request>';
    const result = scanMarkers(text);
    expect(result.markers).toHaveLength(2);
    expect(result.markers[0].type).toBe('craft_request');
    expect(result.markers[1].type).toBe('craft_request');
    expect(result.cleanText).toBe('和');
  });
});

// ========== stripMarkers ==========

describe('stripMarkers', () => {
  it('应剥离所有标记返回纯文本', () => {
    const text = '开头<craft_request>制作</craft_request>中间<combat_trigger>战斗</combat_trigger>结尾';
    const result = stripMarkers(text);
    expect(result).toBe('开头中间结尾');
  });

  it('无标记文本应返回原文', () => {
    const text = '普通正文无标记';
    expect(stripMarkers(text)).toBe(text);
  });

  it('空文本应返回空字符串', () => {
    expect(stripMarkers('')).toBe('');
  });
});

// ========== MARKER_TAGS 常量 ==========

describe('MARKER_TAGS', () => {
  it('应包含三种标记类型', () => {
    expect(MARKER_TAGS).toContain('craft_request');
    expect(MARKER_TAGS).toContain('combat_trigger');
    expect(MARKER_TAGS).toContain('char_detect');
  });

  it('长度应为 3', () => {
    expect(MARKER_TAGS).toHaveLength(3);
  });
});

// ========== MARKER_TAG_SET 常量 ==========

describe('MARKER_TAG_SET', () => {
  it('应包含三种标记类型', () => {
    expect(MARKER_TAG_SET.has('craft_request')).toBe(true);
    expect(MARKER_TAG_SET.has('combat_trigger')).toBe(true);
    expect(MARKER_TAG_SET.has('char_detect')).toBe(true);
  });

  it('大小应为 3', () => {
    expect(MARKER_TAG_SET.size).toBe(3);
  });

  it('不应包含非标记标签', () => {
    expect(MARKER_TAG_SET.has('maintext')).toBe(false);
    expect(MARKER_TAG_SET.has('thinking')).toBe(false);
  });
});
