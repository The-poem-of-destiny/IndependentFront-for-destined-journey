import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptContentPackAtRuntime,
  validateEncryptedEnvelope,
} from '../../../src/ui/lib/pack-crypto';
import {
  encryptPrivatePack,
  makeDiscordSession,
  makePrivatePack,
} from '../../helpers/pack-auth-fixture';
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('protected pack WebCrypto wire contract', () => {
  it('decrypts the independent server-format HKDF + AES-GCM + gzip fixture', async () => {
    const pack = makePrivatePack(),
      download = encryptPrivatePack(pack);
    expect(
      await decryptContentPackAtRuntime(
        download.envelope,
        download.keyLease,
        makeDiscordSession(),
        Date.now(),
      ),
    ).toEqual(pack);
  });
  it.each(['account', 'lease-account', 'version', 'expiry', 'missing-session', 'revoked'])(
    'rejects %s before content can mount',
    async (kind) => {
      const { envelope, keyLease } = encryptPrivatePack();
      let session: ReturnType<typeof makeDiscordSession> | null = makeDiscordSession();
      if (kind === 'account') session.user.id = '999';
      if (kind === 'lease-account') keyLease.boundUserId = '999';
      if (kind === 'version') keyLease.packVersion = '2.0.0';
      if (kind === 'missing-session') session = null;
      if (kind === 'revoked') session!.access.eligible = false;
      await expect(
        decryptContentPackAtRuntime(
          envelope,
          keyLease,
          session,
          kind === 'expiry' ? envelope.expiresAt : Date.now(),
        ),
      ).rejects.toThrow();
    },
  );
  it.each([
    'wrapNonceB64',
    'wrappedDekB64',
    'bodyNonceB64',
    'ciphertextB64',
    'plainSha256',
  ] as const)('detects tampering in %s', async (field) => {
    const { envelope, keyLease } = encryptPrivatePack();
    envelope[field] = `${envelope[field][0] === 'A' ? 'B' : 'A'}${envelope[field].slice(1)}`;
    await expect(
      decryptContentPackAtRuntime(envelope, keyLease, makeDiscordSession(), Date.now()),
    ).rejects.toThrow();
  });
  it('validates large Base64 bodies without recursive regexp stack overflow', () => {
    const { envelope } = encryptPrivatePack();
    envelope.ciphertextB64 = 'AAAA'.repeat(300000);
    expect(() => validateEncryptedEnvelope(envelope)).not.toThrow();
  });
});
