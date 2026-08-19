<script setup lang="ts">
/**
 * MapPoliticalTab — 「势力地图」页签（地图系统 v1 / 设计 §9，裁定 §12-12）
 *
 * 自包含移植 sample 页那套已验证的渲染栈：`provinces.png` 解码成 `idBuf` → 整幅半透明政治
 * 着色 → RDP 简化的 SVG 边界 → 按 `idBuf` 命中检测。**刻意不与 OpenSeadragon 集成**
 * （裁定 §12-12）：改写成 OSD overlay 等于把坐标映射、重绘时机、命中检测对着 OSD 的缩放模型
 * 重推一遍 —— 纯集成风险、v1 零收益。代价是一个 Modal 里两套平移缩放实现，已接受；
 * 统一留给 v2。
 *
 * 分工（三层，各自可单测）:
 *   · `lib/map-political.ts`        —— 全部算法与变换数学（纯函数，零 DOM）
 *   · `lib/map-provinces-raster.ts` —— 唯一碰 canvas 解码的那一步（组件测试 mock 它）
 *   · `composables/useMapPolitical` —— 懒构建 / 按 contentHash 失效 / 卸载释放
 *   · 本文件                        —— 画布绘制、指针交互、信息卡、路线预览、出发指令
 *
 * 🔴 **「出发」不自动发送**（§8.2）：它把一句中文指令填进输入框（`game.fillInput`，
 *    ChatFlow 选项点击走的同一条缝），由玩家自己按发送。这不是谨慎过度 —— 自动发送会让
 *    一次误点消耗一个回合，而且那条路径绕过了「玩家可以改措辞」这件事。
 *    **绝不开第二条写路径**：地图不写任何状态，落位仍由 `set_location` → `applySetLocation` 走。
 *
 * 🔴 **画布像素色只能是数字常量**（下面那几个 RGBA）：`ImageData` 里放不进 CSS 变量。
 *    SVG 边界线与所有界面外壳照 `docs/design.md` 走主题 token，唯一的例外就是这几个像素色。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { getContentRegistry } from '../../stores/content-store';
import { resolveMapSources } from '../../composables/useMapViewer';
import { useMapPolitical } from '../../composables/useMapPolitical';
import { useAssetImage } from '../../composables/useAssetImage';
import { isReducedMotion } from '../../lib/reduced-motion';
import {
  buildHighlightPatch,
  buildLabelsForMode,
  buildModePaint,
  buildPoliticalTint,
  buildRoutePolyline,
  buildRouteWaypoints,
  buildTileDetailModel,
  clampStageView,
  composeDepartureDirective,
  describeTile,
  developmentBarGeometry,
  estimateModeDays,
  fitStageView,
  formatPolylinePoints,
  frameStageOnPoints,
  labelsVisibleAtZoom,
  projectLabelsToScreen,
  projectToScreen,
  resolveEffectiveTintMode,
  stagePointToWorld,
  tileCentroidWorld,
  tileAtRasterPoint,
  tileNameOf,
  zoomStageView,
  type MapTintMode,
  type MapTintModeChoice,
  type StageView,
} from '../../lib/map-political';
import { getMapIndex, getMapPack } from '@engine/map-runtime';
// 落位解析（引擎的落位契约本体）—— 这里**只读**，不写任何派生态，理由见 `playerTileId`
import { resolveTileByLocation } from '@engine/map-index';
import { findPath } from '@engine/map-path';
import { getMapFactsFlags, getMapFlags } from '@engine/save-profile';
import { toEpochMinutes } from '@engine/time-system';
import type { MapRoute } from '@engine/types-map';

// ═══ 高亮像素色（RGBA；理由见文件头最后一条） ═══
const ROUTE_RGBA = [255, 236, 178, 92] as const;
const VIA_RGBA = [173, 226, 255, 120] as const;
const AVOID_RGBA = [255, 138, 128, 110] as const;
const SELECT_RGBA = [255, 246, 214, 104] as const;
const HOVER_RGBA = [255, 250, 232, 54] as const;
// 🔴 玩家**没有**像素高亮色：他所在的那一块曾经也涂一层，但那既指不准（整块地一起亮，
//    读不出「人在哪」）又与选中/路线的涂色抢同一个平面。现在改画一枚棋子（`.pol-pin`）。

/**
 * 三档着色方式。**会话内的纯界面状态**（一个 ref，不落任何存储）——
 * 地图一个字节的持久状态都不写（ADR-31 / 文件头那条），一个显示开关更不该开这个先例。
 */
/** 三个实档的名字（**唯一**一处，按钮组与自动档的后缀都从这里取，免得两处飘开） */
const EFFECTIVE_LABEL: Record<MapTintMode, string> = {
  country: '势力',
  midTier: '中层',
  tile: '地块',
};

const MODE_OPTIONS: readonly { id: MapTintModeChoice; label: string }[] = [
  { id: 'auto', label: '自动' },
  { id: 'country', label: EFFECTIVE_LABEL.country },
  { id: 'midTier', label: EFFECTIVE_LABEL.midTier },
  { id: 'tile', label: EFFECTIVE_LABEL.tile },
];

/**
 * 缩放停下多久算「停稳了」（freeze-and-settle 的那个 settle）。
 *
 * 🔴 这个常量是**性能契约**，不是手感参数：所有「按分辨率算」的东西（标签字号与可见性、
 *    棋子大小、边界线宽、自动档分档）一律读停稳后的视图，缩放过程中一个都不动。
 *    详见 `settledView`。
 */
const SETTLE_MS = 150;

/** 拖拽判据：位移小于这个数才算「点击」而不是「拖完地图松手」 */
const CLICK_SLOP_PX = 3;
/** 一次取景动画的时长（减动效时整段跳过，见 `animateView`） */
const FRAME_MS = 260;

/**
 * `active` = 现在是不是停在这个页签上。
 *
 * 🔴 收这个 prop 而不是在 `onMounted` 里建一次就完事：宿主用 **v-if 首开挂载 + v-show 切换**
 *    （见 `MapPanel.vue` 文件头），所以本组件在 Modal 关闭前只挂载一次，而「又切回来了」
 *    这件事只有 prop 变化能告诉它。`ensureBuilt` 按 `contentHash` 幂等：
 *    页签来回切是缓存命中（不重建 8.7M 像素），中途换过地图包则重建。
 */
const props = defineProps<{ active?: boolean }>();

const game = useGameStore();
// 解构成顶层绑定：模板里才会自动解包（`pol.status` 那种嵌套 ref 在模板里**不**解包，
// 得写成 `pol.status.value` —— 写漏一个 `.value` 的表现是那一格永远为真）
const {
  status: polStatus,
  message: polMessage,
  stage: polStage,
  diagnostics: polDiagnostics,
  ensureBuilt: ensurePolBuilt,
} = useMapPolitical();

/** 就绪态的舞台（`useMapPolitical` 不导出这个类型，从值上取，避免第二处声明漂移） */
type PoliticalStage = NonNullable<typeof polStage.value>;

const stageRef = ref<HTMLDivElement | null>(null);
const tintRef = ref<HTMLCanvasElement | null>(null);
const fxRef = ref<HTMLCanvasElement | null>(null);

const view = ref<StageView>({ s: 1, x: 0, y: 0, min: 1, max: 1 });

/**
 * **停稳后**的视图（freeze-and-settle）—— 缩放手势期间它不动，最后一次缩放的
 * `SETTLE_MS` 毫秒后才追上 `view`。
 *
 * 🔴 为什么必须有这一层（2026-08-12 真机剖析，最坏帧 ~250ms）：手势期间只要有**任何**
 *    按分辨率算的东西跟着 `view.s` 变，浏览器就没法复用已经栅格化好的那张图 ——
 *    两条实测出来的罪证各自都能把帧拖到 200ms 以上：
 *      ① 边界线的 `vector-effect: non-scaling-stroke`：线宽要按屏幕算，
 *         那么「把旧栅格拉大」就是错的，于是**每一格滚轮**整张 SVG 重新栅格化。
 *      ② `--pol-label-k` 每格变一次：310 个带描边的中文标签逐帧重排 + 重刻字形。
 *    所以规矩是：**`view` 只准喂 `.pol-world` 的 transform**（那是纯 GPU 变换，
 *    合成器直接缩放现成的栅格）；一切按分辨率算的量一律读 `settledView`。
 *    代价是手势中标签/棋子跟着地图一起缩放（大小暂时不对），停手 150ms 内自己纠正 ——
 *    这个取舍是刻意的：动的时候没人在读地名，卡顿却人人都感觉得到。
 * 🔴 平移**不需要**进这一层：`x`/`y` 不改变任何分辨率相关的量，只挪 transform。
 */
const settledView = ref<StageView>({ s: 1, x: 0, y: 0, min: 1, max: 1 });

/**
 * 舞台尺寸的**响应式**副本（`viewportSize()` 是命令式的，computed 里读不到变化）。
 * 只在 settle / 挂载 / 容器尺寸变化时同步 —— 手势期间它不变，所以不参与逐帧开销。
 */
const viewport = ref({ vw: 0, vh: 0 });

const tintMode = ref<MapTintModeChoice>('auto');
const hoverTileId = ref(0);
const selectedTileId = ref(0);
const viaTileIds = ref<number[]>([]);
const avoidTileIds = ref<number[]>([]);
const routeVisible = ref(false);
const settingLocation = ref(false);
const setLocationError = ref('');
const tipLeft = ref(0);
const tipTop = ref(0);

/**
 * 底图位图与政治着色的离屏底片 —— **刻意不是 ref**：它们只被绘制代码读，
 * 进响应式系统只会让 Vue 白白深遍历一份 8.7M 像素的缓冲。
 */
