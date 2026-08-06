import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { parseCatalogData, isCatalogPopulated } from '../src/sillytavern/start-catalog-mechanics';
import { coerceLocationNodes, getChildren, getNeighbors } from '../src/sillytavern/location-db';
import { getBloodlineSet, calcBloodlineModifiers } from '../src/sillytavern/bloodlines';
import { getNamePoolsContent, randomName, randomHairColor } from '../src/sillytavern/random-tables';
import { resolveBranding, NEUTRAL_BRANDING } from '../src/ui/branding-defaults';
import { setContentRegistry, getContentRegistry } from '../src/ui/stores/content-store';

/**
 * 占位内容集能不能被现有解析器吃下（内容-引擎分离 §6 / T16）。
 *
 * ## 为什么这条测试值得单开
 * 占位件是**纯数据**，写错不会让编译红、也不会让任何逻辑测试红 —— 它只会在真机上表现为
 * 「捏人页种族列表是空的」「地图查不到相邻节点」「首页标题回落成中性默认值」这类**空但不报错**
 * 的状态，而那恰好和「内容还没加载完」长得一模一样，极难归因。所以这里把每一面都真的喂进
 * 它的生产解析器，断言解析结果**非空且结构对**，而不是只断言 JSON 能 parse。
 *
 * ## 两条与真实内容侧的强绑定（改占位件时最容易踩）
 * 1. **血脉 id + statModifiers 必须与 `data/content/bloodlines.json` 逐字一致**（§6 / D25②）——
 *    存档里躺着的是 id，属性加成是拿 statModifiers 现算的；占位态与内容包态算出不同的属性
 *    等于同一个角色换了张面板。
 * 2. **catalog.raceCosts 的键是血脉的 name**（create-store 拿种族名查表）—— 键写成 id 不会报错，
 *    只会让每个种族的点数消耗静默变成兜底值。
 */

const REPO_ROOT = join(__dirname, '..');
const PLACEHOLDER_CONTENT = join(REPO_ROOT, 'data', 'placeholder', 'content');
const PLACEHOLDER_DEFAULTS = join(REPO_ROOT, 'data', 'placeholder', 'defaults');
const REAL_CONTENT = join(REPO_ROOT, 'data', 'content');
const REAL_DEFAULTS = join(REPO_ROOT, 'data', 'defaults');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const catalogRaw = readJson(join(PLACEHOLDER_CONTENT, 'catalog.json'));
const locationsRaw = readJson(join(PLACEHOLDER_CONTENT, 'locations.json'));
const bloodlinesRaw = readJson(join(PLACEHOLDER_CONTENT, 'bloodlines.json'));
const namePoolsRaw = readJson(join(PLACEHOLDER_CONTENT, 'name-pools.json'));
const brandingRaw = readJson(join(PLACEHOLDER_CONTENT, 'branding.json'));
const markersRaw = readJson(join(PLACEHOLDER_DEFAULTS, 'map-marker-presets.json'));
const audioManifestRaw = readJson(join(PLACEHOLDER_DEFAULTS, 'audio-manifest.json'));
const beautifierRaw = readJson(join(PLACEHOLDER_DEFAULTS, 'beautifier-rules.json')) as {
  version: number;
  rules: Array<Record<string, unknown>>;
};
const agentConfigRaw = readJson(join(PLACEHOLDER_DEFAULTS, 'agent-config.json')) as {
  version: number;
  agents: Record<string, Record<string, unknown>>;
};

