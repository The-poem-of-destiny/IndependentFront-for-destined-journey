/**
 * beautifier.test.ts —— 美化器核心纯函数（autoEnable 解析 + 信号提取）
 *
 * 🔴 2026-08-02 回归防护：`resolveAutoEnable` 三维匹配契约钉死。
 * 注意：**游戏内激活信号按「启用的世界书条目」**（useBeautify 只传 worldBookIds/
 * worldBookEntryUids，不传 characterNames）——角色是否在场不影响规则激活。
 * characterNames 维度仍保留为引擎函数能力（部分角色标签美化规则同时绑了 uid），
 * 但消费方（useBeautify）不依赖它做游戏内判断。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAutoEnable,
  collectActiveSignalsFromEntries,
  mergeRules,
  processRules,
} from './beautifier';
import type { BeautifierRule } from './types';

function rule(over: Partial<BeautifierRule>): BeautifierRule {
  return {
    id: 'r1',
    name: '测试规则',
    scope: 'maintext',
    pattern: 'x',
    flags: 'g',
    replacement: 'y',
    enabled: false,
    order: 0,
    isBuiltin: true,
    locked: false,
    ...over,
  };
}

// ========== collectActiveSignalsFromEntries ==========

describe('collectActiveSignalsFromEntries', () => {
  it('解析 partition:uid 到 worldBookIds + entryUids', () => {
    const r = collectActiveSignalsFromEntries(['system_core:413', 'dlc:100']);
    expect(r.activeEntryUids.has(413)).toBe(true);
    expect(r.activeEntryUids.has(100)).toBe(true);
    expect(r.activeWorldBookIds.has('system_core')).toBe(true);
    expect(r.activeWorldBookIds.has('dlc')).toBe(true);
  });

  it('无冒号的条目被忽略', () => {
    const r = collectActiveSignalsFromEntries(['invalid', 'system_core:413']);
    expect(r.activeEntryUids.size).toBe(1);
    expect(r.activeEntryUids.has(413)).toBe(true);
  });

  it('空数组 → 空集合', () => {
    const r = collectActiveSignalsFromEntries([]);
    expect(r.activeEntryUids.size).toBe(0);
    expect(r.activeWorldBookIds.size).toBe(0);
  });
});

// ========== resolveAutoEnable 三维匹配 ==========

describe('resolveAutoEnable — worldBookEntryUids 维度', () => {
  it('命中 uid → enabled + locked', () => {
    const r = rule({ autoEnable: { worldBookEntryUids: [413] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set([413]), new Set());
    expect(out.enabled).toBe(true);
    expect(out.locked).toBe(true);
  });

  it('未命中 → 保持 disabled', () => {
    const r = rule({ autoEnable: { worldBookEntryUids: [413] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set([999]), new Set());
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — characterNames 维度（🔴 修复核心）', () => {
  it('命中角色名 → enabled + locked（如 <dalian> 规则靠妲丽安激活）', () => {
    const r = rule({ autoEnable: { characterNames: ['妲丽安'] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set(['妲丽安']));
    expect(out.enabled).toBe(true);
    expect(out.locked).toBe(true);
  });

  it('角色名未在场 → 保持 disabled', () => {
    const r = rule({ autoEnable: { characterNames: ['妲丽安'] } });
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set(['艾莉亚']));
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — worldBookIds 维度', () => {
  it('命中世界书 id → enabled + locked', () => {
    const r = rule({ autoEnable: { worldBookIds: ['system_core'] } });
    const [out] = resolveAutoEnable([r], new Set(['system_core']), new Set(), new Set());
    expect(out.enabled).toBe(true);
  });

  it('未命中 → 保持 disabled', () => {
    const r = rule({ autoEnable: { worldBookIds: ['system_core'] } });
    const [out] = resolveAutoEnable([r], new Set(['dlc']), new Set(), new Set());
    expect(out.enabled).toBe(false);
  });
});

describe('resolveAutoEnable — 三维 OR 匹配', () => {
  it('规则同时绑 uid + 角色名，任一命中即激活', () => {
    // 与真实 dalian 规则同构：worldBookEntryUids + characterNames 都有
    const r = rule({ autoEnable: { worldBookEntryUids: [413], characterNames: ['妲丽安'] } });
    // 只命中角色名（uid 未命中）也激活
    const [byName] = resolveAutoEnable([r], new Set(), new Set([999]), new Set(['妲丽安']));
    expect(byName.enabled).toBe(true);
    // 只命中 uid（角色不在场）也激活
    const [byUid] = resolveAutoEnable([r], new Set(), new Set([413]), new Set(['艾莉亚']));
    expect(byUid.enabled).toBe(true);
  });

  it('无 autoEnable 的规则不受影响', () => {
    const r = rule({});
    const [out] = resolveAutoEnable([r], new Set(), new Set(), new Set());
    expect(out.enabled).toBe(false);
    expect(out.locked).toBe(false);
  });
});

describe('mergeRules — 手动翻转内置默认状态', () => {
  it('同一份兼容 ID 列表可关闭默认开启规则并开启默认关闭规则', () => {
    const enabledByDefault = rule({ id: 'on', enabled: true });
    const disabledByDefault = rule({ id: 'off', enabled: false });
    const merged = mergeRules(
      [enabledByDefault, disabledByDefault],
      [],
      ['on', 'off'],
      new Set(),
      new Set(),
      new Set(),
    );

    expect(merged.find(({ id }) => id === 'on')?.enabled).toBe(false);
    expect(merged.find(({ id }) => id === 'off')?.enabled).toBe(true);
  });

  it('auto-enabled locked rules cannot be flipped off', () => {
    const preset = rule({
      id: 'auto',
      enabled: false,
      autoEnable: { worldBookEntryUids: [413] },
    });
    const [merged] = mergeRules([preset], [], ['auto'], new Set(), new Set([413]), new Set());

    expect(merged).toMatchObject({ enabled: true, locked: true });
  });
});

// ========== processRules ==========

describe('processRules — 原文匹配 + 占位符保护 (2026-08-02 回归)', () => {
  function tagRule(over: Partial<BeautifierRule> = {}): BeautifierRule {
    return rule({
      pattern: '<dalian name="(.*?)" mood="(.*?)">\\s*([\\s\\S]*?)\\s*<\\/dalian>',
      replacement: '<div class="phantom">$1-$2-$3</div>',
      enabled: true,
      ...over,
    });
  }

  it('🔴 回归: 依赖字面尖括号的标签规则必须匹配（先整体 escape 会让它失效）', () => {
    // 2026-08-02: d185286 的 P1-01 在 processRules 开头 escapeHtmlBasic(text)，
    // `<dalian>` 变 `&lt;dalian&gt;` → 22 条规则里 13 条标签规则全部失配。
    const out = processRules('<dalian name="妲丽安" mood="思考"> 你好。 </dalian>', 'maintext', [
      tagRule(),
    ]);
    expect(out).toContain('<div class="phantom">');
    expect(out).toContain('妲丽安-思考-你好。');
    // 原始标签应被消费掉，不再出现
    expect(out).not.toContain('<dalian');
    expect(out).not.toContain('&lt;dalian');
  });

  it('捕获组按原生 JS replace 语义原样代入，交由隔离渲染面承载', () => {
    const r = tagRule();
    const out = processRules('<dalian name="<x>" mood="m"> 文本 </dalian>', 'maintext', [r]);
    expect(out).toContain('<x>');
    expect(out).toContain('<div class="phantom">');
    expect(out).toContain('<x>-m-文本');
  });

  it('🔴 未匹配的原文恶意片段必须被转义成纯文本实体（P1-01 XSS 防线不降级）', () => {
    const out = processRules('<img src=x onerror=alert(1)>', 'maintext', [tagRule()]);
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
  });

  it('正常正文原样保留（无匹配时不被误伤）', () => {
    const out = processRules('夜色渐深。', 'maintext', [tagRule()]);
    expect(out).toBe('夜色渐深。');
  });

  it('对话卡片规则（方括号格式）在原文匹配下正常工作', () => {
    const r = rule({
      pattern: '\\[([^\\]]+)\\](?:\\{([^}]*)\\})?\\("([^"]*)"\\)',
      replacement: '<div class="dialogue-card">$1: $3</div>',
      enabled: true,
    });
    const out = processRules('[妲丽安]{思考}("你来了")', 'maintext', [r]);
    expect(out).toContain('<div class="dialogue-card">');
    expect(out).toContain('妲丽安: 你来了');
  });

  it('多条规则按 order 升序执行（先小 order 后大 order）', () => {
    // 同 pattern 两条规则，先跑的那条消费原文 → 断言低 order 的先执行
    const r1 = rule({ pattern: '危险', replacement: '警示', enabled: true, order: 1 });
    const r2 = rule({ pattern: '危险', replacement: '警告', enabled: true, order: 2 });
    const out = processRules('前方危险！', 'maintext', [r2, r1]); // 传入顺序打乱
    expect(out).toBe('前方警示！'); // order 1 先消费原文，order 2 失配
  });
});

// ========== item_info / task_info 卡片放行 (2026-08-02) ==========

describe('processRules — item_info/task_info 卡片', () => {
  it('🔴 回归: <item_info> 内 HTML 放行渲染（不再转义成 &lt;item_info&gt; 文本）', () => {
    const html = `<item_info>
<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:8px;padding:12px;">
<div style="font-weight:bold;color:#7eb3ff;">🎒 初始行囊</div>
<div><b style="color:#b8d4ff;">📜 法师长袍</b> <span style="color:#9acd32;">◆ 优良</span></div>
</div>
</item_info>`;
    const out = processRules(`正文前。\n\n${html}\n\n正文后。`, 'maintext', []);
    // 卡片 HTML 原样渲染（含内联样式），标签不再漏出
    expect(out).toContain('linear-gradient(135deg,#1a1a2e');
    expect(out).toContain('🎒 初始行囊');
    expect(out).toContain('法师长袍');
    expect(out).not.toContain('&lt;item_info&gt;');
    expect(out).not.toContain('</item_info>');
  });

  it('🔴 回归: <task_info> 同样放行', () => {
    const html = `<task_info><div style="color:#fff;">📖 主线委托</div></task_info>`;
    const out = processRules(html, 'maintext', []);
    expect(out).toContain('📖 主线委托');
    expect(out).not.toContain('&lt;task_info&gt;');
  });

  it('保留 <script> 结构，由 UI opaque iframe 隔离执行', () => {
    const html = `<item_info><div>安全内容</div><script>alert(1)</script></item_info>`;
    const out = processRules(html, 'maintext', []);
    expect(out).toContain('安全内容');
    expect(out).toContain('<script>alert(1)</script>');
  });

  it('保留事件属性，由 UI opaque iframe 隔离执行', () => {
    const html = `<item_info><img src=x onerror=alert(1)><div onclick="steal()">卡</div></item_info>`;
    const out = processRules(html, 'maintext', []);
    expect(out).toContain('onerror=alert(1)');
    expect(out).toContain('onclick="steal()"');
    expect(out).toContain('卡');
  });

  it('保留 URL 结构，但不把它放进应用 DOM', () => {
    const html = `<item_info><a href="javascript:alert(1)">点我</a></item_info>`;
    const out = processRules(html, 'maintext', []);
    expect(out).toContain('javascript:alert(1)');
    expect(out).toContain('点我');
  });

  it('未闭合 <item_info>（AI 漏写闭合标签）→ 保持原文转义，不崩溃', () => {
    const out = processRules('<item_info>没闭合的卡片', 'maintext', []);
    // 不崩溃，未匹配原文被转义成纯文本
    expect(typeof out).toBe('string');
    expect(out).toContain('&lt;item_info&gt;');
  });
});