let baseBitmap: ImageBitmap | null = null;
let tintSource: HTMLCanvasElement | null = null;
/** 上面那张底片是按哪一版舞台 + 哪一档着色烘的（换包或换档时靠它判失效） */
let tintSourceStage: PoliticalStage | null = null;
let tintSourceMode: MapTintMode | null = null;
/** 卸载后仍可能落地的解码 —— 落地时拿它判「还要不要」 */
let disposed = false;
let resizeObserver: ResizeObserver | null = null;
let frameRaf = 0;
/** settle 防抖句柄（0 = 没有在等） */
let settleTimer = 0;

// ═══ 派生 ═══

const raster = computed(() => polStage.value?.raster ?? null);
const worldW = computed(() => raster.value?.w ?? 0);
const worldH = computed(() => raster.value?.h ?? 0);
const borders = computed(() => polStage.value?.borders ?? null);

/**
 * 运行时索引。
 *
 * 🔴 `getMapIndex()` 是模块级、**非响应式**的（按现行包记忆化）。`void polStage.value`
 *    这一句是重算的门 —— 换包时舞台会重建，索引跟着重取。少了它，装完内容包地图数据还是旧的，
 *    而那不报错（先例：设置页读内容注册表那条）。
 */
const mapIndex = computed(() => {
  void polStage.value;
  return getMapIndex();
});

/**
 * **实际用来画的那一档**。自动档由缩放决定粒度（口径在 `map-political.ts`）；
 * 手动三档原样透传。整个渲染面 —— 着色缓冲、标签、按钮态 —— 一律读这一个，
 * 绝不再各自去看 `tintMode`：那样自动档就会在某些面生效、某些面不生效。
 */
const effectiveMode = computed(() => resolveEffectiveTintMode(tintMode.value, settledView.value));

/** 自动档按钮上带出当前实档，否则玩家会不明白「我什么都没点，颜色怎么变了」 */
function modeLabel(option: { id: MapTintModeChoice; label: string }): string {
  if (option.id !== 'auto' || tintMode.value !== 'auto') return option.label;
  return `自动·${EFFECTIVE_LABEL[effectiveMode.value]}`;
}

const worldViewBox = computed(() => `0 0 ${worldW.value} ${worldH.value}`);
const worldStyle = computed(() => ({
  width: `${worldW.value}px`,
  height: `${worldH.value}px`,
  transform: `translate(${view.value.x}px, ${view.value.y}px) scale(${view.value.s})`,
  /*
   * 世界层里**线宽**的反缩放系数（标签与棋子已经搬去屏幕层，不再用它）。
   *
   * 🔴 取 `settledView` 不是 `view`，且 `.pv-*` 上**禁用** `vector-effect:
   *    non-scaling-stroke`：那个属性等于告诉浏览器「线宽按屏幕算」，于是把旧栅格
   *    拉大就是错的 —— 每一格滚轮整张 SVG 重新栅格化（真机实测最坏帧 204ms）。
   *    改成世界单位 × 一个停稳后才变的系数：手势中 SVG 内容一个字节没变，
   *    合成器可以合法地复用那张栅格；停稳后写一次变量，重新栅格化一次。
   *    静止时的观感与之前逐字节相同（仍是 1.4/1.9/2.4/3.4 屏幕像素）。
   */
  '--pol-stroke-k': String(1 / (settledView.value.s || 1)),
}));

/*
 * 🔴 **屏幕层没有补偿变换，一个 scale() 都不许有**（2026-08-12 用户反馈）。
 *    上一版给这个容器套了个 `scale(f)` 把停稳时算好的坐标映射到实时视图 —— 结果是
 *    缩放过程中**字明显跟着变大变小、停手 150ms 后再"啪"地跳回去**。
 *    容器缩放这条路对文字天生就是错的：字号只要经过任何 scale，视觉大小就必然变。
 *    现在改成**每一帧按实时视图重新投影每个标签的位置**，只写 `transform: translate()`：
 *      · 字号是常量 12px/15px，**结构上不可能变**（没有任何东西缩放它）；
 *      · 位置逐帧精确跟着地图走，没有 150ms 的错位窗口；
 *      · 代价是每帧 ~35 次纯 transform 样式写入（裁剪后可见标签就这么多）+ 一趟纯数学，
 *        既不触发布局（绝对定位 + 固定尺寸）也不触发字形重刻。
 *    **别再把 scale 加回容器上**：那不报错，只是用户又会看见字在跳。
 */

/**
 * 标签。**粒度跟着着色粒度走**：地块档标地块名（310 个），中层档标中层名（一个域一个，
 * 约 45 个），势力档不标。挑哪一批在 `buildLabelsForMode` 里，这里不重写那个判断。
 */
const mapLabels = computed(() => {
  const stage = polStage.value;
  if (stage === null) return [];
  return buildLabelsForMode(stage.pack, effectiveMode.value, stage.raster.w, stage.raster.h);
});

/** 缩得太小时标签会糊成一团 —— 阈值口径在 `map-political.ts`，这里只问答案 */
const labelsVisible = computed(
  () => mapLabels.value.length > 0 && labelsVisibleAtZoom(settledView.value),
);

/**
 * 真正渲染的那批标签：**屏幕坐标 + 视口裁剪**，跟着**实时视图**逐帧重算。
 *
 * 🔴 这里用 `view` 而不是 `settledView`（与「哪一批标签」相反，见 `mapLabels`）：
 *    位置必须逐帧跟着地图走，否则要么错位、要么得靠容器 scale 补偿 —— 而那正是
 *    用户看见「字在变大变小然后跳一下」的原因。
 *    成本是一趟纯数学（≤310 项）+ 每个可见标签一次 transform 写入（裁剪后 ~35 个），
 *    不含布局、不含字形重刻。
 * 🔴 **哪一批**（地块名 310 / 中层名 49）仍由停稳后的档决定：换档要整组换 DOM，
 *    那件事绝不能发生在手势中间。
 */
const screenLabels = computed(() => {
  if (!labelsVisible.value) return [];
  return projectLabelsToScreen(mapLabels.value, view.value, viewport.value.vw, viewport.value.vh);
});

// ═══ 玩家棋子 ═══

/**
 * 棋子落点（玩家地块的形心）。地块整块涂色读不出「人在哪」，所以改画一枚立在形心上的棋子。
 */
const playerPinPoint = computed(() => {
  const stage = polStage.value;
  const tileId = playerTileId.value;
  if (stage === null || tileId === null) return null;
  return tileCentroidWorld(stage.pack, tileId, stage.raster.w, stage.raster.h);
});

/**
 * 棋子的定位样式。棋子与标签一样住在**不缩放的屏幕层**里，所以这里给的是屏幕坐标、
 * 尺寸是固定的 CSS 像素 —— 不再需要任何反缩放，头像也就不会在深缩放下糊掉。
 */
const playerPinStyle = computed(() => {
  const point = playerPinPoint.value;
  if (point === null) return undefined;
  // 与标签同一套：实时投影 + **只写 transform**。`translate(-50%, -100%)` 那一段把针尖
  // 挪到落点（百分比按元素自身尺寸算），放在后面 = 先作用于元素本身，再整体平移到位。
  const screen = projectToScreen(point, view.value);
  return { transform: `translate(${screen.x}px, ${screen.y}px) translate(-50%, -100%)` };
});

const playerName = computed(() => game.player?.name ?? '');
/**
 * 棋子上的脸。**刻意不传 `'头像'` 这一个类型**，走 composable 默认的脸位链
 * （头像 → 立绘 → 立绘bg）：传裸类型会让回退链失效，只有立绘的角色在头像位显示首字母 ——
 * 那正是 `useAssetImage` 文件头点名的那个洞。
 */
const { url: playerAvatarUrl, isVideo: playerAvatarIsVideo } = useAssetImage(playerName);
/** 没有素材时的兜底：名字首字（AvatarPanel 的口径）。视频素材也走这条 —— 一枚针不放视频 */
const playerInitial = computed(() => playerName.value.slice(0, 1));
const playerPinImage = computed(() =>
  playerAvatarUrl.value !== null && !playerAvatarIsVideo.value ? playerAvatarUrl.value : null,
);

// ═══ 路线折线 ═══

/**
 * 路线折线的顶点 / `points` 串 / 途经点标记。
 *
 * 这一层是**加在**既有的路线涂色之上的：涂色告诉你「经过哪些地」，线告诉你「按什么顺序」。
 * 只有涂色时，一条来回绕的路线看起来就是一片散开的色块。
 */
const routePoints = computed(() => {
  const stage = polStage.value;
  const path = route.value?.tilePath;
  if (stage === null || path === undefined) return [];
  return buildRoutePolyline(stage.pack, path, stage.raster.w, stage.raster.h);
});
const routePointsAttr = computed(() => formatPolylinePoints(routePoints.value));
const routeWaypoints = computed(() => {
  const stage = polStage.value;
  const path = route.value?.tilePath;
  if (stage === null || path === undefined) return [];
  return buildRouteWaypoints(stage.pack, path, viaTileIds.value, stage.raster.w, stage.raster.h);
});
/**
 * 途经点圆点的半径（世界单位）。线宽走 `non-scaling-stroke`（与边界同一口径），
 * 但 `r` 没有那个开关，所以在这里反缩放。途经点至多几个，逐节点改属性可以忽略不计
 * ——「几百个节点别逐个改属性」那条说的是名字标签。
 */
const routeDotRadius = computed(() => 5 / (settledView.value.s || 1));

