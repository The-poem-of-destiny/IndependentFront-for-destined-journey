/**
 * character-viewer.ts — 角色查看器的展示层纯函数（零副作用，不 mount 可测）
 *
 * 为什么单独一层（照 portrait-messages.ts / cg-gallery.ts / scene-image-view.ts 的先例）:
 * 「这个角色现在该显示哪几行」与「这几行长什么样」是两个不相干的变更理由。
 * 弹窗那边全是样式与滚动容器，而这里的每一条都是**判定**，判错了的症状是
 * 界面上少一行字 —— 那种缺陷在模板表达式里没法钉住。
 *
 * 纯度约束: 无 Vue、无 Pinia、无 I/O、无浏览器全局。
 */
import { clampAffection, getAffectionLabel } from '@engine/affection-system';
import { inferQualityFromStats } from '@engine/quality-inference';
import { getTierConfig } from '@engine/tier-constants';
import { ASSET_TYPES } from '@engine/types';
import type {
  AssetMetaRecord,
  AssetType,
  AuthorityDetail,
  CharacterState,
  ElementDetail,
  InventoryItem,
  LawDetail,
} from '@engine/types';

// ═══════════════════════════════════════════════════════════
// 头部
// ═══════════════════════════════════════════════════════════

export interface SubtitleSegment {
  text: string;
  /** `tier` 那一段要按层级着色；其余是普通文字。**不靠字符串比对认它** */
  kind: 'plain' | 'tier';
}

/**
 * 名字下面那一行 —— `种族 · 身份 · 职业 · 层级 · Lv N`。
 *
 * **空段一律不占位**（不补「未知」也不留两个连着的 `·`）: 这一行是给玩家看的
 * 一句介绍，而 AI 造出来的龙套很可能只有种族。写成「人类 · 未知 · 未知 · 普通」
 * 比少两段更难读。
 *
 * 🔴 **层级名由 `tier` 反查 `TIER_CONFIGS`，`tierName` 只当兜底。** 两个字段会不一致
 * （真机走查当场逮到: 测试存档里 `tier: 5` 配着默认的 `tierName: '普通'`，于是一位
 * Lv.18 的传说贤者自称「普通」）。`tier` 是数值侧的驱动量 —— 资源上限、战斗系数、
 * 属性上限全从它算 —— 所以它才是可信的那一个；`tierName` 是给 AI 写的展示字段，
 * 没人保证会跟着改。
 */
export function buildSubtitleSegments(char: CharacterState): SubtitleSegment[] {
  const tierLabel = getTierConfig(char.tier)?.name ?? char.tierName;
  const raw: SubtitleSegment[] = [
    { text: char.race, kind: 'plain' },
    { text: (char.identity ?? []).join(' / '), kind: 'plain' },
    { text: (char.occupation ?? []).join(' / '), kind: 'plain' },
    { text: tierLabel, kind: 'tier' },
    { text: char.level ? `Lv ${char.level}` : '', kind: 'plain' },
  ];
  return raw
    .map((seg) => ({ ...seg, text: (seg.text ?? '').trim() }))
    .filter((seg) => seg.text !== '');
}

// ═══════════════════════════════════════════════════════════
// 好感度
// ═══════════════════════════════════════════════════════════

export interface AffectionView {
  /** 夹逼后的值（真源可能被 AI 写飞，[-100,100] 之外的条不该冲出轨道） */
  value: number;
  /** 单边填充比例 [0,1] —— 中线是 0，符号决定往哪边长 */
  ratio: number;
  negative: boolean;
  /** 11 级中文标签（affection-system 是唯一出处，这里不另分档） */
  label: string;
}

export function buildAffectionView(raw: number | undefined): AffectionView {
  const value = clampAffection(raw ?? 0);
  return {
    value,
    ratio: Math.min(1, Math.abs(value) / 100),
    negative: value < 0,
    label: getAffectionLabel(value),
  };
}

