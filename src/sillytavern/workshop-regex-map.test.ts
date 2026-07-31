/**
 * workshop-regex-map.test.ts — ST 正则 → BeautifierRule（D16）
 *
 * 三个实测坑各有一组断言：
 * 1. `findRegex` 两种形态（裸 pattern / `/pattern/flags`）—— 用**真实的 6 条**跑
 * 2. `substituteRegex` 枚举非布尔（0 与 2）
 * 3. 捕获组方言兼容，`replacement` **原样**不转写、不剥 `<script>`/`<style>`
 */

import { describe, it, expect } from 'vitest';
import { mapWorkshopRegexes, parseFindRegex } from './workshop-regex-map';
import type { WorkshopSourceRegex } from './workshop-types';

function regex(over: Partial<WorkshopSourceRegex> = {}): WorkshopSourceRegex {
  return {
    id: 'rx-1',
    scriptName: '测试正则',
    findRegex: '<a>([\\s\\S]*?)</a>',
    replaceString: '<div>$1</div>',
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: false,
    trimStrings: [],
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    placement: [],
    ...over,
  };
}

const CTX = { projectId: 'proj-a', projectName: '命定核心-言灵（重置）' };

/** 真实样本：6 条 findRegex，实测 2 条裸 / 4 条定界 */
const REAL_FIND_REGEXES = [
  {
    raw: '<yanling_edits\\b[^>]*\\bkind="([^"]+)"[^>]*>([\\s\\S]*?)</yanling_edits>',
    delimited: false,
    flags: '',
  },
  {
    raw: '(?:<yanling\\b[^>]*\\bmood\\s*=\\s*"([^"]+)"[^>]*>[「“]?([\\s\\S]*?)[」”]?</yanling>)',
    delimited: false,
    flags: '',
  },
  {
    raw: '/<Vera\\s+form="([^"]*)"\\s+mood="([^"]*)">\\s*([\\s\\S]*?)\\s*<\\/Vera>/g',
    delimited: true,
    flags: 'g',
  },
  {
    raw: '/<TarotSpread\\s+action="draw">\\s*([\\s\\S]*?)\\s*<\\/TarotSpread>/g',
    delimited: true,
    flags: 'g',
  },
  {
    raw: '/<TimeGate\\s+type\\s*=\\s*["\']?(init|active|finish)["\']?>([\\s\\S]*?)<\\/TimeGate>/g',
    delimited: true,
    flags: 'g',
  },
  {
    raw: '/<dream>「?((?:[^<]|<(?!dream\\b|\\/dream>))*?)」?<\\/dream>/g',
    delimited: true,
    flags: 'g',
  },
];

