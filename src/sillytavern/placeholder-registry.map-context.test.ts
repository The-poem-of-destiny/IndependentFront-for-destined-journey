/**
 * `{{MAP_CONTEXT}}` 渲染器测试（地图 v1 §8.1 载荷契约 / 裁定 §12-9·§12-10）
 *
 * 夹具规矩（设计 §10 + D25①）：**零真实地名** —— 地块/国家/中层名全是合成中立英文串，
 * 地形词是本夹具自造的包词汇。中文只该出现在**渲染结果**里（那正是本文件测的东西：
 * 方位标签与四类行的措辞归渲染层，`map-*.ts` 被结构闸门禁了中文字面量）。
 *
 * 🔴 **坐标是屏幕坐标：y 向下增长**，正北 = 更小的 y（同 `map-index.compassOf` 那条警告）。
 *    写反了不报错，只会让每条邻接行的南北颠倒 —— 所以四个方位各有断言。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { PLACEHOLDER_REGISTRY } from './placeholder-registry';
import { installMapPack, resetMapRuntime } from './map-runtime';
import type { AgentConfig, AgentContext } from './types';
import type { MapPack, MapSaveFlags } from './types-map';

// ══════════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════════

const TILE_HOME = 1;
const TILE_NORTH = 2;
const TILE_EAST = 3;
const TILE_SOUTH = 4;
const TILE_WEST = 5;
const TILE_FAR = 6;

function makePack(): MapPack {
  return {
    version: '0.0.0-fixture',
    contentHash: 'fixture-hash',
    resolution: { w: 1000, h: 1000 },
    kmPerPx: 1,
    terrains: ['flatland', 'frostwaste', 'shelf', 'stillwater', 'crag'],
    travelRules: {
      rates: { land: 40, nearSea: 60, farSea: 100 },
      embarkCost: 20,
      terrainFactor: {},
    },
    countries: [
      { id: 'c-alpha', name: 'Alpha Realm', color: [10, 20, 30], anchorTileId: TILE_HOME },
      { id: 'c-beta', name: 'Beta Realm', color: [40, 50, 60], anchorTileId: TILE_EAST },
    ],
    midTiers: [
      {
        id: 'm-vale',
        name: 'Vale Province',
        countryId: 'c-alpha',
        climateId: '',
        anchorTileId: TILE_HOME,
      },
    ],
    climates: {},
    tiles: [
      {
        id: TILE_HOME,
        name: 'Homestead',
        terrain: 'flatland',
        water: null,
        impassable: false,
        countryId: 'c-alpha',
        midTierId: 'm-vale',
        centroid: [100, 100],
        areaPx: 90,
      },
      {
        // 正北：同主 → 不该标所有者
        id: TILE_NORTH,
        name: 'Frostmoor',
        terrain: 'frostwaste',
        water: null,
        impassable: false,
        countryId: 'c-alpha',
        midTierId: null,
        centroid: [100, 40],
        areaPx: 70,
      },
      {
        // 正东：异主 + 海（需船）
        id: TILE_EAST,
        name: 'Palewater',
        terrain: 'shelf',
        water: 'sea',
        impassable: false,
        countryId: 'c-beta',
        midTierId: null,
        centroid: [160, 100],
        areaPx: 60,
      },
      {
        // 正南：湖（v1 不可入）+ 无主
        id: TILE_SOUTH,
        name: 'Stillmere',
        terrain: 'stillwater',
        water: 'lake',
        impassable: false,
        countryId: null,
        midTierId: null,
        centroid: [100, 160],
        areaPx: 20,
      },
      {
        // 正西：不可通行
        id: TILE_WEST,
        name: 'Cragspine',
        terrain: 'crag',
        water: null,
        impassable: true,
        countryId: null,
        midTierId: null,
        centroid: [40, 100],
        areaPx: 30,
      },
      {
        // 两跳外的旅行目的地（经正北中转）
        id: TILE_FAR,
        name: 'Farhold',
        terrain: 'flatland',
        water: null,
        impassable: false,
        countryId: 'c-alpha',
        midTierId: null,
        centroid: [100, 20],
        areaPx: 50,
      },
    ],
    adjacency: [
      [TILE_HOME, TILE_NORTH, 12],
      [TILE_HOME, TILE_EAST, 14],
      [TILE_HOME, TILE_SOUTH, 8],
      [TILE_HOME, TILE_WEST, 6],
      [TILE_NORTH, TILE_FAR, 10],
    ],
    straits: [],
    placeBindings: {},
  };
}

function mockConfig(): AgentConfig {
  return {
    agentId: 'request_dispatcher',
    apiEndpointId: 'ep1',
    model: 'test-model',
    enabled: true,
    worldBookIds: [],
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    retryOnFail: true,
    timeout: 30000,
    userId: 'test-user',
    promptTemplate: { fixedSystem: '', fixedExamples: '' },
  };
}

function mockCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    userInput: '',
    history: [],
    worldBooks: [],
    characters: [],
    memories: [],
    plotEvents: [],
    variables: {},
    agentOutputs: new Map(),
    ...overrides,
  } as AgentContext;
}

/** 装包 + 落位 + 可选旗 → 渲染结果 */
function render(flags: MapSaveFlags, ctxOverrides?: Partial<AgentContext>): string {
  installMapPack(makePack());
  return PLACEHOLDER_REGISTRY['MAP_CONTEXT'](
    mockCtx({ mapFlags: flags, ...ctxOverrides }),
    mockConfig(),
  );
}

