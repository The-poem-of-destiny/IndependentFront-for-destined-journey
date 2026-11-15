/**
 * plugin-icon.test.ts — 插件图标的唯一入口（设计 §4.4 规则二）
 *
 * 解码器与画布全部是替身：解码器记录收到的 Blob 类型，画布记录尺寸并吐出可控字节。
 */

import { describe, it, expect } from 'vitest';
import {
  PLUGIN_ICON_MAX_EDGE,
  preparePluginIcon,
  sniffPluginIconFormat,
} from '../../../src/ui/lib/plugin-icon';
import type { CropCanvasLike } from '../../../src/ui/lib/image-crop';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)),
  );

const SAMPLES = {
  png: bytes(PNG, [0, 0, 0, 0]),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
  gif: bytes('GIF89a', [1, 0, 1, 0]),
  webp: bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 '),
};

interface Harness {
  decoded: string[];
  canvases: { width: number; height: number }[];
  seams: {
    decode: (blob: Blob) => Promise<{ width: number; height: number }>;
    createCanvas: (w: number, h: number) => CropCanvasLike;
  };
}

function harness(size: { width: number; height: number }, output: Uint8Array): Harness {
  const decoded: string[] = [];
  const canvases: { width: number; height: number }[] = [];
  return {
    decoded,
    canvases,
    seams: {
      decode: async (blob) => {
        decoded.push(blob.type);
        return size;
      },
      createCanvas: (width, height) => {
        const record = { width, height };
        canvases.push(record);
        const canvas: CropCanvasLike = {
          width,
          height,
          getContext: () => ({ drawImage: () => {} }),
          convertToBlob: async () => new Blob([new Uint8Array(output)], { type: 'image/png' }),
        };
        return canvas;
      },
    },
  };
}

describe('sniffPluginIconFormat', () => {
  it('按文件头认出四种栅格格式', () => {
    expect(sniffPluginIconFormat(SAMPLES.png)).toBe('png');
    expect(sniffPluginIconFormat(SAMPLES.jpeg)).toBe('jpeg');
    expect(sniffPluginIconFormat(SAMPLES.gif)).toBe('gif');
    expect(sniffPluginIconFormat(SAMPLES.webp)).toBe('webp');
  });

  it('SVG、HTML、空字节与截断的文件头一律不认', () => {
    expect(sniffPluginIconFormat(bytes('<svg xmlns="x"></svg>'))).toBeNull();
    expect(sniffPluginIconFormat(bytes('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffPluginIconFormat(bytes('<html><script></script>'))).toBeNull();
    expect(sniffPluginIconFormat(new Uint8Array())).toBeNull();
    expect(sniffPluginIconFormat(bytes(PNG.slice(0, 4)))).toBeNull();
    expect(sniffPluginIconFormat(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
  });
});

describe('preparePluginIcon', () => {
  const pngOut = bytes(PNG, [1, 2, 3]);

  it('按文件头的类型解码，重编码为 PNG data URL', async () => {
    const h = harness({ width: 64, height: 32 }, pngOut);
    const url = await preparePluginIcon(SAMPLES.jpeg, h.seams);
    expect(h.decoded).toEqual(['image/jpeg']);
    expect(url).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...pngOut))}`);
    expect(h.canvases[h.canvases.length - 1]).toEqual({ width: 64, height: 32 });
  });

  it(`长边超过 ${PLUGIN_ICON_MAX_EDGE} 时等比缩小`, async () => {
    const h = harness({ width: 1024, height: 512 }, pngOut);
    await preparePluginIcon(SAMPLES.webp, h.seams);
    expect(h.canvases[h.canvases.length - 1]).toEqual({ width: PLUGIN_ICON_MAX_EDGE, height: 128 });
  });

  it('SVG 不进解码器，直接返回 null', async () => {
    const h = harness({ width: 10, height: 10 }, pngOut);
    expect(await preparePluginIcon(bytes('<svg onload="alert(1)"/>'), h.seams)).toBeNull();
    expect(h.decoded).toEqual([]);
  });

  it('解码失败返回 null，不抛', async () => {
    const h = harness({ width: 10, height: 10 }, pngOut);
    h.seams.decode = async () => {
      throw new Error('坏图');
    };
    expect(await preparePluginIcon(SAMPLES.png, h.seams)).toBeNull();
  });

  it('画布产出的不是 PNG 字节时返回 null', async () => {
    const h = harness({ width: 10, height: 10 }, bytes('<svg/>'));
    expect(await preparePluginIcon(SAMPLES.gif, h.seams)).toBeNull();
  });
});