describe('占位内容 · 注册表六面能被生产解析器吃下', () => {
  beforeEach(() => {
    setContentRegistry({
      catalog: catalogRaw,
      locations: locationsRaw,
      bloodlines: bloodlinesRaw,
      namePools: namePoolsRaw,
      markers: markersRaw,
      branding: brandingRaw,
    });
  });

  it('catalog：七池解析出来非空，三类装备各 ≥3 件', () => {
    const catalog = parseCatalogData(getContentRegistry().catalog);
    expect(isCatalogPopulated(catalog)).toBe(true);
    expect(catalog.destinyCores).toHaveLength(3);
    expect(catalog.itemPool.length).toBeGreaterThanOrEqual(5);
    expect(catalog.backgrounds).toHaveLength(3);
    for (const type of ['武器', '防具', '饰品']) {
      const bucket = catalog.equipmentPool.filter((e) => e.type === type);
      expect(bucket.length, `装备类型「${type}」`).toBeGreaterThanOrEqual(3);
      expect(bucket.length, `装备类型「${type}」`).toBeLessThanOrEqual(5);
    }
    // 起始地树：叶节点的 value 必须是「顶层-中层-叶」这种可直接写进角色 location 的整串
    const leaf = catalog.startLocations[0]?.children?.[0]?.children?.[0];
    expect(leaf?.value.split('-').length).toBeGreaterThanOrEqual(3);
  });

  it('catalog.raceCosts 的键是血脉的 name（不是 id）—— 写成 id 会让点数静默变兜底值', () => {
    const catalog = parseCatalogData(catalogRaw);
    const names = new Set(Object.values(getBloodlineSet()).map((b) => b.name));
    for (const key of Object.keys(catalog.raceCosts)) {
      if (key === '自定义') continue;
      expect(names.has(key), `raceCosts 的键「${key}」不是任何血脉的 name`).toBe(true);
    }
  });

  it('locations：6-8 个节点，父子与相邻都查得到', () => {
    const nodes = coerceLocationNodes(locationsRaw);
    expect(nodes.length).toBeGreaterThanOrEqual(6);
    expect(nodes.length).toBeLessThanOrEqual(8);
    // 每个非根节点的 parentId 都必须指向存在的节点（悬空父指针会让路径拼接静默截断）
    const ids = new Set(nodes.map((n) => n.id));
    for (const node of nodes) {
      if (node.parentId !== null) expect(ids.has(node.parentId), node.id).toBe(true);
    }
    expect(getChildren(nodes, 'continent_midland').length).toBeGreaterThan(0);
    expect(getNeighbors(nodes, 'city_stonebridge').length).toBeGreaterThan(0);
    // 每条 neighbors 的 targetId 也必须存在
    for (const node of nodes) {
      for (const edge of node.neighbors) expect(ids.has(edge.targetId), edge.targetId).toBe(true);
    }
  });

  it('bloodlines：id 与 statModifiers 与真实内容侧逐字一致（§6 / D25②）', () => {
    const placeholder = getBloodlineSet();
    const real = readJson(join(REAL_CONTENT, 'bloodlines.json')) as Record<
      string,
      { statModifiers?: Record<string, number> }
    >;
    expect(Object.keys(placeholder).sort()).toEqual(Object.keys(real).sort());
    for (const [id, info] of Object.entries(placeholder)) {
      expect(info.statModifiers ?? {}, `血脉「${id}」的 statModifiers`).toEqual(
        real[id].statModifiers ?? {},
      );
      expect(info.description.length).toBeGreaterThan(0);
    }
    // 累加纯函数照常工作（未知 id 静默忽略，不抛）
    expect(calcBloodlineModifiers(['dwarf', 'elf', '不存在的血脉'])).toEqual({
      con: 2,
      str: 1,
      dex: 2,
      int: 1,
    });
  });

  it('namePools：每池 8-12 个名字，取名/取色都取得到值', () => {
    const content = getNamePoolsContent();
    expect(Object.keys(content.namePools).length).toBeGreaterThan(0);
    for (const [race, pool] of Object.entries(content.namePools)) {
      for (const [field, list] of Object.entries(pool)) {
        expect(list.length, `${race}.${field}`).toBeGreaterThanOrEqual(8);
        expect(list.length, `${race}.${field}`).toBeLessThanOrEqual(12);
      }
    }
    // 六个维度的性格池必须齐 —— 缺一维会让 personality code 少一位，下游按位解读就错位了
    expect(Object.keys(content.personality).sort()).toEqual(
      ['firmness', 'openness', 'persistence', 'stability', 'urgency', 'warmth'].sort(),
    );
    // 没有专属池的种族靠 defaultRace / defaultColorKey 回落，仍然出得了名字与发色
    expect(randomName('人类', '男').length).toBeGreaterThan(0);
    expect(randomName('古龙', '女').length).toBeGreaterThan(0);
    expect(randomHairColor('古龙').length).toBeGreaterThan(0);
  });

  it('branding：解析后不回落中性默认值，且 mapSources 为空（D23 空态）', () => {
    const branding = resolveBranding(brandingRaw);
    expect(branding.era).toBe('元年');
    expect(branding.appTitle.length).toBeGreaterThan(0);
    expect(branding.subtitles.length).toBeGreaterThan(0);
    expect(branding.plotTemplate.length).toBeGreaterThan(0);
    // 品牌面不该整份掉回中性默认值 —— 那说明字段名写错了（解析器只做逐字段回落，不报错）
    expect(branding.worldSummary.title).not.toBe(NEUTRAL_BRANDING.worldSummary.title);
    // 🔴 公开仓没有任何图源，工坊也未配置：两者都必须是「未配置」而不是某个地址
    expect((brandingRaw as { mapSources: unknown[] }).mapSources).toEqual([]);
    expect(branding.workshopApiBase).toBe('');
  });

  it('markers / audio manifest：空数组（面板空态，D12 / D23）', () => {
    expect(markersRaw).toEqual([]);
    expect(audioManifestRaw).toEqual([]);
  });
});

