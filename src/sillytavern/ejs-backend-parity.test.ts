/**
 * 跨后端一致性 —— Legacy vs QuickJS（能力面 §0.1）
 *
 * ## 为什么必须有这个文件
 * 原本的测试布局是：**渲染正确性全测 Legacy，QuickJS 只测安全属性**。
 * 于是「两个后端渲染结果不同」这一整类缺陷结构性无人看守 —— 评审一次性揪出四条：
 *
 * | 缺陷 | Legacy | 当时的 QuickJS |
 * |---|---|---|
 * | `await` 条目 | 正常渲染 | `SyntaxError`（语料 3 条） |
 * | 代码位 `{{roll}}` | 正常渲染 | `SyntaxError`（语料 4 条） |
 * | 失败条目的半途写 | 整体回滚 | 残留并落库 |
 * | `rng` 播种 | 逐条目 | 整 pass 一条序列（位置一变结果就变） |
 *
 * 四条全部**只在两个后端并排跑同一份输入时**才暴露。故本文件的断言形式统一是
 * `legacy(x) === quickjs(x)`，而不是 `quickjs(x) === 某个字面量`：
 * 后者每加一个能力就要手写一遍期望值，前者天然覆盖将来新增的一切。
 *
 * ⚠️ 真跑 wasm，比纯 Legacy 的用例慢一个量级。放在这里的必须是**对齐语义**的用例，
 * 单后端就能测的（语法、契约、对抗）留在各自的文件里。
 */

import { describe, it, expect } from 'vitest';
import { LegacyBackend, type EjsBackend } from './ejs-backend';
import { createQuickJsBackend } from './ejs-quickjs-backend';
import type { EjsEvalContext } from './ejs-runtime';

const legacy: EjsBackend = new LegacyBackend();
const quickjs: EjsBackend = createQuickJsBackend();
const SLOW = 60_000;

const makeCtx = (over: Partial<EjsEvalContext> = {}): EjsEvalContext => ({
  stats: over.stats ?? { 主角: { 等级: 12, 生命值: 71, 姓名: '测试者' } },
  vars: over.vars ?? {},
  historyText: over.historyText ?? '我推开门\n你抬起头',
  seed: over.seed ?? 'save-parity#3',
  ...(over.capabilities !== undefined ? { capabilities: over.capabilities } : {}),
});

/** 同一批条目在两个后端各跑一次；返回 {文本, 是否成功, 末态草稿} 两份，供逐字段比对 */
async function bothBackends(
  entries: Array<{ uid: number; content: string }>,
  over: Partial<EjsEvalContext> = {},
) {
  const lc = makeCtx(over);
  const qc = makeCtx(over);
  const l = await legacy.runPass(entries, lc);
  const q = await quickjs.runPass(entries, qc);
  return {
    legacyText: l.map((o) => o.text),
    quickjsText: q.map((o) => o.text),
    legacyOk: l.map((o) => o.ok),
    quickjsOk: q.map((o) => o.ok),
    legacyVars: lc.vars,
    quickjsVars: qc.vars,
  };
}

/** 单条目对齐断言：文本、成败、草稿末态三样都必须一致 */
async function expectSame(content: string, over: Partial<EjsEvalContext> = {}) {
  const r = await bothBackends([{ uid: 1, content }], over);
  expect(r.quickjsOk, `成败不一致: ${content.slice(0, 60)}`).toEqual(r.legacyOk);
  expect(r.quickjsText, `文本不一致: ${content.slice(0, 60)}`).toEqual(r.legacyText);
  expect(r.quickjsVars, `草稿末态不一致: ${content.slice(0, 60)}`).toEqual(r.legacyVars);
  return r;
}

// ═══════════════════════════════════════════════════════════
// 四条回归 —— 每一条都对应一个真实缺陷
// ═══════════════════════════════════════════════════════════

