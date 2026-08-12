import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { parseCatalogData, isCatalogPopulated } from '../src/sillytavern/start-catalog-mechanics';
import { coerceLocationNodes, getChildren, getNeighbors } from '../src/sillytavern/location-db';
import { getBloodlineSet, calcBloodlineModifiers } from '../src/sillytavern/bloodlines';
import { getNamePoolsContent, randomName, randomHairColor } from '../src/sillytavern/random-tables';
import { resolveBranding, NEUTRAL_BRANDING } from '../src/ui/branding-defaults';
import { parseImageDialects, FALLBACK_IMAGE_DIALECT } from '../src/sillytavern/image-dialect';
import {
  DEFAULT_IMAGE_BASE_NEGATIVE,
  DEFAULT_IMAGE_COMPOSITION_TAGS,
  DEFAULT_IMAGE_QUALITY_SUFFIX,
} from '../src/sillytavern/image-defaults';
import { setContentRegistry, getContentRegistry } from '../src/ui/stores/content-store';
import { coerceMapPack, isEmptyMapPack } from '../src/sillytavern/map-pack';

/**
 * 占位内容集能不能被现有解析器吃下（内容-引擎分离 §6 / T16）。
 *
 * ## 为什么这条测试值得单开
 * 占位件是**纯数据**，写错不会让编译红、也不会让任何逻辑测试红 —— 它只会在真机上表现为
 * 「捏人页种族列表是空的」「地图查不到相邻节点」「首页标题回落成中性默认值」这类**空但不报错**
 * 的状态，而那恰好和「内容还没加载完」长得一模一样，极难归因。所以这里把每一面都真的喂进
 * 它的生产解析器，断言解析结果**非空且结构对**，而不是只断言 JSON 能 parse。
 *
 * ## 公开侧自洽（内容-引擎分离波 4 / D14）
 * 真实内容已迁私有仓，公开侧只有占位件。占位件与真实内容的一致性契约移到私有仓 CI
 * （那里有真实内容可比对）；本测试保留**占位件能被生产解析器吃下**的全部自洽断言，
 * 以及 §6 的形状约束（数量 / 非空 / 空态）。
 */

const REPO_ROOT = join(__dirname, '..');
const PLACEHOLDER_CONTENT = join(REPO_ROOT, 'public', 'data', 'content');
const PLACEHOLDER_DEFAULTS = join(REPO_ROOT, 'public', 'data', 'defaults');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const catalogRaw = readJson(join(PLACEHOLDER_CONTENT, 'catalog.json'));
const locationsRaw = readJson(join(PLACEHOLDER_CONTENT, 'locations.json'));
const bloodlinesRaw = readJson(join(PLACEHOLDER_CONTENT, 'bloodlines.json'));
const namePoolsRaw = readJson(join(PLACEHOLDER_CONTENT, 'name-pools.json'));
const brandingRaw = readJson(join(PLACEHOLDER_CONTENT, 'branding.json'));
const imageDialectsRaw = readJson(join(PLACEHOLDER_CONTENT, 'image-dialects.json'));
const mapPackRaw = readJson(join(PLACEHOLDER_CONTENT, 'map-pack.json'));
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