describe('parseFindRegex —— ★ 坑 1：两种形态都要吃', () => {
  REAL_FIND_REGEXES.forEach(({ raw, delimited, flags }, index) => {
    it(`真实样本 #${index + 1}（${delimited ? '定界' : '裸'}形态）`, () => {
      const parsed = parseFindRegex(raw);
      expect(parsed.delimited).toBe(delimited);
      expect(parsed.flags).toBe(flags);
      // 无论哪种形态，产出的 pattern 都必须能编译
      expect(() => new RegExp(parsed.pattern, parsed.flags)).not.toThrow();
    });
  });

  it('实测比例：6 条里 2 条裸 / 4 条定界 —— 只支持一种形态会漏掉三分之一', () => {
    const parsed = REAL_FIND_REGEXES.map((r) => parseFindRegex(r.raw));
    expect(parsed.filter((p) => p.delimited)).toHaveLength(4);
    expect(parsed.filter((p) => !p.delimited)).toHaveLength(2);
  });

  it('定界形态：斜杠被剥掉，pattern 不含定界符', () => {
    const parsed = parseFindRegex('/<Vera>(.*)<\\/Vera>/g');
    expect(parsed.pattern).toBe('<Vera>(.*)<\\/Vera>');
    expect(parsed.flags).toBe('g');
  });

  it('★ 反例：整串塞进 RegExp 会得到一个永不命中的正则', () => {
    // 这正是不解析定界符的后果 —— 能编译、不报错、匹配的是斜杠字符本身
    expect(new RegExp('/<Vera>(.*)<\\/Vera>/g').test('<Vera>x</Vera>')).toBe(false);
    const parsed = parseFindRegex('/<Vera>(.*)<\\/Vera>/g');
    expect(new RegExp(parsed.pattern, parsed.flags).test('<Vera>x</Vera>')).toBe(true);
  });

  it('裸形态：原样返回，flags 为空', () => {
    const parsed = parseFindRegex('<yanling_edits\\b[^>]*>');
    expect(parsed).toEqual({ pattern: '<yanling_edits\\b[^>]*>', flags: '', delimited: false });
  });

  it('★ 裸形态不补 g —— 补了就是行为改写而非兼容', () => {
    expect(parseFindRegex('a').flags).toBe('');
  });

  it('多 flag 组合', () => {
    expect(parseFindRegex('/abc/gim')).toEqual({ pattern: 'abc', flags: 'gim', delimited: true });
    expect(parseFindRegex('/abc/dgimsuy').flags).toBe('dgimsuy');
  });

  it('无 flag 的定界形态', () => {
    expect(parseFindRegex('/abc/')).toEqual({ pattern: 'abc', flags: '', delimited: true });
  });

  it('以 / 开头的裸 pattern 不被误拆（尾串不是合法 flag）', () => {
    const parsed = parseFindRegex('/api/(\\w+)');
    expect(parsed.delimited).toBe(false);
    expect(parsed.pattern).toBe('/api/(\\w+)');
  });

  it('重复 flag 字符 → 判定为裸 pattern（RegExp 会拒绝重复 flag）', () => {
    expect(parseFindRegex('/abc/gg').delimited).toBe(false);
  });

  it('非法 flag 字符 → 裸 pattern', () => {
    expect(parseFindRegex('/abc/zz').delimited).toBe(false);
  });

  it('收尾斜杠被转义 → 不当定界符', () => {
    // `/a\/` 的末尾斜杠是被转义的，没有合法收尾 → 裸
    expect(parseFindRegex('/a\\/').delimited).toBe(false);
    // 双反斜杠后的斜杠未被转义 → 是收尾
    expect(parseFindRegex('/a\\\\/g')).toEqual({ pattern: 'a\\\\', flags: 'g', delimited: true });
  });

  it('退化输入不抛', () => {
    expect(parseFindRegex('')).toEqual({ pattern: '', flags: '', delimited: false });
    expect(parseFindRegex('/')).toEqual({ pattern: '/', flags: '', delimited: false });
    expect(parseFindRegex('//')).toEqual({ pattern: '', flags: '', delimited: true });
  });
});

describe('mapWorkshopRegexes —— D16 字段映射', () => {
  it('完整映射一条', () => {
    const { rules } = mapWorkshopRegexes([regex()], CTX);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      id: 'workshop-rule:proj-a:rx-1',
      name: '测试正则',
      scope: 'maintext',
      pattern: '<a>([\\s\\S]*?)</a>',
      flags: '',
      replacement: '<div>$1</div>',
      enabled: true,
      order: 1000,
      isBuiltin: false,
      autoEnable: { worldBookIds: ['workshop:proj-a'] },
      group: '创意工坊 · 命定核心-言灵（重置）',
    });
  });

  it('disabled → enabled 取反', () => {
    expect(mapWorkshopRegexes([regex({ disabled: true })], CTX).rules[0].enabled).toBe(false);
    expect(mapWorkshopRegexes([regex({ disabled: false })], CTX).rules[0].enabled).toBe(true);
  });

  it('order 按序递增，不与内置规则抢前排', () => {
    const { rules } = mapWorkshopRegexes(
      [regex({ id: 'a' }), regex({ id: 'b' }), regex({ id: 'c' })],
      CTX,
    );
    expect(rules.map((r) => r.order)).toEqual([1000, 1001, 1002]);
  });

  it('scriptName 为空 → 用序号兜底', () => {
    const { rules } = mapWorkshopRegexes([regex({ scriptName: '  ' })], CTX);
    expect(rules[0].name).toBe('未命名正则 1');
  });

  it('规则 id 带项目命名空间 —— 跨项目不撞', () => {
    const a = mapWorkshopRegexes([regex()], CTX).rules[0];
    const b = mapWorkshopRegexes([regex()], { ...CTX, projectId: 'proj-b' }).rules[0];
    expect(a.id).not.toBe(b.id);
  });

  it('locked 不产出（运行时计算字段，纯函数层不碰）', () => {
    expect(mapWorkshopRegexes([regex()], CTX).rules[0]).not.toHaveProperty('locked');
  });
});

