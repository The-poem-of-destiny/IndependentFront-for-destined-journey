/**
 * patch-rules.ts — StatePatch 的静态校验与按名寻址角色（纯函数，无 I/O）
 *
 * StateManager 提交时用这两条规则判补丁；直出建补丁（agents/direct-output.ts）在提交前
 * 用同一份规则预判，把注定在提交时抛错的补丁先丢掉，免得一条坏补丁连坐整楼。
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
