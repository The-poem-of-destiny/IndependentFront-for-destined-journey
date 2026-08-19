/**
 * map-dynamics.ts — 地块事实态的纯函数叶（地图 v1.2 / ADR-33，设计 §1 / §3 / §4 / §8）
 *
 * 装什么: 「pack 基线 ⊕ 每存档事实」这套模型的**全部计算**——
 *   · 有效视图 `effectiveTileFacts`（有事实取事实、否则取 pack 基线，§3 末条）
 *   · copy-on-write 播种 `seedTileFacts`（§3）
 *   · 状态挂/除（同名即刷新，裁定 §8-10）
 *   · 发展度进度增减与升降档（含钳位与严格槽位摧毁，裁定 §8-7 / §8-8）
 *   · 建筑落位/更新（最小空槽 + 所有权翻转记档，裁定 §8-8 / §8-9）
 *   · 主建筑解析与更新（`resolveMainBuilding` / `applyMainBuildingUpdate`：独立字段、
 *     不占编号槽、降档免疫、只有 update 一个写面，§F4b·裁定 §8-17~19）
 *   · 编年史记录（FIFO 10 条 + 首访钉扎，裁定 §8-16）
 *   · 按期结算 `settleTileFacts` / `settleMapFacts`（到期 / 周期效果 / 收益，§4）
 *
 * 不装什么: **任何 I/O、任何 Dexie、任何时钟、任何随机、任何 state-manager**。
 *   本模块只吃数据、只吐新数据 —— 入参一个字节都不改（照 `random-event-scheduler.ts`
 *   的规矩：无变化返回 `null`，有变化返回全新对象）。
 *   周期与到期的算术**一律委托 `time-ledger.ts`**（`periodsDueCapped` / `expiryDue`）：
 *   那是零簿记调度的唯一真源，在这里重新推导一遍 `floor((now−anchor)/period)`
 *   就是给同一件事开第二个实现，而两份实现漂移时**不会有任何东西变红**。
 *
 * 🔴 **结算只产结构化事件，不产一个字的散文**（§F5 末条）。`SettlementEvent` 是封闭联合，
 *    中文措辞在 `placeholder-registry`（系统事件卡）与 UI 渲染层 —— 这正是本文件能进
 *    `map-literals-gate.test.ts`（引擎 `map-*.ts` 零中文字面量）的原因。
 *    编年史的自动条目同理：存 `kind` + 参数（建筑名 / 起落档位 / 引发的状态名），不存句子。
 *
 * 🔴 **严格槽位身份**（裁定 §8-8）：`TileFactsEntry.buildings` 的**下标即槽位号**，
 *    `null` = 空槽。本模块任何地方都不许 `filter(Boolean)` / `splice(中间)` ——
 *    压实数组会把后面每一座建筑往前挪一格，而槽位号决定降档时谁被摧毁，
 *    挪一格就是让另一座建筑替它去死，且完全无声。移除建筑 = 把那一格置 `null`；
 *    降档 = 从**尾部**截断。
 *
 * 设计全文: `docs/planning/2026-08-18-map-tile-dynamics-v1.2-design.md`
 * （§1 功能契约 / §3 存储与自愈边界 / §4 时间账本 / §8 16 条裁定）。
 */

import { expiryDue, periodsDueCapped } from './time-ledger';
import type {
  BuildingRecord,
  MapFactsFlags,
  MapTile,
  MapTileInitialBuilding,
  TileFactsEntry,
  TileHistoryEntry,
  TileStatus,
  TileStatusEffect,
} from './types-map';

// ═══════════════════════════════════════════════════════════
// 常量（全部是**机制**取值，不是内容 —— 内容那半在 pack 里）
// ═══════════════════════════════════════════════════════════

/** 发展档下界（废墟就是废墟，不再往下掉档，裁定 §8-7） */
export const MIN_DEV_LEVEL = 1;
/** 发展档上界（槽数 = 档数，故这同时是建筑槽上限） */
export const MAX_DEV_LEVEL = 10;
/** 进度下界：`≤` 它就降一档（降档落点由「进位 +100」推出，恰好 50） */
export const DEV_PROGRESS_MIN = -50;
/** 进度上界：`≥` 它就升一档（升档落点由「进位 −100」推出，恰好 0） */
export const DEV_PROGRESS_MAX = 100;
/** `devProgressPerMonth` 的「月」= 30 天（§F1；周期锚在各状态的 `appliedAtDay`） */
export const DEV_PROGRESS_PERIOD_DAYS = 30;
/** 每地块编年史条数上限（FIFO；首访条目钉住不淘汰，裁定 §8-16） */
export const TILE_HISTORY_LIMIT = 10;

/**
 * 主建筑派生通名的**兜底前缀**（裁定 §8-18）。
 *
 * 🔴 **ASCII 是硬要求**：通名表（`MapPack.mainBuildingNames`）是包数据，缺表时引擎必须
 *    自己说出一个名字，而本文件在零 CJK 结构闸门下（`map-literals-gate.test.ts`）。
 *    与 `map-context.developmentLevelName` 的 `Lv{n}` 同款口径：兜底串看得出是兜底，
 *    而不是伪装成内容的中文默认名。
 */
const MAIN_BUILDING_FALLBACK_PREFIX = 'Seat Lv';

/** 升档后的进度落点（**余量丢弃**，裁定 §8-7「升档清 0」） */
const DEV_PROGRESS_AFTER_LEVEL_UP = 0;
/** 降档后的进度落点（**欠量丢弃**；落 50 = 给衰退一段真实缓冲，裁定 §8-7） */
const DEV_PROGRESS_AFTER_LEVEL_DOWN = 50;

// ═══════════════════════════════════════════════════════════
// 结算事件（封闭联合，零散文）
// ═══════════════════════════════════════════════════════════

