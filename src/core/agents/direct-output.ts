import type {
  CharacterState,
  EntityGenOutput,
  EntityStatusOutput,
  StatePatch,
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
import { projectStoryOutput } from '../story/story-output';
import type { DirectCombatOutput } from '../combat/direct-combat';

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
  diceUsed: Array<{ index: number; purpose: string; target: string }>;
}

export interface DirectTurnDraft {
  content: string;
  options: string[];
  characterUpdates: CharacterNarrativeUpdate[];
  updates: DirectUpdates;
  raw: string;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`直出结果无效：${message}`);
}

function object(value: unknown, label: string): Row {
  check(isRecord(value), `${label} 必须是对象`);
  return value;
}

function keys(value: Row, allowed: readonly string[], label: string): void {
  check(
    Object.keys(value).every((key) => allowed.includes(key)),
    `${label} 含未支持的字段`,
  );
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

function validateEntity(value: unknown, character: boolean): void {
  const output = object(value, '实体');
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
    '实体',
  );
  for (const key of ['skills', 'equipment', 'inventory']) {
    for (const item of rows(output[key], key)) {
      named(item.name);
      check(typeof item.description === 'string', `${key} 缺少 description`);
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
    validateEntity({ skills: c.skills, equipment: c.equipment, inventory: c.inventory }, false);
    const ascension = object(c.ascension, '登神状态');
    check(
      typeof ascension.enabled === 'boolean' &&
        typeof ascension.path === 'string' &&
        typeof ascension.description === 'string',
      '登神状态不完整',
    );
    for (const key of ['elements', 'authorities', 'laws']) rows(ascension[key], `ascension.${key}`);
  } else check(output.character === undefined, '归属物不能再次创建人物');
  for (const status of rows(output.statuses ?? [], 'statuses')) {
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

export function parseDirectOutput(raw: string, diceCount: number): DirectTurnDraft {
  const blocks = [...raw.matchAll(/<direct_updates\s*>([\s\S]*?)<\/direct_updates\s*>/gi)];
  check(
    blocks.length === 1 && [...raw.matchAll(/<direct_updates\b/gi)].length === 1,
    '需要一个完整的 direct_updates 区块',
  );
  check(
    [...raw.matchAll(/<maintext\b/gi)].length === 1 && /<\/maintext\s*>/i.test(raw),
    '需要一个完整的 maintext 区块',
  );
  const parsed = object(JSON.parse(blocks[0][1]), 'direct_updates');
  safeValues(parsed);
  const sections = [
    'version',
    'world',
    'time',
    'entities',
    'state',
    'effects',
    'plot',
    'combat',
    'diceUsed',
  ];
  keys(parsed, sections, 'direct_updates');
  check(
    sections.every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) &&
      parsed.version === 1,
    'v1 分区不完整',
  );
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
  for (const row of rows(parsed.entities, 'entities')) {
    check(row.kind === 'character' || row.kind === 'loadout', '实体种类无效');
    keys(
      row,
      row.kind === 'character' ? ['kind', 'placement', 'output'] : ['kind', 'owner', 'output'],
      '实体项',
    );
    validateEntity(row.output, row.kind === 'character');
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
  const consumed = new Set<number>();
  for (const die of rows(parsed.diceUsed, 'diceUsed')) {
    check(
      Number.isInteger(die.index) &&
        Number(die.index) >= 0 &&
        Number(die.index) < diceCount &&
        !consumed.has(Number(die.index)),
      '骰索引无效或重复',
    );
    named(die.purpose);
    named(die.target);
    consumed.add(Number(die.index));
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
