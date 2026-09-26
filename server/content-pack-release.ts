import { createDecipheriv, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

/**
 * 内容包自动更新 v1 —— 发布侧常量与拉取/解密逻辑（BFF 服务端专用）。
 *
 * 背景：真实内容包（世界书 / 提示词 / 预设）不能明文进公开仓，否则会被 GitHub
 * 自动索引、也容易被随手举报。于是发布侧把 pack JSON 压缩后用 AES-256-GCM 加密成
 * 二进制 blob，放进一个「release-only」公开仓的 Release 里；本模块在服务端把它
 * 拉回来解密，再把明文交给前端既有的 `installPack` / `upgradePack`。
 *
 * 🔴 威胁模型（2026-09-26 主人裁定）：**只求「不明文 / 不被自动扫描 / 不扎眼」**。
 *    密钥内嵌在公开源码里 = 纯混淆，不是访问控制 —— 有意者仍可取出密钥解密。
 *    真要保密必须服务端持钥，那与「public release-only」的前提冲突。
 *
 * 🔴 为什么在服务端解密而不是浏览器：密钥不进前端 bundle（少一处泄漏面），
 *    Node 的 `node:crypto` 比 Web Crypto 简单；顺带把 GitHub Releases 的 CORS
 *    问题一起解决（见下）。
 */

/**
 * 发布仓坐标 `owner/repo`。默认值是**占位** —— 建好独立 release-only 仓后，
 * 用环境变量 `POEM_PACK_REPO=owner/repo` 覆盖，或直接改这里的默认值。
 *
 * 🔴 只从这里读仓坐标，**绝不接受请求参数里的仓库/URL** —— 本模块是服务端出站
 *    fetch 的唯一入口，放任 URL 进来即 SSRF。
 */
export const DEFAULT_PACK_REPO = 'The-poem-of-destiny/poem-dist';

/**
 * AES-256-GCM 密钥（base64，32 字节）。**纯混淆用**，与私有仓 `tools/build-release.mjs`
 * 里的 `FALLBACK_KEY_B64` 必须逐字一致 —— 两处是同一份密钥的两个副本。
 * 轮换时两仓同步改，旧 blob 会立刻失效（属预期）。
 */
export const PACK_BLOB_KEY_B64 = 'GKlTyvPi0JetA9z3Pc3RtO1em05jB/CeF/WKK+12mrg=';

/** Release 里两个约定的资产名（发布脚本产出同名文件）。 */
const PACK_MANIFEST_ASSET = 'manifest.json';
const PACK_BLOB_ASSET = 'pack.bin';

/** GCM nonce 长度（字节），blob 前 12 字节。 */
const NONCE_BYTES = 12;

/**
 * Release 清单（明文，刻意极小且**不含任何世界观文字** —— 它会被 GitHub 明文索引，
 * 只放版本号与哈希）。前端用它判断「有没有新版本」。
 */
export interface PackReleaseManifest {
  formatVersion: 1;
  packId: string;
  packVersion: string;
  minEngineVersion?: string;
  name?: string;
  /** 压缩后、加密前的明文字节数（gzip 输出） */
  size: number;
  /** sha256(gzip(JSON)) —— 解密解压后校验，防投毒/误覆盖 */
  plainSha256: string;
  /** sha256(密文) —— 下载后、解密前校验 */
  blobSha256: string;
}

interface GithubAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

/** fetch 的最小形状 —— 便于测试注入。 */
export type PackFetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

function resolveFetch(fetchImpl?: PackFetchLike): PackFetchLike {
  if (fetchImpl) return fetchImpl;
  const g = globalThis as { fetch?: unknown };
  if (typeof g.fetch !== 'function') {
    throw new Error('当前环境没有可用的 fetch');
  }
  return g.fetch as unknown as PackFetchLike;
}

/** 读发布仓坐标（请求期读 env，便于不重启切换/测试）。 */
function resolvePackRepo(): string {
  const raw = (process.env.POEM_PACK_REPO ?? '').trim();
  const repo = raw || DEFAULT_PACK_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`POEM_PACK_REPO 形状不对（应为 owner/repo）：${repo}`);
  }
  return repo;
}

/** 读密钥（env 覆盖，缺省用内嵌常量）。 */
function resolvePackKeyB64(): string {
  const raw = (process.env.POEM_PACK_KEY_B64 ?? '').trim() || PACK_BLOB_KEY_B64;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('内容包密钥必须是 32 字节（base64 编码）');
  }
  return raw;
}

