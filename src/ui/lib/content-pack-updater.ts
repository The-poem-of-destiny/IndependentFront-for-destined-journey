import { semverGte } from '@engine/content/content-source';
import type { PackKeyLease, ProtectedPackDownload } from '@engine/types/types-pack-auth';
import {
  authenticatedPackRequest,
  discordSession,
  effectivePackNow,
  type PackClientFetch,
} from './discord-auth-client';
import { validateEncryptedEnvelope, verifyEnvelopeBinding } from './pack-crypto';

/** Authenticated downloads return ciphertext only; the content store owns memory-only decryption. */
export interface PackUpdateInfo {
  available: boolean;
  updateAvailable: boolean;
  packVersion: string | null;
  tag: string | null;
  minEngineVersion?: string;
  name?: string;
}
export type PackUpdateCheck =
  { status: 'ok'; info: PackUpdateInfo } | { status: 'error'; message: string };
export type PackDownloadResult =
  | { status: 'ok'; download: ProtectedPackDownload; packVersion: string }
  | { status: 'error'; message: string };
export type PackUpdaterFetch = PackClientFetch;

export function isPackUpdateAvailable(
  latest: string | null | undefined,
  current: string | null | undefined,
): boolean {
  if (!latest) return false;
  if (!current) return true;
  return latest !== current && semverGte(latest, current);
}
export async function checkPackUpdate(
  currentVersion: string | null,
  fetchImpl?: PackUpdaterFetch,
): Promise<PackUpdateCheck> {
  try {
    const body = await authenticatedPackRequest('latest', undefined, fetchImpl);
    if (
      typeof body.available !== 'boolean' ||
      (body.available && typeof body.packVersion !== 'string')
    )
      throw new Error('内容包版本响应无效');
    const packVersion = body.available ? (body.packVersion as string) : null;
    return {
      status: 'ok',
      info: {
        available: body.available,
        updateAvailable: body.available && isPackUpdateAvailable(packVersion, currentVersion),
        packVersion,
        tag: typeof body.tag === 'string' ? body.tag : null,
        ...(typeof body.minEngineVersion === 'string'
          ? { minEngineVersion: body.minEngineVersion }
          : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      },
    };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
export async function downloadLatestPack(
  fetchImpl?: PackUpdaterFetch,
): Promise<PackDownloadResult> {
  try {
    const body = await authenticatedPackRequest('blob', undefined, fetchImpl);
    const envelope = body.envelope;
    validateEncryptedEnvelope(envelope);
    const keyLease = body.keyLease as PackKeyLease;
    verifyEnvelopeBinding(envelope, keyLease, discordSession.value, effectivePackNow());
    return { status: 'ok', download: { envelope, keyLease }, packVersion: envelope.packVersion };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
