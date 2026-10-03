/**
 * entity-gen-parse.ts — entity_gen 的 XML/JSON 解析（角色/技能/装备/道具/状态/登神）
 *
 * 🔴 2026-10-02 硬改名：从 `char-gen-agent.ts` 抽出的共享解析层（原 char_gen 与 item_gen
 *    两条链各持一份，且 item-gen-chain / craft-gen-chain 用反向懒 import 绕环）。
 *
 * ## 统一输出契约（entity_gen → 本模块）
 * ```xml
 * <entity_result>
 *   <character> …角色字段 + 内嵌 skills/equipment/inventory/ascension… </character>
 *   <skills><skill name type quality cost_type cost_amount power attr dtype cooldown>
 *     描述<effect name="词条名">词条描述</effect><tag>标签原文</tag></skill></skills>
 *   <equipment><equip slot name quality durability stats="属性:数值">…</equip></equipment>
 *   <inventory><item name quantity type rarity>…</item></inventory>
 *   <statuses><status name category stacks remainingTime timeUnit>…</status></statuses>
 *   <ascension enabled path description>…</ascension>
 * </entity_result>
 * ```
 *
 * ## 两层字段（主人裁定 2026-10-02）
 * - `protocolText` = 该条目元素的**原样内文**（零丢失，AI 依协议文本结算）
 * - `tags` = 该条目下所有 `<tag>` 文本 + AI 直写的 `[...]`
 * - 保留简单标量（type/rarity/cost/skillPower/relevantAttribute/damageType/effects/...）
 * - 🔴 **不解析** `<modifiers>/<buff>/<automaton>/<script>/<divinity>`：AI 即使写了也忽略，
 *   并在 description 里剥离，不落库（Phase 2 战斗重写前保留实体字段本身，但生成链不再填充）。
 *
 * ## 解析工具面
 * XML 工具统一在 `agent-xml.ts`（Q-05），JSON 抢救在 `utils/model-json.ts`。
 */

import type {
  CharGenOutput,
  EntityGenOutput,
  EntityStatusOutput,
  ItemGenOutput,
  DamageType,
} from '../types/types';
import {
  tagInner,
  tagBlock,
  tagAttr,
  tagAttrInt,
  parseAttrsStr,
  stripInnerTags,
  parseNamedChildren,
  stripKnownChildBlocks,
} from './agent-xml';
import { extractJsonPayload } from '../utils/model-json';

/** 剥壳取 JSON；抠不到时退回原文（调用方自己 try/catch parse） */
function extractJsonOrRaw(text: string): string {
  return extractJsonPayload(text) ?? text;
}

/** 空 entity 输出占位 */
function emptyEntityGenOutput(): EntityGenOutput {
  return { skills: [], equipment: [], inventory: [], statuses: [] };
}

// ========== 标签 / 协议文本 ==========

/**
 * 收集条目下的标签原文：`<tag>…</tag>` 子元素 + AI 直写的 `[...]`。
 *
 * 去重保序，空串丢弃。`<tag>` 是协议标记（会被 description 剥离），
 * `[...]` 是 AI 顺手的自由写法（同样不落进 description）。
 */
function collectItemTags(inner: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    tags.push(t);
  };
  // <tag …>原文</tag> / <tag …/>
  const tgRe = /<tag\b[^>]*>([\s\S]*?)<\/tag>/gi;
  let m: RegExpExecArray | null;
  while ((m = tgRe.exec(inner)) !== null) push(m[1].replace(/<[^>]+>/g, '').trim());
  // AI 直写方括号（不含嵌套方括号）
  const brRe = /\[([^[\]]+)\]/g;
  while ((m = brRe.exec(inner)) !== null) push(m[1]);
  return tags;
}

/** 从条目内文剥掉 `<tag>` 块（避免标签原文漏进 description；标签内容另存 tags） */
function stripTagBlocks(inner: string): string {
  return inner.replace(/<tag\b[^>]*>[\s\S]*?<\/tag>/gi, '').replace(/<tag\b[^>]*\/>/gi, '');
}

/**
 * 描述 = 内文去掉已知子块（effect/script/tag/modifiers/buffs/automaton）后的纯文本。
 * 优先取 `<description>` 子标签文本（与旧行为一致）。
 */