// ═══════════════════════════════════════════════════════════
// 档案
// ═══════════════════════════════════════════════════════════

export interface ProfileField {
  label: string;
  text: string;
}

/**
 * 档案四行。**空的整行不渲染** —— 一个「外貌: —」的空行既不好看也不传达信息。
 *
 * 🔴 `喜爱` 取的是 `customFields.likes`，不是正式字段: char-gen 把它落在扩展位上
 * （见 char-gen-agent.ts 的 `customFields`），而 M6 那轮升格没带上它。所以这里
 * 必须防 `unknown` —— 扩展位是 `Record<string, any>`，里面完全可能躺着数组或对象，
 * 直接插值会渲染成 `[object Object]`。
 */
export function buildProfileFields(char: CharacterState): ProfileField[] {
  const likes = char.customFields?.likes;
  const raw: ProfileField[] = [
    { label: '性格', text: char.personality ?? '' },
    { label: '喜爱', text: typeof likes === 'string' ? likes : '' },
    { label: '外貌', text: char.appearance ?? '' },
    { label: '着装', text: char.outfit ?? '' },
  ];
  return raw.map((f) => ({ label: f.label, text: f.text.trim() })).filter((f) => f.text !== '');
}

// ═══════════════════════════════════════════════════════════
// 登神长阶
// ═══════════════════════════════════════════════════════════

/** 一条登神条目。**刻意不导出** —— 它只经 {@link AscensionTrack} 露出去，没有第二个调用面 */
interface AscensionEntry {
  name: string;
  description: string;
  effects: string[];
  /** 权能 / 法则 才有的消耗描述；要素没有这一项 */
  cost: string;
}

export interface AscensionTrack {
  key: 'elements' | 'authority' | 'law';
  label: string;
  /** 上限；`0` = 没有明确上限，只报个数 */
  cap: number;
  /** 这一档从哪一级开始拿得到（空态说明用） */
  unlockLevel: string;
  entries: AscensionEntry[];
}

/**
 * 三档的上限与解锁级别。
 *
 * 数字来自 `types.ts` 的 `CharGenResult.ascension`（要素 1-3 / 权能 1 / 法则 1-2）
 * 与三个 Detail 类型的注释（要素 Lv.13-16 / 权能 Lv.17-20 / 法则 Lv.21-24）。
 * 抄在这里是**展示口径**，不是规则真源: 引擎侧唯一会拿它做判断的地方是
 * `canBreakthrough`（只看要素个数），它不读本表。
 */
const ASCENSION_META = [
  { key: 'elements' as const, label: '要素', cap: 3, unlockLevel: 'Lv.13' },
  { key: 'authority' as const, label: '权能', cap: 1, unlockLevel: 'Lv.17' },
  { key: 'law' as const, label: '法则', cap: 2, unlockLevel: 'Lv.21' },
];

function toEntry(d: ElementDetail | AuthorityDetail | LawDetail): AscensionEntry {
  return {
    name: d.name,
    description: d.description ?? '',
    effects: d.effects ?? [],
    cost: 'costDescription' in d ? (d.costDescription ?? '') : '',
  };
}

/**
 * 三条轨道，**恒返回三条**（没开登神也一样）—— 空轨道由界面画成占位格。
 *
 * 🔴 三个字段自 Phase 9 起是**数组**（此前是 Record）。存量存档里可能还躺着旧形状，
 * 而 `Object.values` 对两者都成立、`.map` 只对数组成立 —— 所以这里统一先摊平。
 * 不做这一步的症状不是空白，是 `.map is not a function` 把整个弹窗打成白屏。
 */
export function buildAscensionTracks(char: CharacterState): AscensionTrack[] {
  const asc = char.ascension;
  return ASCENSION_META.map((meta) => {
    const bag = asc?.[meta.key] as unknown;
    const list: unknown[] = Array.isArray(bag)
      ? bag
      : bag && typeof bag === 'object'
        ? Object.values(bag as Record<string, unknown>)
        : [];
    return {
      ...meta,
      entries: list
        .filter((d): d is ElementDetail => Boolean(d) && typeof d === 'object')
        .map(toEntry),
    };
  });
}