/**
 * 玩家所在地块。**已落位的 `lastTileId` 永远优先**，拿不到时退到一次**只读的显示用落位**。
 *
 * 🔴 为什么需要退路（2026-08-12 真机走查）：新档的 `worldFlags.map.lastTileId` 是**空的** ——
 *    建档直接写 `CharacterState.location`，一个 `set_location` patch 都还没跑过，而落位钩子
 *    挂在那条 op 上。于是玩家在一张画得好好的图上看到「位置未定位」，路线规划整个锁死，
 *    而他的位置路径（形如 `大陆某区域-某国-某城`）本来完全解得开。
 *
 * 🔴 **只读投影，一个字节都不写**：这里**不碰** `updateMapFlags`、不碰任何 store。
 *    权威落位仍然只发生在 `state-manager.applySetLocation`（第一次真移动时），
 *    这一层只是把「按现在的位置路径看，棋子该在哪」画出来。
 *    在 UI 里顺手把它落库很诱人 —— 那等于开了第二条写路径，而它写的是一个**没有 patch
 *    背书**的派生态：换包自愈、快照回退、乃至「AI 其实把人挪到别处了」都会与它打架，
 *    且不报错。
 * 🔴 `resolveTileByLocation(..., null)` 的第三参传 `null`（不传当前块）：没有「当前块」这个
 *    事实可用（正是它缺席才走到这里），传别的值会让「路径只写到国家粗度」那一档
 *    （§8.2-3 原地不动）拿一个猜来的块当锚。
 */
const playerTileId = computed<number | null>(() => {
  const profile = game.saveProfile;
  const persisted = profile ? getMapFlags(profile).lastTileId : undefined;
  if (typeof persisted === 'number') return persisted;

  const location = game.player?.location;
  if (typeof location !== 'string' || location.trim().length === 0) return null;
  return resolveTileByLocation(mapIndex.value, location, null);
});
const playerTileView = computed(() =>
  playerTileId.value === null ? null : describeTile(mapIndex.value, playerTileId.value),
);

const journeyFlag = computed(() => {
  const profile = game.saveProfile;
  if (!profile) return null;
  return getMapFlags(profile).journey ?? null;
});

/**
 * 在途行。
 *
 * 🔴 剩余天数按**当前位置**重估，**不读** `journey.arriveAtMinute`（那需要时钟），
 *    也不信 `plannedPath` —— 计划路线是 advisory（裁定 §12-7 附加），叙事偏离时按新位置重估。
 *    口径与引擎侧 `map-context.describeJourney` 一致。
 */
const journeyLine = computed(() => {
  const flag = journeyFlag.value;
  if (flag === null) return '';
  const name = tileNameOf(mapIndex.value, flag.toTileId);
  if (name === null) return '';
  const from = playerTileId.value;
  if (from !== null && from !== flag.toTileId) {
    const remaining = findPath(getMapPack(), from, flag.toTileId);
    if (remaining !== null) return `在途：前往${name} · 约还需 ${remaining.days} 天`;
  }
  return `在途：前往${name}`;
});

const hoverView = computed(() =>
  hoverTileId.value > 0 ? describeTile(mapIndex.value, hoverTileId.value) : null,
);
const selectedView = computed(() =>
  selectedTileId.value > 0 ? describeTile(mapIndex.value, selectedTileId.value) : null,
);

// ═══ 地块事实态（地图 v1.2 / ADR-33 §5 UI）═══

/** 一个游戏日的分钟数（口径同 `state-manager` / `game-pipeline` / DebugPanel，那份常量未导出） */
const MINUTES_PER_GAME_DAY = 1440;

/**
 * 当前游戏日 —— 状态倒计时的基准（与结算器的 gameDay 同口径）。
 *
 * 🔴 `gameTime` **防御性读**：类型说必填，运行期不一定真有（老存档 / 手改备份 / 测试替身），
 *    而 `toEpochMinutes(undefined)` 是从 computed 里抛穿 —— 整张信息卡当场白掉，
 *    代价远大于「倒计时按第 0 日算」。
 */
const currentGameDay = computed(() => {
  const gameTime = game.saveProfile?.gameTime;
  if (!gameTime) return 0;
  return Math.floor(toEpochMinutes(gameTime) / MINUTES_PER_GAME_DAY);
});

/**
 * 选中地块的详情模型（发展条 / 状态 / 建筑槽 / 编年史）。
 *
 * 🔴 事实**按地块名为键**（ADR-33 §3），所以这里用 `tile.name` 取条目 —— 不是 tileId。
 *    换包后名字还在事实就继续生效，正是那条设计的直接后果。
 * 🔴 重算触发与 `playerTileId` 那条同款：`game.saveProfile` 是响应式的（提交后整份换新），
 *    `mapIndex` 里那句 `void polStage.value` 管的是「换了地图包」。两者都不动时不重算。
 * 🔴 一切措辞与判定都在 `buildTileDetailModel` 里（纯函数，可单测）——
 *    模板里只有 `v-for` 与 `v-if`。
 */
const selectedDetail = computed(() => {
  const view = selectedView.value;
  if (view === null) return null;
  const tile = mapIndex.value.tileById.get(view.tileId);
  if (tile === undefined) return null;
  const profile = game.saveProfile;
  const entry = profile ? getMapFactsFlags(profile).tiles[tile.name] : undefined;
  const pack = getMapPack();
  return buildTileDetailModel(
    tile,
    entry,
    pack.developmentLevels,
    currentGameDay.value,
    pack.mainBuildingNames,
  );
});

/** 发展条的填充段（几何在纯函数里，模板只写 style） */
const developmentBar = computed(() => {
  const development = selectedDetail.value?.development;
  return development ? developmentBarGeometry(development.progress) : null;
});

const viaNames = computed(() =>
  viaTileIds.value
    .map((id) => tileNameOf(mapIndex.value, id))
    .filter((name): name is string => name !== null),
);
const avoidNames = computed(() =>
  avoidTileIds.value
    .map((id) => tileNameOf(mapIndex.value, id))
    .filter((name): name is string => name !== null),
);

/** 「设为当前位置」的可用性（天堑不可选，理由见 `setHere`；已经站在那儿也没必要） */
const canSetLocation = computed(
  () =>
    selectedTileId.value > 0 &&
    selectedTileId.value !== playerTileId.value &&
    selectedView.value?.impassable !== true &&
    !settingLocation.value,
);

const canRoute = computed(
  () =>
    playerTileId.value !== null &&
    selectedTileId.value > 0 &&
    selectedTileId.value !== playerTileId.value,
);

/**
 * 路线预览。`via` / `avoid` 一变就重算（点了「查看路线」之后一直活着）——
 * 设计要的「途经点自选、路线实时重算」就是这条 computed。
 */
const route = computed<MapRoute | null>(() => {
  if (!routeVisible.value || !canRoute.value) return null;
  const from = playerTileId.value;
  if (from === null) return null;
  return findPath(getMapPack(), from, selectedTileId.value, {
    via: viaTileIds.value,
    avoid: avoidTileIds.value,
  });
});
const routeUnreachable = computed(
  () => routeVisible.value && canRoute.value && route.value === null,
);

/**
 * 出行方式表（pack v1.1.0 的 `travelRules.modes`）。**纯参考展示**，不可选：大字天数与
 * 出发指令都走基线口径（factor = 1 的方式 = 校准所依据的城际天数），方式行只是把
 * 各种方式的估算并排给玩家看 —— 要坐什么由玩家在输入框自己说，AI 自然看得见。
 * 旧包是空数组 → 方式行整个不渲染，与没有这个特性时逐字节一致。
 * 失效键与 `mapIndex` 同款（换包重建舞台）。
 */
const travelModes = computed(() => {
  void polStage.value;
  return getMapPack().travelRules.modes;
});
function modeDaysOf(factor: number): number {
  const r = route.value;
  return r === null ? 0 : estimateModeDays(r, factor);
}

const departureDirective = computed(() =>
  composeDepartureDirective({
    destination: selectedView.value?.name ?? '',
    via: viaNames.value,
    avoid: avoidNames.value,
    days: route.value?.days ?? null,
  }),
);

const diagnosticsLine = computed(() => {
  const d = polDiagnostics.value;
  if (d === null) return '';
  const parts: string[] = [];
  if (d.unknownRatio > 0.005) parts.push(`未识别像素 ${(d.unknownRatio * 100).toFixed(1)}%`);
  if (d.ambiguousTiles > 0) parts.push(`撞色地块 ${d.ambiguousTiles}`);
  return parts.length > 0 ? `${parts.join(' · ')} —— 地图图形与数据可能不是同一版` : '';
});

// ═══ 视图与绘制 ═══

function viewportSize(): { vw: number; vh: number } {
  const el = stageRef.value;
  if (!el) return { vw: 0, vh: 0 };
  const rect = el.getBoundingClientRect();
  return { vw: rect.width, vh: rect.height };
}

function fitView(): void {
  const { vw, vh } = viewportSize();
  view.value = fitStageView(vw, vh, worldW.value, worldH.value);
}

/** 平滑取景；减动效（系统偏好或应用开关）时**整段跳过**，直接落位（`lib/reduced-motion.ts`） */
function animateView(target: StageView): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRaf);
  if (isReducedMotion() || typeof requestAnimationFrame !== 'function') {
    view.value = target;
    return;
  }
  const from = { ...view.value };
  const startedAt = typeof performance === 'object' ? performance.now() : Date.now();
  const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now: number): void => {
    const t = Math.min(1, (now - startedAt) / FRAME_MS);
    const e = ease(t);
    view.value = {
      ...target,
      s: from.s + (target.s - from.s) * e,
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
    };
    if (t < 1) frameRaf = requestAnimationFrame(step);
  };
  frameRaf = requestAnimationFrame(step);
}