describe('占位内容 · 注册表八面能被生产解析器吃下', () => {
  beforeEach(() => {
    setContentRegistry({
      catalog: catalogRaw,
      locations: locationsRaw,
      bloodlines: bloodlinesRaw,
      namePools: namePoolsRaw,
      markers: markersRaw,
      branding: brandingRaw,
      imageDialects: imageDialectsRaw,
      mapPack: mapPackRaw,
    });
  });

  it('mapPack 占位包过生产 coerce 且非空', () => {
    const pack = coerceMapPack(mapPackRaw);
    expect(isEmptyMapPack(pack)).toBe(false);
    expect(pack.tiles.length).toBeGreaterThan(0);
    expect(pack.countries.length).toBeGreaterThan(0);
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

  it('bloodlines：占位集形状自洽 —— 同 id 的 statModifiers 与真实内容一致由私有仓 CI 守', () => {
    const placeholder = getBloodlineSet();
    expect(Object.keys(placeholder).length).toBeGreaterThan(0);
    for (const [id, info] of Object.entries(placeholder)) {
      // 人类是中性基准（无加成）；有 statModifiers 的血脉必须是对象
      if (info.statModifiers !== undefined) {
        expect(typeof info.statModifiers, `血脉「${id}」的 statModifiers`).toBe('object');
      }
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

  it('imageDialects：两条内置方言解析得出，且 danbooru 档 = 图像 v1 的行为（C5）', () => {
    const dialects = parseImageDialects(getContentRegistry().imageDialects);
    expect(dialects.map((d) => d.id)).toEqual(['danbooru-anime', 'natural-prose']);

    // 🔴 danbooru 档的三个串必须**逐字节**等于引擎常量：这一面是「零行为变化的纯重构」，
    //    漂了不会报错，只会让每张图悄悄换一套画质词
    const [danbooru, prose] = dialects;
    expect(danbooru.qualitySuffix).toBe(DEFAULT_IMAGE_QUALITY_SUFFIX);
    expect(danbooru.baseNegative).toBe(DEFAULT_IMAGE_BASE_NEGATIVE);
    expect(danbooru.composition).toBe(DEFAULT_IMAGE_COMPOSITION_TAGS);
    // 🔴 兜底方言与它**逐格相同，systemPrompt 也算**（2026-08-08 修）：C5 之后这段提示词
    //    在 agent-config 里已不存在，兜底若留空，注册表这一面缺席时侧链就只剩
    //    agent-templates 那行 stub 可回落 —— 五条规则一条不剩，图照出、Anlas 照扣。
    //    这一对断言是那份「兜底 ↔ 内容树」双向漂移的**唯一**守门人（`image-dialect.test.ts`
    //    读不了盘），所以 systemPrompt 单独再钉一次，好让失败信息直指那一格
    expect(danbooru.systemPrompt).toBe(FALLBACK_IMAGE_DIALECT.systemPrompt);
    expect(danbooru).toEqual(FALLBACK_IMAGE_DIALECT);

    // 🔴 C5 已收口：`image_prompt` 的 systemPrompt **从 agent-config 退役**，方言 JSON 是
    //    唯一真源。两处都留着的话就是 D53 警告的第三份拷贝 —— 改一处不改另一处不报错，
    //    只是侧链按哪一份说话取决于装配顺序
    expect(agentConfigRaw.agents.image_prompt.systemPrompt).toBeUndefined();
    expect(danbooru.systemPrompt.trim().length).toBeGreaterThan(0);

    // prose 档是刻意单薄的占位（真货在私有仓），但**旋钮必须真的不同** ——
    // 只换 systemPrompt 的方言仍会给 krea2 拼上 danbooru 尾巴（C3 的全部理由）
    expect(prose.separator).toBe('. ');
    expect(prose.normalize).toBe('none');
    expect(prose.appearance).toBe('prose');
    expect(prose.rating).toBe('none');
    expect(prose.count).toBe('none');
    expect(prose.supportsNegative).toBe(false);
    expect(prose.qualitySuffix).toBe('');
    expect(prose.baseNegative).toBe('');
    // 三个输出标签是引擎协议，换方言不换协议（抽取器只认这三个）。
    // 🔴 **两条方言都要钉**：C5 之后这里是那份契约的唯一守门人（agent-config 那份已退役）
    for (const tag of ['<image_prompt>', '<image_negative>', '<image_desc>']) {
      expect(prose.systemPrompt, `natural-prose 缺少 ${tag}`).toContain(tag);
      expect(danbooru.systemPrompt, `danbooru-anime 缺少 ${tag}`).toContain(tag);
    }
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
    const ids = new Set(beautifierRaw.rules.map((r) => r.id as string));
    expect(ids.size).toBe(beautifierRaw.rules.length); // id 唯一
    for (const rule of beautifierRaw.rules) {
      // 🔴 加载器读的是 defaultEnabled，不是 enabled（beautifier.ts 的 loadPresetRules）
      expect(rule).toHaveProperty('defaultEnabled');
      expect(typeof rule.scope).toBe('string');
      expect(() => new RegExp(rule.pattern as string, rule.flags as string)).not.toThrow();
    }
    const scopes = new Set(beautifierRaw.rules.map((r) => r.scope));
    expect(scopes.has('maintext')).toBe(true);
    expect(scopes.has('global')).toBe(true);
  });
});

describe('占位内容 · agent-config', () => {
  // §6 规格：占位版固定 13 个 agent id（与真实内容侧相同的 id 集由私有仓 CI 守）
  it('agent id 恰好 13 个，一个不多一个不少', () => {
    expect(Object.keys(agentConfigRaw.agents)).toHaveLength(13);
  });

  it('每个 agent 的 systemPrompt 与 template 都非空（image_prompt 除外 —— 它的那份归方言）', () => {
    for (const [id, agent] of Object.entries(agentConfigRaw.agents)) {
      // 🔴 image_prompt 的 systemPrompt 已随 C5 退役到 `image-dialects.json`：
      //    方言拥有整个装配契约，「教模型怎么说话」是其中一格。这里断言它**不在**，
      //    上面那条 imageDialects 用例断言它在方言里
      if (id === 'image_prompt') {
        expect(agent.systemPrompt, 'image_prompt.systemPrompt 应已退役').toBeUndefined();
      } else {
        expect((agent.systemPrompt as string).trim().length, `${id}.systemPrompt`).toBeGreaterThan(
          0,
        );
      }
      // story 的可调面是预设，template 天然为空串（agent-defaults.ts 的约定）
      if (id !== 'story') {
        expect((agent.template as string).trim().length, `${id}.template`).toBeGreaterThan(0);
      }
    }
  });

  it('worldBookIds 全部指向真实存在的占位世界书（悬空引用不报错，只是静默少注入一本）', () => {
    const books = new Set(
      readdirSync(join(REPO_ROOT, 'public', 'data', 'worldbooks'))
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

  it('story 挂占位预设：presetId 固定且以 placeholder- 前缀开头（D20 四态基线靠它区分）', () => {
    const story = agentConfigRaw.agents.story as {
      presetId: string;
      preset: { id: string; settings: { prompts: unknown[] } };
    };
    expect(story.presetId).toBe('placeholder-story-v1');
    expect(story.preset.id).toBe(story.presetId);
    expect(story.preset.settings.prompts.length).toBeGreaterThanOrEqual(8);
    expect(story.presetId.startsWith('placeholder-')).toBe(true);
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
      // 🔴 image_prompt 不在这张表里：它的提示词住在方言 JSON（C5），三个输出标签由
      //    上面 imageDialects 那条用例逐条钉（两条方言各钉一遍 —— 换方言不换协议）
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
