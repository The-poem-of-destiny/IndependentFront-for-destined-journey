/**
 * map-weather.ts — 天气的确定性采样（地图系统 v1 / 设计 §7 · 裁定 §12-6）
 *
 * 装什么: `weatherAt(pack, zoneId, seasonKey, gameDay, saveSeed)` —— 从包的气候表里**纯采样**
 *         出一个天气标签；外加 `weatherZoneOfTile(pack, tileId)`（「这块地属于哪个气候区」的
 *         唯一判定 —— `worldFlags.map.weatherStamp.zoneId` 就是它的产物）。
 * 不装什么: 任何 I/O、任何存储、任何写入。「跨天 或 换气候区 才重断言」那条判据、以及往
 *           `variables.sys.天气` 的写入，都在接线层（`state-manager` 的 `applyTimeAdvance`）；
 *           本模块只回答「那一天、那一区的天气是什么」这一个问题。
 *
 * 🔴 **零存储、零时钟、零 `Math.random`**（§7）：种子 = `(saveSeed, zoneId, gameDay)`，
 *    同三元组永远同结果 —— 快照回退 / 重发天然一致（整段理由见 `ejs-rng.ts` 文件头：真随机会让
 *    同一个存档点重放产出不同的世界，且 debug loop 里没法复现）。随机数因此**复用**
 *    `createEjsRng`（同一套 FNV-1a + xorshift32），不另造一条序列：两条序列意味着两处要各自
 *    保证可复现，而其中一处永远不会有人手工验。`map-weather.test.ts` 里有结构闸门扫本文件的
 *    源码文本，把 `Math.random` 与时钟钉死。
 *
 * 🔴 **季节键是参数，不是本模块认识的概念**（§3.4-1）：历法是内容（12 具名月 / 四季），键由
 *    调用方从 `getSeason()` 取来**原样**传进来，本模块只做一次 `table[seasonKey]` 查表。在这里
 *    写下任何一个季节名，换一版历法就静默失效 —— 结构闸门 `map-literals-gate.test.ts` 连带钉死
 *    这条（本文件里不许出现中文字面量）。同理，气候区 / 天气词汇一个字都不认识。
 *
 * 🔴 **认不出就回退，绝不猜、也绝不抛**（口径照 `map-pack.ts`：包是第三方可编辑、可热替换的
 *    数据）。但回退到底仍然可能是「整份包里没有一张可用天气表」—— 那时返回 `null`，让接线层
 *    **保持 `sys.天气` 原值不动**（与落位失败时保 `lastTileId` 同款处置）。这里绝不能凭空造一个
 *    标签串：造出来的词不在包词汇里，`image-world-tags` 那张精确匹配表不会命中（少一个出图
 *    标签），而 `<tp>` 栏会把它当真话讲给玩家。
 *
 * 设计全文: `docs/planning/2026-08-11-map-system-v1-integration.md` §7（天气）+ §3.4（换图零改码）。
 */

import { createEjsRng } from './ejs-rng';
import type { ClimateProfile, MapPack, WeatherResult, WeatherWeight } from './types-map';

// ═══════════════════════════════════════════════════════════
// 气候区（落位 → 气候区的唯一判定）
// ═══════════════════════════════════════════════════════════

/**
 * 这块地属于哪个气候区（= 中层 id）。`null` = 这块地不在任何中层里，或地块本身查不到。
 *
 * 🔴 气候区粒度**是中层**（§7）：接线层拿它当 `weatherStamp.zoneId`，「换气候区就重掷」那条
 *    判据比的正是这个串。所以它必须是**稳定键**而不是显示名 —— 名字随图改，键不改。
 *
 * 🔴 **不校验中层是否真的在 `pack.midTiers` 里**：悬空的 `midTierId` 仍然是一个稳定的戳，
 *    把它打回 `null` 会让两块本属不同区的地共用同一个「无区」戳，于是跨区移动**不重掷天气**。
 *    悬空区在 `weatherAt` 里自有回退（见 `resolveClimateProfile`），两条路径不必在这里合并。
 */
