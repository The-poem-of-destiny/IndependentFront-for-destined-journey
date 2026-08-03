/**
 * agent-xml.test.ts — AI 输出 XML 解析共享面（Q-05）
 *
 * 这些用例是把**三份历史拷贝各自的容错行为**钉成并集：
 * char-gen 侧的单双引号属性、craft 侧的 escapeRegex、以及宽松版子元素正则。
 * 任何一条挂掉都意味着某条 Agent 链的容错在悄悄退化。
 */

import { describe, it, expect } from 'vitest';
import {
  escapeRegex,
  tagInner,
  tagBlock,
  tagAttr,
  tagAttrInt,
  parseAttrsStr,
  stripInnerTags,
  parseNamedChildren,
  stripKnownChildBlocks,
} from './agent-xml';

describe('tagInner / tagBlock —— 历史上两个同名 extractTag 打架的地方', () => {
  const xml = '<wrap><name attr="x">艾琳</name></wrap>';

  it('tagInner 取内文并 trim', () => {
    expect(tagInner(xml, 'name')).toBe('艾琳');
    expect(tagInner('<a>  留白  </a>', 'a')).toBe('留白');
  });

  it('tagBlock 取含标签整块', () => {
    expect(tagBlock(xml, 'name')).toBe('<name attr="x">艾琳</name>');
  });

  it('两者都容忍标签带任意属性', () => {
    const s = '<item type="buff" name="灼烧" lvl="3">描述</item>';
    expect(tagInner(s, 'item')).toBe('描述');
    expect(tagBlock(s, 'item')).toBe(s);
  });

  it('没匹配到返回 null（不是空串——空串会被 ?? 兜底吞掉）', () => {
    expect(tagInner(xml, 'missing')).toBeNull();
    expect(tagBlock(xml, 'missing')).toBeNull();
  });

  it('非贪婪：同名标签出现多次只取第一段', () => {
    expect(tagInner('<a>一</a><a>二</a>', 'a')).toBe('一');
  });
});

describe('tagAttr —— 单双引号与空格容错（char-gen 侧的口径）', () => {
  it('双引号', () => {
    expect(tagAttr('<char name="艾琳">', 'char', 'name')).toBe('艾琳');
  });
  it('单引号', () => {
    expect(tagAttr("<char name='艾琳'>", 'char', 'name')).toBe('艾琳');
  });
  it('等号旁有空格', () => {
    expect(tagAttr('<char name = "艾琳">', 'char', 'name')).toBe('艾琳');
  });
  it('属性不在第一位', () => {
    expect(tagAttr('<char type="npc" name="艾琳">', 'char', 'name')).toBe('艾琳');
  });
  it('缺失返回 null', () => {
    expect(tagAttr('<char type="npc">', 'char', 'name')).toBeNull();
  });
});

describe('tagAttrInt —— 显式 0 必须保留（真机修：意识体 0 属性合法）', () => {
  it('显式 0 不被缺省值顶掉', () => {
    expect(tagAttrInt('<attr str="0">', 'attr', 'str', 5)).toBe(0);
  });
  it('缺失用缺省值', () => {
    expect(tagAttrInt('<attr>', 'attr', 'str', 5)).toBe(5);
  });
  it('非法值用缺省值', () => {
    expect(tagAttrInt('<attr str="abc">', 'attr', 'str', 5)).toBe(5);
  });
});

describe('parseAttrsStr —— 取两份拷贝的并集', () => {
  it('双引号', () => {
    expect(parseAttrsStr('a="1" b="2"')).toEqual({ a: '1', b: '2' });
  });
  it('单引号（craft 侧那份只认双引号，会整条丢掉）', () => {
    expect(parseAttrsStr('a=\'1\' b="2"')).toEqual({ a: '1', b: '2' });
  });
  it('等号旁空格', () => {
    expect(parseAttrsStr('a = "1"')).toEqual({ a: '1' });
  });
  it('空值属性', () => {
    expect(parseAttrsStr('a=""')).toEqual({ a: '' });
  });
});

describe('escapeRegex —— 标签名带正则元字符也不炸', () => {
  it('转义元字符', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });
  it('带点的标签名能被正确匹配（未转义时 `.` 会吃任意字符）', () => {
    expect(tagInner('<a.b>x</a.b>', 'a.b')).toBe('x');
    expect(tagInner('<axb>x</axb>', 'a.b')).toBeNull();
  });
});

describe('stripInnerTags —— 剥掉 AI 自作主张的嵌套标签', () => {
  it('成对标签保留内容', () => {
    expect(stripInnerTags('<physical>高挑</physical><voice>清冷</voice>')).toBe('高挑\n清冷');
  });
  it('孤立标签被删除', () => {
    expect(stripInnerTags('前<br>后')).toBe('前后');
  });
  it('没有标签时原样返回', () => {
    expect(stripInnerTags('纯文本')).toBe('纯文本');
  });
});

describe('parseNamedChildren —— 宽松正则（严格版会静默丢字段）', () => {
  it('name 是第一个属性', () => {
    expect(parseNamedChildren('<effect name="灼烧">每回合掉血</effect>', 'effect')).toEqual({
      灼烧: '每回合掉血',
    });
  });

  // 这条正是漂移的现场：严格版要求 name 紧跟标签名，于是同一条 AI 输出
  // 写在装备里能收到、写在技能里被丢掉
  it('name 前面有别的属性也要收到', () => {
    expect(parseNamedChildren('<effect type="buff" name="灼烧">描述</effect>', 'effect')).toEqual({
      灼烧: '描述',
    });
  });

  it('多个子元素', () => {
    const s = '<script name="init">a</script><script name="cleanup">b</script>';
    expect(parseNamedChildren(s, 'script')).toEqual({ init: 'a', cleanup: 'b' });
  });

  it('无子元素返回空对象', () => {
    expect(parseNamedChildren('纯文本', 'effect')).toEqual({});
  });
});

describe('stripKnownChildBlocks', () => {
  it('剥掉四类已知子块，留下纯文本描述', () => {
    const s =
      '一把剑<effect name="a">x</effect><script name="b">y</script><modifiers>z</modifiers>';
    expect(stripKnownChildBlocks(s).trim()).toBe('一把剑');
  });

  it('自闭合的 <modifiers/> / <automaton/> 也剥掉', () => {
    expect(stripKnownChildBlocks('一把剑<modifiers/><automaton />').trim()).toBe('一把剑');
  });
});
