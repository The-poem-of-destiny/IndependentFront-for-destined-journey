/**
 * plugin-icon.ts — 插件贡献点图标的唯一入口（设计 §4.4 规则二）
 *
 * 插件字节进入宿主 origin 的**唯一**通道就是这里。规则只有三条:
 *
 * 1. **按文件头判格式**，只收 PNG / JPEG / WebP / GIF。扩展名和 MIME 都是插件自己写的，
 *    一概不信。SVG 没有固定文件头，天然落空 —— 它能带脚本，绝不能进宿主 origin。
 * 2. 用 `createImageBitmap` 解码、长边缩到 {@link PLUGIN_ICON_MAX_EDGE} 以内、经 canvas
 *    **重编码成 PNG**。出来的字节是宿主画布画的，不是插件给的。
 * 3. 任何一步失败都返回 `null`，调用方显示默认图标。永不抛。
 *
 * 输出选 `data:image/png;base64,…` 字符串而不是 blob URL，理由:
 * - 不用记账撤销（图标跟着插件列表常驻，blob URL 的生命周期没人管就是泄漏）；
 * - 字符串能直接放进 Pinia / postMessage / Dexie，不碰 DataCloneError；
 * - 规则二禁止为插件字节创建「其他类型」的 blob URL；data URL 顶层导航被浏览器拦截，
 *   「在新标签页打开图片」也打不开成可执行文档，更省心。
 * 256px PNG 最大也就几百 KB，base64 膨胀可以接受。
 *
 * 解码与画布复用 `image-crop.ts` 的注入缝（`ImageCropSeams`），测试不碰真实浏览器全局。
 */

import { cropImageBlob, type ImageCropSeams } from './image-crop';

/** 图标重编码后的长边上限（像素） */
export const PLUGIN_ICON_MAX_EDGE = 256;

/** 文件头能认出的四种栅格格式 */
export type PluginIconFormat = 'png' | 'jpeg' | 'webp' | 'gif';

const FORMAT_MIME: Record<PluginIconFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes[offset + i] !== magic[i]) return false;
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

/**
 * 只看文件头判格式；认不出（含 SVG、HTML、空字节）返回 `null`。
 */
export function sniffPluginIconFormat(bytes: Uint8Array): PluginIconFormat | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // 分块拼接，避免大数组展开撑爆调用栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 把插件包里的图标字节洗成宿主自己编码的 PNG data URL。
 *
 * @param bytes 插件包内的原始字节
 * @param seams 解码器与画布工厂；不传时用 `createImageBitmap` 与 OffscreenCanvas / `<canvas>`
 * @returns `data:image/png;base64,…`；格式不认、解码失败、编码失败、产出不是 PNG 时为 `null`
 */
export async function preparePluginIcon(
  bytes: Uint8Array,
  seams: ImageCropSeams = {},
): Promise<string | null> {
  const format = sniffPluginIconFormat(bytes);
  if (!format) return null;
  try {
    // Blob 的类型用文件头判出来的 MIME，不用插件声明的
    const source = new Blob([new Uint8Array(bytes)], { type: FORMAT_MIME[format] });
    const huge = Number.MAX_SAFE_INTEGER;
    const png = await cropImageBlob(
      source,
      { x: 0, y: 0, w: huge, h: huge },
      { ...seams, mime: 'image/png', maxEdge: PLUGIN_ICON_MAX_EDGE },
    );
    const out = new Uint8Array(await png.arrayBuffer());
    // 产出也按文件头复核：画布若没吐 PNG，就当失败，不把未知字节放进宿主
    if (!startsWith(out, PNG_MAGIC)) return null;
    return `data:image/png;base64,${toBase64(out)}`;
  } catch {
    return null;
  }
}
