/**
 * ejs-runtime.ts 测试 — 整片编译运行时（工坊 Phase 2 / D2、D5、D8、D10）
 *
 * 覆盖：跨块控制流、`<%_ _%>` 空白吞噬、输出标签空值、三种读形、别名全表、
 * 执行失败 vars 回滚（引用不变）、危险路径段拒写、沙盒遮蔽。
 */

import { describe, it, expect } from 'vitest';
import {
  compileEjsEntry,
  executeEjsEntry,
  type EjsEvalContext,
  type CompiledEjsEntry,
} from './ejs-runtime';

// ========== 测试工具 ==========

function makeCtx(partial: Partial<EjsEvalContext> = {}): EjsEvalContext {
  return {
    stats: partial.stats ?? {},
    vars: partial.vars ?? {},
    historyText: partial.historyText ?? '',
  };
}

/** 编译 + 执行，断言成功并返回渲染串 */
function render(content: string, ctx: EjsEvalContext = makeCtx()): string {
  const result = executeEjsEntry(compileEjsEntry(content), ctx);
  if (!result.ok) throw new Error(`预期渲染成功但失败了: ${result.error}`);
  return result.rendered;
}

/** 编译 + 执行，返回原始结果（允许失败） */
function run(content: string, ctx: EjsEvalContext) {
  return executeEjsEntry(compileEjsEntry(content), ctx);
}

// ═══════════════════════════════════════════════════════════
// 基础渲染
// ═══════════════════════════════════════════════════════════

describe('基础渲染', () => {
  it('纯文本原样输出', () => {
    expect(render('Hello, World!')).toBe('Hello, World!');
  });

  it('空模板输出空串', () => {
    expect(render('')).toBe('');
  });

  it('<%= 输出表达式', () => {
    expect(render('Hello <%= "World" %>!')).toBe('Hello World!');
  });

  it('<%= 算术表达式', () => {
    expect(render('Count: <%= 1 + 2 %>')).toBe('Count: 3');
  });

  it('<%- 与 <%= 同义（提示词纯文本，不做 HTML 转义）', () => {
    expect(render('<%- "<b>x</b>" %>')).toBe('<b>x</b>');
    expect(render('<%= "<b>x</b>" %>')).toBe('<b>x</b>');
  });

  it('<%= null 输出空串', () => {
    expect(render('Before<%= null %>After')).toBe('BeforeAfter');
  });

  it('<%= undefined 输出空串', () => {
    expect(render('Before<%= undefined %>After')).toBe('BeforeAfter');
  });

  it('<%= 0 / false 正常输出（不被当空值吞掉）', () => {
    expect(render('<%= 0 %>|<%= false %>')).toBe('0|false');
  });

  it('<%= 空表达式输出空串', () => {
    expect(render('a<%= %>b')).toBe('ab');
  });

  it('<% 代码块不产出输出', () => {
    expect(render('<% const x = 1; %>done')).toBe('done');
  });

  it('<%# 注释块不产出输出', () => {
    expect(render('a<%# 这是注释 %>b')).toBe('ab');
  });

  it('print() 追加输出（EJS 自带输出函数，语料 dlc.json#477 用到）', () => {
    expect(render('<% print("a"); print(1) %>|')).toBe('a1|');
  });

  it('print(null/undefined) 输出空串', () => {
    expect(render('[<% print(null); print(undefined) %>]')).toBe('[]');
  });

  it('print 与文本、<%= 按位置交织', () => {
    expect(render('1<% print("2") %>3<%= 4 %>')).toBe('1234');
  });

  it('<%% 转义为字面 <%', () => {
    expect(render('a<%%b')).toBe('a<%b');
  });

  it('未闭合的 <% 原样降级为文本（不吞内容）', () => {
    expect(render('start <% incomplete')).toBe('start <% incomplete');
    expect(render('<%= unfinished')).toBe('<%= unfinished');
  });

  it('多个块顺序拼接', () => {
    expect(render('<%= 1 %>-<%= 2 %>-<%= 3 %>')).toBe('1-2-3');
  });
});

// ═══════════════════════════════════════════════════════════
// 跨块控制流 —— 整片编译的存在理由（D2）
// ═══════════════════════════════════════════════════════════

