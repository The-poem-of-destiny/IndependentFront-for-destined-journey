import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getToolDefinition, getToolsForAgent } from '../src/core/agents/agent-tools';
import { getAgentTemplate } from '../src/core/prompts/agent-templates';
import { getDefaultTemplate } from '../src/core/prompts/placeholder-registry';

const root = resolve(import.meta.dirname, '..');

describe('unified combat module and agent routing', () => {
  it('keeps the runtime and test fixtures in the same combat module', () => {
    expect(existsSync(resolve(root, 'src/core/combat-v3'))).toBe(false);
    expect(existsSync(resolve(root, 'tests/core/combat-v3'))).toBe(false);
    for (const file of ['kernel.ts', 'coordinator.ts', 'participant.ts', 'ui-events.ts']) {
      expect(existsSync(resolve(root, 'src/core/combat', file))).toBe(true);
    }
    expect(existsSync(resolve(root, 'tests/core/combat/fixtures'))).toBe(true);
  });

  it('routes host commands through combat without keeping a retired agent alias', () => {
    const defaults = JSON.parse(
      readFileSync(resolve(root, 'public/data/defaults/agent-config.json'), 'utf8'),
    );
    expect(defaults.agents.combat).toBeDefined();
    expect(defaults.agents.combat_enemy).toBeDefined();
    expect(defaults.agents.combat_v3).toBeUndefined();
    expect(getToolsForAgent('combat').map((tool) => tool.function.name)).toContain(
      'declare_attack',
    );
    expect(getToolsForAgent('combat_enemy').map((tool) => tool.function.name)).toContain(
      'declare_attack',
    );
    expect(getToolsForAgent('combat_v3')).toEqual([]);
    expect(getToolDefinition('get_hp_percent')).toBeUndefined();
    // The renamed host must not inherit the old generic combat prompt or private input template.
    expect(getAgentTemplate('combat')).toBeUndefined();
    expect(getDefaultTemplate('combat')).toBe('');
  });

  it('does not restore retired imports, runtime contracts, or version switches', () => {
    const sourceRoot = resolve(root, 'src');
    const files = readdirSync(sourceRoot, { recursive: true }) as string[];
    const violations = files.filter((file) => {
      if (!/\.(ts|vue)$/.test(file)) return false;
      const source = readFileSync(resolve(sourceRoot, file), 'utf8');
      return /combat-v3(?:\/|['"])|combat_v3|combat-v2-types|combatEngineVersion|modifier-collector/.test(
        source,
      );
    });
    expect(violations).toEqual([]);
  });
});
