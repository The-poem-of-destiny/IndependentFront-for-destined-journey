/**
 * attribute-allocation.ts — 自由属性点分配（ADR-11 / ADR-21）
 *
 * 升级攒下来的 `freeAttrPoints` 由玩家在 UI 上点掉：一次一点，加到某一维五维属性上。
 * 这里是**引擎侧的唯一入口** —— 校验（有没有点 / 到没到层级上限）与落库都在这一层，
 * UI 只负责传「谁、加哪一维」。
 *
 * 三条约束：
 * 1. 数值规则归 Code（ADR-11）：上限查 `getTierConfig(tier).attributeCap`，不让 UI 自己算。
 * 2. 写入走 `commitChatState`（ADR-21）：不直接 `saveCharacter`。
 * 3. 补丁**只写 attributes + freeAttrPoints，绝不碰 level/tier** ——
 *    state-manager 的升级/升层自动加点钩子看的正是 level/tier 差值，
 *    这里一旦写进去就会顺带触发一次自动发放。
 */

import { getCharacters } from './database';
import { getTierConfig } from './tier-constants';
import { createStateManager } from './state-manager';
import type { CharacterState } from './types';

/** 可分配的五维属性键（英文，对齐 CharacterState.attributes） */
export type AllocatableAttr = 'str' | 'dex' | 'con' | 'int' | 'spi';

/** 分配结果 —— 失败时 error 是给玩家看的中文原因 */
export interface AllocateAttributeResult {
  ok: boolean;
  error?: string;
}

/**
 * 按名字找角色 —— 与 StateManager.resolveCharacter 同口径（铁律1：逻辑键=名字）：
 * 先精确匹配，再认「主角」/「玩家」别名。
 */
function resolveCharacterByName(chars: CharacterState[], name: string): CharacterState | undefined {
  const byName = chars.find((c) => c.name === name);
  if (byName) return byName;
  if (name === '主角' || name === '玩家') return chars.find((c) => c.type === 'player');
  return undefined;
}

/**
 * 花 1 点自由属性点，把某一维五维属性 +1
 *
 * @param saveId   存档 id
 * @param charName 角色名字（逻辑键；也接受「主角」/「玩家」别名）
 * @param attr     要加的属性维度
 */
export async function allocateAttributePoint(
  saveId: string,
  charName: string,
  attr: AllocatableAttr,
): Promise<AllocateAttributeResult> {
  const chars = await getCharacters(saveId);
  const char = resolveCharacterByName(chars, charName);
  if (!char) {
    return { ok: false, error: `角色不存在: ${charName}` };
  }

  const points = typeof char.freeAttrPoints === 'number' ? char.freeAttrPoints : 0;
  if (points <= 0) {
    return { ok: false, error: '没有可用的自由属性点' };
  }

  const cur = char.attributes?.[attr];
  const current = typeof cur === 'number' ? cur : 0;
  // 层级配置查不到（越界层级/脏数据）时不拦 —— 上限未知时拒绝分配，等于把玩家已到手的点数扣死
  const cap = getTierConfig(char.tier)?.attributeCap;
  if (typeof cap === 'number' && current >= cap) {
    return { ok: false, error: `属性已达当前层级上限（${cap}），无法继续分配` };
  }

  const sm = createStateManager(saveId);
  const result = await sm.commitChatState([
    {
      op: 'update_character',
      target: `characters.${char.name}`,
      value: { attributes: { [attr]: 1 }, freeAttrPoints: -1 },
      metadata: { delta: true },
    },
  ]);

  if (!result.success) {
    return { ok: false, error: result.errors[0] ?? '属性点分配失败' };
  }
  return { ok: true };
}
