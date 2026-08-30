/**
 * Phase 10: Placeholder Registry — Unified Agent Template System
 *
 * 职责:
 * 1. 定义 PLACEHOLDER_REGISTRY — 18 个 {{PLACEHOLDER}} → 解析函数的映射
 * 2. getDefaultTemplate(agentId) — 为每个 Agent 返回默认模板字符串
 * 3. setPlaceholderGlobals / resetPlaceholderGlobals — 管理跨函数共享的世界书/配置数据
 *
 * 设计原则:
 * - 完全替代旧的 AgentPromptTemplate.variableContext() + variableInstruction()
 * - Agent 通过 config.template 自定义模板字符串，未设置则使用 getDefaultTemplate()
 * - 兼容旧 ST 预设的 assemblePresetContent()（preset-loader 中）
 * - 模板解析由 template-resolver.ts 的 resolveTemplate() 负责（支持 localParams 注入链占位符）
 *
 * 可见性规则:
 * - NARRATIVE 使用 defaultHistoryLayers / defaultHistorySlice（从 agent-templates 导入）
 * - CHARACTER_STATE 使用 buildZoneContext + filterZoneContent（从 context-visibility 导入）
 * - LORE_BOOK 使用 worldbook-loader 的 getEntriesForAgent / filterActiveEntries / renderWorldBookEntries
 * - formatHistory / formatMemories / formatPlotEvents 是本模块私有实现（Q-05 起不再是镜像）
 *   （曾经并列的 formatCharacters 是**从未接进注册表**的死函数，2026-08-05 收紧 lint 时删除；
 *   角色状态实际由 CHARACTER_STATE / INVENTORY / SKILL_STATE 各自的内联实现产出）
 */

import type {
  AgentContext,
  AgentConfig,
  WorldBook,
  PlaceholderResolver,
  RecentCombatInfo,
} from './types';
import {
  getEntriesForAgent,
  filterActiveEntries,
  renderWorldBookEntries,
} from './worldbook-loader';
import { parseSetvars, resolveGetvars, resolveRandoms } from './preset-loader';
import { buildZoneContext, filterZoneContent, getAgentZoneVisibility } from './context-visibility';
import { defaultHistoryLayers } from './agent-templates';
import { formatGameTime, getSeason, toGameDay, type GameTime } from './time-system';
import { buildMapSnapshot, developmentLevelName } from './map-context';
import type {
  MapSnapshot,
  MapSnapshotBuilding,
  MapSnapshotBuildings,
  MapSnapshotJourney,
  MapSnapshotNeighbor,
  MapSnapshotPlace,
  MapSnapshotStatus,
} from './map-context';
import { DEV_PROGRESS_MAX } from './map-dynamics';
import type { TileHistoryEntry } from './types-map';
import type { MapCompass } from './map-index';
import { isEmptyMapPack } from './map-pack';
import { getMapPack } from './map-runtime';
// 随机事件 v1 (§5.1 渲染)：只要形状，不要数据 —— 候选快照由 game-pipeline 供进 ctx
import type { RandomEventOfferEntry } from './random-event-context';

// ═══════════════════════════════════════════════════════════
// Module-Level Globals
// ═══════════════════════════════════════════════════════════

let _worldBooks: WorldBook[] = [];
let _configs: AgentConfig[] = [];

export function setPlaceholderGlobals(worldBooks: WorldBook[], configs: AgentConfig[]): void {
  _worldBooks = worldBooks;
  _configs = configs;
}

export function resetPlaceholderGlobals(): void {
  _worldBooks = [];
  _configs = [];
}

// ═══════════════════════════════════════════════════════════
// Private Formatting Helpers (mirror functions from agent-templates.ts)
// ═══════════════════════════════════════════════════════════

/**
 * uid → 所属世界书名（仅用于 EJS 回退告警的可读性）。
 * uid 在跨书场景可能重复，取首个命中即可——这是日志文案不是寻址。
 */
function bookNameOfUid(uid: number): string {
  for (const book of _worldBooks) {
    if (book.entries?.some((e) => e.uid === uid)) return book.name || book.id;
  }
  return '?';
}

/** 记忆条目格式化（Q-05 起是唯一实现） */
function formatMemoriesEntries(ctx: AgentContext, topK?: number): string {
  const memories = ctx.memories ?? [];
  if (memories.length === 0) return '';
  const sliced = topK && topK > 0 ? memories.slice(0, topK) : memories;
  return sliced
    .map(
      (m) =>
        `[${m.id}] ${m.timeRange.start}~${m.timeRange.end} | 重要度:${m.importance}\n正文: ${m.content.slice(0, 300)}`,
    )
    .join('\n---\n');
}

/** 活跃剧情事件格式化（Q-05 起是唯一实现） */
function formatPlotEventsEntries(ctx: AgentContext): string {
  const events = ctx.plotEvents ?? [];
  if (events.length === 0) return '';
  return events
    .filter((e) => e.status === 'active' || e.status === 'pending')
    .map((e) => {
      const tw = e.timeWindow?.start
        ? `\n时间窗口: ${e.timeWindow.start}${e.timeWindow.end && e.timeWindow.end !== e.timeWindow.start ? ` ~ ${e.timeWindow.end}` : ''}`
        : '';
      return `[${e.id}] ${e.title} (${e.status})\n${e.description.slice(0, 200)}${tw}`;
    })
    .join('\n---\n');
}

function isNaturalOpeningSkillHeading(line: string): boolean {
  return line.endsWith('已经掌握这些本领。');
}

function isNaturalOpeningSkillEnd(line: string): boolean {
  return (
    line.endsWith('的行囊里还有这些东西。') ||
    /.+生性.+。$/.test(line) ||
    line.includes('的身形与外貌给人的印象是：') ||
    (line.startsWith('关于') && line.includes('的来历，已知的是：')) ||
    line.startsWith('故事便从这个瞬间继续。')
  );
}

/**
 * 从捏人页开场消息中取出初始技能原始声明。
 *
 * 新档使用沉浸式自然语言句作为边界；旧档的分隔标题仍须兼容，否则读旧存档后的首轮
 * request_dispatcher 会静默漏掉尚未落库的初始技能。
 */
function extractOpeningSkillDeclaration(opening: string): string {
  const legacy = opening.match(/---\s*初始技能\s*---([\s\S]*?)(?=\n---\s*|\n\n*---|$)/);
  if (legacy?.[1]) return legacy[1].trim();

  const openingLines = opening.replace(/\r\n/g, '\n').split('\n');
  const startIndex = openingLines.findIndex((line) => isNaturalOpeningSkillHeading(line.trim()));
  if (startIndex < 0) return '';

  let endIndex = openingLines.length;
  for (let i = startIndex + 1; i < openingLines.length; i += 1) {
    const line = openingLines[i]?.trim() ?? '';
    if (isNaturalOpeningSkillEnd(line)) {
      endIndex = i;
      break;
    }
  }

  return openingLines
    .slice(startIndex + 1, endIndex)
    .join('\n')
    .trim();
}

// ═══════════════════════════════════════════════════════════
// LORE_BOOK 共享实现（{{LORE_BOOK}} / {{LORE_BOOK_STATIC}} / {{LORE_BOOK_DYNAMIC}} 三者同源）
// ═══════════════════════════════════════════════════════════

/**
 * 世界书条目过滤 + 静/动分层 + EJS 求值 + 宏剥离 —— 三个 LORE_BOOK 占位符的唯一实现。
 *
 * 工坊 P2 (ADR-30 D1/D7)：条目过滤后走 `renderWorldBookEntries` —— 静态区（无 `<%`/`{{random`/
 * `{{getvar}}` 特征）字节稳定排在前，动态区 EJS 求值后沉到尾部，最大化 prompt cache 前缀。
 *
 * 分区选择：
 * - `forcedSection` 传入 → 忽略 `params.section`，只返回该区（供裸名占位符 `{{LORE_BOOK_STATIC}}` /
 *   `{{LORE_BOOK_DYNAMIC}}` 钉死分区用；裸名不接受用户改区）
 * - 否则看 `params.section`（`static` / `dynamic`）
 * - 两者都没有 → 静态区 + 动态区顺序连拼（默认行为，普通用户无感）
 * - `limit=N` → 三种写法通用，对最终文本截断
 *
 * 宏链（parseSetvars → resolveGetvars → resolveRandoms）位置**不动**，仍在 EJS 之后，
 * 对**本次返回的那段文本**独立跑。⚠️ 拆开两区时两区各自成一次宏作用域——
 * 静态区定义的 `{{setvar}}` 不再对动态区的 `{{getvar}}` 可见，这是拆分的固有代价。
 *
 * 🔴 **pass 级 memo（幂等保障）**：拆分写法让本函数在同一 pass 被调多次，
 * 而 EJS 条目不保证幂等（计数器式 `setMessageVar` 在语料里合法）——重复求值 = 写翻倍落库。
 * 故首次求值把整份 `renderWorldBookEntries` 结果缓存到 `ctx.ejsPass.loreRender`，
 * 后续出现（无论哪个占位符、哪个分区）只从缓存挑段。不同 Agent 的 pass 各自新建 ejsPass，天然隔离。
 * 无 ejsPass 的退化路径不缓存——一次性上下文没有二次出现问题（写即弃）。
 */