/** 地块形心 → 世界坐标（按 `resolution` 与实际栅格的比例折算，两者理论相等但不假设） */
function tileWorldPoint(tileId: number): [number, number] | null {
  const tile = mapIndex.value.tileById.get(tileId);
  const stage = polStage.value;
  if (tile === undefined || stage === null) return null;
  const res = getMapPack().resolution;
  const sx = res.w > 0 ? stage.raster.w / res.w : 1;
  const sy = res.h > 0 ? stage.raster.h / res.h : 1;
  return [tile.centroid[0] * sx, tile.centroid[1] * sy];
}

function frameTiles(tileIds: readonly number[]): void {
  const points = tileIds
    .map((id) => tileWorldPoint(id))
    .filter((p): p is [number, number] => p !== null);
  if (points.length === 0) return;
  const { vw, vh } = viewportSize();
  animateView(frameStageOnPoints(view.value, points, vw, vh, worldW.value, worldH.value));
}

/**
 * 政治着色的离屏底片（每版舞台烘一次）。
 *
 * 🔴 着色**必须**先落到离屏画布再 `drawImage` 上去，不能直接 `putImageData` 到可见画布：
 *    `putImageData` 是**覆盖**不是混合（含 alpha 通道），直接 put 会把底下刚画好的底图
 *    整片抹成半透明色块 —— 底图等于没画，而且不报错。
 */
function ensureTintSource(stage: PoliticalStage, mode: MapTintMode): HTMLCanvasElement | null {
  if (tintSource !== null && tintSourceStage === stage && tintSourceMode === mode)
    return tintSource;
  const canvas = document.createElement('canvas');
  canvas.width = stage.raster.w;
  canvas.height = stage.raster.h;
  // 判据是**假值**不是 `=== null`：没装 canvas 包的 jsdom 与老浏览器给的是 undefined，
  // 严格判 null 会让下一行在 undefined 上取 createImageData —— 组件当场抛在 watch 里
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const image = ctx.createImageData(stage.raster.w, stage.raster.h);
  // 🔴 势力档**直接用舞台烘好的那份缓冲**，不重算 —— 加这个开关之前它就是这么画的，
  //    复用同一个字节数组是「势力档逐像素不变」这条最可靠的保证（也省掉切回来的那 280ms）。
  //    另两档现算：**只留一张离屏底片**，绝不为三档各缓存一份 35MB（同 useMapPolitical 的预算）。
  image.data.set(
    mode === 'country'
      ? stage.tint
      : buildPoliticalTint(stage.raster, buildModePaint(stage.pack, mode)),
  );
  ctx.putImageData(image, 0, 0);
  tintSource = canvas;
  tintSourceStage = stage;
  tintSourceMode = mode;
  return canvas;
}

/**
 * 着色层 = 底图 + 政治色，**合成在同一张画布里**。
 *
 * 🔴 底图为什么不是一个 `<img>`：`.pol-world` 会被 `transform: scale()` 放大到约 24 倍
 *    （3900×2226 的世界层），而浏览器对**被拉伸的图片层**是按当前缩放重新光栅化的 ——
 *    深缩放时那张光栅面超出图块/纹理预算，部分区域就**永远排不上光栅**，表现为阶梯状的
 *    空白块（真机可见，且只在放大到一定倍数后出现）。画进 canvas 之后它是一张**固定
 *    3900×2226 的纹理**，缩放只是 GPU 采样，不存在「重新光栅化失败」这回事 ——
 *    旁边两层 canvas 从来不掉就是这个原因。
 *
 * 底图还没解码完时只画着色（= 内容包没有底图时的既有表现），解码落地后再重画一次。
 */
function paintTint(): void {
  const stage = polStage.value;
  const canvas = tintRef.value;
  if (stage === null || canvas === null) return;
  // jsdom 没有 2D 上下文 —— 拿不到就不画（组件测试只验数据与结构，不验像素）
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const tint = ensureTintSource(stage, effectiveMode.value);
  if (tint === null) return;
  ctx.clearRect(0, 0, stage.raster.w, stage.raster.h);
  if (baseBitmap !== null) ctx.drawImage(baseBitmap, 0, 0, stage.raster.w, stage.raster.h);
  ctx.drawImage(tint, 0, 0);
}

function paintFx(): void {
  const stage = polStage.value;
  const canvas = fxRef.value;
  if (stage === null || canvas === null) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, stage.raster.w, stage.raster.h);

  // 后写的赢：路线 → 回避 → 途经 → 选中 → 悬停（玩家不在此列，他是一枚棋子）
  const colors = new Map<number, readonly [number, number, number, number]>();
  for (const id of route.value?.tilePath ?? []) colors.set(id, ROUTE_RGBA);
  for (const id of avoidTileIds.value) colors.set(id, AVOID_RGBA);
  for (const id of viaTileIds.value) colors.set(id, VIA_RGBA);
  if (selectedTileId.value > 0) colors.set(selectedTileId.value, SELECT_RGBA);
  if (hoverTileId.value > 0 && hoverTileId.value !== selectedTileId.value) {
    colors.set(hoverTileId.value, HOVER_RGBA);
  }

  const patch = buildHighlightPatch(stage.raster, colors);
  if (patch === null) return;
  const image = ctx.createImageData(patch.w, patch.h);
  image.data.set(patch.data);
  ctx.putImageData(image, patch.x, patch.y);
}

// ═══ 指针交互 ═══

interface DragState {
  px: number;
  py: number;
  ox: number;
  oy: number;
  moved: number;
}
let drag: DragState | null = null;
let lastDragMoved = 0;
const pointers = new Map<number, { x: number; y: number }>();
let pinch: { d: number; s: number } | null = null;

function stageOffset(clientX: number, clientY: number): { ox: number; oy: number } | null {
  const el = stageRef.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { ox: clientX - rect.left, oy: clientY - rect.top };
}

function tileAtClient(clientX: number, clientY: number): number {
  const stage = polStage.value;
  const offset = stageOffset(clientX, clientY);
  if (stage === null || offset === null) return 0;
  const { wx, wy } = stagePointToWorld(view.value, offset.ox, offset.oy);
  return tileAtRasterPoint(stage.raster, wx, wy);
}

function onWheel(event: WheelEvent): void {
  event.preventDefault();
  const offset = stageOffset(event.clientX, event.clientY);
  if (offset === null) return;
  const { vw, vh } = viewportSize();
  view.value = zoomStageView(
    view.value,
    offset.ox,
    offset.oy,
    Math.exp(-event.deltaY * 0.0016),
    vw,
    vh,
    worldW.value,
    worldH.value,
  );
}

function zoomByStep(factor: number): void {
  const { vw, vh } = viewportSize();
  view.value = zoomStageView(
    view.value,
    vw / 2,
    vh / 2,
    factor,
    vw,
    vh,
    worldW.value,
    worldH.value,
  );
}

function onPointerDown(event: PointerEvent): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRaf);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.value.s };
    drag = null;
    return;
  }
  // jsdom 没有 setPointerCapture；没有它只是拖到容器外会断，不该抛
  try {
    stageRef.value?.setPointerCapture?.(event.pointerId);
  } catch {
    /* 环境不支持，忽略 */
  }
  drag = { px: event.clientX, py: event.clientY, ox: view.value.x, oy: view.value.y, moved: 0 };
}

function onPointerMove(event: PointerEvent): void {
  if (pointers.has(event.pointerId)) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }

  if (pinch !== null && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const center = stageOffset((a.x + b.x) / 2, (a.y + b.y) / 2);
    if (center !== null && pinch.d > 0) {
      const { vw, vh } = viewportSize();
      view.value = zoomStageView(
        view.value,
        center.ox,
        center.oy,
        (pinch.s * (d / pinch.d)) / view.value.s,
        vw,
        vh,
        worldW.value,
        worldH.value,
      );
    }
    return;
  }

  if (drag !== null) {
    const dx = event.clientX - drag.px;
    const dy = event.clientY - drag.py;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    const { vw, vh } = viewportSize();
    view.value = clampStageView(
      { ...view.value, x: drag.ox + dx, y: drag.oy + dy },
      vw,
      vh,
      worldW.value,
      worldH.value,
    );
    if (drag.moved > CLICK_SLOP_PX) {
      hoverTileId.value = 0;
      return;
    }
  }

  // 悬停：拖拽/捏合中不提示（手上在操作地图，气泡只会挡视线）
  const tileId = tileAtClient(event.clientX, event.clientY);
  hoverTileId.value = tileId > 0 ? tileId : 0;
  const offset = stageOffset(event.clientX, event.clientY);
  if (offset !== null) {
    tipLeft.value = offset.ox;
    tipTop.value = offset.oy;
  }
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag !== null) {
    lastDragMoved = drag.moved;
    drag = null;
  }
}

function onPointerLeave(): void {
  hoverTileId.value = 0;
}

function onStageClick(event: MouseEvent): void {
  if (lastDragMoved > CLICK_SLOP_PX) {
    lastDragMoved = 0;
    return;
  }
  const tileId = tileAtClient(event.clientX, event.clientY);
  if (tileId <= 0) {
    selectedTileId.value = 0;
    return;
  }
  selectedTileId.value = tileId;
}

// ═══ 信息卡动作 ═══

function showRoute(): void {
  routeVisible.value = true;
  const path = route.value?.tilePath ?? [];
  if (path.length > 0) frameTiles(path);
}

