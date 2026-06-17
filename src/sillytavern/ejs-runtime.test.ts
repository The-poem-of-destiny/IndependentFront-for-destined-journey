/**
 * ejs-runtime.ts — EJS 沙盒模板评估器测试
 *
 * Phase 4.6: 纯函数测试，无需 DB/浏览器环境。
 * 覆盖所有导出: EjsRuntime (render / renderAll / getMutations), renderEjs
 *
 * 重要: 沙盒仅暴露 getMessageVar / setMessageVar / Math / JSON，
 * 不直接暴露变量名。每个 <% %> 块是独立的 new Function，不支持跨块控制流。
 */
import { describe, it, expect } from 'vitest';
import { EjsRuntime, renderEjs } from './ejs-runtime';

// ========== 纯文本 & 基础输出 ==========

describe('renderEjs — 纯文本/基础', () => {
  it('纯文本无 EJS 标签时原样返回', () => {
    const result = renderEjs('Hello, World!', {});
    expect(result.rendered).toBe('Hello, World!');
    expect(result.errors).toEqual([]);
    expect(result.mutations).toEqual({});
  });

  it('空模板返回空字符串', () => {
    const result = renderEjs('', {});
    expect(result.rendered).toBe('');
    expect(result.errors).toEqual([]);
  });

  it('<%= expr %> 将表达式结果转为字符串输出', () => {
    const result = renderEjs('Hello <%= "World" %>!', {});
    expect(result.rendered).toBe('Hello World!');
    expect(result.errors).toHaveLength(0);
  });

  it('<%= expr %> 数字表达式可正常输出', () => {
    const result = renderEjs('Count: <%= 1 + 2 %>', {});
    expect(result.rendered).toBe('Count: 3');
  });

  it('<%= expr %> 通过 getMessageVar 读取变量并输出', () => {
    const result = renderEjs('Hello <%= getMessageVar("name") %>!', { name: '主人' });
    expect(result.rendered).toBe('Hello 主人!');
    expect(result.errors).toHaveLength(0);
  });

  it('<%- unescaped %> 与 <%= %> 行为一致，直接输出字符串', () => {
    const result = renderEjs('Value: <%- getMessageVar("val") %>.', { val: 99 });
    expect(result.rendered).toBe('Value: 99.');
    expect(result.errors).toHaveLength(0);
  });

  it('<%= expr %> 对 null 值不输出任何内容', () => {
    const result = renderEjs('Before<%= null %>After', {});
    expect(result.rendered).toBe('BeforeAfter');
  });

  it('<%= expr %> 对 undefined 值不输出任何内容', () => {
    const result = renderEjs('Before<%= undefined %>After', {});
    expect(result.rendered).toBe('BeforeAfter');
  });

  it('<%= expr %> 布尔值 true 输出字符串 "true"', () => {
    const result = renderEjs('<%= true %>', {});
    expect(result.rendered).toBe('true');
  });

  it('<%= expr %> 数字 0 输出字符串 "0"（0 不是 null/undefined）', () => {
    const result = renderEjs('<%= 0 %>', {});
    expect(result.rendered).toBe('0');
  });
});

// ========== 代码块执行 ==========

