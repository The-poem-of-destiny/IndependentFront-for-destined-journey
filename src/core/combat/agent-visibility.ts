import type { CombatLogicalRole } from './agent-permissions';
import type { CombatUnitView, CombatView, DomainEvent } from './types';

export interface CombatVisibilityState {
  revealedSkillsByUnit: Readonly<Record<string, readonly string[]>>;
}

export function createCombatVisibilityState(): CombatVisibilityState {
  return { revealedSkillsByUnit: {} };
}

export function accumulateVisibleCombatFacts(
  state: CombatVisibilityState,
  events: readonly DomainEvent[],
): CombatVisibilityState {
  const next: Record<string, string[]> = Object.fromEntries(
    Object.entries(state.revealedSkillsByUnit).map(([id, names]) => [id, [...names]]),
  );
  let changed = false;
  for (const event of events) {
    if (event.kind !== 'AttackDeclared' || !event.skill) continue;
    const skills = next[event.attackerId] ?? [];
    if (!skills.includes(event.skill)) {
      next[event.attackerId] = [...skills, event.skill].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      changed = true;
    }
  }
  return changed ? { revealedSkillsByUnit: next } : state;
}

function hpPercent(unit: CombatUnitView): number {
  return unit.maxHp > 0 ? Math.round((unit.hp / unit.maxHp) * 100) : 0;
}

function statusProjection(unit: CombatUnitView) {
  return unit.statusEffects.map((status) => ({
    name: status.name,
    category: status.category,
    stacks: status.stacks,
    remainingTime: status.remainingTime,
    timeUnit: status.timeUnit,
  }));
}

export function projectCombatUnitForRole(
  unit: CombatUnitView,
  role: CombatLogicalRole,
  visibility: CombatVisibilityState,
): Record<string, unknown> {
  if (role === 'combat_host' || unit.side === 'enemy') {
    return {
      name: unit.name,
      side: unit.side,
      tier: unit.tier,
      hp: unit.hp,
      maxHp: unit.maxHp,
      hpPercent: hpPercent(unit),
      mp: unit.mp,
      maxMp: unit.maxMp,
      sp: unit.sp,
      maxSp: unit.maxSp,
      attacksRemaining: unit.attacksRemaining,
      actionsRemaining: unit.actionsRemaining,
      canAct: unit.canAct,
      morale: unit.morale,
      statusEffects: statusProjection(unit),
    };
  }
  return {
    name: unit.name,
    side: unit.side,
    tier: unit.tier,
    hpPercent: hpPercent(unit),
    canAct: unit.canAct,
    morale: unit.morale,
    statusEffects: statusProjection(unit),
    revealedSkills: [...(visibility.revealedSkillsByUnit[unit.id] ?? [])],
  };
}

export function projectCombatStateForRole(
  view: Readonly<CombatView>,
  role: CombatLogicalRole,
  visibility: CombatVisibilityState,
): Record<string, unknown> {
  const order = view.initiativeOrder.length > 0 ? view.initiativeOrder : Object.keys(view.units);
  return {
    combatId: view.combatId,
    revision: view.revision,
    phase: view.phase,
    round: view.round,
    currentActor: view.units[view.initiativeOrder[view.currentTurnIndex] ?? '']?.name ?? undefined,
    initiativeOrder: order.map((id) => view.units[id]?.name).filter(Boolean),
    units: order
      .map((id) => view.units[id])
      .filter((unit): unit is CombatUnitView => unit !== undefined)
      .map((unit) => projectCombatUnitForRole(unit, role, visibility)),
    ...(role === 'combat_host' ? { resourceSnapshots: { ...view.resourceSnapshots } } : {}),
    terminal: view.terminal ? { ...view.terminal } : undefined,
  };
}

function exactUnitByName(
  view: Readonly<CombatView>,
  requested: unknown,
): CombatUnitView | undefined {
  if (typeof requested !== 'string' || requested.trim() === '') return undefined;
  return Object.values(view.units).find((unit) => unit.name === requested.trim());
}

function matchingCharacter(
  characters: readonly Record<string, unknown>[],
  unit: CombatUnitView,
): Record<string, unknown> | undefined {
  return characters.find((character) => character.id === unit.id || character.name === unit.name);
}

function ownFactionStaticProjection(character: Record<string, unknown> | undefined) {
  if (!character) return {};
  const skills = Array.isArray(character.skills)
    ? character.skills.map((skill) => {
        const value = skill as Record<string, unknown>;
        return {
          name: value.name,
          description: value.description,
          type: value.type,
          cost: value.cost,
          cooldown: value.cooldown,
          effects: value.effects,
          skillPower: value.skillPower,
          damageType: value.damageType,
        };
      })
    : [];
  const inventory = Array.isArray(character.inventory)
    ? character.inventory.map((item) => {
        const value = item as Record<string, unknown>;
        return {
          name: value.name,
          description: value.description,
          quantity: value.quantity,
          type: value.type,
          rarity: value.rarity,
          equippedSlot: value.equippedSlot,
          effects: value.effects,
        };
      })
    : [];
  return {
    race: character.race,
    identity: character.identity,
    occupation: character.occupation,
    attributes: character.attributes,
    skills,
    inventory,
  };
}

export type CombatQueryKind = 'get_character' | 'get_inventory' | 'get_unit_detail';

export function executeVisibleUnitQuery(input: {
  kind: CombatQueryKind;
  requestedName: unknown;
  role: CombatLogicalRole;
  view: Readonly<CombatView>;
  visibility: CombatVisibilityState;
  characters: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  const unit = exactUnitByName(input.view, input.requestedName);
  if (!unit) return { found: false, reason: '未找到可见的参战单位' };

  const dynamic = projectCombatUnitForRole(unit, input.role, input.visibility);
  if (input.role === 'combat_enemy' && unit.side === 'player') {
    return input.kind === 'get_inventory'
      ? { found: false, reason: '该单位的背包不属于当前角色可见信息' }
      : { found: true, character: dynamic };
  }

  const staticData = ownFactionStaticProjection(matchingCharacter(input.characters, unit));
  const character = { ...staticData, ...dynamic };
  if (input.kind === 'get_inventory') {
    return { found: true, characterName: unit.name, inventory: staticData.inventory ?? [] };
  }
  return { found: true, character };
}