afterEach(() => {
  // 模块级状态跨用例存活；不还原会让「没装包应当空串」那条悄悄测在一份真包上（失败方向是变绿）
  resetMapRuntime();
});

// ══════════════════════════════════════════════════════════════
// 空包 / 未定位
// ══════════════════════════════════════════════════════════════

describe('{{MAP_CONTEXT}} —— 没装地图包', () => {
  it('🔴 整段是空串（地图是可选子系统，不用它的存档零 token）', () => {
    resetMapRuntime();
    const out = PLACEHOLDER_REGISTRY['MAP_CONTEXT'](
      mockCtx({ mapFlags: { lastTileId: TILE_HOME }, weather: 'light snow' }),
      mockConfig(),
    );
    expect(out).toBe('');
  });
});

describe('{{MAP_CONTEXT}} —— 装了包但没落位', () => {
  it('只出一行「未定位」，不出邻接/在途/提示行', () => {
    const out = render({});

    expect(out).toBe('<map_context>\n位置: 未定位（按叙事继续）\n</map_context>');
  });

  it('地块 id 在包里查不到（换图后的旧派生态）也走同一条出口', () => {
    expect(render({ lastTileId: 999 })).toContain('位置: 未定位（按叙事继续）');
  });

  it('未定位时在途旗与不连通标记都不渲染（算不出天数与下一站，目的地名叙事里刚写过）', () => {
    const out = render({
      journey: { toTileId: TILE_FAR, arriveAtMinute: 0 },
      lastMoveDiscontinuity: 1,
    });

    expect(out).not.toContain('旅行中');
    expect(out).not.toContain('提示:');
  });
});

// ══════════════════════════════════════════════════════════════
// 当前行
// ══════════════════════════════════════════════════════════════

