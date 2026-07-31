/**
 * 名字 hash 首字母头像配色工具。
 * 纯函数、无副作用、无外部依赖，供 AvatarPanel 等组件复用。
 * 颜色池与 src/ui/lib/quality-colors.ts 的 QUALITY_TO_VAR 保持同步。
 */

/**
 * 与 quality-colors.ts QUALITY_TO_VAR 保持同步的 7 个品质 CSS 变量名池。
 * 顺序固定: 普通→唯一，按 hash 结果取模 7 选用其中一个。
 */
const QUALITY_VAR_POOL: readonly string[] = [
  '--theme-quality-common',
  '--theme-quality-uncommon',
  '--theme-quality-rare',
  '--theme-quality-epic',
  '--theme-quality-legendary',
  '--theme-quality-mythic',
  '--theme-quality-unique',
] as const;

/**
 * DJB2-ish 哈希：循环左移 5 位 + charCodeAt 累加。
 * 空串返回 0；同名恒定，跨字符串稳定分布。
 */
export function hashName(name: string): number {
  if (!name) return 0;
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    // hash * 33 + charCode —— 等价于 (hash << 5) + hash + charCode
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * 按名字 hash 取模 7 选一个品质 CSS 变量，返回完整 var() 字符串。
 * 空 name 按 fallback 返回 `var(--theme-quality-common)`。
 */
export function nameColorVar(name: string): string {
  if (!name) return 'var(--theme-quality-common)';
  const varName = QUALITY_VAR_POOL[hashName(name) % QUALITY_VAR_POOL.length];
  return `var(${varName})`;
}

/**
 * 取名字前 2 个字符作为头像首字母。
 * 与 AvatarPanel.vue `initials(name)=name.slice(0,2)` 强一致。
 * 空串 / undefined 返回空串 ''；[0,2] 对中文 1-2 字、英文 1-2 字母都合适，无分支。
 */
export function initialsOf(name: string | undefined | null): string {
  if (!name) return '';
  return name.slice(0, 2);
}
