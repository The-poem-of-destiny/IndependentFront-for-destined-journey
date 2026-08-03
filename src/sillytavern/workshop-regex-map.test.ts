/**
 * workshop-regex-map.test.ts — ST 正则 → BeautifierRule（D16）
 *
 * 三个实测坑各有一组断言：
 * 1. `findRegex` 两种形态（裸 pattern / `/pattern/flags`）—— 用**真实的 6 条**跑
 * 2. `substituteRegex` 枚举非布尔（0 与 2）
 * 3. 捕获组方言兼容，`replacement` **原样**不转写、不剥 `<script>`/`<style>`
 */

import { describe, it, expect } from 'vitest';
import type { WorkshopNote, WorkshopNoteKind } from './types';
import { mapWorkshopRegexes, parseFindRegex } from './workshop-regex-map';
import type { WorkshopSourceRegex } from './workshop-types';

/** note 正文拼一串，供 `toContain` 用（note 现在是对象，直接 join 会得到 [object Object]） */
function textOf(notes: WorkshopNote[]): string {
  return notes.map((n) => n.text).join('\n');
}

/** 只取某一类的正文 —— 「这条到底算不算丢弃」的断言全靠它 */
function textOfKind(notes: WorkshopNote[], kind: WorkshopNoteKind): string {
  return textOf(notes.filter((n) => n.kind === kind));
}

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
    placement: [2],
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
  it('promptOnly → 整条跳过，不产出规则；★ 归 dropped 不归 degraded', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ promptOnly: true })], CTX);
    expect(rules).toHaveLength(0);
    // 它长得像「装了但只在提示词侧生效」，实际一条规则都没产出 —— 真丢弃
    expect(droppedNotes.map((n) => n.kind)).toEqual(['dropped']);
    expect(textOfKind(droppedNotes, 'dropped')).toContain('promptOnly');
  });

  it('正则编译失败 → 整条跳过（否则会显示「已启用」却永不生效）', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ findRegex: '([' })], CTX);
    expect(rules).toHaveLength(0);
    expect(droppedNotes.map((n) => n.kind)).toEqual(['dropped']);
    expect(textOfKind(droppedNotes, 'dropped')).toContain('编译失败');
  });

  it('findRegex 为空 → 整条跳过', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes([regex({ findRegex: '' })], CTX);
    expect(rules).toHaveLength(0);
    expect(droppedNotes.map((n) => n.kind)).toEqual(['dropped']);
    expect(textOfKind(droppedNotes, 'dropped')).toContain('findRegex 为空');
  });

  it('保留 AI output placement 与深度边界；不可达 runOnEdit 不误报，只记录 trimStrings', () => {
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
    expect(rules[0]).toMatchObject({ minDepth: 1, maxDepth: 10 });
    expect(new Set(droppedNotes.map((n) => n.kind))).toEqual(new Set(['dropped']));
    const joined = textOfKind(droppedNotes, 'dropped');
    expect(joined).toContain('trimStrings');
    expect(joined).not.toContain('placement');
    expect(joined).not.toContain('minDepth');
    expect(joined).not.toContain('maxDepth');
    expect(joined).not.toContain('runOnEdit');
  });

  it('★ 坑 2：substituteRegex 只有 pattern 真含宏时才是可达缺口', () => {
    expect(
      textOf(mapWorkshopRegexes([regex({ substituteRegex: 0 })], CTX).droppedNotes),
    ).not.toContain('substituteRegex');
    expect(
      textOf(mapWorkshopRegexes([regex({ substituteRegex: 2 })], CTX).droppedNotes),
    ).not.toContain('substituteRegex');
    const notes = mapWorkshopRegexes(
      [regex({ findRegex: '{{character}}', substituteRegex: 2 })],
      CTX,
    ).droppedNotes;
    expect(textOfKind(notes, 'dropped')).toContain('substituteRegex=2');
  });

  it('只映射含 AI output placement=2 的规则，避免把 user-only 规则错投到正文', () => {
    expect(mapWorkshopRegexes([regex({ placement: [2] })], CTX).rules).toHaveLength(1);
    expect(mapWorkshopRegexes([regex({ placement: [1, 2] })], CTX).rules).toHaveLength(1);

    const userOnly = mapWorkshopRegexes([regex({ placement: [1] })], CTX);
    expect(userOnly.rules).toHaveLength(0);
    expect(textOfKind(userOnly.droppedNotes, 'dropped')).toContain('不包含 AI 输出位置 2');
  });

  it('无信息可丢的干净条目 → 零 note（不刷屏，否则真丢弃项会被淹没）', () => {
    const { droppedNotes } = mapWorkshopRegexes([regex()], CTX);
    expect(droppedNotes).toEqual([]);
  });

  it('markdownOnly=false → 记「提示词侧未导入」（dropped：那一半是真丢了）', () => {
    const { droppedNotes } = mapWorkshopRegexes([regex({ markdownOnly: false })], CTX);
    expect(textOfKind(droppedNotes, 'dropped')).toContain('markdownOnly 为 false');
  });

  it('iframe 已支持 script / style / 围栏 / 完整文档，仅未求值宏记降级', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes(
      [
        regex({
          replaceString:
            '```html\n<!doctype html><html><style>a{}</style><script>x</script>{{getvar::hp}}{{user}}</html>\n```',
        }),
      ],
      CTX,
    );
    // ★ 关键：这条正则**装上了也启用了** —— 它一项都不该被算进「未导入」
    expect(rules).toHaveLength(1);
    expect(rules[0].enabled).toBe(true);
    expect(droppedNotes.filter((n) => n.kind === 'dropped')).toHaveLength(0);

    expect(droppedNotes.filter((n) => n.kind === 'sideEffect')).toHaveLength(0);
    const degraded = textOfKind(droppedNotes, 'degraded');
    expect(degraded).toContain('2 处 {{...}} 宏');
    expect(degraded).not.toContain('<script>');
    expect(degraded).not.toContain('<style>');
  });

  it('只报告可达的 iframe 限制，且不混进真正丢弃计数', () => {
    const { rules, droppedNotes } = mapWorkshopRegexes(
      [
        regex({
          runOnEdit: true, // 当前没有消息编辑入口，不改变首次渲染
          replaceString:
            '<img src="https://cdn.example/image.png"><script>parent.document;localStorage.setItem("x","y")</script>',
        }),
      ],
      CTX,
    );
    expect(rules).toHaveLength(1);
    const count = (kind: WorkshopNoteKind): number =>
      droppedNotes.filter((n) => n.kind === kind).length;
    expect(count('dropped')).toBe(0);
    expect(count('degraded')).toBe(1);
    expect(count('sideEffect')).toBe(0);
    expect(textOfKind(droppedNotes, 'degraded')).not.toContain('外部来源');
    expect(textOfKind(droppedNotes, 'degraded')).toContain('父页面或酒馆 API');
    expect(textOfKind(droppedNotes, 'degraded')).not.toContain('浏览器存储');
    expect(textOfKind(droppedNotes, 'dropped')).not.toContain('外部来源');
  });

  it('localStorage 走共享持久命名空间，仍只对 sessionStorage / IndexedDB 报降级', () => {
    const local = mapWorkshopRegexes(
      [regex({ replaceString: '<script>localStorage.setItem("theme", "dark")</script>' })],
      CTX,
    );
    expect(textOfKind(local.droppedNotes, 'degraded')).not.toContain('浏览器存储');

    const unavailable = mapWorkshopRegexes(
      [regex({ replaceString: '<script>sessionStorage.x = 1; indexedDB.open("x")</script>' })],
      CTX,
    );
    expect(textOfKind(unavailable.droppedNotes, 'degraded')).toContain('受限浏览器存储');
  });

  it('note 里带条目名，用户能对上是哪条', () => {
    const { droppedNotes } = mapWorkshopRegexes(
      [regex({ scriptName: '维拉占卜美化', trimStrings: ['legacy'] })],
      CTX,
    );
    expect(droppedNotes[0].text).toContain('维拉占卜美化');
  });

  it('空输入 → 空产出', () => {
    expect(mapWorkshopRegexes([], CTX)).toEqual({ rules: [], droppedNotes: [] });
  });
});