describe('{{MAP_CONTEXT}} —— 当前行', () => {
  it('地块名 + 中层 + 国家（带「领」）+ 地形 + 天气（含季节）', () => {
    const out = render(
      { lastTileId: TILE_HOME },
      {
        weather: 'light snow',
        gameTime: {
          era: 'Fixture',
          year: 488,
          month: 11,
          day: 3,
          weekday: 1,
          hour: 9,
          minute: 0,
        },
      },
    );

    expect(out.split('\n')[1]).toBe(
      '位置: Homestead（Vale Province · Alpha Realm领）｜地形: flatland｜天气: light snow（冬季）',
    );
  });

  it('没有 gameTime 时天气格不带季节括注（不猜季节）', () => {
    const out = render({ lastTileId: TILE_HOME }, { weather: 'light snow' });

    expect(out).toContain('天气: light snow');
    expect(out).not.toContain('（冬季）');
  });

  it('没有天气时整格不写（不写「天气: —」这种假事实）', () => {
    const out = render({ lastTileId: TILE_HOME });

    expect(out).not.toContain('天气');
    expect(out.split('\n')[1]).toBe(
      '位置: Homestead（Vale Province · Alpha Realm领）｜地形: flatland',
    );
  });

  it('无中层 / 无主之地 → 括注只写有的那些，或整个不写', () => {
    const noMid = render({ lastTileId: TILE_NORTH });
    expect(noMid.split('\n')[1]).toContain('位置: Frostmoor（Alpha Realm领）');

    const unowned = render({ lastTileId: TILE_SOUTH });
    expect(unowned.split('\n')[1]).toBe('位置: Stillmere｜地形: stillwater');
  });
});

// ══════════════════════════════════════════════════════════════
// 邻接行
// ══════════════════════════════════════════════════════════════

describe('{{MAP_CONTEXT}} —— 邻接行（严格一跳）', () => {
  it('四个方位的中文标签各就各位（y 向下增长：正北是更小的 y）', () => {
    const line = render({ lastTileId: TILE_HOME }).split('\n')[2];

    expect(line.startsWith('邻接: ')).toBe(true);
    expect(line).toContain('北→Frostmoor');
    expect(line).toContain('东→Palewater');
    expect(line).toContain('南→Stillmere');
    expect(line).toContain('西→Cragspine');
  });

  it('🔴 所有者只在异主时标；同主邻块一个字都不写（§8.1 token 经济）', () => {
    const line = render({ lastTileId: TILE_HOME }).split('\n')[2];

    expect(line).toContain('东→Palewater(shelf·Beta Realm领·需船)');
    expect(line).toContain('北→Frostmoor(frostwaste)');
    expect(line).not.toContain('Alpha Realm领·');
  });

  it('通行性照标：海=需船 / 湖=不可入 / impassable=不可通行', () => {
    const line = render({ lastTileId: TILE_HOME }).split('\n')[2];

    expect(line).toContain('南→Stillmere(stillwater·不可入)');
    expect(line).toContain('西→Cragspine(crag·不可通行)');
  });

  it('孤块（没有任何邻接）不渲染空的邻接行', () => {
    const pack = makePack();
    pack.adjacency = [];
    pack.straits = [];
    installMapPack(pack);

    const out = PLACEHOLDER_REGISTRY['MAP_CONTEXT'](
      mockCtx({ mapFlags: { lastTileId: TILE_HOME } }),
      mockConfig(),
    );
    expect(out).not.toContain('邻接');
  });
});

// ══════════════════════════════════════════════════════════════
// 在途行 / 提示行
// ══════════════════════════════════════════════════════════════

describe('{{MAP_CONTEXT}} —— 在途行', () => {
  it('目的地 + 计划路线下一站 + 约还需天数（三格齐）', () => {
    const out = render({
      lastTileId: TILE_HOME,
      journey: {
        toTileId: TILE_FAR,
        plannedPath: [TILE_HOME, TILE_NORTH, TILE_FAR],
        arriveAtMinute: 9999,
      },
    });

    const line = out.split('\n').find((l) => l.startsWith('旅行中'));
    expect(line).toBe('旅行中: 前往Farhold，沿计划路线，下一站 Frostmoor，约还需 2 天');
  });

  it('偏离计划路线（当前块不在 plannedPath 上）→ 只少「下一站」这一格，天数照旧重估', () => {
    const out = render({
      lastTileId: TILE_HOME,
      journey: { toTileId: TILE_FAR, plannedPath: [TILE_EAST, TILE_FAR], arriveAtMinute: 1 },
    });

    const line = out.split('\n').find((l) => l.startsWith('旅行中')) ?? '';
    expect(line).toContain('前往Farhold');
    expect(line).not.toContain('下一站');
    expect(line).toContain('约还需');
  });

  it('目的地地块查不到（旗是旧包留下的）→ 整段在途行不出，不硬造「前往（未知）」', () => {
    const out = render({ lastTileId: TILE_HOME, journey: { toTileId: 999, arriveAtMinute: 1 } });

    expect(out).not.toContain('旅行中');
  });
});

