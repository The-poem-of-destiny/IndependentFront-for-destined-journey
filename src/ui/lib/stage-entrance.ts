/**
 * stage-entrance.ts — 「新角色登场」演出的纯判定（交互式推进 T4）
 *
 * 回答「本条正文里谁该演登场、在第几节」。不碰 DOM、不读 store、不依赖 Vue。
 *
 * 守则：
 * - 名字（含别名）在**本楼开始时的名册**里的一律不演 —— 模型标了 enter 也不演，
 *   登场只属于本楼新建档的人物；
 * - 有 enter 标记的按标记偏移落到所在节；
 * - 回合接纳后新建、但模型没标 enter 的角色，按名字（或别名）在正文里**首次出现的那一节**补锚；
 *   正文里找不到就不演；
 * - 同一人物只演一次（取最早的一节）；「已读过就不演」与「演过就不再撤回」归调用方的账本。
 * - 不拿本楼新建名单过滤 enter 标记：标了 enter、名字不在开楼名册里就演（含没建档的临时人物）。
 *   新建名单要到回合收尾才读回，拿它过滤会让已经演出的卡片在接纳前后忽隐忽现。
 */
import type { StageEnterMark, StageSection } from './stage-playback';

/** 名册条目：名字 + 可选别名 */
export interface StageRosterEntry {
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface StageEntrance {
  readonly name: string;
  readonly sectionIndex: number;
}

/** 名字比较口径：去首尾空白 + NFKC（全半角统一）+ 折小写（西文名大小写不一致时仍认得） */
function normalizeName(raw: string): string {
  return raw.trim().normalize('NFKC').toLowerCase();
}

function namesOf(entry: StageRosterEntry): string[] {
  return [entry.name, ...(entry.aliases ?? [])]
    .map(normalizeName)
    .filter((name) => name.length > 0);
}

/** 偏移所在的节；落在正文末尾（或越界）时归最后一节 */
function sectionAt(sections: readonly StageSection[], at: number): number {
  const hit = sections.find((section) => at >= section.start && at < section.end);
  if (hit) return hit.index;
  return at < 0 ? 0 : sections[sections.length - 1].index;
}

/** 任一名字在各节正文里首次出现的节序号；找不到为 null */
function firstMentionSection(
  sections: readonly StageSection[],
  names: readonly string[],
): number | null {
  for (const section of sections) {
    const text = normalizeName(section.text);
    if (names.some((name) => text.includes(name))) return section.index;
  }
  return null;
}

/**
 * @param enters 模型写的登场标记（字符偏移）
 * @param roster 本楼开始时的角色名册（含别名）
 * @param created 回合接纳后本楼新建的角色（含别名）；流式中未接纳时传空数组
 * @param sections 本条正文的节（`splitStageSections` 的结果）
 */
export function resolveEntrances(
  enters: readonly StageEnterMark[],
  roster: readonly StageRosterEntry[],
  created: readonly StageRosterEntry[],
  sections: readonly StageSection[],
): StageEntrance[] {
  if (sections.length === 0) return [];
  const known = new Set(roster.flatMap(namesOf));
  /** 已决定演出的人物（按任一名字去重） → 结果下标 */
  const decided = new Map<string, number>();
  const result: StageEntrance[] = [];

  const claim = (displayName: string, names: readonly string[], sectionIndex: number) => {
    if (names.length === 0 || names.some((name) => known.has(name))) return;
    const existing = names.map((name) => decided.get(name)).find((at) => at !== undefined);
    if (existing !== undefined) {
      const prior = result[existing];
      if (sectionIndex < prior.sectionIndex) result[existing] = { ...prior, sectionIndex };
      for (const name of names) decided.set(name, existing);
      return;
    }
    result.push({ name: displayName, sectionIndex });
    for (const name of names) decided.set(name, result.length - 1);
  };

  for (const mark of enters) {
    const name = mark.name.trim();
    if (!name) continue;
    // 标记写的可能是别名：并入对应新建角色的全部名字，避免同一人演两次
    const normalized = normalizeName(name);
    const owner = created.find((entry) => namesOf(entry).includes(normalized));
    claim(
      owner ? owner.name.trim() : name,
      owner ? namesOf(owner) : [normalized],
      sectionAt(sections, mark.at),
    );
  }

  for (const entry of created) {
    const names = namesOf(entry);
    if (names.some((name) => decided.has(name))) continue;
    const sectionIndex = firstMentionSection(sections, names);
    if (sectionIndex !== null) claim(entry.name.trim(), names, sectionIndex);
  }

  return result
    .map((entrance, order) => ({ entrance, order }))
    .sort((a, b) => a.entrance.sectionIndex - b.entrance.sectionIndex || a.order - b.order)
    .map(({ entrance }) => entrance);
}
