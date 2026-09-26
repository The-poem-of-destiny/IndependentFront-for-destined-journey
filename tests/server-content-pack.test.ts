import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PACK_REPO,
  PACK_BLOB_KEY_B64,
  decryptPackBlob,
  isTrustedAssetHost,
  parseManifest,
  type PackFetchLike,
} from '../server/content-pack-release';
import { buildHonoApp } from '../server/app';

const REPO = DEFAULT_PACK_REPO;

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 用引擎侧同一把密钥加密，生成一份可被服务端解开的 blob */
function encryptPackBlob(pack: unknown) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(pack), 'utf8'));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(PACK_BLOB_KEY_B64, 'base64'), nonce);
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    blob: Buffer.concat([nonce, body, tag]),
    compressed,
    plainSha256: sha256Hex(compressed),
  };
}

function jsonResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function bytesResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    // Uint8Array.from 复制一份，确保 buffer 恰好等于这段字节（Buffer.slice 共享底层池）
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

/** 搭一个假 GitHub：只认约定 URL，其余一律 404 */
function fakeGithub(opts: {
  manifestUrl: string;
  blobUrl: string;
  manifestBytes: Uint8Array;
  blobBytes: Uint8Array;
  releaseStatus?: number;
}): PackFetchLike {
  return async (url) => {
    if (url === `https://api.github.com/repos/${REPO}/releases/latest`) {
      if (opts.releaseStatus && opts.releaseStatus !== 200) {
        return { ...jsonResponse({}), ok: false, status: opts.releaseStatus };
      }
      return jsonResponse({
        tag_name: 'v9.9.9',
        assets: [
          { name: 'manifest.json', browser_download_url: opts.manifestUrl },
          { name: 'pack.bin', browser_download_url: opts.blobUrl },
        ],
      });
    }
    if (url === opts.manifestUrl) return bytesResponse(opts.manifestBytes);
    if (url === opts.blobUrl) return bytesResponse(opts.blobBytes);
    return { ...jsonResponse({}), ok: false, status: 404 };
  };
}

describe('content-pack-release 纯函数', () => {
  it('isTrustedAssetHost 只放行 GitHub 主机', () => {
    expect(isTrustedAssetHost('https://github.com/o/r/releases/download/x/pack.bin')).toBe(true);
    expect(isTrustedAssetHost('https://release-assets.githubusercontent.com/foo/bar?sig=1')).toBe(
      true,
    );
    expect(isTrustedAssetHost('https://evil.example/pack.bin')).toBe(false);
    expect(isTrustedAssetHost('not a url')).toBe(false);
  });

  it('parseManifest 容错：坏形状返回 null，好形状归一', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest({ formatVersion: 2 })).toBeNull();
    expect(parseManifest({ formatVersion: 1, packId: 'x', packVersion: 'abc' })).toBeNull();
    const ok = parseManifest({
      formatVersion: 1,
      packId: 'fated-poem-official',
      packVersion: '1.2.3',
      minEngineVersion: '1.0.0',
      size: 10,
      plainSha256: 'a',
      blobSha256: 'b',
      extra: 'ignored',
    });
    expect(ok).toMatchObject({ packId: 'fated-poem-official', packVersion: '1.2.3', size: 10 });
  });

  it('decryptPackBlob 往返；密钥不符 / 被改动静默失败抛错', () => {
    const { blob } = encryptPackBlob({ hello: '世界' });
    const out = decryptPackBlob(new Uint8Array(blob), PACK_BLOB_KEY_B64);
    expect(JSON.parse(gunzipSync(out).toString('utf8'))).toEqual({ hello: '世界' });

    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptPackBlob(tampered, PACK_BLOB_KEY_B64)).toThrow();
  });
});

describe('content-pack-release 拉取（注入 fetch）', () => {
  it('loadLatestPack 全链路：发现 manifest → 下 blob → 校验 → 解密 → 解压', async () => {
    const pack = { formatVersion: 1, packId: 'fated-poem-official', packVersion: '9.9.9' };
    const { blob, compressed, plainSha256 } = encryptPackBlob(pack);
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        packId: 'fated-poem-official',
        packVersion: '9.9.9',
        size: compressed.length,
        plainSha256,
        blobSha256: sha256Hex(blob),
      }),
      'utf8',
    );
    const fetchImpl = fakeGithub({
      manifestUrl: 'https://github.com/o/r/releases/download/v9.9.9/manifest.json',
      blobUrl: 'https://github.com/o/r/releases/download/v9.9.9/pack.bin',
      manifestBytes,
      blobBytes: blob,
    });

    const { loadLatestPack } = await import('../server/content-pack-release');
    const result = await loadLatestPack(fetchImpl);
    expect(result?.tag).toBe('v9.9.9');
    expect(result?.pack).toEqual(pack);
  });

  it('密文 sha256 不符 → 抛错（防投毒）', async () => {
    const { blob, compressed, plainSha256 } = encryptPackBlob({ a: 1 });
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        packId: 'p',
        packVersion: '1.0.0',
        size: compressed.length,
        plainSha256,
        blobSha256: 'deadbeef',
      }),
      'utf8',
    );
    const fetchImpl = fakeGithub({
      manifestUrl: 'https://github.com/o/r/releases/download/v1/manifest.json',
      blobUrl: 'https://github.com/o/r/releases/download/v1/pack.bin',
      manifestBytes,
      blobBytes: blob,
    });
    const { loadLatestPack } = await import('../server/content-pack-release');
    await expect(loadLatestPack(fetchImpl)).rejects.toThrow(/sha256/);
  });
});

describe('BFF /api/content-pack 路由', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('/latest 无发布版本 → available:false（200，不是错误）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    const res = await buildHonoApp().request('/api/content-pack/latest');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, available: false });
  });

  it('/latest 有版本 → 回清单字段', async () => {
    const { blob, compressed, plainSha256 } = encryptPackBlob({ a: 1 });
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        packId: 'fated-poem-official',
        packVersion: '3.2.1',
        size: compressed.length,
        plainSha256,
        blobSha256: sha256Hex(blob),
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeGithub({
          manifestUrl: 'https://github.com/o/r/releases/download/v3.2.1/manifest.json',
          blobUrl: 'https://github.com/o/r/releases/download/v3.2.1/pack.bin',
          manifestBytes,
          blobBytes: blob,
        }) as never,
      ),
    );
    const res = await buildHonoApp().request('/api/content-pack/latest');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      available: true,
      tag: 'v9.9.9',
      packVersion: '3.2.1',
    });
  });

  it('/blob 解密后回明文 pack + X-Pack-Version', async () => {
    const pack = { formatVersion: 1, packId: 'fated-poem-official', packVersion: '5.0.0' };
    const { blob, compressed, plainSha256 } = encryptPackBlob(pack);
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        packId: 'fated-poem-official',
        packVersion: '5.0.0',
        size: compressed.length,
        plainSha256,
        blobSha256: sha256Hex(blob),
      }),
      'utf8',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(
        fakeGithub({
          manifestUrl: 'https://github.com/o/r/releases/download/v5/manifest.json',
          blobUrl: 'https://github.com/o/r/releases/download/v5/pack.bin',
          manifestBytes,
          blobBytes: blob,
        }) as never,
      ),
    );
    const res = await buildHonoApp().request('/api/content-pack/blob');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pack-version')).toBe('5.0.0');
    expect(await res.json()).toEqual(pack);
  });
});
