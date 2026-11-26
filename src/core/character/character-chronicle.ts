import type { AgentContext, CharacterState, StoryMemorySource } from '../types/types';
import type { GameTime } from '../time/time-system';
import type { CharacterChronicleEntry, CharacterNarrativeUpdate } from '../types/types-character';
import { formatGameTime, toEpochMinutes } from '../time/time-system';
import { LIST_FIELDS, TEXT_FIELDS } from './character-updates';
import { filterNsfwText, nsfwEnabled } from '../content/nsfw-filter';

export const CHRONICLE_IMPORTANCE_THRESHOLD = 7;
const CHRONICLE_CONTEXT_BUDGET = 6000;

export function chronicleTimeLabel(entry: CharacterChronicleEntry): string {
  return entry.time.kind === 'past'
    ? entry.time.label
    : entry.time.value
      ? formatGameTime(entry.time.value)
      : '日期未载';
}

export function compareChronicleEntries(
  a: CharacterChronicleEntry,
  b: CharacterChronicleEntry,
): number {
  if (a.time.kind !== b.time.kind) return a.time.kind === 'past' ? -1 : 1;
  if (a.time.kind === 'game' && b.time.kind === 'game' && a.time.value && b.time.value) {
    const delta = toEpochMinutes(a.time.value) - toEpochMinutes(b.time.value);
    if (delta) return delta;
  }
  return a.createdAt - b.createdAt || a.order - b.order || a.id.localeCompare(b.id);
}

export function authorChronicle(character: CharacterState): CharacterChronicleEntry[] {
  const definition = character.definition;
  if (!definition) return [];
  return definition.past.map((entry, order) => ({
    ...structuredClone(entry),
    id: `author:${character.id}:${definition.id}:${order}`,
    saveId: character.saveId,
    characterId: character.id,
    origin: 'author',
    order,
    createdAt: 0,
    source: { kind: 'definition', definitionId: definition.id },
    sourceText: entry.summary,
  }));
}

export function turnChronicle(input: {
  character: CharacterState;
  update: CharacterNarrativeUpdate;
  source: StoryMemorySource;
  gameTime: GameTime | null;
  sourceText: string;
  createdAt: number;
}): CharacterChronicleEntry[] {
  return input.update.chronicle.map((entry, order) => ({
    ...entry,
    id: `turn:${input.character.id}:${input.source.sourceTurnKey}:${order}`,
    saveId: input.character.saveId,
    characterId: input.character.id,
    order,
    createdAt: input.createdAt,
    time: entry.time.kind === 'past' ? entry.time : { kind: 'game', value: input.gameTime },
    origin: entry.time.kind === 'past' ? 'generated' : 'experience',
    source: { kind: 'turn', ...input.source },
    sourceText: input.sourceText,
  }));
}