/**
 * 结算与结构变更产出的事件。**调用方**（下一波的接线层）负责把它们翻成系统事件卡
 * 与 StatePatch —— 本模块不写句子、不碰钱、不落库。
 *
 * 🔴 `incomeDue.amount` 是**每期**金额、`periods` 是本次补结算的期数
 *    （总额 = `amount × periods`）。刻意不预乘：跨 90 天补三期时，
 *    「每期 50 G × 3 期」在事件卡上比「150 G」更能解释钱是怎么来的。
 */
export type SettlementEvent =
  /** 限时状态到期（永久状态永不出现在这里） */
  | { kind: 'statusExpired'; title: string }
  /** 某条状态的周期效果本次跨了 `periods` 期，每期 `amount` 点进度 */
  | { kind: 'devPeriodApplied'; title: string; amount: number; periods: number }
  /** 一次档位迁移（多档连锁时**逐档**各出一条，与编年史条目一一对应） */
  | { kind: 'levelChanged'; from: number; to: number }
  /** 降档摧毁了最高号槽里的建筑（空槽被吸收时不出此事件） */
  | { kind: 'buildingDestroyed'; building: string; causeStatuses: string[] }
  /**
   * 玩家产业到了入账点（**本模块不改钱**，只报「该入几期」）。
   *
   * `main: true` = 这笔来自**主建筑**（独立字段、不占编号槽，§F4b）。缺席读作槽位建筑
   * —— 加的是一格可选布尔而不是第二个 `kind`：入账这件事两者一模一样，
   * 分成两个变体会让每个消费方都写两支等价分支（而漏写一支不会红，只会少一笔钱的提示）。
   */
  | { kind: 'incomeDue'; building: string; amount: number; periods: number; main?: true };

// ═══════════════════════════════════════════════════════════
// 只读工具
// ═══════════════════════════════════════════════════════════

/**
 * 这块地有没有发展度与建筑槽（裁定 §8-1）。
 *
 * 🔴 判据是**地块本身的通行性**，不是「pack 里写没写 `development`」：
 *    旧包（v1.0/v1.1）全都没有那一格，但它们的陆块当然该有发展度（§6 coercion 那行
 *    「旧包缺字段 → 默认档 1」讲的就是这件事）。反过来，海面上写了个档位也不作数 ——
 *    收下它就等于给每一块海发建筑槽。
 */
export function hasDevelopment(tile: MapTile): boolean {
  return !tile.impassable && !tile.water;
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return MIN_DEV_LEVEL;
  const rounded = Math.trunc(level);
  if (rounded < MIN_DEV_LEVEL) return MIN_DEV_LEVEL;
  if (rounded > MAX_DEV_LEVEL) return MAX_DEV_LEVEL;
  return rounded;
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  if (progress < DEV_PROGRESS_MIN) return DEV_PROGRESS_MIN;
  if (progress > DEV_PROGRESS_MAX) return DEV_PROGRESS_MAX;
  return progress;
}

/** pack 基线档（可通行陆块缺 `development` 时读作最低档，见 `hasDevelopment` 的注释） */
function baselineLevel(tile: MapTile): number {
  return clampLevel(tile.development ?? MIN_DEV_LEVEL);
}

/**
 * 下面四个读取器一律**防御性**：`worldFlags` 那一侧是 `Record<string, any>`，
 * 历史存档 / 手改备份 / 半截迁移都可能送来缺字段的条目。类型说必填不等于运行期真有。
 */
function statusesOf(entry: TileFactsEntry | undefined): TileStatus[] {
  return entry && Array.isArray(entry.statuses) ? entry.statuses : [];
}

function historyOf(entry: TileFactsEntry | undefined): TileHistoryEntry[] {
  return entry && Array.isArray(entry.history) ? entry.history : [];
}

function slotsOf(entry: TileFactsEntry | undefined): (BuildingRecord | null)[] | undefined {
  return entry && Array.isArray(entry.buildings) ? entry.buildings : undefined;
}

function effectsOf(status: TileStatus): TileStatusEffect[] {
  return Array.isArray(status.effects) ? status.effects : [];
}

/** pack 的初始建筑 → 事实记录（**不带** `playerOwned` / `income`，裁定 §8-9） */
function toBuildingRecord(initial: MapTileInitialBuilding): BuildingRecord {
  const record: BuildingRecord = { name: initial.name };
  if (initial.description !== undefined) record.description = initial.description;
  if (initial.ownerFlavor !== undefined) record.ownerFlavor = initial.ownerFlavor;
  return record;
}

/**
 * 把 pack 的初始建筑清单铺进**最小空槽**（顺序即优先级，§F3）。
 * 装不下的（条数 > 起始槽数）落不进去 —— 那是内容错误，由内容仓 verify 门守。
 */
function seedBuildingSlots(tile: MapTile, slots: number): (BuildingRecord | null)[] {
  const out: (BuildingRecord | null)[] = new Array<BuildingRecord | null>(slots).fill(null);
  const initial = Array.isArray(tile.buildings) ? tile.buildings : [];
  for (let i = 0; i < initial.length && i < slots; i++) {
    const row = initial[i];
    if (row && typeof row.name === 'string' && row.name.length > 0) out[i] = toBuildingRecord(row);
  }
  return out;
}

/**
 * 把槽数组补齐到 `slots` 长。
 *
 * 🔴 **只补不裁**（最后一座真建筑之后的尾部空槽才会被剪掉）：视图层裁掉超出档数的建筑，
 *    表现是「界面上这座磨坊不见了，档位一调回来它又回来了」—— 那种不一致会被读成 bug，
 *    而真正该决定谁消失的地方只有降档那一处（`applyDevProgressDelta`）。
 */
function padSlots(source: (BuildingRecord | null)[], slots: number): (BuildingRecord | null)[] {
  let lastOccupied = -1;
  for (let i = 0; i < source.length; i++) {
    if (source[i]) lastOccupied = i;
  }
  const length = Math.max(slots, lastOccupied + 1);
  const out: (BuildingRecord | null)[] = new Array<BuildingRecord | null>(length).fill(null);
  for (let i = 0; i < length; i++) {
    const row = source[i];
    out[i] = row ?? null;
  }
  return out;
}

