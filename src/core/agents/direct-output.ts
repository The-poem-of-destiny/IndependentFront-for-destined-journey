import type {
  AgentResult,
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
import { extractJsonPayload } from '../utils/model-json';
import {
  DIRECT_AFFECTION_OPERATIONS,
  DIRECT_ASCENSION_LIST_KEYS,
  DIRECT_ATTRIBUTE_KEYS,
  DIRECT_CHARACTER_FIELDS,
  DIRECT_CHARACTER_LIST_FIELDS,
  DIRECT_CHARACTER_OPERATIONS,
  DIRECT_CHARACTER_TEXT_FIELDS,
  DIRECT_DELTA_PATHS,
  DIRECT_EFFECT_ACTIONS,
  DIRECT_EFFECT_CATEGORIES,
  DIRECT_EFFECT_REMOVE_KEYS,
  DIRECT_EFFECT_ROW_KEYS,
  DIRECT_EFFECT_TIME_UNITS,
  DIRECT_EFFECT_UPDATE_KEYS,
  DIRECT_ENTITY_LIST_KEYS,
  DIRECT_ENTITY_OUTPUT_KEYS,
  DIRECT_ENTITY_ROW_KEYS,
  DIRECT_FORBIDDEN_KEYS,
  DIRECT_ITEM_MODIFY_KEYS,
  DIRECT_ITEM_OPERATIONS,
  DIRECT_PLOT_KEYS,
  DIRECT_QUEST_OPERATIONS,
  DIRECT_REMOVE_PATHS,
  DIRECT_SECTIONS,
  DIRECT_STATE_KEYS,
  DIRECT_STRIPPED_KEYS,
  DIRECT_WORLD_KEYS,
  DIRECT_WORLD_RESERVED_SEGMENTS,
} from './direct-contract';
import { normalizeDirectUpdates } from './direct-normalize';

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
  /** 严格校验前做过的无损纠正（中文，带路径），仅供告警；无纠正时缺席 */
  normalized?: string[];
}

export interface ParseDirectOutputOptions {
  /** 是否启用结构化战斗；缺省 true（严格校验 combat 区块） */
  structuredCombat?: boolean;
  /** 剧情系统是否启用；缺省 true。关闭时模型写的非空 plot 被丢弃（记入 normalized） */
  plotEnabled?: boolean;
}

/** 模型可见正文为空（含纯空白）：常见于只产出原生思考、没写正文的回复 */
export function isEmptyDirectReply(raw: string | null | undefined): boolean {
  return !raw?.trim();
}

/** 结束原因表示输出预算已用尽（length / max_tokens）：重试会再烧一整份预算，故不重试 */
export function isDirectOutputBudgetExhausted(finishReason: string | undefined): boolean {
  const reason = finishReason?.toLowerCase();
  return reason === 'length' || reason === 'max_tokens';
}

/**
 * 空正文的报错文案。🔴 前缀「模型返回了空正文」是契约：UI 的失败分类按它识别，别改字。
 * 写「输出 N token」而不是「token: N」——后者会被 redactSecrets 当凭据抹掉。
 */
export function describeEmptyDirectReply(
  result: Pick<AgentResult, 'reasoning' | 'finishReason' | 'completionTokens'>,
  retried: boolean,
): string {
  const reasoning = result.reasoning?.trim() ?? '';
  const head = reasoning
    ? `模型返回了空正文：只输出了思考（约 ${reasoning.length} 字），没有写出正文。`
    : '模型返回了空正文：没有任何输出。';
  const tokens =
    typeof result.completionTokens === 'number' ? `；输出 ${result.completionTokens} token` : '';
  const tail = retried
    ? '已自动重试 1 次仍为空。'
    : isDirectOutputBudgetExhausted(result.finishReason)
      ? '已达到输出上限，未自动重试，可调高输出上限后重试。'
      : '';
  return `${head}结束原因：${result.finishReason || '未知'}${tokens}。${tail}`;
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

/** 白名单常量是 readonly 元组；判定时按普通字符串集合用 */
function among(list: readonly string[], value: unknown): boolean {
  return list.includes(String(value));
}

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

function named(value: unknown, label?: string): asserts value is string {
  check(
    typeof value === 'string' && value.trim().length > 0,
    label ? `${label} 名字／引用不能为空` : '名字／引用不能为空',
  );
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
      // 结构化位置的 id 等账务键已在归一化预处理里剥除；剩下的（world value 内）与原型污染键直接拒收
      check(
        !among(DIRECT_FORBIDDEN_KEYS, key) && !among(DIRECT_STRIPPED_KEYS, key),
        `不允许模型填写 ${key}`,
      );
      safeValues(child);
    }
  }
}