function toggleVia(): void {
  const id = selectedTileId.value;
  if (id <= 0) return;
  viaTileIds.value = viaTileIds.value.includes(id)
    ? viaTileIds.value.filter((v) => v !== id)
    : [...viaTileIds.value, id];
  // 途经与回避互斥：同一块地既取道又避开是一条永远无解的查询
  avoidTileIds.value = avoidTileIds.value.filter((v) => v !== id);
}

function toggleAvoid(): void {
  const id = selectedTileId.value;
  if (id <= 0) return;
  avoidTileIds.value = avoidTileIds.value.includes(id)
    ? avoidTileIds.value.filter((v) => v !== id)
    : [...avoidTileIds.value, id];
  viaTileIds.value = viaTileIds.value.filter((v) => v !== id);
}

function clearPlan(): void {
  viaTileIds.value = [];
  avoidTileIds.value = [];
  routeVisible.value = false;
}

/**
 * 「出发」—— 把指令填进输入框（**不发送**，见文件头）。
 *
 * `fillInput` 是 ChatFlow 点击行动选项走的同一条缝（`game-store.pendingInput` → InputBar），
 * 所以这里没有第二条写路径，也不碰任何存档状态。填完关掉 Modal：输入框就在下面，
 * 玩家看得见自己要发什么。
 */
function depart(): void {
  const text = departureDirective.value;
  if (text.length === 0) return;
  game.fillInput(text);
  // 关掉 Modal：输入框就在下面，玩家看得见自己要发什么（也就不需要一句「已填入」的提示）
  game.closeModal();
}

/**
 * 「设为当前位置」—— 手动落位。
 *
 * 🔴 **本组件仍然零写入**：它只调 `game.setPlayerLocation(地块名)`，那条 action 提交
 *    一条 `set_location`，地块投影由引擎钩子在位置路径落库之后自己做（见那条 action）。
 *    这里不碰 `worldFlags.map`、不碰 `lastTileId` —— 文件头「地图不写任何状态」那条讲的是
 *    「不开第二条写路径」，走引擎唯一写入口的这条不是第二条。
 * 🔴 天堑不可选：`findPath` 把不可通行块整个剔出邻接图，落位到那里之后从它出发的
 *    任何路线规划都恒为无解 —— 玩家会得到一张「哪都去不了」的地图，且看不出原因。
 */
async function setHere(): Promise<void> {
  // 变量名刻意不叫 `view` —— 那是舞台视图的 ref，遮蔽它会让后面读代码的人看错一层
  const target = selectedView.value;
  if (target === null || !canSetLocation.value) return;
  settingLocation.value = true;
  try {
    const result = await game.setPlayerLocation(target.name);
    // 失败只说一句，不改任何界面状态（位置真源在存档里，这里没有本地副本要回滚）
    setLocationError.value = result.ok ? '' : (result.error ?? '落位失败');
  } finally {
    settingLocation.value = false;
  }
}

function focusPlayer(): void {
  if (playerTileId.value === null) return;
  frameTiles([playerTileId.value]);
}

// ═══ 生命周期 ═══

/**
 * 底图：复用标记页签那条链（内容注册表 `branding.mapSources` + Dexie `mapBlobs` 缓存），
 * 解码成 `ImageBitmap` 交给 `paintTint` 合成（理由见那里）。
 *
 * 🔴 **只读缓存不回写**：字节的落库归标记页签那条下载链，这里凑巧没命中就自己取一次，
 *    没有第二个写 `mapBlobs` 的地方。
 * 🔴 任何一步不成就**静悄悄退化成只有着色**（= 内容包没带底图时的既有表现）：
 *    底图是装饰，缺了它地块、边界、命中一样都不少，不值得为它弹一个错误态。
 */
async function loadBaseArt(): Promise<void> {
  // jsdom 与老浏览器没有 createImageBitmap —— 没有它就没有底图，其余一切照旧
  if (typeof createImageBitmap !== 'function') return;
  const sources = resolveMapSources(getContentRegistry().branding);
  const first = sources[0];
  if (first === undefined) return;

  let bytes: Blob | undefined;
  try {
    const { getDatabase } = await import('@engine/database');
    bytes = (await getDatabase().mapBlobs.get(first.url))?.blob;
  } catch {
    /* 缓存拿不到就现取 */
  }
  if (bytes === undefined) {
    try {
      const response = await fetch(first.url, { mode: 'cors' });
      if (!response.ok) return;
      bytes = await response.blob();
    } catch {
      return;
    }
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(bytes);
  } catch {
    return;
  }
  // 解码是异步的，落地时组件可能已经卸载 —— 那就地释放，别把它挂在一个死组件上
  if (disposed) {
    bitmap.close();
    return;
  }
  baseBitmap = bitmap;
  // 舞台可能早就就绪、`paintTint` 也早跑过了（那时还没有底图）—— 补画一次
  if (polStage.value !== null) paintTint();
}

/** 舞台尺寸 → 响应式副本（屏幕层投影要用；只在停稳/挂载/容器变化时调） */
function syncViewport(): void {
  const { vw, vh } = viewportSize();
  if (viewport.value.vw !== vw || viewport.value.vh !== vh) viewport.value = { vw, vh };
}

/** 立刻把 `settledView` 对齐到当前视图（取景/首次就绪这类「不是手势」的跳变用它） */
function settleNow(): void {
  if (settleTimer !== 0) {
    clearTimeout(settleTimer);
    settleTimer = 0;
  }
  syncViewport();
  settledView.value = { ...view.value };
}

/**
 * 缩放防抖 → `settledView`。
 *
 * 只盯 `s` 与 `min`（`min` 会在容器尺寸变化时变）—— 平移不进这一层，理由见 `settledView`。
 */
watch(
  () => [view.value.s, view.value.min] as const,
  () => {
    if (settleTimer !== 0) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      syncViewport();
      settledView.value = { ...view.value };
    }, SETTLE_MS) as unknown as number;
  },
);

watch(
  () => props.active === true,
  (active) => {
    if (active) void ensurePolBuilt();
  },
  { immediate: true },
);

onMounted(() => {
  void loadBaseArt();
  if (typeof ResizeObserver === 'function' && stageRef.value !== null) {
    resizeObserver = new ResizeObserver(() => {
      const { vw, vh } = viewportSize();
      syncViewport();
      if (vw <= 0 || vh <= 0 || worldW.value <= 0) return;
      const fitted = fitStageView(vw, vh, worldW.value, worldH.value);
      view.value = clampStageView(
        { ...view.value, min: fitted.min, max: fitted.max },
        vw,
        vh,
        worldW.value,
        worldH.value,
      );
    });
    resizeObserver.observe(stageRef.value);
  }
});

watch(
  () => polStage.value,
  async (stage) => {
    if (stage === null) return;
    await nextTick();
    fitView();
    // 首次就绪不是手势 —— 立刻对齐，否则头 150ms 会拿退化视图（s=1）的档去画第一帧
    settleNow();
    paintTint();
    paintFx();
    if (playerTileId.value !== null) frameTiles([playerTileId.value]);
  },
);

watch([route, hoverTileId, selectedTileId, viaTileIds, avoidTileIds, playerTileId], () => {
  paintFx();
});

/**
 * 换档 → 重烘那张离屏底片再合成一遍（同步，整幅约 100ms）。
 *
 * 🔴 watch 的是**实档**不是玩家选的那一档：自动档下跨过一个缩放阈值时没有任何点击发生，
 *    盯着 `tintMode` 的话颜色就永远停在进入自动档那一刻的粒度。
 *    实档一轮缩放里至多变两次，所以这不是「每帧重烘」。
 */
watch(effectiveMode, () => {
  paintTint();
});

onBeforeUnmount(() => {
  disposed = true;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRaf);
  resizeObserver?.disconnect();
  resizeObserver = null;
  // 位图与离屏底片各自占一份全幅像素（约 35MB 量级）—— 与 `useMapPolitical` 的
  // 「懒建 + 卸载释放」同一笔预算，漏放的表现不是报错而是本局一直背着它
  baseBitmap?.close();
  baseBitmap = null;
  tintSource = null;
  tintSourceStage = null;
  tintSourceMode = null;
});
</script>