describe('跨块控制流（整片编译）', () => {
  it('跨块 if 为真时输出正文', () => {
    const tpl = '<%_ if (getMessageVar("flag")) { _%>YES<%_ } _%>';
    expect(render(tpl, makeCtx({ vars: { flag: true } }))).toBe('YES');
  });

  it('跨块 if 为假时正文不泄出（旧实现的致命回归点）', () => {
    const tpl = '<%_ if (getMessageVar("flag")) { _%>YES<%_ } _%>';
    expect(render(tpl, makeCtx({ vars: { flag: false } }))).toBe('');
  });

  it('跨块 if/else', () => {
    const tpl = '<%_ if (n > 5) { _%>大<%_ } else { _%>小<%_ } _%>';
    expect(render(`<% const n = 9; %>${tpl}`)).toBe('大');
    expect(render(`<% const n = 1; %>${tpl}`)).toBe('小');
  });

  it('跨块 else if 三分支', () => {
    const tpl =
      '<%_ if (n === 1) { _%>一<%_ } else if (n === 2) { _%>二<%_ } else { _%>其他<%_ } _%>';
    expect(render(`<% const n = 2; %>${tpl}`)).toBe('二');
  });

  it('跨块 for 循环重复输出正文', () => {
    const tpl = '<%_ for (let i = 0; i < 3; i++) { _%>[<%= i %>]<%_ } _%>';
    expect(render(tpl)).toBe('[0][1][2]');
  });

  it('跨块 forEach 闭包', () => {
    const tpl = '<%_ items.forEach((it) => { _%><%= it %>;<%_ }); _%>';
    expect(render(`<% const items = ["a","b"]; %>${tpl}`)).toBe('a;b;');
  });

  it('跨块嵌套 if + for', () => {
    const tpl = '<%_ for (const n of [1,2,3]) { _%><%_ if (n % 2) { _%><%= n %><%_ } _%><%_ } _%>';
    expect(render(tpl)).toBe('13');
  });

  it('语料形态：裸块包住整条目避免变量名冲突', () => {
    const tpl = '<%_ { const t = "内"; _%><%= t %><%_ } _%>';
    expect(render(tpl)).toBe('内');
  });

  it('前一块定义的函数在后一块可用', () => {
    const tpl = '<%_ function greet(n) { return "hi " + n; } _%><%= greet("x") %>';
    expect(render(tpl)).toBe('hi x');
  });
});

// ═══════════════════════════════════════════════════════════
// 空白吞噬（<%_ / _%> / -%>）
// ═══════════════════════════════════════════════════════════

describe('空白吞噬', () => {
  it('_%> 吞掉紧邻的行内空白与一个换行', () => {
    expect(render('<%_ ; _%>\n正文')).toBe('正文');
    expect(render('<%_ ; _%>   \n正文')).toBe('正文');
  });

  it('<%_ 吞掉紧邻前文的行内空白（不吞换行）', () => {
    expect(render('正文\n   <%_ ; _%>')).toBe('正文\n');
  });

  it('普通 %> 不吞任何空白', () => {
    expect(render('<% ; %>\n正文')).toBe('\n正文');
  });

  it('-%> 只吞一个换行，不吞行内空白', () => {
    expect(render('<% ; -%>  \n正文')).toBe('  \n正文');
    expect(render('<% ; -%>\n正文')).toBe('正文');
  });

  it('_%> 只吞一个换行（第二个换行保留）', () => {
    expect(render('<%_ ; _%>\n\n正文')).toBe('\n正文');
  });

  it('语料形态：跨块 if 的行首缩进被吞净', () => {
    const tpl = ['<%_ if (true) { _%>', '  <条目>内容</条目>', '<%_ } _%>', ''].join('\n');
    expect(render(tpl)).toBe('  <条目>内容</条目>\n');
  });

  it('<%= 也能用 _%> 闭合（语料 `<%= time _%>` 形态）', () => {
    const ctx = makeCtx({ vars: { t: '早晨' } });
    expect(render('[<%= getMessageVar("t") _%>]', ctx)).toBe('[早晨]');
  });
});

// ═══════════════════════════════════════════════════════════
// 两轴：stats / vars 直传
// ═══════════════════════════════════════════════════════════

