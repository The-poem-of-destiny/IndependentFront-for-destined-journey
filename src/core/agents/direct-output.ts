import type {
  CharacterState,
  EntityGenOutput,
  EntityStatusOutput,
  StatePatch,
  StoryStage,
} from '../types/types';
import type { CharacterDefinition, CharacterNarrativeUpdate } from '../types/types-character';
import { isRecord, parseCharacterUpdates } from '../character/character-updates';
import {
  assembleCharacterState,
  bindGeneratedCharacter,
  buildEntityGenPatches,
  buildRewritePatches,
} from './entity-gen-agent';
import {
  buildDispatcherPatches,
  buildQuestPatches,
  buildVarsUpdatePatches,
} from '../variables/vars-update-translator';
import { projectStoryOutput, STORY_ENVELOPE_TAGS } from '../story/story-output';
import type { DirectCombatOutput } from '../combat/direct-combat';
import type { DirectDicePool } from './direct-dice';

type Row = Record<string, unknown>;
export interface DirectUpdates {
  version: 1;
  world: Row;
  time: { delta_time: number };
  entities: Array<
    | {
        kind: 'character';
        placement: { location: string; present: boolean };
        output: EntityGenOutput;
      }
    | { kind: 'loadout'; owner: string; output: EntityGenOutput }
  >;
  state: Row;
  effects: Array<{
    owner: string;
    action: 'add' | 'update' | 'remove';
    value: Partial<EntityStatusOutput> & { name: string };
  }>;
  plot: { pre?: Row; post?: Row };
  combat: DirectCombatOutput | null;
  /** 按 (骰面数, 组内下标) 定位骰池里的一颗骰 */
  diceUsed: Array<{ sides: number; index: number; purpose: string; target: string }>;
}

export interface DirectTurnDraft {
  content: string;
  options: string[];
  /** 正文分节（来自 projectStoryOutput；模型没写 `<beat/>` 时缺席） */
  stage?: StoryStage;
  characterUpdates: CharacterNarrativeUpdate[];
  updates: DirectUpdates;
  raw: string;
  /** 结构化战斗关闭时模型仍写了非 null 的 combat：已丢弃，仅供告警 */
  combatIgnored?: true;
  /** 模型把人物字段平铺在 entities[i].output 上（未放进 output.character）：已自动归位，仅供告警 */
  flattenedCharacters?: string[];
}

export interface ParseDirectOutputOptions {
  /** 是否启用结构化战斗；缺省 true（严格校验 combat 区块） */
  structuredCombat?: boolean;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`直出结果无效：${message}`);
}

function object(value: unknown, label: string): Row {
  check(isRecord(value), `${label} 必须是对象`);
  return value;
}

/** 报错里最多列出的多余键数 */
const MAX_LISTED_KEYS = 5;
/** 单个键名在报错里的最大长度，超出截断加「…」 */
const MAX_KEY_LENGTH = 24;

function keys(value: Row, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length === 0) return;
  const listed = extra
    .slice(0, MAX_LISTED_KEYS)
    .map((key) => {
      // 按码点截断，避免切开代理对留下孤立代理项
      const chars = Array.from(key);
      return chars.length > MAX_KEY_LENGTH ? `${chars.slice(0, MAX_KEY_LENGTH).join('')}…` : key;
    })
    .join('、');
  const more = extra.length > MAX_LISTED_KEYS ? ` 等 ${extra.length} 个` : '';
  check(false, `${label} 含未支持的字段：${listed}${more}`);
}

function named(value: unknown): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0, '名字／引用不能为空');
}

function rows(value: unknown, label: string): Row[] {
  check(Array.isArray(value), `${label} 必须是数组`);
  return value.map((row) => object(row, label));
}

function safeValues(value: unknown): void {
  if (typeof value === 'number') check(Number.isFinite(value), '数值必须有限');
  if (Array.isArray(value)) value.forEach(safeValues);
  else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      check(
        ![
          '__proto__',
          'prototype',
          'constructor',
          'id',
          'saveId',
          'introducedBy',
          'definition',
        ].includes(key),
        `不允许模型填写 ${key}`,
      );
      safeValues(child);
    }
  }
}

