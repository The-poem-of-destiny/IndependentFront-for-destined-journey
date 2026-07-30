/**
 * crop-rects.ts — 裁剪框的几何（纯函数，零 DOM）
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md（素材命名与媒体规则 D7 / D12）
 * 契约: 单位一律是**源图像素**，与 image-crop.ts 的 {@link CropRect} 同一个坐标系
 *       —— 编辑器把指针位移除以缩放比换算进来，绝不在这里出现"屏幕像素"。
 *
 * 为什么单独成一个模块而不是写在 SFC 里: 这套算术是整个裁剪编辑器**唯一有分支**的
 * 部分（夹逼、锁定 1:1、最小尺寸、四角各自的锚点），而 SFC 里的东西要靠 mount 才测得到，
 * 裸 `tsc` 也不解析 `.vue`（见 SettingsPage.engine-imports.test.ts 开头那段）。
 * 搬到 `.ts` 里，它既进类型检查也能脱离画布单测 —— 与 image-crop.ts 把
 * `clampCropRect` / `fitWithinMaxEdge` 单独导出的理由逐字相同。
 *
 * 三条纪律:
 * 1. **一律返回整像素**。裁剪最终喂给 `cropImageBlob`，那边 `clampCropRect` 会再取整
 *    一次；这里先取整是为了让界面上显示的数字与真正裁出来的字节对得上（用户看到
 *    `300×300` 就该真是 300×300）。
 * 2. **非有限数不猜**。拖拽的上游能轻易算出 NaN（除以一个还没测量出来的 0 宽容器就够了），
 *    落进状态之后每一帧都会渲染成一个不存在的框。收敛点放在这里，而不是指望每个调用点记得判。
 * 3. **锁定 1:1 时以 `w` 为准**。方框只有一个自由度，拿两个字段去表达它必然有一个是
 *    多余的；约定死哪个说了算，比每处各挑一个要少一类"偶尔变成长方形"的 bug。
 */
import type { CropRect } from './image-crop'

/**
 * 框的最小边长（源图像素）。
 *
 * 不是 1: 一个 1px 的框在界面上抓不住，而且用户几乎不可能是有意拉成那样的。
 * 但**源图本身比它还小时**这条让路（见 {@link clampSize}）—— 规则不该让一张
 * 4×4 的图变得没法裁。
 */
export const MIN_CROP_SIZE = 8

/** 四个角的把手。命名同 CSS 方位，`n` 上 `s` 下 `w` 左 `e` 右 */
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se'

function round(v: number, fallback: number): number {
  return Number.isFinite(v) ? Math.round(v) : fallback
}

/** 边长夹逼: `[min(MIN, 上限), 上限]`。图比 MIN 还小时上限说了算 */
function clampSize(v: number, max: number): number {
  const hi = Math.max(1, Math.floor(Number.isFinite(max) ? max : 1))
  const lo = Math.min(MIN_CROP_SIZE, hi)
  return Math.min(Math.max(round(v, lo), lo), hi)
}

/** 位置夹逼: `[0, 上限]`，上限即 `图边长 - 框边长` */
function clampPos(v: number, max: number): number {
  const hi = Math.max(0, Math.floor(Number.isFinite(max) ? max : 0))
  return Math.min(Math.max(round(v, 0), 0), hi)
}

/** 整张图。**立绘的默认框**就是它 —— 大多数立绘素材本来就是裁好的 */
export function wholeImageRect(imgW: number, imgH: number): CropRect {
  return {
    x: 0,
    y: 0,
    w: Math.max(1, Math.floor(Number.isFinite(imgW) ? imgW : 1)),
    h: Math.max(1, Math.floor(Number.isFinite(imgH) ? imgH : 1)),
  }
}

/**
 * 头像的默认框: **顶部居中的正方形**，边长取「图宽」与「图高的三分之一」里较小的那个。
 *
 * 为什么是顶部居中: 立绘素材里脑袋几乎总在这个位置。默认框落在脸上，用户多半
 * 一下都不用调；默认框落在中央（那是通用裁剪器的习惯做法），对着一张全身立绘
 * 就是框住腰部，每一次都得手动往上拖。
 */
export function defaultAvatarRect(imgW: number, imgH: number): CropRect {
  const side = clampSize(Math.min(imgW, imgH / 3), Math.min(imgW, imgH))
  return { x: clampPos(Math.round((imgW - side) / 2), imgW - side), y: 0, w: side, h: side }
}