export function weatherZoneOfTile(pack: MapPack, tileId: number): string | null {
  if (!Number.isFinite(tileId)) return null;
  const tile = pack.tiles.find((row) => row.id === tileId);
  if (!tile) return null;
  const zoneId = tile.midTierId;
  return typeof zoneId === 'string' && zoneId.length > 0 ? zoneId : null;
}

// ═══════════════════════════════════════════════════════════
// 采样入口
// ═══════════════════════════════════════════════════════════

/**
 * 某一天、某一区的天气。
 *
 * 解析顺序（每一级只在**上一级拿不到**时才往下走）：
 *   1. `zoneId`（中层 id）→ 该中层的 `climateId` → `pack.climates[climateId]`
 *   2. 拿不到（中层不存在 / 没指定气候 / 气候 id 悬空）→ `pack.climates` 的**第一个**画像
 *   3. 一个画像都没有 → `null`
 *   4. 画像里 `table[seasonKey]` → 没有可用行时取该画像里**第一张可用的**季节表
 *   5. 一张可用表都没有 → `null`
 *
 * @param seasonKey 调用方从 `getSeason()` 取来的季节键（本模块不认识季节，见文件头）
 * @param gameDay   游戏日（整数；非整数取下整 —— 天气是**按天**的量，同一天必须同结果）
 * @param saveSeed  按存档隔离的种子串（通常是 saveId）—— 两个存档同日同区不该同天气
 *
 * 🔴 第 2 级刻意是「**第一个**画像」而不是「第一个可用画像」：回退目标只取决于包本身，
 *    不取决于「哪一个恰好有 `seasonKey` 那一季」。代价是一份把空画像写在最前面的包会让全部
 *    回退天气变成 `null`（那是坏包，且 `null` 是显眼的「没天气」而不是错天气）。
 */
export function weatherAt(
  pack: MapPack,
  zoneId: string,
  seasonKey: string,
  gameDay: number,
  saveSeed: string,
): WeatherResult | null {
  const profile = resolveClimateProfile(pack, zoneId);
  if (!profile) return null;

  const rows = resolveWeatherRows(profile, seasonKey);
  if (!rows) return null;

  const unit = createEjsRng(buildWeatherSeed(saveSeed, zoneId, gameDay)).float();
  const label = sampleLabel(rows, unit);
  return label === null ? null : { label };
}

// ═══════════════════════════════════════════════════════════
// 内部：解析
// ═══════════════════════════════════════════════════════════

/** 中层 id → 气候画像；查不到时回退**第一个**画像（见 `weatherAt` 第 2 级那条注释） */
function resolveClimateProfile(pack: MapPack, zoneId: string): ClimateProfile | null {
  const midTier =
    typeof zoneId === 'string' && zoneId.length > 0
      ? pack.midTiers.find((row) => row.id === zoneId)
      : undefined;

  // `climateId` 为空串 = 中层没指定气候（`map-pack.ts` 的 `coerceMidTiers` 刻意留空串而非跳过）
  const climateId = midTier?.climateId ?? '';
  if (climateId.length > 0) {
    const direct = pack.climates[climateId];
    if (direct) return direct;
  }
  return firstClimateProfile(pack);
}

/**
 * `pack.climates` 的第一个画像。
 *
 * 顺序 = `Object.keys` 顺序 = 包里的书写顺序（气候 id 是 `zone-cold` 这类非数字串，
 * 不会被 JS 的「整数键优先」规则重排）。这就是「稳定」的全部含义：同一份包永远同一个回退目标。
 */
function firstClimateProfile(pack: MapPack): ClimateProfile | null {
  for (const key of Object.keys(pack.climates)) {
    const profile = pack.climates[key];
    if (profile) return profile;
  }
  return null;
}

