import type { CharacterState, SaveProfile, StatePatch, StatusEffect } from '../types/types';
import type { CombatantInput, CombatMeta, CombatState, CombatStatusEffect } from './sandbox/types';
import { collectInvariantViolations, createCombatState, toSaveStatus } from './sandbox/state';
import { buildCombatSettlementPatches, isCombatOutcome } from './sandbox/settlement';

export interface DirectCombatOutput {
  meta: Pick<CombatMeta, 'round' | 'combatType' | 'environment' | 'phase'> &
    Partial<Pick<CombatMeta, 'outcome' | 'notes' | 'actionOrder' | 'summary'>>;
  units: Array<
    Omit<CombatantInput, 'character'> & {
      name: string;
      origin: 'save' | 'temp';
      hp: number;
      mp: number;
      sp: number;
    }
  >;
}

export interface DirectCombatRecord {
  sourceTurnKey: string;
  state: CombatState;
}

export function readDirectCombat(
  profile: Pick<SaveProfile, 'worldFlags'> | null | undefined,
): DirectCombatRecord | null {
  return profile?.worldFlags.directCombat ?? null;
}

function directStatusMetadata(effect: CombatStatusEffect | undefined): Partial<StatusEffect> {
  const data = effect as (CombatStatusEffect & Partial<StatusEffect>) | undefined;
  return {
    ...(typeof data?.protocolText === 'string' ? { protocolText: data.protocolText } : {}),
    ...(Array.isArray(data?.tags) && data.tags.every((tag) => typeof tag === 'string')
      ? { tags: data.tags }
      : {}),
  };
}

export function projectDirectCombatCharacters(
  characters: readonly CharacterState[],
  record: DirectCombatRecord | null,
): CharacterState[] {
  if (!record || record.state.meta.phase === 'ended') return [...characters];
  return characters.map((character) => {
    const unit = record.state.units[character.name];
    if (!unit || unit.origin !== 'save' || unit.cluster) return character;
    return {
      ...character,
      hp: unit.hp,
      mp: unit.mp,
      sp: unit.sp,
      statusEffects: unit.statusEffects.map((effect) => ({
        ...character.statusEffects.find((saved) => saved.name === effect.name),
        ...toSaveStatus(effect),
        ...directStatusMetadata(effect),
      })),
    };
  });
}

export function buildDirectCombat(
  output: DirectCombatOutput | null,
  previous: DirectCombatRecord | null,
  characters: CharacterState[],
  patches: readonly StatePatch[],
  sourceTurnKey: string,
): { record: DirectCombatRecord | null; patches: StatePatch[] } {
  if (!output) {
    if (previous && previous.state.meta.phase !== 'ended')
      throw new Error('进行中的战斗必须在同次回复中声明当前状态');
    return { record: null, patches: [] };
  }
  if (!output.meta || !Array.isArray(output.units) || output.units.length === 0)
    throw new Error('战斗状态缺少 meta 或 units');
  const meta = output.meta;
  if (!Number.isInteger(meta.round) || meta.round < 1 || !['active', 'ended'].includes(meta.phase))
    throw new Error('战斗回合或阶段无效');
  if (meta.phase === 'ended' && !isCombatOutcome(meta.outcome))
    throw new Error('战斗终局缺少有效结果');
  const names = new Set<string>();
  const combatants: CombatantInput[] = output.units.map((row) => {
    if (!row.name || names.has(row.name) || !['ally', 'enemy'].includes(row.side))
      throw new Error('战斗单位名字／阵营无效');
    names.add(row.name);
    if (!['save', 'temp'].includes(row.origin)) throw new Error('战斗单位来源无效');
    const character = characters.find((c) => c.name === row.name);
    if ((row.origin === 'save') !== Boolean(character))
      throw new Error(`战斗单位 ${row.name} 与存档实体不匹配`);
    const old =
      previous?.state.meta.phase === 'active' ? previous.state.units[row.name] : undefined;
    if (character && row.cluster) throw new Error('存档角色不能声明为临时集群');
    for (const field of ['maxHp', 'maxMp', 'maxSp'] as const) {
      if (character && row[field] !== undefined && row[field] !== character[field])
        throw new Error('战斗不能重写角色资源上限');
    }
    for (const field of ['hp', 'mp', 'sp'] as const)
      if (!Number.isFinite(row[field]) || row[field] < 0)
        throw new Error(`${row.name} 的 ${field} 无效`);
    if (!Array.isArray(row.statusEffects)) throw new Error(`${row.name} 缺少当前状态效果列表`);
    for (const fx of row.statusEffects) if (!fx.name) throw new Error('战斗状态效果缺名字');
    if (row.origin === 'temp')
      for (const field of ['maxHp', 'maxMp', 'maxSp'] as const)
        if (!Number.isFinite(row[field] ?? old?.[field])) throw new Error(`临时单位缺少 ${field}`);
    return {
      ...old,
      ...row,
      ...(character
        ? {
            maxHp: character.maxHp,
            maxMp: character.maxMp,
            maxSp: character.maxSp,
            attributes: character.attributes,
            tier: character.tier,
            level: character.level,
          }
        : {}),
      character,
      alive: row.hp > 0,
    };
  });
  if (previous && previous.state.meta.phase !== 'ended') {
    for (const name of Object.keys(previous.state.units))
      if (!names.has(name)) throw new Error(`跨楼战斗不能遗漏单位 ${name}`);
  }
  const state = createCombatState({ combatants, meta, fillResources: false });
  for (const unit of Object.values(state.units)) {
    const errors = collectInvariantViolations(unit);
    if (errors.length) throw new Error(`${unit.name}: ${errors.join('；')}`);
  }
  const controlled = new Set(
    Object.values(state.units)
      .filter((u) => u.origin === 'save')
      .map((u) => `characters.${u.name}`),
  );
  for (const patch of patches) {
    if (
      controlled.has(patch.target) &&
      [
        'set_hp',
        'set_mp',
        'set_sp',
        'delta_hp',
        'delta_mp',
        'delta_sp',
        'add_status_effect',
        'update_status_effect',
        'remove_status_effect',
      ].includes(patch.op)
    )
      throw new Error('战斗参与者的资源／状态只能由 combat 声明');
  }
  const settlementState = {
    ...state,
    units: Object.fromEntries(
      Object.entries(state.units).map(([name, unit]) => [
        name,
        { ...unit, statusEffects: unit.statusEffects.filter((fx) => !fx.tempSource) },
      ]),
    ),
  };
  // Settlement is a final snapshot, not another application of stackable buffs.
  const settlement = buildCombatSettlementPatches(settlementState, characters).flatMap((patch) => {
    if (patch.op !== 'add_status_effect') return [patch];
    const name = (patch.value as { name: string }).name;
    const saved = characters
      .find((c) => `characters.${c.name}` === patch.target)
      ?.statusEffects.find((fx) => fx.name === name);
    return [
      { op: 'remove_status_effect' as const, target: patch.target, value: { name } },
      {
        ...patch,
        value: {
          ...saved,
          ...(patch.value as object),
          ...directStatusMetadata(
            state.units[patch.target.slice('characters.'.length)]?.statusEffects.find(
              (effect) => effect.name === name,
            ),
          ),
        },
      },
    ];
  });
  return {
    record: { sourceTurnKey, state },
    // No automatic EXP/FP extras: the main response owns those rewards.
    patches: meta.phase === 'ended' ? settlement : [],
  };
}