function validateEntity(value: unknown, character: boolean, label: string): void {
  const output = object(value, label);
  keys(
    output,
    [
      'character',
      'skills',
      'equipment',
      'inventory',
      'statuses',
      'ascension',
      'elements',
      'authorities',
    ],
    label,
  );
  for (const key of ['skills', 'equipment', 'inventory']) {
    for (const item of rows(output[key], `${label}.${key}`)) {
      named(item.name);
      check(typeof item.description === 'string', `${label}.${key} 缺少 description`);
      if (key === 'inventory')
        check(Number.isInteger(item.quantity) && Number(item.quantity) > 0, '物品数量必须为正整数');
      if (key === 'equipment') {
        named(item.slot);
        object(item.stats, '装备属性');
      }
      if (item.tags !== undefined)
        check(
          Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string'),
          'tags 必须是文本数组',
        );
      if (item.protocolText !== undefined)
        check(typeof item.protocolText === 'string', 'protocolText 必须是文本');
    }
  }
  if (character) {
    const c = object(output.character, '人物');
    named(c.name);
    check(Number.isInteger(c.tier) && Number(c.tier) >= 1 && Number(c.tier) <= 7, '人物层级无效');
    check(
      Number.isInteger(c.level) && Number(c.level) >= 1 && Number(c.level) <= 25,
      '人物等级无效',
    );
    const attrs = object(c.attributes, '人物属性');
    for (const attr of ['str', 'dex', 'con', 'int', 'spi'])
      check(typeof attrs[attr] === 'number' && Number(attrs[attr]) >= 0, `缺少属性 ${attr}`);
    for (const key of [
      'race',
      'gender',
      'background',
      'appearance',
      'clothing',
      'personality',
      'likes',
    ])
      check(typeof c[key] === 'string', `人物缺少 ${key}`);
    for (const key of ['identity', 'occupation'])
      check(Array.isArray(c[key]) && c[key].every((v) => typeof v === 'string'), `人物缺少 ${key}`);
    validateEntity(
      { skills: c.skills, equipment: c.equipment, inventory: c.inventory },
      false,
      `${label}.character`,
    );
    const ascension = object(c.ascension, '登神状态');
    check(
      typeof ascension.enabled === 'boolean' &&
        typeof ascension.path === 'string' &&
        typeof ascension.description === 'string',
      '登神状态不完整',
    );
    for (const key of ['elements', 'authorities', 'laws']) rows(ascension[key], `ascension.${key}`);
  } else check(output.character === undefined, '归属物不能再次创建人物');
  for (const status of rows(output.statuses ?? [], `${label}.statuses`)) {
    named(status.name);
    named(status.owner);
  }
}

const CHARACTER_FIELDS = [
  'hp',
  'mp',
  'sp',
  'location',
  'present',
  'currentAction',
  'thoughts',
  'money',
  'totalExp',
];

function validateState(value: Row): void {
  keys(value, ['characters', 'items', 'affections', 'fp', 'quests'], 'state');
  const chars = object(value.characters ?? {}, 'state.characters');
  keys(chars, ['replace', 'delta', 'remove'], 'state.characters');
  const owned = new Set<string>();
  for (const operation of ['replace', 'delta', 'remove']) {
    for (const row of rows(chars[operation] ?? [], operation)) {
      named(row.name);
      const key = `${row.name}/${row.path}/${operation === 'remove' ? row.target : ''}`;
      check(!owned.has(key), '人物字段重复声明');
      owned.add(key);
      if (operation === 'remove') {
        check(['skills', 'equipment'].includes(String(row.path)), '状态效果由 effects 唯一声明');
        named(row.target);
      } else {
        check(CHARACTER_FIELDS.includes(String(row.path)), '人物字段不属于 direct state 白名单');
        if (operation === 'delta')
          check(
            ['hp', 'mp', 'sp', 'money', 'totalExp'].includes(String(row.path)) &&
              typeof row.amount === 'number',
            'delta 只能用于资源／金钱／经验',
          );
        else if (row.path === 'present')
          check(typeof row.value === 'boolean', 'present 必须是布尔值');
        else if (['hp', 'mp', 'sp', 'money', 'totalExp'].includes(String(row.path)))
          check(typeof row.value === 'number' && Number(row.value) >= 0, '资源值无效');
        else check(typeof row.value === 'string', '人物字段必须为文本');
      }
    }
  }
  const items = object(value.items ?? {}, 'state.items');
  keys(items, ['consume', 'equip', 'unequip', 'transfer', 'modify'], 'state.items');
  for (const [op, list] of Object.entries(items))
    for (const row of rows(list, op)) {
      named(row.target);
      named(op === 'transfer' ? row.from : row.owner);
      if (op === 'transfer') named(row.to);
      if (op === 'consume' || op === 'transfer')
        check(
          Number.isInteger(row.quantity) && Number(row.quantity) > 0,
          '消耗／转移数量必须为正整数',
        );
      if (op === 'equip') named(row.slot);
      if (op === 'modify') {
        const changes = object(row.changes, '物品修改');
        keys(
          changes,
          [
            'description',
            'type',
            'rarity',
            'stats',
            'durability',
            'maxDurability',
            'effects',
            'protocolText',
            'tags',
          ],
          '物品修改',
        );
      }
    }
  const affections = object(value.affections ?? {}, '好感度');
  keys(affections, ['set', 'delta'], '好感度');
  for (const [op, list] of Object.entries(affections))
    for (const row of rows(list, op)) {
      named(row.name);
      check(typeof row[op === 'set' ? 'value' : 'amount'] === 'number', '好感度必须为数值');
    }
  if (value.fp !== undefined) {
    const fp = object(value.fp, 'fp');
    keys(fp, ['delta'], 'fp');
    check(typeof fp.delta === 'number', 'fp.delta 必须为数值');
  }
  const quests = object(value.quests ?? {}, 'quests');
  keys(quests, ['upsert', 'remove'], 'quests');
  for (const list of Object.values(quests)) for (const row of rows(list, 'quests')) named(row.name);
}