/** 深一层的条目克隆（三个数组各自换新，`development` 换新对象） */
function cloneEntry(entry: TileFactsEntry): TileFactsEntry {
  const next: TileFactsEntry = {
    statuses: statusesOf(entry).slice(),
    history: historyOf(entry).slice(),
  };
  if (entry.seededAtDay !== undefined) next.seededAtDay = entry.seededAtDay;
  if (entry.development) {
    next.development = { level: entry.development.level, progress: entry.development.progress };
  }
  const slots = slotsOf(entry);
  if (slots) next.buildings = slots.slice();
  // 主建筑是独立字段（不占槽），克隆时单独换一份 —— 漏了它，一次 update 会顺手改到入参
  if (entry.mainBuilding) next.mainBuilding = { ...entry.mainBuilding };
  return next;
}

/**
 * 档位 → 主建筑派生通名。表缺席 / 该行为空 → `Seat Lv{n}`（ASCII 兜底，见常量注释）。
 *
 * 🔴 派生名**随档漂移**（裁定 §8-18）：这正是主建筑的 op 寻址用 `main: true` 而不是
 *    名字的原因 —— 名字是这块地当下的通名，不是稳定键。
 */
function derivedMainBuildingName(names: readonly string[], level: number): string {
  const raw = names[level - 1];
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  return `${MAIN_BUILDING_FALLBACK_PREFIX}${level}`;
}

/**
 * 「这块地的主建筑现在到底是什么样」的唯一答案（v1.2 / §F4b·裁定 §8-17~19）。
 *
 * 三级优先，**先钉住的赢**:
 *   ① 事实里有 `mainBuilding` → 原样取（作者名 / AI 改名 / 授予产业时定格的通名都在这里，
 *      名字**不再随档变**）；
 *   ② pack 给这块地写了作者名（`tile.mainBuilding`）→ 抄成记录（同样钉住，不随档变）；
 *   ③ 都没有 → 按**当前档**从通名表派生（随升降档自然变化）。
 *
 * 无发展度的地块（海/湖/不可通行）恒 `null` —— 主建筑代表的是聚落，海面上没有聚落。
 *
 * 🔴 返回的是**新对象**（只读投影）：把存档里那份事实的引用递出去，调用方改一格就是
 *    绕过写入口改了存档，且不报错。
 */
export function resolveMainBuilding(
  tile: MapTile,
  entry: TileFactsEntry | undefined,
  mainBuildingNames: readonly string[],
  level: number | null,
): BuildingRecord | null {
  if (!hasDevelopment(tile)) return null;

  const pinned = entry?.mainBuilding;
  if (pinned && typeof pinned.name === 'string' && pinned.name.length > 0) {
    const record: BuildingRecord = { ...pinned };
    if (pinned.income) record.income = { ...pinned.income };
    return record;
  }

  const authored = tile.mainBuilding;
  if (authored && typeof authored.name === 'string' && authored.name.length > 0) {
    const record: BuildingRecord = { name: authored.name };
    if (authored.description !== undefined) record.description = authored.description;
    if (authored.ownerFlavor !== undefined) record.ownerFlavor = authored.ownerFlavor;
    return record;
  }

  const effectiveLevel = clampLevel(level ?? baselineLevel(tile));
  return { name: derivedMainBuildingName(mainBuildingNames, effectiveLevel) };
}

// ═══════════════════════════════════════════════════════════
// 有效视图（§3 末条：有事实取事实，否则取 pack 基线）
// ═══════════════════════════════════════════════════════════

/**
 * 「这块地现在到底是什么样」的唯一答案。读侧（MAP_CONTEXT / `$map` / UI 地块详情）
 * 全部走它 —— 各自把「没有事实条目时读 pack」这句话再写一遍，就是漂移的来路。
 */
export interface EffectiveTileFacts {
  /** 这块地有没有发展度（海/湖/不可通行块恒 false，裁定 §8-1） */
  hasDevelopment: boolean;
  /** 当前档；无发展度时 `null` */
  level: number | null;
  /** 当前进度 −50..100；无发展度时 `null` */
  progress: number | null;
  /** 建筑槽数 = 档数；无发展度时 0 */
  slots: number;
  /** 槽数组（下标即槽位号，`null` = 空槽） */
  buildings: (BuildingRecord | null)[];
  /**
   * 主建筑（**不在 `buildings` 里**，§F4b）；无发展度的地块恒 `null`。
   *
   * 🔴 它**永远不为 null**（只要这块地有发展度）：每个可通行陆块恰有一座主建筑
   *    （裁定 §8-17），没有事实、没有作者名时名字按当前档派生。所以消费方判空是在判
   *    「这块地有没有发展度」，不是在判「有没有主建筑」。
   */
  mainBuilding: BuildingRecord | null;
  statuses: TileStatus[];
  history: TileHistoryEntry[];
  /** 事实条目在不在（false = 这块地还完全是 pack 基线） */
  seeded: boolean;
}

/**
 * pack 基线 ⊕ 事实条目 → 有效视图。**只读投影**，不产生也不返回可写事实。
 *
 * `mainBuildingNames` 只喂主建筑的派生通名（§F4b）；不传 = 空表 = 派生名走 ASCII 兜底，
 * 别的字段一格不受影响（旧调用方因此逐字节等于从前）。
 */
