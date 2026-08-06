/**
 * 血脉系统 — schema + 查询纯函数（Phase 5；内容-引擎分离 波 2 / D25②）
 *
 * 设计决策: 血脉主要是 AI 扮演层的内容（性格/行为/社会地位），
 * Code 层只存标识 + 基础属性修正。完整觉醒/继承/复合机制由 AI 叙事。
 *
 * 🔴 **本模块不再持有任何血脉数据**（D25②）。具体血脉集住在内容注册表的 `bloodlines`
 * 面（占位来源 `/data/content/bloodlines.json`，装包后由 pack 的 `bloodlines` 分节替换）。
 * 这里只留：形状（{@link BloodlineInfo} / {@link BloodlineSet}）、注册表读取缝、
 * 三个查询/累加纯函数。
 *
 * 🔴 **注册表未就绪时确定性兜底为空集**——`getBloodline` 返回 `undefined`、
 * `getBloodlineList` 返回 `[]`、`calcBloodlineModifiers` 返回 `{}`。不抛、不崩。
 * 灌注时序由 content-store 的 ready promise + `ensureContentRegistryLoaded()` 保证
 * （boot 链必经，见 `src/ui/stores/content-store.ts` 文件头 D16 时序契约）。
 *
 * 三个函数都收一个可选的 `set` 参数（默认 = 注册表当前值），与 `location-db.ts` 的
 * `(nodes, …)` 参数式同一口径：调用方不必知道注册表，测试可直接喂 fixture。
 */

import { getContentRegistry } from '../ui/stores/content-store';

// ========== 形状 ==========

/**
 * 一条血脉的内容形状（注册表 / pack `bloodlines` 分节的行）。
 *
 * 刻意**不 export**：对外的入口是 {@link BloodlineSet}，它已把这个形状带出去；
 * 单独导出一个没人 import 的名字会进 knip 死代码账。
 */
interface BloodlineInfo {
  name: string;
  description: string;
  statModifiers?: Partial<Record<string, number>>;
}

/** 血脉集：id → 血脉信息（注册表 `bloodlines` 面的整体形状） */
export type BloodlineSet = Record<string, BloodlineInfo>;

// ========== 注册表读取缝 ==========

/**
 * 取当前生效的血脉集（同步读注册表）。
 *
 * 注册表该面未就绪 / 形状不对 → 返回**空集**（确定性兜底，不抛）。
 * 逐行做最小形状校验：`name` 与 `description` 必须是字符串，否则丢弃该行——
 * 一行坏数据不该让整个血脉列表消失。
 */
export function getBloodlineSet(): BloodlineSet {
  const raw: unknown = getContentRegistry().bloodlines;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: BloodlineSet = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.description !== 'string') continue;
    const info: BloodlineInfo = { name: row.name, description: row.description };
    const mods = row.statModifiers;
    if (mods && typeof mods === 'object' && !Array.isArray(mods)) {
      const parsed: Record<string, number> = {};
      for (const [stat, val] of Object.entries(mods as Record<string, unknown>)) {
        if (typeof val === 'number' && Number.isFinite(val)) parsed[stat] = val;
      }
      info.statModifiers = parsed;
    }
    out[id] = info;
  }
  return out;
}

// ========== 辅助函数 ==========

/** 获取血脉信息（未知 id / 注册表未就绪 → undefined） */
export function getBloodline(id: string, set: BloodlineSet = getBloodlineSet()) {
  return set[id];
}

/** 获取血脉列表（用于 UI；注册表未就绪 → 空数组） */
export function getBloodlineList(set: BloodlineSet = getBloodlineSet()) {
  return Object.entries(set).map(([id, info]) => ({ id, ...info }));
}

/** 计算血脉属性修正总和（未知 id 静默忽略） */
export function calcBloodlineModifiers(
  bloodlineIds: string[],
  set: BloodlineSet = getBloodlineSet(),
): Partial<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const id of bloodlineIds) {
    const bl = set[id];
    if (bl?.statModifiers) {
      for (const [stat, val] of Object.entries(bl.statModifiers)) {
        totals[stat] = (totals[stat] ?? 0) + (val ?? 0);
      }
    }
  }
  return totals;
}
