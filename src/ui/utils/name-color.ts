/**
 * 名字 hash 首字母头像配色工具。纯函数、无副作用，供 AvatarPanel 等组件复用。
 *
 * Q-11：颜色池此前在这里手抄了一份，文件头写着「与 quality-colors.ts 的
 * QUALITY_TO_VAR 保持同步」—— 那句话就是它该 import 而不是抄的理由。现在直接用
 * `QUALITY_VAR_POOL`，调色板扩容时这里自动跟上（取模的基数也跟着变）。
 */
import { QUALITY_VAR_POOL } from '../lib/quality-colors';

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