describe('renderEjs — 代码块', () => {
  it('<% code %> 执行代码但不输出任何内容', () => {
    const result = renderEjs('<% setMessageVar("x", 42) %>done', {});
    expect(result.rendered).toBe('done');
    expect(result.mutations).toHaveProperty('x', 42);
  });

  it('<%_ code _%> trim-mode 代码块执行无输出', () => {
    const result = renderEjs('<%_ setMessageVar("y", 100) _%>end', {});
    expect(result.rendered).toBe('end');
    expect(result.mutations).toHaveProperty('y', 100);
  });

  it('if/else 条件渲染 — 三元表达式走 if 分支', () => {
    // 每个 <% %> 是独立 new Function，不支持跨块控制流。
    // 条件渲染必须用单块三元表达式。
    const template = '<%= getMessageVar("score") >= 60 ? "及格" : "不及格" %>';
    const result = renderEjs(template, { score: 80 });
    expect(result.rendered).toBe('及格');
  });

  it('if/else 条件渲染 — 三元表达式走 else 分支', () => {
    const template = '<%= getMessageVar("score") >= 60 ? "及格" : "不及格" %>';
    const result = renderEjs(template, { score: 30 });
    expect(result.rendered).toBe('不及格');
  });

  it('for 循环在单个代码块内构建结果，通过 setMessageVar 输出', () => {
    // 单块内完成循环 + setMessageVar，再用 output 块输出
    const template =
      '<% let arr = []; for (let i = 0; i < getMessageVar("count"); i++) { arr.push("[" + i + "]"); } setMessageVar("out", arr.join("")); %><%= getMessageVar("out") %>';
    const result = renderEjs(template, { count: 3 });
    expect(result.rendered).toBe('[0][1][2]');
  });

  it('for 循环遍历数组在单块内构建结果', () => {
    const template =
      '<% let s = ""; for (const item of getMessageVar("items")) { s += "-" + item; } setMessageVar("out", s); %><%= getMessageVar("out") %>';
    const result = renderEjs(template, { items: ['a', 'b', 'c'] });
    expect(result.rendered).toBe('-a-b-c');
  });

  it('代码块内可使用 let/const 声明局部变量（不跨块共享）', () => {
    const template =
      '<% let result = []; for (let i = 0; i < 3; i++) { result.push(i * 2); } setMessageVar("doubled", result.join(",")); %><%= getMessageVar("doubled") %>';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('0,2,4');
  });
});

// ========== getMessageVar / setMessageVar ==========

describe('EjsRuntime — getMessageVar / setMessageVar', () => {
  it('getMessageVar 读取顶层变量', () => {
    const result = renderEjs('<%= getMessageVar("name") %>', { name: 'Alice' });
    expect(result.rendered).toBe('Alice');
  });

  it('getMessageVar 支持嵌套对象路径', () => {
    const vars = { user: { profile: { hp: 100 } } };
    const result = renderEjs('<%= getMessageVar("user.profile.hp") %>', vars);
    expect(result.rendered).toBe('100');
  });

  it('getMessageVar 路径不存在时返回 undefined，不输出内容', () => {
    const result = renderEjs('<%= getMessageVar("nested.missing.path") %>', {});
    expect(result.rendered).toBe('');
    expect(result.errors).toHaveLength(0);
  });

  it('getMessageVar 中间值为 null 时返回 undefined', () => {
    const vars = { user: null };
    const result = renderEjs('<%= getMessageVar("user.name") %>', vars);
    expect(result.rendered).toBe('');
    expect(result.errors).toHaveLength(0);
  });

  it('getMessageVar 中间值为非对象时返回 undefined', () => {
    const vars = { user: 42 };
    const result = renderEjs('<%= getMessageVar("user.name") %>', vars);
    expect(result.rendered).toBe('');
    expect(result.errors).toHaveLength(0);
  });

  it('getMessageVar 自动去除 stat_data. 前缀', () => {
    const vars = { hp: 150 };
    const result = renderEjs('<%= getMessageVar("stat_data.hp") %>', vars);
    expect(result.rendered).toBe('150');
  });

  it('setMessageVar 写入 mutations 缓冲区', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("gold", 500) %>');
    expect(runtime.getMutations()).toHaveProperty('gold', 500);
  });

  it('setMessageVar 支持嵌套对象写入', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("player.stats.hp", 75) %>');
    const muts = runtime.getMutations();
    expect(muts).toEqual({ player: { stats: { hp: 75 } } });
  });

  it('setMessageVar 自动去除 stat_data. 前缀', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("stat_data.mana", 200) %>');
    expect(runtime.getMutations()).toHaveProperty('mana', 200);
  });

  it('mutations 在多次 render 调用间累积', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("a", 1) %>');
    runtime.render('<% setMessageVar("b", 2) %>');
    const muts = runtime.getMutations();
    expect(muts).toEqual({ a: 1, b: 2 });
  });

  it('setMessageVar 写入后 getMessageVar 可在同一 render 中读取', () => {
    const template = '<% setMessageVar("hp", 50) %><%= getMessageVar("hp") %>';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('50');
  });

  it('setMessageVar 写入后 getMessageVar 可在后续 render 中读取', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("gold", 100) %>');
    const result = runtime.render('<%= getMessageVar("gold") %>');
    expect(result.rendered).toBe('100');
  });

  it('getMessageVar 先查 mutations 再查 variables（mutations 优先）', () => {
    const runtime = new EjsRuntime({ variables: { color: 'red' } });
    runtime.render('<% setMessageVar("color", "blue") %>');
    const result = runtime.render('<%= getMessageVar("color") %>');
    expect(result.rendered).toBe('blue');
  });

  it('getMessageVar 读取变量中数字类型的值', () => {
    const result = renderEjs('<%= getMessageVar("hp") + 10 %>', { hp: 90 });
    expect(result.rendered).toBe('100');
  });

  it('getMessageVar 读取变量中布尔类型的值', () => {
    const result = renderEjs('<%= getMessageVar("alive") %>', { alive: true });
    expect(result.rendered).toBe('true');
  });

  it('setMessageVar 覆盖已存在的 mutation 键', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("x", 1) %>');
    runtime.render('<% setMessageVar("x", 2) %>');
    expect(runtime.getMutations()).toHaveProperty('x', 2);
  });
});