<template>
  <div class="pol-panel">
    <!-- ═══ 页签头：玩家位置 / 在途 / 视图操作 ═══ -->
    <div class="pol-toolbar">
      <div class="pol-status">
        <span v-if="playerTileView" class="pol-chip">
          <i class="fa-solid fa-location-dot" />
          当前：{{ playerTileView.name }}
          <span v-if="playerTileView.countryName" class="pol-chip-sub">
            {{ playerTileView.countryName }}
          </span>
        </span>
        <span v-else class="pol-chip pol-chip-muted">
          <i class="fa-solid fa-location-crosshairs" />
          位置未定位
        </span>
        <span v-if="journeyLine" class="pol-chip pol-chip-journey">
          <i class="fa-solid fa-route" />
          {{ journeyLine }}
        </span>
      </div>
      <div class="pol-actions">
        <!-- 着色方式：紧凑按钮组（design.md §4 的 Tab 语义，用 aria-pressed 表达当前档） -->
        <div class="pol-modes" role="group" aria-label="着色方式">
          <button
            v-for="option in MODE_OPTIONS"
            :key="option.id"
            class="pol-btn pol-mode"
            :class="{ 'pol-mode-active': tintMode === option.id }"
            :data-mode="option.id"
            :aria-pressed="tintMode === option.id"
            @click="tintMode = option.id"
          >
            {{ modeLabel(option) }}
          </button>
        </div>
        <button class="pol-btn" :disabled="playerTileId === null" @click="focusPlayer">
          定位玩家
        </button>
        <button class="pol-btn" @click="zoomByStep(1.35)">放大</button>
        <button class="pol-btn" @click="zoomByStep(1 / 1.35)">缩小</button>
        <button class="pol-btn" @click="fitView">适应</button>
      </div>
    </div>

    <div class="pol-body">
      <!-- ═══ 舞台 ═══ -->
      <div
        ref="stageRef"
        class="pol-stage"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @pointerleave="onPointerLeave"
        @click="onStageClick"
      >
        <!-- 非就绪态：加载中 / 空态 / 错误。空态用 design.md §5.2 的装饰符 + 斜体说明 -->
        <div v-if="polStatus === 'building'" class="pol-overlay">势力地图构建中…</div>
        <div v-else-if="polStatus === 'empty'" class="pol-empty">
          {{ polMessage || '地图数据未安装' }}
          <span class="pol-empty-hint">安装地图内容包后，这里会显示势力疆域与地块信息</span>
        </div>
        <div v-else-if="polStatus === 'error'" class="pol-empty pol-empty-error">
          {{ polMessage }}
        </div>

        <div v-if="polStatus === 'ready' && raster" class="pol-world" :style="worldStyle">
          <!-- 底图已合成进这张着色画布，**刻意不留独立的图片层**（理由见 `paintTint`） -->
          <canvas ref="tintRef" class="pol-layer" :width="worldW" :height="worldH" />
          <canvas ref="fxRef" class="pol-layer" :width="worldW" :height="worldH" />
          <svg class="pol-vec" :viewBox="worldViewBox" preserveAspectRatio="none">
            <path class="pv-prov" :d="borders?.province || ''" />
            <path class="pv-coast" :d="borders?.coast || ''" />
            <path class="pv-impass" :d="borders?.impassable || ''" />
            <path class="pv-nat" :d="borders?.national || ''" />
            <!--
              路线折线（**加在**既有路线涂色之上）：涂色说「经过哪些地」，线说「按什么顺序」。
              画两条同样的线 = 浅色光晕在下、虚线在上，这样它在羊皮纸与色块上都读得出来。
            -->
            <template v-if="routePointsAttr">
              <polyline class="pol-route-halo" :points="routePointsAttr" />
              <polyline class="pol-route-line" :points="routePointsAttr" />
            </template>
            <circle
              v-for="waypoint in routeWaypoints"
              :key="waypoint.tileId"
              class="pol-route-dot"
              :cx="waypoint.x"
              :cy="waypoint.y"
              :r="routeDotRadius"
            />
          </svg>
        </div>

        <!--
          ═══ 屏幕层：名字标签 + 玩家棋子 ═══

          🔴 它们**必须住在 `.pol-world` 外面**（2026-08-12）：那一层被 scale() 放大，
             而 Chromium 对巨大合成层的栅格化倍率有上限 —— 超过之后是把已有栅格拉大，
             住在里面的文字与头像**必糊**，且字号怎么调都救不回来（问题在层的栅格，不在字号）。
             搬到不缩放的这一层之后，12px 就是真的 12px，任何缩放下都锐利。
          🔴 每个标签/棋子**逐帧按实时视图重新投影**，且只写 `transform: translate()`
             （容器上**没有** scale —— 那条路会让用户看见字变大变小再跳回去，见脚本里那段）。
             字号是常量，所以「大小不变」是结构保证而不是补偿出来的。
        -->
        <div v-if="polStatus === 'ready' && raster" class="pol-screen" aria-hidden="true">
          <svg
            v-if="screenLabels.length > 0"
            class="pol-screen-vec"
            :class="{ 'pol-labels-mid': effectiveMode === 'midTier' }"
          >
            <text
              v-for="label in screenLabels"
              :key="label.key"
              class="pol-label"
              :style="{ transform: `translate(${label.x}px, ${label.y}px)` }"
            >
              {{ label.name }}
            </text>
          </svg>

          <div
            v-if="playerPinStyle"
            class="pol-pin"
            :style="playerPinStyle"
            :title="`当前位置：${playerTileView?.name ?? ''}`"
          >
            <div class="pol-pin-disc">
              <img v-if="playerPinImage" class="pol-pin-face" :src="playerPinImage" alt="" />
              <span v-else class="pol-pin-initial">{{ playerInitial }}</span>
            </div>
            <span class="pol-pin-tail" />
          </div>
        </div>

        <!-- 悬停气泡：地块名 / 所有者 / 地形（+ 不可通行、水域） -->
        <div v-if="hoverView" class="pol-tip" :style="{ left: tipLeft + 'px', top: tipTop + 'px' }">
          <span class="pol-tip-name">{{ hoverView.name }}</span>
          <span class="pol-tip-sub">
            {{ hoverView.countryName || '无主之地' }}
            <template v-if="hoverView.terrain"> · {{ hoverView.terrain }}</template>
            <template v-if="hoverView.waterLabel"> · {{ hoverView.waterLabel }}</template>
            <template v-if="hoverView.impassable"> · 不可通行</template>
          </span>
        </div>

        <div v-if="diagnosticsLine" class="pol-diagnostics">{{ diagnosticsLine }}</div>
      </div>

      <!-- ═══ 信息卡 ═══ -->
      <aside v-if="selectedView" class="pol-card">
        <header class="pol-card-head">
          <h4 class="pol-card-title">{{ selectedView.name }}</h4>
          <button class="pol-card-close" aria-label="关闭信息卡" @click="selectedTileId = 0">
            ×
          </button>
        </header>

        <div class="pol-kv">
          <div class="pol-kv-row">
            <span class="pol-kv-key">国家</span>
            <span class="pol-kv-val">{{ selectedView.countryName || '无主之地' }}</span>
          </div>
          <div class="pol-kv-row">
            <span class="pol-kv-key">中层</span>
            <span class="pol-kv-val">{{ selectedView.midTierName || '—' }}</span>
          </div>
          <div class="pol-kv-row">
            <span class="pol-kv-key">地形</span>
            <span class="pol-kv-val">{{ selectedView.terrain || '—' }}</span>
          </div>
          <div class="pol-kv-row">
            <span class="pol-kv-key">通行性</span>
            <span class="pol-kv-val">
              {{ selectedView.impassable ? '不可通行' : selectedView.waterLabel || '可通行' }}
            </span>
          </div>
        </div>

        <section class="pol-section">
          <h5 class="pol-section-title">路线</h5>
          <p v-if="playerTileId === null" class="pol-note">玩家位置未在地图上定位，无法规划路线</p>
          <p v-else-if="selectedTileId === playerTileId" class="pol-note">玩家当前就在此地</p>
          <template v-else>
            <div v-if="route" class="pol-route">
              <div class="pol-route-days">约 {{ route.days }} 天</div>
              <div v-if="travelModes.length > 0" class="pol-route-modes">
                <span
                  v-for="m in travelModes"
                  :key="m.id"
                  class="pol-mode-item"
                  :data-mode-id="m.id"
                >
                  {{ m.label }} {{ modeDaysOf(m.factor) }} 天
                </span>
              </div>
              <div v-if="route.crossings.length > 0" class="pol-route-cross">
                途经：{{ route.crossings.join(' · ') }}
              </div>
            </div>
            <p v-else-if="routeUnreachable" class="pol-note pol-note-warn">
              无法规划路线（不连通，或被回避的地块挡住）
            </p>
            <div v-if="viaNames.length > 0" class="pol-plan-line">
              取道：{{ viaNames.join('、') }}
            </div>
            <div v-if="avoidNames.length > 0" class="pol-plan-line">
              避开：{{ avoidNames.join('、') }}
            </div>
          </template>
        </section>

        <!--
          ═══ 地块事实态（地图 v1.2 / ADR-33 §5 UI）═══

          四节全部**缺席即整节不渲染**：没有事实的地块（新档的常态、旧包的全部地块）
          看到的卡片与 v1.2 之前逐字节一致 —— 空的「状态」「建筑」标题只是噪音。
          判定与措辞在 `lib/map-political.ts` 的 `buildTileDetailModel`，这里只画。
        -->
        <section v-if="selectedDetail?.development" class="pol-section">
          <h5 class="pol-section-title">发展</h5>
          <div class="pol-dev-head">
            <span class="pol-dev-badge">{{ selectedDetail.development.levelName }}</span>
            <span class="pol-dev-value">进度 {{ selectedDetail.development.progress }}</span>
          </div>
          <!--
            −50..100 的轨道：0 刻度是一条竖线，负进度从它往左长（几何在
            `developmentBarGeometry`）。刻意**不做过渡动画** —— 这条是 design.md
            禁止的布局属性（width/left），而 transform 版在这里读不出真值。
          -->
          <div
            v-if="developmentBar"
            class="pol-dev-track"
            role="img"
            :aria-label="`发展进度 ${selectedDetail.development.progress}，范围 -50 到 100`"
          >
            <span class="pol-dev-zero" :style="{ left: developmentBar.zeroPct + '%' }" />
            <span
              class="pol-dev-fill"
              :class="{ 'pol-dev-fill-down': developmentBar.negative }"
              :style="{ left: developmentBar.startPct + '%', width: developmentBar.widthPct + '%' }"
            />
          </div>
        </section>

        <section v-if="selectedDetail && selectedDetail.statuses.length > 0" class="pol-section">
          <h5 class="pol-section-title">状态</h5>
          <ul class="pol-st-list">
            <li v-for="status in selectedDetail.statuses" :key="status.title" class="pol-st-item">
              <div class="pol-st-head">
                <span class="pol-st-title">{{ status.title }}</span>
                <span class="pol-st-badge" :class="{ 'pol-st-badge-perm': status.permanent }">
                  {{ status.permanent ? '永久' : `剩余 ${status.remainingDays} 天` }}
                </span>
              </div>
              <p v-if="status.description" class="pol-st-desc">{{ status.description }}</p>
            </li>
          </ul>
        </section>

        <section v-if="selectedDetail && selectedDetail.slots.length > 0" class="pol-section">
          <h5 class="pol-section-title">建筑</h5>
          <!--
            🔴 主建筑排在槽格**之上、且不带槽位号**（地图 v1.2 §F4b）：它不占编号槽、
               降档免疫、不可摧毁 —— 给它编个号会让玩家以为下一次降档轮得到它。
          -->
          <div
            v-if="selectedDetail.mainBuilding"
            class="pol-main"
            :class="{ 'pol-main-owned': selectedDetail.mainBuilding.playerOwned }"
          >
            <span class="pol-main-tag">主建筑</span>
            <span class="pol-slot-body">
              <span class="pol-slot-name">{{ selectedDetail.mainBuilding.name }}</span>
              <span class="pol-slot-meta">
                <span v-if="selectedDetail.mainBuilding.ownerFlavor">
                  {{ selectedDetail.mainBuilding.ownerFlavor }}
                </span>
                <span v-if="selectedDetail.mainBuilding.playerOwned" class="pol-slot-own">
                  玩家产业
                </span>
              </span>
            </span>
          </div>
          <p v-if="selectedDetail.mainBuilding?.description" class="pol-main-desc">
            {{ selectedDetail.mainBuilding.description }}
          </p>
          <!--
            🔴 空槽**照样占一格**（裁定 §8-8 严格槽位身份）：降档永远摧毁最高号槽，
               所以编号是「下一次降档谁会没」的唯一线索，过滤空槽会让编号错位。
          -->
          <ul class="pol-slots">
            <li
              v-for="slot in selectedDetail.slots"
              :key="slot.slot"
              class="pol-slot"
              :class="{
                'pol-slot-empty': !slot.building,
                'pol-slot-owned': slot.building?.playerOwned,
              }"
            >
              <span class="pol-slot-num">{{ slot.slot }}</span>
              <span v-if="slot.building" class="pol-slot-body">
                <span class="pol-slot-name">{{ slot.building.name }}</span>
                <span class="pol-slot-meta">
                  <span v-if="slot.building.ownerFlavor">{{ slot.building.ownerFlavor }}</span>
                  <span v-if="slot.building.playerOwned" class="pol-slot-own">玩家产业</span>
                </span>
              </span>
              <span v-else class="pol-slot-body pol-slot-vacant">空置</span>
            </li>
          </ul>
        </section>

        <section v-if="selectedDetail && selectedDetail.history.length > 0" class="pol-section">
          <h5 class="pol-section-title">编年史</h5>
          <ol class="pol-chron">
            <li
              v-for="(line, index) in selectedDetail.history"
              :key="`${line.day}-${index}-${line.kind}`"
              class="pol-chron-item"
            >
              <span class="pol-chron-day">第 {{ line.day }} 日</span>
              <span class="pol-chron-text">{{ line.text }}</span>
            </li>
          </ol>
        </section>

        <div class="pol-card-actions">
          <button class="pol-btn" :disabled="!canSetLocation" @click="setHere">设为当前位置</button>
          <button class="pol-btn" :disabled="!canRoute" @click="showRoute">查看路线</button>
          <button class="pol-btn" @click="toggleVia">
            {{ viaTileIds.includes(selectedTileId) ? '取消途经点' : '设为途经点' }}
          </button>
          <button class="pol-btn" @click="toggleAvoid">
            {{ avoidTileIds.includes(selectedTileId) ? '取消避开' : '避开此地' }}
          </button>
          <button
            class="pol-btn pol-btn-primary"
            :disabled="!canRoute || departureDirective.length === 0"
            @click="depart"
          >
            出发
          </button>
          <button
            v-if="viaNames.length > 0 || avoidNames.length > 0 || routeVisible"
            class="pol-btn pol-btn-ghost"
            @click="clearPlan"
          >
            清空规划
          </button>
        </div>

        <p v-if="selectedView.impassable" class="pol-note">
          此地不可通行，无法落位（从这里出发的任何路线都无解）
        </p>
        <p v-if="setLocationError" class="pol-note pol-note-warn">{{ setLocationError }}</p>

        <p class="pol-hint">「出发」只把一句行动写进输入框，由你自己发送 —— 地图不会替你行动</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.pol-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: var(--theme-spacing-sm);
}

