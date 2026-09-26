import { semverGte } from '@engine/content-source';

/**
 * content-pack-updater.ts — 内容包自动更新 v1 的前端侧（BFF 同源）。
 *
 * 只做两件事：问 BFF 「有没有新版」、把新版明文 pack 拉回来交给 DataSection
 * 既有的 `installPack` / `upgradePack`。**加解密与 GitHub 拉取都在服务端**
 * （`server/content-pack-release.ts`）—— 密钥不进前端 bundle，也绕开 GitHub
 * Release 资产的 CORS 限制。
 *
 * 本模块是纯 fetch 包装，判别联合永不抛穿（照 workshop-client / image-client 先例），
 * 便于测试注入 fetch。
 */

/** BFF 两条路由返回的形状（服务端已解密） */
export interface PackUpdateInfo {
  /** 发布仓是否有可用版本 */
  available: boolean;
  /** 相对已装版本是否更新（未装时 available 即为 true） */
  updateAvailable: boolean;
  packVersion: string | null;
  tag: string | null;
  minEngineVersion?: string;
  name?: string;
}

export type PackUpdateCheck =
  { status: 'ok'; info: PackUpdateInfo } | { status: 'error'; message: string };

export type PackDownloadResult =
  | { status: 'ok'; pack: unknown; packVersion: string | null }
  | { status: 'error'; message: string };

export type PackUpdaterFetch = (
  input: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  headers?: { get: (name: string) => string | null };
}>;

function resolveFetch(fetchImpl?: PackUpdaterFetch): PackUpdaterFetch | undefined {
  if (fetchImpl) return fetchImpl;
  const g = globalThis as { fetch?: unknown };
  return typeof g.fetch === 'function' ? (g.fetch as unknown as PackUpdaterFetch) : undefined;
}

/**
 * 比较「最新版是否比当前版新」。当前未装（null/空）视为可安装。
 * 用引擎的 `semverGte`（全仓唯一一份 semver 比较），不另写。
 */
export function isPackUpdateAvailable(
  latest: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!latest) return false;
  if (!current) return true;
  if (latest === current) return false;
  return semverGte(latest, current);
}

/** 问 BFF 有没有新版。失败不抛，回 status:'error'。 */
export async function checkPackUpdate(
  currentVersion: string | null,
  fetchImpl?: PackUpdaterFetch,
): Promise<PackUpdateCheck> {
  const doFetch = resolveFetch(fetchImpl);
  if (!doFetch) return { status: 'error', message: '当前环境没有可用的 fetch' };
  try {
    const res = await doFetch('/api/content-pack/latest');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { status: 'error', message: body?.error ?? `检查更新失败（HTTP ${res.status}）` };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      available?: boolean;
      packVersion?: string;
      tag?: string;
      minEngineVersion?: string;
      name?: string;
    };
    if (!body || body.ok === false) return { status: 'error', message: '检查更新失败' };
    const available = body.available === true;
    const packVersion = available ? (body.packVersion ?? null) : null;
    return {
      status: 'ok',
      info: {
        available,
        updateAvailable: available && isPackUpdateAvailable(packVersion, currentVersion),
        packVersion,
        tag: available ? (body.tag ?? null) : null,
        ...(body.minEngineVersion ? { minEngineVersion: body.minEngineVersion } : {}),
        ...(body.name ? { name: body.name } : {}),
      },
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** 从 BFF 拉取最新明文 pack（服务端已解密）。失败不抛，回 status:'error'。 */
export async function downloadLatestPack(
  fetchImpl?: PackUpdaterFetch,
): Promise<PackDownloadResult> {
  const doFetch = resolveFetch(fetchImpl);
  if (!doFetch) return { status: 'error', message: '当前环境没有可用的 fetch' };
  try {
    const res = await doFetch('/api/content-pack/blob');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return { status: 'error', message: body?.error ?? `下载内容包失败（HTTP ${res.status}）` };
    }
    const pack = await res.json();
    const version = res.headers?.get('X-Pack-Version') ?? null;
    return { status: 'ok', pack, packVersion: version };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
