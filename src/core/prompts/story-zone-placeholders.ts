/**
 * Story 预设的五个上下文分区占位条目（D24–D27）。
 *
 * 计划依据：docs/planning/2026-09-30-story-context-memory-content-routing-plan.md §3.1.1。
 *
 * - 每份 Story 预设**强制**含 5 个占位条目，对应第 1–5 区，不可删除、不可复制；
 * - 5 个占位的**相对顺序**恒为 1→5，普通条目可以穿插在它们之间；
 * - 新模式开启时，装配在占位位置填入该区已组装好的消息列表（P3 接入）；
 * - 新模式关闭时，占位展开为空 —— `assemblePresetContent` 直接跳过它们，
 *   不产生空白消息、也不改变旧模式的提示词字节（Delta 签名因此不变）。
 *
 * 🔴 身份只认 `identifier`（`story_zone_1` … `story_zone_5`），名称只是展示。
 *    导入的 ST 预设、内容包预设与老用户的 Dexie 行都没有它们，由 `ensureStoryZonePlaceholders`
 *    在**读取视图**上补齐；只有用户真的改了预设时才随那次改动落库 —— 读取时静默写回
 *    会让内容包预设的四态基线判成「用户改过」，下一次升级平白多出冲突。
 * 🔴 缺失条目的补入位置是本文件的临时规则（Q11 待与内容计划 C0 对齐）：
 *    紧跟在编号更小的已有占位之后；没有更小的就放在编号更大的已有占位之前；
 *    一个都没有时 5 个依次追加到末尾。
 */

export type StoryZoneNumber = 1 | 2 | 3 | 4 | 5;

const STORY_ZONE_NUMBERS: readonly StoryZoneNumber[] = [1, 2, 3, 4, 5];

const IDENTIFIER_PREFIX = 'story_zone_';

/** 占位条目的展示名（逻辑分区含义见计划 §3.1）。 */
const STORY_ZONE_NAMES: Record<StoryZoneNumber, string> = {
  1: '【上下文分区 1】固定前缀',
  2: '【上下文分区 2】长期记忆总览',
  3: '【上下文分区 3】区域背景',
  4: '【上下文分区 4】摘要与近期正文',
  5: '【上下文分区 5】本轮资料与召回',
};

/** 预设条目的最小形状（SillyTavern 兼容字段全可选）。 */
export interface PresetEntryLike {
  identifier?: unknown;
  name?: unknown;
  content?: unknown;
  role?: unknown;
  enabled?: unknown;
  injection_order?: unknown;
}

/** 补齐/排序时的重编号步长，与 UI 侧 `preset-entries.ts` 的 10/20/30… 一致。 */
const ORDER_STEP = 10;

export function storyZoneIdentifier(zone: StoryZoneNumber): string {
  return `${IDENTIFIER_PREFIX}${zone}`;
}

/** 条目对应的分区号；不是占位条目返回 `null`。 */
export function storyZoneOf(entry: PresetEntryLike | null | undefined): StoryZoneNumber | null {
  const id = entry?.identifier;
  if (typeof id !== 'string' || !id.startsWith(IDENTIFIER_PREFIX)) return null;
  const n = Number(id.slice(IDENTIFIER_PREFIX.length));
  return STORY_ZONE_NUMBERS.includes(n as StoryZoneNumber) ? (n as StoryZoneNumber) : null;
}

export function isStoryZonePlaceholder(entry: PresetEntryLike | null | undefined): boolean {
  return storyZoneOf(entry) !== null;
}

/** 占位条目的规范形状：正文恒空、恒启用、system 角色（角色只是 ST 兼容字段，装配不读它）。 */
function createStoryZonePlaceholder(zone: StoryZoneNumber, injectionOrder: number) {
  return {
    identifier: storyZoneIdentifier(zone),
    name: STORY_ZONE_NAMES[zone],
    role: 'system',
    enabled: true,
    content: '',
    injection_order: injectionOrder,
  };
}

function orderOf(entry: PresetEntryLike): number {
  return typeof entry.injection_order === 'number' ? entry.injection_order : 0;
}

function isCanonicalPlaceholder(entry: PresetEntryLike, zone: StoryZoneNumber): boolean {
  return (
    entry.name === STORY_ZONE_NAMES[zone] &&
    entry.content === '' &&
    entry.enabled === true &&
    entry.role === 'system'
  );
}

