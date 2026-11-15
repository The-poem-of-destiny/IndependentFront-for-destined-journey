/**
 * 输出美化「导入规则」文件的解析与校验（S-33，纯函数，不碰 store）。
 *
 * 两种格式：
 * - 导出格式 `{ version, builtinDisabled?, rules: [...] }` → 追加（同 id 覆盖）；
 * - 裸数组 `[...]` → 历史语义是「整体替换」，是否真的替换由调用方先问用户。
 *
 * 返回字符串 = 失败原因（直接拼进错误提示）。
 */
import type { BeautifierRule } from '@engine/types/types';

export interface ParsedRuleImport {
  rules: BeautifierRule[];
  /** true = 裸数组格式（历史语义为整体替换） */
  replace: boolean;
  /** 文件里带的内置规则翻转列表（仅导出格式可能有） */
  builtinDisabled?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRuleImport(data: unknown): ParsedRuleImport | string {
  let list: unknown;
  let replace = false;
  let builtinDisabled: string[] | undefined;
  if (Array.isArray(data)) {
    list = data;
    replace = true;
  } else if (isRecord(data) && Array.isArray(data.rules)) {
    list = data.rules;
    if (Array.isArray(data.builtinDisabled)) {
      builtinDisabled = data.builtinDisabled.filter((id): id is string => typeof id === 'string');
    }
  } else {
    return '文件里没有规则列表（需要 rules 数组或规则数组）';
  }

  const items = list as unknown[];
  if (items.length === 0) return '文件里的规则列表是空的';
  const rules: BeautifierRule[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = `第 ${i + 1} 条规则`;
    if (!isRecord(item)) return `${label}不是对象`;
    if (typeof item.id !== 'string' || !item.id) return `${label}缺少 id`;
    if (typeof item.pattern !== 'string') return `${label}缺少正则（pattern）`;
    if (typeof item.replacement !== 'string') return `${label}缺少替换内容（replacement）`;
    rules.push({
      ...(item as unknown as BeautifierRule),
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      flags: typeof item.flags === 'string' ? item.flags : 'g',
      enabled: item.enabled !== false,
      order: typeof item.order === 'number' ? item.order : i,
      scope: (typeof item.scope === 'string' ? item.scope : 'maintext') as BeautifierRule['scope'],
      isBuiltin: false,
    });
  }
  return { rules, replace, builtinDisabled };
}
