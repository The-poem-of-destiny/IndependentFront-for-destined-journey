import type { DirectGenerationInput } from '../agents/direct-request';
import { isPresetPromptActive } from '../content/nsfw-filter';
import type {
  AgentContext,
  CharacterState,
  ChatPreset,
  MemoryRecord,
  WorldBookEntry,
} from '../types/types';
import { buildAgentMessagesAsync } from './agent-templates';
import { resolveTemplateWithGlobals } from './template-resolver';
import { formatMemoryEntry } from './placeholder-registry';
import { buildCharacterContext } from '../character/character-chronicle';
import { projectCharacterAge } from '../character/character-age';
import type { GameTime } from '../time/time-system';
import type { DirectContextFrame } from './direct-context-session';
import { DIRECT_TEMPLATE } from './direct-prompt';
import {
  parseSetvars,
  resolveGetvars,
  resolveRandoms,
  preprocessPresetEntryContents,
} from './preset-loader';
import { isStoryZonePlaceholder, type PresetEntryLike } from './story-zone-placeholders';
import { isStateTreePersonSummary, type StateTreeObject } from '../variables/state-tree-projection';
import { joinStateTreePath, splitStateTreeSections } from '../variables/state-tree-sections';

const RANDOM_MACRO_RE = /\{\{random::/;

/**
 * 预设原文是否含**逐轮变化**的宏，需要保留作者原位（authored layout）。
 *
 * 会话期内恒定的宏不算：`{{user}}`/`{{char}}`/`{{USER_NAME}}`/`{{CHARACTER_NAME}}`、
 * `{{setvar}}`/`{{getvar}}`、`{{//注释}}`，以及 `preprocessEntry` 一律剥离的小写宏
 * （`{{roll ...}}` 与未知 ST 宏）—— 它们的展开结果每轮相同，静态解析进前缀即可。
 * 逐轮变化的：EJS、`{{random::}}`（每次装配重掷）、大写系统占位符（输入/历史/状态等）。
 */
function hasDynamicMacros(text: string): boolean {
  return (
    text.includes('<%') ||
    RANDOM_MACRO_RE.test(text) ||
    /\{\{(?!(?:USER_NAME|CHARACTER_NAME)\}\})[A-Z]/.test(text)
  );
}

/**
 * 每个分区都是绝对值；改 HP 不会重发档案或库存。
 * 位置、在场、当前行动、金钱、经验与心里话几乎每回合都变，单列进 `character/角色名/state`：
 * 若与背景、外貌、性格等长文本同在 `profile`，整份档案会因这些易变字段每楼重发。
 * 年龄按 `now` 现算进 `profile`（不发冻结的开局年龄与原始锚点），每过一个生日该分区重发一次。
 */
export function buildDirectCharacterSections(
  characters: readonly CharacterState[],
  now: Pick<GameTime, 'year' | 'month' | 'day'> | null | undefined,
): Record<string, unknown> {
  const sections: Record<string, unknown> = {};
  const resources = [];
  for (const character of characters) {
    const {
      id: _id,
      saveId: _saveId,
      definition: _definition,
      introducedBy: _introducedBy,
      hp,
      maxHp,
      mp,
      maxMp,
      sp,
      maxSp,
      skills,
      inventory,
      statusEffects,
      location,
      present,
      currentAction,
      money,
      totalExp,
      expToNext,
      thoughts,
      ...profile
    } = projectCharacterAge(character, now);
    const key = `character/${character.name}`;
    sections[`${key}/profile`] = profile;
    sections[`${key}/state`] = {
      location,
      present,
      currentAction,
      money,
      totalExp,
      expToNext,
      thoughts,
    };
    sections[`${key}/skills`] = skills;
    sections[`${key}/inventory`] = inventory;
    sections[`${key}/statusEffects`] = statusEffects;
    resources.push({ name: character.name, hp, maxHp, mp, maxMp, sp, maxSp });
  }
  return { ...sections, resources };
}

/** 尾部现值重申的三个资源分区（状态树协议，设计 §3.4）。 */
const TREE_RESOURCE_KEYS = ['生命值', '法力值', '体力值'] as const;

/**
 * 状态树协议（tree）下的状态分区：分区键即 stat_data 树路径（`splitStateTreeSections` 的切点）。
 * 与 legacy 的 `character/角色名/…` + `resources` 互斥，两种协议不会出现在同一份分区里。
 * 全量 ↔ 摘要切换时，新旧分区路径不同，会话层按「上一轮有、本轮没有」自然下发 remove，
 * 不会在缓存里留下重叠分区（`findOverlappingSections` 闸门测试钉住）。
 */
export function buildDirectTreeSections(tree: StateTreeObject): Record<string, unknown> {
  return splitStateTreeSections(tree);
}

/**
 * 状态树协议下尾部现值重申的分区键：主角与在场角色（全量节点且 `在场` 为真）的
 * 生命值 / 法力值 / 体力值，加上 combat。不在场的摘要角色没有资源分区，自然不列。
 */
export function directTreeCurrentSections(tree: StateTreeObject): string[] {
  const keys = ['combat'];
  if (tree['主角'] && typeof tree['主角'] === 'object')
    for (const key of TREE_RESOURCE_KEYS) keys.push(joinStateTreePath(['主角', key]));
  const relations = tree['关系列表'];
  if (relations && typeof relations === 'object' && !Array.isArray(relations))
    for (const [name, node] of Object.entries(relations)) {
      if (isStateTreePersonSummary(node)) continue;
      if ((node as StateTreeObject)['在场'] !== true) continue;
      for (const key of TREE_RESOURCE_KEYS) keys.push(joinStateTreePath(['关系列表', name, key]));
    }
  return keys;
}

/**
 * 记忆库按条分区（`memory/记忆编号`）：新增记忆只追加一个键，删除走 `remove`，编辑只替换那一条。
 * 整块一个键时，每楼新增一条记忆都会重发全库，长存档每一两楼就因 `transcript_growth` 重建。
 * 规范化序列化按键的字典序排列，与原先按 Dexie 主键读出的顺序一致（6 位零填充流水号内即时间顺序）。
 */
export function buildDirectMemorySections(
  memories: readonly MemoryRecord[],
): Record<string, string> {
  return Object.fromEntries(memories.map((m) => [`memory/${m.id}`, formatMemoryEntry(m)]));
}

/** Move engine-owned changing inputs out of the prefix; custom dynamic instructions still rebase. */
export async function buildLegacyDirectCacheFrame(
  input: DirectGenerationInput,
  books: DirectGenerationInput['worldBooks'],
  history: string,
  fixedEntries: ReadonlySet<WorldBookEntry> = new Set(),
): Promise<DirectContextFrame> {
  const preset = input.presets.find((p) => p.id === input.config.presetId);
  const presetSettings = (preset as ChatPreset | undefined)?.settings;
  const rawPrompts = presetSettings?.prompts;
  const prompts: PresetEntryLike[] | undefined = Array.isArray(rawPrompts) ? rawPrompts : undefined;
  const marked = prompts?.some((p) => p.directCachePlacement === 'turn' && isPresetPromptActive(p));
  const ordered = marked
    ? prompts!
        .filter(
          (p) => isPresetPromptActive(p) && p.role !== 'assistant' && !isStoryZonePlaceholder(p),
        )
        .sort((a, b) => Number(a.injection_order ?? 0) - Number(b.injection_order ?? 0))
    : [];
  const processed = preprocessPresetEntryContents(ordered);
  const dynamic = ordered.flatMap((p, i) =>
    p.directCachePlacement === 'turn' ? [processed[i]] : [],
  );
  const fixedPrompts: PresetEntryLike[] | undefined = marked
    ? ordered.flatMap((p, i) =>
        p.directCachePlacement === 'turn' ? [] : [{ ...p, content: processed[i] }],
      )
    : prompts;
  const fixedPreset =
    marked && preset
      ? { ...preset, settings: { ...presetSettings, prompts: fixedPrompts } }
      : preset;
  const presets = input.presets.map((p) => (p === preset ? fixedPreset! : p));
  // 判据取**预处理前**的原文：预处理会把 {{random}} 掷成定值、{{user}} 改写成 {{USER_NAME}}，
  // 掷完的文本看不出它每轮会变。助手条目与五区占位不进前缀，不参与判定。
  const authored = Array.isArray(prompts)
    ? prompts
        .filter(
          (p) =>
            isPresetPromptActive(p) &&
            p.directCachePlacement !== 'turn' &&
            p.role !== 'assistant' &&
            !isStoryZonePlaceholder(p),
        )
        .map((p) => (typeof p.content === 'string' ? p.content : ''))
        .join('\n')
    : [preset?.fixedSystem, preset?.fixedExamples, input.config.systemPrompt].join('\n');
  const template = input.config.template?.replace(/\r\n/g, '\n').trim();
  // Authored macros and custom layouts retain their original positions. Their rendered
  // prefix participates in the signature, so changing input safely rebuilds the session.
  const authoredLayout = !!(
    (template && template !== DIRECT_TEMPLATE) ||
    hasDynamicMacros(authored)
  );
  const moving = [
    'NARRATIVE',
    'USER_INPUT',
    'LORE_BOOK',
    'LORE_BOOK_STATIC',
    'LORE_BOOK_DYNAMIC',
    'CHARACTER_STATE',
    'GAME_TIME',
    'MAP_CONTEXT',
    'RANDOM_EVENTS',
    'MEMORY_ENTRIES',
    'AGENT.MEMORY_RECALL',
    'CHARACTER_CONTEXT',
  ];
  let rendered: AgentContext = input.context;
  let renderedEntries: ReadonlyMap<WorldBookEntry, string> = new Map();
  const prefix = await buildAgentMessagesAsync(
    'direct_main',
    input.context,
    input.configs,
    books,
    presets,
    authoredLayout ? { NARRATIVE: history } : Object.fromEntries(moving.map((k) => [k, ''])),
    (ctx, entries) => {
      rendered = ctx;
      renderedEntries = entries;
    },
  );
  if (!prefix) throw new Error('直出提示词未配置');
  const resolve = (text: string) =>
    resolveTemplateWithGlobals(
      text,
      'direct_main',
      rendered,
      input.config,
      books,
      input.configs,
      {},
    );
  const authoredTurn = dynamic.map(resolve).filter(Boolean).join('\n');
  if (authoredLayout)
    return {
      prefix: prefix.map((m) => ({ role: 'system', content: m.content })),
      history: [],
      sections: authoredTurn ? { authoredTurn } : {},
    };
  const fixed: string[] = [];
  const current: string[] = [];
  for (const [entry, text] of renderedEntries) {
    const expanded = resolveGetvars(
      parseSetvars(text).stripped,
      rendered.ejsPass?.stDefinitions ?? {},
    );
    // 含 {{random}} 的固定条目每轮掷出不同文本，留在前缀会让会话签名逐轮变化、缓存永不预热；
    // 与 ADR-30「含 random 的条目沉到动态尾部」同口径，改走本轮资料。
    const rerolls = RANDOM_MACRO_RE.test(expanded);
    (fixedEntries.has(entry) && !rerolls ? fixed : current).push(resolveRandoms(expanded));
  }
  return {
    prefix: [
      ...prefix.map((m) => ({ role: 'system' as const, content: m.content })),
      ...(fixed.length ? [{ role: 'system' as const, content: fixed.join('\n\n') }] : []),
    ],
    history: history ? [{ role: 'system', content: history }] : [],
    sections: {
      currentLore: current.join('\n\n'),
      mapContext: resolve('{{MAP_CONTEXT}}'),
      randomEvents: resolve('{{RANDOM_EVENTS}}'),
      ...buildDirectMemorySections(rendered.memories ?? []),
      characterContext: buildCharacterContext(input.context),
      ...(authoredTurn ? { authoredTurn } : {}),
    },
  };
}