function resolveLoreBookSection(
  ctx: AgentContext,
  config: AgentConfig,
  params: Record<string, string> | undefined,
  forcedSection?: 'static' | 'dynamic',
): string {
  if (_worldBooks.length === 0 || _configs.length === 0) return '';
  const agentId = config.agentId || '';
  const entries = getEntriesForAgent(agentId, _configs, _worldBooks);
  if (entries.length === 0) return '';
  const activeEntries = filterActiveEntries(entries);

  // 求值上下文取本次装配 pass 的草稿（buildAgentMessages 挂在 tplCtx.ejsPass 上）。
  // 极端路径（外部直接调 resolver / 老测试）无草稿 → 退化为一次性空草稿：求值照跑，写即弃。
  const ejsCtx = ctx.ejsPass ?? { stats: ctx.statData ?? {}, vars: {}, historyText: '' };

  const memo = ctx.ejsPass?.loreRender;
  let staticText: string;
  let dynamicText: string;
  if (memo && memo.agentId === agentId) {
    // 本 pass 已求值过 —— 直接复用，绝不二次执行 EJS（回退告警也已在首次打过）
    staticText = memo.staticText;
    dynamicText = memo.dynamicText;
  } else {
    // 无 memo 的同步兜底路（2026-08-01 修 F3 的裁定）：
    // 生产装配一律走 `buildAgentMessagesAsync` —— 它预渲染完把结果灌进 `ejsPass.loreRender`，
    // 上面那条 memo 分支才是生产的正常路径，这里只剩测试与外部直接调 resolver 的极端路径。
    // 保留调用而不删，是因为 `renderWorldBookEntries` 自身已带 fail-closed 闸门：
    // 当前后端不是 `LegacyBackend`（= 生产的 QuickJS / fail-closed）时它**不在宿主 realm 求值**，
    // 按 D8 原文注入并记回退。故这里不会成为绕过隔离的后门；测试默认 Legacy 后端下行为不变。
    const rendered = renderWorldBookEntries(activeEntries, ejsCtx);
    staticText = rendered.staticText;
    dynamicText = rendered.dynamicText;
    if (ctx.ejsPass) {
      ctx.ejsPass.loreRender = {
        agentId,
        staticText,
        dynamicText,
        fallbackEntries: rendered.fallbackEntries,
      };
    }
    if (rendered.fallbackEntries.length > 0) {
      console.warn(
        `[LORE_BOOK] agent=${agentId} 有 ${rendered.fallbackEntries.length} 个条目 EJS 失败、已回退原文注入: ` +
          rendered.fallbackEntries.map((f) => `${bookNameOfUid(f.uid)}#${f.uid}`).join(', '),
      );
      // 同步送进诊断出口（同步 resolver 这条路；异步预渲染那条在 agent-templates）
      try {
        ctx.ejsFallback?.({
          agentId,
          entries: rendered.fallbackEntries.map((f) => ({
            uid: f.uid,
            bookName: bookNameOfUid(f.uid),
            error: f.error,
          })),
        });
      } catch (err) {
        console.warn('[LORE_BOOK] EJS 回退诊断出口抛错（已忽略）:', err);
      }
    }
  }

  // 裸名占位符钉死分区，优先级高于 params.section（用户给 {{LORE_BOOK_STATIC:section=dynamic}} 也不改区）
  const section = forcedSection ?? params?.section;
  let formatted: string;
  if (section === 'static') formatted = staticText;
  else if (section === 'dynamic') formatted = dynamicText;
  else formatted = [staticText, dynamicText].filter(Boolean).join('\n\n');

  // 真机修(2026-07-18): 原 ST 角色卡世界书正文自带 {{setvar/getvar/random}} 宏（MVU 机制遗留）
  // → 注入前收集 setvar 变量表并剥离定义、替换 getvar 引用、解析 random——
  //   世界书内自洽的 setvar/getvar 对仍正常工作，孤立宏不再作为噪音喂给 AI（实测 story 系统消息含 25+36 处残留）
  const { variables: wbVars, stripped } = parseSetvars(formatted);
  formatted = resolveRandoms(resolveGetvars(stripped, wbVars));
  if (params?.limit) {
    const limit = parseInt(params.limit, 10);
    if (!isNaN(limit) && limit > 0) {
      return formatted.slice(0, limit);
    }
  }
  return formatted;
}

// ═══════════════════════════════════════════════════════════
// MAP_CONTEXT 渲染（地图 v1 §8.1 载荷契约 —— 两个渲染器之一）
// ═══════════════════════════════════════════════════════════

/**
 * 罗盘令牌 → 中文方位。
 *
 * 🔴 这张表**属于本文件**，不属于 `map-*.ts`：那些模块被结构闸门（`map-literals-gate.test.ts`，
 *    §3.4-1「换图零改码」）禁掉了中文字面量，所以 `MapSnapshot` 给的是 ASCII 令牌，
 *    中文在渲染层查表。同一份 `$map` 数据有**两个渲染器**（裁定 §12-9）：本文件喂
 *    request_dispatcher（模板占位符），内容仓一条 constant EJS 世界书条目喂 story
 *    （story 有预设短路，占位符到不了它）。**数据不会漂，措辞可以漂** —— 措辞属创作层。
 */
const MAP_COMPASS_LABELS: Record<MapCompass, string> = {
  N: '北',
  NE: '东北',
  E: '东',
  SE: '东南',
  S: '南',
  SW: '西南',
  W: '西',
  NW: '西北',
};

/** 当前行的格分隔（照 §8.1 样例：全角竖线，无空格） */
const MAP_CELL_SEP = '｜';
/** 邻接项之间 */
const MAP_NEIGHBOR_SEP = ' · ';
/** 单个邻接项括注内部 */
const MAP_NOTE_SEP = '·';
/** 顿号列表（状态标题 / 引发状态名，v1.2）—— 与 `MAP_NOTE_SEP` 不同层级，别混用 */
const MAP_LIST_SEP = '、';

/**
 * 中层 / 国家括注。
 *
 * 三种「查不到」的成因（不属于任何中层 / 无主之地 / 包里悬空 id）**刻意同一个处置** ——
 * 那一格不写（`MapSnapshotPlace` 那条注释：区分开就得让渲染层也分三支）。
 */
function renderMapDomain(place: MapSnapshotPlace): string {
  const parts: string[] = [];
  if (place.midTierName !== null && place.midTierName.trim() !== '') parts.push(place.midTierName);
  if (place.countryName !== null && place.countryName.trim() !== '') {
    parts.push(`${place.countryName}领`);
  }
  return parts.length === 0 ? '' : `（${parts.join(' · ')}）`;
}

/**
 * 天气格。**只到季节**。
 *
 * 🔴 §8.1 样例写的是「小雪（寒冬 · 长夜月）」，而那 12 个具名月是**世界书历法**里的内容，
 *    引擎的 `time-system.MONTH_NAMES` 只有「一月…十二月」这种数词表 —— 拿它顶替具名月
 *    等于在提示词里写一句世界观不认的话。具名月留给内容仓那个渲染器（它读得到历法条目），
 *    这里只出 `getSeason()`。少一格标签好过一句错话（口径同 `map-context` 那些「不产」的字段）。
 */
function renderMapWeatherCell(label: string, gameTime: GameTime | undefined): string {
  const season = gameTime === undefined ? '' : getSeason(gameTime.month);
  return season === '' ? `天气: ${label}` : `天气: ${label}（${season}）`;
}

/**
 * 邻接行（严格一跳）。
 *
 * 括注顺序照 §8.1 原文：**地形 → 仅异主时的所有者 → 通行性**。`ownerName` 是否为 null
 * 本身就是「该不该标所有者」的答案（`map-context` 已经比过了），这里不再比一遍。
 */