describe('indexBase —— 装前逐条检视与整批安装必须报同一个名字', () => {
  function unnamed(over: Partial<WorkshopSourceRegex> = {}): WorkshopSourceRegex {
    return {
      id: 'x',
      scriptName: '', // 空名 → 触发 `未命名正则 N` 兜底，这正是索引敏感的那条路
      findRegex: '/a/g',
      replaceString: 'b',
      disabled: false,
      markdownOnly: false,
      promptOnly: true, // 整条丢弃 → 一定会产出一条带名字的 note
      runOnEdit: false,
      trimStrings: [],
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
      placement: [2],
      ...over,
    };
  }
  const ctx = { projectId: 'p1', projectName: '维拉的旅途' };

  it('★ 单条调用带上真实序号后，与整批调用的文案逐字一致', () => {
    const entries = [unnamed({ id: 'a' }), unnamed({ id: 'b' }), unnamed({ id: 'c' })];
    const batch = mapWorkshopRegexes(entries, ctx).droppedNotes.map((n) => n.text);
    // 装前检视是一条一条单独调用的 —— 必须把它在项目里的真实位置传进去
    const perRow = entries.map(
      (e, i) => mapWorkshopRegexes([e], { ...ctx, indexBase: i }).droppedNotes[0].text,
    );
    expect(perRow).toEqual(batch);
    expect(perRow[2]).toContain('未命名正则 3');
  });

  it('不传 indexBase 的单条调用会说错名字（回归护栏：别把 indexBase 删了）', () => {
    const entries = [unnamed({ id: 'a' }), unnamed({ id: 'b' })];
    const naive = mapWorkshopRegexes([entries[1]], ctx).droppedNotes[0].text;
    const truth = mapWorkshopRegexes(entries, ctx).droppedNotes[1].text;
    expect(naive).toContain('未命名正则 1');
    expect(truth).toContain('未命名正则 2');
    expect(naive).not.toBe(truth);
  });

  it('order 也跟着真实序号走', () => {
    const named = unnamed({ scriptName: '染色', promptOnly: false });
    const batchSecond = mapWorkshopRegexes([named, named], ctx).rules[1].order;
    const perRowSecond = mapWorkshopRegexes([named], { ...ctx, indexBase: 1 }).rules[0].order;
    expect(perRowSecond).toBe(batchSecond);
  });

  it('整批调用不传 indexBase，行为与加这个字段之前完全一致', () => {
    const named = unnamed({ scriptName: '染色', promptOnly: false });
    expect(mapWorkshopRegexes([named], ctx).rules[0].order).toBe(
      mapWorkshopRegexes([named], { ...ctx, indexBase: 0 }).rules[0].order,
    );
  });
});