/** 有没有任何一档拿到了东西 —— 决定「登神长阶」这一节画不画（空态口径） */
export function hasAnyAscension(tracks: readonly AscensionTrack[]): boolean {
  return tracks.some((t) => t.entries.length > 0);
}

// ═══════════════════════════════════════════════════════════
// 装备 / 背包
// ═══════════════════════════════════════════════════════════

export interface InventorySplit {
  /** 已穿在身上的 —— 判据是 `equippedSlot` 非空（规范 §3，装备是物品的状态） */
  equipped: InventoryItem[];
  /** 背着的 */
  carried: InventoryItem[];
}

/**
 * 这件东西按什么品质着色。
 *
 * 🔴 **有 `rarity` 就用它，别推断** —— `inferQualityFromStats` 的文件头点名了这条：
 * 那个函数封顶在「传说」，拿它去盖掉一件写着「唯一」的物品，界面上是安静地降一级。
 * 推断只服务于没有显式品质的条目（AI 临时造的、旧存档里的）。
 */
export function itemQuality(item: InventoryItem): string {
  return item.rarity ?? inferQualityFromStats(item.stats);
}

export function splitInventory(items: readonly InventoryItem[] | undefined): InventorySplit {
  const equipped: InventoryItem[] = [];
  const carried: InventoryItem[] = [];
  for (const item of items ?? []) {
    if (item.equippedSlot) equipped.push(item);
    else carried.push(item);
  }
  return { equipped, carried };
}

// ═══════════════════════════════════════════════════════════
// 相册
// ═══════════════════════════════════════════════════════════

export interface AlbumTile {
  /** 素材行 id —— 只做 `:key`，**取图仍按 (名字, 类型, 变体) 走渲染缝**（§7.5） */
  id: string;
  type: AssetType;
  /** 无变体行是 `undefined`（= 主图），不是空串 */
  variant?: string;
  /** 格子下面那行小字 */
  caption: string;
}

export interface AlbumGroup {
  type: AssetType;
  tiles: AlbumTile[];
}

/**
 * 这个角色名下的全部素材，按类型分组。
 *
 * 🔴 名字**严格 `===`**（D2）—— 不 trim、不折大小写。相册宽容匹配就会把
 * 「苏婉 」的素材列进「苏婉」的相册里，而那两个在状态层是两个人。
 *
 * 组序走 `ASSET_TYPES`（types.ts 里那条**UI 展示序**）。刻意不用
 * `ASSET_TYPE_FALLBACK_CHAIN` / `ASSET_TYPE_AVATAR_CHAIN`: 那两条是**解析优先级**，
 * asset-resolve 的文件头专门写着两者含义不同、不能共用一个数组。
 *
 * 组内: 主图（无变体）在前，其余按变体名升序、同名按 `createdAt` —— 与
 * `buildAssetIndex` 的 `compareStable` 同一条口径，于是刷新两次顺序不变。
 */
export function buildAlbumGroups(rows: readonly AssetMetaRecord[], name: string): AlbumGroup[] {
  const mine = rows.filter((r) => r.name === name);
  const groups: AlbumGroup[] = [];

  for (const type of ASSET_TYPES) {
    const tiles = mine
      .filter((r) => r.type === type)
      .sort((a, b) => {
        const av = a.variant ?? '';
        const bv = b.variant ?? '';
        // 主图恒在最前（空变体排第一），其余按变体名
        if (av !== bv) return av === '' ? -1 : bv === '' ? 1 : av < bv ? -1 : 1;
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .map<AlbumTile>((r) => ({
        id: r.id,
        type: r.type,
        variant: r.variant === '' ? undefined : r.variant,
        caption: r.variant ? `${r.type} · ${r.variant}` : r.type,
      }));
    if (tiles.length) groups.push({ type, tiles });
  }

  return groups;
}