function renderMapNeighborLine(neighbors: readonly MapSnapshotNeighbor[]): string {
  if (neighbors.length === 0) return '';
  const items = neighbors.map((n) => {
    const notes: string[] = [];
    if (n.terrain.trim() !== '') notes.push(n.terrain);
    // v1.2 头条（裁定 §8-12「邻块单行头条」）：档名紧跟地形，两者都是「那边是个什么地方」
    if (n.devLevelName !== undefined && n.devLevelName.trim() !== '') notes.push(n.devLevelName);
    if (n.ownerName !== null && n.ownerName.trim() !== '') notes.push(`${n.ownerName}领`);
    // 水域与不可通行是**通行性事实**，AI 必须看见：挡在西边的冰脊、东边那片要船才过得去的海。
    // 湖块 v1 一律不可入（§6.1），海块要船 —— 两者措辞刻意不同，因为处置不同。
    if (n.water === 'sea') notes.push('需船');
    else if (n.water === 'lake') notes.push('不可入');
    if (n.impassable) notes.push('不可通行');
    // 状态标题排最后：它是「此刻正在发生什么」，与前面那些地理常量不是一类事实
    if (n.statusTitles !== undefined && n.statusTitles.length > 0) {
      notes.push(`状态:${n.statusTitles.join(MAP_LIST_SEP)}`);
    }
    const suffix = notes.length === 0 ? '' : `(${notes.join(MAP_NOTE_SEP)})`;
    return `${MAP_COMPASS_LABELS[n.dir]}→${n.name}${suffix}`;
  });
  return `邻接: ${items.join(MAP_NEIGHBOR_SEP)}`;
}

// ── 地块动态的中文措辞（地图 v1.2 / ADR-33 §5「本块全量」）────────────────────
// 🔴 这一整节是 v1.2 里**唯一**允许写这些词的地方（对 dispatcher 面而言）：数据面
//    (`map-context` / `map-dynamics`) 被结构闸门禁了中文字面量，编年史条目在那边存的是
//    `kind` + 参数。story 面的措辞在内容仓那条 EJS 世界书条目里 —— 同一份数据两个渲染器，
//    数据不会漂、措辞可以漂（裁定 §12-9 的口径，v1.2 照旧）。

/** 编年史里没有建筑名时的占位（坏数据兜底，正常路径下 op 必带名字） */
const MAP_UNNAMED_BUILDING = '建筑';

/** AI 自由文本（note / reason）里的换行折成空格 —— 一条编年史恒占一格 */
function flattenMapText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 发展档行：`发展: 繁荣城镇（进度 35/100）` */
function renderMapDevelopmentLine(place: MapSnapshotPlace): string {
  const dev = place.development;
  if (dev === undefined) return '';
  return `发展: ${dev.levelName}（进度 ${dev.progress}/${DEV_PROGRESS_MAX}）`;
}

/**
 * 状态行（**一条一行**）：`状态: 洪水（剩余 12 天）｜洪水席卷了银帆城`
 *
 * 🔴 括注三态各有各的话：永久 / 剩余 N 天 / **算不出时什么都不写**。
 *    把「不知道还剩几天」渲染成「永久」是这一格最容易犯、也最贵的错 ——
 *    AI 会据此判断这场洪水永远不会退。
 */
function renderMapStatusLines(place: MapSnapshotPlace): string[] {
  const statuses: readonly MapSnapshotStatus[] = place.statuses ?? [];
  return statuses.map((s) => {
    let line = `状态: ${s.title}`;
    if (s.permanent) line += '（永久）';
    else if (s.remainingDays !== null) line += `（剩余 ${s.remainingDays} 天）`;
    const desc = flattenMapText(s.description);
    if (desc !== '') line += `${MAP_CELL_SEP}${desc}`;
    return line;
  });
}

/** 一座建筑的行内片段：`磨坊（市长）【玩家产业】`（主建筑行与建筑行共用） */
function renderMapBuildingItem(building: MapSnapshotBuilding): string {
  let text = building.name;
  if (building.ownerFlavor !== undefined && building.ownerFlavor.trim() !== '') {
    text += `（${building.ownerFlavor}）`;
  }
  if (building.playerOwned) text += '【玩家产业】';
  return text;
}

/**
 * 主建筑行（v1.2 / §F4b）：`主建筑: 城堡（领主）【玩家产业】`
 *
 * 🔴 **单独一行、排在建筑行之前**：它不占编号槽、降档免疫，混进建筑行会让 AI 以为它
 *    也吃「空槽」那本账（于是把「还能盖几座」算错一格），也读不出它是这块地的座席。
 * 🔴 名字由数据面解析好（作者名 / 钉住名 / 按档派生的通名），这里一个字都不查表。
 */
function renderMapMainBuildingLine(place: MapSnapshotPlace): string {
  const main = place.mainBuilding;
  if (main === undefined) return '';
  return `主建筑: ${renderMapBuildingItem(main)}`;
}

/**
 * 建筑行：`建筑: 磨坊（市长） · 商栈（玛丽）【玩家产业】｜空槽 2`
 *
 * 空槽数**永远写**（含 0）：槽满与还能建，是 AI 决定「这里能不能再盖一座」的唯一依据，
 * 而 0 与「这一格没说」在提示词里长得一样。
 */
function renderMapBuildingsLine(place: MapSnapshotPlace): string {
  const buildings: MapSnapshotBuildings | undefined = place.buildings;
  if (buildings === undefined) return '';
  const items = buildings.entries.map(renderMapBuildingItem);
  const head = items.length === 0 ? '建筑: 无' : `建筑: ${items.join(MAP_NEIGHBOR_SEP)}`;
  return `${head}${MAP_CELL_SEP}空槽 ${buildings.freeSlots}`;
}

/**
 * 一条编年史 → 一句中文（`kind` + 参数 → 措辞；裁定 §8-14 五类自动 + 取得产业 + AI 附注）。
 *
 * 🔴 认不出的 `kind` **整条不渲染**而不是印一句「未知事件」：编年史是给 AI 读的既往事实，
 *    一条说不清是什么的事实比没有更糟。日后新增事件类时这里会静默少一行 ——
 *    所以每加一个 `kind` 都要回来补一支（测试钉着现有七类）。
 */
function renderMapHistoryEntry(entry: TileHistoryEntry, levelNames: readonly string[]): string {
  const building = flattenMapText(entry.building ?? '') || MAP_UNNAMED_BUILDING;
  const levelOf = (level: number | undefined): string =>
    typeof level === 'number' ? developmentLevelName(levelNames, level) : '';

  let body = '';
  switch (entry.kind) {
    case 'built':
      body = `${building}落成`;
      break;
    case 'destroyed': {
      body = `${building}被毁`;
      const causes = (entry.causeStatuses ?? []).map(flattenMapText).filter((s) => s !== '');
      if (causes.length > 0) body += `（毁于${causes.join(MAP_LIST_SEP)}）`;
      break;
    }
    case 'firstVisit':
      body = '玩家首次到访';
      break;
    case 'levelUp': {
      const name = levelOf(entry.toLevel);
      body = name === '' ? '升档' : `升为「${name}」`;
      break;
    }
    case 'levelDown': {
      const name = levelOf(entry.toLevel);
      body = name === '' ? '降档' : `降为「${name}」`;
      break;
    }
    case 'acquired':
      body = `${building}归入玩家产业`;
      break;
    // v1.2 §F4b：只有主建筑改得了名（槽位建筑改名 = 换一座建筑），记的是**新名字**
    case 'renamed':
      body = `主建筑更名为${building}`;
      break;
    case 'note':
      body = flattenMapText(entry.text ?? '');
      break;
    default:
      return '';
  }
  if (body === '') return '';

  const reason = flattenMapText(entry.reason ?? '');
  if (reason !== '' && entry.kind !== 'note') body += `（${reason}）`;
  return `第 ${entry.day} 日 ${body}`;
}

/** 编年史行（**一整行**，新的在后）：`编年史: 第 128 日 磨坊落成 · 第 141 日 …` */
function renderMapHistoryLine(place: MapSnapshotPlace, levelNames: readonly string[]): string {
  const entries = place.history ?? [];
  const items = entries.map((e) => renderMapHistoryEntry(e, levelNames)).filter((s) => s !== '');
  return items.length === 0 ? '' : `编年史: ${items.join(MAP_NEIGHBOR_SEP)}`;
}

/**
 * 当前地块的动态各行（发展 / 状态 / 主建筑 / 建筑 / 编年史）。
 *
 * 🔴 **缺席就一行都不出**（裁定 §8-12「缺席状态零 token」）：没用过 v1.2 的存档、
 *    还没有任何叙事事实的地块，渲染结果与 v1.1 逐字节相同。判断在数据面已经做完了
 *    （那几格是可选键），这里只是不去凭空造行。
 */
