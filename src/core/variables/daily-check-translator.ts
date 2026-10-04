/**
 * daily_check（Phase 3）AI 输出 → `StatePatch[]` 的**纯翻译层**。
 *
 * 形状逐字照 `vars-update-translator.ts`：无 I/O、import 只有类型，只做 JSON → 补丁的纯映射。
 * `commitChatState` 仍是唯一写入口（ADR-21）—— 本文件一个 Dexie 字都没有。
 *
 * ## 输入契约（daily_check 的 `<json>` 块）
 *
 * ```jsonc
 * {
 *   "characterUpdates": [
 *     { "name": "角色名", "fields": { "hp": 30, "maxHp": 50 } },   // 或 { name, path, value }
 *   ],
 *   "statusAdds": [
 *     { "owner": "角色名", "name": "狂暴", "category": "增益", "remainingTime": 3, "timeUnit": "回合" }
 *   ],
 *   "statusUpdates": [
 *     { "owner": "角色名", "name": "中毒", "remainingTime": 120, "stacks": 2 }
 *   ],
 *   "statusRemovals": [
 *     { "owner": "角色名", "name": "中毒" }
 *   ]
 * }
 * ```
 *
 * ## 容错口径（照本仓既有惯例）
 *
 * - 整组认不出（不是数组）→ 当没写；单条认不出 → **只丢那一条**，不连坐同组其余条。
 * - `characterUpdates` 走 `update_character`（白名单已含 hp/maxHp/mp/maxMp/sp/maxSp 且自带
 *   `[0, 上限]` 钳制）—— `path` 无法识别时整条丢。
 * - `statusAdds` 走 `add_status_effect`（**日常物品/技能使用**产生的新状态；同名会叠层/刷新，
 *   由 handler 的既有叠层规则处理）。`owner`/`name` 缺一即丢；只透传白名单字段。
 * - `statusUpdates` 走 `update_status_effect`：`owner`/`name` 缺一即丢；**两个可改字段
 *   （remainingTime/stacks）都缺省**也丢（空更新无意义）。`remainingTime` 允许 `null`=永久。
 * - `statusRemovals` 走 `remove_status_effect`：缺 owner/name 丢。
 * - 🔴 **物品消耗不在本契约**（Option A）：`remove_item` 归 `request_dispatcher → vars_update`，
 *   daily_check 只结算使用后产生的资源/状态效果，避免同一瓶药被扣两次。
 */
import type { StatePatch } from '../types/types';

/** 非空字符串判据 */
function isFilledString(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** 逐条翻译 characterUpdates（update_character） */
function buildCharacterUpdatePatches(raw: unknown): StatePatch[] {
  if (!Array.isArray(raw)) return [];
  const patches: StatePatch[] = [];

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const name = isFilledString(row.name) ? row.name.trim() : '';
    if (!name) {
      console.warn('[Orchestrator] daily_check characterUpdates 条目缺 name，跳过');
      continue;
    }

    let value: Record<string, unknown> | null = null;
    if (row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields)) {
      value = { ...(row.fields as Record<string, unknown>) };
    } else if (isFilledString(row.path) && row.value !== undefined) {
      value = { [row.path]: row.value };
    }
    if (!value || Object.keys(value).length === 0) {
      console.warn('[Orchestrator] daily_check characterUpdates 条目无可写字段，跳过:', name);
      continue;
    }

    patches.push({
      op: 'update_character',
      target: `characters.${name}`,
      value,
      metadata: { source: 'daily_check' },
    });
  }

  return patches;
}

