import type { CombatCommandKind, CombatUnitView, CombatView } from './types';

export type CombatLogicalRole = 'combat_host' | 'combat_enemy';

export type CombatDecisionPhase =
  | 'opening'
  | 'player_decision'
  | 'enemy_decision'
  | 'settlement_narration'
  | 'end_summary'
  | 'bounded_adjudication';

export interface CombatDecisionContext {
  logicalRole: CombatLogicalRole;
  agentId: 'combat_v3' | 'combat_enemy';
  battleId: string;
  sessionId: string;
  decisionWindowId: string;
  phase: CombatDecisionPhase;
  sourceRevision: number;
  authorizedActorId?: string;
  allowedCommandKinds: readonly CombatCommandKind[];
}

export class CombatAuthorizationError extends Error {
  readonly code:
    | 'TOOL_NOT_ALLOWED'
    | 'ACTOR_NOT_ALLOWED'
    | 'ACTOR_UNKNOWN'
    | 'TARGET_UNKNOWN'
    | 'TARGET_NOT_ALLOWED'
    | 'STALE_DECISION_WINDOW';

  constructor(code: CombatAuthorizationError['code'], message: string) {
    super(message);
    this.name = 'CombatAuthorizationError';
    this.code = code;
  }
}

const QUERY_TOOLS = [
  'get_combat_state',
  'get_character',
  'get_inventory',
  'get_unit_detail',
] as const;

const PLAYER_ACTION_TOOLS = [
  'declare_attack',
  'declare_action',
  'pass_slot',
  'flee',
  'end_turn',
] as const;

const TOOL_TO_COMMAND: Readonly<Record<string, CombatCommandKind | undefined>> = {
  declare_attack: 'DeclareAttack',
  declare_action: 'DeclareAction',
  pass_slot: 'PassAttack',
  flee: 'Flee',
  end_turn: 'EndTurn',
  submit_adjudication: 'Adjudicate',
};

export function toolsForCombatDecision(ctx: CombatDecisionContext): readonly string[] {
  switch (ctx.phase) {
    case 'opening':
      return QUERY_TOOLS;
    case 'player_decision':
    case 'enemy_decision':
      return [...QUERY_TOOLS, ...PLAYER_ACTION_TOOLS];
    case 'bounded_adjudication':
      return [...QUERY_TOOLS, 'submit_adjudication'];
    case 'settlement_narration':
    case 'end_summary':
      return [];
  }
}

export function commandKindForTool(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): CombatCommandKind | undefined {
  if (toolName !== 'pass_slot') return TOOL_TO_COMMAND[toolName];
  return args.slot === 'action' ? 'PassAction' : 'PassAttack';
}

function exactUnitByName(view: Readonly<CombatView>, name: unknown): CombatUnitView | undefined {
  if (typeof name !== 'string' || name.trim() === '') return undefined;
  return Object.values(view.units).find((unit) => unit.name === name.trim());
}

export function resolveAuthorizedActorName(
  ctx: CombatDecisionContext,
  view: Readonly<CombatView>,
  suppliedName: unknown,
): string {
  const authorizedId = ctx.authorizedActorId;
  if (!authorizedId) {
    throw new CombatAuthorizationError('ACTOR_NOT_ALLOWED', '当前阶段没有获准行动的单位');
  }
  const authorized = view.units[authorizedId];
  if (!authorized) {
    throw new CombatAuthorizationError('ACTOR_UNKNOWN', '当前获准单位已不在战场');
  }
  if (suppliedName === undefined || suppliedName === null || suppliedName === '')
    return authorized.id;
  const resolved = exactUnitByName(view, suppliedName);
  if (!resolved) {
    throw new CombatAuthorizationError('ACTOR_UNKNOWN', '未找到该行动单位');
  }
  if (resolved.id !== authorized.id) {
    throw new CombatAuthorizationError('ACTOR_NOT_ALLOWED', '只能为当前获准单位提交行动');
  }
  return authorized.id;
}

export function resolveAuthorizedTargetName(
  ctx: CombatDecisionContext,
  view: Readonly<CombatView>,
  suppliedName: unknown,
): string {
  const actorId = ctx.authorizedActorId;
  const actor = actorId ? view.units[actorId] : undefined;
  const target = exactUnitByName(view, suppliedName);
  if (!target) {
    throw new CombatAuthorizationError('TARGET_UNKNOWN', '未找到可寻址的战斗目标');
  }
  // `canAct` 只表示目标当前是否还能消费行动槽，不影响其作为存活敌方单位被攻击。
  if (!actor || target.side === actor.side || target.hp <= 0) {
    throw new CombatAuthorizationError('TARGET_NOT_ALLOWED', '该单位不是当前行动可选的敌对目标');
  }
  return target.id;
}

export function authorizeCombatToolCall(
  ctx: CombatDecisionContext,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  view: Readonly<CombatView>,
): void {
  if (!toolsForCombatDecision(ctx).includes(toolName)) {
    throw new CombatAuthorizationError('TOOL_NOT_ALLOWED', `当前角色与阶段无权调用「${toolName}」`);
  }
  const commandKind = commandKindForTool(toolName, args);
  if (!commandKind) return;
  if (!ctx.allowedCommandKinds.includes(commandKind)) {
    throw new CombatAuthorizationError('TOOL_NOT_ALLOWED', `当前决策窗口不允许提交 ${commandKind}`);
  }
  resolveAuthorizedActorName(ctx, view, args.actorName);
  if (toolName === 'declare_attack') resolveAuthorizedTargetName(ctx, view, args.targetName);
}

export function assertDecisionWindowCurrent(
  ctx: CombatDecisionContext,
  view: Readonly<CombatView>,
  currentActorId: string | undefined,
): void {
  if (
    ctx.battleId !== view.combatId ||
    !ctx.authorizedActorId ||
    ctx.authorizedActorId !== currentActorId
  ) {
    throw new CombatAuthorizationError(
      'STALE_DECISION_WINDOW',
      '该行动来自已经结束或控制权已变化的决策窗口',
    );
  }
}