describe('{{MAP_CONTEXT}} —— 不连通提示行', () => {
  it('判据是这一格在不在（`projectLocationFlags` 相邻时会显式删掉它）', () => {
    const withFlag = render({ lastTileId: TILE_HOME, lastMoveDiscontinuity: 1 });
    expect(withFlag).toContain('提示: 上回合移动跨越了不相邻地块（如为传送/剧情跳转可忽略）');

    const without = render({ lastTileId: TILE_HOME });
    expect(without).not.toContain('提示:');
  });

  it('至多一条提示行（§8.1）', () => {
    const out = render({ lastTileId: TILE_HOME, lastMoveDiscontinuity: 3 });
    expect(out.split('\n').filter((l) => l.startsWith('提示:'))).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 天气读法 / 保护面
// ══════════════════════════════════════════════════════════════

describe('{{MAP_CONTEXT}} —— 天气读法', () => {
  it('`ctx.weather` 优先（供值侧已走完 sys.天气 → worldFlags 两格兜底）', () => {
    const out = render(
      { lastTileId: TILE_HOME },
      { weather: 'supplied', variables: { sys: { 天气: 'from-vars' } } },
    );
    expect(out).toContain('天气: supplied');
  });

  it('没供值时回落 `variables.sys.天气`（变量真源；漏供不该让天气格静默消失）', () => {
    const out = render({ lastTileId: TILE_HOME }, { variables: { sys: { 天气: 'from-vars' } } });
    expect(out).toContain('天气: from-vars');
  });

  it('空串 / 非字符串一律读作「没有天气」', () => {
    expect(render({ lastTileId: TILE_HOME }, { weather: '   ' })).not.toContain('天气');
    expect(
      render({ lastTileId: TILE_HOME }, { variables: { sys: { 天气: 42 } } as never }),
    ).not.toContain('天气');
  });
});

describe('{{MAP_CONTEXT}} —— 保护面（§8.3）', () => {
  it('🔴 不出现 tileId、也不出现像素坐标', () => {
    const out = render({
      lastTileId: TILE_HOME,
      journey: {
        toTileId: TILE_FAR,
        plannedPath: [TILE_HOME, TILE_NORTH, TILE_FAR],
        arriveAtMinute: 9999,
      },
    });

    // 唯一允许出现的数字是天数（「约还需 N 天」）——把它剃掉后应当一个数字都不剩
    const withoutDays = out.replace(/约还需 \d+ 天/g, '');
    expect(withoutDays).not.toMatch(/\d/);
  });

  it('外壳自带，模板不必再包一层（没地图时才可能是空串）', () => {
    const out = render({ lastTileId: TILE_HOME });
    expect(out.startsWith('<map_context>\n')).toBe(true);
    expect(out.endsWith('\n</map_context>')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 供值链路（blurByDefault 教训：单模块测试证明不了有人供值）
// ══════════════════════════════════════════════════════════════

const UI_SOURCES: Record<string, string> = import.meta.glob('@ui/lib/game-pipeline.ts', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

describe('AgentContext 供值', () => {
  it('🔴 game-pipeline 的 buildContext 真的传了 mapFlags 与 weather', () => {
    const source = Object.values(UI_SOURCES)[0] ?? '';
    expect(source.length).toBeGreaterThan(0);

    expect(source).toContain('mapFlags: this.game.saveProfile');
    expect(source).toContain('getMapFlags(this.game.saveProfile)');
    expect(source).toContain('weather: resolveSceneWeather(this.game.saveProfile)');
  });
});
