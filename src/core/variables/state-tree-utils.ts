/**
 * 状态树各模块共用的小工具（审查报告 R8：此前散在 variables 目录约 6 个文件里各写一份）。
 *
 * 🔴 variables 目录内这些函数只此一份；前端（`ui/components/game/state-editor-view.ts`）也从这里引用。
 * 纯函数，无 I/O、无依赖。
 */

/** 普通对象（非 null、非数组）。 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON 往返深拷贝（切断引用与 Proxy，丢掉 undefined 键）；`undefined` 原样返回。 */
export function jsonClone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** 键序无关的规范序列化（深比较用）：对象键排序、值为 undefined 的键视同缺席。 */
export function canonical(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** 路径段转义（JSON Pointer，RFC 6901：`~` → `~0`，`/` → `~1`）。名字里可能含 `/`。 */
export function escapeStateTreeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 路径段反转义。 */
export function unescapeStateTreeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
