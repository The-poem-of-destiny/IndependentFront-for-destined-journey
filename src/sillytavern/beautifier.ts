/**
 * 输出美化器 — 正则替换管道 (Beautifier)
 *
 * Phase 7e: 对 AI 生成的叙事文本进行基于正则的后处理美化。
 * Phase 10i: 预设规则库 (beautifier-rules.json) + 世界书/角色绑定 auto-enable。
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

// ========== Built-in Rules (Legacy) ==========

/**
 * 返回内置美化规则列表。
 *
 * @deprecated Phase 10i: 内置规则已迁移到 data/defaults/beautifier-rules.json。
 *   请使用 loadPresetRules() + mergeRules() 获取完整规则列表。
 *   此函数保留仅用于向后兼容，未来版本将移除。
 */
export function getBuiltinRules(): BeautifierRule[] {
  return [
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

// ========== Preset Rules ==========

/**
 * 从 beautifier-rules.json 加载预设规则库。
 *
 * @returns 预设规则列表（含内置 + 远程导入的规则）
 */
export async function loadPresetRules(): Promise<BeautifierRule[]> {
  try {
    const resp = await fetch('/data/defaults/beautifier-rules.json');
    if (!resp.ok) {
      console.warn('[Beautifier] 预设规则加载失败，回退到 getBuiltinRules():', resp.status);
      return getBuiltinRules();
    }
    const data = await resp.json();
    const raw: any[] = data?.rules ?? [];
    return raw.map((r: any) => ({
      id: r.id,
      name: r.name,
      scope: r.scope ?? 'maintext',
      pattern: r.pattern,
      flags: r.flags ?? 'g',
      replacement: r.replacement,
      enabled: r.defaultEnabled ?? false,
      order: r.order ?? 99,
      isBuiltin: r.isBuiltin ?? true,
      autoEnable: r.autoEnable,
      group: r.group,
      locked: false,
    } satisfies BeautifierRule));
  } catch (err) {
    console.warn('[Beautifier] 预设规则加载异常，回退到 getBuiltinRules():', err);
    return getBuiltinRules();
  }
}

// ========== Auto-Enable Resolution ==========

/**
 * 根据活跃世界书和角色，自动启用匹配的预设规则。
 *
 * 匹配逻辑:
 * - worldBookIds: 任一条目 ID 在活跃世界书集合中 → 匹配
 * - worldBookEntryUids: 任一条目 UID 已启用 → 匹配
 * - characterNames: 任一名字在活跃角色集合中 → 匹配
 * - 以上条件为 OR：任意一个维度匹配即启用
 *
 * 纯函数，不修改原数组。
 *
 * @param rules            预设规则列表
 * @param activeWorldBookIds 活跃世界书的 ID 集合
 * @param activeWorldBookEntryUids 活跃世界书条目的 UID 集合
 * @param activeCharacterNames 活跃角色名集合
 * @returns 处理后的规则列表（locked 字段已置位）
 */
export function resolveAutoEnable(
  rules: BeautifierRule[],
  activeWorldBookIds: Set<string>,
  activeWorldBookEntryUids: Set<number>,
  activeCharacterNames: Set<string>,
): BeautifierRule[] {
  return rules.map(rule => {
    const ae = rule.autoEnable;
    if (!ae) return rule;

    let matched = false;

    // 检查 worldBookIds
    if (ae.worldBookIds?.length) {
      for (const id of ae.worldBookIds) {
        if (activeWorldBookIds.has(id)) { matched = true; break; }
      }
    }

    // 检查 worldBookEntryUids
    if (!matched && ae.worldBookEntryUids?.length) {
      for (const uid of ae.worldBookEntryUids) {
        if (activeWorldBookEntryUids.has(uid)) { matched = true; break; }
      }
    }

    // 检查 characterNames
    if (!matched && ae.characterNames?.length) {
      for (const name of ae.characterNames) {
        if (activeCharacterNames.has(name)) { matched = true; break; }
      }
    }

    if (matched) {
      return { ...rule, enabled: true, locked: true };
    }
    return rule;
  });
}

// ========== Rule Merging ==========

/**
 * 合并预设规则、用户规则和禁用列表，返回最终的规则列表。
 *
 * 合并逻辑:
 * 1. 预设规则默认状态 → 应用 auto-enable 覆盖
 * 2. 用户在 builtinDisabled 中禁掉的规则 → enabled = false（除非 locked）
 * 3. 用户自定义规则追加（同名 ID 用户优先）
 *
 * @param presetRules      loadPresetRules() 返回的预设规则
 * @param userRules        用户自定义规则
 * @param builtinDisabled  用户手动禁用的规则 ID 列表
 * @param activeWorldBookIds 活跃世界书 ID 集合
 * @param activeWorldBookEntryUids 活跃世界书条目 UID 集合
 * @param activeCharacterNames 活跃角色名集合
 * @returns 合并后的规则列表
 */
export function mergeRules(
  presetRules: BeautifierRule[],
  userRules: BeautifierRule[],
  builtinDisabled: string[],
  activeWorldBookIds: Set<string>,
  activeWorldBookEntryUids: Set<number>,
  activeCharacterNames: Set<string>,
): BeautifierRule[] {
  // Step 1: 解析 auto-enable
  const resolved = resolveAutoEnable(presetRules, activeWorldBookIds, activeWorldBookEntryUids, activeCharacterNames);

  // Step 2: 应用用户禁用列表（locked 的规则不受影响）
  const disabledSet = new Set(builtinDisabled);
  const merged = resolved.map(r => {
    if (r.locked) return r;
    if (disabledSet.has(r.id)) return { ...r, enabled: false };
    return r;
  });

  // Step 3: 追加用户规则（同名 ID 覆盖预设）
  const presetIds = new Set(merged.map(r => r.id));
  const uniqueUserRules = userRules.filter(r => !presetIds.has(r.id));

  return [...merged, ...uniqueUserRules];
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
 * 美化文本的便捷入口（兼容旧接口）。
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