describe('mapWorkshopRegexes —— ★ 坑 3：replacement 原样，不剥不转写', () => {
  const html =
    '```html\r\n<!doctype html>\n<html lang="zh-CN"><head><style>.x{color:red}</style></head>' +
    '<body><script>alert(1)</script><div onclick="go()">$1</div></body></html>\n```';

  it('<script> 一个字节都不剥', () => {
    const { rules } = mapWorkshopRegexes([regex({ replaceString: html })], CTX);
    expect(rules[0].replacement).toBe(html);
    expect(rules[0].replacement).toContain('<script>alert(1)</script>');
  });

  it('<style> 一个字节都不剥', () => {
    const { rules } = mapWorkshopRegexes([regex({ replaceString: html })], CTX);
    expect(rules[0].replacement).toContain('<style>.x{color:red}</style>');
  });

  it('捕获组 $1..$9 不转写（引擎侧同为 JS 语义）', () => {
    const repl = '$1-$2-$9-$&';
    const { rules } = mapWorkshopRegexes([regex({ replaceString: repl })], CTX);
    expect(rules[0].replacement).toBe(repl);
  });

  it('enabled 按上游（实测 6/6 都是启用）—— 不因含 script 就默认关掉', () => {
    const { rules } = mapWorkshopRegexes([regex({ replaceString: html, disabled: false })], CTX);
    expect(rules[0].enabled).toBe(true);
  });
});

describe('mapWorkshopRegexes —— droppedNotes 必须 loud', () => {
  it('promptOnly → 整条跳过，不产出规则', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ promptOnly: true })], CTX);
    expect(rules).toHaveLength(0);
    expect(droppedNotes.some((n) => n.includes('promptOnly'))).toBe(true);
  });

  it('正则编译失败 → 整条跳过（否则会显示「已启用」却永不生效）', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ findRegex: '([' })], CTX);
    expect(rules).toHaveLength(0);
    expect(droppedNotes.some((n) => n.includes('编译失败'))).toBe(true);
  });

  it('findRegex 为空 → 整条跳过', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ findRegex: '' })], CTX);
    expect(rules).toHaveLength(0);
    expect(droppedNotes.some((n) => n.includes('findRegex 为空'))).toBe(true);
  });

  it('placement / minDepth / maxDepth / runOnEdit / trimStrings 各记一条', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes(
      [
        regex({
          placement: [1, 2],
          minDepth: 1,
          maxDepth: 10,
          runOnEdit: true,
          trimStrings: ['a', 'b'],
        }),
      ],
      CTX,
    );
    expect(rules).toHaveLength(1); // 丢弃字段不影响规则本体落地
    const joined = droppedNotes.join('\n');
    expect(joined).toContain('placement=[1,2]');
    expect(joined).toContain('minDepth=1');
    expect(joined).toContain('maxDepth=10');
    expect(joined).toContain('runOnEdit');
    expect(joined).toContain('trimStrings');
  });

  it('★ 坑 2：substituteRegex 非 0 才记 note（0 = 不替换，丢弃无损）', () => {
    expect(
      mapWorkshopRegexes([regex({ substituteRegex: 0 })], CTX).droppedNotes.join('\n'),
    ).not.toContain('substituteRegex');
    expect(
      mapWorkshopRegexes([regex({ substituteRegex: 2 })], CTX).droppedNotes.join('\n'),
    ).toContain('substituteRegex=2');
  });

  it('无信息可丢的干净条目 → 零 note（不刷屏，否则真丢弃项会被淹没）', () => {
    const { droppedNotes } = mapWorkshopRegexes([regex()], CTX);
    expect(droppedNotes).toEqual([]);
  });

  it('markdownOnly=false → 记「提示词侧未导入」', () => {
    const { droppedNotes } = mapWorkshopRegexes([regex({ markdownOnly: false })], CTX);
    expect(droppedNotes.join('\n')).toContain('markdownOnly 为 false');
  });

  it('已知后果如实记录：script / style / 围栏 / 完整 HTML 文档 / 宏', () => {
    const { droppedNotes } = mapWorkshopRegexes(
      [
        regex({
          replaceString:
            '```html\n<!doctype html><html><style>a{}</style><script>x</script>{{getvar::hp}}{{user}}</html>\n```',
        }),
      ],
      CTX,
    );
    const joined = droppedNotes.join('\n');
    expect(joined).toContain('<script>');
    expect(joined).toContain('<style>');
    expect(joined).toContain('围栏');
    expect(joined).toContain('完整 HTML 文档');
    expect(joined).toContain('2 处 {{...}} 宏');
  });

  it('note 里带条目名，用户能对上是哪条', () => {
    const { droppedNotes } = mapWorkshopRegexes(
      [regex({ scriptName: '维拉占卜美化', runOnEdit: true })],
      CTX,
    );
    expect(droppedNotes[0]).toContain('维拉占卜美化');
  });

  it('空输入 → 空产出', () => {
    expect(mapWorkshopRegexes([], CTX)).toEqual({ rules: [], droppedNotes: [] });
  });
});
