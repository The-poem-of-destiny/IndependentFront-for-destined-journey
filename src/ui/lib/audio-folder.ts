/**
 * audio-folder.ts — File System Access API 的唯一接触点 (Phase Audio, addendum)
 *
 * 为什么存在: store 绝不能直接碰 File System Access API。所有平台相关的东西
 * 隔离在这里，store 才保持可测，非 Chromium 浏览器也能干净降级回既有的
 * IndexedDB blob 路径。
 *
 * 健壮性要求: node 环境没有 showDirectoryPicker / FileSystemDirectoryHandle /
 * queryPermission。因此**所有全局引用都惰性写在函数体内**（对齐
 * audio-singleton.ts 的做法），仅 import 本模块不触碰任何浏览器 API。
 *
 * 测试接缝 (仅测试使用，生产调用点禁止引用):
 *   __setFolderTestHooks({ picker?, getHandle?, saveHandle?, deleteHandle? })
 *   __resetFolderTestHooks()
 * 未注入时，picker 走 globalThis.showDirectoryPicker，另三个走 @engine/database
 * 的 getAudioHandle / saveAudioHandle / deleteAudioHandle。
 */

import {
  getAudioHandle,
  saveAudioHandle,
  deleteAudioHandle,
} from '@engine/database'
import type { AudioHandleRecord } from '@engine/types'

/** 扫描结果 —— 磁盘上的一个音频文件的最小描述 */
export interface ScannedFile {
  name: string
  size: number
  mimeType: string
}

/** 持久化目录句柄的固定行 id（当前只有一行） */
const LIBRARY_ROOT_ID = 'library-root'

// ═══════════════════════════════════════════════════════════
// 非标准权限方法的窄接口扩展
// ═══════════════════════════════════════════════════════════

interface FileSystemPermissionDescriptorLike {
  mode?: 'read' | 'readwrite'
}

/** DOM lib 未必声明 query/requestPermission，这里做窄扩展而不是 any */
interface PermissionCapableHandle {
  queryPermission?: (desc?: FileSystemPermissionDescriptorLike) => Promise<PermissionState | string>
  requestPermission?: (desc?: FileSystemPermissionDescriptorLike) => Promise<PermissionState | string>
}

/** 目录句柄的 values() 在部分 TS lib 版本里缺失，同样窄扩展 */
interface DirectoryLike {
  values?: () => AsyncIterable<FileSystemHandle>
  getFileHandle?: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandle>
}

// ═══════════════════════════════════════════════════════════
// 测试接缝
// ═══════════════════════════════════════════════════════════

export interface FolderTestHooks {
  picker?: () => Promise<FileSystemDirectoryHandle>
  getHandle?: (id: string) => Promise<AudioHandleRecord | undefined>
  saveHandle?: (record: AudioHandleRecord) => Promise<unknown>
  deleteHandle?: (id: string) => Promise<void>
}

let hooks: FolderTestHooks = {}

/** 仅测试使用：注入 picker / 句柄存储实现 */
export function __setFolderTestHooks(next: FolderTestHooks): void {
  hooks = { ...hooks, ...next }
}

/** 仅测试使用：清空所有注入，恢复真实实现 */
export function __resetFolderTestHooks(): void {
  hooks = {}
}

function readHandle(id: string): Promise<AudioHandleRecord | undefined> {
  return (hooks.getHandle ?? getAudioHandle)(id)
}

function writeHandle(record: AudioHandleRecord): Promise<unknown> {
  return (hooks.saveHandle ?? saveAudioHandle)(record)
}

function removeHandle(id: string): Promise<void> {
  return (hooks.deleteHandle ?? deleteAudioHandle)(id)
}

// ═══════════════════════════════════════════════════════════
// 能力探测 & 选择器
// ═══════════════════════════════════════════════════════════

/** 浏览器是否支持 File System Access 目录选择。node 下安全返回 false。 */
export function isFolderSupported(): boolean {
  if (hooks.picker) return true
  try {
    return 'showDirectoryPicker' in globalThis
  } catch {
    return false
  }
}

