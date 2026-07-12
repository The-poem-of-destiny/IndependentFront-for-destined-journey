/**
 * 输出美化器 — 正则替换管道 (Beautifier)
 *
 * Phase 7e: 对 AI 生成的叙事文本进行基于正则的后处理美化。
 * 内置规则（对话卡片 + 杀增殖）在引擎层定义，用户规则从设置 Store 加载。
 *
 * 设计决策:
 * - 纯函数模块，无副作用，无外部依赖
 * - 内置规则使用 HTML 转义捕获组，防止注入
 * - 编译失败静默跳过，不阻断管道
 */

import type { BeautifierRule } from './types';

// ========== Helpers ==========

/**
 * 将字符串中的 HTML 特殊字符转义为实体。
 * 用于内置规则中防止 AI 输出内容被浏览器解析为 HTML。
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ========== Built-in Rules ==========

/**
 * 返回内置美化规则列表。
 * 内置规则在运行时与用户规则合并，ID 冲突时用户规则覆盖。
 */
export function getBuiltinRules(): BeautifierRule[] {
  return [
    // Rule 1 — 对话卡片: [角色名]{额外信息}("对话内容")
    {
      id: 'builtin-dialogue-card',
      name: '对话卡片',
      scope: 'maintext',
      pattern: '\\[([^\\]]+)\\](?:\\{([^}]*)\\})?\\(\\"([^\\"]*)\\"\\)',
      flags: 'gm',
      replacement:
        '<div class="dialogue-card">' +
        '<div class="dialogue-header">' +
        '<span class="dialogue-avatar">$1</span>' +
        '<span class="dialogue-name">$1</span>' +
        '</div>' +
        '<div class="dialogue-body">"$3"</div>' +
        '</div>',
      enabled: true,
      order: 0,
      isBuiltin: true,
    },

    // Rule 2 — 杀增殖: 移除 AI 过度使用的连接词
    {
      id: 'builtin-kill-proliferation',
      name: '杀增殖',
      scope: 'global',
      pattern: '极其|由于',
      flags: 'gi',
      replacement: '',
      enabled: false,
      order: 1,
      isBuiltin: true,
    },
  ];
}

// ========== Processing Pipeline ==========

/**
 * 对文本应用指定 scope 的活跃规则。
 *
 * 处理流程:
 * 1. 筛选 scope 匹配（或 global）且 enabled 的规则
 * 2. 按 order 升序排序
 * 3. 依次编译正则并替换
 *    - 内置规则: 先对捕获组做 HTML 转义，再代入 replacement
 *    - 用户规则: 直接字符串替换
 * 4. 编译失败静默跳过
 *
 * @param text  原始文本
 * @param scope 当前处理的作用域（maintext / options / summary / thinking）
 * @param rules 全量规则列表（含内置 + 用户）
 * @returns 处理后的文本
 */
export function processRules(text: string, scope: string, rules: BeautifierRule[]): string {
  let result = text;

  const active = rules
    .filter(r => r.enabled && (r.scope === 'global' || r.scope === scope))
    .sort((a, b) => a.order - b.order);

  for (const rule of active) {
    try {
      const re = new RegExp(rule.pattern, rule.flags);
      if (rule.isBuiltin) {
        result = result.replace(re, (...args: (string | number | undefined)[]) => {
          // args: [match, ...groups, offset, string]
          // groupCount 推算: 忽略最后两个参数 (offset, string)
          const groupCount = args.length > 2 ? args.length - 3 : 0;
          let html = rule.replacement;
          for (let i = 1; i <= groupCount; i++) {
            const value = String(args[i] ?? '');
            html = html.split(`$${i}`).join(escapeHtml(value));
          }
          return html;
        });
      } else {
        result = result.replace(re, rule.replacement);
      }
    } catch {
      // 规则编译失败静默跳过，不阻断管道
    }
  }

  return result;
}

/**
 * 美化文本的便捷入口。
 *
 * 合并内置规则与用户规则（同名 ID 用户优先），然后执行 processRules。
 *
 * @param text        原始文本
 * @param scope       当前作用域
 * @param userRules   用户自定义规则
 * @param builtinDisabled 禁用的内置规则 ID 列表
 * @returns 处理后的文本
 */
export function beautify(text: string, scope: string, userRules: BeautifierRule[], builtinDisabled?: string[]): string {
  const builtin = getBuiltinRules();
  const disabledSet = new Set(builtinDisabled ?? []);
  const filteredBuiltin = builtin.map(r => ({
    ...r,
    enabled: r.enabled && !disabledSet.has(r.id),
  }));
  const builtinIds = new Set(builtin.map(r => r.id));
  const merged: BeautifierRule[] = [
    ...filteredBuiltin,
    ...userRules.filter(r => !builtinIds.has(r.id)),
  ];
  return processRules(text, scope, merged);
}
