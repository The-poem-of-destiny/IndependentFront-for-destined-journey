import type { ApiEndpoint } from '../types';
import type { CombatClient } from '../combat-v2-types';
import type { CombatLogicalRole } from './agent-permissions';

export interface CombatAgentMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface CombatAgentSession {
  readonly logicalRole: CombatLogicalRole;
  readonly agentId: 'combat_v3' | 'combat_enemy';
  readonly sessionId: string;
  readonly endpoint: ApiEndpoint;
  readonly messages: CombatAgentMessage[];
  client: CombatClient | null;
  summary?: string;
}

export interface CombatRequestToken {
  readonly battleId: string;
  readonly sessionId: string;
  readonly generation: number;
}

export interface CombatAgentSessions {
  readonly battleId: string;
  readonly host: CombatAgentSession;
  readonly enemy: CombatAgentSession;
  readonly active: boolean;
  get(role: CombatLogicalRole): CombatAgentSession;
  beginRequest(role: CombatLogicalRole): CombatRequestToken;
  accepts(token: CombatRequestToken): boolean;
  dispose(): void;
}

export function createCombatAgentSessions(input: {
  battleId: string;
  hostEndpoint: ApiEndpoint;
  enemyEndpoint?: ApiEndpoint;
}): CombatAgentSessions {
  let generation = 1;
  let active = true;
  const create = (
    logicalRole: CombatLogicalRole,
    agentId: CombatAgentSession['agentId'],
    endpoint: ApiEndpoint,
  ): CombatAgentSession => ({
    logicalRole,
    agentId,
    sessionId: `${input.battleId}:${logicalRole}`,
    endpoint,
    messages: [],
    client: null,
    ...(logicalRole === 'combat_host' ? { summary: '' } : {}),
  });
  const host = create('combat_host', 'combat_v3', input.hostEndpoint);
  const enemy = create('combat_enemy', 'combat_enemy', input.enemyEndpoint ?? input.hostEndpoint);

  return {
    battleId: input.battleId,
    host,
    enemy,
    get active() {
      return active;
    },
    get(role) {
      return role === 'combat_host' ? host : enemy;
    },
    beginRequest(role) {
      const session = role === 'combat_host' ? host : enemy;
      return { battleId: input.battleId, sessionId: session.sessionId, generation };
    },
    accepts(token) {
      return (
        active &&
        token.battleId === input.battleId &&
        token.generation === generation &&
        (token.sessionId === host.sessionId || token.sessionId === enemy.sessionId)
      );
    },
    dispose() {
      if (!active) return;
      active = false;
      generation += 1;
      host.messages.length = 0;
      enemy.messages.length = 0;
      host.client = null;
      enemy.client = null;
      host.summary = '';
    },
  };
}

export function ensureCombatAgentClient(
  session: CombatAgentSession,
  saveId: string,
  clientFactory: (agentId: string, endpoint: ApiEndpoint, saveId: string) => CombatClient,
): CombatClient {
  if (!session.client) {
    session.client = clientFactory(session.agentId, session.endpoint, saveId);
  }
  return session.client;
}