/**
 * 在**生效顺序**上补齐五区占位并修正其相对顺序。
 *
 * 输入按 `injection_order`（缺省 0）稳定排序后处理；返回值同样是生效顺序。
 * - 重复的同号占位只保留第一条；
 * - 占位之间的相对顺序被打乱时，按 1→5 重排到它们原有的那几个槽位上（普通条目不动）；
 * - 占位字段被改过（名称/正文/启用/角色）时恢复为规范形状；
 * - 任一修正发生 → `changed: true`，且全部条目按位置重编号（步长 10）。
 *   未发生修正时原样返回排序结果，不改任何 `injection_order`。
 */
export function ensureStoryZonePlaceholders<T extends PresetEntryLike>(
  entries: readonly T[],
): { entries: T[]; changed: boolean } {
  const sorted = [...entries].sort((a, b) => orderOf(a) - orderOf(b));
  let changed = false;

  // ① 去重：同号占位只留第一条
  const seen = new Set<StoryZoneNumber>();
  const list: PresetEntryLike[] = [];
  for (const entry of sorted) {
    const zone = storyZoneOf(entry);
    if (zone !== null) {
      if (seen.has(zone)) {
        changed = true;
        continue;
      }
      seen.add(zone);
    }
    list.push(entry);
  }

  // ② 相对顺序：占位槽位不动，按分区号重新落位
  const slots: number[] = [];
  list.forEach((entry, index) => {
    if (storyZoneOf(entry) !== null) slots.push(index);
  });
  const zonesInSlots = slots.map((index) => storyZoneOf(list[index]) as StoryZoneNumber);
  const sortedZones = [...zonesInSlots].sort((a, b) => a - b);
  if (zonesInSlots.some((zone, i) => zone !== sortedZones[i])) {
    changed = true;
    const byZone = new Map(slots.map((index) => [storyZoneOf(list[index]), list[index]]));
    slots.forEach((index, i) => {
      list[index] = byZone.get(sortedZones[i]) as PresetEntryLike;
    });
  }

  // ③ 规范形状
  for (let i = 0; i < list.length; i++) {
    const zone = storyZoneOf(list[i]);
    if (zone !== null && !isCanonicalPlaceholder(list[i], zone)) {
      changed = true;
      list[i] = { ...list[i], ...createStoryZonePlaceholder(zone, orderOf(list[i])) };
    }
  }

  // ④ 补齐缺失分区（位置规则见文件头）
  for (const zone of STORY_ZONE_NUMBERS) {
    if (list.some((entry) => storyZoneOf(entry) === zone)) continue;
    changed = true;
    const placeholder = createStoryZonePlaceholder(zone, 0);
    const lowerIndex = findLastIndex(list, (entry) => {
      const z = storyZoneOf(entry);
      return z !== null && z < zone;
    });
    if (lowerIndex >= 0) {
      list.splice(lowerIndex + 1, 0, placeholder);
      continue;
    }
    const higherIndex = list.findIndex((entry) => {
      const z = storyZoneOf(entry);
      return z !== null && z > zone;
    });
    if (higherIndex >= 0) list.splice(higherIndex, 0, placeholder);
    else list.push(placeholder);
  }

  if (!changed) return { entries: sorted, changed: false };
  return {
    entries: list.map((entry, index) => ({
      ...entry,
      injection_order: (index + 1) * ORDER_STEP,
    })) as T[],
    changed: true,
  };
}

function findLastIndex<T>(list: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (predicate(list[i])) return i;
  return -1;
}

/** 按占位条目切分后的预设结构：普通条目段与分区位置交替出现。 */
export type StoryPresetSegment<T> =
  { kind: 'entries'; entries: T[] } | { kind: 'zone'; zone: StoryZoneNumber };

/**
 * 把生效顺序的条目切成「普通条目段 / 分区位置」序列，供新模式装配在分区位置填入消息（D26）。
 *
 * 普通条目沿用 `assemblePresetContent` 的口径：`enabled === false` 的跳过。
 * 普通条目映射成什么消息角色仍待 Q11，这里不做决定，只交出结构。
 */
export function segmentPresetByStoryZones<T extends PresetEntryLike>(
  entries: readonly T[],
): StoryPresetSegment<T>[] {
  const segments: StoryPresetSegment<T>[] = [];
  let pending: T[] = [];
  for (const entry of entries) {
    const zone = storyZoneOf(entry);
    if (zone !== null) {
      if (pending.length > 0) segments.push({ kind: 'entries', entries: pending });
      pending = [];
      segments.push({ kind: 'zone', zone });
      continue;
    }
    if (entry.enabled === false) continue;
    pending.push(entry);
  }
  if (pending.length > 0) segments.push({ kind: 'entries', entries: pending });
  return segments;
}