// ========== 沙盒 API ==========

describe('EjsRuntime — 沙盒 API', () => {
  it('Math.random() 在沙盒中可用且返回 0~1 之间的数值', () => {
    const result = renderEjs('<%= Math.random() %>', {});
    const num = parseFloat(result.rendered);
    expect(num).toBeGreaterThanOrEqual(0);
    expect(num).toBeLessThan(1);
    expect(result.errors).toHaveLength(0);
  });

  it('JSON.stringify 在沙盒中可用', () => {
    const vars = { data: { x: 1, y: 2 } };
    const result = renderEjs('<%= JSON.stringify(getMessageVar("data")) %>', vars);
    const parsed = JSON.parse(result.rendered);
    expect(parsed).toEqual({ x: 1, y: 2 });
  });

  it('Math.floor 在沙盒中可用', () => {
    const result = renderEjs('<%= Math.floor(3.14) %>', {});
    expect(result.rendered).toBe('3');
  });

  it('Math.max / Math.min 在沙盒中可用', () => {
    const result = renderEjs('<%= Math.max(10, 20) %>,<%= Math.min(5, 3) %>', {});
    expect(result.rendered).toBe('20,3');
  });

  it('代码块内可调用多个沙盒 API 组合', () => {
    const template =
      '<% setMessageVar("randomValue", Math.floor(Math.random() * 100)); %><%= getMessageVar("randomValue") %>';
    const result = renderEjs(template, {});
    const val = parseInt(result.rendered, 10);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(100);
  });
});

// ========== 错误隔离 ==========