function extractDescription(inner: string): string {
  const descSub = inner.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
  if (descSub) return stripInnerTags(descSub[1]).trim();
  const stripped = stripInnerTags(stripTagBlocks(stripKnownChildBlocks(inner)));
  return stripped.replace(/<\/?[a-z_][\w-]*[^>]*>/gi, '').trim();
}

// ========== 技能 / 装备 / 道具 ==========

const ATTR_KEYS = new Set(['str', 'dex', 'con', 'int', 'spi']);
const DMG_TYPES = new Set(['物理', '能量', '精神', '真实']);

/** 解析 `<skills>` 块内的 `<skill>` 子元素 */
function parseSkillsXML(xml: string): ItemGenOutput['skills'] {
  const matches = xml.matchAll(/<skill\s+([^>]*?)>([\s\S]*?)<\/skill>/g);
  const results: ItemGenOutput['skills'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const effects = parseNamedChildren(innerContent, 'effect');
    const description = extractDescription(innerContent);

    const skillType = (attrs['type'] ?? '').trim();
    const normalizedType: 'active' | 'passive' =
      skillType === '被动' || skillType === 'passive' ? 'passive' : 'active';

    const skillPowerAttr = attrs['power'] ? parseInt(attrs['power']) || 0 : undefined;
    const relevantAttrRaw = attrs['attr'];
    const relevantAttribute =
      relevantAttrRaw && ATTR_KEYS.has(relevantAttrRaw)
        ? (relevantAttrRaw as 'str' | 'dex' | 'con' | 'int' | 'spi')
        : undefined;
    const dtypeRaw = attrs['dtype'];
    const damageType = dtypeRaw && DMG_TYPES.has(dtypeRaw) ? (dtypeRaw as DamageType) : undefined;
    const qualityRaw = attrs['quality'];
    const quality = qualityRaw && qualityRaw !== '?' ? qualityRaw : undefined;
    const tags = collectItemTags(innerContent);

    results.push({
      name: attrs['name'] ?? '未命名技能',
      description,
      type: normalizedType,
      cost: attrs['cost_type']
        ? {
            type: attrs['cost_type'] as 'HP' | 'MP' | 'SP',
            amount: parseInt(attrs['cost_amount'] ?? '0'),
          }
        : undefined,
      cooldown: attrs['cooldown'] ? parseInt(attrs['cooldown']) : undefined,
      ...(quality ? { quality } : {}),
      effects: Object.keys(effects).length > 0 ? effects : undefined,
      ...(skillPowerAttr !== undefined ? { skillPower: skillPowerAttr } : {}),
      ...(relevantAttribute ? { relevantAttribute } : {}),
      ...(damageType ? { damageType } : {}),
      // 两层字段
      ...(innerContent ? { protocolText: innerContent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

/** 解析 `<equipment>` 块内的 `<equip>` 子元素 */
function parseEquipmentXML(xml: string): ItemGenOutput['equipment'] {
  const matches = xml.matchAll(/<equip\s+([^>]*?)>([\s\S]*?)<\/equip>/g);
  const results: ItemGenOutput['equipment'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const statsStr = attrs['stats'] ?? '';
    const stats: Record<string, number> = {};
    for (const pair of statsStr.split(',')) {
      const [k, v] = pair.split(':').map((s) => s.trim());
      if (k && v) stats[k] = parseFloat(v) || 0;
    }
    const effects = parseNamedChildren(innerContent, 'effect');
    const qualityRaw = attrs['quality'];
    const tags = collectItemTags(innerContent);

    results.push({
      slot: attrs['slot'] ?? '饰品',
      name: attrs['name'] ?? '未命名装备',
      description: extractDescription(innerContent),
      stats,
      durability: attrs['durability'] ? parseInt(attrs['durability']) : undefined,
      quality: qualityRaw && qualityRaw !== '?' ? qualityRaw : undefined,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(innerContent ? { protocolText: innerContent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

/** 解析 `<inventory>` 块内的 `<item>` 子元素 */
function parseInventoryXML(xml: string): ItemGenOutput['inventory'] {
  const matches = xml.matchAll(/<item\s+([^>]*?)>([\s\S]*?)<\/item>/g);
  const results: ItemGenOutput['inventory'] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const effects = parseNamedChildren(innerContent, 'effect');
    const rarityRaw = attrs['rarity'];
    const tags = collectItemTags(innerContent);

    results.push({
      name: attrs['name'] ?? '未命名物品',
      description: extractDescription(innerContent),
      quantity: parseInt(attrs['quantity'] ?? '1') || 1,
      type: attrs['type'] ?? '消耗品',
      rarity: rarityRaw && rarityRaw !== '?' ? rarityRaw : undefined,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(innerContent ? { protocolText: innerContent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(attrs['replace'] ? { replace: attrs['replace'] } : {}),
    });
  }
  return results;
}

// ========== 状态 ==========

/**
 * 解析 `<statuses>` 块内的 `<status>` 子元素。
 *
 * `<status name category stacks remainingTime timeUnit>效果文本<effect name=…/><tag/></status>`。
 * `effect` 子元素内容进 effects/effectDescriptions；`<tag>` 进 tags；`protocolText` = 原样内文。
 */
export function parseStatusesXML(xml: string): EntityStatusOutput[] {
  const matches = xml.matchAll(/<status\s+([^>]*?)>([\s\S]*?)<\/status>/g);
  const results: EntityStatusOutput[] = [];
  for (const m of matches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const effects = parseNamedChildren(innerContent, 'effect');
    const categoryRaw = (attrs['category'] ?? '').trim();
    const category: EntityStatusOutput['category'] =
      categoryRaw === '增益' || categoryRaw === '特殊' ? categoryRaw : '减益';
    const timeUnitRaw = (attrs['timeUnit'] ?? '').trim();
    const timeUnit: EntityStatusOutput['timeUnit'] =
      timeUnitRaw === '分钟' || timeUnitRaw === '小时' ? timeUnitRaw : '回合';
    const tags = collectItemTags(innerContent);

    results.push({
      owner: attrs['owner'] ?? '',
      name: attrs['name'] ?? '未命名状态',
      category,
      description: extractDescription(innerContent),
      stacks: parseInt(attrs['stacks'] ?? '1', 10) || 1,
      maxStacks: parseInt(attrs['maxStacks'] ?? attrs['stacks'] ?? '1', 10) || 1,
      remainingTime: parseInt(attrs['remainingTime'] ?? '60', 10) || 60,
      timeUnit,
      ...(Object.keys(effects).length > 0 ? { effects, effectDescriptions: { ...effects } } : {}),
      ...(innerContent ? { protocolText: innerContent } : {}),
      ...(tags.length > 0 ? { tags } : {}),
    });
  }
  return results;
}

/**
 * 解析 vars_update 输出的 `<status_effects>` 块内的 `<effect>` 子元素。
 *
 * 🔴 与 entity_gen 的 `<status>` 是**两种形状**（此处是 vars_update 的既有契约：
 *    `<effect owner name category stacks remainingTime timeUnit>描述<effect name/></effect>`），
 *    别把两个合并 —— 既有流程仍在用。
 */
export function parseStatusEffectsXML(xmlBody: string): Array<{
  owner: string;
  name: string;
  category: '增益' | '减益' | '特殊';
  description: string;
  stacks: number;
  maxStacks: number;
  remainingTime: number;
  timeUnit: '回合' | '分钟' | '小时';
  effects?: Record<string, string>;
  effectDescriptions?: Record<string, string>;
}> {
  const results: any[] = [];
  const effectRegex =
    /<effect\s+([^>]*)>([\s\S]*?)((?:<effect\b[^>]*>[\s\S]*?<\/effect>\s*)*)(?:(?:<script\b[^>]*>[\s\S]*?<\/script>)\s*)*<\/effect>/gi;
  let match: RegExpExecArray | null;

  while ((match = effectRegex.exec(xmlBody)) !== null) {
    const attrsStr = match[1].trim();
    const description = match[2].trim();
    const innerEffectsBlock = match[3];

    const attrs = parseAttrsStr(attrsStr);
    const owner = attrs.owner || '';
    const name = attrs.name || '';
    const category = (attrs.category as '增益' | '减益' | '特殊') || '减益';
    const stacks = parseInt(attrs.stacks || '1', 10);
    const maxStacks = parseInt(attrs.maxStacks || attrs.stacks || '1', 10);
    const remainingTime = parseInt(attrs.remainingTime || '60', 10);
    const timeUnit = (attrs.timeUnit as '回合' | '分钟' | '小时') || '回合';

    const effects: Record<string, string> = {};
    const effectDescriptions: Record<string, string> = {};
    if (innerEffectsBlock) {
      const innerRegex = /<effect\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/effect>/gi;
      let innerMatch: RegExpExecArray | null;

      while ((innerMatch = innerRegex.exec(innerEffectsBlock)) !== null) {
        const efName = innerMatch[1].trim();
        const efDesc = innerMatch[2].trim();
        effects[efName] = efDesc;
        effectDescriptions[efName] = efDesc;
      }
    }

    results.push({
      owner,
      name,
      category,
      description,
      stacks,
      maxStacks,
      remainingTime,
      timeUnit,
      ...(Object.keys(effects).length > 0 ? { effects } : {}),
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
    });
  }

  return results;
}

// ========== 角色 ==========

/**
 * 从 `<personality>` 提取落库文本，兼容两种输出形态（2026-08-08）。
 *
 * 提示词与工具返回的性格编码（如 `wOaGz(A)`）是角色的**既定属性**，落库必须保留；
 * 两种形态：内文含 code（推荐）/ 属性 `code=`（旧格式，拼接保编码）。
 */
export function extractPersonalityText(xml: string): string {
  const inner = stripInnerTags(tagInner(xml, 'personality') ?? '');
  const code = tagAttr(xml, 'personality', 'code');
  if (!code) return inner;
  if (!inner) return code;
  const codePrefix = `${code}+`;
  return inner.startsWith(codePrefix) ? inner : `${codePrefix}${inner}`;
}

/**
 * 解析 `<ascension>` 块（要素/权能/法则/神位/神国）。
 *
 * `ascInner` 是标签**内文**（子元素），`source` 是含开标签的**外层**文本 ——
 * `enabled`/`path`/`description` 三个属性住在开标签上，必须从 source 取。
 */
function parseAscensionXML(ascXML: string, source: string): CharGenOutput['ascension'] {
  const ascElements: CharGenOutput['ascension']['elements'] = [];
  const ascAuthorities: CharGenOutput['ascension']['authorities'] = [];
  const ascLaws: CharGenOutput['ascension']['laws'] = [];

  const elMatches = ascXML.matchAll(/<element\b([^>]*?)>([\s\S]*?)<\/element>/g);
  for (const m of elMatches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const effectDescriptions = parseNamedChildren(innerContent, 'effect');
    ascElements.push({
      name: attrs['name'] ?? '',
      description: attrs['description'] ?? '',
      effects: innerContent
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('<')),
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
    });
  }
  const auMatches = ascXML.matchAll(/<authority\b([^>]*?)>([\s\S]*?)<\/authority>/g);
  for (const m of auMatches) {
    const attrs = parseAttrsStr(m[1]);
    const innerContent = m[2]?.trim() ?? '';
    const effectDescriptions = parseNamedChildren(innerContent, 'effect');
    ascAuthorities.push({
      name: attrs['name'] ?? '',
      description: attrs['description'] ?? '',
      effects: innerContent
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('<')),
      costDescription: attrs['cost'] ?? '',
      ...(Object.keys(effectDescriptions).length > 0 ? { effectDescriptions } : {}),
    });
  }
  const lawMatches = ascXML.matchAll(/<law\b([^>]*?)>([\s\S]*?)<\/law>/g);
  for (const m of lawMatches) {
    const attrs = parseAttrsStr(m[1]);
    ascLaws.push({
      name: attrs['name'] ?? '',
      description: attrs['description'] ?? '',
      passiveEffects:
        attrs['passive']
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      activeEffects:
        attrs['active']
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [],
      costDescription: attrs['cost'] ?? '',
    });
  }

  return {
    enabled: (tagAttr(source, 'ascension', 'enabled') ?? 'false') === 'true',
    path: tagAttr(source, 'ascension', 'path') ?? '',
    description: tagAttr(source, 'ascension', 'description') ?? '',
    elements: ascElements,
    authorities: ascAuthorities,
    laws: ascLaws,
    deityPosition: tagInner(ascXML, 'deity_position') ?? '',
    divineKingdom: (() => {
      const kdXML = tagInner(ascXML, 'kingdom');
      return {
        name: kdXML ? (tagAttr(kdXML, 'kingdom', 'name') ?? tagInner(kdXML, 'name') ?? '') : '',
        description: kdXML
          ? (tagAttr(kdXML, 'kingdom', 'description') ?? tagInner(kdXML, 'description') ?? '')
          : '',
      };
    })(),
  };
}

/** 解析角色块内容（`<character>` 或旧 `<char_result>`）—— 内嵌技能/装备/道具/登神 */
function parseCharacterBody(xml: string): CharGenOutput {
  const ascXML = tagInner(xml, 'ascension');
  const ascension = ascXML ? parseAscensionXML(ascXML, xml) : emptyAscension();

  const skillsXML = tagInner(xml, 'skills');
  const equipmentXML = tagInner(xml, 'equipment');
  const inventoryXML = tagInner(xml, 'inventory');

  return {
    name: tagInner(xml, 'name') ?? '未命名',
    race: tagInner(xml, 'race') ?? '人类',
    gender: tagInner(xml, 'gender') ?? '其他',
    faction: tagInner(xml, 'faction') ?? undefined,
    tier: parseInt(tagInner(xml, 'tier') ?? '1') || 1,
    level: parseInt(tagInner(xml, 'level') ?? '1') || 1,
    attributes: {
      str: tagAttrInt(xml, 'attributes', 'str', 10),
      dex: tagAttrInt(xml, 'attributes', 'dex', 10),
      con: tagAttrInt(xml, 'attributes', 'con', 10),
      int: tagAttrInt(xml, 'attributes', 'int', 10),
      spi: tagAttrInt(xml, 'attributes', 'spi', 10),
    },
    identity:
      tagInner(xml, 'identity')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    occupation:
      tagInner(xml, 'occupation')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [],
    background: stripInnerTags(tagInner(xml, 'background') ?? ''),
    appearance: stripInnerTags(tagInner(xml, 'appearance') ?? ''),
    clothing: stripInnerTags(tagInner(xml, 'clothing') ?? ''),
    personality: extractPersonalityText(xml),
    likes: stripInnerTags(tagInner(xml, 'likes') ?? ''),
    thoughts: stripInnerTags(tagInner(xml, 'thoughts') ?? ''),
    ascension,
    skills: skillsXML ? parseSkillsXML(skillsXML) : [],
    equipment: equipmentXML ? parseEquipmentXML(equipmentXML) : [],
    inventory: inventoryXML ? parseInventoryXML(inventoryXML) : [],
  };
}

function emptyAscension(): CharGenOutput['ascension'] {
  return {
    enabled: false,
    path: '',
    description: '',
    elements: [],
    authorities: [],
    laws: [],
    deityPosition: '',
    divineKingdom: { name: '', description: '' },
  };
}

// ========== 顶层入口 ==========

/** 解析 `<entity_result>` XML 块 */
function parseEntityResultXML(xml: string): EntityGenOutput {
  const out = emptyEntityGenOutput();

  const charBlock = tagBlock(xml, 'character');
  if (charBlock) {
    out.character = parseCharacterBody(tagInner(charBlock, 'character') ?? charBlock);
    // 角色块自带 skills/equipment/inventory/ascension —— 从顶层扫描时须先移除它，
    // 否则 tagInner(xml,'skills') 会命中的是角色**内嵌**的那一份（重复落库）。
    xml = xml.replace(charBlock, '');
  }

  const skillsXML = tagInner(xml, 'skills');
  const equipmentXML = tagInner(xml, 'equipment');
  const inventoryXML = tagInner(xml, 'inventory');
  const statusesXML = tagInner(xml, 'statuses');
  const ascXML = tagInner(xml, 'ascension');

  if (skillsXML) out.skills = parseSkillsXML(skillsXML);
  if (equipmentXML) out.equipment = parseEquipmentXML(equipmentXML);
  if (inventoryXML) out.inventory = parseInventoryXML(inventoryXML);
  if (statusesXML) out.statuses = parseStatusesXML(statusesXML);
  if (ascXML && !out.character) out.ascension = parseAscensionXML(ascXML, xml);

  return out;
}

/**
 * entity_gen 输出解析主入口。
 *
 * 1. `<entity_result>` XML
 * 2. JSON 兜底（分组形状 / 单对象 / 数组）
 * 3. 全失败 → 空输出（调用方决定跳过还是上浮）
 */
export function parseEntityGenOutput(raw: string): EntityGenOutput {
  const xml = tagBlock(raw, 'entity_result');
  if (xml) {
    const parsed = parseEntityResultXML(xml);
    if (
      parsed.character ||
      parsed.skills.length > 0 ||
      parsed.equipment.length > 0 ||
      parsed.inventory.length > 0 ||
      (parsed.statuses?.length ?? 0) > 0 ||
      parsed.ascension
    ) {
      // 角色块可能是 JSON 直出（AI 无视 XML 教学）—— name 兜底为「未命名」时尝试 JSON
      if (
        parsed.character &&
        (parsed.character.name === '未命名' || parsed.character.name.startsWith('未命名'))
      ) {
        const fallback = parseEntityJSONLoose(raw);
        if (fallback?.character) return fallback;
      }
      return parsed;
    }
    const fallback = parseEntityJSONLoose(xml);
    if (fallback) return fallback;
    return parsed;
  }

  return parseEntityJSONLoose(raw) ?? emptyEntityGenOutput();
}

/** JSON 宽容归一 —— 分组形状 / 单对象 / 数组，永不抛（认不出返回 null） */
function parseEntityJSONLoose(text: string): EntityGenOutput | null {
  const json = extractJsonOrRaw(text);
  if (!json) return null;
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const out = emptyEntityGenOutput();

  // 已分组形状
  if (Array.isArray(data.skills)) out.skills = data.skills;
  if (Array.isArray(data.equipment)) out.equipment = data.equipment;
  if (Array.isArray(data.inventory)) out.inventory = data.inventory;
  if (Array.isArray(data.statuses)) out.statuses = data.statuses;

  const charSource = data.character ?? (data.name ? data : undefined);
  if (charSource && charSource.name) {
    out.character = charGenFromJSON(charSource);
  }

  const hasAny =
    out.character ||
    out.skills.length > 0 ||
    out.equipment.length > 0 ||
    out.inventory.length > 0 ||
    (out.statuses?.length ?? 0) > 0;
  return hasAny ? out : null;
}

/** JSON 对象 → CharGenOutput（保留既有的宽容归一语义） */
function charGenFromJSON(data: any): CharGenOutput {
  const attrs: Record<string, number> = {};
  if (data.attributes && typeof data.attributes === 'object') {
    for (const k of ['str', 'dex', 'con', 'int', 'spi']) {
      attrs[k] =
        typeof data.attributes[k] === 'number'
          ? data.attributes[k]
          : parseInt(data.attributes[k]) || 0;
    }
  }
  if (!Object.keys(attrs).length) {
    for (const k of ['str', 'dex', 'con', 'int', 'spi']) attrs[k] = 10;
  }

  const appearance = data.appearance;
  const personality = data.personality;

  return {
    name: data.name,
    race: data.race ?? '人类',
    gender: data.gender,
    faction: data.faction,
    tier: typeof data.tier === 'number' ? data.tier : 1,
    level: typeof data.level === 'number' ? data.level : 1,
    attributes: {
      str: attrs.str,
      dex: attrs.dex,
      con: attrs.con,
      int: attrs.int,
      spi: attrs.spi,
    },
    identity: Array.isArray(data.identity)
      ? data.identity
      : typeof data.identity === 'string'
        ? [data.identity]
        : [],
    occupation: Array.isArray(data.occupation)
      ? data.occupation
      : typeof data.occupation === 'string'
        ? [data.occupation]
        : [],
    background: data.background ?? data.lore?.origin ?? data.description ?? '',
    appearance:
      typeof appearance === 'object' && appearance
        ? (appearance.summary ?? appearance.description ?? JSON.stringify(appearance))
        : typeof appearance === 'string'
          ? appearance
          : '',
    clothing: data.clothing ?? data.outfit ?? '',
    personality:
      typeof personality === 'object' && personality
        ? (personality.summary ?? personality.description ?? JSON.stringify(personality))
        : typeof personality === 'string'
          ? personality
          : '',
    likes: data.likes ?? '',
    thoughts: data.thoughts ?? '',
    ascension: data.ascension ?? emptyAscension(),
    skills: Array.isArray(data.skills) ? data.skills : [],
    equipment: Array.isArray(data.equipment) ? data.equipment : [],
    inventory: Array.isArray(data.inventory) ? data.inventory : [],
  };
}