describe('两轴注入', () => {
  it('stats 作为顶层标识符可读', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 12 } } });
    expect(render('<%= stats.主角.等级 %>', ctx)).toBe('12');
  });

  it('vars 作为顶层标识符可读写，写的是调用方持有的同一对象', () => {
    const ctx = makeCtx({ vars: { 计数: 1 } });
    expect(render('<% vars.计数 = vars.计数 + 1 %><%= vars.计数 %>', ctx)).toBe('2');
    expect(ctx.vars.计数).toBe(2);
  });

  it('stats 是 pass 级孤儿快照：就地改不抛，pass 结束即弃', () => {
    const ctx = makeCtx({ stats: { a: 1 } });
    render('<% stats.a = 999 %>', ctx);
    expect(ctx.stats.a).toBe(999);
  });
});

// ═══════════════════════════════════════════════════════════
// 别名层：getMessageVar 三种读形（D5）
// ═══════════════════════════════════════════════════════════

describe('getMessageVar — 读形①叶子读', () => {
  it('stats 命中优先于 vars', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 20 } }, vars: { 主角: { 等级: 3 } } });
    expect(render('<%= getMessageVar("stat_data.主角.等级") %>', ctx)).toBe('20');
  });

  it('stats 未命中落 vars', () => {
    const ctx = makeCtx({ stats: {}, vars: { 事件: { 阶段: 2 } } });
    expect(render('<%= getMessageVar("stat_data.事件.阶段") %>', ctx)).toBe('2');
  });

  it('都未命中返回 opts.defaults', () => {
    const ctx = makeCtx();
    expect(render('<%= getMessageVar("stat_data.主角.等级", { defaults: 0 }) %>', ctx)).toBe('0');
  });

  it('都未命中且无 defaults 输出空串', () => {
    expect(render('[<%= getMessageVar("stat_data.无.此.路径") %>]')).toBe('[]');
  });

  it('不带 stat_data 前缀同样可读', () => {
    const ctx = makeCtx({ vars: { hp: 30 } });
    expect(render('<%= getMessageVar("hp") %>', ctx)).toBe('30');
  });

  it('stats 上值为 null 即算命中（不再落 vars）', () => {
    const ctx = makeCtx({ stats: { a: null }, vars: { a: 'fromVars' } });
    expect(render('[<%= getMessageVar("a") %>]', ctx)).toBe('[]');
  });
});

describe('getMessageVar — 读形②子树读', () => {
  it('stats 命中的子树返回深克隆，改它不污染 stats', () => {
    const ctx = makeCtx({ stats: { 主角: { 属性: { 力量: 5 } } } });
    render('<% const a = getMessageVar("stat_data.主角.属性"); a.力量 = 999 %>', ctx);
    expect(ctx.stats.主角.属性.力量).toBe(5);
  });

  it('stats 命中的子树每次读都是独立拷贝', () => {
    const ctx = makeCtx({ stats: { s: { n: 1 } } });
    const out = render(
      '<% const a = getMessageVar("s"); const b = getMessageVar("s"); a.n = 2 %><%= b.n %>',
      ctx,
    );
    expect(out).toBe('1');
  });

  it('vars 侧子树返回活引用，改它就是真实草稿写', () => {
    const ctx = makeCtx({ vars: { 事件: { 阶段: 1 } } });
    render('<% const e = getMessageVar("stat_data.事件"); e.阶段 = 7 %>', ctx);
    expect(ctx.vars.事件.阶段).toBe(7);
  });

  it('vars 侧数组子树也是活引用', () => {
    const ctx = makeCtx({ vars: { 事件: { 信号: ['a'] } } });
    render('<% getMessageVar("stat_data.事件.信号").push("b") %>', ctx);
    expect(ctx.vars.事件.信号).toEqual(['a', 'b']);
  });
});

describe('getMessageVar — 读形③空路径整树读', () => {
  it('"stat_data" 返回 vars + stats 浅合并', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 9 } }, vars: { 事件: { 阶段: 1 } } });
    const out = render('<%= Object.keys(getMessageVar("stat_data")).sort().join(",") %>', ctx);
    expect(out.split(',').sort()).toEqual(['主角', '事件'].sort());
  });

  it('stats 顶层键覆盖 vars 同名键', () => {
    const ctx = makeCtx({ stats: { 主角: 'fromStats' }, vars: { 主角: 'fromVars' } });
    expect(render('<%= getMessageVar("stat_data").主角 %>', ctx)).toBe('fromStats');
  });

  it('空串路径同样走整树读', () => {
    const ctx = makeCtx({ vars: { a: 1 } });
    expect(render('<%= getMessageVar("").a %>', ctx)).toBe('1');
  });
});