export function effectiveTileFacts(
  tile: MapTile,
  entry: TileFactsEntry | undefined,
  mainBuildingNames: readonly string[] = [],
): EffectiveTileFacts {
  const developed = hasDevelopment(tile);
  if (!developed) {
    return {
      hasDevelopment: false,
      level: null,
      progress: null,
      slots: 0,
      buildings: [],
      mainBuilding: null,
      statuses: statusesOf(entry),
      history: historyOf(entry),
      seeded: entry !== undefined,
    };
  }

  const level = entry?.development ? clampLevel(entry.development.level) : baselineLevel(tile);
  const progress = entry?.development ? clampProgress(entry.development.progress) : 0;
  const stored = slotsOf(entry);
  const source = stored ?? seedBuildingSlots(tile, level);

  return {
    hasDevelopment: true,
    level,
    progress,
    slots: level,
    buildings: padSlots(source, level),
    mainBuilding: resolveMainBuilding(tile, entry, mainBuildingNames, level),
    statuses: statusesOf(entry),
    history: historyOf(entry),
    seeded: entry !== undefined,
  };
}

// ═══════════════════════════════════════════════════════════
// 播种（copy-on-write，§3）
// ═══════════════════════════════════════════════════════════

/**
 * 以**当时的** pack 基线为种子创建事实条目（首次偏离基线时由调用方触发）。
 *
 * 🔴 播种**不写编年史**：初始建筑不是「落成」事件，它们是这块地本来就有的东西。
 *    给它们补一条 `built` 会让每块地的编年史第一屏全是与玩家无关的记录，
 *    而 FIFO 只有 10 格。
 * 🔴 **包里没声明起始档就不物化发展面**（设计 §5 那条「v1.0/v1.1 旧包不会凭空长出 Lv1」）：
 *    播种的触发点不止是发展度 op —— 光是走上一块地（首访记档）就会播种，而
 *    `hasDevelopment()` 对**任何**可通行陆块都为真。照它物化，旧包每一块走过的地都会
 *    在 MAP_CONTEXT / `$map` / 界面上凭空长出「发展 Lv1 · 主建筑 Seat Lv1 · 空槽 1」——
 *    那不是事实，是引擎兜底值被当成了内容（还把 ASCII 兜底串漏进了 AI 上下文）。
 *    真有 op 碰发展面时再迟物化：`applyDevProgressDelta` / `applyBuildingAdd` /
 *    `applyMainBuildingUpdate` 三处都带 `baselineLevel` 兜底，缺这一格照样能跑。
 */
export function seedTileFacts(tile: MapTile, day: number): TileFactsEntry {
  const entry: TileFactsEntry = { seededAtDay: day, statuses: [], history: [] };
  if (hasDevelopment(tile) && tile.development !== undefined) {
    const level = baselineLevel(tile);
    entry.development = { level, progress: 0 };
    entry.buildings = seedBuildingSlots(tile, level);
  }
  return entry;
}

/**
 * 事实条目还没有发展面时，以 **pack 基线**就地物化一份（发展档 + 初始建筑槽）。
 *
 * 播种刻意不物化发展面（见 `seedTileFacts`），所以任何**真的碰到发展面**的写操作都得
 * 自己补这一步。三处写面（进度增量 / 建筑落位 / 主建筑更新）用的是同一个 `baselineLevel`
 * 兜底口径 —— 分叉的表现是同一块地经不同 op 物化出不同的起始档，且完全无声。
 *
 * 已经有发展面 → 原样返回（不克隆，调用方据此照常走 copy-on-write）。
 */
function materializeDevelopment(entry: TileFactsEntry, tile: MapTile): TileFactsEntry {
  if (entry.development) return entry;
  const level = baselineLevel(tile);
  const next = cloneEntry(entry);
  next.development = { level, progress: 0 };
  next.buildings = padSlots(slotsOf(entry) ?? seedBuildingSlots(tile, level), level);
  return next;
}

// ═══════════════════════════════════════════════════════════
// 状态（裁定 §8-10 同名即刷新）
// ═══════════════════════════════════════════════════════════

/**
 * 挂一条状态。**同 `title` 即原地刷新**：整条覆盖（描述/效果/时长全换、到期从新的
 * `appliedAtDay` 重算、永久↔限时可互转），槽位不变、不产生第二条同名记录。
 *
 * 这条幂等性是给 AI 复读兜底的：「洪水又持续了 30 天」正是重叙同一件事的语义，
 * 追加成两条会让同一场洪水的周期效果**翻倍**结算。
 */
export function applyTileStatusAdd(entry: TileFactsEntry, status: TileStatus): TileFactsEntry {
  const next = cloneEntry(entry);
  const fresh: TileStatus = { ...status, effects: effectsOf(status).map((e) => ({ ...e })) };
  const index = next.statuses.findIndex((s) => s.title === fresh.title);
  if (index >= 0) next.statuses[index] = fresh;
  else next.statuses.push(fresh);
  return next;
}

/**
 * 按 `title` **精确**移除一条状态（永久状态的唯一出口，裁定 §8-1）。
 * 找不到 → `null`（无变化）——「AI 移除一条根本不在的状态」是常见复读，不该产生写入。
 */
export function applyTileStatusRemove(entry: TileFactsEntry, title: string): TileFactsEntry | null {
  const index = statusesOf(entry).findIndex((s) => s.title === title);
  if (index < 0) return null;
  const next = cloneEntry(entry);
  next.statuses.splice(index, 1);
  return next;
}

// ═══════════════════════════════════════════════════════════
// 编年史（裁定 §8-16 FIFO 10 + 首访钉扎）
// ═══════════════════════════════════════════════════════════

/**
 * 追加一条编年史并施加保留策略：上限 {@link TILE_HISTORY_LIMIT} 条，
 * **首访条目钉住不淘汰**（FIFO 只作用于其余 9 格）。
 *
 * 🔴 钉扎不是「首访排最前所以最后被淘汰」—— 纯 FIFO 下它恰恰是**最先**被淘汰的那条
 *    （它天然是最老的一条）。所以淘汰时是「找最老的**非首访**条目」，不是 `shift()`。
 */
