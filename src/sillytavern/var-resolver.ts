/**
 * $var — 变量解析 & 命名空间隔离 (Layer 2, AI 可读写)
 *
 * Phase 5 模块。职责:
 * 1. 命名空间隔离: user.* / sys.* / char.* / world.*
 * 2. 嵌套路径解析: "sys.世界.地点.城市"
 * 3. 变量读写 (get/set/del)
 * 4. 变量 diff 追踪
 * 5. 变量导入/导出
 */

// ========== 命名空间 ==========

/** 变量命名空间 */
export const VAR_NAMESPACES = {
  /** 用户变量 — 玩家可控 */
  USER: 'user',
  /** 系统变量 — 引擎管理，AI 可读，需授权写入 */
  SYS: 'sys',
  /** 角色变量 — 按角色 ID 分组 */
  CHAR: 'char',
  /** 世界变量 — 世界观设定 */
  WORLD: 'world',
  /** 临时变量 — 本轮有效，不被持久化 */
  TEMP: 'temp',
} as const;

export type VarNamespace = typeof VAR_NAMESPACES[keyof typeof VAR_NAMESPACES];

// ========== 路径解析 ==========

/** 解析变量路径 "sys.世界.地点" → { namespace: 'sys', parts: ['世界', '地点'] } */
export function parseVarPath(path: string): { namespace: string; parts: string[] } | null {
  const trimmed = path.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('.');
  const firstPart = parts[0];

  // 检查是否为已知命名空间
  const knownNamespaces = Object.values(VAR_NAMESPACES);
  if (knownNamespaces.includes(firstPart as VarNamespace)) {
    return { namespace: firstPart, parts: parts.slice(1) };
  }

  // 默认为 sys 命名空间（兼容旧格式：直接写 "世界.地点"）
  return { namespace: VAR_NAMESPACES.SYS, parts };
}

// ========== 变量读写 ==========

