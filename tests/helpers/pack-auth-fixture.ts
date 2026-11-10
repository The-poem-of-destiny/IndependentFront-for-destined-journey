import { createCipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ContentPack } from '../../src/core/types/types-content';
import type {
  DiscordAuthSession,
  ProtectedPackDownload,
} from '../../src/core/types/types-pack-auth';

export const PRIVATE_TEXT = 'private-pack-fixture-仅供测试';
export function makePrivatePack(): ContentPack {
  return {
    formatVersion: 1,
    packId: 'fixture',
    packVersion: '1.0.0',
    worldBooks: [
      {
        id: 'system_core',
        partition: 'system_core',
        name: 'Fixture',
        builtIn: true,
        entries: [
          {
            uid: 'fated:system_core/core',
            name: 'Core',
            content: PRIVATE_TEXT,
            enabled: true,
            key: [],
            keysecondary: [],
            selectiveLogic: 0,
            order: 100,
            position: 0,
          },
        ],
      },
    ],
    presets: [
      {
        id: 'fixture-preset',
        name: 'Fixture',
        settings: {
          prompts: [
            {
              identifier: 'system',
              name: 'System',
              role: 'system',
              content: PRIVATE_TEXT,
              enabled: true,
            },
          ],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}
export function makeDiscordSession(userId = '123'): DiscordAuthSession {
  const now = Date.now();
  const expiresAt = now + 14 * 86400000;
  const encoded = Buffer.from(JSON.stringify({ exp: Math.ceil(expiresAt / 1000) })).toString(
    'base64url',
  );
  return {
    token: `dps1.${encoded}.signature`,
    user: { id: userId, username: 'fixture', displayName: 'Fixture', avatarUrl: null },
    access: { eligible: true, guildId: '456', code: 'ELIGIBLE', message: 'Eligible' },
    expiresAt,
    verifiedAt: now,
    serverUrl: 'https://packs.example',
  };
}
/** Independent Node implementation of the center server's documented HKDF / AES-GCM wire contract. */
export function encryptPrivatePack(
  pack = makePrivatePack(),
  userId = '123',
  issuedAt = Date.now(),
  expiresAt = issuedAt + 7 * 86400000,
): ProtectedPackDownload {
  const distributed = randomBytes(32),
    dek = randomBytes(32);
  const kek = Buffer.from(
    hkdfSync(
      'sha256',
      distributed,
      `${pack.packId}:${pack.packVersion}`,
      `poem-pack-kek-v1|${userId}|${expiresAt}`,
      32,
    ),
  );
  function encrypt(key: Buffer, input: Buffer, aad: string) {
    const nonce = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final(), cipher.getAuthTag()]);
    return { nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') };
  }
  const compressed = gzipSync(JSON.stringify(pack));
  const body = encrypt(
    dek,
    compressed,
    `dps-pack-body-v1|${pack.packId}|${pack.packVersion}|${userId}`,
  );
  const wrap = encrypt(
    kek,
    dek,
    `dps-pack-wrap-v1|${pack.packId}|${pack.packVersion}|${userId}|${expiresAt}`,
  );
  return {
    envelope: {
      formatVersion: 1,
      packId: pack.packId,
      packVersion: pack.packVersion,
      boundUserId: userId,
      issuedAt,
      expiresAt,
      wrapNonceB64: wrap.nonce,
      wrappedDekB64: wrap.ciphertext,
      bodyNonceB64: body.nonce,
      ciphertextB64: body.ciphertext,
      plainSha256: createHash('sha256').update(compressed).digest('hex'),
    },
    keyLease: {
      packId: pack.packId,
      packVersion: pack.packVersion,
      boundUserId: userId,
      issuedAt,
      expiresAt,
      distributedKeyB64: distributed.toString('base64'),
    },
  };
}

export async function renewPrivatePack(
  download: ProtectedPackDownload,
  issuedAt = Date.now() + 1000,
): Promise<ProtectedPackDownload> {
  const { createDecipheriv } = await import('node:crypto');
  const old = download.envelope,
    expiresAt = issuedAt + 7 * 86400000;
  const distributed = Buffer.from(download.keyLease.distributedKeyB64, 'base64');
  function kek(expiry: number) {
    return Buffer.from(
      hkdfSync(
        'sha256',
        distributed,
        `${old.packId}:${old.packVersion}`,
        `poem-pack-kek-v1|${old.boundUserId}|${expiry}`,
        32,
      ),
    );
  }
  function aad(expiry: number) {
    return Buffer.from(
      `dps-pack-wrap-v1|${old.packId}|${old.packVersion}|${old.boundUserId}|${expiry}`,
    );
  }
  const wrapped = Buffer.from(old.wrappedDekB64, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    kek(old.expiresAt),
    Buffer.from(old.wrapNonceB64, 'base64'),
  );
  decipher.setAAD(aad(old.expiresAt));
  decipher.setAuthTag(wrapped.subarray(-16));
  const dek = Buffer.concat([decipher.update(wrapped.subarray(0, -16)), decipher.final()]);
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', kek(expiresAt), nonce);
  cipher.setAAD(aad(expiresAt));
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return {
    envelope: {
      ...old,
      issuedAt,
      expiresAt,
      wrapNonceB64: nonce.toString('base64'),
      wrappedDekB64: ciphertext.toString('base64'),
    },
    keyLease: { ...download.keyLease, issuedAt, expiresAt },
  };
}