export function recordTileHistory(
  entry: TileFactsEntry,
  newEntry: TileHistoryEntry,
): TileFactsEntry {
  const next = cloneEntry(entry);
  next.history.push({ ...newEntry });
  while (next.history.length > TILE_HISTORY_LIMIT) {
    const victim = next.history.findIndex((h) => h.kind !== 'firstVisit');
    if (victim < 0) break;
    next.history.splice(victim, 1);
  }
  return next;
}

/**
 * 记一次玩家首访。**只记一次** —— 已有首访条目时返回 `null`（无变化）。
 * 首访是这块地编年史的锚点，重复记录会把钉扎位占掉两格。
 */
export function recordFirstVisit(entry: TileFactsEntry, day: number): TileFactsEntry | null {
  if (historyOf(entry).some((h) => h.kind === 'firstVisit')) return null;
  return recordTileHistory(entry, { day, kind: 'firstVisit' });
}

// ═══════════════════════════════════════════════════════════
// 发展度进度与升降档（裁定 §8-7 / §8-8）
// ═══════════════════════════════════════════════════════════

/** 各 op / 结算给进度变化附带的上下文（都会落进对应的自动编年史条目） */
export interface TileDevDeltaOptions {
  /**
   * 引发本次变化的**负面状态名**（裁定 §8-15②：Code 侧结算引发的摧毁自动引用它们）。
   * 一次性 op 通常不带 —— 那种摧毁的缘由走 `reason`。
   */
  causeStatuses?: string[];
  /** AI 在 op 上附的缘由（裁定 §8-15①），原样落进自动条目 */
  reason?: string;
}

/** 进度变化的产物：新条目 + 结构化事件（无变化时整个结果为 `null`） */
export interface TileDevDeltaResult {
  entry: TileFactsEntry;
  events: SettlementEvent[];
}

/**
 * 给发展度进度加一个增量，并结算由此产生的档位迁移。
 *
 * 算术（裁定 §8-7）：
 *   · `progress ≥ 100` → 升一档、进度**清 0**（余量丢弃）
 *   · `progress ≤ −50` → 降一档、进度**落 50**（欠量丢弃）
 *
 * 🔴 **一次增量至多跨一个档位边界**（裁定 §8-7，明确否掉了「余量向上进位」那个方案）：
 *    档 3 收 +250 落在档 4 进度 0，**不是**档 5 余 50。理由是叙事时间 ——
 *    让一次 op 连跳数档，等于允许「一条 dispatcher 补丁把一座村庄写成大都会」，
 *    而剧烈的兴衰应当占用回合。要走多档就得多来几次（周期效果天然是逐期来的，
 *    见 `settleTileFacts`：N 期就是 N 次调用，所以它照样能一路走下去）。
 *
 * 钳位（两端各一）：档 1 的进度下钳在 −50（废墟不再往下掉），档 10 的进度上钳在 100
 * （溢出丢弃）。钳住之后若什么都没变，返回 `null`。
 *
 * 🔴 **降档 = 移除最高号槽**（严格槽位身份，裁定 §8-8）：槽里有建筑就摧毁它（玩家产业
 *    **不豁免**），空槽也照样被吸收。这里绝不「挑一座最不重要的建筑毁掉」——
 *    那需要一个价值判断，而任何价值判断都会在某次真机里显得离谱。
 *
 * 无发展度的地块（海/湖/不可通行）恒返回 `null`：状态照挂、flavor 照展示，机制面静默无效。
 */
export function applyDevProgressDelta(
  entry: TileFactsEntry,
  tile: MapTile,
  amount: number,
  day: number,
  options: TileDevDeltaOptions = {},
): TileDevDeltaResult | null {
  if (!hasDevelopment(tile)) return null;
  if (!Number.isFinite(amount) || amount === 0) return null;

  const startLevel = entry.development ? clampLevel(entry.development.level) : baselineLevel(tile);
  const startProgress = entry.development ? clampProgress(entry.development.progress) : 0;

  let level = startLevel;
  let progress = startProgress + amount;
  let slots = padSlots(slotsOf(entry) ?? seedBuildingSlots(tile, startLevel), startLevel);

  const events: SettlementEvent[] = [];
  const pending: TileHistoryEntry[] = [];
  const causeStatuses = options.causeStatuses ?? [];

  if (progress >= DEV_PROGRESS_MAX) {
    if (level >= MAX_DEV_LEVEL) {
      progress = DEV_PROGRESS_MAX;
    } else {
      const from = level;
      level += 1;
      progress = DEV_PROGRESS_AFTER_LEVEL_UP;
      slots = slots.concat([null]);
      events.push({ kind: 'levelChanged', from, to: level });
      pending.push(buildLevelHistory(day, from, level, options));
    }
  } else if (progress <= DEV_PROGRESS_MIN) {
    if (level <= MIN_DEV_LEVEL) {
      progress = DEV_PROGRESS_MIN;
    } else {
      const from = level;
      level -= 1;
      progress = DEV_PROGRESS_AFTER_LEVEL_DOWN;
      events.push({ kind: 'levelChanged', from, to: level });
      pending.push(buildLevelHistory(day, from, level, options));

      // 严格槽位：永远是旧档的**最高号槽**（下标 from−1），不挑不选
      const doomed = slots[from - 1] ?? null;
      slots = slots.slice(0, from - 1);
      if (doomed) {
        events.push({ kind: 'buildingDestroyed', building: doomed.name, causeStatuses });
        const record: TileHistoryEntry = { day, kind: 'destroyed', building: doomed.name };
        if (causeStatuses.length > 0) record.causeStatuses = causeStatuses.slice();
        if (options.reason !== undefined) record.reason = options.reason;
        pending.push(record);
      }
    }
  }

  const materialized = entry.development === undefined;
  if (!materialized && level === startLevel && progress === startProgress) return null;

  let next = cloneEntry(entry);
  next.development = { level, progress };
  next.buildings = padSlots(slots, level);
  for (const record of pending) next = recordTileHistory(next, record);
  return { entry: next, events };
}