/**
 * 把框夹进图内，并按需锁成正方形。**尺寸优先保留**，位置让路 ——
 * 拖动一个框到边界时，用户要的是"贴边"，不是"缩小"。
 *
 * @param square 锁定 1:1 时以 `rect.w` 为准（纪律 3）
 */
export function clampRect(
  rect: CropRect,
  imgW: number,
  imgH: number,
  square = false,
): CropRect {
  const w = square ? clampSize(rect.w, Math.min(imgW, imgH)) : clampSize(rect.w, imgW)
  const h = square ? w : clampSize(rect.h, imgH)
  return { x: clampPos(rect.x, imgW - w), y: clampPos(rect.y, imgH - h), w, h }
}

/** 平移（尺寸不变，撞到边界就停住） */
export function moveRect(
  rect: CropRect,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
  square = false,
): CropRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, imgW, imgH, square)
}

/**
 * 拖某一个角改尺寸。**对角固定不动**（这是所有裁剪器的共同直觉，别改）。
 *
 * 锁定 1:1 时取「变化更大的那个轴」作主导，另一轴跟着走 —— 取平均会让斜着拖的手感
 * 变钝，取固定轴则会让沿另一轴的拖动完全没反应。主导轴之后再按锚点方向把边长夹进
 * 图内，于是**正方形永远是正方形**，不会在贴边时被压成长方形。
 */
export function resizeRect(
  rect: CropRect,
  corner: CropCorner,
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
  square = false,
): CropRect {
  const left = rect.x
  const top = rect.y
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  const east = corner === 'ne' || corner === 'se'
  const south = corner === 'sw' || corner === 'se'
  const ddx = Number.isFinite(dx) ? dx : 0
  const ddy = Number.isFinite(dy) ? dy : 0

  if (square) {
    const sx = east ? rect.w + ddx : rect.w - ddx
    const sy = south ? rect.h + ddy : rect.h - ddy
    const dominant = Math.abs(sx - rect.w) >= Math.abs(sy - rect.h) ? sx : sy
    // 锚点是对角，于是可用空间只由锚点到图边的距离决定
    const maxSide = Math.min(east ? imgW - left : right, south ? imgH - top : bottom)
    const side = clampSize(dominant, maxSide)
    return {
      x: east ? clampPos(left, imgW - side) : clampPos(right - side, imgW - side),
      y: south ? clampPos(top, imgH - side) : clampPos(bottom - side, imgH - side),
      w: side,
      h: side,
    }
  }

  const minW = Math.min(MIN_CROP_SIZE, Math.max(1, Math.floor(imgW)))
  const minH = Math.min(MIN_CROP_SIZE, Math.max(1, Math.floor(imgH)))
  let l = left
  let r = right
  let t = top
  let b = bottom
  if (east) r = Math.min(imgW, Math.max(left + minW, right + ddx))
  else l = Math.max(0, Math.min(right - minW, left + ddx))
  if (south) b = Math.min(imgH, Math.max(top + minH, bottom + ddy))
  else t = Math.max(0, Math.min(bottom - minH, top + ddy))

  return clampRect({ x: l, y: t, w: r - l, h: b - t }, imgW, imgH, false)
}

/**
 * 预览用的 `background-size` / `background-position`。
 *
 * 为什么用背景而不是把源图再画一遍到画布上: 预览要跟着拖拽**每一帧**变，
 * 而每帧解码 + 重画一张几 MB 的图是白烧 CPU。整图当背景、用百分比把要看的那块
 * 挪进视口，浏览器自己合成，零解码。
 *
 * 百分比定位的公式（`offset = (容器 - 图) × p`）推导出 `p = x / (图宽 - 框宽)`；
 * 分母为 0（框就是整图）时定位没有意义，取 0。
 */
export interface PreviewBackground {
  size: string
  position: string
}

export function previewBackground(rect: CropRect, imgW: number, imgH: number): PreviewBackground {
  const pct = (n: number): string => `${Math.round(n * 100) / 100}%`
  const sx = rect.w > 0 ? (imgW / rect.w) * 100 : 100
  const sy = rect.h > 0 ? (imgH / rect.h) * 100 : 100
  const px = imgW > rect.w ? (rect.x / (imgW - rect.w)) * 100 : 0
  const py = imgH > rect.h ? (rect.y / (imgH - rect.h)) * 100 : 0
  return { size: `${pct(sx)} ${pct(sy)}`, position: `${pct(px)} ${pct(py)}` }
}