function renderMapFactLines(place: MapSnapshotPlace, levelNames: readonly string[]): string[] {
  const lines: string[] = [];
  const development = renderMapDevelopmentLine(place);
  if (development !== '') lines.push(development);
  lines.push(...renderMapStatusLines(place));
  const mainBuilding = renderMapMainBuildingLine(place);
  if (mainBuilding !== '') lines.push(mainBuilding);
  const buildings = renderMapBuildingsLine(place);
  if (buildings !== '') lines.push(buildings);
  const history = renderMapHistoryLine(place, levelNames);
  if (history !== '') lines.push(history);
  return lines;
}

/**
 * 在途行。
 *
 * 两格可以缺而**都不是异常**（`MapSnapshotJourney` 那条注释）：没有「下一站」= 玩家不在计划
 * 路线上（或压根没计划路线），没有「还需 N 天」= 当前位置到目的地无路可走。缺了就少一格，
 * 「在途，目的地 X」本身仍是真事实。
 *
 * 🔴 天数是**锚不是判决**（裁定 §12-5）：`delta_time` 仍由 dispatcher 写，Code 只把路线估算
 *    摆在它眼前。所以措辞是「约还需」而不是「需要」。
 */
function renderMapJourneyLine(journey: MapSnapshotJourney): string {
  let line = `旅行中: 前往${journey.toName}`;
  if (journey.nextName !== null && journey.nextName.trim() !== '') {
    line += `，沿计划路线，下一站 ${journey.nextName}`;
  }
  if (journey.remainingDays !== null) line += `，约还需 ${journey.remainingDays} 天`;
  return line;
}

/**
 * 天气标签的读法 —— 与 `resolveSceneWeather`（前端）**同口径**的两级：
 * `ctx.weather`（供值侧已经走完 `sys.天气` → `worldFlags.天气` → `worldFlags.weather` 三格）
 * → `ctx.variables.sys.天气`（变量真源，任何造得出 AgentContext 的调用方都有它）。
 *
 * 为什么留第二级：`weather` 是新字段，而 `AgentContext` 有好几个构造点。漏供的症状不是报错，
 * 是天气格**静默消失** —— 而消失与「今天没有天气」长得一模一样（blurByDefault 那类缺陷）。
 */
function readWeatherLabel(ctx: AgentContext): string | null {
  const supplied = typeof ctx.weather === 'string' ? ctx.weather.trim() : '';
  if (supplied !== '') return supplied;
  const sys = (ctx.variables ?? {})['sys'] as Record<string, unknown> | undefined;
  const raw = sys?.['天气'];
  const fromVars = typeof raw === 'string' ? raw.trim() : '';
  return fromVars === '' ? null : fromVars;
}

/**
 * 四类行 → `<map_context>` 块（§8.1）。
 *
 * 🔴 **未定位时只出一行**：`位置: 未定位（按叙事继续）`。位置路径才是真源，地块只是投影
 *    （裁定 §12-1），投影为空时游戏照常进行 —— 这一行是在告诉 AI「别等地图，照叙事写」。
 *    此时在途摘要只剩一个目的地名字（`remainingDays` / `nextName` 都算不出来），
 *    而那个名字叙事里刚写过；不连通提示更是无从谈起，所以两条都不出。
 */
function renderMapContextBlock(snapshot: MapSnapshot, gameTime: GameTime | undefined): string {
  const lines: string[] = [];
  const place = snapshot.current;

  if (place === null) {
    lines.push('位置: 未定位（按叙事继续）');
  } else {
    const cells = [`位置: ${place.name}${renderMapDomain(place)}`];
    if (place.terrain.trim() !== '') cells.push(`地形: ${place.terrain}`);
    if (snapshot.weatherLabel !== null && snapshot.weatherLabel.trim() !== '') {
      cells.push(renderMapWeatherCell(snapshot.weatherLabel.trim(), gameTime));
    }
    lines.push(cells.join(MAP_CELL_SEP));

    // v1.2 本块全量（裁定 §8-12）：位置行之后、邻接行之前 —— 由近及远读下来。
    // 没有事实时这里返回空数组，于是整块输出与 v1.1 逐字节相同（零 token 铁律）。
    lines.push(...renderMapFactLines(place, snapshot.developmentLevels ?? []));

    const neighborLine = renderMapNeighborLine(snapshot.neighbors);
    if (neighborLine !== '') lines.push(neighborLine);
    if (snapshot.journey !== null) lines.push(renderMapJourneyLine(snapshot.journey));
    // 提示行的判据是**这一格在不在**（`projectLocationFlags` 只在两块不相邻时写 1，
    // 相邻时显式删掉）—— 拿数值比大小会把「相邻」也讲成越野。至多一条（§8.1）。
    if (snapshot.discontinuity !== null) {
      lines.push('提示: 上回合移动跨越了不相邻地块（如为传送/剧情跳转可忽略）');
    }
  }

  return `<map_context>\n${lines.join('\n')}\n</map_context>`;
}

// ═══════════════════════════════════════════════════════════
// RANDOM_EVENTS 渲染（随机事件 v1 §5.1 —— 与 MAP_CONTEXT 同款分工）
// ═══════════════════════════════════════════════════════════

/** 候选行里的换行/连续空白折叠成单空格 —— 一条候选恒占一行（多行简报会把列表读乱） */
function flattenOfferText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 候选快照 → `<random_events>` 块（§5.1 的块形状）。
 *
 * 🔴 **措辞全在这里**，数据面（过滤 + 排序）在 `random-event-context.buildRandomEventOffer`。
 *    这是 `{{MAP_CONTEXT}}` 那三条纪律里的第二条，也是随机事件那几个纯函数叶被结构闸门
 *    禁掉中文字面量的原因。
 * 🔴 `[!]` 那行说明**只在真有 forced 条目时出现**：讲解一个列表里根本不存在的记号，
 *    是在教模型认一个它看不到的东西。
 * 🔴 `plotCompatible` 那一句由调用方按 `plotSettings.mode` 决定（§5.1 末段）：剧情系统
 *    关掉时它就是一句无意义的约束，而随机事件**可独立于剧情系统工作**是本设计第一需求。
 */
function renderRandomEventsBlock(
  offer: readonly RandomEventOfferEntry[],
  plotCompatible: boolean,
): string {
  const lines: string[] = [
    '以下事件当前可以触发。请在叙事自然、不打断当前剧情节奏的时机，选择其中至多一个',
    '编织进正文（按优先级与当前剧情契合度自行判断；本回合不方便可以不触发，列表会保留）。',
    '触发时：把事件内容自然写进正文，并在回复末尾输出 <event_trigger name="事件名"/>（名字逐字一致）。',
  ];
  if (offer.some((e) => e.forced)) {
    lines.push('[!] 标记的是首次到访事件，必须尽快触发（本回合优先）。');
  }
  if (plotCompatible) {
    lines.push('触发时机须与当前剧情推进兼容。');
  }

  for (const entry of offer) {
    const mark = entry.forced ? '[!]' : '';
    const detail = entry.detail ? `（演绎指引：${flattenOfferText(entry.detail)}）` : '';
    lines.push(
      `- ${mark}〔优先级 ${entry.priority}〕${entry.name}：${flattenOfferText(entry.brief)}${detail}`,
    );
  }

  return `<random_events>\n${lines.join('\n')}\n</random_events>`;
}

// ═══════════════════════════════════════════════════════════
// Placeholder Registry
// ═══════════════════════════════════════════════════════════