// ═══════════════════════════════════════════════════════════
// 别名层：setMessageVar
// ═══════════════════════════════════════════════════════════

describe('setMessageVar', () => {
  it('写 vars 草稿，同条目内立即可读回', () => {
    const ctx = makeCtx();
    expect(
      render(
        '<% setMessageVar("stat_data.事件.冰之歌.触发时间", "子夜") %><%= getMessageVar("stat_data.事件.冰之歌.触发时间") %>',
        ctx,
      ),
    ).toBe('子夜');
    expect(ctx.vars.事件.冰之歌.触发时间).toBe('子夜');
  });

  it('中间节点缺失时自动建对象', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("a.b.c", 1) %>', ctx);
    expect(ctx.vars).toEqual({ a: { b: { c: 1 } } });
  });

  it('中间节点是标量时被替换为对象', () => {
    const ctx = makeCtx({ vars: { a: 5 } });
    render('<% setMessageVar("a.b", 1) %>', ctx);
    expect(ctx.vars.a).toEqual({ b: 1 });
  });

  it('永不触碰 stats', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 1 } } });
    render('<% setMessageVar("stat_data.主角.等级", 99) %>', ctx);
    expect(ctx.stats.主角.等级).toBe(1);
    expect(ctx.vars.主角.等级).toBe(99);
  });

  it('语料形态：默认值初始化守卫两支都正确', () => {
    const tpl =
      '<%_ if (!Array.isArray(getMessageVar("stat_data.事件.信号"))) { setMessageVar("stat_data.事件.信号", []) } _%><%= getMessageVar("stat_data.事件.信号").length %>';
    // 无值 → 写草稿再读草稿
    const empty = makeCtx();
    expect(render(tpl, empty)).toBe('0');
    // 有值 → 读到真值不写
    const filled = makeCtx({ vars: { 事件: { 信号: ['x', 'y'] } } });
    expect(render(tpl, filled)).toBe('2');
  });
});

// ═══════════════════════════════════════════════════════════
// 别名层：getvar / setvar
// ═══════════════════════════════════════════════════════════

describe('getvar / setvar', () => {
  it('带 stat_data 前缀时与 getMessageVar 同义', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 6 } } });
    expect(render('<%= getvar("stat_data.主角.等级") %>', ctx)).toBe('6');
  });

  it('扁平键不剥前缀，走同一读链', () => {
    const ctx = makeCtx({ vars: { 系统名: '阿南刻' } });
    expect(render('<%= getvar("系统名") %>', ctx)).toBe('阿南刻');
  });

  it('扁平键也吃 stats 优先', () => {
    const ctx = makeCtx({ stats: { 命运点数: 7 }, vars: { 命运点数: 1 } });
    expect(render('<%= getvar("命运点数") %>', ctx)).toBe('7');
  });

  it('扁平键的点路径形态（dialog_beauty.story）', () => {
    const ctx = makeCtx({ vars: { dialog_beauty: { story: 'on' } } });
    expect(render('<%= getvar("dialog_beauty.story") %>', ctx)).toBe('on');
  });

  it('opts.defaults 生效', () => {
    expect(render('<%= getvar("缺失键", { defaults: "兜底" }) %>')).toBe('兜底');
  });

  it('opts 的 scope / noCache 被静默忽略', () => {
    const ctx = makeCtx({ vars: { k: 'v' } });
    expect(render('<%= getvar("k", { scope: "global", noCache: true }) %>', ctx)).toBe('v');
  });

  it('setvar 扁平键写草稿', () => {
    const ctx = makeCtx();
    render('<% setvar("系统名", "阿南刻") %>', ctx);
    expect(ctx.vars.系统名).toBe('阿南刻');
  });

  it('setvar 带 stat_data 前缀时剥前缀', () => {
    const ctx = makeCtx();
    render('<% setvar("stat_data.事件.x", 1) %>', ctx);
    expect(ctx.vars).toEqual({ 事件: { x: 1 } });
  });

  it('stat_dataX 不算前缀（不误剥）', () => {
    const ctx = makeCtx({ vars: { stat_dataX: 'v' } });
    expect(render('<%= getvar("stat_dataX") %>', ctx)).toBe('v');
  });
});

// ═══════════════════════════════════════════════════════════
// 别名层：getLocalVar / setLocalVar / variables / matchChatMessages
// ═══════════════════════════════════════════════════════════