describe('EjsRuntime — 错误隔离', () => {
  it('未闭合的 EJS 标签作为纯文本输出', () => {
    const result = renderEjs('Hello <%= name !>', { name: 'World' });
    expect(result.rendered).toBe('Hello <%= name !>');
    expect(result.errors).toHaveLength(0);
  });

  it('未闭合的 EJS 标签在模板开头时作为纯文本', () => {
    const result = renderEjs('<%= unfinished', {});
    expect(result.rendered).toBe('<%= unfinished');
    expect(result.errors).toHaveLength(0);
  });

  it('未闭合的 <% 无匹配时整体作为纯文本', () => {
    const result = renderEjs('start <% incomplete', {});
    expect(result.rendered).toBe('start <% incomplete');
    expect(result.errors).toHaveLength(0);
  });

  it('EJS 代码块运行时错误记录到 errors 数组', () => {
    const template = 'start<% throw new Error("故意的错误") %>end';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('startend');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('EJS 块错误');
    expect(result.errors[0]).toContain('故意的错误');
  });

  it('EJS 输出块表达式错误记录到 errors 数组', () => {
    const template = 'before<%= nonExistentVar %>after';
    const result = renderEjs(template, {});
    // nonExistentVar 未定义，ReferenceError
    expect(result.rendered).toBe('beforeafter');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('EJS 块错误');
    expect(result.errors[0]).toContain('nonExistentVar');
  });

  it('代码块语法错误记录到 errors 数组', () => {
    const template = '<% let x = ; %>done';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('done');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('EJS 块错误');
  });

  it('EJS 块错误不影响同模板中其他正常块', () => {
    const template = '<%= "good1" %><% throw new Error("bad") %><%= "good2" %>';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('good1good2');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('错误信息超过 100 字符时自动截断', () => {
    const longMsg = 'A'.repeat(200);
    const template = `<% throw new Error("${longMsg}") %>`;
    const result = renderEjs(template, {});
    expect(result.errors.length).toBeGreaterThan(0);
    // "EJS 块错误: " 前缀 9 字符 + 最多 100 字符错误信息
    expect(result.errors[0].length).toBeLessThanOrEqual(9 + 100);
  });
});

// ========== EjsRuntime 类方法 ==========

describe('EjsRuntime 类', () => {
  it('构造时可传入预置 mutations，render 中可见', () => {
    const runtime = new EjsRuntime({
      variables: {},
      mutations: { existing: 99 },
    });
    const result = runtime.render('<%= getMessageVar("existing") %>');
    expect(result.rendered).toBe('99');
  });

  it('getMutations 返回当前 mutations 快照（浅拷贝）', () => {
    const runtime = new EjsRuntime({ variables: {} });
    runtime.render('<% setMessageVar("k", "v") %>');
    const a = runtime.getMutations();
    const b = runtime.getMutations();
    expect(a).toEqual({ k: 'v' });
    expect(a).not.toBe(b); // 不同引用，说明是副本
  });

  it('renderAll 合并多个模板的渲染结果', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.renderAll([
      'Hello <%= "Alice" %>',
      'World <%= "Bob" %>',
    ]);
    expect(result.rendered).toBe('Hello Alice\nWorld Bob\n');
    expect(result.errors).toHaveLength(0);
    expect(result.mutations).toEqual({});
  });

  it('renderAll 合并多个模板的 mutations', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.renderAll([
      '<% setMessageVar("a", 1) %>first',
      '<% setMessageVar("b", 2) %>second',
    ]);
    expect(result.rendered).toBe('first\nsecond\n');
    expect(result.mutations).toEqual({ a: 1, b: 2 });
  });

  it('renderAll 中前一个模板的 setMessageVar 影响后续模板', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.renderAll([
      '<% setMessageVar("x", 10) %>',
      '<%= getMessageVar("x") %>',
    ]);
    expect(result.rendered).toContain('10');
  });

  it('renderAll 收集所有模板的错误', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.renderAll([
      '<% throw new Error("err1") %>a',
      '<% throw new Error("err2") %>b',
      'c',
    ]);
    expect(result.rendered).toBe('a\nb\nc\n');
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('renderAll 空数组返回空结果', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.renderAll([]);
    expect(result.rendered).toBe('');
    expect(result.mutations).toEqual({});
    expect(result.errors).toHaveLength(0);
  });

  it('renderAll 在初始有 mutations 时正确合并', () => {
    const runtime = new EjsRuntime({
      variables: {},
      mutations: { base: 'original' },
    });
    runtime.renderAll(['<% setMessageVar("added", "new") %>x']);
    const muts = runtime.getMutations();
    expect(muts).toEqual({ base: 'original', added: 'new' });
  });

  it('render 返回结果结构包含 rendered / mutations / errors', () => {
    const runtime = new EjsRuntime({ variables: {} });
    const result = runtime.render('<%= 1 + 1 %>');
    expect(result).toHaveProperty('rendered');
    expect(result).toHaveProperty('mutations');
    expect(result).toHaveProperty('errors');
    expect(result.rendered).toBe('2');
  });
});

