import { gunzipSync } from 'fflate';
import { validatePackOrThrow } from '@engine/content/content-source';
import type { ContentPack } from '@engine/types/types-content';
import type {
  DiscordAuthSession,
  EncryptedPackEnvelope,
  PackKeyLease,
} from '@engine/types/types-pack-auth';

export class PackCryptoError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const utf8 = new TextEncoder();
function bytes(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > 128 * 1024 * 1024 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error('Invalid Base64');
  const result = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (length !== undefined && result.length !== length) throw new Error('Invalid key/nonce size');
  return result;
}

export function validateEncryptedEnvelope(value: unknown): asserts value is EncryptedPackEnvelope {
  if (!value || typeof value !== 'object')
    throw new PackCryptoError('INVALID_ENVELOPE', '内容包加密信封无效');
  const e = value as EncryptedPackEnvelope;
  if (
    e.formatVersion !== 1 ||
    typeof e.packId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(e.packId) ||
    typeof e.packVersion !== 'string' ||
    e.packVersion.length > 128 ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(e.packVersion) ||
    typeof e.boundUserId !== 'string' ||
    !/^\d{1,20}$/.test(e.boundUserId) ||
    !Number.isSafeInteger(e.issuedAt) ||
    !Number.isSafeInteger(e.expiresAt) ||
    e.issuedAt < 0 ||
    e.expiresAt <= e.issuedAt ||
    typeof e.plainSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(e.plainSha256)
  )
    throw new PackCryptoError('INVALID_ENVELOPE', '内容包加密信封字段无效');
  try {
    bytes(e.wrapNonceB64, 12);
    bytes(e.wrappedDekB64, 48);
    bytes(e.bodyNonceB64, 12);
    if (bytes(e.ciphertextB64).length < 16) throw new Error();
  } catch {
    throw new PackCryptoError('INVALID_ENVELOPE', '内容包密文或随机数无效');
  }
}

export function verifyEnvelopeBinding(
  envelope: EncryptedPackEnvelope,
  lease: PackKeyLease | null,
  session: DiscordAuthSession | null,
  effectiveNow: number,
): asserts lease is PackKeyLease {
  if (!session || session.expiresAt <= effectiveNow)
    throw new PackCryptoError('NOT_LOGGED_IN', '请登录绑定的 Discord 账号');
  if (!session.access.eligible)
    throw new PackCryptoError('ACCESS_REVOKED', 'Discord 社区资格未通过验证');
  if (session.user.id !== envelope.boundUserId)
    throw new PackCryptoError('ACCOUNT_MISMATCH', '此内容包绑定于另一 Discord 账号');
  if (
    !lease ||
    lease.boundUserId !== session.user.id ||
    lease.packId !== envelope.packId ||
    lease.packVersion !== envelope.packVersion ||
    lease.issuedAt !== envelope.issuedAt ||
    lease.expiresAt !== envelope.expiresAt
  )
    throw new PackCryptoError('LEASE_REQUIRED', '内容包租约需要重新验证');
  if (!Number.isFinite(effectiveNow) || effectiveNow >= envelope.expiresAt)
    throw new PackCryptoError('EXPIRED', '内容包授权已到期，联网后将自动续期');
}

async function unwrapPackDek(
  envelope: EncryptedPackEnvelope,
  lease: PackKeyLease,
  currentUserId: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    bytes(lease.distributedKeyB64, 32),
    'HKDF',
    false,
    ['deriveKey'],
  );
  const kek = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8.encode(`${envelope.packId}:${envelope.packVersion}`),
      info: utf8.encode(`poem-pack-kek-v1|${currentUserId}|${envelope.expiresAt}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const dek = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes(envelope.wrapNonceB64, 12),
      additionalData: utf8.encode(
        `dps-pack-wrap-v1|${envelope.packId}|${envelope.packVersion}|${envelope.boundUserId}|${envelope.expiresAt}`,
      ),
    },
    kek,
    bytes(envelope.wrappedDekB64, 48),
  );
  return crypto.subtle.importKey('raw', dek, 'AES-GCM', false, ['decrypt']);
}

export async function decryptContentPackAtRuntime(
  envelope: EncryptedPackEnvelope,
  lease: PackKeyLease | null,
  session: DiscordAuthSession | null,
  effectiveNow: number,
): Promise<ContentPack> {
  validateEncryptedEnvelope(envelope);
  verifyEnvelopeBinding(envelope, lease, session, effectiveNow);
  try {
    const dek = await unwrapPackDek(envelope, lease, session!.user.id);
    const compressed = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bytes(envelope.bodyNonceB64, 12),
        additionalData: utf8.encode(
          `dps-pack-body-v1|${envelope.packId}|${envelope.packVersion}|${envelope.boundUserId}`,
        ),
      },
      dek,
      bytes(envelope.ciphertextB64),
    );
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', compressed))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (digest !== envelope.plainSha256) throw new Error('Hash mismatch');
    const pack: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(new Uint8Array(compressed))),
    );
    const errors = validatePackOrThrow(pack).filter((note) => note.level === 'error');
    const content = pack as ContentPack;
    if (
      errors.length ||
      content.packId !== envelope.packId ||
      content.packVersion !== envelope.packVersion
    )
      throw new Error('Invalid content pack');
    return content;
  } catch {
    throw new PackCryptoError('DECRYPT_FAILED', '内容包解密或完整性校验失败，请重新获取');
  }
}