function getPicker(): (() => Promise<FileSystemDirectoryHandle>) | null {
  if (hooks.picker) return hooks.picker
  const g = globalThis as unknown as Record<string, unknown>
  const fn = g.showDirectoryPicker
  if (typeof fn !== 'function') return null
  return () => (fn as (opts?: unknown) => Promise<FileSystemDirectoryHandle>).call(globalThis, { mode: 'read' })
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError'
}

function isNotFoundError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'NotFoundError'
}

/**
 * 弹出目录选择器（需要用户手势）。用户取消 → AbortError → 返回 null。
 * 成功时顺带持久化。其他错误照常抛出。
 */
export async function pickLibraryFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = getPicker()
  if (!picker) return null
  let handle: FileSystemDirectoryHandle
  try {
    handle = await picker()
  } catch (err) {
    if (isAbortError(err)) return null
    throw err
  }
  if (!handle) return null
  await storeFolder(handle)
  return handle
}

// ═══════════════════════════════════════════════════════════
// 句柄持久化
// ═══════════════════════════════════════════════════════════

/** 读取已持久化的目录句柄；没有则 null */
export async function getStoredFolder(): Promise<FileSystemDirectoryHandle | null> {
  const record = await readHandle(LIBRARY_ROOT_ID)
  return record?.handle ?? null
}

/** 持久化目录句柄（覆盖既有行） */
export async function storeFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await writeHandle({ id: LIBRARY_ROOT_ID, handle, addedAt: Date.now() })
}

/** 取消关联音乐文件夹 —— 只删句柄 */
export async function forgetFolder(): Promise<void> {
  await removeHandle(LIBRARY_ROOT_ID)
}

// ═══════════════════════════════════════════════════════════
// 权限
// ═══════════════════════════════════════════════════════════

function normalizeState(value: unknown): 'granted' | 'prompt' | 'denied' {
  return value === 'granted' || value === 'denied' ? value : 'prompt'
}

/** 查询读权限。方法缺失或抛错一律当 'prompt'（后续由用户手势重新申请）。 */
export async function checkPermission(handle: FileSystemDirectoryHandle): Promise<'granted' | 'prompt' | 'denied'> {
  const h = handle as unknown as PermissionCapableHandle
  if (!h || typeof h.queryPermission !== 'function') return 'prompt'
  try {
    return normalizeState(await h.queryPermission({ mode: 'read' }))
  } catch {
    return 'prompt'
  }
}

/** 申请读权限（需要用户手势）。方法缺失或抛错 → false。 */
export async function requestPermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as unknown as PermissionCapableHandle
  if (!h || typeof h.requestPermission !== 'function') return false
  try {
    return normalizeState(await h.requestPermission({ mode: 'read' })) === 'granted'
  } catch {
    return false
  }
}

// ═══════════════════════════════════════════════════════════
// 扫描
// ═══════════════════════════════════════════════════════════

/** 认可的音频扩展名 → MIME */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  webm: 'audio/webm',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

/**
 * 扫描目录**顶层**（不递归），保留受支持扩展名的文件，按文件名排序返回。
 * 单个文件出错只跳过该文件，不中断整次扫描。
 */
export async function scanFolder(handle: FileSystemDirectoryHandle): Promise<ScannedFile[]> {
  const dir = handle as unknown as DirectoryLike
  if (!dir || typeof dir.values !== 'function') return []

  const out: ScannedFile[] = []
  for await (const entry of dir.values()) {
    try {
      if (!entry || entry.kind !== 'file') continue
      const mimeType = AUDIO_MIME[extensionOf(entry.name)]
      if (!mimeType) continue
      const file = await (entry as FileSystemFileHandle).getFile()
      out.push({
        name: entry.name,
        size: file?.size ?? 0,
        mimeType: file?.type || mimeType,
      })
    } catch {
      // 单文件失败（权限/被删/读错）不该毁掉整次扫描
      continue
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

// ═══════════════════════════════════════════════════════════
// 取文件
// ═══════════════════════════════════════════════════════════

/** 按相对路径取回 File；文件已消失（NotFoundError）返回 null 而不是抛错。 */
export async function resolveFile(
  handle: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<File | null> {
  const dir = handle as unknown as DirectoryLike
  if (!dir || typeof dir.getFileHandle !== 'function' || !relativePath) return null
  try {
    const fileHandle = await dir.getFileHandle(relativePath)
    const file = await fileHandle.getFile()
    return file ?? null
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
}