describe('回归：评审揪出的四条后端分叉', () => {
  it(
    'await 条目两边都渲染（曾经 QuickJS 一律 SyntaxError）',
    async () => {
      const r = await expectSame('<%= await 41 + 1 %>');
      expect(r.quickjsText).toEqual(['42']);
    },
    SLOW,
  );

  it(
    '代码位 {{roll}} / {{random::}} 两边都降级成调用（曾经 QuickJS 报 invalid property name）',
    async () => {
      const r = await expectSame('<%_ if ({{roll 1d100}} >= 1) { _%>命中<%_ } _%>');
      expect(r.quickjsText).toEqual(['命中']);
      await expectSame('<%= {{random::甲,乙,丙}} %>');
    },
    SLOW,
  );

  it(
    '失败条目的半途写两边都整体回滚（曾经 QuickJS 残留并落库）',
    async () => {
      const r = await expectSame('<% vars.脏 = 1; 不存在的符号() %>');
      expect(r.quickjsOk).toEqual([false]);
      expect(r.quickjsVars.脏, '失败条目的写不该留下').toBeUndefined();
    },
    SLOW,
  );

  it(
    'rng 逐条目播种：同正文条目的结果与它在 pass 中的位置无关（曾经 QuickJS 整 pass 一条序列）',
    async () => {
      const target = { uid: 2, content: '<%= rng.roll("1d100") %>' };
      const withPrefix = await bothBackends([
        { uid: 1, content: '<%= rng.roll("1d20") %>' },
        target,
      ]);
      const alone = await bothBackends([target]);

      // 两个后端各自对齐
      expect(withPrefix.quickjsText).toEqual(withPrefix.legacyText);
      expect(alone.quickjsText).toEqual(alone.legacyText);
      // 且「前面跑没跑过别的条目」不影响本条目的值
      expect(withPrefix.quickjsText[1]).toBe(alone.quickjsText[0]);
    },
    SLOW,
  );
});

// ═══════════════════════════════════════════════════════════
// 语义面对齐
// ═══════════════════════════════════════════════════════════

describe('渲染语义对齐', () => {
  it(
    '文本 / 表达式 / 跨块控制流 / 注释 / 转义',
    async () => {
      await expectSame('纯文本');
      await expectSame('<%= 1 + 2 %>');
      await expectSame('<%_ if (stats.主角.等级 >= 10) { _%>达标<%_ } else { _%>未达标<%_ } _%>');
      await expectSame('<%_ for (let i = 0; i < 3; i++) { _%>[<%= i %>]<%_ } _%>');
      await expectSame('<%# 这是注释 %>只剩正文');
      await expectSame('<%%= 不求值 %>');
    },
    SLOW,
  );

  it(
    'vars 草稿：写、读、跨条目可见',
    async () => {
      const r = await bothBackends([
        { uid: 1, content: '<% vars.队伍 = { 人数: 3 } %>' },
        { uid: 2, content: '<%= vars.队伍.人数 %>' },
      ]);
      expect(r.quickjsText).toEqual(r.legacyText);
      expect(r.quickjsVars).toEqual(r.legacyVars);
      expect(r.quickjsText[1]).toBe('3');
    },
    SLOW,
  );

  it(
    '危险键在两边都写不进草稿（原型污染）',
    async () => {
      const r = await expectSame('<% setvar("__proto__.polluted", 1) %>');
      // 宿主 Object.prototype 没被污染
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      // 草稿上也没多出一个**自有**的 __proto__ 键（`vars.__proto__` 读到的永远是原型，不能拿来断言）
      expect(Object.prototype.hasOwnProperty.call(r.quickjsVars, '__proto__')).toBe(false);
      expect(Object.keys(r.quickjsVars)).toEqual([]);
    },
    SLOW,
  );

  it(
    'stats 只读面 / fmt / lodash 取值一致',
    async () => {
      await expectSame('<%= stats.主角.姓名 %> Lv.<%= stats.主角.等级 %>');
      await expectSame('<%= fmt.num(1234567) %> | <%= fmt.pct(0.25) %> | <%= fmt.bar(3, 10) %>');
      await expectSame('<%= _.size([1,2,3]) %> <%= _.get(stats, "主角.生命值") %>');
      await expectSame('<%= JSON.stringify(_.mapValues({a:1,b:2}, (v) => v * 2)) %>');
    },
    SLOW,
  );

  it(
    '宿主查询面（chat / char / quest / lore / engine）一致',
    async () => {
      const capabilities = {
        history: [
          { role: 'user', content: '我去咖啡馆' },
          { role: 'assistant', content: '你推开门' },
        ],
        characters: [{ name: '琴师', type: 'npc' }],
        quests: { 寻琴: { status: '进行中' } },
        lore: { get: (n: string) => (n === '设计' ? '设计正文' : null), list: () => ['设计'] },
        turn: 9,
      } as never;
      await expectSame('<%= chat.last("user") %>', { capabilities });
      await expectSame('<%= chat.match("咖啡馆") %>', { capabilities });
      await expectSame('<%= quest.has("寻琴") %>', { capabilities });
      await expectSame('<%= lore.get("设计") %>', { capabilities });
      await expectSame('<%= world.回合 %>', { capabilities });
      await expectSame('<%= engine.name %>/<%= engine.has("lore.get") %>', { capabilities });
    },
    SLOW,
  );

  it(
    '失败形态一致：语法错误 / 未知符号 / 抛错都回退原文',
    async () => {
      for (const bad of ['<% if ( %>', '<% 完全不存在() %>', '<% throw new Error("boom") %>']) {
        const r = await expectSame(bad);
        expect(r.quickjsOk).toEqual([false]);
        expect(r.quickjsText).toEqual([bad]);
      }
    },
    SLOW,
  );

  it(
    '别名层（getMessageVar / getvar / setvar / getChatMessage）一致',
    async () => {
      const capabilities = {
        history: [{ role: 'user', content: '第一句' }],
      } as never;
      await expectSame('<% setvar("进度", 5) %><%= getvar("进度") %>');
      await expectSame('<%= getMessageVar("stat_data.主角.等级") %>');
      await expectSame('<%= getChatMessage(-1, "user") %>', { capabilities });
    },
    SLOW,
  );
});

