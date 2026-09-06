import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeautifierRule } from '@engine/types';
import { useBeautify } from './useBeautify';

const stores = vi.hoisted(() => ({
  settings: { settings: { beautifierEnabled: true } },
  game: { activeSave: null as any },
  beautifier: { presetRules: [] as BeautifierRule[], userRules: [] as BeautifierRule[] },
  workshop: { projects: [] as any[] },
  worldbooks: { books: [] as any[] },
}));

vi.mock('../stores/settings-store', () => ({ useSettingsStore: () => stores.settings }));
vi.mock('../stores/game-store', () => ({ useGameStore: () => stores.game }));
vi.mock('../stores/beautifier-store', () => ({ useBeautifierStore: () => stores.beautifier }));
vi.mock('../stores/workshop-store', () => ({ useWorkshopStore: () => stores.workshop }));
vi.mock('../stores/worldbook-store', () => ({ useWorldBookStore: () => stores.worldbooks }));

function rule(over: Partial<BeautifierRule> = {}): BeautifierRule {
  return {
    id: 'rule',
    name: 'rule',
    scope: 'maintext',
    pattern: 'x',
    flags: 'g',
    replacement: '<script>legacy()</script><style>.x{color:red}</style>',
    enabled: true,
    order: 1,
    isBuiltin: false,
    ...over,
  };
}

describe('useBeautify rule resolution', () => {
  beforeEach(() => {
    stores.settings.settings.beautifierEnabled = true;
    stores.game.activeSave = null;
    stores.beautifier.presetRules = [];
    stores.beautifier.userRules = [];
    stores.workshop.projects = [];
    stores.worldbooks.books = [];
  });

  it('returns legacy replacement markup unchanged for the isolated renderer', () => {
    stores.beautifier.userRules = [rule()];
    const { getBeautifierRules } = useBeautify();

    expect(getBeautifierRules()[0].replacement).toBe(
      '<script>legacy()</script><style>.x{color:red}</style>',
    );
  });

  it('auto-enables a preset bound to the active save entry', () => {
    stores.game.activeSave = {
      metadata: { enabledWorldBookEntries: ['system_core:413'] },
    };
    stores.beautifier.presetRules = [
      rule({
        id: 'preset',
        enabled: false,
        isBuiltin: true,
        autoEnable: { worldBookEntryUids: [413] },
      }),
    ];

    const [resolved] = useBeautify().getBeautifierRules();
    expect(resolved).toMatchObject({ id: 'preset', enabled: true, locked: true });
  });

  it('exposes the global switch without changing the rule catalog', () => {
    stores.settings.settings.beautifierEnabled = false;
    stores.beautifier.userRules = [rule()];
    const beautify = useBeautify();

    expect(beautify.isBeautifierEnabled()).toBe(false);
    expect(beautify.getBeautifierRules()).toHaveLength(1);
  });

  it('gates installed workshop regexes by the current save project selection', () => {
    stores.beautifier.userRules = [
      rule({
        id: 'workshop-rule:p1:r1',
        autoEnable: { worldBookIds: ['workshop:p1'] },
      }),
    ];
    stores.workshop.projects = [
      {
        id: 'p1',
        name: 'P1',
        description: '',
        authorName: '',
        version: '1',
        installedVersion: '1',
        tags: [],
      },
    ];
    stores.worldbooks.books = [
      {
        id: 'workshop:p1',
        partition: 'creative_workshop',
        entries: [{ uid: 900 }, { uid: 901 }],
      },
    ];
    stores.game.activeSave = {
      metadata: { enabledWorldBookEntries: ['creative_workshop:900'] },
    };

    expect(useBeautify().getBeautifierRules()[0].enabled).toBe(false);

    stores.game.activeSave.metadata.enabledWorldBookEntries.push('creative_workshop:901');
    expect(useBeautify().getBeautifierRules()[0].enabled).toBe(true);
  });

  it('同 ID 用户规则在渲染路径上替换预设（F15 用户优先契约）', () => {
    stores.beautifier.presetRules = [rule({ id: 'dup', pattern: 'preset', isBuiltin: true })];
    stores.beautifier.userRules = [rule({ id: 'dup', pattern: 'user', isBuiltin: false })];

    const rules = useBeautify().getBeautifierRules();

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'dup', pattern: 'user', isBuiltin: false });
  });

  it('locked 预设不可被同 ID 用户规则替换（F15 受保护）', () => {
    stores.beautifier.presetRules = [
      rule({ id: 'sys', pattern: 'preset', isBuiltin: true, locked: true }),
    ];
    stores.beautifier.userRules = [rule({ id: 'sys', pattern: 'user', isBuiltin: false })];

    const rules = useBeautify().getBeautifierRules();

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'sys', pattern: 'preset', locked: true });
  });
});