/**
 * 画像 + 季节键 → **已过滤**的加权表；一张可用表都没有时 `null`。
 *
 * 🔴 **空表与缺席走同一条兜底**（`map-pack.ts` 的 `coerceClimates` 明写了这条契约：某季节键
 *    剩下 0 行时连键一起丢，「留个空数组只会让下游多一种要考虑的形状」）。所以这里按
 *    「**有没有可用行**」判定，而不是按键存不存在 —— 否则一份没过 coerce 的手搭包（或将来
 *    某个绕过 coerce 的调用方）会在「键在、行全废」时拿到 `null`，而它本该走季节回退。
 */
function resolveWeatherRows(profile: ClimateProfile, seasonKey: string): WeatherWeight[] | null {
  const table = profile.table;
  if (!table) return null;

  if (typeof seasonKey === 'string' && seasonKey.length > 0) {
    const direct = collectUsableRows(table[seasonKey]);
    if (direct.length > 0) return direct;
  }

  for (const key of Object.keys(table)) {
    const rows = collectUsableRows(table[key]);
    if (rows.length > 0) return rows;
  }
  return null;
}

/**
 * 收下能用的行。丢掉的三类各有理由，且**都不报错**：
 *   · 标签空 / 不是串 —— `WeatherResult.label` 是要写进 `sys.天气` 给玩家看的，空串比 `null` 更坏
 *   · 权重 ≤ 0 —— 0 权重永远采样不到（留着只是让总权重的分母对不上直觉）
 *   · 权重非有穷（NaN / Infinity）—— NaN 会让累加**整份**变 NaN，于是 `target < acc` 恒假、
 *     采样静默退化成「永远取最后一行」；Infinity 则让那一行吞掉全部概率
 *
 * 🔴 过滤只在这里做一次，采样拿到的行**已经全都合法**。两处各写一份权重判据是漂移的来路，
 *    而漂移的症状是「某个标签永远抽不到」—— 它不报错，只是天气变得不对。
 */
function collectUsableRows(rows: WeatherWeight[] | undefined): WeatherWeight[] {
  if (!Array.isArray(rows)) return [];
  const out: WeatherWeight[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const label = row[0];
    const weight = row[1];
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) continue;
    out.push([label, weight]);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// 内部：种子与采样
// ═══════════════════════════════════════════════════════════

/**
 * 种子串 = `(saveSeed, zoneId, gameDay)` 三元组的**无歧义**编码。
 *
 * 🔴 每段带长度前缀，不是简单拼接：`a|b#1` 这种直拼会让「区 `a|b` 第 1 天」与「区 `a` 第
 *    `b#1` 天」撞成同一个种子。分隔符是包数据里可能出现的字符，长度前缀不是。
 *    撞种子的症状是两个区共享同一条天气序列 —— 看着完全正常，只是世界少了一点变化。
 *
 * 🔴 天粒度取下整、非有穷读作 0：天气是按天的量，同一天的两次查询（比如同一回合里 `<tp>` 栏
 *    与出图各问一次）必须拿到同一个答案。
 */
function buildWeatherSeed(saveSeed: string, zoneId: string, gameDay: number): string {
  const seed = typeof saveSeed === 'string' ? saveSeed : '';
  const zone = typeof zoneId === 'string' ? zoneId : '';
  const day = Number.isFinite(gameDay) ? Math.floor(gameDay) : 0;
  return `${seed.length}:${seed}|${zone.length}:${zone}|${day}`;
}

/**
 * 加权采样。`unit ∈ [0, 1)`，`rows` 必须**已过滤**（见 `collectUsableRows`）。
 *
 * 末尾那条 `return` 不是死代码而是浮点兜底：`unit < 1` 保证 `target < total`，循环理论上必定
 * 命中，但累加顺序造成的舍入差让「理论上」不值得依赖 —— 掉出循环时取最后一行，
 * 而不是把一次合法采样报成 `null`。
 */
function sampleLabel(rows: readonly WeatherWeight[], unit: number): string | null {
  let total = 0;
  for (const row of rows) total += row[1];
  if (!(total > 0)) return null;

  const target = unit * total;
  let acc = 0;
  for (const row of rows) {
    acc += row[1];
    if (target < acc) return row[0];
  }
  const last = rows[rows.length - 1];
  return last ? last[0] : null;
}