describe('getLocalVar / setLocalVar', () => {
  it('读写 vars._local 子树', () => {
    const ctx = makeCtx();
    render('<% setLocalVar("旗标", 3) %>', ctx);
    expect(ctx.vars._local).toEqual({ 旗标: 3 });
  });

  it('同条目内写后可读回', () => {
    expect(render('<% setLocalVar("k", "v") %><%= getLocalVar("k") %>')).toBe('v');
  });

  it('读预置的 _local', () => {
    const ctx = makeCtx({ vars: { _local: { 已触发: true } } });
    expect(render('<%= getLocalVar("已触发") %>', ctx)).toBe('true');
  });

  it('缺失时返回 undefined（输出空串），支持 defaults', () => {
    expect(render('[<%= getLocalVar("无") %>]')).toBe('[]');
    expect(render('<%= getLocalVar("无", { defaults: 0 }) %>')).toBe('0');
  });

  it('key 是单键不是路径', () => {
    const ctx = makeCtx();
    render('<% setLocalVar("a.b", 1) %>', ctx);
    expect(ctx.vars._local).toEqual({ 'a.b': 1 });
  });

  it('_local 原为标量时被替换为对象', () => {
    const ctx = makeCtx({ vars: { _local: 'oops' } });
    render('<% setLocalVar("k", 1) %>', ctx);
    expect(ctx.vars._local).toEqual({ k: 1 });
  });
});

describe('variables', () => {
  it('提供 stat_data 整树读视图（语料 _.get(variables, ...) 形态）', () => {
    const ctx = makeCtx({ stats: { 主角: { 等级: 4 } }, vars: { 关系列表: { a: 1 } } });
    expect(render('<%= _.get(variables, "stat_data.主角.等级") %>', ctx)).toBe('4');
    expect(render('<%= _.get(variables, "stat_data.关系列表.a") %>', ctx)).toBe('1');
  });

  it('缺失路径落 _.get 的默认值', () => {
    expect(render('<%= JSON.stringify(_.get(variables, "stat_data.任务列表", {})) %>')).toBe('{}');
  });

  it('stats 顶层键覆盖 vars 同名键', () => {
    const ctx = makeCtx({ stats: { k: 'S' }, vars: { k: 'V' } });
    expect(render('<%= variables.stat_data.k %>', ctx)).toBe('S');
  });
});

describe('matchChatMessages', () => {
  it('字符串 pattern 走子串匹配', () => {
    const ctx = makeCtx({ historyText: '你走进了北境的雪原' });
    expect(render('<%= matchChatMessages("北境") %>', ctx)).toBe('true');
    expect(render('<%= matchChatMessages("南海") %>', ctx)).toBe('false');
  });

  it('RegExp pattern 走正则匹配', () => {
    const ctx = makeCtx({ historyText: '等级提升到 12 级' });
    expect(render('<%= matchChatMessages(/\\d+ 级/) %>', ctx)).toBe('true');
    expect(render('<%= matchChatMessages(/^开局/) %>', ctx)).toBe('false');
  });

  it('带 g 标志的正则连续调用结果稳定（lastIndex 不漂移）', () => {
    const ctx = makeCtx({ historyText: 'aa' });
    expect(
      render('<% const re = /a/g %><%= matchChatMessages(re) %><%= matchChatMessages(re) %>', ctx),
    ).toBe('truetrue');
  });

  it('历史为空时字符串不命中', () => {
    expect(render('<%= matchChatMessages("x") %>')).toBe('false');
  });

  it('非字符串非正则返回 false', () => {
    expect(render('<%= matchChatMessages(123) %>')).toBe('false');
  });
});

// ═══════════════════════════════════════════════════════════
// 原型污染防御
// ═══════════════════════════════════════════════════════════

