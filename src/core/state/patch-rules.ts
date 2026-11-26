/**
 * patch-rules.ts — StatePatch 的静态校验与按名寻址角色（纯函数，无 I/O）
 *
 * StateManager 提交时用这两条规则判补丁；建补丁预演（state/patch-rehearsal.ts，直出建补丁与
 * 状态树翻译层共用）在提交前用同一份规则预判，把注定在提交时抛错的补丁先丢掉，免得一条坏补丁连坐整楼。
 * 🔴 规则只此一份：改这里两边一起变，别在调用方再写一份。
 */
import type { CharacterState, StatePatch, StatePatchOp } from '../types/types';

/** amount 必填的 op */
const AMOUNT_REQUIRED_OPS: readonly StatePatchOp[] = [
  'delta_variable',
  'delta_hp',
  'delta_mp',
  'delta_sp',
  'delta_affection',
];

/** value 必填的 op */
const VALUE_REQUIRED_OPS: readonly StatePatchOp[] = [
  'set_variable',
  'insert_variable',
  'set_hp',
  'set_mp',
  'set_sp',
  'set_location',
  'update_quest',
  'remove_quest',
  'add_item',
  'remove_item',
  'update_item',
  'transfer_item',
  'equip_item',
  'unequip_item',
  'add_skill',
  'update_skill',
  'remove_skill',
  'add_status_effect',
  'remove_status_effect',
  'add_character',
  'rename_character',
  'add_memory',
  'update_plot_event',
  'set_affection',
  'add_news',
  // 地图 v1.2：六个地块事实 op 的整份载荷都在 value 里（含寻址用的 `value.tile`），
  // 缺 value 就连「改哪块地」都不知道 —— 这里拦下比在 handler 里各拦一次好
  'tile_status_add',
  'tile_status_remove',
  'tile_building_add',
  'tile_building_update',
  'tile_dev_progress_add',
  'tile_history_note',
];

/** 补丁的静态形状校验；不合格抛错（文案即提交时的报错） */
export function validateStatePatch(patch: StatePatch): void {
  if (!patch.op) throw new Error('缺少 op 字段');
  if (!patch.target) throw new Error('缺少 target 字段');
  if (AMOUNT_REQUIRED_OPS.includes(patch.op) && patch.amount === undefined)
    throw new Error(`${patch.op} 需要 amount 字段`);
  if (VALUE_REQUIRED_OPS.includes(patch.op) && patch.value === undefined)
    throw new Error(`${patch.op} 需要 value 字段`);
  // move_variable 需要目标路径
  if (patch.op === 'move_variable' && !patch.metadata?.toPath)
    throw new Error('move_variable 需要 metadata.toPath');
  // 状态时长：null=永久，数值须有限（A2：`"3小时"` 进 Math.max 得 NaN 落库）
  if (patch.op === 'add_status_effect' || patch.op === 'update_status_effect') {
    const value = patch.value as { remainingTime?: unknown } | undefined;
    const time = isRecord(value) ? value.remainingTime : undefined;
    if (time !== undefined && time !== null && !(typeof time === 'number' && Number.isFinite(time)))
      throw new Error(`${patch.op} 的 remainingTime 必须是有限数值或 null`);
  }
  if (patch.op === 'update_item') validateUpdateItemValue(patch.value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** update_item 的 changes 各字段期望的值类型（与 InventoryItem 对齐）；表外键不在此判 */
const UPDATE_ITEM_FIELD_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  description: (v) => typeof v === 'string',
  type: (v) => typeof v === 'string',
  rarity: (v) => typeof v === 'string',
  equippedSlot: (v) => v === null || typeof v === 'string',
  stats: (v) =>
    isRecord(v) && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n)),
  durability: (v) => typeof v === 'number' && Number.isFinite(v),
  maxDurability: (v) => typeof v === 'number' && Number.isFinite(v),
  data: isRecord,
  effects: (v) => isRecord(v) && Object.values(v).every((s) => typeof s === 'string'),
  protocolText: (v) => typeof v === 'string',
  tags: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
};

/** update_item 值类型校验（A2：`changes.stats:"abc"` 曾原样写进物品） */
function validateUpdateItemValue(value: unknown): void {
  if (!isRecord(value)) throw new Error('update_item 的 value 必须是对象');
  if (typeof value.name !== 'string' || !value.name) throw new Error('update_item 需要 value.name');
  if (value.changes === undefined) return;
  if (!isRecord(value.changes)) throw new Error('update_item 的 changes 必须是对象');
  for (const [key, v] of Object.entries(value.changes)) {
    // undefined 等于没写（Object.assign 照样会落 undefined，与既有行为一致，不在此拦）
    if (v === undefined) continue;
    const check = UPDATE_ITEM_FIELD_CHECKS[key];
    if (check && !check(v)) throw new Error(`update_item 的 changes.${key} 值类型不符`);
  }
}

/**
 * 按名字解析角色（M2 铁律2：名字解析唯一入口）。顺序：
 * ① 名字精确匹配 → ② 唯一别名匹配（别名不唯一抛错）→ ③ '主角'/'玩家' → type='player' 的角色 → ④ 找不到抛错
 */
export function resolveCharacterByName(
  chars: readonly CharacterState[],
  key: string,
): CharacterState {
  const byName = chars.find((c) => c.name === key);
  if (byName) return byName;
  const aliases = chars.filter((c) => c.aliases?.includes(key));
  if (aliases.length === 1) return aliases[0];
  if (aliases.length > 1) throw new Error(`角色别名不唯一: ${key}`);
  if (key === '主角' || key === '玩家') {
    const player = chars.find((c) => c.type === 'player');
    if (player) return player;
  }
  throw new Error(`角色不存在: ${key}`);
}

/** `characters.X`（或带子路径 `characters.X.skills`）里的角色键；非角色目标返回 undefined */
export function characterKeyOfTarget(target: string): string | undefined {
  if (!target.startsWith('characters.')) return undefined;
  return target.slice('characters.'.length).split('.')[0] || undefined;
}