function buildLevelHistory(
  day: number,
  from: number,
  to: number,
  options: TileDevDeltaOptions,
): TileHistoryEntry {
  const record: TileHistoryEntry = {
    day,
    kind: to > from ? 'levelUp' : 'levelDown',
    fromLevel: from,
    toLevel: to,
  };
  const causes = options.causeStatuses ?? [];
  if (causes.length > 0) record.causeStatuses = causes.slice();
  if (options.reason !== undefined) record.reason = options.reason;
  return record;
}

// ═══════════════════════════════════════════════════════════
// 建筑（裁定 §8-8 最小空槽 / §8-9 所有权只经叙事）
// ═══════════════════════════════════════════════════════════

/** 建筑落位的结果。满槽是**明确的拒绝**，不是静默丢弃 —— 调用方据此 warn。 */
export type BuildingAddResult =
  | { ok: true; entry: TileFactsEntry; slot: number; updated: boolean }
  | { ok: false; reason: 'noDevelopment' | 'noEmptySlot' };

/** `applyBuildingUpdate` 的补丁面：`name` 是逻辑键，**不可改**（改名 = 换一座建筑） */
export type BuildingPatch = Partial<Omit<BuildingRecord, 'name'>>;

/**
 * 记一座新建筑，自动落进**当前档数以内的最小空槽**（老建筑天然住在更安全的低位槽）。
 *
 * · 同名已存在 → **当更新处理**（AI 复读「城里有座磨坊」不该长出第二座磨坊）；
 * · 槽全满 → `ok:false` + `noEmptySlot`（调用方 warn，不静默吞）；
 * · 无发展度（海/湖/不可通行块）→ `ok:false` + `noDevelopment`。
 *
 * 🔴 判据是**地块的通行性**（`hasDevelopment`），不是「条目里有没有 `development`」——
 *    与 `applyDevProgressDelta` / `applyMainBuildingUpdate` 同一套 `baselineLevel` 兜底。
 *    照条目判的表现是：一个在旧包（或换包前那块地还是海）时播下的事实条目，读侧明明显示
 *    着空槽，`tile_building_add` 却报 `noDevelopment` —— 一条永远修不好的静默拒绝。
 */