/* ═══ 页签头 ═══ */
.pol-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
  flex-shrink: 0;
}
.pol-status {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  min-width: 0;
}
.pol-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: 4px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: 999px;
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
}
.pol-chip i {
  color: var(--theme-primary);
}
.pol-chip-sub {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}
.pol-chip-muted {
  color: var(--theme-text-muted);
  font-style: italic;
}
.pol-chip-muted i {
  color: var(--theme-text-muted);
}
.pol-chip-journey {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.pol-actions {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  flex-wrap: wrap;
}

.pol-btn {
  min-height: 36px;
  padding: 6px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.pol-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.pol-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.pol-btn-primary {
  background: var(--theme-primary);
  border-color: var(--theme-primary);
  color: var(--theme-primary-text);
}
.pol-btn-primary:hover:not(:disabled) {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  filter: brightness(1.1);
}
.pol-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--theme-text-muted);
}

/* 着色方式：连成一条的按钮组（相邻边合并，读作「三选一」而不是三个独立动作） */
.pol-modes {
  display: inline-flex;
}
.pol-modes .pol-mode + .pol-mode {
  margin-left: -1px;
}
.pol-modes .pol-mode:not(:first-child):not(:last-child) {
  border-radius: 0;
}
.pol-modes .pol-mode:first-child {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.pol-modes .pol-mode:last-child {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.pol-mode-active {
  z-index: 1;
  background: color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  color: var(--theme-text-primary);
}
.pol-mode-active:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-primary) 20%, var(--theme-card-bg));
}

/* ═══ 布局 ═══ */
.pol-body {
  flex: 1;
  display: flex;
  gap: var(--theme-spacing-md);
  min-height: 0;
}

.pol-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 320px;
  overflow: hidden;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  touch-action: none;
  cursor: grab;
}
.pol-stage:active {
  cursor: grabbing;
}

.pol-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.pol-layer,
.pol-vec {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
}
/*
 * 🔴 **`.pol-vec` 里禁用 `vector-effect: non-scaling-stroke`**（2026-08-12 真机实测：
 *    单独开着它，缩放最坏帧 204ms）。它的语义是「线宽按屏幕算」，于是「把旧栅格拉大」
 *    对浏览器来说就是错的 —— 每一格滚轮整张 SVG 必须重新栅格化。
 *    改法：线宽写成世界单位 × `--pol-stroke-k`（停稳后才变，见 `worldStyle`）。
 *    手势中 SVG 内容一个字节没变 → 合成器合法复用栅格；停稳后重算一次。
 *    静止时的观感与之前逐字节相同。**别把它加回来**，加回来不报错，只是又开始卡。
 */