describe('危险路径段拒写', () => {
  it('setMessageVar 命中 __proto__ 整次拒绝', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("__proto__.polluted", 1) %>', ctx);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('危险段在中途也整次拒绝（不做部分写）', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("a.constructor.b", 1) %>', ctx);
    expect(ctx.vars.a).toBeUndefined();
  });

  it('prototype 段拒写', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("x.prototype", 1) %>', ctx);
    expect(ctx.vars.x).toBeUndefined();
  });

  it('setvar 同样受保护', () => {
    const ctx = makeCtx();
    render('<% setvar("__proto__.bad", 1) %>', ctx);
    expect(({} as Record<string, unknown>).bad).toBeUndefined();
  });

  it('setLocalVar 危险键拒写', () => {
    const ctx = makeCtx();
    render('<% setLocalVar("__proto__", 1) %>', ctx);
    expect(ctx.vars._local).toBeUndefined();
  });

  it('正常路径不受影响', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("a.b", 1) %>', ctx);
    expect(ctx.vars.a.b).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 编译失败 / 执行失败（D8）
// ═══════════════════════════════════════════════════════════

describe('compileEjsEntry — 语法错误抛出', () => {
  it('块内 JS 语法错误抛错', () => {
    expect(() => compileEjsEntry('<% const = %>')).toThrow();
  });

  it('未闭合大括号抛错（整片编译能看见这类跨块错误）', () => {
    expect(() => compileEjsEntry('<%_ if (true) { _%>x')).toThrow();
  });

  it('输出表达式语法错误抛错', () => {
    expect(() => compileEjsEntry('<%= 1 + + + %>')).toThrow();
  });

  it('合法模板不抛，返回带 source/body/fn 的产物', () => {
    const c: CompiledEjsEntry = compileEjsEntry('hi <%= 1 %>');
    expect(c.source).toBe('hi <%= 1 %>');
    expect(typeof c.fn).toBe('function');
    expect(c.body).toContain('__ejsOut');
  });

  it('编译产物可复用多次执行', () => {
    const c = compileEjsEntry('<%= getMessageVar("k") %>');
    expect(executeEjsEntry(c, makeCtx({ vars: { k: 'A' } }))).toEqual({ ok: true, rendered: 'A' });
    expect(executeEjsEntry(c, makeCtx({ vars: { k: 'B' } }))).toEqual({ ok: true, rendered: 'B' });
  });
});

describe('executeEjsEntry — 运行时错误不外抛', () => {
  it('未注入符号触发 ReferenceError → ok:false', () => {
    const r = run('<%= lastMessageId %>', makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ReferenceError');
  });

  it('酒馆助手扩展 API 未注入 → ok:false（走调用方 D8 回退）', () => {
    const r = run('<% getChatMessages(-1) %>', makeCtx());
    expect(r.ok).toBe(false);
  });

  it('显式 throw 被捕获', () => {
    const r = run('<% throw new Error("boom") %>', makeCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('boom');
  });

  it('访问 undefined 的属性 → ok:false', () => {
    const r = run('<%= getMessageVar("无").深 %>', makeCtx());
    expect(r.ok).toBe(false);
  });
});

describe('执行失败 → vars 整体回滚', () => {
  it('半途写入被丢弃，且 vars 对象引用不变', () => {
    const ctx = makeCtx({ vars: { 原有: 1 } });
    const before = ctx.vars;
    const r = run('<% setMessageVar("新写", 2) %><%= lastMessageId %>', ctx);
    expect(r.ok).toBe(false);
    expect(ctx.vars).toBe(before); // 引用不变
    expect(ctx.vars).toEqual({ 原有: 1 }); // 内容回滚
  });

  it('对活引用子树的写也被回滚', () => {
    const ctx = makeCtx({ vars: { 事件: { 阶段: 1 } } });
    const r = run('<% getMessageVar("stat_data.事件").阶段 = 99 %><% throw new Error("x") %>', ctx);
    expect(r.ok).toBe(false);
    expect(ctx.vars.事件.阶段).toBe(1);
  });

  it('回滚会删掉失败前新增的顶层键', () => {
    const ctx = makeCtx({ vars: {} });
    run('<% vars.脏 = 1 %><% throw new Error("x") %>', ctx);
    expect(Object.keys(ctx.vars)).toEqual([]);
  });

  it('数组内容回滚', () => {
    const ctx = makeCtx({ vars: { 信号: ['a'] } });
    run('<% getMessageVar("信号").push("b") %><% throw new Error("x") %>', ctx);
    expect(ctx.vars.信号).toEqual(['a']);
  });

  it('成功执行时写入保留', () => {
    const ctx = makeCtx({ vars: {} });
    const r = run('<% setMessageVar("留下", 1) %>ok', ctx);
    expect(r).toEqual({ ok: true, rendered: 'ok' });
    expect(ctx.vars.留下).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 环安全 —— 回归锚（P1-3）
// 条目 A 把草稿写成自引用后，条目 B 取回滚快照时旧实现会 RangeError 直接漏出，
// 违反「executeEjsEntry 永不抛」的契约。
// ═══════════════════════════════════════════════════════════

describe('环安全（自引用草稿）', () => {
  it('条目 A 写入自引用后，条目 B 照常执行、不抛', () => {
    const ctx = makeCtx({ vars: {} });
    const a = run('<% vars.自引 = vars %>A', ctx);
    expect(a.ok).toBe(true);
    expect(ctx.vars.自引).toBe(ctx.vars);

    const b = run('<% setMessageVar("正常", 1) %>B', ctx);
    expect(b).toEqual({ ok: true, rendered: 'B' });
    expect(ctx.vars.正常).toBe(1);
  });

  it('草稿含环时条目失败 → 回滚不炸，半途写被丢弃', () => {
    const ctx = makeCtx({ vars: { 原有: 1 } });
    run('<% vars.自引 = vars %>', ctx);
    const before = ctx.vars;

    const r = run('<% setMessageVar("脏", 9) %><% throw new Error("x") %>', ctx);
    expect(r.ok).toBe(false);
    expect(ctx.vars).toBe(before); // 引用不变
    expect(ctx.vars.脏).toBeUndefined(); // 半途写回滚
    expect(ctx.vars.原有).toBe(1);
    expect(ctx.vars.自引).toBeDefined(); // 环那一支仍在（内容回滚，不保自引用身份）
  });

  it('互指子树（间接环）也能安全快照', () => {
    const ctx = makeCtx({ vars: {} });
    const a = run(
      '<% vars.甲 = { 名: "甲" }; vars.乙 = { 名: "乙", 指: vars.甲 }; vars.甲.指 = vars.乙 %>',
      ctx,
    );
    expect(a.ok).toBe(true);
    expect(run('<%= getMessageVar("甲.名") %>', ctx)).toEqual({ ok: true, rendered: '甲' });
  });

  it('含环的 stats 子树读不死循环', () => {
    const 环: any = { 名: '环' };
    环.自己 = 环;
    const ctx = makeCtx({ stats: { 节点: 环 } });
    expect(render('<%= getMessageVar("stat_data.节点").名 %>', ctx)).toBe('环');
  });
});

// ═══════════════════════════════════════════════════════════
// stats 只读隔离 —— 回归锚（P2-1）
// 整树读（空路径 / 裸 variables.stat_data）此前把 stats 顶层子树以活引用暴露，
// 模板深改会污染 pass 级共享 stats。
// ═══════════════════════════════════════════════════════════

describe('stats 只读隔离（整树读的深改不回流）', () => {
  it('经 variables.stat_data 深改后，同 ctx 下一条目读 stats 原值不脏', () => {
    const ctx = makeCtx({ stats: { 主角: { 生命值: 100 } } });
    const a = run('<% variables.stat_data.主角.生命值 = 999 %>改完', ctx);
    expect(a.ok).toBe(true);

    expect(ctx.stats.主角.生命值).toBe(100); // 共享 stats 未被污染
    expect(render('<%= stats.主角.生命值 %>', ctx)).toBe('100');
    expect(render('<%= getMessageVar("stat_data.主角.生命值") %>', ctx)).toBe('100');
  });

  it('空路径整树读的深改同样不回流', () => {
    const ctx = makeCtx({ stats: { 主角: { 生命值: 100 } } });
    run('<% getMessageVar("stat_data").主角.生命值 = 1 %>', ctx);
    expect(ctx.stats.主角.生命值).toBe(100);
  });

  it('vars 侧仍是活引用 —— 共写草稿，深改就是真实写（契约内行为）', () => {
    const ctx = makeCtx({ vars: { 事件: { 阶段: 1 } } });
    const r = run('<% variables.stat_data.事件.阶段 = 5 %>', ctx);
    expect(r.ok).toBe(true);
    expect(ctx.vars.事件.阶段).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════
// 沙盒
// ═══════════════════════════════════════════════════════════

describe('沙盒注入面', () => {
  it('原生 Math / JSON 可用', () => {
    expect(render('<%= Math.max(3, 7) %>')).toBe('7');
    expect(render('<%= JSON.stringify({ a: 1 }) %>')).toBe('{"a":1}');
  });

  it('String / Number / Boolean / RegExp / Array / Object 可用', () => {
    expect(render('<%= String(1) + Number("2") + Boolean(1) %>')).toBe('12true');
    expect(render('<%= new RegExp("a").test("bab") %>')).toBe('true');
    expect(render('<%= Array.isArray([]) %>')).toBe('true');
    expect(render('<%= Object.keys({ a: 1 }).join() %>')).toBe('a');
  });

  it('_ 是自研 lodash shim', () => {
    const ctx = makeCtx({ vars: { list: [3, 1, 3] } });
    expect(render('<%= _.uniq(getMessageVar("list")).join("-") %>', ctx)).toBe('3-1');
    expect(render('<%= _.trim("  x  ") %>')).toBe('x');
  });

  it('危险全局被遮蔽为 undefined（失误防护，非安全边界）', () => {
    for (const name of [
      'globalThis',
      'window',
      'document',
      'fetch',
      'XMLHttpRequest',
      'localStorage',
      'indexedDB',
      'self',
      'top',
      'parent',
      'frames',
      'navigator',
      'location',
    ]) {
      expect(render(`<%= typeof ${name} %>`)).toBe('undefined');
    }
  });

  // 🔴 回归锚（P1-2）：遮蔽名单必须与 script-executor.ts 的 SANDBOX_SHADOW_GLOBALS 同口径（设计 D3）。
  // Function 是最直接的构造器逃逸写法，定时器/长连接则会让「条目跑完还在后台跑」。
  it('与 script-executor 对齐的补充名单同样被遮蔽', () => {
    for (const name of ['Function', 'setTimeout', 'setInterval', 'WebSocket', 'sessionStorage']) {
      expect(render(`<%= typeof ${name} %>`)).toBe('undefined');
    }
  });

  it('遮蔽 Function 不影响编译器自身（外层 new Function 照常工作）', () => {
    // 形参遮蔽只作用于模板代码作用域；本条能渲染出来即证明编译链未受影响
    expect(render('编译正常 <%= 1 + 1 %>')).toBe('编译正常 2');
  });

  it('严格模式：给未声明变量赋值抛错而非泄成全局', () => {
    const r = run('<% 泄漏 = 1 %>', makeCtx());
    expect(r.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 语料形态综合（golden 雏形）
// ═══════════════════════════════════════════════════════════

describe('语料形态综合', () => {
  it('冰之歌骨架：等级门槛 + 触发时间簿记 + 跨块条件正文', () => {
    const tpl = [
      '<%_',
      "let time = getMessageVar('stat_data.事件.冰之歌.触发时间') || null;",
      "const level = getMessageVar('stat_data.主角.等级', { defaults: 0 });",
      'if (level >= 10 && time == null) {',
      "  time = getMessageVar('stat_data.世界.时间') || null;",
      "  setMessageVar('stat_data.事件.冰之歌.触发时间', time);",
      '}',
      '_%>',
      '<%_ if (time != null) { _%>',
      '- [<%= time _%>] 北境长垣防线崩溃',
      '<%_ } _%>',
    ].join('\n');

    // 等级不足 → 不簿记、不输出
    const low = makeCtx({
      stats: { 主角: { 等级: 3 }, 世界: { 时间: '复兴纪元001年-05月-24日' } },
    });
    expect(render(tpl, low)).toBe('');
    expect(low.vars).toEqual({});

    // 等级达标 → 首次簿记并输出
    const hit = makeCtx({
      stats: { 主角: { 等级: 12 }, 世界: { 时间: '复兴纪元001年-05月-24日' } },
    });
    expect(render(tpl, hit)).toBe('- [复兴纪元001年-05月-24日] 北境长垣防线崩溃\n');
    expect(hit.vars.事件.冰之歌.触发时间).toBe('复兴纪元001年-05月-24日');

    // 跨回合读回：vars 已有触发时间，时间推进后仍输出首次触发的时间戳
    const later = makeCtx({
      stats: { 主角: { 等级: 12 }, 世界: { 时间: '复兴纪元001年-06月-01日' } },
      vars: { 事件: { 冰之歌: { 触发时间: '复兴纪元001年-05月-24日' } } },
    });
    expect(render(tpl, later)).toBe('- [复兴纪元001年-05月-24日] 北境长垣防线崩溃\n');
  });

  it('pass 内状态机：同一 ctx 上前条目的写后条目立即可见', () => {
    const ctx = makeCtx();
    render('<% setMessageVar("事件.阶段", 2) %>', ctx);
    expect(render('<%= getMessageVar("stat_data.事件.阶段") %>', ctx)).toBe('2');
  });
});