/** 实体外层（非人物）字段；平铺人物归位时留在 output 顶层 */
const ENTITY_OUTER_KEYS = ['statuses', 'elements', 'authorities'];

/**
 * 模型常把人物字段直接平铺在 output 上（name、race… 与 skills/equipment/inventory/ascension 同层），
 * 而不是放进 output.character。识别到这种形状时把人物字段（含随身技能/装备/背包/登神）
 * 收进 output.character，顶层 skills/equipment/inventory 置空 —— 与规范嵌套形状
 * 经 assembleCharacterState 组装出的人物一致。返回归位的人物名；不是平铺形状返回 undefined。
 */
function unflattenCharacterEntity(row: Row): string | undefined {
  if (row.kind !== 'character' || !isRecord(row.output)) return undefined;
  const output = row.output;
  if (output.character !== undefined || typeof output.name !== 'string') return undefined;
  const character: Row = {};
  const outer: Row = {};
  for (const [key, value] of Object.entries(output))
    (ENTITY_OUTER_KEYS.includes(key) ? outer : character)[key] = value;
  row.output = { ...outer, character, skills: [], equipment: [], inventory: [] };
  return output.name;
}

export function parseDirectOutput(
  raw: string,
  pool: DirectDicePool,
  options: ParseDirectOutputOptions = {},
): DirectTurnDraft {
  const structuredCombat = options.structuredCombat ?? true;
  const blocks = [...raw.matchAll(/<direct_updates\s*>([\s\S]*?)<\/direct_updates\s*>/gi)];
  check(
    blocks.length === 1 && [...raw.matchAll(/<direct_updates\b/gi)].length === 1,
    '需要一个完整的 direct_updates 区块',
  );
  // 正文信封认 maintext 与同义的 gametxt：每种开标签至多一个、至少出现一种，
  // 出现的那几种都要有对应闭标签（单 maintext / 单 gametxt / 两种各一嵌套或并列均可）
  const envelopeCounts = STORY_ENVELOPE_TAGS.map((tag) => ({
    tag,
    opens: [...raw.matchAll(new RegExp(String.raw`<${tag}\b`, 'gi'))].length,
  }));
  check(
    envelopeCounts.some(({ opens }) => opens > 0) &&
      envelopeCounts.every(
        ({ tag, opens }) =>
          opens === 0 || (opens === 1 && new RegExp(String.raw`<\/${tag}\s*>`, 'i').test(raw)),
      ),
    '需要一个完整的 maintext（或 gametxt）区块',
  );
  let json: unknown;
  try {
    json = JSON.parse(blocks[0][1]);
  } catch (error) {
    check(
      false,
      `direct_updates 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const parsed = object(json, 'direct_updates');
  // 结构化战斗关闭：combat 区块一律丢弃（不校验、不要求存在），只记下模型是否写了非 null 内容
  let combatIgnored = false;
  if (!structuredCombat) {
    combatIgnored =
      Object.prototype.hasOwnProperty.call(parsed, 'combat') &&
      parsed.combat !== null &&
      parsed.combat !== undefined;
    delete parsed.combat;
  }
  safeValues(parsed);
  const sections = [
    'version',
    'world',
    'time',
    'entities',
    'state',
    'effects',
    'plot',
    ...(structuredCombat ? ['combat'] : []),
    'diceUsed',
  ];
  keys(parsed, sections, 'direct_updates');
  check(
    sections.every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) &&
      parsed.version === 1,
    'v1 分区不完整',
  );
  if (!structuredCombat) parsed.combat = null;
  const time = object(parsed.time, 'time');
  keys(time, ['delta_time'], 'time');
  check(typeof time.delta_time === 'number' && time.delta_time >= 0, 'delta_time 必须是非负分钟数');
  const world = object(parsed.world, 'world');
  keys(world, ['replace', 'insert', 'tile_ops'], 'world');
  for (const op of ['replace', 'insert'])
    for (const row of rows(world[op] ?? [], op)) {
      named(row.path);
      check(
        !/(^|\.)(__proto__|prototype|constructor|gameTime|worldFlags|directCombat|generationMode|profile|characters|fp)(\.|$)/.test(
          row.path,
        ),
        'world 不能写系统状态',
      );
    }
  const tiles = rows(world.tile_ops ?? [], 'tile_ops');
  check(
    buildDispatcherPatches({ tile_ops: tiles }).patches.length === tiles.length,
    '地块操作无效',
  );
  const flattenedCharacters: string[] = [];
  for (const [i, row] of rows(parsed.entities, 'entities').entries()) {
    check(row.kind === 'character' || row.kind === 'loadout', '实体种类无效');
    const flattened = unflattenCharacterEntity(row);
    if (flattened !== undefined) flattenedCharacters.push(flattened);
    keys(
      row,
      row.kind === 'character' ? ['kind', 'placement', 'output'] : ['kind', 'owner', 'output'],
      `entities[${i}]`,
    );
    validateEntity(row.output, row.kind === 'character', `entities[${i}].output`);
    if (row.kind === 'loadout') named(row.owner);
    else {
      const placement = object(row.placement, 'placement');
      named(placement.location);
      check(typeof placement.present === 'boolean', 'placement.present 缺失');
    }
  }
  validateState(object(parsed.state, 'state'));
  for (const effect of rows(parsed.effects, 'effects')) {
    keys(effect, ['owner', 'action', 'value'], 'effects');
    named(effect.owner);
    check(['add', 'update', 'remove'].includes(String(effect.action)), '效果动作无效');
    const value = object(effect.value, '效果');
    named(value.name);
    if (effect.action === 'add') {
      check(
        typeof value.description === 'string' &&
          ['增益', '减益', '特殊'].includes(String(value.category)),
        '效果缺少描述／分类',
      );
      check(typeof value.stacks === 'number' && value.stacks > 0, '效果层数无效');
      check(
        value.remainingTime === null ||
          (typeof value.remainingTime === 'number' && value.remainingTime >= 0),
        '效果时长无效',
      );
      check(['回合', '分钟', '小时'].includes(String(value.timeUnit)), '效果时间单位无效');
    }
    if (effect.action === 'update') keys(value, ['name', 'remainingTime', 'stacks'], '效果更新');
    if (effect.action === 'remove') keys(value, ['name'], '效果移除');
  }
  const effectOwners = new Set<string>();
  for (const entity of parsed.entities as DirectUpdates['entities'])
    for (const effect of entity.output.statuses ?? []) {
      const owner = entity.kind === 'character' ? entity.output.character!.name : entity.owner;
      check(effect.owner === owner, '实体初始状态的归属错误');
      const key = `${owner}/${effect.name}`;
      check(!effectOwners.has(key), '状态效果重复声明');
      effectOwners.add(key);
    }
  for (const effect of parsed.effects as DirectUpdates['effects']) {
    const key = `${effect.owner}/${effect.value.name}`;
    check(!effectOwners.has(key), '状态效果重复声明');
    effectOwners.add(key);
  }
  const plot = object(parsed.plot, 'plot');
  keys(plot, ['pre', 'post'], 'plot');
  for (const value of Object.values(plot)) object(value, '剧情判断');
  if (parsed.combat !== null) object(parsed.combat, 'combat');
  const consumed = new Set<string>();
  for (const [i, die] of rows(parsed.diceUsed, 'diceUsed').entries()) {
    const label = `diceUsed[${i}]`;
    const group = Number.isInteger(die.sides) ? pool.find((g) => g.sides === die.sides) : undefined;
    check(group, `${label} 的骰面数不在骰池中`);
    check(
      Number.isInteger(die.index) &&
        Number(die.index) >= 0 &&
        Number(die.index) < group.values.length,
      `${label} 的骰索引超出 d${group.sides} 骰组范围`,
    );
    const key = `${group.sides}/${Number(die.index)}`;
    check(!consumed.has(key), `${label} 重复使用了同一颗骰`);
    named(die.purpose);
    named(die.target);
    consumed.add(key);
  }
  const character = parseCharacterUpdates(raw);
  check(
    character.present && character.warnings.length === 0,
    character.warnings.join('；') || '缺少 character_updates',
  );
  const projection = projectStoryOutput(raw);
  check(projection.content.length > 0, '正文为空');
  return {
    ...projection,
    raw,
    characterUpdates: character.updates,
    updates: parsed as unknown as DirectUpdates,
    ...(combatIgnored ? { combatIgnored: true as const } : {}),
    ...(flattenedCharacters.length > 0 ? { flattenedCharacters } : {}),
  };
}

export function buildDirectPatches(
  draft: DirectTurnDraft,
  input: {
    characters: CharacterState[];
    definitions: CharacterDefinition[];
    sourceTurnKey: string;
  },
): { patches: StatePatch[]; characters: CharacterState[] } {
  const characters = [...input.characters];
  const patches: StatePatch[] = [];
  for (const entity of draft.updates.entities) {
    if (entity.kind !== 'character') continue;
    const narrativeCharacter = draft.characterUpdates.find(
      (update) => update.name === entity.output.character!.name,
    );
    const definition = input.definitions.find(
      (d) =>
        d.name === entity.output.character!.name ||
        d.profile.aliases?.includes(entity.output.character!.name),
    );
    const character = assembleCharacterState(entity.output, entity.placement);
    bindGeneratedCharacter(character, {
      narrativeCharacter,
      characterDefinition: definition,
      introducedBy: input.sourceTurnKey,
    });
    check(!characters.some((c) => c.name === character.name), `人物 ${character.name} 已存在`);
    characters.push(character);
    patches.push({ op: 'add_character', target: `characters.${character.name}`, value: character });
  }
  for (const update of draft.characterUpdates)
    check(
      characters.some((c) => c.name === update.name || c.aliases?.includes(update.name)),
      `人物 ${update.name} 缺少完整实体`,
    );
  for (const entity of draft.updates.entities) {
    if (entity.kind !== 'loadout') continue;
    check(
      characters.some((c) => c.name === entity.owner),
      `物品归属人物 ${entity.owner} 不存在`,
    );
    const output = entity.output;
    const replacements = [...output.skills, ...output.equipment, ...output.inventory].filter(
      (item) => item.replace,
    );
    const generated = buildEntityGenPatches(
      {
        ...output,
        skills: output.skills.filter((item) => !item.replace),
        equipment: output.equipment.filter((item) => !item.replace),
        inventory: output.inventory.filter((item) => !item.replace),
      },
      entity.owner,
    );
    for (const item of replacements) {
      const rewritten = buildRewritePatches(output, entity.owner, item.replace!);
      check(rewritten.ok, rewritten.reason ?? '替换目标无效');
      generated.push(...rewritten.patches);
    }
    // Acquisition does not equip. Explicit state.items.equip passes the normal slot checks.
    for (const patch of generated)
      if (patch.op === 'add_item') (patch.value as Record<string, unknown>).equippedSlot = null;
    patches.push(...generated);
  }
  patches.push(...buildDispatcherPatches(draft.updates.world).patches);
  patches.push(...buildVarsUpdatePatches(draft.updates.state));
  if (draft.updates.state.quests)
    patches.push(...buildQuestPatches(draft.updates.state.quests as Row));
  for (const effect of draft.updates.effects)
    patches.push({
      op:
        effect.action === 'add'
          ? 'add_status_effect'
          : effect.action === 'update'
            ? 'update_status_effect'
            : 'remove_status_effect',
      target: `characters.${effect.owner}`,
      value: effect.value,
    });
  for (const patch of patches) {
    if (patch.target.startsWith('characters.'))
      check(
        characters.some((c) => `characters.${c.name}` === patch.target),
        `引用的人物不存在：${patch.target}`,
      );
    if (patch.op === 'add_status_effect') {
      const value = patch.value as EntityStatusOutput;
      if (value.effects)
        patch.value = {
          ...value,
          effects: {},
          effectDescriptions: value.effectDescriptions ?? value.effects,
        };
    }
  }
  return { patches, characters };
}
