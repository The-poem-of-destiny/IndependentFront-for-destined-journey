/**
 * DebugPanel.vue — 随机事件区块
 * @vitest-environment jsdom
 *
 * ## 为什么这个区块值得测
 * 随机事件在真机上是**一块黑盒**：候选池住在 `worldFlags` 里、掷骰只发生在时间推进那一刻、
 * 权重链的乘积谁也看不见。这块表就是唯一的窗口，所以它自己必须诚实：
 *
 * - **数字来自生产函数**（`evaluateEventCondition` / `computeEventWeight` / 快照组装）。
 *   照抄一份判据的下场是面板在真机上说谎 —— 而说谎的正是用来查真相的那块面板。
 * - **「下回合触发」真的走引擎写入口**（`game.devArmRandomEvent` → StateManager）。
 *   按钮画出来了但没接线，症状是「按了没反应」，没有任何一处会报错。
 * - **取快照在挂载时**：事件包与引擎设置都是模块级非响应式状态，写成 computed 会把
 *   「当时装的是空包」永久缓存住（先例：内容注册表那次）。
 *
 * 纯判定（谁进表 / 各列的数）在 `random-event-debug.test.ts`，这里只钉**接线**。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import DebugPanel from './DebugPanel.vue';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';
import { installRandomEventPack, resetRandomEventRuntime } from '@engine/random-event-runtime';
import { setEngineSettingsProvider } from '@engine/engine-settings';
import { createDefaultTime } from '@engine/time-system';
import { createDefaultCharacterState, type SaveProfile } from '@engine/types';
import {
  DEFAULT_RANDOM_EVENT_CONFIG,
  type RandomEventDef,
  type RandomEventSaveFlags,
} from '@engine/types-random-events';

function buildProfile(flags?: RandomEventSaveFlags): SaveProfile {
  return {
    saveId: 'save-debug',
    experienceMode: 'normal',
    fp: 0,
    fpHistory: [],
    contracts: [],
    achievements: [],
    news: [],
    quests: {},
    focusQuest: '',
    affections: {},
    gameTime: createDefaultTime(),
    variables: {},
    worldFlags: flags === undefined ? {} : { randomEvents: flags },
    updatedAt: 0,
  };
}

function installPack(defs: RandomEventDef[]): void {
  installRandomEventPack({ config: { ...DEFAULT_RANDOM_EVENT_CONFIG }, defs });
}

/** 面板整块由 AppModal 的 `v-if` 托管 —— 每次打开都是一次新挂载，这里照做 */
function mountPanel() {
  return mount(DebugPanel);
}

function seedSave(game: ReturnType<typeof useGameStore>, flags?: RandomEventSaveFlags): void {
  game.saveProfile = buildProfile(flags);
  game.characters = [
    createDefaultCharacterState({
      id: 'hero-1',
      saveId: 'save-debug',
      name: 'Hero',
      type: 'player',
      location: 'Harbor',
      level: 5,
    }),
  ];
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetRandomEventRuntime();
  setEngineSettingsProvider(undefined);
});

afterEach(() => {
  resetRandomEventRuntime();
  setEngineSettingsProvider(undefined);
  vi.restoreAllMocks();
});

describe('DebugPanel · 随机事件区块', () => {
  it('没装事件包时明说 no-op，不摆一张空表', () => {
    const text = mountPanel().text();
    expect(text).toContain('随机事件');
    expect(text).toContain('未装载事件包');
  });

  it('列出通过 available 的事件：触发列 / 权重 / 日概率四样都在', () => {
    installPack([
      { name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } },
      {
        name: 'Gated',
        brief: 'g',
        trigger: { type: 'mtth', mtthDays: 4 },
        available: { playerLevel: { gte: 99 } },
      },
    ]);
    const game = useGameStore();
    seedSave(game);

    const text = mountPanel().text();
    expect(text).toContain('Rumor');
    // available 不满足的那条根本不进表（调度器也不会考虑它）
    expect(text).not.toContain('Gated');
    expect(text).toContain('4 天');
    expect(text).toContain('25.0%'); // min(1, 1/4)
  });

  it('首访事件也列出来，并报出作者点名的地点', () => {
    installPack([
      {
        name: 'Arrival',
        brief: 'a',
        trigger: { type: 'first_visit', scope: { anyOf: ['Harbor', 'Keep'] } },
      },
    ]);
    const game = useGameStore();
    seedSave(game);

    const text = mountPanel().text();
    expect(text).toContain('Arrival');
    expect(text).toContain('首访');
    expect(text).toContain('Harbor / Keep');
  });

  it('已在池中的条目带「在池」标（否则按完按钮看不出发生了什么）', () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    const game = useGameStore();
    seedSave(game, {
      pending: [{ name: 'Rumor', armedDay: 0, expiresDay: 5, priority: 0, brief: 'r' }],
    });

    expect(mountPanel().text()).toContain('在池');
  });

  it('频率系数真的乘进日概率（设置读了没往下传是看不出来的）', () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    setEngineSettingsProvider(() => ({ randomEventsFrequency: 2 }));
    const game = useGameStore();
    seedSave(game);

    const text = mountPanel().text();
    expect(text).toContain('×2');
    expect(text).toContain('50.0%'); // min(1, 2/4)
  });

  it('🔴 系统关掉时区块照常显示、明说已关闭，且按钮禁用（入池了也不会注入）', () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    setEngineSettingsProvider(() => ({ randomEventsEnabled: false }));
    const game = useGameStore();
    seedSave(game);

    const wrapper = mountPanel();
    expect(wrapper.text()).toContain('Rumor');
    expect(wrapper.text()).toContain('系统已关闭');
    const button = wrapper.find('.debug-re-table button');
    expect(button.attributes('disabled')).toBeDefined();
  });

  it('入池失败按错误播报，绝不报成功（「按了说好了、其实没写」最难查）', async () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    const game = useGameStore();
    const ui = useUIStore();
    seedSave(game);
    vi.spyOn(game, 'devArmRandomEvent').mockResolvedValue({ ok: false, error: '系统已关闭' });

    await mountPanel().find('.debug-re-table button').trigger('click');
    await Promise.resolve();

    expect(ui.toasts.map((t) => [t.type, t.message])).toEqual([['error', '系统已关闭']]);
  });

  it('🔴「下回合触发」按钮真的调到引擎写入口（按名字，逐字）', async () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    const game = useGameStore();
    seedSave(game);
    const spy = vi.spyOn(game, 'devArmRandomEvent').mockResolvedValue({ ok: true });

    const wrapper = mountPanel();
    const buttons = wrapper.findAll('.debug-re-table button');
    expect(buttons).toHaveLength(1);
    await buttons[0].trigger('click');

    expect(spy).toHaveBeenCalledWith('Rumor');
  });

  it('无活跃存档时不炸、也不摆一张假表', () => {
    installPack([{ name: 'Rumor', brief: 'r', trigger: { type: 'mtth', mtthDays: 4 } }]);
    expect(mountPanel().text()).toContain('无活跃存档');
  });
});