describe('占位内容 · 美化规则', () => {
  it('4-6 条自写演示规则，pattern 全部能编译', () => {
    expect(beautifierRaw.rules.length).toBeGreaterThanOrEqual(4);
    expect(beautifierRaw.rules.length).toBeLessThanOrEqual(6);
    const realIds = new Set(
      (
        readJson(join(REAL_DEFAULTS, 'beautifier-rules.json')) as { rules: Array<{ id: string }> }
      ).rules.map((r) => r.id),
    );
    for (const rule of beautifierRaw.rules) {
      // 🔴 加载器读的是 defaultEnabled，不是 enabled（beautifier.ts 的 loadPresetRules）
      expect(rule).toHaveProperty('defaultEnabled');
      expect(typeof rule.scope).toBe('string');
      expect(() => new RegExp(rule.pattern as string, rule.flags as string)).not.toThrow();
      // 自写而非复制：id 不许与真实规则库撞（D11 再分发权未定）
      expect(realIds.has(rule.id as string)).toBe(false);
    }
    const scopes = new Set(beautifierRaw.rules.map((r) => r.scope));
    expect(scopes.has('maintext')).toBe(true);
    expect(scopes.has('global')).toBe(true);
  });
});

describe('占位内容 · agent-config', () => {
  const REAL_AGENT_IDS = Object.keys(
    (readJson(join(REAL_DEFAULTS, 'agent-config.json')) as { agents: Record<string, unknown> })
      .agents,
  );

  it('agent id 与真实内容侧完全相同的 13 个，一个不多一个不少', () => {
    expect(REAL_AGENT_IDS).toHaveLength(13);
    expect(Object.keys(agentConfigRaw.agents).sort()).toEqual([...REAL_AGENT_IDS].sort());
  });

  it('每个 agent 的 systemPrompt 与 template 都非空', () => {
    for (const [id, agent] of Object.entries(agentConfigRaw.agents)) {
      expect((agent.systemPrompt as string).trim().length, `${id}.systemPrompt`).toBeGreaterThan(0);
      // story 的可调面是预设，template 天然为空串（agent-defaults.ts 的约定）
      if (id !== 'story') {
        expect((agent.template as string).trim().length, `${id}.template`).toBeGreaterThan(0);
      }
    }
  });

  it('worldBookIds 全部指向真实存在的占位世界书（悬空引用不报错，只是静默少注入一本）', () => {
    const books = new Set(
      readdirSync(join(REPO_ROOT, 'data', 'placeholder', 'worldbooks'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length)),
    );
    expect(books.size).toBeGreaterThan(0);
    for (const [id, agent] of Object.entries(agentConfigRaw.agents)) {
      for (const bookId of (agent.worldBookIds ?? []) as string[]) {
        expect(books.has(bookId), `${id} 引用了不存在的世界书「${bookId}」`).toBe(true);
      }
    }
  });

  it('story 挂占位预设：presetId 固定，且与真实预设 id 不同（D20 四态基线靠它区分）', () => {
    const story = agentConfigRaw.agents.story as {
      presetId: string;
      preset: { id: string; settings: { prompts: unknown[] } };
    };
    expect(story.presetId).toBe('placeholder-story-v1');
    expect(story.preset.id).toBe(story.presetId);
    expect(story.preset.settings.prompts.length).toBeGreaterThanOrEqual(8);

    const realPresetId = (
      readJson(join(REAL_DEFAULTS, 'agent-config.json')) as {
        agents: { story: { presetId: string } };
      }
    ).agents.story.presetId;
    expect(story.presetId).not.toBe(realPresetId);
  });

  it('引擎协议在占位版里保真：各 agent 的关键输出标签一个不少', () => {
    const CONTRACT: Record<string, string[]> = {
      craft_gen: ['<craft_result>', '<item_requests>', '<narrative>', '<craft_params>', '<affix>'],
      char_gen: [
        '<char_result>',
        '<attributes',
        '<skill_requests>',
        '<equipment_requests>',
        '<item_requests>',
        '<ascension',
      ],
      item_gen: ['<item_result>', '<skills>', '<equipment>', '<inventory>', '<modifiers>'],
      vars_update: ['<json>', '<status_effects>', '"consume"', '"upsert"', '"affections"'],
      request_dispatcher: [
        '<char_gen_request',
        '<char_update_request',
        '<item_gen_request',
        '<item_update_request',
        '<craft_gen_request',
        '<combat_trigger',
      ],
      plot_outline: ['<outline>', '<chapter', '<event', '<self_critique', '<npc_audit>'],
      plot_pre_check: ['<json>', '"triggeredEvents"', '"relevantBackground"', '"directive"'],
      plot_post_check: ['<json>', '"worldLineChanged"', '"eventUpdates"', '"newChildEvents"'],
      memory_summary: ['<json>', '"hiddenLine"', '"relatedCharacterIds"', '"importance"'],
      memory_recall: ['"memories"', '"relevance"'],
      image_prompt: ['<image_prompt>', '<image_negative>', '<image_desc>'],
      combat_v3: ['declare_attack', 'declare_action', 'pass_slot', 'write_summary'],
    };
    for (const [id, tokens] of Object.entries(CONTRACT)) {
      const prompt = agentConfigRaw.agents[id].systemPrompt as string;
      for (const token of tokens) {
        expect(prompt.includes(token), `${id} 的提示词缺少契约片段 ${token}`).toBe(true);
      }
    }
  });
});