export function applyBuildingAdd(
  entry: TileFactsEntry,
  tile: MapTile,
  record: BuildingRecord,
  day: number,
  options: TileDevDeltaOptions = {},
): BuildingAddResult {
  if (!hasDevelopment(tile)) return { ok: false, reason: 'noDevelopment' };
  // 条目还没有发展面（旧包地块被首访播种过 / 换包后名字落到了陆块）→ 以 pack 基线迟物化
  const base = materializeDevelopment(entry, tile);
  const slots = clampLevel(base.development?.level ?? baselineLevel(tile));

  const current = padSlots(slotsOf(base) ?? [], slots);
  const existing = current.findIndex((row) => row?.name === record.name);
  if (existing >= 0) {
    const patch: BuildingPatch = {};
    if (record.description !== undefined) patch.description = record.description;
    if (record.ownerFlavor !== undefined) patch.ownerFlavor = record.ownerFlavor;
    if (record.playerOwned !== undefined) patch.playerOwned = record.playerOwned;
    if (record.income !== undefined) patch.income = record.income;
    // `?? base` 兜的是「刚在槽里找到、更新却说找不到」这条不可能路径 ——
    // 真出现时也只是这一次更新没生效，不该把一次合法的 add 报成满槽
    const updated = applyBuildingUpdate(base, record.name, patch, day, options) ?? base;
    return { ok: true, entry: updated, slot: existing, updated: true };
  }

  let slot = -1;
  for (let i = 0; i < slots; i++) {
    if (!current[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) return { ok: false, reason: 'noEmptySlot' };

  const next = cloneEntry(base);
  const placed = current.slice();
  placed[slot] = { ...record };
  next.buildings = placed;

  const history: TileHistoryEntry = { day, kind: 'built', building: record.name };
  if (options.reason !== undefined) history.reason = options.reason;
  let withHistory = recordTileHistory(next, history);
  if (record.playerOwned === true) {
    withHistory = recordTileHistory(withHistory, { day, kind: 'acquired', building: record.name });
  }
  return { ok: true, entry: withHistory, slot, updated: false };
}

/**
 * 按名字改一座建筑的归属/描述/收益。找不到 → `null`（无变化）。
 *
 * 🔴 `playerOwned` 由非真翻成 `true` 时记一条 `acquired` 编年史（裁定 §8-14 第六类）——
 *    「玩家取得产业」是这套系统里唯一有机制后果的所有权事件，它必须留下痕迹。
 *    反向（产业易手出去）不记：v1.2 没有易手模拟，那只是 flavor 改字。
 * 🔴 补丁里 `undefined` = **没提这一格**（保持原值）。清空某一格请显式传空串/`false`。
 */
export function applyBuildingUpdate(
  entry: TileFactsEntry,
  name: string,
  patch: BuildingPatch,
  day: number,
  options: TileDevDeltaOptions = {},
): TileFactsEntry | null {
  const slots = slotsOf(entry);
  if (!slots) return null;
  const index = slots.findIndex((row) => row?.name === name);
  if (index < 0) return null;
  const before = slots[index];
  if (!before) return null;

  const merged: BuildingRecord = { ...before };
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.ownerFlavor !== undefined) merged.ownerFlavor = patch.ownerFlavor;
  if (patch.playerOwned !== undefined) merged.playerOwned = patch.playerOwned;
  if (patch.income !== undefined) merged.income = { ...patch.income };

  const next = cloneEntry(entry);
  const updatedSlots = slots.slice();
  updatedSlots[index] = merged;
  next.buildings = updatedSlots;

  if (before.playerOwned !== true && merged.playerOwned === true) {
    const history: TileHistoryEntry = { day, kind: 'acquired', building: merged.name };
    if (options.reason !== undefined) history.reason = options.reason;
    return recordTileHistory(next, history);
  }
  return next;
}

// ═══════════════════════════════════════════════════════════
// 主建筑（§F4b / 裁定 §8-17~19）
// ═══════════════════════════════════════════════════════════

/**
 * 主建筑的补丁面。与 `BuildingPatch` 的唯一区别是**允许改名** ——
 * 主建筑的名字不是逻辑键（它随档漂移，故 op 按 `main: true` 寻址，裁定 §8-19），
 * 所以改名是合法的一次「改风格」，而槽位建筑改名等于换一座建筑。
 */
export type MainBuildingPatch = Partial<BuildingRecord>;

/** `applyMainBuildingUpdate` 的选项：在 op 上下文之外多一张派生通名表 */
export interface MainBuildingUpdateOptions extends TileDevDeltaOptions {
  /** pack 的 `mainBuildingNames`；**只在事实里还没有名字时**用得上（派生出要钉住的那个名字） */
  mainBuildingNames?: readonly string[];
}

/**
 * 改主建筑的名字/描述/归属/收益（§F4b）。这是主建筑**唯一的写面** ——
 * 没有 add（每块地恒有一座），也没有 remove（不可摧毁不可移除，裁定 §8-17）。
 *
 * 🔴 一次成功的 update 会把有效记录**物化进事实**，于是**名字自此钉住**、不再随档漂移
 *    （裁定 §8-18）。这就是播种（`seedTileFacts`）刻意不物化它的原因：那会让每个存档在
 *    首次记档那一天把当时的通名永久焊死，此后升到都会仍叫「营地」，且完全无声。
 * 🔴 `playerOwned` 由非真翻成 `true` 记一条 `acquired`（裁定 §8-19，与槽位建筑同一套语义）；
 *    有效名真的变了才记 `renamed`（同名重写不记 —— AI 复读不该刷屏 10 格 FIFO）。
 * 🔴 无发展度的地块（海/湖/不可通行）恒 `null`：那里根本没有主建筑。
 *    补丁里一格都没提时同样 `null`（无变化）—— 空 update 不该把名字钉住。
 */
export function applyMainBuildingUpdate(
  entry: TileFactsEntry,
  tile: MapTile,
  patch: MainBuildingPatch,
  day: number,
  options: MainBuildingUpdateOptions = {},
): TileFactsEntry | null {
  if (!hasDevelopment(tile)) return null;

  const renamed = typeof patch.name === 'string' ? patch.name.trim() : '';
  const touches =
    renamed.length > 0 ||
    patch.description !== undefined ||
    patch.ownerFlavor !== undefined ||
    patch.playerOwned !== undefined ||
    patch.income !== undefined;
  if (!touches) return null;

  const level = entry.development ? clampLevel(entry.development.level) : baselineLevel(tile);
  const before = resolveMainBuilding(tile, entry, options.mainBuildingNames ?? [], level);
  // `hasDevelopment` 已经判过，这里是不可达分支；返回 null 而不是造一座无名主建筑
  if (before === null) return null;

  const merged: BuildingRecord = { ...before };
  if (renamed.length > 0) merged.name = renamed;
  if (patch.description !== undefined) merged.description = patch.description;
  if (patch.ownerFlavor !== undefined) merged.ownerFlavor = patch.ownerFlavor;
  if (patch.playerOwned !== undefined) merged.playerOwned = patch.playerOwned;
  if (patch.income !== undefined) merged.income = { ...patch.income };

  let next = cloneEntry(entry);
  next.mainBuilding = merged;

  if (merged.name !== before.name) {
    const history: TileHistoryEntry = { day, kind: 'renamed', building: merged.name };
    if (options.reason !== undefined) history.reason = options.reason;
    next = recordTileHistory(next, history);
  }
  if (before.playerOwned !== true && merged.playerOwned === true) {
    const history: TileHistoryEntry = { day, kind: 'acquired', building: merged.name };
    if (options.reason !== undefined) history.reason = options.reason;
    next = recordTileHistory(next, history);
  }
  return next;
}

// ═══════════════════════════════════════════════════════════
// 结算（§4 集中调度、分散结算）
// ═══════════════════════════════════════════════════════════

/** 单地块结算的产物 */
export interface TileSettlementResult {
  entry: TileFactsEntry;
  events: SettlementEvent[];
}

/** 全图结算的一条事件（带地块名，调用方据此定位事件卡与补丁） */
export interface MapSettlementEvent {
  tile: string;
  event: SettlementEvent;
}

/** 全图结算的产物 */
export interface MapSettlementResult {
  facts: MapFactsFlags;
  events: MapSettlementEvent[];
}

/**
 * 把一个地块从 `prevDay` 结算到 `nextDay`（半开区间 `(prevDay, nextDay]`）。
 * 无事发生 → `null`。
 *
 * 三件事，按这个顺序：
 *   1. **周期效果**（`devProgressPerMonth`）—— 期数由 `periodsDueCapped` 算，
 *      跨 90 天就是 3 期；途中可连锁降档并摧毁最高号槽的建筑。
 *   2. **到期移除** —— `durationDays >= 0` 且到期日 `≤ nextDay` 的状态被摘掉。
 *   3. **玩家产业收益** —— 只报「该入几期」，**一分钱都不在这里动**（纯函数）。
 *
 * 🔴 **中途到期的状态仍要贡献它到期前的周期节拍**（这是顺序 1 在 2 之前的原因）：
 *    第 0 天挂上、每月 −2、时长 45 天的洪水，在一次跨 90 天的前进里应该结算
 *    **1 期**（第 30 天那一次），而不是 0 期（「反正它已经没了」）也不是 3 期
 *    （「反正它挂过」）。做法是把它的期数窗口右端压到 `min(nextDay, 到期日)`。
 *
 * 🔴 摧毁引用的 `causeStatuses` 取**本次窗口内在场的负面状态**（有 `amount < 0` 的
 *    `devProgressPerMonth`）—— 已经到期的那条也算：它正是把进度压下去的那只手。
 */
export function settleTileFacts(
  entry: TileFactsEntry,
  tile: MapTile,
  prevDay: number,
  nextDay: number,
): TileSettlementResult | null {
  if (!Number.isFinite(prevDay) || !Number.isFinite(nextDay)) return null;
  if (nextDay <= prevDay) return null;

  const statuses = statusesOf(entry);
  const events: SettlementEvent[] = [];
  const causeStatuses = statuses
    .filter((s) => effectsOf(s).some((e) => e.kind === 'devProgressPerMonth' && e.amount < 0))
    .map((s) => s.title);

  let current = entry;
  let changed = false;

  // ── 1. 周期效果 ──
  if (hasDevelopment(tile)) {
    for (const status of statuses) {
      const expires = status.durationDays >= 0;
      const expired = expires && expiryDue(status.appliedAtDay, status.durationDays, nextDay);
      const windowEnd = expired
        ? Math.min(nextDay, status.appliedAtDay + status.durationDays)
        : nextDay;

      for (const effect of effectsOf(status)) {
        if (effect.kind !== 'devProgressPerMonth') continue;
        if (!Number.isFinite(effect.amount) || effect.amount === 0) continue;
        const periods = periodsDueCapped(
          status.appliedAtDay,
          DEV_PROGRESS_PERIOD_DAYS,
          prevDay,
          windowEnd,
        );
        if (periods <= 0) continue;

        events.push({
          kind: 'devPeriodApplied',
          title: status.title,
          amount: effect.amount,
          periods,
        });
        // 🔴 **逐期结算，不合并成一次大增量**：单次增量至多跨一个档位边界（§8-7），
        //    合并会让一场跨三年的洪水只掉一档就停住。期数由 periodsDueCapped 兜着上限，
        //    所以这个循环有硬边界。事件面：devPeriodApplied 仍是聚合的一条，
        //    而每一次真的跨过边界都各出一条 levelChanged / buildingDestroyed。
        for (let tick = 0; tick < periods; tick++) {
          const applied = applyDevProgressDelta(current, tile, effect.amount, nextDay, {
            causeStatuses,
          });
          if (!applied) continue;
          current = applied.entry;
          events.push(...applied.events);
          changed = true;
        }
      }
    }
  }

  // ── 2. 到期移除 ──
  const survivors: TileStatus[] = [];
  const expiredTitles: string[] = [];
  for (const status of statusesOf(current)) {
    if (status.durationDays >= 0 && expiryDue(status.appliedAtDay, status.durationDays, nextDay)) {
      expiredTitles.push(status.title);
      continue;
    }
    survivors.push(status);
  }
  if (expiredTitles.length > 0) {
    const next = cloneEntry(current);
    next.statuses = survivors;
    current = next;
    changed = true;
    for (const title of expiredTitles) events.push({ kind: 'statusExpired', title });
  }

  // ── 3. 玩家产业收益（只报，不动钱） ──
  // 🔴 主建筑**也在这条扫描线上**（§F4b：除降档免疫外一切如常）：它住在独立字段而不是
  //    槽数组里，漏扫的表现是「王冠级产业静默不入账」—— 没有任何东西会变红。
  //    排在槽位之前是因为它是这块地的座席，事件卡上先说主建筑读起来更顺。
  const earners: { record: BuildingRecord; main: boolean }[] = [];
  if (current.mainBuilding) earners.push({ record: current.mainBuilding, main: true });
  for (const building of slotsOf(current) ?? []) {
    if (building) earners.push({ record: building, main: false });
  }

  for (const { record, main } of earners) {
    if (record.playerOwned !== true) continue;
    const income = record.income;
    if (!income) continue;
    if (!Number.isFinite(income.amount) || income.amount === 0) continue;
    const periods = periodsDueCapped(income.anchorDay, income.periodDays, prevDay, nextDay);
    if (periods <= 0) continue;
    events.push(
      main
        ? { kind: 'incomeDue', building: record.name, amount: income.amount, periods, main: true }
        : { kind: 'incomeDue', building: record.name, amount: income.amount, periods },
    );
  }

  if (!changed && events.length === 0) return null;
  return { entry: current, events };
}

/**
 * 全图结算。逐个事实条目跑 {@link settleTileFacts}；无事发生 → `null`。
 *
 * 🔴 **休眠地块整块跳过**（§3）：`resolveTile` 返回 `undefined` = 这个名字不在现行包里
 *    （换了地图 / 内容包卸载）。休眠块**不到期、不入账、不掉档** —— 时间对它冻结。
 *    换成「照常结算」的话，一次换包再换回来，那座玩家酒馆会一次性补上几十期收益，
 *    或者一场早就该结束的洪水把整座城压到废墟 —— 而这两件事都发生在玩家看不见的地方。
 */
export function settleMapFacts(
  facts: MapFactsFlags,
  resolveTile: (name: string) => MapTile | undefined,
  prevDay: number,
  nextDay: number,
): MapSettlementResult | null {
  const tiles = facts.tiles;
  if (!tiles || typeof tiles !== 'object') return null;

  const events: MapSettlementEvent[] = [];
  let nextTiles: Record<string, TileFactsEntry> | null = null;

  for (const [name, entry] of Object.entries(tiles)) {
    if (!entry) continue;
    const tile = resolveTile(name);
    if (!tile) continue; // 休眠：时间对它冻结
    const settled = settleTileFacts(entry, tile, prevDay, nextDay);
    if (!settled) continue;
    for (const event of settled.events) events.push({ tile: name, event });
    if (settled.entry !== entry) {
      if (!nextTiles) nextTiles = { ...tiles };
      nextTiles[name] = settled.entry;
    }
  }

  if (!nextTiles && events.length === 0) return null;
  return { facts: { ...facts, tiles: nextTiles ?? tiles }, events };
}