export const PLACEHOLDER_REGISTRY: Record<string, PlaceholderResolver> = {
  // ---- Global Placeholders (12) ----

  /** {{SYS_PROMPT}} — Agent 的 systemPrompt，来自 agent-config.json */
  SYS_PROMPT: (ctx, config, _params) => {
    return config.systemPrompt || '';
  },

  /**
   * {{LORE_BOOK}} — 世界书条目（静态区 + 动态区连拼）。
   * 支持 `section=static` / `section=dynamic` 参数化拆区，以及 `limit=N` 截断。
   * 完整语义（分层 / 宏作用域 / pass 级 memo）见 `resolveLoreBookSection`。
   */
  LORE_BOOK: (ctx, config, params) => resolveLoreBookSection(ctx, config, params),

  /**
   * {{LORE_BOOK_STATIC}} — 等价于 `{{LORE_BOOK:section=static}}` 的裸名写法。
   *
   * 存在理由：参数化写法在 story 预设链路上会被剥离/漏检（preset-loader 与 agent-templates 的
   * 白名单都按精确 `{{名字}}` 匹配），裸名才能穿过全部正则闸门。行为与参数化形态完全一致：
   * 共用同一份 pass 级 memo（同 pass 内与 `{{LORE_BOOK_DYNAMIC}}` 同时出现也只求值一次 EJS），
   * 同样支持 `limit=N`。
   *
   * ⚠️ 与参数化拆区同样的固有代价：静/动两区各自成一次宏作用域——
   * 静态区定义的 `{{setvar}}` 不再对动态区的 `{{getvar}}` 可见。
   */
  LORE_BOOK_STATIC: (ctx, config, params) => resolveLoreBookSection(ctx, config, params, 'static'),

  /**
   * {{LORE_BOOK_DYNAMIC}} — 等价于 `{{LORE_BOOK:section=dynamic}}` 的裸名写法。
   * 存在理由、memo 共享与 `limit=N` 支持同 {{LORE_BOOK_STATIC}}。
   *
   * ⚠️ 同样各自成一次宏作用域：本区的 `{{getvar}}` 看不到静态区定义的 `{{setvar}}`。
   */
  LORE_BOOK_DYNAMIC: (ctx, config, params) =>
    resolveLoreBookSection(ctx, config, params, 'dynamic'),

  /** {{NARRATIVE}} — 格式化最近对话历史，支持 layers 参数（:slice 已废弃，再不截断） */
  NARRATIVE: (ctx, config, params) => {
    const agentId = config.agentId || '';
    const layers = params?.layers ? parseInt(params.layers, 10) : defaultHistoryLayers(agentId);
    if (layers <= 0 || !ctx.history?.length) return '';
    const maxMessages = layers * 2;
    return ctx.history
      .slice(-maxMessages)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');
  },

  /** {{USER_INPUT}} — 本轮用户输入 */
  USER_INPUT: (ctx, _config, _params) => {
    return ctx.userInput || '';
  },

  /** {{CHARACTER_STATE}} — 角色状态，通过 zone 系统格式化 */
  CHARACTER_STATE: (ctx, config, _params) => {
    const agentId = config.agentId || '';
    const zones = buildZoneContext(ctx);
    const npcZone = zones.npc;
    if (!npcZone) return '';
    const visibility = getAgentZoneVisibility(agentId).npc;
    if (visibility === 'NONE') return '';
    return filterZoneContent('npc', npcZone.content, visibility, agentId, ctx) || '';
  },

  /** {{INVENTORY}} — 遍历所有角色的背包物品 */
  INVENTORY: (ctx, _config, _params) => {
    const characters = ctx.characters ?? [];
    if (characters.length === 0) return '';
    const lines: string[] = [];
    for (const char of characters) {
      const inv = char.inventory ?? [];
      if (inv.length === 0) continue;
      lines.push(`[${char.name}] 背包:`);
      for (const item of inv) {
        const rarityStr = item.rarity ? `, ${item.rarity}` : '';
        const typeStr = item.type ? ` (${item.type}${rarityStr})` : '';
        const desc = item.description ? ` — ${item.description}` : '';
        lines.push(`  ${item.name} ×${item.quantity}${typeStr}${desc}`);
      }
    }
    return lines.join('\n');
  },

  /** {{SKILL_STATE}} — 主角/在场角色的技能清单（含开局初始技能声明） */
  SKILL_STATE: (ctx, _config, _params) => {
    const lines: string[] = [];

    // ① 落库技能（item_gen 已生成的 / 已有角色的技能）
    for (const char of ctx.characters ?? []) {
      const skills = char.skills ?? [];
      if (skills.length === 0) continue;
      lines.push(`[${char.name}] 技能:`);
      for (const sk of skills) {
        const typeLabel = sk.type === 'active' ? '主动' : sk.type === 'passive' ? '被动' : '';
        const effs = sk.effects
          ? ` [${Object.entries(sk.effects)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}]`
          : '';
        lines.push(`  [${typeLabel}] ${sk.name} — ${sk.description || ''}${effs}`);
        // 不显示 cost/cooldown/scripts（同 CHARACTER_STATE KEYS 策略）
      }
    }

    // ② 开局初始技能声明（openingPrompt 的自然语言「角色名已经掌握这些本领」段）。
    //    主角 skills 落库为空（交给 item_gen 生成），request_dispatcher 必须从这份
    //    声明里识别初始技能并逐条发 `<item_gen_request itemType="skill">`；旧分隔标题仍兼容。
    const opening = ctx.openingPrompt ?? '';
    if (opening) {
      const seg = extractOpeningSkillDeclaration(opening);
      const lines2 = seg
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines2.length > 0) {
        lines.push('');
        lines.push('【开局初始技能声明】（尚未落库，需生成）:');
        lines.push(...lines2);
      }
    }

    return lines.join('\n');
  },

  /** {{QUEST_STATE}} — 当前所有任务 (Phase 10g) */
  QUEST_STATE: (ctx, _config, _params) => {
    const quests = ctx.quests ?? {};
    const entries = Object.entries(quests);
    if (entries.length === 0) return '(无任务)';
    const lines: string[] = [];
    for (const [name, q] of entries as [string, any][]) {
      const parts: string[] = [
        `  [${name}]`,
        `状态:${q.status || '—'}`,
        `优先级:${q.priority || '—'}`,
      ];
      if (q.objective) parts.push(`目标:${q.objective}`);
      if (q.progress) parts.push(`进度:${q.progress}`);
      if (q.detail) parts.push(`详情:${q.detail}`);
      if (q.reward) parts.push(`奖励:${q.reward}`);
      lines.push(parts.join(' | '));
    }
    return lines.join('\n');
  },

  /**
   * {{GAME_TIME}} — 当前游戏时间 + 世界键（天气/位置/季节等）。
   *
   * 🔴 2026-08-08 时间漂移根因之一：旧实现只读 `ctx.variables` 的『时间』键，而
   *    variables.sys 几乎只有『天气』，于是时钟永远渲染不出来——story 写「第二天早上」
   *    时根本看不到系统时间，无从判断矛盾。现在优先 `formatGameTime(ctx.gameTime)`
   *    （存档级权威时钟），variables 的世界键只作天气/季节等补充。
   */
  GAME_TIME: (ctx, _config, _params) => {
    const vars = ctx.variables ?? {};
    const parts: string[] = [];
    if (ctx.gameTime) {
      const t = formatGameTime(ctx.gameTime);
      if (t) parts.push(`时间: ${t}`);
    }
    const worldKeys = [
      '位置',
      'location',
      'currentRegion',
      'currentFaction',
      '天气',
      'weather',
      '季节',
      'season',
      '月相',
      'moonPhase',
      '纪元',
      'era',
      'dangerLevel',
    ];
    for (const k of worldKeys) {
      if (vars[k] != null) {
        parts.push(`${k}: ${vars[k]}`);
      }
    }
    return parts.join('\n');
  },

  /**
   * {{MAP_CONTEXT}} — 地块地图的本地事实块（地图 v1 §8.1）：当前地块 + 严格一跳邻接 +
   * 天气（含季节）+ 在途摘要 + 至多一条不连通提示，包在 `<map_context>` 里。
   *
   * 🔴 **没装地图包时是空串**（`isEmptyMapPack`）：地图是**可选**子系统，不用它的存档
   *    一个 token 都不该付。所以这个块自带 XML 外壳、模板里**不要**再包一层中文标签 ——
   *    包了就会在没地图时留下一对空标签，把「零成本」这条设计意图静默作废。
   * 🔴 数据面全部来自 `map-context.buildMapSnapshot`（纯函数），可变半边来自 `ctx.mapFlags`，
   *    不可变半边来自 `map-runtime.getMapPack()` 那条注入缝。本 resolver 只负责**措辞**。
   * 🔴 只给名字：没有 tileId、没有像素坐标、没有两跳（§8.3 保护面）。
   */
  MAP_CONTEXT: (ctx, _config, _params) => {
    const pack = getMapPack();
    if (isEmptyMapPack(pack)) return '';
    const flags = ctx.mapFlags ?? {};
    const snapshot = buildMapSnapshot(pack, {
      currentTileId: flags.lastTileId ?? null,
      weatherLabel: readWeatherLabel(ctx),
      journey: flags.journey ?? null,
      discontinuity: flags.lastMoveDiscontinuity ?? null,
      // v1.2 地块动态（ADR-33 §5）：事实态由 game-pipeline 经 `getMapFactsFlags()` 供进
      // `ctx.mapFacts`；缺席时快照一格动态都不产（零 token）。
      facts: ctx.mapFacts ?? null,
      // 「还剩几天」的基准。数据面不读时钟，所以由这里算 —— 没有 gameTime 时给 null，
      // 状态照常展示、只是不写剩余天数（把「不知道」渲染成「永久」是这一格最贵的错）。
      currentDay: ctx.gameTime === undefined ? null : toGameDay(ctx.gameTime),
    });
    return renderMapContextBlock(snapshot, ctx.gameTime);
  },

  /**
   * {{RANDOM_EVENTS}} — 当前可触发的随机事件候选块（随机事件 v1 §5.1）：指令段 +
   * 一条候选一行（`[!]` 首访 / 优先级 / 名字 / 简报 / 可选演绎指引），包在 `<random_events>` 里。
   *
   * 🔴 **三条空串出口**（缺一条都是在花冤枉 token 或在错误的时机说话）:
   *    ① 池空（`randomEventOffer` 缺席或为空）—— 常态，绝大多数回合都走这条；
   *    ② 系统关闭（`randomEventsEnabled === false`，裁定 §13-4）；
   *    ③ **战斗会话活跃**（`combatActive`，裁定 §13-2）—— 掷骰照常、候选静默驻池，
   *      战斗结束后下一回合自然恢复注入。判据是**活跃位**不是 `recentCombat`（战后回执）。
   *    照 MAP_CONTEXT 的口径：块自带 XML 外壳，模板里**不要**再包一层中文标签 ——
   *    包了就会在空池时留下一对空标签，把「零成本」这条设计意图静默作废。
   * 🔴 数据面（过滤/排序）在 `random-event-context.buildRandomEventOffer`（纯函数），
   *    供值在 game-pipeline 的 `buildContext`。本 resolver 只负责**措辞**。
   * 🔴 只给名字与简报：没有 id、没有 MTTH、没有权重、没有过期日（AI 认领靠名字逐字一致，
   *    其余是引擎的记账，讲给它只会诱导它去推理概率）。
   */
  RANDOM_EVENTS: (ctx, _config, _params) => {
    if (ctx.randomEventsEnabled === false) return '';
    if (ctx.combatActive === true) return '';
    const offer = ctx.randomEventOffer ?? [];
    if (offer.length === 0) return '';
    return renderRandomEventsBlock(offer, (ctx.plotSettings?.mode ?? 'off') !== 'off');
  },

  /**
   * {{RECENT_COMBAT}} — 最近一场**已结算**战斗的事实块（2026-08-13 真机 debug）。
   *
   * 数据来自 `ctx.recentCombat`（game-pipeline 战斗终局时记录，内存级）。request_dispatcher
   * 据此分辨「正文在写已结算战斗的战后延续」vs「正文新开了一场战斗」——没有它，dispatcher
   * 看到正文里的战斗痕迹（尸体/焦痕/伤口）会按「战斗已发生必须重演」再发一次
   * `<combat_trigger>`，把打完的战斗原样重打一遍。
   *
   * 🔴 **本 resolver 只产事实**（名单/结果/结算回合），规则（何时不再发 combat_trigger）
   *    在 request_dispatcher 的 systemPrompt 里 —— 事实与指令分家，改措辞不用动引擎。
   * 🔴 缺席（没打过 / 放弃的战斗 / 跨会话丢内存）= 空串（零 token，照 MAP_CONTEXT 口径）。
   *    块自带 XML 外壳，模板里不要再包一层中文标签。
   */
  RECENT_COMBAT: (ctx, _config, _params) => {
    const rc = ctx.recentCombat;
    if (!rc) return '';
    const outcomeText: Record<RecentCombatInfo['outcome'], string> = {
      ally_win: '我方胜利',
      enemy_win: '敌方胜利',
      draw: '平局',
      fled: '我方撤退',
    };
    const lines = [
      '最近一场战斗已经通过战斗面板结算完成（数值已落库，无需重演）：',
      `我方: ${rc.allies.length > 0 ? rc.allies.join('、') : '（玩家）'} | 敌方: ${rc.enemies.join('、')}`,
      `结果: ${outcomeText[rc.outcome] ?? rc.outcome} | 结算时回合数: ${rc.endedAtTurn}`,
    ];
    return `<recent_combat>\n${lines.join('\n')}\n</recent_combat>`;
  },

  /** {{ACTIVE_EFFECTS}} — 提取所有角色的状态效果 */
  ACTIVE_EFFECTS: (ctx, _config, _params) => {
    const characters = ctx.characters ?? [];
    if (characters.length === 0) return '';
    const lines: string[] = [];
    for (const char of characters) {
      const effects = char.statusEffects ?? [];
      if (effects.length === 0) continue;
      const effectDescs = effects.map((e) => {
        const timeStr =
          e.remainingTime != null ? ` (剩余${e.remainingTime}${e.timeUnit || '分钟'})` : ' (永久)';
        return `${e.name}[${e.category}]${timeStr} — ${e.description || ''}`;
      });
      lines.push(`[${char.name}] 状态效果: ${effectDescs.join('; ')}`);
    }
    return lines.join('\n');
  },

  /** {{MEMORY_ENTRIES}} — 格式化记忆列表，支持 top_k 参数 */
  MEMORY_ENTRIES: (ctx, _config, params) => {
    const topK = params?.top_k ? parseInt(params.top_k, 10) : undefined;
    const formatted = formatMemoriesEntries(ctx, topK);
    if (!formatted) return '';
    const header =
      topK && topK > 0
        ? `**记忆库 (最近 ${topK} 条):**\n${formatted}`
        : `**记忆库:**\n${formatted}`;
    return header;
  },

  /** {{PLOT_EVENTS}} — 格式化剧情事件（仅 active + pending） */
  PLOT_EVENTS: (ctx, _config, _params) => {
    const formatted = formatPlotEventsEntries(ctx);
    if (!formatted) return '';
    return `**活跃剧情事件:**\n${formatted}`;
  },

  // ---- Agent Communication Placeholders (6) ----
  // 多 Agent 间通过 agentOutputs Map 传递输出。输出可能是字符串或对象（如 memory_recall embedding 路径返回 { memories: [...] }）。
  // 对象 → JSON.stringify，字符串 → 原样返回，避免隐式 String(obj) 产生 "[object Object]"。

  /** {{AGENT.MEMORY_RECALL}} */
  'AGENT.MEMORY_RECALL': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('memory_recall');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.PLOT_PRE_CHECK}} */
  'AGENT.PLOT_PRE_CHECK': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('plot_pre_check');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.STORY}} */
  'AGENT.STORY': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('story');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.VARS_UPDATE}} */
  'AGENT.VARS_UPDATE': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('vars_update');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.MEMORY_SUMMARY}} */
  'AGENT.MEMORY_SUMMARY': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('memory_summary');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{AGENT.REQUEST_DISPATCHER}} — request_dispatcher 调度器输出 */
  'AGENT.REQUEST_DISPATCHER': (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('request_dispatcher');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  // ---- Chain Communication Placeholders (5) (localParams injected) ----
  // 图像生成 G 阶段: `image_prompt` 侧链的输入块，由 callImagePromptAgent 经 localParams 注入
  IMAGE_REQUEST: (_ctx, _config, _params) => '',
  CRAFT_REQUEST: (_ctx, _config, _params) => '',
  CHAR_DETECT: (_ctx, _config, _params) => '',
  ITEM_REQUEST: (_ctx, _config, _params) => '',

  /** {{COMBAT_BRIEF}} — 战斗指令：战斗类型/环境/参战方与起因（来自 request_dispatcher 的 <combat_trigger>） */
  COMBAT_BRIEF: (_ctx, _config, _params) => '',

  /** {{COMBAT_ROSTER}} — 参战单位清单（我方/敌方名单，由 game-pipeline 从 <combat_trigger> 的 allies/enemies 组装） */
  COMBAT_ROSTER: (_ctx, _config, _params) => '',

  /** {{CHAR_GEN_RESULT}} — char_gen 输出 (从 agentOutputs 读取) */
  CHAR_GEN_RESULT: (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('char_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },

  /** {{CRAFT_RESULT}} — craft_gen 输出 (从 agentOutputs 读取) */
  CRAFT_RESULT: (ctx, _config, _params) => {
    const v = ctx.agentOutputs?.get('craft_gen');
    if (!v) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  },
};

// ═══════════════════════════════════════════════════════════
// Default Templates (per Agent)
// ═══════════════════════════════════════════════════════════

const DEFAULT_TEMPLATES: Record<string, string> = {
  // 随机事件 v1 (§5.1)：`{{RANDOM_EVENTS}}` 排在动态区之后、对话历史之前 —— 它每回合都可能
  // 变（池子会增删），放前面会把前缀缓存打碎；块自带 `<random_events>` 外壳，别再包中文标签。
  story:
    '{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n{{AGENT.PLOT_PRE_CHECK}}\n{{LORE_BOOK_STATIC}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK_DYNAMIC}}\n{{GAME_TIME}}\n{{RANDOM_EVENTS}}\n{{NARRATIVE}}\n{{USER_INPUT}}',
  memory_recall: '{{SYS_PROMPT}}\n{{MEMORY_ENTRIES}}\n{{NARRATIVE:layers=3}}\n{{USER_INPUT}}',
  // Phase 10 结构化（2026-07-20）: XML 分区 + 注释三要素 + 缓存排序。
  // {{PLOT_EVENTS}} 在管线中被 buildAgentMessages 的 localParams 覆盖为富上下文块
  // （<剧情大纲>+<剧情事件列表>+<当前状态>，见 agent-templates.ts buildPlotContextBlock）。
  plot_pre_check:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你判断剧情触发所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件——含尚未向玩家揭示的 hidden 事件，\n     防剧透只在 UI 层，你必须全量审视)、<当前状态>(时间/位置/主角层级一行摘要)。\n     这是你触发判断的唯一事件来源——triggeredEvents 的 title 必须与 <剧情事件列表> 逐字一致。\n     区块为空或缺大纲时（如支线模式初期）以现有内容为准，保守判断，不编造事件。-->\n\n<记忆召回>\n{{AGENT.MEMORY_RECALL}}\n</记忆召回>\n<!-- 上游记忆召回 Agent 给出的相关历史记忆。用于核对触发条件中的历史前提\n     （如「与铁匠建立信任之后」）。为空表示本轮无相关记忆——缺证据时按条件未满足处理。-->\n\n<最近对话>\n{{NARRATIVE:layers=3}}\n</最近对话>\n<!-- 🔴 每轮变化。最近 3 轮正文与玩家输入。评估证据强度时它是第二优先级——\n     低于本轮 <用户输入> 的明确行动，高于 <记忆召回> 中的旧线索。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言——触发判断的首要证据来源。-->',
  request_dispatcher:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成变量调度所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     判断角色种族和势力归属时参考此处。——稳定数据，优先查阅。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 当前存档中所有已有角色的列表（ID/Name/Race/Type/Tier/Location）。\n     这是你判断\"新角色 vs 已有角色\"的唯一依据——\n     角色名不在此表中 → 新角色 → <char_gen_request>；\n     角色名在此表中 → 已有角色 → <char_update_request>。-->\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n<!-- 所有角色背包中的物品、装备、材料清单。\n     这是你判断\"新物品 vs 已有物品\"的唯一依据——\n     物品名不在背包中 → 新物品 → <item_gen_request>；\n     物品名在背包中 → 已有物品 → <item_update_request>。-->\n\n<已有技能>\n{{SKILL_STATE}}\n</已有技能>\n<!-- 🔴 2026-08-02 新增: 所有角色的技能清单（含开局初始技能声明）。\n     这是你判断\"新技能 vs 已有技能\"的唯一依据——\n     技能名不在下表中 → 新技能 → <item_gen_request itemType="skill">（逐条单独发）；\n     技能名已在表中 → 已有技能，不重复生成。\n     开局初始技能声明标了「尚未落库，需生成」→ 逐条发 <item_gen_request itemType="skill">\n     让 item_gen 生成 stats/modifiers/automata。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n{{RECENT_COMBAT}}\n<!-- 最近一场已结算战斗的事实块（<recent_combat>，自带外壳）。战斗刚打完的那几轮它\n     会出现——正文里的战斗痕迹（尸体/焦痕/伤口）属于已结算战斗的战后延续，不要重发\n     <combat_trigger> 重演。缺席 = 没有已结算战斗记录，此区块零 token。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n<!-- 🔴 高频变化：本回合 Story Agent 生成的叙事正文。\n     仔细阅读全文，从中提取所有变量变化、新角色/物品出现、制作场景。——这是你的核心输入。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 本轮用户的原始输入。开局轮此处是自然叙述式开场提示词，含初始装备与技能的原名、描述及必要机制信息。\n     正文里改写过的装备/技能若与此处声明对应，按此处的原名与原描述发 request，\n     不要用正文改写名——否则 item_gen 会丢数值重掷。-->',
  vars_update:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你更新角色/物品状态的完整上下文数据。       -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。         -->\n<!-- ⚠️ 需要写脚本时调用 get_script_reference 工具。     -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n\n<已有物品>\n{{INVENTORY}}\n</已有物品>\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n\n<调度器输出>\n{{AGENT.REQUEST_DISPATCHER}}\n</调度器输出>\n<!-- request_dispatcher 的完整输出，包含 <char_update_request> 和 <item_update_request> 标签。\n     逐条读取每个标签，这是你需要处理的变更清单。-->\n\n<正文内容>\n{{AGENT.STORY}}\n</正文内容>\n\n<最近对话>\n{{NARRATIVE:layers=1}}\n</最近对话>',
  memory_summary: '{{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{NARRATIVE:layers=4}}',
  // Phase 10 结构化（2026-07-20）: 同 plot_pre_check，{{PLOT_EVENTS}} 由 localParams 覆盖为富上下文块。
  plot_post_check:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你审视世界线与事件状态所需的完整上下文。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<剧情事件库>\n{{PLOT_EVENTS}}\n</剧情事件库>\n<!-- 引擎注入的剧情全景数据，内含三个子区块：<剧情大纲>(标题/版本/当前章节/章节进度/正文节选)、\n     <剧情事件列表>(全部活跃与待触发事件的标题+描述+状态+触发条件)、<当前状态>(时间/位置/主角层级)。\n     eventUpdates 与 newChildEvents.parentTitle 只能引用 <剧情事件列表> 中逐字一致的标题；\n     世界线偏离程度以 <剧情大纲> 的预设走向为标尺。区块缺大纲时以事件列表为准，保守判断。-->\n\n<角色状态>\n{{CHARACTER_STATE}}\n</角色状态>\n<!-- 场景中角色的状态快照(层级/资源/位置等)。用于佐证事件完成/失败的客观后果\n     （如关键角色死亡 → 相关事件 fail）。以区块内容为准，缺失时不做推断。-->\n\n<最近对话>\n{{NARRATIVE:layers=4}}\n</最近对话>\n<!-- 最近 4 轮对话历史（不含本轮正文）。提供剧情连续性——判断世界线是否偏离时\n     结合前几轮走向一起看，避免把连续铺垫误判为突发变动。-->\n\n<用户输入>\n{{USER_INPUT}}\n</用户输入>\n<!-- 🔴 每轮变化。本轮玩家的行动宣言，与 <本轮正文> 对照理解玩家意图与选择后果。-->\n\n<本轮正文>\n{{AGENT.STORY}}\n</本轮正文>\n<!-- 🔴 每轮变化。本回合正文 AI 的完整输出——你审视的核心对象。\n     事件完成/失败、世界线变动的一切判断都必须以此处的直接证据为准。-->\n\n<本轮记忆总结>\n{{AGENT.MEMORY_SUMMARY}}\n</本轮记忆总结>\n<!-- 🔴 每轮变化。记忆总结 Agent 对本轮的压缩记录(含暗线线索)。\n     辅助你快速把握本轮要点；与 <本轮正文> 冲突时以正文为准。-->',
  plot_outline:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成剧情大纲所需的完整上下文。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<角色背景>\n{{CHARACTER_STATE}}\n</角色背景>\n<!-- 主角的种族/血脉/层级/属性/身份/背景故事/装备/技能/起源印记。\n     所有剧情必须以主角为核心展开——章节和事件的推动力必须来自主角的选择和成长。\n     不能偏成 NPC 传、世界观说明书或编年史。\n     以区块实际内容为准；缺字段时不做推断。-->\n\n<剧情配置>\n{{PLOT_EVENTS}}\n</剧情配置>\n<!-- 🔴 引擎注入的剧情配置（非事件列表）。由 create-store 通过 localParams 覆盖。\n     包含：模式(main=主线/side=支线)、持续年份、难度层级(T1-T7)、剧情偏向(战斗/解密/人际/恋爱/探索/政治/生存/悲剧)、\n     自定义偏好、是否允许世界书外NPC、专注区域(支线模式)、雷点(绝对禁止级)。\n     雷点优先级高于一切剧情偏好——绝对禁止生成雷点描述的任何内容。\n     区块为空时：默认 off 模式，不做推断。-->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前激活的世界书条目。涵盖势力/地理/种族/文化/组织/行业/怪物生态。\n     大纲的势力冲突、地理锚点、文化背景必须以此为准。\n     区块为空时以通用奇幻设定为准，不凭空发明势力名/地名。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<用户指令>\n{{USER_INPUT}}\n</用户指令>\n<!-- 🔴 每轮变化。初始生成 → "请根据以上信息生成剧情大纲" + 角色摘要；\n     修改模式 → 用户修改要求 + 上一版大纲完整 JSON。-->',
  // Phase 10 结构化模板：XML 分区 + 注释 + 缓存优化排序（稳定在上，动态在下）
  craft_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你完成制作任务所需的完整上下文数据。-->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力关系、地理信息、行业规范等。\n     制作产物的外观描述、材质选择、工艺风格应与当前世界观保持一致。\n     例如：尚武的山地文化锻造偏向实用粗犷，而重仪礼的学院文化炼金精于优雅调配。\n     区块为空时以通用奇幻设定为准，不凭空发明势力名/地名。-->\n\n<制作者状态>\n{{CHARACTER_STATE}}\n</制作者状态>\n<!-- 制作者及场景中其他角色的完整状态：基础属性(力量/智力/敏捷/精神)、当前HP/MP/SP、\n     等级与层级、已装备物品、已习得技能。制作准备阶段优先查阅此处获取核心属性值和层级信息，\n     以判断是否满足目标品质的层级封顶。若数据不足以完成检定，再调用 get_character 补充。-->\n\n<可用材料>\n{{INVENTORY}}\n</可用材料>\n<!-- 所有角色背包中的物品清单(材料/消耗品/装备等)。先查阅此处确认可用材料的种类和数量，\n     判断材料是否满足品质继承规则(至少2种同品质投入物)。若数据不完整再调用 get_inventory 补充。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<本次制作需求>\n{{CRAFT_REQUEST}}\n</本次制作需求>\n<!-- 从正文 <craft_request> 标记中提取的制作需求。包含用户期望制作的物品、目标品质、行业类型、\n     预期效果描述等。这是你执行制作的核心依据——仔细阅读用户的需求，作为产物设计的起点。-->\n\n<当前剧情>\n{{NARRATIVE:layers=1}}\n</当前剧情>\n<!-- 最近的对话历史。帮助你理解制作发生的场景和上下文——在铁匠铺锻造与在篝火边修理，\n     叙事描写方式截然不同。制作叙事应与当前剧情场景自然衔接。-->',
  char_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成角色所需的完整上下文数据。      -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖种族特性、血脉能力、势力关系、地理信息等。\n     角色外观、种族、文化背景、命名风格应与世界观保持一致。\n     例如：沙漠地带常见深色发肤的血统，而北方雪原多见浅色发瞳。\n     区块为空时以通用奇幻设定为准，不凭空发明势力名/地名/种族名。-->\n\n<已有角色>\n{{CHARACTER_STATE}}\n</已有角色>\n<!-- 场景中所有已有角色的状态快照。第一步先查阅此处——检查是否存在同名角色，\n     若同名已有角色存在则直接复用其数据，不调用随机工具。\n     同时判断新角色与已有角色之间是否存在潜在的血缘、势力或社交关系。\n     若列表不完整需要查重，再调用 get_character 补充。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<当前剧情场景>\n{{NARRATIVE:layers=1}}\n</当前剧情场景>\n<!-- 最近的对话历史。帮助你理解角色出场时的场景氛围——在酒馆偶遇、战场上对峙、\n     还是森林中邂逅，角色的外貌/装备/性格设定应贴合出场情境。-->\n\n<新角色描述>\n{{CHAR_DETECT}}\n</新角色描述>\n<!-- 从正文 <char_detect> 标记中提取的新角色描述，包含角色名、类型(npc/enemy/ally)、\n     外貌特征、行为表现、可能的背景线索。这是你生成角色的核心依据——\n     正文已明确的特征不要用随机工具覆盖，只用工具填充未提及的部分。-->',
  item_gen:
    '{{SYS_PROMPT}}\n\n<!-- ────────────────────────────────────────────── -->\n<!-- 以下各区块是你生成物品/技能/装备所需的完整上下文。  -->\n<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。    -->\n<!-- ────────────────────────────────────────────── -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力文化、地理信息等。\n     装备名和技能名应符合对应的文化和审美风格，品质描述统一使用7级体系。-->\n\n<可用物品库>\n{{INVENTORY}}\n</可用物品库>\n<!-- 所有角色背包中已有的物品、装备、材料清单。生成新物品时注意不与已有物品重复，\n     同时确保新装备的强度不会碾压已有装备，保持数值合理递增。-->\n\n<动态状态>\n{{LORE_BOOK_DYNAMIC}}\n</动态状态>\n<!-- 世界书中含 EJS/宏的动态条目（状态面板等），可能每回合变化。 -->\n\n<角色生成结果>\n{{CHAR_GEN_RESULT}}\n</角色生成结果>\n<!-- char_gen 输出的完整角色数据，包含 <skill_requests>/<equipment_requests>/<item_requests>\n     以及 <ascension> 登神长阶块（如有）。每个 <request> 中含需求描述和理由——\n     仔细阅读每一个 request，理解需求背后的角色定位，再开始编写。\n     若需要补充查询角色详细属性，调用 get_character。-->\n\n<制作结果>\n{{CRAFT_RESULT}}\n</制作结果>\n<!-- craft_gen 输出的制作结果，包含 <item_requests>。\n     仅在制作品质链中触发——为制作产物编写具体数值。未触发制作时此区块为空。-->\n\n<物品需求>\n{{ITEM_REQUEST}}\n</物品需求>\n<!-- 从 <item_requests> 中提取的具体需求列表。每个 <request> 对应一个需要编写的条目。\n     request 中的自然语言描述是唯一的需求来源——不要自行增减条目或改变需求方向。\n     注意区分来源：char_gen 的角色物品 vs craft_gen 的制作产物。-->\n\n<重铸目标>\n{{REWRITE_TARGET}}\n</重铸目标>\n<!-- 非空时进入重铸模式：这是要重写的那一个条目的当前完整数据。\n     只为它输出对应条目，并在条目上加 replace=\"<目标条目名>\" 属性声明替换。\n     不生成其他任何条目；空 = 普通新增模式。-->\n\n<重铸原因>\n{{REWRITE_REASON}}\n</重铸原因>\n<!-- 玩家对现状问题的描述（可能含 debug 线索，如「火球术伤害不对，应该 400 能量伤害却只有 200 物理伤害」）。\n     严格据此修正。空 = 无特殊说明。-->',
  // 图像生成 G 阶段（D28）: image_prompt 侧链。由 scene-image-store 的 runPromptAgent 缝唤起，
  // 不走主 DAG。刻意短 —— 挂便宜快模型，机械转换不需要整套世界观（世界书默认关，§8.5）。
  image_prompt:
    '{{SYS_PROMPT}}\n\n<!-- image_prompt 侧链由情景插画队列唤起，不走主 DAG（设计 §8.5 / D28）。 -->\n\n<世界设定>\n{{LORE_BOOK_STATIC}}\n</世界设定>\n<!-- 世界书对本 Agent 默认关闭。开了才有内容——地点/服饰的设定能提升画面保真度，代价是 token。-->\n\n<本次插画需求>\n{{IMAGE_REQUEST}}\n</本次插画需求>\n<!-- 引擎装配：story 写的那句中文 + 出场角色名 + 当前地点 + 分级 + 所属消息正文。\n     这是你转换的唯一输入——不要从别处推断画面内容，也不要复述这段文字。-->',
  // Q-04: 以下三个是**退役/别名** agentId，生产链路不会调它们（战斗主持已换 combat_v3，
  // 走 coordinator 自己的装配；plot_check / plot_correct 是 v3 兼容别名）。它们仍留在
  // AGENT_TEMPLATES 与 context-visibility 的可见性表里，所以这里给一条最小模板 ——
  // 让「没有默认模板」这个状态在仓库里彻底不存在，buildAgentMessages 只剩一条路。
  combat: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
  plot_check: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
  plot_correct: '{{SYS_PROMPT}}\n{{LORE_BOOK}}\n{{CHARACTER_STATE}}\n{{USER_INPUT}}',
};

/** Get the default template for a given agent, or empty string if unknown */
export function getDefaultTemplate(agentId: string): string {
  return DEFAULT_TEMPLATES[agentId] || '';
}