/** 只信任 GitHub 自家的下载跳转目标 —— 防止 Release 被塞外链后把 BFF 变成取回器。 */
export function isTrustedAssetHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'api.github.com' ||
      host.endsWith('.githubusercontent.com') ||
      host.endsWith('.github.com')
    );
  } catch {
    return false;
  }
}

/** 容错解析 manifest；形状不符返回 null（坏清单当「无可用版本」，不抛）。 */
export function parseManifest(value: unknown): PackReleaseManifest | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (o.formatVersion !== 1) return null;
  if (typeof o.packId !== 'string' || !o.packId) return null;
  if (typeof o.packVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(o.packVersion)) return null;
  if (typeof o.plainSha256 !== 'string' || typeof o.blobSha256 !== 'string') return null;
  if (typeof o.size !== 'number') return null;
  return {
    formatVersion: 1,
    packId: o.packId,
    packVersion: o.packVersion,
    ...(typeof o.minEngineVersion === 'string' ? { minEngineVersion: o.minEngineVersion } : {}),
    ...(typeof o.name === 'string' ? { name: o.name } : {}),
    size: o.size,
    plainSha256: o.plainSha256,
    blobSha256: o.blobSha256,
  };
}

function pickAsset(release: GithubRelease, name: string): GithubAsset | undefined {
  return release.assets.find((a) => a && a.name === name);
}

/**
 * 拿最新 release + 其中的 manifest。无 release / 无 manifest → `null`（不是错误）。
 * 网络或限流错误抛出（调用方转 502）。
 */
export async function loadLatestManifest(
  fetchImpl?: PackFetchLike,
): Promise<{ tag: string; manifest: PackReleaseManifest } | null> {
  const doFetch = resolveFetch(fetchImpl);
  const repo = resolvePackRepo();
  const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fated-poem-bff' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub API 返回 ${res.status}`);
  }
  const release = (await res.json()) as GithubRelease;
  const asset = pickAsset(release, PACK_MANIFEST_ASSET);
  if (!asset) return null;
  const manifestBytes = await downloadAsset(asset, doFetch);
  const manifest = parseManifest(JSON.parse(new TextDecoder().decode(manifestBytes)));
  if (!manifest) return null;
  return { tag: release.tag_name, manifest };
}

/** 下载一个 release 资产为字节（校验主机白名单）。 */
async function downloadAsset(asset: GithubAsset, doFetch: PackFetchLike): Promise<Uint8Array> {
  if (!isTrustedAssetHost(asset.browser_download_url)) {
    throw new Error('release 资产指向非 GitHub 主机，已拒绝下载');
  }
  const res = await doFetch(asset.browser_download_url, {
    headers: { Accept: 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`下载发布资产失败：HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * AES-256-GCM 解密。blob 布局：`nonce(12) || ciphertext || tag(16)`。
 * 认证失败（被改过 / 密钥不符）抛错。
 */
export function decryptPackBlob(blob: Uint8Array, keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (blob.length <= NONCE_BYTES + 16) throw new Error('内容包密文过短');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const body = blob.subarray(NONCE_BYTES);
  const tag = body.subarray(body.length - 16);
  const ciphertext = body.subarray(0, body.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * 拉取最新内容包并解密为明文 pack 对象。
 * 返回 `null` = 当前没有可用的发布版本（无 release / 无资产）。
 * 抛错 = 网络、校验、解密失败。
 */
export async function loadLatestPack(
  fetchImpl?: PackFetchLike,
): Promise<{ tag: string; manifest: PackReleaseManifest; pack: unknown } | null> {
  const doFetch = resolveFetch(fetchImpl);
  const latest = await loadLatestManifest(doFetch);
  if (!latest) return null;

  const repo = resolvePackRepo();
  const res = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'fated-poem-bff' },
  });
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
  const release = (await res.json()) as GithubRelease;
  const asset = pickAsset(release, PACK_BLOB_ASSET);
  if (!asset) return null;

  const ciphertext = await downloadAsset(asset, doFetch);
  if (sha256Hex(ciphertext) !== latest.manifest.blobSha256) {
    throw new Error('内容包密文 sha256 校验失败（发布仓可能被改动）');
  }
  const compressed = decryptPackBlob(ciphertext, resolvePackKeyB64());
  if (sha256Hex(compressed) !== latest.manifest.plainSha256) {
    throw new Error('内容包明文 sha256 校验失败（内容与清单不符）');
  }
  const json = gunzipSync(compressed).toString('utf8');
  return { tag: latest.tag, manifest: latest.manifest, pack: JSON.parse(json) };
}