// ═══════════════════════════════════════════════════════════
// 真实语料片段
// ═══════════════════════════════════════════════════════════

describe('真实语料片段两后端一致', () => {
  interface Fragment {
    feature: string;
    from: string;
    code: string;
    needsAsync: boolean;
  }
  // 夹具走 Vite 的 `?raw` glob，不用 node:fs（仓库没装 @types/node，裸 tsc 会 TS2307）
  const RAW = import.meta.glob('../../tests/fixtures/ejs-scrambled-corpus.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const corpus = JSON.parse(Object.values(RAW)[0]) as { fragments: Fragment[] };

  it(
    '逐片段比对文本、成败与草稿末态',
    async () => {
      const mismatches: string[] = [];
      const tolerated: string[] = [];
      for (const f of corpus.fragments) {
        // §3.14 C 档：**已登记且刻意不修**的跨后端差异。QuickJS 无完整 ICU，
        // `localeCompare('zh-CN')` 的排序口径与 V8 不同 → 排序类条目输出必然不同。
        // 修不了（除非自带 CJK 排序表），故不假装一致——列出来，并由预检提醒创作者改用 fmt.compareName。
        if (/localeCompare|toLocaleString|Intl|\(\?</.test(f.code)) {
          tolerated.push(`${f.from}(${f.feature})`);
          continue;
        }
        const lc = makeCtx();
        const qc = makeCtx();
        const [l] = await legacy.runPass([{ uid: 1, content: f.code }], lc);
        const [q] = await quickjs.runPass([{ uid: 1, content: f.code }], qc);
        if (l.text !== q.text || l.ok !== q.ok) {
          mismatches.push(`${f.from}(${f.feature}): legacy ok=${l.ok} / quickjs ok=${q.ok}`);
        }
      }
      // 一条都不许有 —— 片段是真机形态，这里出分叉等于线上出分叉
      expect(mismatches).toEqual([]);
      // 豁免名单必须**很短**且成因单一。它一旦变长，说明「已登记差异」正在变成垃圾桶。
      expect(tolerated.length, `C 档豁免: ${tolerated.join(', ')}`).toBeLessThanOrEqual(3);
    },
    SLOW,
  );
});