export function buildCharacterContext(
  ctx: AgentContext,
  budget = CHRONICLE_CONTEXT_BUDGET,
): string {
  const recent = [ctx.userInput, ...ctx.history.slice(-2).map((m) => m.content)].join('\n');
  const relevant = ctx.characters.filter(
    (c) =>
      c.type === 'player' ||
      c.present === true ||
      [c.name, ...(c.aliases ?? [])].some((n) => n && recent.includes(n)),
  );
  const ids = new Set(relevant.map((c) => c.id));
  const definitions = (ctx.characterDefinitions ?? []).filter(
    (d) => !ctx.characters.some((c) => c.definition?.id === d.id),
  );
  const mentioned = (name: string, aliases: string[] = []) =>
    [name, ...aliases].some((n) => n && recent.includes(n));
  // A linked worldbook entry is the model-facing profile (EJS / routing / activation apply there);
  // the definition's own `lore` is only a fallback for definitions without a loaded entry.
  // `ctx.characterDefinitions` carries the resolved links, so instantiated characters (whose
  // `definition` copy may predate the link) are judged by their definition id.
  const linked = (definition: { id: string; loreEntry?: string }) =>
    (ctx.characterDefinitions ?? []).find((d) => d.id === definition.id)?.loreEntry !== undefined;
  const fallbackLore = (definition: { id: string; lore?: string; nsfw?: boolean }) => {
    if (linked(definition)) return undefined;
    if (nsfwEnabled()) return definition.lore;
    // 露骨内容关：以按开关投影过的定义为准（整条标记角色被剔、因露骨被剔的链接不回落原文），
    // 别回读角色身上冻结的那份原文
    const projected = (ctx.characterDefinitions ?? []).find((d) => d.id === definition.id);
    if (projected) return projected.lore;
    return definition.nsfw || definition.lore === undefined
      ? undefined
      : filterNsfwText(definition.lore);
  };
  const profiles = definitions.map((d) => {
    const selected = mentioned(d.name, d.profile.aliases);
    return {
      name: d.name,
      ...(selected
        ? { ...d.profile, lore: fallbackLore(d) }
        : { background: (d.profile.background ?? fallbackLore(d))?.slice(0, 240) }),
    };
  });
  for (const c of relevant) {
    const lore = c.definition ? fallbackLore(c.definition) : undefined;
    if (lore) profiles.push({ name: c.name, lore });
  }
  const relevance = (e: CharacterChronicleEntry) =>
    (e.location && relevant.some((c) => c.location?.includes(e.location!)) ? 1 : 0) +
    (e.people?.filter((name) => recent.includes(name)).length ?? 0);
  const candidates = (ctx.characterChronicle ?? [])
    .filter((e) => ids.has(e.characterId))
    .sort((a, b) => compareChronicleEntries(b, a))
    .map((e) => ({
      name: relevant.find((c) => c.id === e.characterId)!.name,
      time: chronicleTimeLabel(e),
      title: e.title,
      summary: e.summary,
      importance: e.importance,
      impact: e.impact,
      relevance: relevance(e),
    }));
  // Authored past must guide the first encounter too, before an entity exists in this save.
  for (const definition of definitions.filter((d) => mentioned(d.name, d.profile.aliases))) {
    for (const entry of [...definition.past].reverse())
      candidates.push({
        name: definition.name,
        time: entry.time.label,
        title: entry.title,
        summary: entry.summary,
        importance: entry.importance,
        impact: entry.impact,
        relevance: 0,
      });
  }
  candidates.sort((a, b) => b.importance - a.importance || b.relevance - a.relevance);
  const entries: string[] = [];
  let used = 0;
  for (const entry of candidates) {
    if (entry.importance < CHRONICLE_IMPORTANCE_THRESHOLD) continue;
    const line = JSON.stringify({
      name: entry.name,
      time: entry.time,
      title: entry.title,
      summary: entry.summary,
      importance: entry.importance,
      impact: entry.impact,
    });
    if (used + line.length + 1 > budget) continue;
    entries.push(line);
    used += line.length + 1;
  }
  return [
    profiles.length
      ? `<character_profiles>\n${JSON.stringify(profiles)}\n</character_profiles>`
      : '',
    entries.length
      ? `<important_character_history>\n${entries.join('\n')}\n</important_character_history>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const CHARACTER_UPDATE_PROTOCOL = `<character_system>
在正文及其他输出之后输出一个 <character_updates> 区块，属于同次回复，不调用额外记忆 Agent。标签内直接写 JSON，不加代码围栏。
格式：{"characters":[{"name":"角色真名","profile_changes":{},"chronicle":[{"title":"事件标题","summary":"该人物实际经历","time":{"kind":"this_turn"},"importance":7,"impact":"持续影响","location":"地点","people":["相关人物真名"]}]}]}。
无更新时 characters 为 []。角色项只有 name/profile_changes/chronicle 三个键，chronicle 必填（无经历写 []），同一角色只写一项。
profile_changes 只允许 ${LIST_FIELDS.join('/')}（字符串数组）及 ${TEXT_FIELDS.join('/')}（非空字符串），仅输出发生变化的字段；clothing/likes/thoughts/age/数值不属于 profile_changes，换装写 outfit。不要输出 ID、数值、物品、资源或战斗结算。
经历必填 title/summary（非空字符串）、time、importance；impact/location 可选字符串，people 可选字符串数组。
初登场人物须在同块给出档案及数条塑造人物的粗略过去，过去用 time:{"kind":"past","label":"少年时期"}；已存在角色不得补造或重写过去。沿用原生角色资料，不另造冲突身世。
重要度为 0–10 整数：0–3 日常，4–6 局部进展，7–8 持续影响，9–10 人生转折。闲聊通常低分，关键承诺按后果评分。只有 >=7 的相关经历会自动提供给后续叙事。
记录人物亲历或获知的事实，不把计划/猜测/传闻当成已发生事实，不因提及某人就为其写亲历。未知时间保留大致描述。不要重复已经保存的事件；这不是正文摘要。所有保存条目玩家可见。
</character_system>`;