.pol-vec path,
.pol-vec polyline,
.pol-vec circle {
  fill: none;
  stroke-linejoin: round;
  stroke-linecap: round;
}
/* 屏幕层容器：**不缩放、不变换**，只是一块盖在舞台上的定位画布（理由见脚本里那段红字） */
.pol-screen {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  user-select: none;
  z-index: 3;
}
.pol-screen-vec {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
/*
 * 四类线型：块界最轻、海岸次之、天堑虚线（= 不可通行）、国界最重。
 *
 * 宽度整体加粗约 1.7 倍（2026-08-12）：适应视图下原先那 0.8 的块界几乎看不见，
 * 而「哪里是一块地」正是这个页签最基本的信息。**层级必须保持**（国界恒最重），
 * 不然加粗只是把四种线糊成一种。
 * 🔴 这些数字仍是**屏幕像素的观感**，但写法是「世界单位 × `--pol-stroke-k`」——
 *    那个变量只在停稳后写一次（= 1/缩放）。静止时与从前逐字节相同，手势中
 *    整张 SVG 不变、栅格可复用。禁用 non-scaling-stroke 的理由见上面那条。
 */
.pv-prov {
  stroke: var(--theme-card-border);
  stroke-opacity: 0.7;
  stroke-width: calc(1.4px * var(--pol-stroke-k, 1));
}
.pv-coast {
  stroke: var(--theme-text-secondary);
  stroke-opacity: 0.5;
  stroke-width: calc(1.9px * var(--pol-stroke-k, 1));
}
.pv-impass {
  stroke: var(--theme-text-muted);
  stroke-opacity: 0.75;
  stroke-width: calc(2.4px * var(--pol-stroke-k, 1));
  stroke-dasharray: calc(6px * var(--pol-stroke-k, 1)) calc(4px * var(--pol-stroke-k, 1));
}
.pv-nat {
  stroke: var(--theme-text-primary);
  stroke-opacity: 0.75;
  stroke-width: calc(3.4px * var(--pol-stroke-k, 1));
}

/*
 * 路线折线。线宽同样走 `--pol-stroke-k`（**不用** non-scaling-stroke —— 那一层里
 * 只要有一个元素带它，整张 SVG 就又变成每帧重栅格化，前功尽弃）。
 * 光晕是**同一条线画两遍**（浅色粗的在下、深色虚线在上）—— 羊皮纸底与半透明色块
 * 两种背景的明度都不可控，只给一种颜色必然在某一类地块上消失。
 */
.pol-route-halo,
.pol-route-line,
.pol-route-dot {
  pointer-events: none;
}
.pol-route-halo {
  stroke: var(--theme-card-bg);
  stroke-opacity: 0.85;
  stroke-width: calc(6px * var(--pol-stroke-k, 1));
}
.pol-route-line {
  stroke: var(--theme-primary);
  stroke-width: calc(2.6px * var(--pol-stroke-k, 1));
  stroke-dasharray: calc(9px * var(--pol-stroke-k, 1)) calc(6px * var(--pol-stroke-k, 1));
}
/* 途经点：线上的实心点（半径在脚本里按停稳视图反缩放 —— `r` 不是能 calc 的那类属性） */
.pol-route-dot {
  fill: var(--theme-primary);
  stroke: var(--theme-card-bg);
  stroke-width: calc(2.5px * var(--pol-stroke-k, 1));
}

/*
 * 地块名标签。
 *
 * 🔴 尺寸是**朴素的 CSS 像素**，一个反缩放变量都没有：标签住在不缩放的 `.pol-screen`
 *    里，12px 就是屏幕上的 12px。此前它们住在被 scale() 的世界层里、靠
 *    `--pol-label-k` 反缩放，结果是深缩放下必糊 —— Chromium 对巨大合成层的栅格化
 *    倍率有上限，超过之后是把已有栅格拉大，字号技巧一个都救不了。
 *    **别再往这里加 `var(--pol-*-k)`**：那等于把标签搬回会糊的那条路。
 * 🔴 **深色字 + 浅色描边光晕**（`paint-order: stroke` 让描边画在字底下）：这一层压在
 *    手绘底图和半透明色块上，两种背景的明度都不可控 —— 只给颜色不给光晕，标签会在
 *    某些地块上彻底读不出来。
 * 指针事件由 `.pol-screen` 统一关掉，命中检测走 idBuf，不受这一层影响。
 */
.pol-label {
  font-family: var(--theme-font-title);
  font-size: 12px;
  font-weight: 600;
  text-anchor: middle;
  dominant-baseline: central;
  fill: var(--theme-text-primary);
  stroke: var(--theme-card-bg);
  stroke-width: 3px;
  stroke-linejoin: round;
  paint-order: stroke;
}

/*
 * 中层名比地块名重一档：那一档只有约 45 个标签（不是 310），每个覆盖一整片域，
 * 所以给得起字重与字号 —— 层级读得出来，也不至于把域内细节盖住。
 */
.pol-labels-mid .pol-label {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.5px;
  stroke-width: 3.5px;
}

/*
 * 玩家棋子 —— 一枚立在形心上的针。
 *
 * 🔴 定位整个走**内联 transform**（`playerPinStyle`）：`translate(落点) translate(-50%,-100%)`
 *    —— 后半段把针尖挪到落点（百分比按元素自身尺寸算）。用 transform 而不是 left/top，
 *    是为了逐帧改位置时不触发布局。
 *    这里**不再有 scale()**：棋子与标签一样住在不缩放的屏幕层，尺寸本来就恒定，
 *    头像也就不会在深缩放下糊掉。
 * 🔴 `pointer-events: none`：命中检测读的是 idBuf，棋子挡在上面会让它下面那块地点不中。
 */
.pol-pin {
  position: absolute;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
  user-select: none;
}
.pol-pin-disc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  overflow: hidden;
  border-radius: 50%;
  border: 2px solid var(--theme-primary);
  background: var(--theme-card-bg);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--theme-card-bg) 80%, transparent),
    var(--theme-shadow-sm);
}
.pol-pin-face {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pol-pin-initial {
  font-family: var(--theme-font-title);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
  color: var(--theme-primary);
}
/* 针尖：朝下的小三角，让圆盘读成「指着这一点」而不是「浮在这一带」 */
.pol-pin-tail {
  width: 0;
  height: 0;
  margin-top: -2px;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 8px solid var(--theme-primary);
  filter: drop-shadow(0 1px 0 color-mix(in srgb, var(--theme-card-bg) 80%, transparent));
}

.pol-overlay {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  pointer-events: none;
}

/* 空态：design.md §5.2 —— 装饰符 + 斜体说明，不用光秃秃的「暂无数据」 */
.pol-empty {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xl);
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.pol-empty::before {
  content: '—';
  display: block;
  font-size: 1.25rem;
  opacity: 0.3;
  font-style: normal;
}
.pol-empty-hint {
  font-size: 0.75rem;
  opacity: 0.8;
}
.pol-empty-error {
  color: var(--theme-error);
}

.pol-tip {
  position: absolute;
  z-index: 6;
  transform: translate(12px, -50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 15rem;
  padding: 6px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  box-shadow: var(--theme-shadow-sm);
  pointer-events: none;
}
.pol-tip-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.pol-tip-sub {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}

.pol-diagnostics {
  position: absolute;
  left: var(--theme-spacing-sm);
  bottom: var(--theme-spacing-sm);
  z-index: 5;
  padding: 3px 8px;
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  color: var(--theme-warning);
  font-size: 0.6875rem;
  pointer-events: none;
}

/* ═══ 信息卡 ═══ */
.pol-card {
  width: 17rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md);
  overflow-y: auto;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.pol-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.pol-card-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.3;
  color: var(--theme-text-primary);
}
.pol-card-close {
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  transition: color var(--theme-transition-fast);
}
.pol-card-close:hover {
  color: var(--theme-text-primary);
}

.pol-kv {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pol-kv-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  font-size: 0.8125rem;
}
.pol-kv-key {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}
.pol-kv-val {
  color: var(--theme-text-primary);
  text-align: right;
}

.pol-section {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.pol-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
/* design.md §5.1 —— Section 标题的渐变装饰线 */
.pol-section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.pol-route {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.pol-route-days {
  font-family: var(--theme-font-title);
  font-size: 1rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.pol-route-cross,
.pol-plan-line {
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}

/* 出行方式参考行：纯展示不可点（要坐什么玩家在输入框自己说） */
.pol-route-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 2px var(--theme-spacing-sm);
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}

/* ═══ 地块事实态（地图 v1.2）═══ */

/* 发展条 */
.pol-dev-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
/* 档名徽章：design.md §1「激活态/强调徽章通用配方」（染底 + 混合边框），非左侧色条 */
.pol-dev-badge {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  color: var(--theme-primary);
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  font-weight: 600;
}
.pol-dev-value {
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}
.pol-dev-track {
  position: relative;
  height: 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-card-border);
  background: var(--theme-surface-muted);
  overflow: hidden;
}
/* 0 刻度 —— 这条轨道是 −50..100，没有它读不出「在衰退」 */
.pol-dev-zero {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in srgb, var(--theme-text-muted) 55%, transparent);
}
/* 🔴 刻意无过渡：宽度/left 是布局属性（design.md §1 禁令），而这里读不出 transform 版的真值 */
.pol-dev-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--theme-primary);
}
.pol-dev-fill-down {
  background: var(--theme-warning);
}

/* 状态列表 */
.pol-st-list,
.pol-slots,
.pol-chron {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin: 0;
  padding: 0;
  list-style: none;
}
.pol-st-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
}
.pol-st-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.pol-st-title {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.pol-st-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  font-size: 0.6875rem;
}
/* 永久状态不是警告 —— 它只是「不会自己消失」，用中性色说 */
.pol-st-badge-perm {
  border-color: var(--theme-card-border);
  background: transparent;
  color: var(--theme-text-muted);
}
.pol-st-desc {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}

/*
  主建筑：与槽格同一套排版，但**实心边框 + 标签代替槽位号**，一眼看得出它不占槽。
  强调仍走 design.md 的配方（整圈混合边框 + 染底），不加左侧色条。
*/
.pol-main {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xs);
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--theme-text-muted) 35%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
}
/* 玩家产业：与槽格同款高亮（同一套所有权语义，裁定 §8-19） */
.pol-main-owned {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
.pol-main-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
}
.pol-main-desc {
  margin: 0 0 var(--theme-spacing-xs);
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-secondary);
}

/* 建筑槽格 */
.pol-slot {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  padding: 6px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
}
.pol-slot-empty {
  border-style: dashed;
  background: transparent;
}
/* 玩家产业：整圈混合边框 + 染底（design.md 的强调配方），**不是**左侧色条 */
.pol-slot-owned {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}
.pol-slot-num {
  flex-shrink: 0;
  min-width: 1.25em;
  text-align: right;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.pol-slot-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px var(--theme-spacing-sm);
  min-width: 0;
}
.pol-slot-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.pol-slot-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.pol-slot-own {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
  color: var(--theme-primary);
}
.pol-slot-vacant {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}

/* 编年史（新的在前，见 buildTileDetailModel） */
.pol-chron-item {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  font-size: 0.75rem;
  line-height: 1.55;
}
.pol-chron-day {
  flex-shrink: 0;
  color: var(--theme-text-muted);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}
.pol-chron-text {
  color: var(--theme-text-secondary);
  min-width: 0;
}

.pol-note {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--theme-text-muted);
}
.pol-note-warn {
  color: var(--theme-warning);
}
.pol-hint {
  margin: 0;
  font-size: 0.6875rem;
  line-height: 1.5;
  color: var(--theme-text-muted);
  font-style: italic;
}

.pol-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
}

/* 窄屏：信息卡叠到舞台下方（min-height: 0 见 CharacterViewerModal 那条教训） */
@media (max-width: 900px) {
  .pol-body {
    flex-direction: column;
  }
  .pol-card {
    width: auto;
    max-height: 40%;
    min-height: 0;
  }
}
</style>