// ========== renderEjs 便捷函数 ==========

describe('renderEjs 便捷函数', () => {
  it('renderEjs 通过变量渲染模板', () => {
    const result = renderEjs(
      'Hello <%= getMessageVar("name") %>!',
      { name: '主人' },
    );
    expect(result.rendered).toBe('Hello 主人!');
    expect(result.errors).toHaveLength(0);
  });

  it('renderEjs 返回结果包含 rendered / mutations / errors', () => {
    const result = renderEjs('<%= 1 + 1 %>', {});
    expect(result).toHaveProperty('rendered');
    expect(result).toHaveProperty('mutations');
    expect(result).toHaveProperty('errors');
    expect(result.rendered).toBe('2');
  });

  it('renderEjs 每次调用创建新实例，mutations 不跨调用共享', () => {
    const r1 = renderEjs('<% setMessageVar("x", 1) %>', {});
    const r2 = renderEjs('<%= getMessageVar("x") %>', {});
    // r2 是新实例，r1 的 mutations 不可见
    expect(r2.rendered).toBe('');
  });

  it('renderEjs 的 mutations 在单次调用内可通过 getMessageVar 读取', () => {
    const result = renderEjs(
      '<% setMessageVar("hp", 30) %><%= getMessageVar("hp") %>',
      {},
    );
    expect(result.rendered).toBe('30');
    expect(result.mutations).toHaveProperty('hp', 30);
  });
});

// ========== 混合模板场景 ==========

describe('EjsRuntime — 混合模板场景', () => {
  it('同一模板中文本、code、output 三者混合正确', () => {
    const template =
      '前缀' +
      '<% let items = []; for (let i = 0; i < 3; i++) { items.push(i); } setMessageVar("result", items.join(",")); %>' +
      '<%= getMessageVar("result") %>' +
      '后缀';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('前缀0,1,2后缀');
  });

  it('嵌套变量对象通过 getMessageVar 正确渲染', () => {
    const vars = { player: { name: 'Hero', level: 5 } };
    const template =
      '<%= getMessageVar("player.name") %>' +
      ' Lv.' +
      '<%= getMessageVar("player.level") %>';
    const result = renderEjs(template, vars);
    expect(result.rendered).toBe('Hero Lv.5');
  });

  it('多个独立 EJS 输出块有序拼接', () => {
    const template = '<%= "A" %><%= "B" %><%= "C" %>';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('ABC');
  });

  it('各 EJS 块之间变量不跨块共享（独立 new Function 作用域）', () => {
    // 第一个代码块声明 let name = "test"，第二个输出块无法访问
    const template = '<% let localVar = "secret"; %><%= typeof localVar === "undefined" ? "isolated" : "shared" %>';
    const result = renderEjs(template, {});
    expect(result.rendered).toBe('isolated');
  });

  it('复杂混合模板：计算并输出角色状态摘要', () => {
    const vars = {
      player: { name: 'Hero', hp: 80, maxHp: 100 },
    };
    const template =
      '<%= getMessageVar("player.name") %> ' +
      '<% const hp = getMessageVar("player.hp"); const maxHp = getMessageVar("player.maxHp"); setMessageVar("hpPercent", Math.floor(hp / maxHp * 100)); %>' +
      'HP: <%= getMessageVar("player.hp") %>/<%= getMessageVar("player.maxHp") %> ' +
      '(<%= getMessageVar("hpPercent") %>%)';
    const result = renderEjs(template, vars);
    // The const declaration uses 'const' but the second block needs getMessageVar
    // Wait, the third block needs hpPercent from mutations, that works because setMessageVar wrote it there
    expect(result.rendered).toBe('Hero HP: 80/100 (80%)');
  });
});