/** `add_status_effect` 只透传这些字段（其余键忽略，防 AI 夹带假字段） */
function pickStatusFields(row: Record<string, unknown>): Record<string, unknown> {
  const KEYS = [
    'name',
    'description',
    'category',
    'stacks',
    'maxStacks',
    'stackable',
    'remainingTime',
    'timeUnit',
    'source',
    'effects',
    'effectDescriptions',
  ] as const;
  const out: Record<string, unknown> = {};
  for (const k of KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out;
}

/** 逐条翻译 statusAdds（add_status_effect）—— 日常物品/技能使用产生的新状态 */
function buildStatusAddPatches(raw: unknown): StatePatch[] {
  if (!Array.isArray(raw)) return [];
  const patches: StatePatch[] = [];

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const owner = isFilledString(row.owner) ? row.owner.trim() : '';
    const effect = isFilledString(row.name) ? row.name.trim() : '';
    if (!owner || !effect) {
      console.warn('[Orchestrator] daily_check statusAdds 条目缺 owner/name，跳过');
      continue;
    }
    patches.push({
      op: 'add_status_effect',
      target: `characters.${owner}`,
      value: pickStatusFields(row),
      metadata: { source: 'daily_check' },
    });
  }

  return patches;
}

/** 逐条翻译 statusUpdates（update_status_effect） */
function buildStatusUpdatePatches(raw: unknown): StatePatch[] {
  if (!Array.isArray(raw)) return [];
  const patches: StatePatch[] = [];

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const owner = isFilledString(row.owner) ? row.owner.trim() : '';
    const effect = isFilledString(row.name) ? row.name.trim() : '';
    if (!owner || !effect) {
      console.warn('[Orchestrator] daily_check statusUpdates 条目缺 owner/name，跳过');
      continue;
    }

    const value: { name: string; remainingTime?: number | null; stacks?: number } = {
      name: effect,
    };
    // remainingTime: 数值或 null（永久）；其余脏值丢弃
    if (row.remainingTime === null) {
      value.remainingTime = null;
    } else if (typeof row.remainingTime === 'number' && Number.isFinite(row.remainingTime)) {
      value.remainingTime = row.remainingTime;
    }
    if (typeof row.stacks === 'number' && Number.isFinite(row.stacks) && row.stacks > 0) {
      value.stacks = row.stacks;
    }
    if (value.remainingTime === undefined && value.stacks === undefined) {
      console.warn(
        `[Orchestrator] daily_check statusUpdates "${effect}"（${owner}）无可改字段，跳过`,
      );
      continue;
    }

    patches.push({
      op: 'update_status_effect',
      target: `characters.${owner}`,
      value,
      metadata: { source: 'daily_check' },
    });
  }

  return patches;
}

/** 逐条翻译 statusRemovals（remove_status_effect） */
function buildStatusRemovalPatches(raw: unknown): StatePatch[] {
  if (!Array.isArray(raw)) return [];
  const patches: StatePatch[] = [];

  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const owner = isFilledString(row.owner) ? row.owner.trim() : '';
    const effect = isFilledString(row.name) ? row.name.trim() : '';
    if (!owner || !effect) {
      console.warn('[Orchestrator] daily_check statusRemovals 条目缺 owner/name，跳过');
      continue;
    }
    patches.push({
      op: 'remove_status_effect',
      target: `characters.${owner}`,
      value: { name: effect },
      metadata: { source: 'daily_check' },
    });
  }

  return patches;
}

/**
 * daily_check 的 `<json>` → StatePatch[]。
 *
 * 顺序：先改角色资源（可能同时改 max），再加新状态，再改状态字段，最后移除状态 ——
 * 同角色上「先加、后改、末删」与 AI 分组声明顺序无关；移除放最后保证 update 不会被
 * remove 抢先（给同一条状态既 update 又 remove 时，以移除为准）。
 */
export function buildDailyCheckPatches(parsed: Record<string, any>): StatePatch[] {
  if (parsed === null || typeof parsed !== 'object') return [];
  return [
    ...buildCharacterUpdatePatches(parsed.characterUpdates),
    ...buildStatusAddPatches(parsed.statusAdds),
    ...buildStatusUpdatePatches(parsed.statusUpdates),
    ...buildStatusRemovalPatches(parsed.statusRemovals),
  ];
}