/** 安全获取嵌套值 */
export function getVar(
  variables: Record<string, any>,
  path: string,
): any {
  const parsed = parseVarPath(path);
  if (!parsed) return undefined;

  const ns = variables[parsed.namespace];
  if (ns === undefined || ns === null) return undefined;

  let value: any = ns;
  for (const part of parsed.parts) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

/** 安全设置嵌套值（不可变 — 返回新对象） */
export function setVar(
  variables: Record<string, any>,
  path: string,
  value: any,
): Record<string, any> {
  const parsed = parseVarPath(path);
  if (!parsed) return variables;

  // 深拷贝
  const result = JSON.parse(JSON.stringify(variables));

  // 确保命名空间存在
  if (!result[parsed.namespace]) {
    result[parsed.namespace] = {};
  }

  if (parsed.parts.length === 0) {
    // 设置整个命名空间
    result[parsed.namespace] = value;
    return result;
  }

  let current = result[parsed.namespace];
  for (let i = 0; i < parsed.parts.length - 1; i++) {
    const part = parsed.parts[i];
    if (typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parsed.parts[parsed.parts.length - 1]] = value;
  return result;
}

/** 删除变量路径 */
export function delVar(
  variables: Record<string, any>,
  path: string,
): Record<string, any> {
  const parsed = parseVarPath(path);
  if (!parsed) return variables;

  const result = JSON.parse(JSON.stringify(variables));

  if (!result[parsed.namespace]) return result;

  if (parsed.parts.length === 0) {
    delete result[parsed.namespace];
    return result;
  }

  let current = result[parsed.namespace];
  for (let i = 0; i < parsed.parts.length - 1; i++) {
    if (typeof current[parsed.parts[i]] !== 'object' || current[parsed.parts[i]] === null) {
      return result;
    }
    current = current[parsed.parts[i]];
  }

  delete current[parsed.parts[parsed.parts.length - 1]];
  return result;
}

/** 数值增量 */
export function deltaVar(
  variables: Record<string, any>,
  path: string,
  amount: number,
): Record<string, any> {
  const current = getVar(variables, path);
  const newValue = (typeof current === 'number' ? current : 0) + amount;
  return setVar(variables, path, newValue);
}

/** 移动变量 (rename/move path) */
export function moveVar(
  variables: Record<string, any>,
  fromPath: string,
  toPath: string,
): Record<string, any> {
  const value = getVar(variables, fromPath);
  let result = delVar(variables, fromPath);
  result = setVar(result, toPath, value);
  return result;
}

/** 数组插入 */
export function insertVar(
  variables: Record<string, any>,
  path: string,
  value: any,
  index?: number,
): Record<string, any> {
  const arr = getVar(variables, path);
  const currentArr = Array.isArray(arr) ? [...arr] : [];
  if (index !== undefined) {
    currentArr.splice(index, 0, value);
  } else {
    currentArr.push(value);
  }
  return setVar(variables, path, currentArr);
}

// ========== 批量操作 ==========

/** 应用 VarsPatch（合并 replace/delta/insert/remove/move） */
export function applyVarsPatch(
  variables: Record<string, any>,
  patch: {
    replace?: Array<{ path: string; value: any }>;
    delta?: Array<{ path: string; amount: number }>;
    insert?: Array<{ path: string; value: any; index?: number }>;
    remove?: Array<{ path: string }>;
    move?: Array<{ from: string; to: string }>;
  },
): Record<string, any> {
  let result = variables;

  if (patch.replace) {
    for (const r of patch.replace) {
      result = setVar(result, r.path, r.value);
    }
  }

  if (patch.delta) {
    for (const d of patch.delta) {
      result = deltaVar(result, d.path, d.amount);
    }
  }

  if (patch.insert) {
    for (const ins of patch.insert) {
      result = insertVar(result, ins.path, ins.value, ins.index);
    }
  }

  if (patch.remove) {
    for (const r of patch.remove) {
      result = delVar(result, r.path);
    }
  }

  if (patch.move) {
    for (const m of patch.move) {
      result = moveVar(result, m.from, m.to);
    }
  }

  return result;
}

// ========== 命名空间隔离 ==========

/** 获取用户变量（玩家可控） */
export function getUserVars(variables: Record<string, any>): Record<string, any> {
  return variables[VAR_NAMESPACES.USER] ?? {};
}

/** 获取系统变量（只读） */
export function getSysVars(variables: Record<string, any>): Record<string, any> {
  return variables[VAR_NAMESPACES.SYS] ?? {};
}

/** 获取世界变量 */
export function getWorldVars(variables: Record<string, any>): Record<string, any> {
  return variables[VAR_NAMESPACES.WORLD] ?? {};
}

/** 获取角色变量 */
export function getCharVars(variables: Record<string, any>): Record<string, any> {
  return variables[VAR_NAMESPACES.CHAR] ?? {};
}

/** 获取临时变量 */
export function getTempVars(variables: Record<string, any>): Record<string, any> {
  return variables[VAR_NAMESPACES.TEMP] ?? {};
}

/** 检查路径是否在用户命名空间下 */
export function isUserPath(path: string): boolean {
  const parsed = parseVarPath(path);
  return parsed?.namespace === VAR_NAMESPACES.USER;
}

/** 检查路径是否在系统命名空间下 */
export function isSysPath(path: string): boolean {
  const parsed = parseVarPath(path);
  return parsed?.namespace === VAR_NAMESPACES.SYS;
}

// ========== Diff 追踪 ==========

export interface VarChange {
  path: string;
  oldValue: any;
  newValue: any;
  op: 'replace' | 'delta' | 'insert' | 'delete';
}

/** 计算两个变量快照之间的差异 */
export function diffVariables(
  before: Record<string, any>,
  after: Record<string, any>,
): VarChange[] {
  const changes: VarChange[] = [];
  const allPaths = new Set([
    ...collectPaths(before),
    ...collectPaths(after),
  ]);

  for (const path of allPaths) {
    const oldVal = getVar(before, path);
    const newVal = getVar(after, path);

    if (oldVal === undefined && newVal !== undefined) {
      changes.push({ path, oldValue: undefined, newValue: newVal, op: 'replace' });
    } else if (oldVal !== undefined && newVal === undefined) {
      changes.push({ path, oldValue: oldVal, newValue: undefined, op: 'delete' });
    } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      const op = typeof oldVal === 'number' && typeof newVal === 'number' ? 'delta' : 'replace';
      changes.push({ path, oldValue: oldVal, newValue: newVal, op });
    }
  }

  return changes;
}

/** 收集所有变量的路径 */
function collectPaths(
  obj: Record<string, any>,
  prefix: string = '',
): string[] {
  const paths: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    paths.push(fullPath);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectPaths(value, fullPath));
    }
  }

  return paths;
}

// ========== $var Namespace ==========

/** AI 可读写的 $var API */
export const $var = {
  get: getVar,
  set: setVar,
  del: delVar,
  delta: deltaVar,
  insert: insertVar,
  move: moveVar,
  applyVarsPatch,
  parseVarPath,
  getUserVars,
  getSysVars,
  getWorldVars,
  getCharVars,
  getTempVars,
  isUserPath,
  isSysPath,
  diffVariables,
  VAR_NAMESPACES,
} as const;
