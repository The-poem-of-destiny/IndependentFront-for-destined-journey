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
import { isReducedMotion } from '../../lib/reduced-motion';
import {
  buildHighlightPatch,
  clampStageView,
  composeDepartureDirective,
  describeTile,
  fitStageView,
  frameStageOnPoints,
  stagePointToWorld,
  tileAtRasterPoint,
  tileNameOf,
  zoomStageView,
  type StageView,
} from '../../lib/map-political';
import { getMapIndex, getMapPack } from '@engine/map-runtime';
import { findPath } from '@engine/map-path';
import { getMapFlags } from '@engine/save-profile';
import type { MapRoute } from '@engine/types-map';

// ═══ 高亮像素色（RGBA；理由见文件头最后一条） ═══
const ROUTE_RGBA = [255, 236, 178, 92] as const;
const VIA_RGBA = [173, 226, 255, 120] as const;
const AVOID_RGBA = [255, 138, 128, 110] as const;
const PLAYER_RGBA = [255, 250, 232, 130] as const;
const SELECT_RGBA = [255, 246, 214, 104] as const;
const HOVER_RGBA = [255, 250, 232, 54] as const;

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

const stageRef = ref<HTMLDivElement | null>(null);
const tintRef = ref<HTMLCanvasElement | null>(null);
const fxRef = ref<HTMLCanvasElement | null>(null);

const view = ref<StageView>({ s: 1, x: 0, y: 0, min: 1, max: 1 });
const hoverTileId = ref(0);
const selectedTileId = ref(0);
const viaTileIds = ref<number[]>([]);
const avoidTileIds = ref<number[]>([]);
const routeVisible = ref(false);
const tipLeft = ref(0);
const tipTop = ref(0);
const baseArtUrl = ref('');

let baseObjectUrl: string | null = null;
let resizeObserver: ResizeObserver | null = null;
let frameRaf = 0;

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

const worldViewBox = computed(() => `0 0 ${worldW.value} ${worldH.value}`);
const worldStyle = computed(() => ({
  width: `${worldW.value}px`,
  height: `${worldH.value}px`,
  transform: `translate(${view.value.x}px, ${view.value.y}px) scale(${view.value.s})`,
}));

const playerTileId = computed<number | null>(() => {
  const profile = game.saveProfile;
  if (!profile) return null;
  const id = getMapFlags(profile).lastTileId;
  return typeof id === 'number' ? id : null;
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

function paintTint(): void {
  const stage = polStage.value;
  const canvas = tintRef.value;
  if (stage === null || canvas === null) return;
  // jsdom 没有 2D 上下文 —— 拿不到就不画（组件测试只验数据与结构，不验像素）。
  // 判据是**假值**不是 `=== null`：没装 canvas 包的 jsdom 与老浏览器给的是 undefined，
  // 严格判 null 会让下一行在 undefined 上取 createImageData —— 组件当场抛在 watch 里
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const image = ctx.createImageData(stage.raster.w, stage.raster.h);
  image.data.set(stage.tint);
  ctx.putImageData(image, 0, 0);
}

function paintFx(): void {
  const stage = polStage.value;
  const canvas = fxRef.value;
  if (stage === null || canvas === null) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, stage.raster.w, stage.raster.h);

  // 后写的赢：路线 → 回避 → 途经 → 玩家 → 选中 → 悬停
  const colors = new Map<number, readonly [number, number, number, number]>();
  for (const id of route.value?.tilePath ?? []) colors.set(id, ROUTE_RGBA);
  for (const id of avoidTileIds.value) colors.set(id, AVOID_RGBA);
  for (const id of viaTileIds.value) colors.set(id, VIA_RGBA);
  if (playerTileId.value !== null) colors.set(playerTileId.value, PLAYER_RGBA);
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

function focusPlayer(): void {
  if (playerTileId.value === null) return;
  frameTiles([playerTileId.value]);
}

// ═══ 生命周期 ═══

/** 底图：复用标记页签那条链（内容注册表 `branding.mapSources` + Dexie `mapBlobs` 缓存） */
async function resolveBaseArt(): Promise<void> {
  const sources = resolveMapSources(getContentRegistry().branding);
  const first = sources[0];
  if (first === undefined) return;
  try {
    const { getDatabase } = await import('@engine/database');
    const cached = (await getDatabase().mapBlobs.get(first.url))?.blob;
    if (cached !== undefined) {
      baseObjectUrl = URL.createObjectURL(cached);
      baseArtUrl.value = baseObjectUrl;
      return;
    }
  } catch {
    /* 缓存拿不到就直接用地址，让浏览器自己去取 */
  }
  baseArtUrl.value = first.url;
}

watch(
  () => props.active === true,
  (active) => {
    if (active) void ensurePolBuilt();
  },
  { immediate: true },
);

onMounted(() => {
  void resolveBaseArt();
  if (typeof ResizeObserver === 'function' && stageRef.value !== null) {
    resizeObserver = new ResizeObserver(() => {
      const { vw, vh } = viewportSize();
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
    paintTint();
    paintFx();
    if (playerTileId.value !== null) frameTiles([playerTileId.value]);
  },
);

watch([route, hoverTileId, selectedTileId, viaTileIds, avoidTileIds, playerTileId], () => {
  paintFx();
});

onBeforeUnmount(() => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRaf);
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (baseObjectUrl !== null) {
    URL.revokeObjectURL(baseObjectUrl);
    baseObjectUrl = null;
  }
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
          <img v-if="baseArtUrl" class="pol-base" :src="baseArtUrl" alt="" draggable="false" />
          <canvas ref="tintRef" class="pol-layer" :width="worldW" :height="worldH" />
          <canvas ref="fxRef" class="pol-layer" :width="worldW" :height="worldH" />
          <svg class="pol-vec" :viewBox="worldViewBox" preserveAspectRatio="none">
            <path class="pv-prov" :d="borders?.province || ''" />
            <path class="pv-coast" :d="borders?.coast || ''" />
            <path class="pv-impass" :d="borders?.impassable || ''" />
            <path class="pv-nat" :d="borders?.national || ''" />
          </svg>
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

        <div class="pol-card-actions">
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
.pol-base,
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
.pol-base {
  display: block;
  -webkit-user-drag: none;
}
.pol-vec path {
  fill: none;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
/* 四类线型：块界最轻、海岸次之、天堑虚线（= 不可通行）、国界最重 */
.pv-prov {
  stroke: var(--theme-card-border);
  stroke-opacity: 0.55;
  stroke-width: 0.8;
}
.pv-coast {
  stroke: var(--theme-text-secondary);
  stroke-opacity: 0.4;
  stroke-width: 1.1;
}
.pv-impass {
  stroke: var(--theme-text-muted);
  stroke-opacity: 0.7;
  stroke-width: 1.4;
  stroke-dasharray: 5 3;
}
.pv-nat {
  stroke: var(--theme-text-primary);
  stroke-opacity: 0.7;
  stroke-width: 2;
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