/** world path 的禁用段：原型污染键 + 系统状态段 */
const WORLD_RESERVED_PATH = new RegExp(
  String.raw`(^|\.)(${[...DIRECT_FORBIDDEN_KEYS, ...DIRECT_WORLD_RESERVED_SEGMENTS].join('|')})(\.|$)`,
);

function validateEntity(value: unknown, character: boolean, label: string): void {
  const output = object(value, label);
  keys(output, DIRECT_ENTITY_OUTPUT_KEYS, label);
  for (const key of DIRECT_ENTITY_LIST_KEYS) {
    for (const [i, item] of rows(output[key], `${label}.${key}`).entries()) {
      named(item.name, `${label}.${key}[${i}].name`);
      check(typeof item.description === 'string', `${label}.${key} 缺少 description`);
      if (key === 'inventory')
        check(Number.isInteger(item.quantity) && Number(item.quantity) > 0, '物品数量必须为正整数');
      if (key === 'equipment') {
        named(item.slot, `${label}.${key}[${i}].slot`);
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
    named(c.name, `${label}.character.name`);
    check(Number.isInteger(c.tier) && Number(c.tier) >= 1 && Number(c.tier) <= 7, '人物层级无效');
    check(
      Number.isInteger(c.level) && Number(c.level) >= 1 && Number(c.level) <= 25,
      '人物等级无效',
    );
    const attrs = object(c.attributes, '人物属性');
    for (const attr of DIRECT_ATTRIBUTE_KEYS)
      check(typeof attrs[attr] === 'number' && Number(attrs[attr]) >= 0, `缺少属性 ${attr}`);
    for (const key of DIRECT_CHARACTER_TEXT_FIELDS)
      check(typeof c[key] === 'string', `人物缺少 ${key}`);
    for (const key of DIRECT_CHARACTER_LIST_FIELDS)
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
    // 缺名条目已在归一化 N5 丢弃（与 HEAD 一样不因无名条目整楼拒收）
    for (const key of DIRECT_ASCENSION_LIST_KEYS) rows(ascension[key], `ascension.${key}`);
  } else check(output.character === undefined, '归属物不能再次创建人物');
  for (const [i, status] of rows(output.statuses ?? [], `${label}.statuses`).entries()) {
    named(status.name, `${label}.statuses[${i}].name`);
    named(status.owner, `${label}.statuses[${i}].owner`);
  }
}

function validateState(value: Row): void {
  keys(value, DIRECT_STATE_KEYS, 'state');
  const chars = object(value.characters ?? {}, 'state.characters');
  keys(chars, DIRECT_CHARACTER_OPERATIONS, 'state.characters');
  const owned = new Set<string>();
  for (const operation of DIRECT_CHARACTER_OPERATIONS) {
    for (const [i, row] of rows(chars[operation] ?? [], operation).entries()) {
      named(row.name, `state.characters.${operation}[${i}].name`);
      const key = `${row.name}/${row.path}/${operation === 'remove' ? row.target : ''}`;
      check(!owned.has(key), '人物字段重复声明');
      owned.add(key);
      if (operation === 'remove') {
        check(
          among(DIRECT_REMOVE_PATHS, row.path),
          'state.characters.remove 只支持 skills／equipment（状态效果走 effects）',
        );
        named(row.target, `state.characters.remove[${i}].target`);
      } else {
        check(among(DIRECT_CHARACTER_FIELDS, row.path), '人物字段不属于 direct state 白名单');
        if (operation === 'delta')
          check(
            among(DIRECT_DELTA_PATHS, row.path) && typeof row.amount === 'number',
            'delta 只能用于资源／金钱／经验',
          );
        else if (row.path === 'present')
          check(typeof row.value === 'boolean', 'present 必须是布尔值');
        else if (among(DIRECT_DELTA_PATHS, row.path))
          check(typeof row.value === 'number' && Number(row.value) >= 0, '资源值无效');
        else check(typeof row.value === 'string', '人物字段必须为文本');
      }
    }
  }
  const items = object(value.items ?? {}, 'state.items');
  keys(items, DIRECT_ITEM_OPERATIONS, 'state.items');
  for (const [op, list] of Object.entries(items))
    for (const [i, row] of rows(list, op).entries()) {
      const label = `state.items.${op}[${i}]`;
      named(row.target, `${label}.target`);
      if (op === 'transfer') {
        named(row.from, `${label}.from`);
        named(row.to, `${label}.to`);
      } else named(row.owner, `${label}.owner`);
      if (op === 'consume' || op === 'transfer')
        check(
          Number.isInteger(row.quantity) && Number(row.quantity) > 0,
          '消耗／转移数量必须为正整数',
        );
      if (op === 'equip') named(row.slot, `${label}.slot`);
      if (op === 'modify') {
        const changes = object(row.changes, '物品修改');
        keys(changes, DIRECT_ITEM_MODIFY_KEYS, '物品修改');
      }
    }
  const affections = object(value.affections ?? {}, '好感度');
  keys(affections, DIRECT_AFFECTION_OPERATIONS, '好感度');
  for (const [op, list] of Object.entries(affections))
    for (const [i, row] of rows(list, op).entries()) {
      named(row.name, `state.affections.${op}[${i}].name`);
      check(typeof row[op === 'set' ? 'value' : 'amount'] === 'number', '好感度必须为数值');
    }
  if (value.fp !== undefined) {
    const fp = object(value.fp, 'fp');
    keys(fp, ['delta'], 'fp');
    check(typeof fp.delta === 'number', 'fp.delta 必须为数值');
  }
  const quests = object(value.quests ?? {}, 'quests');
  keys(quests, DIRECT_QUEST_OPERATIONS, 'quests');
  for (const [op, list] of Object.entries(quests))
    for (const [i, row] of rows(list, 'quests').entries())
      named(row.name, `state.quests.${op}[${i}].name`);
}

export function parseDirectOutput(
  raw: string,
  pool: DirectDicePool,
  options: ParseDirectOutputOptions = {},
): DirectTurnDraft {
  const structuredCombat = options.structuredCombat ?? true;
  const plotEnabled = options.plotEnabled ?? true;
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
  // N1：内文先过 JSON 抢救入口，剥掉 ```json 围栏、<json> 标签或 JSON 之前夹带的说明文字
  // （以 { 开头的内文按整段解析，JSON 之后跟文字不剥，照旧拒收为非法 JSON）
  const inner = blocks[0][1];
  const payload = extractJsonPayload(inner) ?? inner;
  const notes = payload === inner.trim() ? [] : ['direct_updates：已剥除 JSON 外的围栏或说明文字'];
  let json: unknown;
  try {
    json = JSON.parse(payload);
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
  // 无损纠正：就地改写 parsed（buildDirectPatches 读的是同一个对象）；关闭战斗时这里补回 combat: null
  const normalization = normalizeDirectUpdates(parsed, { structuredCombat, plotEnabled });
  notes.push(...normalization.notes);
  const { flattenedCharacters } = normalization;
  safeValues(parsed);
  keys(parsed, DIRECT_SECTIONS, 'direct_updates');
  check(
    DIRECT_SECTIONS.every((key) => Object.prototype.hasOwnProperty.call(parsed, key)) &&
      parsed.version === 1,
    'v1 分区不完整',
  );
  const time = object(parsed.time, 'time');
  keys(time, ['delta_time'], 'time');
  check(typeof time.delta_time === 'number' && time.delta_time >= 0, 'delta_time 必须是非负分钟数');
  const world = object(parsed.world, 'world');
  keys(world, DIRECT_WORLD_KEYS, 'world');
  for (const op of ['replace', 'insert'])
    for (const [i, row] of rows(world[op] ?? [], op).entries()) {
      named(row.path, `world.${op}[${i}].path`);
      check(!WORLD_RESERVED_PATH.test(row.path), 'world 不能写系统状态');
    }
  const tiles = rows(world.tile_ops ?? [], 'tile_ops');
  check(
    buildDispatcherPatches({ tile_ops: tiles }).patches.length === tiles.length,
    '地块操作无效',
  );
  for (const [i, row] of rows(parsed.entities, 'entities').entries()) {
    check(row.kind === 'character' || row.kind === 'loadout', '实体种类无效');
    keys(row, DIRECT_ENTITY_ROW_KEYS[row.kind], `entities[${i}]`);
    validateEntity(row.output, row.kind === 'character', `entities[${i}].output`);
    if (row.kind === 'loadout') named(row.owner, `entities[${i}].owner`);
    else {
      const placement = object(row.placement, 'placement');
      named(placement.location, `entities[${i}].placement.location`);
      check(typeof placement.present === 'boolean', 'placement.present 缺失');
    }
  }
  validateState(object(parsed.state, 'state'));
  for (const [i, effect] of rows(parsed.effects, 'effects').entries()) {
    keys(effect, DIRECT_EFFECT_ROW_KEYS, 'effects');
    named(effect.owner, `effects[${i}].owner`);
    check(among(DIRECT_EFFECT_ACTIONS, effect.action), '效果动作无效');
    const value = object(effect.value, '效果');
    named(value.name, `effects[${i}].value.name`);
    if (effect.action === 'add') {
      check(
        typeof value.description === 'string' && among(DIRECT_EFFECT_CATEGORIES, value.category),
        '效果缺少描述／分类',
      );
      check(typeof value.stacks === 'number' && value.stacks > 0, '效果层数无效');
      check(
        value.remainingTime === null ||
          (typeof value.remainingTime === 'number' && value.remainingTime >= 0),
        '效果时长无效',
      );
      check(among(DIRECT_EFFECT_TIME_UNITS, value.timeUnit), '效果时间单位无效');
    }
    if (effect.action === 'update') keys(value, DIRECT_EFFECT_UPDATE_KEYS, '效果更新');
    if (effect.action === 'remove') keys(value, DIRECT_EFFECT_REMOVE_KEYS, '效果移除');
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
  keys(plot, DIRECT_PLOT_KEYS, 'plot');
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
    named(die.purpose, `${label}.purpose`);
    named(die.target, `${label}.target`);
    consumed.add(key);
  }
  const character = parseCharacterUpdates(raw);
  check(
    character.present && character.warnings.length === 0,
    character.warnings.join('；') || '缺少 character_updates',
  );
  // character_updates 的无损纠正与 direct_updates 的同口径并入 normalized（同一条 warn）
  notes.push(...character.notes.map((note) => `character_updates：${note}`));
  const projection = projectStoryOutput(raw);
  check(projection.content.length > 0, '正文为空');
  return {
    ...projection,
    raw,
    characterUpdates: character.updates,
    updates: parsed as unknown as DirectUpdates,
    ...(combatIgnored ? { combatIgnored: true as const } : {}),
    ...(flattenedCharacters.length > 0 ? { flattenedCharacters } : {}),
    ...(notes.length > 0 ? { normalized: notes } : {}),
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
